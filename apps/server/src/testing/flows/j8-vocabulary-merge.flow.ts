import { expect } from 'bun:test';
import { runJ2Spine } from './j2-spine.flow';
import type { FlowWorld } from './flow-world';

type Change = { readonly affectedIds: readonly string[]; readonly setVersion: number };
type MergeDraft = {
  readonly draftId: string;
  readonly revision: { readonly id: string; readonly digestSha256: string };
  readonly safeDiff: { readonly action: string; readonly liveRepoints: number; readonly historicalPinsPreserved: number };
};
type Vocabulary = {
  readonly setVersion: number;
  readonly formats: readonly { readonly id: string; readonly status: string; readonly version: number }[];
  readonly rooms: readonly { readonly id: string; readonly status: string; readonly version: number }[];
};
function required<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`J8 missing ${label}`);
  return value;
}

/** J8 — ordinary vocabulary edits coexist with reviewed, published repoint merges. */
export async function runJ8VocabularyMerge(world: FlowWorld): Promise<void> {
  const organizer = world.as('organizer');
  const spine = await runJ2Spine(world);
  const room = await organizer.do<Change>('program_vocabulary.create', {
    kind: 'room', expectedSetVersion: 3, name: 'Merge Annex', capacity: 80
  });
  await organizer.expectLog('Created a room');
  const roomId = required(room.data.affectedIds[0], 'merge room');
  const edited = await organizer.do<Change>('program_vocabulary.edit', {
    kind: 'room', id: roomId, expectedSetVersion: room.data.setVersion, expectedItemVersion: 1,
    changes: { name: 'Merge Annex A', capacity: 90 }
  });
  await organizer.expectLog('Updated a room');
  const retired = await organizer.do<Change>('program_vocabulary.retire', {
    kind: 'room', id: roomId, expectedSetVersion: edited.data.setVersion, expectedItemVersion: 2
  });
  await organizer.expectLog('Retired a room');
  const restored = await organizer.do<Change>('program_vocabulary.restore', {
    kind: 'room', id: roomId, expectedSetVersion: retired.data.setVersion, expectedItemVersion: 3
  });
  await organizer.expectLog('Restored a room');
  const target = await organizer.do<Change>('program_vocabulary.create', {
    kind: 'format', expectedSetVersion: restored.data.setVersion, name: 'Merged talk'
  });
  await organizer.expectLog('Created a format');
  const targetId = required(target.data.affectedIds[0], 'merge target');
  const draft = await organizer.do<MergeDraft>('program_vocabulary.merge.draft', {
    kind: 'format', sourceId: spine.formatId, targetId, expectedSetVersion: target.data.setVersion,
    expectedSourceVersion: 1, expectedTargetVersion: 1
  });
  expect(draft.data.safeDiff).toMatchObject({ action: 'merge' });
  expect(draft.data.safeDiff.liveRepoints).toBeGreaterThan(0);
  const published = await organizer.do<Change>('program_vocabulary.merge', {
    draftId: draft.data.draftId, revisionId: draft.data.revision.id,
    revisionDigestSha256: draft.data.revision.digestSha256
  });
  await organizer.expectLog('Merged program categories');
  await organizer.replay(published);
  await organizer.expectRead('program_vocabulary.snapshot.read', (projection) => {
    const vocabulary = projection as Vocabulary;
    const source = vocabulary.formats.find((item) => item.id === spine.formatId);
    const targetFormat = vocabulary.formats.find((item) => item.id === targetId);
    const restoredRoom = vocabulary.rooms.find((item) => item.id === roomId);
    return source?.status === 'retired' && targetFormat?.status === 'active' && restoredRoom?.status === 'active';
  });
}
