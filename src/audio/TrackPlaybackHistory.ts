import { SlidingWindow } from './SlidingWindow.js';
import type { MediaKey } from './mediaIdentity.js';
import type { TrackPlaybackEntry } from './types.js';

export enum TrackPlaybackScope {
    Recent = 'recent',
    PlayCount = 'play-count'
}

export class TrackPlaybackHistory {
    private readonly events: SlidingWindow<TrackPlaybackEntry>;
    private readonly recentCounts = new Map<MediaKey, number>();
    private readonly playCounts = new Map<MediaKey, number>();

    public constructor(
        public readonly recentCapacity: number,
        public readonly playCountCapacity: number
    ) {
        if (!Number.isSafeInteger(recentCapacity) || recentCapacity <= 0) {
            throw new RangeError('Recent playback capacity must be a positive integer.');
        }
        if (!Number.isSafeInteger(playCountCapacity) || playCountCapacity <= 0) {
            throw new RangeError('Play-count capacity must be a positive integer.');
        }
        if (recentCapacity > playCountCapacity) {
            throw new RangeError('Recent playback capacity cannot exceed play-count capacity.');
        }

        this.events = new SlidingWindow<TrackPlaybackEntry>(playCountCapacity);
    }

    public record(entry: TrackPlaybackEntry): void {
        const eventCount = this.events.size();

        if (eventCount >= this.recentCapacity) {
            this.decrement(
                this.recentCounts,
                this.events.valueAt(eventCount - this.recentCapacity).mediaKey
            );
        }
        if (eventCount >= this.playCountCapacity) {
            this.decrement(
                this.playCounts,
                this.events.valueAt(eventCount - this.playCountCapacity).mediaKey
            );
        }

        this.events.push(entry);
        this.increment(this.recentCounts, entry.mediaKey);
        this.increment(this.playCounts, entry.mediaKey);
    }

    public has(scope: TrackPlaybackScope, key: MediaKey): boolean {
        return this.countsFor(scope).has(key);
    }

    public count(scope: TrackPlaybackScope, key: MediaKey): number {
        return this.countsFor(scope).get(key) ?? 0;
    }

    public size(scope: TrackPlaybackScope): number {
        return Math.min(
            this.events.size(),
            scope === TrackPlaybackScope.Recent
                ? this.recentCapacity
                : this.playCountCapacity
        );
    }

    public entriesNewestFirst(scope: TrackPlaybackScope): readonly TrackPlaybackEntry[] {
        return this.events.valuesNewestFirst().slice(0, this.size(scope));
    }

    private countsFor(scope: TrackPlaybackScope): ReadonlyMap<MediaKey, number> {
        switch (scope) {
            case TrackPlaybackScope.Recent:
                return this.recentCounts;
            case TrackPlaybackScope.PlayCount:
                return this.playCounts;
        }
    }

    private increment(counts: Map<MediaKey, number>, key: MediaKey): void {
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    private decrement(counts: Map<MediaKey, number>, key: MediaKey): void {
        const remaining = (counts.get(key) ?? 0) - 1;
        if (remaining <= 0) counts.delete(key);
        else counts.set(key, remaining);
    }
}
