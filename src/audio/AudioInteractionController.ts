import {
    ChatInputCommandInteraction,
    GuildMember,
    MessageFlags
} from 'discord.js';
import { VoiceConnection } from '@discordjs/voice';
import {
    GuildAudioSessionManager,
    VoiceConnectionRateLimitError,
    guildAudioSessionManager
} from './GuildAudioSessionManager.js';

export class AudioInteractionController {
    public constructor(
        private readonly sessions: GuildAudioSessionManager = guildAudioSessionManager
    ) {}

    public async requireVoiceChannel(
        interaction: ChatInputCommandInteraction,
        expectedChannelId?: string
    ): Promise<string | undefined> {
        if (!interaction.guild || !interaction.member) {
            await this.respond(interaction, '❌ **Server only**\nUse this command in a server.');
            return undefined;
        }

        let member: GuildMember;
        try {
            member = interaction.member instanceof GuildMember
                ? interaction.member
                : await interaction.guild.members.fetch(interaction.user.id);
        } catch (error) {
            console.error(`Failed to resolve member voice state in guild ${interaction.guild.id}:`, error);
            await this.respond(
                interaction,
                '⚠️ **Couldn’t check your voice channel**\nPlease try again.'
            );
            return undefined;
        }

        const voiceChannelId = member.voice.channelId;
        if (!voiceChannelId) {
            await this.respond(
                interaction,
                '🔊 **Join a voice channel first**\nThen run the command again.'
            );
            return undefined;
        }

        if (expectedChannelId && expectedChannelId !== voiceChannelId) {
            await this.respond(
                interaction,
                '⚠️ **Voice channel changed**\nRun the command again from your current channel.'
            );
            return undefined;
        }

        const activeChannelId = this.sessions.getActiveChannelId(interaction.guild.id);
        if (activeChannelId && activeChannelId !== voiceChannelId) {
            await this.respond(
                interaction,
                `ℹ️ **I’m active in <#${activeChannelId}>**\nJoin that channel to control playback.`
            );
            return undefined;
        }

        return voiceChannelId;
    }

    public async connect(
        interaction: ChatInputCommandInteraction,
        expectedChannelId?: string
    ): Promise<VoiceConnection | undefined> {
        const voiceChannelId = await this.requireVoiceChannel(interaction, expectedChannelId);
        if (!voiceChannelId || !interaction.guild) return undefined;

        try {
            return await this.sessions.connect(
                interaction.guild.id,
                voiceChannelId,
                interaction.guild.voiceAdapterCreator
            );
        } catch (error) {
            if (error instanceof VoiceConnectionRateLimitError) {
                const retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
                await this.respond(
                    interaction,
                    `⚠️ **Voice is temporarily rate-limited**\nTry again in ${retryAfterSeconds} seconds.`
                );
                return undefined;
            }

            console.error(`Failed to connect to voice in guild ${interaction.guild.id}:`, error);
            await this.respond(
                interaction,
                '❌ **Couldn’t join the voice channel**\nCheck my Connect and Speak permissions, then try again.'
            );
            return undefined;
        }
    }

    public async ensureCanControl(interaction: ChatInputCommandInteraction): Promise<boolean> {
        if (!interaction.guildId || !this.sessions.getActiveChannelId(interaction.guildId)) return true;
        return (await this.requireVoiceChannel(interaction)) !== undefined;
    }

    private async respond(
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

export const audioInteractionController = new AudioInteractionController();
