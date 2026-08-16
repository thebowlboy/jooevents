import { describe, expect, test } from 'bun:test';
import {
	WORKSPACE_TEAM_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	workspaceTeamInviteInputSchema,
	workspaceTeamMutationOperationResultSchema,
	workspaceTeamRemovalInputSchema,
	workspaceTeamRoleChangeInputSchema,
	workspaceTeamSafeDiffSchema,
	type OperationEffect,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	createWorkspaceTeamLiveClient,
	WORKSPACE_TEAM_MEMBERS_READ_OPERATION,
	WORKSPACE_TEAM_MUTATION_OPERATIONS,
	type WorkspaceTeamMutationRequest,
	type WorkspaceTeamRequester
} from './workspace-team-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);
const roles = [
	{ key: 'workspace_admin', name: 'Workspace Admin', version: 1 },
	{ key: 'event_manager', name: 'Event Manager', version: 1 },
	{ key: 'speaker_manager', name: 'Speaker Manager', version: 1 },
	{ key: 'speaker_reviewer', name: 'Speaker Reviewer', version: 1 },
	{ key: 'scheduler', name: 'Scheduler', version: 1 },
	{ key: 'communications_coordinator', name: 'Communications Coordinator', version: 1 },
	{ key: 'viewer', name: 'Viewer', version: 1 }
] as const;

const requests = Object.freeze({
	invite: { action: 'invite', input: workspaceTeamInviteInputSchema.parse({
		email: 'reviewer@example.test', roleKey: 'speaker_reviewer',
		expectedTeamVersion: 7, expectedTeamDigestSha256: digest('a')
	}) },
	change_role: { action: 'change_role', input: workspaceTeamRoleChangeInputSchema.parse({
		subject: { kind: 'member', membershipId: id(1), version: 4 },
		roleKey: 'event_manager', expectedTeamVersion: 7,
		expectedTeamDigestSha256: digest('a')
	}) },
	remove: { action: 'remove', input: workspaceTeamRemovalInputSchema.parse({
		subject: { kind: 'member', membershipId: id(1), version: 4 },
		expectedTeamVersion: 7, expectedTeamDigestSha256: digest('a')
	}) }
} as const satisfies Readonly<Record<string, WorkspaceTeamMutationRequest>>);

const diffs = Object.freeze({
	invite: workspaceTeamSafeDiffSchema.parse({ action: 'invite',
		recipientHint: 'recipient-0123456789ab', role: roles[3],
		invitationStatus: 'recorded', delivery: 'awaiting_activation' }),
	change_role: workspaceTeamSafeDiffSchema.parse({ action: 'change_role',
		subject: requests.change_role.input.subject, before: roles[0], after: roles[1] }),
	remove: workspaceTeamSafeDiffSchema.parse({ action: 'remove',
		subject: requests.remove.input.subject, before: roles[0], after: null,
		sessionRevocation: 'awaiting_activation' })
});

const expected = {
	members: { ...WORKSPACE_TEAM_MEMBERS_READ_OPERATION, effect: 'read' as const,
		method: 'GET' as const, input: 'query' as const, idempotencyRequired: false,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.members, path: '/api/workspace/team' },
	invite: { ...WORKSPACE_TEAM_MUTATION_OPERATIONS.invite, effect: 'commit' as const,
		method: 'POST' as const, input: 'body' as const, idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.invite, path: '/api/workspace/team/invitations' },
	change_role: { ...WORKSPACE_TEAM_MUTATION_OPERATIONS.change_role, effect: 'commit' as const,
		method: 'POST' as const, input: 'body' as const, idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.roleChange, path: '/api/workspace/team/role-changes' },
	remove: { ...WORKSPACE_TEAM_MUTATION_OPERATIONS.remove, effect: 'commit' as const,
		method: 'POST' as const, input: 'body' as const, idempotencyRequired: true,
		...WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.removal, path: '/api/workspace/team/removals' }
} as const;

