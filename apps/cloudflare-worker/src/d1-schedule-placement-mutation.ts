import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  schedulePlacementAuthorInputSchema,
  schedulePlacementPlanSchema,
  schedulePlacementResultSchema,
  type SchedulePlacementPlanDto
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  applySchedulePlacementPlan,
  parseScheduleOccurrenceId,
  parseScheduleSessionId,
  planSchedulePlacementMutation,
  SchedulePlacementPlanningError,
  type PlaceableSessionIdentityPort,
  type SchedulePlacementScope,
  type ScheduleSessionId,
  type SchedulePlacementState
} from '@jooevents/schedule';
import {
  SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY,
  SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_MANAGE_PERMISSION_ID,
  SCHEDULE_PLACEMENT_OPERATION,
  schedulePlacementDirectContributionSchema,
  sealSchedulePlacementDirectPreparation
} from '@jooevents/schedule-operations';
import type { SessionCatalog } from '@jooevents/session';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';
import {
  createD1ProgramVocabularySnapshotReadSource,
  programVocabularyStateFromSnapshot
} from './d1-program-vocabulary';
import { createD1SchedulePlacementReadSource } from './d1-schedule-placement';
import { createD1SessionCatalogReadSource } from './d1-session-catalog';

interface EventSetRow {
  readonly version: number;
  readonly current_event_id: string | null;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId !== undefined && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === context.scope.eventId);
}

function applicationUuid(value: unknown): string {
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('d1_schedule_occurrence_id_invalid');
  }
  return value.toLowerCase();
}

function sessionsPort(catalog: SessionCatalog): PlaceableSessionIdentityPort {
  return Object.freeze({
    readPlaceableSession(scope: SchedulePlacementScope, sessionId: ScheduleSessionId) {
      if (scope.workspaceId !== catalog.scope.workspaceId
          || scope.eventId !== catalog.scope.eventId) return undefined;
      const session = catalog.sessions.find((candidate) => candidate.id === sessionId);
      if (!session || (session.lifecycle !== 'collecting'
          && session.lifecycle !== 'programmed')) return undefined;
      return Object.freeze({
        scope,
        id: parseScheduleSessionId(session.id),
        lifecycle: session.lifecycle,
        trackId: session.programTarget.track?.id ?? null
      });
    }
  });
}

interface PreparedChange {
  readonly plan: SchedulePlacementPlanDto;
  readonly state: SchedulePlacementState;
  readonly actorUserId: string;
  readonly occurredAtMs: number;
  phase: 'prepared' | 'applied';
}

