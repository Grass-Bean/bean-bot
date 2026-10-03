import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { joinMock, playerFactoryMock, entersStateMock } = vi.hoisted(() => ({
    joinMock: vi.fn(),
    playerFactoryMock: vi.fn(),
    entersStateMock: vi.fn()
}));

vi.mock('@discordjs/voice', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@discordjs/voice')>();
    return {
        ...actual,
        joinVoiceChannel: joinMock,
        createAudioPlayer: playerFactoryMock,
        entersState: entersStateMock
    };
});

import {
    AudioPlayerStatus,
    VoiceConnectionDisconnectReason,
    VoiceConnectionStatus
} from '@discordjs/voice';
import {
    GuildAudioSessionManager,
    type GuildAudioSessionManagerOptions,
    VoiceConnectionRateLimitError
} from '../src/audio/GuildAudioSessionManager.js';
import { AutoplaySelector } from '../src/audio/AutoplaySelector.js';
import { VoiceRecoveryPolicy } from '../src/audio/VoiceRecoveryPolicy.js';
import type { AudioResourceManager } from '../src/audio/AudioResourceManager.js';
import { reportResourceFailure } from '../src/audio/AudioResourceManager.js';
import { runWithLogContext } from '../src/utility/logger.js';
import type {
    AutoplayTrackResolver,
    BeanAudioResource,
    TrackMetadata
} from '../src/audio/types.js';

type FakeConnection = EventEmitter & {
    state: any;
    joinConfig: { channelId: string };
    subscribe: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    rejoin: ReturnType<typeof vi.fn>;
    configureNetworking: ReturnType<typeof vi.fn>;
};

type FakePlayer = EventEmitter & {
    state: { status: string };
    play: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
};

const createConnection = (
    status: string = VoiceConnectionStatus.Ready,
    channelId = 'voice-a'
): FakeConnection => {
    const connection = new EventEmitter() as FakeConnection;
    connection.state = {
        status,
        networking: new EventEmitter()
    };
    connection.joinConfig = { channelId };
    connection.subscribe = vi.fn();
    connection.rejoin = vi.fn().mockReturnValue(true);
    connection.configureNetworking = vi.fn(() => {
        const oldState = connection.state;
        const networking = Object.assign(new EventEmitter(), { destroy: vi.fn() });
        oldState.networking?.destroy?.();
        connection.state = { status: VoiceConnectionStatus.Connecting, networking };
        connection.emit('stateChange', oldState, connection.state);
        return networking;
    });
    connection.destroy = vi.fn(() => {
        const oldState = connection.state;
        connection.state = { status: VoiceConnectionStatus.Destroyed };
        connection.emit('stateChange', oldState, connection.state);
    });
    return connection;
};

const createPlayer = (): FakePlayer => {
    const player = new EventEmitter() as FakePlayer;
    player.state = { status: AudioPlayerStatus.Idle };
    player.play = vi.fn((resource: BeanAudioResource) => {
        player.state = { status: AudioPlayerStatus.Playing };
        return resource;
    });
    player.stop = vi.fn().mockReturnValue(true);
    return player;
};

const makeTrack = (id: string, duration?: number): TrackMetadata => ({
    kind: 'track',
    id,
    title: `Track ${id}`,
    url: `https://youtube.com/watch?v=${id}`,
    duration,
    thumbnail: `https://img.youtube.com/${id}.jpg`,
    requestedBy: 'user-a'
});

const makeResource = (metadata: TrackMetadata | { kind: 'elevator'; id: 'elevator'; title: string }) => ({
    metadata,
    playbackDuration: 0,
    playStream: new PassThrough()
}) as unknown as BeanAudioResource;

const createResources = () => {
    const released = new WeakSet<object>();
    return {
        createTrackResource: vi.fn((track: TrackMetadata) => makeResource(track)),
        createElevatorResource: vi.fn(() => makeResource({
            kind: 'elevator', id: 'elevator', title: 'Elevator Music'
        })),
        release: vi.fn((resource?: BeanAudioResource) => {
            if (resource) released.add(resource);
        }),
        isReleased: vi.fn((resource: BeanAudioResource) => released.has(resource))
    };
};

const flushTransitions = async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
};

