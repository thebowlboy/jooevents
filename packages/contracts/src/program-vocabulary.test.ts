import { describe, expect, test } from 'bun:test';
import {
  programRoomSchema,
  programTrackSchema,
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
      usage, deleteEligibility
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
      sourceBefore: { kind: 'track', id, name: 'Old', status: 'active', version: 1 },
      sourceAfter: { kind: 'track', id, name: 'Old', status: 'retired', version: 2 },
      target: { kind: 'track', id: otherId, name: 'New', status: 'active', version: 1 },
      liveRepoints: 2,
      historicalPinsPreserved: 1,
      contributorRows: [{ privateSubmissionTitle: 'classified' }]
    }).success).toBe(false);
  });
});
