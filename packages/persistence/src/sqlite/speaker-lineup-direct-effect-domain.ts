import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import { speakerLineupAuthorInputSchema, speakerLineupMutationPlanSchema } from '@jooevents/contracts';
import {
  SpeakerLineupPlanningError,
  planSpeakerLineupMutation,
  resolveSpeakerLineupPlanningInput,
  speakerLineupChangeDataFromPlan
} from '@jooevents/engagement';
import {
  SPEAKER_LINEUP_CHANGE_OPERATION,
  SPEAKER_LINEUP_DIRECT_HANDLER_CAPABILITY,
  SPEAKER_LINEUP_MANAGE_ACCESS_POLICY,
  sealSpeakerLineupDirectPreparation,
  speakerLineupDirectContributionSchema
} from '@jooevents/engagement-operations';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteSpeakerLineupRepository } from './speaker-lineup';

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

export class SQLiteSpeakerLineupDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly newCategoryId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction
        || !same(capability, SPEAKER_LINEUP_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('speaker_lineup_direct_capability_mismatch');
    }
    if (context.operation.name !== SPEAKER_LINEUP_CHANGE_OPERATION.name
        || context.operation.version !== SPEAKER_LINEUP_CHANGE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exact(context)) {
      throw new TypeError('speaker_lineup_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    const operator = authority.actor.kind === 'workspace_user'
      && authority.principal.kind === 'workspace_user'
      && authority.actor.userId === authority.principal.userId
      && context.actor.kind === 'workspace_user' && context.actor.userId === authority.actor.userId
      && authority.lane.kind === 'operator' && authority.lane.surface === 'operator_http';
    if (!operator
        || !same(authority.lane.policy, SPEAKER_LINEUP_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('speaker_lineup_direct_authority_mismatch');
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
      throw new TypeError('speaker_lineup_direct_event_relationship_mismatch');
    }
    const lineups = new SQLiteSpeakerLineupRepository(this.input.sqlite);
    return sealSpeakerLineupDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('speaker_lineup_direct_context_substitution');
        }
        const wire = speakerLineupAuthorInputSchema.parse(businessInput);
        try {
          const planningInput = resolveSpeakerLineupPlanningInput({
            authorInput: wire,
            scope,
            actorUserId,
            occurredAt,
            ...(wire.action === 'add_category' ? { categoryId: this.input.newCategoryId() } : {})
          });
          const plan = planSpeakerLineupMutation({
            planningInput,
            lineups
          });
          return speakerLineupDirectContributionSchema.parse({
            result: { kind: 'success', data: speakerLineupChangeDataFromPlan(plan) },
            domain: { kind: 'speaker_lineup_direct', plan },
            effectContributions: []
          });
        } catch (error) {
          if (!(error instanceof SpeakerLineupPlanningError)) throw error;
          return speakerLineupDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: {
              class: 'stale_revision', kind: 'speaker-lineup.changed', retryable: false,
              subjects: [],
              detail: {
                code: error.code,
                subjectId: error.subjectId ?? null
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
        || (contribution as { readonly kind?: unknown })?.kind !== 'speaker_lineup_direct') {
      throw new TypeError('speaker_lineup_direct_contribution_invalid');
    }
    const candidate = contribution as { readonly plan?: unknown };
    const plan = speakerLineupMutationPlanSchema.parse(candidate.plan);
    new SQLiteSpeakerLineupRepository(this.input.sqlite).applySpeakerLineupPlan(plan);
  }
}

export function createSQLiteSpeakerLineupDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteSpeakerLineupDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: SPEAKER_LINEUP_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteSpeakerLineupDirectEffectDomainAdapter(input)
  });
}
