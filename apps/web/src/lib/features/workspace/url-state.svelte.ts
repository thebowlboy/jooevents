/**
 * Route-scoped filter state, read from and written to the address.
 *
 * The state-ownership rule puts search, filters, sort, and the selected date in
 * the URL and leaves only open panels, hover, and local selection in component
 * runes. Keeping to it is what lets one surface hand another a *scoped* link:
 * the destination restores the filter from the address instead of asking the
 * operator to rebuild it by hand. It also makes a reload, a shared link, and an
 * agent-produced "here is what I found" all land on the same view.
 *
 * The operator console is a client-rendered static SPA, so every write here is
 * a client-side history operation: no server round-trip and no prerender
 * consequence.
 */

import { goto } from '$app/navigation';
import { page } from '$app/state';

/** A parameter set to write; `null`, `undefined`, and `''` all remove the key. */
export type ParamChanges = Record<string, string | null | undefined>;

/** The current value of a query parameter, or null when it is absent. */
export function param(key: string): string | null {
	return page.url.searchParams.get(key);
}

/**
 * A query parameter constrained to a known set. An unknown or absent value
 * reads as the fallback, so a hand-edited address degrades to the default view
 * rather than to an empty one.
 */
export function paramIn<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	const value = page.url.searchParams.get(key);
	return allowed.includes(value as T) ? (value as T) : fallback;
}

/** A present/absent marker parameter, e.g. `?compose=1`. */
export function paramFlag(key: string): boolean {
	const value = page.url.searchParams.get(key);
	return value === '1' || value === 'true';
}

/**
 * Writes query parameters onto the current address.
 *
 * `replace` is the default because a filter pass is one act of reading, not a
 * trail of destinations; `push` is for a deliberate scope change the operator
 * should be able to take back with the Back button — dismissing a scope chip is
 * the one that matters, since arriving scoped and then clearing the scope are
 * two different views of the same surface.
 *
 * Navigation never scrolls or moves focus: the row that was being read stays
 * where it is, and the control that changed the filter keeps the focus ring.
 */
export function applyParams(
	changes: ParamChanges,
	options: { history?: 'replace' | 'push' } = {}
): Promise<void> {
	const url = new URL(page.url);
	for (const [key, value] of Object.entries(changes)) {
		if (value === null || value === undefined || value === '') url.searchParams.delete(key);
		else url.searchParams.set(key, value);
	}
	if (url.search === page.url.search) return Promise.resolve();
	return goto(`${url.pathname}${url.search}`, {
		replaceState: options.history !== 'push',
		noScroll: true,
		keepFocus: true
	});
}

/** Removes parameters — the compensating write for a scoped arrival. */
export function clearParams(keys: string[], options: { history?: 'replace' | 'push' } = {}) {
	return applyParams(Object.fromEntries(keys.map((key) => [key, null])), options);
}
