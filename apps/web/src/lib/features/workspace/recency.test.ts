import { describe, expect, it } from 'bun:test';
import { formatArrival, isNewArrival, oldestWaitLabel } from './recency';

const NOW = new Date('2026-08-13T12:00:00Z');

function ago(ms: number): string {
	return new Date(NOW.getTime() - ms).toISOString();
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('formatArrival', () => {
	it('spells its units the way every other surface does', () => {
		// One vocabulary: these are the same words the activity feed and the
		// speaker portal use for the same distances.
		expect(formatArrival(ago(20 * 1000), NOW)).toBe('just now');
		expect(formatArrival(ago(38 * MINUTE), NOW)).toBe('38 minutes ago');
		expect(formatArrival(ago(2 * HOUR), NOW)).toBe('2 hours ago');
		expect(formatArrival(ago(3 * DAY), NOW)).toBe('3 days ago');
		expect(formatArrival(ago(42 * DAY), NOW)).toBe('1 month ago');
	});

	it('will not say “yesterday” until it is told whose midnight that is', () => {
		expect(formatArrival(ago(30 * HOUR), NOW)).toBe('1 day ago');
		expect(formatArrival(ago(30 * HOUR), NOW, 'America/New_York')).toBe('yesterday');
	});

	it('clamps a future instant instead of counting backwards', () => {
		expect(formatArrival(ago(-5 * MINUTE), NOW)).toBe('just now');
	});

	it('names the absence rather than handing back what it could not read', () => {
		expect(formatArrival('Jul 2', NOW)).toBe('Not recorded');
	});
});

describe('isNewArrival — new since previous visit OR within 24 h, fading only when both lapse', () => {
	it('keeps the 24-hour arm regardless of visits', () => {
		// Visited five minutes ago; a two-hour-old arrival is still New.
		expect(isNewArrival(ago(2 * HOUR), ago(5 * MINUTE), NOW)).toBe(true);
	});

	it('keeps the since-visit arm past 24 hours', () => {
		// Away for 26 hours: a 25-hour-old arrival landed after the last look.
		expect(isNewArrival(ago(25 * HOUR), ago(26 * HOUR), NOW)).toBe(true);
	});

	it('fades once seen and older than a day', () => {
		// Arrived 30 h ago, visited 26 h ago — seen it, and it is stale.
		expect(isNewArrival(ago(30 * HOUR), ago(26 * HOUR), NOW)).toBe(false);
	});

	it('first-ever visit marks only the last day', () => {
		expect(isNewArrival(ago(2 * HOUR), null, NOW)).toBe(true);
		expect(isNewArrival(ago(3 * DAY), null, NOW)).toBe(false);
	});
});

describe('oldestWaitLabel', () => {
	it('names the oldest arrival, not the newest', () => {
		expect(oldestWaitLabel([ago(2 * HOUR), ago(6 * DAY), ago(3 * DAY)], NOW)).toBe(
			'oldest arrived 6 days ago'
		);
	});

	it('says nothing until the wait is at least a day', () => {
		expect(oldestWaitLabel([ago(2 * HOUR)], NOW)).toBeNull();
		expect(oldestWaitLabel([], NOW)).toBeNull();
	});

	it('uses “yesterday” for a single day', () => {
		expect(oldestWaitLabel([ago(30 * HOUR)], NOW)).toBe('oldest arrived yesterday');
	});
});
