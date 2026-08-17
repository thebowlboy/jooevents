import { z } from 'zod';
import { agentActionBatchStatusSchema, agentActionBatchViewSchema } from './agent-action-runs';
import { structuredOutcomeSchema } from './operations';

const instantSchema = z.iso.datetime({ offset: true });
const correlationIdSchema = z.uuid();
const permissionIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(120);

export const externalAgentGuidanceKeySchema = z.enum([
  'read_routine',
  'read_sensitive',
  'plan_routine_none',
  'plan_consequential_reconcilable'
]);

export const externalAgentGuidanceSchema = z.strictObject({
  key: externalAgentGuidanceKeySchema,
  message: z.string().trim().min(1).max(500)
});

export const externalAgentAvailabilitySchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('active') }),
  z.strictObject({
    state: z.literal('locked_scope'),
    permissionIds: z.array(permissionIdSchema).min(1),
    note: z.string().trim().min(1).max(500),
    humanDoor: z.literal('/app/settings/api-keys')
  }),
  z.strictObject({
    state: z.literal('locked_owner'),
    permissionIds: z.array(permissionIdSchema).min(1),
    note: z.string().trim().min(1).max(500)
  }),
  z.strictObject({
    state: z.literal('locked_workspace'),
    conditionCode: z.string().regex(/^[a-z][a-z0-9_]*$/),
    condition: z.string().trim().min(1).max(500),
    watch: z.strictObject({ tool: z.string().min(1) }),
    humanDoor: z.string().startsWith('/app/')
  }),
  z.strictObject({
    state: z.literal('upcoming'),
    expected: z.union([
      z.strictObject({ path: z.string().startsWith('/') }),
      z.strictObject({ tool: z.string().min(1) })
    ]),
    interim: z.union([
      z.strictObject({ path: z.string().startsWith('/') }),
      z.strictObject({ tool: z.string().min(1) })
    ]),
    note: z.string().trim().min(1).max(500)
  })
]);

export const externalAgentUpcomingSchema = z.strictObject({
  kind: z.enum(['transport', 'capability']),
  availability: externalAgentAvailabilitySchema.refine((value) => value.state === 'upcoming')
});

export const externalAgentWarningSchema = z.discriminatedUnion('code', [
  z.strictObject({
    code: z.literal('key_expires_soon'),
    expiresAt: instantSchema,
    note: z.string().trim().min(1)
  }),
  z.strictObject({
    code: z.literal('scopes_dormant'),
    permissionIds: z.array(permissionIdSchema).min(1),
    note: z.string().trim().min(1)
  })
]);

export const externalAgentMeResponseSchema = z.strictObject({
  workspace: z.strictObject({ id: z.string().min(1) }),
  owner: z.strictObject({ id: z.string().min(1), displayName: z.string().min(1) }),
  capabilities: z.strictObject({ read: z.boolean(), submitPlans: z.boolean() }),
  permissionScopes: z.array(permissionIdSchema),
  eventScopes: z.array(z.string().min(1)),
  expiresAt: instantSchema.nullable(),
  createdAt: instantSchema,
  rateLimitClass: z.literal('standard'),
  standing: z.strictObject({
    serverTime: instantSchema,
    key: z.strictObject({ expiresAt: instantSchema.nullable(), expiresSoon: z.boolean() }),
    warnings: z.array(externalAgentWarningSchema),
    limits: z.strictObject({
      requestsPerMinute: z.number().int().positive(),
      burstPerTenSeconds: z.number().int().positive(),
      maximumConcurrency: z.number().int().positive(),
      planSubmissionsPerDay: z.number().int().positive(),
      maximumOpenPlans: z.number().int().positive()
    }),
    pending: z.strictObject({
      awaitingApproval: z.number().int().nonnegative().optional(),
      needsAttention: z.number().int().nonnegative().optional(),
      hint: z.literal('/api/v1/pending')
    }),
    conduct: z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)])
  }),
  correlationId: correlationIdSchema
});

