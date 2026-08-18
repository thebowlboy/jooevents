import { describe, expect, test } from 'bun:test';
import {
	reviewDraftSaveResultSchema,
	reviewAccoladeChangeResultSchema,
	reviewAccoladePinProjectionSchema,
	reviewMutationResultSchema,
	reviewSnapshotSchema,
	type ReviewAccoladeDefinitionProjection,
	type ReviewAccoladePinProjection,
	type ReviewMutationResult
} from '@jooevents/contracts/reviews';
import { mapReviewSnapshot } from './mappers/review';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { ReviewCorePort } from './review-core-port';
import { createLiveReviewPagePort, mapLiveReviewPlans } from './review-page-port.live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const correlationId = id(90); const scope = { workspaceId: id(80), eventId: id(81) };
const reviewerId = id(2); const assignmentId = id(3); const submissionId = id(4);
const roundId = id(5); const criterionId = id(6); const revisionId = id(7);
const criterion = { id: criterionId, key: 'overall', label: 'Overall', position: 0,
	weightBps: 10_000, scaleMin: 1, scaleMax: 5 };
const round = { id: roundId, ordinal: 1, name: 'Round 1', state: 'open' as const, version: 1,
	scaleMax: 5 as const, deadlineEffectiveAt: '2027-03-20T23:59:59.000Z', criteria: [criterion],
	anonymized: true, antiAnchoring: true, done: 0, total: 1,
	reviewers: [{ reviewerId, displayName: 'Ada', assigned: 1, done: 0, steppedBack: 0, awaitingReassignment: 0 }] };
function snapshot(input: { committed?: boolean; revisions?: { score: number; comment: string }[];
	anonymized?: boolean; comparable?: boolean; standingSlice?: 'track' | 'all';
	definitions?: readonly ReviewAccoladeDefinitionProjection[];
	accolades?: readonly ReviewAccoladePinProjection[] } = {}) {
	const committed = input.committed ?? false;
	const revisions = input.revisions ?? (committed ? [{ score: 4, comment: 'Good' }] : []);
	const revisionCount = revisions.length;
	const anonymized = input.anonymized ?? true;
	const currentValue = revisions[revisionCount - 1] ?? { score: 4, comment: 'Good' };
	const current = { revisionId: id(6 + revisionCount), ...currentValue,
		at: '2027-03-02T00:00:00.000Z', postUnlock: revisionCount > 1 };
	const primary = { assignmentId, roundId, submissionId, assignmentVersion: 2,
		candidate: { submissionId, version: 1, title: 'Talk', abstract: 'Abstract', trackId: id(10),
			submittedAt: '2027-03-01T00:00:00.000Z',
			resources: [{ resourceId: id(8), name: 'Deck', kind: 'slides' as const, detail: 'PDF' }],
			...(!anonymized ? { speakers: [{ speakerId: id(9), displayName: 'Ada Speaker' }] } : {}) },
		...(input.accolades === undefined || input.accolades.length === 0
			? {} : { accolades: input.accolades }),
		...(committed ? { committed: true as const, current, revisions: revisions.map((value, index) => ({
			...current, ...value, revisionId: id(7 + index), postUnlock: index > 0,
			...(index > 0 ? { correctionOfRevisionId: id(6 + index) } : {}) })) }
			: { committed: false as const, draft: { version: 1, score: 4, comment: 'Notes' }, revisions: [] }) };
	const comparableSubmissionId = id(14);
	const comparable = { assignmentId: id(15), roundId, submissionId: comparableSubmissionId,
		assignmentVersion: 1,
		candidate: { submissionId: comparableSubmissionId, version: 1, title: 'Second talk',
			abstract: 'Second abstract', trackId: id(10), submittedAt: '2027-03-01T01:00:00.000Z',
			resources: [] },
		committed: true as const,
		current: { revisionId: id(16), score: 3, comment: 'Solid',
			at: '2027-03-02T01:00:00.000Z', postUnlock: false },
		revisions: [{ revisionId: id(16), score: 3, comment: 'Solid',
			at: '2027-03-02T01:00:00.000Z', postUnlock: false }] };
	const standing = { submissionId: comparableSubmissionId, value: 3, scaleMax: 5 as const,
		reviews: 1, n: 1, median: 3, band: 'few' as const, phrase: 'Not enough reviews to rank.',
		slice: { label: input.standingSlice === 'all' ? 'All submissions' : 'Track' }, points: [] };
	return mapReviewSnapshot(reviewSnapshotSchema.parse({ schemaVersion: 1,
		viewer: { kind: 'reviewer', reviewerId }, plans: [{ ...round, anonymized }],
		accoladeDefinitions: input.definitions ?? [],
		standings: input.comparable ? { [comparableSubmissionId]: standing } : {}, reviewerScope: [],
		queue: input.comparable ? [primary, comparable] : [primary] }));
}
const vocabulary: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'> = {
	source: { kind: 'live' }, async tracks() { return []; }, async formats() { return []; }
};
const scheduleState = { days: [], rooms: [], dayStart: '09:00', slotMinutes: 30,
	slotsPerDay: 0, sessions: [], placements: [], breaks: [], published: false };
