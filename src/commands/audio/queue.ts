import { 
    ChatInputCommandInteraction, 
    EmbedBuilder, 
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
    ComponentType,
} from 'discord.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';
import type { TrackMetadata } from '../../audio/types.js';
import {
    AUDIO_COLORS,
    formatDuration,
    linkedTrackTitle
} from '../../audio/audioPresentation.js';

export default {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Displays the current audio queue'),

    async execute(interaction: ChatInputCommandInteraction) {
        // 1. Defer reply
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply();

        const snapshot = guildAudioSessionManager.getSnapshot(interaction.guildId!);
        const currentTrack = snapshot.current?.kind === 'track' ? snapshot.current : undefined;
        const pendingTracks = [...snapshot.pending];

        const maxItemsPerPage = 10;
        const maxDescriptionLength = currentTrack ? 3_100 : 3_700;
        const lines = pendingTracks.map((item: TrackMetadata, index: number) => {
            const duration = formatDuration(item.duration);
            const metadata = [duration ? `\`${duration}\`` : undefined, `<@${item.requestedBy}>`]
                .filter(Boolean)
                .join(' · ');
            return `\`${index + 1}\` ${linkedTrackTitle(item)}\n　 ${metadata}`;
        });
        const pages: string[][] = [[]];

        for (const line of lines) {
            const currentPageLines = pages.at(-1)!;
            const projectedLength = currentPageLines.join('\n').length + (currentPageLines.length ? 1 : 0) + line.length;
            if (currentPageLines.length >= maxItemsPerPage || projectedLength > maxDescriptionLength) {
                pages.push([line]);
            } else {
                currentPageLines.push(line);
            }
        }

        let currentPage = 0;
        const totalPages = pages.length;

        // --- Helper: Generate Embed ---
        const generateEmbed = (page: number) => {
            const embed = new EmbedBuilder()
                .setColor(currentTrack || pendingTracks.length ? AUDIO_COLORS.info : AUDIO_COLORS.neutral)
                .setTitle('Audio queue');

            if (!currentTrack && pendingTracks.length === 0) {
                embed.setDescription('Nothing is playing or queued.\nAdd something with `/play`.');
            } else {
                const sections: string[] = [];
                if (currentTrack) {
                    const duration = formatDuration(currentTrack.duration);
                    const details = [duration ? `\`${duration}\`` : undefined, `Requested by <@${currentTrack.requestedBy}>`]
                        .filter(Boolean)
                        .join(' · ');
                    sections.push(`**Now playing**\n▶ ${linkedTrackTitle(currentTrack)}\n${details}`);
                    if (currentTrack.thumbnail) embed.setThumbnail(currentTrack.thumbnail);
                }

                const upcoming = pages[page].length
                    ? pages[page].join('\n')
                    : '*Nothing else queued.*';
                sections.push(`**Up next**\n${upcoming}`);
                embed.setDescription(sections.join('\n\n'));

                const waiting = pendingTracks.length === 1
                    ? '1 track waiting'
                    : `${pendingTracks.length} tracks waiting`;
                const pageLabel = totalPages > 1 ? ` · Page ${page + 1} of ${totalPages}` : '';
                embed.setFooter({ text: `${waiting}${pageLabel}` });
            }

            return embed;
        };

        // --- Helper: Generate Buttons ---
        const generateButtons = (page: number) => {
            const row = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev')
                        .setLabel('← Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page === 0), // Disable if on first page
                    new ButtonBuilder()
                        .setCustomId('next')
                        .setLabel('Next →')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page >= totalPages - 1) // Disable if on last page
                );
            
            // If there's only 1 page (or 0 items), disable both or don't show row? 
            // Usually cleaner to show disabled buttons or no buttons. 
            // We'll return the row, but if totalPages <= 1, both will be disabled effectively.
            return row;
        };

        // 2. Initial Render
        // Only attach components if there is more than 1 page
        const components = totalPages > 1 ? [generateButtons(currentPage)] : [];

        const message = await interaction.editReply({ 
            embeds: [generateEmbed(currentPage)],
            components: components
        });

        // 3. Collector (Only if pagination is needed)
        if (totalPages > 1) {
            const collector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000 // 1 minute timeout
            });

            collector.on('collect', async (i: ButtonInteraction) => {
                // Ensure only the original requester can change pages (optional, but good practice)
                /* if (i.user.id !== interaction.user.id) {
                    await i.reply({ content: "You didn't run this command.", ephemeral: true });
                    return;
                }
                */

                if (i.customId === 'prev') {
                    currentPage = Math.max(0, currentPage - 1);
                } else if (i.customId === 'next') {
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                }

                await i.update({
                    embeds: [generateEmbed(currentPage)],
                    components: [generateButtons(currentPage)]
                });
            });

            collector.on('end', () => {
                // Remove buttons when timeout is reached
                interaction.editReply({ components: [] }).catch(() => {});
            });
        }
    }
};
