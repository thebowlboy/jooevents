import type { StructuredOutcome } from '@jooevents/contracts';
import { accoladePortKey, accoladeWireKey, composeCapRefusal } from './accolades';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { ReviewCoreEffectResult, ReviewCorePort } from './review-core-port';
import { assembleReviewResults, type ReviewResultCandidate } from '../features/review/review-results';
import type { ReviewPagePort, ReviewPageViewer, ReviewResultRow } from './review-page-port';
import type {
	ComparableCard,
	Format,
	MutationOutcome,
	MyReviewItem,
	ReviewPlan,
	ReviewRoundSetup,
	ReviewSubmissionDisplay,
	ScheduleState,
	ScopeRef,
	ScoreStanding,
	Track
} from './types';
import type {
	ReviewSnapshotView,
	ReviewStandingView
} from './view-models/review';
import type { ProgramFormatView, ProgramTrackView } from './view-models/program-vocabulary';

/**
 * The tuned page capabilities this deliberately partial live mount cannot
 * truthfully serve yet, each refused with its own name so a failure states
 * exactly which owner has not joined. The recorded Review core boundary
 * (review-core-port.ts) carries the canonical Review reads and writes. Only
 * capabilities without a mounted owner remain refused below.
 */
export type ReviewPageLiveUnmountedCapability =
	| 'reviewer_scope'
	| 'reviewer_reminders'
	| 'review_results';

type AdapterFailure = Readonly<{ code: string; reason: string }>;

/** Safe, reviewed-copy failure at the tuned Review boundary. */
export class ReviewPageLiveError extends Error {
	readonly code: string;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'ReviewPageLiveError';
		this.code = failure.code;
	}
}

const UNMOUNTED_COPY: Readonly<Record<ReviewPageLiveUnmountedCapability, string>> = Object.freeze({
	reviewer_scope:
		'This reviewer scope is not available in this live workspace.',
	reviewer_reminders:
		'Reviewer reminders are not available in this live workspace yet.',
	review_results:
		'Review results are not available in this live workspace yet.'
});

function unmounted(capability: ReviewPageLiveUnmountedCapability): ReviewPageLiveError {
	return new ReviewPageLiveError({ code: capability, reason: UNMOUNTED_COPY[capability] });
}

function outcomeCopy(
	outcome: StructuredOutcome,
	subject: string,
	channel: 'read' | 'change'
): string {
	// D1 error-path fix: refusals name the channel they refused. An
	// access-denied review commit used to claim the *read* permission was
	// lost, which misstates both what was attempted and what to restore.
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

type ReadFailure =
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: OperatorHttpBindingUnavailableReason };

function readFailure(result: ReadFailure, subject: string): AdapterFailure {
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: `The ${subject} is not available in this live workspace.` };
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} could not be reached. Try again.`
				: `This ${subject} request is not valid.`
		};
	}
	return { code: result.outcome.kind, reason: outcomeCopy(result.outcome, subject, 'read') };
}

/**
 * One failure grammar for every direct Review mutation, so the tuned page
 * renders the same `{code, reason}` refusal vocabulary across the whole loop.
 */
function effectFailure(
	result: Exclude<ReviewCoreEffectResult<unknown>, { readonly kind: 'success' }>,
	subject: string
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return {
			code: result.reason,
			reason: `The ${subject} is not available in this live workspace.`
		};
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} change could not reach JooEvents. Try again.`
				: `This ${subject} change is not valid.`
		};
	}
	return {
		code: result.outcome.kind,
		reason: outcomeCopy(result.outcome, subject, 'change')
	};
}

function invalidContract(subject: string): AdapterFailure {
	return {
		code: 'invalid_contract',
		reason: `This ${subject} request could not be completed.`
	};
}

