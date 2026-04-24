import { 
    ChatInputCommandInteraction, 
    EmbedBuilder, 
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
    ComponentType
} from 'discord.js';
import { GuildVC } from '../../utility/guildvc.js';

export default {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Displays the current audio queue'),

    async execute(interaction: ChatInputCommandInteraction) {
        // 1. Defer reply
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply();

        const audioQueue = GuildVC.getAudioQueue(interaction.guildId!);
        
        // Retrieve items
        // @ts-ignore
        const allItems = audioQueue.toArray ? audioQueue.toArray() : Array.from(audioQueue);

        // --- Pagination Settings ---
        const itemsPerPage = 10;
        let currentPage = 0;
        const totalPages = Math.ceil(allItems.length / itemsPerPage) || 1;

        // --- Helper: Generate Embed ---
        const generateEmbed = (page: number) => {
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle("Current Audio Queue");

            if (allItems.length === 0) {
                embed.setDescription("The queue is currently empty.");
                embed.setFooter({ text: "Page 1 of 1" });
            } else {
                const start = page * itemsPerPage;
                const end = start + itemsPerPage;
                const pageItems = allItems.slice(start, end);

                const description = pageItems.map((item: any, i: number) => {
                    const duration = item.duration ? ` \`[${item.duration}]\`` : '';
                    const absoluteIndex = start + i + 1;
                    return `**${absoluteIndex}.** [${item.title}](${item.url})${duration} • <@${item.requestedBy || 'Unknown'}>`;
                }).join('\n');

                embed.setDescription(description);
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