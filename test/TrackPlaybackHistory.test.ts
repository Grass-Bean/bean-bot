import { describe, expect, it } from 'vitest';
import {
    TrackPlaybackHistory,
    TrackPlaybackScope
} from '../src/audio/TrackPlaybackHistory.js';
import type { TrackMetadata, TrackPlaybackSource } from '../src/audio/types.js';

const entry = (id: string, source: TrackPlaybackSource = 'autoplay') => ({
    mediaKey: `youtube:${id}`,
    track: {
        kind: 'track' as const,
        id,
        title: `Track ${id}`,
        url: `https://youtube.com/watch?v=${id}`,
        requestedBy: 'user-a',
        autoplay: source === 'autoplay'
    } satisfies TrackMetadata,
    source
});

describe('TrackPlaybackHistory', () => {
    it('records once while maintaining separate recent and play-count horizons', () => {
        const history = new TrackPlaybackHistory(2, 4);
        history.record(entry('a'));
        history.record(entry('a'));
        history.record(entry('b', 'manual'));

        expect(history.has(TrackPlaybackScope.Recent, 'youtube:a')).toBe(true);
        expect(history.count(TrackPlaybackScope.Recent, 'youtube:a')).toBe(1);
        expect(history.count(TrackPlaybackScope.PlayCount, 'youtube:a')).toBe(2);
        expect(history.entriesNewestFirst(TrackPlaybackScope.Recent).map(value => (
            [value.track.id, value.source]
        ))).toEqual([['b', 'manual'], ['a', 'autoplay']]);

        history.record(entry('c'));
        expect(history.has(TrackPlaybackScope.Recent, 'youtube:a')).toBe(false);
        expect(history.count(TrackPlaybackScope.PlayCount, 'youtube:a')).toBe(2);

        history.record(entry('d'));
        expect(history.count(TrackPlaybackScope.PlayCount, 'youtube:a')).toBe(1);
        history.record(entry('e'));
        expect(history.has(TrackPlaybackScope.PlayCount, 'youtube:a')).toBe(false);
    });

    it('validates the relationship between its horizons', () => {
        expect(() => new TrackPlaybackHistory(0, 4)).toThrow(RangeError);
        expect(() => new TrackPlaybackHistory(5, 4)).toThrow(RangeError);
    });
});
