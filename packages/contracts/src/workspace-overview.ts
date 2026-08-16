import { OPERATION_SURFACES } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  definitionKeySchema,
  operationNameSchema,
  operationReceiptRefSchema,
  operationSurfaceSchema,
  structuredOutcomeSchema
} from './operations';
import { currentEventProjectionSchema } from './event';

export const WORKSPACE_OVERVIEW_AREAS = [
  'overview',
  'submissions',
  'review',
  'decisions',
  'speakers',
  'reviewers',
  'tasks',
  'schedule',
  'messages',
  'templates',
  'forms',
  'embeds',
  'settings'
] as const;

export const workspaceOverviewAreaSchema = z.enum(WORKSPACE_OVERVIEW_AREAS);
export const workspaceOverviewCapabilitySchema = definitionKeySchema;
export const workspaceOverviewUnavailableReasonSchema = z.enum([
  'event_required',
  'not_implemented',
  'not_composed',
  'dependency_unavailable'
]);

function isLexicographicallyCanonical(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

const safeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const capabilityListSchema = z.array(workspaceOverviewCapabilitySchema).max(100)
  .refine(
    isLexicographicallyCanonical,
    'Capabilities must be unique and lexicographically ordered.'
  );

export const workspaceOverviewAreaAvailabilitySchema = z.discriminatedUnion('status', [
  z.strictObject({
    area: workspaceOverviewAreaSchema,
    status: z.literal('available'),
    capabilities: capabilityListSchema.min(1)
  }),
  z.strictObject({
    area: workspaceOverviewAreaSchema,
    status: z.literal('partial'),
    availableCapabilities: capabilityListSchema.min(1),
    unavailableCapabilities: capabilityListSchema.min(1)
  }).refine(
    (value) => value.availableCapabilities.every(
      (capability) => !value.unavailableCapabilities.includes(capability)
    ),
    'Available and unavailable capabilities must not overlap.'
  ),
  z.strictObject({
    area: workspaceOverviewAreaSchema,
    status: z.literal('locked'),
    reason: z.literal('event_required')
  }),
  z.strictObject({
    area: workspaceOverviewAreaSchema,
    status: z.literal('unavailable'),
    reason: workspaceOverviewUnavailableReasonSchema.exclude(['event_required'])
  })
]);

export const workspaceOverviewAreaCatalogSchema = z.array(workspaceOverviewAreaAvailabilitySchema)
  .length(WORKSPACE_OVERVIEW_AREAS.length)
  .superRefine((catalog, context) => {
    WORKSPACE_OVERVIEW_AREAS.forEach((area, index) => {
      if (catalog[index]?.area !== area) {
        context.addIssue({
          code: 'custom',
          message: `Area catalog must contain ${area} at its canonical position.`,
          path: [index, 'area']
        });
      }
    });
  });

const unavailableMetricSchema = z.strictObject({
  kind: z.literal('unavailable'),
  reason: workspaceOverviewUnavailableReasonSchema
});

export const workspaceOverviewFormsMetricSchema = z.union([
  z.strictObject({
    kind: z.literal('exact'),
    total: safeCountSchema,
    draft: safeCountSchema,
    open: safeCountSchema,
    closed: safeCountSchema
  }).refine((value) => value.total === value.draft + value.open + value.closed, {
    message: 'Form status counts must equal the total.'
  }),
  unavailableMetricSchema
]);

export const workspaceOverviewSubmissionsMetricSchema = z.union([
  z.strictObject({ kind: z.literal('exact'), total: safeCountSchema }),
  unavailableMetricSchema
]);

const activeRetiredTotalSchema = z.strictObject({
  total: safeCountSchema,
  active: safeCountSchema,
  retired: safeCountSchema
}).refine((value) => value.total === value.active + value.retired, {
  message: 'Active and retired counts must equal the total.'
});

export const workspaceOverviewProgramVocabularyMetricSchema = z.union([
  z.strictObject({
    kind: z.literal('exact'),
    rooms: activeRetiredTotalSchema,
    tracks: activeRetiredTotalSchema,
    formats: activeRetiredTotalSchema
  }),
  unavailableMetricSchema
]);

export const workspaceOverviewOperationsMetricSchema = z.union([
  z.strictObject({ kind: z.literal('exact'), total: safeCountSchema }),
  unavailableMetricSchema
]);

export const workspaceOverviewMetricsSchema = z.strictObject({
  forms: workspaceOverviewFormsMetricSchema,
  submissions: workspaceOverviewSubmissionsMetricSchema,
  programVocabulary: workspaceOverviewProgramVocabularyMetricSchema,
  operations: workspaceOverviewOperationsMetricSchema
});

export const workspaceOverviewHistoryDomainSchema = z.enum([
  'event',
  'field_registry',
  'forms',
  'program_vocabulary',
  'submission_triage',
  'workspace_team'
]);
export const workspaceOverviewHistoryActorSchema = z.enum([
  'person',
  'agent',
  'participant',
  'system',
  'integration'
]);

const uniqueActorsSchema = z.array(workspaceOverviewHistoryActorSchema)
  .max(5)
  .refine(
    (values) => values.every((value, index) => index === 0
      || workspaceOverviewHistoryActorSchema.options.indexOf(values[index - 1]!)
        < workspaceOverviewHistoryActorSchema.options.indexOf(value)),
    'Actors must be unique and canonically ordered.'
  );
const uniqueSurfacesSchema = z.array(operationSurfaceSchema)
  .max(8)
  .refine(
    (values) => values.every((value, index) => index === 0
      || OPERATION_SURFACES.indexOf(values[index - 1]!) < OPERATION_SURFACES.indexOf(value)),
    'Surfaces must be unique and canonically ordered.'
  );

export const workspaceOverviewHistoryRootSchema = z.strictObject({
  kind: z.literal('operation'),
  receiptId: z.uuid()
});

export const workspaceOverviewHistoryOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success') }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const workspaceOverviewHistoryThreadSchema = z.strictObject({
  id: z.string().regex(/^operation:[0-9a-f-]{36}$/),
  domain: workspaceOverviewHistoryDomainSchema,
  root: workspaceOverviewHistoryRootSchema,
  firstOccurredAt: z.iso.datetime({ offset: true }),
  lastOccurredAt: z.iso.datetime({ offset: true }),
  actors: uniqueActorsSchema,
  surfaces: uniqueSurfacesSchema.min(1),
  latestOperation: z.strictObject({
    name: operationNameSchema,
    version: z.number().int().positive()
  }),
  latestReceipt: operationReceiptRefSchema,
  latestOutcome: workspaceOverviewHistoryOutcomeSchema,
  evidence: z.strictObject({
    timelineEntries: safeCountSchema.min(1),
    receipts: safeCountSchema.min(1)
  })
}).superRefine((thread, context) => {
  const expectedId = `operation:${thread.root.receiptId}`;
  if (thread.id !== expectedId) {
    context.addIssue({ code: 'custom', message: 'History ID must identify its causal root.', path: ['id'] });
  }
  if (Date.parse(thread.firstOccurredAt) > Date.parse(thread.lastOccurredAt)) {
    context.addIssue({ code: 'custom', message: 'History interval is reversed.', path: ['lastOccurredAt'] });
  }
  if (
    thread.latestReceipt.operationName !== thread.latestOperation.name
    || thread.latestReceipt.operationVersion !== thread.latestOperation.version
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Latest receipt must identify the latest operation.',
      path: ['latestReceipt']
    });
  }
});