const schedule = { async state() { return scheduleState; } };
function mutation(action: ReviewMutationResult['action']): ReviewMutationResult {
	if (action === 'open_round' || action === 'discard_empty_round') {
		const canonicalRound = { schemaVersion: 1 as const, scope, id: roundId, ordinal: 1, name: 'Round 1', version: 1,
			deadline: { deadlineId: id(20), kind: 'review_due' as const, version: 1, digestSha256: 'a'.repeat(64),
				effectiveAt: '2027-03-20T23:59:59.000Z' }, criteria: [criterion],
			visibility: { participantIdentity: 'hidden' as const, peerReviewerIdentity: 'hidden' as const,
				peerContentUnlock: 'after_own_commit' as const }, openedByUserId: id(21),
			openedAt: '2027-03-01T00:00:00.000Z', state: action === 'open_round' ? 'open' as const : 'discarded' as const,
			...(action === 'discard_empty_round' ? { discardedByUserId: id(21), discardedAt: '2027-03-02T00:00:00.000Z' } : {}) };
		return reviewMutationResultSchema.parse(action === 'open_round'
			? { action, round: canonicalRound, assignmentCount: 1 }
			: { action, round: canonicalRound });
	}
	if (action === 'step_back') return reviewMutationResultSchema.parse({ action, assignment: { schemaVersion: 1, scope, id: assignmentId,
		roundId, submissionId, reviewerId, version: 3, state: 'stepped_back', assignedAt: '2027-03-01T00:00:00.000Z',
		steppedBackAt: '2027-03-02T00:00:00.000Z', steppedBackByUserId: reviewerId } });
	const head = { schemaVersion: 1 as const, scope, assignmentId, version: action === 'amend_review' ? 2 : 1,
		currentRevisionId: revisionId, firstCommittedAt: '2027-03-02T00:00:00.000Z', peerUnlockedAt: '2027-03-02T00:00:00.000Z' };
	const revision = { schemaVersion: 1 as const, scope, id: revisionId, assignmentId,
		revisionNumber: action === 'amend_review' ? 2 : 1, scores: [{ criterionId, score: 4 }], weightedScore: 4,
		comment: 'Good', committedByReviewerId: reviewerId, committedByUserId: reviewerId,
		committedAt: '2027-03-02T00:00:00.000Z', postUnlock: action === 'amend_review',
		...(action === 'amend_review' ? { correctionOfRevisionId: id(6) } : {}) };
	return reviewMutationResultSchema.parse({ action, head, revision });
}
function core(input: { committed?: boolean; anonymized?: boolean; comparable?: boolean;
	keys: string[]; actions: string[];
	definitions?: readonly ReviewAccoladeDefinitionProjection[];
	accolades?: readonly ReviewAccoladePinProjection[];
	capHolderSubmissionIds?: readonly string[] }): ReviewCorePort {
	let committed = input.committed ?? false;
	const revisions = committed ? [{ score: 4, comment: 'Good' }] : [];
	let accolades = [...(input.accolades ?? [])];
	return { source: { kind: 'live' },
		async readSnapshot(request) { return { kind: 'success', data: snapshot({ committed,
			revisions, anonymized: input.anonymized, comparable: input.comparable,
			standingSlice: request?.standingSlice, definitions: input.definitions, accolades }), correlationId }; },
		async readRoundSetup() { return { kind: 'success', data: { activeReviewers: 1, invitedReviewers: 0,
			submissions: 1, expectedReviews: 1, perReviewer: [] }, correlationId }; },
		async changeRound(value, key) { input.keys.push(key); input.actions.push(value.action);
			return { kind: 'success', data: mutation(value.action),
				receipt: { id: id(40), operationName: 'review.round.change', operationVersion: 1 }, correlationId }; },
		async stepBack(value, key) { input.keys.push(key); input.actions.push(value.action);
			return { kind: 'success', data: mutation('step_back'),
				receipt: { id: id(41), operationName: 'review.assignment.step_back', operationVersion: 1 }, correlationId }; },
		async changeEvaluation(value, key) { input.keys.push(key); input.actions.push(value.action);
			if (value.action === 'commit_review') revisions.push({ score: 4, comment: 'Notes' });
			else revisions.push({ score: value.scores[0]!.score, comment: value.comment });
			committed = true;
			return { kind: 'success', data: mutation(value.action),
				receipt: { id: id(42), operationName: 'review.evaluation.change', operationVersion: 1 }, correlationId }; },
		async changeAccolade(value, key) { input.keys.push(key); input.actions.push(value.action);
			if (value.action === 'pin_accolade' && input.capHolderSubmissionIds) {
				return { kind: 'outcome', terminal: false as const, correlationId, outcome: {
					class: 'policy_violation' as const,
					kind: 'review.accolade_cap_exceeded', retryable: false,
					subjects: [{ type: 'review', id: submissionId }],
					detail: { code: 'write_cap_exceeded', action: value.action,
						subjectId: submissionId,
						holderSubmissionIds: [...input.capHolderSubmissionIds] },
					detailSchemaVersion: 1
				} };
			}
			const observationId = value.action === 'pin_accolade' ? id(44) : value.expectedObservationId;
			if (value.action === 'pin_accolade') {
				accolades = [...accolades, reviewAccoladePinProjectionSchema.parse({
					key: value.key, definitionVersion: value.expectedDefinitionVersion, observationId
				})];
			} else {
				accolades = accolades.filter((pin) => pin.observationId !== value.expectedObservationId);
			}
			return { kind: 'success', data: reviewAccoladeChangeResultSchema.parse({
				action: value.action, key: value.key, submissionId,
				definitionVersion: value.expectedDefinitionVersion,
				observationId,
				pinned: value.action === 'pin_accolade'
			}), receipt: { id: id(45), operationName: 'review.accolade.change', operationVersion: 1 }, correlationId }; },
		async saveEvaluationDraft(_value, key) { input.keys.push(key); input.actions.push('save_draft');
			return { kind: 'success', data: reviewDraftSaveResultSchema.parse({ draft: { schemaVersion: 1, scope, assignmentId, version: 2,
				scores: [{ criterionId, score: 4 }], comment: 'Notes', updatedByReviewerId: reviewerId,
				updatedByUserId: reviewerId, updatedAt: '2027-03-02T00:00:00.000Z' } }),
				receipt: { id: id(43), operationName: 'review.evaluation.draft.save', operationVersion: 1 }, correlationId }; }
	};
}

