import {
  canonicalJsonSha256,
  parseCapabilityRevisionId,
  parseContractVersion
} from '@jooevents/kernel';
import {
  definitionRef,
  parseDefinitionKey,
  schemaRef,
  sealReliabilityDefinition,
  type JobDefinition
} from '@jooevents/reliability';
import { z } from 'zod';
import { AIRTABLE_SYNC_REGISTERED_JOB, airtableSyncWakeSchema } from './wake-adapters';

export const airtableSyncJobResultSchema = z.strictObject({
  kind: z.enum(['completed', 'idle', 'contended', 'attention', 'retry']),
  retryAfterMs: z.number().int().positive().max(86_400_000).optional()
}).superRefine((value, context) => {
  if ((value.kind === 'retry') !== (value.retryAfterMs !== undefined)) {
    context.addIssue({ code: 'custom', message: 'airtable_sync_job_retry_shape_invalid' });
  }
});

export const airtableSyncJobErrorDetailSchema = z.strictObject({
  code: z.string().min(1).max(80),
  correlationId: z.string().min(8).max(160)
});

const schemaDigest = (schema: unknown) => canonicalJsonSha256(schema);

const schemas = Object.freeze({
  input: schemaRef('schema.airtable.sync-job-wake', 1, schemaDigest({
    type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'connectionId', 'reason', 'wakeId'],
    properties: {
      schemaVersion: { const: 1 },
      connectionId: { type: 'string', minLength: 1, maxLength: 160 },
      reason: { type: 'string' },
      wakeId: { type: 'string', minLength: 1, maxLength: 360 }
    }
  })),
  result: schemaRef('schema.airtable.sync-job-result', 1, schemaDigest({
    type: 'object', additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { enum: ['completed', 'idle', 'contended', 'attention', 'retry'] },
      retryAfterMs: { type: 'integer', minimum: 1, maximum: 86_400_000 }
    }
  })),
  error: schemaRef('schema.airtable.sync-job-error', 1, schemaDigest({
    type: 'object', additionalProperties: false,
    required: ['code', 'correlationId'],
    properties: {
      code: { type: 'string', minLength: 1, maxLength: 80 },
      correlationId: { type: 'string', minLength: 8, maxLength: 160 }
    }
  }))
});

/**
 * Exact reliability registration shared by hosted Queue and portable Bun wakes.
 * The wake carries no operation selector: the registered job binds the sole target
 * operation and its anchor-inspection-only external retry policy.
 */
export async function createAirtableSyncJobDefinition(): Promise<JobDefinition> {
  return sealReliabilityDefinition({
    kind: 'job',
    key: parseDefinitionKey(AIRTABLE_SYNC_REGISTERED_JOB.key),
    version: parseContractVersion(AIRTABLE_SYNC_REGISTERED_JOB.version),
    inputSchema: schemas.input,
    resultSchema: schemas.result,
    errorDetailSchema: schemas.error,
    source: definitionRef('source', 'airtable.sync-wake', 1),
    scopeCausation: definitionRef('scope_causation', 'airtable.connection-scope', 1),
    inputProjection: definitionRef('input_projection', 'airtable.sync-wake-to-operation', 1),
    targetOperation: definitionRef('operation', 'airtable.sync-connection-execute', 1),
    capabilityRevisionId: parseCapabilityRevisionId('018f0f64-4d6c-7b2f-8a1e-1234567890e0'),
    authorityCitation: definitionRef('authority_citation', 'airtable.sync-connection-authority', 1),
    leaseDurationMs: 30_000,
    maximumAttempts: 12,
    backoff: definitionRef('backoff', 'airtable.sync-bounded-backoff', 1),
    timeoutMs: 25_000,
    cancellation: definitionRef('cancellation', 'airtable.sync-connection-cancellation', 1),
    externalRetryPolicy: 'anchor_inspection_only'
  });
}

// Keep runtime parsers and the sealed schema references joined in one module.
export const airtableSyncRegisteredJobSchemas = Object.freeze({
  input: airtableSyncWakeSchema,
  result: airtableSyncJobResultSchema,
  errorDetail: airtableSyncJobErrorDetailSchema
});
