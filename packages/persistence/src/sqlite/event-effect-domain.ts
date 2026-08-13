import type { Database } from 'bun:sqlite';
import {
  effectOperationIdentitiesEqual,
  effectOperationIdentityMatchesContext,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  EVENT_CREATE_HANDLER_CAPABILITY,
  EVENT_CREATE_OPERATION,
  EVENT_MANAGE_ACCESS_POLICY,
  eventCreateContributionSchema,
  eventCreateDomainContributionSchema,
  eventCreateEvidenceChildSchema,
  sealEventCreatePreparation,
  type EventCreateContribution
} from '@jooevents/event-operations';
import {
  diffEventCreatePlan,
  EventPlanningError,
  eventCreatePlanDigest,
  eventCreateResult,
  planEventCreation,
  type EventCreatePlan
} from '@jooevents/event';
import {
  canonicalJsonText,
  parseDomainFactId,
  parseEventId,
  parseInstant,
  parseOperationReceiptId,
  parseOutboxPointerId,
  parseUserId,
  parseWorkspaceId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import { eventCreateInputSchema, eventCreateOperationResultSchema } from '@jooevents/contracts';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';

export interface SQLiteEventEffectDomainIds {
  newEventId(): string;
  newPreparationHandle(): string;
  newFactId(): string;
  newPointerId(): string;
  newTimelineId(): string;
}

type EventEvidenceChild = EventCreateContribution['receiptChildren'][number];
type EventCreateDomainContribution = NonNullable<EventCreateContribution['domain']>;
type EventCreateSuccessResult = Extract<EventCreateContribution['result'], { readonly kind: 'success' }>;
type EventDomainFactChild = Extract<EventEvidenceChild, { readonly kind: 'domain_fact' }>;
type EventOutboxPointerChild = Extract<EventEvidenceChild, { readonly kind: 'outbox_pointer' }>;
type EventTimelineChild = Extract<EventEvidenceChild, { readonly kind: 'timeline' }>;

interface SuccessEventCreateContribution {
  readonly result: EventCreateSuccessResult;
  readonly domain: EventCreateDomainContribution;
  readonly receiptChildren: readonly [
    EventDomainFactChild,
    EventOutboxPointerChild,
    EventTimelineChild
  ];
}

interface PreparedEventCreate {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId: UserId;
  readonly evaluatedAt: Instant;
  readonly plan: EventCreatePlan;
  readonly contribution: SuccessEventCreateContribution;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  nextChild: number;
  receiptId?: string;
}

function exactCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === EVENT_CREATE_HANDLER_CAPABILITY.key
    && value.version === EVENT_CREATE_HANDLER_CAPABILITY.version;
}

const APPLICATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function neutralApplicationUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !APPLICATION_UUID.test(value)) {
    throw new TypeError(`event_effect_${label}_invalid`);
  }
  return value.toLowerCase();
}

function exactChild(value: unknown): EventEvidenceChild {
  return eventCreateEvidenceChildSchema.parse(value) as EventEvidenceChild;
}

/**
 * Applies the registered Event-create capability and its receipt evidence on one
 * caller-owned SQLite transaction. All preparation state is process-local and one-shot.
 */
