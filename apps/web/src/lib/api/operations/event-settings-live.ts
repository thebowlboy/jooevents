import {
	EVENT_SETTINGS_OPERATION_SCHEMA_REFS,
	changesetRevisionSelectorSchema,
	currentEventSettingsReadResultSchema,
	eventSettingsSafeDiffSchema,
	eventSettingsUpdateDraftInputSchema,
	eventSettingsUpdateDraftOperationResultSchema,
	operationHttpIdempotencyKeySchema,
	type CurrentEventSettingsReadResult,
	type EventSettingsSafeDiff,
	type EventSettingsUpdateDraftInput,
	type EventSettingsUpdateDraftOperationResult,
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
import { mapEventSettings } from '../mappers/event-settings';
import type { EventSettingsView } from '../view-models/event-settings';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const EVENT_SETTINGS_CURRENT_READ_OPERATION = Object.freeze({
	name: 'event.settings.current.read', version: 1
} as const);

export const EVENT_SETTINGS_UPDATE_DRAFT_OPERATION = Object.freeze({
	name: 'event.settings.update.draft', version: 1
} as const);

const EVENT_SETTINGS_CHANGESET_OPERATION = Object.freeze({
	kind: 'event.settings.update',
	version: 1,
	dependencyGroup: 'event_settings'
} as const);

const EXPECTED_OPERATIONS = Object.freeze({
	read: {
		...EVENT_SETTINGS_CURRENT_READ_OPERATION,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...EVENT_SETTINGS_OPERATION_SCHEMA_REFS.currentRead
	},
	draft: {
		...EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...EVENT_SETTINGS_OPERATION_SCHEMA_REFS.updateDraft
	}
} as const satisfies Readonly<Record<'read' | 'draft', ExpectedOperatorHttpOperation>>);

export type EventSettingsLiveOperation = 'read' | 'draft' | 'propose' | 'commit';

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: EventSettingsLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type EventSettingsLiveReadResult =
	| {
			readonly kind: 'success';
			readonly data: EventSettingsView;
			readonly correlationId: string;
	  }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface EventSettingsCommittedUpdate {
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly committedHeadVersion: number;
	readonly settings: EventSettingsView;
	readonly safeDiff: EventSettingsSafeDiff;
}

export interface EventSettingsConfirmationRequired {
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly headVersion: number;
	readonly safeDiff: EventSettingsSafeDiff;
	readonly requirement: 'distinct_current_human';
}

export type EventSettingsLiveUpdateResult =
	| {
			readonly kind: 'success';
			readonly data: EventSettingsCommittedUpdate;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'confirmation_required';
			readonly data: EventSettingsConfirmationRequired;
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

export interface EventSettingsLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<EventSettingsLiveReadResult>;
	update(
		input: EventSettingsUpdateDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<EventSettingsLiveUpdateResult>;
}

export interface EventSettingsRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type EventSettingsRequester = (
	input: EventSettingsRequestInput
) => Promise<ApiResult<unknown>>;

type BindingKey = keyof typeof EXPECTED_OPERATIONS;
type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

function defaultRequester(input: EventSettingsRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function invalidRequest(): EventSettingsLiveUpdateResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): EventSettingsLiveUpdateResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function resolveBindings(manifest: unknown): Bindings {
	return Object.freeze(Object.fromEntries(
		Object.entries(EXPECTED_OPERATIONS).map(([key, expected]) => [
			key,
			resolveOperatorHttpBinding({ manifest, expected })
		])
	) as unknown as Bindings);
}

function receiptMatches(
	receipt: OperationReceiptRef | undefined,
	operation: { readonly name: string; readonly version: number }
): receipt is OperationReceiptRef {
	return receipt?.operationName === operation.name
		&& receipt.operationVersion === operation.version;
}

function unavailable(
	operation: EventSettingsLiveOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): Unavailable {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function firstUnavailable(input: readonly {
	readonly operation: EventSettingsLiveOperation;
	readonly binding: OperatorHttpBindingResolution;
}[]): Unavailable | undefined {
	for (const entry of input) {
		if (entry.binding.kind === 'unavailable') return unavailable(entry.operation, entry.binding);
	}
	return undefined;
}

async function workflowIdempotencyKeys(
	rawKey: string
): Promise<Readonly<{ draft: string; propose: string; commit: string }> | undefined> {
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
		draft: `je.event-settings.update.draft.${anchor}`,
		propose: `je.event-settings.update.propose.${anchor}`,
		commit: `je.event-settings.update.commit.${anchor}`
	});
}

function sameSettings(
	left: EventSettingsSafeDiff['before'],
	right: EventSettingsSafeDiff['before']
): boolean {
	return left.schemaVersion === right.schemaVersion
		&& left.eventId === right.eventId
		&& left.eventSetVersion === right.eventSetVersion
		&& left.eventVersion === right.eventVersion
		&& left.name === right.name
		&& left.timezone === right.timezone
		&& left.startDate === right.startDate
		&& left.endDate === right.endDate
		&& left.location === right.location
		&& left.venueNote === right.venueNote
		&& left.dayStart === right.dayStart
		&& left.dayEnd === right.dayEnd
		&& left.slotMinutes === right.slotMinutes;
}

function safeDiffMatchesRequest(
	diff: EventSettingsSafeDiff,
	request: EventSettingsUpdateDraftInput
): boolean {
	return diff.action === 'update'
		&& diff.selection.eventId === request.expectedEventId
		&& diff.selection.eventSetVersion === request.expectedEventSetVersion
		&& diff.before.eventId === request.expectedEventId
		&& diff.before.eventSetVersion === request.expectedEventSetVersion
		&& diff.before.eventVersion === request.expectedEventVersion
		&& diff.after.eventId === request.expectedEventId
		&& diff.after.eventSetVersion === request.expectedEventSetVersion
		&& diff.after.eventVersion === request.expectedEventVersion + 1
		&& diff.after.name === request.name
		&& diff.after.timezone === request.timezone
		&& diff.after.startDate === request.startDate
		&& diff.after.endDate === request.endDate
		&& diff.after.location === request.location
		&& diff.after.venueNote === request.venueNote
		&& diff.after.dayStart === request.dayStart
		&& diff.after.dayEnd === request.dayEnd
		&& diff.after.slotMinutes === request.slotMinutes;
}

function sameSafeDiff(left: EventSettingsSafeDiff, right: EventSettingsSafeDiff): boolean {
	return left.action === right.action
		&& sameSettings(left.before, right.before)
		&& sameSettings(left.after, right.after)
		&& left.selection.eventId === right.selection.eventId
		&& left.selection.eventSetVersion === right.selection.eventSetVersion;
}

function mapDraftOutcome(
	result: Extract<EventSettingsUpdateDraftOperationResult, { readonly kind: 'outcome' }>
): EventSettingsLiveUpdateResult {
	const receipt = 'receipt' in result ? result.receipt : undefined;
	if ((result.terminal && !receiptMatches(receipt, EVENT_SETTINGS_UPDATE_DRAFT_OPERATION))
		|| (!result.terminal && receipt !== undefined)) {
		return invalidContract();
	}
	return {
		kind: 'outcome',
		outcome: result.outcome,
		terminal: result.terminal,
		...(receipt ? { receipt } : {}),
		correlationId: result.correlationId
	};
}

function mapChangesetFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operationName: 'propose' | 'commit'
): EventSettingsLiveUpdateResult {
	if (result.kind === 'unavailable') {
		return { kind: 'unavailable', operation: operationName, reason: result.reason };
	}
	if (result.kind === 'transport_error') return result;
	const operation = CHANGESET_REVIEW_OPERATIONS[operationName];
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

/**
 * Pure-live Event Settings client. Every route and schema identity comes from
 * one safe manifest, and an interactive save confirms only the exact
 * low-ceremony draft it just prepared.
 */
export function createEventSettingsLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: EventSettingsRequester;
}): EventSettingsLiveClient {
	const bindings = resolveBindings(input.manifest);
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
		request: (requestInput) => request(requestInput)
	});

	return Object.freeze({
		async read(
			options: { readonly signal?: AbortSignal } = {}
		): Promise<EventSettingsLiveReadResult> {
			if (bindings.read.kind === 'unavailable') return unavailable('read', bindings.read);
			const transport = await request({
				path: bindings.read.path,
				method: 'GET',
				schema: currentEventSettingsReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = currentEventSettingsReadResultSchema.safeParse(transport.data);
			if (!parsed.success) {
				return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			}
			const result: CurrentEventSettingsReadResult = parsed.data;
			return result.kind === 'success'
				? {
						kind: 'success',
						data: mapEventSettings(result.data),
						correlationId: result.correlationId
					}
				: {
						kind: 'outcome',
						outcome: result.outcome,
						correlationId: result.correlationId
					};
		},

		async update(
			rawRequest: EventSettingsUpdateDraftInput,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<EventSettingsLiveUpdateResult> {
			const parsedRequest = eventSettingsUpdateDraftInputSchema.safeParse(rawRequest);
			if (!parsedRequest.success) return invalidRequest();
			const requestData = parsedRequest.data;
			const workflowUnavailable = firstUnavailable([
				{ operation: 'draft', binding: bindings.draft },
				{ operation: 'propose', binding: proposeBinding },
				{ operation: 'commit', binding: commitBinding }
			]);
			if (workflowUnavailable) return workflowUnavailable;
			const keys = await workflowIdempotencyKeys(idempotencyKey);
			if (!keys) return invalidRequest();
			options.signal?.throwIfAborted();

			if (bindings.draft.kind !== 'available') return invalidContract();
			const draftTransport = await request({
				path: bindings.draft.path,
				method: 'POST',
				schema: eventSettingsUpdateDraftOperationResultSchema,
				body: requestData,
				idempotencyKey: keys.draft,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (draftTransport.kind === 'error') {
				return { kind: 'transport_error', error: draftTransport.error };
			}
			const parsedDraft = eventSettingsUpdateDraftOperationResultSchema.safeParse(
				draftTransport.data
			);
			if (!parsedDraft.success) return invalidContract();
			const draft = parsedDraft.data;
			if (draft.kind === 'outcome') return mapDraftOutcome(draft);
			if (!receiptMatches(draft.receipt, EVENT_SETTINGS_UPDATE_DRAFT_OPERATION)
				|| !safeDiffMatchesRequest(draft.data.safeDiff, requestData)) {
				return invalidContract();
			}

			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: draft.data.changesetId,
				revisionId: draft.data.revision.id,
				revisionDigest: draft.data.revision.digestSha256
			});
			if (draft.data.approvalPolicy.requirement === 'distinct_current_human') {
				return {
					kind: 'confirmation_required',
					data: Object.freeze({
						...selector,
						headVersion: draft.data.headVersion,
						safeDiff: draft.data.safeDiff,
						requirement: 'distinct_current_human' as const
					}),
					receipt: draft.receipt,
					correlationId: draft.correlationId
				};
			}

			const proposed = await changesets.propose(
				{ ...selector, expectedHeadVersion: draft.data.headVersion },
				keys.propose,
				options.signal ? { signal: options.signal } : {}
			);
			if (proposed.kind !== 'success') return mapChangesetFailure(proposed, 'propose');
			if (!receiptMatches(proposed.receipt, CHANGESET_REVIEW_OPERATIONS.propose)
				|| proposed.correlationId === undefined) {
				return invalidContract();
			}
			const operations = proposed.data.groups.flatMap((group) => group.operations);
			const proposedOperation = operations[0];
			const proposedDiff = eventSettingsSafeDiffSchema.safeParse(proposedOperation?.safeDiff);
			if (proposed.data.operationCount !== 1
				|| operations.length !== 1
				|| proposedOperation?.kind !== EVENT_SETTINGS_CHANGESET_OPERATION.kind
				|| proposedOperation.version !== EVENT_SETTINGS_CHANGESET_OPERATION.version
				|| proposedOperation.dependencyGroup !== EVENT_SETTINGS_CHANGESET_OPERATION.dependencyGroup
				|| proposed.data.risk.value !== draft.data.riskTier
				|| proposed.data.approval.requirement !== draft.data.approvalPolicy.requirement
				|| !proposedDiff.success
				|| !sameSafeDiff(proposedDiff.data, draft.data.safeDiff)) {
				return invalidContract();
			}

			const committed = await changesets.commit(
				{ ...selector, expectedHeadVersion: proposed.data.headVersion },
				keys.commit,
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
					settings: mapEventSettings(draft.data.safeDiff.after),
					safeDiff: draft.data.safeDiff
				}),
				receipt: committed.receipt,
				correlationId: committed.correlationId
			};
		}
	});
}
