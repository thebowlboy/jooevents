import { parseIanaTimezone, parseInstant } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createOperationSchemaManifestRefs,
  createEffectfulOperationResultSchema,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';

const SHA256 = /^[a-f0-9]{64}$/;
const PROFILE_KEY = 'deadline.calendar-date.event-local-end-exclusive';

function canonicalInstant(value: string): boolean {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}

function canonicalTimezone(value: string): boolean {
  try {
    return parseIanaTimezone(value) === value;
  } catch {
    return false;
  }
}

export const deadlineIdSchema = z.uuid().refine((value) => value === value.toLowerCase(), {
  message: 'Application IDs must use canonical lowercase bytes.'
});
export const deadlineVersionSchema = z.number().int().positive().safe();
export const deadlineDigestSchema = z.string().regex(SHA256);
export const deadlineInstantSchema = z.string().refine(canonicalInstant, {
  message: 'Instant must use canonical RFC 3339 UTC millisecond bytes.'
});
export const deadlineDisplayDateSchema = z.iso.date();
export const deadlineTimezoneSchema = z.string().min(1).max(255).refine(canonicalTimezone, {
  message: 'Timezone must be a canonical IANA timezone.'
});
export const deadlineScopeSchema = z.strictObject({
  workspaceId: deadlineIdSchema,
  eventId: deadlineIdSchema
});
export const deadlineKindSchema = z.enum(['cfp_close', 'review_due', 'task_due']);
export const deadlineGracePolicySchema = z.literal('soft');

export const deadlineBoundaryProfileSchema = z.strictObject({
  key: z.literal(PROFILE_KEY),
  version: z.literal(1),
  digestSha256: deadlineDigestSchema
});

export const deadlineBoundaryEvidenceSchema = z.strictObject({
  profile: deadlineBoundaryProfileSchema,
  eventTimezone: deadlineTimezoneSchema,
  eventVersion: deadlineVersionSchema,
  localBoundaryDate: deadlineDisplayDateSchema
});

const deadlineHeadBase = {
  schemaVersion: z.literal(1),
  id: deadlineIdSchema,
  scope: deadlineScopeSchema,
  kind: deadlineKindSchema,
  version: deadlineVersionSchema,
  digestSha256: deadlineDigestSchema,
  gracePolicy: deadlineGracePolicySchema,
  createdByUserId: deadlineIdSchema,
  createdAt: deadlineInstantSchema,
  updatedByUserId: deadlineIdSchema,
  updatedAt: deadlineInstantSchema
} as const;

export const activeDeadlineHeadSchema = z.strictObject({
  ...deadlineHeadBase,
  status: z.literal('active'),
  displayDate: deadlineDisplayDateSchema,
  effectiveAt: deadlineInstantSchema,
  boundary: deadlineBoundaryEvidenceSchema
});

export const clearedDeadlineHeadSchema = z.strictObject({
  ...deadlineHeadBase,
  status: z.literal('cleared'),
  displayDate: z.null(),
  effectiveAt: z.null(),
  boundary: z.null()
});

export const deadlineHeadSchema = z.discriminatedUnion('status', [
  activeDeadlineHeadSchema,
  clearedDeadlineHeadSchema
]);

export const deadlineReferencePinSchema = z.strictObject({
  id: deadlineIdSchema,
  version: deadlineVersionSchema,
  digestSha256: deadlineDigestSchema,
  effectiveAt: deadlineInstantSchema,
  displayDate: deadlineDisplayDateSchema,
  gracePolicy: deadlineGracePolicySchema
});

export const deadlineCatalogSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: deadlineScopeSchema,
  version: deadlineVersionSchema,
  digestSha256: deadlineDigestSchema,
  deadlines: z.array(deadlineHeadSchema).max(1_000)
}).superRefine((snapshot, context) => {
  for (let index = 1; index < snapshot.deadlines.length; index += 1) {
    if (snapshot.deadlines[index - 1]!.id >= snapshot.deadlines[index]!.id) {
      context.addIssue({
        code: 'custom', path: ['deadlines', index],
        message: 'Deadline identities must be unique and use canonical order.'
      });
    }
  }
  if (snapshot.deadlines.some((deadline) =>
    deadline.scope.workspaceId !== snapshot.scope.workspaceId
      || deadline.scope.eventId !== snapshot.scope.eventId)) {
    context.addIssue({ code: 'custom', path: ['deadlines'], message: 'Deadline scope mismatch.' });
  }
});

