import {
	changesetRevisionSelectorSchema,
	operationHttpIdempotencyKeySchema,
	SUBMISSION_DIRECT_ENTRY_OPERATION_SCHEMA_REFS,
	submissionDirectEntryDraftInputSchema,
	submissionDirectEntryDraftOperationResultSchema,
	submissionDirectEntrySafeDiffSchema,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import {
	FIELD_REGISTRY_OPERATION_SCHEMA_REFS,
	fieldRegistrySnapshotReadResultSchema
} from '@jooevents/contracts/field-registry';
import type { z } from 'zod';
import {
	CHANGESET_REVIEW_OPERATIONS,
	createChangesetReviewLivePort
} from '../changesets/live';
import type { ChangesetReviewResult } from '../changesets/port';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const DIRECT_ENTRY_LIVE_OPERATIONS = Object.freeze({
	draft: Object.freeze({ name: 'submission.direct_entry.create.draft', version: 1 } as const),
	registry: Object.freeze({ name: 'field_registry.snapshot.read', version: 1 } as const)
});

/** The one changeset operation a committed direct entry carries. */
const DIRECT_ENTRY_CHANGESET_OPERATION = Object.freeze({
	kind: 'submission.direct_entry.create',
	version: 1,
	dependencyGroup: 'submission_direct_entry'
} as const);

const EXPECTED_OPERATIONS = Object.freeze({
	draft: {
		...DIRECT_ENTRY_LIVE_OPERATIONS.draft,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...SUBMISSION_DIRECT_ENTRY_OPERATION_SCHEMA_REFS.draft
	},
	registry: {
		...DIRECT_ENTRY_LIVE_OPERATIONS.registry,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.snapshotRead
	}
} as const satisfies Readonly<Record<string, ExpectedOperatorHttpOperation>>);

export type DirectEntryLiveOperation = keyof typeof EXPECTED_OPERATIONS | 'propose' | 'commit';

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: DirectEntryLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

/**
 * Canonical answer-keying identity of one registry field. The tuned registry
 * view deliberately drops `mapsTo`, but a direct entry must key its answers
 * to the canonical mappings (`talk.title`, `person.email`, …), so this
 * client reads them from the canonical snapshot itself.
 */
export interface DirectEntryFieldIdentity {
	readonly id: string;
	readonly kind: string;
	readonly mapsTo: string | null;
}

export type DirectEntryLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface DirectEntryCommittedCreate {
	readonly submissionId: string;
	readonly formId: string;
	readonly formVersionId: string;
	readonly submittedAt: string;
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly committedHeadVersion: number;
}

export type DirectEntryLiveCreateResult =
	| {
			readonly kind: 'success';
			readonly data: DirectEntryCommittedCreate;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'confirmation_required';
			readonly requirement: 'distinct_current_human';
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: boolean;
			readonly receipt?: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface DirectEntryLiveRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type DirectEntryLiveRequester = (
	input: DirectEntryLiveRequestInput
) => Promise<ApiResult<unknown>>;

/** Exact operator wire input of `submission.direct_entry.create.draft`. */
export type DirectEntryDraftWireInput = z.input<typeof submissionDirectEntryDraftInputSchema>;

/**
 * Live client for the organizer direct-entry door: the canonical field
 * identities read (for keying answers by `mapsTo`) and the create carried end
 * to end through `submission.direct_entry.create.draft` and the generic
 * changeset propose/commit lifecycle. Wire input is exactly the operator
 * contract — `{formId, expectedFormDefinitionVersion, answers}` — and every
 * lifecycle response is verified against the exact drafted create it claims
 * to advance. Pure live: no sample state is ever consulted.
 */
export interface DirectEntryLiveClient {
	readFieldIdentities(
		options?: { readonly signal?: AbortSignal }
	): Promise<DirectEntryLiveReadResult<{
		readonly version: number;
		readonly fields: readonly DirectEntryFieldIdentity[];
	}>>;
	create(
		input: z.input<typeof submissionDirectEntryDraftInputSchema>,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<DirectEntryLiveCreateResult>;
}

function invalidRequest(): { kind: 'transport_error'; error: SafeApiError } {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): { kind: 'transport_error'; error: SafeApiError } {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function receiptMatches(
	receipt: OperationReceiptRef | undefined,
	operation: { readonly name: string; readonly version: number }
): receipt is OperationReceiptRef {
	return receipt?.operationName === operation.name
		&& receipt.operationVersion === operation.version;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function workflowKeys(
	rawKey: string,
	stages: readonly string[]
): Promise<Readonly<Record<string, string>> | undefined> {
	const parsed = operationHttpIdempotencyKeySchema.safeParse(rawKey);
	if (!parsed.success) return undefined;
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(parsed.data)
	);
	const anchor = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return Object.freeze(Object.fromEntries(stages.map((stage) => [
		stage, `je.submission.direct-entry.${stage}.${anchor}`
	])));
}

function mapChangesetFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operationName: 'propose' | 'commit'
): DirectEntryLiveCreateResult {
	if (result.kind === 'unavailable') {
		return { kind: 'unavailable', operation: operationName, reason: result.reason };
	}
	if (result.kind === 'transport_error') return result;
	if (typeof result.terminal !== 'boolean') return invalidContract();
	return {
		kind: 'outcome',
		outcome: result.outcome,
		terminal: result.terminal,
		...(result.receipt ? { receipt: result.receipt } : {}),
		correlationId: result.correlationId
	};
}

export function createDirectEntryLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: DirectEntryLiveRequester;
}): DirectEntryLiveClient {
	const request = input.request ?? ((requestInput: DirectEntryLiveRequestInput) =>
		requestJson(requestInput));
	const bindings = Object.freeze({
		draft: resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.draft }),
		registry: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: EXPECTED_OPERATIONS.registry
		}),
		propose: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: CHANGESET_REVIEW_OPERATIONS.propose
		}),
		commit: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: CHANGESET_REVIEW_OPERATIONS.commit
		})
	});
	const changesets = createChangesetReviewLivePort({
		manifest: input.manifest,
		request: (requestInput) => request(requestInput)
	});

	return Object.freeze({
		async readFieldIdentities(
			options: { readonly signal?: AbortSignal } = {}
		): Promise<DirectEntryLiveReadResult<{
			readonly version: number;
			readonly fields: readonly DirectEntryFieldIdentity[];
		}>> {
			if (bindings.registry.kind === 'unavailable') {
				return { kind: 'unavailable', operation: 'registry', reason: bindings.registry.reason };
			}
			const response = await request({
				path: bindings.registry.path,
				method: 'GET',
				schema: fieldRegistrySnapshotReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = fieldRegistrySnapshotReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') {
				return {
					kind: 'outcome',
					outcome: parsed.data.outcome,
					correlationId: parsed.data.correlationId
				};
			}
			return {
				kind: 'success',
				data: Object.freeze({
					version: parsed.data.data.version,
					fields: Object.freeze(parsed.data.data.fields.map((field) => Object.freeze({
						id: field.id,
						kind: field.kind,
						mapsTo: field.mapsTo
					})))
				}),
				correlationId: parsed.data.correlationId
			};
		},

		async create(
			rawInput: z.input<typeof submissionDirectEntryDraftInputSchema>,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<DirectEntryLiveCreateResult> {
			const parsedInput = submissionDirectEntryDraftInputSchema.safeParse(rawInput);
			if (!parsedInput.success) return invalidRequest();
			for (const [key, binding] of Object.entries(bindings)) {
				if (key !== 'registry' && binding.kind === 'unavailable') {
					return {
						kind: 'unavailable',
						operation: key as DirectEntryLiveOperation,
						reason: binding.reason
					};
				}
			}
			const keys = await workflowKeys(idempotencyKey, ['draft', 'propose', 'commit']);
			if (!keys) return invalidRequest();
			options.signal?.throwIfAborted();
			if (bindings.draft.kind !== 'available') return invalidContract();
			const response = await request({
				path: bindings.draft.path,
				method: 'POST',
				schema: submissionDirectEntryDraftOperationResultSchema,
				body: parsedInput.data,
				idempotencyKey: keys.draft!,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = submissionDirectEntryDraftOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') {
				if (parsed.data.terminal) {
					if (!receiptMatches(parsed.data.receipt, DIRECT_ENTRY_LIVE_OPERATIONS.draft)) {
						return invalidContract();
					}
					return {
						kind: 'outcome',
						outcome: parsed.data.outcome,
						terminal: true,
						receipt: parsed.data.receipt,
						correlationId: parsed.data.correlationId
					};
				}
				return {
					kind: 'outcome',
					outcome: parsed.data.outcome,
					terminal: false,
					correlationId: parsed.data.correlationId
				};
			}
			const draft = parsed.data;
			if (!receiptMatches(draft.receipt, DIRECT_ENTRY_LIVE_OPERATIONS.draft)
				|| draft.data.action !== 'create'
				|| draft.data.safeDiff.action !== 'create'
				|| draft.data.safeDiff.submission.formId !== parsedInput.data.formId
				|| draft.data.safeDiff.submission.source !== 'direct_entry') {
				return invalidContract();
			}
			if (draft.data.approvalPolicy.requirement === 'distinct_current_human') {
				return {
					kind: 'confirmation_required',
					requirement: 'distinct_current_human',
					receipt: draft.receipt,
					correlationId: draft.correlationId
				};
			}
			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: draft.data.changesetId,
				revisionId: draft.data.revision.id,
				revisionDigest: draft.data.revision.digestSha256
			});
			const proposed = await changesets.propose(
				{ ...selector, expectedHeadVersion: draft.data.headVersion },
				keys.propose!,
				options.signal ? { signal: options.signal } : {}
			);
			if (proposed.kind !== 'success') return mapChangesetFailure(proposed, 'propose');
			const operations = proposed.data.groups.flatMap((group) => group.operations);
			const operation = operations[0];
			const proposedDiff = submissionDirectEntrySafeDiffSchema.safeParse(operation?.safeDiff);
			if (!receiptMatches(proposed.receipt, CHANGESET_REVIEW_OPERATIONS.propose)
				|| proposed.correlationId === undefined
				|| proposed.data.operationCount !== 1
				|| operations.length !== 1
				|| operation?.kind !== DIRECT_ENTRY_CHANGESET_OPERATION.kind
				|| operation.version !== DIRECT_ENTRY_CHANGESET_OPERATION.version
				|| operation.dependencyGroup !== DIRECT_ENTRY_CHANGESET_OPERATION.dependencyGroup
				|| proposed.data.risk.value !== draft.data.riskTier
				|| proposed.data.approval.requirement !== draft.data.approvalPolicy.requirement
				|| !proposedDiff.success
				|| !sameJson(proposedDiff.data, draft.data.safeDiff)) {
				return invalidContract();
			}
			const committed = await changesets.commit(
				{ ...selector, expectedHeadVersion: proposed.data.headVersion },
				keys.commit!,
				options.signal ? { signal: options.signal } : {}
			);
			if (committed.kind !== 'success') return mapChangesetFailure(committed, 'commit');
			if (!receiptMatches(committed.receipt, CHANGESET_REVIEW_OPERATIONS.commit)
				|| committed.correlationId === undefined) {
				return invalidContract();
			}
			return {
				kind: 'success',
				data: Object.freeze({
					submissionId: draft.data.safeDiff.submission.id,
					formId: draft.data.safeDiff.submission.formId,
					formVersionId: draft.data.safeDiff.submission.formVersionId,
					submittedAt: draft.data.safeDiff.submission.submittedAt,
					...selector,
					committedHeadVersion: committed.data.committedHeadVersion
				}),
				receipt: committed.receipt,
				correlationId: committed.correlationId
			};
		}
	});
}
