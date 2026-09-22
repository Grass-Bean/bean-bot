import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';
import { TrackResolverError, trackResolver } from '../../audio/TrackResolver.js';

const getResolverErrorMessage = (error: TrackResolverError): string => {
    switch (error.code) {
        case 'INVALID_INPUT':
        case 'UNSUPPORTED_URL':
            return error.message;
        case 'TIMEOUT':
            return 'The media lookup timed out. Please try again.';
        case 'CANCELLED':
            return 'The media lookup was cancelled.';
        default:
            return 'Failed to find or inspect the requested media.';
    }
};

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
            if (error instanceof TrackResolverError) {
                if (error.code !== 'INVALID_INPUT' && error.code !== 'UNSUPPORTED_URL') {
                    console.error(`[TrackResolver ${error.code}] ${error.message}`);
                }
            } else {
                console.error(error);
            }

            const message = error instanceof TrackResolverError
                ? getResolverErrorMessage(error)
                : 'Failed to find or play the requested media.';
            await interaction.editReply(message);
        }
    }
}
