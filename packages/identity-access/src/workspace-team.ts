import type {
  WorkspaceTeamRoleKey,
  WorkspaceTeamRoleView,
  WorkspaceTeamSafeDiff,
  WorkspaceTeamSubjectRef
} from '@jooevents/contracts/workspace-team';
import type {
  Instant,
  MembershipId,
  UserId,
  WorkspaceId
} from '@jooevents/kernel';
import { ROLE_PRESETS, type PermissionId } from './permissions';
import type { ReservationId } from './identity';

export const WORKSPACE_TEAM_PERMISSIONS = Object.freeze({
  read: 'access.users.read' as PermissionId,
  invite: 'access.users.invite' as PermissionId,
  changeRole: 'access.roles.manage' as PermissionId,
  remove: 'access.users.suspend' as PermissionId
});

export type WorkspaceTeamChangeAction = 'invite' | 'change_role' | 'remove';

export function workspaceTeamRequiredPermission(action: WorkspaceTeamChangeAction): PermissionId {
  if (action === 'invite') return WORKSPACE_TEAM_PERMISSIONS.invite;
  if (action === 'change_role') return WORKSPACE_TEAM_PERMISSIONS.changeRole;
  return WORKSPACE_TEAM_PERMISSIONS.remove;
}

export function workspaceTeamRoleView(roleKey: WorkspaceTeamRoleKey): WorkspaceTeamRoleView {
  const preset = ROLE_PRESETS.find((candidate) => candidate.key === roleKey);
  if (!preset) throw new TypeError('workspace_team_role_key_unknown');
  switch (roleKey) {
    case 'workspace_admin': return { key: roleKey, name: 'Workspace Admin', version: 1 };
    case 'event_manager': return { key: roleKey, name: 'Event Manager', version: 1 };
    case 'speaker_manager': return { key: roleKey, name: 'Speaker Manager', version: 1 };
    case 'speaker_reviewer': return { key: roleKey, name: 'Speaker Reviewer', version: 1 };
    case 'scheduler': return { key: roleKey, name: 'Scheduler', version: 1 };
    case 'communications_coordinator': return {
      key: roleKey, name: 'Communications Coordinator', version: 1
    };
    case 'viewer': return { key: roleKey, name: 'Viewer', version: 1 };
  }
}

export const WORKSPACE_TEAM_ROLES: readonly WorkspaceTeamRoleView[] = Object.freeze(
  ROLE_PRESETS.map((preset) => workspaceTeamRoleView(preset.key))
);

declare const authenticatedInvitationMailboxBrand: unique symbol;

/** Opaque verified-provider mailbox evidence. It is a reservation lookup key, never identity. */
export interface AuthenticatedWorkspaceInvitationMailbox {
  readonly [authenticatedInvitationMailboxBrand]: true;
}

export interface AuthenticatedWorkspaceInvitationMailboxEvidence {
  readonly provider: string;
  readonly issuer: string;
  readonly subject: string;
  readonly normalizedEmail: string;
  readonly observedAt: string;
}

/** Implemented only by the provider-auth ceremony that owns the opaque handle. */
export interface AuthenticatedWorkspaceInvitationMailboxEvidenceSource {
  open(
    mailbox: AuthenticatedWorkspaceInvitationMailbox
  ): AuthenticatedWorkspaceInvitationMailboxEvidence | undefined;
}

export interface WorkspaceInvitationResolution {
  readonly workspaceId: WorkspaceId;
  readonly reservationId: ReservationId;
  readonly reservationVersion: number;
  readonly roleKey: WorkspaceTeamRoleKey;
}

/** Later provisioning may consume this seam after identity review; it never links a user. */
export interface AuthenticatedWorkspaceInvitationLookup {
  findOpen(input: {
    readonly workspaceId: WorkspaceId;
    readonly mailbox: AuthenticatedWorkspaceInvitationMailbox;
  }): WorkspaceInvitationResolution | undefined;
}

export interface WorkspaceTeamPrimaryRoleState {
  readonly assignmentId: string;
  readonly assignmentVersion: number;
  readonly roleId: string;
  readonly roleKey: WorkspaceTeamRoleKey;
  readonly expiresAt?: Instant;
}

