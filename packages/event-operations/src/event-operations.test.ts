import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  recheckEffectInvocationCurrentAuthority,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type EffectUnitOfWork,
  type EffectUnitOfWorkPort,
  type InvocationEvidence,
  type ShortOperationAuditRecord,
  type TerminalEffectReceipt,
  type TerminalNewOperationAuditRecord
} from '@jooevents/application';
import {
  currentEventReadInputSchema,
  EVENT_OPERATION_SCHEMA_REFS,
  eventCreateInputSchema,
  eventCreateOperationResultSchema,
  type EventCreateInput
} from '@jooevents/contracts';
import {
  applyEventCreatePlan,
  createWorkspaceEventSet,
  diffEventCreatePlan,
  eventCreatePlanDigest,
  eventCreateResult,
  planEventCreation,
  projectCurrentEvent,
  type Event,
  type WorkspaceEventSet
} from '@jooevents/event';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  EVENT_CREATE_HANDLER_CAPABILITY,
  EVENT_CREATE_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_READ_ACCESS_POLICY,
  createEventCreateHandler,
  createEventOperationModule,
  eventCreateContributionSchema,
  sealEventCreatePreparation
} from '.';

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002'),
  event: '018f7d5a-4b3c-7abc-8def-0123456789a2',
  fact: '018f7d5a-4b3c-7abc-8def-0123456789a3',
  pointer: '018f7d5a-4b3c-7abc-8def-0123456789a4',
  timeline: '018f7d5a-4b3c-7abc-8def-0123456789a5',
  receipt: '018f7d5a-4b3c-7abc-8def-0123456789a6',
  correlation: '018f7d5a-4b3c-7abc-8def-0123456789a7'
} as const;
const now = parseInstant('2026-08-12T08:30:00.000Z');
const profile = { key: 'event-operation-test', version: parseContractVersion(1) } as const;
const input = Object.freeze({
  expectedEventSetVersion: 1,
  name: 'JooEvents Summit',
  timezone: 'Asia/Singapore',
  startDate: '2026-11-04',
  endDate: '2026-11-06'
});

function identityKey(identity: EffectOperationIdentity): string {
  return [
    identity.scopePartitionKey,
    identity.authorityPrincipalKey,
    identity.operationName,
    identity.operationVersion,
    identity.surface,
    identity.idempotencyVerifierProfile.key,
    identity.idempotencyVerifierProfile.version,
    identity.idempotencyKeyVerifier
  ].join('|');
}

function contribution(inputValue: EventCreateInput, context: EffectInvocationContext, state: WorkspaceEventSet) {
  if (context.actor.kind !== 'workspace_user') throw new TypeError('workspace_user_required');
  const plan = planEventCreation({
    eventSet: state,
    authorInput: inputValue,
    server: {
      workspaceId: context.scope.workspaceId,
      eventId: ids.event,
      createdByUserId: context.actor.userId,
      createdAt: now
    }
  });
  return {
    plan,
    value: {
      result: { kind: 'success' as const, data: eventCreateResult(plan) },
      domain: {
        kind: 'event_create' as const,
        preparationHandle: 'prepared-event-create',
        planDigestSha256: eventCreatePlanDigest(plan)
      },
      receiptChildren: [{
        kind: 'domain_fact' as const,
        factId: ids.fact,
        factKind: 'event_created' as const,
        factVersion: 1 as const,
        eventId: ids.event,
        sourcePlan: plan,
        safeDiff: diffEventCreatePlan(plan)
      }, {
        kind: 'outbox_pointer' as const,
        pointerId: ids.pointer,
        sourceKind: 'domain_fact' as const,
        factId: ids.fact
      }, {
        kind: 'timeline' as const,
        timelineId: ids.timeline,
        sourceKind: 'domain_fact' as const,
        factId: ids.fact,
        workspaceId: ids.workspace,
        eventId: ids.event,
        occurredAt: now
      }]
    }
  };
}

