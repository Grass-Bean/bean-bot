import { randomInt } from 'node:crypto';
import {
    AUTOPLAY_ANCHORED_CONTEXT_SEED_WEIGHT,
    AUTOPLAY_ANCHORED_MANUAL_SEED_WEIGHT,
    AUTOPLAY_CONTEXT_SEED_WEIGHT,
    AUTOPLAY_EXPLORATION_FLOOR,
    AUTOPLAY_MANUAL_ANCHOR_INTERVAL,
    AUTOPLAY_MANUAL_SEED_WEIGHT,
    AUTOPLAY_PLAY_PENALTY_BASE,
    AUTOPLAY_PLAY_PENALTY_CAP,
    AUTOPLAY_RECIPROCAL_RANK_OFFSET,
    AUTOPLAY_TRANSITION_PENALTY_BASE,
    AUTOPLAY_TRANSITION_PENALTY_CAP
} from './autoplayConstants.js';
import { getMediaKey, getTransitionKey, type MediaKey } from './mediaIdentity.js';
import { TrackPlaybackScope } from './TrackPlaybackHistory.js';
import type {
    AutoplayCandidateBatch,
    AutoplaySeed,
    AutoplaySeedPlan,
    AutoplaySeedSource,
    AutoplaySelection,
    AutoplaySessionHistory,
    EntropySource,
    TrackMetadata
} from './types.js';

const ENTROPY_RANGE = 0x1_0000_0000;

export const cryptoEntropySource: EntropySource = {
    next: () => randomInt(0, ENTROPY_RANGE) / ENTROPY_RANGE
};

interface RankedCandidate extends AutoplaySelection {
    selectionWeight: number;
}

interface CandidateAccumulator {
    track: TrackMetadata;
    mediaKey: MediaKey;
    youtubeRank: number;
    seedSources: Set<AutoplaySeedSource>;
    youtubeScore: number;
}

export class AutoplaySelector {
    public constructor(private readonly entropy: EntropySource = cryptoEntropySource) {}

    public selectSeedPlan(
        lastTrack: TrackMetadata,
        history: AutoplaySessionHistory
    ): AutoplaySeedPlan {
        const lastTrackKey = getMediaKey(lastTrack);
        const manualSeeds = this.getManualSeeds(history, lastTrackKey);
        const manualAnchorApplied = manualSeeds.length > 0 &&
            history.autoplayTracksSinceManualAnchor >= AUTOPLAY_MANUAL_ANCHOR_INTERVAL - 1;
        const seeds: AutoplaySeed[] = [{
            track: lastTrack,
            mediaKey: lastTrackKey,
            source: 'context',
            weight: manualAnchorApplied
                ? AUTOPLAY_ANCHORED_CONTEXT_SEED_WEIGHT
                : AUTOPLAY_CONTEXT_SEED_WEIGHT
        }];

        if (manualSeeds.length > 0) {
            const manualSeed = manualSeeds[history.manualSeedCursor % manualSeeds.length]!;
            seeds.push({
                track: manualSeed,
                mediaKey: getMediaKey(manualSeed),
                source: 'manual',
                weight: manualAnchorApplied
                    ? AUTOPLAY_ANCHORED_MANUAL_SEED_WEIGHT
                    : AUTOPLAY_MANUAL_SEED_WEIGHT
            });
        }

        return {
            seeds,
            manualAnchorApplied,
            manualSeedCount: manualSeeds.length
        };
    }

    public commitSeedPlan(
        history: AutoplaySessionHistory,
        plan: AutoplaySeedPlan
    ): void {
        if (plan.manualAnchorApplied) {
            history.autoplayTracksSinceManualAnchor = 0;
            history.manualSeedCursor = plan.manualSeedCount === 0
                ? 0
                : (history.manualSeedCursor + 1) % plan.manualSeedCount;
            return;
        }

        history.autoplayTracksSinceManualAnchor = Math.min(
            history.autoplayTracksSinceManualAnchor + 1,
            AUTOPLAY_MANUAL_ANCHOR_INTERVAL - 1
        );
    }

