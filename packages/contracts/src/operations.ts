import { encodeCanonicalJson, OPERATION_SURFACES, type OperationSurface } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const httpPathPattern = /^\/api\/(?:[A-Za-z0-9._~-]+\/?)*$/;
const httpIdempotencyKeyPattern = /^[\x21-\x2b\x2d-\x7e]+$/;

function isCanonicalHttpPath(path: string): boolean {
  const segments = path.split('/').slice(2).filter((segment) => segment.length > 0);
  return segments.length > 0
    && segments.every((segment) => segment !== '.' && segment !== '..')
    && new URL(path, 'https://jooevents.invalid').pathname === path;
}

export const operationNameSchema = z.string().trim().min(1).max(160).regex(stableKeyPattern);
export const definitionKeySchema = z.string().trim().min(1).max(160).regex(stableKeyPattern);
export const operationVersionSchema = z.number().int().positive();
export const correlationIdSchema = z.uuid();

/**
 * One bounded wire contract for effectful HTTP requests. Commas are excluded so
 * duplicate header values cannot be mistaken for one credential after joining.
 */
export const operationHttpIdempotencyKeySchema = z.string()
  .min(1)
  .max(256)
  .regex(httpIdempotencyKeyPattern);

export const versionedDefinitionRefSchema = z.strictObject({
  key: definitionKeySchema,
  version: operationVersionSchema
});

export const safeSchemaManifestRefSchema = versionedDefinitionRefSchema.extend({
  digestSha256: z.string().regex(sha256Pattern)
});

/**
 * Builds the disclosure-safe identity for one Zod schema without a Node-only
 * crypto dependency, so registries and browser clients can share exact refs.
 */
export function createSafeSchemaManifestRef(
  key: string,
  schema: z.ZodType,
  version = 1
): Readonly<z.infer<typeof safeSchemaManifestRefSchema>> {
  const jsonSchema = JSON.parse(JSON.stringify(
    z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' })
  )) as unknown;
  return Object.freeze(safeSchemaManifestRefSchema.parse({
    key,
    version,
    digestSha256: bytesToHex(sha256(encodeCanonicalJson(jsonSchema)))
  }));
}

export interface OperationSchemaManifestRefs {
  readonly inputSchema: Readonly<z.infer<typeof safeSchemaManifestRefSchema>>;
  readonly resultSchema: Readonly<z.infer<typeof safeSchemaManifestRefSchema>>;
}

/** Defines the two schema identities a browser must match before invoking a binding. */
export function createOperationSchemaManifestRefs(input: {
  readonly inputKey: string;
  readonly inputSchema: z.ZodType;
  readonly resultKey: string;
  readonly resultSchema: z.ZodType;
  readonly version?: number;
}): Readonly<OperationSchemaManifestRefs> {
  return Object.freeze({
    inputSchema: createSafeSchemaManifestRef(
      input.inputKey,
      input.inputSchema,
      input.version ?? 1
    ),
    resultSchema: createSafeSchemaManifestRef(
      input.resultKey,
      input.resultSchema,
      input.version ?? 1
    )
  });
}

export const operationEffectSchema = z.enum(['read', 'draft', 'commit']);
export const operationRiskSchema = z.enum(['low', 'normal', 'consequential']);
export const operationSurfaceSchema = z.enum(OPERATION_SURFACES);

export const AUTONOMY_DISPOSITIONS = [
  'proceed',
  'safe_retry',
  'reconcile',
  'renewed_approval',
  'replan',
  'compensate',
  'block',
  'attention'
] as const;

export const AUTONOMY_TRIGGERS = [
  'authority_lost',
  'unattended_bounds_exceeded',
  'approval_required',
  'known_retryable_failure',
  'ambiguous_external_effect',
  'stale_plan',
  'compensation_required',
  'terminal_failure'
] as const;

export const autonomyDispositionSchema = z.enum(AUTONOMY_DISPOSITIONS);
export const autonomyTriggerSchema = z.enum(AUTONOMY_TRIGGERS);

