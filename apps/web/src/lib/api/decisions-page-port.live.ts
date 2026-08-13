import {
	DECISION_DECIDE_ROWS_MAX,
	decisionTargetUnavailableDetailSchema,
	type DecisionStateRowDto,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { SafeApiError } from './client';
import type { DecisionsPagePort } from './decisions-page-port';
import type {
	DecisionsLiveClient,
	DecisionsLiveDecideResult,
	DecisionsLiveReadResult
} from './operations/decisions-live';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import { mapLiveReviewPlans } from './review-page-port.live';
import type { ReviewCorePort } from './review-core-port';
import type {
	AccoladeDef,
	DecisionState,
	EventSettings,
	MyReviewItem,
	ReviewPlan,
	ScheduleState,
	ScoreStanding,
	SubmissionPage,
	SubmissionQuery,
	Track
} from './types';
import type { ReviewSnapshotView, ReviewStandingView } from './view-models/review';
import type { ProgramTrackView } from './view-models/program-vocabulary';

/**
 * The tuned page capabilities this deliberately partial live mount cannot
 * truthfully serve yet, each refused with its own name so a failure states
 * exactly which owner has not joined. Notification affordances are the
 * recorded typed refusals (Q2 applied): decisions commit and stay recorded,
 * and nothing pretends a message was reviewed or sent.
 */
export type DecisionsPageLiveUnmountedCapability =
	| 'decision_review_evidence'
	| 'decision_notification_review'
	| 'decision_notification_send'
	| 'decision_undo_to_undecided'
	| 'decision_withdrawn_authoring';

type AdapterFailure = Readonly<{ code: string; reason: string; retryable: boolean }>;

/**
 * Safe, reviewed-copy failure at the tuned Decisions boundary. `retryable`
 * classifies the failure for the consuming surface the way the review
 * resolution seam records: the server's own verdict for structured outcomes,
 * the client's for transport, and `false` for refusals whose answer a retry
 * from the same session can never change — so a terminal typed state is never
 * flattened onto a retry affordance.
 */
export class DecisionsPageLiveError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'DecisionsPageLiveError';
		this.code = failure.code;
		this.retryable = failure.retryable;
	}
}

const UNMOUNTED_COPY: Readonly<Record<DecisionsPageLiveUnmountedCapability, string>> =
	Object.freeze({
		decision_review_evidence:
			'Individual committed reviews are not served on this surface; the standing beside the row is the whole aggregate evidence.',
		decision_notification_review:
			'Decision notifications are not available in this live workspace yet. Decisions are recorded; nothing has been sent.',
		decision_notification_send:
			'Decision notifications are not available in this live workspace yet. Decisions are recorded; nothing has been sent.',
		decision_undo_to_undecided:
			'A committed decision cannot be returned to undecided from here.',
		decision_withdrawn_authoring:
			'Withdrawal belongs to the submitter; it cannot be set from this surface.'
	});

function unmounted(capability: DecisionsPageLiveUnmountedCapability): DecisionsPageLiveError {
	// A capability this mount deliberately does not carry cannot appear on retry.
	return new DecisionsPageLiveError({
		code: capability,
		reason: UNMOUNTED_COPY[capability],
		retryable: false
	});
}

function outcomeCopy(outcome: StructuredOutcome, subject: string, channel: 'read' | 'change'): string {
	if (outcome.class === 'access_denied') {
		return channel === 'read'
			? `You no longer have permission to read ${subject}.`
			: `You no longer have permission to change ${subject}.`;
	}
	if (outcome.class === 'stale_revision' || outcome.class === 'conflict') {
		return `The ${subject} changed while you were working. Reload and try again.`;
	}
	return channel === 'read'
		? `This ${subject} request could not be completed.`
		: `This ${subject} change could not be completed.`;
}

