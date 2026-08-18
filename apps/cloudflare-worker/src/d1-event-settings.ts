import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import type { EventSettingsDto } from '@jooevents/contracts';
import {
  applyEventSettingsUpdatePlan,
  parseEventSettingsCompanion,
  parseEventSettingsState,
  parseEventState,
  parseWorkspaceEventSetState,
  projectEventSettings,
  type EventSettingsState
} from '@jooevents/event';
import {
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY,
  EVENT_SETTINGS_UPDATE_OPERATION,
  eventSettingsDirectUpdatePlanSchema,
  sealEventSettingsDirectUpdateSnapshot
} from '@jooevents/event-operations';
import { parseEventId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

interface SettingsRow {
  readonly set_workspace_id: string;
  readonly set_version: number;
  readonly current_event_id: string | null;
  readonly event_id: string | null;
  readonly name: string | null;
  readonly timezone: string | null;
  readonly start_date: string | null;
  readonly end_date: string | null;
  readonly event_version: number | null;
  readonly companion_event_version: number | null;
  readonly created_by_user_id: string | null;
  readonly created_at_ms: number | null;
  readonly location: string | null;
  readonly venue_note: string | null;
  readonly day_start: string | null;
  readonly day_end: string | null;
  readonly slot_minutes: number | null;
}

type D1ReadSource = Pick<D1Database, 'prepare'> | Pick<D1DatabaseSession, 'prepare'>;

async function readSettingsState(
  source: D1ReadSource,
  workspaceId: WorkspaceId
): Promise<EventSettingsState | undefined> {
  const row = await source.prepare(`SELECT
    s.workspace_id AS set_workspace_id,s.version AS set_version,s.current_event_id,
    h.id AS event_id,h.name,h.timezone,h.start_date,h.end_date,h.version AS event_version,
    h.created_by_user_id,h.created_at_ms,
    c.event_version AS companion_event_version,
    c.location,c.venue_note,c.day_start,c.day_end,c.slot_minutes
    FROM event_spine_workspace_sets s
    LEFT JOIN event_spine_heads h
      ON h.workspace_id = s.workspace_id AND h.id = s.current_event_id
    LEFT JOIN event_settings_companions c
      ON c.workspace_id = h.workspace_id AND c.event_id = h.id
    WHERE s.workspace_id = ?`).bind(workspaceId).first<SettingsRow>();
  if (!row) throw new TypeError('d1_event_settings_set_missing');
  const eventSet = parseWorkspaceEventSetState({
    workspaceId: row.set_workspace_id,
    version: row.set_version,
    currentEventId: row.current_event_id
  });
  if (eventSet.currentEventId === null) return undefined;
  if (row.event_id === null || row.name === null || row.timezone === null
      || row.start_date === null || row.end_date === null || row.event_version === null
      || row.companion_event_version === null
      || row.created_by_user_id === null || row.created_at_ms === null
      || row.location === null || row.venue_note === null) {
    throw new TypeError('d1_event_settings_companion_missing');
  }
  const event = parseEventState({
    id: row.event_id,
    workspaceId: row.set_workspace_id,
    name: row.name,
    timezone: row.timezone,
    startDate: row.start_date,
    endDate: row.end_date,
    version: row.event_version,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at_ms).toISOString()
  });
  const companion = parseEventSettingsCompanion({
    workspaceId: row.set_workspace_id,
    eventId: row.event_id,
    eventVersion: row.companion_event_version,
    location: row.location,
    venueNote: row.venue_note,
    dayStart: row.day_start,
    dayEnd: row.day_end,
    slotMinutes: row.slot_minutes,
    // Worker/D1 parity is paused for the single-machine release. Preserve the
    // legacy adapter's observable default without promoting the SQLite-only
    // review-policy migration into D1 by accident.
    profileContentReview: false
  });
  return parseEventSettingsState({ eventSet, event, companion });
}

