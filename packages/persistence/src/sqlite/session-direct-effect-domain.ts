import type { Database } from 'bun:sqlite';
import { resolveEffectInvocationAuthorityRecheckAttribution, resolveEffectInvocationCurrentAuthorityRecheckTime, type EffectHandlerSnapshot, type EffectInvocationContext, type SealedEffectAuthorityRecheckResult } from '@jooevents/application';
import { sessionDirectInputSchema, sessionMutationPlanSchema, sessionParticipantAddExistingPlanSchema, sessionRemoveNewPlanSchema } from '@jooevents/contracts';
import { applyEngagementRosterInviteFrom, planEngagementRosterInviteFrom } from '@jooevents/engagement';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import { planNewSessionRemoval, planSessionMutation, SessionPlanningError } from '@jooevents/session';
import { SESSION_CHANGE_OPERATION, SESSION_DIRECT_HANDLER_CAPABILITY, SESSION_MANAGE_ACCESS_POLICY, sealSessionDirectPreparation, sessionChangedOutcome, sessionDirectContributionSchema } from '@jooevents/session-operations';
import type { SQLiteEffectDomainAdapter, SQLiteEffectDomainAdapterRegistration } from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import type { SQLiteEngagementRepository } from './engagement';
import type { SQLiteSessionRepository } from './session';
import type { SQLiteSpeakerLineupRepository } from './speaker-lineup';
import type { SQLiteSessionParticipantSupportRepository } from './session-participant-support';

const same = (a: { readonly key: string; readonly version: number }, b: { readonly key: string; readonly version: number }) => a.key === b.key && a.version === b.version;
const exact = (context: EffectInvocationContext) => context.scope.eventId !== undefined && context.scope.subjects.length === 2
  && context.scope.subjects.some((s) => s.kind === 'workspace' && s.id === context.scope.workspaceId)
  && context.scope.subjects.some((s) => s.kind === 'event' && s.id === context.scope.eventId);

