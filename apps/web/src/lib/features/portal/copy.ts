import type { PortalSubmissionStatus, PortalTaskState } from '@jooevents/contracts';
import { statusIcon, type IconComponent } from '$lib/ui';
import type {
	PortalEditabilityView,
	PortalEngagementView,
	PortalProfileFieldAccessView,
	PortalRefusalReason,
	PortalTaskCompletionView
} from '$lib/api/portal/view-models';

/**
 * Every word this surface says about someone's own work.
 *
 * It lives in one module because the portal's reader is occasional and under no
 * obligation to learn anything: the vocabulary has to stay identical wherever a
 * state appears, and a refusal has to read the same whether it was predicted
 * before the press or returned by the operation afterwards. Codes travel;
 * sentences are chosen here.
 */

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface StateCopy {
	/** The status word itself — always the badge's own text, never a tooltip. */
	readonly label: string;
	readonly tone: BadgeTone;
	readonly icon: IconComponent;
	/** One plain sentence, for the record's own page where there is room to say it. */
	readonly meaning: string;
}

/**
 * Communicated decision state. These are the words the participant has already
 * been told, so they stay flat and factual — a decline is neutral, never an
 * alarm aimed at the person who received it.
 */
export const submissionStatusCopy: Record<PortalSubmissionStatus, StateCopy> = {
	submitted: {
		label: 'Received',
		tone: 'neutral',
		icon: statusIcon.received,
		meaning: 'We have this. Nothing is expected from you while it waits.'
	},
	in_review: {
		label: 'Being read',
		tone: 'info',
		icon: statusIcon.invited,
		meaning: 'The organizers are reading it. You will hear from them by email.'
	},
	accepted: {
		label: 'Accepted',
		tone: 'success',
		icon: statusIcon.accepted,
		meaning: 'This talk is in the program.'
	},
	waitlisted: {
		label: 'Waitlisted',
		tone: 'info',
		icon: statusIcon.waitlisted,
		meaning: 'Held in reserve. If a place opens up, the organizers come back to you.'
	},
	declined: {
		label: 'Declined',
		tone: 'neutral',
		icon: statusIcon.declined,
		meaning: 'This one did not make the program.'
	},
	withdrawn: {
		label: 'Withdrawn',
		tone: 'neutral',
		icon: statusIcon.withdrawn,
		meaning: 'You took this out of consideration.'
	}
};

export const taskStateCopy: Record<PortalTaskState, StateCopy> = {
	todo: {
		label: 'To do',
		tone: 'neutral',
		icon: statusIcon.notStarted,
		meaning: 'Nothing has been sent for this yet.'
	},
	received_pending_check: {
		label: 'Received',
		tone: 'info',
		icon: statusIcon.received,
		meaning: 'The organizers have it and will confirm once they have checked it.'
	},
	complete: {
		label: 'Done',
		tone: 'success',
		icon: statusIcon.complete,
		meaning: 'Finished — nothing further is needed.'
	},
	late: {
		label: 'Late',
		tone: 'warning',
		icon: statusIcon.overdue,
		meaning: 'The deadline has passed.'
	}
};

export const engagementStatusCopy: Record<PortalEngagementView['status'], StateCopy> = {
	invited: {
		label: 'Invited',
		tone: 'info',
		icon: statusIcon.invited,
		meaning: 'The organizers are waiting for your answer.'
	},
	confirmed: {
		label: 'Confirmed',
		tone: 'success',
		icon: statusIcon.confirmed,
		meaning: 'You are on the program for this session.'
	},
	declined: {
		label: 'Declined',
		tone: 'neutral',
		icon: statusIcon.declined,
		meaning: 'You told the organizers you cannot do this one.'
	},
	cancelled: {
		label: 'Cancelled',
		tone: 'neutral',
		icon: statusIcon.cancelled,
		meaning: 'This session is no longer going ahead.'
	}
};

