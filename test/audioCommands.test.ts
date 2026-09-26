import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';

const { controllerMock, sessionsMock, resolverMock } = vi.hoisted(() => ({
    controllerMock: {
        requireVoiceChannel: vi.fn(),
        connect: vi.fn(),
        ensureCanControl: vi.fn()
    },
    sessionsMock: {
        disconnect: vi.fn(),
        skip: vi.fn(),
        isQueueFull: vi.fn(),
        enqueue: vi.fn(),
        getSnapshot: vi.fn(),
        isAutoplayEnabled: vi.fn(),
        setAutoplay: vi.fn()
    },
    resolverMock: {
        resolve: vi.fn()
    }
}));

vi.mock('../src/audio/AudioInteractionController.js', () => ({
    audioInteractionController: controllerMock
}));
vi.mock('../src/audio/GuildAudioSessionManager.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/audio/GuildAudioSessionManager.js')>();
    return { ...actual, guildAudioSessionManager: sessionsMock };
});
vi.mock('../src/audio/TrackResolver.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/audio/TrackResolver.js')>();
    return { ...actual, trackResolver: resolverMock };
});

import connectCommand from '../src/commands/audio/connect.js';
import disconnectCommand from '../src/commands/audio/disconnect.js';
import skipCommand from '../src/commands/audio/skip.js';
import playCommand from '../src/commands/audio/play.js';
import queueCommand from '../src/commands/audio/queue.js';
import autoplayCommand from '../src/commands/audio/autoplay.js';
import { TrackResolverError } from '../src/audio/TrackResolver.js';
import type { TrackMetadata } from '../src/audio/types.js';

const track = (id = 'track-a', title = 'Song *A*'): TrackMetadata => ({
    kind: 'track',
    id,
    title,
    url: `https://youtube.com/watch?v=${id}`,
    duration: 65,
    thumbnail: `https://img.youtube.com/${id}.jpg`,
    requestedBy: 'user-a'
});