export const deadlineEventTimeBasisSchema = z.strictObject({
  timezone: deadlineTimezoneSchema,
  eventVersion: deadlineVersionSchema
});

/**
 * `kind` defaults to the original `cfp_close` so pre-existing planners keep
 * their exact meaning; the Review round collaboration passes `review_due`
 * explicitly. Parsed plans always carry the resolved kind.
 */
const deadlinePlanInputBase = {
  scope: deadlineScopeSchema,
  deadlineId: deadlineIdSchema,
  kind: deadlineKindSchema.default('cfp_close'),
  attributedByUserId: deadlineIdSchema,
  attributedAt: deadlineInstantSchema
} as const;

export const deadlineMutationPlanningInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...deadlinePlanInputBase,
    action: z.literal('create'),
    displayDate: deadlineDisplayDateSchema
  }),
  z.strictObject({
    ...deadlinePlanInputBase,
    action: z.literal('update'),
    expectedVersion: deadlineVersionSchema,
    displayDate: deadlineDisplayDateSchema
  }),
  z.strictObject({
    ...deadlinePlanInputBase,
    action: z.literal('clear'),
    expectedVersion: deadlineVersionSchema
  })
]);

export const deadlineMutationPlanSchema = z.strictObject({
  input: deadlineMutationPlanningInputSchema,
  before: deadlineHeadSchema.nullable(),
  after: deadlineHeadSchema,
  eventTimeBasis: deadlineEventTimeBasisSchema.nullable(),
  catalog: z.strictObject({
    beforeVersion: deadlineVersionSchema,
    beforeDigestSha256: deadlineDigestSchema,
    afterVersion: deadlineVersionSchema,
    afterDigestSha256: deadlineDigestSchema
  })
}).superRefine((plan, context) => {
  const coherent = plan.input.action === 'create'
    ? plan.before === null && plan.after.status === 'active' && plan.eventTimeBasis !== null
    : plan.input.action === 'update'
      ? plan.before !== null && plan.after.status === 'active' && plan.eventTimeBasis !== null
      : plan.before?.status === 'active' && plan.after.status === 'cleared'
        && plan.eventTimeBasis === null;
  if (!coherent) context.addIssue({ code: 'custom', message: 'Deadline plan images are incoherent.' });
  if (plan.after.id !== plan.input.deadlineId
      || (plan.before !== null && plan.before.id !== plan.input.deadlineId)) {
    context.addIssue({ code: 'custom', path: ['input', 'deadlineId'], message: 'Identity mismatch.' });
  }
  if (plan.after.kind !== plan.input.kind
      || (plan.before !== null && plan.before.kind !== plan.input.kind)) {
    context.addIssue({ code: 'custom', path: ['input', 'kind'], message: 'Kind mismatch.' });
  }
  if (plan.catalog.afterVersion !== plan.catalog.beforeVersion + 1) {
    context.addIssue({ code: 'custom', path: ['catalog'], message: 'Catalog version must advance once.' });
  }
});

const deadlineDiffImageSchema = z.strictObject({
  id: deadlineIdSchema,
  status: z.enum(['active', 'cleared']),
  version: deadlineVersionSchema,
  displayDate: deadlineDisplayDateSchema.nullable(),
  effectiveAt: deadlineInstantSchema.nullable(),
  gracePolicy: deadlineGracePolicySchema
});

export const deadlineSafeDiffSchema = z.strictObject({
  action: z.enum(['create', 'update', 'clear']),
  before: deadlineDiffImageSchema.nullable(),
  after: deadlineDiffImageSchema,
  representedConsequences: z.tuple([z.literal('deadline_changed')])
});

export const deadlineMutationResultSchema = z.strictObject({
  action: z.enum(['create', 'update', 'clear']),
  catalogVersion: deadlineVersionSchema,
  deadline: deadlineHeadSchema,
  pin: deadlineReferencePinSchema.nullable()
});

