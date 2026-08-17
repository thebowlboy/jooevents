import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import { eventCreateInputSchema } from '@jooevents/contracts';
import {
  applyEventCreatePlan,
  eventCreatePlanDigest,
  eventCreateResult,
  parseEventCreatePlan,
  parseWorkspaceEventSetState,
  planEventCreation,
  type EventCreatePlan,
  type Event,
  type WorkspaceEventSet
} from '@jooevents/event';
import {
  EVENT_CREATE_HANDLER_CAPABILITY,
  EVENT_CREATE_OPERATION,
  EVENT_MANAGE_ACCESS_POLICY,
  eventCreateContributionSchema,
  eventCreateDomainContributionSchema,
  sealEventCreatePreparation
} from '@jooevents/event-operations';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

interface EventSetRow {
  readonly workspace_id: string;
  readonly version: number;
  readonly current_event_id: string | null;
}

interface PreparedEventCreate {
  readonly context: EffectInvocationContext;
  readonly eventSet: WorkspaceEventSet;
  readonly plan: EventCreatePlan;
  phase: 'prepared' | 'applied';
}

export interface D1CreatedEventInitializer {
  initializeCreatedEvent(input: Readonly<{
    unitOfWork: D1BufferedUnitOfWork;
    event: Event;
  }>): void;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

async function requireEventSet(
  unitOfWork: D1BufferedUnitOfWork,
  workspaceId: WorkspaceId
): Promise<WorkspaceEventSet> {
  const row = await unitOfWork.readSession.prepare(`
    SELECT workspace_id,version,current_event_id
      FROM event_spine_workspace_sets
     WHERE workspace_id = ?
  `).bind(workspaceId).first<EventSetRow>();
  if (!row) throw new TypeError('d1_workspace_event_set_missing');
  const eventSet = parseWorkspaceEventSetState({
    workspaceId: row.workspace_id,
    version: row.version,
    currentEventId: row.current_event_id
  });
  unitOfWork.assertCurrent(`EXISTS (
    SELECT 1 FROM event_spine_workspace_sets
     WHERE workspace_id = ? AND version = ? AND current_event_id IS ?
  )`, [eventSet.workspaceId, eventSet.version, eventSet.currentEventId]);
  return eventSet;
}

/** D1 Event-create adapter for the unchanged registered Event operation. */
export class D1EventCreateEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedEventCreate | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly newEventId: () => string;
    readonly createdEventInitializer: D1CreatedEventInitializer;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    if (typeof input.newEventId !== 'function') {
      throw new TypeError('d1_event_effect_id_factory_invalid');
    }
    if (typeof input.createdEventInitializer?.initializeCreatedEvent !== 'function') {
      throw new TypeError('d1_event_effect_initializer_required');
    }
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (!sameRef(capability, EVENT_CREATE_HANDLER_CAPABILITY)) {
      throw new TypeError('d1_event_effect_capability_mismatch');
    }
    if (
      context.operation.name !== EVENT_CREATE_OPERATION.name
      || context.operation.version !== EVENT_CREATE_OPERATION.version
      || context.operation.effect !== 'commit'
      || context.surface !== 'operator_http'
      || context.scope.workspaceId !== this.#workspaceId
      || context.scope.eventId !== undefined
      || context.scope.subjects.length !== 1
      || context.scope.subjects[0]?.kind !== 'workspace'
      || context.scope.subjects[0].id !== this.#workspaceId
    ) throw new TypeError('d1_event_effect_scope_mismatch');

    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (
      authority.actor.kind !== 'workspace_user'
      || authority.principal.kind !== 'workspace_user'
      || authority.actor.userId !== authority.principal.userId
      || context.actor.kind !== 'workspace_user'
      || context.actor.userId !== authority.actor.userId
      || authority.lane.kind !== 'operator'
      || authority.lane.surface !== 'operator_http'
      || !sameRef(authority.lane.policy, EVENT_MANAGE_ACCESS_POLICY)
      || !authority.grants.some((grant) =>
        grant.kind === 'permission' && grant.key === 'event.manage'
      )
    ) throw new TypeError('d1_event_effect_authority_mismatch');

    const actorUserId = parseUserId(authority.actor.userId);
    const eventSet = await requireEventSet(this.input.unitOfWork, this.#workspaceId);
    this.#prepared = undefined;
    return sealEventCreatePreparation({
      capability,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context) throw new TypeError('d1_event_effect_context_substitution');
          const plan = planEventCreation({
            eventSet,
            authorInput: eventCreateInputSchema.parse(businessInput),
            server: {
              workspaceId: this.#workspaceId,
              eventId: parseEventId(this.input.newEventId()),
              createdByUserId: actorUserId,
              createdAt: evaluatedAt
            }
          });
          const contribution = eventCreateContributionSchema.parse({
            result: { kind: 'success', data: eventCreateResult(plan) },
            domain: { kind: 'event_create', plan },
            effectContributions: []
          });
          if (contribution.result.kind !== 'success' || contribution.domain === null) {
            throw new TypeError('d1_event_effect_success_contribution_invalid');
          }
          this.#prepared = { context, eventSet, plan, phase: 'prepared' };
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const parsed = eventCreateDomainContributionSchema.parse(contribution);
    const plan = parseEventCreatePlan(parsed.plan);
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(plan) !== canonicalJsonText(prepared.plan)) {
      throw new TypeError('d1_event_effect_preparation_invalid');
    }
    const applied = applyEventCreatePlan(prepared.eventSet, plan);
    this.input.unitOfWork.write(`INSERT INTO event_spine_heads (
      workspace_id,id,name,timezone,start_date,end_date,version,
      created_by_user_id,created_at_ms,create_plan_digest_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
      applied.event.workspaceId,
      applied.event.id,
      applied.event.name,
      applied.event.timezone,
      applied.event.startDate,
      applied.event.endDate,
      applied.event.version,
      applied.event.createdByUserId,
      Date.parse(applied.event.createdAt),
      eventCreatePlanDigest(plan)
    ]);
    this.input.unitOfWork.write(
      'INSERT INTO event_spine_scope_roots (workspace_id,event_id) VALUES (?,?)',
      [applied.event.workspaceId, applied.event.id]
    );
    this.input.unitOfWork.write(`UPDATE event_spine_workspace_sets
      SET version = ?,current_event_id = ?
      WHERE workspace_id = ? AND version = ? AND current_event_id IS ?`, [
      applied.eventSet.version,
      applied.event.id,
      applied.eventSet.workspaceId,
      prepared.eventSet.version,
      prepared.eventSet.currentEventId
    ]);
    this.input.createdEventInitializer.initializeCreatedEvent({
      unitOfWork: this.input.unitOfWork,
      event: applied.event
    });
    prepared.phase = 'applied';
  }

  afterUnitOfWorkCommitted(): void {
    this.#prepared = undefined;
  }
}

export function createD1EventCreateEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly newEventId: () => string;
  readonly createdEventInitializer: D1CreatedEventInitializer;
}): D1EffectDomainAdapterRegistration {
  return Object.freeze({
    capability: EVENT_CREATE_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) => new D1EventCreateEffectDomainAdapter({
      unitOfWork,
      workspaceId: input.workspaceId,
      newEventId: input.newEventId,
      createdEventInitializer: input.createdEventInitializer
    })
  });
}
