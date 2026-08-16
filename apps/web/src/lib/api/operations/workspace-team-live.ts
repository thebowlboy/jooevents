import {
	WORKSPACE_TEAM_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	workspaceTeamInviteInputSchema,
	workspaceTeamMembersReadResultSchema,
	workspaceTeamMutationOperationResultSchema,
	workspaceTeamRemovalInputSchema,
	workspaceTeamRoleChangeInputSchema,
	type OperationReceiptRef,
	type StructuredOutcome,
	type WorkspaceTeamSafeDiff
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { mapWorkspaceTeamMutation, mapWorkspaceTeamSnapshot } from '../mappers/workspace-team';
import type {
	WorkspaceTeamCommittedMutationView,
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

export const WORKSPACE_TEAM_MUTATION_OPERATIONS = Object.freeze({
	invite: Object.freeze({ name: 'workspace_team.invite', version: 1 } as const),
	change_role: Object.freeze({ name: 'workspace_team.role_change', version: 1 } as const),
	remove: Object.freeze({ name: 'workspace_team.remove', version: 1 } as const)
});

const EXPECTED_OPERATIONS = Object.freeze({
	members: {
		...WORKSPACE_TEAM_MEMBERS_READ_OPERATION,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.members
	},
	invite: {
		...WORKSPACE_TEAM_MUTATION_OPERATIONS.invite,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.invite
	},
	change_role: {
		...WORKSPACE_TEAM_MUTATION_OPERATIONS.change_role,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.roleChange
	},
	remove: {
		...WORKSPACE_TEAM_MUTATION_OPERATIONS.remove,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.removal
	}
} as const satisfies Readonly<Record<
	'members' | 'invite' | 'change_role' | 'remove',
	ExpectedOperatorHttpOperation
>>);

type InviteInput = z.infer<typeof workspaceTeamInviteInputSchema>;
type RoleChangeInput = z.infer<typeof workspaceTeamRoleChangeInputSchema>;
type RemovalInput = z.infer<typeof workspaceTeamRemovalInputSchema>;

export type WorkspaceTeamMutationRequest =
	| { readonly action: 'invite'; readonly input: InviteInput }
	| { readonly action: 'change_role'; readonly input: RoleChangeInput }
	| { readonly action: 'remove'; readonly input: RemovalInput };

export type WorkspaceTeamLiveOperation = 'members' | WorkspaceTeamMutationRequest['action'];

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: WorkspaceTeamLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type WorkspaceTeamLiveReadResult =
	| { readonly kind: 'success'; readonly data: WorkspaceTeamSnapshotView;
		readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome;
		readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export type WorkspaceTeamLiveApplyResult =
	| { readonly kind: 'success'; readonly data: WorkspaceTeamCommittedMutationView;
		readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome;
		readonly terminal: boolean; readonly receipt?: OperationReceiptRef;
		readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface WorkspaceTeamLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<WorkspaceTeamLiveReadResult>;
	apply(request: WorkspaceTeamMutationRequest, idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }): Promise<WorkspaceTeamLiveApplyResult>;
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

type Bindings = Readonly<Record<keyof typeof EXPECTED_OPERATIONS, OperatorHttpBindingResolution>>;

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
			key, resolveOperatorHttpBinding({ manifest, expected })
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

function parseRequest(request: WorkspaceTeamMutationRequest): WorkspaceTeamMutationRequest | undefined {
	if (request.action === 'invite') {
		const parsed = workspaceTeamInviteInputSchema.safeParse(request.input);
		return parsed.success ? Object.freeze({ action: request.action, input: parsed.data }) : undefined;
	}
	if (request.action === 'change_role') {
		const parsed = workspaceTeamRoleChangeInputSchema.safeParse(request.input);
		return parsed.success ? Object.freeze({ action: request.action, input: parsed.data }) : undefined;
	}
	const parsed = workspaceTeamRemovalInputSchema.safeParse(request.input);
	return parsed.success ? Object.freeze({ action: request.action, input: parsed.data }) : undefined;
}

function sameSubject(
	left: Extract<WorkspaceTeamSafeDiff, { readonly action: 'change_role' | 'remove' }>['subject'],
	right: RoleChangeInput['subject'] | RemovalInput['subject']
): boolean {
	if (left.kind !== right.kind || left.version !== right.version) return false;
	return left.kind === 'member' && right.kind === 'member'
		? left.membershipId === right.membershipId
		: left.kind === 'invitation' && right.kind === 'invitation'
			&& left.reservationId === right.reservationId;
}

function safeDiffMatchesRequest(
	diff: WorkspaceTeamSafeDiff,
	request: WorkspaceTeamMutationRequest
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

export function createWorkspaceTeamLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: WorkspaceTeamRequester;
}): WorkspaceTeamLiveClient {
	const bindings = resolveBindings(input.manifest);
	const request = input.request ?? defaultRequester;
	return Object.freeze({
		async read(options: { readonly signal?: AbortSignal } = {}): Promise<WorkspaceTeamLiveReadResult> {
			if (bindings.members.kind === 'unavailable') return unavailable('members', bindings.members);
			const transport = await request({
				path: bindings.members.path, method: 'GET', schema: workspaceTeamMembersReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = workspaceTeamMembersReadResultSchema.safeParse(transport.data);
			if (!parsed.success) return { kind: 'transport_error',
				error: { code: 'invalid_contract', retryable: true } };
			return parsed.data.kind === 'success'
				? { kind: 'success', data: mapWorkspaceTeamSnapshot(parsed.data.data),
					correlationId: parsed.data.correlationId }
				: { kind: 'outcome', outcome: parsed.data.outcome,
					correlationId: parsed.data.correlationId };
		},

		async apply(rawRequest: WorkspaceTeamMutationRequest, idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}): Promise<WorkspaceTeamLiveApplyResult> {
			const mutation = parseRequest(rawRequest);
			if (!mutation || !operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) {
				return invalidRequest();
			}
			const binding = bindings[mutation.action];
			if (binding.kind === 'unavailable') return unavailable(mutation.action, binding);
			options.signal?.throwIfAborted();
			const transport = await request({
				path: binding.path, method: 'POST', schema: workspaceTeamMutationOperationResultSchema,
				body: mutation.input, idempotencyKey,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = workspaceTeamMutationOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			const operation = WORKSPACE_TEAM_MUTATION_OPERATIONS[mutation.action];
			if (parsed.data.kind === 'outcome') {
				const receipt = 'receipt' in parsed.data ? parsed.data.receipt : undefined;
				if ((parsed.data.terminal && !receiptMatches(receipt, operation))
					|| (!parsed.data.terminal && receipt !== undefined)) return invalidContract();
				return { kind: 'outcome', outcome: parsed.data.outcome,
					terminal: parsed.data.terminal, ...(receipt ? { receipt } : {}),
					correlationId: parsed.data.correlationId };
			}
			if (!receiptMatches(parsed.data.receipt, operation)
				|| parsed.data.data.action !== mutation.action
				|| parsed.data.data.teamVersion !== mutation.input.expectedTeamVersion + 1
				|| !safeDiffMatchesRequest(parsed.data.data.safeDiff, mutation)) {
				return invalidContract();
			}
			return { kind: 'success', data: mapWorkspaceTeamMutation(parsed.data.data),
				receipt: parsed.data.receipt, correlationId: parsed.data.correlationId };
		}
	});
}
