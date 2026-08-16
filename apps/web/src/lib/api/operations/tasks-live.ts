import {
	TASK_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	taskBoardReadResultSchema,
	taskMutationInputSchema,
	taskMutationOperationResultSchema,
	type OperationReceiptRef,
	type StructuredOutcome,
	type TaskBoardSnapshotDto,
	type TaskMutationData,
	type TaskMutationInput
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
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
	mutation: {
		name: 'task.mutation', version: 1, effect: 'commit', method: 'POST', input: 'body',
		idempotencyRequired: true, ...TASK_OPERATION_SCHEMA_REFS.mutation
	}
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

export type TaskLiveOperation = 'read' | 'mutation';
type Unavailable = { readonly kind: 'unavailable'; readonly operation: TaskLiveOperation; readonly reason: OperatorHttpBindingUnavailableReason };
type Failure =
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal?: boolean; readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type TaskLiveResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string; readonly receipt?: OperationReceiptRef }
	| Failure;
export type CommittedTaskMutation = TaskMutationData;

export interface TaskLiveClient {
	readBoard(options?: { readonly signal?: AbortSignal }): Promise<TaskLiveResult<TaskBoardSnapshotDto>>;
	mutate(input: TaskMutationInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<TaskLiveResult<CommittedTaskMutation>>;
}

interface RequestInput {
	readonly path: string; readonly schema: z.ZodType; readonly method: 'GET' | 'POST';
	readonly body?: unknown; readonly idempotencyKey?: string; readonly signal?: AbortSignal;
}
type Requester = (input: RequestInput) => Promise<ApiResult<unknown>>;
const invalidRequest = <Data>(): TaskLiveResult<Data> => ({ kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
const invalidContract = <Data>(): TaskLiveResult<Data> => ({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });

export function createTasksLiveClient(input: { readonly manifest: unknown; readonly request?: Requester }): TaskLiveClient {
	const request = input.request ?? ((value: RequestInput) => requestJson(value));
	const read = resolveOperatorHttpBinding({ manifest: input.manifest, expected: TASKS_LIVE_OPERATIONS.read });
	const mutation = resolveOperatorHttpBinding({ manifest: input.manifest, expected: TASKS_LIVE_OPERATIONS.mutation });
	return Object.freeze({
		async readBoard(options: { readonly signal?: AbortSignal } = {}): Promise<TaskLiveResult<TaskBoardSnapshotDto>> {
			if (read.kind === 'unavailable') return { kind: 'unavailable' as const, operation: 'read' as const, reason: read.reason };
			const response = await request({ path: read.path, method: 'GET', schema: taskBoardReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = taskBoardReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract<TaskBoardSnapshotDto>();
			return parsed.data.kind === 'success'
				? { kind: 'success' as const, data: parsed.data.data as TaskBoardSnapshotDto, correlationId: parsed.data.correlationId }
				: { kind: 'outcome' as const, outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async mutate(raw: TaskMutationInput, key: string, options: { readonly signal?: AbortSignal } = {}): Promise<TaskLiveResult<CommittedTaskMutation>> {
			const body = taskMutationInputSchema.safeParse(raw);
			if (!body.success || !operationHttpIdempotencyKeySchema.safeParse(key).success) return invalidRequest<CommittedTaskMutation>();
			if (mutation.kind === 'unavailable') return { kind: 'unavailable' as const, operation: 'mutation' as const, reason: mutation.reason };
			const response = await request({ path: mutation.path, method: 'POST', schema: taskMutationOperationResultSchema, body: body.data, idempotencyKey: key, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = taskMutationOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract<CommittedTaskMutation>();
			if (parsed.data.kind === 'outcome') return { kind: 'outcome' as const, outcome: parsed.data.outcome, terminal: parsed.data.terminal, correlationId: parsed.data.correlationId, ...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {}) };
			if (parsed.data.receipt.operationName !== 'task.mutation' || parsed.data.receipt.operationVersion !== 1
				|| parsed.data.data.action !== body.data.action) return invalidContract<CommittedTaskMutation>();
			return { kind: 'success' as const, data: parsed.data.data, correlationId: parsed.data.correlationId, receipt: parsed.data.receipt };
		}
	});
}
