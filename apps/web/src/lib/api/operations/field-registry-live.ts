import {
	FIELD_REGISTRY_OPERATION_SCHEMA_REFS,
	changesetRevisionSelectorSchema,
	fieldRegistryDraftOperationResultSchema,
	fieldRegistryDraftRequestSchema,
	fieldRegistrySafeDiffSchema,
	fieldRegistrySnapshotReadResultSchema,
	operationHttpIdempotencyKeySchema,
	type FieldRegistryDraftAction,
	type FieldRegistryDraftRequest,
	type FieldRegistryFieldAuthor,
	type FieldRegistrySafeDiff,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import {
	CHANGESET_REVIEW_OPERATIONS,
	createChangesetReviewLivePort
} from '../changesets/live';
import type { ChangesetReviewResult } from '../changesets/port';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	mapFieldRegistrySnapshot,
	type FieldRegistrySnapshotView
} from '../mappers/field-registry';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const FIELD_REGISTRY_SNAPSHOT_READ_OPERATION = Object.freeze({
	name: 'field_registry.snapshot.read', version: 1
} as const);

export const FIELD_REGISTRY_DRAFT_OPERATIONS = Object.freeze({
	add: Object.freeze({ name: 'field_registry.add.draft', version: 1 } as const),
	edit: Object.freeze({ name: 'field_registry.edit.draft', version: 1 } as const),
	move: Object.freeze({ name: 'field_registry.move.draft', version: 1 } as const),
	remove: Object.freeze({ name: 'field_registry.remove.draft', version: 1 } as const),
	restore: Object.freeze({ name: 'field_registry.restore.draft', version: 1 } as const)
});

const FIELD_REGISTRY_CHANGESET_OPERATION = Object.freeze({
	kind: 'field_registry.mutate',
	version: 1,
	dependencyGroup: 'field_registry'
} as const);

const FIELD_REGISTRY_EXPECTED_OPERATIONS = Object.freeze({
	snapshot: {
		...FIELD_REGISTRY_SNAPSHOT_READ_OPERATION,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.snapshotRead
	},
	...Object.fromEntries(Object.entries(FIELD_REGISTRY_DRAFT_OPERATIONS).map(([action, operation]) => [
		action,
		{
			...operation,
			effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
			...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.drafts[
				action as FieldRegistryDraftAction
			]
		}
	]))
} as Readonly<Record<'snapshot' | FieldRegistryDraftAction, ExpectedOperatorHttpOperation>>);

export type FieldRegistryLiveOperation =
	| 'snapshot'
	| FieldRegistryDraftAction
	| 'propose'
	| 'commit';

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: FieldRegistryLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type FieldRegistryLiveReadResult =
	| {
			readonly kind: 'success';
			readonly data: FieldRegistrySnapshotView;
			readonly correlationId: string;
	  }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface FieldRegistryCommittedMutation {
	readonly action: FieldRegistryDraftAction;
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly committedHeadVersion: number;
	readonly safeDiff: FieldRegistrySafeDiff;
}

export interface FieldRegistryConfirmationRequired {
	readonly action: FieldRegistryDraftAction;
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly headVersion: number;
	readonly safeDiff: FieldRegistrySafeDiff;
	readonly requirement: 'distinct_current_human';
}