/**
 * What an attempted change was refused for. Every code the operation can return
 * has a sentence here; the same sentence is what the surface shows in advance
 * when it can already tell the answer would be no.
 */
export const refusalCopy: Record<PortalRefusalReason, string> = {
	unknown_record: 'We could not find that. It may have been removed since this page loaded.',
	cfp_closed: 'Submissions have closed, so this can no longer be changed.',
	submission_not_editable: 'This submission is kept exactly as it was sent.',
	submission_decided: 'A decision has been made, so this can no longer be changed.',
	submission_withdrawn: 'You withdrew this submission, so it can no longer be changed.',
	submission_not_withdrawable: 'This submission can no longer be withdrawn.',
	appeal_unavailable: 'This decision is not open to another look.',
	appeal_already_used: 'You have already asked the organizers to look at this one again.',
	appeal_rate_limited:
		'You have used every request for another look at this event. The organizers can still be emailed.',
	engagement_not_open: 'This invitation has already been answered.',
	task_not_actionable: 'This task has already been dealt with.',
	task_closed: 'The deadline for this task has passed and it no longer accepts anything.',
	field_locked: 'Only the organizers can change this.',
	field_editable: 'This one is yours to edit — no request is needed.'
};

/** Why a submitted record cannot be corrected, said before anyone tries. */
export function editLockCopy(lock: Extract<PortalEditabilityView, { kind: 'locked' }>): string {
	switch (lock.reason) {
		case 'cfp_closed':
			return 'Submissions have closed. What you sent stays exactly as it was.';
		case 'not_editable':
			return 'This submission is kept exactly as it was sent.';
		case 'decided':
			return 'A decision has been made, so what you sent stays as it is.';
		case 'withdrawn':
			return 'You withdrew this submission, so it is no longer being considered.';
	}
}

export function profileLockCopy(
	access: Extract<PortalProfileFieldAccessView, { kind: 'locked' }>
): string {
	switch (access.reason) {
		case 'organizer_managed':
			return 'The organizers manage this one.';
		case 'verified_identity':
			return 'This comes from the address you signed in with.';
		case 'locked_after_acceptance':
			return 'Fixed now that this talk is in the program.';
	}
}

/**
 * Completing a task by saying it is done, wherever that is offered.
 *
 * Deliberately not "Confirm": that word answers a speaking invitation, which is
 * a different commitment with different consequences. Two buttons a few
 * centimetres apart must not read as the same act.
 */
export const taskDoneLabel = 'Mark as done';

/** The primary action a task's completion mode asks for. */
export function taskActionLabel(completion: PortalTaskCompletionView): string {
	switch (completion.mode) {
		case 'acknowledge':
			return taskDoneLabel;
		case 'upload':
			return 'Upload';
		case 'form_fill':
			return 'Answer questions';
		case 'external':
			return 'Open link';
	}
}

/**
 * Operations this build does not serve. They stay on screen carrying the reason
 * rather than disappearing: a control that vanishes takes the explanation of
 * why it is gone with it.
 */
export const unavailableCopy = {
	taskForm: 'The questions for this task do not open here yet.',
	cancellationRequest:
		'Asking to cancel does not go through here yet. Sending one alerts the organizers; nothing about your session changes until they act on it.'
} as const;

/** Access and session copy. No support code is shown unless the server sent one. */
export const accessCopy = {
	checkFailedTitle: 'We could not check your access',
	checkFailedBody: 'Your access has not changed. Try again in a moment.',
	signOutFailed: 'We could not sign you out. Your session is unchanged.',
	signingOut: 'Signing out…'
} as const;

/**
 * Terms a first-time speaker cannot be expected to arrive knowing, carrying
 * their own definitions. Everything else on this surface is said in words that
 * need no glossary — a status badge explains itself in the sentence beside it
 * rather than borrowing a term of art.
 */
export const terms = {
	callForSpeakers: {
		term: 'call for speakers',
		definition:
			'The window when anyone can propose a talk for this event. It closes at the deadline shown here.'
	}
} as const;
