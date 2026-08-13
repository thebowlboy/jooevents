import { describe, expect, test } from 'bun:test';
import {
	changesetRevisionSelectorSchema,
	safeOperationManifestSchema,
	structuredOutcomeSchema,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	CHANGESET_REVIEW_OPERATIONS,
	createChangesetReviewLivePort,
	type ChangesetReviewRequester
} from './live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);
const selector = Object.freeze(changesetRevisionSelectorSchema.parse({
	changesetId: id(1),
	revisionId: id(2),
	revisionDigest: digest('a')
}));

type OperationKey = keyof typeof CHANGESET_REVIEW_OPERATIONS;

const pathByOperation: Readonly<Record<OperationKey, string>> = Object.freeze({
	diff: '/api/changesets/diff',
	propose: '/api/changesets/proposals',
	commit: '/api/changesets/commits'
});

function schemaRef(key: string, seed = 'c') {
	return { key, version: 1, digestSha256: digest(seed) } as const;
}

function operation(key: OperationKey): SafeOperationManifestEntry {
	const expected = CHANGESET_REVIEW_OPERATIONS[key];
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
					requestHashProfile: { key: 'request_hash.changeset', version: 1 }
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
			path: pathByOperation[key],
			input: expected.input,
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

function manifest(keys: readonly OperationKey[] = ['diff', 'propose', 'commit']): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys.map(operation)
	});
}

const approvalPolicy = Object.freeze({
	reference: { key: 'approval.changeset', version: 1 },
	definitionDigestSha256: digest('b'),
	requirement: 'none' as const
});

function diffData(status: 'draft' | 'proposed', headVersion: number) {
	return {
		changesetId: selector.changesetId,
		headVersion,
		status,
		revisionId: selector.revisionId,
		revisionNumber: 1,
		revisionDigest: selector.revisionDigest,
		riskTier: 'normal' as const,
		approvalPolicy,
		operations: [{
			kind: 'event.title.update',
			version: 1,
			riskTier: 'normal' as const,
			dependencyGroup: 'event_identity',
			safeDiff: { before: 'Old title', after: 'New title' },
			consequences: ['event_changed']
		}]
	};
}

const receipt = (name: string) => ({ id: id(901), operationName: name, operationVersion: 1 });
const readSuccess = (data: unknown) => ({ kind: 'success', data, correlationId });
const effectSuccess = (data: unknown, name: string) => ({
	kind: 'success', data, correlationId, receipt: receipt(name)
});

function requesterFor(
	payloads: Readonly<Record<string, unknown>>,
	calls: Array<{ readonly path: string; readonly body?: unknown; readonly idempotencyKey?: string }>
): ChangesetReviewRequester {
	return async (input) => {
		calls.push(input);
		return { kind: 'success', data: payloads[input.path] };
	};
}

