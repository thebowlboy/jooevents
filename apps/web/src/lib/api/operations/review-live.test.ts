import { describe, expect, test } from 'bun:test';
import { safeOperationManifestSchema, type OperationEffect, type SafeOperationManifestEntry } from '@jooevents/contracts';
import { REVIEW_OPERATION_SCHEMA_REFS, reviewDirectOperationResultSchema,
	reviewDraftSaveOperationResultSchema } from '@jooevents/contracts/reviews';
import { createReviewLivePort, REVIEW_LIVE_OPERATIONS, type ReviewRequester } from './review-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const correlationId = id(90);
const scope = { workspaceId: id(80), eventId: id(81) };
const criterion = { id: id(5), key: 'overall', label: 'Overall', position: 0,
	weightBps: 10_000, scaleMin: 1, scaleMax: 5 };
const refs = Object.freeze({ snapshot: REVIEW_OPERATION_SCHEMA_REFS.snapshotRead,
	round_setup: REVIEW_OPERATION_SCHEMA_REFS.roundSetupRead, round_change: REVIEW_OPERATION_SCHEMA_REFS.roundChange,
	step_back: REVIEW_OPERATION_SCHEMA_REFS.stepBack, evaluation_change: REVIEW_OPERATION_SCHEMA_REFS.evaluationChange,
	evaluation_draft_save: REVIEW_OPERATION_SCHEMA_REFS.draftSave });
type Key = keyof typeof REVIEW_LIVE_OPERATIONS;
function entry(key: Key): SafeOperationManifestEntry {
	const op = REVIEW_LIVE_OPERATIONS[key]; const schemas = refs[key]; const effect: OperationEffect = op.effect;
	return { name: op.name, version: op.version, lifecycle: { status: 'active' }, summary: op.name,
		effect, maxRisk: effect === 'read' ? 'low' : 'normal', consequenceTags: [], inputSchema: schemas.inputSchema,
		autonomy: { policy: { key: `autonomy.${op.name}`, version: 1 }, riskFloor: 'low',
			unattendedRiskCeiling: 'normal', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'], triggerDispositions: { authority_lost: 'block',
				unattended_bounds_exceeded: 'block', approval_required: 'block', known_retryable_failure: 'block',
				ambiguous_external_effect: 'block', stale_plan: 'block', compensation_required: 'block', terminal_failure: 'block' } },
		idempotency: op.idempotencyRequired ? { required: true, keySource: { key: 'idempotency.review', version: 1 },
			credentialVerifierProfile: { key: 'credential.review', version: 1 },
			requestHashProfile: { key: 'request-hash.review', version: 1 } } : { required: false },
		concurrency: effect === 'read' ? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: 'concurrency.review', version: 1 } }, outcomes: [],
		enabledBindings: [{ surface: 'operator_http', protocol: 'http', method: op.method, path: op.path,
			input: op.input, resultSchema: schemas.resultSchema, browserResumption: { kind: 'none' } }]
	};
}
function manifest() { return safeOperationManifestSchema.parse({ schemaVersion: 1,
	registryDigestSha256: 'f'.repeat(64), operations: (Object.keys(REVIEW_LIVE_OPERATIONS) as Key[]).map(entry) }); }
const round = (state: 'open' | 'discarded') => ({ schemaVersion: 1, scope, id: id(10), ordinal: 1,
	name: 'Round 1', version: 2, deadline: { deadlineId: id(11), kind: 'review_due', version: 1,
		digestSha256: 'a'.repeat(64), effectiveAt: '2027-03-20T23:59:59.000Z' }, criteria: [criterion],
	visibility: { participantIdentity: 'hidden', peerReviewerIdentity: 'hidden', peerContentUnlock: 'after_own_commit' },
	openedByUserId: id(12), openedAt: '2027-03-01T00:00:00.000Z', state,
	...(state === 'discarded' ? { discardedByUserId: id(12), discardedAt: '2027-03-02T00:00:00.000Z' } : {}) });
const assignment = { schemaVersion: 1, scope, id: id(20), roundId: id(10), submissionId: id(21),
	reviewerId: id(22), version: 3, state: 'stepped_back', assignedAt: '2027-03-01T00:00:00.000Z',
	steppedBackAt: '2027-03-02T00:00:00.000Z', steppedBackByUserId: id(22) };
const head = { schemaVersion: 1, scope, assignmentId: id(20), version: 1, currentRevisionId: id(30),
	firstCommittedAt: '2027-03-02T00:00:00.000Z', peerUnlockedAt: '2027-03-02T00:00:00.000Z' };
const revision = { schemaVersion: 1, scope, id: id(30), assignmentId: id(20), revisionNumber: 1,
	scores: [{ criterionId: id(5), score: 4 }], weightedScore: 4, comment: 'Good',
	committedByReviewerId: id(22), committedByUserId: id(22), committedAt: '2027-03-02T00:00:00.000Z', postUnlock: false };
