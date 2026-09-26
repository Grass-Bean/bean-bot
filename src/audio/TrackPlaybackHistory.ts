import { SlidingWindow } from './SlidingWindow.js';

export enum TrackPlaybackScope {
    Recent = 'recent',
    PlayCount = 'play-count'
}

export class TrackPlaybackHistory<K> {
    private readonly events: SlidingWindow<K>;
    private readonly recentCounts = new Map<K, number>();
    private readonly playCounts = new Map<K, number>();

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

        this.events = new SlidingWindow<K>(playCountCapacity);
    }

    public record(key: K): void {
        const eventCount = this.events.size();

        if (eventCount >= this.recentCapacity) {
            this.decrement(
                this.recentCounts,
                this.events.valueAt(eventCount - this.recentCapacity)
            );
        }
        if (eventCount >= this.playCountCapacity) {
            this.decrement(
                this.playCounts,
                this.events.valueAt(eventCount - this.playCountCapacity)
            );
        }

        this.events.push(key);
        this.increment(this.recentCounts, key);
        this.increment(this.playCounts, key);
    }

    public has(scope: TrackPlaybackScope, key: K): boolean {
        return this.countsFor(scope).has(key);
    }

    public count(scope: TrackPlaybackScope, key: K): number {
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

    private countsFor(scope: TrackPlaybackScope): ReadonlyMap<K, number> {
        switch (scope) {
            case TrackPlaybackScope.Recent:
                return this.recentCounts;
            case TrackPlaybackScope.PlayCount:
                return this.playCounts;
        }
    }

    private increment(counts: Map<K, number>, key: K): void {
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    private decrement(counts: Map<K, number>, key: K): void {
        const remaining = (counts.get(key) ?? 0) - 1;
        if (remaining <= 0) counts.delete(key);
        else counts.set(key, remaining);
    }
}