describe('pure-live changeset review port', () => {
	test('manifest-resolves diff, propose, and exact commit with effect keys outside request bodies', async () => {
		const calls: Array<{ readonly path: string; readonly body?: unknown; readonly idempotencyKey?: string }> = [];
		const diffPath = `${pathByOperation.diff}?${new URLSearchParams(selector).toString()}`;
		const proposed = diffData('proposed', 2);
		const port = createChangesetReviewLivePort({
			manifest: manifest(),
			request: requesterFor({
				[diffPath]: readSuccess(diffData('draft', 1)),
				[pathByOperation.propose]: effectSuccess(
					{ schemaVersion: 1, action: 'propose', diff: proposed },
					CHANGESET_REVIEW_OPERATIONS.propose.name
				),
				[pathByOperation.commit]: effectSuccess({
					schemaVersion: 1,
					action: 'commit',
					changesetId: selector.changesetId,
					expectedHeadVersion: 2,
					committedHeadVersion: 3,
					revisionId: selector.revisionId,
					revisionDigest: selector.revisionDigest
				}, CHANGESET_REVIEW_OPERATIONS.commit.name)
			}, calls)
		});

		expect(await port.readDiff(selector)).toMatchObject({
			kind: 'success', data: { status: { value: 'draft' }, operationCount: 1 }
		});
		expect(await port.propose({ ...selector, expectedHeadVersion: 1 }, 'review-propose-1'))
			.toMatchObject({ kind: 'success', data: { status: { value: 'proposed' }, headVersion: 2 } });
		expect(await port.commit({ ...selector, expectedHeadVersion: 2 }, 'review-commit-1'))
			.toMatchObject({ kind: 'success', data: { committedHeadVersion: 3 } });

		expect(calls.map((call) => call.path)).toEqual([
			diffPath, pathByOperation.propose, pathByOperation.commit
		]);
		expect(calls.map((call) => call.idempotencyKey)).toEqual([
			undefined, 'review-propose-1', 'review-commit-1'
		]);
		expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('review-propose-1');
		expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('review-commit-1');
	});

	test('fails closed for an absent binding and invalid selectors or idempotency keys', async () => {
		let requests = 0;
		const request: ChangesetReviewRequester = async () => {
			requests += 1;
			return { kind: 'error', error: { code: 'unexpected', retryable: false } };
		};
		const missing = createChangesetReviewLivePort({ manifest: manifest(['diff']), request });
		expect(await missing.propose({ ...selector, expectedHeadVersion: 1 }, 'valid-key')).toEqual({
			kind: 'unavailable', operation: 'propose', reason: 'operation_not_registered'
		});
		const complete = createChangesetReviewLivePort({ manifest: manifest(), request });
		expect(await complete.readDiff({ ...selector, changesetId: 'not-an-id' } as never)).toEqual({
			kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
		});
		expect(await complete.commit({ ...selector, expectedHeadVersion: 2 }, 'contains,comma')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
		});
		expect(requests).toBe(0);
	});

	test('fails closed when the manifest advertises a different input or projected-result schema', async () => {
		let requests = 0;
		const request: ChangesetReviewRequester = async () => {
			requests += 1;
			return { kind: 'error', error: { code: 'unexpected', retryable: false } };
		};
		const base = operation('diff');
		const wrongInput = manifestWithOperations([{
			...base,
			inputSchema: { ...base.inputSchema, digestSha256: digest('0') }
		}]);
		const binding = base.enabledBindings[0];
		if (!binding || binding.surface !== 'operator_http') throw new TypeError('operator binding required');
		const wrongResult = manifestWithOperations([{
			...base,
			enabledBindings: [{
				...binding,
				resultSchema: { ...binding.resultSchema, digestSha256: digest('1') }
			}]
		}]);

		for (const changedManifest of [wrongInput, wrongResult]) {
			const port = createChangesetReviewLivePort({ manifest: changedManifest, request });
			expect(await port.readDiff(selector)).toEqual({
				kind: 'unavailable', operation: 'diff', reason: 'operation_contract_mismatch'
			});
		}
		expect(requests).toBe(0);
	});

	test('preserves structured refusals without flattening their outcome', async () => {
		const diffPath = `${pathByOperation.diff}?${new URLSearchParams(selector).toString()}`;
		const outcome = {
			kind: 'outcome',
			correlationId,
			outcome: structuredOutcomeSchema.parse({
				class: 'stale_revision',
				kind: 'changeset.lifecycle_refused',
				retryable: false,
				subjects: [],
				detail: { code: 'revision_changed' },
				detailSchemaVersion: 1
			})
		} as const;
		const port = createChangesetReviewLivePort({
			manifest: manifest(),
			request: requesterFor({ [diffPath]: outcome }, [])
		});
		expect(await port.readDiff(selector)).toEqual(outcome);
	});

	test('rejects read, proposal, and commit responses that are not bound to the exact request', async () => {
		const otherRevision = id(77);
		const otherChangeset = id(78);
		const diffPath = `${pathByOperation.diff}?${new URLSearchParams(selector).toString()}`;
		const port = createChangesetReviewLivePort({
			manifest: manifest(),
			request: requesterFor({
				[diffPath]: readSuccess({ ...diffData('draft', 1), revisionId: otherRevision }),
				[pathByOperation.propose]: effectSuccess({
					schemaVersion: 1,
					action: 'propose',
					diff: { ...diffData('proposed', 2), changesetId: otherChangeset }
				}, CHANGESET_REVIEW_OPERATIONS.propose.name),
				[pathByOperation.commit]: effectSuccess({
					schemaVersion: 1,
					action: 'commit',
					changesetId: selector.changesetId,
					expectedHeadVersion: 2,
					committedHeadVersion: 3,
					revisionId: otherRevision,
					revisionDigest: selector.revisionDigest
				}, CHANGESET_REVIEW_OPERATIONS.commit.name)
			}, [])
		});

		const invalidContract = {
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		} as const;
		expect(await port.readDiff(selector)).toEqual(invalidContract);
		expect(await port.propose({ ...selector, expectedHeadVersion: 1 }, 'propose-bound'))
			.toEqual(invalidContract);
		expect(await port.commit({ ...selector, expectedHeadVersion: 2 }, 'commit-bound'))
			.toEqual(invalidContract);
	});
});

function manifestWithOperations(operations: readonly SafeOperationManifestEntry[]): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations
	});
}
