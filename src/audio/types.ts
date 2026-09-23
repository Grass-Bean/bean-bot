import type {
    AudioPlayer,
    AudioResource,
    VoiceConnection
} from '@discordjs/voice';
import type { TextChannel } from 'discord.js';
import type { Deque } from './Deque.js';

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

export interface QueuedTrack {
    track: TrackMetadata;
    announcementChannel: TextChannel | null;
}

export type VoiceRecoveryKind = 'transient' | 'external-disconnect';

export interface VoiceRecovery {
    kind: VoiceRecoveryKind;
    controller: AbortController;
    promise: Promise<void>;
}

export interface GuildAudioSession {
    guildId: string;
    channelId: string;
    connection: VoiceConnection;
    player: AudioPlayer;
    queue: Deque<QueuedTrack>;
    current?: BeanAudioResource;
    preload?: BeanAudioResource;
    inactivityTimer?: NodeJS.Timeout;
    trackWatchdog?: NodeJS.Timeout;
    announcementChannel: TextChannel | null;
    transition: Promise<void>;
    recovery?: VoiceRecovery;
    hasBeenReady: boolean;
    closing: boolean;
}

export interface YtDlpMetadata {
    title: string;
    webpage_url: string;
    duration?: number | null;
    thumbnail?: string | null;
}

export type TrackResolverErrorCode =
    | 'INVALID_INPUT'
    | 'UNSUPPORTED_URL'
    | 'TIMEOUT'
    | 'CANCELLED'
    | 'PROCESS_FAILURE'
    | 'OUTPUT_LIMIT'
    | 'INVALID_RESPONSE';

export interface TrackResolverOptions {
    timeoutMs?: number;
    maxStdoutBytes?: number;
    forceKillTimeoutMs?: number;
    ytDlpCommand?: string;
    ytDlpCommandArgs?: readonly string[];
    logDiagnostics?: boolean;
}
