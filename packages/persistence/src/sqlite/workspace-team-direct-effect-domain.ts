import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  sealWorkspaceTeamMutationPreparation,
  workspaceTeamMutationActionForOperation,
  workspaceTeamMutationContributionSchema,
  workspaceTeamMutationDomainContributionSchema,
  WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY,
  WORKSPACE_TEAM_OPERATION_ACCESS,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult,
  type WorkspaceTeamMutationAction,
  type WorkspaceTeamMutationContribution
} from '@jooevents/application';
import type { SynchronousClassifiedPayloadStore } from '@jooevents/application/synchronous-classified-payload-store';
import {
  workspaceTeamInviteInputSchema,
  workspaceTeamRemovalInputSchema,
  workspaceTeamRoleChangeInputSchema
} from '@jooevents/contracts';
import {
  normalizeEmail,
  planWorkspaceTeamInvitation,
  planWorkspaceTeamRemoval,
  planWorkspaceTeamRoleChange,
  projectWorkspaceTeamSafeDiff,
  WorkspaceTeamPlanningError,
  type WorkspaceTeamMutationPlan
} from '@jooevents/identity-access';
import {
  canonicalJsonText,
  parseInstant,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import {
  SQLiteWorkspaceTeamRepository,
  adoptWorkspaceInvitationRecipient,
  workspaceInvitationLookupBinding,
  workspaceInvitationRecipientHint
} from './workspace-team';

export interface SQLiteWorkspaceTeamMutationIds {
  newPreparationHandle(): string;
  newReservationId(): string;
  newReservationRoleAssignmentId(): string;
  newReleaseIntentId(): string;
  newHistoryId(): string;
  newPayloadRefId(): string;
  newSessionRevocationIntentId(): string;
}

type MutationSuccess = Extract<
  WorkspaceTeamMutationContribution,
  { result: { kind: 'success' } }
>;

interface InvitationAdoption {
  readonly reservationId: string;
  readonly payloadRefId: string;
  readonly normalizedEmail: string;
}

interface PreparedMutation {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly contribution: MutationSuccess;
  readonly plan: WorkspaceTeamMutationPlan;
  readonly invitationAdoption?: InvitationAdoption;
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
        kind: 'workspace_team.change_refused', retryable: false, subjects: [],
        detail: { code: error.code, action }, detailSchemaVersion: 1
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

export class SQLiteWorkspaceTeamMutationEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #ids: SQLiteWorkspaceTeamMutationIds;
  readonly #input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly classifiedStore: SynchronousClassifiedPayloadStore;
    readonly invitationLookupKeyBytes: Uint8Array;
    readonly ids: SQLiteWorkspaceTeamMutationIds;
  };
  readonly #issued = new Set<string>();
  readonly #prepared = new Map<string, PreparedMutation>();

  constructor(input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly classifiedStore: SynchronousClassifiedPayloadStore;
    readonly invitationLookupKeyBytes: Uint8Array;
    readonly ids: SQLiteWorkspaceTeamMutationIds;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#ids = input.ids;
    if (!(input.invitationLookupKeyBytes instanceof Uint8Array)
        || input.invitationLookupKeyBytes.byteLength < 32) {
      throw new TypeError('workspace_invitation_lookup_key_invalid');
    }
    this.#input = Object.freeze({
      ...input,
      invitationLookupKeyBytes: Uint8Array.from(input.invitationLookupKeyBytes)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.#input.sqlite.inTransaction
        || capability.key !== WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY.key
        || capability.version !== WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY.version) {
      throw new TypeError('workspace_team_mutation_capability_mismatch');
    }
    const action = workspaceTeamMutationActionForOperation(
      context.operation.name, context.operation.version
    );
    if (!action || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactWorkspaceSubjects(context)) {
      throw new TypeError('workspace_team_mutation_scope_mismatch');
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
      throw new TypeError('workspace_team_mutation_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const repository = new SQLiteWorkspaceTeamRepository(
      this.#input.sqlite, this.#input.classifiedStore
    );
    return sealWorkspaceTeamMutationPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }) => {
          if (receivedAction !== action || receivedContext !== context
              || !this.#input.sqlite.inTransaction) {
            throw new TypeError('workspace_team_mutation_context_substitution');
          }
          const handle = this.#fresh(this.#ids.newPreparationHandle);
          let plan: WorkspaceTeamMutationPlan;
          let invitationAdoption: InvitationAdoption | undefined;
          try {
            const snapshot = repository.readPlanningSnapshot(this.#workspaceId);
            if (action === 'invite') {
              const request = workspaceTeamInviteInputSchema.parse(businessInput);
              const reservationId = this.#fresh(this.#ids.newReservationId);
              const payloadRefId = parsePayloadRefId(this.#fresh(this.#ids.newPayloadRefId));
              const normalizedEmail = normalizeEmail(request.email);
              const lookupBinding = workspaceInvitationLookupBinding({
                keyBytes: this.#input.invitationLookupKeyBytes,
                workspaceId: this.#workspaceId,
                normalizedEmail
              });
              invitationAdoption = { reservationId, payloadRefId, normalizedEmail };
              plan = planWorkspaceTeamInvitation({
                snapshot,
                expectedTeamVersion: request.expectedTeamVersion,
                expectedTeamDigestSha256: request.expectedTeamDigestSha256,
                roleKey: request.roleKey,
                recipient: {
                  payloadRefId,
                  lookupBinding,
                  hint: workspaceInvitationRecipientHint(lookupBinding)
                },
                ids: {
                  reservationId,
                  reservationRoleAssignmentId: this.#fresh(
                    this.#ids.newReservationRoleAssignmentId
                  ),
                  releaseIntentId: this.#fresh(this.#ids.newReleaseIntentId),
                  historyId: this.#fresh(this.#ids.newHistoryId)
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
                historyId: this.#fresh(this.#ids.newHistoryId)
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
                historyId: this.#fresh(this.#ids.newHistoryId),
                ...(request.subject.kind === 'member'
                  ? { sessionRevocationIntentId: this.#fresh(
                      this.#ids.newSessionRevocationIntentId
                    ) }
                  : {})
              });
            }
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
                workspaceId: this.#workspaceId,
                resultingTeamVersion: plan.resultingTeamVersion,
                occurredAt: evaluatedAt
              },
              effectContributions: []
            });
            if (contribution.result.kind !== 'success' || !contribution.domain) {
              throw new TypeError('workspace_team_mutation_contribution_invalid');
            }
            const success = contribution as MutationSuccess;
            this.#prepared.set(handle, {
              handle, context, contribution: success, plan,
              ...(invitationAdoption ? { invitationAdoption } : {})
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
    if (!this.#input.sqlite.inTransaction) {
      throw new TypeError('workspace_team_mutation_transaction_required');
    }
    const parsed = workspaceTeamMutationDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || canonicalJsonText(parsed)
        !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('workspace_team_mutation_preparation_invalid');
    }
    if (prepared.invitationAdoption) {
      const adopted = adoptWorkspaceInvitationRecipient({
        store: this.#input.classifiedStore,
        workspaceId: this.#workspaceId,
        reservationId: prepared.invitationAdoption.reservationId,
        payloadRefId: parsePayloadRefId(prepared.invitationAdoption.payloadRefId),
        normalizedEmail: prepared.invitationAdoption.normalizedEmail,
        lookupKeyBytes: this.#input.invitationLookupKeyBytes,
        createdAt: parseInstant(parsed.occurredAt)
      });
      const planned = prepared.plan.action === 'invite' ? {
        payloadRefId: prepared.plan.payloadRefId,
        lookupBinding: prepared.plan.lookupBinding,
        hint: prepared.plan.recipientHint
      } : undefined;
      if (!planned || canonicalJsonText(planned) !== canonicalJsonText(adopted)) {
        throw new TypeError('workspace_team_mutation_recipient_adoption_mismatch');
      }
    }
    new SQLiteWorkspaceTeamRepository(
      this.#input.sqlite, this.#input.classifiedStore
    ).applyPlan(prepared.plan);
    this.#prepared.delete(parsed.preparationHandle);
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared.clear();
  }

  #fresh(factory: () => string): string {
    const value = factory.call(this.#ids);
    if (typeof value !== 'string' || this.#issued.has(value)) {
      throw new TypeError('workspace_team_mutation_id_invalid');
    }
    this.#issued.add(value);
    return value;
  }
}

export function createSQLiteWorkspaceTeamMutationEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly classifiedStore: SynchronousClassifiedPayloadStore;
  readonly invitationLookupKeyBytes: Uint8Array;
  readonly ids: SQLiteWorkspaceTeamMutationIds;
}): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY,
    adapter: new SQLiteWorkspaceTeamMutationEffectDomainAdapter(input)
  });
}
