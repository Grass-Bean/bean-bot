import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, TextChannel } from 'discord.js';

const { axiosPostMock } = vi.hoisted(() => ({ axiosPostMock: vi.fn() }));
vi.mock('axios', () => ({ default: { post: axiosPostMock } }));

import lewdCommand from '../src/commands/nsfw/lewd.js';

const interaction = (overrides: Record<string, unknown> = {}) => ({
    channel: {},
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    ...overrides
}) as any;

describe('/lewd', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects use in a non-NSFW text channel', async () => {
        const channel = Object.create(TextChannel.prototype);
        channel.nsfw = false;
        const commandInteraction = interaction({ channel });

        await lewdCommand.execute(commandInteraction);
        expect(commandInteraction.reply).toHaveBeenCalledWith({
            content: '❌ This command can only be used in NSFW channels!',
            flags: MessageFlags.Ephemeral
        });
        expect(commandInteraction.deferReply).not.toHaveBeenCalled();
    });

    it('scrapes and renders normalized metadata', async () => {
        axiosPostMock.mockResolvedValue({
            data: {
                status: 'ok',
                solution: {
                    url: 'https://nhentai.net/g/12345/',
                    response: `
                        <html><head><title>Fallback » nhentai: hentai doujinshi and manga</title></head>
                        <body>
                            <div id="info"><h1 class="title"> Example Title </h1></div>
                            <div id="cover"><img data-src="//images.example/cover.jpg"></div>
                            <div class="tag-container">Tags<div class="tags">
                                ${Array.from({ length: 12 }, (_, index) => `<span class="tag"><span class="name">Tag ${index}</span></span>`).join('')}
                            </div></div>
                            <div class="tag-container">Artists<div class="tags"><span class="tag"><span class="name">Artist A</span></span></div></div>
                            <div class="tag-container">Pages<div class="tags"><span class="tag"><span class="name">24</span></span></div></div>
                        </body></html>`
                }
            }
        });
        const commandInteraction = interaction();

        await lewdCommand.execute(commandInteraction);
        expect(axiosPostMock).toHaveBeenCalledWith('http://flaresolverr:8191/v1', expect.objectContaining({
            cmd: 'request.get',
            url: 'https://nhentai.net/random/'
        }));
        const payload = commandInteraction.editReply.mock.calls[0][0];
        const embed = payload.embeds[0].toJSON();
        expect(embed.title).toBe('[12345] Example Title');
        expect(embed.image.url).toBe('https://images.example/cover.jpg');
        expect(embed.fields.find((field: any) => field.name === 'Tags').value.split(', ')).toHaveLength(10);
        expect(payload.components[0].toJSON().components).toHaveLength(2);
    });

    it('uses fallback metadata when optional fields are missing', async () => {
        axiosPostMock.mockResolvedValue({
            data: {
                solution: {
                    url: 'https://nhentai.net/not-a-gallery/',
                    response: '<title>Fallback Title » nhentai: hentai doujinshi and manga</title><div id="cover"><img src="https://images.example/fallback.jpg"></div>'
                }
            }
        });
        const commandInteraction = interaction();
        await lewdCommand.execute(commandInteraction);

        const embed = commandInteraction.editReply.mock.calls[0][0].embeds[0].toJSON();
        expect(embed.title).toBe('[Unknown] Fallback Title');
        expect(embed.fields).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Artist', value: 'Unknown' }),
            expect.objectContaining({ name: 'Pages', value: '??' }),
            expect.objectContaining({ name: 'Tags', value: 'None' })
        ]));
    });

    it('uses the configured fallback when FlareSolverr rejects the response', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        axiosPostMock.mockResolvedValue({ data: { status: 'error', message: 'blocked' } });
        const commandInteraction = interaction();
        await lewdCommand.execute(commandInteraction);
        expect(commandInteraction.editReply).toHaveBeenCalledWith(expect.any(String));
    });

    it('handles request exceptions as a failed scrape', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        axiosPostMock.mockRejectedValue(new Error('network'));
        const commandInteraction = interaction();
        await lewdCommand.execute(commandInteraction);
        expect(commandInteraction.editReply).toHaveBeenCalledWith(expect.any(String));
    });
});
