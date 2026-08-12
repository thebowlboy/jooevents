import { z } from 'zod';
import { createReadOperationResultSchema, structuredOutcomeSchema } from './operations';

export const programVocabularyKindSchema = z.enum(['room', 'track', 'format']);
export const programVocabularyStatusSchema = z.enum(['active', 'retired']);
export const programVocabularyVersionSchema = z.number().int().positive();
export const programVocabularyIdSchema = z.uuid();
export const programVocabularyNameSchema = z.string().trim().min(1).max(200);

export const programVocabularyScopeSchema = z.strictObject({
  workspaceId: z.uuid(),
  eventId: z.uuid()
});

export const programVocabularyUsageSchema = z.strictObject({
  current: z.number().int().nonnegative(),
  historicalPins: z.number().int().nonnegative()
});

export const programVocabularyDeleteEligibilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('eligible') }),
  z.strictObject({
    kind: z.literal('blocked'),
    currentReferences: z.number().int().nonnegative(),
    historicalPins: z.number().int().nonnegative()
  })
]);

const commonItemFields = {
  id: programVocabularyIdSchema,
  name: programVocabularyNameSchema,
  status: programVocabularyStatusSchema,
  version: programVocabularyVersionSchema,
  usage: programVocabularyUsageSchema,
  deleteEligibility: programVocabularyDeleteEligibilitySchema
} as const;

export const programRoomSchema = z.strictObject({
  kind: z.literal('room'),
  ...commonItemFields,
  capacity: z.number().int().positive().nullable()
});

export const programTrackSchema = z.strictObject({
  kind: z.literal('track'),
  ...commonItemFields
});

export const programFormatSchema = z.strictObject({
  kind: z.literal('format'),
  ...commonItemFields
});

export const programVocabularyItemSchema = z.discriminatedUnion('kind', [
  programRoomSchema,
  programTrackSchema,
  programFormatSchema
]);

export const programVocabularySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: programVocabularyScopeSchema,
  setVersion: programVocabularyVersionSchema,
  rooms: z.array(programRoomSchema),
  tracks: z.array(programTrackSchema),
  formats: z.array(programFormatSchema)
});

/** The current event target is resolved from verified invocation evidence, not request data. */
export const programVocabularySnapshotReadInputSchema = z.strictObject({});

export const programVocabularySnapshotCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('success'),
    data: programVocabularySnapshotSchema
  }),
  z.strictObject({
    kind: z.literal('outcome'),
    outcome: structuredOutcomeSchema
  })
]);

export const programVocabularySnapshotReadResultSchema =
  createReadOperationResultSchema(programVocabularySnapshotSchema);

const guardedItemFields = {
  scope: programVocabularyScopeSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  expectedItemVersion: programVocabularyVersionSchema
} as const;

const roomCreateInputSchema = z.strictObject({
  action: z.literal('create'),
  scope: programVocabularyScopeSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  item: z.strictObject({
    kind: z.literal('room'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    capacity: z.number().int().positive().nullable()
  })
});

const trackCreateInputSchema = z.strictObject({
  action: z.literal('create'),
  scope: programVocabularyScopeSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  item: z.strictObject({
    kind: z.literal('track'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema
  })
});

const formatCreateInputSchema = z.strictObject({
  action: z.literal('create'),
  scope: programVocabularyScopeSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  item: z.strictObject({
    kind: z.literal('format'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema
  })
});

export const programVocabularyCreateDraftInputSchema = z.union([
  roomCreateInputSchema,
  trackCreateInputSchema,
  formatCreateInputSchema
]);

const roomEditFields = z.strictObject({
  name: programVocabularyNameSchema,
  capacity: z.number().int().positive().nullable()
});
const namedEditFields = z.strictObject({ name: programVocabularyNameSchema });

export const programVocabularyEditDraftInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    action: z.literal('edit'),
    kind: z.literal('room'),
    id: programVocabularyIdSchema,
    ...guardedItemFields,
    changes: roomEditFields
  }),
  z.strictObject({
    action: z.literal('edit'),
    kind: z.literal('track'),
    id: programVocabularyIdSchema,
    ...guardedItemFields,
    changes: namedEditFields
  }),
  z.strictObject({
    action: z.literal('edit'),
    kind: z.literal('format'),
    id: programVocabularyIdSchema,
    ...guardedItemFields,
    changes: namedEditFields
  })
]);

function lifecycleDraftInput<Action extends 'retire' | 'restore' | 'delete'>(action: Action) {
  return z.strictObject({
    action: z.literal(action),
    kind: programVocabularyKindSchema,
    id: programVocabularyIdSchema,
    ...guardedItemFields
  });
}

export const programVocabularyRetireDraftInputSchema = lifecycleDraftInput('retire');
export const programVocabularyRestoreDraftInputSchema = lifecycleDraftInput('restore');
export const programVocabularyDeleteDraftInputSchema = lifecycleDraftInput('delete');

export const programVocabularyMergeDraftInputSchema = z.strictObject({
  action: z.literal('merge'),
  scope: programVocabularyScopeSchema,
  kind: programVocabularyKindSchema,
  sourceId: programVocabularyIdSchema,
  targetId: programVocabularyIdSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  expectedSourceVersion: programVocabularyVersionSchema,
  expectedTargetVersion: programVocabularyVersionSchema
});

