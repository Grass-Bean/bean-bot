export class Deque<T> {
  private storage: Record<number, T> = {};
  private head: number = 0;
  private tail: number = 0;

  // Add to the END (Standard Queue)
  pushBack(item: T): void {
    this.storage[this.tail] = item;
    this.tail++;
  }

  // Add to the FRONT (Skip the line)
  pushFront(item: T): void {
    this.head--;
    this.storage[this.head] = item;
  }

  // Remove from the FRONT
  popFront(): T | undefined {
    if (this.size() === 0) return undefined;

    const item = this.storage[this.head];
    delete this.storage[this.head];
    this.head++;

    // Reset if empty
    if (this.head === this.tail) {
      this.head = 0;
      this.tail = 0;
    }

    return item;
  }

  // Remove from the BACK (Optional, but standard for Deques)
  popBack(): T | undefined {
    if (this.size() === 0) return undefined;

    this.tail--;
    const item = this.storage[this.tail];
    delete this.storage[this.tail];
    return item;
  }

  peekFront(): T | undefined {
    return this.storage[this.head];
  }

  size(): number {
    return this.tail - this.head;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = this.head; i < this.tail; i++) {
      result.push(this.storage[i]);
    }
    return result;
    
  }
}