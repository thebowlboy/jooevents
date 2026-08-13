import { afterEach, describe, expect, test } from 'bun:test';
import { planEventCreation } from '@jooevents/event';
import {
  parseEventId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  workspaceOverviewAreaCatalogSchema,
  type WorkspaceOverviewAreaCatalog
} from '@jooevents/contracts/workspace-overview';
import { createFoundationEphemeralSQLiteRuntime } from './foundation-ephemeral-sqlite-runtime';
import { SQLiteEventSpineRepository } from './event-spine';
import {
  SQLiteWorkspaceOverviewError,
  createSQLiteWorkspaceOverviewProjection
} from './workspace-overview';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa111');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa211');
const createdAt = '2026-08-12T08:30:00.000Z';
const createdAtMs = Date.parse(createdAt);
const openRuntimes: ReturnType<typeof createFoundationEphemeralSQLiteRuntime>[] = [];
const areaCatalog: WorkspaceOverviewAreaCatalog = workspaceOverviewAreaCatalogSchema.parse([
  { area: 'overview', status: 'available', capabilities: ['workspace.overview.read'] },
  {
    area: 'submissions', status: 'partial',
    availableCapabilities: ['submission.list', 'submission.read'],
    unavailableCapabilities: ['submission.review']
  },
  { area: 'review', status: 'unavailable', reason: 'not_implemented' },
  { area: 'decisions', status: 'unavailable', reason: 'not_implemented' },
  { area: 'speakers', status: 'unavailable', reason: 'not_implemented' },
  { area: 'reviewers', status: 'unavailable', reason: 'not_implemented' },
  { area: 'tasks', status: 'unavailable', reason: 'not_implemented' },
  { area: 'schedule', status: 'unavailable', reason: 'not_composed' },
  { area: 'messages', status: 'unavailable', reason: 'not_composed' },
  { area: 'templates', status: 'unavailable', reason: 'not_implemented' },
  {
    area: 'forms', status: 'partial',
    availableCapabilities: ['form.list', 'form.read'],
    unavailableCapabilities: ['form.fields.manage']
  },
  { area: 'embeds', status: 'unavailable', reason: 'not_implemented' },
  {
    area: 'settings', status: 'partial',
    availableCapabilities: ['event.current.read'],
    unavailableCapabilities: ['workspace.settings.manage']
  }
]);

function openRuntime() {
  const runtime = createFoundationEphemeralSQLiteRuntime();
  openRuntimes.push(runtime);
  runtime.sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Overview test workspace', 1, 1, 1);
  runtime.sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Overview owner', 1, 1, 1);
  const eventRepository = new SQLiteEventSpineRepository(runtime.sqlite);
  runtime.sqlite.transaction(() => eventRepository.bootstrapWorkspaceEventSet(workspaceId)).immediate();
  return { runtime, eventRepository };
}

function createEvent(repository: SQLiteEventSpineRepository) {
  const plan = planEventCreation({
    eventSet: repository.requireEventSet(workspaceId),
    authorInput: {
      expectedEventSetVersion: 1,
      name: 'Overview Summit',
      timezone: 'Asia/Singapore',
      startDate: '2026-11-04',
      endDate: '2026-11-06'
    },
    server: { workspaceId, eventId, createdByUserId: userId, createdAt }
  });
  return plan;
}

function projection(sqlite: ReturnType<typeof openRuntime>['runtime']['sqlite'], historyLimit = 20) {
  return createSQLiteWorkspaceOverviewProjection({
    sqlite,
    areaCatalog,
    historyLimit
  });
}

function receiptJson(input: {
  readonly receiptId: string;
  readonly correlationId: string;
  readonly operationName: string;
  readonly outcome?: boolean;
}) {
  return input.outcome
    ? JSON.stringify({
        kind: 'outcome',
        outcome: {
          class: 'conflict',
          kind: 'changeset.blocked',
          retryable: false,
          subjects: [],
          detail: null,
          detailSchemaVersion: 1
        },
        terminal: true,
        receipt: {
          id: input.receiptId,
          operationName: input.operationName,
          operationVersion: 1
        },
        correlationId: input.correlationId
      })
    : JSON.stringify({
        kind: 'success',
        data: {},
        receipt: {
          id: input.receiptId,
          operationName: input.operationName,
          operationVersion: 1
        },
        correlationId: input.correlationId
      });
}

