import { describe, expect, test } from 'bun:test';
import {
  FakeAirtableProvider,
  parseAirtableBaseId,
  parseAirtableRecordId,
  type AirtableBaseSchema,
  type AirtableFieldId,
  type AirtableTableId
} from '@jooevents/airtable';
import { canonicalJsonSha256 } from '@jooevents/kernel';
import type { CurrentProjection, ProjectionWorkClaim } from './processor';
import {
  runAirtableOutboundJob,
  writeAirtableProjectionBatch,
  type AirtableOutboundEntry,
  type AirtableOutboundJobRepository,
  type AirtableProjectionTarget
} from './outbound';

async function providerFixture() {
  const provider = new FakeAirtableProvider();
  const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
  const created = await provider.data.createBase({
    workspaceId,
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
  const field = (name: string): AirtableFieldId => table.fields.find((candidate) =>
    candidate.name === name
  )!.id;
  const target: AirtableProjectionTarget = {
    mappingRevision: 1,
    baseId: created.value.id,
    tableId: table.id,
    stableIdFieldId: field('JooEvents ID'),
    fieldIds: { task: field('Task'), status: field('Status') }
  };
  return { provider, schema: created.value, tableId: table.id, target };
}

function entry(
  target: AirtableProjectionTarget,
  index: number,
  overrides: Partial<AirtableProjectionTarget> = {}
): AirtableOutboundEntry {
  const claim: ProjectionWorkClaim = {
    workId: `work-${index}`,
    connectionId: 'connection-1',
    mappingRevision: 1,
    areaKey: 'tasks',
    subjectKind: 'task_assignment',
    subjectId: `task-${index}`,
    requestedProjectionVersion: index + 1,
    workerId: 'worker-1',
    leaseVersion: 1
  };
  const projection: CurrentProjection = {
    projectionVersion: index + 1,
    fingerprint: `local-${index}`,
    fields: { task: `Task ${index}`, status: index % 2 === 0 ? 'Open' : 'Done' }
  };
  return { claim, projection, target: { ...target, ...overrides } };
}

async function recordCount(input: {
  provider: FakeAirtableProvider;
  schema: AirtableBaseSchema;
  tableId: AirtableTableId;
  fieldIds: readonly AirtableFieldId[];
}) {
  const listed = await input.provider.data.listRecords({
    baseId: input.schema.id,
    tableId: input.tableId,
    fieldIds: input.fieldIds,
    pageSize: 100
  });
  if (listed.kind === 'failure') throw new Error(listed.failure.code);
  return listed.value.records.length;
}

describe('Airtable incremental outbound projection', () => {
  test('writes ten current projections in one provider batch', async () => {
    const fixture = await providerFixture();
    const entries = Array.from({ length: 10 }, (_, index) => entry(fixture.target, index));
    const results = await writeAirtableProjectionBatch({
      entries,
      provider: fixture.provider.data,
      nowMs: 1_000
    });
    expect(results).toHaveLength(10);
    expect(results.every((result) => result.kind === 'applied')).toBe(true);
    expect(await recordCount({
      provider: fixture.provider,
      schema: fixture.schema,
      tableId: fixture.tableId,
      fieldIds: Object.values(fixture.target.fieldIds)
    })).toBe(10);
  });

  test('inspects stable identity after timeout-after-accept and never duplicates creation', async () => {
    const fixture = await providerFixture();
    fixture.provider.enqueueFault({ operation: 'patchRecords', kind: 'timeout_after_accept' });
    const first = await writeAirtableProjectionBatch({
      entries: [entry(fixture.target, 1)],
      provider: fixture.provider.data,
      nowMs: 1_000
    });
    expect(first[0]).toMatchObject({ kind: 'already_current' });
    const second = await writeAirtableProjectionBatch({
      entries: [entry(fixture.target, 1)],
      provider: fixture.provider.data,
      nowMs: 2_000
    });
    expect(second[0]).toMatchObject({ kind: 'applied' });
    expect(await recordCount({
      provider: fixture.provider,
      schema: fixture.schema,
      tableId: fixture.tableId,
      fieldIds: [fixture.target.stableIdFieldId]
    })).toBe(1);
  });

  test('settles partial provider batches per record and rejects a stale mapping before I/O', async () => {
    const fixture = await providerFixture();
    fixture.provider.enqueueFault({
      operation: 'patchRecords',
      kind: 'partial',
      failedRequestIndexes: [1],
      code: 'temporary_unavailable'
    });
    const partial = await writeAirtableProjectionBatch({
      entries: [entry(fixture.target, 0), entry(fixture.target, 1), entry(fixture.target, 2)],
      provider: fixture.provider.data,
      nowMs: 1_000
    });
    expect(partial.map((result) => result.kind)).toEqual(['applied', 'retry', 'applied']);

    const stale = await writeAirtableProjectionBatch({
      entries: [entry(fixture.target, 3, { mappingRevision: 2 })],
      provider: fixture.provider.data,
      nowMs: 2_000
    });
    expect(stale).toEqual([{ kind: 'attention', code: 'mapping_or_projection_invalid' }]);
  });

  test('recreates a missing app-owned projection by stable identity without duplicating it', async () => {
    const fixture = await providerFixture();
    fixture.provider.enqueueFault({
      operation: 'patchRecords',
      kind: 'partial',
      failedRequestIndexes: [0],
      code: 'not_found'
    });
    const repaired = await writeAirtableProjectionBatch({
      entries: [entry(fixture.target, 8, {
        providerRecordId: parseAirtableRecordId('rec00000000009999')
      })],
      provider: fixture.provider.data,
      nowMs: 2_000
    });
    expect(repaired).toMatchObject([{ kind: 'applied' }]);
    expect(await recordCount({
      provider: fixture.provider,
      schema: fixture.schema,
      tableId: fixture.tableId,
      fieldIds: [fixture.target.stableIdFieldId]
    })).toBe(1);
  });

  test('duplicate wake execution observes terminal SQL work and becomes idle', async () => {
    const fixture = await providerFixture();
    const pending = [entry(fixture.target, 0)];
    let claimed = false;
    let completed = false;
    let connectionHeld = false;
    const repository: AirtableOutboundJobRepository = {
      async claimConnection(input) {
        if (connectionHeld) return undefined;
        connectionHeld = true;
        return { connectionId: input.connectionId, workerId: input.workerId, fence: 1 };
      },
      async releaseConnection() {
        connectionHeld = false;
        return true;
      },
      async claimNext() {
        if (claimed || completed) return undefined;
        claimed = true;
        return pending[0]!.claim;
      },
      async complete() {
        completed = true;
        return true;
      }
    };
    const source = {
      async readCurrent() { return pending[0]!.projection; },
      async resolveTarget() { return pending[0]!.target; }
    };
    expect(await runAirtableOutboundJob({
      connectionId: 'connection-1', workerId: 'worker-1', nowMs: 1_000,
      repository, source, provider: fixture.provider.data
    })).toMatchObject({ kind: 'processed', results: [{ kind: 'completed' }] });
    expect(await runAirtableOutboundJob({
      connectionId: 'connection-1', workerId: 'worker-2', nowMs: 2_000,
      repository, source, provider: fixture.provider.data
    })).toEqual({ kind: 'idle' });
  });

  test('skips provider I/O when the current projection equals the saved last-common baseline', async () => {
    const fixture = await providerFixture();
    const current = entry(fixture.target, 0, {
      providerRecordId: parseAirtableRecordId('rec00000000000001'),
      lastCommon: {
        canonicalVersion: 1,
        baselineDigestSha256: canonicalJsonSha256({
          task: 'Task 0',
          status: 'Open'
        }),
        providerFingerprintSha256: 'a'.repeat(64)
      }
    });
    const provider = Object.freeze({
      ...fixture.provider.data,
      async findRecordsByField() { throw new Error('provider lookup must be skipped'); },
      async patchRecords() { throw new Error('provider write must be skipped'); }
    });
    expect(await writeAirtableProjectionBatch({
      entries: [current], provider, nowMs: 3_000
    })).toEqual([{
      kind: 'already_current',
      providerRecordId: 'rec00000000000001',
      providerFingerprint: 'a'.repeat(64)
    }]);
  });

  test('a crash before provider acceptance leaves leased work recoverable after expiry', async () => {
    const fixture = await providerFixture();
    const pending = entry(fixture.target, 0);
    const state: { work: 'pending' | 'running' | 'succeeded' } = { work: 'pending' };
    let workLeaseExpiresAt = 0;
    let workFence = 0;
    const repository: AirtableOutboundJobRepository = {
      async claimConnection(input) {
        return { connectionId: input.connectionId, workerId: input.workerId, fence: 1 };
      },
      async releaseConnection() { return true; },
      async claimNext(input) {
        if (state.work === 'succeeded' || (state.work === 'running' && workLeaseExpiresAt > input.nowMs)) {
          return undefined;
        }
        state.work = 'running';
        workFence += 1;
        workLeaseExpiresAt = input.nowMs + 5_000;
        return { ...pending.claim, workerId: input.workerId, leaseVersion: workFence };
      },
      async complete(input) {
        if (state.work !== 'running' || input.claim.leaseVersion !== workFence) return false;
        state.work = input.outcome.kind === 'succeeded' ? 'succeeded' : 'pending';
        return true;
      }
    };
    const source = {
      async readCurrent() { return pending.projection; },
      async resolveTarget() { return pending.target; }
    };
    const crashingProvider = Object.freeze({
      ...fixture.provider.data,
      async patchRecords() {
        throw new Error('simulated process loss before request acceptance');
      }
    });
    await expect(runAirtableOutboundJob({
      connectionId: 'connection-1', workerId: 'worker-crashed', nowMs: 1_000,
      repository, source, provider: crashingProvider
    })).rejects.toThrow('simulated process loss');
    expect(state.work).toBe('running');

    expect(await runAirtableOutboundJob({
      connectionId: 'connection-1', workerId: 'worker-recovery', nowMs: 6_001,
      repository, source, provider: fixture.provider.data
    })).toMatchObject({ kind: 'processed', results: [{ kind: 'completed' }] });
    expect(state.work).toBe('succeeded');
    expect(await recordCount({
      provider: fixture.provider,
      schema: fixture.schema,
      tableId: fixture.tableId,
      fieldIds: [fixture.target.stableIdFieldId]
    })).toBe(1);
  });
});
