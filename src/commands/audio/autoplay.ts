import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { audioInteractionController } from '../../audio/AudioInteractionController.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';

export default {
    data: new SlashCommandBuilder()
        .setName('autoplay')
        .setDescription('Turns related-track autoplay on or off for this audio session')
        .addBooleanOption(option =>
            option.setName('enabled')
                .setDescription('Leave blank to toggle the current setting')
                .setRequired(false)
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        const voiceChannelId = await audioInteractionController.requireVoiceChannel(interaction);
        if (!voiceChannelId || !interaction.guildId) return;

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }

        const connection = await audioInteractionController.connect(interaction, voiceChannelId);
        if (!connection) return;

        const requested = interaction.options.getBoolean('enabled');
        const enabled = requested ?? !guildAudioSessionManager.isAutoplayEnabled(interaction.guildId);
        if (!guildAudioSessionManager.setAutoplay(interaction.guildId, enabled)) {
            await interaction.editReply({
                content: '❌ **Couldn’t update autoplay**\nThe audio session is no longer active.',
                allowedMentions: { parse: [] }
            });
            return;
        }

        await interaction.editReply({
            content: enabled
                ? '♾️ **Autoplay on**\nRelated tracks will play when the queue is empty.'
                : '⏹️ **Autoplay off**\nElevator music will return after the current track.',
            allowedMentions: { parse: [] }
        });
    }
};
