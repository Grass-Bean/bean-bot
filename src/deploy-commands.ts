import { REST, Routes, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url'; // Import pathToFileURL
import 'dotenv/config'; 

export async function deployCommands(guildOnly : boolean) {
    const { CLIENT_ID, GUILD_ID, DISCORD_TOKEN } = process.env;

    if (!CLIENT_ID || !GUILD_ID || !DISCORD_TOKEN) {
        throw new Error('Missing environment variables');
    }

    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const foldersPath = path.join(__dirname, 'commands');
    const commandFolders = fs.readdirSync(foldersPath);

    for (const folder of commandFolders) {
        const commandsPath = path.join(foldersPath, folder);
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            
            const fileUrl = pathToFileURL(filePath).href;

            const commandModule = await import(fileUrl);

            const command = commandModule.default || commandModule;

            if ('data' in command && 'execute' in command) {
                commands.push(command.data.toJSON());
            } else {
                console.log(`[WARNING] The command at ${filePath} is missing "data" or "execute".`);
            }
        }
    }

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