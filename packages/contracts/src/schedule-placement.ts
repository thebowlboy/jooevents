import { parseInstant } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  versionedDefinitionRefSchema
} from './operations';
import { programVocabularyIdSchema, programVocabularyScopeSchema } from './program-vocabulary';

export const schedulePlacementVersionSchema = z.number().int().positive().safe();
export const schedulePlacementIdSchema = programVocabularyIdSchema;
export const schedulePlacementScopeSchema = programVocabularyScopeSchema;

export const schedulePlacementInstantSchema = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}, 'instant must use canonical RFC 3339 UTC millisecond form');

const occurrenceFields = {
  id: schedulePlacementIdSchema,
  sessionId: schedulePlacementIdSchema,
  roomId: schedulePlacementIdSchema,
  startAt: schedulePlacementInstantSchema,
  endAt: schedulePlacementInstantSchema,
  version: schedulePlacementVersionSchema
} as const;

export const schedulePlacementOccurrenceSchema = z.strictObject(occurrenceFields).refine(
  (occurrence) => occurrence.startAt < occurrence.endAt,
  { path: ['endAt'], message: 'occurrence end must follow its start' }
);

export const schedulePlacementSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: schedulePlacementScopeSchema,
  scheduleVersion: schedulePlacementVersionSchema,
  occurrences: z.array(schedulePlacementOccurrenceSchema).max(2_000)
}).superRefine((snapshot, context) => {
  const ids = new Set<string>();
  for (const [index, occurrence] of snapshot.occurrences.entries()) {
    if (ids.has(occurrence.id)) {
      context.addIssue({ code: 'custom', path: ['occurrences', index, 'id'], message: 'occurrence ids must be unique' });
    }
    ids.add(occurrence.id);
    const previous = snapshot.occurrences[index - 1];
    if (previous && compareOccurrence(previous, occurrence) >= 0) {
      context.addIssue({ code: 'custom', path: ['occurrences', index], message: 'occurrences must use canonical order' });
    }
  }
});

export const schedulePlacementReadInputSchema = z.strictObject({
  startAt: schedulePlacementInstantSchema,
  endAt: schedulePlacementInstantSchema,
  limit: z.number().int().positive().max(2_000)
}).refine((input) => input.startAt < input.endAt, {
  path: ['endAt'],
  message: 'read range end must follow its start'
});

const placementTimeFields = {
  expectedScheduleVersion: schedulePlacementVersionSchema,
  roomId: schedulePlacementIdSchema,
  startAt: schedulePlacementInstantSchema,
  endAt: schedulePlacementInstantSchema
} as const;

export const schedulePlacementInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('place'),
    ...placementTimeFields,
    sessionId: schedulePlacementIdSchema
  }),
  z.strictObject({
    action: z.literal('move'),
    ...placementTimeFields,
    occurrenceId: schedulePlacementIdSchema,
    expectedOccurrenceVersion: schedulePlacementVersionSchema
  })
]).refine((input) => input.startAt < input.endAt, {
  path: ['endAt'],
  message: 'placement end must follow its start'
});

/** Internal correction input; it is not an ordinary placement transport contract. */
export const schedulePlacementUnplaceInputSchema = z.strictObject({
  action: z.literal('unplace'),
  expectedScheduleVersion: schedulePlacementVersionSchema,
  occurrenceId: schedulePlacementIdSchema,
  expectedOccurrenceVersion: schedulePlacementVersionSchema
});

export const schedulePlacementAuthorInputSchema = z.union([
  schedulePlacementInputSchema,
  schedulePlacementUnplaceInputSchema
]);

/** Server-enriched input frozen into a plan after current scope is resolved. */
export const schedulePlacementPlanningInputSchema = z.union([
  z.strictObject({
    action: z.literal('place'),
    scope: schedulePlacementScopeSchema,
    ...placementTimeFields,
    occurrenceId: schedulePlacementIdSchema,
    sessionId: schedulePlacementIdSchema
  }),
  z.strictObject({
    action: z.literal('move'),
    scope: schedulePlacementScopeSchema,
    ...placementTimeFields,
    occurrenceId: schedulePlacementIdSchema,
    expectedOccurrenceVersion: schedulePlacementVersionSchema
  }),
  z.strictObject({
    action: z.literal('unplace'),
    scope: schedulePlacementScopeSchema,
    expectedScheduleVersion: schedulePlacementVersionSchema,
    occurrenceId: schedulePlacementIdSchema,
    expectedOccurrenceVersion: schedulePlacementVersionSchema
  })
]).superRefine((input, context) => {
  if (input.action !== 'unplace' && input.startAt >= input.endAt) {
    context.addIssue({ code: 'custom', path: ['endAt'], message: 'placement end must follow its start' });
  }
});

