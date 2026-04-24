import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { GuildVC } from '../../utility/guildvc.js';

export default {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skips the currently playing audio track'),
    async execute(interaction: ChatInputCommandInteraction) {
        const player = GuildVC.getAudioPlayer(interaction.guildId!);
        if (!player) {
            return interaction.reply({ content: "No audio player found for this guild.", ephemeral: true });
        }
        player.stop();
        await interaction.reply("Skipped the current track.");
    }
}