export const externalAgentPendingPlanSchema = z.strictObject({
  batchId: z.string().min(1),
  status: agentActionBatchStatusSchema,
  ageSeconds: z.number().int().nonnegative(),
  progress: z.strictObject({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  reviewUrl: z.string().min(1),
  currentStep: z.strictObject({
    ordinal: z.number().int().positive(),
    status: z.string().min(1),
    lastSafeOutcome: z.unknown().optional()
  }).optional(),
  note: z.string().min(1).optional()
});

export const externalAgentAttentionSchema = z.strictObject({
  area: z.literal('communications'),
  summary: z.string().trim().min(1),
  counts: z.strictObject({
    draftsAwaitingSend: z.number().int().nonnegative(),
    batchesInFlight: z.number().int().nonnegative()
  }),
  tools: z.tuple([z.literal('list_message_drafts'), z.literal('get_delivery_history')]),
  humanDoor: z.literal('/app/messages')
});

export const externalAgentPendingResponseSchema = z.strictObject({
  plans: z.array(externalAgentPendingPlanSchema).optional(),
  attention: z.array(externalAgentAttentionSchema),
  correlationId: correlationIdSchema
});

const toolContractSchema = z.strictObject({
  operation: z.strictObject({ name: z.string().min(1), version: z.number().int().positive() }),
  effect: z.literal('read'),
  maxRisk: z.enum(['low', 'normal', 'consequential']),
  autonomy: z.unknown(),
  consequenceTags: z.array(z.string()),
  lifecycle: z.unknown(),
  idempotency: z.unknown()
});

export const externalAgentToolCatalogEntrySchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  annotations: z.unknown(),
  contract: toolContractSchema,
  inputJsonSchema: z.unknown(),
  resultJsonSchema: z.unknown(),
  availability: externalAgentAvailabilitySchema,
  guidance: externalAgentGuidanceSchema
});

export const externalAgentUnavailableToolSchema = z.strictObject({
  name: z.string().min(1),
  operation: z.strictObject({ name: z.string().min(1), version: z.number().int().positive() }),
  availability: externalAgentAvailabilitySchema
});

export const externalAgentToolsResponseSchema = z.strictObject({
  registryDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tools: z.array(externalAgentToolCatalogEntrySchema),
  unavailableTools: z.array(externalAgentUnavailableToolSchema),
  upcoming: z.array(externalAgentUpcomingSchema),
  correlationId: correlationIdSchema
});

export const externalAgentPlanOperationSchema = z.strictObject({
  name: z.string().min(1),
  version: z.number().int().positive(),
  contractDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  inputSchema: z.unknown(),
  displayLabel: z.string().min(1),
  consequences: z.array(z.string().min(1)),
  externalEffect: z.enum(['none', 'reconcilable']),
  availability: externalAgentAvailabilitySchema,
  guidance: externalAgentGuidanceSchema
});

export const externalAgentPlanOperationsResponseSchema = z.strictObject({
  registryDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  operations: z.array(externalAgentPlanOperationSchema),
  correlationId: correlationIdSchema
});

export const externalAgentPlanPageResponseSchema = z.strictObject({
  items: z.array(agentActionBatchViewSchema),
  nextCursor: z.string().nullable(),
  correlationId: correlationIdSchema
});

export const externalAgentPlanSubmitResponseSchema = z.strictObject({
  plan: agentActionBatchViewSchema,
  reviewUrl: z.string().min(1),
  correlationId: correlationIdSchema
});

export const externalAgentPlanInspectResponseSchema = z.strictObject({
  plan: agentActionBatchViewSchema,
  reviewUrl: z.string().min(1),
  correlationId: correlationIdSchema
});

export const externalAgentPlanCancelResponseSchema = z.strictObject({
  plan: agentActionBatchViewSchema,
  message: z.string().min(1),
  correlationId: correlationIdSchema
});

export const externalAgentOutcomeResponseSchema = z.strictObject({
  kind: z.literal('outcome'),
  outcome: structuredOutcomeSchema,
  correlationId: correlationIdSchema
});

export const externalAgentTransportErrorResponseSchema = z.strictObject({
  kind: z.literal('transport_error'),
  code: z.enum(['invalid_request', 'unauthenticated', 'forbidden', 'rate_limited', 'internal_error']),
  retryable: z.boolean(),
  correlationId: correlationIdSchema
});

export const externalAgentToolResultResponseSchema = z.union([
  z.strictObject({ kind: z.literal('success'), data: z.unknown(), correlationId: correlationIdSchema }),
  externalAgentOutcomeResponseSchema
]);

export type ExternalAgentAvailability = z.infer<typeof externalAgentAvailabilitySchema>;
export type ExternalAgentGuidance = z.infer<typeof externalAgentGuidanceSchema>;
export type ExternalAgentPendingAttention = z.infer<typeof externalAgentAttentionSchema>;
export type ExternalAgentPendingPlan = z.infer<typeof externalAgentPendingPlanSchema>;
