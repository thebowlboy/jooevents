import { encodeCanonicalJson } from '@jooevents/kernel';
import { z } from 'zod';
import {
  definitionKeySchema,
  operationNameSchema,
  operationVersionSchema,
  versionedDefinitionRefSchema
} from './operations';

export const GATEWAY_AUTHORITY_LIMITS = Object.freeze({
  maximumPartitionAliases: 4,
  maximumResolutionProofLifetimeMs: 5 * 60 * 1_000
});

const opaqueBody = '[A-Za-z0-9_-]{16,240}';
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

function opaqueGatewayValue<Brand extends string>(prefix: string, brand: Brand) {
  return z
    .string()
    .min(prefix.length + 16)
    .max(prefix.length + 240)
    .regex(new RegExp(`^${prefix}${opaqueBody}$`))
    .brand<Brand>();
}

export const gatewayPrincipalPartitionKeySchema = opaqueGatewayValue(
  'gpp_',
  'GatewayPrincipalPartitionKey'
);

export const gatewayDisclosureEpochSchema = opaqueGatewayValue(
  'gde_',
  'GatewayDisclosureEpoch'
);

export const gatewaySourceKeySchema = opaqueGatewayValue('gws_', 'GatewaySourceKey');
export const gatewayScopeKeySchema = opaqueGatewayValue('gsc_', 'GatewayScopeKey');
export const gatewayActionKeySchema = opaqueGatewayValue('gac_', 'GatewayActionKey');
export const gatewayStageIdempotencyKeySchema = opaqueGatewayValue(
  'gik_',
  'GatewayStageIdempotencyKey'
);
export const gatewayPendingActionResolutionProofIdSchema = opaqueGatewayValue(
  'gar_',
  'GatewayPendingActionResolutionProofId'
);

export const gatewayPendingActionIdentitySchema = z.strictObject({
  sourceKey: gatewaySourceKeySchema,
  scopeKey: gatewayScopeKeySchema,
  principalPartitionKey: gatewayPrincipalPartitionKeySchema,
  actionKey: gatewayActionKeySchema
});

export const gatewayPendingActionStepBindingSchema = z.strictObject({
  stepKey: definitionKeySchema,
  operation: z.strictObject({
    name: operationNameSchema,
    version: operationVersionSchema
  }),
  idempotencyKey: gatewayStageIdempotencyKeySchema
});

export const gatewayPendingActionResolutionBindingSchema = z
  .strictObject({
    pendingActionIdentity: gatewayPendingActionIdentitySchema,
    currentPrincipalPartitionKey: gatewayPrincipalPartitionKeySchema,
    previousDisclosureEpoch: gatewayDisclosureEpochSchema,
    resolvedDisclosureEpoch: gatewayDisclosureEpochSchema,
    pendingActionRevision: z.number().int().positive(),
    currentStep: gatewayPendingActionStepBindingSchema
  })
  .superRefine((binding, context) => {
    if (binding.previousDisclosureEpoch === binding.resolvedDisclosureEpoch) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedDisclosureEpoch'],
        message: 'A disclosure rebind must resolve a changed disclosure epoch.'
      });
    }
  });

const gatewayPendingActionResolutionProofClaimsShape = {
  schemaVersion: z.literal(1),
  purpose: z.literal('pending_action_disclosure_rebind'),
  proofId: gatewayPendingActionResolutionProofIdSchema,
  verifierProfile: versionedDefinitionRefSchema,
  binding: gatewayPendingActionResolutionBindingSchema,
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  replayMode: z.literal('single_use')
} as const;

function validateResolutionProofLifetime(
  proof: { readonly issuedAt: string; readonly expiresAt: string },
  context: z.RefinementCtx
): void {
  const issuedAt = Date.parse(proof.issuedAt);
  const expiresAt = Date.parse(proof.expiresAt);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > GATEWAY_AUTHORITY_LIMITS.maximumResolutionProofLifetimeMs
  ) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Pending-action resolution proof lifetime is invalid.'
    });
  }
}

export const gatewayPendingActionResolutionProofClaimsSchema = z
  .strictObject(gatewayPendingActionResolutionProofClaimsShape)
  .superRefine(validateResolutionProofLifetime);

/**
 * A server-issued, single-use resolution envelope. Its claims are safe browser
 * metadata; the authenticator is meaningful only to the injected server verifier.
 */
export const gatewayPendingActionResolutionProofSchema = z
  .strictObject({
    ...gatewayPendingActionResolutionProofClaimsShape,
    authenticator: z.strictObject({
      algorithm: z.literal('hmac_sha256'),
      tagHex: sha256HexSchema
    })
  })
  .superRefine(validateResolutionProofLifetime);

