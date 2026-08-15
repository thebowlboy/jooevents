/**
 * Arrival recency, computed from instants — never stored, never authored.
 *
 * Two different jobs share `submittedAt` and this module keeps them distinct:
 * the pulse (how recently things arrived, worded per row) and the New mark
 * (what arrived since the operator last looked). Both are pure projections;
 * the only state anywhere behind them is the per-operator surface-visit
 * rotation the port reports, and even that is read once at page entry so
 * nothing fades while a person is looking at it.
 */

import { formatRelative } from '@jooevents/contracts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The New mark's fixed floor: anything younger stays New even if seen. */
export const NEW_WINDOW_MS = 24 * HOUR;

/**
 * Instants here are ISO strings. `Date.parse` happily invents dates for prose
 * (“Jul 2” parses), so the shape is checked first — a value that is not an
 * instant must fail closed rather than land on a fictional day.
 */
function parseInstant(iso: string): number {
	if (!/^\d{4}-/.test(iso)) return NaN;
	return Date.parse(iso);
}

/**
 * The arrival fact in words, in the product's one distance vocabulary.
 *
 * It used to spell its own: `6 h ago` here, `6 hr ago` in the activity feed,
 * `in 3 hours` in the portal — three spellings of one unit on surfaces an
 * operator moves between in a single session. The unit choice and the wording
 * now come from `formatRelative`, so they cannot drift again.
 *
 * Pass the event's timezone wherever the caller has it: `today` and `yesterday`
 * are claims about a particular midnight, and without a zone the vocabulary
 * declines to make them rather than counting from the browser's.
 *
 * A relative string stops being a record of anything after a couple of days, so
 * a surface with room for it should carry the absolute beside this — that is
 * what `describeRecency` in the date vocabulary returns ready-made.
 */
export function formatArrival(iso: string, now: Date = new Date(), timezone?: string): string {
	const instant = parseInstant(iso);
	if (Number.isNaN(instant)) return 'Not recorded';
	// Clock skew and mis-authored fixtures put an arrival in the future. A thing
	// cannot have arrived later than now, so it clamps rather than counting
	// backwards at a reader who would have no idea what to do about it.
	const arrived = Math.min(instant, now.getTime());
	return formatRelative(new Date(arrived).toISOString(), now.getTime(), {
		...(timezone === undefined ? {} : { timezone }),
		fallback: 'Not recorded'
	});
}

/**
 * The New mark: arrived since the operator's previous visit to this surface,
 * OR within the last 24 hours — and it fades only when both arms have lapsed,
 * so checking five times a day never strips today's pulse and a weekend away
 * loses nothing. A first-ever visit has no “previous”, so only the 24-hour
 * arm applies and day one is not a sea of New.
 *
 * This is deliberately *not* the Overview's arrival window
 * (`@jooevents/contracts` `chooseArrivalWindow`), and the difference is the
 * point. The dashboard states a **count**, so its window has to be exactly what
 * it claims: `+1 today` means one arrived today, and a 24-hour floor would make
 * that sentence false every morning. A row mark states **freshness to this
 * reader**, where the floor is what stops a 00:20 visit from being a page with
 * nothing marked. Two questions, two windows — and because the count always
 * names its own window on screen, a row marked New that is outside today's
 * count reads as two facts rather than as a contradiction.
 */
export function isNewArrival(
	iso: string,
	previousVisit: string | null,
	now: Date = new Date()
): boolean {
	const instant = parseInstant(iso);
	if (Number.isNaN(instant)) return false;
	if (now.getTime() - instant < NEW_WINDOW_MS) return true;
	if (previousVisit === null) return false;
	const visited = parseInstant(previousVisit);
	if (Number.isNaN(visited)) return false;
	return instant > visited;
}

/**
 * How long the oldest of these arrivals has waited, in whole days — the dwell
 * fact for a group header (“oldest arrived 6 days ago”). Null when there is
 * nothing waiting or nothing parses.
 */
export function oldestWaitDays(isos: readonly string[], now: Date = new Date()): number | null {
	let oldest = Infinity;
	for (const iso of isos) {
		const instant = parseInstant(iso);
		if (!Number.isNaN(instant)) oldest = Math.min(oldest, instant);
	}
	if (oldest === Infinity) return null;
	return Math.max(0, Math.floor((now.getTime() - oldest) / DAY));
}

/** The dwell fact in words, saying nothing until it is at least a day old. */
export function oldestWaitLabel(isos: readonly string[], now: Date = new Date()): string | null {
	const days = oldestWaitDays(isos, now);
	if (days === null || days < 1) return null;
	return days === 1 ? 'oldest arrived yesterday' : `oldest arrived ${days} days ago`;
}
