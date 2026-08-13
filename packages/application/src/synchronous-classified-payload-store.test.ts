import { describe, expect, test } from 'bun:test';
import {
  adoptSynchronousClassifiedPayload,
  openSynchronousClassifiedPayloadAdoptionReceipt,
  issueSynchronousClassifiedPayloadEncryptionProfile,
  openSynchronousClassifiedPayload,
  sealSynchronousClassifiedPayload,
  SynchronousClassifiedPayloadStoreError,
  synchronousClassifiedPayloadEncryptionProfileReference,
  type SynchronousClassifiedPayloadStore
} from './synchronous-classified-payload-store';
import { createClassifiedPayloadProfileRef } from './classified-payloads';
import { createPayloadRef, parseInstant, parsePayloadRefId } from '@jooevents/kernel';

const reference = Object.freeze({ key: 'encryption.sqlite-payload', version: 1 });
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

describe('synchronous classified-payload cryptography', () => {
  test('keeps key material off the authenticated handle and round-trips exact AAD', () => {
    const profile = issueSynchronousClassifiedPayloadEncryptionProfile({ reference, keyBytes: key });
    expect(Object.keys(profile)).toEqual(['reference']);
    expect(JSON.stringify(profile)).not.toContain('1,2,3,4');
    expect(synchronousClassifiedPayloadEncryptionProfileReference(profile)).toEqual(reference);

    const plaintext = new TextEncoder().encode('classified canary');
    const authenticatedData = new TextEncoder().encode('exact binding');
    const encrypted = sealSynchronousClassifiedPayload({
      profile,
      plaintext,
      authenticatedData,
      nonceSource: () => Uint8Array.from({ length: 12 }, (_, index) => 100 + index)
    });
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.authenticationTag).toHaveLength(16);
    expect(new TextDecoder().decode(encrypted.ciphertext)).not.toContain('classified canary');
    expect(openSynchronousClassifiedPayload({ profile, encrypted, authenticatedData })).toEqual(plaintext);
  });

  test('refuses forged profiles, wrong AAD, and tampered tags without raw crypto detail', () => {
    const profile = issueSynchronousClassifiedPayloadEncryptionProfile({ reference, keyBytes: key });
    const authenticatedData = new TextEncoder().encode('binding-a');
    const encrypted = sealSynchronousClassifiedPayload({
      profile,
      plaintext: new TextEncoder().encode('never disclose this'),
      authenticatedData,
      nonceSource: () => new Uint8Array(12)
    });
    const tampered = { ...encrypted, authenticationTag: Uint8Array.from(encrypted.authenticationTag) };
    tampered.authenticationTag[0]! ^= 1;
    for (const attempt of [
      () => openSynchronousClassifiedPayload({
        profile,
        encrypted,
        authenticatedData: new TextEncoder().encode('binding-b')
      }),
      () => openSynchronousClassifiedPayload({ profile, encrypted: tampered, authenticatedData }),
      () => sealSynchronousClassifiedPayload({
        profile: Object.freeze({ reference }) as typeof profile,
        plaintext: new Uint8Array(),
        authenticatedData
      })
    ]) {
      try {
        attempt();
        throw new Error('expected refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(SynchronousClassifiedPayloadStoreError);
        expect(String(error)).not.toContain('never disclose this');
      }
    }
  });

  test('issues adoption receipts only after exact store put and descriptor-bound read-back', () => {
    const bytes = new TextEncoder().encode('governed answer');
    const payloadRef = createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-000000000001'));
    const profiles = {
      classification: createClassifiedPayloadProfileRef('classification', 'classification.private', 1),
      schema: createClassifiedPayloadProfileRef('schema', 'schema.text', 1),
      content: createClassifiedPayloadProfileRef('content', 'content.intake-answer', 1),
      integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
      descriptorAuth: createClassifiedPayloadProfileRef('descriptor_auth', 'descriptor.hmac', 1)
    };
    const binding = Object.freeze({
      profiles,
      scopeBinding: 'workspace:event:form:draft:revision:field',
      contentType: 'text/plain'
    });
    let stored: Uint8Array | undefined;
    const store: SynchronousClassifiedPayloadStore = {
      put(input) {
        stored = Uint8Array.from(input.bytes);
        return { kind: 'inserted', payloadRef };
      },
      read(input) {
        expect(input.expectedBinding).toBe(binding);
        return Uint8Array.from(stored!);
      }
    };
    const receipt = adoptSynchronousClassifiedPayload({
      store,
      put: {
        payloadRefId: payloadRef.id,
        binding,
        purpose: 'intake.application_answer',
        bytes,
        createdAt: parseInstant('2026-08-12T11:00:00.000Z')
      }
    });
    expect(openSynchronousClassifiedPayloadAdoptionReceipt({ receipt, expectedStore: store }))
      .toEqual({ kind: 'inserted', payloadRef });
    expect(JSON.stringify(openSynchronousClassifiedPayloadAdoptionReceipt({
      receipt, expectedStore: store
    }))).not.toMatch(/digest|byteSize|scopeBinding|contentType/u);
    expect(() => openSynchronousClassifiedPayloadAdoptionReceipt({
      receipt: Object.freeze({}) as typeof receipt
    })).toThrow('invalid_payload_input');
    const lyingStore: SynchronousClassifiedPayloadStore = {
      put() { return { kind: 'inserted', payloadRef }; },
      read() { return new TextEncoder().encode('different'); }
    };
    expect(() => adoptSynchronousClassifiedPayload({
      store: lyingStore,
      put: {
        payloadRefId: payloadRef.id,
        binding,
        purpose: 'intake.application_answer',
        bytes,
        createdAt: parseInstant('2026-08-12T11:00:00.000Z')
      }
    })).toThrow('payload_corrupt');
  });
});
