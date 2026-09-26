import { randomInt } from 'node:crypto';
import {
    AUTOPLAY_EXPLOIT_POOL_SIZE,
    AUTOPLAY_EXPLORATION_PROBABILITY,
    AUTOPLAY_EXPLORE_END_RANK,
    AUTOPLAY_EXPLORE_START_RANK,
    AUTOPLAY_MANUAL_SEED_PROBABILITY,
    AUTOPLAY_RANK_EXPONENT
} from './autoplayConstants.js';
import { getMediaKey, getTransitionKey, type MediaKey } from './mediaIdentity.js';
import { TrackPlaybackScope } from './TrackPlaybackHistory.js';
import type { AutoplaySessionHistory, TrackMetadata } from './types.js';

const ENTROPY_RANGE = 0x1_0000_0000;

export interface EntropySource {
    next(): number;
}

export interface AutoplaySelection {
    track: TrackMetadata;
    mediaKey: MediaKey;
    youtubeRank: number;
    mode: 'exploit' | 'explore';
    playCount: number;
    transitionCount: number;
}

export const cryptoEntropySource: EntropySource = {
    next: () => randomInt(0, ENTROPY_RANGE) / ENTROPY_RANGE
};

interface RankedCandidate extends AutoplaySelection {
    weight: number;
}

export class AutoplaySelector {
    public constructor(private readonly entropy: EntropySource = cryptoEntropySource) {}

    public selectSeedPlan(
        lastTrack: TrackMetadata,
        history: AutoplaySessionHistory
    ): readonly TrackMetadata[] {
        const manualSeeds = this.getManualSeeds(history, getMediaKey(lastTrack));
        if (manualSeeds.length === 0) return [lastTrack];

        const useManualSeed = this.entropy.next() < AUTOPLAY_MANUAL_SEED_PROBABILITY;
        const manualSeed = this.pickManualSeed(manualSeeds);
        return useManualSeed
            ? [manualSeed, lastTrack]
            : [lastTrack, manualSeed];
    }

    public selectCandidate(
        seed: TrackMetadata,
        candidates: readonly TrackMetadata[],
        history: AutoplaySessionHistory
    ): AutoplaySelection | undefined {
        const seenCandidates = new Set<MediaKey>();
        const seedKey = getMediaKey(seed);
        const eligible: RankedCandidate[] = [];

        candidates.forEach((track, youtubeRank) => {
            const mediaKey = getMediaKey(track);
            if (
                seenCandidates.has(mediaKey) ||
                history.tracks.has(TrackPlaybackScope.Recent, mediaKey)
            ) return;
            seenCandidates.add(mediaKey);

            const playCount = history.tracks.count(TrackPlaybackScope.PlayCount, mediaKey);
            const transitionCount = history.transitionCounts.count(
                getTransitionKey(seedKey, mediaKey)
            );
            eligible.push({
                track,
                mediaKey,
                youtubeRank,
                mode: 'exploit',
                playCount,
                transitionCount,
                weight: 1 / Math.pow(youtubeRank + 1, AUTOPLAY_RANK_EXPONENT)
            });
        });

        if (eligible.length === 0) return undefined;

        const minimumPlayCount = Math.min(...eligible.map(candidate => candidate.playCount));
        const leastPlayed = eligible.filter(candidate => candidate.playCount === minimumPlayCount);
        const minimumTransitionCount = Math.min(
            ...leastPlayed.map(candidate => candidate.transitionCount)
        );
        const bestTier = leastPlayed.filter(
            candidate => candidate.transitionCount === minimumTransitionCount
        );

        const explore = this.entropy.next() < AUTOPLAY_EXPLORATION_PROBABILITY;
        const explorationPool = explore
            ? bestTier.filter(candidate => (
                candidate.youtubeRank >= AUTOPLAY_EXPLORE_START_RANK &&
                candidate.youtubeRank < AUTOPLAY_EXPLORE_END_RANK
            ))
            : [];
        const pool = explorationPool.length > 0
            ? explorationPool.map(candidate => ({ ...candidate, mode: 'explore' as const }))
            : bestTier.slice(0, AUTOPLAY_EXPLOIT_POOL_SIZE);

        return this.weightedPick(pool);
    }

    private getManualSeeds(
        history: AutoplaySessionHistory,
        excludedKey: MediaKey
    ): TrackMetadata[] {
        const seeds: TrackMetadata[] = [];

        for (const track of history.manualSeeds.valuesNewestFirst()) {
            if (track.autoplay) continue;
            if (getMediaKey(track) === excludedKey) continue;
            seeds.push(track);
        }

        return seeds;
    }

    private pickManualSeed(seeds: readonly TrackMetadata[]): TrackMetadata {
        const totalWeight = seeds.length * (seeds.length + 1) / 2;
        let target = this.entropy.next() * totalWeight;

        for (let index = 0; index < seeds.length; index++) {
            target -= seeds.length - index;
            if (target < 0) return seeds[index]!;
        }

        return seeds.at(-1)!;
    }

    private weightedPick(candidates: readonly RankedCandidate[]): AutoplaySelection {
        const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
        let target = this.entropy.next() * totalWeight;

        for (const candidate of candidates) {
            target -= candidate.weight;
            if (target < 0) return candidate;
        }

        return candidates.at(-1)!;
    }
}
