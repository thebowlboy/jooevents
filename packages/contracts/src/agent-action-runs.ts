import { z } from 'zod';

const canonicalUuid = z.uuid().refine((value) => value === value.toLowerCase());
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const boundedLabel = z.string().trim().min(1).max(160);
const subject = z.strictObject({ type: z.string().trim().min(1).max(80), id: canonicalUuid });

export const agentActionSourceSchema = z.strictObject({
  surface: z.enum(['external_mcp', 'app_model']),
  clientKey: z.string().trim().min(1).max(160),
  runId: z.string().trim().min(1).max(256).optional(),
  proposingPrincipalId: z.string().trim().min(1).max(256),
  continuingGrantKey: z.string().trim().min(1).max(256).optional()
});

export const agentActionScopeSchema = z.strictObject({
  workspaceId: canonicalUuid,
  eventId: canonicalUuid.optional(),
  subjects: z.array(subject).min(1).max(16)
});

export const agentActionBoundsSchema = z.strictObject({
  maximumActions: z.number().int().min(1).max(50),
  expiresAt: instant,
  allowedOperationIdentities: z.array(z.string().trim().min(3).max(180)).min(1).max(50),
  maximumSpendMinor: z.number().int().nonnegative().max(1_000_000_000).optional()
});

export const agentActionStepSchema = z.strictObject({
  id: canonicalUuid,
  ordinal: z.number().int().min(1).max(50),
  operationName: z.string().trim().min(1).max(160),
  operationVersion: z.number().int().positive(),
  contractDigestSha256: sha256,
  input: z.json(),
  requestHashSha256: sha256,
  guards: z.array(z.json()).max(32),
  subjects: z.array(subject).min(1).max(16),
  displayLabel: boundedLabel,
  consequences: z.array(z.string().trim().min(1).max(160)).max(16),
  externalEffect: z.enum(['none', 'reconcilable']).default('none')
});

export const agentActionPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batchId: canonicalUuid,
  source: agentActionSourceSchema,
  scope: agentActionScopeSchema,
  intent: z.string().trim().min(1).max(500),
  registryDigestSha256: sha256,
  bounds: agentActionBoundsSchema,
  steps: z.array(agentActionStepSchema).min(1).max(50),
  submittedAt: instant
});

export const agentActionBatchStatusSchema = z.enum([
  'awaiting_approval', 'rejected', 'queued', 'running', 'paused',
  'cancel_requested', 'cancelled', 'failed', 'succeeded'
]);
export const agentActionStepStatusSchema = z.enum([
  'pending', 'running', 'waiting_external', 'needs_attention', 'cancelled', 'succeeded'
]);

export const agentActionApprovalSchema = z.strictObject({
  approvedByPrincipalId: z.string().trim().min(1).max(256),
  planDigestSha256: sha256,
  approvedAt: instant,
  approvalExpiresAt: instant,
  approvalPolicy: z.strictObject({ key: z.string().trim().min(1).max(160), version: z.number().int().positive() }),
  approvedBounds: agentActionBoundsSchema
});

export const agentActionStepViewSchema = agentActionStepSchema.extend({
  status: agentActionStepStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lastSafeOutcome: z.json().nullable(),
  terminalLogId: canonicalUuid.nullable(),
  startedAt: instant.nullable(),
  completedAt: instant.nullable()
});

export const agentActionBatchViewSchema = z.strictObject({
  plan: agentActionPlanSchema,
  planDigestSha256: sha256,
  status: agentActionBatchStatusSchema,
  version: z.number().int().positive(),
  currentOrdinal: z.number().int().min(1).max(51),
  approval: agentActionApprovalSchema.nullable(),
  pauseRequested: z.boolean(),
  cancelRequested: z.boolean(),
  safeStatusDetail: z.json().nullable(),
  createdAt: instant,
  updatedAt: instant,
  steps: z.array(agentActionStepViewSchema).min(1).max(50)
});

export type AgentActionPlan = z.infer<typeof agentActionPlanSchema>;
export type AgentActionStep = z.infer<typeof agentActionStepSchema>;
export type AgentActionBounds = z.infer<typeof agentActionBoundsSchema>;
export type AgentActionApproval = z.infer<typeof agentActionApprovalSchema>;
export type AgentActionBatchStatus = z.infer<typeof agentActionBatchStatusSchema>;
export type AgentActionStepStatus = z.infer<typeof agentActionStepStatusSchema>;
export type AgentActionBatchView = z.infer<typeof agentActionBatchViewSchema>;
