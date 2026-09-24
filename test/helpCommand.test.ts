import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import helpCommand from '../src/commands/utility/help.js';

const fixtureDirectory = path.resolve('test/fixtures');
const dirent = (name: string) => ({ name, parentPath: fixtureDirectory });

const interaction = () => ({
    user: { id: 'owner' },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({})
}) as any;

describe('/help', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the no-command state without a collector', async () => {
        vi.spyOn(fs, 'readdirSync').mockReturnValue([] as any);
        const commandInteraction = interaction();
        await helpCommand.execute(commandInteraction);

        expect(commandInteraction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
        const payload = commandInteraction.editReply.mock.calls[0][0];
        expect(payload.embeds[0].toJSON().description).toBe('No commands found.');
        expect(payload.components[0].toJSON().components.every((button: any) => button.disabled)).toBe(true);
    });

    it('loads visible commands, paginates, checks ownership, and clears controls', async () => {
        vi.spyOn(fs, 'readdirSync').mockReturnValue([
            ...Array.from({ length: 6 }, () => dirent('help-command.js')),
            dirent('hidden-command.js'),
            dirent('help.js'),
            dirent('not-a-command.txt')
        ] as any);
        const collector = new EventEmitter();
        const commandInteraction = interaction();
        commandInteraction.editReply.mockResolvedValue({
            createMessageComponentCollector: vi.fn().mockReturnValue(collector)
        });

        await helpCommand.execute(commandInteraction);
        const first = commandInteraction.editReply.mock.calls[0][0].embeds[0].toJSON();
        expect(first.description).toContain('Page 1/2');
        expect(first.footer.text).toBe('6 total commands available');

        const stranger = {
            user: { id: 'stranger' }, customId: 'next',
            reply: vi.fn().mockResolvedValue(undefined), update: vi.fn()
        };
        collector.emit('collect', stranger);
        await vi.waitFor(() => expect(stranger.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'These buttons are not for you!'
        })));
        expect(stranger.update).not.toHaveBeenCalled();

        const owner = {
            user: { id: 'owner' }, customId: 'next',
            reply: vi.fn(), update: vi.fn().mockResolvedValue(undefined)
        };
        collector.emit('collect', owner);
        await vi.waitFor(() => expect(owner.update).toHaveBeenCalled());
        expect(owner.update.mock.calls[0][0].embeds[0].toJSON().description).toContain('Page 2/2');

        collector.emit('end');
        await vi.waitFor(() => expect(commandInteraction.editReply).toHaveBeenCalledWith({ components: [] }));
    });

    it('ignores an unknown-message cleanup failure and logs other failures', async () => {
        vi.spyOn(fs, 'readdirSync').mockReturnValue(
            Array.from({ length: 6 }, () => dirent('help-command.js')) as any
        );
        const collector = new EventEmitter();
        const commandInteraction = interaction();
        commandInteraction.editReply.mockResolvedValueOnce({
            createMessageComponentCollector: vi.fn().mockReturnValue(collector)
        });
        await helpCommand.execute(commandInteraction);

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        commandInteraction.editReply.mockRejectedValueOnce({ code: 10008 });
        collector.emit('end');
        await Promise.resolve();
        expect(errorSpy).not.toHaveBeenCalled();

        commandInteraction.editReply.mockRejectedValueOnce({ code: 50_000 });
        collector.emit('end');
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    });
});