export class SQLiteSessionDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteSessionRepository;
    readonly engagements: SQLiteEngagementRepository;
    readonly lineups: SQLiteSpeakerLineupRepository;
    readonly supports: SQLiteSessionParticipantSupportRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly newSessionId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }
  openHandlerSnapshot(capability: { readonly key: string; readonly version: number }, context: EffectInvocationContext, authorityRecheck: SealedEffectAuthorityRecheckResult): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction || !same(capability, SESSION_DIRECT_HANDLER_CAPABILITY)) throw new TypeError('session_direct_capability_mismatch');
    if (context.operation.name !== SESSION_CHANGE_OPERATION.name || context.operation.version !== 1 || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http' || context.scope.workspaceId !== this.#workspaceId || !exact(context)) throw new TypeError('session_direct_scope_mismatch');
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user' || authority.principal.kind !== 'workspace_user' || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user' || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator' || authority.lane.surface !== 'operator_http' || !same(authority.lane.policy, SESSION_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) => grant.kind === 'permission' && grant.key === 'schedule.manage')) throw new TypeError('session_direct_authority_mismatch');
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
      throw new TypeError('session_direct_event_relationship_mismatch');
    }
    return sealSessionDirectPreparation({ capability, context, preparation: { prepare: ({ businessInput, context: received }) => {
      if (received !== context || !this.input.sqlite.inTransaction) throw new TypeError('session_direct_context_substitution');
      const wire = sessionDirectInputSchema.parse(businessInput);
      const catalog = this.input.repository.readSessionCatalog(scope);
      if (!catalog) throw new TypeError('session_direct_catalog_missing');
      try {
        if (wire.action === 'roster_add_existing') {
          const target = catalog.sessions.find((session) => session.id === wire.sessionId);
          if (!target) throw new SessionPlanningError('session_missing');
          if (target.roster.version !== wire.expectedRosterVersion
              || target.roster.participants.some((entry) => entry.personId === wire.personId)) {
            throw new SessionPlanningError('participant_changed');
          }
          const lineup = this.input.lineups.readSpeakerLineupSnapshot(scope);
          if (!lineup?.entries.some((entry) => entry.personId === wire.personId)) {
            throw new SessionPlanningError('participant_missing');
          }
          const existing = this.input.engagements.readSessionPersonEngagement(
            scope,
            target.id,
            wire.personId
          );
          const source = Object.freeze({
            kind: 'organizer', id: actorUserId, version: 1
          });
          const engagementInvite = planEngagementRosterInviteFrom(this.input.engagements, {
            scope,
            sessionId: target.id,
            personId: wire.personId,
            source: existing?.source ?? source,
            invitedAt: occurredAt,
            respondBy: null
          });
          const sessionPlan = planSessionMutation({
            planningInput: {
              action: 'roster_append',
              scope,
              actorUserId,
              occurredAt,
              expectedCatalogVersion: wire.expectedCatalogVersion,
              expectedCatalogDigestSha256: wire.expectedCatalogDigestSha256,
              sessionId: target.id,
              expectedSessionVersion: wire.expectedSessionVersion,
              expectedSessionDigestSha256: wire.expectedSessionDigestSha256,
              participants: [{
                personId: wire.personId,
                role: wire.role,
                publiclyVisible: wire.publiclyVisible,
                source
              }]
            },
            catalog,
            vocabulary: this.input.repository.readSessionVocabulary(scope)!
          });
          const support = Object.freeze({
            schemaVersion: 1 as const,
            scope,
            sessionId: target.id,
            personId: wire.personId,
            kind: 'editorial' as const,
            source
          });
          const existingSupport = this.input.supports.readParticipantSupport(
            scope, target.id, wire.personId, { kind: 'editorial', source }
          );
          const plan = sessionParticipantAddExistingPlanSchema.parse({
            sessionPlan,
            engagementInvite,
            support,
            supportChanges: { remove: [], insert: existingSupport ? [] : [support] }
          });
          return sessionDirectContributionSchema.parse({
            result: { kind: 'success', data: {
              action: 'roster_add_existing',
              catalogVersion: sessionPlan.catalogVersion.after,
              session: sessionPlan.after
            } },
            domain: { kind: 'session_participant_add_existing', plan },
            effectContributions: []
          });
        }
        const plan = wire.action === 'remove_new_session'
          ? (() => {
              const current = catalog.sessions.find((session) => session.id === wire.sessionId);
              if (!current || current.version !== 1 || current.version !== wire.expectedSessionVersion
                  || current.digestSha256 !== wire.expectedSessionDigestSha256
                  || current.roster.participants.length !== 0
                  || this.input.repository.countSessionSchedulePlacements(scope, current.id) !== 0
                  || this.input.repository.countSessionCanonicalReferences(scope, current.id) !== 0) {
                throw new SessionPlanningError('stale_session');
              }
              return planNewSessionRemoval({ current, catalog, actorUserId, occurredAt });
            })()
          : planSessionMutation({
              planningInput: wire.action === 'create'
                ? { ...wire, scope, sessionId: this.input.newSessionId(), actorUserId, occurredAt }
                : { ...wire, scope, actorUserId, occurredAt },
              catalog, vocabulary: this.input.repository.readSessionVocabulary(scope)!
            });
        let data;
        if ('action' in plan && plan.action === 'remove_new_session') {
          data = { action: 'remove_new_session' as const, catalogVersion: plan.catalogVersion.after, session: null };
        } else {
          const mutation = sessionMutationPlanSchema.parse(plan);
          data = { action: mutation.input.action, catalogVersion: mutation.catalogVersion.after, session: mutation.after };
        }
        return sessionDirectContributionSchema.parse({ result: { kind: 'success', data }, domain: { kind: 'session_direct_change', plan }, effectContributions: [] });
      } catch (error) {
        if (!(error instanceof SessionPlanningError)) throw error;
        return sessionDirectContributionSchema.parse({
          result: {
            kind: 'outcome',
            outcome: sessionChangedOutcome({
              code: error.code,
              action: wire.action,
              sessionId: wire.action === 'create' ? scope.eventId : wire.sessionId
            })
          },
          domain: null,
          effectContributions: []
        });
      }
    } } });
  }
  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('session_direct_contribution_invalid');
    if ((contribution as any)?.kind === 'session_participant_add_existing') {
      const plan = sessionParticipantAddExistingPlanSchema.parse((contribution as any).plan);
      this.input.repository.applySessionPlan(plan.sessionPlan);
      applyEngagementRosterInviteFrom(this.input.engagements, plan.engagementInvite);
      this.input.supports.applyParticipantSupportChanges(plan.supportChanges);
      return;
    }
    if ((contribution as any)?.kind !== 'session_direct_change') throw new TypeError('session_direct_contribution_invalid');
    const candidate = (contribution as any).plan;
    const mutation = sessionMutationPlanSchema.safeParse(candidate);
    this.input.repository.applySessionPlan(mutation.success ? mutation.data : sessionRemoveNewPlanSchema.parse(candidate));
  }
}


export function createSQLiteSessionDirectEffectDomainRegistration(input: ConstructorParameters<typeof SQLiteSessionDirectEffectDomainAdapter>[0]): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({ capability: SESSION_DIRECT_HANDLER_CAPABILITY, adapter: new SQLiteSessionDirectEffectDomainAdapter(input) });
}
