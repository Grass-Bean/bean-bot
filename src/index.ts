// --- GLOBAL ERROR HANDLERS ---
// This stops the "Silent Crash" where the container stays up but the bot dies.
process.on('unhandledRejection', (reason, promise) => {
    console.error('🛑 Unhandled Rejection:', reason);
    // Log the error but don't kill the process
});

process.on('uncaughtException', (err) => {
    console.error('🛑 Uncaught Exception:', err);
    // Optional: if (err.message.includes('lost connection')) return;
});
// -----------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import 'dotenv/config';
import { deployCommands } from './deploy-commands.js';
const { DISCORD_TOKEN, GUILD_ONLY } = process.env;
if (!DISCORD_TOKEN||!GUILD_ONLY) {
    throw new Error("Missing DISCORD_TOKEN or GUILD_ONLY in .env file");
}
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

client.commands = new Collection();

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

(async () => {
    // Load commands to memory
    for (const folder of commandFolders) {
        const commandsPath = path.join(foldersPath, folder);
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            
            const commandModule = await import(pathToFileURL(filePath).href); 
            const command = commandModule.default;

            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
                if (command.cooldown) {
                    rateLimiter.setLimit(command.data.name, command.cooldown);
                    console.log(`-> Registered rate limit for ${command.data.name}: ${command.cooldown}ms`);
                }
            } else {
                console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
            }
        }
    }

    // Deploy commands to Discord
    await deployCommands(GUILD_ONLY === 'true');

    const eventsPath = path.join(__dirname, 'events');
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

    // Load interaction event handler
    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        
        const eventModule = await import(pathToFileURL(filePath).href);
        const event = eventModule.default;

        if (event.once) {
            client.once(event.name, (...args) => event.execute(...args));
        } else {
            client.on(event.name, (...args) => event.execute(...args));
        }
    }

    // Login after loading everything
    client.login(DISCORD_TOKEN);
})();