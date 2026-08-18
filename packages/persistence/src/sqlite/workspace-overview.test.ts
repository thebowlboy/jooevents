import { afterEach, describe, expect, test } from 'bun:test';
import { planEventCreation } from '@jooevents/event';
import { parseEventId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  workspaceOverviewAreaCatalogSchema,
  type WorkspaceOverviewAreaCatalog
} from '@jooevents/contracts/workspace-overview';
import { createFoundationEphemeralSQLiteRuntime } from './foundation-ephemeral-sqlite-runtime';
import { SQLiteEventSpineRepository } from './event-spine';
import { createSQLiteWorkspaceOverviewProjection } from './workspace-overview';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa111');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa211');
const createdAt = '2026-08-12T08:30:00.000Z';
const createdAtMs = Date.parse(createdAt);
const openRuntimes: ReturnType<typeof createFoundationEphemeralSQLiteRuntime>[] = [];
const areaCatalog: WorkspaceOverviewAreaCatalog = workspaceOverviewAreaCatalogSchema.parse([
  { area: 'overview', status: 'available', capabilities: ['workspace.overview.read'] },
  { area: 'submissions', status: 'available', capabilities: ['submission.list'] },
  { area: 'review', status: 'unavailable', reason: 'not_implemented' },
  { area: 'decisions', status: 'unavailable', reason: 'not_implemented' },
  { area: 'speakers', status: 'unavailable', reason: 'not_implemented' },
  { area: 'reviewers', status: 'unavailable', reason: 'not_implemented' },
  { area: 'tasks', status: 'unavailable', reason: 'not_implemented' },
  { area: 'schedule', status: 'unavailable', reason: 'not_composed' },
  { area: 'messages', status: 'unavailable', reason: 'not_composed' },
  { area: 'templates', status: 'unavailable', reason: 'not_implemented' },
  { area: 'forms', status: 'available', capabilities: ['form.list'] },
  { area: 'embeds', status: 'unavailable', reason: 'not_implemented' },
  { area: 'settings', status: 'available', capabilities: ['event.current.read'] }
]);

function openRuntime() {
  const runtime = createFoundationEphemeralSQLiteRuntime();
  openRuntimes.push(runtime);
  runtime.sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', 1, 1, 1)
  `).run(workspaceId, 'Overview test workspace');
  runtime.sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, 1, 1, 1)
  `).run(userId, 'Overview owner');
  const events = new SQLiteEventSpineRepository(runtime.sqlite);
  runtime.sqlite.transaction(() => events.bootstrapWorkspaceEventSet(workspaceId)).immediate();
  return { runtime, events };
}

function createEvent(events: SQLiteEventSpineRepository) {
  const plan = planEventCreation({
    eventSet: events.requireEventSet(workspaceId),
    authorInput: { expectedEventSetVersion: 1, name: 'Overview Summit', timezone: 'Asia/Singapore',
      startDate: '2026-11-04', endDate: '2026-11-06' },
    server: { workspaceId, eventId, createdByUserId: userId, createdAt }
  });
  events.commitEventCreatePlan(plan);
}

function projection(sqlite: ReturnType<typeof openRuntime>['runtime']['sqlite']) {
  return createSQLiteWorkspaceOverviewProjection({
    sqlite, areaCatalog, now: () => '2026-08-12T08:30:00.000Z'
  });
}

function insertOperation(sqlite: ReturnType<typeof openRuntime>['runtime']['sqlite'], input: {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly at: number;
}) {
  const result = JSON.stringify({
    kind: 'success', data: {},
    receipt: { id: input.id, operationName: input.name, operationVersion: 1 },
    correlationId: '019c1df7-86b5-769b-bba4-5f7097bfa901'
  });
  sqlite.query(`
    INSERT INTO operation_log (
      id, operation_name, operation_version, registry_digest_sha256, surface,
      actor_json, authority_principal_key, workspace_id, event_id, subjects_json,
      summary, occurred_at_ms, correlation_id, scope_partition_key,
      idempotency_verifier_profile_key, idempotency_verifier_profile_version,
      idempotency_key_verifier, request_hash, result_json, action_batch_id, action_step_id
    ) VALUES (?, ?, 1, ?, 'operator_http', ?, ?, ?, ?, ?, ?, ?,
      '019c1df7-86b5-769b-bba4-5f7097bfa901', ?, 'idempotency.operator-header', 1,
      ?, ?, ?, NULL, NULL)
  `).run(
    input.id, input.name, 'a'.repeat(64), JSON.stringify({ kind: 'workspace_user', userId }),
    `workspace_user:${userId}`, workspaceId, eventId,
    JSON.stringify([{ kind: 'workspace', id: workspaceId }, { kind: 'event', id: eventId }]),
    input.summary, input.at, 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), result
  );
}

