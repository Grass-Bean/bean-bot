import { createAudioResource, StreamType } from '@discordjs/voice';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    AudioMetadata,
    BeanAudioResource,
    ElevatorMetadata,
    TrackMetadata,
    YtDlpProcessClient,
    YtDlpProcessFailure
} from './types.js';
import {
    YtDlpProcessManager,
    ytDlpProcessManager
} from './YtDlpProcessManager.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultElevatorMusicPath = path.resolve(moduleDirectory, '../../assets/elevator.mp3');

export class AudioResourceManager {
    private readonly releasers = new WeakMap<BeanAudioResource, () => void>();
    private readonly releasedResources = new WeakSet<BeanAudioResource>();
    private readonly processes: YtDlpProcessClient;

    public constructor(
        forceKillTimeoutMs = 2_000,
        ytDlpCommand = 'yt-dlp',
        private readonly elevatorMusicPath = defaultElevatorMusicPath,
        processes?: YtDlpProcessClient
    ) {
        this.processes = processes ?? (
            forceKillTimeoutMs === 2_000 && ytDlpCommand === 'yt-dlp'
                ? ytDlpProcessManager
                : new YtDlpProcessManager({
                    command: ytDlpCommand,
                    forceKillTimeoutMs
                })
        );
    }

    public createTrackResource(metadata: TrackMetadata): BeanAudioResource {
        const ytProcess = this.processes.stream([
            '--ignore-config',
            '--no-playlist',
            '-q',
            '-f', 'bestaudio/best',
            '-o', '-',
            '--add-headers', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            '--extractor-args', 'youtube:player_client=default',
            '--',
            metadata.url
        ]);

        let resource: BeanAudioResource | undefined;
        let failureReported = false;

        const describeFailure = (error: YtDlpProcessFailure) => {
            const safeSummary = this.sanitizeForLog(error.message, 500);
            const details = this.sanitizeForLog(error.stderr.toString('utf8'), 8_000);
            return new Error(details ? `${safeSummary}: ${details}` : safeSummary);
        };

        const failResource = (error: Error) => {
            if (failureReported) return;
            failureReported = true;
            console.error(`[yt-dlp] ${this.sanitizeForLog(metadata.title, 200)}:`, error.message);

            // Child-process cleanup should not depend on Discord's stream events firing.
            void ytProcess.stop();

            if (resource && !resource.playStream.destroyed) {
                resource.playStream.destroy(error);
            }
        };

        ytProcess.onFailure(error => failResource(describeFailure(error)));

        try {
            resource = createAudioResource<AudioMetadata>(ytProcess.stdout, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true,
                metadata
            });
        } catch (error) {
            void ytProcess.stop();
            throw error;
        }

        this.register(resource, () => void ytProcess.stop());

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
