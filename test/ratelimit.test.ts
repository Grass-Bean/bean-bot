import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimit } from '../src/utility/ratelimit.js';

describe('RateLimit', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not limit commands that have no configured cooldown', () => {
        const limits = new RateLimit();

        expect(limits.isRateLimited('user-a', 'unknown-command')).toBe(false);
        expect(limits.getTimeLeft('user-a', 'unknown-command')).toBeUndefined();
    });

    it('starts a cooldown, reports the remaining time, and limits repeat use', () => {
        const limits = new RateLimit();
        limits.setLimit('play', 5_000);

        expect(limits.isRateLimited('user-a', 'play')).toBe(false);
        expect(limits.getTimeLeft('user-a', 'play')).toBe(5_000);

        vi.advanceTimersByTime(1_250);
        expect(limits.isRateLimited('user-a', 'play')).toBe(true);
        expect(limits.getTimeLeft('user-a', 'play')).toBe(3_750);
    });

    it('isolates cooldowns by user and command and removes expired entries', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const limits = new RateLimit();
        limits.setLimit('queue', 100);
        limits.setLimit('disconnect', 200);

        expect(limits.isRateLimited('user-a', 'queue')).toBe(false);
        expect(limits.isRateLimited('user-b', 'queue')).toBe(false);
        expect(limits.isRateLimited('user-a', 'disconnect')).toBe(false);

        vi.advanceTimersByTime(100);
        expect(limits.getTimeLeft('user-a', 'queue')).toBeUndefined();
        expect(limits.isRateLimited('user-a', 'queue')).toBe(false);
        expect(limits.getTimeLeft('user-a', 'disconnect')).toBe(100);
        expect(log).toHaveBeenCalledWith('-> Cleared rate limit for user-a:queue');
    });

    it('shares configured limits and active cooldowns across instances', () => {
        const first = new RateLimit();
        const second = new RateLimit();
        first.setLimit('shared-command', 1_000);

        expect(first.isRateLimited('shared-user', 'shared-command')).toBe(false);
        expect(second.isRateLimited('shared-user', 'shared-command')).toBe(true);
        expect(second.getTimeLeft('shared-user', 'shared-command')).toBe(1_000);
    });
});
