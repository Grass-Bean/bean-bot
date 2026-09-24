import {
    spawn,
    type ChildProcessWithoutNullStreams
} from 'child_process';
import type {
    YtDlpCollectedOutput,
    YtDlpCollectOptions,
    YtDlpProcessClient,
    YtDlpProcessErrorCode,
    YtDlpProcessExit,
    YtDlpProcessFailure,
    YtDlpProcessManagerOptions,
    YtDlpProcessOutcome,
    YtDlpStreamHandle
} from './types.js';

const MAX_TIMER_MS = 2_147_483_647;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export class YtDlpProcessError extends Error implements YtDlpProcessFailure {
    public constructor(
        message: string,
        public readonly code: YtDlpProcessErrorCode,
        public readonly stderr: Buffer = Buffer.alloc(0),
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'YtDlpProcessError';
    }
}

const requireIntegerOption = (name: string, value: number, maximum: number): number => {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
    }

    return value;
};

const asError = (value: unknown): Error => (
    value instanceof Error ? value : new Error(String(value))
);

const appendTail = (current: Buffer, chunk: Buffer, maximumBytes: number): Buffer => {
    if (chunk.length >= maximumBytes) return Buffer.from(chunk.subarray(-maximumBytes));
    if (current.length + chunk.length <= maximumBytes) return Buffer.concat([current, chunk]);

    const retainedBytes = maximumBytes - chunk.length;
    return Buffer.concat([current.subarray(current.length - retainedBytes), chunk]);
};

export class YtDlpProcessManager implements YtDlpProcessClient {
    private readonly command: string;
    private readonly commandArgs: readonly string[];
    private readonly forceKillTimeoutMs: number;
    private readonly maxStderrBytes: number;

    public constructor(options: YtDlpProcessManagerOptions = {}) {
        this.command = options.command ?? 'yt-dlp';
        this.commandArgs = [...(options.commandArgs ?? [])];
        this.forceKillTimeoutMs = requireIntegerOption(
            'forceKillTimeoutMs',
            options.forceKillTimeoutMs ?? 2_000,
            MAX_TIMER_MS
        );
        this.maxStderrBytes = requireIntegerOption(
            'maxStderrBytes',
            options.maxStderrBytes ?? 8_000,
            MAX_CAPTURE_BYTES
        );

        if (!this.command.trim()) throw new TypeError('command must not be empty.');
        if (!this.commandArgs.every(argument => typeof argument === 'string')) {
            throw new TypeError('commandArgs must contain only strings.');
        }
    }

