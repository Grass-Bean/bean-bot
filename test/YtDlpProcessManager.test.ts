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

    it('validates process-owned options', () => {
        expect(() => new YtDlpProcessManager({ forceKillTimeoutMs: 1.5 })).toThrow(RangeError);
        expect(() => new YtDlpProcessManager({ maxStderrBytes: 0 })).toThrow(RangeError);
        expect(() => new YtDlpProcessManager({ command: '  ' })).toThrow(TypeError);
        expect(() => new YtDlpProcessManager({
            commandArgs: [1] as unknown as string[]
        })).toThrow(TypeError);
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

    it('cancels an active collection and stops its process', async () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const controller = new AbortController();
        const result = new YtDlpProcessManager().collect([], {
            signal: controller.signal,
            timeoutMs: 100,
            maxStdoutBytes: 100
        });

        controller.abort();

        await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('times out a collection and escalates termination', async () => {
        vi.useFakeTimers();
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const result = new YtDlpProcessManager({ forceKillTimeoutMs: 5 }).collect([], {
            timeoutMs: 10,
            maxStdoutBytes: 100
        });
        const rejection = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });

        await vi.advanceTimersByTimeAsync(10);
        await rejection;
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        await vi.advanceTimersByTimeAsync(5);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
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

    it('waits for close before reporting an exit failure with complete diagnostics', async () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const handle = new YtDlpProcessManager().stream([]);
        const onCompletion = vi.fn();
        void handle.completion.then(onCompletion);

        child.stderr.emit('data', Buffer.from('first '));
        child.emit('exit', 2, null);
        child.stderr.emit('data', Buffer.from('last'));

        await Promise.resolve();
        expect(onCompletion).not.toHaveBeenCalled();

        child.emit('close', 2, null);

        await expect(handle.completion).resolves.toMatchObject({
            status: 'failed',
            error: {
                code: 'PROCESS_FAILURE',
                stderr: Buffer.from('first last')
            }
        });
        expect(onCompletion).toHaveBeenCalledOnce();
    });

    it.each([
        ['stdout', 'STDOUT_FAILURE'],
        ['stderr', 'STDERR_FAILURE']
    ] as const)('normalizes %s stream failures', async (streamName, code) => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const handle = new YtDlpProcessManager().stream([]);

        child[streamName].emit('error', new Error(`${streamName} broke`));

        await expect(handle.completion).resolves.toMatchObject({
            status: 'failed',
            error: { code }
        });
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('completes cleanly without stopping the process', async () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const handle = new YtDlpProcessManager().stream([]);

        child.emit('close', 0, null);

        await expect(handle.completion).resolves.toMatchObject({ status: 'succeeded' });
        expect(child.kill).not.toHaveBeenCalled();
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

    it('does not signal a process that has already exited', async () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const handle = new YtDlpProcessManager().stream([]);
        child.exitCode = 0;

        void handle.stop();
        child.emit('close', 0, null);

        expect(child.kill).not.toHaveBeenCalled();
        await expect(handle.completion).resolves.toMatchObject({ status: 'stopped' });
    });

    it('normalizes synchronous and asynchronous spawn failures', async () => {
        spawnMock.mockImplementationOnce(() => { throw 'synchronous failure'; });
        expect(() => new YtDlpProcessManager().stream([])).toThrow(YtDlpProcessError);

        const child = createProcess();
        spawnMock.mockReturnValueOnce(child);
        const handle = new YtDlpProcessManager().stream([]);
        const error = new Error('missing executable');
        child.emit('error', error);

        await expect(handle.completion).resolves.toMatchObject({
            status: 'failed',
            error: {
                code: 'SPAWN_FAILURE',
                cause: error
            }
        });
    });
});
