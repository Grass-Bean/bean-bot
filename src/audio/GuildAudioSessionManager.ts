import {
    AudioPlayer,
    AudioPlayerStatus,
    createAudioPlayer,
    DiscordGatewayAdapterCreator,
    entersState,
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus
} from '@discordjs/voice';
import { ChatInputCommandInteraction, escapeMarkdown, GuildMember, MessageFlags, TextChannel } from 'discord.js';
import { Deque, MAX_QUEUE_SIZE } from './Deque.js';
import { audioResourceManager, AudioResourceManager } from './AudioResourceManager.js';
import {
    AudioMetadata,
    AudioQueueSnapshot,
    BeanAudioResource,
    EnqueueResult,
    TrackMetadata
} from './types.js';

interface GuildAudioSession {
    guildId: string;
    channelId: string;
    connection: VoiceConnection;
    player: AudioPlayer;
    queue: Deque<TrackMetadata>;
    current?: BeanAudioResource;
    preload?: BeanAudioResource;
    inactivityTimer?: NodeJS.Timeout;
    announcementChannel: TextChannel | null;
    transition: Promise<void>;
    recovery?: Promise<void>;
    closing: boolean;
}

export class GuildAudioSessionManager {
    private readonly sessions = new Map<string, GuildAudioSession>();

    public constructor(
        private readonly resources: AudioResourceManager = audioResourceManager,
        private readonly inactivityTimeoutMs = 5 * 60 * 1000,
        private readonly connectionReadyTimeoutMs = 15_000,
        private readonly connectionRecoveryTimeoutMs = 5_000
    ) {}

    public async connect(
        guildId: string,
        channelId: string,
        adapterCreator: DiscordGatewayAdapterCreator
    ): Promise<VoiceConnection> {
        const existing = this.sessions.get(guildId);
        if (existing && !existing.closing) {
            if (existing.channelId !== channelId) {
                throw new Error(`Audio is already active in voice channel ${existing.channelId}.`);
            }
            return this.awaitReady(existing);
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
            queue: new Deque<TrackMetadata>(),
            announcementChannel: null,
            transition: Promise.resolve(),
            closing: false
        };

        player.on(AudioPlayerStatus.Idle, () => {
            const endedResource = session.current;
            void this.schedule(session, async () => {
                if (session.current !== endedResource) return;
                if (endedResource) {
                    this.resources.release(endedResource);
                    session.current = undefined;
                }
                await this.startNext(session);
            });
        });

        player.on('error', (error) => {
            const metadata = error.resource.metadata as AudioMetadata | null;
            console.error(`Audio player error in guild ${guildId} (${metadata?.title ?? 'unknown resource'}):`, error);
            if (metadata?.kind === 'track') {
                this.notify(session, `⚠️ Could not play **${escapeMarkdown(metadata.title)}**. Skipping...`);
            }
        });

        connection.on('error', (error) => {
            console.error(`Voice connection error in guild ${guildId}:`, error);
        });
        connection.on(VoiceConnectionStatus.Disconnected, () => {
            void this.recoverConnection(session);
        });
        connection.on(VoiceConnectionStatus.Destroyed, () => {
            this.closeSession(session, false);
        });

        connection.subscribe(player);
        this.sessions.set(guildId, session);

        try {
            return await this.awaitReady(session);
        } catch (error) {
            this.closeSession(session, true);
            throw error;
        }
    }

