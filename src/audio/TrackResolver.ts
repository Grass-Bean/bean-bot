import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { TrackMetadata } from './types.js';

interface YtDlpMetadata {
    title?: string;
    webpage_url?: string;
    duration_string?: string;
    thumbnail?: string;
}

export class TrackResolver {
    public async resolve(query: string, requestedBy: string): Promise<TrackMetadata> {
        const input = this.resolveInput(query);

        return new Promise<TrackMetadata>((resolve, reject) => {
            let settled = false;
            const ytProcess = spawn('yt-dlp', [
                '--ignore-config',
                '--dump-json',
                '--no-playlist',
                '-q',
                '--',
                input
            ], { windowsHide: true });

            let stdoutData = '';
            let stderrData = '';

            ytProcess.stdout.on('data', (chunk) => { stdoutData += chunk.toString(); });
            ytProcess.stderr.on('data', (chunk) => {
                stderrData = `${stderrData}${chunk.toString()}`.slice(-8_000);
            });

            ytProcess.once('close', (code) => {
                if (settled) return;
                settled = true;

                if (code !== 0) {
                    console.error(`[yt-dlp Error] Code ${code}:`, stderrData.trim());
                    reject(new Error(`Failed to fetch metadata: ${stderrData.split('\n')[0] || 'Unknown error'}`));
                    return;
                }

                try {
                    const data = JSON.parse(stdoutData) as YtDlpMetadata;
                    if (!data.title || !data.webpage_url) {
                        throw new Error('yt-dlp response did not contain a title and URL.');
                    }

                    resolve({
                        kind: 'track',
                        id: randomUUID(),
                        title: data.title,
                        url: data.webpage_url,
                        duration: data.duration_string,
                        thumbnail: data.thumbnail,
                        requestedBy
                    });
                } catch (error) {
                    console.error('[yt-dlp Parse Error] Failed to parse JSON:', error);
                    reject(new Error('Received invalid data from YouTube.'));
                }
            });

            ytProcess.once('error', (error) => {
                if (settled) return;
                settled = true;
                console.error('[yt-dlp Spawn Error]', error);
                reject(error);
            });
        });
    }

    private resolveInput(query: string): string {
        if (!/^https?:\/\//i.test(query)) return `ytsearch1:${query}`;

        let url: URL;
        try {
            url = new URL(query);
        } catch {
            throw new Error('The supplied URL is invalid.');
        }

        return url.toString();
    }
}

export const trackResolver = new TrackResolver();
