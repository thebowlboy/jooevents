import { describe, expect, test } from 'bun:test';
import {
  synchronousClassifiedPayloadEncryptionProfileReference
} from '@jooevents/application/synchronous-classified-payload-store';
import type { VersionedDefinitionRef } from '@jooevents/contracts';
import { parseContractVersion } from '@jooevents/kernel';
import {
  DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES,
  DurableCryptoProfileConfigurationError,
  assertDurableCryptoProfileComposition,
  createDurableCryptoProfileComposition,
  type DurableCryptoProfileComposition
} from './durable-crypto-profiles';

function key(seed: number): string {
  return Buffer.alloc(32, seed).toString('base64url');
}

function environment() {
  return Object.freeze({
    requestHashKeys: `2:${key(1)},1:${key(2)}`,
    idempotencyKeys: `2:${key(3)},1:${key(4)}`,
    classifiedPayloadKeys: `2:${key(5)},1:${key(6)}`,
    persistentHmacKeys: `2:${key(7)},1:${key(8)}`
  });
}

function profile(keyValue: string, version: number): VersionedDefinitionRef {
  return Object.freeze({ key: keyValue, version });
}

function expectSafeError(
  work: () => unknown,
  duty: string,
  code: string,
  canaries: readonly string[] = []
): void {
  try {
    work();
    throw new Error('expected durable crypto profile refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(DurableCryptoProfileConfigurationError);
    expect(String(error)).toContain(`${duty}:${code}`);
    for (const canary of canaries) expect(String(error)).not.toContain(canary);
  }
}

describe('durable crypto profile composition', () => {
  test('derives stable purpose-distinct sealers for the exact requested profile version', async () => {
    const first = createDurableCryptoProfileComposition(environment());
    const second = createDurableCryptoProfileComposition(environment());
    const requestV1 = profile('request-hash.event.create-draft', 1);
    const requestV2 = profile('request-hash.event.create-draft', 2);
    const otherRequestV1 = profile('request-hash.intake.form-draft', 1);
    const bytes = new TextEncoder().encode('{"title":"Durable"}');

    const firstV1 = await first.requestHashSealer(requestV1).seal(bytes);
    const reopenedV1 = await second.requestHashSealer(requestV1).seal(bytes);
    const firstV2 = await first.requestHashSealer(requestV2).seal(bytes);
    const otherV1 = await first.requestHashSealer(otherRequestV1).seal(bytes);
    const idempotencyV1 = await first.idempotencyCredentialSealer(
      profile('key-profile.event.idempotency-credential', 1)
    ).seal('same-caller-key');

    expect(firstV1).toEqual(reopenedV1);
    expect(firstV1.verifierProfile).toEqual(requestV1);
    expect(firstV1.verifierSha256).not.toBe(firstV2.verifierSha256);
    expect(firstV1.verifierSha256).not.toBe(otherV1.verifierSha256);
    expect(firstV1.verifierSha256).not.toBe(idempotencyV1.verifierSha256);
    expect(idempotencyV1.verifierProfile).toEqual({
      key: 'key-profile.event.idempotency-credential',
      version: parseContractVersion(1)
    });
  });

  test('issues newest and retained classified encryption handles without exposing key bytes', () => {
    const source = environment();
    const composition = createDurableCryptoProfileComposition(source);
    assertDurableCryptoProfileComposition(composition);
    const selected = composition.classifiedPayloadEncryptionProfiles({
      active: profile('encryption.intake-answer', 2),
      retained: [profile('encryption.intake-answer', 1)]
    });

    expect(synchronousClassifiedPayloadEncryptionProfileReference(selected.encryptionProfile))
      .toEqual({ key: 'encryption.intake-answer', version: 2 });
    expect(selected.retainedEncryptionProfiles.map(
      synchronousClassifiedPayloadEncryptionProfileReference
    )).toEqual([{ key: 'encryption.intake-answer', version: 1 }]);
    expect(Object.keys(composition).sort()).toEqual([
      'classifiedPayloadEncryptionProfiles',
      'idempotencyCredentialSealer',
      'profileSelection',
      'requestHashSealer',
      'withPersistentHmacKey',
      'withPersistentHmacKeySelection'
    ]);
    expect(JSON.stringify(composition)).toBe('{}');
    expect(JSON.stringify(selected)).not.toContain(key(5));
    expect(JSON.stringify(selected)).not.toContain(key(6));
  });

  test('derives stable purpose-distinct persistent HMAC keys and clears the temporary view', () => {
    const first = createDurableCryptoProfileComposition(environment());
    const second = createDurableCryptoProfileComposition(environment());
    const reference = profile('security.workspace-invitation-lookup', 1);
    let supplied: Uint8Array | undefined;
    const deriveDigest = (composition: DurableCryptoProfileComposition) =>
      composition.withPersistentHmacKey(reference, (keyBytes) => {
        supplied = keyBytes;
        return Bun.CryptoHasher.hash('sha256', keyBytes, 'hex');
      });

    const firstDigest = deriveDigest(first);
    expect(firstDigest).toBe(deriveDigest(second));
    expect(firstDigest).not.toBe(second.withPersistentHmacKey(
      profile('security.communication-address-fingerprint', 1),
      (keyBytes) => Bun.CryptoHasher.hash('sha256', keyBytes, 'hex')
    ));
    expect(supplied).toBeDefined();
    expect(supplied!.every((byte) => byte === 0)).toBe(true);
  });

  test('selects newest and retained versions and clears every persistent HMAC view', () => {
    const composition = createDurableCryptoProfileComposition(environment());
    expect(composition.profileSelection('classified_payload', 'encryption.intake-answer'))
      .toEqual({
        active: { key: 'encryption.intake-answer', version: 2 },
        retained: [{ key: 'encryption.intake-answer', version: 1 }]
      });
    const supplied: Uint8Array[] = [];
    const versions = composition.withPersistentHmacKeySelection(
      'security.workspace-invitation-lookup',
      (selection) => {
        supplied.push(selection.active.keyBytes, ...selection.retained.map((item) => item.keyBytes));
        return [
          selection.active.reference.version,
          ...selection.retained.map((item) => item.reference.version)
        ];
      }
    );
    expect(versions).toEqual([2, 1]);
    expect(supplied.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  test('fails closed for missing, weak, duplicate, unordered, or mis-versioned key rings', () => {
    const source = environment();
    expectSafeError(
      () => createDurableCryptoProfileComposition({ ...source, requestHashKeys: undefined }),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash,
      'missing_key_ring'
    );
    expectSafeError(
      () => createDurableCryptoProfileComposition({ ...source, requestHashKeys: '1:d2Vhaw' }),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash,
      'invalid_key_material',
      ['d2Vhaw']
    );
    expectSafeError(
      () => createDurableCryptoProfileComposition({
        ...source,
        requestHashKeys: `1:${key(1)},1:${key(2)}`
      }),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash,
      'duplicate_key_version',
      [key(1), key(2)]
    );
    expectSafeError(
      () => createDurableCryptoProfileComposition({
        ...source,
        requestHashKeys: `1:${key(1)},2:${key(2)}`
      }),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash,
      'unordered_key_versions',
      [key(1), key(2)]
    );
    expectSafeError(
      () => createDurableCryptoProfileComposition({
        ...source,
        requestHashKeys: `9007199254740992:${key(1)}`
      }),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash,
      'invalid_key_ring_entry',
      [key(1)]
    );
    expectSafeError(
      () => createDurableCryptoProfileComposition({
        ...source,
        idempotencyKeys: `2:${key(1)},1:${key(4)}`
      }),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.idempotency,
      'duplicate_key_material',
      [key(1)]
    );
    expectSafeError(
      () => createDurableCryptoProfileComposition({
        ...source,
        persistentHmacKeys: `1:${key(8)}`
      }),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.persistentHmac,
      'misaligned_key_versions'
    );
  });

  test('requires exact configured versions and a canonical retained-profile order', () => {
    const composition = createDurableCryptoProfileComposition(environment());
    expectSafeError(
      () => composition.requestHashSealer(profile('request-hash.event.create-draft', 3)),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash,
      'profile_version_unavailable'
    );
    expectSafeError(
      () => composition.requestHashSealer(profile('request-hash.event.create-draft', 0)),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash,
      'invalid_profile_reference'
    );
    expectSafeError(
      () => composition.classifiedPayloadEncryptionProfiles({
        active: profile('encryption.intake-answer', 1),
        retained: [profile('encryption.intake-answer', 2)]
      }),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.classifiedPayload,
      'invalid_retained_profile_order'
    );
    expectSafeError(
      () => composition.classifiedPayloadEncryptionProfiles({
        active: profile('encryption.intake-answer', 2),
        retained: [profile('encryption.other', 1)]
      }),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.classifiedPayload,
      'invalid_retained_profile_order'
    );
  });

  test('rejects a forged opaque composition', () => {
    expectSafeError(
      () => assertDurableCryptoProfileComposition(Object.freeze({}) as never),
      DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash,
      'invalid_profile_reference'
    );
  });
});
