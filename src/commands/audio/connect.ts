import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags} from 'discord.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';

export default {
    data: new SlashCommandBuilder()
        .setName('connect')
        .setDescription('Connects the bot to your current voice channel'),
        
    async execute(interaction: ChatInputCommandInteraction) {
        const connection = await guildAudioSessionManager.connectForInteraction(interaction);
        if (connection) {
            await interaction.reply({ 
                content: 'Connected to voice channel! 🔊', 
                flags: MessageFlags.Ephemeral 
            });
        }
    }
}
