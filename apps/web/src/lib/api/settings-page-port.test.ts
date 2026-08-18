import { describe, expect, test } from 'bun:test';
import type { OperationReceiptRef } from '@jooevents/contracts';
import { createSampleEventProgramPort } from './event-program/sample';
import { configuredEventProgramFixture } from './event-program/fixtures';
import { createProgramVocabularySettingsAdapter } from './program-vocabulary-settings-adapter';
import type { WorkspaceTeamLiveReadResult } from './operations/workspace-team-live';
import type { SpeakerProfilesLiveClient } from './operations/speaker-profiles-live';
import { sampleWorkspaceGateway } from './sample/gateway';
import {
	createLiveSettingsPagePort,
	createSampleSettingsPagePort
} from './settings-page-port';
import {
	createSampleSenderIdentitySettingsPort,
	type SettingsPageSenderIdentityPort
} from './sender-identity-settings-port';
import type {
	WorkspaceTeamSettingsMutationResult,
	WorkspaceTeamSettingsPort
} from './workspace-team-settings-adapter';
import type {
	WorkspaceTeamMemberView,
	WorkspaceTeamRoleView,
	WorkspaceTeamSnapshotView
} from './view-models/workspace-team';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (value: string) => value.repeat(64);

const role: WorkspaceTeamRoleView = {
	key: 'workspace_admin',
	name: 'Workspace Admin',
	version: 1
};

const member: WorkspaceTeamMemberView = {
	id: id(1),
	kind: 'member',
	userId: id(2),
	name: 'Ada Lovelace',
	email: 'ada@example.test',
	role,
	status: 'active',
	version: 1,
	hasAdditionalAccess: false,
	subject: { kind: 'member', membershipId: id(1), version: 1 }
};

const invitation: WorkspaceTeamMemberView = {
	id: id(3),
	kind: 'invitation',
	name: 'Pending invitation',
	email: 'reviewer@example.test',
	role,
	status: 'invited',
	delivery: 'awaiting_activation',
	version: 1,
	hasAdditionalAccess: false,
	subject: { kind: 'invitation', reservationId: id(3), version: 1 }
};

const before: WorkspaceTeamSnapshotView = {
	schemaVersion: 1,
	version: 1,
	digestSha256: digest('a'),
	roles: [role],
	members: [member]
};

const afterInvite: WorkspaceTeamSnapshotView = {
	...before,
	version: 2,
	digestSha256: digest('b'),
	members: [member, invitation]
};

const receipt: OperationReceiptRef = {
	id: id(20),
	operationName: 'workspace_team.invite',
	operationVersion: 1
};

const readSuccess: WorkspaceTeamLiveReadResult = {
	kind: 'success',
	data: before,
	correlationId: id(21)
};

const refused: WorkspaceTeamSettingsMutationResult = {
	kind: 'refused',
	code: 'subject_missing',
	reason: 'That team entry is no longer present.'
};

function teamPort(input: {
	readonly read?: WorkspaceTeamLiveReadResult;
	readonly invite?: WorkspaceTeamSettingsMutationResult;
	readonly changeRole?: WorkspaceTeamSettingsMutationResult;
	readonly remove?: WorkspaceTeamSettingsMutationResult;
} = {}): WorkspaceTeamSettingsPort {
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		async members() {
			return input.read ?? readSuccess;
		},
		async invite() {
			return input.invite ?? refused;
		},
		async changeRole() {
			return input.changeRole ?? refused;
		},
		async removeMember() {
			return input.remove ?? refused;
		}
	});
}

function vocabulary(kind: 'sample' | 'live') {
	const sample = createSampleEventProgramPort({ fixture: configuredEventProgramFixture });
	const adapter = createProgramVocabularySettingsAdapter({
		program: sample.port
	});
	return kind === 'sample'
		? adapter
		: Object.freeze({ ...adapter, source: Object.freeze({ kind: 'live' as const }) });
}

function committedInvite(): WorkspaceTeamSettingsMutationResult {
	return {
		kind: 'success',
		data: {
			committed: {
				action: 'invite',
				teamVersion: 2,
				change: {
					action: 'invite',
					recipientHint: 'recipient-0123456789ab',
					role,
					invitationStatus: 'recorded',
					delivery: 'awaiting_activation'
				}
			},
			team: afterInvite,
			effect: {
				action: 'invite',
				invitationStatus: 'recorded',
				delivery: 'awaiting_activation',
				recipientHint: 'recipient-0123456789ab',
				currentInvitation: invitation
			}
		},
		receipt,
		correlationId: id(24)
	};
}

/** The Email section's seam is exercised in its own suites; here it only has to exist. */
const senderIdentity: SettingsPageSenderIdentityPort = createSampleSenderIdentitySettingsPort(
	sampleWorkspaceGateway.api.communications.senderIdentity
);

