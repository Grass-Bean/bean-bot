import { logger } from './logger.js';

/** Error-response delivery must not replace the already reported operation failure. */
export async function sendCommandErrorResponse(operation: () => Promise<unknown>): Promise<void> {
    try {
        await operation();
    } catch (error) {
        logger.error('command.error_response_failed', 'Could not send the command error response.', { component: 'commands', error });
    }
}

interface InteractionContext {
    id?: string;
    commandName?: string;
    guildId?: string | null;
    channelId?: string | null;
    user: { id: string };
}

export async function observeDiscordTask(interaction: InteractionContext, event: string, operation: () => Promise<unknown>, ignoreMissingMessage = false): Promise<void> {
    const log = logger.child({
        component: 'pagination', interactionId: interaction.id, command: interaction.commandName,
        guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id
    }, { inheritContext: false });
    try {
        await operation();
    } catch (error) {
        if (ignoreMissingMessage && (error as { code?: number } | null)?.code === 10008) {
            log.debug('pagination.message_gone', 'Pagination message no longer exists.');
        } else {
            log.error(event, 'Discord pagination operation failed.', { error });
        }
    }
}
