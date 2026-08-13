import {
	WORKSPACE_TEAM_OPERATION_SCHEMA_REFS,
	changesetRevisionSelectorSchema,
	operationHttpIdempotencyKeySchema,
	workspaceTeamDraftOperationResultSchema,
	workspaceTeamInviteDraftInputSchema,
	workspaceTeamMembersReadResultSchema,
	workspaceTeamRemovalDraftInputSchema,
	workspaceTeamRoleChangeDraftInputSchema,
	workspaceTeamSafeDiffSchema,
	type OperationReceiptRef,
	type StructuredOutcome,
	type WorkspaceTeamSafeDiff
} from '@jooevents/contracts';
import type { z } from 'zod';
import {
	CHANGESET_REVIEW_OPERATIONS,
	createChangesetReviewLivePort
} from '../changesets/live';
import type { ChangesetReviewResult } from '../changesets/port';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	mapWorkspaceTeamSafeChange,
	mapWorkspaceTeamSnapshot
} from '../mappers/workspace-team';
import type {
	WorkspaceTeamCommittedMutationView,
	WorkspaceTeamSafeChangeView,
	WorkspaceTeamSnapshotView
} from '../view-models/workspace-team';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const WORKSPACE_TEAM_MEMBERS_READ_OPERATION = Object.freeze({
	name: 'workspace_team.members.read', version: 1
} as const);

export const WORKSPACE_TEAM_DRAFT_OPERATIONS = Object.freeze({
	invite: Object.freeze({ name: 'workspace_team.invite.draft', version: 1 } as const),
	change_role: Object.freeze({ name: 'workspace_team.role_change.draft', version: 1 } as const),
	remove: Object.freeze({ name: 'workspace_team.removal.draft', version: 1 } as const)
});

const WORKSPACE_TEAM_CHANGESET_OPERATION = Object.freeze({
	kind: 'workspace_team.mutate',
	version: 1,
	dependencyGroup: 'workspace_team'
} as const);

const EXPECTED_OPERATIONS = Object.freeze({
	members: {
		...WORKSPACE_TEAM_MEMBERS_READ_OPERATION,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.members
	},
	invite: {
		...WORKSPACE_TEAM_DRAFT_OPERATIONS.invite,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.invite
	},
	change_role: {
		...WORKSPACE_TEAM_DRAFT_OPERATIONS.change_role,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.roleChange
	},
	remove: {
		...WORKSPACE_TEAM_DRAFT_OPERATIONS.remove,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.removal
	}
} as const satisfies Readonly<Record<
	'members' | 'invite' | 'change_role' | 'remove',
	ExpectedOperatorHttpOperation
>>);

type InviteDraftInput = z.infer<typeof workspaceTeamInviteDraftInputSchema>;
type RoleChangeDraftInput = z.infer<typeof workspaceTeamRoleChangeDraftInputSchema>;
type RemovalDraftInput = z.infer<typeof workspaceTeamRemovalDraftInputSchema>;

export type WorkspaceTeamDraftRequest =
	| { readonly action: 'invite'; readonly input: InviteDraftInput }
	| { readonly action: 'change_role'; readonly input: RoleChangeDraftInput }
	| { readonly action: 'remove'; readonly input: RemovalDraftInput };

export type WorkspaceTeamLiveOperation =
	| 'members'
	| WorkspaceTeamDraftRequest['action']
	| 'propose'
	| 'commit';

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: WorkspaceTeamLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type WorkspaceTeamLiveReadResult =
	| {
			readonly kind: 'success';
			readonly data: WorkspaceTeamSnapshotView;
			readonly correlationId: string;
	  }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface WorkspaceTeamConfirmationRequired {
	readonly action: WorkspaceTeamDraftRequest['action'];
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly headVersion: number;
	readonly change: WorkspaceTeamSafeChangeView;
	readonly requirement: 'distinct_current_human';
}