function createLivePort(
	team: WorkspaceTeamSettingsPort = teamPort(),
	profiles?: SpeakerProfilesLiveClient
) {
	return createLiveSettingsPagePort({
		event: {
			get: sampleWorkspaceGateway.api.settings.get,
			update: sampleWorkspaceGateway.api.settings.update
		},
		team,
		vocab: vocabulary('live'),
		fields: sampleWorkspaceGateway.api.fields,
		...(profiles ? { profiles } : {}),
		senderIdentity
	});
}

describe('tuned Settings page source seam', () => {
	test('keeps the resettable sample on the same page contract', async () => {
		const port = createSampleSettingsPagePort(sampleWorkspaceGateway.api);

		expect(port.source).toEqual({ kind: 'sample' });
		expect(port.workspace.summarySnapshot()).toBe(sampleWorkspaceGateway.api.workspace.summarySnapshot());
		expect(await port.team.members()).toMatchObject({ kind: 'success' });
	});

	test('refuses a sample vocabulary inside the live composition', () => {
		expect(() => createLiveSettingsPagePort({
			event: {
				get: sampleWorkspaceGateway.api.settings.get,
				update: sampleWorkspaceGateway.api.settings.update
			},
			team: teamPort(),
			vocab: vocabulary('sample'),
			fields: sampleWorkspaceGateway.api.fields,
			senderIdentity
		})).toThrow('live_settings_source_required');
	});

	test('maps canonical reference usage and nullable room capacity without inventing workflow counts', async () => {
		const port = createLivePort();
		const [rooms, tracks, team] = await Promise.all([
			port.vocab.rooms(),
			port.vocab.tracks(),
			port.team.members()
		]);

		expect(rooms.find((room) => room.name === 'Workshop room')).toMatchObject({
			capacity: null,
			usage: { currentReferences: 0, historicalPins: 0 }
		});
		expect(Object.keys(tracks[0]!.usage).sort()).toEqual([
			'currentReferences', 'historicalPins'
		]);
		expect(team).toEqual({
			kind: 'success',
			members: [{
				id: member.id,
				name: member.name,
				email: member.email,
				role: member.role.name,
				status: member.status
			}]
		});
	});

	test('reports a recorded invitation as awaiting activation rather than sent', async () => {
		const port = createLivePort(teamPort({ invite: committedInvite() }));
		const result = await port.team.invite('reviewer@example.test', 'Workspace Admin');

		expect(result).toMatchObject({
			ok: true,
			committed: true,
			message: 'Invitation recorded for reviewer@example.test. Delivery is awaiting activation.',
			members: [{ id: member.id }, { id: invitation.id, status: 'invited' }]
		});
		expect(JSON.stringify(result)).not.toContain('Invitation sent');
	});

	test('keeps a committed change committed when its refresh cannot reconcile', async () => {
		const committed = committedInvite();
		if (committed.kind !== 'success') throw new TypeError('expected_committed_invite');
		const port = createLivePort(teamPort({
			invite: {
				kind: 'committed_refresh_failed',
				committed: committed.data.committed,
				receipt: committed.receipt,
				correlationId: committed.correlationId,
				refresh: {
					kind: 'unavailable',
					operation: 'members',
					reason: 'operation_not_active'
				}
			}
		}));

		expect(await port.team.invite('reviewer@example.test', 'Workspace Admin')).toEqual({
			ok: true,
			committed: true,
			message: 'The team change was committed. Refresh to reconcile the latest team list.'
		});
	});

	test('changes profile review through its exact policy operation, outside ordinary event settings', async () => {
		const updates: unknown[] = [];
		const policy = {
			schemaVersion: 1 as const,
			workspaceId: id(30),
			eventId: id(31),
			eventVersion: 7,
			reviewRequired: false
		};
		const profiles: SpeakerProfilesLiveClient = {
			async read() { throw new Error('unexpected profile read'); },
			async readDirectory() { throw new Error('unexpected profile directory read'); },
			async readReviewQueue() {
				return {
					kind: 'success',
					data: { schemaVersion: 1, policy, profiles: [] },
					correlationId: id(32)
				};
			},
			async update() { throw new Error('unexpected profile update'); },
			async approve() { throw new Error('unexpected profile approval'); },
			async updateReviewPolicy(input) {
				updates.push(input);
				return {
					kind: 'success',
					data: { ...policy, eventVersion: 8, reviewRequired: true },
					receipt: {
						id: id(33),
						operationName: 'speaker.profile.review_policy.update',
						operationVersion: 1
					},
					correlationId: id(34)
				};
			}
		};
		const port = createLivePort(teamPort(), profiles);
		expect(await port.profileReview!.update(true)).toEqual({ ok: true });
		expect(updates).toEqual([{ expectedEventVersion: 7, reviewRequired: true }]);
	});
});
