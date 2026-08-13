import {
	EVENT_OPERATION_SCHEMA_REFS,
	changesetRevisionSelectorSchema,
	currentEventReadResultSchema,
	eventCreateDraftInputSchema,
	eventCreateDraftOperationResultSchema,
	eventCreateInputSchema,
	eventCreateSafeDiffSchema,
	operationHttpIdempotencyKeySchema,
	type CurrentEventReadResult,
	type EventCreateDraftOperationResult,
	type EventCreateInput,
	type EventCreateSafeDiff,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	CHANGESET_REVIEW_OPERATIONS,
	createChangesetReviewLivePort,
	type ChangesetReviewRequestInput,
	type ChangesetReviewRequester
} from '../changesets/live';
import type { ChangesetReviewResult } from '../changesets/port';
import { mapCurrentEvent, mapEvent } from '../mappers/event';
import type { CurrentEventView, EventView } from '../view-models/event';
import {
	resolveOperatorHttpBinding,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const EVENT_CURRENT_READ_OPERATION = Object.freeze({
	name: 'event.current.read',
	version: 1
} as const);

export const EVENT_CREATE_DRAFT_OPERATION = Object.freeze({
	name: 'event.create.draft',
	version: 1
} as const);

const EVENT_CREATION_CHANGESET_OPERATION = Object.freeze({
	kind: 'event.creation',
	version: 1,
	dependencyGroup: 'event_creation'
} as const);

export type EventLiveUnavailableReason = OperatorHttpBindingUnavailableReason;

export type EventLiveReadResult =
	| { readonly kind: 'success'; readonly data: CurrentEventView; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: EventLiveUnavailableReason };

export type EventLiveCreateResult =
	| {
			readonly kind: 'success';
			readonly data: { readonly eventSetVersion: number; readonly event: EventView };
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
	| { readonly kind: 'unavailable'; readonly reason: EventLiveUnavailableReason };

export interface EventLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<EventLiveReadResult>;
	create(
		input: EventCreateInput,
		options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
	): Promise<EventLiveCreateResult>;
}

interface EventReadRequestInput {
	readonly path: string;
	readonly schema: typeof currentEventReadResultSchema;
	readonly method: 'GET';
	readonly signal?: AbortSignal;
}

interface EventCreateDraftRequestInput {
	readonly path: string;
	readonly schema: typeof eventCreateDraftOperationResultSchema;
	readonly method: 'POST';
	readonly body: ReturnType<typeof eventCreateDraftInputSchema.parse>;
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface EventLiveRequester {
	read(input: EventReadRequestInput): Promise<ApiResult<CurrentEventReadResult>>;
	draft(input: EventCreateDraftRequestInput): Promise<ApiResult<EventCreateDraftOperationResult>>;
	readonly changeset: ChangesetReviewRequester;
}

const defaultRequester: EventLiveRequester = Object.freeze({
	read: (requestInput: EventReadRequestInput) =>
		requestJson<CurrentEventReadResult>(requestInput),
	draft: (requestInput: EventCreateDraftRequestInput) =>
		requestJson<EventCreateDraftOperationResult>(requestInput),
	changeset: (requestInput: ChangesetReviewRequestInput) => requestJson(requestInput)
});

function invalidRequest(): EventLiveCreateResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): EventLiveCreateResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function unavailableReason(
	bindings: readonly OperatorHttpBindingResolution[]
): EventLiveUnavailableReason | undefined {
	return bindings.find(
		(binding): binding is Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }> =>
			binding.kind === 'unavailable'
	)?.reason;
}

function receiptMatches(
	receipt: OperationReceiptRef | undefined,
	operation: { readonly name: string; readonly version: number }
): receipt is OperationReceiptRef {
	return receipt?.operationName === operation.name
		&& receipt.operationVersion === operation.version;
}

