import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  scheduleBreakPlanSchema,
  schedulePlacementAuthorInputSchema,
  schedulePlacementPlanSchema,
  schedulePlacementResultSchema
} from '@jooevents/contracts';
import {
  parseInstant,
  parseUserId,
  parseWorkspaceId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  parseScheduleOccurrenceId,
  planScheduleBreakMutation,
  planSchedulePlacementMutation,
  ScheduleBreakPlanningError,
  SchedulePlacementPlanningError,
  type PlaceableSessionIdentityPort
} from '@jooevents/schedule';
import {
  SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY,
  SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_OPERATION,
  schedulePlacementDirectContributionSchema,
  sealSchedulePlacementDirectPreparation
} from '@jooevents/schedule-operations';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import type { SQLiteProgramVocabularyRepository } from './program-vocabulary';
import { SQLiteSchedulePlacementRepository } from './schedule-placement';

const same = (
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
) => left.key === right.key && left.version === right.version;

function exactSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId !== undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === context.scope.eventId
    );
}

export class SQLiteSchedulePlacementDirectEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly scheduleRead;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly sessions: PlaceableSessionIdentityPort;
    readonly vocabulary: SQLiteProgramVocabularyRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly newOccurrenceId: () => string;
    readonly newBreakId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    const readRepository = this.repository(
      parseUserId('00000000-0000-4000-8000-000000000001'),
      parseInstant('1970-01-01T00:00:00.000Z')
    );
    this.scheduleRead = Object.freeze({
      readSchedule: readRepository.readSchedule.bind(readRepository)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('schedule_direct_transaction_required');
    if (!same(capability, SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('schedule_direct_capability_mismatch');
    }
    if (context.operation.name !== SCHEDULE_PLACEMENT_OPERATION.name
        || context.operation.version !== SCHEDULE_PLACEMENT_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('schedule_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !same(authority.lane.policy, SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'schedule.manage'
        )) {
      throw new TypeError('schedule_direct_authority_mismatch');
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
      evaluatedAt
    });
    if (relationship.kind !== 'valid' || current?.currentEvent?.id !== scope.eventId) {
      throw new TypeError('schedule_direct_event_relationship_mismatch');
    }
    const repository = this.repository(actorUserId, evaluatedAt);
    return sealSchedulePlacementDirectPreparation({
      capability,
      context,
      prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('schedule_direct_context_substitution');
        }
        const wire = schedulePlacementAuthorInputSchema.parse(businessInput);
        const state = repository.readSchedule(scope);
        const vocabulary = repository.readVocabulary(scope);
        if (!state || !vocabulary) throw new TypeError('schedule_direct_scope_missing');
        if (wire.action === 'break_add'
            || wire.action === 'break_remove'
            || wire.action === 'break_restore') {
          const breakState = repository.readBreakState(scope);
          if (!breakState) throw new TypeError('schedule_direct_scope_missing');
          const planningInput = wire.action === 'break_add'
            ? {
                action: wire.action,
                scope,
                expectedScheduleVersion: wire.expectedScheduleVersion,
                label: wire.label,
                dayKey: wire.dayKey,
                startMin: wire.startMin,
                endMin: wire.endMin,
                breaks: wire.roomIds.map((roomId) => ({ id: this.input.newBreakId(), roomId }))
              }
            : { ...wire, scope };
          try {
            const plan = planScheduleBreakMutation({ planningInput, state: breakState, vocabulary });
            return schedulePlacementDirectContributionSchema.parse({
              result: {
                kind: 'success',
                data: {
                  action: plan.input.action,
                  scheduleVersion: plan.scheduleVersion.after,
                  breaks: plan.after
                }
              },
              domain: {
                kind: 'schedule_break_direct',
                plan,
                actorUserId,
                occurredAt: evaluatedAt
              },
              effectContributions: []
            });
          } catch (error) {
            if (!(error instanceof ScheduleBreakPlanningError)) throw error;
            return schedulePlacementDirectContributionSchema.parse({
              result: {
                kind: 'outcome',
                outcome: {
                  class: 'stale_revision',
                  kind: 'schedule_break_changed',
                  retryable: false,
                  subjects: [],
                  detail: {
                    code: error.code,
                    action: wire.action,
                    breakIds: planningInput.breaks.map((entry) => entry.id)
                  },
                  detailSchemaVersion: 1
                }
              },
              domain: null,
              effectContributions: []
            });
          }
        }
        const planningInput = wire.action === 'place'
          ? { ...wire, scope, occurrenceId: parseScheduleOccurrenceId(this.input.newOccurrenceId()) }
          : { ...wire, scope };
        try {
          const plan = planSchedulePlacementMutation({
            planningInput,
            state,
            sessions: repository,
            vocabulary
          });
          return schedulePlacementDirectContributionSchema.parse({
            result: {
              kind: 'success',
              data: schedulePlacementResultSchema.parse({
                action: plan.input.action,
                scheduleVersion: plan.scheduleVersion.after,
                occurrence: plan.after
              })
            },
            domain: {
              kind: 'schedule_placement_direct',
              plan,
              actorUserId,
              occurredAt: evaluatedAt
            },
            effectContributions: []
          });
        } catch (error) {
          if (!(error instanceof SchedulePlacementPlanningError)) throw error;
          return schedulePlacementDirectContributionSchema.parse({
            result: {
              kind: 'outcome',
              outcome: {
                class: error.code === 'room_overlap' ? 'conflict' : 'stale_revision',
                kind: error.code === 'room_overlap'
                  ? 'schedule_room_overlap'
                  : 'schedule_placement_changed',
                retryable: false,
                subjects: [],
                detail: error.conflict ?? {
                  code: error.code,
                  action: wire.action,
                  occurrenceId: wire.action === 'place'
                    ? planningInput.occurrenceId
                    : wire.occurrenceId
                },
                detailSchemaVersion: error.code === 'room_overlap' ? 1 : 2
              }
            },
            domain: null,
            effectContributions: []
          });
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction
        || !['schedule_placement_direct', 'schedule_break_direct'].includes(
          String((contribution as { readonly kind?: unknown })?.kind)
        )) {
      throw new TypeError('schedule_direct_contribution_invalid');
    }
    const candidate = contribution as {
      readonly plan?: unknown;
      readonly actorUserId?: unknown;
      readonly occurredAt?: unknown;
    };
    const repository = this.repository(
      parseUserId(candidate.actorUserId),
      parseInstant(candidate.occurredAt)
    );
    if ((contribution as { readonly kind: string }).kind === 'schedule_break_direct') {
      repository.applyBreakPlan(scheduleBreakPlanSchema.parse(candidate.plan));
    } else {
      repository.applyPlacementPlan(schedulePlacementPlanSchema.parse(candidate.plan));
    }
  }

  private repository(actorUserId: UserId, occurredAt: Instant): SQLiteSchedulePlacementRepository {
    return new SQLiteSchedulePlacementRepository(
      this.input.sqlite,
      this.input.sessions,
      this.input.vocabulary,
      () => ({ actorUserId, occurredAt })
    );
  }
}

export function createSQLiteSchedulePlacementDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteSchedulePlacementDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration & {
  readonly scheduleRead: SQLiteSchedulePlacementDirectEffectDomainAdapter['scheduleRead'];
} {
  const adapter = new SQLiteSchedulePlacementDirectEffectDomainAdapter(input);
  return Object.freeze({
    capability: SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY,
    adapter,
    scheduleRead: adapter.scheduleRead
  });
}
