import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  sessionSubmissionAttachPlanSchema,
  sessionSubmissionRestorePlanBundleSchema,
  sessionSubmissionRouteContributionSchema,
  sessionSubmissionRouteInputSchema
} from '@jooevents/contracts';
import {
  applyEngagementSeedFrom,
  applyEngagementSeedReversalFrom
} from '@jooevents/engagement';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import {
  planSessionSubmissionAttach,
  planSessionSubmissionRestore,
  SessionSubmissionRoutePlanningError
} from '@jooevents/session';
import {
  SESSION_SUBMISSION_ROUTE_ACCESS_POLICY,
  SESSION_SUBMISSION_ROUTE_HANDLER_CAPABILITY,
  SESSION_SUBMISSION_ROUTE_OPERATION,
  sealSessionDirectPreparation,
  sessionSubmissionRouteChangedOutcome
} from '@jooevents/session-operations';
import type { SQLiteDecisionRepository } from './decision';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import type { SQLiteSessionRepository } from './session';

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

export class SQLiteSessionSubmissionRouteEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly sessions: SQLiteSessionRepository;
    readonly decisions: SQLiteDecisionRepository;
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
        || !same(capability, SESSION_SUBMISSION_ROUTE_HANDLER_CAPABILITY)) {
      throw new TypeError('session_submission_route_capability_mismatch');
    }
    if (context.operation.name !== SESSION_SUBMISSION_ROUTE_OPERATION.name
        || context.operation.version !== SESSION_SUBMISSION_ROUTE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exact(context)) {
      throw new TypeError('session_submission_route_scope_mismatch');
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
        || !same(authority.lane.policy, SESSION_SUBMISSION_ROUTE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'schedule.manage')) {
      throw new TypeError('session_submission_route_authority_mismatch');
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
      throw new TypeError('session_submission_route_event_relationship_mismatch');
    }
    const environment = {
      sessions: this.input.sessions,
      decisions: this.input.decisions,
      engagements: this.input.decisions.engagements
    };
    return sealSessionDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('session_submission_route_context_substitution');
        }
        const author = sessionSubmissionRouteInputSchema.parse(businessInput);
        try {
          if (author.action === 'attach_unlinked') {
            const plan = planSessionSubmissionAttach({
              scope,
              actorUserId,
              occurredAt,
              author,
              environment
            });
            return sessionSubmissionRouteContributionSchema.parse({
              result: { kind: 'success', data: {
                action: 'attach_unlinked',
                catalogVersion: plan.sessionPlan.catalogVersion.after,
                session: plan.sessionPlan.after,
                origin: plan.origin,
                recovery: plan
              } },
              domain: { kind: 'session_submission_attach', plan },
              effectContributions: []
            });
          }
          const plan = planSessionSubmissionRestore({
            scope,
            actorUserId,
            occurredAt,
            expectedCatalogVersion: author.expectedCatalogVersion,
            expectedCatalogDigestSha256: author.expectedCatalogDigestSha256,
            expectedSessionVersion: author.expectedSessionVersion,
            expectedSessionDigestSha256: author.expectedSessionDigestSha256,
            original: author.original,
            environment
          });
          if (plan.sessionPlan.restore === null) {
            throw new SessionSubmissionRoutePlanningError('invalid_plan', plan.origin.submissionId);
          }
          return sessionSubmissionRouteContributionSchema.parse({
            result: { kind: 'success', data: {
              action: 'restore_route',
              catalogVersion: plan.sessionPlan.catalogVersion.after,
              session: plan.sessionPlan.restore,
              origin: null,
              recovery: null
            } },
            domain: { kind: 'session_submission_restore', plan },
            effectContributions: []
          });
        } catch (error) {
          if (!(error instanceof SessionSubmissionRoutePlanningError)) throw error;
          return sessionSubmissionRouteContributionSchema.parse({
            result: { kind: 'outcome', outcome: sessionSubmissionRouteChangedOutcome({
              code: error.code,
              submissionId: error.subjectId
            }) },
            domain: null,
            effectContributions: []
          });
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('session_submission_route_transaction_required');
    }
    const candidate = contribution as { readonly kind?: unknown; readonly plan?: unknown };
    if (candidate.kind === 'session_submission_attach') {
      const plan = sessionSubmissionAttachPlanSchema.parse(candidate.plan);
      this.input.sessions.applySessionPlan(plan.sessionPlan);
      this.input.decisions.insertSubmissionSessionOrigin(plan.origin);
      applyEngagementSeedFrom(this.input.decisions.engagements, plan.engagementSeed);
      return;
    }
    if (candidate.kind === 'session_submission_restore') {
      const plan = sessionSubmissionRestorePlanBundleSchema.parse(candidate.plan);
      this.input.sessions.applySessionPlan(plan.sessionPlan);
      this.input.decisions.deleteSubmissionSessionOrigin(plan.origin);
      applyEngagementSeedReversalFrom(
        this.input.decisions.engagements,
        plan.engagementSeedReversal
      );
      return;
    }
    throw new TypeError('session_submission_route_contribution_invalid');
  }
}

export function createSQLiteSessionSubmissionRouteEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteSessionSubmissionRouteEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: SESSION_SUBMISSION_ROUTE_HANDLER_CAPABILITY,
    adapter: new SQLiteSessionSubmissionRouteEffectDomainAdapter(input)
  });
}
