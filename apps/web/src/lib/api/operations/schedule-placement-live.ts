import {
	changesetRevisionSelectorSchema,
	operationHttpIdempotencyKeySchema,
	type OperationReceiptRef
} from '@jooevents/contracts';
import {
	SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS,
	schedulePlacementDraftOperationResultSchema,
	schedulePlacementInputSchema,
	schedulePlacementPlanSchema,
	schedulePlacementReadInputSchema,
	schedulePlacementReadResultSchema,
	type SchedulePlacementDraftData,
	type SchedulePlacementInput,
	type SchedulePlacementSnapshotDto
} from '@jooevents/contracts/schedule-placement';
import type { z } from 'zod';
import {
	CHANGESET_REVIEW_OPERATIONS,
	createChangesetReviewLivePort
} from '../changesets/live';
import type {
	ChangesetDiffView,
	ChangesetReviewResult
} from '../changesets/port';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	mapSchedulePlacementCommit,
	mapSchedulePlacementSnapshot
} from '../mappers/schedule-placement';
import type {
	SchedulePlacementApplyResult,
	SchedulePlacementCoreOperation,
	SchedulePlacementCorePort,
	SchedulePlacementReadResult
} from '../schedule-placement-port';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const SCHEDULE_PLACEMENT_LIVE_OPERATIONS = Object.freeze({
	snapshot: Object.freeze({
		name: 'schedule.placement.snapshot.read',
		version: 1,
		effect: 'read',
		method: 'GET',
		input: 'query',
		idempotencyRequired: false,
		path: '/api/events/current/schedule/placements'
	} as const),
	draft: Object.freeze({
		name: 'schedule.placement.draft',
		version: 1,
		effect: 'draft',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/schedule/placements/drafts'
	} as const)
});

type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };

const EXPECTED_OPERATIONS = Object.freeze({
	snapshot: Object.freeze({
		...SCHEDULE_PLACEMENT_LIVE_OPERATIONS.snapshot,
		...SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead
	}),
	draft: Object.freeze({
		...SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft,
		...SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placementDraft
	})
} satisfies Readonly<Record<'snapshot' | 'draft', ExactExpectedOperation>>);

const EXPECTED_CHANGESET_LIFECYCLE_OPERATIONS = Object.freeze({
	propose: Object.freeze({
		...CHANGESET_REVIEW_OPERATIONS.propose,
		path: '/api/changesets/proposals'
	}),
	commit: Object.freeze({
		...CHANGESET_REVIEW_OPERATIONS.commit,
		path: '/api/changesets/commits'
	})
} satisfies Readonly<Record<'propose' | 'commit', ExactExpectedOperation>>);

export interface SchedulePlacementRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type SchedulePlacementRequester = (
	input: SchedulePlacementRequestInput
) => Promise<ApiResult<unknown>>;

function defaultRequester(input: SchedulePlacementRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function resolveExactBinding(
	manifest: unknown,
	expected: ExactExpectedOperation
): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	if (binding.kind === 'available' && binding.path !== expected.path) {
		return { kind: 'unavailable', reason: 'operation_contract_mismatch' };
	}
	return binding;
}

function unavailable(
	operation: SchedulePlacementCoreOperation,
	reason: OperatorHttpBindingUnavailableReason
) {
	return { kind: 'unavailable' as const, operation, reason };
}