/** Disclosure-reviewed policy metadata generated from the executable operation registry. */
export const safeOperationAutonomySchema = z.strictObject({
  policy: versionedDefinitionRefSchema,
  riskFloor: operationRiskSchema,
  unattendedRiskCeiling: operationRiskSchema,
  requiresSeparateApproval: z.boolean(),
  supportedDispositions: z.array(autonomyDispositionSchema).min(1).max(AUTONOMY_DISPOSITIONS.length),
  triggerDispositions: z.strictObject({
    authority_lost: autonomyDispositionSchema.exclude(['proceed']),
    unattended_bounds_exceeded: autonomyDispositionSchema.exclude(['proceed']),
    approval_required: autonomyDispositionSchema.exclude(['proceed']),
    known_retryable_failure: autonomyDispositionSchema.exclude(['proceed']),
    ambiguous_external_effect: autonomyDispositionSchema.exclude(['proceed']),
    stale_plan: autonomyDispositionSchema.exclude(['proceed']),
    compensation_required: autonomyDispositionSchema.exclude(['proceed']),
    terminal_failure: autonomyDispositionSchema.exclude(['proceed'])
  })
});

export const structuredOutcomeClassSchema = z.enum([
  'conflict',
  'access_denied',
  'stale_revision',
  'idempotency_conflict',
  'quota_exceeded',
  'policy_violation',
  'provider_not_ready',
  'provider_failure'
]);

export const outcomeSubjectSchema = z.strictObject({
  type: definitionKeySchema,
  id: z.string().trim().min(1).max(256),
  version: z.number().int().nonnegative().optional()
});

export const structuredOutcomeSchema = z.strictObject({
  class: structuredOutcomeClassSchema,
  kind: definitionKeySchema,
  retryable: z.boolean(),
  subjects: z.array(outcomeSubjectSchema).max(100),
  detail: z.json(),
  detailSchemaVersion: operationVersionSchema
});

export const operationReceiptRefSchema = z.strictObject({
  id: z.uuid(),
  operationName: operationNameSchema,
  operationVersion: operationVersionSchema
});

const readOutcomeResultSchema = z.strictObject({
  kind: z.literal('outcome'),
  outcome: structuredOutcomeSchema,
  correlationId: correlationIdSchema
});

export function createReadOperationResultSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('success'),
      data: dataSchema,
      correlationId: correlationIdSchema
    }),
    readOutcomeResultSchema
  ]);
}

export function createEffectfulOperationResultSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z.union([
    z.strictObject({
      kind: z.literal('success'),
      data: dataSchema,
      receipt: operationReceiptRefSchema,
      correlationId: correlationIdSchema
    }),
    z.strictObject({
      kind: z.literal('outcome'),
      outcome: structuredOutcomeSchema,
      terminal: z.literal(true),
      receipt: operationReceiptRefSchema,
      correlationId: correlationIdSchema
    }),
    z.strictObject({
      kind: z.literal('outcome'),
      outcome: structuredOutcomeSchema,
      terminal: z.literal(false),
      correlationId: correlationIdSchema
    })
  ]);
}

export const readOperationResultSchema = createReadOperationResultSchema(z.json());
export const effectfulOperationResultSchema = createEffectfulOperationResultSchema(z.json());
export const operationResultSchema = z.union([readOperationResultSchema, effectfulOperationResultSchema]);

export const operationTransportErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'internal_error'
]);

export const operationTransportErrorSchema = z.strictObject({
  kind: z.literal('transport_error'),
  code: operationTransportErrorCodeSchema,
  retryable: z.boolean(),
  correlationId: correlationIdSchema
});

export const operationLifecycleSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('active') }),
  z.strictObject({
    status: z.literal('deprecated'),
    sunsetAt: z.iso.datetime({ offset: true }),
    replacement: z.strictObject({
      operationName: operationNameSchema,
      operationVersion: operationVersionSchema
    })
  }),
  z.strictObject({ status: z.literal('replay_only') })
]);

export const operationOutcomeDeclarationSchema = z.strictObject({
  class: structuredOutcomeClassSchema,
  kind: definitionKeySchema,
  retryable: z.boolean(),
  detailSchema: safeSchemaManifestRefSchema
});

export const browserResumptionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('safe_inline'),
    inputSchema: safeSchemaManifestRefSchema,
    maximumCanonicalBytes: z.number().int().positive()
  }),
  z.strictObject({
    kind: z.literal('server_ref'),
    referenceSchema: safeSchemaManifestRefSchema,
    requestCodec: versionedDefinitionRefSchema,
    maximumReferenceBytes: z.number().int().positive()
  })
]);

