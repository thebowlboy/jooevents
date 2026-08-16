import {
	TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	templateArtifactListInputSchema,
	templateArtifactListOperationResultSchema,
	templateArtifactMutationInputSchema,
	templateArtifactPublishInputSchema,
	templateArtifactPublishOperationResultSchema,
	templateArtifactReviewDraftOperationResultSchema,
	type OperationReceiptRef,
	type StructuredOutcome,
	type TemplateArtifactMutationInputDto,
	type TemplateArtifactSafeDiffDto,
	type TemplateArtifactSnapshotDto
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { jsonEquivalent } from '../json-equivalence';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

type ExactOperation = ExpectedOperatorHttpOperation & { readonly path: string };

export const TEMPLATE_ARTIFACT_LIVE_OPERATIONS = Object.freeze({
	list: {
		name: 'template.artifact.list', version: 1, effect: 'read',
		method: 'GET', input: 'query', idempotencyRequired: false,
		path: '/api/events/current/template-artifacts',
		...TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.list
	},
	draft: {
		name: 'template.artifact.change.draft', version: 1, effect: 'draft',
		method: 'POST', input: 'body', idempotencyRequired: true,
		path: '/api/events/current/template-artifacts/drafts',
		...TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.reviewDraft
	},
	publish: {
		name: 'template.artifact.change', version: 1, effect: 'commit',
		method: 'POST', input: 'body', idempotencyRequired: true,
		path: '/api/events/current/template-artifacts/publish',
		...TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.publish
	}
} as const satisfies Record<string, ExactOperation>);

export type TemplateArtifactLiveOperation = keyof typeof TEMPLATE_ARTIFACT_LIVE_OPERATIONS;
export type TemplateArtifactMutationKeys = Readonly<{ draft: string; publish: string }>;
export type TemplateArtifactLiveResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string;
		readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal?: boolean;
		readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly operation: TemplateArtifactLiveOperation;
		readonly reason: OperatorHttpBindingUnavailableReason };

export type TemplateArtifactLiveMutationData = Readonly<{
	revision: TemplateArtifactSafeDiffDto['after'];
	safeDiff: TemplateArtifactSafeDiffDto;
}>;