export const workspaceOverviewHistorySchema = z.strictObject({
  total: safeCountSchema,
  truncated: z.boolean(),
  threads: z.array(workspaceOverviewHistoryThreadSchema).max(50)
}).superRefine((history, context) => {
  if (history.total < history.threads.length) {
    context.addIssue({ code: 'custom', message: 'History total cannot be smaller than the page.' });
  }
  if (history.truncated !== (history.total > history.threads.length)) {
    context.addIssue({ code: 'custom', message: 'History truncation flag does not match its total.' });
  }
  history.threads.forEach((thread, index) => {
    const previous = history.threads[index - 1];
    if (!previous) return;
    if (
      Date.parse(previous.lastOccurredAt) < Date.parse(thread.lastOccurredAt)
      || (
        Date.parse(previous.lastOccurredAt) === Date.parse(thread.lastOccurredAt)
        && previous.id > thread.id
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'History threads must be newest first with a canonical ID tie-break.',
        path: ['threads', index]
      });
    }
  });
});

export const workspaceOverviewProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  event: currentEventProjectionSchema,
  areas: workspaceOverviewAreaCatalogSchema,
  metrics: workspaceOverviewMetricsSchema,
  history: workspaceOverviewHistorySchema
});

/** Current workspace and authority are resolved from verified invocation evidence. */
export const workspaceOverviewReadInputSchema = z.strictObject({});

export const workspaceOverviewCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: workspaceOverviewProjectionSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const workspaceOverviewReadResultSchema =
  createReadOperationResultSchema(workspaceOverviewProjectionSchema);

export const WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS = Object.freeze({
  read: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace.overview.read.input',
    inputSchema: workspaceOverviewReadInputSchema,
    resultKey: 'schema.workspace.overview.read.operator-result',
    resultSchema: workspaceOverviewReadResultSchema
  })
});

export type WorkspaceOverviewArea = z.infer<typeof workspaceOverviewAreaSchema>;
export type WorkspaceOverviewAreaAvailability = z.infer<
  typeof workspaceOverviewAreaAvailabilitySchema
>;
export type WorkspaceOverviewAreaCatalog = z.infer<typeof workspaceOverviewAreaCatalogSchema>;
export type WorkspaceOverviewHistoryDomain = z.infer<
  typeof workspaceOverviewHistoryDomainSchema
>;
export type WorkspaceOverviewHistoryActor = z.infer<
  typeof workspaceOverviewHistoryActorSchema
>;
export type WorkspaceOverviewHistoryThread = z.infer<
  typeof workspaceOverviewHistoryThreadSchema
>;
export type WorkspaceOverviewProjection = z.infer<typeof workspaceOverviewProjectionSchema>;
export type WorkspaceOverviewReadInput = z.infer<typeof workspaceOverviewReadInputSchema>;
export type WorkspaceOverviewCanonicalResult = z.infer<
  typeof workspaceOverviewCanonicalResultSchema
>;
export type WorkspaceOverviewReadResult = z.infer<typeof workspaceOverviewReadResultSchema>;
