import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { audioInteractionController } from '../../audio/AudioInteractionController.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';

export default {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skips the currently playing audio track'),
    async execute(interaction: ChatInputCommandInteraction) {
        if (!await audioInteractionController.ensureCanControl(interaction)) return;

        if (!guildAudioSessionManager.skip(interaction.guildId!)) {
            return interaction.reply({ 
                content: "No audio track is currently playing.",
                flags: MessageFlags.Ephemeral 
            });
        }
        await interaction.reply("Skipped the current track.");
    }
}
