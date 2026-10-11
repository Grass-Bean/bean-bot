import { describe, expect, it, vi } from 'vitest';
import { AutoplayCoordinator } from '../src/audio/AutoplayCoordinator.js';
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
    it('does not look up autoplay until a YouTube track has played', async () => {
        const resolver = { resolveAutoplayCandidates: vi.fn().mockResolvedValue([]) };
        const coordinator = new AutoplayCoordinator({ resolver });
        const state = coordinator.createState();
        coordinator.recordStartedTrack('guild-a', state, {
            ...track('clip'), url: 'https://instagram.com/reel/clip'
        });
        coordinator.enable('guild-a', state);
        expect(coordinator.hasPlaybackHistory(state)).toBe(false);
        await expect(coordinator.selectNext('guild-a', state, () => true)).resolves.toBeUndefined();
        expect(resolver.resolveAutoplayCandidates).not.toHaveBeenCalled();
    });

    it('cancels an obsolete seed lookup and prevents late results from replacing the new cache', async () => {
        let finishOldLookup!: (tracks: readonly TrackMetadata[]) => void;
        const fresh = track('fresh', true);
        const resolver = {
            resolveAutoplayCandidates: vi.fn()
                .mockImplementationOnce(() => new Promise(resolve => { finishOldLookup = resolve; }))
                .mockResolvedValue([fresh])
        };
        const coordinator = new AutoplayCoordinator({ resolver });
        const state = coordinator.createState();
        coordinator.recordStartedTrack('guild-a', state, track('old-seed'));
        coordinator.enable('guild-a', state);
        const oldSelection = coordinator.selectNext('guild-a', state, () => true);
        const oldSignal = state.candidateLookup!.controller.signal;

        coordinator.recordStartedTrack('guild-a', state, track('new-seed'));
        expect(oldSignal.aborted).toBe(true);
        await expect(coordinator.selectNext('guild-a', state, () => true)).resolves.toBe(fresh);
        finishOldLookup([track('stale', true)]);
        await expect(oldSelection).resolves.toBeUndefined();
        await expect(coordinator.selectNext('guild-a', state, () => true)).resolves.toBe(fresh);
        expect(resolver.resolveAutoplayCandidates).toHaveBeenCalledTimes(2);
    });

    it('keeps prefetched recommendations across non-YouTube playback and filters updated history', async () => {
        const seed = track('seed');
        const played = track('played', true);
        const fresh = track('fresh', true);
        const resolver = { resolveAutoplayCandidates: vi.fn().mockResolvedValue([played, fresh]) };
        const coordinator = new AutoplayCoordinator({ resolver });
        const state = coordinator.createState();
        coordinator.recordStartedTrack('guild-a', state, played);
        coordinator.recordStartedTrack('guild-a', state, seed);
        coordinator.enable('guild-a', state);
        coordinator.recordStartedTrack('guild-a', state, {
            ...track('clip'), url: 'https://instagram.com/reel/clip'
        });
        await expect(coordinator.selectNext('guild-a', state, () => true)).resolves.toBe(fresh);
        expect(resolver.resolveAutoplayCandidates).toHaveBeenCalledTimes(1);
        expect(resolver.resolveAutoplayCandidates.mock.calls[0]![0]).toEqual(seed);
    });

    it('refreshes recommendations after the cache expires', async () => {
        vi.useFakeTimers();
        try {
            const first = track('first', true);
            const refreshed = track('refreshed', true);
            const resolver = {
                resolveAutoplayCandidates: vi.fn()
                    .mockResolvedValueOnce([first]).mockResolvedValue([refreshed])
            };
            const coordinator = new AutoplayCoordinator({ resolver });
            const state = coordinator.createState();
            coordinator.recordStartedTrack('guild-a', state, track('seed'));
            coordinator.enable('guild-a', state);
            await expect(coordinator.selectNext('guild-a', state, () => true)).resolves.toBe(first);
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
            await expect(coordinator.selectNext('guild-a', state, () => true)).resolves.toBe(refreshed);
            expect(resolver.resolveAutoplayCandidates).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('records playback history and reuses prefetched candidates', async () => {
        const seed = track('seed');
        const candidate = track('candidate', true);
        const resolver = {
            resolveAutoplayCandidates: vi.fn().mockResolvedValue([candidate])
        } as AutoplayTrackResolver;
        const coordinator = new AutoplayCoordinator({
            resolver
        });
        const state = coordinator.createState();

        coordinator.recordStartedTrack('guild-a', state, seed);
        coordinator.enable('guild-a', state);
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

        coordinator.recordStartedTrack('guild-a', state, track('seed'));
        coordinator.enable('guild-a', state);
        coordinator.disable(state);

        expect(lookupSignal?.aborted).toBe(true);
        expect(state.candidateLookup).toBeUndefined();
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
            resolver
        });
        const state = coordinator.createState();
        coordinator.recordStartedTrack('guild-a', state, track('seed'));
        coordinator.enable('guild-a', state);

        const selection = coordinator.selectNext('guild-a', state, () => false);
        finishLookup([candidate]);

        await expect(selection).resolves.toBeUndefined();
        expect(state.controller).toBeUndefined();
    });

    it('reports a shared prefetch/selection failure once, but reports a later lookup again', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const resolver = { resolveAutoplayCandidates: vi.fn().mockRejectedValue(new Error('lookup failed')) };
        const coordinator = new AutoplayCoordinator({ resolver });
        const state = coordinator.createState();
        coordinator.recordStartedTrack('guild-a', state, track('seed'));
        coordinator.enable('guild-a', state);
        await coordinator.selectNext('guild-a', state, () => true);
        expect(errors).toHaveBeenCalledOnce();
        await coordinator.selectNext('guild-a', state, () => true);
        expect(errors).toHaveBeenCalledTimes(2);
        expect(errors.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
            expect.objectContaining({ event: 'autoplay.lookup_failed', guildId: 'guild-a', seedTrackId: 'seed' }),
            expect.objectContaining({ event: 'autoplay.lookup_failed', guildId: 'guild-a', seedTrackId: 'seed' })
        ]);
    });
});
