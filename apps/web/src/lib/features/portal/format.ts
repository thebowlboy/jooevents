/**
 * Time as the person reading it needs it: an instant they can write down, and
 * the distance from now to that instant. Neither half works alone — a date with
 * no distance makes someone do arithmetic, and a countdown with no date leaves
 * nothing to put in a calendar — so a deadline always carries both, in the
 * event's own timezone rather than the reader's.
 *
 * Every date the portal shows comes from here, in one shape: month, day, and
 * then either a clock with its zone or the year. Two spellings of the same
 * moment on one page make a reader check whether they are the same moment.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function partsOf(
	iso: string,
	timezone: string,
	options: Intl.DateTimeFormatOptions
): Record<string, string> | null {
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return null;
	const formatted = new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options }).formatToParts(
		new Date(at)
	);
	const collected: Record<string, string> = {};
	for (const part of formatted) collected[part.type] = part.value;
	return collected;
}

/** `Sep 20, 23:59 EDT` — short enough to sit inside a sentence. */
export function formatInstant(iso: string, timezone: string): string {
	const parts = partsOf(iso, timezone, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZoneName: 'short'
	});
	if (!parts) return iso;
	return `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/**
 * `Sep 20, 2026` — for a date whose time of day carries no meaning.
 *
 * Same month-first shape as an instant, so a page that shows both reads as one
 * voice: the only difference between them is what the day is followed by.
 */
export function formatDay(iso: string, timezone: string): string {
	const parts = partsOf(iso, timezone, { day: 'numeric', month: 'short', year: 'numeric' });
	if (!parts) return iso;
	return `${parts.month} ${parts.day}, ${parts.year}`;
}

/**
 * `in 12 days`, `8 days ago`, `today`. The unit is chosen by distance so the
 * phrase stays one a person can hold: hours near the deadline, days for the
 * ordinary case, months once precision stops meaning anything.
 */
export function formatRelative(iso: string, now: number): string {
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return '';
	const difference = at - now;
	const size = Math.abs(difference);
	const sign = difference < 0 ? -1 : 1;

	if (size < MINUTE) return 'just now';
	if (size < HOUR) return relative.format(sign * Math.round(size / MINUTE), 'minute');
	if (size < DAY) return relative.format(sign * Math.round(size / HOUR), 'hour');
	if (size < MONTH) return relative.format(sign * Math.round(size / DAY), 'day');
	return relative.format(sign * Math.round(size / MONTH), 'month');
}

/** The deadline sentence the portal uses everywhere: `Sep 20, 23:59 EDT — in 12 days`. */
export function formatDeadline(iso: string, timezone: string, now: number): string {
	const distance = formatRelative(iso, now);
	const instant = formatInstant(iso, timezone);
	return distance ? `${instant} — ${distance}` : instant;
}

/** File sizes as a person judges them: two significant figures, never bytes. */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '';
	if (bytes < 1000) return `${Math.round(bytes)} B`;
	const units = ['kB', 'MB', 'GB'];
	let value = bytes / 1000;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