function normalizedEventName(value: string): string {
	return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function canonicalTimezone(value: string): string {
	return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
}

function safeDiffMatchesRequest(diff: EventCreateSafeDiff, input: EventCreateInput): boolean {
	const after = diff.after;
	return diff.currentSelection.before === null
		&& diff.currentSelection.after === after.id
		&& diff.eventSetVersion.before === input.expectedEventSetVersion
		&& diff.eventSetVersion.after === input.expectedEventSetVersion + 1
		&& after.version === 1
		&& after.name === normalizedEventName(input.name)
		&& after.timezone === canonicalTimezone(input.timezone)
		&& after.startDate === input.startDate
		&& after.endDate === input.endDate;
}

function sameSafeDiff(left: EventCreateSafeDiff, right: EventCreateSafeDiff): boolean {
	return left.action === right.action
		&& left.before === right.before
		&& left.after.id === right.after.id
		&& left.after.name === right.after.name
		&& left.after.timezone === right.after.timezone
		&& left.after.startDate === right.after.startDate
		&& left.after.endDate === right.after.endDate
		&& left.after.version === right.after.version
		&& left.currentSelection.before === right.currentSelection.before
		&& left.currentSelection.after === right.currentSelection.after
		&& left.eventSetVersion.before === right.eventSetVersion.before
		&& left.eventSetVersion.after === right.eventSetVersion.after;
}

async function workflowIdempotencyKeys(rawKey: string): Promise<Readonly<{
	draft: string;
	propose: string;
	commit: string;
}> | undefined> {
	const parsed = operationHttpIdempotencyKeySchema.safeParse(rawKey);
	if (!parsed.success) return undefined;
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(parsed.data)
	);
	const anchor = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return Object.freeze({
		draft: `je.event-create.draft.${anchor}`,
		propose: `je.event-create.propose.${anchor}`,
		commit: `je.event-create.commit.${anchor}`
	});
}

function mapChangesetFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operation: { readonly name: string; readonly version: number }
): EventLiveCreateResult {
	if (result.kind === 'unavailable') return { kind: 'unavailable', reason: result.reason };
	if (result.kind === 'transport_error') return result;
	if (typeof result.terminal !== 'boolean'
		|| (result.terminal && !receiptMatches(result.receipt, operation))
		|| (!result.terminal && result.receipt !== undefined)) {
		return invalidContract();
	}
	return {
		kind: 'outcome',
		outcome: result.outcome,
		terminal: result.terminal,
		...(result.receipt ? { receipt: result.receipt } : {}),
		correlationId: result.correlationId
	};
}