function seedPipelineMetricRows(sqlite: ReturnType<typeof openRuntime>['runtime']['sqlite']) {
  const id = (suffix: string) => `019c1df7-86b5-769b-bba4-${suffix.padStart(12, '0')}`;
  const digest = (value: string) => value.repeat(64);
  const openRoundId = id('601');
  const discardedRoundId = id('602');
  const assignmentA = id('611');
  const assignmentB = id('612');
  const assignmentDiscarded = id('613');
  const sessionA = id('701');
  const sessionB = id('702');
  const formatId = id('710');
  const roomId = id('711');

  // This is a projection fixture: every row satisfies its table's own checks, while
  // the owning repository suites separately prove the cross-table foreign keys.
  sqlite.exec('PRAGMA foreign_keys = OFF');
  try {
    sqlite.query(`
      INSERT INTO review_rounds (
        workspace_id, event_id, id, ordinal, name, state, version,
        deadline_id, deadline_kind, deadline_version, deadline_digest_sha256,
        deadline_effective_at_ms, participant_identity, peer_reviewer_identity,
        peer_content_unlock, opened_by_user_id, opened_at_ms, closed_by_user_id,
        closed_at_ms, discarded_by_user_id, discarded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'review_due', 1, ?, ?, 'hidden', 'hidden',
        'after_own_commit', ?, ?, NULL, NULL, ?, ?)
    `).run(workspaceId, eventId, openRoundId, 1, 'Current round', 'open', id('620'),
      digest('a'), createdAtMs, userId, createdAtMs, null, null);
    sqlite.query(`
      INSERT INTO review_rounds (
        workspace_id, event_id, id, ordinal, name, state, version,
        deadline_id, deadline_kind, deadline_version, deadline_digest_sha256,
        deadline_effective_at_ms, participant_identity, peer_reviewer_identity,
        peer_content_unlock, opened_by_user_id, opened_at_ms, closed_by_user_id,
        closed_at_ms, discarded_by_user_id, discarded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'review_due', 1, ?, ?, 'hidden', 'hidden',
        'after_own_commit', ?, ?, NULL, NULL, ?, ?)
    `).run(workspaceId, eventId, discardedRoundId, 2, 'Discarded round', 'discarded',
      id('621'), digest('b'), createdAtMs, userId, createdAtMs, userId, createdAtMs);
    const insertAssignment = sqlite.query(`
      INSERT INTO review_assignments (
        workspace_id, event_id, id, round_id, submission_id, reviewer_id,
        version, state, assigned_at_ms, stepped_back_at_ms, stepped_back_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'assigned', ?, NULL, NULL)
    `);
    insertAssignment.run(workspaceId, eventId, assignmentA, openRoundId, id('631'), id('641'), createdAtMs);
    insertAssignment.run(workspaceId, eventId, assignmentB, openRoundId, id('632'), id('642'), createdAtMs);
    insertAssignment.run(
      workspaceId, eventId, assignmentDiscarded, discardedRoundId, id('633'), id('643'), createdAtMs
    );
    const insertReviewHead = sqlite.query(`
      INSERT INTO review_heads (
        workspace_id, event_id, assignment_id, version, current_revision_id,
        first_committed_at_ms, peer_unlocked_at_ms
      ) VALUES (?, ?, ?, 1, ?, ?, ?)
    `);
    insertReviewHead.run(workspaceId, eventId, assignmentA, id('651'), createdAtMs, createdAtMs);
    insertReviewHead.run(
      workspaceId, eventId, assignmentDiscarded, id('652'), createdAtMs, createdAtMs
    );

    const insertSubmission = sqlite.query(`
      INSERT INTO intake_submission_heads (
        workspace_id, event_id, submission_id, form_id, form_version_id, draft_id,
        submit_evidence_id, person_id, head_json, head_digest_sha256, submitted_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 3; index += 1) {
      const submissionId = id(`${660 + index}`);
      insertSubmission.run(
        workspaceId, eventId, submissionId, id('670'), id('671'), id(`${680 + index}`),
        id(`${690 + index}`), JSON.stringify({ source: 'direct_entry' }), digest('c'), createdAtMs
      );
      if (index < 2) {
        const decisionDigest = index === 0 ? digest('d') : digest('e');
        sqlite.query(`
          INSERT INTO decision_heads (
            workspace_id, event_id, submission_id, state, version, digest_sha256,
            head_json, decided_by_user_id, decided_at_ms
          ) VALUES (?, ?, ?, 'accepted', 1, ?, ?, ?, ?)
        `).run(workspaceId, eventId, submissionId, decisionDigest, JSON.stringify({
          submissionId, state: 'accepted', version: 1, digestSha256: decisionDigest
        }), userId, createdAtMs);
      }
    }

    sqlite.query(`
      INSERT INTO submission_triage_event_heads (
        workspace_id, event_id, query_version, query_digest_sha256
      ) VALUES (?, ?, 1, ?)
    `).run(workspaceId, eventId, digest('9'));
    const insertArrival = sqlite.query(`
      INSERT INTO submission_arrival_facts (
        workspace_id, event_id, submission_id, arrival_id, form_id, form_version_id,
        source, classification, submitted_at_ms, recorded_at_ms, fact_json,
        fact_digest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, 'direct_entry', 'on_time', ?, ?, ?, ?)
    `);
    const insertTriageHead = sqlite.query(`
      INSERT INTO submission_triage_heads (
        workspace_id, event_id, submission_id, head_version, state,
        updated_at_ms, head_json, head_digest_sha256
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    `);
    for (const [index, state] of [
      'inbox', 'set_aside', 'spam'
    ].entries()) {
      const submissionId = id(`${660 + index}`);
      const arrivalId = id(`${800 + index}`);
      insertArrival.run(
        workspaceId, eventId, submissionId, arrivalId, id('670'), id('671'),
        createdAtMs, createdAtMs,
        JSON.stringify({ submissionId, id: arrivalId, classification: 'on_time' }),
        digest(index === 0 ? 'a' : index === 1 ? 'b' : 'c')
      );
      insertTriageHead.run(
        workspaceId, eventId, submissionId, state, createdAtMs,
        JSON.stringify({ submissionId, version: 1, state }),
        digest(index === 0 ? 'd' : index === 1 ? 'e' : 'f')
      );
    }

    const insertSession = sqlite.query(`
      INSERT INTO sessions (
        workspace_id, event_id, id, title, planned_duration_minutes, lifecycle,
        format_id, track_id, program_set_version, program_set_digest_sha256,
        roster_version, roster_digest_sha256, roster_json, head_json, version,
        digest_sha256, created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, 30, 'draft', ?, NULL, 1, ?, 1, ?, '{"participants":[]}', ?, 1, ?, ?, ?, ?, ?)
    `);
    for (const [sessionId, title, sessionDigest] of [
      [sessionA, 'Opening session', digest('f')],
      [sessionB, 'Closing session', digest('1')]
    ] as const) {
      insertSession.run(workspaceId, eventId, sessionId, title, formatId, digest('2'), digest('3'),
        JSON.stringify({
          id: sessionId, lifecycle: 'draft', version: 1, digestSha256: sessionDigest,
          programTarget: { format: { id: formatId }, track: null },
          roster: { version: 1, digestSha256: digest('3') }
        }), sessionDigest, userId, createdAtMs, userId, createdAtMs);
    }
    const insertEngagement = sqlite.query(`
      INSERT INTO engagement_heads (
        workspace_id, event_id, id, session_id, person_id, submission_id,
        state, version, head_json, invited_at_ms, cancelled_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?)
    `);
    for (const [offset, state] of ['invited', 'confirmed', 'declined', 'cancelled'].entries()) {
      const engagementId = id(`${720 + offset}`);
      const personId = id(`${730 + offset}`);
      insertEngagement.run(workspaceId, eventId, engagementId, sessionA, personId, state,
        JSON.stringify({
          id: engagementId, sessionId: sessionA, personId, submissionId: null,
          seededByDecision: null, state, version: 1
        }), createdAtMs, state === 'cancelled' ? createdAtMs : null);
    }
    const insertOccurrence = sqlite.query(`
      INSERT INTO schedule_occurrences (
        workspace_id, event_id, id, session_id, room_id, start_at_ms, end_at_ms,
        version, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    insertOccurrence.run(
      workspaceId, eventId, id('741'), sessionA, roomId, createdAtMs, createdAtMs + 1800000,
      userId, createdAtMs
    );
    insertOccurrence.run(
      workspaceId, eventId, id('742'), sessionA, roomId, createdAtMs + 3600000,
      createdAtMs + 5400000, userId, createdAtMs
    );

    sqlite.query(`
      INSERT INTO review_assignments (
        workspace_id, event_id, id, round_id, submission_id, reviewer_id,
        version, state, assigned_at_ms, stepped_back_at_ms, stepped_back_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, 2, 'stepped_back', ?, ?, ?)
    `).run(workspaceId, eventId, id('614'), openRoundId, id('634'), id('644'),
      createdAtMs, createdAtMs, userId);
    sqlite.query(`
      INSERT INTO task_assignments (
        workspace_id, event_id, id, task_definition_id, task_definition_revision_id,
        engagement_id, person_id, state, version, assignment_json, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
    `).run(
      workspaceId, eventId, id('780'), id('781'), id('782'), id('720'), id('730'),
      JSON.stringify({
        id: id('780'), taskDefinitionId: id('781'), taskDefinitionRevisionId: id('782'),
        engagementId: id('720'), personId: id('730'), state: 'pending', version: 1,
        deadline: { reference: { effectiveAt: '2026-08-11T16:00:00.000Z' } },
        deadlineOverride: null
      }), createdAtMs
    );

    const insertRelease = sqlite.query(`
      INSERT INTO communication_message_releases (
        release_id, workspace_id, event_id, batch_id, recipient_ref_id, person_ref_id,
        contact_ref_id, template_revision_ref_id, content_ref_id, purpose_key,
        reviewed_message_digest_sha256, reviewed_envelope_digest_sha256,
        envelope_payload_ref_id, envelope_byte_size, envelope_digest_sha256, created_at
      ) VALUES (?, ?, ?, 'batch-overview', ?, ?, ?, ?, ?, 'decision_notification',
        ?, ?, ?, 1, ?, ?)
    `);
    for (let index = 0; index < 3; index += 1) {
      insertRelease.run(
        `release-overview-${index}`, workspaceId, eventId,
        index === 0 ? id('660') : `recipient-${index}`, id(`${750 + index}`),
        `contact-${index}`, id('760'), id('761'), digest('4'), digest('5'), id(`${770 + index}`),
        digest('6'), createdAt
      );
    }
    const insertDelivery = sqlite.query(`
      INSERT INTO communication_outbound_delivery_heads (
        delivery_id, workspace_id, event_id, release_id, dispatch_generation,
        reviewed_message_digest_sha256, reviewed_envelope_digest_sha256, recipient_ref_id,
        template_revision_ref_id, content_ref_id, provider_connection_revision_id,
        external_delivery_key, sender_profile_revision_id,
        sender_presentation_contract_key, sender_presentation_contract_version,
        sender_presentation_digest_sha256, channel_address_id, channel_address_version,
        address_lookup_fingerprint_profile, address_lookup_fingerprint_version,
        address_lookup_fingerprint_sha256, state, version, attempt_count,
        unknown_attempt_count, marked_resend_exhausted, current_attempt_id,
        lease_claim_id, lease_acquired_at_ms, lease_expires_at_ms, receipt_id,
        root_fact_id, root_outbox_pointer_id, history_thread_id, root_history_id,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider-1', ?, 'sender-1',
        'sender-contract', 1, ?, ?, 1, 'address-fingerprint', 1, ?, ?, 1, 1,
        0, 0, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
    `);
    const delivery = (suffix: number, releaseId: string, generation: number,
      state: 'accepted' | 'known_rejected_terminal') => insertDelivery.run(
        `delivery-overview-${suffix}`, workspaceId, eventId, releaseId, generation,
        digest('4'), digest('5'), `recipient-${suffix}`, id('760'), id('761'),
        `external-${suffix}`, digest('7'), `address-${suffix}`, digest('8'), state,
        `attempt-${suffix}`, `fact-${suffix}`, `outbox-${suffix}`, `thread-${suffix}`,
        `history-${suffix}`, createdAtMs, createdAtMs
      );
    delivery(0, 'release-overview-0', 1, 'accepted');
    delivery(1, 'release-overview-0', 2, 'accepted');
    delivery(2, 'release-overview-1', 1, 'known_rejected_terminal');
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON');
  }
}

afterEach(() => { while (openRuntimes.length > 0) openRuntimes.pop()?.close(); });

describe('SQLite workspace overview projection', () => {
  test('represents no-Event state with explicit locks and unavailable metrics', () => {
    const { runtime } = openRuntime();
    const overview = projection(runtime.sqlite).readOverview(workspaceId);
    expect(overview.event).toEqual({ schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 });
    expect(overview.areas.find((area) => area.area === 'submissions'))
      .toEqual({ area: 'submissions', status: 'locked', reason: 'event_required' });
    for (const metric of Object.values(overview.metrics)) {
      expect(metric).toEqual({ kind: 'unavailable', reason: 'event_required' });
    }
    expect(overview.history).toEqual({ total: 0, truncated: false, threads: [] });
  });

  test('measures durable domain counts and operation-log changes only', () => {
    const { runtime, events } = openRuntime();
    runtime.sqlite.transaction(() => createEvent(events)).immediate();
    insertOperation(runtime.sqlite, {
      id: '019c1df7-86b5-769b-bba4-5f7097bfa493', name: 'event.settings.update',
      summary: 'Updated event settings', at: createdAtMs
    });
    const overview = projection(runtime.sqlite).readOverview(workspaceId);
    expect(overview.event).toMatchObject({ kind: 'current_event', event: { id: eventId } });
    expect(overview.metrics.forms).toEqual({ kind: 'exact', total: 0, draft: 0, open: 0, closed: 0 });
    expect(overview.metrics.operations).toEqual({ kind: 'exact', total: 1 });
    expect(overview.metrics.triage).toEqual({ kind: 'exact', arrived: 0, sorted: 0 });
    expect(overview.metrics.arrivals).toEqual({
      kind: 'exact', submittedAt: [], inbox: 0, setAside: 0, spam: 0
    });
    expect(overview.metrics.reviews).toEqual({
      kind: 'exact', rounds: 0, assignments: 0, committed: 0
    });
    expect(overview.metrics.decisions).toEqual({ kind: 'exact', decided: 0, undecided: 0 });
    expect(overview.metrics.engagements).toEqual({ kind: 'exact', total: 0, confirmed: 0 });
    expect(overview.metrics.sessions).toEqual({ kind: 'exact', total: 0, placed: 0 });
    expect(overview.metrics.communications).toEqual({ kind: 'exact', recipients: 0, sent: 0 });
  });

  test('derives the pipeline metrics, including triage, from current canonical source rows', () => {
    const { runtime, events } = openRuntime();
    runtime.sqlite.transaction(() => createEvent(events)).immediate();
    seedPipelineMetricRows(runtime.sqlite);

    const metrics = projection(runtime.sqlite).readOverview(workspaceId).metrics;
    expect(metrics.triage).toEqual({ kind: 'exact', arrived: 3, sorted: 2 });
    expect(metrics.arrivals).toEqual({
      kind: 'exact',
      submittedAt: [createdAt, createdAt],
      inbox: 1,
      setAside: 1,
      spam: 1
    });
    expect(metrics.reviews).toEqual({ kind: 'exact', rounds: 1, assignments: 2, committed: 1 });
    expect(metrics.decisions).toEqual({ kind: 'exact', decided: 2, undecided: 1 });
    expect(metrics.engagements).toEqual({ kind: 'exact', total: 2, confirmed: 1 });
    expect(metrics.sessions).toEqual({ kind: 'exact', total: 2, placed: 1 });
    expect(metrics.communications).toEqual({ kind: 'exact', recipients: 3, sent: 1 });
    expect(metrics.attention).toEqual({
      kind: 'exact',
      resultsNotSent: 1,
      overdueSpeakerTasks: 1,
      uncoveredReviews: 1,
      sessionsAwaitingPlacement: 1,
      sessionsMissingSpeakers: 2,
      failedDeliveries: 1
    });
    expect(runtime.sqlite.query<{ readonly foreign_keys: number }, []>(
      'PRAGMA foreign_keys'
    ).get()?.foreign_keys).toBe(1);
  });

  test('fails closed when sorted triage heads exceed immutable arrivals', () => {
    const { runtime, events } = openRuntime();
    runtime.sqlite.transaction(() => createEvent(events)).immediate();
    const digest = (value: string) => value.repeat(64);
    const firstSubmissionId = '019c1df7-86b5-769b-bba4-000000000901';
    const impossibleSubmissionId = '019c1df7-86b5-769b-bba4-000000000902';
    runtime.sqlite.exec('PRAGMA foreign_keys = OFF');
    try {
      runtime.sqlite.query(`
        INSERT INTO submission_triage_event_heads (
          workspace_id, event_id, query_version, query_digest_sha256
        ) VALUES (?, ?, 1, ?)
      `).run(workspaceId, eventId, digest('a'));
      runtime.sqlite.query(`
        INSERT INTO submission_arrival_facts (
          workspace_id, event_id, submission_id, arrival_id, form_id, form_version_id,
          source, classification, submitted_at_ms, recorded_at_ms, fact_json,
          fact_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, 'direct_entry', 'on_time', ?, ?, ?, ?)
      `).run(
        workspaceId, eventId, firstSubmissionId,
        '019c1df7-86b5-769b-bba4-000000000903',
        '019c1df7-86b5-769b-bba4-000000000904',
        '019c1df7-86b5-769b-bba4-000000000905',
        createdAtMs, createdAtMs,
        JSON.stringify({
          submissionId: firstSubmissionId,
          id: '019c1df7-86b5-769b-bba4-000000000903',
          classification: 'on_time'
        }),
        digest('b')
      );
      const insertHead = runtime.sqlite.query(`
        INSERT INTO submission_triage_heads (
          workspace_id, event_id, submission_id, head_version, state,
          updated_at_ms, head_json, head_digest_sha256
        ) VALUES (?, ?, ?, 1, 'set_aside', ?, ?, ?)
      `);
      for (const [submissionId, headDigest] of [
        [firstSubmissionId, digest('c')],
        [impossibleSubmissionId, digest('d')]
      ] as const) {
        insertHead.run(
          workspaceId, eventId, submissionId, createdAtMs,
          JSON.stringify({ submissionId, version: 1, state: 'set_aside' }),
          headDigest
        );
      }
      expect(() => projection(runtime.sqlite).readOverview(workspaceId))
        .toThrow('count_evidence_corrupt');
    } finally {
      runtime.sqlite.exec('PRAGMA foreign_keys = ON');
    }
  });

  test('projects one safe operation-log item per history row without actor identity', () => {
    const { runtime, events } = openRuntime();
    runtime.sqlite.transaction(() => createEvent(events)).immediate();
    const fieldId = '019c1df7-86b5-769b-bba4-5f7097bfa503';
    const triageId = '019c1df7-86b5-769b-bba4-5f7097bfa513';
    insertOperation(runtime.sqlite, {
      id: fieldId, name: 'field_registry.add', summary: 'Added a speaker field', at: createdAtMs
    });
    insertOperation(runtime.sqlite, {
      id: triageId, name: 'submission.triage.transition', summary: 'Set submissions aside',
      at: createdAtMs + 1000
    });
    const history = projection(runtime.sqlite).readOverview(workspaceId).history;
    expect(history.threads.map((item) => ({ id: item.id, domain: item.domain }))).toEqual([
      { id: `operation:${triageId}`, domain: 'submission_triage' },
      { id: `operation:${fieldId}`, domain: 'field_registry' }
    ]);
    expect(JSON.stringify(history)).not.toContain(userId);
  });
});
