import { createAudioResource, StreamType } from '@discordjs/voice';
import { spawn } from 'child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioMetadata, BeanAudioResource, ElevatorMetadata, TrackMetadata } from './types.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultElevatorMusicPath = path.resolve(moduleDirectory, '../../assets/elevator.mp3');

export class AudioResourceManager {
    private readonly releasers = new WeakMap<BeanAudioResource, () => void>();
    private readonly releasedResources = new WeakSet<BeanAudioResource>();

    public constructor(
        private readonly forceKillTimeoutMs = 2_000,
        private readonly ytDlpCommand = 'yt-dlp',
        private readonly elevatorMusicPath = defaultElevatorMusicPath
    ) {}

    public createTrackResource(metadata: TrackMetadata): BeanAudioResource {
        const ytProcess = spawn(this.ytDlpCommand, [
            '--ignore-config',
            '--no-playlist',
            '-q',
            '-f', 'bestaudio/best',
            '-o', '-',
            '--add-headers', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            '--extractor-args', 'youtube:player_client=default',
            '--',
            metadata.url
        ], { windowsHide: true });

        let resource: BeanAudioResource | undefined;
        let stderrData = '';
        let shutdownRequested = false;
        let processClosed = false;
        let failureReported = false;
        let forceKillTimer: NodeJS.Timeout | undefined;

        const hasExited = () => (
            processClosed || ytProcess.exitCode !== null || ytProcess.signalCode !== null
        );

        const clearForceKillTimer = () => {
            if (!forceKillTimer) return;
            clearTimeout(forceKillTimer);
            forceKillTimer = undefined;
        };

        const detachAndDrainOutput = () => {
            ytProcess.stdout.unpipe();
            if (!ytProcess.stdout.destroyed && !ytProcess.stdout.readableEnded) {
                ytProcess.stdout.resume();
            }
        };

        const stopProcess = () => {
            if (shutdownRequested) return;
            shutdownRequested = true;
            detachAndDrainOutput();

            if (hasExited()) return;

            ytProcess.kill('SIGTERM');
            if (hasExited()) return;

            forceKillTimer = setTimeout(() => {
                forceKillTimer = undefined;
                if (!hasExited()) ytProcess.kill('SIGKILL');
            }, this.forceKillTimeoutMs);
            forceKillTimer.unref();
        };

        const describeFailure = (summary: string) => {
            const safeSummary = this.sanitizeForLog(summary, 500);
            const details = this.sanitizeForLog(stderrData, 8_000);
            return new Error(details ? `${safeSummary}: ${details}` : safeSummary);
        };

        const failResource = (error: Error) => {
            if (shutdownRequested || failureReported) return;
            failureReported = true;
            console.error(`[yt-dlp] ${this.sanitizeForLog(metadata.title, 200)}:`, error.message);

            // Child-process cleanup should not depend on Discord's stream events firing.
            stopProcess();

            if (resource && !resource.playStream.destroyed) {
                resource.playStream.destroy(error);
            }
        };

        ytProcess.stderr.on('data', (data) => {
            stderrData = `${stderrData}${data.toString()}`.slice(-8_000);
        });

        // These listeners are registered before resource construction so a synchronous
        // createAudioResource failure cannot leave an unobserved child stream error.
        ytProcess.stdout.on('error', (error) => {
            failResource(describeFailure(`yt-dlp stdout failed: ${error.message}`));
        });
        ytProcess.stderr.on('error', (error) => {
            failResource(describeFailure(`yt-dlp stderr failed: ${error.message}`));
        });
        ytProcess.once('error', (error) => {
            failResource(describeFailure(`Failed to start yt-dlp: ${error.message}`));
        });
        ytProcess.once('exit', (code, signal) => {
            if (shutdownRequested || code === 0) return;

            const outcome = code === null
                ? `yt-dlp was terminated by ${signal ?? 'an unknown signal'}`
                : `yt-dlp exited with code ${code}`;
            failResource(describeFailure(outcome));
        });
        ytProcess.once('close', (code, signal) => {
            processClosed = true;
            clearForceKillTimer();

            // The exit event normally reports this first. Keep close as a fallback because
            // it is the authoritative point at which the stdio streams have also closed.
            if (!shutdownRequested && code !== 0 && !failureReported) {
                const outcome = code === null
                    ? `yt-dlp closed after signal ${signal ?? 'unknown'}`
                    : `yt-dlp closed with code ${code}`;
                failResource(describeFailure(outcome));
            }
        });

        try {
            resource = createAudioResource<AudioMetadata>(ytProcess.stdout, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true,
                metadata
            });
        } catch (error) {
            stopProcess();
            throw error;
        }

        this.register(resource, stopProcess);

        return resource;
    }

    public createElevatorResource(): BeanAudioResource {
        const metadata: ElevatorMetadata = {
            kind: 'elevator',
            id: 'elevator',
            title: 'Elevator Music'
        };
        const resource = createAudioResource<AudioMetadata>(this.elevatorMusicPath, {
            inlineVolume: true,
            metadata
        });

        resource.volume?.setVolume(0.5);
        this.register(resource);
        return resource;
    }

    public release(resource: BeanAudioResource | undefined): void {
        if (!resource || this.releasedResources.has(resource)) return;

        const release = this.releasers.get(resource);
        if (release) {
            release();
            return;
        }

        this.releasedResources.add(resource);
        if (!resource.playStream.destroyed) resource.playStream.destroy();
    }

    public isReleased(resource: BeanAudioResource): boolean {
        return this.releasedResources.has(resource);
    }

    private register(resource: BeanAudioResource, releaseSource?: () => void): void {
        let released = false;
        const release = () => {
            if (released) return;
            released = true;

            this.releasedResources.add(resource);
            this.releasers.delete(resource);

            if (!resource.playStream.destroyed) resource.playStream.destroy();
            releaseSource?.();
        };

        this.releasers.set(resource, release);
        resource.playStream.once('close', release);
        resource.playStream.once('error', release);
    }

    private sanitizeForLog(value: string, maxLength: number): string {
        return value
            .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
            .trim()
            .slice(0, maxLength);
    }
}

export const audioResourceManager = new AudioResourceManager();
