export type WorkspaceTeamRoleKey =
	| 'workspace_admin'
	| 'event_manager'
	| 'speaker_manager'
	| 'speaker_reviewer'
	| 'scheduler'
	| 'communications_coordinator'
	| 'viewer';

export type WorkspaceTeamRoleName =
	| 'Workspace Admin'
	| 'Event Manager'
	| 'Speaker Manager'
	| 'Speaker Reviewer'
	| 'Scheduler'
	| 'Communications Coordinator'
	| 'Viewer';

export interface WorkspaceTeamRoleView {
	readonly key: WorkspaceTeamRoleKey;
	readonly name: WorkspaceTeamRoleName;
	readonly version: 1;
}

export type WorkspaceTeamSubjectView =
	| {
			readonly kind: 'member';
			readonly membershipId: string;
			readonly version: number;
	  }
	| {
			readonly kind: 'invitation';
			readonly reservationId: string;
			readonly version: number;
	  };

interface WorkspaceTeamMemberBaseView {
	readonly id: string;
	readonly name: string;
	readonly email: string;
	readonly role: WorkspaceTeamRoleView;
	readonly version: number;
	readonly hasAdditionalAccess: boolean;
	readonly subject: WorkspaceTeamSubjectView;
}

export type WorkspaceTeamMemberView =
	| (WorkspaceTeamMemberBaseView & {
			readonly kind: 'member';
			readonly status: 'active' | 'pending_review';
			readonly userId: string;
	  })
	| (WorkspaceTeamMemberBaseView & {
			readonly kind: 'invitation';
			readonly status: 'invited';
			readonly delivery: 'awaiting_activation';
	  });

export interface WorkspaceTeamSnapshotView {
	readonly schemaVersion: 1;
	readonly version: number;
	readonly digestSha256: string;
	readonly roles: readonly WorkspaceTeamRoleView[];
	readonly members: readonly WorkspaceTeamMemberView[];
}

export type WorkspaceTeamSafeChangeView =
	| {
			readonly action: 'invite';
			readonly recipientHint: string;
			readonly role: WorkspaceTeamRoleView;
			readonly invitationStatus: 'recorded';
			readonly delivery: 'awaiting_activation';
	  }
	| {
			readonly action: 'change_role';
			readonly subject: WorkspaceTeamSubjectView;
			readonly before: WorkspaceTeamRoleView;
			readonly after: WorkspaceTeamRoleView;
	  }
	| {
			readonly action: 'remove';
			readonly subject: WorkspaceTeamSubjectView;
			readonly before: WorkspaceTeamRoleView;
			readonly after: null;
			readonly sessionRevocation: 'not_applicable' | 'awaiting_activation';
	  };

export interface WorkspaceTeamCommittedMutationView {
  readonly action: 'invite' | 'change_role' | 'remove';
  readonly teamVersion: number;
  readonly change: WorkspaceTeamSafeChangeView;
}
