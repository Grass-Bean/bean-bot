import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import type {
    TrackMetadata,
    TrackResolverErrorCode,
    TrackResolverOptions,
    YtDlpMetadata
} from './types.js';

export type { TrackResolverErrorCode, TrackResolverOptions } from './types.js';

const MAX_STDERR_BYTES = 8_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_CONFIGURED_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_TRACK_TITLE_CHARACTERS = 200;
const MAX_TRACK_URL_CHARACTERS = 1_000;
const ALLOWED_MEDIA_HOSTS = ['youtube.com', 'youtube-nocookie.com', 'instagram.com'];
const ALLOWED_SHORT_LINK_HOSTS = new Set(['youtu.be', 'instagr.am']);

export class TrackResolverError extends Error {
    public constructor(
        message: string,
        public readonly code: TrackResolverErrorCode,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'TrackResolverError';
    }
}

const isYtDlpMetadata = (value: unknown): value is YtDlpMetadata => {
    if (typeof value !== 'object' || value === null) return false;

    const data = value as Record<string, unknown>;
    return (
        typeof data.title === 'string' &&
        data.title.trim().length > 0 &&
        typeof data.webpage_url === 'string' &&
        data.webpage_url.trim().length > 0 &&
        (
            data.duration === undefined ||
            data.duration === null ||
            (typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration >= 0)
        ) &&
        (
            data.thumbnail === undefined ||
            data.thumbnail === null ||
            (typeof data.thumbnail === 'string' && data.thumbnail.trim().length > 0)
        )
    );
};

const createCancellationError = (): TrackResolverError => {
    const error = new TrackResolverError(
        'Track metadata lookup was cancelled.',
        'CANCELLED'
    );
    error.name = 'AbortError';
    return error;
};

const isAllowedMediaHost = (hostname: string): boolean => {
    const normalizedHostname = hostname.toLowerCase();
    return (
        ALLOWED_SHORT_LINK_HOSTS.has(normalizedHostname) ||
        ALLOWED_MEDIA_HOSTS.some(host => (
            normalizedHostname === host || normalizedHostname.endsWith(`.${host}`)
        ))
    );
};

const requireIntegerOption = (name: string, value: number, maximum: number): number => {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
    }

    return value;
};

const normalizeHttpUrl = (value: string | null | undefined): string | undefined => {
    if (!value) return undefined;

    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:'
            ? url.toString()
            : undefined;
    } catch {
        return undefined;
    }
};

const normalizeMediaUrl = (value: string): string | undefined => {
    const normalized = normalizeHttpUrl(value);
    if (!normalized || normalized.length > MAX_TRACK_URL_CHARACTERS) return undefined;

    const url = new URL(normalized);
    if (url.username || url.password || !isAllowedMediaHost(url.hostname)) return undefined;
    return normalized;
};

const normalizeTrackTitle = (value: string): string | undefined => {
    const normalized = value
        .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
        .trim();
    if (!normalized) return undefined;

    const characters = Array.from(normalized);
    if (characters.length <= MAX_TRACK_TITLE_CHARACTERS) return normalized;
    return `${characters.slice(0, MAX_TRACK_TITLE_CHARACTERS - 1).join('')}…`;
};

const asError = (value: unknown): Error => (
    value instanceof Error ? value : new Error(String(value))
);

export class TrackResolver {
    private readonly timeoutMs: number;
    private readonly maxStdoutBytes: number;
    private readonly forceKillTimeoutMs: number;
    private readonly ytDlpCommand: string;
    private readonly ytDlpCommandArgs: readonly string[];
    private readonly logDiagnostics: boolean;

    public constructor(options: TrackResolverOptions = {}) {
        this.timeoutMs = requireIntegerOption(
            'timeoutMs',
            options.timeoutMs ?? 15_000,
            MAX_TIMER_MS
        );
        this.maxStdoutBytes = requireIntegerOption(
            'maxStdoutBytes',
            options.maxStdoutBytes ?? 1_000_000,
            MAX_CONFIGURED_STDOUT_BYTES
        );
        this.forceKillTimeoutMs = requireIntegerOption(
            'forceKillTimeoutMs',
            options.forceKillTimeoutMs ?? 2_000,
            MAX_TIMER_MS
        );
        this.ytDlpCommand = options.ytDlpCommand ?? 'yt-dlp';
        this.ytDlpCommandArgs = [...(options.ytDlpCommandArgs ?? [])];
        this.logDiagnostics = options.logDiagnostics ?? false;

        if (!this.ytDlpCommand.trim()) {
            throw new TypeError('ytDlpCommand must not be empty.');
        }

        if (!this.ytDlpCommandArgs.every(argument => typeof argument === 'string')) {
            throw new TypeError('ytDlpCommandArgs must contain only strings.');
        }
    }

