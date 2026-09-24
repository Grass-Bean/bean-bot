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
    VoiceConnectionRateLimitError
} from '../src/audio/GuildAudioSessionManager.js';
import type { AudioResourceManager } from '../src/audio/AudioResourceManager.js';
import type { BeanAudioResource, TrackMetadata } from '../src/audio/types.js';

type FakeConnection = EventEmitter & {
    state: any;
    joinConfig: { channelId: string };
    subscribe: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
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
    connection.destroy = vi.fn(() => {
        connection.state = { status: VoiceConnectionStatus.Destroyed };
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

describe('GuildAudioSessionManager', () => {
    let connection: FakeConnection;
    let player: FakePlayer;
    let resources: ReturnType<typeof createResources>;
    let manager: GuildAudioSessionManager;

    beforeEach(() => {
        vi.clearAllMocks();
        connection = createConnection();
        player = createPlayer();
        resources = createResources();
        joinMock.mockReturnValue(connection);
        playerFactoryMock.mockReturnValue(player);
        entersStateMock.mockImplementation(async (target) => target);
        manager = new GuildAudioSessionManager(
            resources as unknown as AudioResourceManager,
            300_000,
            15_000,
            15_000,
            600_000,
            20_000,
            30_000,
            5_000,
            5_000,
            60_000
        );
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

    it('closes a reused connecting session when its readiness check fails', async () => {
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
        expect(connection.destroy).toHaveBeenCalledOnce();
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
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
        expect(resources.createTrackResource).toHaveBeenCalledWith(makeTrack('two'));
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
        expect(resources.createTrackResource).toHaveBeenLastCalledWith(makeTrack('two'));
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
            expect.stringContaining('Failed to preload Track two'),
            expect.any(Error)
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
            expect.stringContaining('Audio player error'),
            expect.anything()
        );
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Voice connection error'),
            expect.any(Error)
        );
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to send audio notification'),
            expect.any(Error)
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

        const ready = {
            status: VoiceConnectionStatus.Ready,
            networking: connection.state.networking
        };
        connection.state = ready;
        connection.emit('stateChange', disconnected, ready);
        await flushTransitions();

        expect(recoverySignal?.aborted).toBe(true);
        expect(manager.getActiveChannelId('guild-a')).toBe('voice-a');
        expect(connection.destroy).not.toHaveBeenCalled();
    });

    it('closes and notifies after transient recovery fails', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const channel = { send: vi.fn().mockResolvedValue(undefined) } as any;
        await manager.connect('guild-a', 'voice-a', {} as any);
        manager.enqueue('guild-a', makeTrack('one'), channel);
        await flushTransitions();
        entersStateMock.mockRejectedValueOnce(new Error('voice unavailable'));
        const disconnected = {
            status: VoiceConnectionStatus.Disconnected,
            reason: VoiceConnectionDisconnectReason.WebSocketClose,
            closeCode: 4015
        };
        connection.state = disconnected;
        connection.emit('stateChange', {}, disconnected);

        await vi.waitFor(() => expect(manager.getActiveChannelId('guild-a')).toBeUndefined());
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Voice connection recovery failed'),
            expect.any(Error)
        );
        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Voice connection lost')
        }));
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
        manager = new GuildAudioSessionManager(
            resources as unknown as AudioResourceManager,
            20,
            15_000,
            15_000,
            10
        );
        await manager.connect('guild-a', 'voice-a', {} as any);

        await vi.advanceTimersByTimeAsync(10);
        expect(manager.getActiveChannelId('guild-a')).toBeUndefined();
        expect(connection.destroy).toHaveBeenCalled();
    });

    it('cancels the initial timeout while playing and starts a fresh timeout when the queue ends', async () => {
        vi.useFakeTimers();
        manager = new GuildAudioSessionManager(
            resources as unknown as AudioResourceManager,
            20,
            15_000,
            15_000,
            10
        );
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
        vi.useFakeTimers();
        manager = new GuildAudioSessionManager(
            resources as unknown as AudioResourceManager,
            300_000,
            15_000,
            15_000,
            600_000,
            10,
            20,
            5
        );
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
    });

    it('watchdog stops playback that stops making progress and lets idle release it', async () => {
        vi.useFakeTimers();
        manager = new GuildAudioSessionManager(
            resources as unknown as AudioResourceManager,
            300_000,
            15_000,
            15_000,
            600_000,
            10,
            10,
            5
        );
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
        manager = new GuildAudioSessionManager(
            resources as unknown as AudioResourceManager,
            300_000,
            15_000,
            15_000,
            600_000,
            10,
            10,
            5
        );
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

    it('watchdog stops a progressing track after its duration safety limit', async () => {
        vi.useFakeTimers();
        manager = new GuildAudioSessionManager(
            resources as unknown as AudioResourceManager,
            300_000,
            15_000,
            15_000,
            600_000,
            10,
            100_000,
            20_000
        );
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