export class D1SchedulePlacementDirectEffectDomainAdapter
implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedChange | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly newOccurrenceId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (!sameRef(capability, SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('d1_schedule_direct_capability_mismatch');
    }
    if (context.operation.name !== SCHEDULE_PLACEMENT_OPERATION.name
        || context.operation.version !== SCHEDULE_PLACEMENT_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_schedule_direct_scope_mismatch');
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
        || !sameRef(authority.lane.policy, SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === SCHEDULE_PLACEMENT_MANAGE_PERMISSION_ID)) {
      throw new TypeError('d1_schedule_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = parseEventId(context.scope.eventId!);
    this.#prepared = undefined;

    const eventSet = await this.input.unitOfWork.readSession.prepare(
      'SELECT version,current_event_id FROM event_spine_workspace_sets WHERE workspace_id = ?'
    ).bind(this.#workspaceId).first<EventSetRow>();
    if (!eventSet || eventSet.current_event_id !== eventId) {
      throw new TypeError('d1_schedule_direct_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id = ? AND version = ? AND current_event_id = ?)`, [
      this.#workspaceId, eventSet.version, eventId
    ]);

    const sessionDatabase = {
      withSession: () => this.input.unitOfWork.readSession
    } as unknown as D1Database;
    const scope = { workspaceId: this.#workspaceId, eventId };
    const [state, catalog, vocabularySnapshot] = await Promise.all([
      createD1SchedulePlacementReadSource({
        database: sessionDatabase, workspaceId: this.#workspaceId
      }).readSchedule(scope),
      createD1SessionCatalogReadSource({
        database: sessionDatabase, workspaceId: this.#workspaceId
      }).readSessionCatalog(scope),
      createD1ProgramVocabularySnapshotReadSource({
        database: sessionDatabase, workspaceId: this.#workspaceId
      }).readSnapshot(scope)
    ]);
    if (!state || !catalog || !vocabularySnapshot) {
      throw new SchedulePlacementPlanningError('wrong_scope');
    }
    const vocabulary = programVocabularyStateFromSnapshot(vocabularySnapshot);
    const sessions = sessionsPort(catalog);
    this.input.unitOfWork.assertCurrent(state.scheduleVersion === 1
      ? `NOT EXISTS (SELECT 1 FROM schedule_placement_sets
          WHERE workspace_id = ? AND event_id = ?)`
      : `EXISTS (SELECT 1 FROM schedule_placement_sets
          WHERE workspace_id = ? AND event_id = ? AND schedule_version = ?)`,
    state.scheduleVersion === 1
      ? [this.#workspaceId, eventId]
      : [this.#workspaceId, eventId, state.scheduleVersion]);
    this.input.unitOfWork.assertCurrent(catalog.version === 1
      ? `NOT EXISTS (SELECT 1 FROM session_catalogs
          WHERE workspace_id = ? AND event_id = ?)`
      : `EXISTS (SELECT 1 FROM session_catalogs
          WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?)`,
    catalog.version === 1
      ? [this.#workspaceId, eventId]
      : [this.#workspaceId, eventId, catalog.version, catalog.digestSha256]);
    this.input.unitOfWork.assertCurrent(vocabulary.setVersion === 1
      ? `NOT EXISTS (SELECT 1 FROM program_vocabulary_sets
          WHERE workspace_id = ? AND event_id = ?)`
      : `EXISTS (SELECT 1 FROM program_vocabulary_sets
          WHERE workspace_id = ? AND event_id = ? AND set_version = ?)`,
    vocabulary.setVersion === 1
      ? [this.#workspaceId, eventId]
      : [this.#workspaceId, eventId, vocabulary.setVersion]);

    return sealSchedulePlacementDirectPreparation({
      capability,
      context,
      prepare: ({ businessInput, context: received }) => {
        if (received !== context) throw new TypeError('d1_schedule_direct_context_substitution');
        const wire = schedulePlacementAuthorInputSchema.parse(businessInput);
        const planningInput = wire.action === 'place'
          ? { ...wire, scope, occurrenceId: parseScheduleOccurrenceId(
              applicationUuid(this.input.newOccurrenceId())) }
          : { ...wire, scope };
        try {
          const plan = planSchedulePlacementMutation({
            planningInput, state, sessions, vocabulary
          });
          applySchedulePlacementPlan({ state, sessions, vocabulary, plan });
          this.#prepared = {
            plan,
            state,
            actorUserId,
            occurredAtMs: Date.parse(occurredAt),
            phase: 'prepared'
          };
          return schedulePlacementDirectContributionSchema.parse({
            result: { kind: 'success', data: schedulePlacementResultSchema.parse({
              action: plan.input.action,
              scheduleVersion: plan.scheduleVersion.after,
              occurrence: plan.after
            }) },
            domain: { kind: 'schedule_placement_direct', plan, actorUserId, occurredAt },
            effectContributions: []
          });
        } catch (error) {
          if (!(error instanceof SchedulePlacementPlanningError)) throw error;
          return schedulePlacementDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: {
              class: error.code === 'room_overlap' ? 'conflict' : 'stale_revision',
              kind: error.code === 'room_overlap'
                ? 'schedule_room_overlap' : 'schedule_placement_changed',
              retryable: false,
              subjects: [],
              detail: error.conflict ?? {
                code: error.code,
                action: wire.action,
                occurrenceId: wire.action === 'place'
                  ? planningInput.occurrenceId : wire.occurrenceId
              },
              detailSchemaVersion: error.code === 'room_overlap' ? 1 : 2
            } },
            domain: null,
            effectContributions: []
          });
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const candidate = contribution as {
      readonly kind?: unknown;
      readonly plan?: unknown;
      readonly actorUserId?: unknown;
      readonly occurredAt?: unknown;
    };
    if (candidate.kind !== 'schedule_placement_direct') {
      throw new TypeError('d1_schedule_direct_contribution_invalid');
    }
    const plan = schedulePlacementPlanSchema.parse(candidate.plan);
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || candidate.actorUserId !== prepared.actorUserId
        || typeof candidate.occurredAt !== 'string'
        || Date.parse(candidate.occurredAt) !== prepared.occurredAtMs
        || canonicalJsonText(prepared.plan) !== canonicalJsonText(plan)) {
      throw new TypeError('d1_schedule_direct_preparation_invalid');
    }
    this.bufferPlan(plan, prepared);
    prepared.phase = 'applied';
  }

  private bufferPlan(plan: SchedulePlacementPlanDto, prepared: PreparedChange): void {
    const scope = plan.input.scope;
    const before = plan.before;
    const after = plan.after;
    if (plan.input.action === 'place') {
      this.input.unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM schedule_occurrences
        WHERE workspace_id = ? AND event_id = ? AND id = ?)`, [
        scope.workspaceId, scope.eventId, plan.input.occurrenceId
      ]);
    } else {
      this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM schedule_occurrences
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND room_id = ?
          AND start_at_ms = ? AND end_at_ms = ? AND version = ?)`, [
        scope.workspaceId, scope.eventId, before!.id, before!.roomId,
        Date.parse(before!.startAt), Date.parse(before!.endAt), before!.version
      ]);
    }
    if (after) {
      this.input.unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM schedule_occurrences
        WHERE workspace_id = ? AND event_id = ? AND room_id = ? AND id != ?
          AND start_at_ms < ? AND ? < end_at_ms)`, [
        scope.workspaceId, scope.eventId, after.roomId, after.id,
        Date.parse(after.endAt), Date.parse(after.startAt)
      ]);
    }

    if (prepared.state.scheduleVersion === 1) {
      this.input.unitOfWork.write(`INSERT INTO schedule_placement_sets
        (workspace_id,event_id,schedule_version,updated_by_user_id,updated_at_ms)
        VALUES (?,?,?,?,?)`, [
        scope.workspaceId, scope.eventId, plan.scheduleVersion.after,
        prepared.actorUserId, prepared.occurredAtMs
      ]);
    }
    if (plan.input.action === 'place') {
      this.input.unitOfWork.write(`INSERT INTO schedule_occurrences
        (workspace_id,event_id,id,session_id,room_id,start_at_ms,end_at_ms,version,
         updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
        scope.workspaceId, scope.eventId, after!.id, after!.sessionId, after!.roomId,
        Date.parse(after!.startAt), Date.parse(after!.endAt), after!.version,
        prepared.actorUserId, prepared.occurredAtMs
      ]);
    } else if (plan.input.action === 'move') {
      this.input.unitOfWork.write(`UPDATE schedule_occurrences SET
        room_id = ?,start_at_ms = ?,end_at_ms = ?,version = ?,
        updated_by_user_id = ?,updated_at_ms = ?
        WHERE workspace_id = ? AND event_id = ? AND id = ?
          AND room_id = ? AND start_at_ms = ? AND end_at_ms = ? AND version = ?`, [
        after!.roomId, Date.parse(after!.startAt), Date.parse(after!.endAt), after!.version,
        prepared.actorUserId, prepared.occurredAtMs,
        scope.workspaceId, scope.eventId, before!.id, before!.roomId,
        Date.parse(before!.startAt), Date.parse(before!.endAt), before!.version
      ]);
    } else {
      this.input.unitOfWork.write(`DELETE FROM schedule_occurrences
        WHERE workspace_id = ? AND event_id = ? AND id = ?
          AND room_id = ? AND start_at_ms = ? AND end_at_ms = ? AND version = ?`, [
        scope.workspaceId, scope.eventId, before!.id, before!.roomId,
        Date.parse(before!.startAt), Date.parse(before!.endAt), before!.version
      ]);
    }
    if (prepared.state.scheduleVersion !== 1) {
      this.input.unitOfWork.write(`UPDATE schedule_placement_sets
        SET schedule_version = ?,updated_by_user_id = ?,updated_at_ms = ?
        WHERE workspace_id = ? AND event_id = ? AND schedule_version = ?`, [
        plan.scheduleVersion.after, prepared.actorUserId, prepared.occurredAtMs,
        scope.workspaceId, scope.eventId, plan.scheduleVersion.before
      ]);
    }
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared = undefined;
  }
}

export function createD1SchedulePlacementDirectEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly newOccurrenceId: () => string;
}): D1EffectDomainAdapterRegistration {
  return Object.freeze({
    capability: SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) =>
      new D1SchedulePlacementDirectEffectDomainAdapter({ ...input, unitOfWork })
  });
}
