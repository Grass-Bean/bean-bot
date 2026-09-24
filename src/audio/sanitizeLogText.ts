export const sanitizeLogText = (value: string, maxLength: number): string => (
    value
        .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
        .trim()
        .slice(0, maxLength)
);
