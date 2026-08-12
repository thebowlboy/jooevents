import type { Brand } from './brand';

export type Instant = Brand<string, 'Instant'>;
export type UtcInstant = Instant;
export type IanaTimezone = Brand<string, 'IanaTimezone'>;

const UTC_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/** Parses an RFC 3339 UTC instant and normalizes it to millisecond precision. */
export function parseInstant(value: unknown): Instant {
  if (typeof value !== 'string') throw new TypeError('instant must be a UTC string');
  const match = UTC_INSTANT.exec(value);
  if (!match) throw new TypeError('instant must use RFC 3339 UTC form');

  const milliseconds = (match[7] ?? '').padEnd(3, '0') || '000';
  const canonical = `${value.slice(0, 19)}.${milliseconds}Z`;
  const parsed = new Date(canonical);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonical) {
    throw new TypeError('instant is not a real UTC calendar instant');
  }
  return canonical as Instant;
}

export const parseUtcInstant = parseInstant;

/** Validates and returns the runtime's canonical IANA timezone identity. */
export function parseIanaTimezone(value: unknown): IanaTimezone {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError('timezone must be a non-empty IANA identity');
  }
  if (value !== 'UTC' && !value.includes('/')) {
    throw new TypeError('timezone must be UTC or an area/location IANA identity');
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone;
    return canonical as IanaTimezone;
  } catch {
    throw new TypeError('timezone must be a recognized IANA identity');
  }
}

export interface Clock {
  now(): Instant;
}
