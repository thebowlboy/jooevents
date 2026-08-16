import { describe, expect, test } from 'bun:test';
import {
	reviewDraftSaveResultSchema,
	reviewMutationResultSchema,
	reviewSnapshotSchema,
	type ReviewMutationResult
} from '@jooevents/contracts/reviews';
import { mapReviewSnapshot } from './mappers/review';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { ReviewCorePort } from './review-core-port';
import { createLiveReviewPagePort } from './review-page-port.live';

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
function snapshot(input: { committed?: boolean; revisions?: number } = {}) {
	const committed = input.committed ?? false; const revisionCount = input.revisions ?? (committed ? 1 : 0);
	const current = { revisionId, score: 4, comment: 'Good', at: '2027-03-02T00:00:00.000Z', postUnlock: false };
	return mapReviewSnapshot(reviewSnapshotSchema.parse({ schemaVersion: 1,
		viewer: { kind: 'reviewer', reviewerId }, plans: [round], standings: {}, reviewerScope: [],
		queue: [{ assignmentId, roundId, submissionId, assignmentVersion: 2,
			candidate: { submissionId, version: 1, title: 'Talk', abstract: 'Abstract',
				submittedAt: '2027-03-01T00:00:00.000Z', resources: [] },
			...(committed ? { committed: true, current, revisions: Array.from({ length: revisionCount }, (_, index) => ({
				...current, revisionId: id(7 + index), postUnlock: index > 0,
				...(index > 0 ? { correctionOfRevisionId: id(6 + index) } : {}) })) }
				: { committed: false, draft: { version: 1, score: 4, comment: 'Notes' }, revisions: [] }) }] }));
}
const vocabulary: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'> = {
	source: { kind: 'live' }, async tracks() { return []; }, async formats() { return []; }
};
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
function core(input: { committed?: boolean; keys: string[]; actions: string[] }): ReviewCorePort {
	let committed = input.committed ?? false;
	return { source: { kind: 'live' },
		async readSnapshot() { return { kind: 'success', data: snapshot({ committed, revisions: committed ? 1 : 0 }), correlationId }; },
		async readRoundSetup() { return { kind: 'success', data: { activeReviewers: 1, invitedReviewers: 0,
			submissions: 1, expectedReviews: 1, perReviewer: [] }, correlationId }; },
		async changeRound(value, key) { input.keys.push(key); input.actions.push(value.action);
			return { kind: 'success', data: mutation(value.action),
				receipt: { id: id(40), operationName: 'review.round.change', operationVersion: 1 }, correlationId }; },
		async stepBack(value, key) { input.keys.push(key); input.actions.push(value.action);
			return { kind: 'success', data: mutation('step_back'),
				receipt: { id: id(41), operationName: 'review.assignment.step_back', operationVersion: 1 }, correlationId }; },
		async changeEvaluation(value, key) { input.keys.push(key); input.actions.push(value.action); committed = true;
			return { kind: 'success', data: mutation(value.action),
				receipt: { id: id(42), operationName: 'review.evaluation.change', operationVersion: 1 }, correlationId }; },
		async saveEvaluationDraft(_value, key) { input.keys.push(key); input.actions.push('save_draft');
			return { kind: 'success', data: reviewDraftSaveResultSchema.parse({ draft: { schemaVersion: 1, scope, assignmentId, version: 2,
				scores: [{ criterionId, score: 4 }], comment: 'Notes', updatedByReviewerId: reviewerId,
				updatedByUserId: reviewerId, updatedAt: '2027-03-02T00:00:00.000Z' } }),
				receipt: { id: id(43), operationName: 'review.evaluation.draft.save', operationVersion: 1 }, correlationId }; }
	};
}

describe('direct live Review page port', () => {
	test('uses one caller key for round, evaluation, and step-back actions with no review choreography', async () => {
		const keys: string[] = []; const actions: string[] = []; let next = 0;
		const page = createLiveReviewPagePort({ review: core({ keys, actions }), vocabulary,
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

	test('amends forward from retained current revision and returns the reread item', async () => {
		const keys: string[] = []; const actions: string[] = [];
		const page = createLiveReviewPagePort({ review: core({ committed: true, keys, actions }), vocabulary,
			viewer: { kind: 'reviewer', reviewerId }, newAttemptKey: () => 'review-amend-key' });
		expect(await page.review.amend(submissionId, 5, 'Better')).toMatchObject({ committed: true });
		expect(actions).toEqual(['amend_review']);
		expect(keys).toEqual(['review-amend-key']);
	});
});