export const programVocabularyDraftInputSchema = z.union([
  programVocabularyCreateDraftInputSchema,
  programVocabularyEditDraftInputSchema,
  programVocabularyRetireDraftInputSchema,
  programVocabularyRestoreDraftInputSchema,
  programVocabularyDeleteDraftInputSchema,
  programVocabularyMergeDraftInputSchema
]);

const safeDiffItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('room'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    status: programVocabularyStatusSchema,
    capacity: z.number().int().positive().nullable(),
    version: programVocabularyVersionSchema
  }),
  z.strictObject({
    kind: z.literal('track'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    status: programVocabularyStatusSchema,
    version: programVocabularyVersionSchema
  }),
  z.strictObject({
    kind: z.literal('format'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    status: programVocabularyStatusSchema,
    version: programVocabularyVersionSchema
  })
]);

export const programVocabularySafeDiffSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    before: z.null(),
    after: safeDiffItemSchema
  }),
  z.strictObject({
    action: z.literal('edit'),
    before: safeDiffItemSchema,
    after: safeDiffItemSchema
  }),
  z.strictObject({
    action: z.literal('retire'),
    before: safeDiffItemSchema,
    after: safeDiffItemSchema
  }),
  z.strictObject({
    action: z.literal('restore'),
    before: safeDiffItemSchema,
    after: safeDiffItemSchema
  }),
  z.strictObject({
    action: z.literal('delete'),
    before: safeDiffItemSchema,
    after: z.null(),
    usage: programVocabularyUsageSchema
  }),
  z.strictObject({
    action: z.literal('merge'),
    sourceBefore: safeDiffItemSchema,
    sourceAfter: safeDiffItemSchema,
    target: safeDiffItemSchema,
    liveRepoints: z.number().int().nonnegative(),
    historicalPinsPreserved: z.number().int().nonnegative()
  }),
  z.strictObject({
    action: z.literal('merge_compensation'),
    sourceBefore: safeDiffItemSchema,
    sourceAfter: safeDiffItemSchema,
    target: safeDiffItemSchema,
    liveRepoints: z.number().int().nonnegative(),
    historicalPinsPreserved: z.number().int().nonnegative()
  })
]);

export const programVocabularyChangeResultSchema = z.strictObject({
  action: z.enum(['create', 'edit', 'retire', 'restore', 'delete', 'merge', 'merge_compensation']),
  kind: programVocabularyKindSchema,
  affectedIds: z.array(programVocabularyIdSchema).min(1).max(2),
  setVersion: programVocabularyVersionSchema,
  liveRepoints: z.number().int().nonnegative()
});

export type ProgramVocabularyKind = z.infer<typeof programVocabularyKindSchema>;
export type ProgramVocabularyStatus = z.infer<typeof programVocabularyStatusSchema>;
export type ProgramVocabularyScopeDto = z.infer<typeof programVocabularyScopeSchema>;
export type ProgramVocabularyUsageDto = z.infer<typeof programVocabularyUsageSchema>;
export type ProgramVocabularyDeleteEligibilityDto = z.infer<typeof programVocabularyDeleteEligibilitySchema>;
export type ProgramRoomDto = z.infer<typeof programRoomSchema>;
export type ProgramTrackDto = z.infer<typeof programTrackSchema>;
export type ProgramFormatDto = z.infer<typeof programFormatSchema>;
export type ProgramVocabularyItemDto = z.infer<typeof programVocabularyItemSchema>;
export type ProgramVocabularySnapshotDto = z.infer<typeof programVocabularySnapshotSchema>;
export type ProgramVocabularySnapshotReadInput = z.infer<typeof programVocabularySnapshotReadInputSchema>;
export type ProgramVocabularySnapshotCanonicalResult = z.infer<typeof programVocabularySnapshotCanonicalResultSchema>;
export type ProgramVocabularySnapshotReadResult = z.infer<typeof programVocabularySnapshotReadResultSchema>;
export type ProgramVocabularyCreateDraftInput = z.infer<typeof programVocabularyCreateDraftInputSchema>;
export type ProgramVocabularyEditDraftInput = z.infer<typeof programVocabularyEditDraftInputSchema>;
export type ProgramVocabularyRetireDraftInput = z.infer<typeof programVocabularyRetireDraftInputSchema>;
export type ProgramVocabularyRestoreDraftInput = z.infer<typeof programVocabularyRestoreDraftInputSchema>;
export type ProgramVocabularyDeleteDraftInput = z.infer<typeof programVocabularyDeleteDraftInputSchema>;
export type ProgramVocabularyMergeDraftInput = z.infer<typeof programVocabularyMergeDraftInputSchema>;
export type ProgramVocabularyDraftInput = z.infer<typeof programVocabularyDraftInputSchema>;
export type ProgramVocabularySafeDiff = z.infer<typeof programVocabularySafeDiffSchema>;
export type ProgramVocabularyChangeResult = z.infer<typeof programVocabularyChangeResultSchema>;
