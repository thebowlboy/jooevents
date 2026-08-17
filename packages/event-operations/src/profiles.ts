import type { VersionedKeyProfileRef } from '@jooevents/identity-access';
import { parseContractVersion } from '@jooevents/kernel';

function keyProfile(key: string): VersionedKeyProfileRef {
  return Object.freeze({ key, version: parseContractVersion(1) });
}

/** Shared Event-family key duties consumed by every supported runtime composition. */
export const EVENT_OPERATION_KEY_PROFILES = Object.freeze({
  authorityPrincipal: keyProfile('key-profile.event.operator-principal'),
  scopePartition: keyProfile('key-profile.event.workspace-scope'),
  requestCanonicalization: keyProfile('key-profile.event.request-canonicalization'),
  idempotencyCredential: keyProfile('key-profile.event.idempotency-credential')
});
