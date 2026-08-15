import { describe, expect, test } from 'bun:test';
import { formatDay, formatDeadline, formatFileSize, formatInstant, formatRelative } from './format';

const zone = 'America/New_York';
const now = Date.parse('2026-09-08T23:59:00-04:00');

/**
 * Reads an expectation with ordinary spaces against the non-breaking bytes a
 * date actually carries, so the assertion stays legible and still proves the
 * span cannot break across two lines.
 */
const span = (text: string): string => text.replaceAll(' ', '\u00a0');

describe('portal time', () => {
	test('an instant is stated in the event timezone, named', () => {
		expect(formatInstant('2026-09-20T23:59:00-04:00', zone)).toBe(span('20 Sep 2026 · 23:59 EDT'));
	});

	test('a date with no meaningful time of day loses the clock, not the house shape', () => {
		expect(formatDay('2026-07-08T09:20:00-04:00', zone)).toBe(span('8 Jul 2026'));
		// One voice: the day is written the same way whether a clock follows it.
		expect(formatInstant('2026-07-08T09:20:00-04:00', zone)).toBe(span('8 Jul 2026 · 09:20 EDT'));
	});

	test('the event zone, not the reader’s, decides which day an instant falls on', () => {
		// 20:30 in New York on the 20th is already the 21st in Helsinki. A portal
		// read from either place must name the event's day, or two people quoting
		// the same submission quote different dates.
		expect(formatDay('2026-09-21T00:30:00Z', zone)).toBe(span('20 Sep 2026'));
		expect(formatDay('2026-09-21T00:30:00Z', 'Europe/Helsinki')).toBe(span('21 Sep 2026'));
	});

	test('distance picks the unit a person would use', () => {
		// Past a week the phrase coarsens on purpose: the exact instant is always
		// beside it, and `in 2 weeks` is the shape a person plans in.
		expect(formatRelative('2026-09-20T23:59:00-04:00', zone, now)).toBe('in 2 weeks');
		expect(formatRelative('2026-08-31T23:59:00-04:00', zone, now)).toBe('1 week ago');
		expect(formatRelative('2026-09-09T02:59:00-04:00', zone, now)).toBe('in 3 hours');
		expect(formatRelative('2026-09-08T23:19:00-04:00', zone, now)).toBe('40 minutes ago');
		expect(formatRelative('2026-09-08T23:59:20-04:00', zone, now)).toBe('just now');
	});

	test('a deadline carries both halves, because neither works alone', () => {
		// The one ordinary space in the line sits before the em dash: the absolute
		// and the distance may wrap apart, neither may wrap inside itself.
		expect(formatDeadline('2026-09-20T23:59:00-04:00', zone, now)).toBe(
			`${span('Sun 20 Sep 2026 · 23:59 EDT')} — in 2 weeks`
		);
	});

	test('an unreadable instant names its absence instead of echoing the input', () => {
		// Handing the machine string back was the defect, not the fallback: a
		// reader shown `not-a-date` learns nothing they can act on.
		expect(formatInstant('not-a-date', zone)).toBe('Not recorded');
		expect(formatDay('not-a-date', zone)).toBe('Not recorded');
		expect(formatRelative('not-a-date', zone, now)).toBe('Not recorded');
		expect(formatDeadline('not-a-date', zone, now)).toBe('No deadline set');
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
