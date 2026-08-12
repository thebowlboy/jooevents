/**
 * Where a list surface answers from: the server, or a resident copy of its own
 * scope.
 *
 * Both answers must be the same answer. That is the whole point of putting them
 * behind one seam — a feature calls `list(query)` and never learns which side
 * served it, so the choice can be made per deployment, per surface, or reversed
 * later without touching the surface.
 *
 * ## Why the choice is worth having
 *
 * A working list scoped to one event is small. Measured on realistic prose with
 * ~1 500-character abstracts: 500 submissions is ~200 KB gzipped and parses in
 * about a millisecond; 2 000 is ~0.8 MB. Below that ceiling, holding the scope
 * makes every subsequent interaction — search, filter, sort, tray switch —
 * local and instant, and spends zero round trips. Paginating that size is
 * paying latency to save bandwidth nobody needed.
 *
 * Above it the arithmetic turns: 5 000 submissions is ~2 MB gzipped, which is
 * a multi-second first paint on a slow link. So residency has a ceiling, and
 * the ceiling is enforced by whoever loads the scope rather than guessed here.
 *
 * ## Why it is not simply the default
 *
 * Two constraints, and only the first is about size.
 *
 * 1. **Authorization.** Field visibility and anonymization are applied inside
 *    the query so that no consumer can read around them. A resident copy that
 *    the client filters is exactly reading around them: not rendering a row is
 *    not a control when the row is in the browser. Surfaces under the
 *    peer-content gate therefore pass `allowResident: false`, which this module
 *    treats as absolute — it is not a preference the residency setting can
 *    override, because a config mistake there is a disclosure.
 * 2. **Staleness.** A snapshot is only true until someone else commits, and in
 *    this product agents commit too — a single human user is not a single
 *    writer. Snapshots carry a version and a mutation invalidates them.
 */

/** Which side answered, or should. */
export type Residency = 'resident' | 'paged';

/**
 * Rows above which a scope is not held.
 *
 * Set from the transfer cost, measured on realistic prose: at ~2 000 rows a
 * submission scope is around 0.8 MB gzipped — still under a second on a slow
 * link, and paid once. At 5 000 it is ~2 MB and several seconds, which is too
 * much to spend before first paint. A loader is free to use a different number;
 * this is the default, not a rule.
 */
export const RESIDENT_ROW_CEILING = 2000;

/** A loaded scope, or a report that it was too large to hold. */
export interface ResidentLoad<Row> {
	readonly rows: readonly Row[];
	/**
	 * False when the scope exceeded its ceiling and was not fully loaded.
	 *
	 * A partial load must never be treated as a scope: filtering it would answer
	 * "3 matches" from rows that are a fraction of the population, which is the
	 * same class of untruth as an empty state claiming absence. The source
	 * discards it and serves that scope from the server instead.
	 */
	readonly complete: boolean;
	/** Changes whenever anything in the scope changes. */
	readonly version: string;
}

export interface ListPorts<Row, Query, Page> {
	/**
	 * Which population this query belongs to — everything the query selects
	 * *between*, never what it filters *within*. Getting this wrong is the one
	 * real hazard: too coarse and a resident answer omits rows; too fine and the
	 * snapshot is discarded on every keystroke, which is pagination wearing a
	 * cache's clothes.
	 */
	scopeKey(query: Query): string;
	/** Loads a whole scope, or reports that it is too large to hold. */
	loadScope(query: Query): Promise<ResidentLoad<Row>>;
	/** Answers one query at the server. */
	queryServer(query: Query): Promise<Page>;
	/**
	 * Answers one query from resident rows.
	 *
	 * This must agree with `queryServer` — same rows, same order, same counts.
	 * The way to guarantee it is to share the code that decides, rather than to
	 * write the rule twice and test that two implementations still match.
	 */
	applyLocally(rows: readonly Row[], query: Query): Page;
}

export interface ListSource<Query, Page> {
	list(query: Query): Promise<Page>;
	/** What the last completed call actually used. */
	lastMode(): Residency;
	/** Why residency was declined, when it was. Null when nothing declined it. */
	declinedReason(): string | null;
	/** Drops any snapshot; the next read reloads. Call after a mutation. */
	invalidate(): void;
}

export interface ListSourceOptions {
	/** Read per call, so the mode can be switched without rebuilding anything. */
	residency: () => Residency;
	/**
	 * Whether this surface may hold rows at all. Defaults to true.
	 *
	 * `false` is a structural refusal for surfaces whose rows are filtered by
	 * authority — it outranks the residency setting rather than being weighed
	 * against it.
	 */
	allowResident?: boolean;
}

interface Snapshot<Row> {
	readonly key: string;
	readonly rows: readonly Row[];
	readonly version: string;
}

export function createListSource<Row, Query, Page>(
	ports: ListPorts<Row, Query, Page>,
	options: ListSourceOptions
): ListSource<Query, Page> {
	const allowResident = options.allowResident !== false;

	let snapshot: Snapshot<Row> | null = null;
	/** Scopes proven too large to hold; they stay on the server for this session. */
	const unholdable = new Set<string>();
	/** In-flight loads per scope, so a burst of queries causes one fetch. */
	const loading = new Map<string, Promise<ResidentLoad<Row>>>();
	let mode: Residency = 'paged';
	let declined: string | null = allowResident
		? null
		: 'This surface filters by authority, so its rows are never held client-side.';

	async function loadOnce(key: string, query: Query): Promise<ResidentLoad<Row>> {
		const existing = loading.get(key);
		if (existing) return existing;
		const pending = ports.loadScope(query).finally(() => loading.delete(key));
		loading.set(key, pending);
		return pending;
	}

	async function list(query: Query): Promise<Page> {
		const key = ports.scopeKey(query);

		if (!allowResident || options.residency() === 'paged' || unholdable.has(key)) {
			mode = 'paged';
			return ports.queryServer(query);
		}

		// A different population is a different snapshot; the old one is not a
		// subset of the new one and must not be filtered as if it were.
		if (snapshot && snapshot.key !== key) snapshot = null;

		if (!snapshot) {
			const loaded = await loadOnce(key, query);
			if (!loaded.complete) {
				unholdable.add(key);
				declined = 'This scope is larger than a resident copy may hold, so it is served per query.';
				mode = 'paged';
				return ports.queryServer(query);
			}
			// A concurrent call may have landed a snapshot for this same scope
			// already; either is equally valid, so the first one wins and the
			// second is dropped rather than replacing it mid-read.
			snapshot ??= { key, rows: loaded.rows, version: loaded.version };
		}

		mode = 'resident';
		return ports.applyLocally(snapshot.rows, query);
	}

	return {
		list,
		lastMode: () => mode,
		declinedReason: () => declined,
		invalidate() {
			snapshot = null;
		}
	};
}
