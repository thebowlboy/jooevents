import { describe, expect, test } from 'bun:test';
import {
  deriveProgramTrackAccent,
  programRoomSchema,
  programTrackSchema,
  programVocabularyIdInputSchema,
  programVocabularyNameInputSchema,
  programVocabularyCreateDraftRequestSchema,
  programVocabularyDeleteDraftRequestSchema,
  programVocabularyDraftInputSchema,
  programVocabularySafeDiffSchema,
  programVocabularySnapshotCanonicalResultSchema,
  programVocabularySnapshotReadInputSchema,
  programVocabularySnapshotReadResultSchema,
  programVocabularySnapshotSchema
} from '.';

const id = '018f7d5a-4b3c-7abc-8def-0123456789ab';
const otherId = '018f7d5a-4b3c-7abc-8def-0123456789ac';
const scope = { workspaceId: id, eventId: otherId };
const usage = { current: 0, historicalPins: 0 };
const deleteEligibility = { kind: 'eligible' as const };

describe('Program Vocabulary transport contracts', () => {
  test('keeps room-only capacity and distinct strict entity families', () => {
    expect(programRoomSchema.parse({
      kind: 'room', id, name: 'Main hall', capacity: 300, status: 'active', version: 1,
      usage, deleteEligibility
    }).capacity).toBe(300);
    expect(programTrackSchema.safeParse({
      kind: 'track', id, name: 'AI', capacity: 300, status: 'active', version: 1,
      accent: deriveProgramTrackAccent(id),
      usage, deleteEligibility
    }).success).toBe(false);
    expect(programTrackSchema.parse({
      kind: 'track', id, name: 'AI', status: 'active', version: 1,
      accent: deriveProgramTrackAccent(id), usage, deleteEligibility
    }).accent).toBe('lavender');
    expect(programTrackSchema.safeParse({
      kind: 'track', id, name: 'AI', status: 'active', version: 1,
      accent: 'sea', usage, deleteEligibility
    }).success).toBe(false);
    expect(programRoomSchema.safeParse({
      kind: 'room', id, name: 'Main hall', color: 'blue', capacity: null, status: 'active', version: 1,
      usage, deleteEligibility
    }).success).toBe(false);
  });

  test('requires positive item/set versions and preserves retired resolution data', () => {
    const snapshot = programVocabularySnapshotSchema.parse({
      schemaVersion: 1,
      scope,
      setVersion: 2,
      rooms: [{
        kind: 'room', id, name: 'Old room', capacity: null, status: 'retired', version: 3,
        usage: { current: 1, historicalPins: 2 },
        deleteEligibility: { kind: 'blocked', currentReferences: 1, historicalPins: 2 }
      }],
      tracks: [],
      formats: []
    });
    expect(snapshot.rooms[0]?.status).toBe('retired');
    expect(programVocabularySnapshotSchema.safeParse({ ...snapshot, setVersion: 0 }).success).toBe(false);
    expect(programVocabularySnapshotSchema.safeParse({
      ...snapshot,
      rooms: [{ ...snapshot.rooms[0], version: -1 }]
    }).success).toBe(false);

    expect(programVocabularySnapshotReadInputSchema.parse({})).toEqual({});
    expect(programVocabularySnapshotReadInputSchema.safeParse({ scope }).success).toBe(false);
    expect(programVocabularySnapshotReadInputSchema.safeParse({ eventId: scope.eventId }).success).toBe(false);
    expect(programVocabularySnapshotCanonicalResultSchema.safeParse({
      kind: 'success',
      data: snapshot
    }).success).toBe(true);
    expect(programVocabularySnapshotReadResultSchema.safeParse({
      kind: 'success',
      data: snapshot,
      correlationId: id
    }).success).toBe(true);
  });

  test('draft guards are mandatory and safe diffs reject contributor/private detail', () => {
    expect(programVocabularyDraftInputSchema.safeParse({
      action: 'merge', scope, kind: 'track', sourceId: id, targetId: otherId,
      expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
    }).success).toBe(true);
    expect(programVocabularyDraftInputSchema.safeParse({
      action: 'merge', scope, kind: 'track', sourceId: id, targetId: otherId,
      expectedSourceVersion: 1, expectedTargetVersion: 1
    }).success).toBe(false);
    expect(programVocabularySafeDiffSchema.safeParse({
      action: 'merge',
      sourceBefore: { kind: 'track', id, name: 'Old', status: 'active', version: 1,
        accent: deriveProgramTrackAccent(id) },
      sourceAfter: { kind: 'track', id, name: 'Old', status: 'retired', version: 2,
        accent: deriveProgramTrackAccent(id) },
      target: { kind: 'track', id: otherId, name: 'New', status: 'active', version: 1,
        accent: deriveProgramTrackAccent(otherId) },
      liveRepoints: 2,
      historicalPinsPreserved: 1,
      contributorRows: [{ privateSubmissionTitle: 'classified' }]
    }).success).toBe(false);
  });

  test('keeps operator draft requests scope-free and draft results browser-safe', () => {
    const request = programVocabularyCreateDraftRequestSchema.parse({
      kind: 'room', expectedSetVersion: 3, name: '  Main   hall  ', capacity: 300
    });
    expect(request).toEqual({
      kind: 'room', expectedSetVersion: 3, name: 'Main hall', capacity: 300
    });
    expect(programVocabularyCreateDraftRequestSchema.safeParse({
      ...request,
      scope
    }).success).toBe(false);
    expect(programVocabularyDeleteDraftRequestSchema.safeParse({
      kind: 'track', id, expectedSetVersion: 3, expectedItemVersion: 2,
      actor: 'browser-supplied'
    }).success).toBe(false);

  });

  test('normalizes author text and ids but refuses non-canonical projected bytes', () => {
    expect(programVocabularyNameInputSchema.parse('  Main   hall  ')).toBe('Main hall');
    expect(programVocabularyIdInputSchema.parse(id.toUpperCase())).toBe(id);
    expect(programRoomSchema.safeParse({
      kind: 'room', id: id.toUpperCase(), name: 'Main hall', capacity: 300,
      status: 'active', version: 1, usage, deleteEligibility
    }).success).toBe(false);
    expect(programRoomSchema.safeParse({
      kind: 'room', id, name: ' Main  hall ', capacity: 300,
      status: 'active', version: 1, usage, deleteEligibility
    }).success).toBe(false);
  });

  test('requires canonical ordering, global ids, and usage-derived delete eligibility', () => {
    const item = (itemId: string) => ({
      kind: 'track' as const,
      id: itemId,
      name: 'Track',
      accent: deriveProgramTrackAccent(itemId),
      status: 'active' as const,
      version: 1,
      usage,
      deleteEligibility
    });
    expect(programVocabularySnapshotSchema.safeParse({
      schemaVersion: 1,
      scope,
      setVersion: 1,
      rooms: [],
      tracks: [item(otherId), item(id)],
      formats: []
    }).success).toBe(false);
    expect(programVocabularySnapshotSchema.safeParse({
      schemaVersion: 1,
      scope,
      setVersion: 1,
      rooms: [],
      tracks: [{ ...item(id), accent: 'sea' }],
      formats: []
    }).success).toBe(false);
    expect(programVocabularySnapshotSchema.safeParse({
      schemaVersion: 1,
      scope,
      setVersion: 1,
      rooms: [{
        kind: 'room', id, name: 'Room', capacity: null, status: 'active', version: 1,
        usage, deleteEligibility
      }],
      tracks: [item(id)],
      formats: []
    }).success).toBe(false);
    expect(programVocabularySnapshotSchema.safeParse({
      schemaVersion: 1,
      scope,
      setVersion: 1,
      rooms: [],
      tracks: [{
        ...item(id),
        usage: { current: 1, historicalPins: 0 },
        deleteEligibility
      }],
      formats: []
    }).success).toBe(false);
  });
});
