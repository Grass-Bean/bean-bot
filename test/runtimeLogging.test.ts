import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { attachClientLogging, logUnhandledRejection, logUncaughtException } from '../src/utility/runtimeLogging.js';

describe('runtime logging', () => {
    it('logs global failures without exiting the process', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected exit'); });
        logUnhandledRejection('failed promise');
        logUncaughtException(new Error('uncaught'));
        expect(error.mock.calls.map(([line]) => JSON.parse(line).event)).toEqual(['process.unhandled_rejection', 'process.uncaught_exception']);
        expect(exit).not.toHaveBeenCalled();
    });

    it('captures client and shard lifecycle without exposing Discord event objects', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const client = new EventEmitter();
        attachClientLogging(client as any);
        client.emit('error', new Error('client error'));
        client.emit('warn', 'warning');
        client.emit('shardError', new Error('shard error'), 0);
        client.emit('shardDisconnect', { code: 1006, private: 'do not log' }, 0);
        client.emit('shardReconnecting', 0);
        client.emit('shardResume', 0, 4);
        client.emit('shardReady', 0);
        expect(info).toHaveBeenCalledTimes(3);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledTimes(2);
        expect(JSON.parse(warn.mock.calls[1][0])).toMatchObject({ event: 'discord.shard_disconnected', shardId: 0, closeCode: 1006 });
        expect(warn.mock.calls[1][0]).not.toContain('do not log');
    });
});