function readFailure(
	result:
		| Exclude<DecisionsLiveReadResult<unknown>, { readonly kind: 'success' }>
		| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome }
		| { readonly kind: 'transport_error'; readonly error: SafeApiError }
		| { readonly kind: 'unavailable'; readonly reason: string },
	subject: string
): AdapterFailure {
	if (result.kind === 'unavailable') {
		// The composed manifest is captured once; a retry cannot mount the operation.
		return {
			code: result.reason,
			reason: `The ${subject} is not available in this live workspace.`,
			retryable: false
		};
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} could not be reached. Try again.`
				: `This ${subject} request is not valid.`,
			retryable: result.error.retryable
		};
	}
	return {
		code: result.outcome.kind,
		reason: outcomeCopy(result.outcome, subject, 'read'),
		retryable: result.outcome.retryable
	};
}

const TARGET_UNAVAILABLE_REASON: Readonly<Record<string, string>> = Object.freeze({
	target_graduated: 'has already graduated into the program',
	target_closed: 'is no longer collecting proposals',
	target_missing: 'no longer exists'
});

/**
 * The typed re-offer surface for a refused attach: the server's structured
 * `decision.target_unavailable` refusal names its two decided exits, and this
 * copy re-offers exactly those — re-target another collecting session or
 * accept as a new session — never a silent fallback the organizer did not
 * choose.
 */
function decideFailure(
	result: Exclude<DecisionsLiveDecideResult, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return {
			code: result.reason,
			reason: 'Deciding is not available in this live workspace.',
			retryable: false
		};
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? 'The decision could not reach JooEvents. Try again.'
				: 'This decision is not valid.',
			retryable: result.error.retryable
		};
	}
	if (result.outcome.kind === 'decision.target_unavailable') {
		const detail = decisionTargetUnavailableDetailSchema.safeParse(result.outcome.detail);
		const because = detail.success
			? TARGET_UNAVAILABLE_REASON[detail.data.reason] ?? 'cannot take this proposal'
			: 'cannot take this proposal';
		return {
			code: result.outcome.kind,
			reason: `The session this proposal targeted ${because}. Re-target it at another collecting session, or accept it as a new session in the program pool.`,
			// Retrying the identical accept refuses identically; the two decided
			// exits in the copy are the only ways forward.
			retryable: false
		};
	}
	return {
		code: result.outcome.kind,
		reason: outcomeCopy(result.outcome, 'decision', 'change'),
		retryable: result.outcome.retryable
	};
}

function standingView(standing: ReviewStandingView): ScoreStanding {
	return {
		value: standing.value,
		scaleMax: standing.scaleMax,
		reviews: standing.reviews,
		n: standing.n,
		median: standing.median,
		band: standing.band,
		phrase: standing.phrase,
		slice: {
			label: standing.slice.label ?? '',
			...(standing.slice.trackId !== undefined ? { trackId: standing.slice.trackId } : {})
		},
		...(standing.points ? { points: [...standing.points] } : {}),
		...(standing.bins ? { bins: [...standing.bins] } : {}),
		...(standing.dotK !== undefined ? { dotK: standing.dotK } : {})
	};
}

function myReviewItem(item: NonNullable<ReviewSnapshotView['queue']>[number]): MyReviewItem {
	const current = item.committed ? item.current : undefined;
	const score = current ? current.score : item.draft?.score;
	const comment = current ? current.comment : item.draft?.comment;
	return {
		submissionId: item.submissionId,
		...(score !== undefined ? { myScore: score } : {}),
		...(comment !== undefined ? { myComment: comment } : {}),
		committed: item.committed,
		...(item.peerScores ? { peerScores: [...item.peerScores] } : {})
	};
}

function liveTrack(track: ProgramTrackView): Track {
	return {
		id: track.id,
		name: track.name,
		accent: track.accent,
		status: track.status,
		usage: { ...track.usage }
	};
}

/** The canonical whole-population reads accept at most this many ids per request. */
const READ_CHUNK = 100;

function chunked<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
	const chunks: Value[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

function defaultIdempotencyKey(): string {
	return `je.decisions.page.action.${globalThis.crypto.randomUUID()}`;
}

/**
 * Live tuned Decisions page port over the canonical mounts: candidate rows
 * come from the composed live Submissions surface (triage joined with the
 * Decision spine's head state), aggregate review evidence comes from the
 * Review core's whole-slice standings (chunked ≤100-id reads), and a verdict
 * is a consequential decide carried through draft -> propose -> commit with
 * per-row version/digest guards read immediately before drafting.
 *
 * Graduation routing is deliberately left to the server's recorded rule: an
 * accepted submission with a resolvable collecting target attaches, anything
 * else spawns a new session. A refused attach surfaces the typed
 * `decision.target_unavailable` re-offer (re-target or spawn) — never an
 * automatic exit the organizer did not choose. Notification affordances are
 * typed refusals until the send wave; nothing is ever pretended sent.
 */
export function createLiveDecisionsPagePort(input: {
	readonly decisions: DecisionsLiveClient;
	readonly review: ReviewCorePort;
	readonly vocabulary: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks'>;
	readonly settings: { get(): Promise<EventSettings | null> };
	readonly schedule: { state(): Promise<ScheduleState> };
	readonly submissions: { list(query?: SubmissionQuery): Promise<SubmissionPage> };
	readonly newIdempotencyKey?: () => string;
	readonly now?: () => number;
}): DecisionsPagePort {
	if (input.review.source.kind !== 'live' || input.vocabulary.source.kind !== 'live') {
		throw new TypeError('live_decisions_source_required');
	}
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;
	const now = input.now ?? Date.now;

	async function readSnapshot(
		request: { standingSubmissionIds?: string[] } = {}
	): Promise<ReviewSnapshotView> {
		const result = await input.review.readSnapshot(request);
		if (result.kind !== 'success') {
			throw new DecisionsPageLiveError(readFailure(result, 'review snapshot'));
		}
		return result.data;
	}

	async function readDecisionRows(
		submissionIds: readonly string[]
	): Promise<ReadonlyMap<string, DecisionStateRowDto>> {
		const rows = new Map<string, DecisionStateRowDto>();
		for (const chunk of chunked(submissionIds, READ_CHUNK)) {
			const result = await input.decisions.readState(chunk);
			if (result.kind !== 'success') {
				throw new DecisionsPageLiveError(readFailure(result, 'decision state'));
			}
			for (const row of result.data.rows) rows.set(row.submissionId, row);
		}
		return rows;
	}

	return Object.freeze({
		workspace: Object.freeze({
			/** No live workspace summary is composed here; null is "not read yet". */
			decisionAttentionExpectedSnapshot(): boolean | null {
				return null;
			}
		}),
		submissions: Object.freeze({
			list(query: { readonly tray: 'inbox' | 'late' }): Promise<SubmissionPage> {
				return input.submissions.list({ tray: query.tray });
			}
		}),
		review: Object.freeze({
			async standings(submissionIds: string[]): Promise<Record<string, ScoreStanding>> {
				const distinct = [...new Set(submissionIds)];
				if (distinct.length === 0) return {};
				const merged: Record<string, ScoreStanding> = {};
				for (const chunk of chunked(distinct, READ_CHUNK)) {
					const snapshot = await readSnapshot({ standingSubmissionIds: [...chunk] });
					for (const [submissionId, standing] of Object.entries(snapshot.standings)) {
						merged[submissionId] = standingView(standing);
					}
				}
				return merged;
			},
			/**
			 * The viewer's own queue as the server states it. An organizer holds
			 * no assignments, so the absent queue is the true empty list; a
			 * reviewer snapshot missing its queue is an absence and refuses.
			 */
			async myQueue(): Promise<MyReviewItem[]> {
				const snapshot = await readSnapshot();
				if (snapshot.queue) return snapshot.queue.map(myReviewItem);
				if (snapshot.viewer.kind === 'organizer') return [];
				throw new DecisionsPageLiveError({
					code: 'review_queue_unavailable',
					reason: 'Your review queue is not available in this live workspace.',
					retryable: false
				});
			},
			/** No accolade owner exists canonically, so no defs exist to offer. */
			async accoladeDefs(): Promise<AccoladeDef[]> {
				return [];
			},
			async plans(): Promise<ReviewPlan[]> {
				return mapLiveReviewPlans((await readSnapshot()).plans, now());
			},
			/**
			 * Decision evidence is aggregates only (recorded default): the
			 * canonical read serves whole-slice standings, never per-reviewer
			 * committed reviews, so this capability refuses rather than serving
			 * an empty list that would claim "no reviews exist".
			 */
			async forSubmission(): Promise<never> {
				throw unmounted('decision_review_evidence');
			}
		}),
		vocab: Object.freeze({
			tracks: async () => (await input.vocabulary.tracks()).map(liveTrack)
		}),
		settings: Object.freeze({
			async get(): Promise<{ readonly name: string } | null> {
				const settings = await input.settings.get();
				return settings ? { name: settings.name } : null;
			}
		}),
		templates: Object.freeze({
			/** No stored-template owner is mounted; no message templates exist. */
			async list() {
				return { messages: [] };
			}
		}),
		speakers: Object.freeze({
			/** Null is the port's own typed absence for an unknown profile. */
			async profile() {
				return null;
			}
		}),
		schedule: Object.freeze({
			state: () => input.schedule.state()
		}),
		decisions: Object.freeze({
			/**
			 * One consequential decide per chunk of at most the wire's 100 rows,
			 * guarded by the decision heads read immediately before drafting.
			 * `undecided` and `withdrawn` have no organizer authoring path and
			 * refuse typed — a failed undo states exactly why instead of
			 * silently leaving the decision standing.
			 */
			async decide(ids: string[], decision: DecisionState): Promise<void> {
				if (decision === 'undecided') throw unmounted('decision_undo_to_undecided');
				if (decision === 'withdrawn') throw unmounted('decision_withdrawn_authoring');
				const distinct = [...new Set(ids)];
				if (distinct.length === 0) return;
				const heads = await readDecisionRows(distinct);
				for (const chunk of chunked(distinct, DECISION_DECIDE_ROWS_MAX)) {
					const result = await input.decisions.decide({
						action: 'decide',
						decisions: chunk.map((submissionId) => {
							const head = heads.get(submissionId)?.head ?? null;
							return {
								submissionId,
								state: decision,
								expectedDecisionVersion: head?.version ?? null,
								expectedDecisionDigestSha256: head?.digestSha256 ?? null
								// Graduation deliberately omitted: the server routes an
								// accept by the submission's effective target (attach a
								// resolvable collecting target, spawn otherwise), and a
								// refused attach re-offers instead of guessing.
							};
						})
					}, newIdempotencyKey());
					if (result.kind !== 'success') {
						throw new DecisionsPageLiveError(decideFailure(result));
					}
				}
			},
			async reviewNotification(): Promise<never> {
				throw unmounted('decision_notification_review');
			},
			async notify(): Promise<never> {
				throw unmounted('decision_notification_send');
			}
		}),
		communications: Object.freeze({
			/**
			 * The notification dialog is the only consumer, and its send path is
			 * the recorded typed refusal above; readiness refuses with the same
			 * name rather than dressing an unusable dialog with live provider
			 * facts.
			 */
			async readiness(): Promise<never> {
				throw unmounted('decision_notification_review');
			}
		})
	} satisfies DecisionsPagePort);
}
