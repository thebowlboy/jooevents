/**
 * The closed state vocabularies every speaker-shaped surface reads from.
 *
 * One meaning, one badge: the roster row, the record page, and the task matrix
 * must not spell `received` three ways or give `cancel_requested` three tones.
 * The words come from the shared status vocabulary rather than from prose
 * invented per surface, and nothing here mints a new colour.
 *
 * Recognition role: these are the page's **state** values — the closed `Badge`
 * grammar, glyph included. They are the primary scan key on a record whose
 * subject is one person, because the question is never "who" (the page already
 * answered that) but "what condition is each thing in".
 */

import { statusIcon } from '$lib/ui';
import type { IconComponent } from '$lib/ui';
import type { AssignmentState, CommunicationThreadEntry, EngagementState } from '$lib/api/types';

export interface StateBadge {
	readonly label: string;
	readonly tone: string;
	readonly solid?: boolean;
	readonly icon: IconComponent;
}

/** Where this person stands in the event. */
export const engagementStateBadge: Readonly<Record<EngagementState, StateBadge>> = Object.freeze({
	invited: { label: 'Invited', tone: 'info', solid: false, icon: statusIcon.invited },
	confirmed: { label: 'Confirmed', tone: 'success', solid: false, icon: statusIcon.confirmed },
	cancel_requested: {
		label: 'Cancellation requested',
		tone: 'danger',
		solid: true,
		icon: statusIcon.cancelRequested
	},
	declined: { label: 'Declined', tone: 'neutral', solid: false, icon: statusIcon.declined },
	cancelled: { label: 'Cancelled', tone: 'neutral', solid: false, icon: statusIcon.cancelled }
});

/** Where one deliverable stands. */
export const assignmentStateBadge: Readonly<Record<AssignmentState, StateBadge>> = Object.freeze({
	todo: { label: 'Not started', tone: 'neutral', icon: statusIcon.notStarted },
	received: { label: 'Received', tone: 'info', icon: statusIcon.received },
	complete: { label: 'Complete', tone: 'success', icon: statusIcon.complete },
	'late-complete': { label: 'Done late', tone: 'neutral', icon: statusIcon.lateComplete },
	waived: { label: 'Waived', tone: 'neutral', icon: statusIcon.waived }
});

/** Overdue outranks the assignment's own state on the row that carries it. */
export const overdueBadge: StateBadge = Object.freeze({
	label: 'Overdue',
	tone: 'warning',
	solid: true,
	icon: statusIcon.overdue
});

/** What happened to this person's own copy of a message. */
export const deliveryOutcomeBadge: Readonly<
	Record<CommunicationThreadEntry['outcome'], StateBadge>
> = Object.freeze({
	delivered: { label: 'Delivered', tone: 'success', icon: statusIcon.delivered },
	sent: { label: 'Sent', tone: 'success', icon: statusIcon.sent },
	bounced: { label: 'Bounced', tone: 'danger', solid: true, icon: statusIcon.bounced },
	scheduled: { label: 'Scheduled', tone: 'info', icon: statusIcon.scheduled }
});
