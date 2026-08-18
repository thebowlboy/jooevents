import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  FakeAirtableProvider,
  parseAirtableBaseId,
  parseAirtableCursor,
  parseAirtableFieldId,
  parseAirtableRecordId,
  parseAirtableTableId,
  parseAirtableWebhookId
} from '@jooevents/airtable';
import {
  createSecretReference,
  createSecretStoreAdapterRef
} from '@jooevents/application';
import {
  AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR,
  consumeCloudflareAirtableWakeBatch,
  createDefaultManagedBaseManifest,
  createManagedProvisioningState,
  processOneAirtableShadowSettle,
  processOneControlledAirtableSettle,
  runAirtableOutboundJob,
  runManagedProvisioningStep,
  scanOneAirtableReconciliationPage,
  type ManagedProjectedRecord
} from '@jooevents/airtable-sync';
import {
  installSQLiteAirtableSync,
  type AirtableSyncWake,
  SQLiteAirtableInboundBoundaryPort,
  SQLiteAirtableInboundCursorRepository,
  SQLiteAirtableProjectionContributionAdapter,
  SQLiteAirtableProviderThrottle,
  SQLiteAirtableReconciliationRepository,
  SQLiteAirtableShadowSettleRepository,
  SQLiteAirtableOutboundJobRepository,
  SQLiteAirtableSyncRepository
} from './airtable-sync';
import {
  createSQLiteOperationFeatureContributionAdapterRegistry
} from './operation-feature-contribution-registry';

const connectionId = '018f0f64-4d6c-7b2f-8a1e-1234567890ab';
const workspaceId = '018f0f64-4d6c-7b2f-8a1e-1234567890ac';
const mappingId = '018f0f64-4d6c-7b2f-8a1e-1234567890ad';
const linkId = '018f0f64-4d6c-7b2f-8a1e-1234567890ae';
const workId = '018f0f64-4d6c-7b2f-8a1e-1234567890af';
const settleId = '018f0f64-4d6c-7b2f-8a1e-1234567890b0';
const observationId = '018f0f64-4d6c-7b2f-8a1e-1234567890b1';
const reconciliationRunId = '018f0f64-4d6c-7b2f-8a1e-1234567890b2';
const reconciliationFindingId = '018f0f64-4d6c-7b2f-8a1e-1234567890b3';
const reconciliationWorkId = '018f0f64-4d6c-7b2f-8a1e-1234567890b4';
const digest = 'a'.repeat(64);

function setup() {
  const sqlite = new Database(':memory:', { strict: true });
  installSQLiteAirtableSync(sqlite);
  const repository = new SQLiteAirtableSyncRepository(sqlite);
  repository.createConnection({
    id: connectionId,
    workspaceId,
    publicCallbackRef: 'opaque-callback-reference-000000000001',
    providerAccountId: 'usr00000000000001',
    nowMs: 1_000
  });
  repository.addMappingRevision({
    id: mappingId,
    connectionId,
    revision: 1,
    manifestVersion: 1,
    status: 'active',
    mappingDigest: digest,
    mapping: { areas: [] },
    nowMs: 1_000
  });
  return { sqlite, repository };
}

