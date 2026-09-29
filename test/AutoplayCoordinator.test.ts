import { describe, expect, it, vi } from 'vitest';
import { AutoplayCoordinator } from '../src/audio/AutoplayCoordinator.js';
import { AutoplaySelector } from '../src/audio/AutoplaySelector.js';
import type { AutoplayTrackResolver, TrackMetadata } from '../src/audio/types.js';

const track = (id: string, autoplay = false): TrackMetadata => ({
    kind: 'track',
    id,
    title: `Track ${id}`,
    url: `https://youtube.com/watch?v=${id}`,
    requestedBy: 'user-a',
    autoplay
});

describe('AutoplayCoordinator', () => {
    it('records playback history and reuses prefetched candidates', async () => {
        const seed = track('seed');
        const candidate = track('candidate', true);
        const resolver = {
            resolveAutoplayCandidates: vi.fn().mockResolvedValue([candidate])
        } as AutoplayTrackResolver;
        const coordinator = new AutoplayCoordinator({
            resolver,
            selector: new AutoplaySelector({ next: () => 0 })
        });
        const state = coordinator.createState();

        coordinator.recordStartedTrack('guild-a', state, seed, () => true);
        coordinator.enable('guild-a', state, () => true);
        const selected = await coordinator.selectNext('guild-a', state, () => true);

        expect(selected).toBe(candidate);
        expect(resolver.resolveAutoplayCandidates).toHaveBeenCalledTimes(1);
        expect(resolver.resolveAutoplayCandidates).toHaveBeenCalledWith(
            seed,
            expect.any(Number),
            expect.any(AbortSignal)
        );
    });

    it('aborts active candidate lookups when autoplay is disabled', () => {
        let lookupSignal: AbortSignal | undefined;
        const resolver = {
            resolveAutoplayCandidates: vi.fn((
                _seed: TrackMetadata,
                _limit: number,
                signal?: AbortSignal
            ) => {
                lookupSignal = signal;
                return new Promise<readonly TrackMetadata[]>(() => undefined);
            })
        } as AutoplayTrackResolver;
        const coordinator = new AutoplayCoordinator({ resolver });
        const state = coordinator.createState();

        coordinator.recordStartedTrack('guild-a', state, track('seed'), () => true);
        coordinator.enable('guild-a', state, () => true);
        coordinator.disable(state);

        expect(lookupSignal?.aborted).toBe(true);
        expect(state.candidateLookups.size).toBe(0);
        expect(state.enabled).toBe(false);
    });

    it('discards a resolved candidate when the session can no longer use it', async () => {
        const candidate = track('candidate', true);
        let finishLookup!: (tracks: readonly TrackMetadata[]) => void;
        const resolver = {
            resolveAutoplayCandidates: vi.fn(() => new Promise<readonly TrackMetadata[]>(resolve => {
                finishLookup = resolve;
            }))
        } as AutoplayTrackResolver;
        const coordinator = new AutoplayCoordinator({
            resolver,
            selector: new AutoplaySelector({ next: () => 0 })
        });
        const state = coordinator.createState();
        coordinator.recordStartedTrack('guild-a', state, track('seed'), () => true);
        coordinator.enable('guild-a', state, () => true);

        const selection = coordinator.selectNext('guild-a', state, () => false);
        finishLookup([candidate]);

        await expect(selection).resolves.toBeUndefined();
        expect(state.controller).toBeUndefined();
    });
});
