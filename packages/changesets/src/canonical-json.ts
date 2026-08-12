import { createHash } from 'node:crypto';
import {
  CANONICAL_JSON_PROFILE,
  canonicalJsonValue,
  encodeCanonicalJson,
  type CanonicalJson
} from '@jooevents/kernel';

export { CANONICAL_JSON_PROFILE, canonicalJsonValue, encodeCanonicalJson as canonicalJsonBytes };
export type { CanonicalJson };

export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}
