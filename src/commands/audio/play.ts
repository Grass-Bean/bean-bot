import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { audioInteractionController } from '../../audio/AudioInteractionController.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';
import { TrackResolverError, trackResolver } from '../../audio/TrackResolver.js';
import { createQueuedTrackEmbed } from '../../audio/audioPresentation.js';

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
            return 'Try another song name or paste a supported media link.';
    }
};

export default {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Plays audio from YouTube or Instagram')
        .addStringOption(option => 
            option.setName('query')
                .setDescription('URL or song name')
                .setRequired(true)
        ),
        
    async execute(interaction: ChatInputCommandInteraction) {
        const guildId = interaction.guildId!;
        const voiceChannelId = await audioInteractionController.requireVoiceChannel(interaction);
        if (!voiceChannelId) return;

        const query = interaction.options.getString('query', true);

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        if (guildAudioSessionManager.isQueueFull(guildId)) {
            await interaction.editReply({
                content: '⚠️ **Queue is full**\nThere are already 50 tracks waiting.',
                allowedMentions: { parse: [] }
            });
            return;
        }

        try {
            const track = await trackResolver.resolve(query, interaction.user.id);
            const conn = await audioInteractionController.connect(interaction, voiceChannelId);
            if (!conn) return;

            const result = guildAudioSessionManager.enqueue(
                guildId,
                track,
                interaction.channel as TextChannel | null
            );
            if (!result.accepted) {
                await interaction.editReply({
                    content: '⚠️ **Queue is full**\nThere are already 50 tracks waiting.',
                    allowedMentions: { parse: [] }
                });
                return;
            }

            await interaction.editReply({
                embeds: [createQueuedTrackEmbed(track, result.startsImmediately, result.position)],
                allowedMentions: { parse: [] }
            });

        } catch (error) {
            if (error instanceof TrackResolverError) {
                if (error.code !== 'INVALID_INPUT' && error.code !== 'UNSUPPORTED_URL') {
                    console.error(`[TrackResolver ${error.code}] ${error.message}`);
                }
            } else {
                console.error(error);
            }

            const detail = error instanceof TrackResolverError
                ? getResolverErrorMessage(error)
                : 'Failed to find or play the requested media.';
            await interaction.editReply({
                content: `❌ **Couldn’t add that track**\n${detail}`,
                allowedMentions: { parse: [] }
            });
        }
    }
}
