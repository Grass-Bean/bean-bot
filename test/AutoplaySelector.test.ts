import { describe, expect, it } from 'vitest';
import { AutoplaySelector } from '../src/audio/AutoplaySelector.js';
import { TrackPlaybackHistory } from '../src/audio/TrackPlaybackHistory.js';
import type { TrackMetadata } from '../src/audio/types.js';

const track = (id: string, url = `https://youtube.com/watch?v=${id}`): TrackMetadata => ({
    kind: 'track', id, title: id, url, requestedBy: 'user-a', autoplay: true
});

const selector = new AutoplaySelector();

describe('AutoplaySelector', () => {
    it('takes the first unplayed YouTube recommendation in provider order', () => {
        const history = new TrackPlaybackHistory(50);
        const seed = track('seed');
        history.record(seed);
        history.record({ ...track('played'), autoplay: false });
        const first = track('first');
        expect(selector.selectCandidate([
            seed,
            track('same-video', 'https://youtu.be/played'),
            track('clip', 'https://instagram.com/reel/clip'),
            first,
            track('second')
        ], history)).toBe(first);
    });

    it('hard-excludes all of the last 50 plays and permits a track once it ages out', () => {
        const history = new TrackPlaybackHistory(50);
        const oldest = track('oldest');
        const fresh = track('fresh');
        history.record(oldest);
        for (let index = 0; index < 49; index++) history.record(track(`history-${index}`));
        expect(selector.selectCandidate([oldest, fresh], history)).toBe(fresh);
        history.record(track('newest'));
        expect(selector.selectCandidate([oldest, fresh], history)).toBe(oldest);
    });

    it('never chooses the seed itself, even after it leaves the exclusion window', () => {
        const history = new TrackPlaybackHistory(1);
        const seed = track('seed');
        history.record(seed);
        history.record(track('clip', 'https://instagram.com/reel/clip'));
        expect(selector.selectCandidate([seed], history)).toBeUndefined();
    });

    it('returns no selection when recommendations are empty or all excluded', () => {
        const history = new TrackPlaybackHistory(50);
        const seed = track('seed');
        history.record(seed);
        expect(selector.selectCandidate([], history)).toBeUndefined();
        expect(selector.selectCandidate([seed], history)).toBeUndefined();
    });
});
