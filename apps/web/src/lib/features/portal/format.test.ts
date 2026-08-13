import { describe, expect, test } from 'bun:test';
import { formatDay, formatDeadline, formatFileSize, formatInstant, formatRelative } from './format';

const zone = 'America/New_York';
const now = Date.parse('2026-09-08T23:59:00-04:00');

describe('portal time', () => {
	test('an instant is stated in the event timezone, named', () => {
		expect(formatInstant('2026-09-20T23:59:00-04:00', zone)).toBe('Sep 20, 23:59 EDT');
	});

	test('a date with no meaningful time of day loses the clock, not the house shape', () => {
		expect(formatDay('2026-07-08T09:20:00-04:00', zone)).toBe('Jul 8, 2026');
		// One voice: the day is written the same way whether a clock follows it.
		expect(formatInstant('2026-07-08T09:20:00-04:00', zone)).toBe('Jul 8, 09:20 EDT');
	});

	test('distance picks the unit a person would use', () => {
		expect(formatRelative('2026-09-20T23:59:00-04:00', now)).toBe('in 12 days');
		expect(formatRelative('2026-08-31T23:59:00-04:00', now)).toBe('8 days ago');
		expect(formatRelative('2026-09-09T02:59:00-04:00', now)).toBe('in 3 hours');
		expect(formatRelative('2026-09-08T23:19:00-04:00', now)).toBe('40 minutes ago');
		expect(formatRelative('2026-09-08T23:59:20-04:00', now)).toBe('just now');
	});

	test('a deadline carries both halves, because neither works alone', () => {
		expect(formatDeadline('2026-09-20T23:59:00-04:00', zone, now)).toBe(
			'Sep 20, 23:59 EDT — in 12 days'
		);
	});

	test('an unreadable instant degrades to what it was given', () => {
		expect(formatInstant('not-a-date', zone)).toBe('not-a-date');
		expect(formatRelative('not-a-date', now)).toBe('');
	});
});

describe('file sizes', () => {
	test('sizes read the way a person judges them', () => {
		expect(formatFileSize(0)).toBe('0 B');
		expect(formatFileSize(999)).toBe('999 B');
		expect(formatFileSize(1000)).toBe('1.0 kB');
		expect(formatFileSize(1_840_233)).toBe('1.8 MB');
		expect(formatFileSize(2_400_000_000)).toBe('2.4 GB');
	});
});
