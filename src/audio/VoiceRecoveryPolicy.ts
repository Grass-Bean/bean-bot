const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 2_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;

export interface VoiceRecoveryPolicyOptions {
    maxAttempts?: number;
    initialBackoffMs?: number;
    attemptTimeoutMs?: number;
}

export interface VoiceRecoveryAttemptContext {
    attempt: number;
    maxAttempts: number;
    signal: AbortSignal;
}

export interface VoiceRecoveryObserver {
    onBackoff?(attempt: number, delayMs: number): void;
    onFailure?(attempt: number, error: unknown): void;
}

export class VoiceRecoveryPolicy {
    public readonly maxAttempts: number;
    private readonly initialBackoffMs: number;
    private readonly attemptTimeoutMs: number;

    public constructor(options: VoiceRecoveryPolicyOptions = {}) {
        this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
        this.attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    }

    public get estimatedDurationMinutes(): number {
        let totalMs = this.maxAttempts * this.attemptTimeoutMs;
        for (let attempt = 2; attempt <= this.maxAttempts; attempt++) {
            totalMs += this.getBackoffMs(attempt);
        }
        return Math.ceil(totalMs / 60_000);
    }

    public async recover(
        signal: AbortSignal,
        runAttempt: (context: VoiceRecoveryAttemptContext) => Promise<void>,
        observer: VoiceRecoveryObserver = {}
    ): Promise<void> {
        let lastError: unknown = new Error('Voice connection did not become ready.');

        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            if (signal.aborted) return;

            const backoffMs = this.getBackoffMs(attempt);
            if (backoffMs > 0) {
                observer.onBackoff?.(attempt, backoffMs);
                if (!await this.wait(backoffMs, signal)) return;
            }

            try {
                await this.runWithTimeout(
                    signal,
                    attemptSignal => runAttempt({
                        attempt,
                        maxAttempts: this.maxAttempts,
                        signal: attemptSignal
                    })
                );
                return;
            } catch (error) {
                if (signal.aborted) return;
                lastError = error;
                observer.onFailure?.(attempt, error);
            }
        }

        throw lastError;
    }

    private getBackoffMs(attempt: number): number {
        return attempt <= 1 ? 0 : this.initialBackoffMs * (2 ** (attempt - 2));
    }

    private async runWithTimeout(
        recoverySignal: AbortSignal,
        operation: (signal: AbortSignal) => Promise<void>
    ): Promise<void> {
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort();
        recoverySignal.addEventListener('abort', abortAttempt, { once: true });

        const timeout = setTimeout(abortAttempt, this.attemptTimeoutMs);
        timeout.unref();

        try {
            await operation(attemptController.signal);
        } finally {
            clearTimeout(timeout);
            recoverySignal.removeEventListener('abort', abortAttempt);
        }
    }

    private wait(delayMs: number, signal: AbortSignal): Promise<boolean> {
        if (signal.aborted) return Promise.resolve(false);

        return new Promise(resolve => {
            const finish = (elapsed: boolean) => {
                clearTimeout(timeout);
                signal.removeEventListener('abort', handleAbort);
                resolve(elapsed);
            };
            const handleAbort = () => finish(false);
            const timeout = setTimeout(() => finish(true), delayMs);
            timeout.unref();
            signal.addEventListener('abort', handleAbort, { once: true });
        });
    }
}
