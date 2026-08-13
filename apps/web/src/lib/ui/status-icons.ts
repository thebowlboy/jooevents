/**
 * The product's status glyph vocabulary: one meaning, one symbol, everywhere.
 *
 * A glyph is recognition support, never the encoding. Every badge still carries
 * its status word, so the glyph renders `aria-hidden` and the word remains the
 * accessible name. Extending this record is the only supported way to give a
 * state a symbol — a feature importing an icon directly is how the same state
 * drifts to two shapes on two surfaces.
 *
 * Deliberate reuse: states that mean the same thing to an operator share one
 * glyph. "Waitlisted" and "Invited" are both Hourglass because both say
 * *waiting on someone else*; "Overdue" and "Late complete" differ because one
 * is an open obligation and the other is a closed one.
 */

import type { Icon } from 'lucide-svelte';
import type { SubmissionResource, TrayKind } from '$lib/api/types';
import {
	AlarmClock,
	AlarmClockOff,
	ArchiveRestore,
	ArrowRightFromLine,
	Bot,
	CalendarCheck,
	CalendarX2,
	Check,
	CircleCheck,
	CircleDashed,
	CircleEllipsis,
	CirclePause,
	CircleQuestionMark,
	CircleSlash,
	CircleX,
	Clock,
	Eye,
	EyeOff,
	FileInput,
	FilePen,
	FileText,
	FunnelX,
	Hourglass,
	Inbox,
	Info,
	Link2,
	Lock,
	LockOpen,
	MailCheck,
	MailOpen,
	MailWarning,
	MailX,
	MessageCircleReply,
	OctagonX,
	PencilLine,
	Presentation,
	Send,
	Siren,
	TriangleAlert,
	Undo2,
	UserRoundX,
	Users,
	Video
} from 'lucide-svelte';

export type IconComponent = typeof Icon;

export type StatusIconKey =
	// Submission decision outcomes.
	| 'accepted'
	| 'waitlisted'
	| 'declined'
	| 'withdrawn'
	| 'unnotified'
	// Speaker engagement lifecycle.
	| 'invited'
	| 'confirmed'
	| 'cancelRequested'
	| 'cancelled'
	// Public visibility.
	| 'published'
	| 'unpublished'
	// Communication lifecycle.
	| 'draft'
	| 'scheduled'
	| 'sending'
	| 'sent'
	| 'held'
	| 'delivered'
	| 'bounced'
	// Email delivery readiness.
	| 'ready'
	| 'actionRequired'
	| 'notChecked'
	| 'notConfigured'
	// Speaker task states.
	| 'complete'
	| 'received'
	| 'lateComplete'
	| 'waived'
	| 'overdue'
	| 'notStarted'
	// Form status.
	| 'formOpen'
	| 'formClosed'
	// Review coverage.
	| 'needsReviewer'
	// Schedule conflict severity.
	| 'blocking'
	| 'warning'
	// Attention-rail priority.
	| 'actNow'
	| 'soon'
	| 'fyi';

export const statusIcon: Record<StatusIconKey, IconComponent> = {
	accepted: CircleCheck,
	waitlisted: Hourglass,
	declined: CircleX,
	withdrawn: Undo2,
	unnotified: MailWarning,

	invited: Hourglass,
	confirmed: CircleCheck,
	cancelRequested: UserRoundX,
	cancelled: CalendarX2,

	published: Eye,
	unpublished: EyeOff,

	draft: PencilLine,
	scheduled: AlarmClock,
	sending: CircleEllipsis,
	sent: Send,
	held: CirclePause,
	delivered: MailCheck,
	// Shares the ledger's bounced-recipients glyph deliberately: one concept,
	// one symbol, whether it appears as a tray or as a person's own outcome.
	bounced: MailX,

	ready: CircleCheck,
	actionRequired: TriangleAlert,
	notChecked: CircleQuestionMark,
	notConfigured: CircleDashed,

	complete: Check,
	received: Inbox,
	lateComplete: CalendarCheck,
	waived: CircleSlash,
	overdue: AlarmClockOff,
	notStarted: CircleDashed,

	formOpen: LockOpen,
	formClosed: Lock,

	// Shares the cancellation glyph deliberately: to an operator both say *the
	// person who was going to do this is out of it*, and the difference between
	// a speaker and a reviewer is carried by the surface, not the symbol.
	needsReviewer: UserRoundX,

	blocking: OctagonX,
	warning: TriangleAlert,

	actNow: Siren,
	soon: Clock,
	fyi: Info
};

/**
 * Holding places on the Overview ledger — "everything has a place". These name a
 * *kind of waiting room*, not a state, so they live apart from `statusIcon`.
 */
export const trayIcon: Record<TrayKind, IconComponent> = {
	late: Hourglass,
	discarded: ArchiveRestore,
	'unresolved-import': FileInput,
	'stranded-drafts': FilePen,
	'inbound-mail': MailOpen,
	bounced: MailX,
	appeals: MessageCircleReply
};

/**
 * The four fates a submission can be in during triage.
 *
 * `discarded` deliberately carries the same glyph as the Overview ledger's
 * "Discarded, recoverable" pill: it is one concept, so it gets one symbol. A
 * waste basket said the opposite of what the product promises — discards stay
 * recoverable for the life of the event.
 */
export const submissionTrayIcon: Record<'inbox' | 'set-aside' | 'late' | 'discarded', IconComponent> =
	{
		inbox: Inbox,
		'set-aside': ArrowRightFromLine,
		late: Hourglass,
		discarded: ArchiveRestore
	};

/**
 * What an attached material *is*. A resource kind describes a thing, not a state,
 * so it sits beside the tray vocabularies rather than inside `statusIcon`. Every
 * consumer renders these `aria-hidden`: the resource's own name is the encoding,
 * and the glyph only lets someone recognise the kind before reading it.
 */
export type ResourceKind = SubmissionResource['kind'];

export const resourceKindIcon: Record<ResourceKind, IconComponent> = {
	slides: Presentation,
	video: Video,
	document: FileText,
	link: Link2
};

/**
 * How many kind glyphs a collapsed affordance may preview. Four is the whole
 * vocabulary today; the cap is what keeps a preview a preview if it grows.
 */
const RESOURCE_KIND_PREVIEW_LIMIT = 4;

/**
 * The distinct kinds present in `resources`, always in the vocabulary's own
 * order — so the same attachment set draws the same row on every surface,
 * independent of the order the resources happen to arrive in.
 */
export function distinctResourceKinds(
	resources: readonly SubmissionResource[] = []
): ResourceKind[] {
	const present = new Set(resources.map((resource) => resource.kind));
	return (Object.keys(resourceKindIcon) as ResourceKind[])
		.filter((kind) => present.has(kind))
		.slice(0, RESOURCE_KIND_PREVIEW_LIMIT);
}

/**
 * Situations rather than states: what an empty surface *is*. An empty list and a
 * filter hiding everything look identical without these, and the difference
 * decides whether the operator clears the filter or starts creating.
 */
export const situationIcon = {
	/** Never had anyone in it — a beginning, not a failure. */
	emptyRoster: Users,
	/** The data exists; the filter is hiding it. */
	filteredEmpty: FunnelX,
	/** Swept and clear. Neutral ink, never a green fill — calm is not a success event. */
	allClear: CircleCheck
} satisfies Record<string, IconComponent>;

/**
 * Actor attribution. Lavender categorization ink, never alarm — a machine acting
 * is a fact about provenance, not a problem.
 */
export const markIcon = {
	agent: Bot
} satisfies Record<string, IconComponent>;
