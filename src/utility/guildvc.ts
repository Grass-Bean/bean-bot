import { 
    VoiceConnection, 
    joinVoiceChannel, 
    DiscordGatewayAdapterCreator, 
    AudioPlayer,
    createAudioPlayer,
    AudioResource
} from '@discordjs/voice';
import { Deque } from './dequeue.js';

export interface AudioData {
    title: string;
    url: string;
    duration: string;
    thumbnail: string;
    requestedBy?: string;
}

export class GuildVC {
    private static voiceConnections: Map<string, VoiceConnection> = new Map();
    private static audioPlayers: Map<string, AudioPlayer> = new Map();
    private static audioQueues: Map<string, Deque<AudioData>> = new Map();
    
    // --- MIGRATED STATE ---
    private static preloadedResources: Map<string, Promise<AudioResource>> = new Map();
    private static inactivityTimers: Map<string, NodeJS.Timeout> = new Map();
    private static elevatorStatus: Map<string, boolean> = new Map();

    public static connect(
        guildId: string, 
        channelId: string, 
        adapterCreator: DiscordGatewayAdapterCreator
    ): VoiceConnection {
        try {
            if (GuildVC.voiceConnections.has(guildId)) {
                return GuildVC.voiceConnections.get(guildId)!;
            }
            const connection = joinVoiceChannel({
                channelId: channelId,
                guildId: guildId,
                adapterCreator: adapterCreator,
                selfDeaf: true,
                selfMute: false
            });

            GuildVC.voiceConnections.set(guildId, connection);
            return connection;
        } catch (error) {
            console.error(`Error connecting to voice channel in guild ${guildId}:`, error);
            throw error;
        }
    }

    public static getConnection(guildId: string): VoiceConnection | undefined {
        return GuildVC.voiceConnections.get(guildId);
    }

    public static disconnect(guildId: string): boolean {
        let connDestroyed: boolean = false;
        const player = GuildVC.audioPlayers.get(guildId);
        if (player) {
            player.stop();
        }
        const conn = GuildVC.voiceConnections.get(guildId);
        if (conn) {
            conn.destroy();
            connDestroyed = true;
        }
        GuildVC.freeGuildResources(guildId);
        return connDestroyed;
    }

    public static freeGuildResources(guildId: string): void {
        GuildVC.clearInactivityTimer(guildId);
        GuildVC.clearPreload(guildId);
        GuildVC.audioPlayers.delete(guildId);
        GuildVC.audioQueues.delete(guildId);
        GuildVC.voiceConnections.delete(guildId);
        GuildVC.elevatorStatus.delete(guildId);
    }

    public static getAudioPlayer(guildId: string): AudioPlayer {
        let player = GuildVC.audioPlayers.get(guildId)
        if (!player) {
            player = createAudioPlayer();
            GuildVC.audioPlayers.set(guildId, player);
        }
        return player;
    }

    public static getAudioQueue(guildId: string): Deque<AudioData> {
        let queue = GuildVC.audioQueues.get(guildId);
        if (!queue) {
            queue = new Deque<AudioData>();
            GuildVC.audioQueues.set(guildId, queue);
        }
        return queue;
    }

    // --- MIGRATED PRELOAD LOGIC ---
    public static setPreload(guildId: string, resourcePromise: Promise<AudioResource>) {
        GuildVC.preloadedResources.set(guildId, resourcePromise);
    }

    public static getPreload(guildId: string): Promise<AudioResource> | undefined {
        return GuildVC.preloadedResources.get(guildId);
    }

    public static clearPreload(guildId: string) {
        GuildVC.preloadedResources.delete(guildId);
    }

    // --- MIGRATED TIMER LOGIC ---
    public static startInactivityTimer(guildId: string, timeoutMs: number, onTimeout: () => void) {
        GuildVC.clearInactivityTimer(guildId);
        const timer = setTimeout(() => {
            onTimeout();
            GuildVC.inactivityTimers.delete(guildId);
        }, timeoutMs);
        GuildVC.inactivityTimers.set(guildId, timer);
    }

    public static clearInactivityTimer(guildId: string) {
        if (GuildVC.inactivityTimers.has(guildId)) {
            clearTimeout(GuildVC.inactivityTimers.get(guildId));
            GuildVC.inactivityTimers.delete(guildId);
            console.log(`⏱️ Timer cleared for guild ${guildId}`);
        }
    }

    public static hasInactivityTimer(guildId: string): boolean {
        return GuildVC.inactivityTimers.has(guildId);
    }

    public static setElevatorStatus(guildId: string, status: boolean) {
        GuildVC.elevatorStatus.set(guildId, status);
    }

    public static isElevatorPlaying(guildId: string): boolean {
        return GuildVC.elevatorStatus.get(guildId) ?? false;
    }
}