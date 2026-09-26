import type { TrackMetadata } from './types.js';

export type MediaKey = string;
export type TransitionKey = string;

export const getYouTubeVideoId = (value: string): string | undefined => {
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        if (hostname === 'youtu.be') {
            return url.pathname.split('/').filter(Boolean)[0];
        }
        if (
            hostname === 'youtube.com' || hostname.endsWith('.youtube.com') ||
            hostname === 'youtube-nocookie.com' || hostname.endsWith('.youtube-nocookie.com')
        ) {
            if (url.searchParams.get('v')) return url.searchParams.get('v')!;
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts[0] === 'shorts' || parts[0] === 'embed') return parts[1];
        }
    } catch {
        return undefined;
    }

    return undefined;
};

export const getMediaKey = (track: TrackMetadata): MediaKey => {
    const youtubeId = getYouTubeVideoId(track.url);
    if (youtubeId) return `youtube:${youtubeId}`;

    try {
        const url = new URL(track.url);
        url.hash = '';
        const hostname = url.hostname.toLowerCase();
        if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) {
            return `instagram:${url.pathname.replace(/\/+$/, '')}`;
        }
        url.searchParams.sort();
        return `url:${url.toString()}`;
    } catch {
        return `url:${track.url}`;
    }
};

export const getTransitionKey = (from: MediaKey, to: MediaKey): TransitionKey => (
    `${from.length}:${from}${to}`
);