export type WorkspaceTeamLiveApplyResult =
	| {
			readonly kind: 'success';
			readonly data: WorkspaceTeamCommittedMutationView;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'confirmation_required';
			readonly data: WorkspaceTeamConfirmationRequired;
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

export interface WorkspaceTeamLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<WorkspaceTeamLiveReadResult>;
	apply(
		request: WorkspaceTeamDraftRequest,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<WorkspaceTeamLiveApplyResult>;
}

export interface WorkspaceTeamRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type WorkspaceTeamRequester = (
	input: WorkspaceTeamRequestInput
) => Promise<ApiResult<unknown>>;

type BindingKey = keyof typeof EXPECTED_OPERATIONS;
type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

function defaultRequester(input: WorkspaceTeamRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function invalidRequest(): WorkspaceTeamLiveApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): WorkspaceTeamLiveApplyResult {
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
	operation: WorkspaceTeamLiveOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): Unavailable {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function firstUnavailable(input: readonly {
	readonly operation: WorkspaceTeamLiveOperation;
	readonly binding: OperatorHttpBindingResolution;
}[]): Unavailable | undefined {
	for (const entry of input) {
		if (entry.binding.kind === 'unavailable') return unavailable(entry.operation, entry.binding);
	}
	return undefined;
}

function parseRequest(request: WorkspaceTeamDraftRequest): WorkspaceTeamDraftRequest | undefined {
	if (request.action === 'invite') {
		const parsed = workspaceTeamInviteDraftInputSchema.safeParse(request.input);
		return parsed.success ? Object.freeze({ action: request.action, input: parsed.data }) : undefined;
	}
	if (request.action === 'change_role') {
		const parsed = workspaceTeamRoleChangeDraftInputSchema.safeParse(request.input);
		return parsed.success ? Object.freeze({ action: request.action, input: parsed.data }) : undefined;
	}
	const parsed = workspaceTeamRemovalDraftInputSchema.safeParse(request.input);
	return parsed.success ? Object.freeze({ action: request.action, input: parsed.data }) : undefined;
}

async function workflowIdempotencyKeys(
	rawKey: string,
	action: WorkspaceTeamDraftRequest['action']
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
		draft: `je.workspace-team.${action}.draft.${anchor}`,
		propose: `je.workspace-team.${action}.propose.${anchor}`,
		commit: `je.workspace-team.${action}.commit.${anchor}`
	});
}

function sameSubject(
	left: Extract<WorkspaceTeamSafeDiff, { readonly action: 'change_role' | 'remove' }>['subject'],
	right: RoleChangeDraftInput['subject'] | RemovalDraftInput['subject']
): boolean {
	if (left.kind !== right.kind || left.version !== right.version) return false;
	return left.kind === 'member' && right.kind === 'member'
		? left.membershipId === right.membershipId
		: left.kind === 'invitation' && right.kind === 'invitation'
			&& left.reservationId === right.reservationId;
}

function safeDiffMatchesRequest(
	diff: WorkspaceTeamSafeDiff,
	request: WorkspaceTeamDraftRequest
): boolean {
	if (diff.action !== request.action) return false;
	if (request.action === 'invite' && diff.action === 'invite') {
		return diff.role.key === request.input.roleKey
			&& diff.invitationStatus === 'recorded'
			&& diff.delivery === 'awaiting_activation';
	}
	if (request.action === 'change_role' && diff.action === 'change_role') {
		return sameSubject(diff.subject, request.input.subject)
			&& diff.after.key === request.input.roleKey;
	}
	if (request.action === 'remove' && diff.action === 'remove') {
		return sameSubject(diff.subject, request.input.subject)
			&& diff.after === null
			&& diff.sessionRevocation === (
				request.input.subject.kind === 'member' ? 'awaiting_activation' : 'not_applicable'
			);
	}
	return false;
}

