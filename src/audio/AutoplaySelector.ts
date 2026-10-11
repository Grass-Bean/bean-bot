import { getMediaKey, getYouTubeVideoId } from './mediaIdentity.js';
import type { TrackPlaybackHistory } from './TrackPlaybackHistory.js';
import type { TrackMetadata } from './types.js';

export class AutoplaySelector {
    public selectCandidate(
        candidates: readonly TrackMetadata[],
        history: TrackPlaybackHistory
    ): TrackMetadata | undefined {
        const seedKey = history.lastYouTubeTrack && getMediaKey(history.lastYouTubeTrack);
        return candidates.find(track => {
            const key = getMediaKey(track);
            return Boolean(getYouTubeVideoId(track.url)) &&
                key !== seedKey && !history.has(key);
        });
    }
}
