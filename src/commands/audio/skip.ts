import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    escapeMarkdown
} from 'discord.js';
import { audioInteractionController } from '../../audio/AudioInteractionController.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';

export default {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skips the currently playing audio track'),
    async execute(interaction: ChatInputCommandInteraction) {
        if (!await audioInteractionController.ensureCanControl(interaction)) return;

        const current = guildAudioSessionManager.getSnapshot(interaction.guildId!).current;
        if (!guildAudioSessionManager.skip(interaction.guildId!)) {
            return interaction.reply({ 
                content: 'ℹ️ **Nothing is playing**\nAdd something with `/play`.',
                flags: MessageFlags.Ephemeral 
            });
        }
        const title = current?.kind === 'track' ? ` **${escapeMarkdown(current.title)}**` : '';
        await interaction.reply(`⏭️ Skipped${title}.`);
    }
}
