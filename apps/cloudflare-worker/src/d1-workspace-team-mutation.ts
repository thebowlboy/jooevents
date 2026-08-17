import {
  WORKSPACE_INVITATION_CLASSIFIED_PROFILES,
  WORKSPACE_INVITATION_RECIPIENT_CONTENT_TYPE,
  WORKSPACE_INVITATION_RECIPIENT_PURPOSE,
  WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY,
  WORKSPACE_TEAM_OPERATION_ACCESS,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  sealWorkspaceTeamMutationPreparation,
  workspaceTeamMutationActionForOperation,
  workspaceTeamMutationContributionSchema,
  workspaceTeamMutationDomainContributionSchema,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult,
  type WorkspaceTeamMutationAction,
  type WorkspaceTeamMutationContribution
} from '@jooevents/application';
import {
  adoptSynchronousClassifiedPayload,
  openSynchronousClassifiedPayloadAdoptionReceipt
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  workspaceTeamInviteInputSchema,
  workspaceTeamRemovalInputSchema,
  workspaceTeamRoleChangeInputSchema,
  type WorkspaceTeamRoleKey,
  type WorkspaceTeamSnapshot
} from '@jooevents/contracts';
import {
  normalizeEmail,
  planWorkspaceTeamInvitation,
  planWorkspaceTeamRemoval,
  planWorkspaceTeamRoleChange,
  projectWorkspaceTeamSafeDiff,
  WorkspaceTeamPlanningError,
  WORKSPACE_TEAM_ROLES,
  type WorkspaceTeamInvitationState,
  type WorkspaceTeamMemberState,
  type WorkspaceTeamMutationPlan,
  type WorkspaceTeamPlanningSnapshot
} from '@jooevents/identity-access';
import {
  canonicalJsonText,
  createPayloadRef,
  parseInstant,
  parseMembershipId,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import { createHash, createHmac } from 'node:crypto';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import { D1BufferedClassifiedPayloadStore } from './d1-classified-payload-store';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';
import { readD1WorkspaceTeamSnapshot } from './d1-workspace-team';
import type { ImmutableClassifiedPayloadRecordCodecOptions } from '@jooevents/application/immutable-classified-payload-record';

interface RoleRow {
  readonly id: string;
  readonly role_key: string;
  readonly preset_version: number;
  readonly role_version: number;
}
interface AssignmentRow {
  readonly membership_id: string;
  readonly assignment_id: string;
  readonly assignment_version: number;
  readonly role_id: string;
  readonly role_key: string;
  readonly role_preset_version: number;
  readonly expires_at: number | null;
}
interface InvitationRow {
  readonly reservation_id: string;
  readonly reservation_version: number;
  readonly lookup_binding: string;
  readonly payload_ref_id: string;
  readonly recipient_hint: string;
  readonly role_id: string;
  readonly role_key: string;
  readonly role_preset_version: number;
}

type MutationSuccess = Extract<
  WorkspaceTeamMutationContribution,
  { result: { kind: 'success' } }
>;

interface PreparedMutation {
  readonly handle: string;
  readonly contribution: MutationSuccess;
  readonly plan: WorkspaceTeamMutationPlan;
  readonly resultingDigestSha256: string;
  readonly invitationEmail?: string;
}

export interface D1WorkspaceTeamMutationIds {
  newPreparationHandle(): string;
  newReservationId(): string;
  newReservationRoleAssignmentId(): string;
  newReleaseIntentId(): string;
  newHistoryId(): string;
  newPayloadRefId(): string;
  newSessionRevocationIntentId(): string;
}

function roleKey(value: string): WorkspaceTeamRoleKey {
  const role = WORKSPACE_TEAM_ROLES.find((candidate) => candidate.key === value);
  if (!role) throw new TypeError('d1_workspace_team_data_corrupt');
  return role.key;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value)).digest('hex');
}

