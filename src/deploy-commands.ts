import { REST, Routes, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { loadCommands } from './commandLoader.js';
import type { BotCommand } from './commandTypes.js';

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
    
    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);
        await rest.put(
            guildOnly ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );  

        console.log(`Successfully reloaded ${commands.length} application (/) commands.`);
    } catch (error) {
        console.error(error);
    }
}
