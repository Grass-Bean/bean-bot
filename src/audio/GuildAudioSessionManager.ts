import {
    AudioPlayer,
    AudioPlayerStatus,
    createAudioPlayer,
    DiscordGatewayAdapterCreator,
    entersState,
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionDisconnectReason,
    VoiceConnectionStatus
} from '@discordjs/voice';
import { escapeMarkdown, TextChannel, type MessageCreateOptions } from 'discord.js';
import { Deque, MAX_QUEUE_SIZE } from './Deque.js';
import { audioResourceManager, AudioResourceManager } from './AudioResourceManager.js';
import { createNowPlayingEmbed } from './audioPresentation.js';
import { trackResolver } from './TrackResolver.js';
import type {
    AutoplayTrackResolver,
    AudioMetadata,
    AudioQueueSnapshot,
    BeanAudioResource,
    EnqueueResult,
    GuildAudioSession,
    QueuedTrack,
    TrackMetadata,
    VoiceRecovery,
    VoiceRecoveryKind
} from './types.js';

const VOICE_CLOSE_CODE_DESCRIPTIONS: Readonly<Record<number, string>> = {
    4001: 'Unknown opcode',
    4002: 'Failed to decode payload',
    4003: 'Not authenticated',
    4004: 'Authentication failed',
    4005: 'Already authenticated',
    4006: 'Session no longer valid',
    4009: 'Session timeout',
    4011: 'Server not found',
    4012: 'Unknown protocol',
    4014: 'Disconnected',
    4015: 'Voice server crashed',
    4016: 'Unknown encryption mode',
    4017: 'E2EE/DAVE protocol required',
    4020: 'Bad request',
    4021: 'Disconnected: Rate limited',
    4022: 'Disconnected: Call terminated'
};

const TERMINAL_VOICE_CLOSE_CODES = new Set([4021, 4022]);

export class VoiceConnectionRateLimitError extends Error {
    public constructor(public readonly retryAfterMs: number) {
        super('Discord voice connections are temporarily rate limited.');
        this.name = 'VoiceConnectionRateLimitError';
    }
}

export class GuildAudioSessionManager {
    private readonly sessions = new Map<string, GuildAudioSession>();
    private readonly observedNetworkingInstances = new WeakSet<object>();
    private readonly rateLimitCooldowns = new Map<string, number>();

    public constructor(
        private readonly resources: AudioResourceManager = audioResourceManager,
        private readonly inactivityTimeoutMs = 5 * 60 * 1000,
        private readonly connectionReadyTimeoutMs = 15_000,
        private readonly connectionRecoveryTimeoutMs = 15_000,
        private readonly emptySessionTimeoutMs = 10 * 60 * 1000,
        private readonly trackStartupTimeoutMs = 20_000,
        private readonly trackStallTimeoutMs = 30_000,
        private readonly trackWatchdogIntervalMs = 5_000,
        private readonly externalDisconnectGraceTimeoutMs = 5_000,
        private readonly rateLimitCooldownMs = 60_000,
        private readonly autoplayResolver: AutoplayTrackResolver = trackResolver
    ) {}