function stateDigest(input: {
  readonly roles: ReadonlyMap<WorkspaceTeamRoleKey, { readonly id: string; readonly version: number }>;
  readonly members: readonly WorkspaceTeamMemberState[];
  readonly invitations: readonly WorkspaceTeamInvitationState[];
}): string {
  return digest({
    schemaVersion: 1,
    roles: WORKSPACE_TEAM_ROLES.map((role) => ({ ...role, id: input.roles.get(role.key)?.id })),
    members: input.members.map((member) => ({
      membershipId: member.membershipId,
      version: member.membershipVersion,
      status: member.status,
      userId: parseUserId(member.userId),
      role: member.primaryRole,
      hasAdditionalAccess: member.hasAdditionalAccess
    })),
    invitations: input.invitations.map((invitation) => ({
      reservationId: invitation.reservationId,
      version: invitation.reservationVersion,
      lookupBinding: invitation.lookupBinding,
      payloadRefId: invitation.payloadRefId,
      roleId: invitation.roleId,
      roleKey: invitation.roleKey
    }))
  });
}

function planningRefusal(
  error: WorkspaceTeamPlanningError,
  action: WorkspaceTeamMutationAction
): WorkspaceTeamMutationContribution {
  const stale = error.code === 'stale_team' || error.code === 'stale_subject';
  const policy = [
    'unsupported_assignment', 'current_actor_role_change',
    'current_actor_removal', 'last_owner'
  ].includes(error.code);
  return workspaceTeamMutationContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: stale ? 'stale_revision' : policy ? 'policy_violation' : 'conflict',
        kind: 'workspace_team.change_refused',
        retryable: false,
        subjects: [],
        detail: { code: error.code, action },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: []
  });
}

function permissionFor(action: WorkspaceTeamMutationAction): string {
  if (action === 'invite') return WORKSPACE_TEAM_OPERATION_ACCESS.invite.permissionId;
  if (action === 'change_role') return WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.permissionId;
  return WORKSPACE_TEAM_OPERATION_ACCESS.remove.permissionId;
}

function policyFor(action: WorkspaceTeamMutationAction) {
  if (action === 'invite') return WORKSPACE_TEAM_OPERATION_ACCESS.invite.policy;
  if (action === 'change_role') return WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.policy;
  return WORKSPACE_TEAM_OPERATION_ACCESS.remove.policy;
}

function exactWorkspaceSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId === undefined
    && context.scope.subjects.length === 1
    && context.scope.subjects[0]?.kind === 'workspace'
    && context.scope.subjects[0].id === context.scope.workspaceId;
}

function invitationLookupBinding(input: {
  readonly keyBytes: Uint8Array;
  readonly workspaceId: WorkspaceId;
  readonly normalizedEmail: string;
}): string {
  return createHmac('sha256', input.keyBytes).update(canonicalJsonText({
    workspaceId: input.workspaceId,
    normalizedEmail: input.normalizedEmail
  })).digest('hex');
}

function invitationRecipientHint(lookupBinding: string): string {
  if (!/^[a-f0-9]{64}$/.test(lookupBinding)) {
    throw new TypeError('d1_workspace_invitation_lookup_binding_invalid');
  }
  return `recipient-${lookupBinding.slice(0, 12)}`;
}

