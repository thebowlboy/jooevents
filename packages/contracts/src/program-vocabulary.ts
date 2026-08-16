import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';

const PROGRAM_VOCABULARY_NAME_LIMIT = 200;
const APPLICATION_UUID_INPUT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLICATION_UUID_CANONICAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalizedProgramVocabularyName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function isAcceptedProgramVocabularyNameInput(value: string): boolean {
  const normalized = normalizedProgramVocabularyName(value);
  return normalized.length > 0 && normalized.length <= PROGRAM_VOCABULARY_NAME_LIMIT;
}

/** Returns the deterministic stored form accepted for a Program Vocabulary name. */
export function normalizeProgramVocabularyNameInput(value: string): string {
  const normalized = normalizedProgramVocabularyName(value);
  if (normalized.length === 0 || normalized.length > PROGRAM_VOCABULARY_NAME_LIMIT) {
    throw new TypeError('program vocabulary name must contain 1 to 200 characters');
  }
  return normalized;
}

/** Tests canonical output/storage bytes without changing them. */
export function isCanonicalProgramVocabularyName(value: string): boolean {
  return value.length > 0
    && value.length <= PROGRAM_VOCABULARY_NAME_LIMIT
    && normalizedProgramVocabularyName(value) === value;
}

export const programVocabularyKindSchema = z.enum(['room', 'track', 'format']);
export const programVocabularyStatusSchema = z.enum(['active', 'retired']);
export const programTrackAccentSchema = z.enum(['lavender', 'sea', 'neutral']);
export const programVocabularyVersionSchema = z.number().int().positive().safe();
export const programVocabularyIdInputSchema = z.string()
  .regex(APPLICATION_UUID_INPUT)
  .overwrite((value) => value.toLowerCase());
export const programVocabularyIdSchema = z.string().regex(APPLICATION_UUID_CANONICAL);

/** Stable presentation voice derived from an immutable canonical Track identity. */
export function deriveProgramTrackAccent(
  id: string
): z.infer<typeof programTrackAccentSchema> {
  const canonicalId = programVocabularyIdSchema.parse(id);
  const finalByte = Number.parseInt(canonicalId.slice(-2), 16);
  return (['lavender', 'sea', 'neutral'] as const)[finalByte % 3]!;
}
export const programVocabularyNameInputSchema = z.string()
  .refine(isAcceptedProgramVocabularyNameInput)
  .overwrite(normalizeProgramVocabularyNameInput);
export const programVocabularyNameSchema = z.string().refine(isCanonicalProgramVocabularyName);

export const programVocabularyScopeSchema = z.strictObject({
  workspaceId: programVocabularyIdSchema,
  eventId: programVocabularyIdSchema
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
  ...commonItemFields,
  accent: programTrackAccentSchema
}).superRefine((track, context) => {
  if (track.accent !== deriveProgramTrackAccent(track.id)) {
    context.addIssue({
      code: 'custom',
      path: ['accent'],
      message: 'track accent must match its immutable identity'
    });
  }
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

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addSnapshotIssues(
  snapshot: {
    readonly rooms: readonly z.infer<typeof programRoomSchema>[];
    readonly tracks: readonly z.infer<typeof programTrackSchema>[];
    readonly formats: readonly z.infer<typeof programFormatSchema>[];
  },
  context: z.core.$RefinementCtx
): void {
  const allIds = new Set<string>();
  for (const [family, items] of [
    ['rooms', snapshot.rooms],
    ['tracks', snapshot.tracks],
    ['formats', snapshot.formats]
  ] as const) {
    for (const [index, item] of items.entries()) {
      if (index > 0 && compareCanonicalText(items[index - 1]!.id, item.id) >= 0) {
        context.addIssue({
          code: 'custom',
          path: [family, index, 'id'],
          message: 'items must be uniquely ordered by canonical id'
        });
      }
      if (allIds.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: [family, index, 'id'],
          message: 'item ids must be unique across vocabulary kinds'
        });
      }
      allIds.add(item.id);
      if (item.kind === 'track' && item.accent !== deriveProgramTrackAccent(item.id)) {
        context.addIssue({
          code: 'custom',
          path: [family, index, 'accent'],
          message: 'track accent must match its immutable identity'
        });
      }
      const eligible = item.usage.current === 0 && item.usage.historicalPins === 0;
      const coherent = item.deleteEligibility.kind === 'eligible'
        ? eligible
        : !eligible
          && item.deleteEligibility.currentReferences === item.usage.current
          && item.deleteEligibility.historicalPins === item.usage.historicalPins;
      if (!coherent) {
        context.addIssue({
          code: 'custom',
          path: [family, index, 'deleteEligibility'],
          message: 'delete eligibility must match current usage'
        });
      }
    }
  }
}