class MemoryEventUnitOfWork implements EffectUnitOfWorkPort, EffectUnitOfWork {
  eventSet: WorkspaceEventSet = createWorkspaceEventSet({
    workspaceId: ids.workspace,
    version: 1,
    currentEventId: null
  });
  currentEvent: Event | undefined;
  readonly receipts = new Map<string, TerminalEffectReceipt>();
  readonly shortAudits: ShortOperationAuditRecord[] = [];
  readonly terminalAudits: TerminalNewOperationAuditRecord[] = [];
  readonly children: unknown[] = [];
  applyCalls = 0;
  claim: 'available' | 'contended' = 'available';
  #prepared: ReturnType<typeof contribution> | undefined;

  findTerminalReceipt(identity: EffectOperationIdentity) {
    return this.receipts.get(identityKey(identity));
  }

  recordShortOperationAudit(record: ShortOperationAuditRecord) {
    this.shortAudits.push(record);
  }

  async runInUnitOfWork<Value>(work: (unitOfWork: EffectUnitOfWork) => Promise<Value>) {
    return work(this);
  }

  acquireExecutionClaim() {
    return this.claim === 'contended'
      ? { kind: 'contended_same_request' as const }
      : { kind: 'acquired' as const };
  }

  recheckCurrentAuthority(context: EffectInvocationContext) {
    return recheckEffectInvocationCurrentAuthority(context);
  }

  openHandlerSnapshot(capability: typeof EVENT_CREATE_HANDLER_CAPABILITY, context: EffectInvocationContext, authorityRecheck: Parameters<EffectUnitOfWork['openHandlerSnapshot']>[2]) {
    expect(capability).toEqual(EVENT_CREATE_HANDLER_CAPABILITY);
    expect(resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck)).toBe(now);
    return sealEventCreatePreparation({
      capability,
      preparation: {
        prepare: ({ businessInput, context: received }) => {
          expect(received).toBe(context);
          this.#prepared = contribution(eventCreateInputSchema.parse(businessInput), context, this.eventSet);
          return this.#prepared.value;
        }
      }
    });
  }

  applyDomainContribution(capability: typeof EVENT_CREATE_HANDLER_CAPABILITY, domain: unknown) {
    expect(capability).toEqual(EVENT_CREATE_HANDLER_CAPABILITY);
    const parsed = eventCreateContributionSchema.parse(this.#prepared?.value);
    expect(domain).toEqual(parsed.domain);
    if (!this.#prepared) throw new TypeError('missing_preparation');
    const applied = applyEventCreatePlan(this.eventSet, this.#prepared.plan);
    this.eventSet = applied.eventSet;
    this.currentEvent = applied.event;
    this.applyCalls += 1;
  }

  insertReceiptParent(receipt: TerminalEffectReceipt) {
    this.receipts.set(identityKey(receipt.identity), receipt);
  }

  insertTerminalNewOperationAudit(record: TerminalNewOperationAuditRecord) {
    this.terminalAudits.push(record);
  }

  insertReceiptChild(_receiptId: string, child: unknown) {
    this.children.push(child);
  }

  releaseExecutionClaim() {}
}

function createFixture(options: {
  denied?: boolean;
  selected?: boolean;
  wrongPolicy?: boolean;
  mountLegacyDirectCreate?: boolean;
} = {}) {
  const unitOfWork = new MemoryEventUnitOfWork();
  if (options.selected) {
    const planned = contribution(input, {
      actor: { kind: 'workspace_user', userId: ids.user },
      scope: { workspaceId: ids.workspace }
    } as EffectInvocationContext, unitOfWork.eventSet);
    const applied = applyEventCreatePlan(unitOfWork.eventSet, planned.plan);
    unitOfWork.eventSet = applied.eventSet;
    unitOfWork.currentEvent = applied.event;
  }
  let nextInvocation = 0;
  const module = createEventOperationModule({
    workspaceId: ids.workspace,
    policies: {
      read: options.wrongPolicy
        ? { key: 'authority.event.wrong', version: EVENT_READ_ACCESS_POLICY.version }
        : EVENT_READ_ACCESS_POLICY,
      manage: EVENT_MANAGE_ACCESS_POLICY
    },
    currentAuthority: {
      resolve(resolution) {
        if (options.denied) return { kind: 'denied', reason: 'not_authorized' };
        if (resolution.evidence.kind !== 'operator') return { kind: 'denied', reason: 'lane_mismatch' };
        return {
          kind: 'authorized',
          authority: {
            actor: { kind: 'workspace_user', userId: ids.user },
            principal: { kind: 'workspace_user', userId: ids.user, membershipId: ids.membership },
            lane: resolution.lane,
            scope: resolution.scope,
            grants: [{ kind: 'permission', key: resolution.operation.effect === 'read' ? 'event.read' : 'event.manage' }],
            evidenceIds: ['membership.current'],
            authorityCitationIds: [],
            evaluatedAt: resolution.evaluatedAt
          }
        };
      }
    },
    currentEventRead: {
      readCurrent: () => projectCurrentEvent(unitOfWork.eventSet, unitOfWork.currentEvent)
    },
    clock: { now: () => now },
    ids: {
      newInvocationId: () => parseInvocationId(
        `018f7d5a-4b3c-7abc-8def-${(nextInvocation++ + 100).toString().padStart(12, '0')}`
      )
    },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: EVENT_CREATE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x33)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`event-key:${raw}`).digest('hex')
        };
      }
    },
    ...(options.mountLegacyDirectCreate === undefined
      ? {}
      : { mountLegacyDirectCreate: options.mountLegacyDirectCreate })
  });
  const evidence: InvocationEvidence = {
    kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' }, sessionHandle: 'session-current'
  };
  return { module, unitOfWork, evidence };
}

