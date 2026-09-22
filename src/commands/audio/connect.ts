import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags} from 'discord.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';

export default {
    data: new SlashCommandBuilder()
        .setName('connect')
        .setDescription('Connects the bot to your current voice channel'),
        
    async execute(interaction: ChatInputCommandInteraction) {
        const voiceChannelId = await guildAudioSessionManager.validateInteractionVoiceChannel(interaction);
        if (!voiceChannelId) return;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const connection = await guildAudioSessionManager.connectForInteraction(interaction, voiceChannelId);
        if (connection) {
            await interaction.editReply({
                content: 'Connected to voice channel! 🔊',
                allowedMentions: { parse: [] }
            });
        }
    }
}