    public async connect(
        guildId: string,
        channelId: string,
        adapterCreator: DiscordGatewayAdapterCreator
    ): Promise<VoiceConnection> {
        const cooldownRemainingMs = this.getRateLimitCooldownRemaining(guildId);
        if (cooldownRemainingMs > 0) {
            throw new VoiceConnectionRateLimitError(cooldownRemainingMs);
        }

        const existing = this.sessions.get(guildId);
        if (existing && !existing.closing) {
            this.syncSessionChannel(existing);
            if (existing.channelId !== channelId) {
                throw new Error(`Audio is already active in voice channel ${existing.channelId}.`);
            }
            try {
                const readyConnection = await this.awaitReady(existing);
                existing.hasBeenReady = true;
                return readyConnection;
            } catch (error) {
                this.closeSession(existing, true);
                throw error;
            }
        }

        const connection = joinVoiceChannel({
            channelId,
            guildId,
            adapterCreator,
            selfDeaf: true,
            selfMute: false
        });
        const player = createAudioPlayer();
        const session: GuildAudioSession = {
            guildId,
            channelId,
            connection,
            player,
            queue: new Deque<QueuedTrack>(),
            announcementChannel: null,
            transition: Promise.resolve(),
            autoplayEnabled: false,
            hasBeenReady: connection.state.status === VoiceConnectionStatus.Ready,
            closing: false
        };

        player.on(AudioPlayerStatus.Idle, () => {
            const endedResource = session.current;
            this.clearTrackWatchdog(session);
            void this.schedule(session, async () => {
                if (session.current !== endedResource) return;
                if (endedResource) {
                    this.releaseCurrent(session);
                }
                await this.startNext(session);
            });
        });

        player.on('error', (error) => {
            const metadata = error.resource.metadata as AudioMetadata | null;
            console.error(`Audio player error in guild ${guildId} (${metadata?.title ?? 'unknown resource'}):`, error);
            if (metadata?.kind === 'track') {
                this.notify(
                    session,
                    `⚠️ **Couldn’t play ${escapeMarkdown(metadata.title)}**\nSkipping to the next track.`
                );
            }
        });

        connection.on('error', (error) => {
            console.error(`Voice connection error in guild ${guildId}:`, error);
        });
        connection.on('stateChange', (_oldState, newState) => {
            this.syncSessionChannel(session);

            if (newState.status === VoiceConnectionStatus.Connecting) {
                this.observeNetworkingClose(session, newState.networking);
            }

            if (newState.status === VoiceConnectionStatus.Destroyed) {
                this.closeSession(session, false);
                return;
            }
            if (newState.status === VoiceConnectionStatus.Ready) {
                session.hasBeenReady = true;
                this.cancelRecovery(session);
                return;
            }
            if (session.hasBeenReady) {
                let recoveryKind: VoiceRecoveryKind = 'transient';

                if (newState.status === VoiceConnectionStatus.Disconnected) {
                    const closeCode = newState.reason === VoiceConnectionDisconnectReason.WebSocketClose
                        ? newState.closeCode
                        : undefined;
                    const reason = VoiceConnectionDisconnectReason[newState.reason];
                    console.info(
                        `Voice connection disconnected in guild ${guildId} ` +
                        `(reason=${reason}${closeCode === undefined ? '' : `, closeCode=${closeCode}`}).`
                    );

                    if (
                        newState.reason === VoiceConnectionDisconnectReason.Manual ||
                        newState.reason === VoiceConnectionDisconnectReason.EndpointRemoved ||
                        (
                            newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
                            newState.closeCode === 4014
                        )
                    ) {
                        recoveryKind = 'external-disconnect';
                    }
                }

                void this.recoverConnection(session, recoveryKind);
            }
        });

        connection.subscribe(player);
        this.sessions.set(guildId, session);

        const initialConnectionState = connection.state;
        if (
            initialConnectionState.status === VoiceConnectionStatus.Connecting ||
            initialConnectionState.status === VoiceConnectionStatus.Ready
        ) {
            this.observeNetworkingClose(session, initialConnectionState.networking);
        }

        try {
            const readyConnection = await this.awaitReady(session);
            session.hasBeenReady = true;
            this.scheduleInactivityDisconnect(session, this.emptySessionTimeoutMs);
            return readyConnection;
        } catch (error) {
            this.closeSession(session, true);
            throw error;
        }
    }

    public getActiveChannelId(guildId: string): string | undefined {
        const session = this.sessions.get(guildId);
        if (!session || session.closing) return undefined;

        this.syncSessionChannel(session);
        return session.channelId;
    }

    public isQueueFull(guildId: string): boolean {
        const session = this.sessions.get(guildId);
        return Boolean(session && !session.closing && session.queue.size() >= MAX_QUEUE_SIZE);
    }

    public isAutoplayEnabled(guildId: string): boolean {
        const session = this.sessions.get(guildId);
        return Boolean(session && !session.closing && session.autoplayEnabled);
    }

    public setAutoplay(guildId: string, enabled: boolean): boolean {
        const session = this.sessions.get(guildId);
        if (!session || session.closing) return false;
        if (session.autoplayEnabled === enabled) return true;

        session.autoplayEnabled = enabled;
        if (!enabled) {
            session.autoplayController?.abort();
            if (!session.current) {
                void this.schedule(session, () => this.startNext(session));
            }
            return true;
        }

        this.clearInactivityTimer(session);
        if (session.current?.metadata.kind === 'elevator') {
            const elevator = session.current;
            session.player.stop();
            void this.schedule(session, async () => {
                if (session.current !== elevator) return;
                this.releaseCurrent(session);
                await this.startNext(session);
            });
        } else if (!session.current) {
            void this.schedule(session, () => this.startNext(session));
        }

        return true;
    }

