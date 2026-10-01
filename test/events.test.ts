import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';

const { rateLimitMock } = vi.hoisted(() => ({
    rateLimitMock: {
        isRateLimited: vi.fn(),
        getTimeLeft: vi.fn(),
        setLimit: vi.fn()
    }
}));

vi.mock('../src/utility/ratelimit.js', () => ({
    RateLimit: class {
        isRateLimited = rateLimitMock.isRateLimited;
        getTimeLeft = rateLimitMock.getTimeLeft;
        setLimit = rateLimitMock.setLimit;
    }
}));

import interactionEvent from '../src/events/interactionCreate.js';
import readyEvent from '../src/events/ready.js';
import { setCommandOutcome } from '../src/utility/logger.js';

const interaction = (overrides: Record<string, unknown> = {}) => ({
    isChatInputCommand: vi.fn().mockReturnValue(true),
    client: { commands: new Map() },
    commandName: 'play',
    id: 'interaction-a', guildId: 'guild-a', channelId: 'channel-a',
    user: { id: 'user-a' },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides
}) as any;

describe('Discord event handlers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rateLimitMock.isRateLimited.mockReturnValue(false);
    });

    it('ignores interactions that are not slash commands', async () => {
        const value = interaction({ isChatInputCommand: vi.fn().mockReturnValue(false) });
        await interactionEvent.execute(value);
        expect(rateLimitMock.isRateLimited).not.toHaveBeenCalled();
    });

    it('logs and returns when no command is registered', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await interactionEvent.execute(interaction());
        expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ event: 'command.missing', command: 'play' });
    });

    it('enforces cooldowns with known and missing remaining times', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        rateLimitMock.isRateLimited.mockReturnValue(true);
        rateLimitMock.getTimeLeft.mockReturnValueOnce(1_234).mockReturnValueOnce(undefined);
        const command = { execute: vi.fn() };

        for (const expected of ['1.23', '0']) {
            const value = interaction({ client: { commands: new Map([['play', command]]) } });
            await interactionEvent.execute(value);
            expect(value.reply).toHaveBeenCalledWith({
                content: expect.stringContaining(`${expected} seconds`),
                flags: MessageFlags.Ephemeral
            });
        }
        expect(command.execute).not.toHaveBeenCalled();
    });

    it('dispatches a registered command', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const command = { execute: vi.fn().mockResolvedValue(undefined) };
        const value = interaction({ client: { commands: new Map([['play', command]]) } });
        await interactionEvent.execute(value);
        expect(command.execute).toHaveBeenCalledWith(value);
    });

    it('reports command errors through reply or follow-up', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const command = { execute: vi.fn().mockRejectedValue(new Error('failed')) };

        const fresh = interaction({ client: { commands: new Map([['play', command]]) } });
        await interactionEvent.execute(fresh);
        expect(fresh.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('error'),
            flags: MessageFlags.Ephemeral
        }));

        const acknowledged = interaction({
            client: { commands: new Map([['play', command]]) },
            deferred: true
        });
        await interactionEvent.execute(acknowledged);
        expect(acknowledged.followUp).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('error')
        }));
    });

    it('logs the ready client identity', () => {
        const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        readyEvent.execute({ user: { tag: 'Bean#0001' } } as any);
        expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'bot.ready', botTag: 'Bean#0001' });
    });

    it('records handled command failures and validation rejections as their actual outcomes', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        for (const outcome of ['failed', 'rejected'] as const) {
            const command = { execute: vi.fn(async () => { setCommandOutcome(outcome, 'handled'); }) };
            await interactionEvent.execute(interaction({ client: { commands: new Map([['play', command]]) } }));
        }
        const records = info.mock.calls.map(([line]) => JSON.parse(line));
        expect(records).toEqual([
            expect.objectContaining({ event: 'command.completed', outcome: 'failed', reason: 'handled', interactionId: 'interaction-a', elapsedMs: expect.any(Number) }),
            expect.objectContaining({ event: 'command.completed', outcome: 'rejected', guildId: 'guild-a', userId: 'user-a' })
        ]);
    });

    it('preserves the original failure when the Discord error response also fails', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const command = { execute: vi.fn().mockRejectedValue(new Error('original failure')) };
        await expect(interactionEvent.execute(interaction({
            client: { commands: new Map([['play', command]]) },
            reply: vi.fn().mockRejectedValue(new Error('Discord unavailable'))
        }))).resolves.toBeUndefined();
        expect(errors.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
            expect.objectContaining({ event: 'command.failed', error: expect.objectContaining({ message: 'original failure' }) }),
            expect.objectContaining({ event: 'command.error_response_failed', error: expect.objectContaining({ message: 'Discord unavailable' }) })
        ]);
        expect(info.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
            expect.objectContaining({ event: 'command.completed', outcome: 'failed' })
        ]);
    });
});
