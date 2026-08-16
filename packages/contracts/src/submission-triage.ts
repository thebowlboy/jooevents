import { z } from 'zod';
import {
  intakeDigestSchema,
  intakeIdInputSchema,
  intakeIdSchema,
  intakeInstantSchema,
  intakeScopeSchema,
  intakeVersionSchema
} from './forms';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';
import {
  organizerSubmissionChoiceSchema,
  organizerSubmissionDetailSchema,
  organizerSubmissionSummarySchema
} from './submissions';

export const SUBMISSION_TRIAGE_BULK_MAX = 200;
export const SUBMISSION_TRIAGE_LIST_MAX = 500;
export const SUBMISSION_TRIAGE_SEARCH_MAX_LENGTH = 200;

const boundedPrincipalKeySchema = z.string().trim().min(1).max(512);
const boundedEvidenceIdSchema = z.string().trim().min(1).max(512);
const canonicalApplicationIdSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  { message: 'Application IDs must use canonical lowercase bytes.' }
);

function addCanonicalOrderIssues(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[],
  message: string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      context.addIssue({ code: 'custom', path: [...path, index], message });
    }
  }
}

export const submissionTriageStateSchema = z.enum([
  'inbox',
  'set_aside',
  'discarded_recoverable'
]);

export const submissionTriageVisibleTraySchema = z.enum([
  'inbox',
  'set_aside',
  'late',
  'discarded'
]);

export const submissionArrivalClassificationSchema = z.enum(['on_time', 'late']);

export const submissionTriageManualAttributionSchema = z.strictObject({
  kind: z.literal('manual'),
  principalKey: boundedPrincipalKeySchema,
  invocationId: canonicalApplicationIdSchema,
  surface: z.enum(['operator_http', 'external_mcp'])
});

export const submissionTriageRegisteredRunAttributionSchema = z.strictObject({
  kind: z.literal('registered_run'),
  runId: canonicalApplicationIdSchema,
  standingPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: intakeDigestSchema
  }),
  invocationEvidenceIds: z.array(boundedEvidenceIdSchema).min(1).max(32)
}).superRefine((value, context) => {
  addCanonicalOrderIssues(
    value.invocationEvidenceIds,
    context,
    ['invocationEvidenceIds'],
    'invocation evidence ids must be unique and use canonical code-unit order'
  );
});

export const submissionTriageAttributionSchema = z.discriminatedUnion('kind', [
  submissionTriageManualAttributionSchema,
  submissionTriageRegisteredRunAttributionSchema
]);

export const submissionArrivalCloseEvidenceSchema = z.strictObject({
  closeAt: intakeInstantSchema,
  policy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: intakeDigestSchema
  })
});

/**
 * Immutable evidence for how one submitted record related to the accepting close.
 * Triage transitions never update this record.
 */
export const submissionArrivalFactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  scope: intakeScopeSchema,
  submissionId: intakeIdSchema,
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  source: z.enum(['public_form', 'direct_entry', 'import', 'email']),
  submittedAt: intakeInstantSchema,
  classification: submissionArrivalClassificationSchema,
  closeEvidence: submissionArrivalCloseEvidenceSchema.nullable(),
  recordedAt: intakeInstantSchema
}).superRefine((fact, context) => {
  const closeAt = fact.closeEvidence?.closeAt;
  if (fact.classification === 'late' && closeAt === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['closeEvidence'],
      message: 'late arrival requires close evidence'
    });
  }
  if (closeAt !== undefined) {
    // Lateness measures a public-window arrival. Organizer-lane sources record
    // the accepting close as evidence but are never classified late.
    const shouldBeLate = fact.source === 'public_form'
      && Date.parse(fact.submittedAt) > Date.parse(closeAt);
    if (shouldBeLate !== (fact.classification === 'late')) {
      context.addIssue({
        code: 'custom',
        path: ['classification'],
        message: 'arrival classification must agree with the source and recorded close instant'
      });
    }
  }
});

export const submissionTriageHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: intakeScopeSchema,
  submissionId: intakeIdSchema,
  version: intakeVersionSchema,
  state: submissionTriageStateSchema,
  setAsideAttribution: submissionTriageAttributionSchema.nullable(),
  updatedAt: intakeInstantSchema
}).superRefine((head, context) => {
  const coherent = head.state === 'set_aside'
    ? head.setAsideAttribution !== null
    : head.setAsideAttribution === null;
  if (!coherent) {
    context.addIssue({
      code: 'custom',
      path: ['setAsideAttribution'],
      message: 'set-aside attribution must be present exactly while set aside'
    });
  }
});

export const submissionTriageQueryGuardSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: intakeScopeSchema,
  version: intakeVersionSchema,
  digestSha256: intakeDigestSchema
});

export const submissionTriageCategorySchema = z.strictObject({
  id: intakeIdSchema,
  label: z.string().trim().min(1).max(160)
});

/**
 * Least-disclosure source projection used by triage. Contact fields and raw
 * participant identifiers are intentionally absent.
 */
