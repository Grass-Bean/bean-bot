import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => ({ spawn: spawnMock }));

import {
    YtDlpProcessError,
    YtDlpProcessManager
} from '../src/audio/YtDlpProcessManager.js';

type FakeProcess = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
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

describe('YtDlpProcessManager', () => {
    beforeEach(() => {
        spawnMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('collects bounded output and applies the configured command prefix', async () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const manager = new YtDlpProcessManager({
            command: 'custom-yt-dlp',
            commandArgs: ['--cookies', 'cookies.txt'],
            maxStderrBytes: 5
        });

        const result = manager.collect(['--dump-json', '--', 'song'], {
            timeoutMs: 100,
            maxStdoutBytes: 100
        });
        child.stdout.emit('data', Buffer.from('{"ok":true}'));
        child.stderr.emit('data', Buffer.from('12345678'));
        child.emit('close', 0, null);

        await expect(result).resolves.toEqual({
            stdout: Buffer.from('{"ok":true}'),
            stderr: Buffer.from('45678')
        });
        expect(spawnMock).toHaveBeenCalledWith(
            'custom-yt-dlp',
            ['--cookies', 'cookies.txt', '--dump-json', '--', 'song'],
            { windowsHide: true }
        );
    });

    it('does not spawn for an already-cancelled collection', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(new YtDlpProcessManager().collect([], {
            signal: controller.signal,
            timeoutMs: 100,
            maxStdoutBytes: 100
        })).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('rejects oversized output immediately and escalates termination', async () => {
        vi.useFakeTimers();
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const manager = new YtDlpProcessManager({ forceKillTimeoutMs: 5 });
        const result = manager.collect([], { timeoutMs: 100, maxStdoutBytes: 4 });

        child.stdout.emit('data', Buffer.from('12345'));
        await expect(result).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        await vi.advanceTimersByTimeAsync(5);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('reports a process failure once even when exit and close both fire', async () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const handle = new YtDlpProcessManager().stream([]);
        const onFailure = vi.fn();
        handle.onFailure(onFailure);

        child.stderr.emit('data', Buffer.from('diagnostic'));
        child.emit('exit', 2, null);
        child.emit('close', 2, null);

        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
            code: 'PROCESS_FAILURE',
            stderr: Buffer.from('diagnostic')
        }));
        await expect(handle.completion).resolves.toMatchObject({ status: 'failed' });
    });

    it('stops idempotently and cancels forced termination after close', async () => {
        vi.useFakeTimers();
        const child = createProcess();
        const unpipeSpy = vi.spyOn(child.stdout, 'unpipe');
        const resumeSpy = vi.spyOn(child.stdout, 'resume');
        spawnMock.mockReturnValue(child);
        const handle = new YtDlpProcessManager({ forceKillTimeoutMs: 5 }).stream([]);

        void handle.stop();
        void handle.stop();
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(unpipeSpy).toHaveBeenCalledOnce();
        expect(resumeSpy).toHaveBeenCalledOnce();

        child.emit('close', 0, null);
        await vi.advanceTimersByTimeAsync(5);

        expect(child.kill).toHaveBeenCalledTimes(1);
        await expect(handle.completion).resolves.toMatchObject({ status: 'stopped' });
    });

    it('normalizes synchronous and asynchronous spawn failures', async () => {
        spawnMock.mockImplementationOnce(() => { throw 'synchronous failure'; });
        expect(() => new YtDlpProcessManager().stream([])).toThrow(YtDlpProcessError);

        const child = createProcess();
        spawnMock.mockReturnValueOnce(child);
        const handle = new YtDlpProcessManager().stream([]);
        const onFailure = vi.fn();
        handle.onFailure(onFailure);
        const error = new Error('missing executable');
        child.emit('error', error);

        expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
            code: 'SPAWN_FAILURE',
            cause: error
        }));
        await expect(handle.completion).resolves.toMatchObject({ status: 'failed' });
    });
});
