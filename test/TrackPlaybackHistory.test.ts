import { describe, expect, it } from 'vitest';
import { TrackPlaybackHistory } from '../src/audio/TrackPlaybackHistory.js';
import type { TrackMetadata } from '../src/audio/types.js';

const track = (id: string, url = `https://youtube.com/watch?v=${id}`): TrackMetadata => ({
    kind: 'track', id, title: id, url, requestedBy: 'user-a'
});

describe('TrackPlaybackHistory', () => {
    it('excludes exactly the last 50 playback events', () => {
        const history = new TrackPlaybackHistory(50);
        history.record(track('oldest'));
        for (let index = 0; index < 49; index++) history.record(track(`track-${index}`));
        expect(history.has('youtube:oldest')).toBe(true);
        history.record(track('next'));
        expect(history.has('youtube:oldest')).toBe(false);
        expect(history.has('youtube:track-0')).toBe(true);
    });

    it('keeps repeated tracks excluded until their final occurrence leaves the window', () => {
        const history = new TrackPlaybackHistory(3);
        history.record(track('repeat'));
        history.record(track('repeat', 'https://youtu.be/repeat'));
        history.record(track('one'));
        history.record(track('two'));
        expect(history.has('youtube:repeat')).toBe(true);
        history.record(track('three'));
        expect(history.has('youtube:repeat')).toBe(false);
    });

    it('retains the last YouTube seed across other media, even beyond the exclusion window', () => {
        const history = new TrackPlaybackHistory(2);
        const youtube = track('youtube');
        history.record(youtube);
        for (let index = 0; index < 3; index++) {
            history.record(track(`clip-${index}`, `https://instagram.com/reel/clip-${index}`));
        }
        expect(history.lastYouTubeTrack).toEqual(youtube);
        expect(history.has('youtube:youtube')).toBe(false);
        const autoplay = { ...track('autoplay'), autoplay: true };
        history.record(autoplay);
        expect(history.lastYouTubeTrack).toEqual(autoplay);
    });

    it('has no seed before any YouTube playback and snapshots recorded metadata', () => {
        const history = new TrackPlaybackHistory(50);
        history.record(track('clip', 'https://instagram.com/reel/clip'));
        expect(history.lastYouTubeTrack).toBeUndefined();
        const youtube = track('youtube');
        history.record(youtube);
        youtube.url = 'https://instagram.com/reel/clip';
        expect(history.lastYouTubeTrack?.url).toBe('https://youtube.com/watch?v=youtube');
    });

    it('requires a positive integer window capacity', () => {
        for (const capacity of [0, -1, 1.5, Infinity]) {
            expect(() => new TrackPlaybackHistory(capacity)).toThrow(RangeError);
        }
    });
});
