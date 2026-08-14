import type { PortalEventDto } from '@jooevents/contracts';
import { mapPortalEngagement, mapPortalSnapshot, type PortalProjectionContext } from './mappers';
import type {
	PortalEngagementView,
	PortalMutationOutcome,
	PortalProfileView,
	PortalRefusalReason,
	PortalSnapshotView,
	PortalSubmissionView,
	PortalTaskView
} from './view-models';
import type {
	PortalLiveRespondResult,
	PortalOperationsLiveClient
} from './live/operations-client';

/**
 * Live fulfillment of the frozen portal page port, over the two served
 * participant-lane operations: the snapshot read and the engagement response
 * act. Everything else the port names is answered as a typed absence rather
 * than a pretence — the snapshot's task list arrives honestly empty from the
 * server, and a change the lane does not serve yet resolves to the
 * `portal_not_served` refusal instead of pretending it landed or throwing a
 * failure the calling surfaces do not catch.
 *
 * Reads may throw (`PortalPageLiveError`); the portal store treats any read
 * rejection as its failed state. Changes never throw: every path resolves to
 * the port's own outcome shape, because the portal surfaces render refusals
 * inline and have no catch boundary. A transport failure or an outcome
 * outside the lane's refusal vocabulary resolves to `request_unconfirmed` —
 * the one honest sentence when this client cannot know what the server did.
 *
 * Nothing here consults sample state, and nothing organizer-internal has a
 * representation on this port at all.
 */

/**
 * The live lane's refusal vocabulary: the frozen reasons plus the two words
 * only a real transport needs. `portal_not_served` is the typed absence for
 * an act the lane does not serve yet; `request_unconfirmed` is the honest
 * answer when no trustworthy server answer exists (network failure, contract
 * violation, or an outcome the portal vocabulary does not carry).
 *
 * Once the port's own `PortalRefusalReason` carries both members, this alias
 * collapses into it and the live api is exactly the frozen `PortalApi`.
 */
export type LivePortalRefusalReason =
	| PortalRefusalReason
	| 'portal_not_served'
	| 'request_unconfirmed';

export type LivePortalMutationOutcome<Data> =
	| { readonly ok: true; readonly data: Data }
	| { readonly ok: false; readonly reason: LivePortalRefusalReason };

/**
 * The frozen portal page port, restated structurally so the live composition
 * can name it without the sample module in its import graph (the pure-live
 * boundary walks type imports too). Method shapes mirror the sample api
 * exactly — `portal-page-port.live.test.ts` proves the equivalence — with
 * the one live widening documented on `LivePortalRefusalReason`.
 */
export interface LivePortalApi {
	snapshot(): Promise<PortalSnapshotView>;
	submission(id: string): Promise<PortalSubmissionView | null>;
	editAnswers(input: {
		readonly submissionId: string;
		readonly answers: readonly { readonly fieldId: string; readonly value: string }[];
	}): Promise<LivePortalMutationOutcome<PortalSubmissionView>>;
	withdrawSubmission(id: string): Promise<LivePortalMutationOutcome<PortalSubmissionView>>;
	appealDecision(input: {
		readonly submissionId: string;
		readonly reason: string;
	}): Promise<LivePortalMutationOutcome<PortalSubmissionView>>;
	respondToEngagement(input: {
		readonly engagementId: string;
		readonly response: 'confirm' | 'decline';
	}): Promise<LivePortalMutationOutcome<PortalEngagementView>>;
	completeTask(input: {
		readonly taskId: string;
		readonly fileName?: string;
	}): Promise<LivePortalMutationOutcome<PortalTaskView>>;
	saveProfileField(input: {
		readonly fieldId: string;
		readonly value: string;
	}): Promise<LivePortalMutationOutcome<PortalProfileView>>;
	requestProfileChange(input: {
		readonly fieldId: string;
	}): Promise<LivePortalMutationOutcome<PortalProfileView>>;
}

/** Which source fulfils the portal gateway in a live build. */
export interface LivePortalSource {
	readonly kind: 'live';
}

export const livePortalSource: LivePortalSource = Object.freeze({ kind: 'live' });

/**
 * Safe, reviewed-copy failure at the portal read boundary. `retryable` is the
 * server's own verdict for structured outcomes and the client's for
 * transport; an unclassified failure stays retryable rather than freezing the
 * surface behind a terminal claim nobody made.
 */
export class PortalPageLiveError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(failure: { readonly code: string; readonly reason: string; readonly retryable: boolean }) {
		super(failure.reason);
		this.name = 'PortalPageLiveError';
		this.code = failure.code;
		this.retryable = failure.retryable;
	}
}