function invalidRequest(): SchedulePlacementApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): SchedulePlacementApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function invalidReadContract(): SchedulePlacementReadResult {
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

function draftMatchesRequest(
	draft: SchedulePlacementDraftData,
	request: SchedulePlacementInput
): boolean {
	const plan = draft.safeDiff;
	if (draft.action !== request.action || plan.input.action !== request.action) return false;
	if (plan.input.expectedScheduleVersion !== request.expectedScheduleVersion
		|| plan.input.roomId !== request.roomId
		|| plan.input.startAt !== request.startAt
		|| plan.input.endAt !== request.endAt
		|| plan.scheduleVersion.before !== request.expectedScheduleVersion
		|| plan.scheduleVersion.after !== request.expectedScheduleVersion + 1
		|| plan.roomQueryGuard.version !== request.expectedScheduleVersion
		|| plan.after === null
		|| plan.after.id !== plan.input.occurrenceId
		|| plan.after.roomId !== request.roomId
		|| plan.after.startAt !== request.startAt
		|| plan.after.endAt !== request.endAt
		|| plan.roomQueryGuard.id !== `schedule_room_query:${plan.input.scope.eventId}:${request.roomId}`) {
		return false;
	}
	if (request.action === 'place') {
		return plan.input.action === 'place'
			&& plan.input.sessionId === request.sessionId
			&& plan.before === null
			&& plan.after.sessionId === request.sessionId
			&& plan.after.version === 1;
	}
	return plan.input.action === 'move'
		&& plan.input.occurrenceId === request.occurrenceId
		&& plan.input.expectedOccurrenceVersion === request.expectedOccurrenceVersion
		&& plan.before !== null
		&& plan.before.id === request.occurrenceId
		&& plan.before.version === request.expectedOccurrenceVersion
		&& plan.after.id === request.occurrenceId
		&& plan.after.sessionId === plan.before.sessionId
		&& plan.after.version === request.expectedOccurrenceVersion + 1;
}

function proposedDiffMatchesDraft(
	proposed: ChangesetDiffView,
	draft: SchedulePlacementDraftData
): boolean {
	if (proposed.selector.changesetId !== draft.changesetId
		|| proposed.selector.revisionId !== draft.revision.id
		|| proposed.selector.revisionDigest !== draft.revision.digestSha256
		|| proposed.headVersion !== draft.headVersion + 1
		|| proposed.status.value !== 'proposed'
		|| proposed.revisionNumber !== draft.revision.number
		|| proposed.risk.value !== 'normal'
		|| proposed.approval.requirement !== 'none'
		|| proposed.operationCount !== 1
		|| proposed.groups.length !== 1) {
		return false;
	}
	const group = proposed.groups[0];
	const operation = group?.operations[0];
	if (!group
		|| group.key !== 'schedule_placement'
		|| group.operations.length !== 1
		|| group.risk.value !== 'normal'
		|| !operation
		|| operation.kind !== 'schedule.placement.mutate'
		|| operation.version !== 1
		|| operation.risk.value !== 'normal'
		|| operation.dependencyGroup !== 'schedule_placement'
		|| operation.consequences.length !== 1
		|| operation.consequences[0] !== 'schedule_occurrence_changed') {
		return false;
	}
	const parsed = schedulePlacementPlanSchema.safeParse(operation.safeDiff);
	return parsed.success && sameJson(parsed.data, draft.safeDiff);
}

function snapshotMatchesRange(
	snapshot: SchedulePlacementSnapshotDto,
	range: z.output<typeof schedulePlacementReadInputSchema>
): boolean {
	return snapshot.occurrences.length <= range.limit
		&& snapshot.occurrences.every((occurrence) =>
			occurrence.startAt < range.endAt && range.startAt < occurrence.endAt
		);
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
		draft: `je.schedule.placement.draft.${anchor}`,
		propose: `je.schedule.placement.propose.${anchor}`,
		commit: `je.schedule.placement.commit.${anchor}`
	});
}

function mapChangesetFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operation: 'propose' | 'commit'
): SchedulePlacementApplyResult {
	if (result.kind === 'unavailable') return unavailable(operation, result.reason);
	if (result.kind === 'transport_error') return result;
	const expected = CHANGESET_REVIEW_OPERATIONS[operation];
	if (typeof result.terminal !== 'boolean'
		|| (result.terminal && !receiptMatches(result.receipt, expected))
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
 * Pure-live placement client. It invokes only exact manifest-pinned operations and
 * applies a reviewed placement through draft -> generic propose -> generic commit.
 */
export function createSchedulePlacementLivePort(input: {
	readonly manifest: unknown;
	readonly request?: SchedulePlacementRequester;
}): SchedulePlacementCorePort {
	const snapshotBinding = resolveExactBinding(input.manifest, EXPECTED_OPERATIONS.snapshot);
	const draftBinding = resolveExactBinding(input.manifest, EXPECTED_OPERATIONS.draft);
	const proposeBinding = resolveExactBinding(
		input.manifest,
		EXPECTED_CHANGESET_LIFECYCLE_OPERATIONS.propose
	);
	const commitBinding = resolveExactBinding(
		input.manifest,
		EXPECTED_CHANGESET_LIFECYCLE_OPERATIONS.commit
	);
	const request = input.request ?? defaultRequester;
	const changesets = createChangesetReviewLivePort({
		manifest: input.manifest,
		request: (requestInput) => request(requestInput)
	});

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		async readPlacements(rawRange, options = {}) {
			const range = schedulePlacementReadInputSchema.safeParse(rawRange);
			if (!range.success) {
				return { kind: 'transport_error', error: {
					code: 'invalid_request', retryable: false
				} satisfies SafeApiError };
			}
			if (snapshotBinding.kind === 'unavailable') {
				return unavailable('snapshot', snapshotBinding.reason);
			}
			const query = new URLSearchParams({
				startAt: range.data.startAt,
				endAt: range.data.endAt,
				limit: String(range.data.limit)
			});
			const response = await request({
				path: `${snapshotBinding.path}?${query.toString()}`,
				method: 'GET',
				schema: schedulePlacementReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = schedulePlacementReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidReadContract();
			if (parsed.data.kind === 'outcome') return parsed.data;
			if (!snapshotMatchesRange(parsed.data.data, range.data)) return invalidReadContract();
			try {
				return {
					kind: 'success',
					data: mapSchedulePlacementSnapshot(parsed.data.data),
					correlationId: parsed.data.correlationId
				};
			} catch {
				return invalidReadContract();
			}
		},

		async placeOrMove(rawRequest, rawIdempotencyKey, options = {}) {
			const parsedRequest = schedulePlacementInputSchema.safeParse(rawRequest);
			const keys = await workflowIdempotencyKeys(rawIdempotencyKey);
			if (!parsedRequest.success || !keys) return invalidRequest();
			if (draftBinding.kind === 'unavailable') {
				return unavailable('draft', draftBinding.reason);
			}
			if (proposeBinding.kind === 'unavailable') {
				return unavailable('propose', proposeBinding.reason);
			}
			if (commitBinding.kind === 'unavailable') {
				return unavailable('commit', commitBinding.reason);
			}

			const draftedResponse = await request({
				path: draftBinding.path,
				method: 'POST',
				schema: schedulePlacementDraftOperationResultSchema,
				body: parsedRequest.data,
				idempotencyKey: keys.draft,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (draftedResponse.kind === 'error') {
				return { kind: 'transport_error', error: draftedResponse.error };
			}
			const drafted = schedulePlacementDraftOperationResultSchema.safeParse(draftedResponse.data);
			if (!drafted.success) return invalidContract();
			if (drafted.data.kind === 'outcome') {
				if (drafted.data.terminal
					&& !receiptMatches(drafted.data.receipt, SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft)) {
					return invalidContract();
				}
				return drafted.data;
			}
			if (!receiptMatches(drafted.data.receipt, SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft)
				|| !draftMatchesRequest(drafted.data.data, parsedRequest.data)) {
				return invalidContract();
			}

			const parsedSelector = changesetRevisionSelectorSchema.safeParse({
				changesetId: drafted.data.data.changesetId,
				revisionId: drafted.data.data.revision.id,
				revisionDigest: drafted.data.data.revision.digestSha256
			});
			if (!parsedSelector.success) return invalidContract();
			const selector = Object.freeze(parsedSelector.data);
			const proposed = await changesets.propose({
				...selector,
				expectedHeadVersion: drafted.data.data.headVersion
			}, keys.propose, options);
			if (proposed.kind !== 'success') return mapChangesetFailure(proposed, 'propose');
			if (!receiptMatches(proposed.receipt, CHANGESET_REVIEW_OPERATIONS.propose)
				|| !proposedDiffMatchesDraft(proposed.data, drafted.data.data)) {
				return invalidContract();
			}

			const committed = await changesets.commit({
				...selector,
				expectedHeadVersion: proposed.data.headVersion
			}, keys.commit, options);
			if (committed.kind !== 'success') return mapChangesetFailure(committed, 'commit');
			if (!receiptMatches(committed.receipt, CHANGESET_REVIEW_OPERATIONS.commit)) {
				return invalidContract();
			}
			try {
				return {
					kind: 'success',
					data: mapSchedulePlacementCommit({
						draft: drafted.data.data,
						proposedHeadVersion: proposed.data.headVersion,
						committedHeadVersion: committed.data.committedHeadVersion
					}),
					receipt: committed.receipt,
					correlationId: committed.correlationId ?? drafted.data.correlationId
				};
			} catch {
				return invalidContract();
			}
		}
	} satisfies SchedulePlacementCorePort);
}