export interface WorkspaceTeamMemberState {
  readonly kind: 'member';
  readonly membershipId: MembershipId;
  readonly membershipVersion: number;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly status: 'active' | 'pending_review';
  readonly primaryRole: WorkspaceTeamPrimaryRoleState;
  readonly hasAdditionalAccess: boolean;
}

export interface WorkspaceTeamInvitationState {
  readonly kind: 'invitation';
  readonly reservationId: ReservationId;
  readonly reservationVersion: number;
  readonly workspaceId: WorkspaceId;
  readonly status: 'open';
  readonly lookupBinding: string;
  readonly payloadRefId: string;
  readonly recipientHint: string;
  readonly roleId: string;
  readonly roleKey: WorkspaceTeamRoleKey;
}

export interface WorkspaceTeamPlanningSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly version: number;
  readonly digestSha256: string;
  readonly roles: ReadonlyMap<WorkspaceTeamRoleKey, { readonly id: string; readonly version: number }>;
  readonly members: readonly WorkspaceTeamMemberState[];
  readonly invitations: readonly WorkspaceTeamInvitationState[];
}

interface PlanBase {
  readonly workspaceId: WorkspaceId;
  readonly expectedTeamVersion: number;
  readonly expectedTeamDigestSha256: string;
  readonly resultingTeamVersion: number;
  readonly historyId: string;
}

export type WorkspaceTeamMutationPlan =
  | (PlanBase & {
      readonly action: 'invite';
      readonly reservationId: string;
      readonly reservationRoleAssignmentId: string;
      readonly releaseIntentId: string;
      readonly payloadRefId: string;
      readonly lookupBinding: string;
      readonly recipientHint: string;
      readonly roleId: string;
      readonly roleKey: WorkspaceTeamRoleKey;
      readonly createdByUserId: UserId;
      readonly createdAt: Instant;
    })
  | (PlanBase & {
      readonly action: 'change_role';
      readonly subject: WorkspaceTeamSubjectRef;
      readonly beforeRoleId: string;
      readonly beforeRoleKey: WorkspaceTeamRoleKey;
      readonly afterRoleId: string;
      readonly afterRoleKey: WorkspaceTeamRoleKey;
      readonly actorUserId: UserId;
      readonly changedAt: Instant;
    })
  | (PlanBase & {
      readonly action: 'remove';
      readonly subject: WorkspaceTeamSubjectRef;
      readonly beforeRoleId: string;
      readonly beforeRoleKey: WorkspaceTeamRoleKey;
      readonly actorUserId: UserId;
      readonly removedAt: Instant;
      readonly sessionRevocationIntentId?: string;
    });

export type WorkspaceTeamPlanningErrorCode =
  | 'wrong_scope'
  | 'stale_team'
  | 'subject_missing'
  | 'stale_subject'
  | 'role_unavailable'
  | 'unsupported_assignment'
  | 'duplicate_invitation'
  | 'current_actor_role_change'
  | 'current_actor_removal'
  | 'last_owner';

export class WorkspaceTeamPlanningError extends Error {
  constructor(readonly code: WorkspaceTeamPlanningErrorCode) {
    super(code);
    this.name = 'WorkspaceTeamPlanningError';
  }
}

function requireCurrentGuard(
  snapshot: WorkspaceTeamPlanningSnapshot,
  expectedVersion: number,
  expectedDigest: string
): void {
  if (snapshot.version !== expectedVersion || snapshot.digestSha256 !== expectedDigest) {
    throw new WorkspaceTeamPlanningError('stale_team');
  }
}

function role(
  snapshot: WorkspaceTeamPlanningSnapshot,
  roleKey: WorkspaceTeamRoleKey
): { readonly id: string; readonly version: number } {
  const found = snapshot.roles.get(roleKey);
  if (!found) throw new WorkspaceTeamPlanningError('role_unavailable');
  return found;
}

