import {
	CHANGESET_OPERATION_SCHEMA_REFS,
	changesetLifecycleOperationResultSchema,
	changesetRevisionSelectorSchema,
	draftChangesetCorrectionInputSchema,
	operationHttpIdempotencyKeySchema,
	operationReceiptRefSchema,
	type ChangesetRevisionSelector,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import {
	SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS,
	submissionTriageDraftOperationResultSchema,
	submissionTriageListInputSchema,
	submissionTriageListOperationResultSchema,
	submissionTriageReadInputSchema,
	submissionTriageReadOperationResultSchema,
	submissionTriageSafeDiffSchema,
	submissionTriageTransitionDraftInputSchema,
	type SubmissionTriageAction,
	type SubmissionTriageSafeDiff,
	type SubmissionTriageTransitionDraftInput
} from '@jooevents/contracts/submission-triage';
import type { z } from 'zod';
import {
	CHANGESET_REVIEW_OPERATIONS,
	createChangesetReviewLivePort
} from '../changesets/live';
import type { ChangesetReviewResult } from '../changesets/port';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	mapSubmissionTriageList,
	mapSubmissionTriageRead,
	type SubmissionTriagePageView,
	type SubmissionTriageRowView
} from '../mappers/submission-triage';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const SUBMISSION_TRIAGE_OPERATIONS = Object.freeze({
	list: Object.freeze({ name: 'submission.triage.list', version: 1 } as const),
	read: Object.freeze({ name: 'submission.triage.read', version: 1 } as const),
	draft: Object.freeze({ name: 'submission.triage.transition.draft', version: 1 } as const),
	correction: Object.freeze({ name: 'changeset.correction.draft', version: 1 } as const)
});

const SUBMISSION_TRIAGE_CHANGESET_OPERATION = Object.freeze({
	kind: 'submission.triage.transition',
	version: 1,
	dependencyGroup: 'submission_triage'
} as const);

const EXPECTED_OPERATIONS = Object.freeze({
	list: {
		...SUBMISSION_TRIAGE_OPERATIONS.list,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.list
	},
	read: {
		...SUBMISSION_TRIAGE_OPERATIONS.read,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.read
	},
	draft: {
		...SUBMISSION_TRIAGE_OPERATIONS.draft,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.draft
	},
	correction: {
		...SUBMISSION_TRIAGE_OPERATIONS.correction,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...CHANGESET_OPERATION_SCHEMA_REFS.correction
	}
} as const satisfies Readonly<Record<string, ExpectedOperatorHttpOperation>>);

type BindingKey = keyof typeof EXPECTED_OPERATIONS;
type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

export type SubmissionTriageLiveOperation =
	| BindingKey
	| 'propose'
	| 'commit';

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: SubmissionTriageLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type SubmissionTriageLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface SubmissionTriageCommittedMutation {
	readonly action: SubmissionTriageAction | 'restore_exact';
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly committedHeadVersion: number;
	readonly safeDiff: SubmissionTriageSafeDiff;
}

export interface SubmissionTriageCompensationSource {
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly sourceCommitReceiptId: string;
	readonly safeDiff: SubmissionTriageSafeDiff;
}

export interface SubmissionTriageConfirmationRequired {
	readonly action: SubmissionTriageAction | 'restore_exact';
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly headVersion: number;
	readonly safeDiff: SubmissionTriageSafeDiff;
	readonly requirement: 'distinct_current_human';
}

