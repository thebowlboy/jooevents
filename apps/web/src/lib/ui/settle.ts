/**
 * Defers an action until typing stops.
 *
 * A field that acts on every keystroke spends a round trip per character and
 * writes the address the same number of times; one that acts only on blur makes
 * the reader commit before they can see whether the query worked. Settling is
 * the middle: the action runs once, shortly after the last keystroke.
 *
 * The delay is deliberately `PENDING_GRACE_MS`. That is the threshold below
 * which a completed wait must leave no trace on screen, so a search that
 * settles there and answers quickly never shows a waiting treatment at all —
 * the rows simply become the right rows. Choosing any other number would put a
 * flicker where the quality standard says there must be none.
 */

import { PENDING_GRACE_MS } from './pending.svelte';

export interface Settler {
	/** Replaces any pending action and restarts the timer. */
	schedule(run: () => void): void;
	/** Runs a pending action now. Safe to call with nothing pending. */
	flush(): void;
	/** Drops a pending action without running it. */
	cancel(): void;
}

/**
 * A settle timer with an owned handle.
 *
 * The handle is owned rather than fire-and-forget because a superseded action
 * that still runs is how a stale query lands after a fresh one — the classic
 * shape of a search box that shows results for a word the person already
 * deleted. `cancel` on teardown is the caller's responsibility.
 */
export function createSettler(delayMs: number = PENDING_GRACE_MS): Settler {
	let handle: ReturnType<typeof setTimeout> | undefined;
	let pending: (() => void) | undefined;

	function clear() {
		if (handle !== undefined) clearTimeout(handle);
		handle = undefined;
		pending = undefined;
	}

	return {
		schedule(run: () => void) {
			if (handle !== undefined) clearTimeout(handle);
			pending = run;
			handle = setTimeout(() => {
				const run = pending;
				clear();
				run?.();
			}, delayMs);
		},
		flush() {
			const run = pending;
			clear();
			run?.();
		},
		cancel: clear
	};
}
