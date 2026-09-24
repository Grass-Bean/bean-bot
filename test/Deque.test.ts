import { describe, expect, it } from 'vitest';
import { Deque, MAX_QUEUE_SIZE } from '../src/audio/Deque.js';

describe('Deque', () => {
    it('pushes and removes values from both ends in order', () => {
        const deque = new Deque<number>();

        expect(deque.popFront()).toBeUndefined();
        expect(deque.popBack()).toBeUndefined();
        expect(deque.peekFront()).toBeUndefined();

        expect(deque.pushBack(2)).toBe(true);
        expect(deque.pushFront(1)).toBe(true);
        expect(deque.pushBack(3)).toBe(true);

        expect(deque.size()).toBe(3);
        expect(deque.peekFront()).toBe(1);
        expect(deque.toArray()).toEqual([1, 2, 3]);
        expect(deque.popBack()).toBe(3);
        expect(deque.popFront()).toBe(1);
        expect(deque.popFront()).toBe(2);
        expect(deque.size()).toBe(0);
    });

    it('wraps its circular storage without changing logical order', () => {
        const deque = new Deque<number>();

        for (let value = 0; value < MAX_QUEUE_SIZE; value++) {
            expect(deque.pushBack(value)).toBe(true);
        }
        for (let value = 0; value < 20; value++) {
            expect(deque.popFront()).toBe(value);
        }
        for (let value = MAX_QUEUE_SIZE; value < MAX_QUEUE_SIZE + 20; value++) {
            expect(deque.pushBack(value)).toBe(true);
        }

        expect(deque.toArray()).toEqual(
            Array.from({ length: MAX_QUEUE_SIZE }, (_, index) => index + 20)
        );
    });

    it('rejects inserts when it reaches its fixed capacity', () => {
        const deque = new Deque<number>();
        for (let value = 0; value < MAX_QUEUE_SIZE; value++) deque.pushBack(value);

        expect(deque.pushBack(100)).toBe(false);
        expect(deque.pushFront(-1)).toBe(false);
        expect(deque.size()).toBe(MAX_QUEUE_SIZE);
    });
});
