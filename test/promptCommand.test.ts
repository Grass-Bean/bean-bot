import { beforeEach, describe, expect, it, vi } from 'vitest';

const { completionMock } = vi.hoisted(() => ({ completionMock: vi.fn() }));

vi.mock('openai', () => ({
    default: class OpenAI {
        chat = { completions: { create: completionMock } };
    }
}));
vi.mock('bottleneck', () => ({
    default: class Bottleneck {
        wrap<T extends (...args: any[]) => any>(fn: T): T {
            return fn;
        }
    }
}));

import promptCommand from '../src/commands/llm/prompt.js';

const stream = async function* (contents: Array<string | undefined>) {
    for (const content of contents) {
        yield { choices: [{ delta: { content } }] };
    }
};

const interaction = () => ({
    options: { getString: vi.fn().mockReturnValue('Why sky blue?') },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined)
}) as any;

describe('/prompt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('streams content, caps Discord messages, and sends overflow in order', async () => {
        const longText = 'a'.repeat(4_500);
        completionMock.mockResolvedValue(stream([undefined, longText]));
        const commandInteraction = interaction();

        await promptCommand.execute(commandInteraction);

        expect(commandInteraction.deferReply).toHaveBeenCalled();
        expect(completionMock).toHaveBeenCalledWith(expect.objectContaining({
            model: 'nvidia/nemotron-3-super-120b-a12b',
            stream: true,
            messages: expect.arrayContaining([
                expect.objectContaining({ role: 'user', content: 'Why sky blue?' }),
                expect.objectContaining({ role: 'system' })
            ])
        }));
        expect(commandInteraction.editReply).toHaveBeenLastCalledWith('a'.repeat(2_000));
        expect(commandInteraction.followUp).toHaveBeenNthCalledWith(1, 'a'.repeat(2_000));
        expect(commandInteraction.followUp).toHaveBeenNthCalledWith(2, 'a'.repeat(500));
    });

    it('throttles intermediate edits but always writes the final response', async () => {
        vi.spyOn(Date, 'now')
            .mockReturnValueOnce(2_000)
            .mockReturnValueOnce(2_500)
            .mockReturnValueOnce(4_000);
        completionMock.mockResolvedValue(stream(['one', ' two', ' three']));
        const commandInteraction = interaction();

        await promptCommand.execute(commandInteraction);
        expect(commandInteraction.editReply.mock.calls.map((call: any[]) => call[0])).toEqual([
            'one',
            'one two three',
            'one two three'
        ]);
        expect(commandInteraction.followUp).not.toHaveBeenCalled();
    });

    it('reports an empty model response', async () => {
        completionMock.mockResolvedValue(stream([undefined, '']));
        const commandInteraction = interaction();
        await promptCommand.execute(commandInteraction);
        expect(commandInteraction.editReply).toHaveBeenCalledWith('Received an empty response from the model.');
    });

    it('handles API and stream failures', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        completionMock.mockRejectedValue(new Error('API unavailable'));
        const commandInteraction = interaction();
        await promptCommand.execute(commandInteraction);
        expect(commandInteraction.editReply).toHaveBeenCalledWith('Sorry, bot decided to kill itself halfway.');
        expect(error).toHaveBeenCalled();
    });
});
