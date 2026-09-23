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
            await this.respond(interaction, 'This command can only be used in a server.');
            return undefined;
        }

        let member: GuildMember;
        try {
            member = interaction.member instanceof GuildMember
                ? interaction.member
                : await interaction.guild.members.fetch(interaction.user.id);
        } catch (error) {
            console.error(`Failed to resolve member voice state in guild ${interaction.guild.id}:`, error);
            await this.respond(interaction, 'Could not determine your voice channel.');
            return undefined;
        }

        const voiceChannelId = member.voice.channelId;
        if (!voiceChannelId) {
            await this.respond(interaction, 'You need to be in a voice channel to use this command.');
            return undefined;
        }

        if (expectedChannelId && expectedChannelId !== voiceChannelId) {
            await this.respond(
                interaction,
                'Your voice channel changed while the command was running. Please try again.'
            );
            return undefined;
        }

        const activeChannelId = this.sessions.getActiveChannelId(interaction.guild.id);
        if (activeChannelId && activeChannelId !== voiceChannelId) {
            await this.respond(
                interaction,
                `The bot is already active in <#${activeChannelId}>. Join that voice channel to control it.`
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
                    `Discord temporarily rate-limited voice connections. Please try again in ${retryAfterSeconds} seconds.`
                );
                return undefined;
            }

            console.error(`Failed to connect to voice in guild ${interaction.guild.id}:`, error);
            await this.respond(interaction, 'Failed to connect to the voice channel.');
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