export type SubmissionTriageLiveApplyResult =
	| {
			readonly kind: 'success';
			readonly data: SubmissionTriageCommittedMutation;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'confirmation_required';
			readonly data: SubmissionTriageConfirmationRequired;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'correction_unavailable';
			readonly resultKind: 'semantic' | 'partial' | 'blocked' | 'irreversible';
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

export interface SubmissionTriageLiveClient {
	list(
		query?: unknown,
		options?: { readonly signal?: AbortSignal }
	): Promise<SubmissionTriageLiveReadResult<SubmissionTriagePageView>>;
	read(
		submissionId: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<SubmissionTriageLiveReadResult<SubmissionTriageRowView>>;
	apply(
		input: SubmissionTriageTransitionDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<SubmissionTriageLiveApplyResult>;
	compensate(
		source: SubmissionTriageCompensationSource,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<SubmissionTriageLiveApplyResult>;
}

export interface SubmissionTriageRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type SubmissionTriageRequester = (
	input: SubmissionTriageRequestInput
) => Promise<ApiResult<unknown>>;

function defaultRequester(input: SubmissionTriageRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function invalidRequest(): SubmissionTriageLiveApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): SubmissionTriageLiveApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function unavailable(
	operation: SubmissionTriageLiveOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): Unavailable {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function firstUnavailable(entries: readonly {
	readonly operation: SubmissionTriageLiveOperation;
	readonly binding: OperatorHttpBindingResolution;
}[]): Unavailable | undefined {
	for (const entry of entries) {
		if (entry.binding.kind === 'unavailable') return unavailable(entry.operation, entry.binding);
	}
	return undefined;
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

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function sameScope(
	left: SubmissionTriageSafeDiff['queryGuard']['before']['scope'],
	right: SubmissionTriageSafeDiff['queryGuard']['before']['scope']
): boolean {
	return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function visibleTray(
	state: SubmissionTriageSafeDiff['transitions'][number]['before']['state'],
	arrival: SubmissionTriageSafeDiff['transitions'][number]['arrivalClassification']
): SubmissionTriageSafeDiff['transitions'][number]['beforeVisibleTray'] {
	return state === 'discarded_recoverable'
		? 'discarded'
		: state === 'set_aside'
			? 'set_aside'
			: arrival === 'late' ? 'late' : 'inbox';
}

function transitionMatchesAction(
	action: SubmissionTriageAction,
	transition: SubmissionTriageSafeDiff['transitions'][number]
): boolean {
	const before = transition.before;
	const after = transition.after;
	if (transition.beforeVisibleTray !== visibleTray(before.state, transition.arrivalClassification)
		|| transition.afterVisibleTray !== visibleTray(after.state, transition.arrivalClassification)) {
		return false;
	}
	switch (action) {
		case 'set_aside':
			return before.state === 'inbox'
				&& after.state === 'set_aside'
				&& after.setAsideAttribution !== null;
		case 'return_to_inbox':
			return before.state === 'set_aside'
				&& after.state === 'inbox'
				&& after.setAsideAttribution === null;
		case 'discard_recoverable':
			return before.state !== 'discarded_recoverable'
				&& after.state === 'discarded_recoverable'
				&& after.setAsideAttribution === null;
		case 'restore':
			return before.state === 'discarded_recoverable'
				&& after.state === 'inbox'
				&& after.setAsideAttribution === null;
		default: {
			const exhaustive: never = action;
			return exhaustive;
		}
	}
}

function safeDiffMatchesRequest(
	diff: SubmissionTriageSafeDiff,
	request: SubmissionTriageTransitionDraftInput
): boolean {
	if (diff.action !== request.action
		|| diff.queryGuard.before.version !== request.expectedQueryGuard.version
		|| diff.queryGuard.before.digestSha256 !== request.expectedQueryGuard.digestSha256
		|| !sameScope(diff.queryGuard.before.scope, diff.queryGuard.after.scope)
		|| diff.transitions.length !== request.submissionIds.length) {
		return false;
	}
	return diff.transitions.every((transition, index) => {
		const expectedId = request.submissionIds[index];
		const expectedHead = request.expectedHeads[index];
		return transition.submissionId === expectedId
			&& expectedHead?.submissionId === expectedId
			&& transition.before.submissionId === expectedId
			&& transition.after.submissionId === expectedId
			&& transition.before.version === expectedHead.version
			&& transition.after.version === expectedHead.version + 1
			&& transitionMatchesAction(request.action, transition);
	});
}

function exactCorrectionMatchesSource(
	correction: SubmissionTriageSafeDiff,
	source: SubmissionTriageSafeDiff
): boolean {
	if (correction.action !== 'restore_exact'
		|| correction.transitions.length !== source.transitions.length
		|| !sameJson(correction.queryGuard.before, source.queryGuard.after)
		|| !sameScope(correction.queryGuard.before.scope, correction.queryGuard.after.scope)) {
		return false;
	}
	return correction.transitions.every((transition, index) => {
		const original = source.transitions[index];
		return original !== undefined
			&& transition.submissionId === original.submissionId
			&& transition.arrivalClassification === original.arrivalClassification
			&& transition.beforeVisibleTray === original.afterVisibleTray
			&& transition.afterVisibleTray === original.beforeVisibleTray
			&& sameJson(transition.before, original.after)
			&& transition.after.submissionId === original.before.submissionId
			&& transition.after.version === original.after.version + 1
			&& transition.after.state === original.before.state
			&& sameJson(
				transition.after.setAsideAttribution,
				original.before.setAsideAttribution
			);
	});
}

async function workflowKeys(
	rawKey: string,
	workflow: string,
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
		stage, `je.submission-triage.${workflow}.${stage}.${anchor}`
	])));
}

function mapEffectOutcome(
	result: {
		readonly outcome: StructuredOutcome;
		readonly terminal: boolean;
		readonly receipt?: OperationReceiptRef;
		readonly correlationId: string;
	},
	operation: { readonly name: string; readonly version: number }
): SubmissionTriageLiveApplyResult {
	if ((result.terminal && !receiptMatches(result.receipt, operation))
		|| (!result.terminal && result.receipt !== undefined)) return invalidContract();
	return {
		kind: 'outcome',
		outcome: result.outcome,
		terminal: result.terminal,
		...(result.receipt ? { receipt: result.receipt } : {}),
		correlationId: result.correlationId
	};
}

function mapChangesetFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operationName: 'propose' | 'commit'
): SubmissionTriageLiveApplyResult {
	if (result.kind === 'unavailable') {
		return { kind: 'unavailable', operation: operationName, reason: result.reason };
	}
	if (result.kind === 'transport_error') return result;
	if (typeof result.terminal !== 'boolean') return invalidContract();
	return mapEffectOutcome({
		outcome: result.outcome,
		terminal: result.terminal,
		...(result.receipt ? { receipt: result.receipt } : {}),
		correlationId: result.correlationId
	}, CHANGESET_REVIEW_OPERATIONS[operationName]);
}

function proposedOperationMatches(
	result: Extract<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>['data'] & {
		readonly operationCount: number;
		readonly groups: readonly {
			readonly operations: readonly {
				readonly kind: string;
				readonly version: number;
				readonly dependencyGroup: string;
				readonly safeDiff: unknown;
			}[];
		}[];
	},
	expected: SubmissionTriageSafeDiff
): boolean {
	const operations = result.groups.flatMap((group) => group.operations);
	const operation = operations[0];
	const parsed = submissionTriageSafeDiffSchema.safeParse(operation?.safeDiff);
	return result.operationCount === 1
		&& operations.length === 1
		&& operation?.kind === SUBMISSION_TRIAGE_CHANGESET_OPERATION.kind
		&& operation.version === SUBMISSION_TRIAGE_CHANGESET_OPERATION.version
		&& operation.dependencyGroup === SUBMISSION_TRIAGE_CHANGESET_OPERATION.dependencyGroup
		&& parsed.success
		&& sameJson(parsed.data, expected);
}

/** Pure live: every path comes from one exact active manifest; no sample state is consulted. */
export function createSubmissionTriageLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: SubmissionTriageRequester;
}): SubmissionTriageLiveClient {
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

	async function completeDraft(input: {
		readonly action: SubmissionTriageAction | 'restore_exact';
		readonly selector: ChangesetRevisionSelector;
		readonly headVersion: number;
		readonly safeDiff: SubmissionTriageSafeDiff;
		readonly approvalRequirement: 'none' | 'distinct_current_human';
		readonly draftReceipt: OperationReceiptRef;
		readonly correlationId: string;
		readonly proposeKey: string;
		readonly commitKey: string;
		readonly signal?: AbortSignal;
	}): Promise<SubmissionTriageLiveApplyResult> {
		if (input.approvalRequirement === 'distinct_current_human') {
			return {
				kind: 'confirmation_required',
				data: Object.freeze({
					action: input.action,
					...input.selector,
					headVersion: input.headVersion,
					safeDiff: input.safeDiff,
					requirement: 'distinct_current_human' as const
				}),
				receipt: input.draftReceipt,
				correlationId: input.correlationId
			};
		}
		const proposed = await changesets.propose(
			{ ...input.selector, expectedHeadVersion: input.headVersion },
			input.proposeKey,
			input.signal ? { signal: input.signal } : {}
		);
		if (proposed.kind !== 'success') return mapChangesetFailure(proposed, 'propose');
		if (!receiptMatches(proposed.receipt, CHANGESET_REVIEW_OPERATIONS.propose)
			|| proposed.correlationId === undefined
			|| !proposedOperationMatches(proposed.data, input.safeDiff)) {
			return invalidContract();
		}
		const committed = await changesets.commit(
			{ ...input.selector, expectedHeadVersion: proposed.data.headVersion },
			input.commitKey,
			input.signal ? { signal: input.signal } : {}
		);
		if (committed.kind !== 'success') return mapChangesetFailure(committed, 'commit');
		if (!receiptMatches(committed.receipt, CHANGESET_REVIEW_OPERATIONS.commit)
			|| committed.correlationId === undefined) return invalidContract();
		return {
			kind: 'success',
			data: Object.freeze({
				action: input.action,
				...input.selector,
				committedHeadVersion: committed.data.committedHeadVersion,
				safeDiff: input.safeDiff
			}),
			receipt: committed.receipt,
			correlationId: committed.correlationId
		};
	}

	return Object.freeze({
		async list(
			rawQuery: unknown = {},
			options: { readonly signal?: AbortSignal } = {}
		): Promise<SubmissionTriageLiveReadResult<SubmissionTriagePageView>> {
			const parsedQuery = submissionTriageListInputSchema.safeParse(rawQuery);
			if (!parsedQuery.success) {
				return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
			}
			if (bindings.list.kind === 'unavailable') return unavailable('list', bindings.list);
			const query = new URLSearchParams(Object.entries(parsedQuery.data));
			const response = await request({
				path: `${bindings.list.path}${query.size === 0 ? '' : `?${query.toString()}`}`,
				method: 'GET',
				schema: submissionTriageListOperationResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = submissionTriageListOperationResultSchema.safeParse(response.data);
			if (!parsed.success) {
				return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			}
			if (parsed.data.kind === 'outcome') {
				return {
					kind: 'outcome', outcome: parsed.data.outcome,
					correlationId: parsed.data.correlationId
				};
			}
			try {
				return {
					kind: 'success',
					data: mapSubmissionTriageList(parsed.data.data),
					correlationId: parsed.data.correlationId
				};
			} catch {
				return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			}
		},

		async read(
			submissionId: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<SubmissionTriageLiveReadResult<SubmissionTriageRowView>> {
			const parsedInput = submissionTriageReadInputSchema.safeParse({ submissionId });
			if (!parsedInput.success) {
				return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
			}
			if (bindings.read.kind === 'unavailable') return unavailable('read', bindings.read);
			const response = await request({
				path: `${bindings.read.path}?${new URLSearchParams(parsedInput.data).toString()}`,
				method: 'GET',
				schema: submissionTriageReadOperationResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = submissionTriageReadOperationResultSchema.safeParse(response.data);
			if (!parsed.success) {
				return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			}
			if (parsed.data.kind === 'outcome') {
				return {
					kind: 'outcome', outcome: parsed.data.outcome,
					correlationId: parsed.data.correlationId
				};
			}
			try {
				return {
					kind: 'success',
					data: mapSubmissionTriageRead(parsed.data.data),
					correlationId: parsed.data.correlationId
				};
			} catch {
				return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			}
		},

		async apply(
			rawInput: SubmissionTriageTransitionDraftInput,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<SubmissionTriageLiveApplyResult> {
			const parsedInput = submissionTriageTransitionDraftInputSchema.safeParse(rawInput);
			if (!parsedInput.success) return invalidRequest();
			const missing = firstUnavailable([
				{ operation: 'draft', binding: bindings.draft },
				{ operation: 'propose', binding: proposeBinding },
				{ operation: 'commit', binding: commitBinding }
			]);
			if (missing) return missing;
			const keys = await workflowKeys(
				idempotencyKey, parsedInput.data.action, ['draft', 'propose', 'commit']
			);
			if (!keys) return invalidRequest();
			options.signal?.throwIfAborted();
			if (bindings.draft.kind !== 'available') return invalidContract();
			const response = await request({
				path: bindings.draft.path,
				method: 'POST',
				schema: submissionTriageDraftOperationResultSchema,
				body: parsedInput.data,
				idempotencyKey: keys.draft!,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = submissionTriageDraftOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') {
				return mapEffectOutcome(parsed.data, SUBMISSION_TRIAGE_OPERATIONS.draft);
			}
			const draft = parsed.data;
			if (!receiptMatches(draft.receipt, SUBMISSION_TRIAGE_OPERATIONS.draft)
				|| draft.data.action !== parsedInput.data.action
				|| !safeDiffMatchesRequest(draft.data.safeDiff, parsedInput.data)) {
				return invalidContract();
			}
			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: draft.data.changesetId,
				revisionId: draft.data.revision.id,
				revisionDigest: draft.data.revision.digestSha256
			});
			return completeDraft({
				action: draft.data.action,
				selector,
				headVersion: draft.data.headVersion,
				safeDiff: draft.data.safeDiff,
				approvalRequirement: draft.data.approvalPolicy.requirement,
				draftReceipt: draft.receipt,
				correlationId: draft.correlationId,
				proposeKey: keys.propose!,
				commitKey: keys.commit!,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		async compensate(
			rawSource: SubmissionTriageCompensationSource,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<SubmissionTriageLiveApplyResult> {
			const parsedSelector = changesetRevisionSelectorSchema.safeParse({
				changesetId: rawSource?.changesetId,
				revisionId: rawSource?.revisionId,
				revisionDigest: rawSource?.revisionDigest
			});
			const parsedReceipt = rawSource && typeof rawSource === 'object'
				? operationReceiptRefSchema.shape.id.safeParse(rawSource.sourceCommitReceiptId)
				: { success: false as const };
			const parsedSourceDiff = submissionTriageSafeDiffSchema.safeParse(rawSource?.safeDiff);
			if (!parsedSelector.success || !parsedReceipt.success || !parsedSourceDiff.success) {
				return invalidRequest();
			}
			const missing = firstUnavailable([
				{ operation: 'correction', binding: bindings.correction },
				{ operation: 'propose', binding: proposeBinding },
				{ operation: 'commit', binding: commitBinding }
			]);
			if (missing) return missing;
			const keys = await workflowKeys(
				idempotencyKey, 'restore-exact', ['correction', 'propose', 'commit']
			);
			if (!keys) return invalidRequest();
			const correctionInput = draftChangesetCorrectionInputSchema.parse({
				sourceChangesetId: parsedSelector.data.changesetId,
				sourceRevisionId: parsedSelector.data.revisionId,
				sourceRevisionDigest: parsedSelector.data.revisionDigest,
				sourceCommitReceiptId: rawSource.sourceCommitReceiptId
			});
			options.signal?.throwIfAborted();
			if (bindings.correction.kind !== 'available') return invalidContract();
			const response = await request({
				path: bindings.correction.path,
				method: 'POST',
				schema: changesetLifecycleOperationResultSchema,
				body: correctionInput,
				idempotencyKey: keys.correction!,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = changesetLifecycleOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') {
				return mapEffectOutcome(parsed.data, SUBMISSION_TRIAGE_OPERATIONS.correction);
			}
			const correction = parsed.data;
			if (!receiptMatches(correction.receipt, SUBMISSION_TRIAGE_OPERATIONS.correction)
				|| correction.data.action !== 'correction'
				|| correction.data.sourceChangesetId !== correctionInput.sourceChangesetId
				|| correction.data.sourceRevisionId !== correctionInput.sourceRevisionId
				|| correction.data.sourceRevisionDigest !== correctionInput.sourceRevisionDigest) {
				return invalidContract();
			}
			if (correction.data.resultKind !== 'exact') {
				return {
					kind: 'correction_unavailable',
					resultKind: correction.data.resultKind,
					receipt: correction.receipt,
					correlationId: correction.correlationId
				};
			}
			const target = correction.data.target;
			if (target === null || target.status !== 'draft' || target.operations.length !== 1) {
				return invalidContract();
			}
			const operation = target.operations[0];
			const safeDiff = submissionTriageSafeDiffSchema.safeParse(operation?.safeDiff);
			if (operation?.kind !== SUBMISSION_TRIAGE_CHANGESET_OPERATION.kind
				|| operation.version !== SUBMISSION_TRIAGE_CHANGESET_OPERATION.version
				|| operation.dependencyGroup !== SUBMISSION_TRIAGE_CHANGESET_OPERATION.dependencyGroup
				|| !safeDiff.success
				|| !exactCorrectionMatchesSource(safeDiff.data, parsedSourceDiff.data)) {
				return invalidContract();
			}
			const selector = changesetRevisionSelectorSchema.parse({
				changesetId: target.changesetId,
				revisionId: target.revisionId,
				revisionDigest: target.revisionDigest
			});
			return completeDraft({
				action: 'restore_exact',
				selector,
				headVersion: target.headVersion,
				safeDiff: safeDiff.data,
				approvalRequirement: target.approvalPolicy.requirement,
				draftReceipt: correction.receipt,
				correlationId: correction.correlationId,
				proposeKey: keys.propose!,
				commitKey: keys.commit!,
				...(options.signal ? { signal: options.signal } : {})
			});
		}
	});
}
