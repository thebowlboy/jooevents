/**
 * Track accents: telling a programme's categories apart.
 *
 * The surfaces shipped with three: lavender, sea, and "neutral". Neutral is
 * not a colour, it is the absence of one, so a three-track palette is really
 * two — and every track past the second one collided. On the live playground
 * the collision was invisible only because no submission carried a track at
 * all; the moment one does, a nine-row column resolves into two hues and the
 * reader learns that the colour means nothing.
 *
 * Eight families, hue-separated and deliberately equal in lightness. Equal
 * lightness is the design decision that keeps this differentiation rather than
 * decoration: no track outshines its neighbours, so the accent says *which*
 * without also claiming *how important*, and the surface's one accent-dominant
 * element is still free for the thing that earned it.
 *
 * They render through `.ui-track`, never `.ui-badge`. A category and a state
 * are different kinds of fact, and giving them the same pill silhouette in
 * overlapping hues is how an amber track starts reading as a warning.
 */

/** How many accents the palette carries. Adding one means adding its tokens. */
export const TRACK_ACCENT_COUNT = 8;

/** `1`–`8`; the suffix of `.ui-track--N` and of the `--je-color-track-N-*` pair. */
export type TrackAccent = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * The measured palette, kept beside the code that uses it so the contrast
 * claim is testable rather than remembered. `soft` is the chip fill, `ink` is
 * its text; `unit-test`ed at >= 4.5:1 against the fill, against `surface`
 * (#ffffff) and against `page` (#f5f2ee), which are the three grounds a track
 * chip is ever drawn on. They do not move with the event theme — track tokens
 * are absent from `publicThemeTokens` on purpose, so a themed event cannot
 * re-derive its categories out of its own action colour.
 */
export const trackAccentPalette: readonly { accent: TrackAccent; name: string; soft: string; ink: string }[] =
	[
		{ accent: 1, name: 'lavender', soft: '#ece7f6', ink: '#57497a' },
		{ accent: 2, name: 'sea', soft: '#daedee', ink: '#2f6165' },
		{ accent: 3, name: 'indigo', soft: '#e3e8f7', ink: '#3f4e86' },
		{ accent: 4, name: 'plum', soft: '#f4e5f1', ink: '#7a3d6d' },
		{ accent: 5, name: 'olive', soft: '#e7edda', ink: '#4f6127' },
		{ accent: 6, name: 'sand', soft: '#f5e9d7', ink: '#74551f' },
		{ accent: 7, name: 'rose', soft: '#fae2e7', ink: '#8f3a53' },
		{ accent: 8, name: 'cocoa', soft: '#eee6df', ink: '#6b5344' }
	];

/**
 * A stable, order-preserving hash. Used only when a caller cannot supply the
 * programme's own track order.
 */
function fold(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/**
 * Which accent a track wears.
 *
 * **Prefer passing `order`** — the event's own track list. Position in that
 * list walks the palette from the top, so a programme with eight or fewer
 * tracks gets eight distinct accents by construction, and the same track wears
 * the same colour on Submissions, Decisions, the schedule, and the public
 * programme, because they all read the same list.
 *
 * Without `order` the accent is hashed from the id: stable across renders and
 * across surfaces, but two tracks can collide. That is the fallback, not the
 * design — a collision is not a bug in the hash, it is a caller that did not
 * know its own programme.
 *
 * Past the palette's size the accents repeat. Eight is the point at which
 * hue distinctions stop being reliable anyway; a programme with more tracks
 * than that is telling you the chip is no longer the right instrument.
 */
export function trackAccent(trackId: string, order?: readonly string[]): TrackAccent {
	const index = order?.indexOf(trackId) ?? -1;
	const slot = index >= 0 ? index : fold(trackId);
	return ((slot % TRACK_ACCENT_COUNT) + 1) as TrackAccent;
}

/** The class list for a track chip: `trackAccentClass(3)` → `ui-track ui-track--3`. */
export function trackAccentClass(accent: TrackAccent): string {
	return `ui-track ui-track--${accent}`;
}

/**
 * Whether a track value is worth rendering at all.
 *
 * The blank-pill defect began upstream of the badge: the page port minted `''`
 * for "no track", the row rendered it unconditionally, and nine empty capsules
 * shipped. A missing category is not a category — it renders nothing, and if
 * the absence itself matters the surface says so in words on the quietest rung
 * ("No track") rather than drawing an empty box.
 */
export function hasTrack(name: string | null | undefined): name is string {
	return typeof name === 'string' && name.trim().length > 0;
}