function insertReceiptAndAudit(input: {
  readonly sqlite: ReturnType<typeof openRuntime>['runtime']['sqlite'];
  readonly receiptId: string;
  readonly auditId: string;
  readonly correlationId: string;
  readonly operationName: string;
  readonly surface: 'operator_http' | 'external_mcp';
  readonly actor: Record<string, unknown>;
  readonly outcome?: boolean;
  readonly workspaceScoped?: boolean;
}) {
  input.sqlite.query(`
    INSERT INTO foundation_trial_operation_receipts (
      id, scope_partition_key, authority_principal_key, operation_name,
      operation_version, surface, idempotency_verifier_profile_key,
      idempotency_verifier_profile_version, idempotency_key_verifier,
      request_hash, result_json
    ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?)
  `).run(
    input.receiptId,
    'a'.repeat(64),
    `overview-principal-${input.receiptId}`,
    input.operationName,
    input.surface,
    'overview-test.idempotency',
    input.receiptId.replaceAll('-', '').padEnd(64, 'b').slice(0, 64),
    'c'.repeat(64),
    receiptJson(input)
  );
  input.sqlite.query(`
    INSERT INTO foundation_trial_operation_audits (
      event_id, disposition, receipt_id, related_receipt_id, record_json
    ) VALUES (?, 'terminal_new', ?, NULL, ?)
  `).run(input.auditId, input.receiptId, JSON.stringify({
    eventId: input.auditId,
    disposition: 'terminal_new',
    receiptId: input.receiptId,
    operation: { name: input.operationName, version: 1, effect: 'draft' },
    surface: input.surface,
    scope: {
      workspaceId,
      ...(input.workspaceScoped
        ? { subjects: [{ kind: 'workspace', id: workspaceId }] }
        : { eventId, subjects: [{ kind: 'event', id: eventId }] })
    },
    actor: input.actor
  }));
}

afterEach(() => {
  while (openRuntimes.length > 0) openRuntimes.pop()?.close();
});

