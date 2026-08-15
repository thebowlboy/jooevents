/**
 * The portal's four date names, each one call into the product's single date
 * vocabulary (`@jooevents/contracts`). The module survives its own formatters
 * because nine portal components already reach for these names; what it no
 * longer holds is a second opinion about how a date is spelled.
 *
 * That opinion is what made it worth deleting. The portal used to say
 * `Sep 20, 23:59 EDT` while the operator sidebar said `Mar 18–20, 2027`, the
 * schedule said `Thu Mar 18`, and the public confirmation said
 * `March 18, 2027 at 11:30 PM` — four spellings of one product. A speaker and
 * an organizer discussing the same deadline now read the same bytes.
 *
 * The zone is still the event's rather than the reader's, and a deadline still
 * carries the instant and the distance together: a date with no distance makes
 * someone do arithmetic, and a countdown with no date leaves nothing to put in
 * a calendar.
 */

import {
	describeDeadline,
	formatInstant as formatZonedInstant,
	formatInstantDate,
	formatRelative as formatZonedRelative
} from '@jooevents/contracts';

/** `20 Sep 2026 · 23:59 EDT` — short enough to sit inside a sentence. */
export function formatInstant(iso: string, timezone: string): string {
	return formatZonedInstant(iso, timezone, { zone: true, fallback: 'Not recorded' });
}

/**
 * `20 Sep 2026` — for a date whose time of day carries no meaning.
 *
 * The calendar day is the one the *event* is having, so a speaker submitting
 * from Auckland at 09:00 does not see a send-date a day ahead of the organizer
 * reviewing it.
 */
export function formatDay(iso: string, timezone: string): string {
	return formatInstantDate(iso, timezone, { fallback: 'Not recorded' });
}

/**
 * `in 12 days`, `8 days ago`, `today`. The unit is chosen by distance so the
 * phrase stays one a person can hold: clock units near the deadline, days for
 * the ordinary case, weeks and months once precision stops meaning anything.
 *
 * The zone is required rather than optional because "today" is a claim about a
 * particular midnight, and the portal is read from every timezone there is.
 */
export function formatRelative(iso: string, timezone: string, now: number): string {
	return formatZonedRelative(iso, now, { timezone, fallback: 'Not recorded' });
}

/** The deadline sentence the portal uses everywhere: `Mon 20 Sep 2026 · 23:59 EDT — in 12 days`. */
export function formatDeadline(iso: string, timezone: string, now: number): string {
	return describeDeadline({ at: iso, timezone, now })?.text ?? 'No deadline set';
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