export const programVocabularySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: programVocabularyScopeSchema,
  setVersion: programVocabularyVersionSchema,
  rooms: z.array(programRoomSchema),
  tracks: z.array(programTrackSchema),
  formats: z.array(programFormatSchema)
}).superRefine(addSnapshotIssues);

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
    id: programVocabularyIdInputSchema,
    name: programVocabularyNameInputSchema,
    capacity: z.number().int().positive().nullable()
  })
});

const trackCreateInputSchema = z.strictObject({
  action: z.literal('create'),
  scope: programVocabularyScopeSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  item: z.strictObject({
    kind: z.literal('track'),
    id: programVocabularyIdInputSchema,
    name: programVocabularyNameInputSchema
  })
});

const formatCreateInputSchema = z.strictObject({
  action: z.literal('create'),
  scope: programVocabularyScopeSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  item: z.strictObject({
    kind: z.literal('format'),
    id: programVocabularyIdInputSchema,
    name: programVocabularyNameInputSchema
  })
});

export const programVocabularyCreateDraftInputSchema = z.union([
  roomCreateInputSchema,
  trackCreateInputSchema,
  formatCreateInputSchema
]);

const roomEditFields = z.strictObject({
  name: programVocabularyNameInputSchema,
  capacity: z.number().int().positive().nullable()
});
const namedEditFields = z.strictObject({ name: programVocabularyNameInputSchema });

export const programVocabularyEditDraftInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    action: z.literal('edit'),
    kind: z.literal('room'),
    id: programVocabularyIdInputSchema,
    ...guardedItemFields,
    changes: roomEditFields
  }),
  z.strictObject({
    action: z.literal('edit'),
    kind: z.literal('track'),
    id: programVocabularyIdInputSchema,
    ...guardedItemFields,
    changes: namedEditFields
  }),
  z.strictObject({
    action: z.literal('edit'),
    kind: z.literal('format'),
    id: programVocabularyIdInputSchema,
    ...guardedItemFields,
    changes: namedEditFields
  })
]);

function lifecycleDraftInput<Action extends 'retire' | 'restore' | 'delete'>(action: Action) {
  return z.strictObject({
    action: z.literal(action),
    kind: programVocabularyKindSchema,
    id: programVocabularyIdInputSchema,
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
  sourceId: programVocabularyIdInputSchema,
  targetId: programVocabularyIdInputSchema,
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
    accent: programTrackAccentSchema,
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
]).superRefine((diff, context) => {
  const items = diff.action === 'create'
    ? [diff.after]
    : diff.action === 'edit' || diff.action === 'retire' || diff.action === 'restore'
      ? [diff.before, diff.after]
      : diff.action === 'delete'
        ? [diff.before]
        : [diff.sourceBefore, diff.sourceAfter, diff.target];
  for (const [index, item] of items.entries()) {
    if (item.kind === 'track' && item.accent !== deriveProgramTrackAccent(item.id)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'accent'],
        message: 'track accent must match its immutable identity'
      });
    }
  }
});

export const programVocabularyChangeResultSchema = z.strictObject({
  action: z.enum(['create', 'edit', 'retire', 'restore', 'delete', 'merge', 'merge_compensation']),
  kind: programVocabularyKindSchema,
  affectedIds: z.array(programVocabularyIdSchema).min(1).max(2),
  setVersion: programVocabularyVersionSchema,
  liveRepoints: z.number().int().nonnegative()
});