export class SQLiteEventEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #repository: SQLiteEventSpineRepository;
  readonly #ids: SQLiteEventEffectDomainIds;
  readonly #prepared = new Map<string, PreparedEventCreate>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedEventCreate | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(
    private readonly sqlite: Database,
    private readonly workspaceId: WorkspaceId,
    ids: SQLiteEventEffectDomainIds
  ) {
    this.workspaceId = parseWorkspaceId(workspaceId);
    for (const method of [
      'newEventId',
      'newPreparationHandle',
      'newFactId',
      'newPointerId',
      'newTimelineId'
    ] as const) {
      if (typeof ids[method] !== 'function') throw new TypeError('event_effect_id_factory_invalid');
    }
    this.#ids = Object.freeze({
      newEventId: ids.newEventId.bind(ids),
      newPreparationHandle: ids.newPreparationHandle.bind(ids),
      newFactId: ids.newFactId.bind(ids),
      newPointerId: ids.newPointerId.bind(ids),
      newTimelineId: ids.newTimelineId.bind(ids)
    });
    this.#repository = new SQLiteEventSpineRepository(sqlite);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.sqlite.inTransaction) throw new TypeError('event_effect_transaction_required');
    if (!exactCapability(capability)) throw new TypeError('event_effect_capability_mismatch');
    if (
      context.operation.name !== EVENT_CREATE_OPERATION.name
      || context.operation.version !== EVENT_CREATE_OPERATION.version
      || context.operation.effect !== 'commit'
      || context.surface !== 'operator_http'
      || context.scope.workspaceId !== this.workspaceId
      || context.scope.eventId !== undefined
      || context.scope.subjects.length !== 1
      || context.scope.subjects[0]?.kind !== 'workspace'
      || context.scope.subjects[0].id !== this.workspaceId
    ) throw new TypeError('event_effect_scope_mismatch');

    const authority = resolveEffectInvocationAuthorityRecheckAttribution(
      context,
      authorityRecheck
    );
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(
      context,
      authorityRecheck
    );
    if (
      authority.actor.kind !== 'workspace_user'
      || authority.principal.kind !== 'workspace_user'
      || authority.actor.userId !== authority.principal.userId
      || context.actor.kind !== 'workspace_user'
      || context.actor.userId !== authority.actor.userId
      || authority.lane.kind !== 'operator'
      || authority.lane.surface !== 'operator_http'
      || authority.lane.policy.key !== EVENT_MANAGE_ACCESS_POLICY.key
      || authority.lane.policy.version !== EVENT_MANAGE_ACCESS_POLICY.version
      || !authority.grants.some((grant) =>
        grant.kind === 'permission' && grant.key === 'event.manage'
      )
    ) throw new TypeError('event_effect_authority_mismatch');

    const actorUserId = parseUserId(authority.actor.userId);
    const eventSet = this.#repository.requireEventSet(this.workspaceId);
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;

    return sealEventCreatePreparation({
      capability,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.sqlite.inTransaction) {
            throw new TypeError('event_effect_context_substitution');
          }
          const eventId = parseEventId(this.#ids.newEventId());
          let plan: EventCreatePlan;
          try {
            plan = planEventCreation({
              eventSet,
              authorInput: eventCreateInputSchema.parse(businessInput),
              server: {
                workspaceId: this.workspaceId,
                eventId,
                createdByUserId: actorUserId,
                createdAt: evaluatedAt
              }
            });
          } catch (error) {
            if (
              error instanceof EventPlanningError
              && (error.code === 'stale_event_set' || error.code === 'event_already_selected')
            ) this.#nonterminalReleaseContext = context;
            throw error;
          }
          const handle = neutralApplicationUuid(
            this.#ids.newPreparationHandle(),
            'preparation_handle'
          );
          const factId = parseDomainFactId(this.#ids.newFactId());
          const pointerId = parseOutboxPointerId(this.#ids.newPointerId());
          const timelineId = neutralApplicationUuid(this.#ids.newTimelineId(), 'timeline_id');
          const generatedIds = [eventId, handle, factId, pointerId, timelineId];
          if (
            new Set(generatedIds).size !== generatedIds.length
            || generatedIds.some((id) => this.#issuedIds.has(id))
          ) {
            throw new TypeError('event_effect_ids_not_unique');
          }
          for (const id of generatedIds) this.#issuedIds.add(id);
          const candidate = eventCreateContributionSchema.parse({
            result: { kind: 'success', data: eventCreateResult(plan) },
            domain: {
              kind: 'event_create',
              preparationHandle: handle,
              planDigestSha256: eventCreatePlanDigest(plan)
            },
            receiptChildren: [{
              kind: 'domain_fact',
              factId,
              factKind: 'event_created',
              factVersion: 1,
              eventId,
              sourcePlan: plan,
              safeDiff: diffEventCreatePlan(plan)
            }, {
              kind: 'outbox_pointer',
              pointerId,
              sourceKind: 'domain_fact',
              factId
            }, {
              kind: 'timeline',
              timelineId,
              sourceKind: 'domain_fact',
              factId,
              workspaceId: this.workspaceId,
              eventId,
              occurredAt: evaluatedAt
            }]
          });
          if (candidate.result.kind !== 'success' || candidate.domain === null) {
            throw new TypeError('event_effect_success_contribution_invalid');
          }
          const contribution = candidate as SuccessEventCreateContribution;
          this.#prepared.set(handle, {
            handle,
            context,
            workspaceId: this.workspaceId,
            actorUserId,
            evaluatedAt,
            plan,
            contribution,
            phase: 'prepared',
            nextChild: 0
          });
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.sqlite.inTransaction) throw new TypeError('event_effect_transaction_required');
    const parsed = eventCreateDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (
      !prepared
      || prepared.phase !== 'prepared'
      || parsed.planDigestSha256 !== eventCreatePlanDigest(prepared.plan)
      || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)
    ) throw new TypeError('event_effect_preparation_invalid');
    this.#prepared.delete(prepared.handle);
    this.#repository.commitEventCreatePlan(prepared.plan);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = eventCreateOperationResultSchema.safeParse(receipt.result);
    if (
      !this.sqlite.inTransaction
      || !active
      || active.phase !== 'applied'
      || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
      || receipt.requestHash !== active.context.requestBinding.requestHashSha256
      || receipt.ref.operationName !== EVENT_CREATE_OPERATION.name
      || receipt.ref.operationVersion !== EVENT_CREATE_OPERATION.version
      || !parsedResult.success
      || parsedResult.data.kind !== 'success'
      || parsedResult.data.receipt.id !== receipt.ref.id
      || parsedResult.data.receipt.operationName !== EVENT_CREATE_OPERATION.name
      || parsedResult.data.receipt.operationVersion !== EVENT_CREATE_OPERATION.version
      || canonicalJsonText(parsedResult.data.data)
        !== canonicalJsonText(eventCreateResult(active.plan))
    ) throw new TypeError('event_effect_receipt_mismatch');
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.#repository.linkEventCreateReceipt({
      receiptId,
      plan: active.plan,
      operation: EVENT_CREATE_OPERATION
    });
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (
      !this.sqlite.inTransaction
      || !active
      || active.phase !== 'parent_linked'
      || !this.#expectedIdentity
      || active.receiptId === undefined
      || receiptId !== active.receiptId
    ) throw new TypeError('event_effect_receipt_parent_missing');
    const expected = active.contribution.receiptChildren[active.nextChild];
    const child = exactChild(contribution);
    if (!expected || canonicalJsonText(child) !== canonicalJsonText(expected)) {
      throw new TypeError('event_effect_evidence_order_mismatch');
    }
    if (child.kind === 'domain_fact') {
      this.sqlite.query<never, [string, string, string, string, string, number, string]>(`
        INSERT INTO event_spine_domain_facts (
          fact_id, receipt_id, workspace_id, event_id,
          fact_kind, fact_version, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.factId,
        active.receiptId,
        active.workspaceId,
        child.eventId,
        child.factKind,
        child.factVersion,
        canonicalJsonText({ sourcePlan: child.sourcePlan, safeDiff: child.safeDiff })
      );
    } else if (child.kind === 'outbox_pointer') {
      this.sqlite.query<never, [string, string, string, string]>(`
        INSERT INTO event_spine_outbox_pointers (
          pointer_id, receipt_id, fact_id, source_kind
        ) VALUES (?, ?, ?, ?)
      `).run(child.pointerId, active.receiptId, child.factId, child.sourceKind);
    } else {
      this.sqlite.query<never, [string, string, string, string, string, number, string]>(`
        INSERT INTO event_spine_timeline_projection (
          timeline_id, receipt_id, fact_id, workspace_id,
          event_id, occurred_at_ms, source_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.timelineId,
        active.receiptId,
        child.factId,
        child.workspaceId,
        child.eventId,
        Date.parse(parseInstant(child.occurredAt)),
        child.sourceKind
      );
    }
    active.nextChild += 1;
    if (active.nextChild === active.contribution.receiptChildren.length) {
      active.phase = 'evidence_complete';
    }
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.sqlite.inTransaction) throw new TypeError('event_effect_transaction_required');
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('event_effect_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (
      active.phase !== 'evidence_complete'
      || !this.#expectedIdentity
      || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)
    ) throw new TypeError('event_effect_incomplete');
    active.phase = 'claim_released';
  }

  afterUnitOfWorkCommitted(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }
}

export function createSQLiteEventEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly ids: SQLiteEventEffectDomainIds;
}): {
  readonly capability: typeof EVENT_CREATE_HANDLER_CAPABILITY;
  readonly adapter: SQLiteEventEffectDomainAdapter;
} {
  return Object.freeze({
    capability: EVENT_CREATE_HANDLER_CAPABILITY,
    adapter: new SQLiteEventEffectDomainAdapter(input.sqlite, input.workspaceId, input.ids)
  });
}
