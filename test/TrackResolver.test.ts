import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackResolver, TrackResolverError } from '../src/audio/TrackResolver.js';
import { YtDlpProcessError } from '../src/audio/YtDlpProcessManager.js';
import type { YtDlpProcessClient, YtDlpMetadata } from '../src/audio/types.js';

const metadata = (overrides: Partial<YtDlpMetadata> = {}): YtDlpMetadata => ({
    title: 'A Song',
    webpage_url: 'https://www.youtube.com/watch?v=abc',
    duration: 42,
    thumbnail: 'https://img.youtube.com/cover.jpg',
    ...overrides
});

const collected = (value: unknown) => ({
    stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    stderr: Buffer.alloc(0)
});

const createProcesses = () => ({
    collect: vi.fn(),
    stream: vi.fn()
}) as unknown as YtDlpProcessClient;

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
    let processes: YtDlpProcessClient;

    beforeEach(() => {
        processes = createProcesses();
    });

    it('validates resolver-owned options', () => {
        expect(() => new TrackResolver({ timeoutMs: 0 }, processes)).toThrow(RangeError);
        expect(() => new TrackResolver({ maxStdoutBytes: 16 * 1024 * 1024 + 1 }, processes))
            .toThrow(RangeError);
    });

    it.each([
        ['', 'INVALID_INPUT'],
        ['https://[invalid', 'INVALID_INPUT'],
        ['ftp://youtube.com/video', 'UNSUPPORTED_URL'],
        ['https://example.com/video', 'UNSUPPORTED_URL']
    ] as const)('rejects invalid input %j before invoking yt-dlp', async (query, code) => {
        await expectResolverError(new TrackResolver({}, processes).resolve(query, 'user-a'), code);
        expect(processes.collect).not.toHaveBeenCalled();
    });

    it('builds metadata arguments and normalizes a successful response', async () => {
        vi.mocked(processes.collect).mockResolvedValue(collected(metadata({
            title: '  A\u0000 Song  '
        })));
        const resolver = new TrackResolver({}, processes);

        await expect(resolver.resolve('song name', 'user-a')).resolves.toMatchObject({
            kind: 'track',
            title: 'A  Song',
            url: 'https://www.youtube.com/watch?v=abc',
            duration: 42,
            thumbnail: 'https://img.youtube.com/cover.jpg',
            requestedBy: 'user-a'
        });
        expect(processes.collect).toHaveBeenCalledWith(
            [
                '--ignore-config', '--dump-json', '--no-playlist', '--quiet',
                '--', 'ytsearch1:song name'
            ],
            {
                signal: undefined,
                timeoutMs: 15_000,
                maxStdoutBytes: 1_000_000
            }
        );
    });

    it('accepts supported direct URLs, truncates titles, and drops unsafe thumbnails', async () => {
        vi.mocked(processes.collect).mockResolvedValue(collected(metadata({
            title: '🎵'.repeat(220),
            webpage_url: 'https://youtu.be/abc',
            duration: null,
            thumbnail: 'file:///secret'
        })));

        const result = await new TrackResolver({}, processes)
            .resolve('https://youtu.be/abc', 'user-b');

        expect(Array.from(result.title)).toHaveLength(200);
        expect(result.title.endsWith('…')).toBe(true);
        expect(result.duration).toBeUndefined();
        expect(result.thumbnail).toBeUndefined();
        expect(vi.mocked(processes.collect).mock.calls[0]![0]).toContain('https://youtu.be/abc');
    });

    it.each([
        ['not json', 'yt-dlp returned malformed metadata.'],
        [JSON.stringify({ title: '', webpage_url: 'https://youtube.com/a' }), 'yt-dlp returned incomplete track metadata.'],
        [JSON.stringify({ title: 'Song', webpage_url: 'https://evil.test/a' }), 'yt-dlp returned unsafe track metadata.'],
        [JSON.stringify({ title: 'Song', webpage_url: 'https://user:pass@youtube.com/a' }), 'yt-dlp returned unsafe track metadata.']
    ])('rejects invalid successful output', async (output, message) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.mocked(processes.collect).mockResolvedValue(collected(output));

        await expect(new TrackResolver({}, processes).resolve('song', 'user'))
            .rejects.toMatchObject({ code: 'INVALID_RESPONSE', message });
    });

    it.each([
        ['CANCELLED', 'CANCELLED'],
        ['TIMEOUT', 'TIMEOUT'],
        ['OUTPUT_LIMIT', 'OUTPUT_LIMIT']
    ] as const)('maps manager failure %s to resolver failure %s', async (sourceCode, targetCode) => {
        vi.mocked(processes.collect).mockRejectedValue(new YtDlpProcessError(
            'operation failed',
            sourceCode
        ));

        await expectResolverError(
            new TrackResolver({}, processes).resolve('song', 'user'),
            targetCode
        );
    });

    it('maps process exits and redacts diagnostic URL query strings', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.mocked(processes.collect).mockRejectedValue(new YtDlpProcessError(
            'yt-dlp exited with code 2',
            'PROCESS_FAILURE',
            Buffer.from('failed https://youtube.com/watch?v=secret\n')
        ));

        await expectResolverError(
            new TrackResolver({ logDiagnostics: true }, processes).resolve('song', 'user'),
            'PROCESS_FAILURE'
        );
        expect(errorSpy).toHaveBeenCalledWith(
            '[yt-dlp Diagnostic]',
            'failed https://youtube.com/watch?[redacted]'
        );
    });

    it('wraps manager startup failures', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const cause = Object.assign(new Error('missing command'), { code: 'ENOENT' });
        vi.mocked(processes.collect).mockRejectedValue(new YtDlpProcessError(
            'Failed to start yt-dlp: missing command',
            'SPAWN_FAILURE',
            Buffer.alloc(0),
            { cause }
        ));

        await expect(new TrackResolver({}, processes).resolve('song', 'user'))
            .rejects.toMatchObject({ code: 'PROCESS_FAILURE', cause });
        expect(errorSpy).toHaveBeenCalled();
    });

    it('cancels before collection or passes the signal through', async () => {
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await expectResolverError(
            new TrackResolver({}, processes).resolve('song', 'user', alreadyAborted.signal),
            'CANCELLED'
        );
        expect(processes.collect).not.toHaveBeenCalled();

        const active = new AbortController();
        vi.mocked(processes.collect).mockResolvedValue(collected(metadata()));
        await new TrackResolver({}, processes).resolve('song', 'user', active.signal);
        expect(processes.collect).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({ signal: active.signal })
        );
    });
});
