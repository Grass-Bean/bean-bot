import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { TrackMetadata } from './types.js';

interface YtDlpMetadata {
    title?: string;
    webpage_url?: string;
    duration_string?: string;
    thumbnail?: string;
}

export class YouTubeTrackResolver {
    public resolve(query: string, requestedBy: string): Promise<TrackMetadata> {
        const input = query.startsWith('http') ? query : `ytsearch1:${query}`;

        return new Promise((resolve, reject) => {
            let settled = false;
            const ytProcess = spawn('yt-dlp', [
                '--dump-json',
                '--no-playlist',
                '-q',
                input
            ]);

            let stdoutData = '';
            let stderrData = '';

            ytProcess.stdout.on('data', (chunk) => { stdoutData += chunk.toString(); });
            ytProcess.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

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
}

export const youTubeTrackResolver = new YouTubeTrackResolver();
