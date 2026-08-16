import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import { submissionTriageTransitionPlanSchema } from '@jooevents/contracts/submission-triage';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import {
  planSubmissionTriageTransition,
  SubmissionTriageDomainError,
  type SubmissionTriageTransitionPlan
} from '@jooevents/submission-triage';
import {
  SUBMISSION_TRIAGE_DIRECT_HANDLER_CAPABILITY,
  SUBMISSION_TRIAGE_TRANSITION_OPERATION,
  sealSubmissionTriageDirectPreparation,
  submissionTriageDirectContributionSchema
} from '@jooevents/submission-triage';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import type { SQLiteSubmissionTriageRepository } from './submission-triage';

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

export class SQLiteSubmissionTriageDirectEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteSubmissionTriageRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction
        || !same(capability, SUBMISSION_TRIAGE_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('submission_triage_direct_capability_mismatch');
    }
    if (context.operation.name !== SUBMISSION_TRIAGE_TRANSITION_OPERATION.name
        || context.operation.version !== SUBMISSION_TRIAGE_TRANSITION_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exact(context)) {
      throw new TypeError('submission_triage_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || authority.lane.policy.key !== 'authority.submission.triage-manage'
        || authority.lane.policy.version !== 1
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('submission_triage_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const scope = { workspaceId: this.#workspaceId, eventId: context.scope.eventId! };
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
      throw new TypeError('submission_triage_direct_event_relationship_mismatch');
    }
    return sealSubmissionTriageDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('submission_triage_direct_context_substitution');
        }
        const state = this.input.repository.readTriageState(scope);
        if (!state) return submissionTriageDirectContributionSchema.parse({
          result: { kind: 'outcome', outcome: {
            class: 'conflict', kind: 'submission_triage.event_required', retryable: false,
            subjects: [], detail: null, detailSchemaVersion: 1
          } }, domain: null, effectContributions: []
        });
        try {
          const plan = planSubmissionTriageTransition({
            state,
            action: businessInput.action,
            submissionIds: businessInput.submissionIds,
            expectedHeads: businessInput.expectedHeads,
            expectedQueryGuard: businessInput.expectedQueryGuard,
            attribution: {
              kind: 'manual',
              principalKey: context.authorityPrincipalKey,
              invocationId: context.invocationId,
              surface: 'operator_http'
            },
            changedAt: occurredAt
          });
          return submissionTriageDirectContributionSchema.parse({
            result: { kind: 'success', data: {
              schemaVersion: 1,
              action: plan.action,
              queryGuard: plan.queryGuard.after,
              submissionIds: plan.transitions.map((transition) => transition.submissionId)
            } },
            domain: { kind: 'submission_triage_direct', plan },
            effectContributions: []
          });
        } catch (error) {
          if (!(error instanceof SubmissionTriageDomainError)) throw error;
          const stale = new Set([
            'wrong_scope', 'projection_incomplete', 'source_changed', 'submission_missing',
            'stale_query_set', 'stale_submission'
          ]).has(error.code);
          return submissionTriageDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: {
              class: stale ? 'stale_revision' : 'policy_violation',
              kind: stale ? 'submission_triage.changed' : 'submission_triage.change_refused',
              retryable: false,
              subjects: [],
              detail: {
                code: error.code,
                action: businessInput.action,
                submissionIds: businessInput.submissionIds
              },
              detailSchemaVersion: 1
            } }, domain: null, effectContributions: []
          });
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction
        || (contribution as { readonly kind?: unknown })?.kind !== 'submission_triage_direct') {
      throw new TypeError('submission_triage_direct_contribution_invalid');
    }
    this.input.repository.applyTransitionPlan(
      submissionTriageTransitionPlanSchema.parse(
        (contribution as { readonly plan?: unknown }).plan
      ) as SubmissionTriageTransitionPlan
    );
  }
}

export function createSQLiteSubmissionTriageDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteSubmissionTriageDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: SUBMISSION_TRIAGE_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteSubmissionTriageDirectEffectDomainAdapter(input)
  });
}