export const schedulePlacementPlanSchema = z.strictObject({
  input: schedulePlacementPlanningInputSchema,
  before: schedulePlacementOccurrenceSchema.nullable(),
  after: schedulePlacementOccurrenceSchema.nullable(),
  scheduleVersion: z.strictObject({
    before: schedulePlacementVersionSchema,
    after: schedulePlacementVersionSchema
  }),
  roomQueryGuard: z.strictObject({
    id: z.string().regex(/^schedule_room_query:[0-9a-f-]{36}:[0-9a-f-]{36}$/),
    version: schedulePlacementVersionSchema,
    digestSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
}).superRefine((plan, context) => {
  const coherent = plan.input.action === 'place'
    ? plan.before === null && plan.after !== null
    : plan.input.action === 'move'
      ? plan.before !== null && plan.after !== null
      : plan.before !== null && plan.after === null;
  if (!coherent) context.addIssue({ code: 'custom', message: 'plan images must match its action' });
});

export const schedulePlacementResultSchema = z.strictObject({
  action: z.enum(['place', 'move', 'unplace']),
  scheduleVersion: schedulePlacementVersionSchema,
  occurrence: schedulePlacementOccurrenceSchema.nullable()
});

export const schedulePlacementDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(['place', 'move']),
  changesetId: schedulePlacementIdSchema,
  headVersion: schedulePlacementVersionSchema,
  status: z.literal('draft'),
  revision: z.strictObject({
    id: schedulePlacementIdSchema,
    number: schedulePlacementVersionSchema,
    digestSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  riskTier: z.literal('normal'),
  approvalPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    requirement: z.literal('none')
  }),
  safeDiff: schedulePlacementPlanSchema
}).superRefine((data, context) => {
  if (data.safeDiff.input.action !== data.action) {
    context.addIssue({
      code: 'custom', path: ['safeDiff', 'input', 'action'],
      message: 'Draft action and safe diff action must match.'
    });
  }
});

export const schedulePlacementConflictDetailSchema = z.strictObject({
  severity: z.literal('block'),
  roomId: schedulePlacementIdSchema,
  requested: z.strictObject({
    startAt: schedulePlacementInstantSchema,
    endAt: schedulePlacementInstantSchema
  }),
  conflicts: z.array(z.strictObject({
    occurrenceId: schedulePlacementIdSchema,
    startAt: schedulePlacementInstantSchema,
    endAt: schedulePlacementInstantSchema
  })).min(1).max(100)
});

export const schedulePlacementReadResultSchema = createReadOperationResultSchema(
  schedulePlacementSnapshotSchema
);
export const schedulePlacementOperationResultSchema =
  createEffectfulOperationResultSchema(schedulePlacementResultSchema);
export const schedulePlacementDraftOperationResultSchema =
  createEffectfulOperationResultSchema(schedulePlacementDraftDataSchema);

/** Exact public schema identities projected into the operator operation manifest. */
export const SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS = Object.freeze({
  snapshotRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.schedule.placement-snapshot-read.input',
    inputSchema: schedulePlacementReadInputSchema,
    resultKey: 'schema.schedule.placement-snapshot-read.operator-result',
    resultSchema: schedulePlacementReadResultSchema
  }),
  placementDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.schedule.placement-draft.input',
    inputSchema: schedulePlacementInputSchema,
    resultKey: 'schema.schedule.placement-draft.operator-result',
    resultSchema: schedulePlacementDraftOperationResultSchema,
    version: 2
  })
});

export type SchedulePlacementOccurrenceDto = z.infer<typeof schedulePlacementOccurrenceSchema>;
export type SchedulePlacementSnapshotDto = z.infer<typeof schedulePlacementSnapshotSchema>;
export type SchedulePlacementReadInput = z.infer<typeof schedulePlacementReadInputSchema>;
export type SchedulePlacementInput = z.infer<typeof schedulePlacementInputSchema>;
export type SchedulePlacementUnplaceInput = z.infer<typeof schedulePlacementUnplaceInputSchema>;
export type SchedulePlacementAuthorInput = z.infer<typeof schedulePlacementAuthorInputSchema>;
export type SchedulePlacementPlanningInput = z.infer<typeof schedulePlacementPlanningInputSchema>;
export type SchedulePlacementPlanDto = z.infer<typeof schedulePlacementPlanSchema>;
export type SchedulePlacementResult = z.infer<typeof schedulePlacementResultSchema>;
export type SchedulePlacementDraftData = z.infer<typeof schedulePlacementDraftDataSchema>;
export type SchedulePlacementConflictDetail = z.infer<typeof schedulePlacementConflictDetailSchema>;

function compareOccurrence(
  left: Pick<SchedulePlacementOccurrenceDto, 'startAt' | 'endAt' | 'id'>,
  right: Pick<SchedulePlacementOccurrenceDto, 'startAt' | 'endAt' | 'id'>
): number {
  if (left.startAt !== right.startAt) return left.startAt < right.startAt ? -1 : 1;
  if (left.endAt !== right.endAt) return left.endAt < right.endAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
