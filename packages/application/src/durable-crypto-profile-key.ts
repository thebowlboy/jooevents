import { hkdfSync } from 'node:crypto';

const keyLength = 32;
const kdfSalt = new TextEncoder().encode('jooevents:durable-crypto-profile:hkdf-sha256:v1');

export interface DurableCryptoProfileKeyCoordinate {
  readonly family: 'request_hash' | 'idempotency' | 'classified_payload' | 'persistent_hmac';
  readonly purpose: string;
  readonly key: string;
  readonly version: number;
}

/** One shared deterministic KDF used by every runtime composition. */
export function deriveDurableCryptoProfileKey(input: {
  readonly rootKeyBytes: Uint8Array;
  readonly coordinate: DurableCryptoProfileKeyCoordinate;
}): Uint8Array {
  if (!(input.rootKeyBytes instanceof Uint8Array) || input.rootKeyBytes.byteLength !== keyLength) {
    throw new TypeError('durable_crypto_root_key_invalid');
  }
  const { coordinate } = input;
  if (
    !coordinate.purpose
    || !coordinate.key
    || !Number.isSafeInteger(coordinate.version)
    || coordinate.version < 1
  ) {
    throw new TypeError('durable_crypto_profile_coordinate_invalid');
  }
  const identity = JSON.stringify([
    'jooevents.durable-crypto-profile',
    1,
    coordinate.family,
    coordinate.purpose,
    coordinate.key,
    coordinate.version
  ]);
  return new Uint8Array(hkdfSync(
    'sha256',
    input.rootKeyBytes,
    kdfSalt,
    new TextEncoder().encode(identity),
    keyLength
  ));
}
