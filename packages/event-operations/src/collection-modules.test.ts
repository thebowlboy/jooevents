import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createOperationRegistry,
  type EffectUnitOfWork,
  type EffectUnitOfWorkPort,
  type InvocationEvidence,
  type ShortOperationAuditRecord,
  type TerminalEffectReceipt
} from '@jooevents/application';
import { EVENT_OPERATION_SCHEMA_REFS, eventListProjectionSchema } from '@jooevents/contracts';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  EVENT_LIST_READ_OPERATION,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_READ_ACCESS_POLICY,
  EVENT_SELECT_OPERATION,
  EVENT_SELECT_REQUEST_HASH_PROFILE,
  createEventListReadOperationModule,
  createEventSelectOperationModule
} from '.';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const userId = parseUserId('01890f47-9abc-7def-8123-456789abc001');
const membershipId = parseMembershipId('01890f47-9abc-7def-8123-456789abc002');
const now = parseInstant('2026-08-16T08:30:00.000Z');
const profile = { key: 'event-collection-test', version: parseContractVersion(1) } as const;
const eventId = '018f7d5a-4b3c-7abc-8def-0123456789a2';
const projection = eventListProjectionSchema.parse({
  schemaVersion: 1,
  eventSetVersion: 2,
  currentEventId: eventId,
  events: [{
    id: eventId,
    name: 'JooConf 2027',
    timezone: 'Asia/Singapore',
    startDate: '2027-04-16',
    endDate: '2027-04-18',
    version: 1
  }]
});

class UnusedUnitOfWork implements EffectUnitOfWorkPort {
  findTerminalReceipt(): TerminalEffectReceipt | undefined { return undefined; }
  recordShortOperationAudit(_record: ShortOperationAuditRecord): void {}
  async runInUnitOfWork<Value>(_work: (unitOfWork: EffectUnitOfWork) => Promise<Value>) {
    return Promise.reject(new TypeError('unused'));
  }
}

const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'session-current'
});
const currentAuthority = Object.freeze({
  resolve(input: Parameters<Parameters<typeof createEventListReadOperationModule>[0]['currentAuthority']['resolve']>[0]) {
    return Object.freeze({
      kind: 'authorized' as const,
      authority: Object.freeze({
        actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
        principal: Object.freeze({
          kind: 'workspace_user' as const, userId, membershipId
        }),
        lane: input.lane,
        scope: input.scope,
        grants: Object.freeze([Object.freeze({
          kind: 'permission' as const,
          key: input.operation.effect === 'read' ? 'event.read' : 'event.manage'
        })]),
        evidenceIds: Object.freeze(['membership.current']),
        authorityCitationIds: Object.freeze([]),
        evaluatedAt: input.evaluatedAt
      })
    });
  }
});

describe('Event collection operation modules', () => {
  test('reads the compact collection through the exact operator binding', async () => {
    const module = createEventListReadOperationModule({
      workspaceId,
      readPolicy: EVENT_READ_ACCESS_POLICY,
      currentAuthority,
      list: { readList: () => projection },
      clock: { now: () => now },
      ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile
    });
    const runtime = await createApplicationOperationRuntime({
      source: module.source,
      read: {
        operationalTrace: { emit() {} }, immutableAudit: { append() {} },
        clock: { now: () => now },
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      },
      unitOfWork: new UnusedUnitOfWork()
    });
    expect(runtime.registry.operatorHttpBindings).toEqual([{
      operationName: EVENT_LIST_READ_OPERATION.name,
      operationVersion: 1,
      surface: 'operator_http', method: 'GET', path: '/api/events', input: 'query'
    }]);
    expect(runtime.registry.safeManifest.operations[0]?.inputSchema)
      .toEqual(EVENT_OPERATION_SCHEMA_REFS.listRead.inputSchema);
    expect(await runtime.readExecutor.execute({
      operationName: EVENT_LIST_READ_OPERATION.name,
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: '018f7d5a-4b3c-7abc-8def-0123456789a7',
      businessInput: {},
      verifiedEvidence: evidence
    })).toMatchObject({ kind: 'success', data: projection });
  });

  test('registers one direct audited workspace-wide selection operation', async () => {
    const module = createEventSelectOperationModule({
      workspaceId,
      managePolicy: EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority,
      clock: { now: () => now },
      ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: EVENT_SELECT_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x61)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile, keyBytes: new Uint8Array(32).fill(0x62)
      })
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpEffectBindings).toEqual([{
      operationName: EVENT_SELECT_OPERATION.name,
      operationVersion: 1,
      surface: 'operator_http', method: 'POST', path: '/api/events/select', input: 'body'
    }]);
    const operation = module.source.effectOperations?.[0];
    expect(operation?.inputSchema).toEqual(EVENT_OPERATION_SCHEMA_REFS.select.inputSchema);
    expect(operation?.execution).toMatchObject({
      profile: 'direct_audited', history: { summary: 'Selected an event' }
    });
    expect(operation?.agentAction).toMatchObject({
      eligible: true, displayLabel: 'Select an event'
    });
    expect(operation?.outcomes.map((outcome) => `${outcome.class}:${outcome.kind}`))
      .toEqual(expect.arrayContaining([
        'stale_revision:event.event_set_changed',
        'conflict:event.already_selected',
        'conflict:event.not_found'
      ]));
  });
});
