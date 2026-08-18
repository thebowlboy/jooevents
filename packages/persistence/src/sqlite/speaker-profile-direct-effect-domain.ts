import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  speakerProfileApproveInputSchema,
  speakerProfileApprovePlanSchema,
  speakerProfileReviewPolicyUpdateInputSchema,
  speakerProfileReviewPolicyUpdatePlanSchema,
  speakerProfileUpdateInputSchema,
  speakerProfileUpdatePlanSchema
} from '@jooevents/contracts';
import {
  SpeakerProfilePlanningError,
  planSpeakerProfileApproval,
  planSpeakerProfileReviewPolicyUpdate,
  planSpeakerProfileUpdate
} from '@jooevents/engagement';
import {
  SPEAKER_PROFILE_APPROVE_OPERATION,
  SPEAKER_PROFILE_DIRECT_HANDLER_CAPABILITY,
  SPEAKER_PROFILE_MANAGE_ACCESS_POLICY,
  SPEAKER_PROFILE_REVIEW_POLICY_UPDATE_OPERATION,
  SPEAKER_PROFILE_UPDATE_OPERATION,
  sealSpeakerProfileDirectPreparation,
  speakerProfileDirectContributionSchema
} from '@jooevents/engagement-operations';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteSpeakerProfileRepository } from './speaker-profile';

const same = (
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
) => left.key === right.key && left.version === right.version;

function exact(context: EffectInvocationContext): boolean {
  return context.scope.eventId !== undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === context.scope.eventId);
}

function supportedOperation(
  context: EffectInvocationContext
): 'update' | 'approve' | 'review_policy_update' | undefined {
  if (context.operation.version !== 1) return undefined;
  if (context.operation.name === SPEAKER_PROFILE_UPDATE_OPERATION.name) return 'update';
  if (context.operation.name === SPEAKER_PROFILE_APPROVE_OPERATION.name) return 'approve';
  if (context.operation.name === SPEAKER_PROFILE_REVIEW_POLICY_UPDATE_OPERATION.name) {
    return 'review_policy_update';
  }
  return undefined;
}

export class SQLiteSpeakerProfileDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly newApprovalId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    const operation = supportedOperation(context);
    if (!this.input.sqlite.inTransaction
        || !same(capability, SPEAKER_PROFILE_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('speaker_profile_direct_capability_mismatch');
    }
    if (!operation || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId || !exact(context)) {
      throw new TypeError('speaker_profile_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    const operator = authority.actor.kind === 'workspace_user'
      && authority.principal.kind === 'workspace_user'
      && authority.actor.userId === authority.principal.userId
      && context.actor.kind === 'workspace_user' && context.actor.userId === authority.actor.userId
      && authority.lane.kind === 'operator' && authority.lane.surface === 'operator_http';
    if (!operator
        || !same(authority.lane.policy, SPEAKER_PROFILE_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'speaker.profile.manage')) {
      throw new TypeError('speaker_profile_direct_authority_mismatch');
    }
    const scope = { workspaceId: this.#workspaceId, eventId: context.scope.eventId! };
    const actorUserId = parseUserId(authority.actor.userId);
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.#workspaceId);
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite,
      workspaceId: this.#workspaceId,
      eventId: scope.eventId,
      userId: actorUserId,
      evaluatedAt: occurredAt
    });
    if (relationship.kind !== 'valid' || current?.currentEvent?.id !== scope.eventId) {
      throw new TypeError('speaker_profile_direct_event_relationship_mismatch');
    }
    const profiles = new SQLiteSpeakerProfileRepository(this.input.sqlite);
    return sealSpeakerProfileDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('speaker_profile_direct_context_substitution');
        }
        try {
          if (operation === 'update') {
            const authorInput = speakerProfileUpdateInputSchema.parse(businessInput);
            const plan = planSpeakerProfileUpdate({
              planningInput: {
                scope, actorUserId, occurredAt, authorInput,
                autoApprovalIds: [
                  this.input.newApprovalId(), this.input.newApprovalId(),
                  this.input.newApprovalId(), this.input.newApprovalId()
                ]
              },
              profiles
            });
            return speakerProfileDirectContributionSchema.parse({
              result: { kind: 'success', data: plan.after },
              domain: { kind: 'speaker_profile_update_direct', plan },
              effectContributions: []
            });
          }
          if (operation === 'approve') {
            const authorInput = speakerProfileApproveInputSchema.parse(businessInput);
            const plan = planSpeakerProfileApproval({
              planningInput: {
                scope, actorUserId, occurredAt, authorInput,
                approvalIds: authorInput.fields.map(() => this.input.newApprovalId())
              },
              profiles
            });
            return speakerProfileDirectContributionSchema.parse({
              result: { kind: 'success', data: plan.after },
              domain: { kind: 'speaker_profile_approve_direct', plan },
              effectContributions: []
            });
          }
          const authorInput = speakerProfileReviewPolicyUpdateInputSchema.parse(businessInput);
          const candidates = authorInput.reviewRequired
            ? []
            : profiles.readPolicyApprovalCandidates(scope);
          const plan = planSpeakerProfileReviewPolicyUpdate({
            planningInput: {
              scope, actorUserId, occurredAt, authorInput,
              approvalIds: candidates.map(() => this.input.newApprovalId())
            },
            profiles
          });
          return speakerProfileDirectContributionSchema.parse({
            result: { kind: 'success', data: plan.after },
            domain: { kind: 'speaker_profile_review_policy_update_direct', plan },
            effectContributions: []
          });
        } catch (error) {
          if (!(error instanceof SpeakerProfilePlanningError)) throw error;
          return speakerProfileDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: {
              class: 'stale_revision', kind: 'speaker.profile.changed', retryable: false,
              subjects: [], detail: { code: error.code, field: error.field },
              detailSchemaVersion: 1
            } },
            domain: null,
            effectContributions: []
          });
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('speaker_profile_direct_contribution_invalid');
    }
    const candidate = contribution as { readonly kind?: unknown; readonly plan?: unknown };
    const repository = new SQLiteSpeakerProfileRepository(this.input.sqlite);
    if (candidate.kind === 'speaker_profile_update_direct') {
      repository.applySpeakerProfileUpdatePlan(speakerProfileUpdatePlanSchema.parse(candidate.plan));
      return;
    }
    if (candidate.kind === 'speaker_profile_approve_direct') {
      repository.applySpeakerProfileApprovePlan(speakerProfileApprovePlanSchema.parse(candidate.plan));
      return;
    }
    if (candidate.kind === 'speaker_profile_review_policy_update_direct') {
      repository.applyReviewPolicyUpdatePlan(
        speakerProfileReviewPolicyUpdatePlanSchema.parse(candidate.plan)
      );
      return;
    }
    throw new TypeError('speaker_profile_direct_contribution_invalid');
  }
}

export function createSQLiteSpeakerProfileDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteSpeakerProfileDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: SPEAKER_PROFILE_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteSpeakerProfileDirectEffectDomainAdapter(input)
  });
}
