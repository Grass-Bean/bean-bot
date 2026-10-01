import { Events, Client } from 'discord.js';
import { logger } from '../utility/logger.js';

export default {
    name: Events.ClientReady,
    once: true,
    execute(client: Client<true>) {
        logger.info('bot.ready', 'Bot is ready.', { botTag: client.user.tag, botId: client.user.id });
    },
};
