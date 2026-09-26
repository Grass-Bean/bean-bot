import { describe, expect, it } from 'vitest';
import { AutoplaySelector, type EntropySource } from '../src/audio/AutoplaySelector.js';
import { CountedSlidingWindow, UniqueSlidingWindow } from '../src/audio/SlidingWindow.js';
import { TrackPlaybackHistory } from '../src/audio/TrackPlaybackHistory.js';
import { getMediaKey, getTransitionKey } from '../src/audio/mediaIdentity.js';
import type { AutoplaySessionHistory, TrackMetadata } from '../src/audio/types.js';

const track = (id: string, autoplay = false): TrackMetadata => ({
    kind: 'track',
    id,
    title: `Track ${id}`,
    url: `https://youtube.com/watch?v=${id}`,
    requestedBy: 'user-a',
    autoplay
});

const history = (): AutoplaySessionHistory => ({
    tracks: new TrackPlaybackHistory(50, 200),
    transitionCounts: new CountedSlidingWindow(200),
    manualSeeds: new UniqueSlidingWindow(10)
});

class SequenceEntropy implements EntropySource {
    public constructor(private readonly values: number[]) {}
    public next(): number {
        return this.values.shift() ?? 0;
    }
}

describe('AutoplaySelector', () => {
    it('varies the primary seed while weighting recent manual seeds', () => {
        const state = history();
        const older = track('older');
        const newer = track('newer');
        const last = track('last', true);
        state.manualSeeds.push(getMediaKey(older), older);
        state.manualSeeds.push(getMediaKey(newer), newer);

        const manualFirst = new AutoplaySelector(new SequenceEntropy([0.19, 0]));
        expect(manualFirst.selectSeedPlan(last, state)).toEqual([newer, last]);

        const lastFirst = new AutoplaySelector(new SequenceEntropy([0.21, 0]));
        expect(lastFirst.selectSeedPlan(last, state)).toEqual([last, newer]);
    });

    it('hard-excludes recent tracks and penalizes plays beyond the recent window', () => {
        const state = history();
        const seed = track('seed');
        const recent = track('recent', true);
        const repeated = track('repeated', true);
        const fresh = track('fresh', true);
        state.tracks.record(getMediaKey(repeated));
        for (let index = 0; index < 49; index++) {
            const filler = getMediaKey(track(`filler-${index}`, true));
            state.tracks.record(filler);
        }
        state.tracks.record(getMediaKey(recent));

        const selector = new AutoplaySelector(new SequenceEntropy([0.99, 0]));
        expect(selector.selectCandidate(seed, [recent, repeated, fresh], state)?.track).toBe(fresh);
    });

    it('penalizes repeated transitions after their tracks leave the recent window', () => {
        const state = history();
        const seed = track('seed');
        const repeated = track('repeated', true);
        const alternate = track('alternate', true);
        const repeatedKey = getMediaKey(repeated);
        const alternateKey = getMediaKey(alternate);
        state.tracks.record(repeatedKey);
        state.tracks.record(alternateKey);
        state.transitionCounts.push(getTransitionKey(getMediaKey(seed), repeatedKey));
        for (let index = 0; index < 50; index++) {
            state.tracks.record(getMediaKey(track(`transition-filler-${index}`, true)));
        }

        const selector = new AutoplaySelector(new SequenceEntropy([0.99, 0]));
        expect(selector.selectCandidate(seed, [repeated, alternate], state)?.track).toBe(alternate);
    });

    it('can explore beyond the first ten YouTube candidates', () => {
        const state = history();
        const seed = track('seed');
        const candidates = Array.from({ length: 15 }, (_, index) => track(`candidate-${index}`, true));
        const selector = new AutoplaySelector(new SequenceEntropy([0.10, 0]));

        const selection = selector.selectCandidate(seed, candidates, state);
        expect(selection?.mode).toBe('explore');
        expect(selection?.youtubeRank).toBe(10);
    });

    it('returns nothing when every candidate is in the hard exclusion window', () => {
        const state = history();
        const seed = track('seed');
        const candidates = [track('one', true), track('two', true)];
        for (const candidate of candidates) state.tracks.record(getMediaKey(candidate));

        expect(new AutoplaySelector(new SequenceEntropy([]))
            .selectCandidate(seed, candidates, state)).toBeUndefined();
    });
});