export interface TemplateArtifactLiveClient {
	list(kind?: 'message' | 'surface' | 'theme', options?: { readonly signal?: AbortSignal }):
		Promise<TemplateArtifactLiveResult<readonly TemplateArtifactSnapshotDto[]>>;
	mutate(
		mutation: TemplateArtifactMutationInputDto,
		keys: TemplateArtifactMutationKeys,
		options?: { readonly signal?: AbortSignal }
	): Promise<TemplateArtifactLiveResult<TemplateArtifactLiveMutationData>>;
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

function defaultRequester(input: TemplateArtifactRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function exactBinding(manifest: unknown, expected: ExactOperation): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	return binding.kind === 'available' && binding.path !== expected.path
		? { kind: 'unavailable', reason: 'operation_contract_mismatch' }
		: binding;
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
function receiptMatches(receipt: OperationReceiptRef, expected: ExactOperation): boolean {
	return receipt.operationName === expected.name && receipt.operationVersion === expected.version;
}
function outcomeReceiptMatches(
	result: { readonly terminal?: boolean; readonly receipt?: OperationReceiptRef },
	expected: ExactOperation
): boolean {
	return result.terminal === true
		? result.receipt !== undefined && receiptMatches(result.receipt, expected)
		: result.receipt === undefined;
}

/** Pure-live read and owner-native reviewed Template artifact client. */
export function createTemplateArtifactLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: TemplateArtifactRequester;
}): TemplateArtifactLiveClient {
	const listBinding = exactBinding(input.manifest, TEMPLATE_ARTIFACT_LIVE_OPERATIONS.list);
	const draftBinding = exactBinding(input.manifest, TEMPLATE_ARTIFACT_LIVE_OPERATIONS.draft);
	const publishBinding = exactBinding(input.manifest, TEMPLATE_ARTIFACT_LIVE_OPERATIONS.publish);
	const request = input.request ?? defaultRequester;

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
			const result = templateArtifactListOperationResultSchema.safeParse(transport.data);
			if (!result.success) return invalidContract();
			return result.data.kind === 'success'
				? { kind: 'success', data: result.data.data.artifacts, correlationId: result.data.correlationId }
				: { kind: 'outcome', outcome: result.data.outcome, correlationId: result.data.correlationId };
		},

		async mutate(
			rawMutation: TemplateArtifactMutationInputDto,
			rawKeys: TemplateArtifactMutationKeys,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<TemplateArtifactLiveResult<TemplateArtifactLiveMutationData>> {
			const mutation = templateArtifactMutationInputSchema.safeParse(rawMutation);
			const draftKey = operationHttpIdempotencyKeySchema.safeParse(rawKeys.draft);
			const publishKey = operationHttpIdempotencyKeySchema.safeParse(rawKeys.publish);
			if (!mutation.success || !draftKey.success || !publishKey.success) return invalidRequest();
			if (draftBinding.kind === 'unavailable') return unavailable('draft', draftBinding);
			if (publishBinding.kind === 'unavailable') return unavailable('publish', publishBinding);

			const draftTransport = await request({
				path: draftBinding.path, method: 'POST',
				schema: templateArtifactReviewDraftOperationResultSchema,
				body: mutation.data, idempotencyKey: draftKey.data,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (draftTransport.kind === 'error') return { kind: 'transport_error', error: draftTransport.error };
			const drafted = templateArtifactReviewDraftOperationResultSchema.safeParse(draftTransport.data);
			if (!drafted.success) return invalidContract();
			if (drafted.data.kind === 'outcome') {
				if (!outcomeReceiptMatches(drafted.data, TEMPLATE_ARTIFACT_LIVE_OPERATIONS.draft)) return invalidContract();
				return {
					kind: 'outcome', outcome: drafted.data.outcome, terminal: drafted.data.terminal,
					correlationId: drafted.data.correlationId,
					...('receipt' in drafted.data ? { receipt: drafted.data.receipt } : {})
				};
			}
			if (!receiptMatches(drafted.data.receipt, TEMPLATE_ARTIFACT_LIVE_OPERATIONS.draft)
				|| drafted.data.data.action !== mutation.data.action
				|| drafted.data.data.safeDiff.artifactId !== mutation.data.artifactId
				|| drafted.data.data.safeDiff.before.number !== mutation.data.expectedRevisionNumber
				|| (mutation.data.action === 'replace'
					&& !jsonEquivalent(drafted.data.data.safeDiff.after.document, mutation.data.document))
				|| (mutation.data.action === 'revert'
					&& drafted.data.data.safeDiff.restoredFromRevisionNumber !== mutation.data.targetRevisionNumber)) {
				return invalidContract();
			}

			const selector = templateArtifactPublishInputSchema.safeParse({
				draftId: drafted.data.data.draftId,
				revisionId: drafted.data.data.revision.id,
				revisionDigestSha256: drafted.data.data.revision.digestSha256
			});
			if (!selector.success) return invalidContract();
			const publishTransport = await request({
				path: publishBinding.path, method: 'POST', schema: templateArtifactPublishOperationResultSchema,
				body: selector.data, idempotencyKey: publishKey.data,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (publishTransport.kind === 'error') return { kind: 'transport_error', error: publishTransport.error };
			const published = templateArtifactPublishOperationResultSchema.safeParse(publishTransport.data);
			if (!published.success) return invalidContract();
			if (published.data.kind === 'outcome') {
				if (!outcomeReceiptMatches(published.data, TEMPLATE_ARTIFACT_LIVE_OPERATIONS.publish)) return invalidContract();
				return {
					kind: 'outcome', outcome: published.data.outcome, terminal: published.data.terminal,
					correlationId: published.data.correlationId,
					...('receipt' in published.data ? { receipt: published.data.receipt } : {})
				};
			}
			if (!receiptMatches(published.data.receipt, TEMPLATE_ARTIFACT_LIVE_OPERATIONS.publish)
				|| published.data.data.action !== mutation.data.action
				|| !jsonEquivalent(published.data.data.safeDiff, drafted.data.data.safeDiff)
				|| published.data.data.revision.revisionId !== drafted.data.data.safeDiff.after.revisionId
				|| published.data.data.revision.digestSha256 !== drafted.data.data.safeDiff.after.digestSha256) {
				return invalidContract();
			}
			return {
				kind: 'success',
				data: {
					revision: published.data.data.safeDiff.after,
					safeDiff: published.data.data.safeDiff
				},
				correlationId: published.data.correlationId,
				receipt: published.data.receipt
			};
		}
	});
}
