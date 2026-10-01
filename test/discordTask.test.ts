import { describe, expect, it, vi } from 'vitest';
import { observeDiscordTask, sendCommandErrorResponse } from '../src/utility/discordTask.js';
import { runWithLogContext } from '../src/utility/logger.js';

describe('Discord background tasks', () => {
    const interaction = { id: 'interaction-a', commandName: 'queue', guildId: 'guild-a', user: { id: 'user-a' } };
    it('captures synchronous and asynchronous pagination failures with context', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await observeDiscordTask(interaction, 'pagination.update_failed', () => { throw new Error('sync failure'); });
        await observeDiscordTask(interaction, 'pagination.cleanup_failed', () => Promise.reject(new Error('async failure')), true);
        expect(error.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
            expect.objectContaining({ event: 'pagination.update_failed', interactionId: 'interaction-a', command: 'queue', error: { name: 'Error', message: 'sync failure', stack: expect.any(String) } }),
            expect.objectContaining({ event: 'pagination.cleanup_failed', guildId: 'guild-a', error: { name: 'Error', message: 'async failure', stack: expect.any(String) } })
        ]);
    });
    it('ignores missing messages during cleanup only', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await observeDiscordTask(interaction, 'cleanup', () => Promise.reject({ code: 10008 }), true);
        await observeDiscordTask(interaction, 'update', () => Promise.reject({ code: 10008 }));
        await observeDiscordTask(interaction, 'update', () => Promise.resolve());
        expect(error).toHaveBeenCalledOnce();
    });
    it('captures a locally handled command error response with command context', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await runWithLogContext({ interactionId: 'interaction-a', command: 'play' }, async () => {
            await sendCommandErrorResponse(() => Promise.reject(new Error('reply failure')));
            await sendCommandErrorResponse(() => Promise.resolve());
        });
        expect(error).toHaveBeenCalledOnce();
        expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ event: 'command.error_response_failed', command: 'play', interactionId: 'interaction-a' });
    });
});