function subject(
  snapshot: WorkspaceTeamPlanningSnapshot,
  ref: WorkspaceTeamSubjectRef
): WorkspaceTeamMemberState | WorkspaceTeamInvitationState {
  const found = ref.kind === 'member'
    ? snapshot.members.find((candidate) => candidate.membershipId === ref.membershipId)
    : snapshot.invitations.find((candidate) => candidate.reservationId === ref.reservationId);
  if (!found) throw new WorkspaceTeamPlanningError('subject_missing');
  const version = found.kind === 'member' ? found.membershipVersion : found.reservationVersion;
  if (version !== ref.version) throw new WorkspaceTeamPlanningError('stale_subject');
  if (found.workspaceId !== snapshot.workspaceId) throw new WorkspaceTeamPlanningError('wrong_scope');
  return found;
}

function activeNonExpiringOwnerCount(snapshot: WorkspaceTeamPlanningSnapshot): number {
  return snapshot.members.filter((member) =>
    member.status === 'active'
    && member.primaryRole.roleKey === 'workspace_admin'
    && member.primaryRole.expiresAt === undefined
  ).length;
}

function guardOwnerExit(
  snapshot: WorkspaceTeamPlanningSnapshot,
  current: WorkspaceTeamMemberState
): void {
  if (current.status === 'active'
      && current.primaryRole.roleKey === 'workspace_admin'
      && current.primaryRole.expiresAt === undefined
      && activeNonExpiringOwnerCount(snapshot) <= 1) {
    throw new WorkspaceTeamPlanningError('last_owner');
  }
}

export function planWorkspaceTeamInvitation(input: {
  readonly snapshot: WorkspaceTeamPlanningSnapshot;
  readonly expectedTeamVersion: number;
  readonly expectedTeamDigestSha256: string;
  readonly roleKey: WorkspaceTeamRoleKey;
  readonly recipient: {
    readonly payloadRefId: string;
    readonly lookupBinding: string;
    readonly hint: string;
  };
  readonly ids: {
    readonly reservationId: string;
    readonly reservationRoleAssignmentId: string;
    readonly releaseIntentId: string;
    readonly historyId: string;
  };
  readonly actorUserId: UserId;
  readonly evaluatedAt: Instant;
}): WorkspaceTeamMutationPlan {
  requireCurrentGuard(
    input.snapshot, input.expectedTeamVersion, input.expectedTeamDigestSha256
  );
  if (input.snapshot.invitations.some((candidate) =>
    candidate.status === 'open' && candidate.lookupBinding === input.recipient.lookupBinding
  )) throw new WorkspaceTeamPlanningError('duplicate_invitation');
  const nextRole = role(input.snapshot, input.roleKey);
  return Object.freeze({
    action: 'invite',
    workspaceId: input.snapshot.workspaceId,
    expectedTeamVersion: input.expectedTeamVersion,
    expectedTeamDigestSha256: input.expectedTeamDigestSha256,
    resultingTeamVersion: input.expectedTeamVersion + 1,
    historyId: input.ids.historyId,
    reservationId: input.ids.reservationId,
    reservationRoleAssignmentId: input.ids.reservationRoleAssignmentId,
    releaseIntentId: input.ids.releaseIntentId,
    payloadRefId: input.recipient.payloadRefId,
    lookupBinding: input.recipient.lookupBinding,
    recipientHint: input.recipient.hint,
    roleId: nextRole.id,
    roleKey: input.roleKey,
    createdByUserId: input.actorUserId,
    createdAt: input.evaluatedAt
  });
}

