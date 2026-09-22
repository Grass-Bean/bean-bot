import { AudioResource } from '@discordjs/voice';

export interface TrackMetadata {
    kind: 'track';
    id: string;
    title: string;
    url: string;
    duration?: number;
    thumbnail?: string;
    requestedBy: string;
}

export interface ElevatorMetadata {
    kind: 'elevator';
    id: 'elevator';
    title: string;
}

export type AudioMetadata = TrackMetadata | ElevatorMetadata;
export type BeanAudioResource = AudioResource<AudioMetadata>;

export interface AudioQueueSnapshot {
    current?: AudioMetadata;
    pending: readonly TrackMetadata[];
}

export interface EnqueueResult {
    accepted: boolean;
    startsImmediately: boolean;
    position: number;
}
