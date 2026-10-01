import { randomUUID } from 'crypto';
import type {
    TrackMetadata,
    TrackResolverErrorCode,
    TrackResolverOptions,
    YtDlpMetadata,
    YtDlpProcessClient
} from './types.js';
import {
    YtDlpProcessError,
    ytDlpProcessManager
} from './YtDlpProcessManager.js';
import { getMediaKey, getYouTubeVideoId } from './mediaIdentity.js';

export type { TrackResolverErrorCode, TrackResolverOptions } from './types.js';

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

const createCancellationError = (cause?: unknown): TrackResolverError => {
    const error = new TrackResolverError(
        'Track metadata lookup was cancelled.',
        'CANCELLED',
        cause === undefined ? undefined : { cause }
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

const getYouTubeThumbnail = (mediaUrl: string): string | undefined => {
    const videoId = getYouTubeVideoId(mediaUrl);
    return videoId
        ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
        : undefined;
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
    private readonly processes: YtDlpProcessClient;

    public constructor(
        options: TrackResolverOptions = {},
        processes: YtDlpProcessClient = ytDlpProcessManager
    ) {
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
        this.processes = processes;
    }

    public async resolve(
        query: string,
        requestedBy: string,
        signal?: AbortSignal
    ): Promise<TrackMetadata> {
        const input = this.resolveInput(query);
        if (signal?.aborted) throw createCancellationError();

        let stdout: Buffer;
        try {
            ({ stdout } = await this.processes.collect(this.createArguments(input), {
                signal,
                timeoutMs: this.timeoutMs,
                maxStdoutBytes: this.maxStdoutBytes
            }));
        } catch (error) {
            throw this.mapProcessError(error);
        }

        let data: unknown;
        try {
            data = JSON.parse(stdout.toString('utf8'));
        } catch (error) {
            const cause = asError(error);
            throw new TrackResolverError(
                'yt-dlp returned malformed metadata.',
                'INVALID_RESPONSE',
                { cause }
            );
        }

        if (!isYtDlpMetadata(data)) {
            throw new TrackResolverError(
                'yt-dlp returned incomplete track metadata.',
                'INVALID_RESPONSE'
            );
        }

        const title = normalizeTrackTitle(data.title);
        const mediaUrl = normalizeMediaUrl(data.webpage_url);
        if (!title || !mediaUrl) {
            throw new TrackResolverError(
                'yt-dlp returned unsafe track metadata.',
                'INVALID_RESPONSE'
            );
        }

        return {
            kind: 'track',
            id: randomUUID(),
            title,
            url: mediaUrl,
            duration: data.duration ?? undefined,
            thumbnail: normalizeHttpUrl(data.thumbnail),
            requestedBy
        };
    }

    public async resolveAutoplay(
        seed: TrackMetadata,
        signal?: AbortSignal
    ): Promise<TrackMetadata> {
        const candidates = await this.resolveAutoplayCandidates(seed, 10, signal);
        const candidate = candidates[0];
        if (candidate) return candidate;

        throw new TrackResolverError(
            'No related track was available for autoplay.',
            'INVALID_RESPONSE'
        );
    }

    public async resolveAutoplayCandidates(
        seed: TrackMetadata,
        limit: number,
        signal?: AbortSignal
    ): Promise<readonly TrackMetadata[]> {
        requireIntegerOption('limit', limit, 100);
        if (signal?.aborted) throw createCancellationError();

        let stdout: Buffer;
        try {
            ({ stdout } = await this.processes.collect(
                this.createAutoplayArguments(this.createAutoplayInput(seed), limit),
                {
                    signal,
                    timeoutMs: this.timeoutMs,
                    maxStdoutBytes: this.maxStdoutBytes
                }
            ));
        } catch (error) {
            throw this.mapProcessError(error);
        }

        const candidates = stdout.toString('utf8')
            .split(/\r?\n/)
            .filter(line => line.trim().length > 0)
            .map(line => {
                try {
                    return JSON.parse(line) as unknown;
                } catch {
                    return undefined;
                }
            })
            .filter(isYtDlpMetadata);

        const seedKey = getMediaKey(seed);
        const seen = new Set<string>([seedKey]);
        const tracks: TrackMetadata[] = [];
        for (const candidate of candidates) {
            const title = normalizeTrackTitle(candidate.title);
            const mediaUrl = normalizeMediaUrl(candidate.webpage_url);
            if (!title || !mediaUrl) continue;

            const track: TrackMetadata = {
                kind: 'track',
                id: randomUUID(),
                title,
                url: mediaUrl,
                duration: candidate.duration ?? undefined,
                thumbnail: normalizeHttpUrl(candidate.thumbnail) ?? getYouTubeThumbnail(mediaUrl),
                requestedBy: seed.requestedBy,
                autoplay: true
            };
            const mediaKey = getMediaKey(track);
            if (seen.has(mediaKey)) continue;
            seen.add(mediaKey);
            tracks.push(track);
        }

        return tracks;
    }

    private mapProcessError(error: unknown): TrackResolverError {
        if (!(error instanceof YtDlpProcessError)) {
            const cause = asError(error);
            return new TrackResolverError(
                'Track metadata process failed.',
                'PROCESS_FAILURE',
                { cause }
            );
        }

        if (error.code === 'CANCELLED') return createCancellationError(error);
        if (error.code === 'TIMEOUT') {
            return new TrackResolverError('Track metadata lookup timed out.', 'TIMEOUT', { cause: error });
        }
        if (error.code === 'OUTPUT_LIMIT') {
            return new TrackResolverError(
                'Track metadata response exceeded the configured size limit.',
                'OUTPUT_LIMIT',
                { cause: error }
            );
        }

        if (error.code === 'PROCESS_FAILURE') {
            return new TrackResolverError(
                'Failed to fetch track metadata.',
                'PROCESS_FAILURE',
                { cause: error }
            );
        }

        return new TrackResolverError(
            'Track metadata process failed.',
            'PROCESS_FAILURE',
            { cause: error }
        );
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
            '--ignore-config',
            '--no-playlist',
            '--quiet',
            '--print',
            '%(.{title,webpage_url,duration,thumbnail})j',
            '--',
            input
        ];
    }

    private createAutoplayArguments(input: string, limit: number): string[] {
        return [
            '--ignore-config',
            '--flat-playlist',
            '--playlist-end', String(limit),
            '--quiet',
            '--print',
            '%(.{title,webpage_url,duration,thumbnail})j',
            '--',
            input
        ];
    }

    private createAutoplayInput(seed: TrackMetadata): string {
        const videoId = getYouTubeVideoId(seed.url);
        if (videoId) {
            const encodedId = encodeURIComponent(videoId);
            return `https://www.youtube.com/watch?v=${encodedId}&list=RD${encodedId}`;
        }

        return `ytsearch10:${seed.title} official audio`;
    }

}

export const trackResolver = new TrackResolver();
