import { describe, expect, it } from 'vitest';
import {
    TrackPlaybackHistory,
    TrackPlaybackScope
} from '../src/audio/TrackPlaybackHistory.js';

describe('TrackPlaybackHistory', () => {
    it('records once while maintaining separate recent and play-count horizons', () => {
        const history = new TrackPlaybackHistory<string>(2, 4);
        history.record('a');
        history.record('a');
        history.record('b');

        expect(history.has(TrackPlaybackScope.Recent, 'a')).toBe(true);
        expect(history.count(TrackPlaybackScope.Recent, 'a')).toBe(1);
        expect(history.count(TrackPlaybackScope.PlayCount, 'a')).toBe(2);

        history.record('c');
        expect(history.has(TrackPlaybackScope.Recent, 'a')).toBe(false);
        expect(history.count(TrackPlaybackScope.PlayCount, 'a')).toBe(2);

        history.record('d');
        expect(history.count(TrackPlaybackScope.PlayCount, 'a')).toBe(1);
        history.record('e');
        expect(history.has(TrackPlaybackScope.PlayCount, 'a')).toBe(false);
    });

    it('validates the relationship between its horizons', () => {
        expect(() => new TrackPlaybackHistory(0, 4)).toThrow(RangeError);
        expect(() => new TrackPlaybackHistory(5, 4)).toThrow(RangeError);
    });
});