async function readPlanningSnapshot(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly workspaceId: WorkspaceId;
  readonly nowEpochMs: number;
  readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
}): Promise<WorkspaceTeamPlanningSnapshot> {
  const view = await readD1WorkspaceTeamSnapshot({
    database: input.unitOfWork.readSession,
    workspaceId: input.workspaceId,
    nowEpochMs: input.nowEpochMs,
    classifiedPayload: input.classifiedPayload
  });
  const [roleResult, assignmentResult, invitationResult] = await input.unitOfWork.readSession.batch([
    input.unitOfWork.readSession.prepare(`SELECT id,source_preset_key AS role_key,
      source_preset_version AS preset_version,version AS role_version
      FROM roles WHERE workspace_id = ? AND archived_at IS NULL
        AND source_preset_key IS NOT NULL
      ORDER BY source_preset_key COLLATE BINARY`).bind(input.workspaceId),
    input.unitOfWork.readSession.prepare(`SELECT m.id AS membership_id,a.id AS assignment_id,
      a.version AS assignment_version,a.role_id,r.source_preset_key AS role_key,
      r.source_preset_version AS role_preset_version,a.expires_at
      FROM workspace_memberships m
      JOIN role_assignments a ON a.workspace_id = m.workspace_id AND a.user_id = m.user_id
        AND a.scope_kind = 'workspace' AND a.event_id IS NULL
        AND (a.expires_at IS NULL OR a.expires_at > ?)
      JOIN roles r ON r.id = a.role_id
      WHERE m.workspace_id = ? AND m.status IN ('active','pending_review')
      ORDER BY m.id COLLATE BINARY,a.id COLLATE BINARY`)
      .bind(input.nowEpochMs, input.workspaceId),
    input.unitOfWork.readSession.prepare(`SELECT r.id AS reservation_id,
      r.version AS reservation_version,recipient.lookup_binding,recipient.payload_ref_id,
      recipient.recipient_hint,assignment.role_id,role.source_preset_key AS role_key,
      role.source_preset_version AS role_preset_version
      FROM access_reservations r
      JOIN workspace_team_invitation_recipients recipient ON recipient.reservation_id = r.id
      JOIN reservation_role_assignments assignment ON assignment.reservation_id = r.id
        AND assignment.scope_kind = 'workspace' AND assignment.event_id IS NULL
      JOIN roles role ON role.id = assignment.role_id
      WHERE r.workspace_id = ? AND r.status = 'open'
      ORDER BY r.id COLLATE BINARY`).bind(input.workspaceId)
  ]);
  const roles = new Map<WorkspaceTeamRoleKey, { readonly id: string; readonly version: number }>();
  for (const row of (roleResult as D1Result<RoleRow>).results) {
    const key = roleKey(row.role_key);
    if (row.preset_version !== 1 || roles.has(key)) {
      throw new TypeError('d1_workspace_team_role_corrupt');
    }
    roles.set(key, Object.freeze({ id: row.id, version: row.role_version }));
  }
  if (roles.size !== WORKSPACE_TEAM_ROLES.length) {
    throw new TypeError('d1_workspace_team_roles_incomplete');
  }
  const assignments = (assignmentResult as D1Result<AssignmentRow>).results;
  const memberViews = view.members.filter(
    (member): member is Extract<WorkspaceTeamSnapshot['members'][number], { kind: 'member' }> =>
      member.kind === 'member'
  );
  const members = memberViews.map((member) => {
    const matches = assignments.filter((row) => row.membership_id === member.id);
    const row = matches[0];
    if (matches.length !== 1 || !row || row.role_preset_version !== 1
        || roleKey(row.role_key) !== member.role.key) {
      throw new TypeError('d1_workspace_team_assignment_corrupt');
    }
    return Object.freeze({
      kind: 'member' as const,
      membershipId: parseMembershipId(member.id),
      membershipVersion: member.version,
      workspaceId: input.workspaceId,
      userId: parseUserId(member.userId),
      status: member.status,
      primaryRole: Object.freeze({
        assignmentId: row.assignment_id,
        assignmentVersion: row.assignment_version,
        roleId: row.role_id,
        roleKey: member.role.key,
        ...(row.expires_at === null
          ? {}
          : { expiresAt: parseInstant(new Date(row.expires_at).toISOString()) })
      }),
      hasAdditionalAccess: member.hasAdditionalAccess
    });
  });
  const invitationRows = (invitationResult as D1Result<InvitationRow>).results;
  const invitations = view.members
    .filter((member) => member.kind === 'invitation')
    .map((member) => {
      const matches = invitationRows.filter((row) => row.reservation_id === member.id);
      const row = matches[0];
      if (matches.length !== 1 || !row || row.role_preset_version !== 1
          || roleKey(row.role_key) !== member.role.key) {
        throw new TypeError('d1_workspace_team_invitation_corrupt');
      }
      return Object.freeze({
        kind: 'invitation' as const,
        reservationId: member.id,
        reservationVersion: member.version,
        workspaceId: input.workspaceId,
        status: 'open' as const,
        lookupBinding: row.lookup_binding,
        payloadRefId: row.payload_ref_id,
        recipientHint: row.recipient_hint,
        roleId: row.role_id,
        roleKey: member.role.key
      });
    });
  const snapshot = Object.freeze({
    workspaceId: input.workspaceId,
    version: view.version,
    digestSha256: view.digestSha256,
    roles,
    members: Object.freeze(members),
    invitations: Object.freeze(invitations)
  });
  if (stateDigest(snapshot) !== view.digestSha256) {
    throw new TypeError('d1_workspace_team_planning_digest_mismatch');
  }
  guardPlanningSnapshot(input.unitOfWork, snapshot);
  return snapshot;
}

