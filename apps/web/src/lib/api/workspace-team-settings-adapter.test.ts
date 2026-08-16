import { describe, expect, test } from 'bun:test';
import { workspaceTeamSnapshotSchema, type OperationReceiptRef } from '@jooevents/contracts';
import { mapWorkspaceTeamSnapshot } from './mappers/workspace-team';
import type {
	WorkspaceTeamMutationRequest,
	WorkspaceTeamLiveApplyResult,
	WorkspaceTeamLiveClient,
	WorkspaceTeamLiveReadResult
} from './operations/workspace-team-live';
import {
	createWorkspaceTeamSettingsPort,
	type WorkspaceTeamSettingsMutationResult
} from './workspace-team-settings-adapter';
import type {
	WorkspaceTeamCommittedMutationView,
	WorkspaceTeamSafeChangeView,
	WorkspaceTeamSnapshotView
} from './view-models/workspace-team';

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

const member = {
	id: id(1),
	kind: 'member' as const,
	userId: id(2),
	name: 'Ada Lovelace',
	email: 'ada@example.test',
	role: roles[0],
	status: 'active' as const,
	version: 4,
	hasAdditionalAccess: false
};

const invitation = {
	id: id(3),
	kind: 'invitation' as const,
	name: 'Pending invitation',
	email: 'existing@example.test',
	role: roles[6],
	status: 'invited' as const,
	delivery: 'awaiting_activation' as const,
	version: 2,
	hasAdditionalAccess: false
};

function snapshot(input: {
	readonly version: number;
	readonly digestSeed: string;
	readonly members: readonly (typeof member | typeof invitation | Record<string, unknown>)[];
}): WorkspaceTeamSnapshotView {
	return mapWorkspaceTeamSnapshot(workspaceTeamSnapshotSchema.parse({
		schemaVersion: 1,
		version: input.version,
		digestSha256: digest(input.digestSeed),
		roles,
		members: input.members
	}));
}

const before = snapshot({ version: 7, digestSeed: 'a', members: [invitation, member] });

const commitReceipt: OperationReceiptRef = {
	id: id(100), operationName: 'workspace_team.invite', operationVersion: 1
};

function committed(change: WorkspaceTeamSafeChangeView): WorkspaceTeamLiveApplyResult {
	const data: WorkspaceTeamCommittedMutationView = {
		action: change.action,
		teamVersion: 8,
		change
	};
	return { kind: 'success', data, receipt: commitReceipt, correlationId };
}

function readSuccess(data: WorkspaceTeamSnapshotView): WorkspaceTeamLiveReadResult {
	return { kind: 'success', data, correlationId };
}

function client(input: {
	readonly reads: readonly WorkspaceTeamLiveReadResult[];
	readonly apply?: (
		request: WorkspaceTeamMutationRequest,
		idempotencyKey: string
	) => WorkspaceTeamLiveApplyResult | Promise<WorkspaceTeamLiveApplyResult>;
}): WorkspaceTeamLiveClient {
	let index = 0;
	return {
		async read() {
			const result = input.reads[Math.min(index, input.reads.length - 1)];
			index += 1;
			if (!result) throw new TypeError('missing_workspace_team_read_fixture');
			return result;
		},
		async apply(request, idempotencyKey) {
			if (!input.apply) throw new TypeError('unexpected_workspace_team_apply');
			return input.apply(request, idempotencyKey);
		}
	};
}

