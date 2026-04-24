import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags} from 'discord.js';
import { joinVoiceChannel } from '../../utility/joinvoice.js';

export default {
    data: new SlashCommandBuilder()
        .setName('connect')
        .setDescription('Connects the bot to your current voice channel'),
        
    async execute(interaction: ChatInputCommandInteraction) {
        const connection = await joinVoiceChannel(interaction);
        if (connection) {
            await interaction.reply({ 
                content: 'Connected to voice channel! 🔊', 
                flags: MessageFlags.Ephemeral 
            });
        }
    }
}