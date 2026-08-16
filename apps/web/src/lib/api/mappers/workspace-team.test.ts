import { describe, expect, test } from 'bun:test';
import {
	workspaceTeamMutationDataSchema,
	workspaceTeamSnapshotSchema
} from '@jooevents/contracts';
import {
	mapWorkspaceTeamMutation,
	mapWorkspaceTeamSnapshot
} from './workspace-team';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);

const roles = [
	{ key: 'workspace_admin', name: 'Workspace Admin', version: 1 },
	{ key: 'event_manager', name: 'Event Manager', version: 1 },
	{ key: 'speaker_manager', name: 'Speaker Manager', version: 1 },
	{ key: 'speaker_reviewer', name: 'Speaker Reviewer', version: 1 },
	{ key: 'scheduler', name: 'Scheduler', version: 1 },
	{ key: 'communications_coordinator', name: 'Communications Coordinator', version: 1 },
	{ key: 'viewer', name: 'Viewer', version: 1 }
] as const;

describe('Workspace Team browser mapper', () => {
	test('preserves member and invitation identity, versions, access, and pending delivery', () => {
		const snapshot = workspaceTeamSnapshotSchema.parse({
			schemaVersion: 1,
			version: 7,
			digestSha256: digest('a'),
			roles,
			members: [{
				id: id(1),
				kind: 'invitation',
				name: 'Pending invitation',
				email: 'reviewer@example.test',
				role: roles[3],
				status: 'invited',
				delivery: 'awaiting_activation',
				version: 2,
				hasAdditionalAccess: false
			}, {
				id: id(2),
				kind: 'member',
				userId: id(3),
				name: 'Ada Lovelace',
				email: 'ada@example.test',
				role: roles[0],
				status: 'active',
				version: 4,
				hasAdditionalAccess: true
			}]
		});

		expect(mapWorkspaceTeamSnapshot(snapshot)).toEqual({
			schemaVersion: 1,
			version: 7,
			digestSha256: digest('a'),
			roles,
			members: [{
				id: id(1),
				kind: 'invitation',
				name: 'Pending invitation',
				email: 'reviewer@example.test',
				role: roles[3],
				status: 'invited',
				delivery: 'awaiting_activation',
				version: 2,
				hasAdditionalAccess: false,
				subject: { kind: 'invitation', reservationId: id(1), version: 2 }
			}, {
				id: id(2),
				kind: 'member',
				userId: id(3),
				name: 'Ada Lovelace',
				email: 'ada@example.test',
				role: roles[0],
				status: 'active',
				version: 4,
				hasAdditionalAccess: true,
				subject: { kind: 'member', membershipId: id(2), version: 4 }
			}]
		});
	});

	test('maps only the disclosure-safe invitation evidence and never reconstructs an address', () => {
		const mutation = workspaceTeamMutationDataSchema.parse({
			schemaVersion: 1,
			action: 'invite',
			teamVersion: 8,
			safeDiff: {
				action: 'invite',
				recipientHint: 'recipient-0123456789ab',
				role: roles[6],
				invitationStatus: 'recorded',
				delivery: 'awaiting_activation'
			}
		});
		const mapped = mapWorkspaceTeamMutation(mutation);
		expect(mapped).toMatchObject({
			action: 'invite',
			teamVersion: 8,
			change: {
				recipientHint: 'recipient-0123456789ab',
				invitationStatus: 'recorded',
				delivery: 'awaiting_activation'
			}
		});
		expect(JSON.stringify(mapped)).not.toContain('@');
	});

	test('keeps pending member-session revocation distinct from invitation removal', () => {
		const mutation = workspaceTeamMutationDataSchema.parse({
			schemaVersion: 1,
			action: 'remove',
			teamVersion: 8,
			safeDiff: {
				action: 'remove',
				subject: { kind: 'member', membershipId: id(2), version: 4 },
				before: roles[0],
				after: null,
				sessionRevocation: 'awaiting_activation'
			}
		});

		expect(mapWorkspaceTeamMutation(mutation).change).toEqual({
			action: 'remove',
			subject: { kind: 'member', membershipId: id(2), version: 4 },
			before: roles[0],
			after: null,
			sessionRevocation: 'awaiting_activation'
		});
	});
});
