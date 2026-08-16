import {
	RELEASE_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	releaseAuthorInputSchema,
	releaseOverviewReadInputSchema,
	releaseOverviewReadResultSchema,
	releasePublishInputSchema,
	releasePublishOperationResultSchema,
	releaseReviewDraftOperationResultSchema,
	type OperationReceiptRef,
	type ReleaseAuthorInput,
	type ReleaseMutationResultDto,
	type ReleaseOverviewDto,
	type ReleaseSafeDiffDto,
	type StructuredOutcome
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

export const RELEASE_LIVE_OPERATIONS = Object.freeze({
	overview: {
		name: 'release.overview.read', version: 1, effect: 'read',
		method: 'GET', input: 'query', idempotencyRequired: false,
		path: '/api/events/current/releases',
		...RELEASE_OPERATION_SCHEMA_REFS.overviewRead
	},
	draft: {
		name: 'release.change.draft', version: 1, effect: 'draft',
		method: 'POST', input: 'body', idempotencyRequired: true,
		path: '/api/events/current/releases/drafts',
		...RELEASE_OPERATION_SCHEMA_REFS.reviewDraft
	},
	publish: {
		name: 'release.publish', version: 1, effect: 'commit',
		method: 'POST', input: 'body', idempotencyRequired: true,
		path: '/api/events/current/releases/publish',
		...RELEASE_OPERATION_SCHEMA_REFS.publish
	}
} as const satisfies Record<string, ExactOperation>);

export type ReleaseLiveOperation = keyof typeof RELEASE_LIVE_OPERATIONS;
export type ReleaseMutationKeys = Readonly<{ draft: string; publish: string }>;
export type ReleaseLiveResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string;
		readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal?: boolean;
		readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly operation: ReleaseLiveOperation;
		readonly reason: OperatorHttpBindingUnavailableReason };

export type ReleaseLiveMutationData = Readonly<{
	mutation: ReleaseMutationResultDto;
	safeDiff: ReleaseSafeDiffDto;
}>;

export interface ReleaseLiveClient {
	overview(): Promise<ReleaseLiveResult<ReleaseOverviewDto>>;
	mutate(input: ReleaseAuthorInput, keys: ReleaseMutationKeys): Promise<ReleaseLiveResult<ReleaseLiveMutationData>>;
}

export interface ReleaseRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}
export type ReleaseRequester = (input: ReleaseRequestInput) => Promise<ApiResult<unknown>>;

function defaultRequester(input: ReleaseRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function exactBinding(manifest: unknown, expected: ExactOperation): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	return binding.kind === 'available' && binding.path !== expected.path
		? { kind: 'unavailable', reason: 'operation_contract_mismatch' }
		: binding;
}