function direct(action: 'open_round' | 'discard_empty_round' | 'step_back' | 'commit_review' | 'amend_review') {
	const data = action === 'open_round' ? { action, round: round('open'), assignmentCount: 2 }
		: action === 'discard_empty_round' ? { action, round: round('discarded') }
			: action === 'step_back' ? { action, assignment }
				: { action, head, revision };
	return reviewDirectOperationResultSchema.parse({ kind: 'success', data,
		receipt: { id: id(40), operationName: action === 'open_round' || action === 'discard_empty_round'
			? 'review.round.change' : action === 'step_back' ? 'review.assignment.step_back' : 'review.evaluation.change',
			operationVersion: 1 }, correlationId });
}

describe('Review direct live port', () => {
	test('uses one exact request and unchanged key for every ordinary arm', async () => {
		const calls: { path: string; idempotencyKey?: string; body?: unknown }[] = [];
		const request: ReviewRequester = async (input) => { calls.push(input);
			if (typeof input.body !== 'object' || input.body === null || !('action' in input.body)) throw new Error('action_missing');
			const action = input.body.action;
			if (action !== 'open_round' && action !== 'discard_empty_round' && action !== 'step_back'
				&& action !== 'commit_review' && action !== 'amend_review') throw new Error('action_invalid');
			return { kind: 'success', data: direct(action) }; };
		const port = createReviewLivePort({ manifest: manifest(), request });
		const attempts = [
			port.changeRound({ action: 'open_round', deadlineDate: '2027-03-20', anonymized: true }, 'review-open-key'),
			port.changeRound({ action: 'discard_empty_round', roundId: id(10), expectedRoundVersion: 2 }, 'review-discard-key'),
			port.stepBack({ action: 'step_back', assignmentId: id(20), expectedAssignmentVersion: 2 }, 'review-step-key'),
			port.changeEvaluation({ action: 'commit_review', assignmentId: id(20), expectedAssignmentVersion: 2,
				expectedDraftVersion: 1 }, 'review-commit-key'),
			port.changeEvaluation({ action: 'amend_review', assignmentId: id(20), expectedAssignmentVersion: 2,
				expectedReviewVersion: 1, expectedCurrentRevisionId: id(30), scores: [{ criterionId: id(5), score: 4 }],
				comment: 'Good' }, 'review-amend-key')
		];
		const results = await Promise.all(attempts);
		expect(results.every((result) => result.kind === 'success')).toBe(true);
		expect(calls.map(({ path, idempotencyKey }) => ({ path, idempotencyKey }))).toEqual([
			{ path: '/api/events/current/review/rounds', idempotencyKey: 'review-open-key' },
			{ path: '/api/events/current/review/rounds', idempotencyKey: 'review-discard-key' },
			{ path: '/api/events/current/review/assignments/step-back', idempotencyKey: 'review-step-key' },
			{ path: '/api/events/current/review/evaluations', idempotencyKey: 'review-commit-key' },
			{ path: '/api/events/current/review/evaluations', idempotencyKey: 'review-amend-key' }
		]);
	});

	test('retains the feature-owned evaluation draft save call', async () => {
		const calls: unknown[] = [];
		const saved = reviewDraftSaveOperationResultSchema.parse({ kind: 'success', correlationId,
			receipt: { id: id(50), operationName: 'review.evaluation.draft.save', operationVersion: 1 },
			data: { draft: { schemaVersion: 1, scope, assignmentId: id(20), version: 1,
				scores: [{ criterionId: id(5), score: 4 }], comment: 'Notes', updatedByReviewerId: id(22),
				updatedByUserId: id(22), updatedAt: '2027-03-02T00:00:00.000Z' } } });
		const port = createReviewLivePort({ manifest: manifest(), request: async (input) => {
			calls.push(input); return { kind: 'success', data: saved }; } });
		expect(await port.saveEvaluationDraft({ assignmentId: id(20), expectedDraftVersion: null,
			scores: [{ criterionId: id(5), score: 4 }], comment: 'Notes' }, 'review-save-key'))
			.toMatchObject({ kind: 'success', receipt: { operationName: 'review.evaluation.draft.save' } });
		expect(calls).toHaveLength(1);
	});

	test('fails malformed and action-mismatched direct results closed', async () => {
		const malformed = structuredClone(direct('step_back')); Reflect.deleteProperty(malformed, 'receipt');
		const bad = createReviewLivePort({ manifest: manifest(), request: async () => ({ kind: 'success', data: malformed }) });
		expect(await bad.stepBack({ action: 'step_back', assignmentId: id(20), expectedAssignmentVersion: 2 }, 'review-step-key'))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
		const mismatch = createReviewLivePort({ manifest: manifest(), request: async () => ({ kind: 'success', data: direct('open_round') }) });
		expect(await mismatch.stepBack({ action: 'step_back', assignmentId: id(20), expectedAssignmentVersion: 2 }, 'review-step-key'))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
	});
});
