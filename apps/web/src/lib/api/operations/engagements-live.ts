import {
	changesetRevisionSelectorSchema,
	ENGAGEMENT_OPERATION_SCHEMA_REFS,
	engagementAuthorInputSchema,
	engagementChangeDraftOperationResultSchema,
	engagementSafeDiffSchema,
	engagementSnapshotReadResultSchema,
	operationHttpIdempotencyKeySchema,
	type EngagementAuthorInput,
	type EngagementSafeDiffDto,
	type EngagementSnapshotDto,
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
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const ENGAGEMENTS_LIVE_OPERATIONS = Object.freeze({
	read: Object.freeze({ name: 'engagement.snapshot.read', version: 1 } as const),
	draft: Object.freeze({ name: 'engagement.change.draft', version: 1 } as const)
});

/** The one changeset operation a committed engagement response carries. */
const ENGAGEMENT_CHANGESET_OPERATION = Object.freeze({
	kind: 'engagement.respond',
	version: 1,
	dependencyGroup: 'engagement'
} as const);

const EXPECTED_OPERATIONS = Object.freeze({
	read: {
		...ENGAGEMENTS_LIVE_OPERATIONS.read,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...ENGAGEMENT_OPERATION_SCHEMA_REFS.snapshotRead
	},
	draft: {
		...ENGAGEMENTS_LIVE_OPERATIONS.draft,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...ENGAGEMENT_OPERATION_SCHEMA_REFS.changeDraft
	}
} as const satisfies Readonly<Record<string, ExpectedOperatorHttpOperation>>);

export type EngagementsLiveOperation = keyof typeof EXPECTED_OPERATIONS | 'propose' | 'commit';

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: EngagementsLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type EngagementsLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface EngagementsCommittedResponse {
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly committedHeadVersion: number;
	readonly safeDiff: EngagementSafeDiffDto;
}

export type EngagementsLiveRespondResult =
	| {
			readonly kind: 'success';
			readonly data: EngagementsCommittedResponse;
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

export interface EngagementsLiveRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type EngagementsLiveRequester = (
	input: EngagementsLiveRequestInput
) => Promise<ApiResult<unknown>>;

/**
 * Live client for the canonical engagement vertical: the whole-event snapshot
 * read (`engagement.snapshot.read`) and the four consequential response acts
 * (`record_confirmation` — organizer-recorded only on this wire — `decline`,
 * `request_cancellation`, `accept_cancellation`) carried end to end through
 * `engagement.change.draft` and the generic changeset propose/commit
 * lifecycle. Every response is verified against the exact drafted change it
 * claims to advance, so a swapped or partial changeset never reads as this
 * response succeeding. Pure live: no sample state is ever consulted.
 */
export interface EngagementsLiveClient {
	readSnapshot(
		options?: { readonly signal?: AbortSignal }
	): Promise<EngagementsLiveReadResult<EngagementSnapshotDto>>;
	respond(
		input: EngagementAuthorInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<EngagementsLiveRespondResult>;
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
		stage, `je.engagement.respond.${stage}.${anchor}`
	])));
}

function mapChangesetFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operationName: 'propose' | 'commit'
): EngagementsLiveRespondResult {
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

export function createEngagementsLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: EngagementsLiveRequester;
}): EngagementsLiveClient {
	const request = input.request ?? ((requestInput: EngagementsLiveRequestInput) =>
		requestJson(requestInput));
	const bindings = Object.freeze({
		read: resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.read }),
		draft: resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.draft }),
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
		async readSnapshot(
			options: { readonly signal?: AbortSignal } = {}
		): Promise<EngagementsLiveReadResult<EngagementSnapshotDto>> {
			if (bindings.read.kind === 'unavailable') {
				return { kind: 'unavailable', operation: 'read', reason: bindings.read.reason };
			}
			const response = await request({
				path: bindings.read.path,
				method: 'GET',
				schema: engagementSnapshotReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = engagementSnapshotReadResultSchema.safeParse(response.data);
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
				data: parsed.data.data,
				correlationId: parsed.data.correlationId
			};
		},

		async respond(
			rawInput: EngagementAuthorInput,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<EngagementsLiveRespondResult> {
			const parsedInput = engagementAuthorInputSchema.safeParse(rawInput);
			if (!parsedInput.success) return invalidRequest();
			for (const [key, binding] of Object.entries(bindings)) {
				if (key !== 'read' && binding.kind === 'unavailable') {
					return {
						kind: 'unavailable',
						operation: key as EngagementsLiveOperation,
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
				schema: engagementChangeDraftOperationResultSchema,
				body: parsedInput.data,
				idempotencyKey: keys.draft!,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = engagementChangeDraftOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') {
				if (parsed.data.terminal) {
					if (!receiptMatches(parsed.data.receipt, ENGAGEMENTS_LIVE_OPERATIONS.draft)) {
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
			// The drafted change must be exactly the act this call asked for, on
			// exactly the engagement it named: the safe diff's before image is the
			// current head the server planned against.
			if (!receiptMatches(draft.receipt, ENGAGEMENTS_LIVE_OPERATIONS.draft)
				|| draft.data.action !== parsedInput.data.action
				|| draft.data.safeDiff.action !== parsedInput.data.action
				|| draft.data.safeDiff.before?.id !== parsedInput.data.engagementId
				|| draft.data.safeDiff.before.version !== parsedInput.data.expectedEngagementVersion) {
				return invalidContract();
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
			const proposedDiff = engagementSafeDiffSchema.safeParse(operation?.safeDiff);
			if (!receiptMatches(proposed.receipt, CHANGESET_REVIEW_OPERATIONS.propose)
				|| proposed.correlationId === undefined
				|| proposed.data.operationCount !== 1
				|| operations.length !== 1
				|| operation?.kind !== ENGAGEMENT_CHANGESET_OPERATION.kind
				|| operation.version !== ENGAGEMENT_CHANGESET_OPERATION.version
				|| operation.dependencyGroup !== ENGAGEMENT_CHANGESET_OPERATION.dependencyGroup
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