async function runtime(fixture: ReturnType<typeof createFixture>) {
  return createApplicationOperationRuntime({
    source: fixture.module.source,
    read: {
      operationalTrace: { emit() {} }, immutableAudit: { append() {} },
      clock: { now: () => now }, newInvocationId: () => parseInvocationId(crypto.randomUUID())
    },
    unitOfWork: fixture.unitOfWork,
    newReceiptId: () => ids.receipt
  });
}

describe('Event operation module', () => {
  test('owns the exact policy catalog and rejects policy substitution', () => {
    expect(() => createFixture({ wrongPolicy: true })).toThrow('event_operation_policy_catalog_mismatch');
    expect(EVENT_READ_ACCESS_POLICY.key).toBe('authority.event.read');
    expect(Number(EVENT_READ_ACCESS_POLICY.version)).toBe(1);
    expect(EVENT_MANAGE_ACCESS_POLICY.key).toBe('authority.event.manage');
    expect(Number(EVENT_MANAGE_ACCESS_POLICY.version)).toBe(1);
    expect(EVENT_CREATE_REQUEST_HASH_PROFILE).toEqual({ key: 'request-hash.event.create', version: 1 });
  });

  test('compiles a deterministic operator-only manifest with exact bindings and outcomes', async () => {
    const fixture = createFixture();
    const first = await runtime(fixture);
    const second = await runtime(createFixture());
    expect(first.registry.manifestDigestSha256).toBe(second.registry.manifestDigestSha256);
    expect(first.registry.safeManifest.operations.map((operation) => ({
      name: operation.name,
      version: operation.version,
      effect: operation.effect,
      surfaces: operation.enabledBindings.map((binding) => binding.surface)
    }))).toEqual([{
      name: 'event.create', version: 1, effect: 'commit', surfaces: ['operator_http']
    }, {
      name: 'event.current.read', version: 1, effect: 'read', surfaces: ['operator_http']
    }]);
    expect(first.registry.operatorHttpBindings).toEqual([{
      operationName: 'event.current.read', operationVersion: 1,
      surface: 'operator_http', method: 'GET', path: '/api/events/current', input: 'query'
    }]);
    expect(first.registry.operatorHttpEffectBindings).toEqual([{
      operationName: 'event.create', operationVersion: 1,
      surface: 'operator_http', method: 'POST', path: '/api/events', input: 'body'
    }]);
    const create = first.registry.safeManifest.operations.find((operation) => operation.name === 'event.create');
    const read = first.registry.safeManifest.operations.find(
      (operation) => operation.name === 'event.current.read'
    );
    expect(read?.inputSchema).toEqual(EVENT_OPERATION_SCHEMA_REFS.currentRead.inputSchema);
    expect(read?.enabledBindings[0]?.resultSchema)
      .toEqual(EVENT_OPERATION_SCHEMA_REFS.currentRead.resultSchema);
    expect(create?.inputSchema).toEqual(EVENT_OPERATION_SCHEMA_REFS.create.inputSchema);
    expect(create?.enabledBindings[0]?.resultSchema)
      .toEqual(EVENT_OPERATION_SCHEMA_REFS.create.resultSchema);
    expect(create?.outcomes.map((outcome) => `${outcome.class}:${outcome.kind}`)).toContain('stale_revision:event.event_set_changed');
    expect(create?.outcomes.map((outcome) => `${outcome.class}:${outcome.kind}`)).toContain('conflict:event.already_selected');
  });

  test('can retain current read while leaving legacy direct create unmounted', async () => {
    const composed = await runtime(createFixture({ mountLegacyDirectCreate: false }));
    expect(composed.registry.safeManifest.operations.map((operation) => operation.name))
      .toEqual(['event.current.read']);
    expect(composed.registry.operatorHttpEffectBindings).toEqual([]);
    expect(composed.registry.operatorHttpBindings).toEqual([{
      operationName: 'event.current.read', operationVersion: 1,
      surface: 'operator_http', method: 'GET', path: '/api/events/current', input: 'query'
    }]);
  });

  test('reads a live no-event projection and never accepts caller scope or authority fields', async () => {
    const fixture = createFixture();
    const operations = await runtime(fixture);
    expect(await operations.readExecutor.execute({
      operationName: 'event.current.read', operationVersion: 1, surface: 'operator_http',
      correlationId: ids.correlation, businessInput: {}, verifiedEvidence: fixture.evidence
    })).toEqual({
      kind: 'success', data: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 },
      correlationId: ids.correlation
    });
    expect(currentEventReadInputSchema.safeParse({ workspaceId: ids.workspace }).success).toBe(false);
    expect(eventCreateInputSchema.safeParse({ ...input, workspaceId: ids.workspace }).success).toBe(false);
    expect(eventCreateInputSchema.safeParse({ ...input, createdByUserId: ids.user }).success).toBe(false);
    expect(eventCreateInputSchema.safeParse({ ...input, authority: 'event.manage' }).success).toBe(false);
  });

  test('commits one exact create with trusted attribution/time and full correction evidence', async () => {
    const fixture = createFixture();
    const operations = await runtime(fixture);
    const invocation = await operations.effectBuilder.build({
      operationName: 'event.create', operationVersion: 1, surface: 'operator_http',
      correlationId: ids.correlation, businessInput: input, verifiedEvidence: fixture.evidence,
      rawIdempotencyKey: 'create-first-event'
    });
    const result = await operations.effectExecutor.execute(invocation);
    expect(eventCreateOperationResultSchema.parse(result)).toMatchObject({
      kind: 'success',
      data: { eventSetVersion: 2, event: { id: ids.event, name: input.name } },
      receipt: { id: ids.receipt, operationName: 'event.create', operationVersion: 1 }
    });
    expect(fixture.unitOfWork.applyCalls).toBe(1);
    expect(fixture.unitOfWork.currentEvent).toMatchObject({
      workspaceId: ids.workspace, createdByUserId: ids.user, createdAt: now
    });
    expect(fixture.unitOfWork.children).toHaveLength(3);
    expect(fixture.unitOfWork.children[0]).toMatchObject({
      kind: 'domain_fact', sourcePlan: { eventSetGuardDigest: expect.any(String) },
      safeDiff: { action: 'create' }
    });
    expect(fixture.unitOfWork.terminalAudits).toHaveLength(1);
  });

  test('returns typed stale/already-selected refusals with zero writes or receipt children', async () => {
    for (const [fixture, businessInput, outcome] of [[
      createFixture(), { ...input, expectedEventSetVersion: 2 }, 'event.event_set_changed'
    ], [
      createFixture({ selected: true }), { ...input, expectedEventSetVersion: 2 }, 'event.already_selected'
    ]] as const) {
      const operations = await runtime(fixture);
      const invocation = await operations.effectBuilder.build({
        operationName: 'event.create', operationVersion: 1, surface: 'operator_http',
        correlationId: ids.correlation, businessInput, verifiedEvidence: fixture.evidence,
        rawIdempotencyKey: `refusal-${outcome}`
      });
      const result = await operations.effectExecutor.execute(invocation);
      expect(result).toMatchObject({
        kind: 'outcome', terminal: false, outcome: { kind: outcome, retryable: false }
      });
      expect(fixture.unitOfWork.applyCalls).toBe(0);
      expect(fixture.unitOfWork.children).toHaveLength(0);
      expect(fixture.unitOfWork.receipts.size).toBe(0);
      expect(fixture.unitOfWork.shortAudits).toHaveLength(1);
    }
  });
});

