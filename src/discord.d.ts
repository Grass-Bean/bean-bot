import { Collection } from 'discord.js';
import type { BotCommand } from './commandTypes.js';

declare module 'discord.js' {
    export interface Client {
        commands: Collection<string, BotCommand>;
    }
}