    public async validateInteractionVoiceChannel(
        interaction: ChatInputCommandInteraction,
        expectedChannelId?: string
    ): Promise<string | undefined> {
        if (!interaction.guild || !interaction.member) {
            await this.respondToInteraction(interaction, 'This command can only be used in a server.');
            return undefined;
        }

        let member: GuildMember;
        try {
            member = interaction.member instanceof GuildMember
                ? interaction.member
                : await interaction.guild.members.fetch(interaction.user.id);
        } catch (error) {
            console.error(`Failed to resolve member voice state in guild ${interaction.guild.id}:`, error);
            await this.respondToInteraction(interaction, 'Could not determine your voice channel.');
            return undefined;
        }

        const voiceChannelId = member.voice.channelId;
        if (!voiceChannelId) {
            await this.respondToInteraction(interaction, 'You need to be in a voice channel to use this command.');
            return undefined;
        }

        if (expectedChannelId && expectedChannelId !== voiceChannelId) {
            await this.respondToInteraction(interaction, 'Your voice channel changed while the command was running. Please try again.');
            return undefined;
        }

        const existing = this.sessions.get(interaction.guild.id);
        if (existing && !existing.closing && existing.channelId !== voiceChannelId) {
            await this.respondToInteraction(
                interaction,
                `The bot is already active in <#${existing.channelId}>. Join that voice channel to control it.`
            );
            return undefined;
        }

        return voiceChannelId;
    }

    public async connectForInteraction(
        interaction: ChatInputCommandInteraction,
        expectedChannelId?: string
    ): Promise<VoiceConnection | undefined> {
        const voiceChannelId = await this.validateInteractionVoiceChannel(interaction, expectedChannelId);
        if (!voiceChannelId || !interaction.guild) return undefined;

        try {
            return await this.connect(
                interaction.guild.id,
                voiceChannelId,
                interaction.guild.voiceAdapterCreator
            );
        } catch (error) {
            console.error(`Failed to connect to voice in guild ${interaction.guild.id}:`, error);
            await this.respondToInteraction(interaction, 'Failed to connect to the voice channel.');
            return undefined;
        }
    }

    public async canControlFromInteraction(interaction: ChatInputCommandInteraction): Promise<boolean> {
        if (!interaction.guildId || !this.sessions.has(interaction.guildId)) return true;
        return (await this.validateInteractionVoiceChannel(interaction)) !== undefined;
    }

