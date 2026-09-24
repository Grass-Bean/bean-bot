import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import {
    AudioInteractionController
} from '../src/audio/AudioInteractionController.js';
import {
    GuildAudioSessionManager,
    VoiceConnectionRateLimitError
} from '../src/audio/GuildAudioSessionManager.js';

const createSessions = () => ({
    getActiveChannelId: vi.fn(),
    connect: vi.fn()
});

const createInteraction = (overrides: Record<string, unknown> = {}) => {
    const fetch = vi.fn().mockResolvedValue({ voice: { channelId: 'voice-a' } });
    return {
        guildId: 'guild-a',
        guild: {
            id: 'guild-a',
            members: { fetch },
            voiceAdapterCreator: { adapter: true }
        },
        member: { user: { id: 'user-a' } },
        user: { id: 'user-a' },
        deferred: false,
        replied: false,
        reply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        ...overrides
    } as unknown as ChatInputCommandInteraction & { guild: { members: { fetch: ReturnType<typeof vi.fn> } } };
};

describe('AudioInteractionController', () => {
    let sessions: ReturnType<typeof createSessions>;
    let controller: AudioInteractionController;

    beforeEach(() => {
        sessions = createSessions();
        controller = new AudioInteractionController(sessions as unknown as GuildAudioSessionManager);
    });

    it('rejects direct-message use and selects the correct response method', async () => {
        const fresh = createInteraction({ guild: null, member: null });
        expect(await controller.requireVoiceChannel(fresh)).toBeUndefined();
        expect(fresh.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'This command can only be used in a server.',
            flags: MessageFlags.Ephemeral
        }));

        const deferred = createInteraction({ guild: null, member: null, deferred: true });
        await controller.requireVoiceChannel(deferred);
        expect(deferred.editReply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'This command can only be used in a server.'
        }));

        const replied = createInteraction({ guild: null, member: null, replied: true });
        await controller.requireVoiceChannel(replied);
        expect(replied.followUp).toHaveBeenCalledWith(expect.objectContaining({
            content: 'This command can only be used in a server.',
            flags: MessageFlags.Ephemeral
        }));
    });

    it('reports member lookup failures and missing voice membership', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const failed = createInteraction();
        failed.guild.members.fetch.mockRejectedValueOnce(new Error('Discord unavailable'));

        expect(await controller.requireVoiceChannel(failed)).toBeUndefined();
        expect(failed.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'Could not determine your voice channel.'
        }));
        expect(errorSpy).toHaveBeenCalled();

        const noVoice = createInteraction();
        noVoice.guild.members.fetch.mockResolvedValueOnce({ voice: { channelId: null } });
        expect(await controller.requireVoiceChannel(noVoice)).toBeUndefined();
        expect(noVoice.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'You need to be in a voice channel to use this command.'
        }));
    });

    it('prevents channel races and cross-channel control', async () => {
        const changed = createInteraction();
        expect(await controller.requireVoiceChannel(changed, 'voice-old')).toBeUndefined();
        expect(changed.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'Your voice channel changed while the command was running. Please try again.'
        }));

        sessions.getActiveChannelId.mockReturnValueOnce('voice-b');
        const occupied = createInteraction();
        expect(await controller.requireVoiceChannel(occupied)).toBeUndefined();
        expect(occupied.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('<#voice-b>')
        }));
    });

    it('returns the member channel when control is valid', async () => {
        sessions.getActiveChannelId.mockReturnValue(undefined);
        const interaction = createInteraction();

        expect(await controller.requireVoiceChannel(interaction)).toBe('voice-a');
        expect(interaction.reply).not.toHaveBeenCalled();
    });

    it('connects through the session manager', async () => {
        const connection = { state: { status: 'ready' } };
        sessions.connect.mockResolvedValue(connection);
        const interaction = createInteraction();

        expect(await controller.connect(interaction)).toBe(connection);
        expect(sessions.connect).toHaveBeenCalledWith(
            'guild-a',
            'voice-a',
            interaction.guild.voiceAdapterCreator
        );
    });

    it('turns voice rate limits into a user-facing retry time', async () => {
        sessions.connect.mockRejectedValue(new VoiceConnectionRateLimitError(1_001));
        const interaction = createInteraction();

        expect(await controller.connect(interaction)).toBeUndefined();
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'Discord temporarily rate-limited voice connections. Please try again in 2 seconds.'
        }));
    });

    it('reports unexpected connection failures without leaking the exception', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        sessions.connect.mockRejectedValue(new Error('boom'));
        const interaction = createInteraction();

        expect(await controller.connect(interaction)).toBeUndefined();
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'Failed to connect to the voice channel.'
        }));
        expect(errorSpy).toHaveBeenCalled();
    });

    it('allows control without an active session and validates it otherwise', async () => {
        const interaction = createInteraction();
        sessions.getActiveChannelId.mockReturnValueOnce(undefined);
        expect(await controller.ensureCanControl(interaction)).toBe(true);

        sessions.getActiveChannelId.mockReturnValueOnce('voice-a').mockReturnValueOnce('voice-a');
        expect(await controller.ensureCanControl(interaction)).toBe(true);
    });
});
