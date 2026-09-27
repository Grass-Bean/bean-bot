import { randomInt } from 'node:crypto';
import {
    AUTOPLAY_PLAY_PENALTY_BASE,
    AUTOPLAY_PLAY_PENALTY_CAP,
    AUTOPLAY_RECIPROCAL_RANK_OFFSET,
    AUTOPLAY_SEED_RECENCY_DECAY,
    AUTOPLAY_SEED_WINDOW_SIZE,
    AUTOPLAY_SELECTION_POOL_SIZE,
    AUTOPLAY_SELECTION_RANK_DECAY,
    AUTOPLAY_SELECTION_SHARPNESS
} from './autoplayConstants.js';
import { getMediaKey, type MediaKey } from './mediaIdentity.js';
import { TrackPlaybackScope } from './TrackPlaybackHistory.js';
import type {
    AutoplayCandidateBatch,
    AutoplaySeed,
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

    public selectSeeds(history: AutoplaySessionHistory): readonly AutoplaySeed[] {
        const seeds = new Map<MediaKey, AutoplaySeed>();
        const entries = history.tracks
            .entriesNewestFirst(TrackPlaybackScope.Recent)
            .slice(0, AUTOPLAY_SEED_WINDOW_SIZE);

        entries.forEach((entry, age) => {
            const weight = Math.pow(AUTOPLAY_SEED_RECENCY_DECAY, age);
            const existing = seeds.get(entry.mediaKey);
            if (existing) {
                existing.weight += weight;
                return;
            }

            seeds.set(entry.mediaKey, {
                track: entry.track,
                mediaKey: entry.mediaKey,
                source: entry.source,
                weight
            });
        });

        return [...seeds.values()];
    }

    public selectCandidate(
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

        const ranked = [...accumulated.values()].map((candidate): AutoplaySelection => {
            const playCount = history.tracks.count(
                TrackPlaybackScope.PlayCount,
                candidate.mediaKey
            );
            const playPenalty = Math.pow(
                AUTOPLAY_PLAY_PENALTY_BASE,
                Math.min(playCount, AUTOPLAY_PLAY_PENALTY_CAP)
            );
            const finalScore = candidate.youtubeScore * playPenalty;

            return {
                track: candidate.track,
                mediaKey: candidate.mediaKey,
                youtubeRank: candidate.youtubeRank,
                seedSources: [...candidate.seedSources],
                playCount,
                youtubeScore: candidate.youtubeScore,
                finalScore
            };
        }).sort((left, right) => right.finalScore - left.finalScore)
            .slice(0, AUTOPLAY_SELECTION_POOL_SIZE);

        if (ranked.length === 0) return undefined;
        const maximumFinalScore = ranked[0].finalScore;
        const weighted = ranked.map((candidate, rank): RankedCandidate => ({
            ...candidate,
            selectionWeight: Math.pow(
                candidate.finalScore / maximumFinalScore,
                AUTOPLAY_SELECTION_SHARPNESS
            ) * Math.exp(-AUTOPLAY_SELECTION_RANK_DECAY * rank)
        }));
        const selected = this.weightedPick(weighted);
        const { selectionWeight: _, ...selection } = selected;
        return selection;
    }

    private weightedPick(candidates: readonly RankedCandidate[]): RankedCandidate {
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