const UTC_MONTHS = Object.freeze([
	'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]);

function utcDayNumber(epochMs: number): number {
	return Math.floor(epochMs / 86_400_000);
}

/**
 * The tuned plan's one presentation field, derived deterministically from the
 * canonical UTC deadline instant — never from a browser locale. Open rounds
 * phrase distance by whole UTC days; closed rounds name their UTC calendar
 * date, matching the product's established deadline copy.
 */
function deadlinePhrase(state: 'open' | 'closed', deadlineIso: string, nowMs: number): string {
	const deadline = Date.parse(deadlineIso);
	if (state === 'closed') {
		const date = new Date(deadline);
		return `closed ${UTC_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
	}
	const days = utcDayNumber(deadline) - utcDayNumber(nowMs);
	if (days < 0) return days === -1 ? 'due yesterday' : `overdue by ${-days} days`;
	if (days === 0) return 'due today';
	if (days === 1) return 'due tomorrow';
	return `due in ${days} days`;
}

/**
 * Canonical plans projected into the tuned shape. Discarded rounds are the
 * tuned list's removed records — `discardRound` takes a plan off the page —
 * so they are omitted rather than shown as live rounds; open and closed
 * rounds both remain, because closed history stays listed. A reviewer row
 * whose canonical projection discloses no display name keeps that absence as
 * the tuned string's empty value; a label is never invented for it.
 */
export function mapLiveReviewPlans(
	plans: ReviewSnapshotView['plans'],
	nowMs: number
): ReviewPlan[] {
	const kept: ReviewPlan[] = [];
	for (const plan of plans) {
		if (plan.state === 'discarded') continue;
		kept.push({
			id: plan.id,
			name: plan.name,
			scaleMax: plan.scaleMax,
			deadlineRelative: deadlinePhrase(plan.state, plan.deadlineEffectiveAt, nowMs),
			anonymized: plan.anonymized,
			done: plan.done,
			total: plan.total,
			reviewers: plan.reviewers.map((row) => ({
				id: row.reviewerId,
				name: row.displayName ?? '',
				assigned: row.assigned,
				done: row.done,
				steppedBack: row.steppedBack,
				awaitingReassignment: row.awaitingReassignment,
				...(row.uncovered === undefined ? {} : {
					uncovered: row.uncovered.map((entry) => ({ ...entry }))
				})
			})),
			antiAnchoring: plan.antiAnchoring
		});
	}
	return kept;
}

function myReviewItem(item: NonNullable<ReviewSnapshotView['queue']>[number]): MyReviewItem {
	const current = item.committed ? item.current : undefined;
	const score = current ? current.score : item.draft?.score;
	const comment = current ? current.comment : item.draft?.comment;
	const priorRevisions = current
		? item.revisions.filter((revision) => revision.revisionId !== current.revisionId)
		: [];
	return {
		submissionId: item.submissionId,
		...(score !== undefined ? { myScore: score } : {}),
		...(comment !== undefined ? { myComment: comment } : {}),
		committed: item.committed,
		...(item.peerScores ? { peerScores: [...item.peerScores] } : {}),
		...(priorRevisions.length > 0
			? {
				revisions: priorRevisions.map((revision) => ({
						score: revision.score,
						comment: revision.comment,
						at: revision.at,
						postUnlock: revision.postUnlock
					}))
				}
			: {}),
		...(item.accolades === undefined || item.accolades.length === 0
			? {}
			: { accolades: item.accolades.map((pin) => accoladePortKey(pin.key)) })
	};
}

/**
 * Maps only the candidate display already authorized by Review. It never
 * consults Intake's organizer projection and never fabricates the wider
 * submission lifecycle fields that a reviewer is not entitled to read.
 */
function reviewSubmission(
	item: NonNullable<ReviewSnapshotView['queue']>[number]
): ReviewSubmissionDisplay {
	return {
		id: item.candidate.submissionId,
		title: item.candidate.title,
		abstract: item.candidate.abstract,
		speakers: (item.candidate.speakers ?? []).map((speaker) => ({
			id: speaker.speakerId,
			name: speaker.displayName
		})),
		...(item.candidate.trackId !== undefined ? { trackId: item.candidate.trackId } : {}),
		...(item.candidate.formatId !== undefined ? { formatId: item.candidate.formatId } : {}),
		...(item.candidate.targetSessionId !== undefined
			? { targetSessionId: item.candidate.targetSessionId }
			: {}),
		submittedAt: item.candidate.submittedAt,
		resources: item.candidate.resources.map((resource) => ({
			name: resource.name,
			kind: resource.kind,
			detail: resource.detail
		}))
	};
}

/**
 * Canonical standing projected into the tuned shape. The canonical slice
 * label is optional disclosure; its absence is carried as the tuned string's
 * empty value, never replaced with an invented slice name.
 */
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

function liveTrack(track: ProgramTrackView): Track {
	return {
		id: track.id,
		name: track.name,
		accent: track.accent,
		status: track.status,
		usage: { ...track.usage }
	};
}

function liveFormat(format: ProgramFormatView): Format {
	return {
		id: format.id,
		name: format.name,
		status: format.status,
		usage: { ...format.usage }
	};
}

/** The canonical standings read accepts at most this many ids per request. */
const STANDINGS_READ_CHUNK = 100;

function chunked<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
	const chunks: Value[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

/**
 * Live tuned Review page port over the canonical mount: the Review core
 * port's reads (snapshot plans with their served criterion identities, the
 * viewer's own queue, whole-slice standings, round setup, the viewer's own
 * scope), its feature-owned evaluation draft save, and its direct round,
 * assignment, and evaluation mutations. Everything else surfaces the port's
 * typed refusal or its typed absence — never sample fallback, fabricated
 * zeros, or silent no-ops.
 *
 * `saveReview` maps the tuned single score onto the round's served criterion
 * identities. A round serving more than one criterion cannot truthfully
 * accept one overall number, so the save refuses instead of minting ids or
 * splitting the score — criterion identities only ever come from the
 * canonical round.
 */
export function createLiveReviewPagePort(input: {
	readonly review: ReviewCorePort;
	readonly vocabulary: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'>;
	readonly schedule: { state(): Promise<ScheduleState> };
	readonly viewer: ReviewPageViewer;
	readonly now?: () => number;
	/** Mints one idempotency anchor per user-visible attempt. */
	readonly newAttemptKey?: () => string;
	/**
	 * Organizer-authorized candidates for results/export. Absent keeps the
	 * results read unmounted rather than inventing a second classified list.
	 */
	readonly results?: { list(): Promise<readonly ReviewResultCandidate[]> };
	/** Optional already-wired reminder lane; absent stays an honest refusal. */
	readonly remind?: (reviewerIds: readonly string[], subject: string) => Promise<unknown>;
}): ReviewPagePort {
	if (input.review.source.kind !== 'live' || input.vocabulary.source.kind !== 'live') {
		throw new TypeError('live_review_source_required');
	}
	const now = input.now ?? Date.now;
	const newAttemptKey = input.newAttemptKey ?? (() => crypto.randomUUID());
	let latestSnapshot: ReviewSnapshotView | undefined;

	async function readSnapshot(
		request: { standingSubmissionIds?: string[]; standingSlice?: 'track' | 'all' } = {}
	): Promise<ReviewSnapshotView> {
		const result = await input.review.readSnapshot(request);
		if (result.kind !== 'success') {
			throw new ReviewPageLiveError(readFailure(result, 'review snapshot'));
		}
		latestSnapshot = result.data;
		return latestSnapshot;
	}

	async function readStandings(submissionIds: readonly string[]): Promise<Record<string, ScoreStanding>> {
		const distinct = [...new Set(submissionIds)];
		if (distinct.length === 0) return {};
		const merged: Record<string, ScoreStanding> = {};
		for (const chunk of chunked(distinct, STANDINGS_READ_CHUNK)) {
			const snapshot = await readSnapshot({ standingSubmissionIds: [...chunk] });
			for (const [submissionId, standing] of Object.entries(snapshot.standings)) {
				merged[submissionId] = standingView(standing);
			}
		}
		return merged;
	}

	function queueItem(
		snapshot: ReviewSnapshotView,
		submissionId: string
	): NonNullable<ReviewSnapshotView['queue']>[number] {
		const item = snapshot.queue?.find((entry) => entry.submissionId === submissionId);
		if (!item) {
			throw new ReviewPageLiveError({
				code: 'review_assignment_missing',
				reason: 'This submission is not in your review queue.'
			});
		}
		return item;
	}

	/** The outcome-channel translation: typed adapter throws become `{ok:false}`. */
	async function asOutcome(work: () => Promise<MutationOutcome>): Promise<MutationOutcome> {
		try {
			return await work();
		} catch (error) {
			if (error instanceof ReviewPageLiveError) return { ok: false, reason: error.message };
			throw error;
		}
	}

	/**
	 * Every correction, including receipt Undo, is a new guarded amendment.
	 * Retained revisions are never deleted or rewound; putting an earlier value
	 * back is itself attributable history.
	 */
	async function amendEvaluation(
		snapshot: ReviewSnapshotView,
		item: NonNullable<ReviewSnapshotView['queue']>[number],
		score: number,
		comment: string
	): Promise<MyReviewItem | null> {
		if (!item.committed || !item.current) {
			throw new ReviewPageLiveError({ code: 'review_not_committed',
				reason: 'Commit this review before amending it.' });
		}
		const plan = snapshot.plans.find((candidate) => candidate.id === item.roundId);
		if (!plan || plan.criteria.length !== 1) {
			throw new ReviewPageLiveError(invalidContract('review amendment'));
		}
		const criterion = plan.criteria[0]!;
		if (!Number.isInteger(score) || score < criterion.scaleMin || score > criterion.scaleMax) {
			throw new ReviewPageLiveError({ code: 'review_score_invalid',
				reason: `Scores are whole numbers from ${criterion.scaleMin} to ${criterion.scaleMax}.` });
		}
		const changed = await input.review.changeEvaluation({
			action: 'amend_review', assignmentId: item.assignmentId,
			expectedAssignmentVersion: item.assignmentVersion,
			expectedReviewVersion: item.revisions.length,
			expectedCurrentRevisionId: item.current.revisionId,
			scores: [{ criterionId: criterion.id, score }], comment
		}, newAttemptKey());
		if (changed.kind !== 'success') {
			throw new ReviewPageLiveError(effectFailure(changed, 'review amendment'));
		}
		if (changed.data.action !== 'amend_review') {
			throw new ReviewPageLiveError(invalidContract('review amendment'));
		}
		const after = await readSnapshot();
		const amended = after.queue?.find((entry) => entry.submissionId === item.submissionId);
		return amended ? myReviewItem(amended) : null;
	}

	return Object.freeze({
		viewer: Object.freeze({ ...input.viewer }),
		workspace: Object.freeze({
			/** No live workspace summary is composed here; null is "not read yet". */
			reviewPlanExpectedSnapshot(): boolean | null {
				return null;
			}
		}),
		vocab: Object.freeze({
			tracks: async () => (await input.vocabulary.tracks()).map(liveTrack),
			formats: async () => (await input.vocabulary.formats()).map(liveFormat)
		}),
		submissions: Object.freeze({
			/**
			 * The canonical Review snapshot has already joined and redacted the
			 * candidate for this viewer. Use that exact record; do not cross into
			 * the organizer's wider Intake projection just to paint the queue.
			 */
			async get(id: string): Promise<ReviewSubmissionDisplay | null> {
				const cached = latestSnapshot?.queue?.find((item) => item.submissionId === id);
				if (cached) return reviewSubmission(cached);
				const snapshot = await readSnapshot();
				const item = snapshot.queue?.find((candidate) => candidate.submissionId === id);
				return item ? reviewSubmission(item) : null;
			}
		}),
		review: Object.freeze({
			async plans(): Promise<ReviewPlan[]> {
				return mapLiveReviewPlans((await readSnapshot()).plans, now());
			},
			async roundSetup(): Promise<ReviewRoundSetup> {
				const result = await input.review.readRoundSetup();
				if (result.kind !== 'success') {
					throw new ReviewPageLiveError(readFailure(result, 'round setup'));
				}
				return {
					activeReviewers: result.data.activeReviewers,
					invitedReviewers: result.data.invitedReviewers,
					submissions: result.data.submissions,
					expectedReviews: result.data.expectedReviews,
					perReviewer: result.data.perReviewer.map((row) => ({
						id: row.reviewerId,
						// Undisclosed display names stay absent ('' in the tuned string).
						name: row.displayName ?? '',
						assigned: row.assigned
					}))
				};
			},
			async openRound(request: {
				deadlineIso: string;
				anonymized: boolean;
			}): Promise<ReviewPlan> {
				// `criteria` stays absent on purpose: the server opens the round
				// with its single default criterion, which the snapshot then serves.
				const changed = await input.review.changeRound({
					action: 'open_round',
					deadlineDate: request.deadlineIso,
					anonymized: request.anonymized
				}, newAttemptKey());
				if (changed.kind !== 'success') {
					throw new ReviewPageLiveError(effectFailure(changed, 'review round'));
				}
				if (changed.data.action !== 'open_round') {
					throw new ReviewPageLiveError(invalidContract('review round'));
				}
				const roundId = changed.data.round.id;
				const opened = mapLiveReviewPlans((await readSnapshot()).plans, now())
					.find((plan) => plan.id === roundId);
				if (!opened) throw new ReviewPageLiveError(invalidContract('review round'));
				return opened;
			},
			discardRound(planId: string): Promise<MutationOutcome> {
				return asOutcome(async () => {
					const snapshot = await readSnapshot();
					const plan = snapshot.plans.find((candidate) => candidate.id === planId);
					if (!plan) {
						return { ok: false, reason: 'This round is not on the current review plan.' };
					}
					const changed = await input.review.changeRound({
						action: 'discard_empty_round',
						roundId: planId,
						expectedRoundVersion: plan.version
					}, newAttemptKey());
					if (changed.kind !== 'success') {
						return { ok: false, reason: effectFailure(changed, 'review round').reason };
					}
					return changed.data.action === 'discard_empty_round'
						? { ok: true }
						: { ok: false, reason: invalidContract('review round').reason };
				});
			},
			/**
			 * The viewer's own queue only, as the server states it. An organizer
			 * snapshot carries no queue because an organizer holds no assignments —
			 * that empty list is the true state — while a reviewer snapshot missing
			 * its queue is an absence and refuses rather than claiming "nothing to
			 * review".
			 */
			async myQueue(): Promise<MyReviewItem[]> {
				const snapshot = await readSnapshot();
				if (snapshot.queue) return snapshot.queue.map(myReviewItem);
				if (snapshot.viewer.kind === 'organizer') return [];
				throw new ReviewPageLiveError({
					code: 'review_queue_unavailable',
					reason: 'Your review queue is not available in this live workspace.'
				});
			},
			async saveReview(submissionId: string, score: number, comment: string): Promise<void> {
				const snapshot = await readSnapshot();
				const item = queueItem(snapshot, submissionId);
				if (item.committed) {
					throw new ReviewPageLiveError({
						code: 'review_already_committed',
						reason: 'This review is already committed; a saved draft can no longer change it.'
					});
				}
				const plan = snapshot.plans.find((candidate) => candidate.id === item.roundId);
				if (!plan) throw new ReviewPageLiveError(invalidContract('review draft'));
				if (plan.criteria.length !== 1) {
					throw new ReviewPageLiveError({
						code: 'review_multi_criterion_round',
						reason: 'This round scores several criteria; saving one overall score is not available here.'
					});
				}
				const criterion = plan.criteria[0]!;
				if (!Number.isInteger(score)
					|| score < criterion.scaleMin
					|| score > criterion.scaleMax) {
					throw new ReviewPageLiveError({
						code: 'review_score_invalid',
						reason: `Scores are whole numbers from ${criterion.scaleMin} to ${criterion.scaleMax}.`
					});
				}
				const saved = await input.review.saveEvaluationDraft({
					assignmentId: item.assignmentId,
					expectedDraftVersion: item.draft?.version ?? null,
					scores: [{ criterionId: criterion.id, score }],
					comment
				}, newAttemptKey());
				if (saved.kind !== 'success') {
					throw new ReviewPageLiveError(effectFailure(saved, 'review draft'));
				}
			},
			async commitReview(submissionId: string): Promise<MyReviewItem | null> {
				const snapshot = await readSnapshot();
				const item = queueItem(snapshot, submissionId);
				// An already-committed review is served truth, not a new write.
				if (item.committed) return myReviewItem(item);
				if (!item.draft) {
					throw new ReviewPageLiveError({
						code: 'review_draft_missing',
						reason: 'Save a score before committing this review.'
					});
				}
				const changed = await input.review.changeEvaluation({
					action: 'commit_review',
					assignmentId: item.assignmentId,
					expectedAssignmentVersion: item.assignmentVersion,
					expectedDraftVersion: item.draft.version
				}, newAttemptKey());
				if (changed.kind !== 'success') {
					throw new ReviewPageLiveError(effectFailure(changed, 'review commit'));
				}
				if (changed.data.action !== 'commit_review') {
					throw new ReviewPageLiveError(invalidContract('review commit'));
				}
				// The committed truth is re-read, never locally synthesized.
				const after = await readSnapshot();
				const committed = after.queue?.find((entry) => entry.submissionId === submissionId);
				return committed ? myReviewItem(committed) : null;
			},
			/** Absent key = the canonically served "no standing" absence, kept as null. */
			async standing(submissionId: string): Promise<ScoreStanding | null> {
				const snapshot = await readSnapshot({ standingSubmissionIds: [submissionId] });
				// The canonical record is keyed by branded ids; the tuned read asks
				// by plain string, so the lookup walks the served entries.
				const entry = Object.entries(snapshot.standings).find(([key]) => key === submissionId);
				return entry ? standingView(entry[1]) : null;
			},
			/**
			 * The canonical read serves at most 100 standings per request, so a
			 * larger ask becomes exact chunked reads merged by submission id —
			 * never a silently truncated single request.
			 */
			async standings(submissionIds: string[]): Promise<Record<string, ScoreStanding>> {
				return readStandings(submissionIds);
			},
			async results(): Promise<ReviewResultRow[]> {
				if (input.viewer.kind !== 'organizer') {
					throw new ReviewPageLiveError({
						code: 'review_results_organizer_only',
						reason: 'Review results are available to the people running this round.'
					});
				}
				if (!input.results) throw unmounted('review_results');
				const candidates = await input.results.list();
				return assembleReviewResults(candidates, await readStandings(candidates.map((row) => row.submissionId)));
			},
			async amend(submissionId: string, score: number, comment: string): Promise<MyReviewItem | null> {
				const snapshot = await readSnapshot();
				const item = queueItem(snapshot, submissionId);
				return amendEvaluation(snapshot, item, score, comment);
			},
			async revertAmend(submissionId: string): Promise<MyReviewItem | null> {
				const snapshot = await readSnapshot();
				const item = queueItem(snapshot, submissionId);
				if (!item.committed || !item.current) {
					throw new ReviewPageLiveError({ code: 'review_not_committed',
						reason: 'Commit this review before restoring an earlier score.' });
				}
				const currentIndex = item.revisions.findIndex(
					(revision) => revision.revisionId === item.current?.revisionId
				);
				const prior = currentIndex > 0 ? item.revisions[currentIndex - 1] : undefined;
				// No earlier revision means there is nothing to compensate. Return the
				// served truth without manufacturing a write or a failure.
				if (!prior) return myReviewItem(item);
				return amendEvaluation(snapshot, item, prior.score, prior.comment);
			},
			async comparables(submissionId: string, slice: 'track' | 'all'): Promise<ComparableCard[]> {
				const snapshot = await readSnapshot();
				const anchor = queueItem(snapshot, submissionId);
				if (!anchor.committed) return [];
				const candidates = (snapshot.queue ?? []).filter((item) =>
					item.committed
					&& item.submissionId !== submissionId
					&& (slice === 'all' || item.candidate.trackId === anchor.candidate.trackId)
				);
				const standings: Record<string, ScoreStanding> = {};
				for (const ids of chunked(candidates.map((item) => item.submissionId), STANDINGS_READ_CHUNK)) {
					const served = await readSnapshot({
						standingSubmissionIds: [...ids],
						standingSlice: slice
					});
					for (const [id, standing] of Object.entries(served.standings)) {
						standings[id] = standingView(standing);
					}
				}
				return candidates
					.map((item) => ({
						item: myReviewItem(item),
						submission: reviewSubmission(item),
						standing: standings[item.submissionId] ?? null
					}))
					.sort((left, right) => (right.item.myScore ?? 0) - (left.item.myScore ?? 0));
			},
			async accoladeDefs() {
				const snapshot = await readSnapshot();
				return snapshot.accoladeDefinitions.map((definition) => ({
					key: accoladePortKey(definition.key),
					label: definition.label,
					...(definition.cap === undefined ? {} : { cap: definition.cap })
				}));
			},
			async pinAccolade(submissionId, key): Promise<MutationOutcome> {
				return asOutcome(async () => {
					const snapshot = await readSnapshot();
					const item = queueItem(snapshot, submissionId);
					const wireKey = accoladeWireKey(key);
					const definition = snapshot.accoladeDefinitions.find((entry) => entry.key === wireKey);
					if (!definition) return { ok: false, reason: 'This accolade is not available.' };
					const changed = await input.review.changeAccolade({
						action: 'pin_accolade',
						assignmentId: item.assignmentId,
						expectedAssignmentVersion: item.assignmentVersion,
						key: wireKey,
						expectedDefinitionVersion: definition.version
					}, newAttemptKey());
					if (changed.kind === 'success') return { ok: true };
					if (changed.kind === 'outcome'
						&& changed.outcome.kind === 'review.accolade_cap_exceeded') {
						const detail = changed.outcome.detail as { holderSubmissionIds?: unknown } | null;
						const holders = Array.isArray(detail?.holderSubmissionIds)
							? detail.holderSubmissionIds.filter((id): id is string => typeof id === 'string')
							: [];
						const titles = holders.map((id) => snapshot.queue?.find((row) => row.submissionId === id)
							?.candidate.title ?? 'another submission');
						return {
							ok: false,
							reason: composeCapRefusal({
								key,
								label: definition.label,
								...(definition.cap === undefined ? {} : { cap: definition.cap })
							}, titles)
						};
					}
					return { ok: false, reason: effectFailure(changed, 'review accolade').reason };
				});
			},
			async unpinAccolade(submissionId, key): Promise<MutationOutcome> {
				return asOutcome(async () => {
					const snapshot = await readSnapshot();
					const item = queueItem(snapshot, submissionId);
					const wireKey = accoladeWireKey(key);
					const definition = snapshot.accoladeDefinitions.find((entry) => entry.key === wireKey);
					const pin = item.accolades?.find((entry) => entry.key === wireKey);
					if (!definition || !pin) return { ok: false, reason: 'This accolade is no longer pinned.' };
					const changed = await input.review.changeAccolade({
						action: 'unpin_accolade',
						assignmentId: item.assignmentId,
						expectedAssignmentVersion: item.assignmentVersion,
						key: wireKey,
						expectedDefinitionVersion: definition.version,
						expectedObservationId: pin.observationId
					}, newAttemptKey());
					return changed.kind === 'success'
						? { ok: true }
						: { ok: false, reason: effectFailure(changed, 'review accolade').reason };
				});
			},
			/**
			 * The snapshot serves only the viewer's own scope; any other subject's
			 * scope is not a served fact and refuses rather than answering with an
			 * invented (or generalist-shaped) empty scope.
			 */
			async myScope(reviewerId: string): Promise<ScopeRef[]> {
				const snapshot = await readSnapshot();
				if (
					snapshot.viewer.kind !== 'reviewer'
					|| snapshot.viewer.reviewerId !== reviewerId
					|| snapshot.reviewerScope === undefined
				) {
					throw unmounted('reviewer_scope');
				}
				return snapshot.reviewerScope.map((ref) => ({ kind: ref.kind, id: ref.id }));
			},
			stepBack(submissionId: string, reviewerId: string): Promise<MutationOutcome> {
				return asOutcome(async () => {
					// The queue serves only the viewer's own assignments, so only
					// the viewer's own step-back is expressible here.
					if (input.viewer.kind !== 'reviewer' || input.viewer.reviewerId !== reviewerId) {
						return {
							ok: false,
							reason: 'Only your own assignment can be stepped back from here.'
						};
					}
					const snapshot = await readSnapshot();
					const item = queueItem(snapshot, submissionId);
					const changed = await input.review.stepBack({
						action: 'step_back',
						assignmentId: item.assignmentId,
						expectedAssignmentVersion: item.assignmentVersion
					}, newAttemptKey());
					if (changed.kind !== 'success') {
						return { ok: false, reason: effectFailure(changed, 'review assignment').reason };
					}
					return changed.data.action === 'step_back'
						? { ok: true }
						: { ok: false, reason: invalidContract('review assignment').reason };
				});
			}
		}),
		speakers: Object.freeze({
			/** Null is the port's own typed absence for an unknown profile. */
			async profile() {
				return null;
			}
		}),
		tasks: Object.freeze({
			async remind(reviewerIds: string[], subject: string): Promise<unknown> {
				if (!input.remind) throw unmounted('reviewer_reminders');
				return input.remind(reviewerIds, subject);
			}
		}),
		schedule: Object.freeze({
			/** Session scope resolves through the same canonical Schedule projection. */
			state: () => input.schedule.state()
		})
	} satisfies ReviewPagePort);
}
