import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'pretty' | 'json';
export type LogFields = Record<string, unknown>;
export type CommandOutcome = 'completed' | 'rejected' | 'rate-limited' | 'failed';

interface LogContext {
    fields: LogFields;
    outcome: CommandOutcome;
    reason?: string;
    sensitiveValues: string[];
}

const contexts = new AsyncLocalStorage<LogContext>();
const levels: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const forbiddenField = /^(?:.*token.*|api_?key|.*secret.*|.*password.*|authorization|cookie|headers?|body|request|response|resource|stream|query|question|prompt|content|generatedText)$/i;

export function runWithLogContext<T>(fields: LogFields, operation: () => T): T {
    return contexts.run({ fields, outcome: 'completed', sensitiveValues: [] }, operation);
}

export function setCommandOutcome(outcome: CommandOutcome, reason?: string): void {
    const context = contexts.getStore();
    if (!context || context.outcome === 'failed' || context.outcome === 'rate-limited' && outcome === 'rejected') return;
    context.outcome = outcome;
    context.reason = reason;
}

export function getCommandOutcome(): { outcome: CommandOutcome; reason?: string } {
    const context = contexts.getStore();
    return { outcome: context?.outcome ?? 'completed', reason: context?.reason };
}

export function addLogContextFields(fields: LogFields): void {
    const context = contexts.getStore();
    if (context) Object.assign(context.fields, fields);
}

export function getLogContextFields(): LogFields {
    return { ...contexts.getStore()?.fields };
}

/** Prevent an upstream error from echoing user input into its message or stack. */
export function registerSensitiveText(value: string): void {
    if (value) contexts.getStore()?.sensitiveValues.push(value);
}

function diagnosticProperty(value: object, key: string): unknown {
    try {
        return (value as Record<string, unknown>)[key];
    } catch {
        return undefined;
    }
}

export function sanitizeLogValue(value: string, maximum = 1_000, sensitiveValues: readonly string[] = []): string {
    let result = value;
    const credentials = Object.entries(process.env)
        .filter(([key, entry]) => entry && /TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PLACEHOLDER/i.test(key))
        .map(([, entry]) => entry!);
    for (const secret of [...credentials, ...sensitiveValues]) {
        if (secret) result = result.split(secret).join('[redacted]');
    }
    result = result.replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
        try {
            const url = new URL(raw);
            return `${url.protocol}//${url.host}${url.pathname}${url.search ? '?[redacted]' : ''}${url.hash ? '#[redacted]' : ''}`;
        } catch {
            return '[redacted URL]';
        }
    }).replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]');
    return result
        .replace(/\r\n|\r|\n/g, '\\n')
        .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
        .slice(0, maximum);
}

/** Only inspect diagnostic fields, never an SDK's request, response, or resource. */
export function serializeError(value: unknown, sensitiveValues: readonly string[] = [], seen = new WeakSet<object>(), depth = 0): LogFields {
    if (depth >= 3) return { message: '[cause limit]' };
    if (typeof value !== 'object' || value === null) {
        return { name: 'NonError', message: sanitizeLogValue(typeof value === 'function' ? '[non-Error function]' : String(value), 500, sensitiveValues) };
    }
    if (seen.has(value)) return { message: '[circular cause]' };
    seen.add(value);
    const result: LogFields = {};
    for (const key of ['name', 'message', 'stack', 'code', 'status', 'statusCode', 'exitCode', 'signal']) {
        const entry = diagnosticProperty(value, key);
        if (typeof entry === 'string') result[key] = sanitizeLogValue(entry, key === 'stack' ? 8_000 : 500, sensitiveValues);
        else if (typeof entry === 'number' && Number.isFinite(entry) || entry === null) result[key] = entry;
    }
    result.name ??= value instanceof Error ? 'Error' : 'NonError';
    result.message ??= '[non-Error object]';
    const stderrValue = diagnosticProperty(value, 'stderr');
    if (Buffer.isBuffer(stderrValue)) {
        const stderr = stderrValue.toString('utf8');
        result.diagnostic = sanitizeLogValue(stderr, 2_000, sensitiveValues);
        const status = stderr.match(/\bHTTP(?:\s+Error|\/\d(?:\.\d)?)?\s*[: ]\s*(\d{3})\b/i);
        if (status) result.httpStatus = Number(status[1]);
    }
    const cause = diagnosticProperty(value, 'cause');
    if (cause !== undefined) result.cause = serializeError(cause, sensitiveValues, seen, depth + 1);
    return result;
}

