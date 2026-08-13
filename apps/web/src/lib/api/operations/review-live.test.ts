import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	REVIEW_OPERATION_SCHEMA_REFS,
	reviewDraftSaveOperationResultSchema,
	reviewRoundSetupReadResultSchema,
	reviewSnapshotReadResultSchema
} from '@jooevents/contracts/reviews';
import { reviewOpenRoundAtomicJoinRequirement } from '../mappers/review';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createReviewLivePort,
	REVIEW_LIVE_OPERATIONS,
	type ReviewRequestInput,
	type ReviewRequester
} from './review-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);

type BindingKey = keyof typeof REVIEW_LIVE_OPERATIONS;

const schemaRefs = Object.freeze({
	snapshot: REVIEW_OPERATION_SCHEMA_REFS.snapshotRead,
	round_setup: REVIEW_OPERATION_SCHEMA_REFS.roundSetupRead,
	round_change_draft: REVIEW_OPERATION_SCHEMA_REFS.roundChangeDraft,
	step_back_draft: REVIEW_OPERATION_SCHEMA_REFS.stepBackDraft,
	evaluation_change_draft: REVIEW_OPERATION_SCHEMA_REFS.evaluationChangeDraft,
	evaluation_draft_save: REVIEW_OPERATION_SCHEMA_REFS.draftSave
});

function expected(key: BindingKey): ExpectedOperatorHttpOperation {
	return { ...REVIEW_LIVE_OPERATIONS[key], ...schemaRefs[key] };
}

