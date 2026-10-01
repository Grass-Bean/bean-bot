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
import { audioResourceManager, AudioResourceManager, getResourceFailure, reportResourceFailure } from './AudioResourceManager.js';
import { logger, getLogContextFields, type LogFields } from '../utility/logger.js';
import { AutoplayCoordinator } from './AutoplayCoordinator.js';
import { createNowPlayingEmbed } from './audioPresentation.js';
import { trackResolver } from './TrackResolver.js';
import { AutoplaySelector } from './AutoplaySelector.js';
import { VoiceRecoveryPolicy } from './VoiceRecoveryPolicy.js';
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
const log = logger.child({ component: 'audio' }, { inheritContext: false });

export interface GuildAudioSessionManagerOptions {
    resources?: AudioResourceManager;
    inactivityTimeoutMs?: number;
    connectionReadyTimeoutMs?: number;
    connectionRecoveryTimeoutMs?: number;
    emptySessionTimeoutMs?: number;
    trackStartupTimeoutMs?: number;
    trackStallTimeoutMs?: number;
    trackWatchdogIntervalMs?: number;
    externalDisconnectGraceTimeoutMs?: number;
    rateLimitCooldownMs?: number;
    autoplayResolver?: AutoplayTrackResolver;
    autoplaySelector?: AutoplaySelector;
    autoplayCoordinator?: AutoplayCoordinator;
    voiceRecoveryPolicy?: VoiceRecoveryPolicy;
}

export class VoiceConnectionRateLimitError extends Error {
    public constructor(public readonly retryAfterMs: number) {
        super('Discord voice connections are temporarily rate limited.');
        this.name = 'VoiceConnectionRateLimitError';
    }
}

export class GuildAudioSessionManager {
    private readonly sessions = new Map<string, GuildAudioSession>();
    private readonly startedResources = new WeakSet<BeanAudioResource>();
    private readonly endedResources = new WeakSet<BeanAudioResource>();
    private readonly endReasons = new WeakMap<BeanAudioResource, string>();
    private readonly observedNetworkingInstances = new WeakSet<object>();
    private readonly rateLimitCooldowns = new Map<string, number>();
    private readonly resources: AudioResourceManager;
    private readonly inactivityTimeoutMs: number;
    private readonly connectionReadyTimeoutMs: number;
    private readonly emptySessionTimeoutMs: number;
    private readonly trackStartupTimeoutMs: number;
    private readonly trackStallTimeoutMs: number;
    private readonly trackWatchdogIntervalMs: number;
    private readonly externalDisconnectGraceTimeoutMs: number;
    private readonly rateLimitCooldownMs: number;
    private readonly autoplayCoordinator: AutoplayCoordinator;
    private readonly voiceRecoveryPolicy: VoiceRecoveryPolicy;

