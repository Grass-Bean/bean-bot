import { 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    MessageFlags, 
    ChatInputCommandInteraction, 
    ButtonInteraction,
    ComponentType,
} from 'discord.js';

interface CommandInfo {
    name: string;
    description: string;
}

export default {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('List all available commands with descriptions'),
    
    async execute(interaction: ChatInputCommandInteraction) {
        // Defer the reply first
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const commands: CommandInfo[] = [...interaction.client.commands.values()]
            .filter(command => command.data.name !== 'help' && !command.hidden)
            .map(command => ({
                name: `/${command.data.name}`,
                description: command.data.description || 'No description available'
            }))
            .sort((left, right) => left.name.localeCompare(right.name));

        // Pagination setup
        const itemsPerPage = 5;
        let currentPage = 0;
        const totalPages = Math.ceil(commands.length / itemsPerPage);

        // Create embed function
        const createEmbed = (page: number) => {
            const start = page * itemsPerPage;
            const end = start + itemsPerPage;
            const currentCommands = commands.slice(start, end);

            const commandList = currentCommands.map(cmd => 
                `**${cmd.name}**\n${cmd.description}\n`
            ).join('\n');

            return new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('Command Help Menu')
                .setDescription(commandList.length > 0 ? `**Page ${page + 1}/${totalPages}**\n\n${commandList}` : 'No commands found.')
                .setFooter({ text: `${commands.length} total commands available` })
                .setTimestamp();
        };

        // Create buttons
        const getButtons = (page: number) => {
            return new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId('previous')
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1 || totalPages === 0)
            );
        };

        // Send initial response
        const message = await interaction.editReply({
            embeds: [createEmbed(currentPage)],
            components: [getButtons(currentPage)]
        });

        // Only create collector if multiple pages exist
        if (totalPages > 1) {
            const collector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000
            });

            collector.on('collect', async (i: ButtonInteraction) => {
                if (i.user.id !== interaction.user.id) {
                    await i.reply({ content: 'These buttons are not for you!', flags: MessageFlags.Ephemeral });
                    return;
                }

                currentPage = i.customId === 'next' ? currentPage + 1 : currentPage - 1;

                await i.update({
                    embeds: [createEmbed(currentPage)],
                    components: [getButtons(currentPage)]
                });
            });

            collector.on('end', () => {
                interaction.editReply({
                    components: []
                }).catch((error) => {
                    // Ignore "Unknown Message" errors (if ephemeral message was dismissed)
                    if (error.code !== 10008) {
                        console.error('Failed to remove buttons:', error);
                    }
                });
            });
        }
    }
};
