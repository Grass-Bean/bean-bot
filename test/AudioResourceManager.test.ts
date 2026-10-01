import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAudioResourceMock } = vi.hoisted(() => ({
    createAudioResourceMock: vi.fn()
}));

vi.mock('@discordjs/voice', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@discordjs/voice')>();
    return { ...actual, createAudioResource: createAudioResourceMock };
});

import { StreamType } from '@discordjs/voice';
import { AudioResourceManager, getResourceFailure, reportResourceFailure } from '../src/audio/AudioResourceManager.js';
import { runWithLogContext } from '../src/utility/logger.js';
import { YtDlpProcessError } from '../src/audio/YtDlpProcessManager.js';
import type {
    BeanAudioResource,
    TrackMetadata,
    YtDlpProcessClient,
    YtDlpProcessOutcome,
    YtDlpStreamHandle
} from '../src/audio/types.js';

const track: TrackMetadata = {
    kind: 'track',
    id: 'track-a',
    title: 'Track\u0000 A',
    url: 'https://youtube.com/watch?v=a',
    duration: 60,
    requestedBy: 'user-a'
};

const createResource = (metadata = track) => {
    const playStream = new PassThrough();
    return {
        metadata,
        playStream,
        playbackDuration: 0,
        volume: { setVolume: vi.fn() }
    } as unknown as BeanAudioResource;
};

const createHandle = () => {
    let complete!: (outcome: YtDlpProcessOutcome) => void;
    const completion = new Promise<YtDlpProcessOutcome>(resolve => {
        complete = resolve;
    });
    const handle: YtDlpStreamHandle = {
        stdout: new PassThrough(),
        completion,
        stop: vi.fn().mockResolvedValue(undefined)
    };
    return { handle, complete };
};

const createProcesses = (handle: YtDlpStreamHandle) => ({
    collect: vi.fn(),
    stream: vi.fn().mockReturnValue(handle)
}) as unknown as YtDlpProcessClient;

