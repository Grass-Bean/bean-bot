import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import type { TrackMetadata } from './types.js';

export const AUDIO_COLORS = {
    info: 0x5865f2,
    success: 0x57f287,
    warning: 0xfee75c,
    error: 0xed4245,
    neutral: 0x2b2d31
} as const;

export const formatDuration = (durationSeconds: number | undefined): string | undefined => {
    if (durationSeconds === undefined) return undefined;

    const totalSeconds = Math.floor(durationSeconds);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    return hours > 0
        ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
        : `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

export const safeTrackUrl = (url: string): string => (
    url.replace(/\\/g, '%5C').replace(/\(/g, '%28').replace(/\)/g, '%29')
);

export const linkedTrackTitle = (track: TrackMetadata): string => (
    `[${escapeMarkdown(track.title)}](${safeTrackUrl(track.url)})`
);

const setTrackArtwork = (embed: EmbedBuilder, track: TrackMetadata): EmbedBuilder => {
    if (track.thumbnail) embed.setImage(track.thumbnail);
    return embed;
};

export const createQueuedTrackEmbed = (
    track: TrackMetadata,
    startsImmediately: boolean,
    position: number
): EmbedBuilder => {
    const metadata: string[] = [];
    const duration = formatDuration(track.duration);
    if (duration) metadata.push(`\`${duration}\``);
    if (!startsImmediately) metadata.push(`Position ${position}`);

    const details = metadata.length ? `${metadata.join('  •  ')}\n` : '';

    const embed = new EmbedBuilder()
        .setColor(AUDIO_COLORS.info)
        .setAuthor({ name: '＋ Added to queue' })
        .setTitle(track.title)
        .setURL(track.url)
        .setDescription(`${details}Requested by <@${track.requestedBy}>`);

    return setTrackArtwork(embed, track);
};

export const createNowPlayingEmbed = (
    track: TrackMetadata,
    tracksWaiting: number
): EmbedBuilder => {
    const details: string[] = [];
    const duration = formatDuration(track.duration);
    if (duration) details.push(`\`${duration}\``);
    details.push(`Requested by <@${track.requestedBy}>`);

    const waitingLabel = tracksWaiting === 0
        ? 'Queue empty'
        : tracksWaiting === 1
            ? 'Up next: 1 track'
            : `Up next: ${tracksWaiting} tracks`;
    const embed = new EmbedBuilder()
        .setColor(AUDIO_COLORS.success)
        .setAuthor({ name: '♫ Now playing' })
        .setTitle(track.title)
        .setURL(track.url)
        .setDescription(details.join('  •  '))
        .setFooter({ text: waitingLabel });

    return setTrackArtwork(embed, track);
};