function sanitizeFields(fields: LogFields, sensitiveValues: readonly string[], seen = new WeakSet<object>(), depth = 0): LogFields {
    if (depth >= 4 || seen.has(fields)) return { omitted: '[nested/circular fields]' };
    seen.add(fields);
    const result: LogFields = {};
    for (const [key, value] of Object.entries(fields).slice(0, 30)) {
        if (forbiddenField.test(key) || value === undefined) continue;
        const safeKey = sanitizeLogValue(key, 80, sensitiveValues);
        if (key === 'error' || value instanceof Error) result[safeKey] = serializeError(value, sensitiveValues);
        else if (typeof value === 'string') result[safeKey] = sanitizeLogValue(value, 1_000, sensitiveValues);
        else if (typeof value === 'boolean' || value === null || typeof value === 'number' && Number.isFinite(value)) result[safeKey] = value;
        else if (Array.isArray(value)) result[safeKey] = value.slice(0, 20).map(item => (
            typeof item === 'string' ? sanitizeLogValue(item, 500, sensitiveValues) :
                typeof item === 'number' || typeof item === 'boolean' ? item : '[omitted]'
        ));
        else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
            result[safeKey] = sanitizeFields(value as LogFields, sensitiveValues, seen, depth + 1);
        }
    }
    return result;
}

export interface LoggerOptions {
    level?: string;
    format?: string;
    fields?: LogFields;
    inheritContext?: boolean;
    sink?: (level: LogLevel, line: string) => void;
    now?: () => Date;
}

const consoleSink = (level: LogLevel, line: string) => {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
};

export class Logger {
    private readonly level: LogLevel;
    private readonly format: LogFormat;
    private readonly sink: (level: LogLevel, line: string) => void;
    private readonly now: () => Date;

    public constructor(private readonly options: LoggerOptions = {}) {
        const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
        const format = options.format ?? process.env.LOG_FORMAT ?? 'pretty';
        this.level = Object.hasOwn(levels, level) ? level as LogLevel : 'info';
        this.format = format === 'pretty' || format === 'json' ? format : 'pretty';
        this.sink = options.sink ?? consoleSink;
        this.now = options.now ?? (() => new Date());
        if (this.level !== level || this.format !== format) {
            this.write('warn', 'logging.invalid_config', 'Invalid logging settings; using defaults for invalid values.', {
                configuredLevel: level, configuredFormat: format, levelUsed: this.level, formatUsed: this.format
            }, true);
        }
    }

    public child(fields: LogFields, options: { inheritContext?: boolean } = {}): Logger {
        return new Logger({ ...this.options, level: this.level, format: this.format, sink: this.sink, now: this.now,
            fields: { ...this.options.fields, ...fields }, inheritContext: options.inheritContext ?? this.options.inheritContext });
    }

    public debug(event: string, message: string, fields: LogFields = {}): void { this.write('debug', event, message, fields); }
    public info(event: string, message: string, fields: LogFields = {}): void { this.write('info', event, message, fields); }
    public warn(event: string, message: string, fields: LogFields = {}): void { this.write('warn', event, message, fields); }
    public error(event: string, message: string, fields: LogFields = {}): void { this.write('error', event, message, fields); }

    private write(level: LogLevel, event: string, message: string, fields: LogFields, force = false): void {
        if (!force && levels[level] < levels[this.level]) return;
        const context = this.options.inheritContext === false ? undefined : contexts.getStore();
        const sensitiveValues = context?.sensitiveValues ?? [];
        const record = {
            ...sanitizeFields({ component: 'bot', ...context?.fields, ...this.options.fields, ...fields }, sensitiveValues),
            timestamp: this.now().toISOString(), level,
            event: sanitizeLogValue(event, 100, sensitiveValues),
            message: sanitizeLogValue(message, 1_000, sensitiveValues)
        };
        const { timestamp, level: severity, event: name, message: text, ...details } = record;
        const line = this.format === 'json' ? JSON.stringify(record) :
            `${timestamp} ${severity.toUpperCase()} ${name} ${text} ${JSON.stringify(details)}`;
        this.sink(level, line);
    }
}

export const logger = new Logger();
