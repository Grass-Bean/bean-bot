import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BotCommand } from './commandTypes.js';

export interface LoadedCommand {
    command: BotCommand;
    filePath: string;
}

export const isBotCommand = (value: unknown): value is BotCommand => {
    if (!value || typeof value !== 'object') return false;

    const candidate = value as Partial<BotCommand>;
    return Boolean(
        candidate.data &&
        typeof candidate.data.name === 'string' &&
        typeof candidate.data.toJSON === 'function' &&
        typeof candidate.execute === 'function'
    );
};

export const findCommandFiles = (directory: string): string[] => {
    const files: string[] = [];

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...findCommandFiles(entryPath));
        } else if (
            entry.isFile() &&
            (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) &&
            !entry.name.endsWith('.d.ts')
        ) {
            files.push(entryPath);
        }
    }

    return files.sort();
};

export const loadCommands = async (directory: string): Promise<LoadedCommand[]> => {
    const commands: LoadedCommand[] = [];

    for (const filePath of findCommandFiles(directory)) {
        const commandModule = await import(pathToFileURL(filePath).href) as {
            default?: unknown;
        };
        const command = commandModule.default;

        if (!isBotCommand(command)) {
            console.warn(
                `[WARNING] The command at ${filePath} is missing valid data or an execute function.`
            );
            continue;
        }

        commands.push({ command, filePath });
    }

    return commands;
};
