import {
	FIELD_REGISTRY_OPERATION_SCHEMA_REFS,
	fieldRegistryDirectOperationResultSchema,
	fieldRegistryDraftRequestSchema,
	fieldRegistrySnapshotReadResultSchema,
	operationHttpIdempotencyKeySchema,
	type FieldRegistryChangeResult,
	type FieldRegistryDraftAction,
	type FieldRegistryDraftRequest,
	type FieldRegistryFieldAuthor,
	type FieldRegistrySafeDiff,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { mapFieldRegistrySnapshot, type FieldRegistrySnapshotView } from '../mappers/field-registry';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const FIELD_REGISTRY_SNAPSHOT_READ_OPERATION = Object.freeze({ name: 'field_registry.snapshot.read', version: 1 } as const);
export const FIELD_REGISTRY_DIRECT_OPERATIONS = Object.freeze({
	add: Object.freeze({ name: 'field_registry.add', version: 1 } as const),
	edit: Object.freeze({ name: 'field_registry.edit', version: 1 } as const),
	move: Object.freeze({ name: 'field_registry.move', version: 1 } as const),
	remove: Object.freeze({ name: 'field_registry.remove', version: 1 } as const),
	restore: Object.freeze({ name: 'field_registry.restore', version: 1 } as const)
});

const expected = Object.freeze({
	snapshot: { ...FIELD_REGISTRY_SNAPSHOT_READ_OPERATION, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.snapshotRead },
	...Object.fromEntries(Object.entries(FIELD_REGISTRY_DIRECT_OPERATIONS).map(([action, operation]) => [
		action,
		{ ...operation, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.direct[action as FieldRegistryDraftAction] }
	]))
} as Readonly<Record<'snapshot' | FieldRegistryDraftAction, ExpectedOperatorHttpOperation>>);

export type FieldRegistryLiveOperation = 'snapshot' | FieldRegistryDraftAction;
type Unavailable = { readonly kind: 'unavailable'; readonly operation: FieldRegistryLiveOperation; readonly reason: OperatorHttpBindingUnavailableReason };
export type FieldRegistryLiveReadResult =
	| { readonly kind: 'success'; readonly data: FieldRegistrySnapshotView; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export interface FieldRegistryCommittedMutation {
	readonly action: FieldRegistryDraftAction;
	readonly mutation: FieldRegistryChangeResult;
	readonly safeDiff: FieldRegistrySafeDiff;
}
export type FieldRegistryLiveApplyResult =
	| { readonly kind: 'success'; readonly data: FieldRegistryCommittedMutation; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export interface FieldRegistryLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<FieldRegistryLiveReadResult>;
	apply(request: FieldRegistryDraftRequest, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<FieldRegistryLiveApplyResult>;
}
export interface FieldRegistryRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}
export type FieldRegistryRequester = (input: FieldRegistryRequestInput) => Promise<ApiResult<unknown>>;
type Bindings = Readonly<Record<'snapshot' | FieldRegistryDraftAction, OperatorHttpBindingResolution>>;

function invalidRequest(): FieldRegistryLiveApplyResult { return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } }; }
function invalidContract(): FieldRegistryLiveApplyResult { return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } }; }
function receiptMatches(receipt: OperationReceiptRef | undefined, operation: { readonly name: string; readonly version: number }): receipt is OperationReceiptRef {
	return receipt?.operationName === operation.name && receipt.operationVersion === operation.version;
}
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function authoredOptionsMatch(author: FieldRegistryFieldAuthor['options'], actual: Extract<FieldRegistrySafeDiff, { readonly action: 'add' }>['after']['options']): boolean {
	if (author.kind !== actual.kind) return false;
	if (author.kind === 'none' && actual.kind === 'none') return true;
	if (author.kind === 'program_vocabulary' && actual.kind === 'program_vocabulary') return author.source === actual.source;
	return author.kind === 'custom' && actual.kind === 'custom' && sameJson(author.labels, actual.choices.map((choice) => choice.label));
}
function safeDiffMatchesRequest(diff: FieldRegistrySafeDiff, request: FieldRegistryDraftRequest): boolean {
	if (diff.action !== request.action || diff.registryVersionBefore !== request.request.expectedRegistryVersion || diff.registryVersionAfter !== request.request.expectedRegistryVersion + 1) return false;
	if (request.action === 'add' && diff.action === 'add') {
		const author = request.request.field;
		return diff.after.version === 1 && diff.after.kind === author.kind && diff.after.label === author.label
			&& diff.after.help === (author.help ?? null) && diff.after.answerOwner === author.answerOwner
			&& sameJson(diff.after.scope, author.scope) && sameJson(diff.after.contexts, author.contexts)
			&& authoredOptionsMatch(author.options, diff.after.options) && diff.after.position === diff.placement.index && diff.after.group === diff.placement.group;
	}
	if (request.action === 'edit' && diff.action === 'edit') {
		const changes = request.request.changes;
		return diff.before.id === request.request.fieldId && diff.before.version === request.request.expectedFieldVersion
			&& diff.after.id === diff.before.id && diff.after.version === diff.before.version + 1
			&& (changes.label === undefined || diff.after.label === changes.label)
			&& (changes.help === undefined || diff.after.help === changes.help)
			&& (changes.contexts === undefined || sameJson(diff.after.contexts, changes.contexts))
			&& (changes.customOptionLabels === undefined || (diff.after.options.kind === 'custom' && sameJson(changes.customOptionLabels, diff.after.options.choices.map((choice) => choice.label))));
	}
	if (request.action === 'move' && diff.action === 'move') return diff.fieldId === request.request.fieldId && diff.fieldVersion === request.request.expectedFieldVersion && diff.afterIndex === request.request.toIndex;
	if (request.action === 'remove' && diff.action === 'remove') return diff.before.id === request.request.fieldId && diff.before.version === request.request.expectedFieldVersion;
	if (request.action === 'restore' && diff.action === 'restore') return diff.after.id === request.request.fieldId && diff.after.version === request.request.expectedFieldVersion + 1 && diff.after.position === request.request.toIndex && diff.placement.index === request.request.toIndex;
	return false;
}