export function planWorkspaceTeamRoleChange(input: {
  readonly snapshot: WorkspaceTeamPlanningSnapshot;
  readonly expectedTeamVersion: number;
  readonly expectedTeamDigestSha256: string;
  readonly subject: WorkspaceTeamSubjectRef;
  readonly roleKey: WorkspaceTeamRoleKey;
  readonly actorUserId: UserId;
  readonly evaluatedAt: Instant;
  readonly historyId: string;
}): WorkspaceTeamMutationPlan {
  requireCurrentGuard(
    input.snapshot, input.expectedTeamVersion, input.expectedTeamDigestSha256
  );
  const current = subject(input.snapshot, input.subject);
  const nextRole = role(input.snapshot, input.roleKey);
  if (current.kind === 'member') {
    if (current.hasAdditionalAccess) throw new WorkspaceTeamPlanningError('unsupported_assignment');
    if (current.userId === input.actorUserId) {
      throw new WorkspaceTeamPlanningError('current_actor_role_change');
    }
    if (current.primaryRole.roleKey === 'workspace_admin' && input.roleKey !== 'workspace_admin') {
      guardOwnerExit(input.snapshot, current);
    }
  }
  const beforeRoleId = current.kind === 'member' ? current.primaryRole.roleId : current.roleId;
  const beforeRoleKey = current.kind === 'member' ? current.primaryRole.roleKey : current.roleKey;
  return Object.freeze({
    action: 'change_role',
    workspaceId: input.snapshot.workspaceId,
    expectedTeamVersion: input.expectedTeamVersion,
    expectedTeamDigestSha256: input.expectedTeamDigestSha256,
    resultingTeamVersion: input.expectedTeamVersion + 1,
    historyId: input.historyId,
    subject: input.subject,
    beforeRoleId,
    beforeRoleKey,
    afterRoleId: nextRole.id,
    afterRoleKey: input.roleKey,
    actorUserId: input.actorUserId,
    changedAt: input.evaluatedAt
  });
}

export function planWorkspaceTeamRemoval(input: {
  readonly snapshot: WorkspaceTeamPlanningSnapshot;
  readonly expectedTeamVersion: number;
  readonly expectedTeamDigestSha256: string;
  readonly subject: WorkspaceTeamSubjectRef;
  readonly actorUserId: UserId;
  readonly evaluatedAt: Instant;
  readonly historyId: string;
  readonly sessionRevocationIntentId?: string;
}): WorkspaceTeamMutationPlan {
  requireCurrentGuard(
    input.snapshot, input.expectedTeamVersion, input.expectedTeamDigestSha256
  );
  const current = subject(input.snapshot, input.subject);
  if (current.kind === 'member') {
    if (!input.sessionRevocationIntentId) {
      throw new TypeError('workspace_team_session_revocation_intent_required');
    }
    if (current.userId === input.actorUserId) {
      throw new WorkspaceTeamPlanningError('current_actor_removal');
    }
    guardOwnerExit(input.snapshot, current);
  }
  return Object.freeze({
    action: 'remove',
    workspaceId: input.snapshot.workspaceId,
    expectedTeamVersion: input.expectedTeamVersion,
    expectedTeamDigestSha256: input.expectedTeamDigestSha256,
    resultingTeamVersion: input.expectedTeamVersion + 1,
    historyId: input.historyId,
    subject: input.subject,
    beforeRoleId: current.kind === 'member' ? current.primaryRole.roleId : current.roleId,
    beforeRoleKey: current.kind === 'member' ? current.primaryRole.roleKey : current.roleKey,
    actorUserId: input.actorUserId,
    removedAt: input.evaluatedAt,
    ...(current.kind === 'member'
      ? { sessionRevocationIntentId: input.sessionRevocationIntentId }
      : {})
  });
}

export function projectWorkspaceTeamSafeDiff(plan: WorkspaceTeamMutationPlan): WorkspaceTeamSafeDiff {
  if (plan.action === 'invite') return Object.freeze({
    action: 'invite',
    recipientHint: plan.recipientHint,
    role: workspaceTeamRoleView(plan.roleKey),
    invitationStatus: 'recorded',
    delivery: 'awaiting_activation'
  });
  if (plan.action === 'change_role') return Object.freeze({
    action: 'change_role',
    subject: plan.subject,
    before: workspaceTeamRoleView(plan.beforeRoleKey),
    after: workspaceTeamRoleView(plan.afterRoleKey)
  });
  return Object.freeze({
    action: 'remove',
    subject: plan.subject,
    before: workspaceTeamRoleView(plan.beforeRoleKey),
    after: null,
    sessionRevocation: plan.subject.kind === 'member'
      ? 'awaiting_activation'
      : 'not_applicable'
  });
}