describe('AudioResourceManager', () => {
    beforeEach(() => {
        createAudioResourceMock.mockReset();
    });

    it('builds streaming arguments and registers the returned resource', () => {
        const { handle } = createHandle();
        const processes = createProcesses(handle);
        const resource = createResource();
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager({ processes });

        expect(manager.createTrackResource(track)).toBe(resource);
        expect(processes.stream).toHaveBeenCalledWith(expect.arrayContaining([
            '--ignore-config', '--no-playlist', '--', track.url
        ]));
        expect(createAudioResourceMock).toHaveBeenCalledWith(handle.stdout, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
            metadata: track
        });
        expect(manager.isReleased(resource)).toBe(false);
    });

    it('releases a track and its source exactly once', () => {
        const { handle } = createHandle();
        const resource = createResource();
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager({ processes: createProcesses(handle) });
        manager.createTrackResource(track);

        manager.release(resource);
        manager.release(resource);

        expect(manager.isReleased(resource)).toBe(true);
        expect(resource.playStream.destroyed).toBe(true);
        expect(handle.stop).toHaveBeenCalledOnce();
    });

    it('treats play-stream closure as release', () => {
        const { handle } = createHandle();
        const resource = createResource();
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager({ processes: createProcesses(handle) });
        manager.createTrackResource(track);

        resource.playStream.emit('close');
        resource.playStream.emit('error', new Error('late stream error'));

        expect(manager.isReleased(resource)).toBe(true);
        expect(handle.stop).toHaveBeenCalledOnce();
    });

    it('leaves buffered playback alive after clean yt-dlp completion', async () => {
        const { handle, complete } = createHandle();
        const resource = createResource();
        const destroySpy = vi.spyOn(resource.playStream, 'destroy');
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager({ processes: createProcesses(handle) });
        manager.createTrackResource(track);

        complete({
            status: 'succeeded',
            exitCode: 0,
            signal: null,
            stderr: Buffer.alloc(0)
        });
        await handle.completion;
        await Promise.resolve();

        expect(destroySpy).not.toHaveBeenCalled();
        expect(manager.isReleased(resource)).toBe(false);
    });

    it('turns manager failures into sanitized playback errors', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { handle, complete } = createHandle();
        const resource = createResource();
        const destroySpy = vi.spyOn(resource.playStream, 'destroy');
        createAudioResourceMock.mockReturnValue(resource);
        new AudioResourceManager({ processes: createProcesses(handle) }).createTrackResource(track);

        complete({
            status: 'failed',
            exitCode: null,
            signal: null,
            error: new YtDlpProcessError(
                'Failed\nto start yt-dlp',
                'SPAWN_FAILURE',
                Buffer.from('private\u0000 detail')
            )
        });
        await handle.completion;
        await Promise.resolve();

        expect(destroySpy).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Failed to start yt-dlp', cause: expect.objectContaining({ code: 'SPAWN_FAILURE' })
        }));
        expect(JSON.parse(errorSpy.mock.calls[0][0])).toMatchObject({ event: 'audio.source_failed', title: 'Track  A', error: { cause: { code: 'SPAWN_FAILURE', diagnostic: 'private  detail' } } });
        expect(handle.stop).not.toHaveBeenCalled();
    });

    it('stops the source if audio resource construction throws', () => {
        const { handle } = createHandle();
        createAudioResourceMock.mockImplementation(() => { throw new Error('bad resource'); });
        const manager = new AudioResourceManager({ processes: createProcesses(handle) });

        expect(() => manager.createTrackResource(track)).toThrow('bad resource');
        expect(handle.stop).toHaveBeenCalledOnce();
    });

    it('reports a 403 preload failure once per resource and keeps independent failures visible', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        for (let index = 0; index < 2; index++) {
            const { handle, complete } = createHandle();
            const resource = createResource();
            createAudioResourceMock.mockReturnValue(resource);
            runWithLogContext({ interactionId: 'unrelated-command' }, () => {
                new AudioResourceManager({ processes: createProcesses(handle) })
                    .createTrackResource(track, { guildId: 'guild-a', voiceChannelId: 'voice-a', phase: 'preload' });
            });
            complete({ status: 'failed', exitCode: 1, signal: null, error: new YtDlpProcessError(
                'yt-dlp closed with code 1', 'PROCESS_FAILURE',
                Buffer.from('HTTP Error 403: Forbidden\nhttps://user:pass@host/path?signed=private')
            ) });
            await handle.completion;
            await Promise.resolve();
            expect(getResourceFailure(resource)).toBeInstanceOf(Error);
            // Discord replaces the original error object but preserves the resource.
            reportResourceFailure(resource, new Error('wrapped player error'), { guildId: 'guild-a' }, 'audio.player_failed');
        }
        expect(errors).toHaveBeenCalledTimes(2);
        for (const [line] of errors.mock.calls) {
            const record = JSON.parse(line);
            expect(record).toMatchObject({ event: 'audio.source_failed', guildId: 'guild-a', phase: 'preload', error: { exitCode: 1, signal: null, cause: { code: 'PROCESS_FAILURE', httpStatus: 403 } } });
            expect(record).not.toHaveProperty('interactionId');
            expect(line).not.toContain('user:pass');
            expect(line).not.toContain('signed=private');
            expect(line).not.toContain('playStream');
        }
    });

    it('creates quiet elevator music from the configured path', () => {
        const { handle } = createHandle();
        const elevator = createResource({
            kind: 'elevator',
            id: 'elevator',
            title: 'Elevator Music'
        });
        createAudioResourceMock.mockReturnValue(elevator);
        const manager = new AudioResourceManager({
            elevatorMusicPath: 'C:\\music\\elevator.mp3',
            processes: createProcesses(handle)
        });

        expect(manager.createElevatorResource()).toBe(elevator);
        expect(createAudioResourceMock).toHaveBeenCalledWith('C:\\music\\elevator.mp3', {
            inlineVolume: true,
            metadata: {
                kind: 'elevator',
                id: 'elevator',
                title: 'Elevator Music'
            }
        });
        expect(elevator.volume?.setVolume).toHaveBeenCalledWith(0.5);
    });

    it('releases unregistered and elevator resources safely', () => {
        const { handle } = createHandle();
        const manager = new AudioResourceManager({ processes: createProcesses(handle) });
        const unknown = createResource();

        manager.release(undefined);
        manager.release(unknown);
        manager.release(unknown);

        expect(manager.isReleased(unknown)).toBe(true);
        expect(unknown.playStream.destroyed).toBe(true);

        const elevator = createResource({
            kind: 'elevator',
            id: 'elevator',
            title: 'Elevator Music'
        });
        createAudioResourceMock.mockReturnValue(elevator);
        manager.createElevatorResource();
        elevator.playStream.emit('close');
        expect(manager.isReleased(elevator)).toBe(true);
    });
});
