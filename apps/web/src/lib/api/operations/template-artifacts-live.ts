import {
	TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS,
	changesetRevisionSelectorSchema,
	operationHttpIdempotencyKeySchema,
	templateArtifactListInputSchema,
	templateArtifactListOperationResultSchema,
	templateArtifactMutationDraftOperationResultSchema,
	templateArtifactMutationInputSchema,
	type OperationReceiptRef,
	type StructuredOutcome,
	type TemplateArtifactMutationInputDto,
	type TemplateArtifactSafeDiffDto,
	type TemplateArtifactSnapshotDto
} from '@jooevents/contracts';
import type { z } from 'zod';
import { createChangesetReviewLivePort } from '../changesets/live';
import type { ChangesetReviewResult } from '../changesets/port';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { jsonEquivalent } from '../json-equivalence';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const TEMPLATE_ARTIFACT_LIVE_OPERATIONS = Object.freeze({
	list: {
		name: 'template.artifact.list', version: 1, effect: 'read',
		method: 'GET', input: 'query', idempotencyRequired: false,
		...TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.list
	},
	draft: {
		name: 'template.artifact.change.draft', version: 1, effect: 'draft',
		method: 'POST', input: 'body', idempotencyRequired: true,
		...TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.mutationDraft
	}
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

export type TemplateArtifactLiveOperation = 'list' | 'draft' | 'propose' | 'commit';
type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: TemplateArtifactLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};
export type TemplateArtifactLiveResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal?: boolean; readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface TemplateArtifactLiveClient {
	list(kind?: 'message' | 'surface' | 'theme', options?: { readonly signal?: AbortSignal }):
		Promise<TemplateArtifactLiveResult<readonly TemplateArtifactSnapshotDto[]>>;
	mutate(
		mutation: TemplateArtifactMutationInputDto,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<TemplateArtifactLiveResult<{
		readonly revision: TemplateArtifactSafeDiffDto['after'];
		readonly safeDiff: TemplateArtifactSafeDiffDto;
		readonly committedHeadVersion: number;
	}>>;
}

export interface TemplateArtifactRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}
export type TemplateArtifactRequester =
	(input: TemplateArtifactRequestInput) => Promise<ApiResult<unknown>>;
type ListOperationResult = z.infer<typeof templateArtifactListOperationResultSchema>;
type DraftOperationResult = z.infer<typeof templateArtifactMutationDraftOperationResultSchema>;

function defaultRequester(input: TemplateArtifactRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}
function invalidRequest<Data>(): TemplateArtifactLiveResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}
function invalidContract<Data>(): TemplateArtifactLiveResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}
function unavailable<Data>(
	operation: TemplateArtifactLiveOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): TemplateArtifactLiveResult<Data> {
	return { kind: 'unavailable', operation, reason: binding.reason };
}
function receiptMatches(
	receipt: OperationReceiptRef | undefined,
	operation: { readonly name: string; readonly version: number }
): receipt is OperationReceiptRef {
	return receipt?.operationName === operation.name && receipt.operationVersion === operation.version;
}
function mapChangesetFailure<Data>(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operation: 'propose' | 'commit'
): TemplateArtifactLiveResult<Data> {
	if (result.kind === 'unavailable') return { kind: 'unavailable', operation, reason: result.reason };
	if (result.kind === 'transport_error') return result;
	return {
		kind: 'outcome', outcome: result.outcome,
		...(result.terminal === undefined ? {} : { terminal: result.terminal }),
		correlationId: result.correlationId,
		...(result.receipt === undefined ? {} : { receipt: result.receipt })
	};
}