function readFailure(
	result: Exclude<Awaited<ReturnType<PortalOperationsLiveClient['readSnapshot']>>, { kind: 'success' }>
): PortalPageLiveError {
	if (result.kind === 'unavailable') {
		// The composed manifest is captured once; a retry cannot mount the operation.
		return new PortalPageLiveError({
			code: result.reason,
			reason: 'The speaker portal is not served by this JooEvents installation yet.',
			retryable: false
		});
	}
	if (result.kind === 'transport_error') {
		return new PortalPageLiveError({
			code: result.error.code,
			reason: result.error.retryable
				? 'Your portal could not be loaded. Check your connection and try again.'
				: 'This portal request is not valid.',
			retryable: result.error.retryable
		});
	}
	if (result.outcome.class === 'access_denied') {
		return new PortalPageLiveError({
			code: result.outcome.kind,
			reason: 'Your access has changed since you signed in. Sign in again to see where things stand.',
			retryable: false
		});
	}
	return new PortalPageLiveError({
		code: result.outcome.kind,
		reason: 'Your portal could not be loaded just now.',
		retryable: result.outcome.retryable
	});
}

function respondRefusal(
	result: Exclude<PortalLiveRespondResult, { kind: 'success' }>
): LivePortalRefusalReason {
	// The composed manifest already proves an unserved act before anything is
	// sent — the same typed absence the unserved mutations resolve, and the
	// same terminal verdict the read path gives these reasons. A trustworthy
	// answer exists here; only a transport failure leaves the outcome unknown.
	if (result.kind === 'unavailable') return 'portal_not_served';
	if (result.kind === 'transport_error') return 'request_unconfirmed';
	// The lane's own uniform refusal posture: an engagement outside the
	// participant's current world — missing, foreign, or no longer theirs —
	// is one indistinguishable answer, and a lost session or revoked identity
	// reads the same way. The next snapshot read states where things stand.
	if (result.outcome.class === 'access_denied') return 'unknown_record';
	if (result.outcome.kind === 'portal.engagement_not_open') return 'engagement_not_open';
	return 'request_unconfirmed';
}

const NOT_SERVED = Object.freeze({ ok: false, reason: 'portal_not_served' } as const);

function defaultIdempotencyKey(): string {
	return `je.portal.respond.${globalThis.crypto.randomUUID()}`;
}

export function createLivePortalApi(input: {
	readonly operations: PortalOperationsLiveClient;
	readonly now?: () => number;
	readonly newIdempotencyKey?: () => string;
}): LivePortalApi {
	const now = input.now ?? Date.now;
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;

	/**
	 * Whose portal the last successful read said this is. Engagement ids only
	 * ever come from a rendered snapshot, so a response normally finds this
	 * populated; the cold path re-reads once rather than guessing a viewer.
	 */
	let lastProjection: { readonly participantId: string; readonly event: PortalEventDto } | null =
		null;

	async function readSnapshotView(): Promise<PortalSnapshotView> {
		const result = await input.operations.readSnapshot();
		if (result.kind !== 'success') throw readFailure(result);
		lastProjection = {
			participantId: result.data.participant.id,
			event: result.data.event
		};
		return mapPortalSnapshot(result.data, now());
	}

	async function projectionContext(): Promise<PortalProjectionContext | null> {
		if (lastProjection === null) {
			const result = await input.operations.readSnapshot();
			if (result.kind !== 'success') return null;
			lastProjection = {
				participantId: result.data.participant.id,
				event: result.data.event
			};
		}
		return { ...lastProjection, now: now() };
	}

	return Object.freeze({
		async snapshot(): Promise<PortalSnapshotView> {
			return await readSnapshotView();
		},

		async submission(id: string): Promise<PortalSubmissionView | null> {
			const snapshot = await readSnapshotView();
			return snapshot.submissions.find((submission) => submission.id === id) ?? null;
		},

		/**
		 * Corrections to a submitted record are not served on the participant
		 * lane yet; the record stays exactly as it was sent.
		 */
		async editAnswers(): Promise<LivePortalMutationOutcome<PortalSubmissionView>> {
			return NOT_SERVED;
		},

		async withdrawSubmission(): Promise<LivePortalMutationOutcome<PortalSubmissionView>> {
			return NOT_SERVED;
		},

		async appealDecision(): Promise<LivePortalMutationOutcome<PortalSubmissionView>> {
			return NOT_SERVED;
		},

		/**
		 * The one served act. Attribution is never sent: the server derives
		 * `self` versus `co_speaker` from the authenticated participant, and
		 * under `any_participant_acts` the answer binds every listed speaker
		 * and lands on the shared timeline for the others.
		 */
		async respondToEngagement(request: {
			readonly engagementId: string;
			readonly response: 'confirm' | 'decline';
		}): Promise<LivePortalMutationOutcome<PortalEngagementView>> {
			const context = await projectionContext();
			if (context === null) return { ok: false, reason: 'request_unconfirmed' };
			const result = await input.operations.respondToEngagement(
				{ engagementId: request.engagementId, response: request.response },
				newIdempotencyKey()
			);
			if (result.kind !== 'success') return { ok: false, reason: respondRefusal(result) };
			return { ok: true, data: mapPortalEngagement(result.data, context) };
		},

		/** The live snapshot serves no tasks yet, so no task can be completed. */
		async completeTask(): Promise<LivePortalMutationOutcome<PortalTaskView>> {
			return NOT_SERVED;
		},

		async saveProfileField(): Promise<LivePortalMutationOutcome<PortalProfileView>> {
			return NOT_SERVED;
		},

		async requestProfileChange(): Promise<LivePortalMutationOutcome<PortalProfileView>> {
			return NOT_SERVED;
		}
	});
}