export const gatewayPrincipalPartitionSchema = z
  .strictObject({
    current: gatewayPrincipalPartitionKeySchema,
    aliases: z
      .array(gatewayPrincipalPartitionKeySchema)
      .max(GATEWAY_AUTHORITY_LIMITS.maximumPartitionAliases)
  })
  .superRefine((partition, context) => {
    const ordered = [partition.current, ...partition.aliases];
    if (new Set(ordered).size !== ordered.length) {
      context.addIssue({
        code: 'custom',
        path: ['aliases'],
        message: 'Gateway principal partition keys must be unique.'
      });
    }
  });

export const gatewayAuthorityProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  principalPartition: gatewayPrincipalPartitionSchema,
  disclosureEpoch: gatewayDisclosureEpochSchema
});

export type GatewayPrincipalPartitionKey = z.infer<typeof gatewayPrincipalPartitionKeySchema>;
export type GatewayDisclosureEpoch = z.infer<typeof gatewayDisclosureEpochSchema>;
export type GatewaySourceKey = z.infer<typeof gatewaySourceKeySchema>;
export type GatewayScopeKey = z.infer<typeof gatewayScopeKeySchema>;
export type GatewayActionKey = z.infer<typeof gatewayActionKeySchema>;
export type GatewayStageIdempotencyKey = z.infer<typeof gatewayStageIdempotencyKeySchema>;
export type GatewayPendingActionIdentity = z.infer<typeof gatewayPendingActionIdentitySchema>;
export type GatewayPendingActionStepBinding = z.infer<
  typeof gatewayPendingActionStepBindingSchema
>;
export type GatewayPendingActionResolutionBinding = z.infer<
  typeof gatewayPendingActionResolutionBindingSchema
>;
export type GatewayPendingActionResolutionProofId = z.infer<
  typeof gatewayPendingActionResolutionProofIdSchema
>;
export type GatewayPendingActionResolutionProofClaims = z.infer<
  typeof gatewayPendingActionResolutionProofClaimsSchema
>;
export type GatewayPendingActionResolutionProof = z.infer<
  typeof gatewayPendingActionResolutionProofSchema
>;
export type GatewayPrincipalPartition = z.infer<typeof gatewayPrincipalPartitionSchema>;
export type GatewayAuthorityProjection = z.infer<typeof gatewayAuthorityProjectionSchema>;

export function parseGatewayPrincipalPartitionKey(value: unknown): GatewayPrincipalPartitionKey {
  return gatewayPrincipalPartitionKeySchema.parse(value);
}

export function parseGatewayDisclosureEpoch(value: unknown): GatewayDisclosureEpoch {
  return gatewayDisclosureEpochSchema.parse(value);
}

export function parseGatewayPendingActionResolutionBinding(
  value: unknown
): GatewayPendingActionResolutionBinding {
  return gatewayPendingActionResolutionBindingSchema.parse(value);
}

export function parseGatewayPendingActionResolutionProofClaims(
  value: unknown
): GatewayPendingActionResolutionProofClaims {
  return gatewayPendingActionResolutionProofClaimsSchema.parse(value);
}

export function parseGatewayPendingActionResolutionProof(
  value: unknown
): GatewayPendingActionResolutionProof {
  return gatewayPendingActionResolutionProofSchema.parse(value);
}

/** Exact domain-separated bytes authenticated by a resolution-proof issuer/verifier. */
export function encodeGatewayPendingActionResolutionProofClaims(
  value: unknown
): Uint8Array {
  const parsedProof = gatewayPendingActionResolutionProofSchema.safeParse(value);
  const claimInput = parsedProof.success
    ? {
        schemaVersion: parsedProof.data.schemaVersion,
        purpose: parsedProof.data.purpose,
        proofId: parsedProof.data.proofId,
        verifierProfile: parsedProof.data.verifierProfile,
        binding: parsedProof.data.binding,
        issuedAt: parsedProof.data.issuedAt,
        expiresAt: parsedProof.data.expiresAt,
        replayMode: parsedProof.data.replayMode
      }
    : value;
  const claims = gatewayPendingActionResolutionProofClaimsSchema.parse(claimInput);
  return encodeCanonicalJson({
    namespace: 'jooevents.gateway.pending_action_resolution_proof',
    claims
  });
}

export function parseGatewayAuthorityProjection(value: unknown): GatewayAuthorityProjection {
  return gatewayAuthorityProjectionSchema.parse(value);
}

export function gatewayPrincipalPartitionKeys(
  projection: GatewayAuthorityProjection
): readonly GatewayPrincipalPartitionKey[] {
  const parsed = gatewayAuthorityProjectionSchema.parse(projection);
  return Object.freeze([
    parsed.principalPartition.current,
    ...parsed.principalPartition.aliases
  ]);
}
