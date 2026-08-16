import type {
	WorkspaceTeamMutationData,
	WorkspaceTeamMemberView as WorkspaceTeamMemberDto,
	WorkspaceTeamRoleView as WorkspaceTeamRoleDto,
	WorkspaceTeamSafeDiff,
	WorkspaceTeamSnapshot
} from '@jooevents/contracts';
import type {
	WorkspaceTeamCommittedMutationView,
	WorkspaceTeamMemberView,
	WorkspaceTeamRoleView,
	WorkspaceTeamSafeChangeView,
	WorkspaceTeamSnapshotView,
	WorkspaceTeamSubjectView
} from '../view-models/workspace-team';

function unreachable(value: never): never {
	throw new TypeError(`Unsupported Workspace Team contract variant: ${JSON.stringify(value)}`);
}

export function mapWorkspaceTeamRole(role: WorkspaceTeamRoleDto): WorkspaceTeamRoleView {
	return Object.freeze({ key: role.key, name: role.name, version: role.version });
}

export function mapWorkspaceTeamSubject(
	member: Pick<WorkspaceTeamMemberDto, 'kind' | 'id' | 'version'>
): WorkspaceTeamSubjectView {
	return member.kind === 'member'
		? Object.freeze({ kind: 'member', membershipId: member.id, version: member.version })
		: Object.freeze({ kind: 'invitation', reservationId: member.id, version: member.version });
}

export function mapWorkspaceTeamMember(member: WorkspaceTeamMemberDto): WorkspaceTeamMemberView {
	const common = {
		id: member.id,
		name: member.name,
		email: member.email,
		role: mapWorkspaceTeamRole(member.role),
		version: member.version,
		hasAdditionalAccess: member.hasAdditionalAccess,
		subject: mapWorkspaceTeamSubject(member)
	} as const;
	if (member.status === 'active' || member.status === 'pending_review') {
		return Object.freeze({
			...common,
			kind: member.kind,
			status: member.status,
			userId: member.userId
		});
	}
	if (member.status === 'invited') {
		return Object.freeze({
			...common,
			kind: member.kind,
			status: member.status,
			delivery: member.delivery
		});
	}
	return unreachable(member);
}

export function mapWorkspaceTeamSnapshot(
	snapshot: WorkspaceTeamSnapshot
): WorkspaceTeamSnapshotView {
	return Object.freeze({
		schemaVersion: snapshot.schemaVersion,
		version: snapshot.version,
		digestSha256: snapshot.digestSha256,
		roles: Object.freeze(snapshot.roles.map(mapWorkspaceTeamRole)),
		members: Object.freeze(snapshot.members.map(mapWorkspaceTeamMember))
	});
}

function mapSubject(subject: Extract<WorkspaceTeamSafeDiff,
	{ readonly action: 'change_role' | 'remove' }>['subject']): WorkspaceTeamSubjectView {
	return subject.kind === 'member'
		? Object.freeze({
				kind: subject.kind,
				membershipId: subject.membershipId,
				version: subject.version
			})
		: Object.freeze({
				kind: subject.kind,
				reservationId: subject.reservationId,
				version: subject.version
			});
}

export function mapWorkspaceTeamSafeChange(
	diff: WorkspaceTeamSafeDiff
): WorkspaceTeamSafeChangeView {
	switch (diff.action) {
		case 'invite':
			return Object.freeze({
				action: diff.action,
				recipientHint: diff.recipientHint,
				role: mapWorkspaceTeamRole(diff.role),
				invitationStatus: diff.invitationStatus,
				delivery: diff.delivery
			});
		case 'change_role':
			return Object.freeze({
				action: diff.action,
				subject: mapSubject(diff.subject),
				before: mapWorkspaceTeamRole(diff.before),
				after: mapWorkspaceTeamRole(diff.after)
			});
		case 'remove':
			return Object.freeze({
				action: diff.action,
				subject: mapSubject(diff.subject),
				before: mapWorkspaceTeamRole(diff.before),
				after: diff.after,
				sessionRevocation: diff.sessionRevocation
			});
		default:
			return unreachable(diff);
	}
}

export function mapWorkspaceTeamMutation(
	mutation: WorkspaceTeamMutationData
): WorkspaceTeamCommittedMutationView {
	if (mutation.action !== mutation.safeDiff.action) {
		throw new TypeError('Workspace Team mutation action does not match its safe diff.');
	}
	return Object.freeze({
		action: mutation.action,
		teamVersion: mutation.teamVersion,
		change: mapWorkspaceTeamSafeChange(mutation.safeDiff)
	});
}