    public enqueue(guildId: string, track: TrackMetadata, channel: TextChannel | null): EnqueueResult {
        const session = this.requireSession(guildId);
        const queueWasEmpty = session.queue.size() === 0;
        const currentKind = session.current?.metadata.kind;
        if (!session.queue.pushBack({ track, announcementChannel: channel })) {
            return { accepted: false, startsImmediately: false, position: MAX_QUEUE_SIZE };
        }

        session.autoplayController?.abort();
        const startsImmediately = queueWasEmpty && (!session.current || currentKind === 'elevator');

        this.clearInactivityTimer(session);
        const position = startsImmediately ? 0 : session.queue.size();

        if (currentKind === 'elevator') {
            const stopped = session.player.stop();
            if (!stopped) {
                void this.schedule(session, async () => {
                    if (session.current?.metadata.kind !== 'elevator') return;
                    this.releaseCurrent(session);
                    await this.startNext(session);
                });
            }
        } else {
            void this.schedule(session, async () => {
                if (!session.current) {
                    await this.startNext(session);
                } else {
                    this.reconcilePreload(session);
                }
            });
        }

        return { accepted: true, startsImmediately, position };
    }

    public skip(guildId: string): boolean {
        const session = this.sessions.get(guildId);
        if (!session || session.closing || session.current?.metadata.kind !== 'track') return false;
        return session.player.stop();
    }

    public disconnect(guildId: string): boolean {
        const session = this.sessions.get(guildId);
        if (!session) return false;
        return this.closeSession(session, true);
    }

    public getSnapshot(guildId: string): AudioQueueSnapshot {
        const session = this.sessions.get(guildId);
        if (!session) return { pending: [] };

        return {
            current: session.current ? { ...session.current.metadata } : undefined,
            pending: session.queue.toArray().map(({ track }) => ({ ...track }))
        };
    }

    private requireSession(guildId: string): GuildAudioSession {
        const session = this.sessions.get(guildId);
        if (!session || session.closing) {
            throw new Error(`No active audio session for guild ${guildId}.`);
        }
        return session;
    }

    private schedule(session: GuildAudioSession, operation: () => Promise<void>): Promise<void> {
        const scheduled = session.transition.then(async () => {
            if (session.closing) return;
            await operation();
        });

        session.transition = scheduled.catch((error) => {
            console.error(`Audio state transition failed in guild ${session.guildId}:`, error);
        });
        return scheduled;
    }

    private async awaitReady(
        session: GuildAudioSession,
        timeoutOrSignal: number | AbortSignal = this.connectionReadyTimeoutMs
    ): Promise<VoiceConnection> {
        if (session.connection.state.status === VoiceConnectionStatus.Ready) {
            return session.connection;
        }

        return entersState(
            session.connection,
            VoiceConnectionStatus.Ready,
            timeoutOrSignal
        );
    }

    private async recoverConnection(
        session: GuildAudioSession,
        recoveryKind: VoiceRecoveryKind = 'transient'
    ): Promise<void> {
        if (session.closing) return;

        const existingRecovery = session.recovery;
        if (existingRecovery?.kind === recoveryKind) return existingRecovery.promise;

        existingRecovery?.controller.abort();

        const controller = new AbortController();
        const recovery: VoiceRecovery = {
            kind: recoveryKind,
            controller,
            promise: Promise.resolve()
        };
        session.recovery = recovery;

        recovery.promise = (async () => {
            try {
                const timeoutMs = recoveryKind === 'external-disconnect'
                    ? this.externalDisconnectGraceTimeoutMs
                    : this.connectionRecoveryTimeoutMs;
                const timeout = setTimeout(() => controller.abort(), timeoutMs);
                timeout.unref();

                try {
                    await this.awaitReady(session, controller.signal);
                } finally {
                    clearTimeout(timeout);
                }
                this.syncSessionChannel(session);
            } catch (error) {
                if (
                    session.recovery !== recovery ||
                    this.sessions.get(session.guildId) !== session ||
                    session.closing
                ) return;

                if (recoveryKind === 'external-disconnect') {
                    console.info(
                        `Voice connection in guild ${session.guildId} was removed externally; ` +
                        'clearing the audio session.'
                    );
                    this.notify(
                        session,
                        'ℹ️ **Disconnected from voice**\nThe audio session was cleared.'
                    );
                } else {
                    console.error(`Voice connection recovery failed in guild ${session.guildId}:`, error);
                    this.notify(session, '⚠️ **Voice connection lost**\nThe audio session was cleared.');
                }
                this.closeSession(session, true);
            } finally {
                if (session.recovery === recovery) session.recovery = undefined;
            }
        })();

        return recovery.promise;
    }

