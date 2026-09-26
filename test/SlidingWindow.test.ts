import { describe, expect, it } from 'vitest';
import {
    CountedSlidingWindow,
    SlidingWindow,
    UniqueSlidingWindow
} from '../src/audio/SlidingWindow.js';

describe('SlidingWindow', () => {
    it('validates capacity and evicts the oldest value', () => {
        expect(() => new SlidingWindow(0)).toThrow(RangeError);
        const window = new SlidingWindow<number>(3);

        expect(window.push(1)).toBeUndefined();
        window.push(2);
        window.push(3);
        expect(window.push(4)).toBe(1);
        expect(window.values()).toEqual([2, 3, 4]);
        expect(window.valuesNewestFirst()).toEqual([4, 3, 2]);
        expect(window.valueAt(1)).toBe(3);
        expect(() => window.valueAt(3)).toThrow(RangeError);
    });

    it('keeps duplicate counts until the final occurrence expires', () => {
        const window = new CountedSlidingWindow<string>(3);
        window.push('a');
        window.push('a');
        window.push('b');
        expect(window.count('a')).toBe(2);

        window.push('c');
        expect(window.count('a')).toBe(1);
        expect(window.has('a')).toBe(true);

        window.push('d');
        expect(window.count('a')).toBe(0);
        expect(window.has('a')).toBe(false);
    });

    it('refreshes unique values and evicts the least recently inserted key', () => {
        const window = new UniqueSlidingWindow<string, number>(3);
        window.push('a', 1);
        window.push('b', 2);
        window.push('c', 3);
        window.push('a', 10);

        expect(window.values()).toEqual([2, 3, 10]);
        expect(window.valuesNewestFirst()).toEqual([10, 3, 2]);

        window.push('d', 4);
        expect(window.values()).toEqual([3, 10, 4]);
        expect(window.size()).toBe(3);
    });
});