    public resetSeedSchedule(history: AutoplaySessionHistory): void {
        history.autoplayTracksSinceManualAnchor = 0;
        history.manualSeedCursor = 0;
    }

    public selectCandidate(
        lastTrack: TrackMetadata,
        batches: readonly AutoplayCandidateBatch[],
        history: AutoplaySessionHistory
    ): AutoplaySelection | undefined {
        const excludedSeedKeys = new Set(batches.map(batch => batch.seed.mediaKey));
        const accumulated = new Map<MediaKey, CandidateAccumulator>();

        for (const { seed, candidates } of batches) {
            const seenInBatch = new Set<MediaKey>();

            candidates.forEach((track, youtubeRank) => {
                const mediaKey = getMediaKey(track);
                if (
                    seenInBatch.has(mediaKey) ||
                    excludedSeedKeys.has(mediaKey) ||
                    history.tracks.has(TrackPlaybackScope.Recent, mediaKey)
                ) return;
                seenInBatch.add(mediaKey);

                const rankScore = seed.weight /
                    (AUTOPLAY_RECIPROCAL_RANK_OFFSET + youtubeRank);
                const existing = accumulated.get(mediaKey);
                if (existing) {
                    existing.youtubeRank = Math.min(existing.youtubeRank, youtubeRank);
                    existing.youtubeScore += rankScore;
                    existing.seedSources.add(seed.source);
                    return;
                }

                accumulated.set(mediaKey, {
                    track,
                    mediaKey,
                    youtubeRank,
                    seedSources: new Set([seed.source]),
                    youtubeScore: rankScore
                });
            });
        }

        const lastTrackKey = getMediaKey(lastTrack);
        const scored = [...accumulated.values()].map((candidate): RankedCandidate => {
            const playCount = history.tracks.count(
                TrackPlaybackScope.PlayCount,
                candidate.mediaKey
            );
            const transitionCount = history.transitionCounts.count(
                getTransitionKey(lastTrackKey, candidate.mediaKey)
            );
            const playPenalty = Math.pow(
                AUTOPLAY_PLAY_PENALTY_BASE,
                Math.min(playCount, AUTOPLAY_PLAY_PENALTY_CAP)
            );
            const transitionPenalty = Math.pow(
                AUTOPLAY_TRANSITION_PENALTY_BASE,
                Math.min(transitionCount, AUTOPLAY_TRANSITION_PENALTY_CAP)
            );
            const finalScore = candidate.youtubeScore * playPenalty * transitionPenalty;

            return {
                track: candidate.track,
                mediaKey: candidate.mediaKey,
                youtubeRank: candidate.youtubeRank,
                seedSources: [...candidate.seedSources],
                playCount,
                transitionCount,
                youtubeScore: candidate.youtubeScore,
                finalScore,
                selectionWeight: 0
            };
        });

        if (scored.length === 0) return undefined;

        const totalScore = scored.reduce((sum, candidate) => sum + candidate.finalScore, 0);
        const explorationShare = AUTOPLAY_EXPLORATION_FLOOR / scored.length;
        for (const candidate of scored) {
            candidate.selectionWeight =
                (1 - AUTOPLAY_EXPLORATION_FLOOR) * (candidate.finalScore / totalScore) +
                explorationShare;
        }

        return this.weightedPick(scored);
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

    private weightedPick(candidates: readonly RankedCandidate[]): AutoplaySelection {
        const totalWeight = candidates.reduce(
            (sum, candidate) => sum + candidate.selectionWeight,
            0
        );
        let target = this.entropy.next() * totalWeight;

        for (const candidate of candidates) {
            target -= candidate.selectionWeight;
            if (target < 0) return candidate;
        }

        return candidates.at(-1)!;
    }
}