function invalidRequest<Data>(): ReleaseLiveResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract<Data>(): ReleaseLiveResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function unavailable<Data>(
	operation: ReleaseLiveOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): ReleaseLiveResult<Data> {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function receiptMatches(
	receipt: OperationReceiptRef,
	expected: ExactOperation
): boolean {
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

function publishedEffectMatches(
	mutation: ReleaseMutationResultDto,
	safeDiff: ReleaseSafeDiffDto
): boolean {
	switch (safeDiff.action) {
		case 'publish_schedule':
		case 'program_rollback':
			if (mutation.action !== safeDiff.action) return false;
			return mutation.release.id === safeDiff.after.releaseId
				&& mutation.release.number === safeDiff.after.number
				&& mutation.release.digestSha256 === safeDiff.after.digestSha256;
		case 'style_set_publish':
			if (mutation.action !== safeDiff.action) return false;
			return mutation.release.id === safeDiff.after.releaseId
				&& mutation.release.number === safeDiff.after.number
				&& mutation.release.digestSha256 === safeDiff.after.digestSha256;
		case 'surface_publish':
			if (mutation.action !== safeDiff.action) return false;
			return mutation.release.id === safeDiff.after.activeReleaseId
				&& jsonEquivalent(mutation.head, safeDiff.after);
		case 'surface_rollback':
		case 'surface_allowlist':
			if (mutation.action !== safeDiff.action) return false;
			return jsonEquivalent(mutation.head, safeDiff.after);
	}
}

/** Pure-live read and owner-native reviewed Release mutation client. */
export function createReleaseLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: ReleaseRequester;
}): ReleaseLiveClient {
	const overviewBinding = exactBinding(input.manifest, RELEASE_LIVE_OPERATIONS.overview);
	const draftBinding = exactBinding(input.manifest, RELEASE_LIVE_OPERATIONS.draft);
	const publishBinding = exactBinding(input.manifest, RELEASE_LIVE_OPERATIONS.publish);
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		async overview(): Promise<ReleaseLiveResult<ReleaseOverviewDto>> {
			if (overviewBinding.kind === 'unavailable') return unavailable('overview', overviewBinding);
			const query = releaseOverviewReadInputSchema.safeParse({});
			if (!query.success) return invalidContract();
			const transport = await request({
				path: overviewBinding.path, method: 'GET', schema: releaseOverviewReadResultSchema
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const result = releaseOverviewReadResultSchema.safeParse(transport.data);
			if (!result.success) return invalidContract();
			return result.data.kind === 'success'
				? { kind: 'success', data: result.data.data, correlationId: result.data.correlationId }
				: { kind: 'outcome', outcome: result.data.outcome, correlationId: result.data.correlationId };
		},

		async mutate(
			rawInput: ReleaseAuthorInput,
			rawKeys: ReleaseMutationKeys
		): Promise<ReleaseLiveResult<ReleaseLiveMutationData>> {
			const business = releaseAuthorInputSchema.safeParse(rawInput);
			const draftKey = operationHttpIdempotencyKeySchema.safeParse(rawKeys.draft);
			const publishKey = operationHttpIdempotencyKeySchema.safeParse(rawKeys.publish);
			if (!business.success || !draftKey.success || !publishKey.success) return invalidRequest();
			if (draftBinding.kind === 'unavailable') return unavailable('draft', draftBinding);
			if (publishBinding.kind === 'unavailable') return unavailable('publish', publishBinding);

			const draftTransport = await request({
				path: draftBinding.path,
				method: 'POST',
				schema: releaseReviewDraftOperationResultSchema,
				body: business.data,
				idempotencyKey: draftKey.data
			});
			if (draftTransport.kind === 'error') return { kind: 'transport_error', error: draftTransport.error };
			const drafted = releaseReviewDraftOperationResultSchema.safeParse(draftTransport.data);
			if (!drafted.success) return invalidContract();
			if (drafted.data.kind === 'outcome') {
				if (!outcomeReceiptMatches(drafted.data, RELEASE_LIVE_OPERATIONS.draft)) return invalidContract();
				return {
					kind: 'outcome', outcome: drafted.data.outcome, terminal: drafted.data.terminal,
					correlationId: drafted.data.correlationId,
					...('receipt' in drafted.data ? { receipt: drafted.data.receipt } : {})
				};
			}
			if (!receiptMatches(drafted.data.receipt, RELEASE_LIVE_OPERATIONS.draft)
				|| drafted.data.data.action !== business.data.action
				|| drafted.data.data.safeDiff.action !== business.data.action) return invalidContract();

			const selector = releasePublishInputSchema.safeParse({
				draftId: drafted.data.data.draftId,
				revisionId: drafted.data.data.revision.id,
				revisionDigestSha256: drafted.data.data.revision.digestSha256
			});
			if (!selector.success) return invalidContract();
			const publishTransport = await request({
				path: publishBinding.path,
				method: 'POST',
				schema: releasePublishOperationResultSchema,
				body: selector.data,
				idempotencyKey: publishKey.data
			});
			if (publishTransport.kind === 'error') return { kind: 'transport_error', error: publishTransport.error };
			const published = releasePublishOperationResultSchema.safeParse(publishTransport.data);
			if (!published.success) return invalidContract();
			if (published.data.kind === 'outcome') {
				if (!outcomeReceiptMatches(published.data, RELEASE_LIVE_OPERATIONS.publish)) return invalidContract();
				return {
					kind: 'outcome', outcome: published.data.outcome, terminal: published.data.terminal,
					correlationId: published.data.correlationId,
					...('receipt' in published.data ? { receipt: published.data.receipt } : {})
				};
			}
			if (!receiptMatches(published.data.receipt, RELEASE_LIVE_OPERATIONS.publish)
				|| published.data.data.action !== business.data.action
				|| !publishedEffectMatches(published.data.data, drafted.data.data.safeDiff)) {
				return invalidContract();
			}
			return {
				kind: 'success',
				data: { mutation: published.data.data, safeDiff: drafted.data.data.safeDiff },
				correlationId: published.data.correlationId,
				receipt: published.data.receipt
			};
		}
	});
}