export const deadlineChangeInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), displayDate: deadlineDisplayDateSchema }),
  z.strictObject({
    action: z.literal('update'), deadlineId: deadlineIdSchema,
    expectedVersion: deadlineVersionSchema, displayDate: deadlineDisplayDateSchema
  }),
  z.strictObject({
    action: z.literal('clear'), deadlineId: deadlineIdSchema,
    expectedVersion: deadlineVersionSchema
  })
]);

export const deadlineListReadInputSchema = z.strictObject({});
export const deadlineGetReadInputSchema = z.strictObject({ deadlineId: deadlineIdSchema });
export const deadlineGetProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deadline: activeDeadlineHeadSchema.nullable()
});
export const deadlineListReadResultSchema = createReadOperationResultSchema(deadlineCatalogSnapshotSchema);
export const deadlineGetReadResultSchema = createReadOperationResultSchema(deadlineGetProjectionSchema);

export const deadlineChangeDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(['create', 'update', 'clear']),
  catalogVersion: deadlineVersionSchema,
  deadline: deadlineHeadSchema,
  pin: deadlineReferencePinSchema.nullable()
});
export const deadlineChangeCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: deadlineChangeDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const deadlineChangeOperationResultSchema = createEffectfulOperationResultSchema(deadlineChangeDataSchema);

/** Exact public schema identities projected into the operator operation manifest. */
export const DEADLINE_OPERATION_SCHEMA_REFS = Object.freeze({
  catalogRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.deadline.catalog-read.input',
    inputSchema: deadlineListReadInputSchema,
    resultKey: 'schema.deadline.catalog-read.operator-result',
    resultSchema: deadlineListReadResultSchema
  }),
  currentRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.deadline.current-read.input',
    inputSchema: deadlineGetReadInputSchema,
    resultKey: 'schema.deadline.current-read.operator-result',
    resultSchema: deadlineGetReadResultSchema
  }),
  change: createOperationSchemaManifestRefs({
    inputKey: 'schema.deadline.change.input',
    inputSchema: deadlineChangeInputSchema,
    resultKey: 'schema.deadline.change.operator-result',
    resultSchema: deadlineChangeOperationResultSchema
  })
});

export const deadlineChangedFactPayloadSchema = z.strictObject({
  action: z.enum(['create', 'update', 'clear']),
  deadlineId: deadlineIdSchema,
  version: deadlineVersionSchema,
  status: z.enum(['active', 'cleared']),
  displayDate: deadlineDisplayDateSchema.nullable(),
  effectiveAt: deadlineInstantSchema.nullable()
});

export type DeadlineScopeDto = z.infer<typeof deadlineScopeSchema>;
export type DeadlineHeadDto = z.infer<typeof deadlineHeadSchema>;
export type ActiveDeadlineHeadDto = z.infer<typeof activeDeadlineHeadSchema>;
export type ClearedDeadlineHeadDto = z.infer<typeof clearedDeadlineHeadSchema>;
export type DeadlineReferencePinDto = z.infer<typeof deadlineReferencePinSchema>;
export type DeadlineCatalogSnapshotDto = z.infer<typeof deadlineCatalogSnapshotSchema>;
export type DeadlineEventTimeBasisDto = z.infer<typeof deadlineEventTimeBasisSchema>;
/**
 * Author-facing planning input: `kind` may be omitted and defaults to
 * `cfp_close` at parse time. Parsed plans (`DeadlineMutationPlanDto.input`)
 * always carry the resolved kind.
 */
export type DeadlineMutationPlanningInput = z.input<typeof deadlineMutationPlanningInputSchema>;
export type DeadlineMutationPlanDto = z.infer<typeof deadlineMutationPlanSchema>;
export type DeadlineSafeDiff = z.infer<typeof deadlineSafeDiffSchema>;
export type DeadlineMutationResult = z.infer<typeof deadlineMutationResultSchema>;
export type DeadlineChangeInput = z.infer<typeof deadlineChangeInputSchema>;
export type DeadlineChangeData = z.infer<typeof deadlineChangeDataSchema>;
export type DeadlineChangedFactPayload = z.infer<typeof deadlineChangedFactPayloadSchema>;
