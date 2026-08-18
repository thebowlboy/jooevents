/**
 * The speaker record's derivations: everything the page ranks, states, or
 * refuses, computed from one committed snapshot.
 *
 * Kept out of the component because these are the parts that must be provably
 * honest — what counts as needing attention, when an accept control may exist,
 * which material is the organizer's to read — and a rule that lives in markup
 * can only be checked by looking at pixels.
 *
 * Nothing here is stored. Every situation is recomputed on each read, so a fact
 * that stops holding stops rendering, and no row can latch.
 */

import type {
	SpeakerDeliverable,
	SpeakerRecordSnapshot,
	TaskSettlement,
	TaskSubmission
} from './speaker-record-port';
import type { AssignmentState, EngagementState, SessionPlacementDisplay } from './types';

/** Terminal engagements are archives: their record is readable and inert. */
export function isTerminal(state: EngagementState): boolean {
	return state === 'declined' || state === 'cancelled';
}

// ---------------------------------------------------------------------------
// Section 2 — needs attention, scoped to this person

export type AttentionReason =
	| 'cancel_requested'
	| 'bounced'
	| 'overdue_tasks'
	| 'awaiting_review'
	| 'unconfirmed'
	| 'result_not_sent';

export interface AttentionDoor {
	readonly label: string;
	readonly href: string;
}

export interface AttentionRow {
	readonly reason: AttentionReason;
	/** Lower sorts first. Ranking is the fact's weight, never its arrival order. */
	readonly weight: number;
	readonly tone: 'danger' | 'warning' | 'info';
	/** A plain fact, not an instruction: the verb belongs to the door. */
	readonly title: string;
	readonly detail?: string;
	/**
	 * Absent where the rows this row counts are already on this page and the act
	 * it names lives here too — the rows test's terminal branch.
	 */
	readonly door?: AttentionDoor;
}

/** The walk's own address. The record never re-implements a step of it. */
export function cancellationWalkHref(engagementId: string): string {
	return `/app/speakers?panel=cancellation&engagement=${engagementId}`;
}

/** Where this person's outstanding work is worked, scoped and filtered. */
export function tasksHref(engagementId: string, overdue: boolean): string {
	return `/app/tasks?speaker=${engagementId}${overdue ? '&filter=overdue' : ''}`;
}

/** The compose dialog, scoped to one person. A GET never sends anything. */
export function composeHref(engagementId: string): string {
	return `/app/messages?compose=1&person=${engagementId}`;
}

/** This person's whole thread on the Communications page. */
export function threadHref(engagementId: string): string {
	return `/app/messages?person=${engagementId}`;
}

