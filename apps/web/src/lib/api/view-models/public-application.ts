import type { ServedPublicFormDto, StructuredOutcome } from '@jooevents/contracts';

/**
 * Typed refusal surfaces for the public application ceremony.
 *
 * The server serves classes, not sentences; the sentences live here so every
 * consumer of the apply surface — standalone and embedded alike — reads the
 * same reviewed copy. The filled-target re-offer wording is the recorded
 * product default: headline, one reason line per case, and the two exits.
 */

export type PublicApplicationTargetRefusalReason =
	| 'target_graduated'
	| 'target_closed'
	| 'target_missing';

/** The recorded filled-target re-offer copy, verbatim. */
export const PUBLIC_APPLICATION_TARGET_REOFFER_COPY = Object.freeze({
	headline: 'This session is no longer collecting',
	reasons: Object.freeze({
		target_graduated: 'It has been added to the program.',
		target_closed: 'Its call has closed.',
		target_missing: 'It no longer exists.'
	} satisfies Record<PublicApplicationTargetRefusalReason, string>),
	exits: Object.freeze({
		retarget: 'Choose another session',
		spawn: 'Create its own session'
	})
});

export type PublicApplicationRefusalView =
	| {
			/** No published apply surface serves this form right now. */
			readonly kind: 'not_open';
			readonly headline: string;
			readonly detail: string;
	  }
	| {
			/** The ceremony stopped: expired, superseded, or withdrawn — one sentence. */
			readonly kind: 'session_gone';
			readonly headline: string;
			readonly detail: string;
	  }
	| {
			/** The draft moved under the caller; the resumed state is authoritative. */
			readonly kind: 'draft_changed';
			readonly headline: string;
			readonly detail: string;
	  }
	| {
			/** Same idempotency key, different request bytes. */
			readonly kind: 'request_changed';
			readonly headline: string;
			readonly detail: string;
	  }
	| {
			/** The session this form proposes into is no longer collecting. */
			readonly kind: 'target_no_longer_collecting';
			readonly headline: string;
			/**
			 * The per-case reason line when the refusal detail carries one; null
			 * until the session owner serves the graduated/closed/missing split,
			 * in which case only the headline and exits are shown.
			 */
			readonly reason: string | null;
			readonly reasonCode: PublicApplicationTargetRefusalReason | null;
			readonly exits: { readonly retarget: string; readonly spawn: string };
	  }
	| {
			/** Any other terminal policy refusal of the submission itself. */
			readonly kind: 'not_accepted';
			readonly headline: string;
			readonly detail: string;
	  };

export function publicApplicationNotOpenView(): PublicApplicationRefusalView {
	return {
		kind: 'not_open',
		headline: 'This call isn’t open',
		detail: 'Submissions aren’t being accepted here right now. Check back, or ask the organizer.'
	};
}

export function publicApplicationSessionGoneView(): PublicApplicationRefusalView {
	return {
		kind: 'session_gone',
		headline: 'This session has ended',
		detail: 'Your editing session is no longer valid. Reload the page to start again — submitted work is already safe.'
	};
}

function targetReasonCode(outcome: StructuredOutcome): PublicApplicationTargetRefusalReason | null {
	const detail = outcome.detail;
	if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
		const reason = (detail as { readonly reason?: unknown }).reason;
		if (reason === 'target_graduated' || reason === 'target_closed'
			|| reason === 'target_missing') {
			return reason;
		}
	}
	return null;
}

/**
 * The reviewed sentence for a terminal mutation outcome, in the context of the
 * served form it refused. A policy refusal on a session-targeted form presents
 * as the recorded filled-target re-offer; everything else keeps its own class.
 */
export function publicApplicationRefusalView(input: {
	readonly outcome: StructuredOutcome;
	readonly target?: ServedPublicFormDto['target'];
}): PublicApplicationRefusalView {
	const { outcome } = input;
	if (outcome.class === 'conflict' && outcome.kind === 'intake.changed') {
		return {
			kind: 'draft_changed',
			headline: 'This draft changed elsewhere',
			detail: 'It was updated from another tab or window. The latest saved answers are shown; check them and continue.'
		};
	}
	if (outcome.class === 'idempotency_conflict') {
		return {
			kind: 'request_changed',
			headline: 'That didn’t match the earlier attempt',
			detail: 'The retried request wasn’t identical to the first one. Reload and try again.'
		};
	}
	if (outcome.class === 'policy_violation' && input.target?.kind === 'session') {
		const reasonCode = targetReasonCode(outcome);
		return {
			kind: 'target_no_longer_collecting',
			headline: PUBLIC_APPLICATION_TARGET_REOFFER_COPY.headline,
			reason: reasonCode === null
				? null
				: PUBLIC_APPLICATION_TARGET_REOFFER_COPY.reasons[reasonCode],
			reasonCode,
			exits: PUBLIC_APPLICATION_TARGET_REOFFER_COPY.exits
		};
	}
	if (outcome.class === 'access_denied') return publicApplicationSessionGoneView();
	return {
		kind: 'not_accepted',
		headline: 'This couldn’t be accepted',
		detail: 'The call isn’t taking this submission right now. Check the form’s notices, or ask the organizer.'
	};
}
