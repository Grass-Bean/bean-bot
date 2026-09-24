import { createAudioResource, StreamType } from '@discordjs/voice';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    AudioMetadata,
    AudioResourceManagerOptions,
    BeanAudioResource,
    ElevatorMetadata,
    TrackMetadata,
    YtDlpProcessClient,
    YtDlpProcessFailure
} from './types.js';
import { ytDlpProcessManager } from './YtDlpProcessManager.js';
import { sanitizeLogText } from './sanitizeLogText.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultElevatorMusicPath = path.resolve(moduleDirectory, '../../assets/elevator.mp3');

export class AudioResourceManager {
    private readonly releasers = new WeakMap<BeanAudioResource, () => void>();
    private readonly releasedResources = new WeakSet<BeanAudioResource>();
    private readonly processes: YtDlpProcessClient;
    private readonly elevatorMusicPath: string;

    public constructor(options: AudioResourceManagerOptions = {}) {
        this.processes = options.processes ?? ytDlpProcessManager;
        this.elevatorMusicPath = options.elevatorMusicPath ?? defaultElevatorMusicPath;
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

        const describeFailure = (error: YtDlpProcessFailure) => {
            const safeSummary = sanitizeLogText(error.message, 500);
            const details = sanitizeLogText(error.stderr.toString('utf8'), 8_000);
            return new Error(details ? `${safeSummary}: ${details}` : safeSummary);
        };

        const failResource = (error: Error) => {
            console.error(`[yt-dlp] ${sanitizeLogText(metadata.title, 200)}:`, error.message);

            if (resource && !resource.playStream.destroyed) {
                resource.playStream.destroy(error);
            }
        };

        void ytProcess.completion.then(outcome => {
            if (outcome.status === 'failed') failResource(describeFailure(outcome.error));
        });

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
        const release = () => {
            if (this.releasedResources.has(resource)) return;

            this.releasedResources.add(resource);
            this.releasers.delete(resource);

            if (!resource.playStream.destroyed) resource.playStream.destroy();
            releaseSource?.();
        };

        this.releasers.set(resource, release);
        resource.playStream.once('close', release);
        resource.playStream.once('error', release);
    }

}

export const audioResourceManager = new AudioResourceManager();
