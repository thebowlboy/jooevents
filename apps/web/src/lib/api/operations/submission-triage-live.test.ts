import { describe, expect, test } from 'bun:test';
import {
	CHANGESET_OPERATION_SCHEMA_REFS,
	changesetLifecycleOperationResultSchema,
	committedChangesetOperationResultSchema,
	proposedChangesetOperationResultSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS,
	submissionTriageDraftOperationResultSchema,
	submissionTriageListOperationResultSchema,
	submissionTriageReadOperationResultSchema,
	type SubmissionTriageAction,
	type SubmissionTriageSafeDiff,
	type SubmissionTriageTransitionDraftInput
} from '@jooevents/contracts/submission-triage';
import { CHANGESET_REVIEW_OPERATIONS } from '../changesets/live';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createSubmissionTriageLiveClient,
	SUBMISSION_TRIAGE_OPERATIONS,
	type SubmissionTriageCompensationSource,
	type SubmissionTriageRequester
} from './submission-triage-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const workspaceId = id(1);
const eventId = id(2);
const submissionId = id(3);
const secondSubmissionId = id(4);
const formId = id(5);
const formVersionId = id(6);
const arrivalId = id(7);
const fieldId = id(8);
const changesetId = id(20);
const revisionId = id(21);
const correctionChangesetId = id(22);
const correctionRevisionId = id(23);
const correlationId = id(900);

const paths = Object.freeze({
	list: '/api/events/current/submissions/triage',
	read: '/api/events/current/submissions/triage/detail',
	draft: '/api/events/current/submissions/triage/drafts',
	correction: '/api/changesets/corrections',
	propose: '/api/changesets/proposals',
	commit: '/api/changesets/commits'
} as const);

const approvalPolicy = Object.freeze({
	reference: { key: 'approval.submission_triage.bounded', version: 1 },
	definitionDigestSha256: digest('c'),
	requirement: 'none' as const
});

function expectedOperations(): Readonly<Record<keyof typeof paths, ExpectedOperatorHttpOperation>> {
	return {
		list: {
			...SUBMISSION_TRIAGE_OPERATIONS.list,
			effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
			...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.list
		},
		read: {
			...SUBMISSION_TRIAGE_OPERATIONS.read,
			effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
			...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.read
		},
		draft: {
			...SUBMISSION_TRIAGE_OPERATIONS.draft,
			effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
			...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.draft
		},
		correction: {
			...SUBMISSION_TRIAGE_OPERATIONS.correction,
			effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
			...CHANGESET_OPERATION_SCHEMA_REFS.correction
		},
		propose: CHANGESET_REVIEW_OPERATIONS.propose,
		commit: CHANGESET_REVIEW_OPERATIONS.commit
	};
}