function guardPlanningSnapshot(
  unitOfWork: D1BufferedUnitOfWork,
  snapshot: WorkspaceTeamPlanningSnapshot
): void {
  unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM workspace_team_heads
    WHERE workspace_id = ? AND team_version = ? AND team_digest_sha256 = ?)`, [
    snapshot.workspaceId, snapshot.version, snapshot.digestSha256
  ]);
  unitOfWork.assertCurrent(`(SELECT count(*) FROM roles
    WHERE workspace_id = ? AND archived_at IS NULL AND source_preset_key IS NOT NULL) = ?`, [
    snapshot.workspaceId, snapshot.roles.size
  ]);
  for (const [key, role] of snapshot.roles) {
    unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM roles
      WHERE id = ? AND workspace_id = ? AND source_preset_key = ?
        AND source_preset_version = 1 AND version = ? AND archived_at IS NULL)`, [
      role.id, snapshot.workspaceId, key, role.version
    ]);
  }
  unitOfWork.assertCurrent(`(SELECT count(*) FROM workspace_memberships m
    WHERE m.workspace_id = ? AND m.status IN ('active','pending_review')
      AND EXISTS (SELECT 1 FROM role_assignments a
        WHERE a.workspace_id = m.workspace_id AND a.user_id = m.user_id
          AND a.scope_kind = 'workspace' AND a.event_id IS NULL)) = ?`, [
    snapshot.workspaceId, snapshot.members.length
  ]);
  for (const member of snapshot.members) {
    unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM workspace_memberships
      WHERE id = ? AND workspace_id = ? AND user_id = ? AND status = ? AND version = ?)`, [
      member.membershipId, snapshot.workspaceId, member.userId,
      member.status, member.membershipVersion
    ]);
    unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM role_assignments
      WHERE id = ? AND user_id = ? AND role_id = ? AND workspace_id = ?
        AND scope_kind = 'workspace' AND event_id IS NULL AND version = ?
        AND expires_at IS ?)`, [
      member.primaryRole.assignmentId,
      member.userId,
      member.primaryRole.roleId,
      snapshot.workspaceId,
      member.primaryRole.assignmentVersion,
      member.primaryRole.expiresAt === undefined
        ? null
        : Date.parse(member.primaryRole.expiresAt)
    ]);
    const otherAccess = `(EXISTS (SELECT 1 FROM role_assignments a
      WHERE a.workspace_id = ? AND a.user_id = ?
        AND NOT (a.scope_kind = 'workspace' AND a.event_id IS NULL))
      OR EXISTS (SELECT 1 FROM permission_overrides o
        WHERE o.workspace_id = ? AND o.user_id = ?))`;
    unitOfWork.assertCurrent(
      member.hasAdditionalAccess ? otherAccess : `NOT ${otherAccess}`,
      [snapshot.workspaceId, member.userId, snapshot.workspaceId, member.userId]
    );
  }
  unitOfWork.assertCurrent(`(SELECT count(*) FROM access_reservations r
    JOIN workspace_team_invitation_recipients recipient ON recipient.reservation_id = r.id
    WHERE r.workspace_id = ? AND r.status = 'open') = ?`, [
    snapshot.workspaceId, snapshot.invitations.length
  ]);
  for (const invitation of snapshot.invitations) {
    unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM access_reservations r
      JOIN workspace_team_invitation_recipients recipient ON recipient.reservation_id = r.id
      JOIN reservation_role_assignments assignment ON assignment.reservation_id = r.id
        AND assignment.scope_kind = 'workspace' AND assignment.event_id IS NULL
      WHERE r.id = ? AND r.workspace_id = ? AND r.status = 'open' AND r.version = ?
        AND recipient.lookup_binding = ? AND recipient.payload_ref_id = ?
        AND recipient.recipient_hint = ? AND assignment.role_id = ?)`, [
      invitation.reservationId,
      snapshot.workspaceId,
      invitation.reservationVersion,
      invitation.lookupBinding,
      invitation.payloadRefId,
      invitation.recipientHint,
      invitation.roleId
    ]);
  }
}

function resultingSnapshot(
  snapshot: WorkspaceTeamPlanningSnapshot,
  plan: WorkspaceTeamMutationPlan
): WorkspaceTeamPlanningSnapshot {
  let members = [...snapshot.members];
  let invitations = [...snapshot.invitations];
  if (plan.action === 'invite') {
    invitations.push(Object.freeze({
      kind: 'invitation' as const,
      reservationId: plan.reservationId,
      reservationVersion: 1,
      workspaceId: plan.workspaceId,
      status: 'open' as const,
      lookupBinding: plan.lookupBinding,
      payloadRefId: plan.payloadRefId,
      recipientHint: plan.recipientHint,
      roleId: plan.roleId,
      roleKey: plan.roleKey
    }));
  } else if (plan.action === 'change_role') {
    const subject = plan.subject;
    if (subject.kind === 'member') {
      members = members.map((member) => member.membershipId === subject.membershipId
        ? Object.freeze({
            ...member,
            membershipVersion: member.membershipVersion + 1,
            primaryRole: Object.freeze({
              ...member.primaryRole,
              assignmentVersion: member.primaryRole.assignmentVersion + 1,
              roleId: plan.afterRoleId,
              roleKey: plan.afterRoleKey
            })
          })
        : member);
    } else {
      invitations = invitations.map((invitation) =>
        invitation.reservationId === subject.reservationId
          ? Object.freeze({
              ...invitation,
              reservationVersion: invitation.reservationVersion + 1,
              roleId: plan.afterRoleId,
              roleKey: plan.afterRoleKey
            })
          : invitation
      );
    }
  } else if (plan.action === 'remove') {
    const subject = plan.subject;
    if (subject.kind === 'member') {
      members = members.filter((member) => member.membershipId !== subject.membershipId);
    } else {
      invitations = invitations.filter(
        (invitation) => invitation.reservationId !== subject.reservationId
      );
    }
  }
  members.sort((left, right) => left.membershipId.localeCompare(right.membershipId));
  invitations.sort((left, right) => left.reservationId.localeCompare(right.reservationId));
  return Object.freeze({
    ...snapshot,
    version: plan.resultingTeamVersion,
    members: Object.freeze(members),
    invitations: Object.freeze(invitations),
    digestSha256: stateDigest({ roles: snapshot.roles, members, invitations })
  });
}

export class D1WorkspaceTeamMutationEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #issued = new Set<string>();
  readonly #prepared = new Map<string, PreparedMutation>();
  readonly #lookupKeyBytes: Uint8Array;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
    readonly invitationLookupKeyBytes: Uint8Array;
    readonly ids: D1WorkspaceTeamMutationIds;
    readonly nowEpochMs: () => number;
  }) {
    this.#lookupKeyBytes = Uint8Array.from(input.invitationLookupKeyBytes);
    if (this.#lookupKeyBytes.byteLength < 32) {
      throw new TypeError('d1_workspace_invitation_lookup_key_invalid');
    }
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (capability.key !== WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY.key
        || capability.version !== WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY.version) {
      throw new TypeError('d1_workspace_team_mutation_capability_mismatch');
    }
    const action = workspaceTeamMutationActionForOperation(
      context.operation.name, context.operation.version
    );
    if (!action || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactWorkspaceSubjects(context)) {
      throw new TypeError('d1_workspace_team_mutation_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    const expectedPolicy = policyFor(action);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || authority.lane.policy.key !== expectedPolicy.key
        || authority.lane.policy.version !== expectedPolicy.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === permissionFor(action)
        )) {
      throw new TypeError('d1_workspace_team_mutation_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const snapshot = await readPlanningSnapshot({
      unitOfWork: this.input.unitOfWork,
      workspaceId: this.input.workspaceId,
      nowEpochMs: this.input.nowEpochMs(),
      classifiedPayload: this.input.classifiedPayload
    });
    return sealWorkspaceTeamMutationPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }) => {
          if (receivedAction !== action || receivedContext !== context) {
            throw new TypeError('d1_workspace_team_mutation_context_substitution');
          }
          const handle = this.#fresh(this.input.ids.newPreparationHandle);
          let plan: WorkspaceTeamMutationPlan;
          let invitationEmail: string | undefined;
          try {
            if (action === 'invite') {
              const request = workspaceTeamInviteInputSchema.parse(businessInput);
              invitationEmail = normalizeEmail(request.email);
              const lookupBinding = invitationLookupBinding({
                keyBytes: this.#lookupKeyBytes,
                workspaceId: this.input.workspaceId,
                normalizedEmail: invitationEmail
              });
              plan = planWorkspaceTeamInvitation({
                snapshot,
                expectedTeamVersion: request.expectedTeamVersion,
                expectedTeamDigestSha256: request.expectedTeamDigestSha256,
                roleKey: request.roleKey,
                recipient: {
                  payloadRefId: this.#fresh(this.input.ids.newPayloadRefId),
                  lookupBinding,
                  hint: invitationRecipientHint(lookupBinding)
                },
                ids: {
                  reservationId: this.#fresh(this.input.ids.newReservationId),
                  reservationRoleAssignmentId: this.#fresh(
                    this.input.ids.newReservationRoleAssignmentId
                  ),
                  releaseIntentId: this.#fresh(this.input.ids.newReleaseIntentId),
                  historyId: this.#fresh(this.input.ids.newHistoryId)
                },
                actorUserId,
                evaluatedAt
              });
            } else if (action === 'change_role') {
              const request = workspaceTeamRoleChangeInputSchema.parse(businessInput);
              plan = planWorkspaceTeamRoleChange({
                snapshot,
                expectedTeamVersion: request.expectedTeamVersion,
                expectedTeamDigestSha256: request.expectedTeamDigestSha256,
                subject: request.subject,
                roleKey: request.roleKey,
                actorUserId,
                evaluatedAt,
                historyId: this.#fresh(this.input.ids.newHistoryId)
              });
            } else {
              const request = workspaceTeamRemovalInputSchema.parse(businessInput);
              plan = planWorkspaceTeamRemoval({
                snapshot,
                expectedTeamVersion: request.expectedTeamVersion,
                expectedTeamDigestSha256: request.expectedTeamDigestSha256,
                subject: request.subject,
                actorUserId,
                evaluatedAt,
                historyId: this.#fresh(this.input.ids.newHistoryId),
                ...(request.subject.kind === 'member'
                  ? { sessionRevocationIntentId: this.#fresh(
                      this.input.ids.newSessionRevocationIntentId
                    ) }
                  : {})
              });
            }
            const after = resultingSnapshot(snapshot, plan);
            const contribution = workspaceTeamMutationContributionSchema.parse({
              result: {
                kind: 'success',
                data: {
                  schemaVersion: 1,
                  action,
                  teamVersion: plan.resultingTeamVersion,
                  safeDiff: projectWorkspaceTeamSafeDiff(plan)
                }
              },
              domain: {
                kind: 'workspace_team_direct_mutation',
                preparationHandle: handle,
                action,
                workspaceId: this.input.workspaceId,
                resultingTeamVersion: plan.resultingTeamVersion,
                occurredAt: evaluatedAt
              },
              effectContributions: []
            });
            if (contribution.result.kind !== 'success' || !contribution.domain) {
              throw new TypeError('d1_workspace_team_mutation_contribution_invalid');
            }
            const success = contribution as MutationSuccess;
            this.#prepared.set(handle, {
              handle,
              contribution: success,
              plan,
              resultingDigestSha256: after.digestSha256,
              ...(invitationEmail === undefined ? {} : { invitationEmail })
            });
            return success;
          } catch (error) {
            if (error instanceof WorkspaceTeamPlanningError) {
              return planningRefusal(error, action);
            }
            throw error;
          }
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const parsed = workspaceTeamMutationDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('d1_workspace_team_mutation_preparation_invalid');
    }
    if (prepared.plan.action === 'invite') {
      if (prepared.invitationEmail === undefined) {
        throw new TypeError('d1_workspace_team_invitation_email_missing');
      }
      this.#adoptInvitationRecipient(prepared.plan, prepared.invitationEmail);
    }
    this.#applyPlan(prepared.plan, prepared.resultingDigestSha256);
    this.#prepared.delete(parsed.preparationHandle);
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared.clear();
    this.#lookupKeyBytes.fill(0);
  }

  #adoptInvitationRecipient(
    plan: Extract<WorkspaceTeamMutationPlan, { action: 'invite' }>,
    email: string
  ): void {
    const store = new D1BufferedClassifiedPayloadStore({
      ...this.input.classifiedPayload,
      unitOfWork: this.input.unitOfWork
    });
    const bytes = new TextEncoder().encode(canonicalJsonText({ email }));
    const binding = {
      profiles: WORKSPACE_INVITATION_CLASSIFIED_PROFILES,
      scopeBinding: `workspace:${plan.workspaceId}/reservation:${plan.reservationId}`,
      contentType: WORKSPACE_INVITATION_RECIPIENT_CONTENT_TYPE
    };
    try {
      const receipt = adoptSynchronousClassifiedPayload({
        store,
        put: {
          payloadRefId: parsePayloadRefId(plan.payloadRefId),
          binding,
          purpose: WORKSPACE_INVITATION_RECIPIENT_PURPOSE,
          bytes,
          createdAt: plan.createdAt
        }
      });
      openSynchronousClassifiedPayloadAdoptionReceipt({
        receipt,
        expectedStore: store,
        expected: {
          binding,
          purpose: WORKSPACE_INVITATION_RECIPIENT_PURPOSE,
          bytes
        }
      });
    } finally {
      bytes.fill(0);
    }
  }

  #applyPlan(plan: WorkspaceTeamMutationPlan, resultingDigestSha256: string): void {
    if (plan.action === 'invite') {
      this.input.unitOfWork.write(`INSERT INTO access_reservations
        (id,workspace_id,normalized_email,status,created_by_user_id,created_at,version)
        VALUES (?,? ,?,'open',?,?,1)`, [
        plan.reservationId,
        plan.workspaceId,
        plan.lookupBinding,
        plan.createdByUserId,
        Date.parse(plan.createdAt)
      ]);
      this.input.unitOfWork.write(`INSERT INTO reservation_role_assignments
        (id,reservation_id,role_id,scope_kind,event_id)
        VALUES (?,?,?,'workspace',NULL)`, [
        plan.reservationRoleAssignmentId, plan.reservationId, plan.roleId
      ]);
      this.input.unitOfWork.write(`INSERT INTO workspace_team_invitation_recipients
        (reservation_id,workspace_id,payload_ref_id,lookup_binding,recipient_hint,created_at_ms)
        VALUES (?,?,?,?,?,?)`, [
        plan.reservationId, plan.workspaceId, plan.payloadRefId,
        plan.lookupBinding, plan.recipientHint, Date.parse(plan.createdAt)
      ]);
      this.input.unitOfWork.write(`INSERT INTO workspace_team_invitation_release_intents
        (id,reservation_id,workspace_id,status,created_at_ms)
        VALUES (?,?,?,'awaiting_activation',?)`, [
        plan.releaseIntentId, plan.reservationId, plan.workspaceId, Date.parse(plan.createdAt)
      ]);
    } else if (plan.action === 'change_role') {
      const subject = plan.subject;
      if (subject.kind === 'member') {
        this.input.unitOfWork.write(`UPDATE role_assignments
          SET role_id = ?,assigned_by_user_id = ?,assigned_at = ?,version = version + 1
          WHERE workspace_id = ? AND user_id = (
            SELECT user_id FROM workspace_memberships WHERE id = ?)
            AND scope_kind = 'workspace' AND event_id IS NULL AND role_id = ?`, [
          plan.afterRoleId, plan.actorUserId, Date.parse(plan.changedAt),
          plan.workspaceId, subject.membershipId, plan.beforeRoleId
        ]);
        this.input.unitOfWork.write(`UPDATE workspace_memberships
          SET version = version + 1,updated_at = ? WHERE id = ? AND version = ?`, [
          Date.parse(plan.changedAt), subject.membershipId, subject.version
        ]);
      } else {
        this.input.unitOfWork.write(`UPDATE reservation_role_assignments SET role_id = ?
          WHERE reservation_id = ? AND role_id = ?`, [
          plan.afterRoleId, subject.reservationId, plan.beforeRoleId
        ]);
        this.input.unitOfWork.write(`UPDATE access_reservations SET version = version + 1
          WHERE id = ? AND version = ?`, [subject.reservationId, subject.version]);
      }
    } else if (plan.action === 'remove') {
      const subject = plan.subject;
      if (subject.kind === 'member') {
        this.input.unitOfWork.write(`UPDATE workspace_memberships
          SET status = 'deactivated',updated_at = ?,version = version + 1
          WHERE id = ? AND workspace_id = ? AND version = ?
            AND status IN ('active','pending_review')`, [
          Date.parse(plan.removedAt), subject.membershipId,
          plan.workspaceId, subject.version
        ]);
        this.input.unitOfWork.write(`INSERT INTO workspace_team_session_revocation_intents
          (id,membership_id,workspace_id,user_id,status,created_at_ms)
          SELECT ?,id,workspace_id,user_id,'awaiting_activation',?
            FROM workspace_memberships WHERE id = ?`, [
          plan.sessionRevocationIntentId,
          Date.parse(plan.removedAt),
          subject.membershipId
        ]);
      } else {
        this.input.unitOfWork.write(`UPDATE access_reservations
          SET status = 'revoked',version = version + 1
          WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'open'`, [
          subject.reservationId, plan.workspaceId, subject.version
        ]);
        this.input.unitOfWork.write(`UPDATE workspace_team_invitation_release_intents
          SET status = 'cancelled',cancelled_at_ms = ?
          WHERE reservation_id = ? AND workspace_id = ? AND status = 'awaiting_activation'`, [
          Date.parse(plan.removedAt), subject.reservationId, plan.workspaceId
        ]);
      }
    }
    this.input.unitOfWork.write(`UPDATE workspace_team_heads
      SET team_version = ?,team_digest_sha256 = ?
      WHERE workspace_id = ? AND team_version = ? AND team_digest_sha256 = ?`, [
      plan.resultingTeamVersion,
      resultingDigestSha256,
      plan.workspaceId,
      plan.expectedTeamVersion,
      plan.expectedTeamDigestSha256
    ]);
    const subject = plan.action === 'invite'
      ? { kind: 'invitation', id: plan.reservationId }
      : plan.subject.kind === 'member'
        ? { kind: 'member', id: plan.subject.membershipId }
        : { kind: 'invitation', id: plan.subject.reservationId };
    const evidence = plan.action === 'invite'
      ? {
          schemaVersion: 1,
          action: 'invite_recorded',
          roleKey: plan.roleKey,
          recipientHint: plan.recipientHint,
          delivery: 'awaiting_activation'
        }
      : plan.action === 'change_role'
        ? {
            schemaVersion: 1,
            action: 'role_changed',
            beforeRoleKey: plan.beforeRoleKey,
            afterRoleKey: plan.afterRoleKey
          }
        : {
            schemaVersion: 1,
            action: 'access_revoked',
            beforeRoleKey: plan.beforeRoleKey,
            sessionRevocation: plan.subject.kind === 'member'
              ? 'awaiting_activation'
              : 'not_applicable'
          };
    this.input.unitOfWork.write(`INSERT INTO workspace_team_history
      (id,workspace_id,action,subject_kind,subject_id,actor_user_id,
       evidence_json,occurred_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`, [
      plan.historyId,
      plan.workspaceId,
      evidence.action,
      subject.kind,
      subject.id,
      plan.action === 'invite' ? plan.createdByUserId : plan.actorUserId,
      canonicalJsonText(evidence),
      Date.parse(plan.action === 'invite'
        ? plan.createdAt
        : plan.action === 'change_role'
          ? plan.changedAt
          : plan.removedAt)
    ]);
  }

  #fresh(factory: () => string): string {
    const value = factory.call(this.input.ids);
    if (typeof value !== 'string' || this.#issued.has(value)) {
      throw new TypeError('d1_workspace_team_mutation_id_invalid');
    }
    this.#issued.add(value);
    return value;
  }
}

export function createD1WorkspaceTeamMutationEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
  readonly invitationLookupKeyBytes: Uint8Array;
  readonly ids: D1WorkspaceTeamMutationIds;
  readonly nowEpochMs?: () => number;
}): D1EffectDomainAdapterRegistration {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const keyBytes = Uint8Array.from(input.invitationLookupKeyBytes);
  if (keyBytes.byteLength < 32) {
    throw new TypeError('d1_workspace_invitation_lookup_key_invalid');
  }
  return Object.freeze({
    capability: WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY,
    create(unitOfWork: D1BufferedUnitOfWork) {
      return new D1WorkspaceTeamMutationEffectDomainAdapter({
        unitOfWork,
        workspaceId,
        classifiedPayload: input.classifiedPayload,
        invitationLookupKeyBytes: keyBytes,
        ids: input.ids,
        nowEpochMs: input.nowEpochMs ?? Date.now
      });
    }
  });
}
