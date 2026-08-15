import {
	CHANGESET_OPERATION_SCHEMA_REFS,
	TASK_OPERATION_SCHEMA_REFS,
	changesetRevisionSelectorSchema,
	draftChangesetCorrectionInputSchema,
	draftedChangesetCorrectionOperationResultSchema,
	operationHttpIdempotencyKeySchema,
	taskBoardReadResultSchema,
	taskMutationDraftInputSchema,
	taskDraftOperationResultSchema,
	type OperationReceiptRef,
	type StructuredOutcome,
	type ChangesetRevisionSelector,
	type TaskBoardSnapshotDto,
	type TaskMutationDraftInput,
	type TaskSafeDiffDto
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

export const TASKS_LIVE_OPERATIONS = Object.freeze({
	read: {
		name: 'task.board.read', version: 1, effect: 'read', method: 'GET', input: 'query',
		idempotencyRequired: false, ...TASK_OPERATION_SCHEMA_REFS.boardRead
	},
	draft: {
		name: 'task.mutation.draft', version: 1, effect: 'draft', method: 'POST', input: 'body',
		idempotencyRequired: true, ...TASK_OPERATION_SCHEMA_REFS.mutationDraft
	},
	correction: {
		name: 'changeset.correction.draft', version: 1, effect: 'draft', method: 'POST', input: 'body',
		idempotencyRequired: true, ...CHANGESET_OPERATION_SCHEMA_REFS.correction
	}
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

export type TaskLiveOperation = 'read' | 'draft' | 'correction' | 'propose' | 'commit';
type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: TaskLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};
type Failure =
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal?: boolean; readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type TaskLiveResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| Failure;

export interface CommittedTaskMutation {
	readonly safeDiff: TaskSafeDiffDto;
	readonly source: {
		readonly changesetId: ChangesetRevisionSelector['changesetId'];
		readonly revisionId: ChangesetRevisionSelector['revisionId'];
		readonly revisionDigest: ChangesetRevisionSelector['revisionDigest'];
		readonly commitReceiptId: string;
	};
}

export interface TaskLiveClient {
	readBoard(options?: { readonly signal?: AbortSignal }): Promise<TaskLiveResult<TaskBoardSnapshotDto>>;
	mutate(input: TaskMutationDraftInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<TaskLiveResult<CommittedTaskMutation>>;
	compensate(source: CommittedTaskMutation['source'], idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<TaskLiveResult<TaskSafeDiffDto>>;
}

interface RequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}
type Requester = (input: RequestInput) => Promise<ApiResult<unknown>>;
const invalidRequest = <Data>(): TaskLiveResult<Data> => ({
	kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
});
const invalidContract = <Data>(): TaskLiveResult<Data> => ({
	kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
});
const receiptMatches = (receipt: OperationReceiptRef | undefined, name: string) =>
	receipt?.operationName === name && receipt.operationVersion === 1;

async function workflowKeys(raw: string, stages: readonly string[]) {
	const key = operationHttpIdempotencyKeySchema.safeParse(raw);
	if (!key.success) return undefined;
	const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(key.data));
	const anchor = Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
	return Object.freeze(Object.fromEntries(stages.map((stage) => [stage, `je.task.${stage}.${anchor}`])));
}

function changesetFailure<Data>(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operation: 'propose' | 'commit'
): TaskLiveResult<Data> {
	if (result.kind === 'unavailable') return { kind: 'unavailable', operation, reason: result.reason };
	if (result.kind === 'transport_error') return result;
	return {
		kind: 'outcome', outcome: result.outcome,
		...(result.terminal === undefined ? {} : { terminal: result.terminal }),
		correlationId: result.correlationId,
		...(result.receipt === undefined ? {} : { receipt: result.receipt })
	};
}

export function createTasksLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: Requester;
}): TaskLiveClient {
	const request = input.request ?? ((value: RequestInput) => requestJson(value));
	const read = resolveOperatorHttpBinding({ manifest: input.manifest, expected: TASKS_LIVE_OPERATIONS.read });
	const draft = resolveOperatorHttpBinding({ manifest: input.manifest, expected: TASKS_LIVE_OPERATIONS.draft });
	const correction = resolveOperatorHttpBinding({ manifest: input.manifest, expected: TASKS_LIVE_OPERATIONS.correction });
	const changesets = createChangesetReviewLivePort({ manifest: input.manifest, request });

	async function commitDraft(input: {
		readonly selector: ChangesetRevisionSelector;
		readonly headVersion: number;
		readonly safeDiff: TaskSafeDiffDto;
		readonly keys: Readonly<Record<string, string>>;
		readonly signal?: AbortSignal;
	}): Promise<TaskLiveResult<CommittedTaskMutation>> {
		const proposed = await changesets.propose(
			{ ...input.selector, expectedHeadVersion: input.headVersion }, input.keys.propose!,
			input.signal ? { signal: input.signal } : {}
		);
		if (proposed.kind !== 'success') return changesetFailure(proposed, 'propose');
		const operations = proposed.data.groups.flatMap((group) => group.operations);
		const operation = operations[0];
		if (proposed.data.operationCount !== 1 || operations.length !== 1
			|| operation?.kind !== 'task.mutate' || operation.version !== 1
			|| operation.dependencyGroup !== 'task'
			|| !jsonEquivalent(operation.safeDiff, input.safeDiff)) return invalidContract();
		const committed = await changesets.commit(
			{ ...input.selector, expectedHeadVersion: proposed.data.headVersion }, input.keys.commit!,
			input.signal ? { signal: input.signal } : {}
		);
		if (committed.kind !== 'success') return changesetFailure(committed, 'commit');
		if (!committed.receipt || !receiptMatches(committed.receipt, 'changeset.commit')) return invalidContract();
		return {
			kind: 'success',
			data: {
				safeDiff: input.safeDiff,
				source: { ...input.selector, commitReceiptId: committed.receipt.id }
			},
			correlationId: committed.correlationId ?? '',
			receipt: committed.receipt
		};
	}

	return Object.freeze({
		async readBoard(options: { readonly signal?: AbortSignal } = {}): Promise<TaskLiveResult<TaskBoardSnapshotDto>> {
			if (read.kind === 'unavailable') return { kind: 'unavailable' as const, operation: 'read' as const, reason: read.reason };
			const response = await request({
				path: read.path, method: 'GET', schema: taskBoardReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = taskBoardReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? { kind: 'success' as const, data: parsed.data.data as TaskBoardSnapshotDto, correlationId: parsed.data.correlationId }
				: { kind: 'outcome' as const, outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},

		async mutate(
			raw: TaskMutationDraftInput,
			rawKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<TaskLiveResult<CommittedTaskMutation>> {
			const mutation = taskMutationDraftInputSchema.safeParse(raw);
			const keys = await workflowKeys(rawKey, ['draft', 'propose', 'commit']);
			if (!mutation.success || !keys) return invalidRequest();
			if (draft.kind === 'unavailable') return { kind: 'unavailable' as const, operation: 'draft' as const, reason: draft.reason };
			const response = await request({
				path: draft.path, method: 'POST', schema: taskDraftOperationResultSchema,
				body: mutation.data, idempotencyKey: keys.draft!,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = taskDraftOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return {
				kind: 'outcome' as const, outcome: parsed.data.outcome, terminal: parsed.data.terminal,
				correlationId: parsed.data.correlationId, ...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {})
			};
			const data = parsed.data.data;
			if (!receiptMatches(parsed.data.receipt, 'task.mutation.draft')
				|| data.action !== mutation.data.action || data.approvalPolicy.requirement !== 'none') {
				return invalidContract();
			}
			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: data.changesetId,
				revisionId: data.revision.id,
				revisionDigest: data.revision.digestSha256
			});
			return commitDraft({ selector, headVersion: data.headVersion, safeDiff: data.safeDiff, keys, ...options });
		},

		async compensate(
			source: CommittedTaskMutation['source'],
			rawKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<TaskLiveResult<TaskSafeDiffDto>> {
			const body = draftChangesetCorrectionInputSchema.safeParse({
				sourceChangesetId: source.changesetId,
				sourceRevisionId: source.revisionId,
				sourceRevisionDigest: source.revisionDigest,
				sourceCommitReceiptId: source.commitReceiptId
			});
			const keys = await workflowKeys(rawKey, ['correction', 'propose', 'commit']);
			if (!body.success || !keys) return invalidRequest();
			if (correction.kind === 'unavailable') return { kind: 'unavailable' as const, operation: 'correction' as const, reason: correction.reason };
			const response = await request({
				path: correction.path, method: 'POST', schema: draftedChangesetCorrectionOperationResultSchema,
				body: body.data, idempotencyKey: keys.correction!,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = draftedChangesetCorrectionOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return {
				kind: 'outcome' as const, outcome: parsed.data.outcome, terminal: parsed.data.terminal,
				correlationId: parsed.data.correlationId, ...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {})
			};
			const data = parsed.data.data;
			if (!receiptMatches(parsed.data.receipt, 'changeset.correction.draft')
				|| data.sourceChangesetId !== source.changesetId
				|| data.sourceRevisionId !== source.revisionId
				|| data.sourceRevisionDigest !== source.revisionDigest
				|| data.resultKind !== 'exact' || data.target === null
				|| data.target.operations.length !== 1) return invalidContract();
			const operation = data.target.operations[0];
			if (operation?.kind !== 'task.mutate' || operation.version !== 1
				|| operation.dependencyGroup !== 'task') return invalidContract();
			const safeDiff = operation.safeDiff as TaskSafeDiffDto;
			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: data.target.changesetId,
				revisionId: data.target.revisionId,
				revisionDigest: data.target.revisionDigest
			});
			const committed = await commitDraft({
				selector, headVersion: data.target.headVersion, safeDiff, keys, ...options
			});
			return committed.kind === 'success'
				? { kind: 'success' as const, data: safeDiff, correlationId: committed.correlationId, receipt: committed.receipt }
				: committed;
		}
	});
}
