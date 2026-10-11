import { CountedSlidingWindow } from './SlidingWindow.js';
import { getMediaKey, getYouTubeVideoId, type MediaKey } from './mediaIdentity.js';
import type { TrackMetadata } from './types.js';

export class TrackPlaybackHistory {
    private readonly plays: CountedSlidingWindow<MediaKey>;
    private lastYouTube?: TrackMetadata;

    public constructor(capacity: number) {
        this.plays = new CountedSlidingWindow(capacity);
    }

    public get lastYouTubeTrack(): TrackMetadata | undefined {
        return this.lastYouTube;
    }

    public record(track: TrackMetadata): void {
        this.plays.push(getMediaKey(track));
        if (getYouTubeVideoId(track.url)) this.lastYouTube = { ...track };
    }

    public has(key: MediaKey): boolean {
        return this.plays.has(key);
    }
}
