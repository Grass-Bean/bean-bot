import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags} from 'discord.js';
import { audioInteractionController } from '../../audio/AudioInteractionController.js';

export default {
    data: new SlashCommandBuilder()
        .setName('connect')
        .setDescription('Connects the bot to your current voice channel'),
        
    async execute(interaction: ChatInputCommandInteraction) {
        const voiceChannelId = await audioInteractionController.requireVoiceChannel(interaction);
        if (!voiceChannelId) return;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const connection = await audioInteractionController.connect(interaction, voiceChannelId);
        if (connection) {
            await interaction.editReply({
                content: `🔊 Connected to <#${voiceChannelId}>.`,
                allowedMentions: { parse: [] }
            });
        }
    }
}