    public async resolve(
        query: string,
        requestedBy: string,
        signal?: AbortSignal
    ): Promise<TrackMetadata> {
        const input = this.resolveInput(query);
        if (signal?.aborted) throw createCancellationError();

        return new Promise<TrackMetadata>((resolve, reject) => {
            // Promise settlement and child-process shutdown are separate lifecycle states.
            let settled = false;
            let processClosed = false;
            let shutdownRequested = false;
            const stdoutChunks: Buffer[] = [];
            let stdoutBytes = 0;
            let stderrData = Buffer.alloc(0);
            let deadlineTimer: NodeJS.Timeout | undefined;
            let forceKillTimer: NodeJS.Timeout | undefined;

            let ytProcess: ChildProcessWithoutNullStreams;
            try {
                ytProcess = spawn(
                    this.ytDlpCommand,
                    this.createArguments(input),
                    { windowsHide: true }
                );
            } catch (error) {
                const cause = asError(error);
                this.logProcessError(cause);
                reject(new TrackResolverError(
                    'Track metadata process failed.',
                    'PROCESS_FAILURE',
                    { cause }
                ));
                return;
            }

            const hasExited = () => (
                processClosed || ytProcess.exitCode !== null || ytProcess.signalCode !== null
            );

            const clearForceKillTimer = () => {
                if (!forceKillTimer) return;
                clearTimeout(forceKillTimer);
                forceKillTimer = undefined;
            };

            const stopProcess = () => {
                if (shutdownRequested) return;
                shutdownRequested = true;

                if (hasExited()) return;

                ytProcess.kill('SIGTERM');
                if (hasExited()) return;

                forceKillTimer = setTimeout(() => {
                    forceKillTimer = undefined;
                    if (!hasExited()) ytProcess.kill('SIGKILL');
                }, this.forceKillTimeoutMs);
                forceKillTimer.unref();
            };

            const handleAbort = () => {
                rejectAndStop(createCancellationError());
            };

            const clearSettlementHandlers = () => {
                if (deadlineTimer) {
                    clearTimeout(deadlineTimer);
                    deadlineTimer = undefined;
                }
                signal?.removeEventListener('abort', handleAbort);
            };

            const rejectOnce = (error: Error) => {
                if (settled) return;
                settled = true;
                clearSettlementHandlers();
                reject(error);
            };

            const rejectAndStop = (error: Error) => {
                if (settled) return;
                rejectOnce(error);
                stopProcess();
            };

            const resolveOnce = (metadata: TrackMetadata) => {
                if (settled) return;
                settled = true;
                clearSettlementHandlers();
                resolve(metadata);
            };

            ytProcess.stdout.on('data', (chunk: Buffer) => {
                if (settled) return;

                stdoutBytes += chunk.length;
                if (stdoutBytes > this.maxStdoutBytes) {
                    rejectAndStop(new TrackResolverError(
                        'Track metadata response exceeded the configured size limit.',
                        'OUTPUT_LIMIT'
                    ));
                    return;
                }

                stdoutChunks.push(chunk);
            });
            ytProcess.stderr.on('data', (chunk: Buffer) => {
                if (settled) return;
                stderrData = Buffer.concat([stderrData, chunk]).subarray(-MAX_STDERR_BYTES);
            });

            ytProcess.once('close', (code, closeSignal) => {
                processClosed = true;
                clearForceKillTimer();
                if (settled) return;

                if (code !== 0) {
                    const outcome = code === null
                        ? `yt-dlp was terminated by ${closeSignal ?? 'an unknown signal'}`
                        : `yt-dlp exited with code ${code}`;
                    this.logYtDlpFailure(outcome, stderrData);
                    rejectOnce(new TrackResolverError(
                        'Failed to fetch track metadata.',
                        'PROCESS_FAILURE'
                    ));
                    return;
                }

                let data: unknown;
                try {
                    data = JSON.parse(Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'));
                } catch (error) {
                    const cause = asError(error);
                    console.error('[yt-dlp Parse Error] Failed to parse metadata JSON.');
                    rejectOnce(new TrackResolverError(
                        'yt-dlp returned malformed metadata.',
                        'INVALID_RESPONSE',
                        { cause }
                    ));
                    return;
                }

                if (!isYtDlpMetadata(data)) {
                    rejectOnce(new TrackResolverError(
                        'yt-dlp returned incomplete track metadata.',
                        'INVALID_RESPONSE'
                    ));
                    return;
                }

                const title = normalizeTrackTitle(data.title);
                const mediaUrl = normalizeMediaUrl(data.webpage_url);
                if (!title || !mediaUrl) {
                    rejectOnce(new TrackResolverError(
                        'yt-dlp returned unsafe track metadata.',
                        'INVALID_RESPONSE'
                    ));
                    return;
                }

                resolveOnce({
                    kind: 'track',
                    id: randomUUID(),
                    title,
                    url: mediaUrl,
                    duration: data.duration ?? undefined,
                    thumbnail: normalizeHttpUrl(data.thumbnail),
                    requestedBy
                });
            });

            ytProcess.once('error', (error) => {
                if (settled) return;
                this.logProcessError(error);
                rejectAndStop(new TrackResolverError(
                    'Track metadata process failed.',
                    'PROCESS_FAILURE',
                    { cause: error }
                ));
            });

            deadlineTimer = setTimeout(() => {
                rejectAndStop(new TrackResolverError(
                    'Track metadata lookup timed out.',
                    'TIMEOUT'
                ));
            }, this.timeoutMs);
            deadlineTimer.unref();

            signal?.addEventListener('abort', handleAbort, { once: true });
            if (signal?.aborted) handleAbort();
        });
    }

    private resolveInput(query: string): string {
        const trimmed = query.trim();
        if (!trimmed) {
            throw new TrackResolverError(
                'A search query or URL is required.',
                'INVALID_INPUT'
            );
        }

        let url: URL;
        try {
            url = new URL(trimmed);
        } catch {
            const lowerCaseInput = trimmed.toLowerCase();
            if (lowerCaseInput.startsWith('http://') || lowerCaseInput.startsWith('https://')) {
                throw new TrackResolverError('The supplied URL is invalid.', 'INVALID_INPUT');
            }

            return `ytsearch1:${trimmed}`;
        }

        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new TrackResolverError(
                'Only HTTP and HTTPS URLs are supported.',
                'UNSUPPORTED_URL'
            );
        }

        if (!isAllowedMediaHost(url.hostname)) {
            throw new TrackResolverError(
                'Only YouTube and Instagram URLs are supported.',
                'UNSUPPORTED_URL'
            );
        }

        return url.toString();
    }

