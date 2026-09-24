import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import coinflipCommand from '../src/commands/gambling/coinflip.js';
import slotsCommand from '../src/commands/gambling/slots.js';

const createUser = () => ({
    username: 'Bean',
    displayAvatarURL: vi.fn().mockReturnValue('https://example.com/avatar.png')
});

describe('gambling commands', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        [0, 'Heads'],
        [0.99, 'Tails']
    ] as const)('/flip renders the selected face', async (random, expected) => {
        vi.spyOn(Math, 'random').mockReturnValue(random);
        const interaction = {
            user: createUser(),
            reply: vi.fn().mockResolvedValue(undefined)
        } as any;

        await coinflipCommand.execute(interaction);
        const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
        expect(embed.description).toContain(expected);
        expect(embed.author.name).toBe('Bean');
        expect(embed.thumbnail.url).toContain('cdn.discordapp.com/emojis/');
    });

    describe('/slots payout paths', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        const cases = [
            { name: 'rare triple jackpot', randoms: [0.999, 0.999, 0.999], result: 'JACKPOT', won: '**100**' },
            { name: 'mapped triple', randoms: [0.70, 0.70, 0.70], result: 'TRIPLE', won: '**30**' },
            { name: 'fallback triple', randoms: [0, 0, 0], result: 'TRIPLE', won: '**6**' },
            { name: 'adjacent pair', randoms: [0, 0, 0.3], result: 'DOUBLE_ADJACENT', won: '**4**' },
            { name: 'separated pair', randoms: [0, 0.3, 0], result: 'DOUBLE', won: '**2**' },
            { name: 'special combo', randoms: [0.999, 0.90, 0.70], result: 'SPECIAL_COMBO', won: '**10**' },
            { name: 'loss', randoms: [0, 0.3, 0.55], result: 'LOSE', won: '**0**' }
        ];

        it.each(cases)('calculates $name', async ({ randoms, result, won }) => {
            vi.spyOn(Math, 'random')
                .mockReturnValueOnce(randoms[0])
                .mockReturnValueOnce(randoms[1])
                .mockReturnValueOnce(randoms[2]);
            const message = { edit: vi.fn().mockResolvedValue(undefined) };
            const interaction = {
                user: createUser(),
                options: { getInteger: vi.fn().mockReturnValue(2) },
                reply: vi.fn().mockResolvedValue(undefined),
                fetchReply: vi.fn().mockResolvedValue(message)
            } as any;

            const execution = slotsCommand.execute(interaction);
            await vi.runAllTimersAsync();
            await execution;

            expect(interaction.reply).toHaveBeenCalledOnce();
            expect(message.edit).toHaveBeenCalledTimes(3);
            const finalEmbed = message.edit.mock.calls[2][0].embeds[0].toJSON();
            const fields = Object.fromEntries(finalEmbed.fields.map((field: any) => [field.name, field.value]));
            expect(fields.Result).toBeTruthy();
            expect(fields.Won).toBe(won);
            expect(finalEmbed.title).toBe(result === 'JACKPOT' ? '💰 JACKPOT 💰' : '🎰 Slot Machine Results');
        });

        it('uses the default bet when no bet was supplied', async () => {
            vi.spyOn(Math, 'random').mockReturnValue(0);
            const message = { edit: vi.fn().mockResolvedValue(undefined) };
            const interaction = {
                user: createUser(),
                options: { getInteger: vi.fn().mockReturnValue(null) },
                reply: vi.fn().mockResolvedValue(undefined),
                fetchReply: vi.fn().mockResolvedValue(message)
            } as any;

            const execution = slotsCommand.execute(interaction);
            await vi.runAllTimersAsync();
            await execution;
            const final = message.edit.mock.calls[2][0].embeds[0].toJSON();
            expect(final.fields.find((field: any) => field.name === 'Bet').value).toBe('1');
        });
    });
});
