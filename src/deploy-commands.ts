import { REST, Routes, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { loadCommands } from './commandLoader.js';
import type { BotCommand } from './commandTypes.js';
import { logger } from './utility/logger.js';

export async function deployCommands(
    guildOnly: boolean,
    loadedCommands?: readonly BotCommand[]
) {
    const { CLIENT_ID, GUILD_ID, DISCORD_TOKEN } = process.env;

    if (!CLIENT_ID || !GUILD_ID || !DISCORD_TOKEN) {
        throw new Error('Missing environment variables');
    }

    const commandsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'commands');
    const commandModules = loadedCommands ?? (await loadCommands(commandsDirectory))
        .map(({ command }) => command);
    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = commandModules
        .map(command => command.data.toJSON());

    const rest = new REST().setToken(DISCORD_TOKEN);
    
    const started = performance.now();
    const context = { component: 'deployment', count: commands.length, deploymentScope: guildOnly ? 'guild' : 'global' };
    try {
        logger.info('commands.deploy_started', 'Refreshing application commands.', context);
        await rest.put(
            guildOnly ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );  

        logger.info('commands.deploy_completed', 'Application commands refreshed.', { ...context, elapsedMs: Math.round(performance.now() - started) });
    } catch (error) {
        logger.error('commands.deploy_failed', 'Application command deployment failed; startup will continue.', { ...context, error, elapsedMs: Math.round(performance.now() - started) });
    }
}