    private observeNetworkingClose(
        session: GuildAudioSession,
        networking: object & {
            prependOnceListener(event: 'close', listener: (code: number) => void): unknown;
        }
    ): void {
        if (this.observedNetworkingInstances.has(networking)) return;
        this.observedNetworkingInstances.add(networking);

        // Run before @discordjs/voice's close listener so terminal close codes do
        // not trigger the library's generic rejoin path.
        networking.prependOnceListener('close', (code) => {
            if (this.sessions.get(session.guildId) !== session || session.closing) return;

            const description = VOICE_CLOSE_CODE_DESCRIPTIONS[code] ?? 'Unknown voice close code';
            console.info(
                `Voice WebSocket closed in guild ${session.guildId} ` +
                `(closeCode=${code}, description=${description}).`
            );

            if (!TERMINAL_VOICE_CLOSE_CODES.has(code)) return;

            if (code === 4021) this.startRateLimitCooldown(session.guildId);

            const notification = code === 4021
                ? '⚠️ **Discord rate-limited voice**\nThe audio session was cleared.'
                : 'ℹ️ **Voice call ended**\nThe audio session was cleared.';
            this.notify(session, notification);
            this.closeSession(session, true);
        });
    }

    private getRateLimitCooldownRemaining(guildId: string): number {
        const expiresAt = this.rateLimitCooldowns.get(guildId);
        if (expiresAt === undefined) return 0;

        const remainingMs = expiresAt - Date.now();
        if (remainingMs > 0) return remainingMs;

        this.rateLimitCooldowns.delete(guildId);
        return 0;
    }

    private startRateLimitCooldown(guildId: string): void {
        const expiresAt = Date.now() + this.rateLimitCooldownMs;
        this.rateLimitCooldowns.set(guildId, expiresAt);

        const cleanupTimer = setTimeout(() => {
            if (this.rateLimitCooldowns.get(guildId) === expiresAt) {
                this.rateLimitCooldowns.delete(guildId);
            }
        }, this.rateLimitCooldownMs);
        cleanupTimer.unref();
    }

    private syncSessionChannel(session: GuildAudioSession): void {
        const channelId = session.connection.joinConfig.channelId;
        if (channelId) session.channelId = channelId;
    }

    private cancelRecovery(session: GuildAudioSession): void {
        const recovery = session.recovery;
        session.recovery = undefined;
        recovery?.controller.abort();
    }

    private closeSession(session: GuildAudioSession, destroyConnection: boolean): boolean {
        if (session.closing) return false;

        session.closing = true;
        if (this.sessions.get(session.guildId) === session) {
            this.sessions.delete(session.guildId);
        }
        this.clearInactivityTimer(session);
        this.clearTrackWatchdog(session);
        this.cancelRecovery(session);
        session.autoplayController?.abort();
        session.autoplayController = undefined;

        session.player.removeAllListeners();
        session.player.stop(true);
        this.releaseCurrent(session);
        this.releasePreload(session);
        session.queue = new Deque<QueuedTrack>();

        if (destroyConnection && session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            session.connection.destroy();
        }
        return true;
    }