function manifestEntry(
	key: keyof typeof paths,
	expected: ExpectedOperatorHttpOperation
): SafeOperationManifestEntry {
	const effect = expected.effect as OperationEffect;
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${expected.name}.`,
		effect,
		maxRisk: effect === 'commit' ? 'consequential' : effect === 'read' ? 'low' : 'normal',
		autonomy: {
			policy: { key: `autonomy.${expected.name}`, version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'normal',
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
		inputSchema: expected.inputSchema,
		idempotency: expected.idempotencyRequired
			? {
					required: true,
					keySource: { key: 'idempotency.operator_header', version: 1 },
					credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
					requestHashProfile: { key: 'request_hash.submission_triage', version: 1 }
				}
			: { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${expected.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: expected.method,
			path: paths[key],
			input: expected.input,
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

function manifest(omit: readonly (keyof typeof paths)[] = []): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: Object.entries(expectedOperations())
			.filter(([key]) => !omit.includes(key as keyof typeof paths))
			.map(([key, operation]) => manifestEntry(key as keyof typeof paths, operation))
	});
}

const queryGuard = Object.freeze({
	schemaVersion: 1 as const,
	scope: { workspaceId, eventId },
	version: 7,
	digestSha256: digest('a')
});

function projection() {
	return {
		schemaVersion: 1,
		source: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			source: 'public_form',
			summary: {
				schemaVersion: 1,
				id: submissionId,
				formId,
				formVersionId,
				target: { kind: 'general_pool' },
				title: 'A durable proposal',
				primaryParticipantName: 'Avery Stone',
				submittedAt: '2026-08-13T10:01:00.000Z'
			},
			detail: {
				schemaVersion: 1,
				submissionId,
				formId,
				formVersionId,
				submittedAt: '2026-08-13T10:01:00.000Z',
				participantCount: 1,
				answers: [{
					kind: 'textarea', fieldId, fieldLabel: 'Abstract', value: 'Practical systems.'
				}],
				affirmedConsentFieldIds: []
			},
			abstract: 'Practical systems.',
			track: null,
			format: null
		},
		triage: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			submissionId,
			version: 4,
			state: 'inbox',
			setAsideAttribution: null,
			updatedAt: '2026-08-13T10:02:00.000Z'
		},
		arrival: {
			schemaVersion: 1,
			id: arrivalId,
			scope: { workspaceId, eventId },
			submissionId,
			formId,
			formVersionId,
			source: 'public_form',
			submittedAt: '2026-08-13T10:01:00.000Z',
			classification: 'late',
			closeEvidence: {
				closeAt: '2026-08-13T10:00:00.000Z',
				policy: {
					reference: { key: 'intake.soft_close', version: 1 },
					definitionDigestSha256: digest('d')
				}
			},
			recordedAt: '2026-08-13T10:01:00.000Z'
		},
		visibleTray: 'late'
	};
}

function manualAttribution() {
	return {
		kind: 'manual' as const,
		principalKey: 'opaque:principal',
		invocationId: id(30),
		surface: 'operator_http' as const
	};
}

function diffFor(
	action: SubmissionTriageAction,
	idValue = submissionId
): SubmissionTriageSafeDiff {
	const beforeState = action === 'return_to_inbox'
		? 'set_aside'
		: action === 'restore'
			? 'discarded_recoverable'
			: 'inbox';
	const afterState = action === 'set_aside'
		? 'set_aside'
		: action === 'discard_recoverable'
			? 'discarded_recoverable'
			: 'inbox';
	const beforeAttribution = beforeState === 'set_aside' ? manualAttribution() : null;
	const afterAttribution = afterState === 'set_aside' ? manualAttribution() : null;
	const tray = (state: typeof beforeState | typeof afterState) => state === 'set_aside'
		? 'set_aside' as const
		: state === 'discarded_recoverable'
			? 'discarded' as const
			: 'late' as const;
	return {
		schemaVersion: 1,
		action,
		queryGuard: {
			before: queryGuard,
			after: { ...queryGuard, version: 8, digestSha256: digest('b') }
		},
		transitions: [{
			submissionId: idValue,
			arrivalClassification: 'late',
			beforeVisibleTray: tray(beforeState),
			afterVisibleTray: tray(afterState),
			before: {
				submissionId: idValue,
				version: 4,
				state: beforeState,
				setAsideAttribution: beforeAttribution,
				updatedAt: '2026-08-13T10:02:00.000Z'
			},
			after: {
				submissionId: idValue,
				version: 5,
				state: afterState,
				setAsideAttribution: afterAttribution,
				updatedAt: '2026-08-13T10:03:00.000Z'
			}
		}]
	};
}

function draftInput(action: SubmissionTriageAction): SubmissionTriageTransitionDraftInput {
	return {
		action,
		submissionIds: [submissionId],
		expectedHeads: [{ submissionId, version: 4 }],
		expectedQueryGuard: { version: queryGuard.version, digestSha256: queryGuard.digestSha256 }
	};
}

function draftSuccess(
	action: SubmissionTriageAction,
	requirement: 'none' | 'distinct_current_human' = 'none'
) {
	return submissionTriageDraftOperationResultSchema.parse({
		kind: 'success',
		correlationId,
		receipt: {
			id: id(901),
			operationName: SUBMISSION_TRIAGE_OPERATIONS.draft.name,
			operationVersion: 1
		},
		data: {
			schemaVersion: 1,
			action,
			changesetId,
			headVersion: 1,
			status: 'draft',
			revision: { id: revisionId, number: 1, digestSha256: digest('e') },
			affectedCount: 1,
			riskTier: action === 'discard_recoverable' ? 'consequential' : 'normal',
			approvalPolicy: { ...approvalPolicy, requirement },
			safeDiff: diffFor(action)
		}
	});
}

function proposedSuccess(input: {
	readonly safeDiff: unknown;
	readonly changesetId?: string;
	readonly revisionId?: string;
	readonly revisionDigest?: string;
	readonly headVersion?: number;
}) {
	return proposedChangesetOperationResultSchema.parse({
		kind: 'success',
		correlationId,
		receipt: {
			id: id(902),
			operationName: CHANGESET_REVIEW_OPERATIONS.propose.name,
			operationVersion: 1
		},
		data: {
			schemaVersion: 1,
			action: 'propose',
			diff: {
				changesetId: input.changesetId ?? changesetId,
				headVersion: input.headVersion ?? 2,
				status: 'proposed',
				revisionId: input.revisionId ?? revisionId,
				revisionNumber: 1,
				revisionDigest: input.revisionDigest ?? digest('e'),
				riskTier: 'normal',
				approvalPolicy,
				operations: [{
					kind: 'submission.triage.transition',
					version: 1,
					riskTier: 'normal',
					dependencyGroup: 'submission_triage',
					safeDiff: input.safeDiff,
					consequences: ['submission_triage_changed']
				}]
			}
		}
	});
}

function committedSuccess(input: {
	readonly changesetId?: string;
	readonly revisionId?: string;
	readonly revisionDigest?: string;
	readonly expectedHeadVersion?: number;
} = {}) {
	const expected = input.expectedHeadVersion ?? 2;
	return committedChangesetOperationResultSchema.parse({
		kind: 'success',
		correlationId,
		receipt: {
			id: id(903),
			operationName: CHANGESET_REVIEW_OPERATIONS.commit.name,
			operationVersion: 1
		},
		data: {
			schemaVersion: 1,
			action: 'commit',
			changesetId: input.changesetId ?? changesetId,
			expectedHeadVersion: expected,
			committedHeadVersion: expected + 1,
			revisionId: input.revisionId ?? revisionId,
			revisionDigest: input.revisionDigest ?? digest('e')
		}
	});
}

function requester(
	payloads: Readonly<Record<string, unknown | readonly unknown[]>>,
	calls: SubmissionTriageRequestInput[] = []
): SubmissionTriageRequester {
	const offsets = new Map<string, number>();
	return async (request) => {
		calls.push(request);
		const payload = payloads[request.path];
		if (payload === undefined) {
			return { kind: 'error', error: { code: 'unexpected_request', retryable: false } };
		}
		if (!Array.isArray(payload)) return { kind: 'success', data: payload };
		const index = offsets.get(request.path) ?? 0;
		offsets.set(request.path, index + 1);
		const selected = payload[index];
		return selected === undefined
			? { kind: 'error', error: { code: 'unexpected_request', retryable: false } }
			: { kind: 'success', data: selected };
	};
}

type SubmissionTriageRequestInput = Parameters<SubmissionTriageRequester>[0];

function exactCorrection(source: SubmissionTriageSafeDiff): SubmissionTriageSafeDiff {
	const original = source.transitions[0]!;
	return {
		schemaVersion: 1,
		action: 'restore_exact',
		queryGuard: {
			before: source.queryGuard.after,
			after: { ...source.queryGuard.after, version: 9, digestSha256: digest('9') }
		},
		transitions: [{
			submissionId: original.submissionId,
			arrivalClassification: original.arrivalClassification,
			beforeVisibleTray: original.afterVisibleTray,
			afterVisibleTray: original.beforeVisibleTray,
			before: original.after,
			after: {
				...original.before,
				version: original.after.version + 1,
				updatedAt: '2026-08-13T10:04:00.000Z'
			}
		}]
	};
}

describe('pure-live Submission Triage operation client', () => {
	test('lists and reads through exact query bindings without exposing contact data', async () => {
		const calls: SubmissionTriageRequestInput[] = [];
		const list = submissionTriageListOperationResultSchema.parse({
			kind: 'success', correlationId,
			data: {
				schemaVersion: 1, queryGuard, rows: [projection()],
				trayTotals: { inbox: 0, set_aside: 0, late: 1, discarded: 0 },
				search: { query: 'durable', matched: 1, scanned: 1 }
			}
		});
		const read = submissionTriageReadOperationResultSchema.parse({
			kind: 'success', correlationId,
			data: { schemaVersion: 1, queryGuard, row: projection() }
		});
		const listPath = `${paths.list}?tray=late&search=durable`;
		const readPath = `${paths.read}?submissionId=${submissionId}`;
		const client = createSubmissionTriageLiveClient({
			manifest: manifest(),
			request: requester({ [listPath]: list, [readPath]: read }, calls)
		});
		expect(await client.list({ tray: 'late', search: 'durable' })).toMatchObject({
			kind: 'success',
			data: { rows: [{ source: { id: submissionId }, visibleTray: 'late' }] }
		});
		expect(await client.read(submissionId)).toMatchObject({
			kind: 'success', data: { source: { id: submissionId }, visibleTray: 'late' }
		});
		expect(calls.map((call) => call.path)).toEqual([listPath, readPath]);
		expect(calls.map(({ path, method, body }) => ({ path, method, body })))
			.not.toEqual(expect.arrayContaining([expect.objectContaining({ body: expect.anything() })]));
		expect(JSON.stringify((await client.read(submissionId)))).not.toContain('@');
	});

	test('commits an exact guarded transition through draft, propose, and commit', async () => {
		const calls: SubmissionTriageRequestInput[] = [];
		const input = draftInput('set_aside');
		const safeDiff = diffFor('set_aside');
		const client = createSubmissionTriageLiveClient({
			manifest: manifest(),
			request: requester({
				[paths.draft]: draftSuccess('set_aside'),
				[paths.propose]: proposedSuccess({ safeDiff }),
				[paths.commit]: committedSuccess()
			}, calls)
		});
		expect(await client.apply(input, 'triage-set-aside')).toMatchObject({
			kind: 'success',
			data: { action: 'set_aside', changesetId, safeDiff },
			receipt: { operationName: 'changeset.commit' }
		});
		expect(calls.map((call) => call.path)).toEqual([
			paths.draft, paths.propose, paths.commit
		]);
		expect(calls[0]?.body).toEqual(input);
		expect(calls.map((call) => call.idempotencyKey?.split('.').at(-2)))
			.toEqual(['draft', 'propose', 'commit']);
		expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(3);
	});

	test('validates all four ordinary action semantics before presenting confirmation', async () => {
		for (const action of [
			'set_aside', 'return_to_inbox', 'discard_recoverable', 'restore'
		] as const) {
			const calls: SubmissionTriageRequestInput[] = [];
			const client = createSubmissionTriageLiveClient({
				manifest: manifest(),
				request: requester({
					[paths.draft]: draftSuccess(action, 'distinct_current_human')
				}, calls)
			});
			expect(await client.apply(draftInput(action), `triage-${action}`)).toMatchObject({
				kind: 'confirmation_required',
				data: { action, safeDiff: { action }, requirement: 'distinct_current_human' }
			});
			expect(calls).toHaveLength(1);
		}
	});

	test('fails closed before drafting when generic commit is unavailable', async () => {
		let requests = 0;
		const client = createSubmissionTriageLiveClient({
			manifest: manifest(['commit']),
			request: async () => {
				requests += 1;
				return { kind: 'error', error: { code: 'unexpected', retryable: false } };
			}
		});
		expect(await client.apply(draftInput('set_aside'), 'missing-commit')).toEqual({
			kind: 'unavailable', operation: 'commit', reason: 'operation_not_registered'
		});
		expect(requests).toBe(0);
	});

	test('rejects a draft whose returned query guard crosses event scope', async () => {
		const calls: SubmissionTriageRequestInput[] = [];
		const crossed = structuredClone(draftSuccess('set_aside'));
		if (crossed.kind !== 'success') throw new TypeError('draft_fixture_missing');
		crossed.data.safeDiff.queryGuard.after.scope.eventId = id(99);
		const client = createSubmissionTriageLiveClient({
			manifest: manifest(),
			request: requester({ [paths.draft]: crossed }, calls)
		});
		expect(await client.apply(draftInput('set_aside'), 'crossed-scope')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
		expect(calls.map((call) => call.path)).toEqual([paths.draft]);
	});

	test('refuses a proposed operation whose exact safe diff changed', async () => {
		const calls: SubmissionTriageRequestInput[] = [];
		const safeDiff = diffFor('set_aside');
		const client = createSubmissionTriageLiveClient({
			manifest: manifest(),
			request: requester({
				[paths.draft]: draftSuccess('set_aside'),
				[paths.propose]: proposedSuccess({
					safeDiff: { ...safeDiff, queryGuard: {
						...safeDiff.queryGuard,
						after: { ...safeDiff.queryGuard.after, digestSha256: digest('7') }
					} }
				})
			}, calls)
		});
		expect(await client.apply(draftInput('set_aside'), 'tampered-proposal')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
		expect(calls.map((call) => call.path)).toEqual([paths.draft, paths.propose]);
	});

	test('drafts, verifies, proposes, and commits the generic exact compensation', async () => {
		const calls: SubmissionTriageRequestInput[] = [];
		const sourceDiff = diffFor('set_aside');
		const restored = exactCorrection(sourceDiff);
		const source: SubmissionTriageCompensationSource = {
			changesetId,
			revisionId,
			revisionDigest: digest('e'),
			sourceCommitReceiptId: id(903),
			safeDiff: sourceDiff
		};
		const correction = changesetLifecycleOperationResultSchema.parse({
			kind: 'success',
			correlationId,
			receipt: {
				id: id(904),
				operationName: SUBMISSION_TRIAGE_OPERATIONS.correction.name,
				operationVersion: 1
			},
			data: {
				schemaVersion: 1,
				action: 'correction',
				sourceChangesetId: changesetId,
				sourceRevisionId: revisionId,
				sourceRevisionDigest: digest('e'),
				resultKind: 'exact',
				target: {
					changesetId: correctionChangesetId,
					headVersion: 1,
					status: 'draft',
					revisionId: correctionRevisionId,
					revisionNumber: 1,
					revisionDigest: digest('6'),
					riskTier: 'normal',
					approvalPolicy,
					operations: [{
						kind: 'submission.triage.transition',
						version: 1,
						riskTier: 'normal',
						dependencyGroup: 'submission_triage',
						safeDiff: restored,
						consequences: ['submission_triage_changed']
					}]
				},
				evidence: { source: changesetId }
			}
		});
		const client = createSubmissionTriageLiveClient({
			manifest: manifest(),
			request: requester({
				[paths.correction]: correction,
				[paths.propose]: proposedSuccess({
					safeDiff: restored,
					changesetId: correctionChangesetId,
					revisionId: correctionRevisionId,
					revisionDigest: digest('6')
				}),
				[paths.commit]: committedSuccess({
					changesetId: correctionChangesetId,
					revisionId: correctionRevisionId,
					revisionDigest: digest('6')
				})
			}, calls)
		});
		expect(await client.compensate(source, 'restore-exact')).toMatchObject({
			kind: 'success',
			data: { action: 'restore_exact', safeDiff: restored }
		});
		expect(calls.map((call) => call.path)).toEqual([
			paths.correction, paths.propose, paths.commit
		]);
		expect(calls[0]?.body).toEqual({
			sourceChangesetId: changesetId,
			sourceRevisionId: revisionId,
			sourceRevisionDigest: digest('e'),
			sourceCommitReceiptId: id(903)
		});
		expect(restored.transitions[0]).toMatchObject({
			beforeVisibleTray: 'set_aside',
			afterVisibleTray: 'late',
			after: { state: 'inbox', setAsideAttribution: null }
		});
	});

	test('does not propose a partial correction', async () => {
		const calls: SubmissionTriageRequestInput[] = [];
		const sourceDiff = diffFor('set_aside');
		const correction = changesetLifecycleOperationResultSchema.parse({
			kind: 'success', correlationId,
			receipt: {
				id: id(904), operationName: SUBMISSION_TRIAGE_OPERATIONS.correction.name,
				operationVersion: 1
			},
			data: {
				schemaVersion: 1,
				action: 'correction',
				sourceChangesetId: changesetId,
				sourceRevisionId: revisionId,
				sourceRevisionDigest: digest('e'),
				resultKind: 'partial',
				target: null,
				evidence: { conflict: secondSubmissionId }
			}
		});
		const client = createSubmissionTriageLiveClient({
			manifest: manifest(),
			request: requester({ [paths.correction]: correction }, calls)
		});
		expect(await client.compensate({
			changesetId,
			revisionId,
			revisionDigest: digest('e'),
			sourceCommitReceiptId: id(903),
			safeDiff: sourceDiff
		}, 'partial-restore')).toMatchObject({
			kind: 'correction_unavailable', resultKind: 'partial'
		});
		expect(calls.map((call) => call.path)).toEqual([paths.correction]);
	});
});