describe('source-neutral Workspace Team Settings port', () => {
	test('reads fresh guards, records an invitation, and preserves awaiting activation', async () => {
		const createdInvitation = {
			...invitation,
			id: id(4),
			email: 'reviewer@example.test',
			role: roles[3],
			version: 1
		};
		const after = snapshot({
			version: 8,
			digestSeed: 'b',
			members: [invitation, createdInvitation, member]
		});
		let captured: { request: WorkspaceTeamMutationRequest; key: string } | undefined;
		const port = createWorkspaceTeamSettingsPort({
			client: client({
				reads: [readSuccess(before), readSuccess(after)],
				apply(request, key) {
					captured = { request, key };
					return committed({
						action: 'invite',
						recipientHint: 'recipient-0123456789ab',
						role: roles[3],
						invitationStatus: 'recorded',
						delivery: 'awaiting_activation'
					});
				}
			}),
			newIdempotencyKey: () => 'team-invite-action-1'
		});

		const result = await port.invite('  Reviewer@Example.Test  ', 'Speaker Reviewer');
		expect(captured).toEqual({
			key: 'team-invite-action-1',
			request: {
				action: 'invite',
				input: {
					email: 'reviewer@example.test',
					roleKey: 'speaker_reviewer',
					expectedTeamVersion: 7,
					expectedTeamDigestSha256: digest('a')
				}
			}
		});
		expect(result).toMatchObject({
			kind: 'success',
			data: {
				team: { version: 8 },
				effect: {
					action: 'invite',
					invitationStatus: 'recorded',
					delivery: 'awaiting_activation',
					recipientHint: 'recipient-0123456789ab',
					currentInvitation: {
						id: id(4),
						email: 'reviewer@example.test',
						delivery: 'awaiting_activation'
					}
				}
			},
			receipt: commitReceipt
		});
		expect(JSON.stringify(result)).not.toContain('sent');
	});

	test('changes the exact versioned member subject and returns current canonical state', async () => {
		const after = snapshot({
			version: 8,
			digestSeed: 'd',
			members: [invitation, { ...member, role: roles[1], version: 5 }]
		});
		let captured: WorkspaceTeamMutationRequest | undefined;
		const port = createWorkspaceTeamSettingsPort({
			client: client({
				reads: [readSuccess(before), readSuccess(after)],
				apply(request) {
					captured = request;
					return committed({
						action: 'change_role',
						subject: { kind: 'member', membershipId: id(1), version: 4 },
						before: roles[0],
						after: roles[1]
					});
				}
			}),
			newIdempotencyKey: () => 'team-role-action-1'
		});

		const result = await port.changeRole(id(1), 'Event Manager');
		if (captured?.action !== 'change_role') throw new TypeError('missing_role_change_request');
		expect(captured.input.subject).toMatchObject({
			kind: 'member', membershipId: id(1), version: 4
		});
		expect(captured.input).toMatchObject({
			roleKey: 'event_manager',
			expectedTeamVersion: 7,
			expectedTeamDigestSha256: digest('a')
		});
		expect(result).toMatchObject({
			kind: 'success',
			data: {
				effect: {
					action: 'change_role',
					before: roles[0],
					after: roles[1],
					currentSubject: { id: id(1), version: 5, role: roles[1] }
				}
			}
		});
	});

	test('removes a member while keeping session revocation pending as a first-class fact', async () => {
		const after = snapshot({ version: 8, digestSeed: 'e', members: [invitation] });
		let captured: WorkspaceTeamMutationRequest | undefined;
		const port = createWorkspaceTeamSettingsPort({
			client: client({
				reads: [readSuccess(before), readSuccess(after)],
				apply(request) {
					captured = request;
					return committed({
						action: 'remove',
						subject: { kind: 'member', membershipId: id(1), version: 4 },
						before: roles[0],
						after: null,
						sessionRevocation: 'awaiting_activation'
					});
				}
			})
		});

		const result = await port.removeMember(id(1), { idempotencyKey: 'team-remove-action-1' });
		expect(captured).toMatchObject({
			action: 'remove',
			input: {
				subject: { kind: 'member', membershipId: id(1), version: 4 },
				expectedTeamVersion: 7,
				expectedTeamDigestSha256: digest('a')
			}
		});
		expect(result).toMatchObject({
			kind: 'success',
			data: {
				effect: {
					action: 'remove',
					removedSubject: { id: id(1), name: 'Ada Lovelace' },
					sessionRevocation: 'awaiting_activation'
				}
			},
			receipt: commitReceipt
		});
	});

	test('distinguishes a committed change from a failed post-commit refresh', async () => {
		const refreshFailure: WorkspaceTeamLiveReadResult = {
			kind: 'transport_error', error: { code: 'network_error', retryable: true }
		};
		const port = createWorkspaceTeamSettingsPort({
			client: client({
				reads: [readSuccess(before), refreshFailure],
				apply() {
					return committed({
						action: 'remove',
						subject: { kind: 'member', membershipId: id(1), version: 4 },
						before: roles[0],
						after: null,
						sessionRevocation: 'awaiting_activation'
					});
				}
			})
		});

		expect(await port.removeMember(id(1))).toMatchObject({
			kind: 'committed_refresh_failed',
			committed: { action: 'remove' },
			receipt: commitReceipt,
			refresh: refreshFailure
		});
	});

	test('returns typed local refusals before sending stale or ambiguous work', async () => {
		let applies = 0;
		const port = createWorkspaceTeamSettingsPort({
			client: client({
				reads: [readSuccess(before)],
				apply() {
					applies += 1;
					throw new TypeError('unexpected_workspace_team_apply');
				}
			})
		});

		const cases: readonly Promise<WorkspaceTeamSettingsMutationResult>[] = [
			port.changeRole(id(1), 'Workspace Admin'),
			port.changeRole(id(999), 'Viewer'),
			port.invite('reviewer@example.test', 'Unknown role')
		];
		const results = await Promise.all(cases);
		expect(results.map((result) => result.kind)).toEqual(['refused', 'refused', 'refused']);
		expect(results).toMatchObject([
			{ code: 'role_unchanged' },
			{ code: 'subject_missing' },
			{ code: 'role_unavailable' }
		]);
		expect(applies).toBe(0);
	});
});
