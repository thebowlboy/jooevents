import { describe, expect, test } from 'bun:test';
import { FakeAirtableProvider } from '@jooevents/airtable';
import {
  bindManagedSchema,
  createDefaultManagedBaseManifest,
  createManagedBaseManifest,
  projectSnapshotBatch,
  toAirtableCreateTables
} from './manifest';

describe('managed Airtable base manifest and snapshot', () => {
  test('builds a reading-first scope-aware manifest with optional personal fields', () => {
    const single = createDefaultManagedBaseManifest({
      scope: 'single_event',
      includeSpeakerEmail: false,
      includeSpeakerPhone: false
    });
    expect(single.tables.map((table) => table.key)).toEqual([
      'speakers', 'submissions', 'sessions', 'tasks'
    ]);
    expect(single.tables[0]?.fields.some((field) => field.key === 'event')).toBe(false);
    expect(single.tables[0]?.fields.some((field) => field.key === 'email')).toBe(false);
    expect(single.tables[0]?.fields.slice(-3).map((field) => field.key)).toEqual([
      'sync_state', 'last_synced', 'jooevents_id'
    ]);

    const all = createDefaultManagedBaseManifest({
      scope: 'all_events',
      includeSpeakerEmail: true,
      includeSpeakerPhone: true,
      vocabulary: { submissions: 'Proposals', sessions: 'Talks' }
    });
    expect(all.tables.map((table) => table.name)).toEqual([
      'Speakers', 'Proposals', 'Talks', 'Tasks', 'Events'
    ]);
    expect(all.tables[0]?.fields.some((field) => field.key === 'email')).toBe(true);
    expect(all.tables[0]?.fields.some((field) => field.key === 'event')).toBe(true);
    expect(all.digestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('refuses duplicate names and control fields mixed into human columns', () => {
    expect(() => createManagedBaseManifest({
      version: 1,
      scope: 'single_event',
      tables: [{
        key: 'tasks', name: 'Tasks', description: 'Tasks', stableIdFieldKey: 'id',
        fields: [
          { key: 'task', name: 'Task', type: 'singleLineText', authority: 'view', description: 'View' },
          { key: 'id', name: 'JooEvents ID', type: 'singleLineText', authority: 'control', description: 'Control' },
          { key: 'status', name: 'Status', type: 'singleLineText', authority: 'view', description: 'View' }
        ]
      }]
    })).toThrow('managed_manifest_control_fields_not_last');
  });

  test('binds returned stable IDs and resumes an upserted snapshot without duplicates', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const manifest = createDefaultManagedBaseManifest({
      scope: 'single_event',
      includeSpeakerEmail: false,
      includeSpeakerPhone: false
    });
    const created = await provider.data.createBase({
      workspaceId,
      name: 'JooEvents · Riverside',
      tables: toAirtableCreateTables(manifest)
    });
    if (created.kind === 'failure') throw new Error(created.failure.code);
    const bound = bindManagedSchema(manifest, created.value);
    expect(bound.kind).toBe('bound');
    if (bound.kind !== 'bound') return;

    const batch = projectSnapshotBatch({
      manifest,
      binding: bound.binding,
      tableKey: 'tasks',
      records: [{ subjectKey: 'task-1', fields: { task: 'Prepare doors', status: 'Open' } }],
      syncedAt: '2026-08-17T00:00:00.000Z'
    });
    const first = await provider.data.patchRecords({
      baseId: bound.binding.baseId,
      tableId: batch.tableId,
      mergeOnFieldId: batch.stableIdFieldId,
      records: batch.writes
    });
    const second = await provider.data.patchRecords({
      baseId: bound.binding.baseId,
      tableId: batch.tableId,
      mergeOnFieldId: batch.stableIdFieldId,
      records: batch.writes
    });
    expect(first).toMatchObject({ kind: 'success', value: { records: [{ kind: 'created' }] } });
    expect(second).toMatchObject({ kind: 'success', value: { records: [{ kind: 'updated' }] } });
    const page = await provider.data.listRecords({
      baseId: bound.binding.baseId,
      tableId: batch.tableId,
      fieldIds: [batch.stableIdFieldId],
      pageSize: 100
    });
    expect(page).toMatchObject({ kind: 'success', value: { records: [{ fields: {
      [batch.stableIdFieldId]: 'task-1'
    } }] } });
  });
});