function assertStateCurrent(unitOfWork: D1BufferedUnitOfWork, state: EventSettingsState): void {
  const { eventSet, event, companion } = state;
  unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
    WHERE workspace_id = ? AND version = ? AND current_event_id = ?)`, [
    eventSet.workspaceId, eventSet.version, event.id
  ]);
  unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_heads
    WHERE workspace_id = ? AND id = ? AND name = ? AND timezone = ?
      AND start_date = ? AND end_date = ? AND version = ?
      AND created_by_user_id = ? AND created_at_ms = ?)`, [
    event.workspaceId, event.id, event.name, event.timezone, event.startDate, event.endDate,
    event.version, event.createdByUserId, Date.parse(event.createdAt)
  ]);
  unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_settings_companions
    WHERE workspace_id = ? AND event_id = ? AND event_version = ?
      AND location = ? AND venue_note = ? AND day_start IS ? AND day_end IS ?
      AND slot_minutes IS ?)`, [
    companion.workspaceId, companion.eventId, companion.eventVersion,
    companion.location, companion.venueNote, companion.dayStart, companion.dayEnd,
    companion.slotMinutes
  ]);
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return eventId !== undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId);
}

/** Atomic current-Event settings projection for the registered read operation. */
export function createD1EventSettingsReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readCurrent(requestedWorkspaceId: WorkspaceId): Promise<EventSettingsDto | undefined> {
      if (parseWorkspaceId(requestedWorkspaceId) !== workspaceId) {
        throw new TypeError('d1_event_settings_read_workspace_mismatch');
      }
      const state = await readSettingsState(input.database, workspaceId);
      return state ? projectEventSettings(state) : undefined;
    }
  });
}

interface PreparedSettingsUpdate {
  readonly state: EventSettingsState | undefined;
  phase: 'prepared' | 'applied';
}

/** D1 Event-settings adapter for the unchanged direct audited update operation. */
export class D1EventSettingsEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedSettingsUpdate | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (capability.key !== EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY.key
        || capability.version !== EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY.version) {
      throw new TypeError('d1_event_settings_capability_mismatch');
    }
    if (context.operation.name !== EVENT_SETTINGS_UPDATE_OPERATION.name
        || context.operation.version !== EVENT_SETTINGS_UPDATE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_event_settings_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || authority.lane.policy.key !== EVENT_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== EVENT_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('d1_event_settings_authority_mismatch');
    }
    const eventId = parseEventId(context.scope.eventId);
    const currentState = await readSettingsState(
      this.input.unitOfWork.readSession,
      this.#workspaceId
    );
    const state = currentState?.event.id === eventId ? currentState : undefined;
    if (state) assertStateCurrent(this.input.unitOfWork, state);
    this.#prepared = { state, phase: 'prepared' };
    return sealEventSettingsDirectUpdateSnapshot({ capability, context, state });
  }

  applyDomainContribution(contribution: unknown): void {
    const candidate = contribution as { readonly kind?: unknown; readonly plan?: unknown };
    if (candidate.kind !== 'event_settings_direct_update') {
      throw new TypeError('d1_event_settings_contribution_invalid');
    }
    const plan = eventSettingsDirectUpdatePlanSchema.parse(candidate.plan);
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared' || !prepared.state) {
      throw new TypeError('d1_event_settings_preparation_invalid');
    }
    applyEventSettingsUpdatePlan({ state: prepared.state, plan });
    const before = plan.before;
    const after = plan.after;
    this.input.unitOfWork.write(`UPDATE event_spine_heads
      SET name = ?,timezone = ?,start_date = ?,end_date = ?,version = ?
      WHERE workspace_id = ? AND id = ? AND version = ?
        AND name = ? AND timezone = ? AND start_date = ? AND end_date = ?`, [
      after.name, after.timezone, after.startDate, after.endDate, after.eventVersion,
      plan.scope.workspaceId, plan.scope.eventId, before.eventVersion,
      before.name, before.timezone, before.startDate, before.endDate
    ]);
    this.input.unitOfWork.write(`UPDATE event_settings_companions
      SET event_version = ?,location = ?,venue_note = ?,day_start = ?,day_end = ?,slot_minutes = ?
      WHERE workspace_id = ? AND event_id = ? AND event_version = ?
        AND location = ? AND venue_note = ? AND day_start IS ? AND day_end IS ?
        AND slot_minutes IS ?`, [
      after.eventVersion, after.location, after.venueNote,
      after.dayStart, after.dayEnd, after.slotMinutes,
      plan.scope.workspaceId, plan.scope.eventId, before.eventVersion,
      before.location, before.venueNote, before.dayStart, before.dayEnd, before.slotMinutes
    ]);
    prepared.phase = 'applied';
  }

  afterUnitOfWorkCommitted(): void {
    this.#prepared = undefined;
  }
}

export function createD1EventSettingsEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
}): D1EffectDomainAdapterRegistration {
  return Object.freeze({
    capability: EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) => new D1EventSettingsEffectDomainAdapter({
      unitOfWork,
      workspaceId: input.workspaceId
    })
  });
}
