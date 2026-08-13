import {
	changesetRevisionSelectorSchema,
	DECISION_OPERATION_SCHEMA_REFS,
	decisionAuthorInputSchema,
	decisionDecideDraftOperationResultSchema,
	decisionSafeDiffSchema,
	decisionStateReadInputSchema,
	decisionStateReadResultSchema,
	operationHttpIdempotencyKeySchema,
	type DecisionAuthorInput,
	type DecisionSafeDiffDto,
	type DecisionStateSnapshotDto,
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

export const DECISIONS_LIVE_OPERATIONS = Object.freeze({
	read: Object.freeze({ name: 'decision.state.read', version: 1 } as const),
	draft: Object.freeze({ name: 'decision.decide.draft', version: 1 } as const)
});

/** The one changeset operation a committed decide carries. */
const DECISION_CHANGESET_OPERATION = Object.freeze({
	kind: 'decision.decide',
	version: 1,
	dependencyGroup: 'decision'
} as const);

const EXPECTED_OPERATIONS = Object.freeze({
	read: {
		...DECISIONS_LIVE_OPERATIONS.read,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...DECISION_OPERATION_SCHEMA_REFS.stateRead
	},
	draft: {
		...DECISIONS_LIVE_OPERATIONS.draft,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...DECISION_OPERATION_SCHEMA_REFS.decideDraft
	}
} as const satisfies Readonly<Record<string, ExpectedOperatorHttpOperation>>);

export type DecisionsLiveOperation = keyof typeof EXPECTED_OPERATIONS | 'propose' | 'commit';

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: DecisionsLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type DecisionsLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface DecisionsCommittedDecide {
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly committedHeadVersion: number;
	readonly safeDiff: DecisionSafeDiffDto;
}

export type DecisionsLiveDecideResult =
	| {
			readonly kind: 'success';
			readonly data: DecisionsCommittedDecide;
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

export interface DecisionsLiveRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type DecisionsLiveRequester = (
	input: DecisionsLiveRequestInput
) => Promise<ApiResult<unknown>>;

/**
 * Live client for the canonical Decision spine: the whole-truth state read
 * (`decision.state.read`, at most 100 submission ids per request — chunking
 * belongs to callers) and the consequential decide carried end to end through
 * `decision.decide.draft` and the generic changeset propose/commit lifecycle.
 * Every response is verified against the exact drafted change it claims to
 * advance, so a swapped or partial changeset never reads as this decide
 * succeeding. Pure live: no sample state is ever consulted.
 */
export interface DecisionsLiveClient {
	readState(
		submissionIds: readonly string[],
		options?: { readonly signal?: AbortSignal }
	): Promise<DecisionsLiveReadResult<DecisionStateSnapshotDto>>;
	decide(
		input: DecisionAuthorInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<DecisionsLiveDecideResult>;
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
		stage, `je.decision.decide.${stage}.${anchor}`
	])));
}

function mapChangesetFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operationName: 'propose' | 'commit'
): DecisionsLiveDecideResult {
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

export function createDecisionsLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: DecisionsLiveRequester;
}): DecisionsLiveClient {
	const request = input.request ?? ((requestInput: DecisionsLiveRequestInput) =>
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
		async readState(
			submissionIds: readonly string[],
			options: { readonly signal?: AbortSignal } = {}
		): Promise<DecisionsLiveReadResult<DecisionStateSnapshotDto>> {
			const parsedInput = decisionStateReadInputSchema.safeParse({
				submissionIds: [...submissionIds]
			});
			if (!parsedInput.success) return invalidRequest();
			if (bindings.read.kind === 'unavailable') {
				return { kind: 'unavailable', operation: 'read', reason: bindings.read.reason };
			}
			const query = new URLSearchParams();
			for (const submissionId of parsedInput.data.submissionIds) {
				query.append('submissionIds', submissionId);
			}
			const response = await request({
				path: `${bindings.read.path}?${query.toString()}`,
				method: 'GET',
				schema: decisionStateReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = decisionStateReadResultSchema.safeParse(response.data);
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

		async decide(
			rawInput: DecisionAuthorInput,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<DecisionsLiveDecideResult> {
			const parsedInput = decisionAuthorInputSchema.safeParse(rawInput);
			if (!parsedInput.success) return invalidRequest();
			for (const [key, binding] of Object.entries(bindings)) {
				if (key !== 'read' && binding.kind === 'unavailable') {
					return {
						kind: 'unavailable',
						operation: key as DecisionsLiveOperation,
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
				schema: decisionDecideDraftOperationResultSchema,
				body: parsedInput.data,
				idempotencyKey: keys.draft!,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = decisionDecideDraftOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') {
				if (parsed.data.terminal) {
					if (!receiptMatches(parsed.data.receipt, DECISIONS_LIVE_OPERATIONS.draft)) {
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
			const draftedIds = draft.data.safeDiff.rows.map((row) => row.submissionId).sort();
			const askedIds = parsedInput.data.decisions.map((row) => row.submissionId).sort();
			if (!receiptMatches(draft.receipt, DECISIONS_LIVE_OPERATIONS.draft)
				|| draft.data.action !== 'decide'
				|| draft.data.safeDiff.action !== 'decide'
				|| !sameJson(draftedIds, askedIds)) {
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
			const proposedDiff = decisionSafeDiffSchema.safeParse(operation?.safeDiff);
			if (!receiptMatches(proposed.receipt, CHANGESET_REVIEW_OPERATIONS.propose)
				|| proposed.correlationId === undefined
				|| proposed.data.operationCount !== 1
				|| operations.length !== 1
				|| operation?.kind !== DECISION_CHANGESET_OPERATION.kind
				|| operation.version !== DECISION_CHANGESET_OPERATION.version
				|| operation.dependencyGroup !== DECISION_CHANGESET_OPERATION.dependencyGroup
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