    private async startNext(session: GuildAudioSession): Promise<void> {
        if (session.closing || session.current) return;
        this.clearTrackWatchdog(session);

        while (!session.closing) {
            const queuedTrack = session.queue.popFront();
            if (!queuedTrack) {
                if (session.autoplayEnabled && session.lastTrack) {
                    if (await this.startAutoplay(session)) return;
                    if (session.queue.size() > 0) continue;
                }
                this.startElevatorMusic(session);
                return;
            }

            this.clearInactivityTimer(session);
            const { track, announcementChannel } = queuedTrack;
            session.announcementChannel = announcementChannel;

            try {
                const resource = this.takePreload(session, track) ?? this.resources.createTrackResource(track);
                session.current = resource;
                session.lastTrack = track;
                session.player.play(resource);
                this.startTrackWatchdog(session, resource);
                this.notify(session, {
                    embeds: [createNowPlayingEmbed(track, session.queue.size())]
                });
                this.reconcilePreload(session);
                return;
            } catch (error) {
                console.error(`Failed to play ${track.title} in guild ${session.guildId}:`, error);
                this.releaseCurrent(session);
                this.notify(
                    session,
                    `⚠️ **Couldn’t play ${escapeMarkdown(track.title)}**\nSkipping to the next track.`
                );
            }
        }
    }

    private async startAutoplay(session: GuildAudioSession): Promise<boolean> {
        const seed = session.lastTrack;
        if (!session.autoplayEnabled || !seed || session.closing || session.current) return false;

        this.clearInactivityTimer(session);
        session.autoplayController?.abort();
        const controller = new AbortController();
        session.autoplayController = controller;

        let resource: BeanAudioResource | undefined;
        try {
            const track = await this.autoplayResolver.resolveAutoplay(seed, controller.signal);
            if (
                controller.signal.aborted ||
                session.autoplayController !== controller ||
                !session.autoplayEnabled ||
                session.closing ||
                session.current ||
                session.queue.size() > 0
            ) return false;

            resource = this.resources.createTrackResource(track);
            session.current = resource;
            session.lastTrack = track;
            session.player.play(resource);
            this.startTrackWatchdog(session, resource);
            this.notify(session, {
                embeds: [createNowPlayingEmbed(track, session.queue.size())]
            });
            return true;
        } catch (error) {
            if (resource && session.current === resource) this.releaseCurrent(session);
            if (!controller.signal.aborted) {
                console.error(`Failed to start autoplay in guild ${session.guildId}:`, error);
            }
            return false;
        } finally {
            if (session.autoplayController === controller) {
                session.autoplayController = undefined;
            }
        }
    }

    private takePreload(session: GuildAudioSession, track: TrackMetadata): BeanAudioResource | undefined {
        const preload = session.preload;
        session.preload = undefined;
        if (!preload) return undefined;

        if (
            preload.metadata.kind === 'track' &&
            preload.metadata.id === track.id &&
            !this.resources.isReleased(preload)
        ) {
            return preload;
        }

        this.resources.release(preload);
        return undefined;
    }

    private reconcilePreload(session: GuildAudioSession): void {
        const nextQueuedTrack = session.queue.peekFront();
        const currentPreload = session.preload;

        if (!nextQueuedTrack) {
            this.releasePreload(session);
            return;
        }

        const { track: nextTrack } = nextQueuedTrack;

        if (
            currentPreload?.metadata.kind === 'track' &&
            currentPreload.metadata.id === nextTrack.id &&
            !this.resources.isReleased(currentPreload)
        ) {
            return;
        }

        this.releasePreload(session);
        try {
            session.preload = this.resources.createTrackResource(nextTrack);
        } catch (error) {
            session.preload = undefined;
            console.error(`Failed to preload ${nextTrack.title} in guild ${session.guildId}:`, error);
        }
    }

    private startElevatorMusic(session: GuildAudioSession): void {
        if (session.closing || session.current) return;

        this.clearTrackWatchdog(session);
        this.releasePreload(session);

        try {
            const elevatorResource = this.resources.createElevatorResource();
            session.current = elevatorResource;
            session.player.play(elevatorResource);
        } catch (error) {
            console.error(`Failed to play elevator music in guild ${session.guildId}:`, error);
        }

        if (!session.inactivityTimer) {
            this.notify(
                session,
                '⏱️ **Queue finished**\nDisconnecting in 5 minutes if nothing else is added.'
            );
            this.scheduleInactivityDisconnect(
                session,
                this.inactivityTimeoutMs,
                '🔌 **Disconnected after 5 minutes of inactivity.**'
            );
        }
    }

