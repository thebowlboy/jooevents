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

const MINUTE = 60_000;
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
 * The arrival fact in words: relative while it still reads as “recently”
 * (under seven days), the plain date once “ago” arithmetic would be work the
 * reader has to undo. Future instants — clock skew, a mis-authored fixture —
 * clamp to “just now” rather than counting backwards.
 */
export function formatArrival(iso: string, now: Date = new Date()): string {
	const instant = parseInstant(iso);
	if (Number.isNaN(instant)) return iso;
	const age = now.getTime() - instant;
	if (age < MINUTE) return 'just now';
	if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
	if (age < DAY) {
		const hours = Math.floor(age / HOUR);
		return `${hours} h ago`;
	}
	if (age < 7 * DAY) {
		const days = Math.floor(age / DAY);
		return days === 1 ? 'yesterday' : `${days} days ago`;
	}
	const date = new Date(instant);
	const sameYear = date.getFullYear() === now.getFullYear();
	return date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' })
	});
}

/**
 * The New mark: arrived since the operator's previous visit to this surface,
 * OR within the last 24 hours — and it fades only when both arms have lapsed,
 * so checking five times a day never strips today's pulse and a weekend away
 * loses nothing. A first-ever visit has no “previous”, so only the 24-hour
 * arm applies and day one is not a sea of New.
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
