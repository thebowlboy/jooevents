import { env } from 'cloudflare:workers';
import {
  createApplicationOperationRuntime,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  type EffectAuthorityRecheckSource,
  type InvocationEvidence
} from '@jooevents/application';
import { eventCreateOperationResultSchema } from '@jooevents/contracts';
import { createWorkspaceEventSet, projectCurrentEvent } from '@jooevents/event';
import {
  EVENT_CREATE_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_READ_ACCESS_POLICY,
  createEventOperationModule
} from '@jooevents/event-operations';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { beforeAll, describe, expect, test } from 'vitest';
import type { D1BufferedUnitOfWork } from '../src/d1-atomic-batch';
import { createD1EventCreateEffectDomainRegistration } from '../src/d1-event-domain';
import {
  D1EffectUnitOfWorkPort,
  createD1EffectDomainAdapterRegistry
} from '../src/d1-effect-unit-of-work';

const uuid = (suffix: number): string =>
  `019c1df8-a7c6-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(uuid(301));
const userId = parseUserId(uuid(302));
const membershipId = parseMembershipId(uuid(303));
const eventId = uuid(304);
const receiptId = uuid(305);
const now = parseInstant('2026-08-17T12:00:00.000Z');
const profile = { key: 'd1-event-operation-test', version: parseContractVersion(1) } as const;
let invocationSequence = 400;

interface CountRow { readonly count: number }
interface EventSetRow { readonly version: number; readonly current_event_id: string | null }

function authorityResolver(
  session: D1DatabaseSession,
  buffered?: D1BufferedUnitOfWork
): EffectAuthorityRecheckSource['resolveAuthority'] {
  return async (resolution) => {
      const row = await session.prepare(`SELECT user_id,membership_id,version
        FROM d1_event_authority_probe WHERE workspace_id = ? AND active = 1`)
        .bind(workspaceId)
        .first<{ user_id: string; membership_id: string; version: number }>();
      if (!row) return { kind: 'denied' as const, reason: 'not_authorized' as const };
      buffered?.assertCurrent(`EXISTS (
        SELECT 1 FROM d1_event_authority_probe
         WHERE workspace_id = ? AND user_id = ? AND membership_id = ?
           AND active = 1 AND version = ?
      )`, [workspaceId, row.user_id, row.membership_id, row.version]);
      return {
        kind: 'authorized' as const,
        authority: {
          actor: { kind: 'workspace_user' as const, userId: parseUserId(row.user_id) },
          principal: {
            kind: 'workspace_user' as const,
            userId: parseUserId(row.user_id),
            membershipId: parseMembershipId(row.membership_id)
          },
          lane: resolution.lane,
          scope: resolution.scope,
          grants: [{
            kind: 'permission' as const,
            key: resolution.operation.effect === 'read' ? 'event.read' : 'event.manage'
          }],
          evidenceIds: ['membership.current'],
          authorityCitationIds: [],
          evaluatedAt: resolution.evaluatedAt
        }
      };
  };
}

function authoritySource(
  session: D1DatabaseSession,
  buffered?: D1BufferedUnitOfWork
): EffectAuthorityRecheckSource {
  return Object.freeze({
    now: () => now,
    resolveAuthority: authorityResolver(session, buffered)
  });
}

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE d1_event_authority_probe (
    workspace_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0,1)),
    version INTEGER NOT NULL CHECK (version > 0)
  ) STRICT, WITHOUT ROWID`).run();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'D1 event workspace','active',1,1,1)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','D1 event owner',1,1,1)`).bind(userId),
    env.DB.prepare(`INSERT INTO event_spine_workspace_sets (workspace_id,version,current_event_id)
      VALUES (?,1,NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO d1_event_authority_probe
      (workspace_id,user_id,membership_id,active,version) VALUES (?,?,?,1,1)`)
      .bind(workspaceId, userId, membershipId)
  ]);
});