/*
 * Browser-safe operator operation contracts. These intentionally exclude trusted
 * scope, generated ids, preparation handles, and internal contribution records;
 * the application resolves or creates those below the transport boundary.
 */
const programVocabularyOperationApplicationIdSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  { message: 'Application IDs must use canonical lowercase bytes.' }
);

export const programVocabularyCreateDraftRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('room'),
    expectedSetVersion: programVocabularyVersionSchema,
    name: programVocabularyNameInputSchema,
    capacity: z.number().int().positive().safe().nullable()
  }),
  z.strictObject({
    kind: z.literal('track'),
    expectedSetVersion: programVocabularyVersionSchema,
    name: programVocabularyNameInputSchema
  }),
  z.strictObject({
    kind: z.literal('format'),
    expectedSetVersion: programVocabularyVersionSchema,
    name: programVocabularyNameInputSchema
  })
]);

export const programVocabularyEditDraftRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('room'),
    id: programVocabularyIdInputSchema,
    expectedSetVersion: programVocabularyVersionSchema,
    expectedItemVersion: programVocabularyVersionSchema,
    changes: z.strictObject({
      name: programVocabularyNameInputSchema,
      capacity: z.number().int().positive().safe().nullable()
    })
  }),
  z.strictObject({
    kind: z.literal('track'),
    id: programVocabularyIdInputSchema,
    expectedSetVersion: programVocabularyVersionSchema,
    expectedItemVersion: programVocabularyVersionSchema,
    changes: z.strictObject({ name: programVocabularyNameInputSchema })
  }),
  z.strictObject({
    kind: z.literal('format'),
    id: programVocabularyIdInputSchema,
    expectedSetVersion: programVocabularyVersionSchema,
    expectedItemVersion: programVocabularyVersionSchema,
    changes: z.strictObject({ name: programVocabularyNameInputSchema })
  })
]);

function programVocabularyLifecycleDraftRequestSchema() {
  return z.strictObject({
    kind: programVocabularyKindSchema,
    id: programVocabularyIdInputSchema,
    expectedSetVersion: programVocabularyVersionSchema,
    expectedItemVersion: programVocabularyVersionSchema
  });
}

export const programVocabularyRetireDraftRequestSchema =
  programVocabularyLifecycleDraftRequestSchema();
export const programVocabularyRestoreDraftRequestSchema =
  programVocabularyLifecycleDraftRequestSchema();
export const programVocabularyDeleteDraftRequestSchema =
  programVocabularyLifecycleDraftRequestSchema();
export const programVocabularyMergeDraftRequestSchema = z.strictObject({
  kind: programVocabularyKindSchema,
  sourceId: programVocabularyIdInputSchema,
  targetId: programVocabularyIdInputSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  expectedSourceVersion: programVocabularyVersionSchema,
  expectedTargetVersion: programVocabularyVersionSchema
});

export const programVocabularyDirectDataSchema = programVocabularyChangeResultSchema;
export const programVocabularyDirectCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: programVocabularyDirectDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const programVocabularyDirectOperationResultSchema =
  createEffectfulOperationResultSchema(programVocabularyDirectDataSchema);

/** Feature-owned reviewed merge revision with its own draft and publish selector. */
export const programVocabularyMergeReviewDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('merge'),
  draftId: programVocabularyOperationApplicationIdSchema,
  status: z.literal('draft'),
  revision: z.strictObject({
    id: programVocabularyOperationApplicationIdSchema,
    number: z.literal(1),
    digestSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  safeDiff: programVocabularySafeDiffSchema
}).superRefine((data, context) => {
  if (data.safeDiff.action !== 'merge') {
    context.addIssue({ code: 'custom', path: ['safeDiff', 'action'], message: 'Expected a merge diff.' });
  }
});
export const programVocabularyMergeReviewCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: programVocabularyMergeReviewDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const programVocabularyMergeReviewOperationResultSchema =
  createEffectfulOperationResultSchema(programVocabularyMergeReviewDataSchema);
