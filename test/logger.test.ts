import { describe, expect, it, vi } from 'vitest';
import {
    Logger, addLogContextFields, getLogContextFields, getCommandOutcome, registerSensitiveText, runWithLogContext,
    sanitizeLogValue, serializeError, setCommandOutcome
} from '../src/utility/logger.js';

const fixture = (options: ConstructorParameters<typeof Logger>[0] = {}) => {
    const sink = vi.fn();
    const logger = new Logger({ level: 'debug', format: 'json', sink, now: () => new Date('2026-10-01T00:00:00Z'), ...options });
    return { logger, sink, records: () => sink.mock.calls.map(([, line]) => JSON.parse(line)) };
};

describe('logger', () => {
    it('writes stable JSON fields and filters below the selected severity', () => {
        const { logger, records } = fixture({ level: 'warn' });
        logger.debug('debug', 'hidden');
        logger.info('info', 'hidden');
        logger.warn('warn', 'warning', { timestamp: 'override', level: 'override' });
        logger.error('error', 'failure');
        expect(records()).toEqual([
            { component: 'bot', timestamp: '2026-10-01T00:00:00.000Z', level: 'warn', event: 'warn', message: 'warning' },
            { component: 'bot', timestamp: '2026-10-01T00:00:00.000Z', level: 'error', event: 'error', message: 'failure' }
        ]);
    });

    it('uses defaults and reports invalid config even at error level', () => {
        vi.stubEnv('LOG_LEVEL', 'info');
        vi.stubEnv('LOG_FORMAT', 'pretty');
        const sink = vi.fn();
        const defaults = new Logger({ sink });
        defaults.debug('hidden', 'hidden');
        defaults.info('visible', 'visible');
        expect(sink.mock.calls[0][1]).toContain('INFO visible');
        const invalid = new Logger({ level: 'ERROR', format: 'bad', sink });
        invalid.info('visible', 'visible');
        new Logger({ level: 'error', format: 'bad', sink });
        expect(sink.mock.calls.filter(([, line]) => line.includes('logging.invalid_config'))).toHaveLength(2);
        vi.unstubAllEnvs();
    });

    it('keeps pretty output on one physical line, including error stacks', () => {
        const { logger, sink } = fixture({ format: 'pretty' });
        logger.error('operation.failed', 'line\nline', { error: new Error('bad\ninput') });
        const line = sink.mock.calls[0][1];
        expect(line).toContain('2026-10-01T00:00:00.000Z ERROR operation.failed');
        expect(line).toContain('\\n');
        expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    });

    it('routes normal records to stdout and warnings/errors to stderr', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const log = new Logger({ level: 'debug', format: 'json' });
        log.debug('debug', 'message');
        log.info('info', 'message');
        log.warn('warn', 'message');
        log.error('error', 'message');
        expect(info).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledOnce();
    });

    it('isolates concurrent contexts and outcomes; detached children ignore command context', async () => {
        const { logger, records } = fixture();
        const command = logger.child({ component: 'commands' });
        const audio = command.child({ component: 'audio', guildId: 'guild-b' }, { inheritContext: false });
        await Promise.all(['one', 'two'].map(id => runWithLogContext({ interactionId: id }, async () => {
            await Promise.resolve();
            addLogContextFields({ trackId: id });
            expect(getLogContextFields()).toEqual({ interactionId: id, trackId: id });
            registerSensitiveText(`private-${id}`);
            setCommandOutcome(id === 'one' ? 'failed' : 'rate-limited', id);
            setCommandOutcome('rejected', 'must_not_override');
            command.info('completed', `private-${id}`, getCommandOutcome());
            audio.info('track.started', 'Background playback.');
        })));
        const completed = records().filter(record => record.event === 'completed');
        expect(completed).toEqual(expect.arrayContaining([
            expect.objectContaining({ interactionId: 'one', outcome: 'failed', reason: 'one', message: '[redacted]' }),
            expect.objectContaining({ interactionId: 'two', outcome: 'rate-limited', reason: 'two', message: '[redacted]' })
        ]));
        for (const record of records().filter(record => record.event === 'track.started')) {
            expect(record).toMatchObject({ guildId: 'guild-b', component: 'audio' });
            expect(record).not.toHaveProperty('interactionId');
        }
        setCommandOutcome('failed');
        addLogContextFields({ trackId: 'outside' });
        expect(getLogContextFields()).toEqual({});
        registerSensitiveText('outside');
        expect(getCommandOutcome()).toEqual({ outcome: 'completed', reason: undefined });
    });

    it('redacts configured credentials, authorization, URL credentials and query strings', () => {
        vi.stubEnv('TEST_API_KEY', 'private-key');
        expect(sanitizeLogValue('private-key Bearer abc https://user:pass@host/path?token=abc#secret\u0000\n')).toBe(
            '[redacted] Bearer [redacted] https://host/path?[redacted]#[redacted]\\n'
        );
        expect(sanitizeLogValue('https://[broken')).toBe('[redacted URL]');
        expect(sanitizeLogValue('a\u0000b')).toBe('a b');
        vi.unstubAllEnvs();
    });

    it('serializes only allowed diagnostics and detects HTTP status', () => {
        const error = Object.assign(new Error('source failed'), {
            code: 'PROCESS_FAILURE', stderr: Buffer.from('HTTP Error 403: Forbidden\nhttps://host/path?signed=private'),
            exitCode: 1, signal: null, status: 502, resource: { nested: 'audio internals' },
            response: { data: 'private body' }, headers: { Authorization: 'private' },
            cause: new Error('original')
        });
        const result = serializeError(error);
        expect(result).toMatchObject({ code: 'PROCESS_FAILURE', exitCode: 1, signal: null, status: 502, httpStatus: 403, cause: { message: 'original' } });
        expect(result.diagnostic).toBe('HTTP Error 403: Forbidden\\nhttps://host/path?[redacted]');
        expect(result).not.toHaveProperty('resource');
        expect(result).not.toHaveProperty('response');
        expect(result).not.toHaveProperty('headers');
    });

    it('bounds cause chains and handles circular and non-Error failures', () => {
        const circular: Record<string, unknown> = { message: 'loop', code: 10, statusCode: 500 };
        circular.cause = circular;
        expect(serializeError(circular)).toMatchObject({ message: 'loop', code: 10, cause: { message: '[circular cause]' } });
        const nested = new Error('1', { cause: new Error('2', { cause: new Error('3', { cause: new Error('4') }) }) });
        expect(serializeError(nested)).toMatchObject({ cause: { cause: { cause: { message: '[cause limit]' } } } });
        expect(serializeError(undefined)).toEqual({ name: 'NonError', message: 'undefined' });
        expect(serializeError({ response: 'private' })).toEqual({ name: 'NonError', message: '[non-Error object]' });
        expect(serializeError(() => 'private')).toEqual({ name: 'NonError', message: '[non-Error function]' });
        const broken = { get message() { throw new Error('getter failure'); } };
        expect(serializeError(broken)).toEqual({ name: 'NonError', message: '[non-Error object]' });
    });

    it('bounds fields and excludes user content, SDK instances, buffers and circular objects', () => {
        const { logger, records } = fixture();
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        logger.info('safe', 'x'.repeat(2_000), {
            title: 'x'.repeat(2_000), query: 'private', question: 'private', response: { data: 'private' },
            resource: { data: 'private' }, nested: { content: 'private', bool: true, nil: null },
            circular, bytes: Buffer.from('private'), date: new Date(),
            values: ['a\n', 1, false, {}, ...Array(25).fill('x')], invalid: Infinity, missing: undefined,
            error: Object.assign(new Error('x'.repeat(2_000)), { stderr: Buffer.alloc(5_000, 'x') })
        });
        const [record] = records();
        expect(record.message).toHaveLength(1_000);
        expect(record.title).toHaveLength(1_000);
        expect(record.error.message).toHaveLength(500);
        expect(record.error.diagnostic).toHaveLength(2_000);
        expect(record.values).toHaveLength(20);
        expect(record.nested).toEqual({ bool: true, nil: null });
        expect(record.circular).toEqual({ self: { omitted: '[nested/circular fields]' } });
        for (const field of ['query', 'question', 'response', 'resource', 'bytes', 'date', 'invalid', 'missing']) expect(record).not.toHaveProperty(field);
    });
});
