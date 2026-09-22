export const MAX_QUEUE_SIZE = 50;

export class Deque<T> {
    private readonly storage: Array<T | undefined> = new Array(MAX_QUEUE_SIZE);
    private head = 0;
    private tail = 0;
    private length = 0;

    public pushBack(item: T): boolean {
        if (this.length === MAX_QUEUE_SIZE) return false;

        this.storage[this.tail] = item;
        this.tail = (this.tail + 1) % MAX_QUEUE_SIZE;
        this.length++;
        return true;
    }

    public pushFront(item: T): boolean {
        if (this.length === MAX_QUEUE_SIZE) return false;

        this.head = (this.head - 1 + MAX_QUEUE_SIZE) % MAX_QUEUE_SIZE;
        this.storage[this.head] = item;
        this.length++;
        return true;
    }

    public popFront(): T | undefined {
        if (this.length === 0) return undefined;

        const item = this.storage[this.head]!;
        this.storage[this.head] = undefined;
        this.head = (this.head + 1) % MAX_QUEUE_SIZE;
        this.length--;

        return item;
    }

    public popBack(): T | undefined {
        if (this.length === 0) return undefined;

        this.tail = (this.tail - 1 + MAX_QUEUE_SIZE) % MAX_QUEUE_SIZE;
        const item = this.storage[this.tail]!;
        this.storage[this.tail] = undefined;
        this.length--;
        return item;
    }

    public peekFront(): T | undefined {
        return this.storage[this.head];
    }

    public size(): number {
        return this.length;
    }

    public toArray(): T[] {
        const result = new Array<T>(this.length);
        for (let index = 0; index < this.length; index++) {
            result[index] = this.storage[(this.head + index) % MAX_QUEUE_SIZE]!;
        }
        return result;
    }
}
