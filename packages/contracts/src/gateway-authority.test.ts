import { describe, expect, test } from 'bun:test';
import { accessContextSchema } from './access';
import {
  GATEWAY_AUTHORITY_LIMITS,
  encodeGatewayPendingActionResolutionProofClaims,
  gatewayActionKeySchema,
  gatewayAuthorityProjectionSchema,
  gatewayDisclosureEpochSchema,
  gatewayPendingActionResolutionProofIdSchema,
  gatewayPendingActionResolutionProofSchema,
  gatewayPrincipalPartitionKeySchema,
  gatewayPrincipalPartitionKeys,
  gatewayScopeKeySchema,
  gatewaySourceKeySchema,
  gatewayStageIdempotencyKeySchema,
  parseGatewayAuthorityProjection,
  parseGatewayPendingActionResolutionProof
} from './gateway-authority';

const current = 'gpp_0123456789abcdef';
const alias = 'gpp_fedcba9876543210';
const disclosureEpoch = 'gde_0123456789abcdef';
const resolvedDisclosureEpoch = 'gde_fedcba9876543210';

function projection() {
  return {
    schemaVersion: 1,
    principalPartition: { current, aliases: [alias] },
    disclosureEpoch
  } as const;
}

function resolutionProof() {
  return {
    schemaVersion: 1,
    purpose: 'pending_action_disclosure_rebind',
    proofId: 'gar_0123456789abcdef',
    verifierProfile: { key: 'gateway.pending_action_resolution.hmac', version: 1 },
    binding: {
      pendingActionIdentity: {
        sourceKey: 'gws_0123456789abcdef',
        scopeKey: 'gsc_0123456789abcdef',
        principalPartitionKey: current,
        actionKey: 'gac_0123456789abcdef'
      },
      currentPrincipalPartitionKey: alias,
      previousDisclosureEpoch: disclosureEpoch,
      resolvedDisclosureEpoch,
      pendingActionRevision: 7,
      currentStep: {
        stepKey: 'commit',
        operation: { name: 'changeset.commit', version: 3 },
        idempotencyKey: 'gik_0123456789abcdef'
      }
    },
    issuedAt: '2026-08-11T00:00:00.000Z',
    expiresAt: '2026-08-11T00:05:00.000Z',
    replayMode: 'single_use',
    authenticator: { algorithm: 'hmac_sha256', tagHex: 'a'.repeat(64) }
  } as const;
}