describe('SQLite workspace overview projection', () => {
  test('represents no-Event state with explicit locks and unavailable metrics', () => {
    const { runtime } = openRuntime();
    const overview = projection(runtime.sqlite).readOverview(workspaceId);
    expect(overview.event).toEqual({
      schemaVersion: 1,
      kind: 'no_event',
      eventSetVersion: 1
    });
    expect(overview.areas.find((area) => area.area === 'submissions'))
      .toEqual({ area: 'submissions', status: 'locked', reason: 'event_required' });
    expect(overview.areas.find((area) => area.area === 'review'))
      .toEqual({ area: 'review', status: 'unavailable', reason: 'not_implemented' });
    expect(overview.metrics.forms).toEqual({
      kind: 'unavailable',
      reason: 'event_required'
    });
    expect(overview.history).toEqual({ total: 0, truncated: false, threads: [] });
  });

  test('measures exact current-Event counts from implemented durable tables', () => {
    const { runtime, eventRepository } = openRuntime();
    const plan = createEvent(eventRepository);
    runtime.sqlite.transaction(() => eventRepository.commitEventCreatePlan(plan)).immediate();
    runtime.sqlite.exec(`
      INSERT INTO intake_form_catalogs (workspace_id, event_id, catalog_version)
      VALUES ('${workspaceId}', '${eventId}', 2);
      INSERT INTO intake_form_heads (
        workspace_id, event_id, form_id, head_version, status,
        current_published_version_id, head_json, head_digest_sha256,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES
        ('${workspaceId}', '${eventId}', '019c1df7-86b5-769b-bba4-5f7097bfa401', 1,
         'draft', NULL, '{}', '${'d'.repeat(64)}', '${userId}', ${createdAtMs}, '${userId}', ${createdAtMs}),
        ('${workspaceId}', '${eventId}', '019c1df7-86b5-769b-bba4-5f7097bfa402', 1,
         'closed', NULL, '{}', '${'e'.repeat(64)}', '${userId}', ${createdAtMs}, '${userId}', ${createdAtMs});
      INSERT INTO program_vocabulary_sets (
        workspace_id, event_id, set_version, created_by_user_id, created_at_ms,
        updated_by_user_id, updated_at_ms
      ) VALUES ('${workspaceId}', '${eventId}', 2, '${userId}', ${createdAtMs}, '${userId}', ${createdAtMs});
      INSERT INTO program_vocabulary_rooms (
        workspace_id, event_id, id, name, capacity, status, version,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES
        ('${workspaceId}', '${eventId}', '019c1df7-86b5-769b-bba4-5f7097bfa411',
         'Hall A', 200, 'active', 1, '${userId}', ${createdAtMs}, '${userId}', ${createdAtMs}),
        ('${workspaceId}', '${eventId}', '019c1df7-86b5-769b-bba4-5f7097bfa412',
         'Old Hall', 100, 'retired', 1, '${userId}', ${createdAtMs}, '${userId}', ${createdAtMs});
      INSERT INTO program_vocabulary_tracks (
        workspace_id, event_id, id, name, status, version,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES ('${workspaceId}', '${eventId}', '019c1df7-86b5-769b-bba4-5f7097bfa413',
         'AI-native', 'active', 1, '${userId}', ${createdAtMs}, '${userId}', ${createdAtMs});
      INSERT INTO program_vocabulary_formats (
        workspace_id, event_id, id, name, status, version,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES ('${workspaceId}', '${eventId}', '019c1df7-86b5-769b-bba4-5f7097bfa414',
         'Talk', 'active', 1, '${userId}', ${createdAtMs}, '${userId}', ${createdAtMs});
      INSERT INTO changeset_heads (
        changeset_id, workspace_id, event_id, head_version, status,
        current_revision_number, head_json, head_digest_sha256
      ) VALUES
        ('019c1df7-86b5-769b-bba4-5f7097bfa421', '${workspaceId}', '${eventId}',
         1, 'draft', 1, '{}', '${'f'.repeat(64)}'),
        ('019c1df7-86b5-769b-bba4-5f7097bfa422', '${workspaceId}', '${eventId}',
         1, 'discarded', 1, '{}', '${'1'.repeat(64)}');
    `);
    const overview = projection(runtime.sqlite).readOverview(workspaceId);
    expect(overview.metrics.forms).toEqual({
      kind: 'exact', total: 2, draft: 1, open: 0, closed: 1
    });
    expect(overview.metrics.submissions).toEqual({ kind: 'exact', total: 0 });
    expect(overview.metrics.programVocabulary).toEqual({
      kind: 'exact',
      rooms: { total: 2, active: 1, retired: 1 },
      tracks: { total: 1, active: 1, retired: 0 },
      formats: { total: 1, active: 1, retired: 0 }
    });
    expect(overview.metrics.changesets).toEqual({
      kind: 'exact', total: 2, draft: 1, proposed: 0, committed: 0, discarded: 1
    });
  });

  test('groups timeline evidence causally without exposing actor identity', () => {
    const { runtime, eventRepository } = openRuntime();
    const plan = createEvent(eventRepository);
    runtime.sqlite.transaction(() => eventRepository.commitEventCreatePlan(plan)).immediate();
    const changesetId = '019c1df7-86b5-769b-bba4-5f7097bfa431';
    const revisionId = '019c1df7-86b5-769b-bba4-5f7097bfa432';
    const digest = 'a'.repeat(64);
    runtime.sqlite.exec(`
      INSERT INTO changeset_heads (
        changeset_id, workspace_id, event_id, head_version, status,
        current_revision_number, head_json, head_digest_sha256
      ) VALUES ('${changesetId}', '${workspaceId}', '${eventId}', 1, 'draft', 1, '{}', '${digest}');
      INSERT INTO changeset_revisions (
        changeset_id, revision_number, revision_id, revision_digest_sha256,
        record_json, record_digest_sha256
      ) VALUES ('${changesetId}', 1, '${revisionId}', '${digest}', '{}', '${digest}');
    `);
    const firstReceipt = '019c1df7-86b5-769b-bba4-5f7097bfa441';
    const secondReceipt = '019c1df7-86b5-769b-bba4-5f7097bfa442';
    insertReceiptAndAudit({
      sqlite: runtime.sqlite,
      receiptId: firstReceipt,
      auditId: '019c1df7-86b5-769b-bba4-5f7097bfa451',
      correlationId: '019c1df7-86b5-769b-bba4-5f7097bfa461',
      operationName: 'form.definition.create.draft',
      surface: 'operator_http',
      actor: { kind: 'workspace_user', userId }
    });
    insertReceiptAndAudit({
      sqlite: runtime.sqlite,
      receiptId: secondReceipt,
      auditId: '019c1df7-86b5-769b-bba4-5f7097bfa452',
      correlationId: '019c1df7-86b5-769b-bba4-5f7097bfa462',
      operationName: 'changeset.propose',
      surface: 'external_mcp',
      actor: {
        kind: 'external_mcp_client',
        oauthClientId: 'client',
        authorityPrincipalId: 'principal'
      },
      outcome: true
    });
    runtime.sqlite.exec(`
      INSERT INTO intake_form_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES ('${firstReceipt}', '${workspaceId}', '${eventId}', '${changesetId}',
        '${revisionId}', '${digest}', '${digest}', 'create',
        'form.definition.create.draft', 1, ${createdAtMs});
      INSERT INTO intake_form_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id, changeset_id,
        revision_id, occurred_at_ms, source_kind
      ) VALUES ('019c1df7-86b5-769b-bba4-5f7097bfa471', '${firstReceipt}',
        '${workspaceId}', '${eventId}', '${changesetId}', '${revisionId}',
        ${createdAtMs}, 'changeset_revision');
      INSERT INTO intake_form_changeset_receipt_links (
        receipt_id, action, operation_name, operation_version, workspace_id,
        event_id, changeset_id, revision_id, revision_digest_sha256,
        record_digest_sha256, occurred_at_ms
      ) VALUES ('${secondReceipt}', 'propose', 'changeset.propose', 1,
        '${workspaceId}', '${eventId}', '${changesetId}', '${revisionId}',
        '${digest}', '${digest}', ${createdAtMs + 1000});
      INSERT INTO intake_form_changeset_timeline (
        timeline_id, receipt_id, source_kind, workspace_id, event_id,
        changeset_id, revision_id, occurred_at_ms
      ) VALUES ('019c1df7-86b5-769b-bba4-5f7097bfa472', '${secondReceipt}',
        'changeset_proposal', '${workspaceId}', '${eventId}', '${changesetId}',
        '${revisionId}', ${createdAtMs + 1000});
    `);
    const overview = projection(runtime.sqlite).readOverview(workspaceId);
    expect(overview.history.total).toBe(1);
    expect(overview.history.threads[0]).toMatchObject({
      id: `changeset:${changesetId}`,
      domain: 'forms',
      root: { kind: 'changeset', changesetId, status: 'draft' },
      actors: ['person', 'agent'],
      surfaces: ['operator_http', 'external_mcp'],
      latestOperation: { name: 'changeset.propose', version: 1 },
      latestOutcome: {
        kind: 'outcome',
        outcome: { class: 'conflict', kind: 'changeset.blocked' }
      },
      evidence: { timelineEntries: 2, receipts: 2 }
    });
    expect(JSON.stringify(overview)).not.toContain(userId);
    expect(JSON.stringify(overview)).not.toContain('oauthClientId');
  });

  test('accepts a workspace-scoped audit when guarded domain evidence resolves the current Event', () => {
    const { runtime, eventRepository } = openRuntime();
    runtime.sqlite.transaction(() => eventRepository.commitEventCreatePlan(
      createEvent(eventRepository)
    )).immediate();
    const changesetId = '019c1df7-86b5-769b-bba4-5f7097bfa491';
    const revisionId = '019c1df7-86b5-769b-bba4-5f7097bfa492';
    const receiptId = '019c1df7-86b5-769b-bba4-5f7097bfa493';
    const recordDigest = '7'.repeat(64);
    runtime.sqlite.exec(`
      INSERT INTO changeset_heads (
        changeset_id, workspace_id, event_id, head_version, status,
        current_revision_number, head_json, head_digest_sha256
      ) VALUES ('${changesetId}', '${workspaceId}', '${eventId}', 1, 'draft', 1,
        '{}', '${recordDigest}');
      INSERT INTO changeset_revisions (
        changeset_id, revision_number, revision_id, revision_digest_sha256,
        record_json, record_digest_sha256
      ) VALUES ('${changesetId}', 1, '${revisionId}', '${recordDigest}', '{}', '${recordDigest}');
    `);
    insertReceiptAndAudit({
      sqlite: runtime.sqlite,
      receiptId,
      auditId: '019c1df7-86b5-769b-bba4-5f7097bfa494',
      correlationId: '019c1df7-86b5-769b-bba4-5f7097bfa495',
      operationName: 'event.settings.update.draft',
      surface: 'operator_http',
      actor: { kind: 'workspace_user', userId },
      workspaceScoped: true
    });
    runtime.sqlite.exec(`
      INSERT INTO event_settings_update_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, operation_name,
        operation_version, occurred_at_ms
      ) VALUES ('${receiptId}', '${workspaceId}', '${eventId}', '${changesetId}',
        '${revisionId}', '${recordDigest}', '${recordDigest}',
        'event.settings.update.draft', 1, ${createdAtMs});
      INSERT INTO event_settings_update_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id, changeset_id,
        revision_id, occurred_at_ms, source_kind
      ) VALUES ('019c1df7-86b5-769b-bba4-5f7097bfa496', '${receiptId}',
        '${workspaceId}', '${eventId}', '${changesetId}', '${revisionId}',
        ${createdAtMs}, 'changeset_revision');
    `);

    expect(projection(runtime.sqlite).readOverview(workspaceId).history.threads[0]).toMatchObject({
      id: `changeset:${changesetId}`,
      domain: 'event',
      actors: ['person'],
      latestOperation: { name: 'event.settings.update.draft', version: 1 }
    });
  });

  test('groups Field Registry and submission-triage changes in their own domains', () => {
    const { runtime, eventRepository } = openRuntime();
    runtime.sqlite.transaction(() => eventRepository.commitEventCreatePlan(
      createEvent(eventRepository)
    )).immediate();
    const digest = 'a'.repeat(64);
    const fieldChangeset = '019c1df7-86b5-769b-bba4-5f7097bfa501';
    const fieldRevision = '019c1df7-86b5-769b-bba4-5f7097bfa502';
    const fieldReceipt = '019c1df7-86b5-769b-bba4-5f7097bfa503';
    const triageChangeset = '019c1df7-86b5-769b-bba4-5f7097bfa511';
    const triageRevision = '019c1df7-86b5-769b-bba4-5f7097bfa512';
    const triageReceipt = '019c1df7-86b5-769b-bba4-5f7097bfa513';
    runtime.sqlite.exec(`
      INSERT INTO changeset_heads (
        changeset_id, workspace_id, event_id, head_version, status,
        current_revision_number, head_json, head_digest_sha256
      ) VALUES
        ('${fieldChangeset}', '${workspaceId}', '${eventId}', 1, 'draft', 1, '{}', '${digest}'),
        ('${triageChangeset}', '${workspaceId}', '${eventId}', 1, 'draft', 1, '{}', '${digest}');
      INSERT INTO changeset_revisions (
        changeset_id, revision_number, revision_id, revision_digest_sha256,
        record_json, record_digest_sha256
      ) VALUES
        ('${fieldChangeset}', 1, '${fieldRevision}', '${digest}', '{}', '${digest}'),
        ('${triageChangeset}', 1, '${triageRevision}', '${digest}', '{}', '${digest}');
    `);
    insertReceiptAndAudit({
      sqlite: runtime.sqlite,
      receiptId: fieldReceipt,
      auditId: '019c1df7-86b5-769b-bba4-5f7097bfa504',
      correlationId: '019c1df7-86b5-769b-bba4-5f7097bfa505',
      operationName: 'field_registry.add.draft',
      surface: 'operator_http',
      actor: { kind: 'workspace_user', userId }
    });
    insertReceiptAndAudit({
      sqlite: runtime.sqlite,
      receiptId: triageReceipt,
      auditId: '019c1df7-86b5-769b-bba4-5f7097bfa514',
      correlationId: '019c1df7-86b5-769b-bba4-5f7097bfa515',
      operationName: 'submission.triage.transition.draft',
      surface: 'operator_http',
      actor: { kind: 'workspace_user', userId }
    });
    runtime.sqlite.exec(`
      INSERT INTO field_registry_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES ('${fieldReceipt}', '${workspaceId}', '${eventId}', '${fieldChangeset}',
        '${fieldRevision}', '${digest}', '${digest}', 'add',
        'field_registry.add.draft', 1, ${createdAtMs});
      INSERT INTO field_registry_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id, changeset_id,
        revision_id, occurred_at_ms, source_kind
      ) VALUES ('019c1df7-86b5-769b-bba4-5f7097bfa506', '${fieldReceipt}',
        '${workspaceId}', '${eventId}', '${fieldChangeset}', '${fieldRevision}',
        ${createdAtMs}, 'changeset_revision');
      INSERT INTO submission_triage_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES ('${triageReceipt}', '${workspaceId}', '${eventId}', '${triageChangeset}',
        '${triageRevision}', '${digest}', '${digest}', 'set_aside',
        'submission.triage.transition.draft', 1, ${createdAtMs + 1000});
      INSERT INTO submission_triage_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id, changeset_id,
        revision_id, occurred_at_ms, source_kind
      ) VALUES ('019c1df7-86b5-769b-bba4-5f7097bfa516', '${triageReceipt}',
        '${workspaceId}', '${eventId}', '${triageChangeset}', '${triageRevision}',
        ${createdAtMs + 1000}, 'changeset_revision');
    `);
    const history = projection(runtime.sqlite).readOverview(workspaceId).history;
    expect(history.total).toBe(2);
    expect(history.threads.map((thread) => ({ id: thread.id, domain: thread.domain })))
      .toEqual([
        { id: `changeset:${triageChangeset}`, domain: 'submission_triage' },
        { id: `changeset:${fieldChangeset}`, domain: 'field_registry' }
      ]);
  });

  test('fails closed when a timeline receipt lacks its terminal audit evidence', () => {
    const { runtime, eventRepository } = openRuntime();
    const plan = createEvent(eventRepository);
    runtime.sqlite.transaction(() => eventRepository.commitEventCreatePlan(plan)).immediate();
    const receiptId = '019c1df7-86b5-769b-bba4-5f7097bfa481';
    const changesetId = '019c1df7-86b5-769b-bba4-5f7097bfa483';
    const revisionId = '019c1df7-86b5-769b-bba4-5f7097bfa484';
    const digest = 'a'.repeat(64);
    runtime.sqlite.query(`
      INSERT INTO foundation_trial_operation_receipts (
        id, scope_partition_key, authority_principal_key, operation_name,
        operation_version, surface, idempotency_verifier_profile_key,
        idempotency_verifier_profile_version, idempotency_key_verifier,
        request_hash, result_json
      ) VALUES (?, ?, ?, 'form.definition.create.draft', 1, 'operator_http', ?, 1, ?, ?, ?)
    `).run(
      receiptId,
      'a'.repeat(64),
      'overview-principal-corrupt',
      'overview-test.idempotency',
      'b'.repeat(64),
      'c'.repeat(64),
      receiptJson({
        receiptId,
        operationName: 'form.definition.create.draft',
        correlationId: '019c1df7-86b5-769b-bba4-5f7097bfa482'
      })
    );
    runtime.sqlite.exec(`
      INSERT INTO changeset_heads (
        changeset_id, workspace_id, event_id, head_version, status,
        current_revision_number, head_json, head_digest_sha256
      ) VALUES ('${changesetId}', '${workspaceId}', '${eventId}', 1, 'draft', 1, '{}', '${digest}');
      INSERT INTO changeset_revisions (
        changeset_id, revision_number, revision_id, revision_digest_sha256,
        record_json, record_digest_sha256
      ) VALUES ('${changesetId}', 1, '${revisionId}', '${digest}', '{}', '${digest}');
      INSERT INTO intake_form_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES ('${receiptId}', '${workspaceId}', '${eventId}', '${changesetId}',
        '${revisionId}', '${digest}', '${digest}', 'create',
        'form.definition.create.draft', 1, ${createdAtMs});
      INSERT INTO intake_form_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id, changeset_id,
        revision_id, occurred_at_ms, source_kind
      ) VALUES ('019c1df7-86b5-769b-bba4-5f7097bfa485', '${receiptId}',
        '${workspaceId}', '${eventId}', '${changesetId}', '${revisionId}',
        ${createdAtMs}, 'changeset_revision');
    `);
    expect(() => projection(runtime.sqlite).readOverview(workspaceId)).toThrow(
      SQLiteWorkspaceOverviewError
    );
  });
});
