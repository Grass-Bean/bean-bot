import { 
    ChatInputCommandInteraction, 
    EmbedBuilder, 
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
    ComponentType,
    escapeMarkdown
} from 'discord.js';
import { guildAudioSessionManager } from '../../audio/GuildAudioSessionManager.js';
import type { TrackMetadata } from '../../audio/types.js';

const formatDuration = (durationSeconds: number | undefined): string => {
    if (durationSeconds === undefined) return '';

    const totalSeconds = Math.floor(durationSeconds);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    const formatted = hours > 0
        ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
        : `${minutes}:${seconds.toString().padStart(2, '0')}`;

    return ` \`[${formatted}]\``;
};

export default {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Displays the current audio queue'),

    async execute(interaction: ChatInputCommandInteraction) {
        // 1. Defer reply
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply();

        const snapshot = guildAudioSessionManager.getSnapshot(interaction.guildId!);
        const currentTrack = snapshot.current?.kind === 'track' ? snapshot.current : undefined;
        const allItems = currentTrack ? [currentTrack, ...snapshot.pending] : [...snapshot.pending];

        const maxItemsPerPage = 10;
        const maxDescriptionLength = 3_900;
        const lines = allItems.map((item: TrackMetadata, index: number) => {
            const duration = formatDuration(item.duration);
            const status = currentTrack?.id === item.id ? ' **(Now Playing)**' : '';
            const safeTitle = escapeMarkdown(item.title);
            const safeUrl = item.url.replace(/\\/g, '%5C').replace(/\(/g, '%28').replace(/\)/g, '%29');
            return `**${index + 1}.** [${safeTitle}](${safeUrl})${duration} • <@${item.requestedBy}>${status}`;
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
                .setColor(0x00ff00)
                .setTitle("Current Audio Queue");

            if (allItems.length === 0) {
                embed.setDescription("The queue is currently empty.");
                embed.setFooter({ text: "Page 1 of 1" });
            } else {
                embed.setDescription(pages[page].join('\n'));
                embed.setFooter({ text: `Page ${page + 1} of ${totalPages} • Total tracks: ${allItems.length}` });
                embed.setTimestamp();
            }

            return embed;
        };

        // --- Helper: Generate Buttons ---
        const generateButtons = (page: number) => {
            const row = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev')
                        .setLabel('◀ Previous')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0), // Disable if on first page
                    new ButtonBuilder()
                        .setCustomId('next')
                        .setLabel('Next ▶')
                        .setStyle(ButtonStyle.Primary)
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
