export class Deque<T> {
    private storage: Record<number, T> = {};
    private head = 0;
    private tail = 0;

    public pushBack(item: T): void {
        this.storage[this.tail] = item;
        this.tail++;
    }

    public pushFront(item: T): void {
        this.head--;
        this.storage[this.head] = item;
    }

    public popFront(): T | undefined {
        if (this.size() === 0) return undefined;

        const item = this.storage[this.head];
        delete this.storage[this.head];
        this.head++;

        if (this.head === this.tail) {
            this.head = 0;
            this.tail = 0;
        }

        return item;
    }

    public popBack(): T | undefined {
        if (this.size() === 0) return undefined;

        this.tail--;
        const item = this.storage[this.tail];
        delete this.storage[this.tail];
        return item;
    }

    public peekFront(): T | undefined {
        return this.storage[this.head];
    }

    public size(): number {
        return this.tail - this.head;
    }

    public toArray(): T[] {
        const result: T[] = [];
        for (let index = this.head; index < this.tail; index++) {
            result.push(this.storage[index]);
        }
        return result;
    }
}
