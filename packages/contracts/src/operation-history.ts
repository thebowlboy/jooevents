import { isApplicationId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  operationSurfaceSchema,
  structuredOutcomeSchema
} from './operations';

const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Expected a canonical lowercase UUIDv4 or UUIDv7 application ID.'
});
const contractVersionSchema = z.number().int().positive().safe();

export const operationHistoryActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workspace_user'), userId: applicationIdSchema }),
  z.strictObject({
    kind: z.literal('participant'),
    participantIdentityId: applicationIdSchema,
    personId: applicationIdSchema
  }),
  z.strictObject({ kind: z.literal('service'), serviceIdentityId: applicationIdSchema }),
  z.strictObject({
    kind: z.literal('external_mcp_client'),
    clientKey: z.string().min(1).max(255),
    authorityPrincipalId: z.string().min(1).max(255)
  }),
  z.strictObject({
    kind: z.literal('app_model_run'),
    agentRunId: applicationIdSchema,
    delegatedByPrincipalId: z.string().min(1).max(255)
  }),
  z.strictObject({
    kind: z.literal('system_job'),
    jobId: applicationIdSchema,
    registeredCapabilityRevisionId: applicationIdSchema
  }),
  z.strictObject({
    kind: z.literal('system_consumer_delivery'),
    consumerDeliveryId: applicationIdSchema,
    consumerAttemptId: applicationIdSchema,
    consumerKey: z.string().min(1).max(160),
    consumerVersion: contractVersionSchema
  }),
  z.strictObject({
    kind: z.literal('system_scheduler'),
    schedulerKey: z.string().min(1).max(160),
    schedulerVersion: contractVersionSchema,
    registeredCapabilityRevisionId: applicationIdSchema
  }),
  z.strictObject({
    kind: z.literal('verified_ingress_intake'),
    verifiedEnvelopeHandleId: applicationIdSchema,
    sourceConnectionId: applicationIdSchema,
    sourceConnectionRevisionId: applicationIdSchema,
    verifierContractKey: z.string().min(1).max(160),
    verifierContractVersion: contractVersionSchema,
    verifierRevisionId: applicationIdSchema
  }),
  z.strictObject({
    kind: z.literal('verified_inbox_processing'),
    inboxReceiptId: applicationIdSchema,
    sourceConnectionId: applicationIdSchema
  }),
  z.strictObject({
    kind: z.literal('public_request'),
    publicPolicyRevisionId: applicationIdSchema,
    authority: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('open_policy') }),
      z.strictObject({
        kind: z.literal('mutation_ceremony'),
        ceremonyEvidenceId: applicationIdSchema
      })
    ])
  })
]);

export const operationHistorySubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workspace'), id: applicationIdSchema }),
  z.strictObject({ kind: z.literal('event'), id: applicationIdSchema }),
  z.strictObject({ kind: z.literal('workspace_user'), id: applicationIdSchema }),
  z.strictObject({ kind: z.literal('participant_person'), id: applicationIdSchema }),
  z.strictObject({
    kind: z.literal('domain'),
    domain: z.string().min(1).max(160),
    entity: z.string().min(1).max(160),
    id: z.string().min(1).max(255),
    version: z.number().int().positive().safe().optional()
  })
]);

export const operationHistoryCursorSchema = z.strictObject({
  occurredAt: z.iso.datetime({ offset: true }),
  id: applicationIdSchema
});

export const operationHistoryListInputSchema = z.strictObject({
  view: z.enum(['workspace', 'event']),
  limit: z.number().int().min(1).max(100).default(50),
  beforeOccurredAt: z.iso.datetime({ offset: true }).optional(),
  beforeId: applicationIdSchema.optional()
}).superRefine((input, context) => {
  if ((input.beforeOccurredAt === undefined) !== (input.beforeId === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'History cursor time and ID must be supplied together.'
    });
  }
});

export const operationHistoryEntrySchema = z.strictObject({
  id: applicationIdSchema,
  operation: z.strictObject({
    name: z.string().min(1).max(160),
    version: contractVersionSchema
  }),
  scope: z.strictObject({
    workspaceId: applicationIdSchema,
    eventId: applicationIdSchema.optional()
  }),
  surface: operationSurfaceSchema,
  actor: operationHistoryActorSchema,
  subjects: z.array(operationHistorySubjectSchema).min(1).max(16),
  summary: z.string().min(1).max(240),
  occurredAt: z.iso.datetime({ offset: true }),
  correlationId: z.uuid(),
  resultKind: z.enum(['success', 'outcome'])
});

export const operationHistoryPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.enum(['workspace', 'event']),
  entries: z.array(operationHistoryEntrySchema).max(100),
  next: operationHistoryCursorSchema.optional()
});

export const operationHistoryCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: operationHistoryPageSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const operationHistoryListResultSchema =
  createReadOperationResultSchema(operationHistoryPageSchema);

export const OPERATION_HISTORY_SCHEMA_REFS = Object.freeze({
  list: createOperationSchemaManifestRefs({
    inputKey: 'schema.operation.history.list.input',
    inputSchema: operationHistoryListInputSchema,
    resultKey: 'schema.operation.history.list.result',
    resultSchema: operationHistoryListResultSchema
  })
});

export type OperationHistoryActor = z.infer<typeof operationHistoryActorSchema>;
export type OperationHistorySubject = z.infer<typeof operationHistorySubjectSchema>;
export type OperationHistoryListInput = z.infer<typeof operationHistoryListInputSchema>;
export type OperationHistoryEntry = z.infer<typeof operationHistoryEntrySchema>;
export type OperationHistoryPage = z.infer<typeof operationHistoryPageSchema>;
