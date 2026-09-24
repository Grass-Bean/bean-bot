import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn()
}));

vi.mock('child_process', () => ({
    spawn: spawnMock
}));

import { TrackResolver, TrackResolverError } from '../src/audio/TrackResolver.js';

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

const expectResolverError = async (
    promise: Promise<unknown>,
    code: TrackResolverError['code']
) => {
    await expect(promise).rejects.toMatchObject({
        name: code === 'CANCELLED' ? 'AbortError' : 'TrackResolverError',
        code
    });
};

describe('TrackResolver', () => {
    beforeEach(() => {
        spawnMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('validates constructor limits and command configuration', () => {
        expect(() => new TrackResolver({ timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new TrackResolver({ maxStdoutBytes: 16 * 1024 * 1024 + 1 })).toThrow(RangeError);
        expect(() => new TrackResolver({ forceKillTimeoutMs: 1.5 })).toThrow(RangeError);
        expect(() => new TrackResolver({ ytDlpCommand: '  ' })).toThrow(TypeError);
        expect(() => new TrackResolver({ ytDlpCommandArgs: [1] as unknown as string[] })).toThrow(TypeError);
    });

    it.each([
        ['', 'INVALID_INPUT'],
        ['  ', 'INVALID_INPUT'],
        ['https://%', 'INVALID_INPUT'],
        ['ftp://youtube.com/video', 'UNSUPPORTED_URL'],
        ['https://example.com/video', 'UNSUPPORTED_URL'],
        ['https://youtube.com.evil.test/video', 'UNSUPPORTED_URL']
    ] as const)('rejects unsafe input %j with %s', async (query, code) => {
        await expectResolverError(new TrackResolver().resolve(query, 'user-a'), code);
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('turns a text query into a single-result search and returns normalized metadata', async () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const resolver = new TrackResolver({
            ytDlpCommand: 'custom-yt-dlp',
            ytDlpCommandArgs: ['--cookies-from-browser', 'test']
        });

        const resultPromise = resolver.resolve('  song name  ', 'user-a');
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            title: '  A\u0000 Song  ',
            webpage_url: 'https://www.youtube.com/watch?v=abc',
            duration: 42,
            thumbnail: 'https://img.youtube.com/cover.jpg'
        })));
        child.emit('close', 0, null);

        await expect(resultPromise).resolves.toMatchObject({
            kind: 'track',
            title: 'A  Song',
            url: 'https://www.youtube.com/watch?v=abc',
            duration: 42,
            thumbnail: 'https://img.youtube.com/cover.jpg',
            requestedBy: 'user-a'
        });
        expect(spawnMock).toHaveBeenCalledWith(
            'custom-yt-dlp',
            [
                '--cookies-from-browser', 'test',
                '--ignore-config', '--dump-json', '--no-playlist', '--quiet',
                '--', 'ytsearch1:song name'
            ],
            { windowsHide: true }
        );
    });

    it('accepts supported direct URLs, truncates long titles, and drops unsafe thumbnails', async () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const resolver = new TrackResolver();
        const title = '🎵'.repeat(220);

        const resultPromise = resolver.resolve('https://youtu.be/abc', 'user-b');
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            title,
            webpage_url: 'https://youtu.be/abc',
            duration: null,
            thumbnail: 'file:///secret'
        })));
        child.emit('close', 0, null);

        const result = await resultPromise;
        expect(Array.from(result.title)).toHaveLength(200);
        expect(result.title.endsWith('…')).toBe(true);
        expect(result.duration).toBeUndefined();
        expect(result.thumbnail).toBeUndefined();
        expect(spawnMock.mock.calls[0][1]).toContain('https://youtu.be/abc');
    });

    it('rejects output larger than the configured bound and stops the process', async () => {
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const promise = new TrackResolver({ maxStdoutBytes: 4 }).resolve('song', 'user');

        child.stdout.emit('data', Buffer.from('12345'));

        await expectResolverError(promise, 'OUTPUT_LIMIT');
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it.each([
        ['not json', 'yt-dlp returned malformed metadata.'],
        [JSON.stringify({ title: '', webpage_url: 'https://youtube.com/a' }), 'yt-dlp returned incomplete track metadata.'],
        [JSON.stringify({ title: 'Song', webpage_url: 'https://evil.test/a' }), 'yt-dlp returned unsafe track metadata.'],
        [JSON.stringify({ title: 'Song', webpage_url: 'https://user:pass@youtube.com/a' }), 'yt-dlp returned unsafe track metadata.']
    ])('rejects invalid successful output', async (output, message) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const promise = new TrackResolver().resolve('song', 'user');

        child.stdout.emit('data', Buffer.from(output));
        child.emit('close', 0, null);

        await expect(promise).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message });
    });

    it('reports nonzero exits and redacts diagnostic URL query strings', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const promise = new TrackResolver({ logDiagnostics: true }).resolve('song', 'user');

        child.stderr.emit('data', Buffer.from('failed https://youtube.com/watch?v=secret\n'));
        child.emit('close', 2, null);

        await expectResolverError(promise, 'PROCESS_FAILURE');
        expect(errorSpy).toHaveBeenCalledWith(
            '[yt-dlp Diagnostic]',
            'failed https://youtube.com/watch?[redacted]'
        );
    });

    it('wraps asynchronous and synchronous process start failures', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const child = createProcess();
        spawnMock.mockReturnValueOnce(child);
        const asynchronous = new TrackResolver().resolve('song', 'user');
        const processError = Object.assign(new Error('missing command'), { code: 'ENOENT' });
        child.emit('error', processError);

        await expect(asynchronous).rejects.toMatchObject({
            code: 'PROCESS_FAILURE',
            cause: processError
        });
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        spawnMock.mockImplementationOnce(() => { throw 'synchronous failure'; });
        await expect(new TrackResolver().resolve('song', 'user')).rejects.toMatchObject({
            code: 'PROCESS_FAILURE',
            cause: expect.any(Error)
        });
        expect(errorSpy).toHaveBeenCalled();
    });

    it('cancels before or during lookup', async () => {
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await expectResolverError(
            new TrackResolver().resolve('song', 'user', alreadyAborted.signal),
            'CANCELLED'
        );
        expect(spawnMock).not.toHaveBeenCalled();

        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const controller = new AbortController();
        const pending = new TrackResolver().resolve('song', 'user', controller.signal);
        controller.abort();

        await expectResolverError(pending, 'CANCELLED');
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('times out and escalates from graceful to forced termination', async () => {
        vi.useFakeTimers();
        const child = createProcess();
        spawnMock.mockReturnValue(child);
        const pending = new TrackResolver({ timeoutMs: 10, forceKillTimeoutMs: 5 })
            .resolve('song', 'user');
        const rejection = expectResolverError(pending, 'TIMEOUT');

        await vi.advanceTimersByTimeAsync(10);
        await rejection;
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        await vi.advanceTimersByTimeAsync(5);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
});