function manifestEntry(
	key: BindingKey,
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	const operation = expected(key);
	const effect = operation.effect as OperationEffect;
	return {
		name: operation.name,
		version: operation.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${operation.name}.`,
		effect,
		maxRisk: 'low',
		autonomy: {
			policy: { key: `autonomy.${operation.name}`, version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'low',
			requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block',
				unattended_bounds_exceeded: 'block',
				approval_required: 'block',
				known_retryable_failure: 'block',
				ambiguous_external_effect: 'block',
				stale_plan: 'block',
				compensation_required: 'block',
				terminal_failure: 'block'
			}
		},
		consequenceTags: [],
		inputSchema: operation.inputSchema,
		idempotency: operation.idempotencyRequired
			? {
					required: true,
					keySource: { key: `idempotency.${operation.name}`, version: 1 },
					credentialVerifierProfile: { key: 'credential.review', version: 1 },
					requestHashProfile: { key: 'request-hash.review.operations', version: 1 }
				}
			: { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${operation.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: operation.method,
			path: REVIEW_LIVE_OPERATIONS[key].path,
			input: operation.input,
			resultSchema: operation.resultSchema,
			browserResumption: { kind: 'none' }
		}],
		...overrides
	};
}

function manifest(input: {
	readonly omit?: readonly BindingKey[];
	readonly replace?: Partial<Record<BindingKey, SafeOperationManifestEntry>>;
} = {}): SafeOperationManifest {
	const keys = Object.keys(REVIEW_LIVE_OPERATIONS) as BindingKey[];
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys
			.filter((key) => !input.omit?.includes(key))
			.map((key) => input.replace?.[key] ?? manifestEntry(key))
	});
}

function emptySnapshot() {
	return {
		schemaVersion: 1 as const,
		viewer: { kind: 'organizer' as const },
		plans: [],
		roundSetup: {
			activeReviewers: 0,
			invitedReviewers: 0,
			submissions: 0,
			expectedReviews: 0,
			perReviewer: []
		},
		standings: {}
	};
}

function eventRequiredOutcome() {
	return {
		kind: 'outcome' as const,
		outcome: {
			class: 'conflict' as const,
			kind: 'review.event_required',
			retryable: false,
			subjects: [],
			detail: null,
			detailSchemaVersion: 1
		},
		terminal: false as const,
		correlationId
	};
}

describe('live Review operation port', () => {
	test('pins the six frozen operation identities and HTTP paths', () => {
		expect(Object.fromEntries(
			Object.entries(REVIEW_LIVE_OPERATIONS).map(([key, value]) => [
				key,
				{ name: value.name, path: value.path }
			])
		)).toEqual({
			snapshot: {
				name: 'review.snapshot.read',
				path: '/api/events/current/review/snapshot'
			},
			round_setup: {
				name: 'review.round.setup.read',
				path: '/api/events/current/review/round-setup'
			},
			round_change_draft: {
				name: 'review.round.change.draft',
				path: '/api/events/current/review/round-drafts'
			},
			step_back_draft: {
				name: 'review.assignment.step-back.draft',
				path: '/api/events/current/review/step-back-drafts'
			},
			evaluation_change_draft: {
				name: 'review.evaluation.change.draft',
				path: '/api/events/current/review/evaluation-drafts'
			},
			evaluation_draft_save: {
				name: 'review.evaluation.draft.save',
				path: '/api/events/current/review/evaluation-draft'
			}
		});
	});

	test('reads a manifest-resolved snapshot with repeated standing ids and no caller scope', async () => {
		const calls: unknown[] = [];
		const request: ReviewRequester = async (input) => {
			calls.push(input);
			return {
				kind: 'success',
				data: reviewSnapshotReadResultSchema.parse({
					kind: 'success', data: emptySnapshot(), correlationId
				})
			};
		};
		const first = id(20);
		const second = id(21);
		const result = await createReviewLivePort({ manifest: manifest(), request }).readSnapshot({
			standingSubmissionIds: [first, second],
			standingSlice: 'all'
		});

		expect(result).toMatchObject({
			kind: 'success',
			data: { viewer: { kind: 'organizer' }, plans: [], standings: {} },
			correlationId
		});
		if (result.kind !== 'success') throw new TypeError('Expected snapshot success.');
		expect(Object.isFrozen(result.data)).toBe(true);
		expect(calls).toEqual([{
			path: `${REVIEW_LIVE_OPERATIONS.snapshot.path}?standingSubmissionIds=${first}&standingSubmissionIds=${second}&standingSlice=all`,
			method: 'GET',
			schema: expect.anything()
		}]);
	});

	test('keeps open-round date intent and returns the typed atomic review_due blocker unchanged', async () => {
		const calls: ReviewRequestInput[] = [];
		const blocker = {
			kind: 'outcome' as const,
			outcome: {
				class: 'conflict' as const,
				kind: 'review.open_round_atomic_join_required',
				retryable: false,
				subjects: [],
				detail: {
					schemaVersion: 1,
					kind: 'review_due_round_atomic_join',
					deadlineKind: 'review_due',
					deadlineDate: '2026-09-01',
					atomic: true
				} as const,
				detailSchemaVersion: 1
			},
			terminal: false as const,
			correlationId
		};
		const result = await createReviewLivePort({
			manifest: manifest(),
			request: async (input) => {
				calls.push(input);
				return { kind: 'success', data: blocker };
			}
		}).draftRoundChange({
			action: 'open_round',
			deadlineDate: '2026-09-01'
		}, 'review-open-round');

		expect(result).toEqual(blocker);
		if (result.kind !== 'outcome') throw new TypeError('Expected typed blocker.');
		expect(reviewOpenRoundAtomicJoinRequirement(result.outcome)).toEqual(blocker.outcome.detail);
		expect(calls).toEqual([{
			path: REVIEW_LIVE_OPERATIONS.round_change_draft.path,
			method: 'POST',
			schema: expect.anything(),
			body: {
				action: 'open_round',
				deadlineDate: '2026-09-01',
				anonymized: true
			},
			idempotencyKey: 'review-open-round'
		}]);
		expect(JSON.stringify(calls[0]?.body)).not.toContain('deadlineId');
	});

	test('dispatches only the remaining three canonical effect capabilities', async () => {
		const calls: Array<{ readonly path: string; readonly body?: unknown; readonly idempotencyKey?: string }> = [];
		const port = createReviewLivePort({
			manifest: manifest(),
			request: async (input) => {
				calls.push(input);
				return { kind: 'success', data: eventRequiredOutcome() };
			}
		});
		const assignmentId = id(30);
		const criterionId = id(31);
		const revisionId = id(32);

		expect(await port.draftStepBack({
			action: 'step_back', assignmentId, expectedAssignmentVersion: 2
		}, 'review-step-back')).toMatchObject({
			kind: 'outcome', outcome: { kind: 'review.event_required' }
		});
		expect(await port.draftEvaluationChange({
			action: 'commit_review',
			assignmentId,
			expectedAssignmentVersion: 2,
			expectedDraftVersion: 1
		}, 'review-commit-draft')).toMatchObject({
			kind: 'outcome', outcome: { kind: 'review.event_required' }
		});
		expect(await port.draftEvaluationChange({
			action: 'amend_review',
			assignmentId,
			expectedAssignmentVersion: 2,
			expectedReviewVersion: 3,
			expectedCurrentRevisionId: revisionId,
			scores: [{ criterionId, score: 4 }],
			comment: 'A bounded amendment.'
		}, 'review-amend-draft')).toMatchObject({
			kind: 'outcome', outcome: { kind: 'review.event_required' }
		});
		expect(await port.saveEvaluationDraft({
			assignmentId,
			expectedDraftVersion: null,
			scores: [{ criterionId, score: 3 }],
			comment: 'Independent notes.'
		}, 'review-save-draft')).toMatchObject({
			kind: 'outcome', outcome: { kind: 'review.event_required' }
		});

		expect(calls.map(({ path, idempotencyKey }) => ({ path, idempotencyKey }))).toEqual([
			{ path: REVIEW_LIVE_OPERATIONS.step_back_draft.path, idempotencyKey: 'review-step-back' },
			{ path: REVIEW_LIVE_OPERATIONS.evaluation_change_draft.path, idempotencyKey: 'review-commit-draft' },
			{ path: REVIEW_LIVE_OPERATIONS.evaluation_change_draft.path, idempotencyKey: 'review-amend-draft' },
			{ path: REVIEW_LIVE_OPERATIONS.evaluation_draft_save.path, idempotencyKey: 'review-save-draft' }
		]);
	});

	test('maps a saved draft with its assignment and criterion versions intact', async () => {
		const assignmentId = id(40);
		const criterionId = id(41);
		const draft = {
			schemaVersion: 1 as const,
			scope: { workspaceId: id(1), eventId: id(2) },
			assignmentId,
			version: 2,
			scores: [{ criterionId, score: 5 }],
			comment: 'Must-have.',
			updatedByReviewerId: id(42),
			updatedByUserId: id(43),
			updatedAt: '2026-08-13T12:00:00.000Z'
		};
		const response = reviewDraftSaveOperationResultSchema.parse({
			kind: 'success',
			data: { draft },
			receipt: {
				id: id(44),
				operationName: REVIEW_LIVE_OPERATIONS.evaluation_draft_save.name,
				operationVersion: 1
			},
			correlationId
		});
		const result = await createReviewLivePort({
			manifest: manifest(),
			request: async () => ({ kind: 'success', data: response })
		}).saveEvaluationDraft({
			assignmentId,
			expectedDraftVersion: 1,
			scores: [{ criterionId, score: 5 }],
			comment: 'Must-have.'
		}, 'review-save-success');

		expect(result).toMatchObject({ kind: 'success', data: { draft }, correlationId });
		if (result.kind !== 'success') throw new TypeError('Expected draft-save success.');
		expect(Object.isFrozen(result.data.draft.scores)).toBe(true);
	});

	test('fails closed on missing, path-drifted, and malformed typed-blocker contracts', async () => {
		let calls = 0;
		const request: ReviewRequester = async () => {
			calls += 1;
			return { kind: 'success', data: eventRequiredOutcome() };
		};
		const missing = createReviewLivePort({
			manifest: manifest({ omit: ['snapshot'] }), request
		});
		expect(await missing.readSnapshot()).toEqual({
			kind: 'unavailable', operation: 'snapshot', reason: 'operation_not_registered'
		});

		const driftedEntry = manifestEntry('round_setup');
		const binding = driftedEntry.enabledBindings[0];
		if (!binding || binding.protocol !== 'http') throw new TypeError('HTTP binding missing.');
		const drifted = createReviewLivePort({
			manifest: manifest({
				replace: {
					round_setup: {
						...driftedEntry,
						enabledBindings: [{ ...binding, path: '/api/events/current/review/setup-v2' }]
					}
				}
			}),
			request
		});
		expect(await drifted.readRoundSetup()).toEqual({
			kind: 'unavailable', operation: 'round_setup', reason: 'operation_contract_mismatch'
		});

		const malformed = await createReviewLivePort({
			manifest: manifest(),
			request: async () => ({
				kind: 'success',
				data: {
					kind: 'outcome',
					outcome: {
						class: 'conflict',
						kind: 'review.open_round_atomic_join_required',
						retryable: false,
						subjects: [],
						detail: null,
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				}
			})
		}).draftRoundChange({
			action: 'open_round', deadlineDate: '2026-09-01'
		}, 'review-open-malformed');
		expect(malformed).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
		expect(calls).toBe(0);
	});

	test('exposes no tuned-screen capability the backend does not own', () => {
		const port = createReviewLivePort({ manifest: manifest(), request: async () => ({
			kind: 'success',
			data: reviewRoundSetupReadResultSchema.parse({
				kind: 'success',
				data: emptySnapshot().roundSetup,
				correlationId
			})
		}) });
		expect(Object.keys(port).sort()).toEqual([
			'draftEvaluationChange',
			'draftRoundChange',
			'draftStepBack',
			'readRoundSetup',
			'readSnapshot',
			'saveEvaluationDraft',
			'source'
		]);
		expect(port).not.toHaveProperty('comparables');
		expect(port).not.toHaveProperty('accoladeDefs');
		expect(port).not.toHaveProperty('profile');
		expect(port).not.toHaveProperty('remind');
		expect(port).not.toHaveProperty('commitReview');
	});
});