    private clearInactivityTimer(session: GuildAudioSession): void {
        if (!session.inactivityTimer) return;
        clearTimeout(session.inactivityTimer);
        session.inactivityTimer = undefined;
    }

    private scheduleInactivityDisconnect(
        session: GuildAudioSession,
        timeoutMs: number,
        disconnectMessage?: string
    ): void {
        if (session.inactivityTimer) return;

        session.inactivityTimer = setTimeout(() => {
            session.inactivityTimer = undefined;
            if (this.sessions.get(session.guildId) !== session) return;
            if (disconnectMessage) this.notify(session, disconnectMessage);
            this.disconnect(session.guildId);
        }, timeoutMs);
        session.inactivityTimer.unref();
    }

    private startTrackWatchdog(session: GuildAudioSession, resource: BeanAudioResource): void {
        if (resource.metadata.kind !== 'track') return;

        this.clearTrackWatchdog(session);

        const startedAt = Date.now();
        const maximumPlaybackMs = resource.metadata.duration === undefined
            ? undefined
            : Math.max(60_000, Math.ceil(resource.metadata.duration * 1_500) + 30_000);
        let playbackStartedAt: number | undefined;
        let lastPlaybackDuration = 0;
        let lastProgressAt = startedAt;

        const watchdog = setInterval(() => {
            if (session.closing || session.current !== resource) {
                this.clearTrackWatchdog(session, watchdog);
                return;
            }

            const now = Date.now();
            if (session.player.state.status !== AudioPlayerStatus.Playing) {
                if (!playbackStartedAt && now - startedAt >= this.trackStartupTimeoutMs) {
                    this.stopWatchedTrack(session, resource, 'Playback didn’t start in time');
                } else if (playbackStartedAt && now - lastProgressAt >= this.trackStallTimeoutMs) {
                    this.stopWatchedTrack(session, resource, 'Playback stalled');
                }
                return;
            }

            if (!playbackStartedAt) playbackStartedAt = now;
            if (resource.playbackDuration > lastPlaybackDuration) {
                lastPlaybackDuration = resource.playbackDuration;
                lastProgressAt = now;
            } else if (now - lastProgressAt >= this.trackStallTimeoutMs) {
                this.stopWatchedTrack(session, resource, 'Playback stalled');
                return;
            }

            if (maximumPlaybackMs !== undefined && now - playbackStartedAt >= maximumPlaybackMs) {
                this.stopWatchedTrack(session, resource, 'Playback ran longer than expected');
            }
        }, this.trackWatchdogIntervalMs);
        watchdog.unref();
        session.trackWatchdog = watchdog;
    }

    private stopWatchedTrack(
        session: GuildAudioSession,
        resource: BeanAudioResource,
        reason: string
    ): void {
        if (session.closing || session.current !== resource) return;

        this.clearTrackWatchdog(session);
        const title = resource.metadata.kind === 'track'
            ? ` **${escapeMarkdown(resource.metadata.title)}**`
            : '';
        this.notify(session, `⚠️ **${reason}**\nSkipped${title}.`);
        if (session.player.stop(true)) return;

        void this.schedule(session, async () => {
            if (session.current !== resource) return;
            this.releaseCurrent(session);
            await this.startNext(session);
        });
    }

    private releaseCurrent(session: GuildAudioSession): void {
        this.resources.release(session.current);
        session.current = undefined;
    }

    private releasePreload(session: GuildAudioSession): void {
        this.resources.release(session.preload);
        session.preload = undefined;
    }

    private clearTrackWatchdog(session: GuildAudioSession, expected?: NodeJS.Timeout): void {
        if (!session.trackWatchdog || (expected && session.trackWatchdog !== expected)) return;
        clearInterval(session.trackWatchdog);
        session.trackWatchdog = undefined;
    }

    private notify(session: GuildAudioSession, message: string | MessageCreateOptions): void {
        const payload: MessageCreateOptions = typeof message === 'string'
            ? { content: message, allowedMentions: { parse: [] } }
            : { ...message, allowedMentions: { parse: [] } };

        void session.announcementChannel?.send(payload).catch((error) => {
            console.error(`Failed to send audio notification in guild ${session.guildId}:`, error);
        });
    }

}

export const guildAudioSessionManager = new GuildAudioSessionManager();
