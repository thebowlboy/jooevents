import type {
	PortalSubmissionStatus,
	PortalSpeakerAuthority,
	PortalTaskState
} from '@jooevents/contracts';

export interface PortalParticipantView {
	readonly id: string;
	readonly displayName: string;
	readonly email: string;
}

export interface PortalEventView {
	readonly id: string;
	readonly name: string;
	readonly timezone: string;
	readonly cfpClosesAt: string;
	readonly closePolicy: 'soft' | 'hard';
	readonly cfpOpen: boolean;
}

export interface PortalAnswerView {
	readonly fieldId: string;
	readonly label: string;
	readonly value: string;
}

export type PortalSubmissionTargetView =
	| { readonly kind: 'new_session' }
	| { readonly kind: 'collecting_session'; readonly sessionId: string; readonly name: string };

export interface PortalSpeakerView {
	readonly participantId: string;
	readonly displayName: string;
	readonly isYou: boolean;
}

/**
 * Whether this submission can still be corrected, and — when it cannot — why,
 * as a code the surface can explain before anyone attempts an edit.
 */
export type PortalEditabilityView =
	| { readonly kind: 'open'; readonly closesAt: string }
	| {
			readonly kind: 'locked';
			readonly reason: 'cfp_closed' | 'not_editable' | 'decided' | 'withdrawn';
	  };

export type PortalAppealView =
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'available' }
	| { readonly kind: 'submitted'; readonly submittedAt: string; readonly reason: string };

export interface PortalTimelineEventView {
	readonly id: string;
	readonly occurredAt: string;
	readonly actor: 'you' | 'organizers';
	readonly kind:
		| 'submitted'
		| 'edited'
		| 'withdrawn'
		| 'status_communicated'
		| 'appeal_submitted'
		| 'engagement_invited'
		| 'engagement_responded'
		| 'task_completed';
	readonly summary: string;
}

export interface PortalSubmissionView {
	readonly id: string;
	readonly title: string;
	readonly formVersion: number;
	readonly answers: readonly PortalAnswerView[];
	readonly target: PortalSubmissionTargetView;
	readonly status: PortalSubmissionStatus;
	readonly statusNotifiedAt: string | null;
	readonly submittedAt: string;
	readonly late: boolean;
	readonly editability: PortalEditabilityView;
	readonly speakers: readonly PortalSpeakerView[];
	readonly authority: PortalSpeakerAuthority;
	/** True when another listed speaker's action binds you and every action informs the rest. */
	readonly sharedAuthority: boolean;
	readonly appeal: PortalAppealView;
	readonly timeline: readonly PortalTimelineEventView[];
}

export type PortalEngagementConfirmationView =
	| { readonly by: 'you'; readonly at: string }
	| { readonly by: 'co_speaker'; readonly at: string; readonly displayName: string }
	| { readonly by: 'organizer'; readonly at: string; readonly displayName: string };

export interface PortalEngagementView {
	readonly id: string;
	readonly sessionId: string;
	readonly sessionTitle: string;
	readonly submissionId: string | null;
	readonly status: 'invited' | 'confirmed' | 'declined' | 'cancelled';
	readonly invitedAt: string;
	readonly respondBy: string | null;
	readonly confirmation: PortalEngagementConfirmationView | null;
	readonly speakers: readonly PortalSpeakerView[];
	readonly awaitingYou: boolean;
	readonly sharedAuthority: boolean;
}

export type PortalTaskCompletionView =
	| { readonly mode: 'acknowledge' }
	| {
			readonly mode: 'upload';
			readonly acceptedTypes: readonly string[];
			readonly receivedFileId: string | null;
	  }
	| { readonly mode: 'form_fill'; readonly formId: string }
	| { readonly mode: 'external'; readonly url: string };

export interface PortalTaskView {
	readonly id: string;
	readonly title: string;
	readonly required: boolean;
	readonly completion: PortalTaskCompletionView;
	readonly state: PortalTaskState;
	readonly dueAt: string | null;
	readonly timezone: string;
	readonly closePolicy: 'soft' | 'hard';
	readonly sessionId: string | null;
	/** After the deadline a soft-closed task still accepts work, labelled late. */
	readonly acceptsLateCompletion: boolean;
}

export interface PortalFileView {
	readonly id: string;
	readonly name: string;
	readonly sizeBytes: number;
	readonly version: number;
	readonly uploadedAt: string;
	readonly taskId: string | null;
}

export interface PortalResourceView {
	readonly id: string;
	readonly title: string;
	readonly kind: 'link' | 'document';
	readonly url: string;
	readonly detail: string | null;
}

export type PortalProfileFieldAccessView =
	| { readonly kind: 'editable' }
	| {
			readonly kind: 'locked';
			readonly reason: 'organizer_managed' | 'verified_identity' | 'locked_after_acceptance';
			readonly changeRequested: boolean;
	  };

export interface PortalProfileFieldView {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly kind: 'text' | 'long_text' | 'email' | 'url';
	readonly access: PortalProfileFieldAccessView;
}

export interface PortalProfileView {
	readonly fields: readonly PortalProfileFieldView[];
}

export interface PortalSnapshotView {
	readonly schemaVersion: 1;
	readonly participant: PortalParticipantView;
	readonly event: PortalEventView;
	readonly submissions: readonly PortalSubmissionView[];
	readonly engagements: readonly PortalEngagementView[];
	readonly tasks: readonly PortalTaskView[];
	readonly files: readonly PortalFileView[];
	readonly resources: readonly PortalResourceView[];
	readonly profile: PortalProfileView;
}

/**
 * Why an attempted change was refused, as a code. The participant-facing
 * sentence belongs to the surface's copy, never to the transport.
 */
export type PortalRefusalReason =
	| 'unknown_record'
	| 'cfp_closed'
	| 'submission_not_editable'
	| 'submission_decided'
	| 'submission_withdrawn'
	| 'submission_not_withdrawable'
	| 'appeal_unavailable'
	| 'appeal_already_used'
	| 'appeal_rate_limited'
	| 'engagement_not_open'
	| 'task_not_actionable'
	| 'task_closed'
	| 'field_locked'
	| 'field_editable'
	/** Typed absence: this act is not served on the participant lane yet. */
	| 'portal_not_served'
	/** No trustworthy server answer exists (transport failure or an outcome outside this vocabulary). */
	| 'request_unconfirmed';

export type PortalMutationOutcome<Data> =
	| { readonly ok: true; readonly data: Data }
	| { readonly ok: false; readonly reason: PortalRefusalReason };
