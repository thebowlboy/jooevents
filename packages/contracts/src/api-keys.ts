import { isApplicationId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema
} from './operations';

/** The shared warning window used by both the settings UI and external API. */
export const API_KEY_EXPIRES_SOON_DAYS = 14;

const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Expected a canonical application ID.'
});
const instantSchema = z.iso.datetime({ offset: true });
const permissionIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(120);
const canonicalPermissionIdsSchema = z.array(permissionIdSchema).min(1).max(100)
  .refine((values) => values.every((value, index) => index === 0 || values[index - 1]! < value), {
    message: 'Permission IDs must be unique and sorted.'
  });
const canonicalEventIdsSchema = z.array(applicationIdSchema).max(500)
  .refine((values) => values.every((value, index) => index === 0 || values[index - 1]! < value), {
    message: 'Event IDs must be unique and sorted.'
  });

export const apiKeyRevokeReasonSchema = z.enum([
  'rotated', 'owner_request', 'admin_request', 'security'
]);

export const apiKeyViewSchema = z.strictObject({
  id: applicationIdSchema,
  ownerUserId: applicationIdSchema,
  ownerDisplayName: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(80),
  tokenHint: z.string().regex(/^jooak1_[A-Za-z0-9_-]{4}$/),
  reads: z.boolean(),
  proposesChanges: z.boolean(),
  permissionIds: canonicalPermissionIdsSchema,
  eventIds: canonicalEventIdsSchema,
  createdAt: instantSchema,
  /** `null` means the owner explicitly chose a key that does not expire. */
  expiresAt: instantSchema.nullable(),
  lastUsedAt: instantSchema.nullable(),
  standing: z.enum(['active', 'revoked']),
  revokedAt: instantSchema.nullable(),
  revokeReason: apiKeyRevokeReasonSchema.nullable(),
  version: z.number().int().positive()
});

export const apiKeyPermissionViewSchema = z.strictObject({
  id: permissionIdSchema,
  group: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(80),
  groupLabel: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(400),
  risk: z.enum(['routine', 'sensitive', 'consequential']),
  held: z.boolean()
});

export const apiKeyProfileViewSchema = z.strictObject({
  key: z.enum(['full', 'assistant', 'dashboard', 'schedule']),
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(600),
  proposesChanges: z.boolean(),
  permissionIds: z.union([z.literal('everything-held'), canonicalPermissionIdsSchema])
});

export const apiKeyListDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  timezone: z.string().trim().min(1).max(100),
  keys: z.array(apiKeyViewSchema).max(10_000),
  permissions: z.array(apiKeyPermissionViewSchema).max(200),
  profiles: z.array(apiKeyProfileViewSchema).length(4),
  events: z.array(z.strictObject({
    id: applicationIdSchema,
    name: z.string().trim().min(1).max(240)
  })).max(500),
  expiry: z.strictObject({
    defaultDays: z.number().int().min(1).max(3650),
    maxDays: z.number().int().min(1).max(3650),
    rotationGraceHours: z.number().int().min(0).max(8760)
  })
});

export const apiKeyListInputSchema = z.strictObject({});
export const apiKeyCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  mayRead: z.boolean().default(true),
  maySubmitPlans: z.boolean(),
  permissionIds: canonicalPermissionIdsSchema,
  eventIds: canonicalEventIdsSchema,
  /** `null` is an explicit never-expire choice, not a sentinel date. */
  expiresInDays: z.number().int().min(1).max(3650).nullable()
});
export const apiKeyRotateInputSchema = z.strictObject({
  apiKeyId: applicationIdSchema,
  expectedVersion: z.number().int().positive()
});
export const apiKeyRevokeInputSchema = z.strictObject({
  apiKeyId: applicationIdSchema,
  expectedVersion: z.number().int().positive(),
  reason: apiKeyRevokeReasonSchema
});

export const apiKeyMintDataSchema = z.strictObject({
  key: apiKeyViewSchema,
  /** Opaque, single-use browser delivery handle. The raw key is never durable operation data. */
  secretHandle: z.uuid()
});
export const apiKeyRotateDataSchema = z.strictObject({
  predecessor: apiKeyViewSchema,
  successor: apiKeyViewSchema,
  /** Opaque, single-use browser delivery handle. The raw key is never durable operation data. */
  secretHandle: z.uuid()
});

export const apiKeySecretDeliveryResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('delivered'),
    secret: z.string().regex(/^jooak1_[A-Za-z0-9_-]{43}$/)
  }),
  z.strictObject({ kind: z.literal('unavailable') })
]);

export const apiKeyListCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: apiKeyListDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const apiKeyCreateCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: apiKeyMintDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const apiKeyRotateCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: apiKeyRotateDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const apiKeyRevokeCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: apiKeyViewSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const apiKeyListOperationResultSchema = createReadOperationResultSchema(apiKeyListDataSchema);
export const apiKeyCreateOperationResultSchema = createEffectfulOperationResultSchema(apiKeyMintDataSchema);
export const apiKeyRotateOperationResultSchema = createEffectfulOperationResultSchema(apiKeyRotateDataSchema);
export const apiKeyRevokeOperationResultSchema = createEffectfulOperationResultSchema(apiKeyViewSchema);

const oneTimeApiKeySecretSchema = z.string().regex(/^jooak1_[A-Za-z0-9_-]{43}$/);

/**
 * HTTP-only result variants for runtimes that must return the one-time secret in
 * the committing response. The canonical operation result and its durable receipt
 * remain the secret-free schemas above.
 */
export const apiKeyCreateHttpResultSchema = z.union([
  createEffectfulOperationResultSchema(apiKeyMintDataSchema.extend({
    oneTimeSecret: oneTimeApiKeySecretSchema
  })),
  apiKeyCreateOperationResultSchema
]);
export const apiKeyRotateHttpResultSchema = z.union([
  createEffectfulOperationResultSchema(apiKeyRotateDataSchema.extend({
    oneTimeSecret: oneTimeApiKeySecretSchema
  })),
  apiKeyRotateOperationResultSchema
]);

export const API_KEY_OPERATION_SCHEMA_REFS = Object.freeze({
  list: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace.api-key.list.input', inputSchema: apiKeyListInputSchema,
    resultKey: 'schema.workspace.api-key.list.result', resultSchema: apiKeyListOperationResultSchema
  }),
  create: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace.api-key.create.input', inputSchema: apiKeyCreateInputSchema,
    resultKey: 'schema.workspace.api-key.create.result', resultSchema: apiKeyCreateOperationResultSchema
  }),
  rotate: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace.api-key.rotate.input', inputSchema: apiKeyRotateInputSchema,
    resultKey: 'schema.workspace.api-key.rotate.result', resultSchema: apiKeyRotateOperationResultSchema
  }),
  revoke: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace.api-key.revoke.input', inputSchema: apiKeyRevokeInputSchema,
    resultKey: 'schema.workspace.api-key.revoke.result', resultSchema: apiKeyRevokeOperationResultSchema
  })
});

export type ApiKeyViewDto = z.infer<typeof apiKeyViewSchema>;
export type ApiKeyListDataDto = z.infer<typeof apiKeyListDataSchema>;
