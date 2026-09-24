import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, createAudioResourceMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    createAudioResourceMock: vi.fn()
}));

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('@discordjs/voice', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@discordjs/voice')>();
    return {
        ...actual,
        createAudioResource: createAudioResourceMock
    };
});

import { StreamType } from '@discordjs/voice';
import { AudioResourceManager } from '../src/audio/AudioResourceManager.js';
import type { BeanAudioResource, TrackMetadata } from '../src/audio/types.js';

type FakeProcess = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
};

const track: TrackMetadata = {
    kind: 'track',
    id: 'track-a',
    title: 'Track\u0000 A',
    url: 'https://youtube.com/watch?v=a',
    duration: 60,
    requestedBy: 'user-a'
};

const createProcess = (): FakeProcess => {
    const child = new EventEmitter() as FakeProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn().mockReturnValue(true);
    return child;
};

const createResource = (metadata = track) => {
    const playStream = new PassThrough();
    const resource = {
        metadata,
        playStream,
        playbackDuration: 0,
        volume: { setVolume: vi.fn() }
    } as unknown as BeanAudioResource;
    return resource;
};

describe('AudioResourceManager', () => {
    beforeEach(() => {
        spawnMock.mockReset();
        createAudioResourceMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('spawns yt-dlp with an argument boundary and registers a track resource', () => {
        const child = createProcess();
        const resource = createResource();
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager(100, 'yt-custom');

        expect(manager.createTrackResource(track)).toBe(resource);
        expect(spawnMock).toHaveBeenCalledWith(
            'yt-custom',
            expect.arrayContaining(['--', track.url]),
            { windowsHide: true }
        );
        expect(createAudioResourceMock).toHaveBeenCalledWith(child.stdout, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
            metadata: track
        });
        expect(manager.isReleased(resource)).toBe(false);
    });

    it('releases a track exactly once and force-kills a process that does not exit', async () => {
        vi.useFakeTimers();
        const child = createProcess();
        const resource = createResource();
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager(10);
        manager.createTrackResource(track);

        manager.release(resource);
        manager.release(resource);

        expect(manager.isReleased(resource)).toBe(true);
        expect(resource.playStream.destroyed).toBe(true);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        await vi.advanceTimersByTimeAsync(10);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('treats the play stream closing as a release and tears down the source once', () => {
        const child = createProcess();
        const resource = createResource();
        const unpipeSpy = vi.spyOn(child.stdout, 'unpipe');
        const resumeSpy = vi.spyOn(child.stdout, 'resume');
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager(100);
        manager.createTrackResource(track);

        resource.playStream.emit('close');
        resource.playStream.emit('error', new Error('late stream error'));
        manager.release(resource);

        expect(manager.isReleased(resource)).toBe(true);
        expect(unpipeSpy).toHaveBeenCalledOnce();
        expect(resumeSpy).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('cancels the force-kill timer when the child closes after SIGTERM', async () => {
        vi.useFakeTimers();
        const child = createProcess();
        const resource = createResource();
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager(10);
        manager.createTrackResource(track);

        manager.release(resource);
        child.emit('close', 0, null);
        await vi.advanceTimersByTimeAsync(10);

        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    });

    it('does not kill a process that has already exited', () => {
        const child = createProcess();
        child.exitCode = 0;
        const resource = createResource();
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager();
        manager.createTrackResource(track);

        manager.release(resource);
        expect(child.kill).not.toHaveBeenCalled();
    });

    it('leaves the resource alive when yt-dlp exits and closes successfully', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const child = createProcess();
        const resource = createResource();
        const destroySpy = vi.spyOn(resource.playStream, 'destroy');
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        const manager = new AudioResourceManager();
        manager.createTrackResource(track);

        child.emit('exit', 0, null);
        child.emit('close', 0, null);

        expect(errorSpy).not.toHaveBeenCalled();
        expect(destroySpy).not.toHaveBeenCalled();
        expect(manager.isReleased(resource)).toBe(false);
    });

    it('reports a child terminated by a signal when exit arrives before close', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const child = createProcess();
        const resource = createResource();
        const destroySpy = vi.spyOn(resource.playStream, 'destroy');
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        new AudioResourceManager().createTrackResource(track);

        child.emit('exit', null, 'SIGABRT');

        expect(destroySpy).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('terminated by SIGABRT')
        }));
    });

    it('turns child-process failures into stream errors with sanitized diagnostics', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const child = createProcess();
        const resource = createResource();
        const destroySpy = vi.spyOn(resource.playStream, 'destroy');
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        new AudioResourceManager().createTrackResource(track);

        child.stderr.emit('data', Buffer.from('private\u0000 detail'));
        child.emit('error', new Error('spawn\nfailed'));

        expect(destroySpy).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Failed to start yt-dlp: spawn failed: private  detail'
        }));
        expect(errorSpy).toHaveBeenCalledWith('[yt-dlp] Track  A:', expect.any(String));
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('handles stdout, stderr, exit, and close failures only once', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const child = createProcess();
        const resource = createResource();
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        new AudioResourceManager().createTrackResource(track);

        child.stdout.emit('error', new Error('stdout broke'));
        child.stderr.emit('error', new Error('stderr broke'));
        child.emit('exit', 3, null);
        child.emit('close', 3, null);

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(resource.playStream.destroyed).toBe(true);
    });

    it('uses close as the failure fallback when no exit failure was reported', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const child = createProcess();
        const resource = createResource();
        const destroySpy = vi.spyOn(resource.playStream, 'destroy');
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockReturnValue(resource);
        new AudioResourceManager().createTrackResource(track);

        child.emit('close', null, 'SIGABRT');
        expect(destroySpy).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('closed after signal SIGABRT')
        }));
    });

    it('stops the source if audio resource construction throws', () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        createAudioResourceMock.mockImplementation(() => { throw new Error('bad resource'); });

        expect(() => new AudioResourceManager().createTrackResource(track)).toThrow('bad resource');
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('creates quiet elevator music and releases unregistered resources safely', () => {
        const elevator = createResource({
            kind: 'elevator',
            id: 'elevator',
            title: 'Elevator Music'
        });
        createAudioResourceMock.mockReturnValue(elevator);
        const manager = new AudioResourceManager(100, 'yt-dlp', 'C:\\music\\elevator.mp3');

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

        const unknown = createResource();
        manager.release(undefined);
        manager.release(unknown);
        expect(manager.isReleased(unknown)).toBe(true);
        expect(unknown.playStream.destroyed).toBe(true);
    });

    it('marks elevator resources released when their stream closes', () => {
        const elevator = createResource({
            kind: 'elevator',
            id: 'elevator',
            title: 'Elevator Music'
        });
        createAudioResourceMock.mockReturnValue(elevator);
        const manager = new AudioResourceManager();
        manager.createElevatorResource();

        elevator.playStream.emit('close');

        expect(manager.isReleased(elevator)).toBe(true);
        manager.release(elevator);
        expect(elevator.playStream.destroyed).toBe(true);
    });
});
