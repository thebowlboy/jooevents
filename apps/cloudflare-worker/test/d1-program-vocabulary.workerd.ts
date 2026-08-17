import { env } from 'cloudflare:workers';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  D1ProgramVocabularyReadError,
  createD1ProgramVocabularySnapshotReadSource
} from '../src/d1-program-vocabulary';
import { createD1SchedulePlacementReadSource } from '../src/d1-schedule-placement';

const uuid = (suffix: number): string =>
  `019c1df8-a7c6-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(uuid(801));
const userId = parseUserId(uuid(802));
const eventId = parseEventId(uuid(803));
const roomId = uuid(804);
const trackId = uuid(805);
const formatId = uuid(806);
const recordedAtMs = Date.parse('2026-08-18T12:00:00.000Z');

beforeAll(async () => {
  const registryJson = canonicalJsonText({
    scope: { workspaceId, eventId },
    version: 1,
    fields: [],
    removed: []
  });
  const registryDigest = [...new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(registryJson)
  ))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'Program Vocabulary workspace','active',1,1,1)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','Program Vocabulary owner',1,1,1)`).bind(userId),
    env.DB.prepare(`INSERT INTO event_spine_workspace_sets
      (workspace_id,version,current_event_id) VALUES (?,1,NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO event_spine_heads (
      workspace_id,id,name,timezone,start_date,end_date,version,
      created_by_user_id,created_at_ms,create_plan_digest_sha256
    ) VALUES (?,?,'Program Vocabulary Summit','UTC','2027-04-02','2027-04-03',1,?,?,?)`)
      .bind(workspaceId, eventId, userId, recordedAtMs, 'a'.repeat(64)),
    env.DB.prepare(`INSERT INTO event_spine_scope_roots (workspace_id,event_id)
      VALUES (?,?)`).bind(workspaceId, eventId),
    env.DB.prepare(`INSERT INTO field_registry_aggregates
      (workspace_id,event_id,registry_version,state_json,state_digest_sha256,
       baseline_digest_sha256) VALUES (?,?,1,?,?,?)`)
      .bind(workspaceId, eventId, registryJson, registryDigest, registryDigest),
    env.DB.prepare(`INSERT INTO program_vocabulary_sets
      (workspace_id,event_id,set_version,created_by_user_id,created_at_ms,
       updated_by_user_id,updated_at_ms) VALUES (?,?,2,?,?,?,?)`)
      .bind(workspaceId, eventId, userId, recordedAtMs, userId, recordedAtMs),
    env.DB.prepare(`INSERT INTO program_vocabulary_rooms
      (workspace_id,event_id,id,name,capacity,status,version,created_by_user_id,
       created_at_ms,updated_by_user_id,updated_at_ms)
       VALUES (?,?,?,'Main Hall',500,'active',1,?,?,?,?)`)
      .bind(workspaceId, eventId, roomId, userId, recordedAtMs, userId, recordedAtMs),
    env.DB.prepare(`INSERT INTO program_vocabulary_tracks
      (workspace_id,event_id,id,name,status,version,created_by_user_id,created_at_ms,
       updated_by_user_id,updated_at_ms)
       VALUES (?,?,?,'Engineering','active',1,?,?,?,?)`)
      .bind(workspaceId, eventId, trackId, userId, recordedAtMs, userId, recordedAtMs),
    env.DB.prepare(`INSERT INTO program_vocabulary_formats
      (workspace_id,event_id,id,name,status,version,created_by_user_id,created_at_ms,
       updated_by_user_id,updated_at_ms)
       VALUES (?,?,?,'Talk','active',1,?,?,?,?)`)
      .bind(workspaceId, eventId, formatId, userId, recordedAtMs, userId, recordedAtMs),
    env.DB.prepare(`INSERT INTO schedule_placement_sets
      (workspace_id,event_id,schedule_version,updated_by_user_id,updated_at_ms)
      VALUES (?,?,2,?,?)`).bind(workspaceId, eventId, userId, recordedAtMs),
    env.DB.prepare(`INSERT INTO schedule_occurrences
      (workspace_id,event_id,id,session_id,room_id,start_at_ms,end_at_ms,version,
       updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        workspaceId,
        eventId,
        uuid(807),
        uuid(808),
        roomId,
        Date.parse('2027-04-02T09:00:00.000Z'),
        Date.parse('2027-04-02T10:00:00.000Z'),
        1,
        userId,
        recordedAtMs
      )
  ]);
});

describe('D1 Program Vocabulary snapshot read source', () => {
  test('projects current schedule usage into safe deletion eligibility', async () => {
    const source = createD1ProgramVocabularySnapshotReadSource({
      database: env.DB,
      workspaceId
    });

    const snapshot = await source.readSnapshot({ workspaceId, eventId });

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      scope: { workspaceId, eventId },
      setVersion: 2,
      rooms: [{
        id: roomId,
        usage: { current: 1, historicalPins: 0 },
        deleteEligibility: {
          kind: 'blocked',
          currentReferences: 1,
          historicalPins: 0
        }
      }],
      tracks: [{
        id: trackId,
        usage: { current: 0, historicalPins: 0 },
        deleteEligibility: { kind: 'eligible' }
      }],
      formats: [{
        id: formatId,
        usage: { current: 0, historicalPins: 0 },
        deleteEligibility: { kind: 'eligible' }
      }]
    });
  });

  test('rejects a workspace outside the configured D1 partition', async () => {
    const source = createD1ProgramVocabularySnapshotReadSource({
      database: env.DB,
      workspaceId
    });

    await expect(source.readSnapshot({
      workspaceId: parseWorkspaceId(uuid(809)),
      eventId
    })).rejects.toMatchObject({
      name: 'D1ProgramVocabularyReadError',
      code: 'wrong_scope'
    } satisfies Partial<D1ProgramVocabularyReadError>);
  });

  test('projects the same current placement through the canonical schedule state', async () => {
    const source = createD1SchedulePlacementReadSource({
      database: env.DB,
      workspaceId
    });

    const schedule = await source.readSchedule({ workspaceId, eventId });

    expect(schedule).toMatchObject({
      scope: { workspaceId, eventId },
      scheduleVersion: 2,
      occurrences: [{
        id: uuid(807),
        sessionId: uuid(808),
        roomId,
        startAt: '2027-04-02T09:00:00.000Z',
        endAt: '2027-04-02T10:00:00.000Z',
        version: 1
      }]
    });
  });

  test('fails closed when a retained reference projection digest is corrupt', async () => {
    const corruptEventId = parseEventId(uuid(810));
    const corruptRegistryJson = canonicalJsonText({
      scope: { workspaceId, eventId: corruptEventId },
      version: 1,
      fields: [],
      removed: []
    });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO event_spine_heads (
        workspace_id,id,name,timezone,start_date,end_date,version,
        created_by_user_id,created_at_ms,create_plan_digest_sha256
      ) VALUES (?,?,'Corrupt projection event','UTC','2027-05-02','2027-05-03',1,?,?,?)`)
        .bind(workspaceId, corruptEventId, userId, recordedAtMs, 'c'.repeat(64)),
      env.DB.prepare(`INSERT INTO event_spine_scope_roots (workspace_id,event_id)
        VALUES (?,?)`).bind(workspaceId, corruptEventId),
      env.DB.prepare(`INSERT INTO field_registry_aggregates
        (workspace_id,event_id,registry_version,state_json,state_digest_sha256,
         baseline_digest_sha256) VALUES (?,?,1,?,?,?)`)
        .bind(
          workspaceId,
          corruptEventId,
          corruptRegistryJson,
          'b'.repeat(64),
          'b'.repeat(64)
        )
    ]);
    const source = createD1ProgramVocabularySnapshotReadSource({
      database: env.DB,
      workspaceId
    });

    await expect(source.readSnapshot({
      workspaceId,
      eventId: corruptEventId
    })).rejects.toMatchObject({
      name: 'D1ProgramVocabularyReadError',
      code: 'data_corrupt'
    } satisfies Partial<D1ProgramVocabularyReadError>);
  });
});
