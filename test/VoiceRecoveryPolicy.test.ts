import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecoveryPolicy } from '../src/audio/VoiceRecoveryPolicy.js';

describe('VoiceRecoveryPolicy', () => {
    afterEach(() => vi.useRealTimers());

    it('retries with exponential backoff and reports a conservative estimate', async () => {
        vi.useFakeTimers();
        const policy = new VoiceRecoveryPolicy();
        const attempt = vi.fn()
            .mockRejectedValueOnce(new Error('first'))
            .mockRejectedValueOnce(new Error('second'))
            .mockResolvedValueOnce(undefined);
        const onBackoff = vi.fn();
        const recovery = policy.recover(
            new AbortController().signal,
            attempt,
            { onBackoff }
        );

        await vi.advanceTimersByTimeAsync(6_000);
        await recovery;

        expect(policy.maxAttempts).toBe(5);
        expect(policy.estimatedDurationMinutes).toBe(2);
        expect(attempt).toHaveBeenCalledTimes(3);
        expect(onBackoff).toHaveBeenNthCalledWith(1, 2, 2_000);
        expect(onBackoff).toHaveBeenNthCalledWith(2, 3, 4_000);
    });

    it('stops after the configured maximum attempts', async () => {
        vi.useFakeTimers();
        const policy = new VoiceRecoveryPolicy({
            maxAttempts: 3,
            initialBackoffMs: 10,
            attemptTimeoutMs: 20
        });
        const failure = new Error('unavailable');
        const attempt = vi.fn().mockRejectedValue(failure);
        const recovery = policy.recover(new AbortController().signal, attempt);
        const rejection = expect(recovery).rejects.toBe(failure);

        await vi.advanceTimersByTimeAsync(30);

        await rejection;
        expect(attempt).toHaveBeenCalledTimes(3);
        expect(policy.estimatedDurationMinutes).toBe(1);
    });

    it('reports a readiness timeout explicitly instead of a generic abort', async () => {
        vi.useFakeTimers();
        const policy = new VoiceRecoveryPolicy({ maxAttempts: 1, attemptTimeoutMs: 20 });
        const onFailure = vi.fn();
        const recovery = policy.recover(new AbortController().signal, ({ signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
        }), { onFailure });
        const rejection = expect(recovery).rejects.toMatchObject({
            name: 'TimeoutError', message: 'Voice recovery attempt timed out after 20 ms.'
        });
        await vi.advanceTimersByTimeAsync(20);
        await rejection;
        expect(onFailure).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'TimeoutError' }));
    });

    it('cancels cleanly during backoff', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const attempt = vi.fn().mockRejectedValue(new Error('unavailable'));
        const recovery = new VoiceRecoveryPolicy().recover(controller.signal, attempt);
        await Promise.resolve();

        controller.abort();
        await recovery;

        expect(attempt).toHaveBeenCalledOnce();
    });
});
