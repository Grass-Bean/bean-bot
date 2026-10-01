import { logger } from './utility/logger.js';
import { attachClientLogging, logUnhandledRejection, logUncaughtException } from './utility/runtimeLogging.js';

// Preserve the existing policy: report global failures and keep the process alive.
process.on('unhandledRejection', logUnhandledRejection);
process.on('uncaughtException', logUncaughtException);
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import 'dotenv/config';
import { loadCommands } from './commandLoader.js';
import { deployCommands } from './deploy-commands.js';
const { DISCORD_TOKEN, GUILD_ONLY } = process.env;
import { RateLimit } from './utility/ratelimit.js';
const rateLimiter = new RateLimit();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});
attachClientLogging(client);

client.commands = new Collection();

const foldersPath = path.join(__dirname, 'commands');
(async () => {
    const started = performance.now();
    logger.info('bot.starting', 'Bot startup started.', { nodeVersion: process.version });
    if (!DISCORD_TOKEN || !GUILD_ONLY) {
        throw new Error('Missing DISCORD_TOKEN or GUILD_ONLY in .env file');
    }
    const loadedCommands = await loadCommands(foldersPath);
    for (const { command } of loadedCommands) {
        client.commands.set(command.data.name, command);
        if (command.cooldown) {
            rateLimiter.setLimit(command.data.name, command.cooldown);
            logger.debug('cooldown.registered', 'Command cooldown registered.', { command: command.data.name, cooldownMs: command.cooldown });
        }
    }

    // Deploy commands to Discord
    await deployCommands(
        GUILD_ONLY === 'true',
        loadedCommands.map(({ command }) => command)
    );

    const eventsPath = path.join(__dirname, 'events');
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

    // Load interaction event handler
    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        
        const eventModule = await import(pathToFileURL(filePath).href);
        const event = eventModule.default;

        const execute = (...args: unknown[]) => {
            void Promise.resolve().then(() => event.execute(...args)).catch(error => {
                logger.error('discord.event_failed', 'Discord event handler failed.', { eventName: event.name, error });
            });
        };
        if (event.once) client.once(event.name, execute);
        else client.on(event.name, execute);
    }

    // Login after loading everything
    await client.login(DISCORD_TOKEN);
    logger.info('bot.login_completed', 'Discord login completed.', { elapsedMs: Math.round(performance.now() - started) });
})().catch(error => {
    logger.error('bot.startup_failed', 'Bot startup failed; process survival policy is unchanged.', { error });
});