/** The one record URL every person-shaped door in the product resolves to. */
export function speakerRecordHref(engagementId: string): string {
	return `/app/speakers/${engagementId}`;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * What is wrong with this person, ranked.
 *
 * Derived, never authored — the same grammar the Overview uses, narrowed to one
 * engagement. A cancellation request leads by weight because it is the reason
 * the record gets opened under time pressure, and because every other row on the
 * page is provisional while it stands.
 *
 * A terminal engagement produces nothing: there is no work outstanding on a
 * record that is now an archive, and rendering overdue tasks for someone who
 * cancelled would be asking for work nobody owes.
 *
 * The ladder, by consequence rather than by data category: what is broken
 * (asked to cancel, nothing reaches them) · who is waiting on us (never told
 * their result) · what is late · what is waiting to be read · what is merely
 * pending. A missing travel form surfaces here while the form itself lives in
 * Deliverables — importance is the state, not the category.
 */
export function scopedAttention(snapshot: SpeakerRecordSnapshot): AttentionRow[] {
	const engagement = snapshot.engagement;
	if (isTerminal(engagement.state)) return [];

	const rows: AttentionRow[] = [];
	const name = engagement.name;

	if (engagement.state === 'cancel_requested') {
		rows.push({
			reason: 'cancel_requested',
			weight: 0,
			tone: 'danger',
			title: `${name} asked to cancel.`,
			...(engagement.note ? { detail: engagement.note } : {})
			/*
			 * No door: the walk *is* this engagement's next step, so the header's
			 * one primary action carries it, immediately above this row. Two
			 * danger-toned links to one URL a hundred pixels apart is the link
			 * soup R2 exists to prevent — the same reason the unconfirmed row
			 * below leaves its act to the header.
			 */
		});
	}

	// Their own copy bounced, so this is a fact about this person rather than
	// about a batch. The remedy is the message it belongs to, where the address
	// is fixed and the same copy is resent.
	const bounced = (snapshot.thread?.entries ?? []).filter((entry) => entry.outcome === 'bounced');
	if (bounced.length > 0) {
		const first = bounced[0];
		rows.push({
			reason: 'bounced',
			weight: 1,
			tone: 'danger',
			title: `${name} never received “${first.subject}” — their address rejected it.`,
			detail: `Every later message goes to the same address until it is fixed.`,
			door: { label: 'Fix the address', href: threadHref(engagement.id) }
		});
	}

	const overdue = snapshot.deliverables.filter(
		(entry) => entry.assignment.overdue && entry.assignment.state === 'todo'
	);
	if (overdue.length > 0) {
		rows.push({
			reason: 'overdue_tasks',
			weight: 3,
			tone: 'warning',
			// The rows are listed below on this page, so the count is a
			// denominator and the door is the reminder ceremony, not a way to
			// find out which ones.
			title: `${plural(overdue.length, 'task is', 'tasks are')} past ${
				overdue.length === 1 ? 'its' : 'their'
			} due date.`,
			detail: overdue.map((entry) => entry.def.name).join(' · '),
			door: { label: 'Send a reminder', href: tasksHref(engagement.id, true) }
		});
	}

	const awaiting = snapshot.deliverables.filter((entry) => entry.assignment.state === 'received');
	if (awaiting.length > 0) {
		rows.push({
			reason: 'awaiting_review',
			weight: 4,
			tone: 'info',
			title: `${name} sent ${plural(awaiting.length, 'thing', 'things')} that ${
				awaiting.length === 1 ? 'is' : 'are'
			} waiting for you to read.`,
			detail: awaiting.map((entry) => entry.def.name).join(' · ')
			// Terminal: the material and both acts are in Deliverables below.
		});
	}

	if (engagement.state === 'invited') {
		rows.push({
			reason: 'unconfirmed',
			weight: 5,
			tone: 'info',
			title: `${name} has not said yes yet.`,
			detail: 'Speakers confirm from their own portal link; you can record an agreement made elsewhere.'
			// The act is the header's one primary action — one fact, one door.
		});
	}

	const unsent = snapshot.submissions.filter(
		(entry) => entry.decision !== 'undecided' && !entry.notified
	);
	if (unsent.length > 0) {
		rows.push({
			reason: 'result_not_sent',
			weight: 2,
			tone: 'warning',
			title:
				unsent.length === 1
					? `${name} has not been told the result of their proposal.`
					: `${name} has not been told the results of their ${unsent.length} proposals.`,
			detail: unsent.map((entry) => entry.title).join(' · '),
			door: { label: 'Send their result', href: '/app/decisions?scope=unnotified' }
		});
	}

	return rows.sort((left, right) => left.weight - right.weight);
}

/** What the section says when this person is in good standing. */
export function quietSentence(name: string, state: EngagementState): string {
	if (isTerminal(state)) {
		return `Nothing is outstanding. This record is kept as it stands.`;
	}
	return `Nothing needs you for ${name}.`;
}

// ---------------------------------------------------------------------------
// Section 4 — deliverables and their content

export type DeliverableTone = 'quiet' | 'overdue' | 'received' | 'settled';

export interface DeliverableView {
	readonly def: SpeakerDeliverable['def'];
	readonly state: AssignmentState;
	readonly overdue: boolean;
	readonly tone: DeliverableTone;
	/**
	 * The material to render, or null for no content area at all. An empty frame
	 * would claim something was expected to be visible.
	 */
	readonly content: Exclude<TaskSubmission, { kind: 'draft' }> | null;
	/** Set when the speaker has started but not submitted — the row says so. */
	readonly notYetSubmitted: boolean;
	/**
	 * The due figure, only where it still says something.
	 *
	 * A definition's countdown belongs to the definition, while `overdue` is this
	 * person's own fact, and the two can disagree — "Overdue · in 32 days" is a
	 * sentence nobody can act on. On an overdue row the badge already carries the
	 * timing, and on settled work the deadline has stopped mattering, so both
	 * drop the figure rather than restating or contradicting the state beside it.
	 */
	readonly due?: string;
	readonly acceptable: boolean;
	/** Stated in place when an accept control exists but may not act. */
	readonly acceptRefusal?: string;
	readonly waivable: boolean;
	readonly settlement?: TaskSettlement;
}

const READ_NOT_MOUNTED =
	'Nothing submitted can be read here, so there is nothing to accept yet.';
const ARCHIVED = 'This engagement is closed. Its record stays readable and unchanged.';

/**
 * One assignment as the record renders it.
 *
 * The rule this function exists for: **no accept control renders above
 * unviewable content.** `received` means the material is in and the queue is
 * waiting on the organizer — but if the content read did not mount, accepting
 * would be exactly the blind act this page was built to end, so the control
 * carries its refusal instead of disappearing (absence deletes the why).
 *
 * The second rule: a portal draft is the speaker's own workspace. It is
 * discarded here, and the row says "Not yet submitted" — the words the state
 * already owns.
 */
export function deliverableView(
	entry: SpeakerDeliverable,
	engagementState: EngagementState
): DeliverableView {
	const { def, assignment, submission, settlement } = entry;
	const archived = isTerminal(engagementState);
	const committed = submission && submission.kind !== 'draft' ? submission : null;
	const draftOnly = submission?.kind === 'draft';

	// `todo` claims no content area even when a draft exists: nothing has been
	// committed, so there is nothing of theirs the organizer may read.
	const content = assignment.state === 'todo' || assignment.state === 'waived' ? null : committed;

	const tone: DeliverableTone =
		assignment.state === 'received'
			? 'received'
			: assignment.overdue && assignment.state === 'todo'
				? 'overdue'
				: assignment.state === 'todo'
					? 'quiet'
					: 'settled';

	const acceptControl = assignment.state === 'received' && !archived;
	const acceptable = acceptControl && content !== null;

	const showsDue =
		assignment.state === 'received' || (assignment.state === 'todo' && !assignment.overdue);

	const view: DeliverableView = {
		def,
		state: assignment.state,
		overdue: assignment.overdue,
		tone,
		content,
		notYetSubmitted: assignment.state === 'todo' && draftOnly,
		...(showsDue ? { due: def.dueRelative } : {}),
		acceptable,
		waivable: !archived && (assignment.state === 'todo' || assignment.state === 'received'),
		...(settlement ? { settlement } : {}),
		...(acceptControl && !acceptable ? { acceptRefusal: READ_NOT_MOUNTED } : {}),
		...(archived && assignment.state === 'received' ? { acceptRefusal: ARCHIVED } : {})
	};
	return view;
}

/**
 * Open obligations first, then anything still outstanding, then what is settled
 * — the same ranking the roster expansion and the task matrix already use, so
 * the three surfaces list one person's work in one order.
 */
const deliverableRank = (view: DeliverableView): number =>
	view.tone === 'overdue' ? 0 : view.tone === 'received' ? 1 : view.tone === 'quiet' ? 2 : 3;

/**
 * No remind door rides these rows. Overdue work raises exactly one attention row
 * above, and that row carries the reminder ceremony: one fact, one exit, or the
 * page grows a second landing for the same number.
 */
export function deliverableViews(snapshot: SpeakerRecordSnapshot): DeliverableView[] {
	return snapshot.deliverables
		.map((entry) => deliverableView(entry, snapshot.engagement.state))
		.sort((left, right) => deliverableRank(left) - deliverableRank(right));
}

// ---------------------------------------------------------------------------
// Section 1 — the header's continuity cue and provenance line

export interface CueArm {
	readonly key: 'standing' | 'when' | 'where' | 'publication';
	readonly text: string;
}

const standingWord: Record<EngagementState, string> = {
	invited: 'invited',
	confirmed: 'confirmed',
	cancel_requested: 'asked to cancel',
	declined: 'declined',
	cancelled: 'cancelled'
};

/**
 * `Wed 14:00` from a placement.
 *
 * The cue is a one-line orientation, so it spends the day's weekday and the
 * start of the range rather than the full `Wed Oct 14 · 14:00–14:30` the
 * commitments section states. It returns nothing rather than half a fact when
 * either part cannot be read — a machine key wearing a label's clothes is worse
 * than silence.
 */
export function cueSlotLabel(placement: SessionPlacementDisplay): string | undefined {
	const weekday = placement.day.trim().split(/\s+/)[0];
	const start = placement.time.split('–')[0]?.trim();
	if (!weekday || !start) return undefined;
	return `${weekday} ${start}`;
}

/**
 * Where this engagement stands, in one line: standing · when · where ·
 * publication — record `24` §4's continuity cue, arm by arm, each rendered only
 * when its fact exists. The cancellation walk leads with the same line, so a
 * person who opens the walk from this page reads the sentence they just read.
 */
export function continuityCue(snapshot: SpeakerRecordSnapshot): CueArm[] {
	const arms: CueArm[] = [{ key: 'standing', text: standingWord[snapshot.engagement.state] }];
	const placed = snapshot.sessions.find((session) => session.placement);
	if (placed?.placement) {
		const slot = cueSlotLabel(placed.placement);
		if (slot) arms.push({ key: 'when', text: slot });
		arms.push({ key: 'where', text: placed.placement.room });
	}
	const { onLineup, releaseNumber } = snapshot.publication;
	if (onLineup && releaseNumber !== undefined) {
		arms.push({ key: 'publication', text: `public since release ${releaseNumber}` });
	}
	return arms;
}

/** How this person reached the roster, in the `21` §5 attribution grammar. */
export function provenanceSentence(snapshot: SpeakerRecordSnapshot): string {
	const provenance = snapshot.provenance;
	switch (provenance.kind) {
		case 'submission':
			return `Decided from the submission “${provenance.title}”.`;
		case 'direct_entry':
			return provenance.by ? `Direct entry by ${provenance.by}.` : 'Direct entry.';
		case 'import':
			return 'Added by import.';
		default:
			return 'Editorial addition to the roster.';
	}
}

/**
 * The `24` §4 after-gap statement, while its predicate holds: a cancelled or
 * declined person the public lineup still names. Concrete facts only — never
 * "there may be inconsistencies" — and it retires itself the moment the next
 * release drops them.
 */
export function afterGapStatement(snapshot: SpeakerRecordSnapshot): string | undefined {
	const { engagement, publication, sessions } = snapshot;
	if (!isTerminal(engagement.state) || !publication.onLineup) return undefined;
	const placed = sessions.find((session) => session.placement);
	if (placed?.placement) {
		return `The lineup still names ${engagement.name}, and ${placed.title} still holds ${placed.placement.day} · ${placed.placement.time} in ${placed.placement.room}.`;
	}
	return `The lineup still names ${engagement.name}. Publishing again drops them.`;
}

// ---------------------------------------------------------------------------
// Section 1 — the one primary next step

export type NextStepKind = 'record_confirmation' | 'review_cancellation' | 'none';

export interface NextStep {
	readonly kind: NextStepKind;
	readonly label: string;
	/** Present on a door; absent on an act committed here. */
	readonly href?: string;
	readonly tone: 'primary' | 'danger';
	readonly hint: string;
}

/**
 * The engagement's current next step, using the roster's own `hasNextStep`
 * vocabulary. Exactly one, or none: `confirmed` is the steady state and a
 * terminal engagement is an archive, and inventing a primary action for either
 * would be shipping a control with nothing to do.
 */
export function nextStep(snapshot: SpeakerRecordSnapshot): NextStep | null {
	const engagement = snapshot.engagement;
	if (engagement.state === 'invited') {
		return {
			kind: 'record_confirmation',
			label: 'Record confirmation',
			tone: 'primary',
			hint: 'Records that they agreed outside the product — attributed to you, not to them.'
		};
	}
	if (engagement.state === 'cancel_requested') {
		return {
			kind: 'review_cancellation',
			label: 'Review cancellation…',
			href: cancellationWalkHref(engagement.id),
			tone: 'danger',
			hint: 'Walks what this touches — the roster, the slot, the lineup, anything queued to send.'
		};
	}
	return null;
}
