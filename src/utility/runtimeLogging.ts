import type { Client } from 'discord.js';
import { logger } from './logger.js';

const log = logger.child({ component: 'runtime' }, { inheritContext: false });

export function logUnhandledRejection(reason: unknown): void {
    log.error('process.unhandled_rejection', 'Unhandled rejection; process remains running.', { error: reason });
}

export function logUncaughtException(error: unknown): void {
    log.error('process.uncaught_exception', 'Uncaught exception; process remains running.', { error });
}

export function attachClientLogging(client: Client): void {
    client.on('error', error => log.error('discord.client_error', 'Discord client error.', { error }));
    client.on('warn', warning => log.warn('discord.client_warning', 'Discord client warning.', { warning }));
    client.on('shardError', (error, shardId) => log.error('discord.shard_error', 'Discord shard error.', { error, shardId }));
    client.on('shardDisconnect', (event, shardId) => log.warn('discord.shard_disconnected', 'Discord shard disconnected.', { shardId, closeCode: event.code }));
    client.on('shardReconnecting', shardId => log.info('discord.shard_reconnecting', 'Discord shard reconnecting.', { shardId }));
    client.on('shardResume', (shardId, replayedEvents) => log.info('discord.shard_resumed', 'Discord shard resumed.', { shardId, replayedEvents }));
    client.on('shardReady', shardId => log.info('discord.shard_ready', 'Discord shard ready.', { shardId }));
}
