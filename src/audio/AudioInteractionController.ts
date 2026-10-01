import {
    ChatInputCommandInteraction,
    GuildMember,
    MessageFlags
} from 'discord.js';
import { VoiceConnection } from '@discordjs/voice';
import { logger, setCommandOutcome } from '../utility/logger.js';
import { sendCommandErrorResponse } from '../utility/discordTask.js';
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
            setCommandOutcome('failed', 'member_fetch_failed');
            logger.error('voice.member_fetch_failed', 'Failed to resolve member voice state.', { guildId: interaction.guild.id, error });
            await sendCommandErrorResponse(() => this.respond(
                interaction,
                '⚠️ **Couldn’t check your voice channel**\nPlease try again.'
            ));
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
                setCommandOutcome('rate-limited', 'voice_cooldown');
                logger.warn('voice.connect_rate_limited', 'Voice connection is on cooldown.', { guildId: interaction.guild.id, retryAfterMs: error.retryAfterMs });
                const retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
                await this.respond(
                    interaction,
                    `⚠️ **Voice is temporarily rate-limited**\nTry again in ${retryAfterSeconds} seconds.`
                );
                return undefined;
            }

            setCommandOutcome('failed', 'voice_connect_failed');
            logger.error('voice.connect_failed', 'Failed to connect to voice.', { guildId: interaction.guild.id, voiceChannelId, error });
            await sendCommandErrorResponse(() => this.respond(
                interaction,
                '❌ **Couldn’t join the voice channel**\nCheck my Connect and Speak permissions, then try again.'
            ));
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
        // Failed/rate-limited outcomes set by callers take precedence over validation rejection.
        setCommandOutcome('rejected', 'voice_requirement');
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