    public constructor(options: GuildAudioSessionManagerOptions = {}) {
        this.resources = options.resources ?? audioResourceManager;
        this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 5 * 60 * 1000;
        this.connectionReadyTimeoutMs = options.connectionReadyTimeoutMs ?? 15_000;
        this.emptySessionTimeoutMs = options.emptySessionTimeoutMs ?? 10 * 60 * 1000;
        this.trackStartupTimeoutMs = options.trackStartupTimeoutMs ?? 20_000;
        this.trackStallTimeoutMs = options.trackStallTimeoutMs ?? 30_000;
        this.trackWatchdogIntervalMs = options.trackWatchdogIntervalMs ?? 5_000;
        this.externalDisconnectGraceTimeoutMs = options.externalDisconnectGraceTimeoutMs ?? 5_000;
        this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 60_000;
        this.autoplayCoordinator = options.autoplayCoordinator ?? new AutoplayCoordinator({
            resolver: options.autoplayResolver ?? trackResolver,
            selector: options.autoplaySelector ?? new AutoplaySelector()
        });
        this.voiceRecoveryPolicy = options.voiceRecoveryPolicy ?? new VoiceRecoveryPolicy({
            attemptTimeoutMs: options.connectionRecoveryTimeoutMs
        });
    }

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
            const readyConnection = await this.awaitReady(existing);
            existing.hasBeenReady = true;
            return readyConnection;
        }

        const connection = joinVoiceChannel({
            channelId,
            guildId,
            adapterCreator,
            selfDeaf: true,
            selfMute: false
        });
        const player = createAudioPlayer();
        let readyReported = false;
        log.info('voice.connecting', 'Joining voice channel.', { guildId, voiceChannelId: channelId });
        const session: GuildAudioSession = {
            guildId,
            channelId,
            connection,
            player,
            queue: new Deque<QueuedTrack>(),
            announcementChannel: null,
            transition: Promise.resolve(),
            autoplay: this.autoplayCoordinator.createState(),
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
            const resource = error.resource as BeanAudioResource;
            this.endReasons.set(resource, 'failed');
            reportResourceFailure(resource, error, this.sessionFields(session), 'audio.player_failed');
            if (metadata?.kind === 'track') {
                this.notify(
                    session,
                    `⚠️ **Couldn’t play ${escapeMarkdown(metadata.title)}**\nSkipping to the next track.`
                );
            }
        });

        connection.on('error', (error) => {
            log.error('voice.connection_error', 'Voice connection error.', { ...this.sessionFields(session), error });
        });
        player.on('stateChange', (_oldState, newState) => {
            log.debug('audio.player_state', 'Audio player state changed.', { ...this.sessionFields(session), state: newState.status });
            if (newState.status === AudioPlayerStatus.Playing) this.logPlaybackStarted(session, newState.resource as BeanAudioResource);
        });
        connection.on('stateChange', (oldState, newState) => {
            this.syncSessionChannel(session);
            log.debug('voice.state_changed', 'Voice state changed.', { ...this.sessionFields(session), oldState: oldState.status, state: newState.status });

            if (newState.status === VoiceConnectionStatus.Connecting) {
                this.observeNetworkingClose(session, newState.networking);
            }

            if (newState.status === VoiceConnectionStatus.Destroyed) {
                this.closeSession(session, false, 'connection_destroyed');
                return;
            }
            if (newState.status === VoiceConnectionStatus.Ready) {
                readyReported = true;
                log.info('voice.ready', 'Voice connection ready.', this.sessionFields(session));
                if (session.recovery) log.info('voice.recovery_succeeded', 'Voice connection recovered.', { ...this.sessionFields(session), recoveryKind: session.recovery.kind });
                session.hasBeenReady = true;
                this.cancelRecovery(session);
                if (!session.current && session.queue.size() > 0) {
                    void this.schedule(session, () => this.startNext(session));
                }
                return;
            }
            if (session.hasBeenReady) {
                let recoveryKind: VoiceRecoveryKind = 'transient';

                if (newState.status === VoiceConnectionStatus.Disconnected) {
                    const closeCode = newState.reason === VoiceConnectionDisconnectReason.WebSocketClose
                        ? newState.closeCode
                        : undefined;
                    const reason = VoiceConnectionDisconnectReason[newState.reason];
                    log.warn('voice.disconnected', 'Voice connection disconnected.', { ...this.sessionFields(session), reason, closeCode });

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
            if (!readyReported) log.info('voice.ready', 'Voice connection ready.', this.sessionFields(session));
            session.hasBeenReady = true;
            this.scheduleInactivityDisconnect(session, this.emptySessionTimeoutMs);
            return readyConnection;
        } catch (error) {
            this.closeSession(session, true, 'connect_failed');
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
        return Boolean(session && !session.closing && session.autoplay.enabled);
    }

    public setAutoplay(guildId: string, enabled: boolean): boolean {
        const session = this.sessions.get(guildId);
        if (!session || session.closing) return false;
        if (session.autoplay.enabled === enabled) return true;
        log.info('audio.autoplay_changed', 'Autoplay setting changed.', { ...this.sessionFields(session), enabled });

        if (!enabled) {
            this.autoplayCoordinator.disable(session.autoplay);
            if (!session.current) {
                void this.schedule(session, () => this.startNext(session));
            }
            return true;
        }

        this.clearInactivityTimer(session);
        this.autoplayCoordinator.enable(
            session.guildId,
            session.autoplay,
            () => !session.closing
        );
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
            log.info('audio.queue_rejected', 'Queue is full.', { ...this.sessionFields(session), trackId: track.id });
            return { accepted: false, startsImmediately: false, position: MAX_QUEUE_SIZE };
        }

        this.autoplayCoordinator.cancelSelection(session.autoplay);
        const startsImmediately = queueWasEmpty && (!session.current || currentKind === 'elevator');

        this.clearInactivityTimer(session);
        const position = startsImmediately ? 0 : session.queue.size();
        log.info('audio.track_queued', 'Track added to queue.', { ...getLogContextFields(), ...this.sessionFields(session), trackId: track.id, title: track.title, requestedBy: track.requestedBy, position, startsImmediately });

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
        this.endReasons.set(session.current, 'skipped');
        const stopped = session.player.stop();
        if (!stopped && session.current) this.endReasons.delete(session.current);
        return stopped;
    }

    public disconnect(guildId: string, reason = 'requested'): boolean {
        const session = this.sessions.get(guildId);
        if (!session) return false;
        return this.closeSession(session, true, reason);
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
            log.error('audio.transition_failed', 'Audio state transition failed.', { ...this.sessionFields(session), error });
        });
        // Return the observed promise, so fire-and-forget callers cannot leak a rejection.
        return session.transition;
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
                if (recoveryKind === 'external-disconnect') {
                    await this.awaitRecoveryAttempt(
                        session,
                        controller.signal,
                        this.externalDisconnectGraceTimeoutMs
                    );
                } else {
                    const estimateMinutes = this.voiceRecoveryPolicy.estimatedDurationMinutes;
                    log.warn('voice.recovery_started', 'Transient voice outage; starting recovery.', { ...this.sessionFields(session), recoveryKind, maxAttempts: this.voiceRecoveryPolicy.maxAttempts, estimatedMinutes: estimateMinutes });
                    this.notify(
                        session,
                        `⚠️ **Voice connection interrupted**\n` +
                        `Discord may be having an outage. Retrying up to ` +
                        `${this.voiceRecoveryPolicy.maxAttempts} times over about ` +
                        `${estimateMinutes} minutes.`
                    );
                    await this.retryTransientRecovery(session, recovery, controller.signal);
                }
                this.syncSessionChannel(session);
                if (this.isRecoveryActive(session, recovery)) log.info('voice.recovery_succeeded', 'Voice connection recovered.', { ...this.sessionFields(session), recoveryKind });
            } catch (error) {
                if (
                    session.recovery !== recovery ||
                    this.sessions.get(session.guildId) !== session ||
                    session.closing
                ) return;

                if (recoveryKind === 'external-disconnect') {
                    log.info('voice.removed_externally', 'Voice connection removed externally; clearing session.', this.sessionFields(session));
                    this.notify(
                        session,
                        'ℹ️ **Disconnected from voice**\nThe audio session was cleared.'
                    );
                } else {
                    log.error('voice.recovery_failed', 'Voice recovery exhausted; clearing session.', { ...this.sessionFields(session), error });
                    this.notify(session, '⚠️ **Voice connection lost**\nThe audio session was cleared.');
                }
                this.closeSession(session, true, recoveryKind === 'external-disconnect' ? 'external_disconnect' : 'recovery_exhausted');
            } finally {
                if (session.recovery === recovery) session.recovery = undefined;
            }
        })();

        return recovery.promise;
    }

    private async retryTransientRecovery(
        session: GuildAudioSession,
        recovery: VoiceRecovery,
        signal: AbortSignal
    ): Promise<void> {
        await this.voiceRecoveryPolicy.recover(
            signal,
            async ({ attempt, maxAttempts, signal: attemptSignal }) => {
                if (!this.isRecoveryActive(session, recovery)) return;
                // A rejoin only sends a gateway payload. Recreate networking
                // on every attempt to open a fresh voice WebSocket.
                session.connection.configureNetworking();
                const state = session.connection.state;
                if (state.status !== VoiceConnectionStatus.Connecting) {
                    throw new Error('No voice server endpoint is available for recovery.');
                }
                const networking = state.networking;
                log.info('voice.recovery_attempt', 'Attempting voice recovery.', { ...this.sessionFields(session), attempt, maxAttempts });
                try {
                    await this.awaitReady(session, attemptSignal);
                } catch (error) {
                    const currentState = session.connection.state;
                    if (
                        this.isRecoveryActive(session, recovery) &&
                        currentState.status === VoiceConnectionStatus.Connecting &&
                        currentState.networking === networking
                    ) {
                        networking.destroy();
                    }
                    throw error;
                }
            },
            {
                onBackoff: (attempt, delayMs) => {
                    log.info('voice.recovery_backoff', 'Waiting before voice recovery attempt.', { ...this.sessionFields(session), attempt, delayMs });
                },
                onFailure: (attempt, error) => {
                    log.warn('voice.recovery_attempt_failed', 'Voice recovery attempt failed.', { ...this.sessionFields(session), attempt, maxAttempts: this.voiceRecoveryPolicy.maxAttempts, error });
                }
            }
        );
    }

    private async awaitRecoveryAttempt(
        session: GuildAudioSession,
        recoverySignal: AbortSignal,
        timeoutMs: number
    ): Promise<void> {
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort();
        recoverySignal.addEventListener('abort', abortAttempt, { once: true });

        const timeout = setTimeout(abortAttempt, timeoutMs);
        timeout.unref();

        try {
            await this.awaitReady(session, attemptController.signal);
        } finally {
            clearTimeout(timeout);
            recoverySignal.removeEventListener('abort', abortAttempt);
        }
    }

    private isRecoveryActive(session: GuildAudioSession, recovery: VoiceRecovery): boolean {
        return (
            session.recovery === recovery &&
            this.sessions.get(session.guildId) === session &&
            !session.closing
        );
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
            log.info('voice.websocket_closed', 'Voice WebSocket closed.', { ...this.sessionFields(session), closeCode: code, description });

            if (!TERMINAL_VOICE_CLOSE_CODES.has(code)) return;

            if (code === 4021) this.startRateLimitCooldown(session.guildId);

            const notification = code === 4021
                ? '⚠️ **Discord rate-limited voice**\nThe audio session was cleared.'
                : 'ℹ️ **Voice call ended**\nThe audio session was cleared.';
            this.notify(session, notification);
            this.closeSession(session, true, code === 4021 ? 'voice_rate_limited' : 'call_terminated');
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
        log.warn('voice.cooldown_started', 'Voice connection cooldown started.', { guildId, retryAfterMs: this.rateLimitCooldownMs });
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

    private closeSession(session: GuildAudioSession, destroyConnection: boolean, reason = 'closed'): boolean {
        if (session.closing) return false;

        session.closing = true;
        log.info('audio.session_closed', 'Audio session closed.', { ...this.sessionFields(session), reason });
        if (session.current) this.endReasons.set(session.current, reason);
        if (this.sessions.get(session.guildId) === session) {
            this.sessions.delete(session.guildId);
        }
        this.clearInactivityTimer(session);
        this.clearTrackWatchdog(session);
        this.cancelRecovery(session);
        this.autoplayCoordinator.dispose(session.autoplay);

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
        if (
            session.closing ||
            session.current ||
            session.connection.state.status !== VoiceConnectionStatus.Ready
        ) return;
        this.clearTrackWatchdog(session);

        while (!session.closing) {
            const queuedTrack = session.queue.popFront();
            if (!queuedTrack) {
                if (session.autoplay.enabled) {
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
                const resource = this.takePreload(session, track) ?? this.resources.createTrackResource(track, this.sessionFields(session));
                session.current = resource;
                log.info('audio.track_submitted', 'Track submitted to audio player.', { ...this.sessionFields(session), trackId: track.id, title: track.title, autoplay: track.autoplay ?? false });
                session.player.play(resource);
                this.autoplayCoordinator.recordStartedTrack(
                    session.guildId,
                    session.autoplay,
                    track,
                    () => !session.closing
                );
                this.startTrackWatchdog(session, resource);
                this.notify(session, {
                    embeds: [createNowPlayingEmbed(track, session.queue.size())]
                });
                this.reconcilePreload(session);
                return;
            } catch (error) {
                log.error('audio.track_submit_failed', 'Failed to submit track to audio player.', { ...this.sessionFields(session), trackId: track.id, title: track.title, error });
                if (session.current) this.endReasons.set(session.current, 'failed');
                this.releaseCurrent(session);
                this.notify(
                    session,
                    `⚠️ **Couldn’t play ${escapeMarkdown(track.title)}**\nSkipping to the next track.`
                );
            }
        }
    }

    private async startAutoplay(session: GuildAudioSession): Promise<boolean> {
        if (
            !session.autoplay.enabled ||
            !this.autoplayCoordinator.hasPlaybackHistory(session.autoplay) ||
            session.closing ||
            session.current
        ) return false;

        this.clearInactivityTimer(session);

        let resource: BeanAudioResource | undefined;
        try {
            const track = await this.autoplayCoordinator.selectNext(
                session.guildId,
                session.autoplay,
                () => !session.closing && !session.current && session.queue.size() === 0
            );
            if (!track) return false;

            resource = this.resources.createTrackResource(track, this.sessionFields(session));
            session.current = resource;
            log.info('audio.track_submitted', 'Autoplay track submitted to audio player.', { ...this.sessionFields(session), trackId: track.id, title: track.title, autoplay: true });
            session.player.play(resource);
            this.autoplayCoordinator.recordStartedTrack(
                session.guildId,
                session.autoplay,
                track,
                () => !session.closing
            );
            this.startTrackWatchdog(session, resource);
            this.notify(session, {
                embeds: [createNowPlayingEmbed(track, session.queue.size())]
            });
            return true;
        } catch (error) {
            if (resource && session.current === resource) {
                this.endReasons.set(resource, 'failed');
                this.releaseCurrent(session);
            }
            if (!session.closing) {
                log.error('audio.autoplay_start_failed', 'Failed to start autoplay.', { ...this.sessionFields(session), error });
            }
            return false;
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
            log.debug('audio.preload_started', 'Preloading next track.', { ...this.sessionFields(session), trackId: nextTrack.id });
            session.preload = this.resources.createTrackResource(nextTrack, { ...this.sessionFields(session), phase: 'preload' });
        } catch (error) {
            session.preload = undefined;
            log.error('audio.preload_failed', 'Failed to preload track.', { ...this.sessionFields(session), trackId: nextTrack.id, title: nextTrack.title, error });
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
            log.error('audio.elevator_failed', 'Failed to play elevator music.', { ...this.sessionFields(session), error });
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
            this.disconnect(session.guildId, 'inactivity');
        }, timeoutMs);
        session.inactivityTimer.unref();
    }

    private startTrackWatchdog(session: GuildAudioSession, resource: BeanAudioResource): void {
        if (resource.metadata.kind !== 'track') return;

        this.clearTrackWatchdog(session);

        let startedAt = Date.now();
        const maximumPlaybackMs = resource.metadata.duration === undefined
            ? undefined
            : Math.max(60_000, Math.ceil(resource.metadata.duration * 1_500) + 30_000);
        let playbackStartedAt: number | undefined;
        let lastPlaybackDuration = 0;
        let lastProgressAt = startedAt;
        let unavailableSince: number | undefined;

        const watchdog = setInterval(() => {
            if (session.closing || session.current !== resource) {
                this.clearTrackWatchdog(session, watchdog);
                return;
            }

            const now = Date.now();
            if (session.connection.state.status !== VoiceConnectionStatus.Ready) {
                unavailableSince ??= now;
                return;
            }
            if (unavailableSince !== undefined) {
                const unavailableMs = now - unavailableSince;
                startedAt += unavailableMs;
                if (playbackStartedAt !== undefined) playbackStartedAt += unavailableMs;
                lastProgressAt += unavailableMs;
                unavailableSince = undefined;
            }
            if (session.player.state.status !== AudioPlayerStatus.Playing) {
                if (!playbackStartedAt && now - startedAt >= this.trackStartupTimeoutMs) {
                    this.stopWatchedTrack(session, resource, 'Playback didn’t start in time');
                } else if (playbackStartedAt && now - lastProgressAt >= this.trackStallTimeoutMs) {
                    this.stopWatchedTrack(session, resource, 'Playback stalled');
                }
                return;
            }

            if (!playbackStartedAt) {
                playbackStartedAt = now;
                this.logPlaybackStarted(session, resource);
            }
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
        this.endReasons.set(resource, reason);
        log.warn('audio.watchdog_stopped', 'Watchdog stopped track.', { ...this.sessionFields(session), trackId: resource.metadata.id, title: resource.metadata.title, reason, playbackDurationMs: resource.playbackDuration });
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
        const resource = session.current;
        if (resource?.metadata.kind === 'track' && !this.endedResources.has(resource)) {
            this.endedResources.add(resource);
            log.info('audio.track_ended', 'Track ended.', {
                ...this.sessionFields(session), trackId: resource.metadata.id, title: resource.metadata.title,
                reason: getResourceFailure(resource) ? 'failed' : this.endReasons.get(resource) ?? 'finished',
                playbackDurationMs: resource.playbackDuration, started: this.startedResources.has(resource)
            });
        }
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
            log.error('audio.notification_failed', 'Failed to send audio notification.', { ...this.sessionFields(session), error });
        });
    }

    private sessionFields(session: GuildAudioSession): LogFields {
        return { guildId: session.guildId, voiceChannelId: session.channelId, queueSize: session.queue.size() };
    }

    private logPlaybackStarted(session: GuildAudioSession, resource: BeanAudioResource): void {
        if (resource.metadata.kind !== 'track' || this.startedResources.has(resource)) return;
        this.startedResources.add(resource);
        log.info('audio.track_started', 'Audio playback started.', { ...this.sessionFields(session), trackId: resource.metadata.id, title: resource.metadata.title, autoplay: resource.metadata.autoplay ?? false });
    }

}

export const guildAudioSessionManager = new GuildAudioSessionManager();
