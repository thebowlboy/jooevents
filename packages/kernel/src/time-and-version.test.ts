import { expect, test } from 'bun:test';
import {
  parseAggregateVersion,
  parseContractVersion,
  parsePolicyVersion
} from './versions';
import { parseIanaTimezone, parseInstant } from './time';

test('positive versions reject zero, fractions, unsafe integers, and strings', () => {
  expect(Number(parseAggregateVersion(1))).toBe(1);
  expect(Number(parsePolicyVersion(7))).toBe(7);
  expect(Number(parseContractVersion(2))).toBe(2);

  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    expect(() => parseAggregateVersion(value)).toThrow();
  }
});

test('UTC instants normalize millisecond precision and reject ambiguous time forms', () => {
  expect(String(parseInstant('2026-08-11T06:04:03Z'))).toBe('2026-08-11T06:04:03.000Z');
  expect(String(parseInstant('2024-02-29T23:59:59.1Z'))).toBe('2024-02-29T23:59:59.100Z');

  for (const value of [
    '2026-08-11T14:04:03+08:00',
    '2026-02-29T00:00:00Z',
    '2026-08-11 06:04:03Z',
    '2026-08-11T06:04:03.1234Z',
    '2026-08-11T06:04:60Z'
  ]) {
    expect(() => parseInstant(value)).toThrow();
  }
});

test('IANA timezone parsing returns the runtime canonical identity', () => {
  expect(String(parseIanaTimezone('Asia/Singapore'))).toBe('Asia/Singapore');
  expect(String(parseIanaTimezone('UTC'))).toBe('UTC');

  for (const value of ['', ' Asia/Singapore', '+08:00', 'Singapore', 'Mars/Olympus']) {
    expect(() => parseIanaTimezone(value)).toThrow();
  }
});