export function createEventLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: EventLiveRequester;
}): EventLiveClient {
	const readBinding = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: {
			...EVENT_CURRENT_READ_OPERATION,
			effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
			...EVENT_OPERATION_SCHEMA_REFS.currentRead
		}
	});
	const createDraftBinding = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: {
			...EVENT_CREATE_DRAFT_OPERATION,
			effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
			...EVENT_OPERATION_SCHEMA_REFS.createDraft
		}
	});
	const proposeBinding = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: CHANGESET_REVIEW_OPERATIONS.propose
	});
	const commitBinding = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: CHANGESET_REVIEW_OPERATIONS.commit
	});
	const request = input.request ?? defaultRequester;
	const changesets = createChangesetReviewLivePort({
		manifest: input.manifest,
		request: request.changeset
	});

	return Object.freeze({
		async read(
			options: { readonly signal?: AbortSignal } = {}
		): Promise<EventLiveReadResult> {
			if (readBinding.kind === 'unavailable') return readBinding;
			const transport = await request.read({
				path: readBinding.path,
				method: 'GET',
				schema: currentEventReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') {
				return { kind: 'transport_error', error: transport.error };
			}
			const parsed = currentEventReadResultSchema.safeParse(transport.data);
			if (!parsed.success) {
				return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			}
			const result = parsed.data;
			return result.kind === 'success'
				? {
						kind: 'success' as const,
						data: mapCurrentEvent(result.data),
						correlationId: result.correlationId
					}
				: {
						kind: 'outcome' as const,
						outcome: result.outcome,
						correlationId: result.correlationId
					};
		},

		async create(
			businessInput: EventCreateInput,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventLiveCreateResult> {
			const mutationUnavailable = unavailableReason([
				createDraftBinding,
				proposeBinding,
				commitBinding
			]);
			if (mutationUnavailable) return { kind: 'unavailable', reason: mutationUnavailable };

			const parsedInput = eventCreateInputSchema.safeParse(businessInput);
			if (!parsedInput.success) return invalidRequest();
			const keys = await workflowIdempotencyKeys(options.idempotencyKey);
			if (!keys) return invalidRequest();
			options.signal?.throwIfAborted();

			if (createDraftBinding.kind !== 'available') return invalidContract();
			const draftTransport = await request.draft({
				path: createDraftBinding.path,
				method: 'POST',
				schema: eventCreateDraftOperationResultSchema,
				body: eventCreateDraftInputSchema.parse({
					name: parsedInput.data.name,
					timezone: parsedInput.data.timezone,
					startDate: parsedInput.data.startDate,
					endDate: parsedInput.data.endDate
				}),
				idempotencyKey: keys.draft,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (draftTransport.kind === 'error') {
				return { kind: 'transport_error', error: draftTransport.error };
			}
			const parsedDraft = eventCreateDraftOperationResultSchema.safeParse(draftTransport.data);
			if (!parsedDraft.success) return invalidContract();
			const draft = parsedDraft.data;
			if (draft.kind === 'outcome') {
				if ((draft.terminal && !receiptMatches(draft.receipt, EVENT_CREATE_DRAFT_OPERATION))
					|| (!draft.terminal && 'receipt' in draft)) {
					return invalidContract();
				}
				return {
					kind: 'outcome',
					outcome: draft.outcome,
					terminal: draft.terminal,
					...('receipt' in draft ? { receipt: draft.receipt } : {}),
					correlationId: draft.correlationId
				};
			}
			if (!receiptMatches(draft.receipt, EVENT_CREATE_DRAFT_OPERATION)
				|| !safeDiffMatchesRequest(draft.data.safeDiff, parsedInput.data)) {
				return invalidContract();
			}

			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: draft.data.changesetId,
				revisionId: draft.data.revision.id,
				revisionDigest: draft.data.revision.digestSha256
			});
			const proposed = await changesets.propose(
				{ ...selector, expectedHeadVersion: draft.data.headVersion },
				keys.propose,
				options.signal ? { signal: options.signal } : {}
			);
			if (proposed.kind !== 'success') {
				return mapChangesetFailure(proposed, CHANGESET_REVIEW_OPERATIONS.propose);
			}
			if (!receiptMatches(proposed.receipt, CHANGESET_REVIEW_OPERATIONS.propose)
				|| proposed.correlationId === undefined) {
				return invalidContract();
			}
			const proposedOperations = proposed.data.groups.flatMap((group) => group.operations);
			const proposedSafeDiff = proposedOperations.length === 1
				? eventCreateSafeDiffSchema.safeParse(proposedOperations[0]?.safeDiff)
				: undefined;
			const proposedOperation = proposedOperations[0];
			if (proposed.data.operationCount !== 1
				|| proposedOperation?.kind !== EVENT_CREATION_CHANGESET_OPERATION.kind
				|| proposedOperation.version !== EVENT_CREATION_CHANGESET_OPERATION.version
				|| proposedOperation.dependencyGroup !== EVENT_CREATION_CHANGESET_OPERATION.dependencyGroup
				|| !proposedSafeDiff?.success
				|| !sameSafeDiff(draft.data.safeDiff, proposedSafeDiff.data)) {
				return invalidContract();
			}

			const committed = await changesets.commit(
				{ ...selector, expectedHeadVersion: proposed.data.headVersion },
				keys.commit,
				options.signal ? { signal: options.signal } : {}
			);
			if (committed.kind !== 'success') {
				return mapChangesetFailure(committed, CHANGESET_REVIEW_OPERATIONS.commit);
			}
			if (!receiptMatches(committed.receipt, CHANGESET_REVIEW_OPERATIONS.commit)
				|| committed.correlationId === undefined) {
				return invalidContract();
			}
			return {
				kind: 'success',
				data: Object.freeze({
					eventSetVersion: draft.data.safeDiff.eventSetVersion.after,
					event: mapEvent(draft.data.safeDiff.after)
				}),
				receipt: committed.receipt,
				correlationId: committed.correlationId
			};
		}
	});
}
