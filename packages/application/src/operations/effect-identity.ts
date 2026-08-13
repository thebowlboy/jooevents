import type { EffectInvocationContext, EffectOperationIdentity } from './types';

/** Compares every field that binds an effect receipt to one idempotent operation. */
export function effectOperationIdentitiesEqual(
  left: EffectOperationIdentity,
  right: EffectOperationIdentity
): boolean {
  return left.scopePartitionKey === right.scopePartitionKey
    && left.authorityPrincipalKey === right.authorityPrincipalKey
    && left.operationName === right.operationName
    && left.operationVersion === right.operationVersion
    && left.surface === right.surface
    && left.idempotencyVerifierProfile.key === right.idempotencyVerifierProfile.key
    && left.idempotencyVerifierProfile.version === right.idempotencyVerifierProfile.version
    && left.idempotencyKeyVerifier === right.idempotencyKeyVerifier;
}

/** Verifies that an effect identity was derived from the supplied invocation context. */
export function effectOperationIdentityMatchesContext(
  identity: EffectOperationIdentity,
  context: EffectInvocationContext
): boolean {
  return identity.scopePartitionKey === context.requestBinding.scopePartitionKey
    && identity.authorityPrincipalKey === context.authorityPrincipalKey
    && identity.operationName === context.operation.name
    && identity.operationVersion === context.operation.version
    && identity.surface === context.surface
    && identity.idempotencyVerifierProfile.key
      === context.requestBinding.idempotency?.verifierProfile.key
    && identity.idempotencyVerifierProfile.version
      === context.requestBinding.idempotency?.verifierProfile.version
    && identity.idempotencyKeyVerifier === context.requestBinding.idempotency?.verifierSha256;
}