const httpBindingFields = {
  protocol: z.literal('http'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(6).max(512).regex(httpPathPattern).refine(isCanonicalHttpPath),
  input: z.enum(['query', 'body']),
  resultSchema: safeSchemaManifestRefSchema,
  browserResumption: browserResumptionSchema
} as const;

const toolBindingFields = {
  protocol: z.literal('tool'),
  toolName: definitionKeySchema,
  resultSchema: safeSchemaManifestRefSchema
} as const;

export const safePublicOperationBindingSchema = z.discriminatedUnion('surface', [
  z.strictObject({ surface: z.literal('operator_http'), ...httpBindingFields }),
  z.strictObject({ surface: z.literal('participant_http'), ...httpBindingFields }),
  z.strictObject({ surface: z.literal('public_http'), ...httpBindingFields }),
  z.strictObject({ surface: z.literal('external_mcp'), ...toolBindingFields }),
  z.strictObject({ surface: z.literal('app_model'), ...toolBindingFields })
]);

export const safeOperationManifestEntrySchema = z.strictObject({
  name: operationNameSchema,
  version: operationVersionSchema,
  lifecycle: operationLifecycleSchema,
  summary: z.string().trim().min(1).max(500),
  effect: operationEffectSchema,
  maxRisk: operationRiskSchema,
  autonomy: safeOperationAutonomySchema,
  consequenceTags: z.array(definitionKeySchema).max(50),
  inputSchema: safeSchemaManifestRefSchema,
  idempotency: z.discriminatedUnion('required', [
    z.strictObject({ required: z.literal(false) }),
    z.strictObject({
      required: z.literal(true),
      keySource: versionedDefinitionRefSchema,
      credentialVerifierProfile: versionedDefinitionRefSchema,
      requestHashProfile: versionedDefinitionRefSchema
    })
  ]),
  concurrency: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('read_snapshot') }),
    z.strictObject({ kind: z.literal('registered'), definition: versionedDefinitionRefSchema })
  ]),
  outcomes: z.array(operationOutcomeDeclarationSchema),
  enabledBindings: z.array(safePublicOperationBindingSchema)
});

export const safeOperationManifestBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  operations: z.array(safeOperationManifestEntrySchema)
});

export const safeOperationManifestSchema = safeOperationManifestBodySchema.extend({
  registryDigestSha256: z.string().regex(sha256Pattern)
});

export type OperationEffect = z.infer<typeof operationEffectSchema>;
export type OperationRisk = z.infer<typeof operationRiskSchema>;
export type AutonomyDisposition = z.infer<typeof autonomyDispositionSchema>;
export type AutonomyTrigger = z.infer<typeof autonomyTriggerSchema>;
export type SafeOperationAutonomy = z.infer<typeof safeOperationAutonomySchema>;
export type StructuredOutcomeClass = z.infer<typeof structuredOutcomeClassSchema>;
export type OutcomeSubject = z.infer<typeof outcomeSubjectSchema>;
export type StructuredOutcome = z.infer<typeof structuredOutcomeSchema>;
export type OperationReceiptRef = z.infer<typeof operationReceiptRefSchema>;
export type OperationHttpIdempotencyKey = z.infer<typeof operationHttpIdempotencyKeySchema>;
export type ReadOperationResult = z.infer<typeof readOperationResultSchema>;
export type EffectfulOperationResult = z.infer<typeof effectfulOperationResultSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export type OperationTransportError = z.infer<typeof operationTransportErrorSchema>;
export type VersionedDefinitionRef = z.infer<typeof versionedDefinitionRefSchema>;
export type SafeSchemaManifestRef = z.infer<typeof safeSchemaManifestRefSchema>;
export type OperationLifecycle = z.infer<typeof operationLifecycleSchema>;
export type OperationOutcomeDeclaration = z.infer<typeof operationOutcomeDeclarationSchema>;
export type BrowserResumption = z.infer<typeof browserResumptionSchema>;
export type SafePublicOperationBinding = z.infer<typeof safePublicOperationBindingSchema>;
export type SafeOperationManifestEntry = z.infer<typeof safeOperationManifestEntrySchema>;
export type SafeOperationManifestBody = z.infer<typeof safeOperationManifestBodySchema>;
export type SafeOperationManifest = z.infer<typeof safeOperationManifestSchema>;

export { OPERATION_SURFACES };
export type { OperationSurface };
