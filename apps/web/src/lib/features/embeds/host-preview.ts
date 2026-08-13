import type { EventTheme } from '$lib/api/types';

/**
 * The stranger's website — the ground an embed is judged against.
 *
 * A preview that renders an embed on the product's own canvas answers the wrong
 * question. What an organizer is deciding is how it will sit on *their* page,
 * which has typography and ink of its own, so the simulation commits to a
 * specific look that is neither this app's nor the event's. Anything less and
 * "match my site" has nothing to match.
 */
const HOST_CANVAS = '#f4f5f7';
const HOST_SURFACE = '#ffffff';
const HOST_INK = '#1f2933';

/**
 * The host page's own custom properties, applied to the simulation's root.
 * Serif body text is a deliberate choice: it is unmistakably not the product's
 * sans, so a person can tell at a glance which of the two modes is showing.
 */
export const HOST_TYPE = [
	`--host-canvas: ${HOST_CANVAS}`,
	`--host-surface: ${HOST_SURFACE}`,
	`--host-ink: ${HOST_INK}`,
	'--host-font: Georgia, "Times New Roman", serif'
].join('; ');

/**
 * The event's brand as a host page's cascade would deliver it.
 *
 * `match-site` is not a second renderer and not a second stylesheet — it is the
 * same surface with the host's ground, ink, and typography substituted for the
 * event's. That is exactly what a shadow root produces when the embed leaves
 * `color` and `font-family` undeclared at its root and lets the host's cascade
 * through: inherited properties cross the boundary, everything else does not.
 *
 * Expressing it as a derived recipe rather than as per-renderer CSS is what
 * makes it free: every public surface already consumes the same semantic tokens,
 * so all three of them honour this control without knowing it exists, and a
 * fourth surface built later inherits the behaviour by construction.
 *
 * What deliberately does *not* change is everything structural — the action
 * colour, radii, control height, spacing, and the layout itself. Those are the
 * event's decisions, and a visitor who recognizes the schedule on a partner's
 * site is recognizing them.
 */
export function hostThemeFor(theme: EventTheme): EventTheme {
	return { ...theme, canvas: HOST_CANVAS, surface: HOST_SURFACE, text: HOST_INK };
}
