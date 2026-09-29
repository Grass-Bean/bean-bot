import { AutoplaySelector } from './AutoplaySelector.js';
import {
    AUTOPLAY_CANDIDATE_CACHE_SIZE,
    AUTOPLAY_CANDIDATE_CACHE_TTL_MS,
    AUTOPLAY_CANDIDATE_LIMIT,
    AUTOPLAY_PLAY_COUNT_WINDOW_SIZE,
    AUTOPLAY_RECENT_TRACK_WINDOW_SIZE
} from './autoplayConstants.js';
import { getMediaKey, type MediaKey } from './mediaIdentity.js';
import { TrackPlaybackHistory, TrackPlaybackScope } from './TrackPlaybackHistory.js';
import { trackResolver } from './TrackResolver.js';
import type {
    AutoplayCandidateBatch,
    AutoplaySeed,
    AutoplaySessionState,
    AutoplayTrackResolver,
    TrackMetadata
} from './types.js';

interface AutoplaySeedResolution {
    batch?: AutoplayCandidateBatch;
    error?: unknown;
}

export interface AutoplayCoordinatorOptions {
    resolver?: AutoplayTrackResolver;
    selector?: AutoplaySelector;
}

export class AutoplayCoordinator {
    private readonly resolver: AutoplayTrackResolver;
    private readonly selector: AutoplaySelector;

    public constructor(options: AutoplayCoordinatorOptions = {}) {
        this.resolver = options.resolver ?? trackResolver;
        this.selector = options.selector ?? new AutoplaySelector();
    }

    public createState(): AutoplaySessionState {
        return {
            enabled: false,
            history: {
                tracks: new TrackPlaybackHistory(
                    AUTOPLAY_RECENT_TRACK_WINDOW_SIZE,
                    AUTOPLAY_PLAY_COUNT_WINDOW_SIZE
                )
            },
            candidateCache: new Map(),
            candidateLookups: new Map()
        };
    }

    public enable(
        guildId: string,
        state: AutoplaySessionState,
        isActive: () => boolean
    ): void {
        state.enabled = true;
        this.prefetchSeeds(guildId, state, isActive);
    }

    public disable(state: AutoplaySessionState): void {
        state.enabled = false;
        this.cancelSelection(state);
        this.cancelCandidateLookups(state);
    }

    public hasPlaybackHistory(state: AutoplaySessionState): boolean {
        return state.history.tracks.size(TrackPlaybackScope.Recent) > 0;
    }

    public cancelSelection(state: AutoplaySessionState): void {
        state.controller?.abort();
        state.controller = undefined;
    }

    public dispose(state: AutoplaySessionState): void {
        this.disable(state);
        state.candidateCache.clear();
    }

    public recordStartedTrack(
        guildId: string,
        state: AutoplaySessionState,
        track: TrackMetadata,
        isActive: () => boolean
    ): void {
        const mediaKey = getMediaKey(track);
        state.history.tracks.record({
            mediaKey,
            track: { ...track },
            source: track.autoplay ? 'autoplay' : 'manual'
        });

        this.pruneCandidateLookups(state);
        if (state.enabled) this.prefetchTrack(guildId, state, track, isActive);
    }

    public async selectNext(
        guildId: string,
        state: AutoplaySessionState,
        canUseSelection: () => boolean
    ): Promise<TrackMetadata | undefined> {
        if (!state.enabled) return undefined;

        const seeds = this.selector.selectSeeds(state.history);
        if (seeds.length === 0) return undefined;

        this.cancelSelection(state);
        const controller = new AbortController();
        state.controller = controller;

        try {
            const resolutions = await Promise.all(seeds.map(seed => (
                this.resolveSeed(state, seed, controller.signal)
            )));

            if (
                controller.signal.aborted ||
                state.controller !== controller ||
                !state.enabled ||
                !canUseSelection()
            ) return undefined;

            const batches = resolutions.flatMap(({ batch }) => batch ? [batch] : []);
            const selection = this.selector.selectCandidate(batches, state.history);
            if (selection) return selection.track;

            const resolutionError = resolutions.find(({ error }) => error)?.error;
            if (resolutionError) {
                console.error(
                    `Failed to resolve autoplay candidates in guild ${guildId}:`,
                    resolutionError
                );
            }
            return undefined;
        } finally {
            if (state.controller === controller) state.controller = undefined;
        }
    }