    public async collect(
        args: readonly string[],
        options: YtDlpCollectOptions
    ): Promise<YtDlpCollectedOutput> {
        const timeoutMs = requireIntegerOption('timeoutMs', options.timeoutMs, MAX_TIMER_MS);
        const maxStdoutBytes = requireIntegerOption(
            'maxStdoutBytes',
            options.maxStdoutBytes,
            MAX_CAPTURE_BYTES
        );

        if (options.signal?.aborted) {
            throw new YtDlpProcessError('yt-dlp operation was cancelled.', 'CANCELLED');
        }

        const handle = this.stream(args);

        return new Promise<YtDlpCollectedOutput>((resolve, reject) => {
            const stdoutChunks: Buffer[] = [];
            let stdoutBytes = 0;
            let settled = false;
            let timeout: NodeJS.Timeout | undefined;

            const clearSettlementHandlers = () => {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = undefined;
                }
                options.signal?.removeEventListener('abort', handleAbort);
                handle.stdout.off('data', handleData);
            };

            const rejectAndStop = (error: YtDlpProcessError) => {
                if (settled) return;
                settled = true;
                clearSettlementHandlers();
                reject(error);
                void handle.stop();
            };

            const handleAbort = () => {
                rejectAndStop(new YtDlpProcessError(
                    'yt-dlp operation was cancelled.',
                    'CANCELLED'
                ));
            };

            const handleData = (value: Buffer | string) => {
                if (settled) return;

                const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
                stdoutBytes += chunk.length;
                if (stdoutBytes > maxStdoutBytes) {
                    rejectAndStop(new YtDlpProcessError(
                        'yt-dlp output exceeded the configured size limit.',
                        'OUTPUT_LIMIT'
                    ));
                    return;
                }

                stdoutChunks.push(chunk);
            };

            handle.stdout.on('data', handleData);
            void handle.completion.then(outcome => {
                if (settled) return;
                settled = true;
                clearSettlementHandlers();

                if (outcome.status === 'failed') {
                    reject(outcome.error);
                    return;
                }
                if (outcome.status === 'stopped') {
                    reject(new YtDlpProcessError(
                        'yt-dlp stopped before completing.',
                        'PROCESS_FAILURE',
                        outcome.stderr
                    ));
                    return;
                }

                resolve({
                    stdout: Buffer.concat(stdoutChunks, stdoutBytes),
                    stderr: outcome.stderr
                });
            });

            timeout = setTimeout(() => {
                rejectAndStop(new YtDlpProcessError(
                    'yt-dlp operation timed out.',
                    'TIMEOUT'
                ));
            }, timeoutMs);
            timeout.unref();

            options.signal?.addEventListener('abort', handleAbort, { once: true });
            if (options.signal?.aborted) handleAbort();
        });
    }

    public stream(args: readonly string[]): YtDlpStreamHandle {
        if (!args.every(argument => typeof argument === 'string')) {
            throw new TypeError('args must contain only strings.');
        }

        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(
                this.command,
                [...this.commandArgs, ...args],
                { windowsHide: true }
            );
        } catch (error) {
            const cause = asError(error);
            throw new YtDlpProcessError(
                `Failed to start yt-dlp: ${cause.message}`,
                'SPAWN_FAILURE',
                Buffer.alloc(0),
                { cause }
            );
        }

        let stderr: Buffer = Buffer.alloc(0);
        let stopRequested = false;
        let processClosed = false;
        let outcomeSettled = false;
        let settledOutcome: YtDlpProcessOutcome | undefined;
        let forceKillTimer: NodeJS.Timeout | undefined;
        const failureListeners = new Set<(error: YtDlpProcessError) => void>();
        let resolveCompletion!: (outcome: YtDlpProcessOutcome) => void;
        let resolveClosed!: () => void;

        const completion = new Promise<YtDlpProcessOutcome>(resolve => {
            resolveCompletion = resolve;
        });
        const closed = new Promise<void>(resolve => {
            resolveClosed = resolve;
        });

        const hasExited = () => (
            processClosed || child.exitCode !== null || child.signalCode !== null
        );

        const clearForceKillTimer = () => {
            if (!forceKillTimer) return;
            clearTimeout(forceKillTimer);
            forceKillTimer = undefined;
        };

        const settle = (outcome: YtDlpProcessOutcome) => {
            if (outcomeSettled) return;
            outcomeSettled = true;
            settledOutcome = outcome;
            resolveCompletion(outcome);
            if (outcome.status === 'failed') {
                const listeners = [...failureListeners];
                failureListeners.clear();
                for (const listener of listeners) listener(outcome.error);
            } else {
                failureListeners.clear();
            }
        };

        const createFailure = (
            message: string,
            code: YtDlpProcessErrorCode,
            cause?: Error
        ): YtDlpProcessError => new YtDlpProcessError(
            message,
            code,
            Buffer.from(stderr),
            cause ? { cause } : undefined
        );

        const detachAndDrainOutput = () => {
            child.stdout.unpipe();
            if (!child.stdout.destroyed && !child.stdout.readableEnded) child.stdout.resume();
        };

        const stop = (): Promise<void> => {
            if (stopRequested) return closed;
            stopRequested = true;
            detachAndDrainOutput();

            if (hasExited()) return closed;

            try {
                child.kill('SIGTERM');
            } catch {
                return closed;
            }
            if (hasExited()) return closed;

            forceKillTimer = setTimeout(() => {
                forceKillTimer = undefined;
                if (hasExited()) return;
                try {
                    child.kill('SIGKILL');
                } catch {
                    // The close/error events remain authoritative if termination races.
                }
            }, this.forceKillTimeoutMs);
            forceKillTimer.unref();
            return closed;
        };

        const failAndStop = (error: YtDlpProcessError) => {
            settle({
                status: 'failed',
                exitCode: child.exitCode,
                signal: child.signalCode,
                stderr: error.stderr,
                error
            });
            void stop();
        };

        child.stderr.on('data', (value: Buffer | string) => {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            stderr = appendTail(stderr, chunk, this.maxStderrBytes);
        });
        child.stdout.once('error', error => {
            failAndStop(createFailure(
                `yt-dlp stdout failed: ${error.message}`,
                'STDOUT_FAILURE',
                error
            ));
        });
        child.stderr.once('error', error => {
            failAndStop(createFailure(
                `yt-dlp stderr failed: ${error.message}`,
                'STDERR_FAILURE',
                error
            ));
        });
        child.once('error', error => {
            failAndStop(createFailure(
                `Failed to start yt-dlp: ${error.message}`,
                'SPAWN_FAILURE',
                error
            ));
        });
        child.once('exit', (exitCode, signal) => {
            if (stopRequested || exitCode === 0 || outcomeSettled) return;

            const outcome = exitCode === null
                ? `yt-dlp was terminated by ${signal ?? 'an unknown signal'}`
                : `yt-dlp exited with code ${exitCode}`;
            const error = createFailure(outcome, 'PROCESS_FAILURE');
            settle({
                status: 'failed',
                exitCode,
                signal,
                stderr: error.stderr,
                error
            });
        });
        child.once('close', (exitCode, signal) => {
            processClosed = true;
            clearForceKillTimer();
            resolveClosed();

            if (outcomeSettled) return;
            const exit: YtDlpProcessExit = {
                exitCode,
                signal,
                stderr: Buffer.from(stderr)
            };

            if (stopRequested) {
                settle({ status: 'stopped', ...exit });
                return;
            }
            if (exitCode === 0) {
                settle({ status: 'succeeded', ...exit });
                return;
            }

            const outcome = exitCode === null
                ? `yt-dlp closed after signal ${signal ?? 'unknown'}`
                : `yt-dlp closed with code ${exitCode}`;
            const error = createFailure(outcome, 'PROCESS_FAILURE');
            settle({ status: 'failed', ...exit, error });
        });

        const onFailure = (listener: (error: YtDlpProcessError) => void): (() => void) => {
            if (settledOutcome) {
                if (settledOutcome.status === 'failed') listener(settledOutcome.error);
                return () => undefined;
            }

            failureListeners.add(listener);
            return () => failureListeners.delete(listener);
        };

        return { stdout: child.stdout, completion, onFailure, stop };
    }
}

export const ytDlpProcessManager = new YtDlpProcessManager();