    private createArguments(input: string): string[] {
        return [
            ...this.ytDlpCommandArgs,
            '--ignore-config',
            '--dump-json',
            '--no-playlist',
            '--quiet',
            '--',
            input
        ];
    }

    private logYtDlpFailure(outcome: string, stderrData: Buffer): void {
        console.error(`[yt-dlp Error] ${outcome}`);
        if (!this.logDiagnostics) return;

        const details = this.sanitizeLogText(
            this.redactSensitiveUrls(stderrData.toString('utf8')),
            MAX_STDERR_BYTES
        );
        if (details) console.error('[yt-dlp Diagnostic]', details);
    }

    private logProcessError(error: Error): void {
        const code = (error as NodeJS.ErrnoException).code;
        const summary = this.sanitizeLogText(
            this.redactSensitiveUrls(error.message),
            500
        );
        console.error(`[yt-dlp Process Error${code ? ` ${code}` : ''}] ${summary}`);
    }

    private redactSensitiveUrls(value: string): string {
        return value.replace(/https?:\/\/[^\s"'<>]+/gi, rawUrl => {
            try {
                const url = new URL(rawUrl);
                const redactedQuery = url.search ? '?[redacted]' : '';
                return `${url.protocol}//${url.host}${url.pathname}${redactedQuery}`;
            } catch {
                return '[redacted URL]';
            }
        });
    }

    private sanitizeLogText(value: string, maxLength: number): string {
        return value
            .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
            .trim()
            .slice(0, maxLength);
    }
}

export const trackResolver = new TrackResolver();