function operation(key: keyof typeof expected): SafeOperationManifestEntry {
	const item = expected[key];
	const effect = item.effect as OperationEffect;
	return {
		name: item.name, version: item.version, lifecycle: { status: 'active' },
		summary: `Execute ${item.name}.`, effect, maxRisk: 'low',
		autonomy: { policy: { key: `autonomy.${item.name}`, version: 1 },
			riskFloor: 'low', unattendedRiskCeiling: 'low', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'], triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block',
				approval_required: 'block', known_retryable_failure: 'block',
				ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block' } },
		consequenceTags: [], inputSchema: item.inputSchema,
		idempotency: item.idempotencyRequired ? { required: true,
			keySource: { key: 'idempotency.operator_header', version: 1 },
			credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
			requestHashProfile: { key: `request_hash.${item.name}`, version: 1 } }
			: { required: false },
		concurrency: effect === 'read' ? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${item.name}`, version: 1 } },
		outcomes: [], enabledBindings: [{ surface: 'operator_http', protocol: 'http',
			method: item.method, path: item.path, input: item.input,
			resultSchema: item.resultSchema, browserResumption: { kind: 'none' } }]
	};
}

function manifest(keys: readonly (keyof typeof expected)[] = [
	'members', 'invite', 'change_role', 'remove'
]) {
	return safeOperationManifestSchema.parse({ schemaVersion: 1,
		registryDigestSha256: digest('f'), operations: keys.map(operation) });
}

describe('pure-live Workspace Team operation client', () => {
	test('uses one request per direct arm and preserves each caller key unchanged', async () => {
		for (const action of ['invite', 'change_role', 'remove'] as const) {
			const calls: Parameters<WorkspaceTeamRequester>[0][] = [];
			const key = `workspace-team-${action}-01`;
			const client = createWorkspaceTeamLiveClient({ manifest: manifest(), request: async (call) => {
				calls.push(call);
				return { kind: 'success', data: workspaceTeamMutationOperationResultSchema.parse({
					kind: 'success', data: { schemaVersion: 1, action, teamVersion: 8,
						safeDiff: diffs[action] }, receipt: { id: id(100),
							operationName: WORKSPACE_TEAM_MUTATION_OPERATIONS[action].name,
							operationVersion: 1 }, correlationId
				}) };
			} });
			const result = await client.apply(requests[action], key);
			expect(result).toMatchObject({ kind: 'success', data: { action, teamVersion: 8 } });
			expect(calls).toEqual([expect.objectContaining({ path: expected[action].path,
				method: 'POST', idempotencyKey: key })]);
		}
	});

	test('fails malformed or mismatched results closed', async () => {
		const client = createWorkspaceTeamLiveClient({ manifest: manifest(), request: async () => ({
			kind: 'success', data: workspaceTeamMutationOperationResultSchema.parse({
				kind: 'success', data: { schemaVersion: 1, action: 'invite', teamVersion: 8,
					safeDiff: diffs.invite }, receipt: { id: id(101),
						operationName: 'workspace_team.role_change', operationVersion: 1 }, correlationId
			})
		}) });
		expect(await client.apply(requests.invite, 'workspace-team-invite-02')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
	});

	test('refuses missing bindings and invalid keys before transport', async () => {
		let called = false;
		const client = createWorkspaceTeamLiveClient({ manifest: manifest(['members']),
			request: async () => { called = true; throw new Error('unexpected'); } });
		expect(await client.apply(requests.invite, 'workspace-team-invite-03')).toEqual({
			kind: 'unavailable', operation: 'invite', reason: 'operation_not_registered'
		});
		expect(await createWorkspaceTeamLiveClient({ manifest: manifest(), request: async () => {
			called = true; throw new Error('unexpected');
		} }).apply(requests.invite, '')).toEqual({ kind: 'transport_error',
			error: { code: 'invalid_request', retryable: false } });
		expect(called).toBe(false);
	});
});
