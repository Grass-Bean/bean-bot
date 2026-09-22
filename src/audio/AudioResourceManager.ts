import { createAudioResource, StreamType } from '@discordjs/voice';
import { spawn } from 'child_process';
import path from 'path';
import { AudioMetadata, BeanAudioResource, ElevatorMetadata, TrackMetadata } from './types.js';

export class AudioResourceManager {
    private readonly elevatorMusicPath = path.join(process.cwd(), 'assets', 'elevator.mp3');
    private readonly disposers = new WeakMap<BeanAudioResource, () => void>();
    private readonly disposedResources = new WeakSet<BeanAudioResource>();

    public createTrackResource(metadata: TrackMetadata): BeanAudioResource {
        const ytProcess = spawn('yt-dlp', [
            '-f', 'bestaudio/best',
            '--no-playlist',
            '-o', '-',
            '-q',
            '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            '--extractor-args', 'youtube:player_client=default',
            metadata.url
        ]);

        ytProcess.stderr.on('data', (data) => {
            const message = data.toString();
            if (message.includes('Broken pipe') || message.includes('Errno 32')) return;
            if (!message.includes('WARNING')) console.warn(`yt-dlp stderr: ${message}`);
        });

        let resource: BeanAudioResource;
        try {
            resource = createAudioResource<AudioMetadata>(ytProcess.stdout, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true,
                metadata
            });
        } catch (error) {
            if (!ytProcess.killed) ytProcess.kill('SIGKILL');
            throw error;
        }

        this.register(resource, () => {
            if (ytProcess.exitCode === null && ytProcess.signalCode === null && !ytProcess.killed) {
                ytProcess.kill('SIGKILL');
            }
        });

        ytProcess.stdout.once('error', () => this.dispose(resource));
        ytProcess.stderr.once('error', () => this.dispose(resource));
        ytProcess.once('error', () => this.dispose(resource));

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

    public dispose(resource: BeanAudioResource | undefined): void {
        if (!resource || this.disposedResources.has(resource)) return;

        const dispose = this.disposers.get(resource);
        if (dispose) {
            dispose();
            return;
        }

        this.disposedResources.add(resource);
        if (!resource.playStream.destroyed) resource.playStream.destroy();
    }

    public isDisposed(resource: BeanAudioResource): boolean {
        return this.disposedResources.has(resource);
    }

    private register(resource: BeanAudioResource, releaseSource?: () => void): void {
        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;

            this.disposedResources.add(resource);
            this.disposers.delete(resource);

            if (!resource.playStream.destroyed) resource.playStream.destroy();
            releaseSource?.();
        };

        this.disposers.set(resource, dispose);
        resource.playStream.once('close', dispose);
        resource.playStream.once('error', dispose);
    }
}

export const audioResourceManager = new AudioResourceManager();
