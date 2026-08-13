import {
	CHANGESET_OPERATION_SCHEMA_REFS,
	changesetDiffInputSchema,
	changesetDiffOperationResultSchema,
	commitChangesetInputSchema,
	committedChangesetOperationResultSchema,
	operationHttpIdempotencyKeySchema,
	proposeChangesetInputSchema,
	proposedChangesetOperationResultSchema,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult } from '../client';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution
} from '../operations/operator-http-binding';
import { mapChangesetCommit, mapChangesetDiff } from './mapper';
import type {
	ChangesetCommitView,
	ChangesetDiffView,
	ChangesetReviewOperation,
	ChangesetReviewPort,
	ChangesetReviewResult,
	ChangesetReviewEffectInput
} from './port';

export const CHANGESET_REVIEW_OPERATIONS = Object.freeze({
	diff: {
		name: 'changeset.diff.read', version: 1, effect: 'read',
		method: 'GET', input: 'query', idempotencyRequired: false,
		...CHANGESET_OPERATION_SCHEMA_REFS.diff
	},
	propose: {
		name: 'changeset.propose', version: 1, effect: 'draft',
		method: 'POST', input: 'body', idempotencyRequired: true,
		...CHANGESET_OPERATION_SCHEMA_REFS.propose
	},
	commit: {
		name: 'changeset.commit', version: 1, effect: 'commit',
		method: 'POST', input: 'body', idempotencyRequired: true,
		...CHANGESET_OPERATION_SCHEMA_REFS.commit
	}
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

export interface ChangesetReviewRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type ChangesetReviewRequester = (
	input: ChangesetReviewRequestInput
) => Promise<ApiResult<unknown>>;

type BindingKey = keyof typeof CHANGESET_REVIEW_OPERATIONS;
type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

type ParsedOperationResult =
	| {
			readonly kind: 'success';
			readonly data: unknown;
			readonly correlationId: string;
			readonly receipt?: OperationReceiptRef;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal?: boolean;
			readonly correlationId: string;
			readonly receipt?: OperationReceiptRef;
	  };

function defaultRequester(input: ChangesetReviewRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function resolveBindings(manifest: unknown): Bindings {
	return Object.freeze(Object.fromEntries(
		Object.entries(CHANGESET_REVIEW_OPERATIONS).map(([key, expected]) => [
			key,
			resolveOperatorHttpBinding({ manifest, expected })
		])
	) as unknown as Bindings);
}

function invalidRequest<Data>(): ChangesetReviewResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract<Data>(): ChangesetReviewResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function sameSelector(
	data: { readonly changesetId: string; readonly revisionId: string; readonly revisionDigest: string },
	selector: { readonly changesetId: string; readonly revisionId: string; readonly revisionDigest: string }
): boolean {
	return data.changesetId === selector.changesetId
		&& data.revisionId === selector.revisionId
		&& data.revisionDigest === selector.revisionDigest;
}

function mapBoundDiff(
	data: Parameters<typeof mapChangesetDiff>[0],
	selector: { readonly changesetId: string; readonly revisionId: string; readonly revisionDigest: string },
	expected?: { readonly status: 'proposed'; readonly headVersion: number }
): ChangesetDiffView {
	if (!sameSelector(data, selector)
		|| (expected !== undefined
			&& (data.status !== expected.status || data.headVersion !== expected.headVersion))) {
		throw new TypeError('changeset_response_selector_mismatch');
	}
	return mapChangesetDiff(data);
}

function mapBoundCommit(
	data: Parameters<typeof mapChangesetCommit>[0],
	request: ChangesetReviewEffectInput
): ChangesetCommitView {
	if (!sameSelector(data, request)
		|| data.expectedHeadVersion !== request.expectedHeadVersion
		|| data.committedHeadVersion !== request.expectedHeadVersion + 1) {
		throw new TypeError('changeset_commit_response_mismatch');
	}
	return mapChangesetCommit(data);
}

function unavailable<Data>(
	operation: ChangesetReviewOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): ChangesetReviewResult<Data> {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function mapParsedResult<Data>(
	result: ParsedOperationResult,
	map: (data: unknown) => Data
): ChangesetReviewResult<Data> {
	if (result.kind === 'outcome') {
		return {
			kind: 'outcome',
			outcome: result.outcome,
			...(result.terminal === undefined ? {} : { terminal: result.terminal }),
			correlationId: result.correlationId,
			...(result.receipt ? { receipt: result.receipt } : {})
		};
	}
	try {
		return {
			kind: 'success',
			data: map(result.data),
			correlationId: result.correlationId,
			...(result.receipt ? { receipt: result.receipt } : {})
		};
	} catch {
		return invalidContract();
	}
}

async function requestParsed<Data>(input: {
	readonly binding: OperatorHttpBindingResolution;
	readonly operation: ChangesetReviewOperation;
	readonly requester: ChangesetReviewRequester;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly pathSuffix?: string;
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
	readonly map: (data: unknown) => Data;
}): Promise<ChangesetReviewResult<Data>> {
	if (input.binding.kind === 'unavailable') return unavailable(input.operation, input.binding);
	const response = await input.requester({
		path: `${input.binding.path}${input.pathSuffix ?? ''}`,
		method: input.method,
		schema: input.schema,
		...(input.body === undefined ? {} : { body: input.body }),
		...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
		...(input.signal ? { signal: input.signal } : {})
	});
	if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
	const parsed = input.schema.safeParse(response.data);
	if (!parsed.success) return invalidContract();
	return mapParsedResult(parsed.data as ParsedOperationResult, input.map);
}

/** Pure-live client: paths come only from one exact active operation manifest. */
export function createChangesetReviewLivePort(input: {
	readonly manifest: unknown;
	readonly request?: ChangesetReviewRequester;
}): ChangesetReviewPort {
	const bindings = resolveBindings(input.manifest);
	const requester = input.request ?? defaultRequester;

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		readDiff: (selector, options: { readonly signal?: AbortSignal } = {}) => {
			const parsed = changesetDiffInputSchema.safeParse(selector);
			if (!parsed.success) return Promise.resolve(invalidRequest<ChangesetDiffView>());
			return requestParsed({
				binding: bindings.diff,
				operation: 'diff',
				requester,
				schema: changesetDiffOperationResultSchema,
				method: 'GET',
				pathSuffix: `?${new URLSearchParams(parsed.data).toString()}`,
				...(options.signal ? { signal: options.signal } : {}),
				map: (data) => mapBoundDiff(
					data as Parameters<typeof mapChangesetDiff>[0],
					parsed.data
				)
			});
		},
		propose: (effectInput, idempotencyKey, options: { readonly signal?: AbortSignal } = {}) => {
			const parsed = proposeChangesetInputSchema.safeParse(effectInput);
			const parsedKey = operationHttpIdempotencyKeySchema.safeParse(idempotencyKey);
			if (!parsed.success || !parsedKey.success) {
				return Promise.resolve(invalidRequest<ChangesetDiffView>());
			}
			return requestParsed({
				binding: bindings.propose,
				operation: 'propose',
				requester,
				schema: proposedChangesetOperationResultSchema,
				method: 'POST',
				body: parsed.data,
				idempotencyKey: parsedKey.data,
				...(options.signal ? { signal: options.signal } : {}),
				map: (data) => mapBoundDiff(
					(data as { readonly diff: Parameters<typeof mapChangesetDiff>[0] }).diff,
					parsed.data,
					{ status: 'proposed', headVersion: parsed.data.expectedHeadVersion + 1 }
				)
			});
		},
		commit: (effectInput, idempotencyKey, options: { readonly signal?: AbortSignal } = {}) => {
			const parsed = commitChangesetInputSchema.safeParse(effectInput);
			const parsedKey = operationHttpIdempotencyKeySchema.safeParse(idempotencyKey);
			if (!parsed.success || !parsedKey.success) {
				return Promise.resolve(invalidRequest<ChangesetCommitView>());
			}
			return requestParsed({
				binding: bindings.commit,
				operation: 'commit',
				requester,
				schema: committedChangesetOperationResultSchema,
				method: 'POST',
				body: parsed.data,
				idempotencyKey: parsedKey.data,
				...(options.signal ? { signal: options.signal } : {}),
				map: (data) => mapBoundCommit(
					data as Parameters<typeof mapChangesetCommit>[0],
					parsed.data
				)
			});
		}
	} satisfies ChangesetReviewPort);
}