describe('registered Event operation over D1', () => {
  test('runs the unchanged application executor and atomically replays the result', async () => {
    const module = createEventOperationModule({
      workspaceId,
      policies: { read: EVENT_READ_ACCESS_POLICY, manage: EVENT_MANAGE_ACCESS_POLICY },
      currentAuthority: { resolve: authorityResolver(env.DB.withSession('first-primary')) },
      currentEventRead: {
        readCurrent: () => projectCurrentEvent(createWorkspaceEventSet({
          workspaceId,
          version: 1,
          currentEventId: null
        }), undefined)
      },
      clock: { now: () => now },
      ids: {
        newInvocationId: () => parseInvocationId(uuid(invocationSequence++))
      },
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: EVENT_CREATE_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x33)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile,
        keyBytes: new Uint8Array(32).fill(0x44)
      })
    });
    const domains = createD1EffectDomainAdapterRegistry([
      createD1EventCreateEffectDomainRegistration({
        workspaceId,
        newEventId: () => eventId,
        createdEventInitializer: {
          initializeCreatedEvent({ unitOfWork, event }) {
            unitOfWork.write(`INSERT INTO events (id,workspace_id,name,created_at,updated_at)
              VALUES (?,?,?,?,?)`, [
              event.id,
              event.workspaceId,
              event.name,
              Date.parse(event.createdAt),
              Date.parse(event.createdAt)
            ]);
          }
        }
      })
    ]);
    const unitOfWork = new D1EffectUnitOfWorkPort(env.DB, domains, {
      authorityRecheck: (buffered) => authoritySource(buffered.readSession, buffered),
      recordShortOperationAudit: () => undefined
    });
    const operations = await createApplicationOperationRuntime({
      source: module.source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => now },
        newInvocationId: () => parseInvocationId(uuid(invocationSequence++))
      },
      unitOfWork,
      newOperationLogId: () => receiptId
    });
    const evidence: InvocationEvidence = {
      kind: 'operator',
      surface: 'operator_http',
      client: { key: 'web.operator' },
      sessionHandle: 'd1-session-current'
    };
    const buildInvocation = () => operations.effectBuilder.build({
      operationName: 'event.create',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: uuid(invocationSequence++),
      businessInput: {
        expectedEventSetVersion: 1,
        name: 'D1 JooEvents Summit',
        timezone: 'Asia/Singapore',
        startDate: '2026-11-04',
        endDate: '2026-11-06'
      },
      verifiedEvidence: evidence,
      rawIdempotencyKey: 'd1-create-first-event'
    });

    const first = eventCreateOperationResultSchema.parse(
      await operations.effectExecutor.execute(await buildInvocation())
    );
    const replay = eventCreateOperationResultSchema.parse(
      await operations.effectExecutor.execute(await buildInvocation())
    );
    const eventSet = await env.DB.prepare(`SELECT version,current_event_id
      FROM event_spine_workspace_sets WHERE workspace_id = ?`)
      .bind(workspaceId).first<EventSetRow>();
    const heads = await env.DB.prepare(`SELECT count(*) AS count
      FROM event_spine_heads WHERE workspace_id = ?`).bind(workspaceId).first<CountRow>();
    const identityEvents = await env.DB.prepare(`SELECT count(*) AS count
      FROM events WHERE workspace_id = ?`).bind(workspaceId).first<CountRow>();
    const logs = await env.DB.prepare(`SELECT count(*) AS count
      FROM operation_log WHERE id = ?`).bind(receiptId).first<CountRow>();

    expect(first).toMatchObject({
      kind: 'success',
      data: { eventSetVersion: 2, event: { id: eventId, name: 'D1 JooEvents Summit' } },
      receipt: { id: receiptId, operationName: 'event.create', operationVersion: 1 }
    });
    expect(replay).toEqual(first);
    expect(eventSet).toEqual({ version: 2, current_event_id: eventId });
    expect(heads?.count).toBe(1);
    expect(identityEvents?.count).toBe(1);
    expect(logs?.count).toBe(1);
  });
});