function sameSafeDiff(left: WorkspaceTeamSafeDiff, right: WorkspaceTeamSafeDiff): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function mapDraftOutcome(
	result: Extract<z.infer<typeof workspaceTeamDraftOperationResultSchema>,
		{ readonly kind: 'outcome' }>,
	operation: { readonly name: string; readonly version: number }
): WorkspaceTeamLiveApplyResult {
	const receipt = 'receipt' in result ? result.receipt : undefined;
	if ((result.terminal && !receiptMatches(receipt, operation))
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
): WorkspaceTeamLiveApplyResult {
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
 * Pure-live Workspace Team client. Routes are accepted only from one exact
 * safe operation manifest, and one press confirms only the draft, proposal,
 * and commit bound to the same revision selector and staged idempotency root.
 */
export function createWorkspaceTeamLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: WorkspaceTeamRequester;
}): WorkspaceTeamLiveClient {
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
		): Promise<WorkspaceTeamLiveReadResult> {
			if (bindings.members.kind === 'unavailable') {
				return unavailable('members', bindings.members);
			}
			const transport = await request({
				path: bindings.members.path,
				method: 'GET',
				schema: workspaceTeamMembersReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = workspaceTeamMembersReadResultSchema.safeParse(transport.data);
			if (!parsed.success) {
				return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			}
			return parsed.data.kind === 'success'
				? {
						kind: 'success',
						data: mapWorkspaceTeamSnapshot(parsed.data.data),
						correlationId: parsed.data.correlationId
					}
				: {
						kind: 'outcome',
						outcome: parsed.data.outcome,
						correlationId: parsed.data.correlationId
					};
		},

		async apply(
			rawRequest: WorkspaceTeamDraftRequest,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<WorkspaceTeamLiveApplyResult> {
			const draftRequest = parseRequest(rawRequest);
			if (!draftRequest) return invalidRequest();
			const workflowUnavailable = firstUnavailable([
				{ operation: draftRequest.action, binding: bindings[draftRequest.action] },
				{ operation: 'propose', binding: proposeBinding },
				{ operation: 'commit', binding: commitBinding }
			]);
			if (workflowUnavailable) return workflowUnavailable;
			const keys = await workflowIdempotencyKeys(idempotencyKey, draftRequest.action);
			if (!keys) return invalidRequest();
			options.signal?.throwIfAborted();

			const draftBinding = bindings[draftRequest.action];
			if (draftBinding.kind !== 'available') return invalidContract();
			const draftTransport = await request({
				path: draftBinding.path,
				method: 'POST',
				schema: workspaceTeamDraftOperationResultSchema,
				body: draftRequest.input,
				idempotencyKey: keys.draft,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (draftTransport.kind === 'error') {
				return { kind: 'transport_error', error: draftTransport.error };
			}
			const parsedDraft = workspaceTeamDraftOperationResultSchema.safeParse(draftTransport.data);
			if (!parsedDraft.success) return invalidContract();
			const draft = parsedDraft.data;
			const draftOperation = WORKSPACE_TEAM_DRAFT_OPERATIONS[draftRequest.action];
			if (draft.kind === 'outcome') return mapDraftOutcome(draft, draftOperation);
			if (!receiptMatches(draft.receipt, draftOperation)
				|| draft.data.action !== draftRequest.action
				|| draft.data.riskTier !== (
					draftRequest.action === 'invite' ? 'normal' : 'consequential'
				)
				|| !safeDiffMatchesRequest(draft.data.safeDiff, draftRequest)) {
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
						action: draftRequest.action,
						...selector,
						headVersion: draft.data.headVersion,
						change: mapWorkspaceTeamSafeChange(draft.data.safeDiff),
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
			const proposedDiff = workspaceTeamSafeDiffSchema.safeParse(proposedOperation?.safeDiff);
			if (proposed.data.operationCount !== 1
				|| operations.length !== 1
				|| proposedOperation?.kind !== WORKSPACE_TEAM_CHANGESET_OPERATION.kind
				|| proposedOperation.version !== WORKSPACE_TEAM_CHANGESET_OPERATION.version
				|| proposedOperation.dependencyGroup !== WORKSPACE_TEAM_CHANGESET_OPERATION.dependencyGroup
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
					action: draftRequest.action,
					...selector,
					committedHeadVersion: committed.data.committedHeadVersion,
					change: mapWorkspaceTeamSafeChange(draft.data.safeDiff)
				}),
				receipt: committed.receipt,
				correlationId: committed.correlationId
			};
		}
	});
}