    public enqueue(guildId: string, track: TrackMetadata, channel: TextChannel | null): EnqueueResult {
        const session = this.requireSession(guildId);
        const queueWasEmpty = session.queue.size() === 0;
        const currentKind = session.current?.metadata.kind;
        if (!session.queue.pushBack(track)) {
            return { accepted: false, startsImmediately: false, position: MAX_QUEUE_SIZE };
        }

        const startsImmediately = queueWasEmpty && (!session.current || currentKind === 'elevator');

        session.announcementChannel = channel;
        this.clearInactivityTimer(session);
        const position = startsImmediately ? 0 : session.queue.size();

        if (currentKind === 'elevator') {
            const stopped = session.player.stop();
            if (!stopped) {
                void this.schedule(session, async () => {
                    if (session.current?.metadata.kind !== 'elevator') return;
                    this.resources.release(session.current);
                    session.current = undefined;
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
            pending: session.queue.toArray().map((track) => ({ ...track }))
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

    private async awaitReady(session: GuildAudioSession): Promise<VoiceConnection> {
        if (session.connection.state.status === VoiceConnectionStatus.Ready) {
            return session.connection;
        }

        return entersState(
            session.connection,
            VoiceConnectionStatus.Ready,
            this.connectionReadyTimeoutMs
        );
    }

    private async recoverConnection(session: GuildAudioSession): Promise<void> {
        if (session.closing || session.recovery) return session.recovery;

        session.recovery = (async () => {
            try {
                await Promise.race([
                    entersState(
                        session.connection,
                        VoiceConnectionStatus.Signalling,
                        this.connectionRecoveryTimeoutMs
                    ),
                    entersState(
                        session.connection,
                        VoiceConnectionStatus.Connecting,
                        this.connectionRecoveryTimeoutMs
                    )
                ]);
            } catch (error) {
                if (this.sessions.get(session.guildId) !== session || session.closing) return;
                console.error(`Voice connection recovery failed in guild ${session.guildId}:`, error);
                this.notify(session, '⚠️ Voice connection was lost. Disconnecting the audio session.');
                this.closeSession(session, true);
            } finally {
                session.recovery = undefined;
            }
        })();

        return session.recovery;
    }

    private closeSession(session: GuildAudioSession, destroyConnection: boolean): boolean {
        if (session.closing) return false;

        session.closing = true;
        if (this.sessions.get(session.guildId) === session) {
            this.sessions.delete(session.guildId);
        }
        this.clearInactivityTimer(session);

        session.player.removeAllListeners();
        session.player.stop(true);
        this.resources.release(session.current);
        this.resources.release(session.preload);
        session.current = undefined;
        session.preload = undefined;
        session.queue = new Deque<TrackMetadata>();

        if (destroyConnection && session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            session.connection.destroy();
        }
        return true;
    }

    private async startNext(session: GuildAudioSession): Promise<void> {
        if (session.closing || session.current) return;
        this.clearInactivityTimer(session);

        while (!session.closing) {
            const track = session.queue.popFront();
            if (!track) {
                this.startElevatorMusic(session);
                return;
            }

            try {
                const resource = this.takePreload(session, track) ?? this.resources.createTrackResource(track);
                session.current = resource;
                session.player.play(resource);
                this.notify(
                    session,
                    `🎶 **Now Playing:** ${escapeMarkdown(resource.metadata.title)}\n🔗 ${resource.metadata.kind === 'track' ? resource.metadata.url : ''}`
                );
                this.reconcilePreload(session);
                return;
            } catch (error) {
                console.error(`Failed to play ${track.title} in guild ${session.guildId}:`, error);
                this.resources.release(session.current);
                session.current = undefined;
                this.notify(session, `⚠️ Could not play **${escapeMarkdown(track.title)}**. Skipping...`);
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
        const nextTrack = session.queue.peekFront();
        const currentPreload = session.preload;

        if (!nextTrack) {
            this.resources.release(currentPreload);
            session.preload = undefined;
            return;
        }

        if (
            currentPreload?.metadata.kind === 'track' &&
            currentPreload.metadata.id === nextTrack.id &&
            !this.resources.isReleased(currentPreload)
        ) {
            return;
        }

        this.resources.release(currentPreload);
        try {
            session.preload = this.resources.createTrackResource(nextTrack);
        } catch (error) {
            session.preload = undefined;
            console.error(`Failed to preload ${nextTrack.title} in guild ${session.guildId}:`, error);
        }
    }

    private startElevatorMusic(session: GuildAudioSession): void {
        if (session.closing || session.current) return;

        this.resources.release(session.preload);
        session.preload = undefined;

        try {
            const elevatorResource = this.resources.createElevatorResource();
            session.current = elevatorResource;
            session.player.play(elevatorResource);
        } catch (error) {
            console.error(`Failed to play elevator music in guild ${session.guildId}:`, error);
        }

        if (!session.inactivityTimer) {
            this.notify(session, '**Queue finished.** Disconnecting in 5 minutes...');
            session.inactivityTimer = setTimeout(() => {
                session.inactivityTimer = undefined;
                if (this.sessions.get(session.guildId) !== session) return;
                this.notify(session, '**Disconnected due to 5 minutes of inactivity.**');
                this.disconnect(session.guildId);
            }, this.inactivityTimeoutMs);
        }
    }

    private clearInactivityTimer(session: GuildAudioSession): void {
        if (!session.inactivityTimer) return;
        clearTimeout(session.inactivityTimer);
        session.inactivityTimer = undefined;
    }

    private notify(session: GuildAudioSession, message: string): void {
        void session.announcementChannel?.send({
            content: message,
            allowedMentions: { parse: [] }
        }).catch((error) => {
            console.error(`Failed to send audio notification in guild ${session.guildId}:`, error);
        });
    }

    private async respondToInteraction(
        interaction: ChatInputCommandInteraction,
        content: string
    ): Promise<void> {
        const response = {
            content,
            allowedMentions: { parse: [] }
        };

        if (interaction.deferred) {
            await interaction.editReply(response);
        } else if (interaction.replied) {
            await interaction.followUp({ ...response, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
        }
    }
}

export const guildAudioSessionManager = new GuildAudioSessionManager();
