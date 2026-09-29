import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findCommandFiles, isBotCommand, loadCommands } from '../src/commandLoader.js';

const fixtureDirectory = path.resolve('test/fixtures');

describe('commandLoader', () => {
    afterEach(() => vi.restoreAllMocks());

    it('recursively finds command modules in stable order', () => {
        expect(findCommandFiles(fixtureDirectory).map(file => path.basename(file))).toEqual([
            'help-command.js',
            'hidden-command.js'
        ]);
    });

    it('validates the command contract', () => {
        const valid = {
            data: { name: 'valid', toJSON: () => ({}) },
            execute: async () => undefined
        };

        expect(isBotCommand(valid)).toBe(true);
        expect(isBotCommand({ ...valid, execute: undefined })).toBe(false);
        expect(isBotCommand({ ...valid, data: { name: 'invalid' } })).toBe(false);
        expect(isBotCommand(null)).toBe(false);
    });

    it('loads valid commands and warns once for invalid modules', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const commands = await loadCommands(fixtureDirectory);

        expect(commands.map(({ command }) => command.data.name)).toEqual(['fixture']);
        expect(warning).toHaveBeenCalledOnce();
    });

    it('supports source and compiled modules while ignoring declarations', () => {
        vi.spyOn(fs, 'readdirSync').mockReturnValue([
            {
                name: 'README.md',
                isDirectory: () => false,
                isFile: () => true
            },
            {
                name: 'command.d.ts',
                isDirectory: () => false,
                isFile: () => true
            },
            {
                name: 'command.ts',
                isDirectory: () => false,
                isFile: () => true
            },
            {
                name: 'command.js',
                isDirectory: () => false,
                isFile: () => true
            }
        ] as any);

        expect(findCommandFiles(fixtureDirectory).map(file => path.basename(file))).toEqual([
            'command.js',
            'command.ts'
        ]);
    });
});