describe('gateway authority contracts', () => {
  test('uses closed, purpose-distinct opaque values', () => {
    expect(gatewayPrincipalPartitionKeySchema.safeParse(current).success).toBe(true);
    expect(gatewayPrincipalPartitionKeySchema.safeParse(disclosureEpoch).success).toBe(false);
    expect(gatewayDisclosureEpochSchema.safeParse(current).success).toBe(false);
    expect(gatewaySourceKeySchema.safeParse('gws_0123456789abcdef').success).toBe(true);
    expect(gatewayScopeKeySchema.safeParse('gws_0123456789abcdef').success).toBe(false);
    expect(gatewayActionKeySchema.safeParse('gac_0123456789abcdef').success).toBe(true);
    expect(gatewayStageIdempotencyKeySchema.safeParse('gac_0123456789abcdef').success)
      .toBe(false);
    expect(gatewayPendingActionResolutionProofIdSchema.safeParse('gar_0123456789abcdef').success)
      .toBe(true);
    expect(gatewayPendingActionResolutionProofIdSchema.safeParse(current).success).toBe(false);
    expect(gatewayPrincipalPartitionKeySchema.safeParse('user_ada').success).toBe(false);
  });

  test('requires an exact, bounded, single-use authenticated resolution envelope', () => {
    const proof = parseGatewayPendingActionResolutionProof(resolutionProof());
    expect(proof.binding.currentStep.operation).toEqual({
      name: 'changeset.commit',
      version: 3
    });
    expect(gatewayPendingActionResolutionProofSchema.safeParse('gar_0123456789abcdef').success)
      .toBe(false);
    expect(gatewayPendingActionResolutionProofSchema.safeParse({ ...proof, extra: true }).success)
      .toBe(false);
    expect(gatewayPendingActionResolutionProofSchema.safeParse({
      ...proof,
      replayMode: 'reusable'
    }).success).toBe(false);
    expect(gatewayPendingActionResolutionProofSchema.safeParse({
      ...proof,
      binding: {
        ...proof.binding,
        resolvedDisclosureEpoch: proof.binding.previousDisclosureEpoch
      }
    }).success).toBe(false);
    expect(gatewayPendingActionResolutionProofSchema.safeParse({
      ...proof,
      expiresAt: new Date(
        Date.parse(proof.issuedAt) + GATEWAY_AUTHORITY_LIMITS.maximumResolutionProofLifetimeMs + 1
      ).toISOString()
    }).success).toBe(false);
    expect(gatewayPendingActionResolutionProofSchema.safeParse({
      ...proof,
      authenticator: { algorithm: 'hmac_sha256', tagHex: 'A'.repeat(64) }
    }).success).toBe(false);
  });

  test('encodes all resolution claims under a fixed domain and never authenticates its own tag', () => {
    const proof = parseGatewayPendingActionResolutionProof(resolutionProof());
    const encoded = new TextDecoder().decode(
      encodeGatewayPendingActionResolutionProofClaims(proof)
    );
    expect(encoded).toContain('jooevents.gateway.pending_action_resolution_proof');
    expect(encoded).toContain(proof.binding.currentStep.idempotencyKey);
    expect(encoded).toContain(proof.binding.previousDisclosureEpoch);
    expect(encoded).toContain(proof.binding.resolvedDisclosureEpoch);
    expect(encoded).not.toContain(proof.authenticator.tagHex);

    const variants = [
      { ...proof, proofId: 'gar_fedcba9876543210' },
      {
        ...proof,
        binding: {
          ...proof.binding,
          pendingActionIdentity: {
            ...proof.binding.pendingActionIdentity,
            actionKey: 'gac_fedcba9876543210'
          }
        }
      },
      {
        ...proof,
        binding: {
          ...proof.binding,
          currentStep: { ...proof.binding.currentStep, stepKey: 'propose' }
        }
      }
    ];
    for (const variant of variants) {
      expect(encodeGatewayPendingActionResolutionProofClaims(variant)).not.toEqual(
        encodeGatewayPendingActionResolutionProofClaims(proof)
      );
    }
  });

  test('is strict, bounded, ordered, and collision-free', () => {
    const parsed = parseGatewayAuthorityProjection(projection());
    expect(gatewayPrincipalPartitionKeys(parsed)).toEqual([
      parsed.principalPartition.current,
      parsed.principalPartition.aliases[0]!
    ]);
    expect(gatewayAuthorityProjectionSchema.safeParse({ ...projection(), extra: true }).success)
      .toBe(false);
    expect(gatewayAuthorityProjectionSchema.safeParse({
      ...projection(),
      principalPartition: { current, aliases: [current] }
    }).success).toBe(false);
    expect(gatewayAuthorityProjectionSchema.safeParse({
      ...projection(),
      principalPartition: {
        current,
        aliases: Array.from(
          { length: GATEWAY_AUTHORITY_LIMITS.maximumPartitionAliases + 1 },
          (_, index) => `gpp_${String(index).padStart(16, '0')}`
        )
      }
    }).success).toBe(false);
  });

  test('appears only on an active access context and remains optional before activation', () => {
    const user = { id: 'user_ada', displayName: 'Ada' };
    const workspace = { id: 'workspace_summit', name: 'Summit Operations' };
    expect(accessContextSchema.safeParse({
      state: 'active',
      user,
      workspace,
      gatewayAuthority: projection()
    }).success).toBe(true);
    expect(accessContextSchema.safeParse({ state: 'active', user, workspace }).success).toBe(true);
    const nonActive = [
      { state: 'anonymous' },
      { state: 'provisioning', retryAfterSeconds: 2, correlationId: 'corr_ada' },
      {
        state: 'pending_review',
        user,
        workspace,
        membership: {
          id: 'membership_ada',
          workspaceId: 'workspace_summit',
          status: 'pending_review',
          version: 1
        }
      },
      { state: 'blocked', code: 'suspended' }
    ];
    for (const context of nonActive) {
      expect(accessContextSchema.safeParse({
        ...context,
        gatewayAuthority: projection()
      }).success).toBe(false);
    }
  });
});