/** Pure-live client for the complete manual Template artifact review loop. */
export function createTemplateArtifactLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: TemplateArtifactRequester;
}): TemplateArtifactLiveClient {
	const listBinding = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: TEMPLATE_ARTIFACT_LIVE_OPERATIONS.list
	});
	const draftBinding = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: TEMPLATE_ARTIFACT_LIVE_OPERATIONS.draft
	});
	const request = input.request ?? defaultRequester;
	const changesets = createChangesetReviewLivePort({
		manifest: input.manifest,
		request: (requestInput) => request(requestInput)
	});

	return Object.freeze({
		async list(
			kind?: 'message' | 'surface' | 'theme',
			options: { readonly signal?: AbortSignal } = {}
		): Promise<TemplateArtifactLiveResult<readonly TemplateArtifactSnapshotDto[]>> {
			if (listBinding.kind === 'unavailable') return unavailable('list', listBinding);
			const query = templateArtifactListInputSchema.safeParse(kind === undefined ? {} : { kind });
			if (!query.success) return invalidRequest();
			const suffix = new URLSearchParams(query.data).toString();
			const transport = await request({
				path: `${listBinding.path}${suffix ? `?${suffix}` : ''}`,
				method: 'GET', schema: templateArtifactListOperationResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = templateArtifactListOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			const result = parsed.data as ListOperationResult;
			return result.kind === 'success'
				? { kind: 'success', data: result.data.artifacts, correlationId: result.correlationId }
				: { kind: 'outcome', outcome: result.outcome, correlationId: result.correlationId };
		},

		async mutate(
			rawMutation: TemplateArtifactMutationInputDto,
			rawKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<TemplateArtifactLiveResult<{
			readonly revision: TemplateArtifactSafeDiffDto['after'];
			readonly safeDiff: TemplateArtifactSafeDiffDto;
			readonly committedHeadVersion: number;
		}>> {
			const mutation = templateArtifactMutationInputSchema.safeParse(rawMutation);
			const key = operationHttpIdempotencyKeySchema.safeParse(rawKey);
			if (!mutation.success || !key.success) return invalidRequest();
			if (draftBinding.kind === 'unavailable') return unavailable('draft', draftBinding);
			const draftTransport = await request({
				path: draftBinding.path,
				method: 'POST', schema: templateArtifactMutationDraftOperationResultSchema,
				body: mutation.data, idempotencyKey: `${key.data}.draft`,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (draftTransport.kind === 'error') return { kind: 'transport_error', error: draftTransport.error };
			const parsedDraft = templateArtifactMutationDraftOperationResultSchema.safeParse(draftTransport.data);
			if (!parsedDraft.success) return invalidContract();
			const draft = parsedDraft.data as DraftOperationResult;
			if (draft.kind === 'outcome') return {
				kind: 'outcome', outcome: draft.outcome, terminal: draft.terminal,
				correlationId: draft.correlationId,
				...('receipt' in draft ? { receipt: draft.receipt } : {})
			};
			if (!receiptMatches(draft.receipt, TEMPLATE_ARTIFACT_LIVE_OPERATIONS.draft)
				|| draft.data.action !== mutation.data.action
				|| draft.data.safeDiff.artifactId !== mutation.data.artifactId
				|| draft.data.safeDiff.before.number !== mutation.data.expectedRevisionNumber
				|| (mutation.data.action === 'replace'
					&& !jsonEquivalent(draft.data.safeDiff.after.document, mutation.data.document))
				|| (mutation.data.action === 'revert'
					&& draft.data.safeDiff.restoredFromRevisionNumber !== mutation.data.targetRevisionNumber)) {
				return invalidContract();
			}
			if (draft.data.approvalPolicy.requirement !== 'none') {
				return invalidContract();
			}
			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: draft.data.changesetId,
				revisionId: draft.data.revision.id,
				revisionDigest: draft.data.revision.digestSha256
			});
			const proposed = await changesets.propose(
				{ ...selector, expectedHeadVersion: draft.data.headVersion },
				`${key.data}.propose`, options.signal ? { signal: options.signal } : {}
			);
			if (proposed.kind !== 'success') return mapChangesetFailure(proposed, 'propose');
			const operations = proposed.data.groups.flatMap((group) => group.operations);
			const operation = operations[0];
			if (proposed.data.operationCount !== 1 || operations.length !== 1
				|| operation?.kind !== 'template.artifact.change' || operation.version !== 1
				|| operation.dependencyGroup !== 'template_artifact'
				|| !jsonEquivalent(operation.safeDiff, draft.data.safeDiff)) return invalidContract();
			const committed = await changesets.commit(
				{ ...selector, expectedHeadVersion: proposed.data.headVersion },
				`${key.data}.commit`, options.signal ? { signal: options.signal } : {}
			);
			if (committed.kind !== 'success') return mapChangesetFailure(committed, 'commit');
			return {
				kind: 'success',
				data: {
					revision: draft.data.safeDiff.after,
					safeDiff: draft.data.safeDiff,
					committedHeadVersion: committed.data.committedHeadVersion
				},
				correlationId: committed.correlationId ?? draft.correlationId,
				receipt: committed.receipt
			};
		}
	});
}
