import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { GuildVC } from '../../utility/guildvc.js';

export default {
    data: new SlashCommandBuilder()
        .setName('disconnect')
        .setDescription('Disconnects the bot from the voice channel'),
        
    async execute(interaction: ChatInputCommandInteraction) {
        // 1. Ensure this is happening inside a guild (server)
        if (!interaction.guild || !interaction.member) {
            await interaction.reply({ 
                content: 'This command can only be used in a server.', 
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // 2. disconnect
        try {
            if (GuildVC.disconnect(
                interaction.guild.id
            )) {
                await interaction.reply({ 
                    content: `Disconnected from the voice channel!`, 
                });
            }
        } catch (error) {
            console.error(error);
            await interaction.reply({ 
                content: 'Failed to disconnect from the voice channel.', 
                flags: MessageFlags.Ephemeral 
            });
        }
    }
}