describe('GuildAudioSessionManager', () => {
    let connection: FakeConnection;
    let player: FakePlayer;
    let resources: ReturnType<typeof createResources>;
    let manager: GuildAudioSessionManager;

    const createManager = (options: GuildAudioSessionManagerOptions = {}) => (
        new GuildAudioSessionManager({
            resources: resources as unknown as AudioResourceManager,
            ...options
        })
    );

    beforeEach(() => {
        vi.clearAllMocks();
        connection = createConnection();
        player = createPlayer();
        resources = createResources();
        joinMock.mockReturnValue(connection);
        playerFactoryMock.mockReturnValue(player);
        entersStateMock.mockImplementation(async (target) => target);
        manager = createManager();
    });

    afterEach(() => {
        manager.disconnect('guild-a');
        vi.useRealTimers();
    });

    it('creates, subscribes, exposes, reuses, and disconnects a ready session', async () => {
        expect(await manager.connect('guild-a', 'voice-a', {} as any)).toBe(connection);
        expect(joinMock).toHaveBeenCalledWith(expect.objectContaining({
            guildId: 'guild-a', channelId: 'voice-a', selfDeaf: true, selfMute: false
        }));
        expect(connection.subscribe).toHaveBeenCalledWith(player);
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');

        expect(await manager.connect('guild-a', 'voice-a', {} as any)).toBe(connection);
        expect(joinMock).toHaveBeenCalledTimes(1);
        await expect(manager.connect('guild-a', 'voice-b', {} as any)).rejects.toThrow(
            'Audio is already active in voice channel voice-a.'
        );

        expect(manager.disconnect('guild-a')).toBe(true);
        expect(connection.destroy).toHaveBeenCalledOnce();
        expect(manager.disconnect('guild-a')).toBe(false);
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
    });

    it('releases active and preloaded resources and cancels timers on disconnect', async () => {
        vi.useFakeTimers();
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), null);
        await flushTransitions();
        const current = resources.createTrackResource.mock.results[0]!.value;
        manager.enqueue('guild-a', makeTrack('two'), null);
        await flushTransitions();
        const preload = resources.createTrackResource.mock.results[1]!.value;

        expect(manager.disconnect('guild-a')).toBe(true);

        expect(player.stop).toHaveBeenCalledWith(true);
        expect(resources.release).toHaveBeenCalledWith(current);
        expect(resources.release).toHaveBeenCalledWith(preload);
        expect(vi.getTimerCount()).toBe(0);

        player.emit(AudioPlayerStatus.Idle);
        await vi.runAllTimersAsync();
        await flushTransitions();
        expect(resources.createElevatorResource).not.toHaveBeenCalled();
    });

    it('waits for a connecting session and destroys it when readiness fails', async () => {
        connection = createConnection(VoiceConnectionStatus.Connecting);
        joinMock.mockReturnValue(connection);
        entersStateMock.mockRejectedValueOnce(new Error('not ready'));

        await expect(manager.connect('guild-a', 'voice-a', {} as any)).rejects.toThrow('not ready');
        expect(entersStateMock).toHaveBeenCalledWith(connection, VoiceConnectionStatus.Ready, 15_000);
        expect(connection.destroy).toHaveBeenCalled();
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
    });

    it('leaves a reused connecting session intact when its readiness check fails', async () => {
        connection = createConnection(VoiceConnectionStatus.Connecting);
        joinMock.mockReturnValue(connection);
        entersStateMock.mockResolvedValueOnce(connection);
        await manager.connect('guild-a', 'voice-a', {} as any);

        connection.state = {
            status: VoiceConnectionStatus.Connecting,
            networking: connection.state.networking
        };
        entersStateMock.mockRejectedValueOnce(new Error('reconnect failed'));

        await expect(manager.connect('guild-a', 'voice-a', {} as any)).rejects.toThrow(
            'reconnect failed'
        );
        expect(connection.destroy).not.toHaveBeenCalled();
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');
    });

    it('synchronizes a moved voice channel from the connection join config', async () => {
        await manager.connect('guild-a', 'voice-a', {} as any);
        connection.joinConfig.channelId = 'voice-moved';
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-moved');
    });

    it('starts the first track, queues later tracks, and preloads the next item', async () => {
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);

        expect(manager.enqueue('guild-a', makeTrack('one'), channel)).toEqual({
            accepted: true, startsImmediately: true, position: 0
        });
        await flushTransitions();
        expect(player.play).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ id: 'one' })
        }));
        const nowPlaying = channel.send.mock.calls[0][0].embeds[0].toJSON();
        expect(nowPlaying.author.name).toBe('♫ Now playing');
        expect(nowPlaying.color).toBe(0x57f287);
        expect(nowPlaying.title).toBe('Track one');
        expect(nowPlaying.image?.url).toBe('https://img.youtube.com/one.jpg');
        expect(nowPlaying.thumbnail).toBeUndefined();

        expect(manager.enqueue('guild-a', makeTrack('two'), channel)).toEqual({
            accepted: true, startsImmediately: false, position: 1
        });
        await flushTransitions();
        expect(resources.createTrackResource).toHaveBeenCalledWith(makeTrack('two'), expect.objectContaining({ guildId: 'guild-a', phase: 'preload' }));
        expect(manager.getSnapshot('guild-a')).toEqual({
            current: makeTrack('one'),
            pending: [makeTrack('two')]
        });
        expect(manager.skip('guild-a')).toBe(true);
    });

    it('advances on idle using the preload, then starts elevator music', async () => {
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), null);
        await flushTransitions();
        manager.enqueue('guild-a', makeTrack('two'), null);
        await flushTransitions();
        const preloaded = resources.createTrackResource.mock.results.at(-1)!.value;

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        expect(resources.release).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ id: 'one' })
        }));
        expect(player.play).toHaveBeenLastCalledWith(preloaded);

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        expect(resources.createElevatorResource).toHaveBeenCalled();
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ kind: 'elevator' })
        }));
    });

    it('autoplays a related track when an enabled queue becomes empty', async () => {
        const related = { ...makeTrack('related'), autoplay: true };
        const autoplayResolver = {
            resolveAutoplayCandidates: vi.fn().mockResolvedValue([related])
        };
        manager = createManager({
            autoplayResolver: autoplayResolver as AutoplayTrackResolver
        });
        await manager.connect('guild-a', 'voice-a', {} as any);
        expect(manager.isAutoplayEnabled('guild-a')).toBe(false);

        const seed = makeTrack('seed');
        manager.enqueue('guild-a', seed, null);
        await flushTransitions();
        expect(manager.setAutoplay('guild-a', true)).toBe(true);
        expect(manager.isAutoplayEnabled('guild-a')).toBe(true);

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();

        expect(autoplayResolver.resolveAutoplayCandidates).toHaveBeenCalledWith(
            seed,
            50,
            expect.any(AbortSignal)
        );
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: related }));
        expect(resources.createElevatorResource).not.toHaveBeenCalled();
    });

    it('switches elevator music to autoplay as soon as autoplay is enabled', async () => {
        const related = { ...makeTrack('related'), autoplay: true };
        const autoplayResolver = {
            resolveAutoplayCandidates: vi.fn().mockResolvedValue([related])
        };
        manager = createManager({
            autoplayResolver: autoplayResolver as AutoplayTrackResolver
        });
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('seed'), null);
        await flushTransitions();
        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ kind: 'elevator' })
        }));

        manager.setAutoplay('guild-a', true);
        await flushTransitions();

        expect(player.stop).toHaveBeenCalled();
        expect(resources.release).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ kind: 'elevator' })
        }));
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: related }));
    });

    it('preserves the inactivity deadline when autoplay has no playback history', async () => {
        vi.useFakeTimers();
        const autoplayResolver = {
            resolveAutoplayCandidates: vi.fn().mockResolvedValue([])
        };
        manager = createManager({
            autoplayResolver: autoplayResolver as AutoplayTrackResolver,
            inactivityTimeoutMs: 20,
            emptySessionTimeoutMs: 10
        });
        await manager.connect('guild-a', 'voice-a', {} as any);

        manager.setAutoplay('guild-a', true);
        await flushTransitions();
        await vi.advanceTimersByTimeAsync(10);
        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        await vi.advanceTimersByTimeAsync(10);

        expect(autoplayResolver.resolveAutoplayCandidates).not.toHaveBeenCalled();
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
    });

    it('aggregates cached lookups from recent playback seeds', async () => {
        const first = makeTrack('first');
        const second = makeTrack('second');
        const related = { ...makeTrack('related'), autoplay: true };
        const autoplayResolver = {
            resolveAutoplayCandidates: vi.fn()
                .mockResolvedValueOnce([{ ...first, autoplay: true }, { ...second, autoplay: true }])
                .mockResolvedValueOnce([related])
                .mockResolvedValue([])
        };
        const selector = new AutoplaySelector({ next: () => 0.99 });
        manager = createManager({
            autoplayResolver: autoplayResolver as AutoplayTrackResolver,
            autoplaySelector: selector
        });
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', first, null);
        manager.enqueue('guild-a', second, null);
        await flushTransitions();
        manager.setAutoplay('guild-a', true);

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();

        expect(autoplayResolver.resolveAutoplayCandidates).toHaveBeenCalledTimes(3);
        expect(autoplayResolver.resolveAutoplayCandidates.mock.calls[0]![0]).toEqual(first);
        expect(autoplayResolver.resolveAutoplayCandidates.mock.calls[1]![0]).toEqual(second);
        expect(autoplayResolver.resolveAutoplayCandidates.mock.calls[2]![0]).toBe(related);
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: related }));
    });

    it('reuses a bounded session candidate pool when a seed appears again', async () => {
        const first = makeTrack('first');
        const second = makeTrack('second');
        const autoplayOne = { ...makeTrack('autoplay-one'), autoplay: true };
        const autoplayTwo = { ...makeTrack('autoplay-two'), autoplay: true };
        const manualCandidate = { ...makeTrack('manual-candidate'), autoplay: true };
        const autoplayResolver = {
            resolveAutoplayCandidates: vi.fn().mockImplementation((seed: TrackMetadata) => {
                if (seed.id === 'second') return Promise.resolve([autoplayOne]);
                if (seed.id === 'first') return Promise.resolve([manualCandidate]);
                return Promise.resolve([autoplayTwo]);
            })
        };
        manager = createManager({
            autoplayResolver: autoplayResolver as AutoplayTrackResolver,
            autoplaySelector: new AutoplaySelector({ next: () => 0 })
        });
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', first, null);
        manager.enqueue('guild-a', second, null);
        await flushTransitions();
        manager.setAutoplay('guild-a', true);

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({
            metadata: autoplayOne
        }));

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();

        expect(autoplayResolver.resolveAutoplayCandidates).toHaveBeenCalledTimes(4);
        expect(autoplayResolver.resolveAutoplayCandidates.mock.calls.map(call => call[0].id))
            .toEqual(['first', 'second', 'autoplay-one', 'autoplay-two']);
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({
            metadata: autoplayTwo
        }));
    });

    it('finishes the current track before returning to elevator music when autoplay is disabled', async () => {
        const related = { ...makeTrack('related'), autoplay: true };
        const autoplayResolver = {
            resolveAutoplayCandidates: vi.fn().mockResolvedValue([related])
        };
        manager = createManager({
            autoplayResolver: autoplayResolver as AutoplayTrackResolver
        });
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('seed'), null);
        await flushTransitions();
        manager.setAutoplay('guild-a', true);
        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();

        expect(manager.setAutoplay('guild-a', false)).toBe(true);
        expect(player.stop).toHaveBeenCalledTimes(0);
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: related }));

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ kind: 'elevator' })
        }));
        expect(autoplayResolver.resolveAutoplayCandidates).toHaveBeenCalledTimes(2);
    });

    it('discards a released preload and constructs a fresh resource for the track', async () => {
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), null);
        await flushTransitions();
        manager.enqueue('guild-a', makeTrack('two'), null);
        await flushTransitions();
        const stalePreload = resources.createTrackResource.mock.results[1]!.value;
        resources.release(stalePreload);

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();

        expect(resources.release).toHaveBeenCalledWith(stalePreload);
        expect(resources.createTrackResource).toHaveBeenCalledTimes(3);
        expect(resources.createTrackResource).toHaveBeenLastCalledWith(makeTrack('two'), expect.objectContaining({ guildId: 'guild-a' }));
        expect(player.play).not.toHaveBeenLastCalledWith(stalePreload);
    });

    it('falls back to on-demand construction after preloading fails', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), null);
        await flushTransitions();
        resources.createTrackResource
            .mockImplementationOnce(() => { throw new Error('preload failed'); })
            .mockImplementationOnce((track: TrackMetadata) => makeResource(track));

        manager.enqueue('guild-a', makeTrack('two'), null);
        await flushTransitions();
        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();

        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('audio.preload_failed')
        );
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ id: 'two' })
        }));
    });

    it('replaces elevator music even when player.stop reports no transition', async () => {
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), null);
        await flushTransitions();
        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        player.stop.mockReturnValueOnce(false);

        expect(manager.enqueue('guild-a', makeTrack('two'), null).startsImmediately).toBe(true);
        await flushTransitions();
        expect(resources.release).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ kind: 'elevator' })
        }));
        expect(player.play).toHaveBeenLastCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ id: 'two' })
        }));
    });

    it('skips resource construction failures and continues to the next queued track', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        resources.createTrackResource
            .mockImplementationOnce(() => { throw new Error('bad source'); })
            .mockImplementationOnce((track: TrackMetadata) => makeResource(track));
        await manager.connect('guild-a', 'voice-a', {} as any);

        manager.enqueue('guild-a', makeTrack('bad'), channel);
        manager.enqueue('guild-a', makeTrack('good'), channel);
        await flushTransitions();

        expect(player.play).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ id: 'good' })
        }));
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Couldn’t play')
        }));
        expect(errorSpy).toHaveBeenCalled();
    });

    it('enforces the pending queue capacity', async () => {
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('playing'), null);
        await flushTransitions();

        for (let index = 0; index < 50; index++) {
            expect(manager.enqueue('guild-a', makeTrack(`queued-${index}`), null).accepted).toBe(true);
        }
        expect(manager.isQueueFull('guild-a')).toBe(true);
        expect(manager.enqueue('guild-a', makeTrack('overflow'), null)).toEqual({
            accepted: false, startsImmediately: false, position: 50
        });
    });

    it('rejects queue operations without an active session', () => {
        expect(() => manager.enqueue('missing', makeTrack('one'), null)).toThrow(
            'No active audio session for guild missing.'
        );
        expect(manager.isQueueFull('missing')).toBe(false);
        expect(manager.skip('missing')).toBe(false);
        expect(manager.getSnapshot('missing')).toEqual({ pending: [] });
    });

    it('logs player and connection errors and notifies for failed tracks', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const channel = { send: vi.fn().mockRejectedValue(new Error('send failed')) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();

        player.emit('error', { resource: { metadata: makeTrack('one') } });
        connection.emit('error', new Error('voice failed'));
        await flushTransitions();
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('audio.player_failed')
        );
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('voice.connection_error')
        );
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('audio.notification_failed')
        ));
    });

    it('clears the session when the connection is destroyed', async () => {
        await manager.connect('guild-a', 'voice-a', {} as any);
        connection.state = { status: VoiceConnectionStatus.Destroyed };
        connection.emit('stateChange', {}, connection.state);
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
        expect(connection.destroy).not.toHaveBeenCalled();
    });

    it('recovers transient disconnects and updates the channel', async () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        connection.joinConfig.channelId = 'voice-recovered';
        const disconnected = {
            status: VoiceConnectionStatus.Disconnected,
            reason: VoiceConnectionDisconnectReason.WebSocketClose,
            closeCode: 4015
        };
        connection.state = disconnected;
        connection.emit('stateChange', {}, disconnected);
        await flushTransitions();

        expect(entersStateMock).toHaveBeenCalledWith(
            connection,
            VoiceConnectionStatus.Ready,
            expect.any(AbortSignal)
        );
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-recovered');
        expect(infoSpy).toHaveBeenCalled();
        expect(infoSpy.mock.calls.map(([line]) => JSON.parse(line))).toEqual(expect.arrayContaining([
            expect.objectContaining({ event: 'voice.recovery_succeeded', guildId: 'guild-a' })
        ]));
    });

    it('keeps the session when a ready state cancels an in-flight recovery', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        let recoverySignal: AbortSignal | undefined;
        await manager.connect('guild-a', 'voice-a', {} as any);
        entersStateMock.mockImplementationOnce((_target, _status, signal: AbortSignal) => {
            recoverySignal = signal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
        });
        const disconnected = {
            status: VoiceConnectionStatus.Disconnected,
            reason: VoiceConnectionDisconnectReason.WebSocketClose,
            closeCode: 4015
        };
        connection.state = disconnected;
        connection.emit('stateChange', {}, disconnected);
        await flushTransitions();
        const recoveringNetworking = connection.state.networking;

        const ready = {
            status: VoiceConnectionStatus.Ready,
            networking: connection.state.networking
        };
        connection.state = ready;
        connection.emit('stateChange', disconnected, ready);
        await flushTransitions();

        expect(recoverySignal?.aborted).toBe(true);
        expect(recoveringNetworking.destroy).not.toHaveBeenCalled();
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');
        expect(connection.destroy).not.toHaveBeenCalled();
    });

    it('closes and notifies after transient recovery fails', async () => {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();
        entersStateMock.mockRejectedValue(new Error('voice unavailable'));
        const disconnected = {
            status: VoiceConnectionStatus.Disconnected,
            reason: VoiceConnectionDisconnectReason.WebSocketClose,
            closeCode: 4015
        };
        connection.state = disconnected;
        connection.emit('stateChange', {}, disconnected);

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(manager.getActiveChannelId('guild-a')).toBeUndefined());
        expect(entersStateMock).toHaveBeenCalledTimes(5);
        expect(connection.configureNetworking).toHaveBeenCalledTimes(5);
        expect(connection.rejoin).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('voice.recovery_failed')
        );
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Voice connection lost')
        }));
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('about 2 minutes')
        }));
    });

    it('logs actual playback once and a failed end without repeating a source error', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await runWithLogContext({ interactionId: 'old-command' }, () => manager.connect('guild-a', 'voice-a', {} as any));
        manager.enqueue('guild-a', makeTrack('one'), null);
        await flushTransitions();
        const resource = resources.createTrackResource.mock.results[0].value;
        expect(info.mock.calls.filter(([line]) => JSON.parse(line).event === 'audio.track_started')).toHaveLength(0);
        player.emit('stateChange', { status: 'buffering' }, { status: AudioPlayerStatus.Playing, resource });
        player.emit('stateChange', { status: 'buffering' }, { status: AudioPlayerStatus.Playing, resource });
        reportResourceFailure(resource, new Error('source error'), { guildId: 'guild-a' });
        player.emit('error', Object.assign(new Error('wrapped error'), { resource }));
        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        expect(errors).toHaveBeenCalledOnce();
        const records = info.mock.calls.map(([line]) => JSON.parse(line));
        expect(records.filter(record => record.event === 'audio.track_started')).toHaveLength(1);
        expect(records.find(record => record.event === 'audio.track_ended')).toMatchObject({ reason: 'failed', started: true, trackId: 'one' });
        expect(records.every(record => !('interactionId' in record))).toBe(true);
    });

    it('observes failed scheduled work without an unhandled rejection', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        const session = (manager as any).sessions.get('guild-a');
        await expect((manager as any).schedule(session, async () => { throw new Error('transition failure'); })).resolves.toBeUndefined();
        expect(errors.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
            expect.objectContaining({ event: 'audio.transition_failed', guildId: 'guild-a', error: expect.objectContaining({ message: 'transition failure' }) })
        ]);
    });

    it('recovers a transient outage on a later backoff attempt', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        entersStateMock
            .mockRejectedValueOnce(new Error('voice unavailable'))
            .mockRejectedValueOnce(new Error('voice unavailable'))
            .mockResolvedValueOnce(connection);
        const disconnected = {
            status: VoiceConnectionStatus.Disconnected,
            reason: VoiceConnectionDisconnectReason.WebSocketClose,
            closeCode: 4015
        };
        connection.state = disconnected;
        connection.emit('stateChange', {}, disconnected);

        await vi.advanceTimersByTimeAsync(6_000);
        await flushTransitions();

        expect(connection.configureNetworking).toHaveBeenCalledTimes(3);
        expect(connection.rejoin).not.toHaveBeenCalled();
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');
        expect(connection.destroy).not.toHaveBeenCalled();
    });

    it('replaces an already opening socket on the first recovery attempt', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        const oldNetworking = Object.assign(new EventEmitter(), { destroy: vi.fn() });
        const connecting = { status: VoiceConnectionStatus.Connecting, networking: oldNetworking };
        connection.state = connecting;
        connection.emit('stateChange', {}, connecting);
        await flushTransitions();

        expect(connection.configureNetworking).toHaveBeenCalledOnce();
        expect(oldNetworking.destroy).toHaveBeenCalledOnce();
        expect(connection.state.networking).not.toBe(oldNetworking);
    });

    it('opens a new voice WebSocket for each failed recovery attempt', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        manager = createManager({
            voiceRecoveryPolicy: new VoiceRecoveryPolicy({
                maxAttempts: 2,
                initialBackoffMs: 10,
                attemptTimeoutMs: 20
            })
        });
        await manager.connect('guild-a', 'voice-a', {} as any);
        entersStateMock
            .mockRejectedValueOnce(new Error('Unexpected server response: 521'))
            .mockImplementation((_target, _status, signal: AbortSignal) => (
                new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                })
            ));

        const oldState = connection.state;
        connection.state = { status: VoiceConnectionStatus.Signalling };
        connection.emit('stateChange', oldState, connection.state);
        await flushTransitions();
        const firstNetworking = connection.configureNetworking.mock.results[0]!.value;

        expect(firstNetworking.destroy).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10);
        const secondNetworking = connection.state.networking;
        expect(secondNetworking).not.toBe(firstNetworking);
        expect(connection.configureNetworking).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(20);
        expect(secondNetworking.destroy).toHaveBeenCalled();
        expect(connection.rejoin).not.toHaveBeenCalled();
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
    });

    it('keeps recovering when a concurrent connect times out', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        entersStateMock.mockImplementationOnce((_target, _status, signal: AbortSignal) => (
            new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            })
        ));
        const disconnected = {
            status: VoiceConnectionStatus.Disconnected,
            reason: VoiceConnectionDisconnectReason.WebSocketClose,
            closeCode: 4015
        };
        connection.state = disconnected;
        connection.emit('stateChange', {}, disconnected);
        await flushTransitions();

        entersStateMock.mockRejectedValueOnce(new Error('command readiness timed out'));
        await expect(manager.connect('guild-a', 'voice-a', {} as any)).rejects.toThrow(
            'command readiness timed out'
        );
        expect(connection.destroy).not.toHaveBeenCalled();
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');

        const ready = { status: VoiceConnectionStatus.Ready };
        connection.state = ready;
        connection.emit('stateChange', disconnected, ready);
        await flushTransitions();
        expect(connection.destroy).not.toHaveBeenCalled();
    });

    it('waits for voice readiness before starting the next queued track', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), null);
        manager.enqueue('guild-a', makeTrack('two'), null);
        await flushTransitions();

        const disconnected = {
            status: VoiceConnectionStatus.Disconnected,
            reason: VoiceConnectionDisconnectReason.WebSocketClose,
            closeCode: 4015
        };
        connection.state = disconnected;
        connection.emit('stateChange', {}, disconnected);
        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();

        expect(manager.getSnapshot('guild-a').current).toBeUndefined();
        expect(manager.getSnapshot('guild-a').pending.map(track => track.id)).toEqual(['two']);

        const ready = { status: VoiceConnectionStatus.Ready };
        connection.state = ready;
        connection.emit('stateChange', disconnected, ready);
        await flushTransitions();
        expect(manager.getSnapshot('guild-a').current?.id).toBe('two');
    });

    it('closes after failed external-disconnect recovery', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();
        entersStateMock.mockRejectedValueOnce(new Error('gone'));
        const disconnected = {
            status: VoiceConnectionStatus.Disconnected,
            reason: VoiceConnectionDisconnectReason.Manual
        };
        connection.state = disconnected;
        connection.emit('stateChange', {}, disconnected);

        await vi.waitFor(() => expect(manager.getActiveChannelId('guild-a')).toBeUndefined());
        expect(connection.destroy).toHaveBeenCalled();
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Disconnected from voice')
        }));
    });

    it.each([4006, 4009])('rejoins with fresh credentials after voice close %i and preserves playback', async (code) => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const adapterCreator = vi.fn() as any;
        await manager.connect('guild-a', 'voice-a', adapterCreator);
        manager.enqueue('guild-a', makeTrack('one'), null);
        manager.enqueue('guild-a', makeTrack('two'), null);
        manager.setAutoplay('guild-a', true);
        await flushTransitions();
        const snapshot = manager.getSnapshot('guild-a');
        resources.release.mockClear();
        const staleNetworking = connection.state.networking;
        const replacement = createConnection(VoiceConnectionStatus.Connecting);
        joinMock.mockReturnValue(replacement);

        staleNetworking.emit('close', code);
        await flushTransitions();

        expect(connection.destroy).toHaveBeenCalledOnce();
        expect(connection.configureNetworking).not.toHaveBeenCalled();
        expect(replacement.configureNetworking).not.toHaveBeenCalled();
        expect(joinMock).toHaveBeenLastCalledWith(expect.objectContaining({
            guildId: 'guild-a', channelId: 'voice-a', adapterCreator
        }));
        expect(replacement.subscribe).toHaveBeenCalledWith(player);
        expect(playerFactoryMock).toHaveBeenCalledOnce();
        expect(manager.getSnapshot('guild-a')).toEqual(snapshot);
        expect(manager.isAutoplayEnabled('guild-a')).toBe(true);
        expect(resources.release).not.toHaveBeenCalled();
        expect(player.stop).not.toHaveBeenCalled();

        // Late events from the destroyed connection must not clear the new session.
        connection.emit('stateChange', {}, { status: VoiceConnectionStatus.Destroyed });
        staleNetworking.emit('close', 4021);
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');
        const oldState = replacement.state;
        replacement.state = { ...oldState, status: VoiceConnectionStatus.Ready };
        replacement.emit('stateChange', oldState, replacement.state);
        expect(await manager.connect('guild-a', 'voice-a', adapterCreator)).toBe(replacement);

        // The replacement retains terminal-close handling too.
        replacement.state.networking.emit('close', 4022);
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
        expect(replacement.destroy).toHaveBeenCalledOnce();
    });

    it('interrupts an in-flight socket retry when Discord invalidates the session', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        let waitingSignal: AbortSignal | undefined;
        entersStateMock.mockImplementationOnce((_target, _status, signal: AbortSignal) => {
            waitingSignal = signal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        });
        const oldState = connection.state;
        connection.state = { status: VoiceConnectionStatus.Signalling };
        connection.emit('stateChange', oldState, connection.state);
        await flushTransitions();
        const retryNetworking = connection.state.networking;
        const replacement = createConnection(VoiceConnectionStatus.Signalling);
        joinMock.mockReturnValue(replacement);

        retryNetworking.emit('close', 4006);
        await flushTransitions();
        expect(waitingSignal?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(2_000);

        expect(joinMock).toHaveBeenCalledTimes(2);
        expect(connection.destroy).toHaveBeenCalledOnce();
        expect(entersStateMock).toHaveBeenLastCalledWith(replacement, VoiceConnectionStatus.Ready, expect.any(AbortSignal));
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');
        expect(replacement.configureNetworking).not.toHaveBeenCalled();
    });

    it('bounds fresh-session retries and clears resources when they all fail', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        manager = createManager({
            voiceRecoveryPolicy: new VoiceRecoveryPolicy({ maxAttempts: 2, initialBackoffMs: 10, attemptTimeoutMs: 20 })
        });
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), null);
        manager.enqueue('guild-a', makeTrack('two'), null);
        await flushTransitions();
        const replacements = [createConnection(VoiceConnectionStatus.Signalling), createConnection(VoiceConnectionStatus.Signalling)];
        joinMock.mockReturnValueOnce(replacements[0]).mockReturnValueOnce(replacements[1]);
        entersStateMock.mockImplementation((_target, _status, signal: AbortSignal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }));

        connection.state.networking.emit('close', 4006);
        await vi.advanceTimersByTimeAsync(50);

        expect(joinMock).toHaveBeenCalledTimes(3);
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
        expect(replacements.every(item => item.destroy.mock.calls.length === 1)).toBe(true);
        expect(resources.release).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ id: 'one' }) }));
        expect(resources.release).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ id: 'two' }) }));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('discards cached gateway credentials and sends a leave/join through the real voice adapter', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const voice = await vi.importActual<typeof import('@discordjs/voice')>('@discordjs/voice');
        const sendPayload = vi.fn().mockReturnValue(true);
        const adapterCreator = vi.fn(() => ({ sendPayload, destroy: vi.fn() }));
        joinMock.mockImplementation(voice.joinVoiceChannel);
        playerFactoryMock.mockReturnValue(voice.createAudioPlayer());
        // Stub readiness so no socket is opened; exercise the real connection and adapter lifecycle.
        const original = await manager.connect('guild-a', 'voice-a', adapterCreator);
        original.packets.state = { session_id: 'expired-session', user_id: 'bot', channel_id: 'voice-a' } as any;
        original.packets.server = { endpoint: 'expired-endpoint', token: 'expired-token', guild_id: 'guild-a' };
        const session = (manager as any).sessions.get('guild-a');
        session.needsFreshVoiceSession = true;

        await (manager as any).recoverConnection(session);

        expect(original.state.status).toBe(VoiceConnectionStatus.Destroyed);
        expect(session.connection).not.toBe(original);
        expect(session.connection.packets).toEqual({});
        expect(adapterCreator).toHaveBeenCalledTimes(2);
        expect(sendPayload.mock.calls.map(([payload]) => payload.d.channel_id)).toEqual(['voice-a', null, 'voice-a']);
        expect(session.connection.state.status).toBe(VoiceConnectionStatus.Signalling);
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');
    });

    it('does not start a queued recovery after the voice connection has already become ready', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        const ready = connection.state;
        const signalling = { status: VoiceConnectionStatus.Signalling };
        connection.state = signalling;
        connection.emit('stateChange', ready, signalling);
        connection.state = ready;
        connection.emit('stateChange', signalling, ready);
        await flushTransitions();

        expect(connection.configureNetworking).not.toHaveBeenCalled();
        expect(connection.destroy).not.toHaveBeenCalled();
    });

    it('cancels a fresh voice join when the user disconnects during recovery', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        const replacement = createConnection(VoiceConnectionStatus.Signalling);
        joinMock.mockReturnValue(replacement);
        let waitingSignal: AbortSignal | undefined;
        entersStateMock.mockImplementationOnce((_target, _status, signal: AbortSignal) => {
            waitingSignal = signal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        });

        connection.state.networking.emit('close', 4006);
        await flushTransitions();
        manager.disconnect('guild-a');
        await vi.advanceTimersByTimeAsync(120_000);

        expect(waitingSignal?.aborted).toBe(true);
        expect(joinMock).toHaveBeenCalledTimes(2);
        expect(replacement.destroy).toHaveBeenCalledOnce();
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('handles terminal networking closes and applies a temporary rate-limit cooldown', async () => {
        vi.useFakeTimers();
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();

        connection.state.networking.emit('close', 4021);
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
        await expect(manager.connect('guild-a', 'voice-a', {} as any)).rejects.toBeInstanceOf(
            VoiceConnectionRateLimitError
        );

        await vi.advanceTimersByTimeAsync(60_000);
        connection = createConnection();
        joinMock.mockReturnValue(connection);
        expect(await manager.connect('guild-a', 'voice-a', {} as any)).toBe(connection);
    });

    it('clears a terminated call without applying a rate-limit cooldown', async () => {
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();

        connection.state.networking.emit('close', 4022);
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Voice call ended')
        }));

        connection = createConnection();
        player = createPlayer();
        joinMock.mockReturnValue(connection);
        playerFactoryMock.mockReturnValue(player);
        await expect(manager.connect('guild-a', 'voice-a', {} as any)).resolves.toBe(connection);
    });

    it('ignores networking closes from a session that has already been replaced', async () => {
        await manager.connect('guild-a', 'voice-a', {} as any);
        const staleNetworking = connection.state.networking as EventEmitter;
        manager.disconnect('guild-a');

        connection = createConnection();
        player = createPlayer();
        joinMock.mockReturnValue(connection);
        playerFactoryMock.mockReturnValue(player);
        await manager.connect('guild-a', 'voice-a', {} as any);

        staleNetworking.emit('close', 4021);

        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');
        expect(connection.destroy).not.toHaveBeenCalled();
    });

    it('observes each networking instance only once', async () => {
        await manager.connect('guild-a', 'voice-a', {} as any);
        const networking = connection.state.networking as EventEmitter;
        expect(networking.listenerCount('close')).toBe(1);

        const connecting = { status: VoiceConnectionStatus.Connecting, networking };
        connection.state = connecting;
        connection.emit('stateChange', {}, connecting);
        await flushTransitions();

        expect(networking.listenerCount('close')).toBe(1);
    });

    it('ignores nonterminal networking close codes', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await manager.connect('guild-a', 'voice-a', {} as any);
        connection.state.networking.emit('close', 4001);
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');
    });

    it('disconnects an empty session after its initial inactivity timeout', async () => {
        vi.useFakeTimers();
        manager = createManager({
            inactivityTimeoutMs: 20,
            emptySessionTimeoutMs: 10
        });
        await manager.connect('guild-a', 'voice-a', {} as any);

        await vi.advanceTimersByTimeAsync(10);
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
        expect(connection.destroy).toHaveBeenCalled();
    });

    it('cancels the initial timeout while playing and starts a fresh timeout when the queue ends', async () => {
        vi.useFakeTimers();
        manager = createManager({
            inactivityTimeoutMs: 20,
            emptySessionTimeoutMs: 10
        });
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();

        await vi.advanceTimersByTimeAsync(10);
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        await vi.advanceTimersByTimeAsync(20);

        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Disconnected after')
        }));
    });

    it('watchdog stops a track that never starts and falls back when stop returns false', async () => {
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.useFakeTimers();
        manager = createManager({
            trackStartupTimeoutMs: 10,
            trackStallTimeoutMs: 20,
            trackWatchdogIntervalMs: 5
        });
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        player.play.mockImplementation(() => {
            player.state = { status: AudioPlayerStatus.Buffering };
        });
        player.stop.mockReturnValue(false);
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();

        await vi.advanceTimersByTimeAsync(10);
        await flushTransitions();
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('didn’t start in time')
        }));
        expect(resources.release).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ id: 'one' })
        }));
        expect(warnings.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
            expect.objectContaining({ event: 'audio.watchdog_stopped', guildId: 'guild-a', trackId: 'one', reason: 'Playback didn’t start in time' })
        ]);
        expect(info.mock.calls.map(([line]) => JSON.parse(line))).toEqual(expect.arrayContaining([
            expect.objectContaining({ event: 'audio.track_ended', trackId: 'one', started: false, reason: 'Playback didn’t start in time' })
        ]));
    });

    it('watchdog stops playback that stops making progress and lets idle release it', async () => {
        vi.useFakeTimers();
        manager = createManager({
            trackStartupTimeoutMs: 10,
            trackStallTimeoutMs: 10,
            trackWatchdogIntervalMs: 5
        });
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();
        const resource = resources.createTrackResource.mock.results[0]!.value;

        await vi.advanceTimersByTimeAsync(10);

        expect(player.stop).toHaveBeenCalledWith(true);
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Playback stalled')
        }));
        expect(resources.release).not.toHaveBeenCalledWith(resource);

        player.emit(AudioPlayerStatus.Idle);
        await flushTransitions();
        expect(resources.release).toHaveBeenCalledWith(resource);
    });

    it('watchdog stops a track that stalls after entering a non-playing state', async () => {
        vi.useFakeTimers();
        manager = createManager({
            trackStartupTimeoutMs: 10,
            trackStallTimeoutMs: 10,
            trackWatchdogIntervalMs: 5
        });
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();
        const resource = resources.createTrackResource.mock.results[0]!.value;
        resource.playbackDuration = 1;
        await vi.advanceTimersByTimeAsync(5);

        player.state = { status: AudioPlayerStatus.Buffering };
        await vi.advanceTimersByTimeAsync(10);

        expect(player.stop).toHaveBeenCalledWith(true);
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Playback stalled')
        }));
    });

    it('does not treat a voice outage as a stalled track', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        manager = createManager({
            trackStartupTimeoutMs: 10,
            trackStallTimeoutMs: 10,
            trackWatchdogIntervalMs: 5
        });
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), null);
        await flushTransitions();
        const resource = resources.createTrackResource.mock.results[0]!.value;
        resource.playbackDuration = 1;
        await vi.advanceTimersByTimeAsync(5);

        const disconnected = {
            status: VoiceConnectionStatus.Disconnected,
            reason: VoiceConnectionDisconnectReason.WebSocketClose,
            closeCode: 4015
        };
        connection.state = disconnected;
        connection.emit('stateChange', {}, disconnected);
        player.state = { status: AudioPlayerStatus.AutoPaused };
        await vi.advanceTimersByTimeAsync(40);

        expect(player.stop).not.toHaveBeenCalled();
        expect(manager.getSnapshot('guild-a').current?.id).toBe('one');

        const ready = { status: VoiceConnectionStatus.Ready };
        connection.state = ready;
        connection.emit('stateChange', disconnected, ready);
        player.state = { status: AudioPlayerStatus.Playing };
        await vi.advanceTimersByTimeAsync(5);

        expect(player.stop).not.toHaveBeenCalled();

        resource.playbackDuration = 2;
        await vi.advanceTimersByTimeAsync(5);

        expect(player.stop).not.toHaveBeenCalled();
        expect(manager.getSnapshot('guild-a').current?.id).toBe('one');
    });

    it('watchdog stops a progressing track after its duration safety limit', async () => {
        vi.useFakeTimers();
        manager = createManager({
            trackStartupTimeoutMs: 10,
            trackStallTimeoutMs: 100_000,
            trackWatchdogIntervalMs: 20_000
        });
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one', 1), channel);
        await flushTransitions();
        const resource = resources.createTrackResource.mock.results[0]!.value;

        for (let tick = 1; tick <= 4; tick++) {
            resource.playbackDuration = tick;
            await vi.advanceTimersByTimeAsync(20_000);
        }

        expect(player.stop).toHaveBeenCalledWith(true);
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('longer than expected')
        }));
    });
});