describe('SQLite Airtable sync', () => {
  test('persists a full reconciliation scan, schedules a missing-record repair, and updates health', async () => {
    const { sqlite, repository } = setup();
    const provider = new FakeAirtableProvider();
    const providerWorkspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const created = await provider.data.createBase({
      workspaceId: providerWorkspaceId,
      name: 'JooEvents',
      tables: [{ name: 'Tasks', fields: [
        { name: 'Task', type: 'singleLineText' },
        { name: 'JooEvents ID', type: 'singleLineText' }
      ] }]
    });
    if (created.kind === 'failure') throw new Error(created.failure.code);
    const table = created.value.tables[0]!;
    const stableFieldId = table.fields.find((field) => field.name === 'JooEvents ID')!.id;
    const taskFieldId = table.fields.find((field) => field.name === 'Task')!.id;
    repository.upsertRecordLink({
      id: linkId,
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task_assignment',
      subjectId: workId,
      providerTableId: table.id,
      providerRecordId: parseAirtableRecordId('rec00000000000099'),
      canonicalVersion: 4,
      baseline: { task: 'Headshot' },
      baselineDigest: digest,
      nowMs: 1_000
    });
    const reconciliation = new SQLiteAirtableReconciliationRepository(sqlite);
    reconciliation.createRun({
      id: reconciliationRunId,
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      baseId: created.value.id,
      tableId: table.id,
      stableIdFieldId: stableFieldId,
      comparedFieldIds: [taskFieldId],
      kind: 'full',
      nowMs: 2_000
    });
    expect(await scanOneAirtableReconciliationPage({
      connectionId,
      workerId: 'reconcile-worker',
      nowMs: 2_100,
      repository: reconciliation,
      provider: provider.data
    })).toEqual({ kind: 'ready_to_assess', runId: reconciliationRunId, records: 0 });
    expect(reconciliation.assessReadyRun({
      runId: reconciliationRunId,
      nowMs: 2_200,
      newFindingId: () => reconciliationFindingId,
      newWorkId: () => reconciliationWorkId
    })).toEqual({ findings: 1, repairsScheduled: 1, settlesScheduled: 0, state: 'pending' });
    expect(reconciliation.readHealth(connectionId)).toMatchObject({
      state: 'pending', dueWork: 1, schemaDrift: 0,
      lastFullSummary: '1 managed record needs attention or repair.'
    });
    expect(sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM airtable_sync_reconciliation_findings
    `).get()).toEqual({ count: 1 });
    sqlite.close();
  });

  test('retention recovery replays intact records through three-way settle without duplicating an inbound write', async () => {
    const { sqlite, repository } = setup();
    sqlite.query(`UPDATE airtable_sync_connections SET state = 'active' WHERE id = ?`)
      .run(connectionId);
    const provider = new FakeAirtableProvider();
    const providerWorkspaceId = provider.seedWorkspace({
      id: 'wsp00000000000001', name: 'Events'
    });
    const created = await provider.data.createBase({
      workspaceId: providerWorkspaceId,
      name: 'JooEvents',
      tables: [{ name: 'Tasks', fields: [
        { name: 'JooEvents ID', type: 'singleLineText' },
        { name: 'Status', type: 'singleLineText' }
      ] }]
    });
    if (created.kind === 'failure') throw new Error(created.failure.code);
    const table = created.value.tables[0]!;
    const stableFieldId = table.fields[0]!.id;
    const statusFieldId = table.fields[1]!.id;
    const providerRecordId = provider.seedRecord({
      baseId: created.value.id,
      tableId: table.id,
      fields: { [stableFieldId]: workId, [statusFieldId]: 'Complete' }
    });
    const secretReference = createSecretReference({
      id: 'secret.airtable.webhook.recovery.0001',
      version: 1,
      adapter: createSecretStoreAdapterRef('secret.memory', 1),
      purpose: 'airtable.webhook.mac',
      scopeBinding: connectionId
    });
    repository.saveWebhookRegistration({
      connectionId,
      baseId: created.value.id,
      webhookId: 'ach00000000000001',
      macSecret: { secretReference },
      expiresAtMs: 100_000,
      nowMs: 1_000
    });
    repository.upsertRecordLink({
      id: linkId,
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task_assignment',
      subjectId: workId,
      providerTableId: table.id,
      providerRecordId,
      canonicalVersion: 1,
      baseline: { 'task.status': 'Open' },
      baselineDigest: digest,
      nowMs: 1_000
    });
    const reconciliation = new SQLiteAirtableReconciliationRepository(sqlite);
    const recover = async (runId: string, nowMs: number) => {
      reconciliation.createRun({
        id: runId,
        connectionId,
        mappingRevision: 1,
        areaKey: 'tasks',
        baseId: created.value.id,
        tableId: table.id,
        stableIdFieldId: stableFieldId,
        comparedFieldIds: [statusFieldId],
        kind: 'retention_recovery',
        nowMs
      });
      expect(repository.hasOpenRetentionRecovery(connectionId)).toBe(true);
      expect((await scanOneAirtableReconciliationPage({
        connectionId,
        workerId: `reconcile-${nowMs}`,
        nowMs: nowMs + 1,
        repository: reconciliation,
        provider: provider.data
      })).kind).toBe('ready_to_assess');
      expect(reconciliation.assessReadyRun({
        runId,
        nowMs: nowMs + 2,
        newFindingId: () => globalThis.crypto.randomUUID(),
        newWorkId: () => globalThis.crypto.randomUUID(),
        newSettleId: () => globalThis.crypto.randomUUID()
      })).toEqual({
        findings: 0,
        repairsScheduled: 0,
        settlesScheduled: 1,
        state: 'pending'
      });
      expect(repository.hasOpenRetentionRecovery(connectionId)).toBe(false);
    };
    let localStatus = 'Open';
    let localVersion = 1;
    let operationWrites = 0;
    const shadow = new SQLiteAirtableShadowSettleRepository(repository, {
      async resolve() {
        return {
          mappings: [{
            fieldKey: 'task.status',
            fieldId: statusFieldId,
            mode: 'editable_in_airtable',
            dataClassification: 'ordinary'
          }],
          local: { 'task.status': localStatus },
          subjectVersion: localVersion
        };
      }
    });
    const boundary = new SQLiteAirtableInboundBoundaryPort(repository, {
      nowMs: () => 10_000,
      newId: () => globalThis.crypto.randomUUID()
    });
    const operations = {
      async setTaskAssignmentStatus(input: { status: 'complete' | 'open' }) {
        operationWrites += 1;
        localStatus = input.status === 'complete' ? 'Complete' : 'Open';
        localVersion += 1;
        return { kind: 'applied' as const, operationReceiptId: globalThis.crypto.randomUUID() };
      },
      async setEngagementCancellationRequest() {
        throw new Error('unexpected engagement operation');
      },
      async requestRecordDeletionReview() {
        throw new Error('unexpected deletion operation');
      }
    };

    await recover(reconciliationRunId, 2_000);
    expect(await processOneControlledAirtableSettle({
      connectionId,
      workerId: 'settle-1',
      nowMs: 2_100,
      repository: shadow,
      provider: provider.data,
      operations,
      boundary
    })).toMatchObject({ kind: 'settled' });
    expect({ localStatus, operationWrites }).toEqual({ localStatus: 'Complete', operationWrites: 1 });

    await recover('018f0f64-4d6c-7b2f-8a1e-1234567890c0', 4_000);
    expect(await processOneControlledAirtableSettle({
      connectionId,
      workerId: 'settle-2',
      nowMs: 4_100,
      repository: shadow,
      provider: provider.data,
      operations,
      boundary
    })).toMatchObject({ kind: 'settled' });
    expect(operationWrites).toBe(1);
    expect(sqlite.query<{ readonly count: number }, []>(`
      SELECT count(*) AS count
        FROM airtable_sync_boundary_observations
       WHERE kind = 'applied'
    `).get()).toEqual({ count: 1 });
    sqlite.close();
  });

  test('joined organizer contribution reaches fake Airtable through the shared registered-job wake', async () => {
    const { sqlite, repository } = setup();
    sqlite.query(`UPDATE airtable_sync_connections SET state = 'active' WHERE id = ?`)
      .run(connectionId);
    sqlite.query(`UPDATE airtable_sync_mapping_revisions SET mapping_json = ? WHERE id = ?`)
      .run(JSON.stringify({
        areas: [{ areaKey: 'tasks', direction: 'keep_airtable_updated', fields: [] }]
      }), mappingId);

    const provider = new FakeAirtableProvider();
    const providerWorkspaceId = provider.seedWorkspace({
      id: 'wsp00000000000001', name: 'Events'
    });
    const created = await provider.data.createBase({
      workspaceId: providerWorkspaceId,
      name: 'JooEvents',
      tables: [{
        name: 'Tasks',
        fields: [
          { name: 'Task', type: 'singleLineText' },
          { name: 'Status', type: 'singleLineText' },
          { name: 'JooEvents ID', type: 'singleLineText' }
        ]
      }]
    });
    if (created.kind === 'failure') throw new Error(created.failure.code);
    const table = created.value.tables[0]!;
    const field = (name: string) => table.fields.find((candidate) => candidate.name === name)!.id;
    const wakes: AirtableSyncWake[] = [];
    const contributionAdapter = new SQLiteAirtableProjectionContributionAdapter(
      sqlite,
      () => workId,
      { async publish(wake) { wakes.push(wake); } }
    );
    sqlite.exec('BEGIN IMMEDIATE;');
    contributionAdapter.apply({
      contributor: AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR,
      operationLogId: '018f0f64-4d6c-7b2f-8a1e-1234567890d0',
      value: {
        schemaVersion: 2,
        catalogDigestSha256: digest,
        workspaceId,
        eventId: null,
        occurredAt: '2026-08-17T00:00:01.000Z',
        impacts: [{
          areaKey: 'tasks',
          subjectKind: 'task_assignment',
          subjectId: '018f0f64-4d6c-7b2f-8a1e-1234567890d1',
          projectionVersion: 7
        }]
      }
    });
    sqlite.exec('COMMIT;');
    await contributionAdapter.afterUnitOfWorkCommitted();
    contributionAdapter.afterUnitOfWorkFinished();
    expect(wakes).toHaveLength(1);

    const actions: string[] = [];
    const jobRepository = new SQLiteAirtableOutboundJobRepository(repository);
    await consumeCloudflareAirtableWakeBatch({
      batch: { messages: [wakes[0]!, wakes[0]!].map((wake, index) => ({
        id: `message-${index}`,
        body: wake,
        attempts: 1,
        ack: () => actions.push(`ack-${index}`),
        retry: () => actions.push(`retry-${index}`)
      })) },
      invoker: {
        async run({ wake }) {
          const result = await runAirtableOutboundJob({
            connectionId: wake.connectionId,
            workerId: `worker-${wake.wakeId}`,
            nowMs: Date.parse('2026-08-17T00:00:02.000Z'),
            repository: jobRepository,
            source: {
              async readCurrent() {
                return {
                  projectionVersion: 7,
                  fingerprint: 'local-seven',
                  fields: { task: 'Confirm slides', status: 'Open' }
                };
              },
              async resolveTarget() {
                return {
                  mappingRevision: 1,
                  baseId: created.value.id,
                  tableId: table.id,
                  stableIdFieldId: field('JooEvents ID'),
                  fieldIds: { task: field('Task'), status: field('Status') }
                };
              }
            },
            provider: provider.data
          });
          return result.kind === 'processed' ? { kind: 'completed' as const } : result;
        }
      }
    });
    expect(actions).toEqual(['ack-0', 'ack-1']);
    const records = await provider.data.listRecords({
      baseId: created.value.id,
      tableId: table.id,
      fieldIds: [field('Task'), field('Status'), field('JooEvents ID')],
      pageSize: 10
    });
    expect(records.kind).toBe('success');
    if (records.kind === 'success') {
      expect(records.value.records).toHaveLength(1);
      expect(records.value.records[0]?.fields[field('Task')]).toBe('Confirm slides');
    }
    const link = sqlite.query<{
      readonly canonical_version: number;
      readonly baseline_json: string;
      readonly baseline_digest: string;
      readonly provider_fingerprint: string;
    }, []>(`
      SELECT canonical_version, baseline_json, baseline_digest, provider_fingerprint
        FROM airtable_sync_record_links
    `).get();
    expect(link).toMatchObject({
      canonical_version: 7,
      baseline_json: JSON.stringify({ status: 'Open', task: 'Confirm slides' })
    });
    expect(link?.baseline_digest).toHaveLength(64);
    expect(link?.provider_fingerprint).toHaveLength(64);
    sqlite.close();
  });

  test('fences connection workers and shares one persisted per-base cooldown', async () => {
    const { sqlite, repository } = setup();
    const first = repository.claimConnectionLease({
      connectionId, workerId: 'worker-a', nowMs: 1_000, leaseMs: 5_000
    });
    expect(first).toMatchObject({ workerId: 'worker-a', fence: 1 });
    expect(repository.claimConnectionLease({
      connectionId, workerId: 'worker-b', nowMs: 1_001, leaseMs: 5_000
    })).toBeUndefined();
    const reclaimed = repository.claimConnectionLease({
      connectionId, workerId: 'worker-b', nowMs: 6_001, leaseMs: 5_000
    });
    expect(reclaimed).toMatchObject({ workerId: 'worker-b', fence: 2 });
    expect(repository.releaseConnectionLease({ lease: first!, nowMs: 6_002 })).toBe(false);
    expect(repository.releaseConnectionLease({ lease: reclaimed!, nowMs: 6_003 })).toBe(true);

    const throttle = new SQLiteAirtableProviderThrottle(repository);
    await throttle.observe({
      baseId: 'app00000000000001',
      nowMs: 10_000,
      failure: {
        code: 'rate_limited',
        retryAfterMs: 30_000
      }
    });
    expect(await throttle.beforeRequest({
      baseId: 'app00000000000001', nowMs: 20_000
    })).toEqual({ kind: 'delayed', retryAfterMs: 20_000 });
    expect(await throttle.beforeRequest({
      baseId: 'app00000000000001', nowMs: 40_001
    })).toEqual({ kind: 'ready' });
    sqlite.close();
  });

  test('active mapping contributions coalesce atomically and lost wakes remain discoverable', async () => {
    const { sqlite, repository } = setup();
    sqlite.query(`UPDATE airtable_sync_connections SET state = 'active' WHERE id = ?`)
      .run(connectionId);
    sqlite.query(`
      UPDATE airtable_sync_mapping_revisions
         SET mapping_json = ?
       WHERE id = ?
    `).run(JSON.stringify({
      areas: [{ areaKey: 'tasks', direction: 'keep_airtable_updated', fields: [] }]
    }), mappingId);
    const attemptedWakes: unknown[] = [];
    let nextId = 0xb9;
    const adapter = new SQLiteAirtableProjectionContributionAdapter(
      sqlite,
      () => `018f0f64-4d6c-7b2f-8a1e-1234567890${(nextId++).toString(16)}`,
      {
        async publish(wake) {
          attemptedWakes.push(wake);
          throw new Error('queue unavailable');
        }
      }
    );
    for (let version = 1; version <= 10; version += 1) {
      sqlite.exec('BEGIN IMMEDIATE;');
      adapter.apply({
        contributor: AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR,
        operationLogId: `018f0f64-4d6c-7b2f-8a1e-123456789${String(version).padStart(3, '0')}`,
        value: {
          schemaVersion: 2,
          catalogDigestSha256: digest,
          workspaceId,
          eventId: null,
          occurredAt: `2026-08-17T00:00:${String(version).padStart(2, '0')}.000Z`,
          impacts: [{
            areaKey: 'tasks',
            subjectKind: 'task_assignment',
            subjectId: '018f0f64-4d6c-7b2f-8a1e-1234567890c0',
            projectionVersion: version
          }]
        }
      });
      sqlite.exec('COMMIT;');
      await adapter.afterUnitOfWorkCommitted();
      adapter.afterUnitOfWorkFinished();
    }
    const due = repository.claimDueProjectionWork({
      connectionId,
      workerId: 'worker-a',
      nowMs: Date.parse('2026-08-17T00:01:00.000Z'),
      leaseMs: 5_000,
      limit: 10
    });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ requestedProjectionVersion: 10 });
    expect(attemptedWakes).toHaveLength(10);
    expect(repository.listDueProjectionConnections({
      nowMs: Date.parse('2026-08-17T00:01:00.000Z'),
      limit: 10
    })).toEqual([]);
    expect(repository.finishProjectionWork({
      id: due[0]!.id,
      workerId: 'worker-a',
      leaseVersion: due[0]!.leaseVersion,
      outcome: 'failed',
      nextAttemptAtMs: Date.parse('2026-08-17T00:01:05.000Z'),
      nowMs: Date.parse('2026-08-17T00:01:00.000Z'),
      errorCode: 'provider_unavailable'
    })).toBe(true);
    expect(repository.listDueProjectionConnections({
      nowMs: Date.parse('2026-08-17T00:01:06.000Z'),
      limit: 10
    })).toEqual([connectionId]);
    sqlite.close();
  });

  test('area refresh contributions discover new managed subjects inside the committed operation', async () => {
    const { sqlite, repository } = setup();
    const eventId = '018f0f64-4d6c-7b2f-8a1e-1234567890ff';
    sqlite.exec(`
      CREATE TABLE event_spine_heads(
        workspace_id TEXT,event_id TEXT,id TEXT,name TEXT,start_date TEXT,end_date TEXT,version INTEGER
      );
      CREATE TABLE event_settings_companions(
        workspace_id TEXT,event_id TEXT,event_version INTEGER
      );
    `);
    sqlite.query(`INSERT INTO event_spine_heads VALUES (?,?,?,?,?,?,?)`).run(
      workspaceId, eventId, eventId, 'JooConf', '2027-02-20', '2027-02-21', 3
    );
    sqlite.query(`UPDATE airtable_sync_connections SET state='active' WHERE id=?`).run(connectionId);
    sqlite.query(`
      UPDATE airtable_sync_mapping_revisions
         SET mapping_json='{"areas":[{"areaKey":"events","direction":"keep_airtable_updated"}]}'
       WHERE id=?
    `).run(mappingId);
    const adapter = new SQLiteAirtableProjectionContributionAdapter(
      sqlite,
      () => crypto.randomUUID(),
      { async publish() {} }
    );
    sqlite.exec('BEGIN IMMEDIATE;');
    adapter.apply({
      contributor: AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR,
      operationLogId: '018f0f64-4d6c-7b2f-8a1e-1234567890fe',
      value: {
        schemaVersion: 2,
        catalogDigestSha256: digest,
        workspaceId,
        eventId,
        occurredAt: '2026-08-17T00:00:00.000Z',
        impacts: [],
        refreshAreas: ['events']
      }
    });
    sqlite.exec('COMMIT;');
    expect(repository.claimDueProjectionWork({
      connectionId,
      workerId: 'refresh-worker',
      nowMs: Date.parse('2026-08-17T00:00:01.000Z'),
      leaseMs: 5_000,
      limit: 10
    })).toMatchObject([{
      areaKey: 'events', subjectKind: 'event', subjectId: eventId,
      requestedProjectionVersion: 3
    }]);
    sqlite.close();
  });

  test('stores only fenced opaque OAuth grant references', () => {
    const { sqlite, repository } = setup();
    const reference = createSecretReference({
      id: 'secret.airtable.0001',
      version: 1,
      adapter: createSecretStoreAdapterRef('secret.memory', 1),
      purpose: 'airtable.oauth.grant',
      scopeBinding: connectionId
    });
    const stored = {
      secretReference: reference,
      accessExpiresAt: '2026-08-17T01:00:00.000Z',
      refreshExpiresAt: '2026-10-16T00:00:00.000Z',
      scopes: ['data.records:read'] as const
    };
    expect(repository.saveOAuthGrantReference({
      connectionId, stored, nowMs: 1_100
    })).toBe(true);
    expect(repository.saveOAuthGrantReference({
      connectionId, stored, nowMs: 1_101
    })).toBe(false);
    expect(repository.saveOAuthGrantReference({
      connectionId, stored: { ...stored, secretReference: createSecretReference({
        id: reference.id,
        version: 2,
        adapter: reference.adapter,
        purpose: reference.purpose,
        scopeBinding: reference.scopeBinding
      }) }, expectedVersion: 1, nowMs: 1_102
    })).toBe(true);
    expect(repository.saveOAuthGrantReference({
      connectionId, stored, expectedVersion: 1, nowMs: 1_103
    })).toBe(false);
    const row = sqlite.query<Record<string, unknown>, []>(`
      SELECT * FROM airtable_sync_grant_references
    `).get();
    expect(JSON.stringify(row)).not.toContain('access-secret');
    expect(row?.secret_reference_version).toBe(2);
    sqlite.close();
  });

  test('reconnect replaces the revoked grant while preserving the managed connection', () => {
    const { sqlite, repository } = setup();
    const adapter = createSecretStoreAdapterRef('secret.memory', 1);
    const firstReference = createSecretReference({
      id: 'secret.airtable.reconnect.grant.0001', version: 1, adapter,
      purpose: 'airtable.oauth.grant', scopeBinding: connectionId
    });
    expect(repository.saveOAuthGrantReference({
      connectionId,
      stored: {
        secretReference: firstReference,
        accessExpiresAt: '2026-08-17T01:00:00.000Z',
        refreshExpiresAt: '2026-10-16T00:00:00.000Z',
        scopes: ['data.records:read']
      },
      nowMs: 1_100
    })).toBe(true);
    sqlite.query(`UPDATE airtable_sync_connections SET state='active' WHERE id=?`).run(connectionId);
    expect(repository.markConnectionNeedsReconnect({
      connectionId, expectedVersion: 1, nowMs: 1_200
    })).toBe(true);
    const attemptReference = createSecretReference({
      id: 'secret.airtable.reconnect.attempt.0001', version: 1, adapter,
      purpose: 'airtable.oauth.attempt', scopeBinding: connectionId
    });
    repository.createOAuthConnectionAttempt({
      connectionId,
      workspaceId,
      publicCallbackRef: 'opaque-callback-reference-000000000001',
      attemptId: '018f0f64-4d6c-7b2f-8a1e-1234567890c9',
      stored: {
        secretReference: attemptReference,
        stateDigestSha256: 'c'.repeat(64),
        scopes: ['data.records:read', 'data.records:write'],
        expiresAt: '2026-08-17T00:10:00.000Z'
      },
      redirectUri: 'https://events.example.test/api/integrations/airtable/oauth/callback',
      nowMs: 1_300
    });
    const claim = repository.claimOAuthAttempt({
      stateDigestSha256: 'c'.repeat(64), workerId: 'reconnect-worker',
      nowMs: 1_400, leaseMs: 5_000
    });
    expect(claim).toBeDefined();
    const replacementReference = createSecretReference({
      id: 'secret.airtable.reconnect.grant.0002', version: 1, adapter,
      purpose: 'airtable.oauth.grant', scopeBinding: connectionId
    });
    expect(repository.completeOAuthConnection({
      claim: claim!,
      providerAccountId: 'usr00000000000002',
      stored: {
        secretReference: replacementReference,
        accessExpiresAt: '2026-08-17T02:00:00.000Z',
        refreshExpiresAt: '2026-11-16T00:00:00.000Z',
        scopes: ['data.records:read', 'data.records:write']
      },
      nowMs: 1_500
    })).toBe(true);
    expect(repository.readWorkspaceConnection(workspaceId)).toMatchObject({
      id: connectionId,
      state: 'active',
      providerAccountId: 'usr00000000000002',
      grant: { secretReference: { id: replacementReference.id } }
    });
    sqlite.close();
  });

  test('claims OAuth attempts by state digest and fences callback replay', () => {
    const { sqlite, repository } = setup();
    const reference = createSecretReference({
      id: 'secret.airtable.attempt.0001',
      version: 1,
      adapter: createSecretStoreAdapterRef('secret.memory', 1),
      purpose: 'airtable.oauth.attempt',
      scopeBinding: connectionId
    });
    repository.createOAuthAttempt({
      id: '018f0f64-4d6c-7b2f-8a1e-1234567890b9',
      connectionId,
      stored: {
        secretReference: reference,
        stateDigestSha256: 'b'.repeat(64),
        scopes: ['schema.bases:write'],
        expiresAt: '2026-08-17T00:10:00.000Z'
      },
      redirectUri: 'https://events.example.test/api/integrations/airtable/callback',
      nowMs: 1_000
    });
    const first = repository.claimOAuthAttempt({
      stateDigestSha256: 'b'.repeat(64),
      workerId: 'worker-a',
      nowMs: 2_000,
      leaseMs: 5_000
    });
    expect(first).toMatchObject({ workerId: 'worker-a', leaseVersion: 1 });
    expect(repository.claimOAuthAttempt({
      stateDigestSha256: 'b'.repeat(64),
      workerId: 'worker-b',
      nowMs: 2_001,
      leaseMs: 5_000
    })).toBeUndefined();
    const second = repository.claimOAuthAttempt({
      stateDigestSha256: 'b'.repeat(64),
      workerId: 'worker-b',
      nowMs: 7_001,
      leaseMs: 5_000
    });
    expect(second).toMatchObject({ workerId: 'worker-b', leaseVersion: 2 });
    expect(repository.finishOAuthAttempt({
      id: first!.id,
      workerId: first!.workerId,
      leaseVersion: first!.leaseVersion,
      outcome: 'consumed',
      nowMs: 7_002
    })).toBe(false);
    expect(repository.finishOAuthAttempt({
      id: second!.id,
      workerId: second!.workerId,
      leaseVersion: second!.leaseVersion,
      outcome: 'consumed',
      nowMs: 7_003
    })).toBe(true);
    expect(repository.claimOAuthAttempt({
      stateDigestSha256: 'b'.repeat(64), workerId: 'worker-c', nowMs: 7_004, leaseMs: 5_000
    })).toBeUndefined();
    sqlite.close();
  });

  test('persists fenced resumable managed-base provisioning through snapshot verification', async () => {
    const { sqlite, repository } = setup();
    const provider = new FakeAirtableProvider();
    const providerWorkspaceId = provider.seedWorkspace({
      id: 'wsp00000000000001',
      name: 'Events'
    });
    const manifest = createDefaultManagedBaseManifest({
      scope: 'single_event',
      includeSpeakerEmail: false,
      includeSpeakerPhone: false
    });
    repository.createProvisioningRun({
      state: createManagedProvisioningState({
        connectionId,
        providerWorkspaceId,
        baseName: 'JooEvents · Riverside',
        manifest
      }),
      nowMs: 1_100
    });
    const records: ManagedProjectedRecord[] = Array.from({ length: 11 }, (_, index) => ({
      subjectKey: `task-${index + 1}`,
      fields: { task: `Task ${index + 1}`, status: 'Open' }
    }));
    const source = {
      async listPage(input: { tableKey: string; cursor?: string; limit: 10 }) {
        if (input.tableKey !== 'tasks') return { records: [] };
        const start = input.cursor === undefined ? 0 : Number(input.cursor);
        const page = records.slice(start, start + input.limit);
        const next = start + page.length;
        return { records: page, ...(next < records.length ? { nextCursor: String(next) } : {}) };
      }
    };
    for (let index = 0; index < 30; index += 1) {
      const result = await runManagedProvisioningStep({
        connectionId,
        workerId: 'worker-a',
        nowMs: 2_000 + index * 10,
        leaseMs: 5_000,
        manifest,
        repository,
        provider: provider.data,
        source
      });
      if (result.kind === 'ready') break;
      if (result.kind === 'attention') throw new Error(result.code);
    }
    expect(sqlite.query<{ phase: string }, []>(`
      SELECT phase FROM airtable_sync_provisioning_runs
    `).get()?.phase).toBe('ready');
    expect(sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM airtable_sync_snapshot_links
    `).get()?.count).toBe(11);
    expect(await repository.claim({
      connectionId,
      workerId: 'worker-after-ready',
      nowMs: 10_000,
      leaseMs: 5_000
    })).toBeUndefined();
    sqlite.close();
  });

  test('enforces one active connection/mapping and one-to-one provider record links', () => {
    const { sqlite, repository } = setup();
    expect(() => repository.createConnection({
      id: '018f0f64-4d6c-7b2f-8a1e-1234567890b2',
      workspaceId,
      publicCallbackRef: 'opaque-callback-reference-000000000002',
      providerAccountId: 'usr00000000000002',
      nowMs: 1_001
    })).toThrow();
    expect(() => repository.addMappingRevision({
      id: '018f0f64-4d6c-7b2f-8a1e-1234567890b3',
      connectionId,
      revision: 2,
      manifestVersion: 1,
      status: 'active',
      mappingDigest: 'b'.repeat(64),
      mapping: { areas: [] },
      nowMs: 1_001
    })).toThrow();

    repository.upsertRecordLink({
      id: linkId,
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task',
      subjectId: 'task-1',
      providerTableId: 'tbl00000000000001',
      providerRecordId: 'rec00000000000001',
      canonicalVersion: 1,
      baseline: { status: 'Open' },
      baselineDigest: digest,
      nowMs: 1_010
    });
    expect(() => repository.upsertRecordLink({
      id: '018f0f64-4d6c-7b2f-8a1e-1234567890b4',
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task',
      subjectId: 'task-2',
      providerTableId: 'tbl00000000000001',
      providerRecordId: 'rec00000000000001',
      canonicalVersion: 1,
      baseline: { status: 'Open' },
      baselineDigest: digest,
      nowMs: 1_011
    })).toThrow();
    sqlite.close();
  });

  test('coalesces current projection work and fences late completion', () => {
    const { sqlite, repository } = setup();
    repository.enqueueProjectionWork({
      id: workId,
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task',
      subjectId: 'task-1',
      projectionVersion: 2,
      availableAtMs: 2_000,
      nowMs: 1_000
    });
    repository.enqueueProjectionWork({
      id: '018f0f64-4d6c-7b2f-8a1e-1234567890b5',
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task',
      subjectId: 'task-1',
      projectionVersion: 5,
      availableAtMs: 2_100,
      nowMs: 1_100
    });
    const first = repository.claimDueProjectionWork({
      connectionId,
      workerId: 'worker-a',
      nowMs: 2_000,
      leaseMs: 5_000,
      limit: 10
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: workId,
      requestedProjectionVersion: 5,
      leaseVersion: 1
    });
    const second = repository.claimDueProjectionWork({
      connectionId,
      workerId: 'worker-b',
      nowMs: 7_001,
      leaseMs: 5_000,
      limit: 10
    });
    expect(second[0]).toMatchObject({ id: workId, leaseVersion: 2 });
    expect(repository.finishProjectionWork({
      id: workId,
      workerId: 'worker-a',
      leaseVersion: 1,
      outcome: 'succeeded',
      nowMs: 7_002
    })).toBe(false);
    expect(repository.finishProjectionWork({
      id: workId,
      workerId: 'worker-b',
      leaseVersion: 2,
      outcome: 'succeeded',
      nowMs: 7_003
    })).toBe(true);
    sqlite.close();
  });

  test('cursor never regresses and settle heads keep the newest edit deadline', () => {
    const { sqlite, repository } = setup();
    expect(repository.advanceWebhookCursor({
      connectionId,
      providerWebhookId: 'ach00000000000001',
      cursor: '11',
      transactionNumber: 10,
      expiresAtMs: 100_000,
      nowMs: 2_000
    })).toBe(true);
    expect(repository.advanceWebhookCursor({
      connectionId,
      providerWebhookId: 'ach00000000000001',
      cursor: '10',
      transactionNumber: 9,
      expiresAtMs: 100_000,
      nowMs: 2_001
    })).toBe(false);

    repository.scheduleSettle({
      id: settleId,
      connectionId,
      mappingRevision: 1,
      providerTableId: 'tbl00000000000001',
      providerRecordId: 'rec00000000000001',
      transactionNumber: 10,
      notBeforeMs: 5_000,
      nowMs: 2_000
    });
    repository.scheduleSettle({
      id: '018f0f64-4d6c-7b2f-8a1e-1234567890b6',
      connectionId,
      mappingRevision: 1,
      providerTableId: 'tbl00000000000001',
      providerRecordId: 'rec00000000000001',
      transactionNumber: 12,
      notBeforeMs: 7_000,
      nowMs: 2_100
    });
    expect(repository.listDueSettleHeads({
      connectionId,
      nowMs: 6_999,
      limit: 10
    })).toEqual([]);
    expect(repository.listDueSettleHeads({
      connectionId,
      nowMs: 7_000,
      limit: 10
    })).toEqual([{
      id: settleId,
      providerTableId: 'tbl00000000000001',
      providerRecordId: 'rec00000000000001',
      transactionNumber: 12,
      version: 2
    }]);
    sqlite.close();
  });

  test('commits a provider cursor and its coalesced settle head in one mapping fence', async () => {
    const { sqlite, repository } = setup();
    sqlite.query(`UPDATE airtable_sync_connections SET state = 'active' WHERE id = ?`)
      .run(connectionId);
    const secretReference = createSecretReference({
      id: 'secret.airtable.webhook.0001',
      version: 1,
      adapter: createSecretStoreAdapterRef('secret.memory', 1),
      purpose: 'airtable.webhook.mac',
      scopeBinding: connectionId
    });
    repository.saveWebhookRegistration({
      connectionId,
      baseId: 'app00000000000001',
      webhookId: 'ach00000000000001',
      macSecret: { secretReference },
      expiresAtMs: 100_000,
      nowMs: 1_000
    });
    const adapter = new SQLiteAirtableInboundCursorRepository(
      repository,
      () => settleId
    );
    const state = await adapter.read(connectionId);
    expect(state).toMatchObject({
      mappingRevision: 1,
      baseId: parseAirtableBaseId('app00000000000001'),
      webhookId: parseAirtableWebhookId('ach00000000000001'),
      lastTransactionNumber: 0
    });
    expect(await adapter.commitPage({
      state: state!,
      nextCursor: parseAirtableCursor('2'),
      nextTransactionNumber: 1,
      candidates: [{
        tableId: parseAirtableTableId('tbl00000000000001'),
        recordId: parseAirtableRecordId('rec00000000000001'),
        transactionNumber: 1,
        kind: 'updated',
        changedFieldIds: [parseAirtableFieldId('fld00000000000001')],
        source: 'client',
        observedAt: '2026-08-17T00:00:01.000Z'
      }],
      settleNotBeforeMs: 5_000,
      nowMs: 2_000
    })).toBe(true);
    expect(await adapter.commitPage({
      state: state!,
      nextCursor: parseAirtableCursor('3'),
      nextTransactionNumber: 2,
      candidates: [],
      settleNotBeforeMs: 6_000,
      nowMs: 3_000
    })).toBe(false);
    expect(await adapter.read(connectionId)).toMatchObject({
      cursor: '2', lastTransactionNumber: 1
    });
    const settle = sqlite.query<Record<string, unknown>, []>(`
      SELECT * FROM airtable_sync_settle_heads
    `).get();
    expect(settle).toMatchObject({
      latest_transaction_number: 1,
      changed_field_ids_json: JSON.stringify(['fld00000000000001']),
      provider_source: 'client'
    });
    sqlite.close();
  });

  test('leases settled re-reads, fences superseded workers, and retains digest-only shadow findings', async () => {
    const { sqlite, repository } = setup();
    sqlite.query(`UPDATE airtable_sync_connections SET state = 'active' WHERE id = ?`)
      .run(connectionId);
    const provider = new FakeAirtableProvider();
    const providerWorkspaceId = provider.seedWorkspace({
      id: 'wsp00000000000001', name: 'Events'
    });
    const created = await provider.data.createBase({
      workspaceId: providerWorkspaceId,
      name: 'JooEvents',
      tables: [{ name: 'Tasks', fields: [
        { name: 'Task', type: 'singleLineText' },
        { name: 'Status', type: 'singleLineText' }
      ] }]
    });
    if (created.kind === 'failure') throw new Error(created.failure.code);
    const table = created.value.tables[0]!;
    const taskField = table.fields[0]!.id;
    const statusField = table.fields[1]!.id;
    const recordId = provider.seedRecord({
      baseId: created.value.id,
      tableId: table.id,
      fields: { [taskField]: 'Confirm slides', [statusField]: 'Done' }
    });
    const secretReference = createSecretReference({
      id: 'secret.airtable.webhook.shadow.0001',
      version: 1,
      adapter: createSecretStoreAdapterRef('secret.memory', 1),
      purpose: 'airtable.webhook.mac',
      scopeBinding: connectionId
    });
    repository.saveWebhookRegistration({
      connectionId,
      baseId: created.value.id,
      webhookId: 'ach00000000000001',
      macSecret: { secretReference },
      expiresAtMs: 100_000,
      nowMs: 1_000
    });
    repository.upsertRecordLink({
      id: linkId,
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task',
      subjectId: 'task-1',
      providerTableId: table.id,
      providerRecordId: recordId,
      canonicalVersion: 1,
      baseline: { task: 'Confirm slides', status: 'Open' },
      baselineDigest: digest,
      nowMs: 1_000
    });
    repository.scheduleSettle({
      id: settleId,
      connectionId,
      mappingRevision: 1,
      providerTableId: table.id,
      providerRecordId: recordId,
      transactionNumber: 1,
      changeKind: 'updated',
      notBeforeMs: 2_000,
      nowMs: 1_000
    });
    let findingId = 0xb7;
    const adapter = new SQLiteAirtableShadowSettleRepository(
      repository,
      {
        async resolve() {
          return {
            mappings: [
              { fieldKey: 'task', fieldId: taskField, mode: 'view_in_airtable', dataClassification: 'ordinary' },
              { fieldKey: 'status', fieldId: statusField, mode: 'editable_in_airtable', dataClassification: 'ordinary' }
            ],
            local: { task: 'Confirm slides', status: 'Open' }
          };
        }
      },
      {
        leaseMs: 5_000,
        newFindingId: () => `018f0f64-4d6c-7b2f-8a1e-1234567890${(findingId++).toString(16)}`
      }
    );
    const first = await adapter.claimNext({ connectionId, workerId: 'worker-a', nowMs: 2_000 });
    expect(first).toMatchObject({ transactionNumber: 1, leaseVersion: 1 });
    expect(await adapter.claimNext({ connectionId, workerId: 'worker-b', nowMs: 2_001 }))
      .toBeUndefined();
    const reclaimed = await adapter.claimNext({ connectionId, workerId: 'worker-b', nowMs: 7_001 });
    expect(reclaimed).toMatchObject({ transactionNumber: 1, leaseVersion: 2 });
    expect(await adapter.complete({
      claim: first!,
      outcome: { kind: 'attention', code: 'late_worker' },
      nowMs: 7_002
    })).toBe(false);
    expect(await processOneAirtableShadowSettle({
      connectionId,
      workerId: 'worker-b',
      nowMs: 7_003,
      repository: {
        async claimNext() { return reclaimed; },
        resolveContext: (claim) => adapter.resolveContext(claim),
        complete: (input) => adapter.complete(input)
      },
      provider: provider.data
    })).toEqual({ kind: 'observed', settleId });
    expect(repository.listShadowFindingSummaries({ connectionId, limit: 10 }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ fieldKey: 'status', disposition: 'apply_inbound' }),
        expect.objectContaining({ fieldKey: 'task', disposition: 'unchanged' })
      ]));
    const stored = sqlite.query<{
      readonly base_digest: string;
      readonly local_digest: string;
      readonly remote_digest: string;
    }, []>(`SELECT base_digest, local_digest, remote_digest FROM airtable_sync_shadow_findings LIMIT 1`).get();
    expect(stored?.base_digest).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain('Confirm slides');
    expect(sqlite.query<{ readonly status: string }, []>(`
      SELECT status FROM airtable_sync_settle_heads
    `).get()?.status).toBe('observed');
    sqlite.close();
  });

  test('retains bounded ordinary before/after evidence immutably and references classified values', () => {
    const { sqlite, repository } = setup();
    repository.upsertRecordLink({
      id: linkId,
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task',
      subjectId: 'task-1',
      providerTableId: 'tbl00000000000001',
      providerRecordId: 'rec00000000000001',
      canonicalVersion: 1,
      baseline: { status: 'Open' },
      baselineDigest: digest,
      nowMs: 1_010
    });
    repository.recordBoundaryObservation({
      id: observationId,
      connectionId,
      recordLinkId: linkId,
      fieldKey: 'task.status',
      kind: 'applied',
      classification: 'ordinary',
      before: 'Open',
      after: 'Done',
      providerActorId: 'usr00000000000001',
      providerActorEmail: 'dana@example.test',
      providerActorDisplayName: 'Dana',
      occurredAtMs: 2_000
    });
    expect(() => sqlite.query(`
      UPDATE airtable_sync_boundary_observations
         SET after_json = '"Open"'
       WHERE id = ?
    `).run(observationId)).toThrow('immutable');
    expect(() => repository.recordBoundaryObservation({
      id: '018f0f64-4d6c-7b2f-8a1e-1234567890b7',
      connectionId,
      recordLinkId: linkId,
      fieldKey: 'person.private_note',
      kind: 'refused_restored',
      classification: 'classified',
      before: 'secret',
      after: 'other',
      occurredAtMs: 2_001
    })).toThrow('value_boundary');
    repository.recordBoundaryObservation({
      id: '018f0f64-4d6c-7b2f-8a1e-1234567890b8',
      connectionId,
      recordLinkId: linkId,
      fieldKey: 'person.private_note',
      kind: 'refused_restored',
      classification: 'classified',
      beforePayloadRef: 'payload-before',
      afterPayloadRef: 'payload-after',
      occurredAtMs: 2_002
    });
    sqlite.close();
  });

  test('carries Airtable editor provenance into controlled inbound boundary history', async () => {
    const { sqlite, repository } = setup();
    repository.upsertRecordLink({
      id: linkId,
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task_assignment',
      subjectId: 'task-1',
      providerTableId: 'tbl00000000000001',
      providerRecordId: 'rec00000000000001',
      canonicalVersion: 1,
      baseline: { status: 'Open' },
      baselineDigest: digest,
      nowMs: 1_010
    });
    const boundary = new SQLiteAirtableInboundBoundaryPort(repository, {
      nowMs: () => 2_000,
      newId: () => observationId
    });
    await boundary.observation({
      claim: {
        settleId,
        connectionId,
        mappingRevision: 1,
        providerTableId: parseAirtableTableId('tbl00000000000001'),
        providerRecordId: parseAirtableRecordId('rec00000000000001'),
        transactionNumber: 8,
        changeKind: 'updated',
        providerActor: {
          id: 'usr00000000000001',
          email: 'dana@example.test',
          displayName: 'Dana'
        },
        workerId: 'worker-a',
        leaseVersion: 1
      },
      recordLinkId: linkId,
      fieldKey: 'task.status',
      kind: 'applied',
      before: 'Open',
      after: 'Complete',
      operationReceiptId: 'operation-receipt-1',
      classification: 'ordinary'
    });
    expect(sqlite.query<{
      readonly provider_actor_id: string;
      readonly provider_actor_email: string;
      readonly provider_actor_display_name: string;
      readonly operation_receipt_id: string;
    }, [string]>(`
      SELECT provider_actor_id, provider_actor_email,
             provider_actor_display_name, operation_receipt_id
        FROM airtable_sync_boundary_observations
       WHERE id = ?
    `).get(observationId)).toEqual({
      provider_actor_id: 'usr00000000000001',
      provider_actor_email: 'dana@example.test',
      provider_actor_display_name: 'Dana',
      operation_receipt_id: 'operation-receipt-1'
    });
    sqlite.close();
  });

  test('commits provider-ingress history through the direct feature contribution transaction', async () => {
    const { sqlite, repository } = setup();
    sqlite.query(`UPDATE airtable_sync_connections SET state = 'active' WHERE id = ?`)
      .run(connectionId);
    repository.upsertRecordLink({
      id: linkId,
      connectionId,
      mappingRevision: 1,
      areaKey: 'tasks',
      subjectKind: 'task_assignment',
      subjectId: workId,
      providerTableId: 'tbl00000000000001',
      providerRecordId: 'rec00000000000001',
      canonicalVersion: 1,
      baseline: { 'task.status': 'Open' },
      baselineDigest: digest,
      nowMs: 1_000
    });
    const adapter = new SQLiteAirtableProjectionContributionAdapter(
      sqlite,
      () => globalThis.crypto.randomUUID(),
      { async publish() {} }
    );
    const composite = createSQLiteOperationFeatureContributionAdapterRegistry([
      {
        contributor: { key: 'feature.calendar.commitment-facts', version: 1 },
        adapter: { apply() {} }
      },
      { contributor: AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR, adapter }
    ]);
    expect(composite.contributors.map((item) => item.key)).toEqual([
      AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR.key,
      'feature.calendar.commitment-facts'
    ]);
    const contribution = {
      contributor: AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR,
      operationLogId: '018f0f64-4d6c-7b2f-8a1e-1234567890d0',
      value: {
        schemaVersion: 2,
        catalogDigestSha256: digest,
        workspaceId,
        eventId: null,
        occurredAt: '2026-08-17T00:00:01.000Z',
        impacts: [],
        inbound: {
          inboxReceiptId: '018f0f64-4d6c-7b2f-8a1e-1234567890d1',
          observations: [{
            connectionId,
            recordLinkId: linkId,
            fieldKey: 'task.status',
            kind: 'applied',
            classification: 'ordinary',
            before: 'Open',
            after: 'Complete',
            providerActorId: 'usr00000000000001',
            providerActorDisplayName: 'Dana',
            observedAtMs: 2_000
          }]
        }
      }
    } as const;
    sqlite.exec('BEGIN IMMEDIATE;');
    composite.apply(contribution);
    sqlite.exec('ROLLBACK;');
    expect(sqlite.query<{ readonly count: number }, []>(`
      SELECT count(*) AS count FROM airtable_sync_boundary_observations
    `).get()).toEqual({ count: 0 });

    sqlite.exec('BEGIN IMMEDIATE;');
    composite.apply(contribution);
    sqlite.exec('COMMIT;');
    expect(sqlite.query<{
      readonly inbox_receipt_id: string;
      readonly operation_receipt_id: string;
      readonly provider_actor_display_name: string;
    }, []>(`
      SELECT inbox_receipt_id, operation_receipt_id, provider_actor_display_name
        FROM airtable_sync_boundary_observations
    `).get()).toEqual({
      inbox_receipt_id: '018f0f64-4d6c-7b2f-8a1e-1234567890d1',
      operation_receipt_id: contribution.operationLogId,
      provider_actor_display_name: 'Dana'
    });
    sqlite.close();
  });

  test('activates only after ready provisioning and a durable webhook, then fences pause and mapping changes', () => {
    const sqlite = new Database(':memory:', { strict: true });
    installSQLiteAirtableSync(sqlite);
    const repository = new SQLiteAirtableSyncRepository(sqlite);
    repository.createConnection({
      id: connectionId, workspaceId,
      publicCallbackRef: 'opaque-callback-reference-000000000001',
      providerAccountId: 'usr00000000000001', nowMs: 1_000
    });
    repository.addMappingRevision({
      id: mappingId, connectionId, revision: 1, manifestVersion: 2,
      status: 'draft', mappingDigest: digest,
      mapping: { manifestVersion: 2, revision: 1, areas: [
        { areaKey: 'tasks', direction: 'work_from_airtable' }
      ], fields: [] }, nowMs: 1_000
    });
    repository.createProvisioningRun({
      state: {
        connectionId, manifestVersion: 2, manifestDigestSha256: digest,
        mode: 'selected_base', providerBaseId: parseAirtableBaseId('app00000000000001'),
        baseName: 'Event operations', phase: 'ready', createdTableKeys: ['tasks'],
        binding: {
          manifestVersion: 2, manifestDigestSha256: digest,
          baseId: parseAirtableBaseId('app00000000000001'),
          tables: [{
            key: 'tasks', tableId: parseAirtableTableId('tbl00000000000001'),
            primaryFieldId: parseAirtableFieldId('fld00000000000001'),
            defaultViewId: 'viw00000000000001',
            stableIdFieldId: parseAirtableFieldId('fld00000000000002'),
            fields: [
              { key: 'task', fieldId: parseAirtableFieldId('fld00000000000001'), type: 'singleLineText' },
              { key: 'jooevents_id', fieldId: parseAirtableFieldId('fld00000000000002'), type: 'singleLineText' }
            ]
          }]
        },
        tables: [{ tableKey: 'tasks', snapshotComplete: true, projectedCount: 0,
          verifyComplete: true, verifiedCount: 0 }], version: 1
      },
      nowMs: 1_000
    });
    sqlite.query(`UPDATE airtable_sync_connections SET state='provisioning' WHERE id=?`).run(connectionId);
    expect(repository.finalizeProvisioningActivation({
      connectionId, expectedConnectionVersion: 1, mappingRevision: 1, nowMs: 2_000
    })).toBe(false);
    repository.saveWebhookRegistration({
      connectionId, baseId: 'app00000000000001', webhookId: 'ach00000000000001',
      macSecret: { secretReference: createSecretReference({
        id: 'secret.airtable.webhook.test', version: 1,
        adapter: createSecretStoreAdapterRef('secret.memory', 1),
        purpose: 'airtable.webhook.mac', scopeBinding: connectionId
      }) },
      expiresAtMs: 100_000, nowMs: 2_000
    });
    expect(repository.finalizeProvisioningActivation({
      connectionId, expectedConnectionVersion: 1, mappingRevision: 1, nowMs: 2_100
    })).toBe(true);
    expect(repository.readWorkspaceConnection(workspaceId)).toMatchObject({
      state: 'active', version: 2, mapping: { revision: 1, status: 'active' }
    });
    expect(repository.setConnectionPaused({
      connectionId, expectedVersion: 2, paused: true, nowMs: 2_200
    })).toBe(true);
    expect(repository.setConnectionPaused({
      connectionId, expectedVersion: 2, paused: false, nowMs: 2_300
    })).toBe(false);
    sqlite.close();
  });
});
