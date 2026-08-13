import { describe, expect, test } from 'bun:test';
import {
  effectOperationIdentitiesEqual,
  effectOperationIdentityMatchesContext
} from './effect-identity';
import type { EffectInvocationContext, EffectOperationIdentity } from './types';

const identity: EffectOperationIdentity = {
  scopePartitionKey: 'scope-partition',
  authorityPrincipalKey: 'principal',
  operationName: 'event.create',
  operationVersion: 1,
  surface: 'operator_http',
  idempotencyVerifierProfile: { key: 'idempotency.hmac-sha256', version: 1 },
  idempotencyKeyVerifier: 'idempotency-verifier'
};

function contextFor(source: EffectOperationIdentity): EffectInvocationContext {
  return {
    authorityPrincipalKey: source.authorityPrincipalKey,
    operation: {
      name: source.operationName,
      version: source.operationVersion,
      effect: 'commit'
    },
    surface: source.surface,
    requestBinding: {
      scopePartitionKey: source.scopePartitionKey,
      idempotency: {
        verifierProfile: { ...source.idempotencyVerifierProfile },
        verifierSha256: source.idempotencyKeyVerifier
      }
    }
  } as unknown as EffectInvocationContext;
}

const identityMismatches: ReadonlyArray<readonly [
  string,
  (source: EffectOperationIdentity) => EffectOperationIdentity
]> = [
  ['scope partition key', (source) => ({ ...source, scopePartitionKey: 'other-scope' })],
  ['authority principal key', (source) => ({ ...source, authorityPrincipalKey: 'other-principal' })],
  ['operation name', (source) => ({ ...source, operationName: 'event.update' })],
  ['operation version', (source) => ({ ...source, operationVersion: 2 })],
  ['surface', (source) => ({ ...source, surface: 'participant_http' })],
  ['idempotency verifier profile key', (source) => ({
    ...source,
    idempotencyVerifierProfile: { ...source.idempotencyVerifierProfile, key: 'other-profile' }
  })],
  ['idempotency verifier profile version', (source) => ({
    ...source,
    idempotencyVerifierProfile: { ...source.idempotencyVerifierProfile, version: 2 }
  })],
  ['idempotency key verifier', (source) => ({ ...source, idempotencyKeyVerifier: 'other-verifier' })]
];

describe('effect operation identity comparison', () => {
  test('accepts an exact identity and exact invocation binding', () => {
    expect(effectOperationIdentitiesEqual(identity, { ...identity })).toBe(true);
    expect(effectOperationIdentityMatchesContext(identity, contextFor(identity))).toBe(true);
  });

  for (const [field, mutate] of identityMismatches) {
    test(`rejects a receipt identity with a mismatched ${field}`, () => {
      expect(effectOperationIdentitiesEqual(identity, mutate(identity))).toBe(false);
    });

    test(`rejects an invocation context with a mismatched ${field}`, () => {
      expect(effectOperationIdentityMatchesContext(identity, contextFor(mutate(identity)))).toBe(false);
    });
  }

  test('rejects an invocation context without an idempotency binding', () => {
    const context = contextFor(identity) as unknown as {
      requestBinding: Record<string, unknown>;
    };
    expect(effectOperationIdentityMatchesContext(identity, {
      ...context,
      requestBinding: { scopePartitionKey: identity.scopePartitionKey }
    } as unknown as EffectInvocationContext)).toBe(false);
  });
});