export const programVocabularyMergePublishInputSchema = z.strictObject({
  draftId: programVocabularyOperationApplicationIdSchema,
  revisionId: programVocabularyOperationApplicationIdSchema,
  revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
});
export const programVocabularyMergePublishCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: programVocabularyChangeResultSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const programVocabularyMergePublishOperationResultSchema =
  createEffectfulOperationResultSchema(programVocabularyChangeResultSchema);

const programVocabularyDraftRequestSchemas = Object.freeze({
  create: programVocabularyCreateDraftRequestSchema,
  edit: programVocabularyEditDraftRequestSchema,
  retire: programVocabularyRetireDraftRequestSchema,
  restore: programVocabularyRestoreDraftRequestSchema,
  delete: programVocabularyDeleteDraftRequestSchema,
  merge: programVocabularyMergeDraftRequestSchema
});

/** Exact public schema identities projected into the operator operation manifest. */
export const PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS = Object.freeze({
  snapshotRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.program_vocabulary.snapshot-read.input',
    inputSchema: programVocabularySnapshotReadInputSchema,
    resultKey: 'schema.program_vocabulary.snapshot-read.operator-result',
    resultSchema: programVocabularySnapshotReadResultSchema
  }),
  direct: Object.freeze(Object.fromEntries(
    Object.entries(programVocabularyDraftRequestSchemas)
      .filter(([action]) => action !== 'merge')
      .map(([action, inputSchema]) => [
        action,
        createOperationSchemaManifestRefs({
          inputKey: `schema.program_vocabulary.${action}.input`,
          inputSchema,
          resultKey: 'schema.program_vocabulary.direct.operator-result',
          resultSchema: programVocabularyDirectOperationResultSchema
        })
      ])
  ) as {
    readonly [Action in Exclude<keyof typeof programVocabularyDraftRequestSchemas, 'merge'>]:
      ReturnType<typeof createOperationSchemaManifestRefs>;
  }),
  mergeReviewDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.program_vocabulary.merge-review-draft.input',
    inputSchema: programVocabularyMergeDraftRequestSchema,
    resultKey: 'schema.program_vocabulary.merge-review-draft.operator-result',
    resultSchema: programVocabularyMergeReviewOperationResultSchema
  }),
  mergePublish: createOperationSchemaManifestRefs({
    inputKey: 'schema.program_vocabulary.merge-publish.input',
    inputSchema: programVocabularyMergePublishInputSchema,
    resultKey: 'schema.program_vocabulary.merge-publish.operator-result',
    resultSchema: programVocabularyMergePublishOperationResultSchema
  })
});

export type ProgramVocabularyKind = z.infer<typeof programVocabularyKindSchema>;
export type ProgramVocabularyStatus = z.infer<typeof programVocabularyStatusSchema>;
export type ProgramTrackAccent = z.infer<typeof programTrackAccentSchema>;
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
export type ProgramVocabularyCreateDraftRequest =
  z.infer<typeof programVocabularyCreateDraftRequestSchema>;
export type ProgramVocabularyEditDraftRequest =
  z.infer<typeof programVocabularyEditDraftRequestSchema>;
export type ProgramVocabularyRetireDraftRequest =
  z.infer<typeof programVocabularyRetireDraftRequestSchema>;
export type ProgramVocabularyRestoreDraftRequest =
  z.infer<typeof programVocabularyRestoreDraftRequestSchema>;
export type ProgramVocabularyDeleteDraftRequest =
  z.infer<typeof programVocabularyDeleteDraftRequestSchema>;
export type ProgramVocabularyMergeDraftRequest =
  z.infer<typeof programVocabularyMergeDraftRequestSchema>;
export type ProgramVocabularyDirectData = z.infer<typeof programVocabularyDirectDataSchema>;
export type ProgramVocabularyDirectOperationResult =
  z.infer<typeof programVocabularyDirectOperationResultSchema>;
export type ProgramVocabularyMergeReviewData = z.infer<typeof programVocabularyMergeReviewDataSchema>;
export type ProgramVocabularyMergePublishInput = z.infer<typeof programVocabularyMergePublishInputSchema>;
