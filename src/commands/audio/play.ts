import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { audioInteractionController } from '../../audio/AudioInteractionController.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';
import { TrackResolverError, trackResolver } from '../../audio/TrackResolver.js';
import { createQueuedTrackEmbed } from '../../audio/audioPresentation.js';
import { logger, addLogContextFields, registerSensitiveText, setCommandOutcome } from '../../utility/logger.js';
import { sendCommandErrorResponse } from '../../utility/discordTask.js';

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
        registerSensitiveText(query);

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        if (guildAudioSessionManager.isQueueFull(guildId)) {
            setCommandOutcome('rejected', 'queue_full');
            await interaction.editReply({
                content: '⚠️ **Queue is full**\nThere are already 50 tracks waiting.',
                allowedMentions: { parse: [] }
            });
            return;
        }

        try {
            const track = await trackResolver.resolve(query, interaction.user.id);
            addLogContextFields({ trackId: track.id });
            const conn = await audioInteractionController.connect(interaction, voiceChannelId);
            if (!conn) return;

            const result = guildAudioSessionManager.enqueue(
                guildId,
                track,
                interaction.channel as TextChannel | null
            );
            if (!result.accepted) {
                setCommandOutcome('rejected', 'queue_full');
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
            const expected = error instanceof TrackResolverError && ['INVALID_INPUT', 'UNSUPPORTED_URL', 'CANCELLED'].includes(error.code);
            setCommandOutcome(expected ? 'rejected' : 'failed', error instanceof TrackResolverError ? error.code : 'play_error');
            logger[expected ? 'info' : 'error']('command.play_failed', 'Could not add the requested track.', { component: 'resolver', error });

            const detail = error instanceof TrackResolverError
                ? getResolverErrorMessage(error)
                : 'Failed to find or play the requested media.';
            await sendCommandErrorResponse(() => interaction.editReply({
                content: `❌ **Couldn’t add that track**\n${detail}`,
                allowedMentions: { parse: [] }
            }));
        }
    }
}