export const submissionTriageSourceRowSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: intakeScopeSchema,
  source: z.enum(['public_form', 'direct_entry', 'import', 'email']),
  summary: organizerSubmissionSummarySchema,
  detail: organizerSubmissionDetailSchema,
  abstract: z.string().max(20_000).nullable(),
  track: submissionTriageCategorySchema.nullable(),
  format: submissionTriageCategorySchema.nullable()
}).superRefine((row, context) => {
  if (row.summary.id !== row.detail.submissionId
      || row.summary.formId !== row.detail.formId
      || row.summary.formVersionId !== row.detail.formVersionId
      || row.summary.submittedAt !== row.detail.submittedAt) {
    context.addIssue({ code: 'custom', message: 'source summary and detail must describe one submission' });
  }
});

export const submissionTriageProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: submissionTriageSourceRowSchema,
  triage: submissionTriageHeadSchema,
  arrival: submissionArrivalFactSchema,
  visibleTray: submissionTriageVisibleTraySchema
}).superRefine((row, context) => {
  const scope = row.triage.scope;
  if (row.source.scope.workspaceId !== scope.workspaceId
      || row.source.scope.eventId !== scope.eventId
      || row.source.summary.id !== row.triage.submissionId
      || row.arrival.submissionId !== row.triage.submissionId
      || row.arrival.scope.workspaceId !== scope.workspaceId
      || row.arrival.scope.eventId !== scope.eventId
      || row.arrival.formId !== row.source.summary.formId
      || row.arrival.formVersionId !== row.source.summary.formVersionId
      || row.arrival.source !== row.source.source
      || row.arrival.submittedAt !== row.source.summary.submittedAt) {
    context.addIssue({ code: 'custom', message: 'triage projection evidence is cross-bound' });
  }
  const expected = row.triage.state === 'discarded_recoverable'
    ? 'discarded'
    : row.triage.state === 'set_aside'
      ? 'set_aside'
      : row.arrival.classification === 'late'
        ? 'late'
        : 'inbox';
  if (row.visibleTray !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['visibleTray'],
      message: 'visible tray must be derived from triage state and arrival evidence'
    });
  }
});

export const submissionTriageListInputSchema = z.strictObject({
  tray: submissionTriageVisibleTraySchema.optional(),
  trackId: intakeIdInputSchema.optional(),
  formatId: intakeIdInputSchema.optional(),
  search: z.string().trim().max(SUBMISSION_TRIAGE_SEARCH_MAX_LENGTH).optional()
});

export const submissionTriageReadInputSchema = z.strictObject({
  submissionId: intakeIdInputSchema
});

export const submissionTriageSearchOutcomeSchema = z.strictObject({
  query: z.string().max(SUBMISSION_TRIAGE_SEARCH_MAX_LENGTH),
  matched: z.number().int().nonnegative().safe(),
  scanned: z.number().int().nonnegative().safe()
});

export const submissionTriageTrayTotalsSchema = z.strictObject({
  inbox: z.number().int().nonnegative().safe(),
  set_aside: z.number().int().nonnegative().safe(),
  late: z.number().int().nonnegative().safe(),
  discarded: z.number().int().nonnegative().safe()
});

export const submissionTriageListSchema = z.strictObject({
  schemaVersion: z.literal(1),
  queryGuard: submissionTriageQueryGuardSchema,
  rows: z.array(submissionTriageProjectionSchema).max(SUBMISSION_TRIAGE_LIST_MAX),
  trayTotals: submissionTriageTrayTotalsSchema,
  search: submissionTriageSearchOutcomeSchema.nullable()
}).superRefine((page, context) => {
  const ids = page.rows.map((row) => row.source.summary.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['rows'], message: 'rows must be unique' });
  }
  const total = Object.values(page.trayTotals).reduce((sum, count) => sum + count, 0);
  if (total < page.rows.length) {
    context.addIssue({
      code: 'custom',
      path: ['trayTotals'],
      message: 'tray totals cannot be smaller than the returned page'
    });
  }
});

export const submissionTriageReadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  queryGuard: submissionTriageQueryGuardSchema,
  row: submissionTriageProjectionSchema
});

export const submissionTriageActionSchema = z.enum([
  'set_aside',
  'return_to_inbox',
  'discard_recoverable',
  'restore'
]);

export const submissionTriageExpectedHeadSchema = z.strictObject({
  submissionId: intakeIdInputSchema,
  version: intakeVersionSchema
});

