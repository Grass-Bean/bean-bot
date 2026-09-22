import {
    AudioPlayer,
    AudioPlayerStatus,
    createAudioPlayer,
    DiscordGatewayAdapterCreator,
    joinVoiceChannel,
    VoiceConnection
} from '@discordjs/voice';
import { ChatInputCommandInteraction, GuildMember, MessageFlags, TextChannel } from 'discord.js';
import { Deque } from './Deque.js';
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
    connection: VoiceConnection;
    player: AudioPlayer;
    queue: Deque<TrackMetadata>;
    current?: BeanAudioResource;
    preload?: BeanAudioResource;
    inactivityTimer?: NodeJS.Timeout;
    announcementChannel: TextChannel | null;
    transition: Promise<void>;
    closing: boolean;
}

export class GuildAudioSessionManager {
    private readonly sessions = new Map<string, GuildAudioSession>();

    public constructor(
        private readonly resources: AudioResourceManager = audioResourceManager,
        private readonly inactivityTimeoutMs = 5 * 60 * 1000
    ) {}

    public connect(
        guildId: string,
        channelId: string,
        adapterCreator: DiscordGatewayAdapterCreator
    ): VoiceConnection {
        const existing = this.sessions.get(guildId);
        if (existing && !existing.closing) return existing.connection;

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
                    this.resources.dispose(endedResource);
                    session.current = undefined;
                }
                await this.startNext(session);
            });
        });

        player.on('error', (error) => {
            const metadata = error.resource.metadata as AudioMetadata | null;
            console.error(`Audio player error in guild ${guildId} (${metadata?.title ?? 'unknown resource'}):`, error);
            if (metadata?.kind === 'track') {
                this.notify(session, `⚠️ Could not play **${metadata.title}**. Skipping...`);
            }
        });

        connection.subscribe(player);
        this.sessions.set(guildId, session);
        return connection;
    }

    public async connectForInteraction(
        interaction: ChatInputCommandInteraction
    ): Promise<VoiceConnection | undefined> {
        if (!interaction.guild || !interaction.member) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral
            });
            return undefined;
        }

        const member = interaction.member as GuildMember;
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) {
            await interaction.reply({
                content: 'You need to be in a voice channel to use this command.',
                flags: MessageFlags.Ephemeral
            });
            return undefined;
        }

        try {
            return this.connect(
                interaction.guild.id,
                voiceChannel.id,
                interaction.guild.voiceAdapterCreator
            );
        } catch (error) {
            console.error(`Failed to connect to voice in guild ${interaction.guild.id}:`, error);
            await interaction.reply({
                content: 'Failed to connect to the voice channel.',
                flags: MessageFlags.Ephemeral
            });
            return undefined;
        }
    }

    public enqueue(guildId: string, track: TrackMetadata, channel: TextChannel | null): EnqueueResult {
        const session = this.requireSession(guildId);
        const queueWasEmpty = session.queue.size() === 0;
        const currentKind = session.current?.metadata.kind;
        const startsImmediately = queueWasEmpty && (!session.current || currentKind === 'elevator');

        session.announcementChannel = channel;
        this.clearInactivityTimer(session);
        session.queue.pushBack(track);
        const position = startsImmediately ? 0 : session.queue.size();

        if (currentKind === 'elevator') {
            const stopped = session.player.stop();
            if (!stopped) {
                void this.schedule(session, async () => {
                    if (session.current?.metadata.kind !== 'elevator') return;
                    this.resources.dispose(session.current);
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

        return { startsImmediately, position };
    }

    public skip(guildId: string): boolean {
        const session = this.sessions.get(guildId);
        if (!session || session.closing || session.current?.metadata.kind !== 'track') return false;
        return session.player.stop();
    }

    public disconnect(guildId: string): boolean {
        const session = this.sessions.get(guildId);
        if (!session) return false;

        session.closing = true;
        this.sessions.delete(guildId);
        this.clearInactivityTimer(session);

        session.player.removeAllListeners();
        session.player.stop(true);
        this.resources.dispose(session.current);
        this.resources.dispose(session.preload);
        session.current = undefined;
        session.preload = undefined;
        session.queue = new Deque<TrackMetadata>();
        session.connection.destroy();
        return true;
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
                this.notify(session, `🎶 **Now Playing:** ${resource.metadata.title}\n🔗 ${resource.metadata.kind === 'track' ? resource.metadata.url : ''}`);
                this.reconcilePreload(session);
                return;
            } catch (error) {
                console.error(`Failed to play ${track.title} in guild ${session.guildId}:`, error);
                this.resources.dispose(session.current);
                session.current = undefined;
                this.notify(session, `⚠️ Could not play **${track.title}**. Skipping...`);
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
            !this.resources.isDisposed(preload)
        ) {
            return preload;
        }

        this.resources.dispose(preload);
        return undefined;
    }

    private reconcilePreload(session: GuildAudioSession): void {
        const nextTrack = session.queue.peekFront();
        const currentPreload = session.preload;

        if (!nextTrack) {
            this.resources.dispose(currentPreload);
            session.preload = undefined;
            return;
        }

        if (
            currentPreload?.metadata.kind === 'track' &&
            currentPreload.metadata.id === nextTrack.id &&
            !this.resources.isDisposed(currentPreload)
        ) {
            return;
        }

        this.resources.dispose(currentPreload);
        try {
            session.preload = this.resources.createTrackResource(nextTrack);
        } catch (error) {
            session.preload = undefined;
            console.error(`Failed to preload ${nextTrack.title} in guild ${session.guildId}:`, error);
        }
    }

    private startElevatorMusic(session: GuildAudioSession): void {
        if (session.closing || session.current) return;

        this.resources.dispose(session.preload);
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
        void session.announcementChannel?.send(message).catch((error) => {
            console.error(`Failed to send audio notification in guild ${session.guildId}:`, error);
        });
    }
}

export const guildAudioSessionManager = new GuildAudioSessionManager();
