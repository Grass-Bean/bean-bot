import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';
import { trackResolver } from '../../audio/TrackResolver.js';

export default {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Plays audio from YouTube')
        .addStringOption(option => 
            option.setName('query')
                .setDescription('URL or song name')
                .setRequired(true)
        ),
        
    async execute(interaction: ChatInputCommandInteraction) {
        const guildId = interaction.guildId!;
        const conn = await guildAudioSessionManager.connectForInteraction(interaction);
        if (!conn) return;

        const query = interaction.options.getString('query', true);

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        try {
            const track = await trackResolver.resolve(query, interaction.user.id);
            const result = guildAudioSessionManager.enqueue(
                guildId,
                track,
                interaction.channel as TextChannel | null
            );

            if (result.startsImmediately) {
                await interaction.editReply(`✅ **Added to queue:** ${track.title}`);
            } else {
                await interaction.editReply(`✅ **Queued:** ${track.title} \n📊 Position: ${result.position}`);
            }

        } catch (error) {
            console.error(error);
            await interaction.editReply('Failed to find or play video!');
        }
    }
}