describe('Event create preparation and contribution schema', () => {
  test('keeps preparation opaque, synchronous, one-shot, and capability-bound', () => {
    const handler = createEventCreateHandler({
      reference: { key: 'handler.event.create', version: 1 },
      handlerCapability: EVENT_CREATE_HANDLER_CAPABILITY,
      contributionSchema: { key: 'schema.event.create.contribution', version: 1, digestSha256: 'a'.repeat(64) },
      canonicalResultSchema: { key: 'schema.event.create.canonical-result', version: 1, digestSha256: 'b'.repeat(64) }
    });
    const context = Object.freeze({}) as EffectInvocationContext;
    const snapshot = sealEventCreatePreparation({
      capability: EVENT_CREATE_HANDLER_CAPABILITY,
      preparation: { prepare: () => ({ result: { kind: 'outcome', outcome: {} }, domain: null, receiptChildren: [] }) }
    });
    expect(snapshot).toEqual({ strategy: 'event_create', version: 1 });
    expect(Object.keys(snapshot)).toEqual(['strategy', 'version']);
    handler.handle({ businessInput: input, context, snapshot });
    expect(() => handler.handle({ businessInput: input, context, snapshot })).toThrow('invalid_event_create_preparation');
    expect(() => sealEventCreatePreparation({
      capability: EVENT_CREATE_HANDLER_CAPABILITY,
      preparation: { prepare: (async () => ({ result: null, domain: null, receiptChildren: [] })) as never }
    })).toThrow('event_create_preparation_must_be_synchronous');
  });

  test('accepts only coherent full plan/diff evidence or an exact zero-write refusal', () => {
    const context = {
      actor: { kind: 'workspace_user', userId: ids.user },
      scope: { workspaceId: ids.workspace }
    } as EffectInvocationContext;
    const prepared = contribution(input, context, createWorkspaceEventSet({
      workspaceId: ids.workspace, version: 1, currentEventId: null
    })).value;
    expect(eventCreateContributionSchema.safeParse(prepared).success).toBe(true);
    const reordered = structuredClone(prepared);
    const reorderedFact = reordered.receiptChildren[0];
    if (!reorderedFact || reorderedFact.kind !== 'domain_fact') throw new TypeError('missing_fact');
    reorderedFact.sourcePlan = Object.fromEntries(
      Object.entries(reorderedFact.sourcePlan).reverse()
    ) as typeof reorderedFact.sourcePlan;
    expect(eventCreateContributionSchema.safeParse(reordered).success).toBe(true);
    const tampered = structuredClone(prepared);
    const fact = tampered.receiptChildren[0];
    if (!fact || fact.kind !== 'domain_fact') throw new TypeError('missing_fact');
    fact.safeDiff.after.name = 'Changed';
    expect(eventCreateContributionSchema.safeParse(tampered).success).toBe(false);
    expect(eventCreateContributionSchema.safeParse({
      result: {
        kind: 'outcome', outcome: {
          class: 'stale_revision', kind: 'event.event_set_changed', retryable: false,
          subjects: [], detail: null, detailSchemaVersion: 1
        }
      }, domain: null, receiptChildren: []
    }).success).toBe(true);
    expect(eventCreateContributionSchema.safeParse({
      result: {
        kind: 'outcome', outcome: {
          class: 'stale_revision', kind: 'event.event_set_changed', retryable: false,
          subjects: [], detail: null, detailSchemaVersion: 1
        }
      }, domain: { kind: 'event_create' }, receiptChildren: []
    }).success).toBe(false);
  });
});