describe('direct live Review page port', () => {
	test('carries organizer-served uncovered review detail into the roster load', () => {
		const served = reviewSnapshotSchema.parse({
			schemaVersion: 1,
			viewer: { kind: 'organizer' },
			plans: [{
				...round,
				reviewers: [{
					reviewerId,
					displayName: 'Ada',
					assigned: 1,
					done: 0,
					steppedBack: 1,
					awaitingReassignment: 1,
					uncovered: [{
						assignmentId,
						assignmentVersion: 2,
						roundId: round.id,
						submissionId,
						title: 'Talk',
						remainingReviewers: 0,
						replacementCandidates: [{
							reviewerId: id(60),
							displayName: 'Morgan',
							assigned: 0,
							scopeMatch: true
						}]
					}]
				}]
			}],
			accoladeDefinitions: [],
			standings: {}
		});
		const [plan] = mapLiveReviewPlans(served.plans, Date.parse('2027-03-01T00:00:00Z'));
		expect(plan?.reviewers[0]?.uncovered).toEqual([{
			assignmentId,
			assignmentVersion: 2,
			roundId: round.id,
			submissionId,
			title: 'Talk',
			remainingReviewers: 0,
			replacementCandidates: [{
				reviewerId: id(60),
				displayName: 'Morgan',
				assigned: 0,
				scopeMatch: true
			}]
		}]);
	});

	test('uses one caller key for round, evaluation, and step-back actions with no review choreography', async () => {
		const keys: string[] = []; const actions: string[] = []; let next = 0;
		const page = createLiveReviewPagePort({ review: core({ keys, actions }), vocabulary, schedule,
			viewer: { kind: 'reviewer', reviewerId }, now: () => Date.parse('2027-03-01T00:00:00Z'),
			newAttemptKey: () => `review-page-key-${++next}` });
		expect((await page.review.openRound({ deadlineIso: '2027-03-20', anonymized: true })).id).toBe(roundId);
		expect(await page.review.discardRound(roundId)).toEqual({ ok: true });
		await page.review.saveReview(submissionId, 4, 'Notes');
		expect(await page.review.commitReview(submissionId)).toMatchObject({ committed: true });
		expect(await page.review.stepBack(submissionId, reviewerId)).toEqual({ ok: true });
		expect(actions).toEqual(['open_round', 'discard_empty_round', 'save_draft', 'commit_review', 'step_back']);
		expect(keys).toEqual(['review-page-key-1', 'review-page-key-2', 'review-page-key-3',
			'review-page-key-4', 'review-page-key-5']);
	});

	test('amends forward and restores a prior value with another retained amendment', async () => {
		const keys: string[] = []; const actions: string[] = [];
		const page = createLiveReviewPagePort({ review: core({ committed: true, keys, actions }), vocabulary, schedule,
			viewer: { kind: 'reviewer', reviewerId }, newAttemptKey: () => 'review-amend-key' });
		expect(await page.review.amend(submissionId, 5, 'Better')).toMatchObject({
			committed: true,
			myScore: 5,
			revisions: [{ score: 4, comment: 'Good' }]
		});
		expect(await page.review.revertAmend(submissionId)).toMatchObject({
			committed: true,
			myScore: 4,
			revisions: [{ score: 4, comment: 'Good' }, { score: 5, comment: 'Better' }]
		});
		expect(actions).toEqual(['amend_review', 'amend_review']);
		expect(keys).toEqual(['review-amend-key', 'review-amend-key']);
	});

	test('serves the reviewer-safe candidate already joined to the queue', async () => {
		const blind = createLiveReviewPagePort({ review: core({ keys: [], actions: [] }), vocabulary, schedule,
			viewer: { kind: 'reviewer', reviewerId } });
		await blind.review.myQueue();
		expect(await blind.submissions.get(submissionId)).toEqual({
			id: submissionId,
			title: 'Talk',
			abstract: 'Abstract',
			speakers: [],
			trackId: id(10),
			submittedAt: '2027-03-01T00:00:00.000Z',
			resources: [{ name: 'Deck', kind: 'slides', detail: 'PDF' }]
		});

		const shown = createLiveReviewPagePort({
			review: core({ anonymized: false, keys: [], actions: [] }),
			vocabulary,
			schedule,
			viewer: { kind: 'reviewer', reviewerId }
		});
		expect(await shown.submissions.get(submissionId)).toMatchObject({
			speakers: [{ id: id(9), name: 'Ada Speaker' }]
		});
		expect(await shown.submissions.get(id(999))).toBeNull();
		expect(await shown.schedule.state()).toEqual(scheduleState);
	});

	test('builds committed comparison cards from the same safe queue projection', async () => {
		const page = createLiveReviewPagePort({
			review: core({ committed: true, comparable: true, keys: [], actions: [] }),
			vocabulary,
			schedule,
			viewer: { kind: 'reviewer', reviewerId }
		});
		expect(await page.review.comparables(submissionId, 'track')).toEqual([{
			item: { submissionId: id(14), myScore: 3, myComment: 'Solid', committed: true },
			submission: {
				id: id(14), title: 'Second talk', abstract: 'Second abstract', speakers: [],
				trackId: id(10), submittedAt: '2027-03-01T01:00:00.000Z', resources: []
			},
			standing: {
				value: 3, scaleMax: 5, reviews: 1, n: 1, median: 3, band: 'few',
				phrase: 'Not enough reviews to rank.', slice: { label: 'Track' }, points: []
			}
		}]);
	});

	test('maps the retained accolade catalog and pins then unpins through one operation each', async () => {
		const keys: string[] = []; const actions: string[] = [];
		const definitions: ReviewAccoladeDefinitionProjection[] = [{
			key: 'accolade.top_pick', version: 1, label: 'Top pick',
			description: 'One of this reviewer’s strongest choices.', icon: 'star', cap: 3
		}];
		const page = createLiveReviewPagePort({
			review: core({ committed: true, keys, actions, definitions }), vocabulary, schedule,
			viewer: { kind: 'reviewer', reviewerId }, newAttemptKey: () => `accolade-${keys.length + 1}`
		});
		expect(await page.review.accoladeDefs()).toEqual([
			{ key: 'top_pick', label: 'Top pick', cap: 3 }
		]);
		expect(await page.review.pinAccolade(submissionId, 'top_pick')).toEqual({ ok: true });
		expect((await page.review.myQueue())[0]?.accolades).toEqual(['top_pick']);
		expect(await page.review.unpinAccolade(submissionId, 'top_pick')).toEqual({ ok: true });
		expect((await page.review.myQueue())[0]?.accolades).toBeUndefined();
		expect(actions).toEqual(['pin_accolade', 'unpin_accolade']);
		expect(keys).toEqual(['accolade-1', 'accolade-2']);
	});

	test('turns a canonical cap refusal into a named actionable sentence', async () => {
		const definitions: ReviewAccoladeDefinitionProjection[] = [{
			key: 'accolade.top_pick', version: 1, label: 'Top pick',
			description: 'One of this reviewer’s strongest choices.', icon: 'star', cap: 3
		}];
		const page = createLiveReviewPagePort({
			review: core({
				committed: true, comparable: true, keys: [], actions: [], definitions,
				capHolderSubmissionIds: [submissionId, id(14)]
			}),
			vocabulary, schedule, viewer: { kind: 'reviewer', reviewerId }
		});
		expect(await page.review.pinAccolade(submissionId, 'top_pick')).toEqual({
			ok: false,
			reason: 'Top pick is capped at 3 and already on “Talk” and “Second talk” — unpin one first.'
		});
	});

	test('refuses results until an authorized candidate list is composed', async () => {
		const reviewer = createLiveReviewPagePort({
			review: core({ keys: [], actions: [] }),
			vocabulary,
			schedule,
			viewer: { kind: 'reviewer', reviewerId }
		});
		await expect(reviewer.review.results()).rejects.toMatchObject({
			code: 'review_results_organizer_only'
		});

		const organizer = createLiveReviewPagePort({
			review: core({ keys: [], actions: [] }),
			vocabulary,
			schedule,
			viewer: { kind: 'organizer' }
		});
		await expect(organizer.review.results()).rejects.toMatchObject({ code: 'review_results' });
	});

	test('joins authorized candidates with standings for organizer results', async () => {
		const page = createLiveReviewPagePort({
			review: core({ comparable: true, keys: [], actions: [] }),
			vocabulary,
			schedule,
			viewer: { kind: 'organizer' },
			results: {
				async list() {
					return [
						{ submissionId: id(14), title: 'Second talk', trackId: id(10), reviews: 1 },
						{ submissionId, title: 'Talk', trackId: id(10) }
					];
				}
			}
		});
		expect(await page.review.results()).toEqual([
			{
				submissionId: id(14),
				title: 'Second talk',
				trackId: id(10),
				status: 'scored',
				reviews: 1,
				standing: {
					value: 3, scaleMax: 5, reviews: 1, n: 1, median: 3, band: 'few',
					phrase: 'Not enough reviews to rank.', slice: { label: 'Track' }, points: []
				},
				criteria: [{ key: 'overall', label: 'Overall', value: 3 }]
			},
			{
				submissionId,
				title: 'Talk',
				trackId: id(10),
				status: 'unscored',
				reviews: 0,
				standing: null,
				criteria: []
			}
		]);
	});
});