export const submissionTriageTransitionInputSchema = z.strictObject({
  action: submissionTriageActionSchema,
  submissionIds: z.array(intakeIdInputSchema).min(1).max(SUBMISSION_TRIAGE_BULK_MAX),
  expectedHeads: z.array(submissionTriageExpectedHeadSchema).min(1).max(SUBMISSION_TRIAGE_BULK_MAX),
  expectedQueryGuard: z.strictObject({
    version: intakeVersionSchema,
    digestSha256: intakeDigestSchema
  })
}).superRefine((input, context) => {
  addCanonicalOrderIssues(
    input.submissionIds,
    context,
    ['submissionIds'],
    'submission ids must be unique and use canonical code-unit order'
  );
  addCanonicalOrderIssues(
    input.expectedHeads.map((head) => head.submissionId),
    context,
    ['expectedHeads'],
    'expected heads must be unique and use canonical code-unit order'
  );
  if (input.submissionIds.length !== input.expectedHeads.length
      || input.submissionIds.some((id, index) => id !== input.expectedHeads[index]?.submissionId)) {
    context.addIssue({
      code: 'custom',
      path: ['expectedHeads'],
      message: 'expected heads must match the selected submission ids exactly'
    });
  }
});

export const submissionTriageTransitionPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: submissionTriageActionSchema,
  scope: z.strictObject({ workspaceId: intakeIdSchema, eventId: intakeIdSchema }),
  attribution: submissionTriageAttributionSchema,
  queryGuard: z.strictObject({
    before: submissionTriageQueryGuardSchema,
    after: submissionTriageQueryGuardSchema
  }),
  transitions: z.array(z.strictObject({
    submissionId: intakeIdSchema,
    arrivalDigestSha256: intakeDigestSchema,
    arrivalClassification: submissionArrivalClassificationSchema,
    beforeVisibleTray: submissionTriageVisibleTraySchema,
    afterVisibleTray: submissionTriageVisibleTraySchema,
    before: submissionTriageHeadSchema,
    after: submissionTriageHeadSchema
  })).min(1).max(SUBMISSION_TRIAGE_BULK_MAX)
});

export const submissionTriageTransitionDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: submissionTriageActionSchema,
  queryGuard: submissionTriageQueryGuardSchema,
  submissionIds: z.array(intakeIdSchema).min(1).max(SUBMISSION_TRIAGE_BULK_MAX)
});

export const submissionTriageListCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: submissionTriageListSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const submissionTriageReadCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: submissionTriageReadSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const submissionTriageTransitionCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: submissionTriageTransitionDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const submissionTriageListOperationResultSchema =
  createReadOperationResultSchema(submissionTriageListSchema);
export const submissionTriageReadOperationResultSchema =
  createReadOperationResultSchema(submissionTriageReadSchema);
export const submissionTriageTransitionOperationResultSchema =
  createEffectfulOperationResultSchema(submissionTriageTransitionDataSchema);

export const SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS = Object.freeze({
  list: createOperationSchemaManifestRefs({
    inputKey: 'schema.submission.triage-list.input',
    inputSchema: submissionTriageListInputSchema,
    resultKey: 'schema.submission.triage-list.operator-result',
    resultSchema: submissionTriageListOperationResultSchema
  }),
  read: createOperationSchemaManifestRefs({
    inputKey: 'schema.submission.triage-read.input',
    inputSchema: submissionTriageReadInputSchema,
    resultKey: 'schema.submission.triage-read.operator-result',
    resultSchema: submissionTriageReadOperationResultSchema
  }),
  transition: createOperationSchemaManifestRefs({
    inputKey: 'schema.submission.triage-transition.input',
    inputSchema: submissionTriageTransitionInputSchema,
    resultKey: 'schema.submission.triage-transition.operator-result',
    resultSchema: submissionTriageTransitionOperationResultSchema
  })
});

export type SubmissionTriageState = z.infer<typeof submissionTriageStateSchema>;
export type SubmissionTriageVisibleTray = z.infer<typeof submissionTriageVisibleTraySchema>;
export type SubmissionArrivalClassification = z.infer<typeof submissionArrivalClassificationSchema>;
export type SubmissionTriageAttribution = z.infer<typeof submissionTriageAttributionSchema>;
export type SubmissionArrivalFactDto = z.infer<typeof submissionArrivalFactSchema>;
export type SubmissionTriageHeadDto = z.infer<typeof submissionTriageHeadSchema>;
export type SubmissionTriageQueryGuardDto = z.infer<typeof submissionTriageQueryGuardSchema>;
export type SubmissionTriageSourceRowDto = z.infer<typeof submissionTriageSourceRowSchema>;
export type SubmissionTriageProjectionDto = z.infer<typeof submissionTriageProjectionSchema>;
export type SubmissionTriageListInput = z.infer<typeof submissionTriageListInputSchema>;
export type SubmissionTriageListDto = z.infer<typeof submissionTriageListSchema>;
export type SubmissionTriageReadDto = z.infer<typeof submissionTriageReadSchema>;
export type SubmissionTriageAction = z.infer<typeof submissionTriageActionSchema>;
export type SubmissionTriageTransitionInput = z.infer<typeof submissionTriageTransitionInputSchema>;
export type SubmissionTriageTransitionPlanDto = z.infer<typeof submissionTriageTransitionPlanSchema>;
export type SubmissionTriageTransitionData = z.infer<typeof submissionTriageTransitionDataSchema>;
export type OrganizerSubmissionChoiceDto = z.infer<typeof organizerSubmissionChoiceSchema>;
