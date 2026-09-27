import { describe, expect, it } from 'vitest';
import { AutoplaySelector } from '../src/audio/AutoplaySelector.js';
import { CountedSlidingWindow, UniqueSlidingWindow } from '../src/audio/SlidingWindow.js';
import { TrackPlaybackHistory } from '../src/audio/TrackPlaybackHistory.js';
import { getMediaKey, getTransitionKey } from '../src/audio/mediaIdentity.js';
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

const history = (): AutoplaySessionHistory => ({
    tracks: new TrackPlaybackHistory(50, 200),
    transitionCounts: new CountedSlidingWindow(200),
    manualSeeds: new UniqueSlidingWindow(10),
    autoplayTracksSinceManualAnchor: 0,
    manualSeedCursor: 0
});

const seed = (
    value: TrackMetadata,
    source: AutoplaySeed['source'] = 'context',
    weight = 1
): AutoplaySeed => ({
    track: value,
    mediaKey: getMediaKey(value),
    source,
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
    it('uses deterministic manual anchors and rotates manual seeds', () => {
        const state = history();
        const older = track('older');
        const newer = track('newer');
        const last = track('last', true);
        state.manualSeeds.push(getMediaKey(older), older);
        state.manualSeeds.push(getMediaKey(newer), newer);
        const entropy = new SequenceEntropy([]);
        const selector = new AutoplaySelector(entropy);

        const normal = selector.selectSeedPlan(last, state);
        expect(normal.manualAnchorApplied).toBe(false);
        expect(normal.seeds.map(value => [value.source, value.track.id, value.weight])).toEqual([
            ['context', 'last', 1],
            ['manual', 'newer', 0.8]
        ]);

        state.autoplayTracksSinceManualAnchor = 4;
        const anchored = selector.selectSeedPlan(last, state);
        expect(anchored.manualAnchorApplied).toBe(true);
        expect(anchored.seeds.map(value => [value.source, value.track.id, value.weight])).toEqual([
            ['context', 'last', 0.8],
            ['manual', 'newer', 1.2]
        ]);

        selector.commitSeedPlan(state, anchored);
        expect(state.autoplayTracksSinceManualAnchor).toBe(0);
        expect(selector.selectSeedPlan(last, state).seeds[1]?.track).toBe(older);
        expect(entropy.calls).toBe(0);
    });

    it('fuses rankings from context and manual recommendation pools', () => {
        const state = history();
        const last = track('last', true);
        const manual = track('manual');
        const contextOnly = track('context-only', true);
        const manualOnly = track('manual-only', true);
        const shared = track('shared', true);
        const selector = new AutoplaySelector(new SequenceEntropy([0.5]));

        const selection = selector.selectCandidate(last, [
            batch(seed(last), [contextOnly, shared]),
            batch(seed(manual, 'manual', 0.8), [manualOnly, shared])
        ], state);

        expect(selection?.track).toBe(shared);
        expect(selection?.seedSources).toEqual(['context', 'manual']);
        expect(selection?.youtubeScore).toBeGreaterThan(0.1);
    });

    it('keeps YouTube relevance dominant while applying a soft play penalty', () => {
        const state = history();
        const last = track('last', true);
        const repeated = track('repeated', true);
        const fresh = track('fresh', true);
        const excluded = Array.from(
            { length: 48 },
            (_, index) => track(`excluded-${index}`, true)
        );

        state.tracks.record(getMediaKey(repeated));
        for (let index = 0; index < 50; index++) {
            state.tracks.record(getMediaKey(track(`history-${index}`, true)));
        }
        for (const candidate of excluded) state.tracks.record(getMediaKey(candidate));

        const selector = new AutoplaySelector(new SequenceEntropy([0]));
        const selection = selector.selectCandidate(
            last,
            [batch(seed(last), [repeated, ...excluded, fresh])],
            state
        );

        expect(selection?.track).toBe(repeated);
        expect(selection?.playCount).toBe(1);
    });

    it('softly penalizes repeated actual playback transitions', () => {
        const state = history();
        const last = track('last', true);
        const repeated = track('repeated', true);
        const alternate = track('alternate', true);
        state.transitionCounts.push(getTransitionKey(getMediaKey(last), getMediaKey(repeated)));

        const selector = new AutoplaySelector(new SequenceEntropy([0.5]));
        const selection = selector.selectCandidate(
            last,
            [batch(seed(last), [repeated, alternate])],
            state
        );

        expect(selection?.track).toBe(alternate);
        expect(selection?.transitionCount).toBe(0);
    });

    it('hard-excludes recent tracks and consumes entropy only for the final draw', () => {
        const state = history();
        const last = track('last', true);
        const candidates = [track('one', true), track('two', true)];
        for (const candidate of candidates) state.tracks.record(getMediaKey(candidate));
        const entropy = new SequenceEntropy([0.5]);
        const selector = new AutoplaySelector(entropy);

        selector.selectSeedPlan(last, state);
        expect(selector.selectCandidate(
            last,
            [batch(seed(last), candidates)],
            state
        )).toBeUndefined();
        expect(entropy.calls).toBe(0);

        const fresh = track('fresh', true);
        expect(selector.selectCandidate(
            last,
            [batch(seed(last), [fresh])],
            state
        )?.track).toBe(fresh);
        expect(entropy.calls).toBe(1);
    });
});
