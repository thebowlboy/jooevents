import { env } from 'cloudflare:workers';
import {
  createApplicationOperationRuntime,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createOperatorAuthorityPolicyCatalog,
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
import { createD1EventCreateEffectDomainRegistration } from '../src/d1-event-domain';
import {
  D1EffectUnitOfWorkPort,
  createD1EffectDomainAdapterRegistry
} from '../src/d1-effect-unit-of-work';
import { createD1OperatorCurrentAuthorityResolver } from '../src/d1-operator-authority';

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

beforeAll(async () => {
  const authUserId = uuid(306);
  const roleId = uuid(307);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'D1 event workspace','active',1,1,1)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','D1 event owner',1,1,1)`).bind(userId),
    env.DB.prepare(`INSERT INTO event_spine_workspace_sets (workspace_id,version,current_event_id)
      VALUES (?,1,NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'D1 event owner','d1-event-owner@example.invalid',1,NULL,1,1)`)
      .bind(authUserId),
    env.DB.prepare(`INSERT INTO auth_sessions
      (id,token,user_id,expires_at,ip_address,user_agent,created_at,updated_at)
      VALUES (?,'d1-event-session-token',?,?,NULL,NULL,1,1)`)
      .bind('d1-event-session', authUserId, Date.parse(now) + 86_400_000),
    env.DB.prepare(`INSERT INTO auth_user_links
      (auth_user_id,user_id,provisioning_state,last_error_code,attempts,created_at,updated_at)
      VALUES (?,?,'ready',NULL,0,1,1)`).bind(authUserId, userId),
    env.DB.prepare(`INSERT INTO workspace_memberships
      (id,workspace_id,user_id,status,approved_by_user_id,approved_at,decision_reason,
       created_at,updated_at,version)
      VALUES (?,?,?,'active',?,1,NULL,1,1,1)`)
      .bind(membershipId, workspaceId, userId, userId),
    env.DB.prepare(`INSERT INTO roles
      (id,workspace_id,name,description,source_preset_key,source_preset_version,
       archived_at,created_at,updated_at,version)
      VALUES (?,?,'D1 event manager','Event test role',NULL,NULL,NULL,1,1,1)`)
      .bind(roleId, workspaceId),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'event.read'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'event.manage'),
    env.DB.prepare(`INSERT INTO role_assignments
      (id,user_id,role_id,workspace_id,scope_kind,event_id,assigned_by_user_id,
       assigned_at,expires_at,version)
      VALUES (?,?,?,?, 'workspace',NULL,?,1,NULL,1)`)
      .bind(uuid(308), userId, roleId, workspaceId, userId)
  ]);
});

describe('registered Event operation over D1', () => {
  test('runs the unchanged application executor and atomically replays the result', async () => {
    const policies = createOperatorAuthorityPolicyCatalog([
      { policy: EVENT_READ_ACCESS_POLICY, permissionId: 'event.read' },
      { policy: EVENT_MANAGE_ACCESS_POLICY, permissionId: 'event.manage' }
    ]);
    const module = createEventOperationModule({
      workspaceId,
      policies: { read: EVENT_READ_ACCESS_POLICY, manage: EVENT_MANAGE_ACCESS_POLICY },
      currentAuthority: createD1OperatorCurrentAuthorityResolver({
        session: env.DB.withSession('first-primary'),
        workspaceId,
        policies
      }),
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
      authorityRecheck: (buffered) => {
        const currentAuthority = createD1OperatorCurrentAuthorityResolver({
          session: buffered.readSession,
          unitOfWork: buffered,
          workspaceId,
          policies
        });
        return Object.freeze({ now: () => now, resolveAuthority: currentAuthority.resolve });
      },
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
      sessionHandle: 'd1-event-session'
    };
    const buildInvocation = (
      rawIdempotencyKey = 'd1-create-first-event',
      expectedEventSetVersion = 1
    ) => operations.effectBuilder.build({
      operationName: 'event.create',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: uuid(invocationSequence++),
      businessInput: {
        expectedEventSetVersion,
        name: 'D1 JooEvents Summit',
        timezone: 'Asia/Singapore',
        startDate: '2026-11-04',
        endDate: '2026-11-06'
      },
      verifiedEvidence: evidence,
      rawIdempotencyKey
    });

    const first = eventCreateOperationResultSchema.parse(
      await operations.effectExecutor.execute(await buildInvocation())
    );
    if (first.kind !== 'success') throw new Error(`unexpected_event_result:${JSON.stringify(first)}`);
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

    await env.DB.prepare(`UPDATE workspace_memberships
      SET status = 'suspended',updated_at = 2,version = version + 1 WHERE id = ?`)
      .bind(membershipId).run();
    const denied = eventCreateOperationResultSchema.parse(
      await operations.effectExecutor.execute(await buildInvocation('after-revocation', 2))
    );
    expect(denied).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: { class: 'access_denied', kind: 'authority.revoked', retryable: false }
    });
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM event_spine_heads
      WHERE workspace_id = ?`).bind(workspaceId).first<CountRow>())?.count).toBe(1);
  });
});