    private async resolveSeed(
        state: AutoplaySessionState,
        seed: AutoplaySeed,
        signal: AbortSignal
    ): Promise<AutoplaySeedResolution> {
        try {
            const candidates = await this.getOrStartCandidateLookup(state, seed.track);
            if (signal.aborted) return {};
            return { batch: { seed, candidates } };
        } catch (error) {
            return signal.aborted ? {} : { error };
        }
    }

    private getOrStartCandidateLookup(
        state: AutoplaySessionState,
        seed: TrackMetadata
    ): Promise<readonly TrackMetadata[]> {
        const seedKey = getMediaKey(seed);
        const cached = this.getCachedCandidates(state, seedKey);
        if (cached) return Promise.resolve(cached);

        const active = state.candidateLookups.get(seedKey);
        if (active) return active.promise;

        const controller = new AbortController();
        const lookup = {
            controller,
            promise: Promise.resolve<readonly TrackMetadata[]>([])
        };
        lookup.promise = this.resolver.resolveAutoplayCandidates(
            seed,
            AUTOPLAY_CANDIDATE_LIMIT,
            controller.signal
        ).then(candidates => {
            if (!controller.signal.aborted && candidates.length > 0) {
                this.cacheCandidates(state, seedKey, candidates);
            }
            return controller.signal.aborted ? [] : candidates;
        }).finally(() => {
            if (state.candidateLookups.get(seedKey) === lookup) {
                state.candidateLookups.delete(seedKey);
            }
        });
        state.candidateLookups.set(seedKey, lookup);
        void lookup.promise.catch(() => undefined);
        return lookup.promise;
    }

    private prefetchSeeds(
        guildId: string,
        state: AutoplaySessionState,
        isActive: () => boolean
    ): void {
        if (!state.enabled || !isActive()) return;

        for (const seed of this.selector.selectSeeds(state.history)) {
            this.prefetchTrack(guildId, state, seed.track, isActive);
        }
    }

    private prefetchTrack(
        guildId: string,
        state: AutoplaySessionState,
        track: TrackMetadata,
        isActive: () => boolean
    ): void {
        void this.getOrStartCandidateLookup(state, track).catch(error => {
            if (state.enabled && isActive()) {
                console.error(
                    `Failed to prefetch autoplay candidates for ${track.title} ` +
                    `in guild ${guildId}:`,
                    error
                );
            }
        });
    }

    private cancelCandidateLookups(state: AutoplaySessionState): void {
        for (const lookup of state.candidateLookups.values()) lookup.controller.abort();
        state.candidateLookups.clear();
    }

    private pruneCandidateLookups(state: AutoplaySessionState): void {
        const retainedKeys = new Set(
            this.selector.selectSeeds(state.history).map(seed => seed.mediaKey)
        );
        for (const [seedKey, lookup] of state.candidateLookups) {
            if (retainedKeys.has(seedKey)) continue;
            lookup.controller.abort();
            state.candidateLookups.delete(seedKey);
        }
    }

    private getCachedCandidates(
        state: AutoplaySessionState,
        seedKey: MediaKey
    ): readonly TrackMetadata[] | undefined {
        const cached = state.candidateCache.get(seedKey);
        if (!cached) return undefined;
        if (cached.expiresAt <= Date.now()) {
            state.candidateCache.delete(seedKey);
            return undefined;
        }

        state.candidateCache.delete(seedKey);
        state.candidateCache.set(seedKey, cached);
        return cached.candidates;
    }

    private cacheCandidates(
        state: AutoplaySessionState,
        seedKey: MediaKey,
        candidates: readonly TrackMetadata[]
    ): void {
        state.candidateCache.delete(seedKey);
        state.candidateCache.set(seedKey, {
            candidates,
            expiresAt: Date.now() + AUTOPLAY_CANDIDATE_CACHE_TTL_MS
        });

        while (state.candidateCache.size > AUTOPLAY_CANDIDATE_CACHE_SIZE) {
            const oldestKey = state.candidateCache.keys().next().value as MediaKey;
            state.candidateCache.delete(oldestKey);
        }
    }
}
