import { AutoplaySelector } from './AutoplaySelector.js';
import {
    AUTOPLAY_CANDIDATE_CACHE_TTL_MS,
    AUTOPLAY_CANDIDATE_LIMIT,
    AUTOPLAY_EXCLUSION_WINDOW_SIZE
} from './autoplayConstants.js';
import { getMediaKey } from './mediaIdentity.js';
import { TrackPlaybackHistory } from './TrackPlaybackHistory.js';
import { trackResolver } from './TrackResolver.js';
import { logger } from '../utility/logger.js';
import type { AutoplaySessionState, AutoplayTrackResolver, TrackMetadata } from './types.js';

const log = logger.child({ component: 'autoplay' }, { inheritContext: false });

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
            history: new TrackPlaybackHistory(AUTOPLAY_EXCLUSION_WINDOW_SIZE)
        };
    }

    public enable(guildId: string, state: AutoplaySessionState): void {
        state.enabled = true;
        this.prefetchSeed(guildId, state);
    }

    public disable(state: AutoplaySessionState): void {
        state.enabled = false;
        this.cancelSelection(state);
        this.cancelCandidateLookup(state);
    }

    public hasPlaybackHistory(state: AutoplaySessionState): boolean {
        return Boolean(state.history.lastYouTubeTrack);
    }

    public cancelSelection(state: AutoplaySessionState): void {
        state.controller?.abort();
        state.controller = undefined;
    }

    public dispose(state: AutoplaySessionState): void {
        this.disable(state);
        state.candidateCache = undefined;
    }

    public recordStartedTrack(
        guildId: string,
        state: AutoplaySessionState,
        track: TrackMetadata
    ): void {
        const previousSeed = state.history.lastYouTubeTrack;
        state.history.record(track);
        const seed = state.history.lastYouTubeTrack;
        if (seed && (!previousSeed || getMediaKey(previousSeed) !== getMediaKey(seed))) {
            this.cancelSelection(state);
            this.cancelCandidateLookup(state);
            state.candidateCache = undefined;
        }
        if (state.enabled) this.prefetchSeed(guildId, state);
    }

    public async selectNext(
        guildId: string,
        state: AutoplaySessionState,
        canUseSelection: () => boolean
    ): Promise<TrackMetadata | undefined> {
        const seed = state.history.lastYouTubeTrack;
        if (!state.enabled || !seed) return undefined;

        this.cancelSelection(state);
        const controller = new AbortController();
        state.controller = controller;

        try {
            // The shared lookup reports failures once for both prefetch and selection.
            const candidates = await this.getOrStartCandidateLookup(guildId, state, seed)
                .catch(() => []);
            if (
                controller.signal.aborted ||
                state.controller !== controller ||
                !state.enabled ||
                !canUseSelection()
            ) return undefined;

            const track = this.selector.selectCandidate(candidates, state.history);
            if (track) {
                log.debug('autoplay.selected', 'Autoplay candidate selected.', {
                    guildId, trackId: track.id, seedTrackId: seed.id
                });
            }
            return track;
        } finally {
            if (state.controller === controller) state.controller = undefined;
        }
    }

    private getOrStartCandidateLookup(
        guildId: string,
        state: AutoplaySessionState,
        seed: TrackMetadata
    ): Promise<readonly TrackMetadata[]> {
        const seedKey = getMediaKey(seed);
        const cached = state.candidateCache;
        if (cached?.seedKey === seedKey && cached.expiresAt > Date.now()) {
            log.debug('autoplay.cache_hit', 'Using cached autoplay candidates.', { guildId, seedTrackId: seed.id });
            return Promise.resolve(cached.candidates);
        }
        if (state.candidateLookup?.seedKey === seedKey) return state.candidateLookup.promise;

        this.cancelCandidateLookup(state);
        const controller = new AbortController();
        const lookup = {
            seedKey,
            controller,
            promise: Promise.resolve<readonly TrackMetadata[]>([])
        };
        lookup.promise = this.resolver.resolveAutoplayCandidates(
            seed,
            AUTOPLAY_CANDIDATE_LIMIT,
            controller.signal
        ).then(candidates => {
            if (!controller.signal.aborted && candidates.length > 0) {
                state.candidateCache = {
                    seedKey,
                    candidates,
                    expiresAt: Date.now() + AUTOPLAY_CANDIDATE_CACHE_TTL_MS
                };
            }
            return controller.signal.aborted ? [] : candidates;
        }).catch(error => {
            if (!controller.signal.aborted) {
                log.error('autoplay.lookup_failed', 'Autoplay candidate lookup failed.', {
                    guildId, seedTrackId: seed.id, title: seed.title, error
                });
            } else {
                log.debug('autoplay.lookup_cancelled', 'Autoplay candidate lookup cancelled.', {
                    guildId, seedTrackId: seed.id
                });
            }
            throw error;
        }).finally(() => {
            if (state.candidateLookup === lookup) state.candidateLookup = undefined;
        });
        state.candidateLookup = lookup;
        return lookup.promise;
    }

    private prefetchSeed(guildId: string, state: AutoplaySessionState): void {
        const seed = state.history.lastYouTubeTrack;
        if (seed) void this.getOrStartCandidateLookup(guildId, state, seed).catch(() => undefined);
    }

    private cancelCandidateLookup(state: AutoplaySessionState): void {
        state.candidateLookup?.controller.abort();
        state.candidateLookup = undefined;
    }
}
