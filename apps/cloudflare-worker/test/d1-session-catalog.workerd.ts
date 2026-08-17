import { env } from 'cloudflare:workers';
import { canonicalJsonText, parseEventId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import { createProgramVocabularyState } from '@jooevents/program';
import {
  applySessionMutationPlan,
  createEmptySessionCatalog,
  planSessionMutation
} from '@jooevents/session';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  D1SessionCatalogReadError,
  createD1SessionCatalogReadSource
} from '../src/d1-session-catalog';

const uuid = (suffix: number): string =>
  `019c1df8-b8d7-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(uuid(901));
const userId = parseUserId(uuid(902));
const eventId = parseEventId(uuid(903));
const sessionId = uuid(904);
const trackId = uuid(905);
const formatId = uuid(906);
const occurredAt = '2026-08-18T14:00:00.000Z';
const occurredAtMs = Date.parse(occurredAt);

const scope = { workspaceId, eventId };
const vocabulary = createProgramVocabularyState({
  scope,
  setVersion: 2,
  tracks: [{ id: trackId, name: 'Platform', status: 'active', version: 1 }],
  formats: [{ id: formatId, name: 'Talk', status: 'active', version: 1 }]
});
const emptyCatalog = createEmptySessionCatalog(scope);
const plan = planSessionMutation({
  catalog: emptyCatalog,
  vocabulary,
  planningInput: {
    action: 'create',
    scope,
    sessionId,
    actorUserId: userId,
    occurredAt,
    expectedCatalogVersion: 1,
    expectedCatalogDigestSha256: emptyCatalog.digestSha256,
    title: 'Canonical D1 Session',
    plannedDurationMinutes: 45,
    lifecycle: 'collecting',
    formatId,
    trackId
  }
});
const applied = applySessionMutationPlan({ plan, catalog: emptyCatalog, vocabulary });

beforeAll(async () => {
  const head = plan.after;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'Session workspace','active',1,1,1)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','Session owner',1,1,1)`).bind(userId),
    env.DB.prepare(`INSERT INTO event_spine_workspace_sets
      (workspace_id,version,current_event_id) VALUES (?,1,NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO event_spine_heads (
      workspace_id,id,name,timezone,start_date,end_date,version,
      created_by_user_id,created_at_ms,create_plan_digest_sha256
    ) VALUES (?,?,'Session Summit','UTC','2027-06-02','2027-06-03',1,?,?,?)`)
      .bind(workspaceId, eventId, userId, occurredAtMs, 'd'.repeat(64)),
    env.DB.prepare(`INSERT INTO event_spine_scope_roots (workspace_id,event_id)
      VALUES (?,?)`).bind(workspaceId, eventId),
    env.DB.prepare(`INSERT INTO program_vocabulary_sets
      (workspace_id,event_id,set_version,created_by_user_id,created_at_ms,
       updated_by_user_id,updated_at_ms) VALUES (?,?,2,?,?,?,?)`)
      .bind(workspaceId, eventId, userId, occurredAtMs, userId, occurredAtMs),
    env.DB.prepare(`INSERT INTO program_vocabulary_tracks
      (workspace_id,event_id,id,name,status,version,created_by_user_id,created_at_ms,
       updated_by_user_id,updated_at_ms) VALUES (?,?,?,'Platform','active',1,?,?,?,?)`)
      .bind(workspaceId, eventId, trackId, userId, occurredAtMs, userId, occurredAtMs),
    env.DB.prepare(`INSERT INTO program_vocabulary_formats
      (workspace_id,event_id,id,name,status,version,created_by_user_id,created_at_ms,
       updated_by_user_id,updated_at_ms) VALUES (?,?,?,'Talk','active',1,?,?,?,?)`)
      .bind(workspaceId, eventId, formatId, userId, occurredAtMs, userId, occurredAtMs),
    env.DB.prepare(`INSERT INTO session_catalogs
      (workspace_id,event_id,version,digest_sha256) VALUES (?,?,?,?)`)
      .bind(workspaceId, eventId, applied.catalog.version, applied.catalog.digestSha256),
    env.DB.prepare(`INSERT INTO sessions (
      workspace_id,event_id,id,title,planned_duration_minutes,lifecycle,format_id,track_id,
      program_set_version,program_set_digest_sha256,roster_version,roster_digest_sha256,
      roster_json,head_json,version,digest_sha256,created_by_user_id,created_at_ms,
      updated_by_user_id,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      workspaceId, eventId, head.id, head.title, head.plannedDurationMinutes, head.lifecycle,
      head.programTarget.format.id, head.programTarget.track?.id ?? null,
      head.programTarget.setVersion, head.programTarget.setDigestSha256,
      head.roster.version, head.roster.digestSha256, canonicalJsonText(head.roster),
      canonicalJsonText(head), head.version, head.digestSha256, head.createdByUserId,
      occurredAtMs, head.updatedByUserId, occurredAtMs
    )
  ]);
});

describe('D1 Session catalog read source', () => {
  test('projects a retained canonical Session catalog', async () => {
    const source = createD1SessionCatalogReadSource({ database: env.DB, workspaceId });

    await expect(source.readSessionCatalog(scope)).resolves.toEqual(applied.catalog);
  });

  test('rejects a workspace outside the configured D1 partition', async () => {
    const source = createD1SessionCatalogReadSource({ database: env.DB, workspaceId });

    await expect(source.readSessionCatalog({
      workspaceId: parseWorkspaceId(uuid(907)),
      eventId
    })).rejects.toMatchObject({
      name: 'D1SessionCatalogReadError',
      code: 'wrong_scope'
    } satisfies Partial<D1SessionCatalogReadError>);
  });

  test('fails closed when an indexed Session projection drifts from its canonical head', async () => {
    await env.DB.prepare(`UPDATE sessions SET title = 'Drifted projection'
      WHERE workspace_id = ? AND event_id = ? AND id = ?`)
      .bind(workspaceId, eventId, sessionId).run();
    const source = createD1SessionCatalogReadSource({ database: env.DB, workspaceId });

    await expect(source.readSessionCatalog(scope)).rejects.toMatchObject({
      name: 'D1SessionCatalogReadError',
      code: 'data_corrupt'
    } satisfies Partial<D1SessionCatalogReadError>);
  });
});