export type FieldRegistryLiveApplyResult =
	| {
			readonly kind: 'success';
			readonly data: FieldRegistryCommittedMutation;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'confirmation_required';
			readonly data: FieldRegistryConfirmationRequired;
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

export interface FieldRegistryLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<FieldRegistryLiveReadResult>;
	apply(
		request: FieldRegistryDraftRequest,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<FieldRegistryLiveApplyResult>;
}

export interface FieldRegistryRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type FieldRegistryRequester = (
	input: FieldRegistryRequestInput
) => Promise<ApiResult<unknown>>;

type BindingKey = 'snapshot' | FieldRegistryDraftAction;
type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

function defaultRequester(input: FieldRegistryRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function invalidRequest(): FieldRegistryLiveApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): FieldRegistryLiveApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function resolveBindings(manifest: unknown): Bindings {
	return Object.freeze(Object.fromEntries(
		Object.entries(FIELD_REGISTRY_EXPECTED_OPERATIONS).map(([key, expected]) => [
			key,
			resolveOperatorHttpBinding({ manifest, expected })
		])
	) as unknown as Bindings);
}

function receiptMatches(
	receipt: OperationReceiptRef | undefined,
	operation: { readonly name: string; readonly version: number }
): receipt is OperationReceiptRef {
	return receipt?.operationName === operation.name
		&& receipt.operationVersion === operation.version;
}

function unavailable(
	operation: FieldRegistryLiveOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): Unavailable {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function firstUnavailable(input: readonly {
	readonly operation: FieldRegistryLiveOperation;
	readonly binding: OperatorHttpBindingResolution;
}[]): Unavailable | undefined {
	for (const entry of input) {
		if (entry.binding.kind === 'unavailable') return unavailable(entry.operation, entry.binding);
	}
	return undefined;
}

async function workflowIdempotencyKeys(
	rawKey: string,
	action: FieldRegistryDraftAction
): Promise<Readonly<{ draft: string; propose: string; commit: string }> | undefined> {
	const parsed = operationHttpIdempotencyKeySchema.safeParse(rawKey);
	if (!parsed.success) return undefined;
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(parsed.data)
	);
	const anchor = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return Object.freeze({
		draft: `je.field-registry.${action}.draft.${anchor}`,
		propose: `je.field-registry.${action}.propose.${anchor}`,
		commit: `je.field-registry.${action}.commit.${anchor}`
	});
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function authoredOptionsMatch(
	author: FieldRegistryFieldAuthor['options'],
	actual: Extract<FieldRegistrySafeDiff, { readonly action: 'add' }>['after']['options']
): boolean {
	if (author.kind !== actual.kind) return false;
	if (author.kind === 'none' && actual.kind === 'none') return true;
	if (author.kind === 'program_vocabulary' && actual.kind === 'program_vocabulary') {
		return author.source === actual.source;
	}
	return author.kind === 'custom' && actual.kind === 'custom'
		&& sameJson(author.labels, actual.choices.map((choice) => choice.label));
}

function safeDiffMatchesRequest(
	diff: FieldRegistrySafeDiff,
	request: FieldRegistryDraftRequest
): boolean {
	if (diff.action !== request.action
		|| diff.registryVersionBefore !== request.request.expectedRegistryVersion
		|| diff.registryVersionAfter !== request.request.expectedRegistryVersion + 1) {
		return false;
	}
	if (request.action === 'add' && diff.action === 'add') {
		const author = request.request.field;
		return diff.after.version === 1
			&& diff.after.kind === author.kind
			&& diff.after.label === author.label
			&& diff.after.help === (author.help ?? null)
			&& diff.after.answerOwner === author.answerOwner
			&& sameJson(diff.after.scope, author.scope)
			&& sameJson(diff.after.contexts, author.contexts)
			&& authoredOptionsMatch(author.options, diff.after.options)
			&& diff.after.position === diff.placement.index
			&& diff.after.group === diff.placement.group;
	}
	if (request.action === 'edit' && diff.action === 'edit') {
		const changes = request.request.changes;
		return diff.before.id === request.request.fieldId
			&& diff.before.version === request.request.expectedFieldVersion
			&& diff.after.id === diff.before.id
			&& diff.after.version === diff.before.version + 1
			&& (changes.label === undefined || diff.after.label === changes.label)
			&& (changes.help === undefined || diff.after.help === changes.help)
			&& (changes.contexts === undefined || sameJson(diff.after.contexts, changes.contexts))
			&& (changes.customOptionLabels === undefined
				|| (diff.after.options.kind === 'custom'
					&& sameJson(
						changes.customOptionLabels,
						diff.after.options.choices.map((choice) => choice.label)
					)));
	}
	if (request.action === 'move' && diff.action === 'move') {
		return diff.fieldId === request.request.fieldId
			&& diff.fieldVersion === request.request.expectedFieldVersion
			&& diff.afterIndex === request.request.toIndex;
	}
	if (request.action === 'remove' && diff.action === 'remove') {
		return diff.before.id === request.request.fieldId
			&& diff.before.version === request.request.expectedFieldVersion;
	}
	if (request.action === 'restore' && diff.action === 'restore') {
		return diff.after.id === request.request.fieldId
			&& diff.after.version === request.request.expectedFieldVersion + 1
			&& diff.after.position === request.request.toIndex
			&& diff.placement.index === request.request.toIndex;
	}
	return false;
}

function mapDraftOutcome(
	result: Extract<z.infer<typeof fieldRegistryDraftOperationResultSchema>, { readonly kind: 'outcome' }>,
	operation: { readonly name: string; readonly version: number }
): FieldRegistryLiveApplyResult {
	const receipt = 'receipt' in result ? result.receipt : undefined;
	if ((result.terminal && !receiptMatches(receipt, operation))
		|| (!result.terminal && receipt !== undefined)) {
		return invalidContract();
	}
	return {
		kind: 'outcome',
		outcome: result.outcome,
		terminal: result.terminal,
		...(receipt ? { receipt } : {}),
		correlationId: result.correlationId
	};
}

function mapChangesetFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operationName: 'propose' | 'commit'
): FieldRegistryLiveApplyResult {
	if (result.kind === 'unavailable') {
		return { kind: 'unavailable', operation: operationName, reason: result.reason };
	}
	if (result.kind === 'transport_error') return result;
	const operation = CHANGESET_REVIEW_OPERATIONS[operationName];
	if (typeof result.terminal !== 'boolean'
		|| (result.terminal && !receiptMatches(result.receipt, operation))
		|| (!result.terminal && result.receipt !== undefined)) {
		return invalidContract();
	}
	return {
		kind: 'outcome',
		outcome: result.outcome,
		terminal: result.terminal,
		...(result.receipt ? { receipt: result.receipt } : {}),
		correlationId: result.correlationId
	};
}

/**
 * Pure-live Field Registry client. It resolves every route from the safe
 * operation manifest and treats the tuned one-click action as confirmation of
 * one exact low-ceremony draft; no sample state is imported or consulted.
 */
export function createFieldRegistryLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: FieldRegistryRequester;
}): FieldRegistryLiveClient {
	const bindings = resolveBindings(input.manifest);
	const proposeBinding = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: CHANGESET_REVIEW_OPERATIONS.propose
	});
	const commitBinding = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: CHANGESET_REVIEW_OPERATIONS.commit
	});
	const request = input.request ?? defaultRequester;
	const changesets = createChangesetReviewLivePort({
		manifest: input.manifest,
		request: (requestInput) => request(requestInput)
	});

	return Object.freeze({
		async read(
			options: { readonly signal?: AbortSignal } = {}
		): Promise<FieldRegistryLiveReadResult> {
			if (bindings.snapshot.kind === 'unavailable') {
				return unavailable('snapshot', bindings.snapshot);
			}
			const transport = await request({
				path: bindings.snapshot.path,
				method: 'GET',
				schema: fieldRegistrySnapshotReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = fieldRegistrySnapshotReadResultSchema.safeParse(transport.data);
			if (!parsed.success) {
				return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			}
			return parsed.data.kind === 'success'
				? {
						kind: 'success',
						data: mapFieldRegistrySnapshot(parsed.data.data),
						correlationId: parsed.data.correlationId
					}
				: {
						kind: 'outcome',
						outcome: parsed.data.outcome,
						correlationId: parsed.data.correlationId
					};
		},

		async apply(
			rawRequest: FieldRegistryDraftRequest,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<FieldRegistryLiveApplyResult> {
			const parsedRequest = fieldRegistryDraftRequestSchema.safeParse(rawRequest);
			if (!parsedRequest.success) return invalidRequest();
			const draftRequest = parsedRequest.data;
			const workflowUnavailable = firstUnavailable([
				{ operation: draftRequest.action, binding: bindings[draftRequest.action] },
				{ operation: 'propose', binding: proposeBinding },
				{ operation: 'commit', binding: commitBinding }
			]);
			if (workflowUnavailable) return workflowUnavailable;
			const keys = await workflowIdempotencyKeys(idempotencyKey, draftRequest.action);
			if (!keys) return invalidRequest();
			options.signal?.throwIfAborted();

			const draftBinding = bindings[draftRequest.action];
			if (draftBinding.kind !== 'available') return invalidContract();
			const draftTransport = await request({
				path: draftBinding.path,
				method: 'POST',
				schema: fieldRegistryDraftOperationResultSchema,
				body: draftRequest.request,
				idempotencyKey: keys.draft,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (draftTransport.kind === 'error') {
				return { kind: 'transport_error', error: draftTransport.error };
			}
			const parsedDraft = fieldRegistryDraftOperationResultSchema.safeParse(draftTransport.data);
			if (!parsedDraft.success) return invalidContract();
			const draft = parsedDraft.data;
			const draftOperation = FIELD_REGISTRY_DRAFT_OPERATIONS[draftRequest.action];
			if (draft.kind === 'outcome') return mapDraftOutcome(draft, draftOperation);
			if (!receiptMatches(draft.receipt, draftOperation)
				|| draft.data.action !== draftRequest.action
				|| !safeDiffMatchesRequest(draft.data.safeDiff, draftRequest)) {
				return invalidContract();
			}

			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: draft.data.changesetId,
				revisionId: draft.data.revision.id,
				revisionDigest: draft.data.revision.digestSha256
			});
			if (draft.data.approvalPolicy.requirement === 'distinct_current_human') {
				return {
					kind: 'confirmation_required',
					data: Object.freeze({
						action: draftRequest.action,
						...selector,
						headVersion: draft.data.headVersion,
						safeDiff: draft.data.safeDiff,
						requirement: 'distinct_current_human' as const
					}),
					receipt: draft.receipt,
					correlationId: draft.correlationId
				};
			}

			const proposed = await changesets.propose(
				{ ...selector, expectedHeadVersion: draft.data.headVersion },
				keys.propose,
				options.signal ? { signal: options.signal } : {}
			);
			if (proposed.kind !== 'success') return mapChangesetFailure(proposed, 'propose');
			if (!receiptMatches(proposed.receipt, CHANGESET_REVIEW_OPERATIONS.propose)
				|| proposed.correlationId === undefined) {
				return invalidContract();
			}
			const operations = proposed.data.groups.flatMap((group) => group.operations);
			const proposedOperation = operations[0];
			const proposedDiff = fieldRegistrySafeDiffSchema.safeParse(proposedOperation?.safeDiff);
			if (proposed.data.operationCount !== 1
				|| operations.length !== 1
				|| proposedOperation?.kind !== FIELD_REGISTRY_CHANGESET_OPERATION.kind
				|| proposedOperation.version !== FIELD_REGISTRY_CHANGESET_OPERATION.version
				|| proposedOperation.dependencyGroup !== FIELD_REGISTRY_CHANGESET_OPERATION.dependencyGroup
				|| !proposedDiff.success
				|| !sameJson(proposedDiff.data, draft.data.safeDiff)) {
				return invalidContract();
			}

			const committed = await changesets.commit(
				{ ...selector, expectedHeadVersion: proposed.data.headVersion },
				keys.commit,
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
					action: draftRequest.action,
					...selector,
					committedHeadVersion: committed.data.committedHeadVersion,
					safeDiff: draft.data.safeDiff
				}),
				receipt: committed.receipt,
				correlationId: committed.correlationId
			};
		}
	});
}
