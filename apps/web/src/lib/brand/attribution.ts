/**
 * Who made JooEvents, and the notices that travel with it.
 *
 * Two identities, two jobs. **JooEvents** is the product and owns every working
 * surface — tables, queues, schedules, the review lane. **Bowlboy** is the maker
 * and owns only the edges: the signature under the sign-in panel, the portal's
 * closing line, and the About panel. An organizer working under time pressure
 * never reads a maker's name twice, and never reads one at all inside the task.
 *
 * Every string the product says about its maker is declared here, so the volume
 * is set in one file. Turn a single placement down with a `false` in
 * `ATTRIBUTION_PLACEMENT`; remove the maker from the product entirely by setting
 * all three to `false`, which leaves no import to unpick.
 */

/** The rights holder, exactly as registered. Must match LICENSE and NOTICE. */
export const COPYRIGHT_HOLDER = 'JooCorp Private Limited';
export const COPYRIGHT_YEAR = '2026';

/** Chrome carries the short form; About carries the registered name in full. */
export const COPYRIGHT_SHORT = `© ${COPYRIGHT_YEAR} JooCorp`;
export const COPYRIGHT_FULL = `© ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}`;

export const LICENSE_NAME = 'JooEvents Community and Small Organization License 1.0';

/**
 * "Source available", not "open source": the license is not OSI-approved and
 * gates production use by organization size. The distinction is the licensing
 * doc's own wording and the product must not contradict it.
 */
export const LICENSE_POSTURE = 'Source available';

/**
 * The public repository. Left `null` until the canonical URL exists — a link in
 * the sign-in footer that 404s costs more trust than the missing link saves, so
 * every placement omits its source link while this is null rather than guessing
 * one. Setting it here lights up all three at once.
 */
export const SOURCE_URL: string | null = null;

export const MAKER = {
	name: 'Bowlboy',
	/** The phrase that does the brand work at the edges. Reads as a byline. */
	signature: 'A Bowlboy project',
	/**
	 * X is the account the maker wants found, so it is the one link that appears
	 * outside About. GitHub stays in About: someone reading the About panel is
	 * looking for the source, and someone signing in is not.
	 */
	x: {
		handle: '@thebowlboy',
		href: 'https://x.com/thebowlboy',
		/** Names the destination, since the visible label is only a handle. */
		label: 'Bowlboy on X (@thebowlboy)'
	},
	github: {
		handle: 'thebowlboy',
		href: 'https://github.com/thebowlboy',
		label: 'Bowlboy on GitHub'
	}
} as const;

/**
 * Where the maker signature is allowed to appear.
 *
 * `entry` — under the sign-in panel, below the task, carrying the X link.
 * `portal` — the participant portal's closing line, text only.
 * `about` — Settings → About, the one place that carries every link.
 *
 * Deliberately absent, and not switches to be added later: operator working
 * surfaces, hosted public surfaces under `/s`, and embeds. A visitor arriving on
 * an organizer's speaker form is not a user of this product, and an embed sits
 * inside a page that belongs to someone else.
 */
export const ATTRIBUTION_PLACEMENT = {
	entry: true,
	portal: true,
	about: true
} as const;
