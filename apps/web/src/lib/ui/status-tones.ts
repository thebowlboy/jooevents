/**
 * The product's status *tone* vocabulary: one state, one loudness, everywhere.
 *
 * `status-icons.ts` already settled "one meaning, one symbol". This is the
 * other half of the same rule and it exists because the missing half produced
 * a real defect: "Result not sent" rendered as a soft amber badge on Submissions
 * and a solid amber badge on Decisions — one fact wearing two loudnesses on
 * two surfaces, so a reader who learned it in one place mis-ranked it in the
 * other. Seven of the solid ones then stacked into a single column beside a
 * solid primary button, which is three accent-dominant elements in one region
 * where the budget is one.
 *
 * Five tones, and only five:
 *
 * | Tone       | Means                                   | Example              |
 * | ---------- | --------------------------------------- | -------------------- |
 * | `positive` | resolved well, nothing owed             | Accepted, Confirmed  |
 * | `negative` | resolved against, or failed             | Declined, Bounced    |
 * | `caution`  | open and waiting on someone             | Waitlisted, Overdue  |
 * | `info`     | true and worth knowing, not actionable  | Invited, Scheduled   |
 * | `neutral`  | no answer yet, or not applicable        | No decision, Waived  |
 *
 * Tone is a property of the *state*. Emphasis is not: whether a badge renders
 * solid is a decision about the region it sits in, governed by the
 * accent-budget rule, and a whole column of solid badges is always wrong. That
 * is why this map carries no `emphasis` field — there is nowhere to put the
 * answer, because the state does not have one.
 *
 * Colour is never the only carrier. Every consumer still renders the word, and
 * `badgeFor` hands back the glyph alongside the tone so the two channels stay
 * attached to each other rather than being chosen independently per surface.
 */

import { statusIcon, type IconComponent, type StatusIconKey } from './status-icons';

export type StatusTone = 'positive' | 'negative' | 'caution' | 'info' | 'neutral';

/**
 * The tone every keyed state renders in. Exhaustive over `StatusIconKey` by
 * construction: a state that gains a symbol must also declare its loudness,
 * or the type stops compiling.
 */
export const statusTone: Record<StatusIconKey, StatusTone> = {
	// Submission decision outcomes. Waitlisted is caution rather than neutral
	// because it is an open obligation: somebody is still waiting on an answer.
	accepted: 'positive',
	waitlisted: 'caution',
	declined: 'negative',
	withdrawn: 'neutral',
	unnotified: 'caution',

	// Speaker engagement lifecycle. The canonical mapping of the design record:
	// invited = info, confirmed = positive, cancellation requested = negative,
	// cancelled = neutral (it is a settled fact, not a live problem).
	invited: 'info',
	confirmed: 'positive',
	cancelRequested: 'negative',
	cancelled: 'neutral',

	// Public visibility.
	published: 'positive',
	unpublished: 'neutral',

	// Communication lifecycle.
	draft: 'neutral',
	scheduled: 'info',
	sending: 'info',
	sent: 'positive',
	held: 'caution',
	delivered: 'positive',
	bounced: 'negative',

	// Email delivery readiness.
	ready: 'positive',
	actionRequired: 'caution',
	notChecked: 'neutral',
	notConfigured: 'neutral',

	// Speaker task states.
	complete: 'positive',
	received: 'positive',
	lateComplete: 'positive',
	waived: 'neutral',
	overdue: 'negative',
	notStarted: 'neutral',

	// Form status.
	formOpen: 'positive',
	formClosed: 'neutral',

	// Review coverage.
	needsReviewer: 'caution',

	// Schedule conflict severity.
	blocking: 'negative',
	warning: 'caution',

	// Attention-rail priority.
	actNow: 'negative',
	soon: 'caution',
	fyi: 'info'
};

/**
 * The CSS tone class each vocabulary word resolves to. The vocabulary is what
 * product code says; these are the families the palette already carries, and
 * keeping the indirection means "caution" can be retuned in one place without
 * a search-and-replace across every surface that renders a waiting state.
 */
export const statusToneClass: Record<StatusTone, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> =
	{
		positive: 'success',
		negative: 'danger',
		caution: 'warning',
		info: 'info',
		neutral: 'neutral'
	};

export interface StatusPresentation {
	tone: StatusTone;
	icon: IconComponent;
}

/**
 * Everything a badge needs for a keyed state, from one lookup.
 *
 * ```svelte
 * <Badge {...badgeFor('waitlisted')} value="Waitlisted" />
 * ```
 *
 * Taking the tone and the glyph together is the point: picked separately they
 * drift, and a state with the right symbol in the wrong colour is harder to
 * unlearn than one with neither.
 */
export function badgeFor(key: StatusIconKey): StatusPresentation {
	return { tone: statusTone[key], icon: statusIcon[key] };
}
