import { Events, MessageFlags, Interaction, CacheType } from 'discord.js';
import { RateLimit } from '../utility/ratelimit.js';
import { logger, runWithLogContext, getCommandOutcome, setCommandOutcome } from '../utility/logger.js';
const rateLimiter = new RateLimit();
const log = logger.child({ component: 'commands' });

export default {
    name: Events.InteractionCreate,
    async execute(interaction: Interaction<CacheType>) {
        if (!interaction.isChatInputCommand()) return;

        return runWithLogContext({
            interactionId: interaction.id, command: interaction.commandName,
            guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id
        }, async () => {
            const started = performance.now();

            const client = interaction.client as any;
            const command = client.commands.get(interaction.commandName);

            log.debug('command.started', 'Command received.');
            try {
                if (!command) {
                    setCommandOutcome('failed', 'unknown_command');
                    log.error('command.missing', 'No registered command matched this interaction.');
                    return;
                }
                if (rateLimiter.isRateLimited(interaction.user.id, interaction.commandName)) {
                    const timeLeft = rateLimiter.getTimeLeft(interaction.user.id, interaction.commandName);
                    setCommandOutcome('rate-limited', 'cooldown');
                    log.debug('command.cooldown', 'Command is on cooldown.', { retryAfterMs: timeLeft });
                    await interaction.reply({
                        content: `Please wait ${timeLeft !== undefined ? (timeLeft/1000).toFixed(2) : 0} seconds before using this command again.`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                await command.execute(interaction);
            } catch (error) {
                setCommandOutcome('failed', 'execution_error');
                log.error('command.failed', 'Command execution failed.', { error });
                try {
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
                } catch (responseError) {
                    log.error('command.error_response_failed', 'Could not send the command error response.', { error: responseError });
                }
            } finally {
                log.info('command.completed', 'Command finished.', {
                    ...getCommandOutcome(), elapsedMs: Math.round(performance.now() - started)
                });
            }
        });
    },
};
