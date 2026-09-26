import { describe, expect, it } from 'vitest';
import { getMediaKey, getTransitionKey } from '../src/audio/mediaIdentity.js';
import type { TrackMetadata } from '../src/audio/types.js';

const track = (url: string): TrackMetadata => ({
    kind: 'track',
    id: crypto.randomUUID(),
    title: 'Track',
    url,
    requestedBy: 'user-a'
});

describe('media identity', () => {
    it('uses the YouTube video id across equivalent URL forms', () => {
        expect(getMediaKey(track('https://youtu.be/abc'))).toBe('youtube:abc');
        expect(getMediaKey(track('https://www.youtube.com/watch?v=abc&feature=share')))
            .toBe('youtube:abc');
        expect(getMediaKey(track('https://youtube.com/shorts/abc'))).toBe('youtube:abc');
    });

    it('normalizes Instagram identity and creates unambiguous transition keys', () => {
        expect(getMediaKey(track('https://www.instagram.com/reel/abc/?utm_source=test')))
            .toBe('instagram:/reel/abc');
        expect(getTransitionKey('ab', 'c')).not.toBe(getTransitionKey('a', 'bc'));
    });
});
