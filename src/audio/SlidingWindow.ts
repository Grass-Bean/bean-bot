export class SlidingWindow<T> {
    private readonly storage: Array<T | undefined>;
    private head = 0;
    private length = 0;

    public constructor(public readonly capacity: number) {
        if (!Number.isSafeInteger(capacity) || capacity <= 0) {
            throw new RangeError('Sliding window capacity must be a positive integer.');
        }
        this.storage = new Array<T | undefined>(capacity);
    }

    public push(value: T): T | undefined {
        if (this.length < this.capacity) {
            const index = (this.head + this.length) % this.capacity;
            this.storage[index] = value;
            this.length++;
            return undefined;
        }

        const evicted = this.storage[this.head];
        this.storage[this.head] = value;
        this.head = (this.head + 1) % this.capacity;
        return evicted;
    }

    public size(): number {
        return this.length;
    }

    public values(): readonly T[] {
        return Array.from({ length: this.length }, (_, index) => (
            this.storage[(this.head + index) % this.capacity]!
        ));
    }

    public valuesNewestFirst(): readonly T[] {
        return [...this.values()].reverse();
    }

    public valueAt(index: number): T {
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
            throw new RangeError('Sliding window index is out of range.');
        }

        return this.storage[(this.head + index) % this.capacity]!;
    }
}

export class CountedSlidingWindow<K> {
    private readonly window: SlidingWindow<K>;
    private readonly counts = new Map<K, number>();

    public constructor(capacity: number) {
        this.window = new SlidingWindow<K>(capacity);
    }

    public push(key: K): void {
        const wasFull = this.window.size() === this.window.capacity;
        const evicted = this.window.push(key);

        if (wasFull) {
            const remaining = (this.counts.get(evicted as K) ?? 0) - 1;
            if (remaining <= 0) this.counts.delete(evicted as K);
            else this.counts.set(evicted as K, remaining);
        }

        this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }

    public has(key: K): boolean {
        return this.counts.has(key);
    }

    public count(key: K): number {
        return this.counts.get(key) ?? 0;
    }

    public size(): number {
        return this.window.size();
    }

    public values(): readonly K[] {
        return this.window.values();
    }
}

export class UniqueSlidingWindow<K, V> {
    private readonly entries = new Map<K, V>();

    public constructor(public readonly capacity: number) {
        if (!Number.isSafeInteger(capacity) || capacity <= 0) {
            throw new RangeError('Unique sliding window capacity must be a positive integer.');
        }
    }

    public push(key: K, value: V): void {
        // Map preserves insertion order; reinsertion refreshes an existing key's recency.
        this.entries.delete(key);
        this.entries.set(key, value);

        if (this.entries.size > this.capacity) {
            const oldestKey = this.entries.keys().next().value as K;
            this.entries.delete(oldestKey);
        }
    }

    public size(): number {
        return this.entries.size;
    }

    public values(): readonly V[] {
        return [...this.entries.values()];
    }

    public valuesNewestFirst(): readonly V[] {
        return [...this.entries.values()].reverse();
    }
}
