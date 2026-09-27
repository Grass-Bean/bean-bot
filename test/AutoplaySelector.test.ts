import { describe, expect, it } from 'vitest';
import { AutoplaySelector } from '../src/audio/AutoplaySelector.js';
import { TrackPlaybackHistory } from '../src/audio/TrackPlaybackHistory.js';
import { getMediaKey } from '../src/audio/mediaIdentity.js';
import type {
    AutoplayCandidateBatch,
    AutoplaySeed,
    AutoplaySessionHistory,
    EntropySource,
    TrackMetadata
} from '../src/audio/types.js';

const track = (id: string, autoplay = false): TrackMetadata => ({
    kind: 'track',
    id,
    title: `Track ${id}`,
    url: `https://youtube.com/watch?v=${id}`,
    requestedBy: 'user-a',
    autoplay
});

const history = (recentCapacity = 50): AutoplaySessionHistory => ({
    tracks: new TrackPlaybackHistory(recentCapacity, 200)
});

const record = (state: AutoplaySessionHistory, value: TrackMetadata): void => {
    state.tracks.record({
        mediaKey: getMediaKey(value),
        track: value,
        source: value.autoplay ? 'autoplay' : 'manual'
    });
};

const seed = (
    value: TrackMetadata,
    weight = 1
): AutoplaySeed => ({
    track: value,
    mediaKey: getMediaKey(value),
    source: value.autoplay ? 'autoplay' : 'manual',
    weight
});

const batch = (
    value: AutoplaySeed,
    candidates: readonly TrackMetadata[]
): AutoplayCandidateBatch => ({ seed: value, candidates });

class SequenceEntropy implements EntropySource {
    public calls = 0;

    public constructor(private readonly values: number[]) {}

    public next(): number {
        this.calls++;
        return this.values.shift() ?? 0;
    }
}

describe('AutoplaySelector', () => {
    it('uses the last five playbacks as recency-decayed seeds', () => {
        const state = history();
        const played = [
            track('zero'),
            track('one', true),
            track('two'),
            track('three', true),
            track('four'),
            track('five', true)
        ];
        for (const value of played) record(state, value);

        const seeds = new AutoplaySelector().selectSeeds(state);

        expect(seeds.map(value => [value.track.id, value.source])).toEqual([
            ['five', 'autoplay'],
            ['four', 'manual'],
            ['three', 'autoplay'],
            ['two', 'manual'],
            ['one', 'autoplay']
        ]);
        expect(seeds.map(value => value.weight)).toEqual([
            1,
            0.75,
            0.75 ** 2,
            0.75 ** 3,
            0.75 ** 4
        ]);
    });

    it('collates repeated playback identities into one stronger seed', () => {
        const state = history();
        const repeatedManual = track('repeated');
        const other = track('other', true);
        const repeatedAutoplay = track('repeated', true);
        record(state, repeatedManual);
        record(state, other);
        record(state, repeatedAutoplay);

        const seeds = new AutoplaySelector().selectSeeds(state);

        expect(seeds).toHaveLength(2);
        expect(seeds[0]).toEqual(expect.objectContaining({
            track: repeatedAutoplay,
            source: 'autoplay',
            weight: 1 + 0.75 ** 2
        }));
        expect(seeds[1]).toEqual(expect.objectContaining({
            track: other,
            weight: 0.75
        }));
    });

    it('promotes candidates supported by several recent seeds', () => {
        const state = history();
        const newest = seed(track('newest', true), 1);
        const previous = seed(track('previous'), 0.75);
        const single = track('single', true);
        const shared = track('shared', true);
        const selector = new AutoplaySelector(new SequenceEntropy([0]));

        const selection = selector.selectCandidate([
            batch(newest, [single, shared]),
            batch(previous, [shared])
        ], state);

        expect(selection?.track).toBe(shared);
        expect(selection?.seedSources).toEqual(['autoplay', 'manual']);
        expect(selection?.youtubeScore).toBeGreaterThan(0.16);
    });

    it('softly penalizes plays outside the hard-exclusion horizon', () => {
        const state = history();
        const repeated = track('repeated', true);
        const fresh = track('fresh', true);
        record(state, repeated);
        for (let index = 0; index < 50; index++) {
            record(state, track(`history-${index}`, true));
        }

        const selection = new AutoplaySelector(new SequenceEntropy([0])).selectCandidate([
            batch(seed(track('seed', true)), [repeated, fresh])
        ], state);

        expect(selection?.track).toBe(fresh);
        expect(selection?.playCount).toBe(0);
    });

    it('limits the entropy draw to the twenty highest-scoring candidates', () => {
        const state = history();
        const candidates = Array.from({ length: 25 }, (_, index) => track(`candidate-${index}`, true));
        const selector = new AutoplaySelector(new SequenceEntropy([0.999999]));

        const selection = selector.selectCandidate([
            batch(seed(track('seed', true)), candidates)
        ], state);

        expect(Number(selection?.track.id.split('-').at(-1))).toBeLessThan(20);
    });

    it('hard-excludes recent tracks and consumes entropy only for a real draw', () => {
        const state = history();
        const candidates = [track('one', true), track('two', true)];
        for (const candidate of candidates) record(state, candidate);
        const entropy = new SequenceEntropy([0.5]);
        const selector = new AutoplaySelector(entropy);

        expect(selector.selectCandidate([
            batch(seed(track('seed', true)), candidates)
        ], state)).toBeUndefined();
        expect(entropy.calls).toBe(0);

        const fresh = track('fresh', true);
        expect(selector.selectCandidate([
            batch(seed(track('seed', true)), [fresh])
        ], state)?.track).toBe(fresh);
        expect(entropy.calls).toBe(1);
    });
});
