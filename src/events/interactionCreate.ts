import { Events, MessageFlags, Interaction, CacheType } from 'discord.js';
import { RateLimit } from '../utility/ratelimit.js';
const rateLimiter = new RateLimit();

export default {
    name: Events.InteractionCreate,
    async execute(interaction: Interaction<CacheType>) {
        if (!interaction.isChatInputCommand()) return;

        const client = interaction.client as any;
        const command = client.commands.get(interaction.commandName);

        console.log(`Running ${interaction.commandName}`);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }

        try {
            if (rateLimiter.isRateLimited(interaction.user.id, interaction.commandName)) {
                const timeLeft = rateLimiter.getTimeLeft(interaction.user.id, interaction.commandName);
                await interaction.reply({ 
                    content: `Please wait ${timeLeft !== undefined ? (timeLeft/1000).toFixed(2) : 0} seconds before using this command again.`, 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ 
                    content: 'There was an error while executing this command!', 
                    flags: MessageFlags.Ephemeral 
                });
            } else {
                await interaction.reply({ 
                    content: 'There was an error while executing this command!', 
                    flags: MessageFlags.Ephemeral 
                });
            }
        }
    },
};