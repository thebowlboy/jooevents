import {
	RELEASE_OPERATION_SCHEMA_REFS,
	changesetRevisionSelectorSchema,
	operationHttpIdempotencyKeySchema,
	releaseAuthorInputSchema,
	releaseDraftOperationResultSchema,
	releaseOverviewReadInputSchema,
	releaseOverviewReadResultSchema,
	type OperationReceiptRef,
	type ReleaseAuthorInput,
	type ReleaseOverviewDto,
	type ReleaseSafeDiffDto,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { createChangesetReviewLivePort } from '../changesets/live';
import type { ChangesetReviewResult } from '../changesets/port';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { jsonEquivalent } from '../json-equivalence';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const RELEASE_LIVE_OPERATIONS = Object.freeze({
	overview: {
		name: 'release.overview.read', version: 1, effect: 'read',
		method: 'GET', input: 'query', idempotencyRequired: false,
		...RELEASE_OPERATION_SCHEMA_REFS.overviewRead
	},
	draft: {
		name: 'release.change.draft', version: 1, effect: 'draft',
		method: 'POST', input: 'body', idempotencyRequired: true,
		...RELEASE_OPERATION_SCHEMA_REFS.draft
	}
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

export type ReleaseLiveOperation = 'overview' | 'draft' | 'propose' | 'commit';
export type ReleaseLiveResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal?: boolean; readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly operation: ReleaseLiveOperation; readonly reason: OperatorHttpBindingUnavailableReason };

export interface ReleaseLiveClient {
	overview(): Promise<ReleaseLiveResult<ReleaseOverviewDto>>;
	mutate(input: ReleaseAuthorInput, idempotencyKey: string): Promise<ReleaseLiveResult<{
		readonly safeDiff: ReleaseSafeDiffDto;
		readonly committedHeadVersion: number;
	}>>;
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

function invalidContract<Data>(): ReleaseLiveResult<Data> {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function mapChangesetFailure<Data>(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operation: 'propose' | 'commit'
): ReleaseLiveResult<Data> {
	if (result.kind === 'unavailable') return { kind: 'unavailable', operation, reason: result.reason };
	if (result.kind === 'transport_error') return result;
	return {
		kind: 'outcome', outcome: result.outcome,
		...(result.terminal === undefined ? {} : { terminal: result.terminal }),
		correlationId: result.correlationId,
		...(result.receipt === undefined ? {} : { receipt: result.receipt })
	};
}

/** Pure-live read and reviewed release mutation client. */
export function createReleaseLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: ReleaseRequester;
}): ReleaseLiveClient {
	const overviewBinding = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: RELEASE_LIVE_OPERATIONS.overview
	});
	const draftBinding = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: RELEASE_LIVE_OPERATIONS.draft
	});
	const request = input.request ?? defaultRequester;
	const changesets = createChangesetReviewLivePort({
		manifest: input.manifest,
		request: (requestInput) => request(requestInput)
	});

	return Object.freeze({
		async overview(): Promise<ReleaseLiveResult<ReleaseOverviewDto>> {
			if (overviewBinding.kind === 'unavailable') return {
				kind: 'unavailable' as const, operation: 'overview' as const,
				reason: overviewBinding.reason
			};
			const query = releaseOverviewReadInputSchema.safeParse({});
			if (!query.success) return invalidContract();
			const transport = await request({
				path: overviewBinding.path,
				method: 'GET',
				schema: releaseOverviewReadResultSchema
			});
			if (transport.kind === 'error') return { kind: 'transport_error' as const, error: transport.error };
			const result = releaseOverviewReadResultSchema.safeParse(transport.data);
			if (!result.success) return invalidContract();
			return result.data.kind === 'success'
				? { kind: 'success' as const, data: result.data.data, correlationId: result.data.correlationId }
				: { kind: 'outcome' as const, outcome: result.data.outcome, correlationId: result.data.correlationId };
		},

		async mutate(
			rawInput: ReleaseAuthorInput,
			rawKey: string
		): Promise<ReleaseLiveResult<{
			readonly safeDiff: ReleaseSafeDiffDto;
			readonly committedHeadVersion: number;
		}>> {
			const business = releaseAuthorInputSchema.safeParse(rawInput);
			const key = operationHttpIdempotencyKeySchema.safeParse(rawKey);
			if (!business.success || !key.success) return {
				kind: 'transport_error' as const,
				error: { code: 'invalid_request', retryable: false }
			};
			if (draftBinding.kind === 'unavailable') return {
				kind: 'unavailable' as const, operation: 'draft' as const,
				reason: draftBinding.reason
			};
			const transport = await request({
				path: draftBinding.path,
				method: 'POST',
				schema: releaseDraftOperationResultSchema,
				body: business.data,
				idempotencyKey: `${key.data}.draft`
			});
			if (transport.kind === 'error') return { kind: 'transport_error' as const, error: transport.error };
			const parsed = releaseDraftOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			const draft = parsed.data;
			if (draft.kind === 'outcome') return {
				kind: 'outcome' as const, outcome: draft.outcome, terminal: draft.terminal,
				correlationId: draft.correlationId,
				...('receipt' in draft ? { receipt: draft.receipt } : {})
			};
			if (draft.receipt.operationName !== RELEASE_LIVE_OPERATIONS.draft.name
				|| draft.receipt.operationVersion !== RELEASE_LIVE_OPERATIONS.draft.version
				|| draft.data.action !== business.data.action
				|| draft.data.safeDiff.action !== business.data.action
				|| draft.data.approvalPolicy.requirement !== 'none') return invalidContract();
			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: draft.data.changesetId,
				revisionId: draft.data.revision.id,
				revisionDigest: draft.data.revision.digestSha256
			});
			const proposed = await changesets.propose(
				{ ...selector, expectedHeadVersion: draft.data.headVersion }, `${key.data}.propose`
			);
			if (proposed.kind !== 'success') return mapChangesetFailure(proposed, 'propose');
			const operations = proposed.data.groups.flatMap((group) => group.operations);
			const operation = operations[0];
			if (proposed.data.operationCount !== 1 || operations.length !== 1
				|| operation?.kind !== 'release.publish' || operation.version !== 1
				|| operation.dependencyGroup !== 'release'
				|| !jsonEquivalent(operation.safeDiff, draft.data.safeDiff)) return invalidContract();
			const committed = await changesets.commit(
				{ ...selector, expectedHeadVersion: proposed.data.headVersion }, `${key.data}.commit`
			);
			if (committed.kind !== 'success') return mapChangesetFailure(committed, 'commit');
			return {
				kind: 'success' as const,
				data: {
					safeDiff: draft.data.safeDiff,
					committedHeadVersion: committed.data.committedHeadVersion
				},
				correlationId: committed.correlationId ?? draft.correlationId,
				receipt: committed.receipt
			};
		}
	});
}
