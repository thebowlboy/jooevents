import { describe, expect, test } from 'bun:test';
import { FakeAirtableProvider } from '@jooevents/airtable';
import {
  createDefaultManagedBaseManifest,
  createManagedProvisioningState,
  createManagedSelectedBaseProvisioningState,
  runManagedSchemaUpgradeStep,
  runManagedProvisioningStep,
  toAirtableCreateTables,
  type ManagedProjectedRecord,
  type ManagedProvisioningClaim,
  type ManagedProvisioningRepository,
  type ManagedProvisioningState,
  type SnapshotRecordLink
} from './index';

class MemoryProvisioningRepository implements ManagedProvisioningRepository {
  state: ManagedProvisioningState;
  links: SnapshotRecordLink[] = [];
  #leaseVersion = 0;
  #claimed = false;

  constructor(state: ManagedProvisioningState) {
    this.state = state;
  }

  async claim(input: {
    connectionId: string;
    workerId: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<ManagedProvisioningClaim | undefined> {
    if (this.#claimed || input.connectionId !== this.state.connectionId) return undefined;
    this.#claimed = true;
    this.#leaseVersion += 1;
    return Object.freeze({ state: this.state, workerId: input.workerId, leaseVersion: this.#leaseVersion });
  }

  async complete(input: {
    claim: ManagedProvisioningClaim;
    nextState: ManagedProvisioningState;
    links: readonly SnapshotRecordLink[];
    nowMs: number;
  }): Promise<boolean> {
    if (!this.#claimed || input.claim.leaseVersion !== this.#leaseVersion
      || input.claim.state.version !== this.state.version) return false;
    this.#claimed = false;
    this.state = input.nextState;
    this.links.push(...input.links);
    return true;
  }
}

describe('managed provisioning state machine', () => {
  test('adds fields from a newer managed manifest without replacing tables or records', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const manifest = createDefaultManagedBaseManifest({
      scope: 'single_event', includeSpeakerEmail: false, includeSpeakerPhone: false
    });
    const priorTables = toAirtableCreateTables(manifest).map((table) => table.name === 'Speakers'
      ? {
          ...table,
          fields: table.fields.filter((field) => ![
            'Effective status', 'Requested status', 'Cancellation note'
          ].includes(field.name))
        }
      : table);
    const selected = await provider.data.createBase({
      workspaceId, name: 'Existing JooEvents base', tables: priorTables
    });
    if (selected.kind === 'failure') throw new Error(selected.failure.code);
    const speakers = selected.value.tables.find((table) => table.name === 'Speakers')!;
    const speakerId = speakers.fields.find((field) => field.name === 'JooEvents ID')!.id;
    const recordId = provider.seedRecord({
      baseId: selected.value.id,
      tableId: speakers.id,
      fields: { [speakers.primaryFieldId]: 'Maya Chen', [speakerId]: 'engagement-1' }
    });

    const results = [];
    for (let step = 0; step < 4; step += 1) {
      results.push(await runManagedSchemaUpgradeStep({
        manifest, baseId: selected.value.id, provider: provider.data
      }));
    }
    expect(results.map((result) => result.kind)).toEqual([
      'advanced', 'advanced', 'advanced', 'ready'
    ]);
    expect(results.slice(0, 3).map((result) =>
      result.kind === 'advanced' ? result.fieldKey : undefined
    )).toEqual(['effective_status', 'requested_status', 'cancellation_note']);
    expect(await provider.data.getRecord({
      baseId: selected.value.id, tableId: speakers.id, recordId
    })).toMatchObject({ kind: 'success', value: { id: recordId } });
  });

  test('adds managed tables to a selected base without touching its unrelated starter table', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const selected = await provider.data.createBase({
      workspaceId,
      name: 'JooEvents',
      tables: [{ name: 'Starter table', fields: [{ name: 'Name', type: 'singleLineText' }] }]
    });
    if (selected.kind === 'failure') throw new Error(selected.failure.code);
    const manifest = createDefaultManagedBaseManifest({
      scope: 'single_event', includeSpeakerEmail: false, includeSpeakerPhone: false
    });
    const repository = new MemoryProvisioningRepository(createManagedSelectedBaseProvisioningState({
      connectionId: 'connection-selected', providerBaseId: selected.value.id, manifest
    }));
    let result: Awaited<ReturnType<typeof runManagedProvisioningStep>> = { kind: 'idle' };
    for (let index = 0; index < 40; index += 1) {
      result = await runManagedProvisioningStep({
        connectionId: 'connection-selected', workerId: 'worker-a', nowMs: index + 1,
        leaseMs: 5_000, manifest, repository, provider: provider.data,
        source: { async listPage() { return { records: [] }; } }
      });
      if (result.kind === 'ready' || result.kind === 'attention') break;
    }
    expect(result.kind).toBe('ready');
    const schema = await provider.data.getBaseSchema({ baseId: selected.value.id });
    expect(schema.kind).toBe('success');
    if (schema.kind !== 'success') return;
    expect(schema.value.tables.map((table) => table.name)).toEqual([
      'Starter table', 'Speakers', 'Submissions', 'Sessions', 'Tasks'
    ]);
  });

  test('stops before writing when the selected base already uses a managed table name', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const selected = await provider.data.createBase({
      workspaceId,
      name: 'Existing operations',
      tables: [{ name: 'Tasks', fields: [{ name: 'Name', type: 'singleLineText' }] }]
    });
    if (selected.kind === 'failure') throw new Error(selected.failure.code);
    const manifest = createDefaultManagedBaseManifest({
      scope: 'single_event', includeSpeakerEmail: false, includeSpeakerPhone: false
    });
    const repository = new MemoryProvisioningRepository(createManagedSelectedBaseProvisioningState({
      connectionId: 'connection-conflict', providerBaseId: selected.value.id, manifest
    }));
    const result = await runManagedProvisioningStep({
      connectionId: 'connection-conflict', workerId: 'worker-a', nowMs: 1,
      leaseMs: 5_000, manifest, repository, provider: provider.data,
      source: { async listPage() { return { records: [] }; } }
    });
    expect(result).toEqual({ kind: 'attention', code: 'base_managed_table_name_conflict' });
    expect(repository.state.createdTableKeys).toEqual([]);
  });

  test('creates once, snapshots in bounded upserts, verifies, and becomes ready', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const manifest = createDefaultManagedBaseManifest({
      scope: 'single_event', includeSpeakerEmail: false, includeSpeakerPhone: false
    });
    const repository = new MemoryProvisioningRepository(createManagedProvisioningState({
      connectionId: 'connection-1', providerWorkspaceId: workspaceId,
      baseName: 'JooEvents · Riverside', manifest
    }));
    const taskRecords: ManagedProjectedRecord[] = Array.from({ length: 11 }, (_, index) => ({
      subjectKey: `task-${index + 1}`,
      fields: { task: `Task ${index + 1}`, status: index % 2 === 0 ? 'Open' : 'Done' }
    }));
    const source = {
      async listPage(input: { tableKey: string; cursor?: string; limit: 10 }) {
        if (input.tableKey !== 'tasks') return { records: [] };
        const start = input.cursor === undefined ? 0 : Number(input.cursor);
        const records = taskRecords.slice(start, start + input.limit);
        const next = start + records.length;
        return {
          records,
          ...(next < taskRecords.length ? { nextCursor: String(next) } : {})
        };
      }
    };
    let result: Awaited<ReturnType<typeof runManagedProvisioningStep>> = { kind: 'idle' };
    for (let index = 0; index < 30; index += 1) {
      result = await runManagedProvisioningStep({
        connectionId: 'connection-1', workerId: 'worker-a', nowMs: index + 1,
        leaseMs: 5_000, manifest, repository, provider: provider.data, source
      });
      if (result.kind === 'ready' || result.kind === 'attention') break;
    }
    expect(result.kind).toBe('ready');
    expect(repository.state.phase).toBe('ready');
    expect(repository.state.tables.find((table) => table.tableKey === 'tasks')).toMatchObject({
      projectedCount: 11, verifiedCount: 11, snapshotComplete: true, verifyComplete: true
    });
    expect(repository.links).toHaveLength(11);
    expect(new Set(repository.links.map((link) => link.recordId)).size).toBe(11);
  });

  test('quarantines an acceptance-unknown snapshot without advancing its cursor', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const manifest = createDefaultManagedBaseManifest({
      scope: 'single_event', includeSpeakerEmail: false, includeSpeakerPhone: false
    });
    const repository = new MemoryProvisioningRepository(createManagedProvisioningState({
      connectionId: 'connection-1', providerWorkspaceId: workspaceId,
      baseName: 'JooEvents · Riverside', manifest
    }));
    const source = {
      async listPage(input: { tableKey: string }) {
        return input.tableKey === 'speakers'
          ? { records: [{ subjectKey: 'speaker-1', fields: { speaker: 'Maya Chen' } }] }
          : { records: [] };
      }
    };
    await runManagedProvisioningStep({
      connectionId: 'connection-1', workerId: 'worker-a', nowMs: 1,
      leaseMs: 5_000, manifest, repository, provider: provider.data, source
    });
    provider.enqueueFault({ operation: 'patchRecords', kind: 'timeout_after_accept' });
    const result = await runManagedProvisioningStep({
      connectionId: 'connection-1', workerId: 'worker-a', nowMs: 2,
      leaseMs: 5_000, manifest, repository, provider: provider.data, source
    });
    expect(result).toEqual({ kind: 'attention', code: 'snapshot_acceptance_unknown' });
    expect(repository.state.tables[0]).toMatchObject({ projectedCount: 0, snapshotComplete: false });
    expect(repository.links).toEqual([]);
  });
});