export function createFieldRegistryLiveClient(input: { readonly manifest: unknown; readonly request?: FieldRegistryRequester }): FieldRegistryLiveClient {
	const bindings = Object.freeze(Object.fromEntries(Object.entries(expected).map(([key, operation]) => [key, resolveOperatorHttpBinding({ manifest: input.manifest, expected: operation })])) as unknown as Bindings);
	const request = input.request ?? ((requestInput: FieldRegistryRequestInput) => requestJson(requestInput));
	return Object.freeze({
		async read(options: { readonly signal?: AbortSignal } = {}): Promise<FieldRegistryLiveReadResult> {
			const binding = bindings.snapshot;
			if (binding.kind === 'unavailable') return { kind: 'unavailable', operation: 'snapshot', reason: binding.reason };
			const transport = await request({ path: binding.path, method: 'GET', schema: fieldRegistrySnapshotReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = fieldRegistrySnapshotReadResultSchema.safeParse(transport.data);
			if (!parsed.success) return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			return parsed.data.kind === 'success'
				? { kind: 'success', data: mapFieldRegistrySnapshot(parsed.data.data), correlationId: parsed.data.correlationId }
				: { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async apply(rawRequest: FieldRegistryDraftRequest, rawKey: string, options: { readonly signal?: AbortSignal } = {}): Promise<FieldRegistryLiveApplyResult> {
			const parsedRequest = fieldRegistryDraftRequestSchema.safeParse(rawRequest);
			const parsedKey = operationHttpIdempotencyKeySchema.safeParse(rawKey);
			if (!parsedRequest.success || !parsedKey.success) return invalidRequest();
			const action = parsedRequest.data.action;
			const binding = bindings[action];
			if (binding.kind === 'unavailable') return { kind: 'unavailable', operation: action, reason: binding.reason };
			const transport = await request({ path: binding.path, method: 'POST', schema: fieldRegistryDirectOperationResultSchema, body: parsedRequest.data.request, idempotencyKey: parsedKey.data, ...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = fieldRegistryDirectOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			const result = parsed.data;
			const operation = FIELD_REGISTRY_DIRECT_OPERATIONS[action];
			if (result.kind === 'outcome') {
				const receipt = 'receipt' in result ? result.receipt : undefined;
				if ((result.terminal && !receiptMatches(receipt, operation)) || (!result.terminal && receipt !== undefined)) return invalidContract();
				return { kind: 'outcome', outcome: result.outcome, terminal: result.terminal, ...(receipt ? { receipt } : {}), correlationId: result.correlationId };
			}
			if (!receiptMatches(result.receipt, operation) || result.data.action !== action
				|| result.data.mutation.action !== action || !safeDiffMatchesRequest(result.data.safeDiff, parsedRequest.data)) return invalidContract();
			return { kind: 'success', data: result.data, receipt: result.receipt, correlationId: result.correlationId };
		}
	});
}
