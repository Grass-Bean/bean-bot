import { ChatInputCommandInteraction, GuildMember, MessageFlags } from 'discord.js';
import { 
    VoiceConnection, 
} from '@discordjs/voice';
import { GuildVC } from './guildvc.js';

export async function joinVoiceChannel(interaction: ChatInputCommandInteraction): Promise<VoiceConnection|void> {
        // 1. Ensure this is happening inside a guild (server)
        if (!interaction.guild || !interaction.member) {
            await interaction.reply({ 
                content: 'This command can only be used in a server.', 
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const member = interaction.member as GuildMember;
        const voiceChannel = member.voice.channel;

        // 3. Validate Voice Channel
        if (!voiceChannel) {
            await interaction.reply({ 
                content: 'You need to be in a voice channel to use this command.', 
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // 4. Connect
        try {
            return GuildVC.connect(
                interaction.guild.id, 
                voiceChannel.id, 
                interaction.guild.voiceAdapterCreator
            );
            
        } catch (error) {
            console.error(error);
            await interaction.reply({ 
                content: 'Failed to connect to the voice channel.', 
                flags: MessageFlags.Ephemeral
            });
        }
    }