const createInteraction = (overrides: Record<string, unknown> = {}) => ({
    guildId: 'guild-a',
    guild: { id: 'guild-a' },
    member: { id: 'member-a' },
    user: { id: 'user-a' },
    channel: { id: 'text-a' },
    deferred: false,
    replied: false,
    options: {
        getString: vi.fn().mockReturnValue('song query'),
        getBoolean: vi.fn().mockReturnValue(null)
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides
}) as any;

describe('audio commands', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        controllerMock.requireVoiceChannel.mockResolvedValue('voice-a');
        controllerMock.connect.mockResolvedValue({ id: 'connection-a' });
        controllerMock.ensureCanControl.mockResolvedValue(true);
        sessionsMock.isQueueFull.mockReturnValue(false);
        sessionsMock.enqueue.mockReturnValue({ accepted: true, startsImmediately: true, position: 0 });
        sessionsMock.getSnapshot.mockReturnValue({ pending: [] });
        sessionsMock.isAutoplayEnabled.mockReturnValue(false);
        sessionsMock.setAutoplay.mockReturnValue(true);
        resolverMock.resolve.mockResolvedValue(track());
    });

    describe('/connect', () => {
        it('stops before deferral when the member has no usable voice channel', async () => {
            controllerMock.requireVoiceChannel.mockResolvedValue(undefined);
            const interaction = createInteraction();
            await connectCommand.execute(interaction);
            expect(interaction.deferReply).not.toHaveBeenCalled();
        });

        it('defers, connects to the originally validated channel, and confirms success', async () => {
            const interaction = createInteraction();
            await connectCommand.execute(interaction);
            expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
            expect(controllerMock.connect).toHaveBeenCalledWith(interaction, 'voice-a');
            expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Connected')
            }));
        });

        it('lets the controller own the failure response', async () => {
            controllerMock.connect.mockResolvedValue(undefined);
            const interaction = createInteraction();
            await connectCommand.execute(interaction);
            expect(interaction.editReply).not.toHaveBeenCalled();
        });
    });

    describe('/disconnect and /skip', () => {
        it('rejects disconnects outside a guild', async () => {
            const interaction = createInteraction({ guild: null, member: null });
            await disconnectCommand.execute(interaction);
            expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
                content: '❌ **Server only**\nUse this command in a server.',
                flags: MessageFlags.Ephemeral
            }));
        });

        it('checks control rights and reports both disconnect outcomes', async () => {
            controllerMock.ensureCanControl.mockResolvedValueOnce(false);
            const denied = createInteraction();
            await disconnectCommand.execute(denied);
            expect(sessionsMock.disconnect).not.toHaveBeenCalled();

            sessionsMock.disconnect.mockReturnValueOnce(true).mockReturnValueOnce(false);
            const disconnected = createInteraction();
            await disconnectCommand.execute(disconnected);
            expect(disconnected.reply).toHaveBeenCalledWith({ content: '🔌 Disconnected from the voice channel.' });

            const absent = createInteraction();
            await disconnectCommand.execute(absent);
            expect(absent.reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Nothing to disconnect')
            }));
        });

        it('reports disconnect exceptions', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            sessionsMock.disconnect.mockImplementation(() => { throw new Error('failure'); });
            const interaction = createInteraction();
            await disconnectCommand.execute(interaction);
            expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Couldn’t disconnect')
            }));
        });

        it('denies, rejects, or performs a skip based on control and player state', async () => {
            controllerMock.ensureCanControl.mockResolvedValueOnce(false);
            const denied = createInteraction();
            await skipCommand.execute(denied);
            expect(sessionsMock.skip).not.toHaveBeenCalled();

            sessionsMock.skip.mockReturnValueOnce(false).mockReturnValueOnce(true);
            const empty = createInteraction();
            await skipCommand.execute(empty);
            expect(empty.reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Nothing is playing')
            }));

            sessionsMock.getSnapshot.mockReturnValueOnce({ current: track(), pending: [] });
            const playing = createInteraction();
            await skipCommand.execute(playing);
            expect(playing.reply).toHaveBeenCalledWith(expect.stringContaining('Song \\*A\\*'));
        });
    });

    describe('/play', () => {
        it('stops when voice validation fails', async () => {
            controllerMock.requireVoiceChannel.mockResolvedValue(undefined);
            const interaction = createInteraction();
            await playCommand.execute(interaction);
            expect(resolverMock.resolve).not.toHaveBeenCalled();
        });

        it('defers and rejects a queue that is already full', async () => {
            sessionsMock.isQueueFull.mockReturnValue(true);
            const interaction = createInteraction();
            await playCommand.execute(interaction);
            expect(interaction.deferReply).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Queue is full')
            }));
            expect(resolverMock.resolve).not.toHaveBeenCalled();
        });

        it('resolves, connects, enqueues, escapes the title, and reports immediate play', async () => {
            const interaction = createInteraction();
            await playCommand.execute(interaction);
            expect(resolverMock.resolve).toHaveBeenCalledWith('song query', 'user-a');
            expect(controllerMock.connect).toHaveBeenCalledWith(interaction, 'voice-a');
            expect(sessionsMock.enqueue).toHaveBeenCalledWith('guild-a', track(), interaction.channel);
            const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
            expect(embed.author.name).toBe('＋ Added to queue');
            expect(embed.color).toBe(0x5865f2);
            expect(embed.title).toBe('Song *A*');
            expect(embed.description).toContain('1:05');
            expect(embed.description).not.toContain('Playing now');
            expect(embed.image?.url).toBe('https://img.youtube.com/track-a.jpg');
            expect(embed.thumbnail).toBeUndefined();
        });

        it('reports queued position and an enqueue race that fills the queue', async () => {
            sessionsMock.enqueue.mockReturnValueOnce({ accepted: true, startsImmediately: false, position: 4 });
            const queued = createInteraction();
            await playCommand.execute(queued);
            const embed = queued.editReply.mock.calls[0][0].embeds[0].toJSON();
            expect(embed.author.name).toBe('＋ Added to queue');
            expect(embed.description).toContain('Position 4');

            sessionsMock.enqueue.mockReturnValueOnce({ accepted: false, startsImmediately: false, position: 50 });
            const full = createInteraction();
            await playCommand.execute(full);
            expect(full.editReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Queue is full')
            }));
        });

        it('stops if connecting fails after resolution', async () => {
            controllerMock.connect.mockResolvedValue(undefined);
            const interaction = createInteraction();
            await playCommand.execute(interaction);
            expect(sessionsMock.enqueue).not.toHaveBeenCalled();
        });

        it.each([
            ['INVALID_INPUT', 'bad input', 'bad input'],
            ['UNSUPPORTED_URL', 'bad host', 'bad host'],
            ['TIMEOUT', 'timeout', 'The media lookup timed out. Please try again.'],
            ['CANCELLED', 'cancelled', 'The media lookup was cancelled.'],
            ['PROCESS_FAILURE', 'failed', 'Try another song name or paste a supported media link.']
        ] as const)('maps resolver error %s to a safe reply', async (code, sourceMessage, response) => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            resolverMock.resolve.mockRejectedValue(new TrackResolverError(sourceMessage, code));
            const interaction = createInteraction();
            await playCommand.execute(interaction);
            expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining(response)
            }));
        });

        it('maps unexpected errors to a generic reply', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            resolverMock.resolve.mockRejectedValue(new Error('secret'));
            const interaction = createInteraction();
            await playCommand.execute(interaction);
            expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Failed to find or play the requested media.')
            }));
        });
    });

    describe('/autoplay', () => {
        it('connects and toggles autoplay with an ephemeral response', async () => {
            const interaction = createInteraction();
            await autoplayCommand.execute(interaction);

            expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
            expect(controllerMock.connect).toHaveBeenCalledWith(interaction, 'voice-a');
            expect(sessionsMock.setAutoplay).toHaveBeenCalledWith('guild-a', true);
            expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Autoplay on')
            }));
        });

        it('honors an explicit off setting', async () => {
            const interaction = createInteraction();
            interaction.options.getBoolean.mockReturnValue(false);
            await autoplayCommand.execute(interaction);

            expect(sessionsMock.setAutoplay).toHaveBeenCalledWith('guild-a', false);
            expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Autoplay off')
            }));
        });
    });

    describe('/queue', () => {
        it('renders an empty queue without pagination controls', async () => {
            const interaction = createInteraction();
            interaction.editReply.mockResolvedValue({});
            await queueCommand.execute(interaction);

            const payload = interaction.editReply.mock.calls[0][0];
            expect(payload.embeds[0].toJSON().description).toContain('Nothing playing yet');
            expect(payload.components).toEqual([]);
        });

        it('renders current and pending tracks with safe URLs and durations', async () => {
            sessionsMock.getSnapshot.mockReturnValue({
                current: track('current', 'Now [playing]'),
                pending: [{ ...track('next'), duration: 3_661, url: 'https://youtube.com/a(b)\\c' }]
            });
            const interaction = createInteraction({ deferred: true });
            await queueCommand.execute(interaction);

            expect(interaction.deferReply).not.toHaveBeenCalled();
            const description = interaction.editReply.mock.calls[0][0].embeds[0].toJSON().description;
            expect(description).toContain('**▶ Now playing**');
            expect(description).toContain('`1:01:01`');
            expect(description).toContain('%28b%29%5Cc');
        });

        it('paginates, handles both navigation directions, and removes expired controls', async () => {
            const collector = new EventEmitter();
            sessionsMock.getSnapshot.mockReturnValue({
                pending: Array.from({ length: 11 }, (_, index) => track(`track-${index}`, `Song ${index}`))
            });
            const interaction = createInteraction();
            interaction.editReply.mockResolvedValue({
                createMessageComponentCollector: vi.fn().mockReturnValue(collector)
            });
            await queueCommand.execute(interaction);

            const next = { customId: 'next', update: vi.fn().mockResolvedValue(undefined) };
            collector.emit('collect', next);
            await vi.waitFor(() => expect(next.update).toHaveBeenCalled());
            expect(next.update.mock.calls[0][0].embeds[0].toJSON().footer.text).toContain('Page 2 of 2');

            const previous = { customId: 'prev', update: vi.fn().mockResolvedValue(undefined) };
            collector.emit('collect', previous);
            await vi.waitFor(() => expect(previous.update).toHaveBeenCalled());
            expect(previous.update.mock.calls[0][0].embeds[0].toJSON().footer.text).toContain('Page 1 of 2');

            collector.emit('end');
            await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledWith({ components: [] }));
        });
    });
});
