import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  SynchronousClassifiedPayloadStoreError,
  issueSynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadStoreErrorCode
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  createClassifiedPayloadDescriptor,
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadDescriptor,
  type ClassifiedPayloadProfiles
} from '@jooevents/application';
import { parseInstant, parsePayloadRefId } from '@jooevents/kernel';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installSQLiteClassifiedPayloadStoreSchema,
  SQLiteClassifiedPayloadStore
} from './sqlite-classified-payload-store';

const payloadRefId = parsePayloadRefId('019c20e3-9947-7df0-853d-56b39cf00001');
const otherPayloadRefId = parsePayloadRefId('019c20e3-9947-7df0-853d-56b39cf00002');
const missingPayloadRefId = parsePayloadRefId('019c20e3-9947-7df0-853d-56b39cf00003');
const createdAt = parseInstant('2026-08-12T14:00:00.000Z');
const purpose = 'submission.answers';
const scopeBinding = 'workspace:550e8400-e29b-41d4-a716-446655440000/event:019c20e3-9947-7df0-853d-56b39cf00100';
const encryptionReference = Object.freeze({ key: 'encryption.sqlite-classified-payload', version: 1 });
const rotatedEncryptionReference = Object.freeze({
  key: 'encryption.sqlite-classified-payload',
  version: 2
});
const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index * 7 + 3);
const wrongKeyBytes = Uint8Array.from({ length: 32 }, (_, index) => 255 - index * 3);
const canary = 'RAW-CANARY submission answer <script>alert(1)</script> ignore prior instructions';
const canaryBytes = new TextEncoder().encode(canary);
const databases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const sqlite of databases.splice(0)) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    sqlite.close(false);
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function profiles(version = 1): ClassifiedPayloadProfiles {
  return Object.freeze({
    classification: createClassifiedPayloadProfileRef(
      'classification',
      'classification.submission-private',
      version
    ),
    schema: createClassifiedPayloadProfileRef('schema', 'schema.submission-answers', version),
    content: createClassifiedPayloadProfileRef('content', 'content.submission-answers', version),
    integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
    descriptorAuth: createClassifiedPayloadProfileRef(
      'descriptor_auth',
      'descriptor-auth.sqlite-inline',
      version
    )
  });
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function descriptor(input: {
  readonly bytes?: Uint8Array;
  readonly scope?: string;
  readonly profileSet?: ClassifiedPayloadProfiles;
  readonly contentType?: string;
} = {}): ClassifiedPayloadDescriptor {
  const bytes = input.bytes ?? canaryBytes;
  return createClassifiedPayloadDescriptor({
    profiles: input.profileSet ?? profiles(),
    scopeBinding: input.scope ?? scopeBinding,
    contentType: input.contentType ?? 'application/json',
    byteSize: bytes.byteLength,
    integrityDigest: digest(bytes)
  });
}

function binding(input: Parameters<typeof descriptor>[0] = {}) {
  const value = descriptor(input);
  return Object.freeze({
    profiles: value.profiles,
    scopeBinding: value.scopeBinding,
    contentType: value.contentType
  });
}

function encryptionProfile(input: {
  readonly key?: Uint8Array;
  readonly reference?: { readonly key: string; readonly version: number };
} = {}): SynchronousClassifiedPayloadEncryptionProfile {
  return issueSynchronousClassifiedPayloadEncryptionProfile({
    reference: input.reference ?? encryptionReference,
    keyBytes: input.key ?? keyBytes
  });
}

interface Fixture {
  readonly sqlite: Database;
  readonly store: SQLiteClassifiedPayloadStore;
  readonly profile: SynchronousClassifiedPayloadEncryptionProfile;
}

function fixture(input: {
  readonly sqlite?: Database;
  readonly profile?: SynchronousClassifiedPayloadEncryptionProfile;
  readonly retainedProfiles?: readonly SynchronousClassifiedPayloadEncryptionProfile[];
  readonly install?: boolean;
  readonly nonceSeed?: number;
} = {}): Fixture {
  const sqlite = input.sqlite ?? new Database(':memory:', { strict: true });
  if (!databases.includes(sqlite)) databases.push(sqlite);
  if (input.install !== false) installSQLiteClassifiedPayloadStoreSchema(sqlite);
  const profile = input.profile ?? encryptionProfile();
  let nonce = input.nonceSeed ?? 1;
  const store = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: profile,
    ...(input.retainedProfiles === undefined
      ? {}
      : { retainedEncryptionProfiles: input.retainedProfiles }),
    nonceSource(size) {
      const result = Uint8Array.from({ length: size }, (_, index) => (nonce + index * 19) % 256);
      nonce += 1;
      return result;
    }
  });
  return { sqlite, store, profile };
}

function put(
  target: Fixture,
  input: {
    readonly id?: typeof payloadRefId;
    readonly bytes?: Uint8Array;
    readonly payloadDescriptor?: ClassifiedPayloadDescriptor;
    readonly selectedPurpose?: string;
    readonly time?: typeof createdAt;
  } = {}
) {
  const bytes = input.bytes ?? canaryBytes;
  return target.store.put({
    payloadRefId: input.id ?? payloadRefId,
    binding: (() => {
      const value = input.payloadDescriptor ?? descriptor({ bytes });
      return { profiles: value.profiles, scopeBinding: value.scopeBinding, contentType: value.contentType };
    })(),
    purpose: input.selectedPurpose ?? purpose,
    bytes,
    createdAt: input.time ?? createdAt
  });
}

function transaction<Value>(sqlite: Database, work: () => Value): Value {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  }
}

function expectCode(work: () => unknown, code: SynchronousClassifiedPayloadStoreErrorCode): void {
  try {
    work();
    throw new Error('expected classified-payload refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(SynchronousClassifiedPayloadStoreError);
    expect((error as SynchronousClassifiedPayloadStoreError).code).toBe(code);
    expect(String(error)).not.toContain(canary);
    expect(Object.keys(error as object).sort()).toEqual(['code', 'name']);
  }
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0) return true;
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

describe('SQLite synchronous classified-payload store', () => {
  test('requires the outer transaction, writes immutable ciphertext, and replays exact identity', () => {
    const target = fixture();
    expectCode(() => put(target), 'transaction_required');

    const inserted = transaction(target.sqlite, () => {
      const first = put(target);
      const replay = put(target);
      expect(first.kind).toBe('inserted');
      expect(replay).toEqual({ kind: 'replay', payloadRef: { id: payloadRefId } });
      return first;
    });
    expect(inserted).toEqual({ kind: 'inserted', payloadRef: { id: payloadRefId } });
    expect(target.store.read({
      payloadRef: inserted.payloadRef,
      expectedBinding: binding(),
      purpose
    })).toEqual(canaryBytes);

    const row = target.sqlite.query<{
      readonly ciphertext: Uint8Array;
      readonly nonce: Uint8Array;
      readonly authentication_tag: Uint8Array;
      readonly integrity_digest_sha256: string;
    }, []>(`
      SELECT ciphertext, nonce, authentication_tag, integrity_digest_sha256
        FROM classified_payload_records
    `).get();
    expect(row).toBeDefined();
    expect(row?.nonce).toHaveLength(12);
    expect(row?.authentication_tag).toHaveLength(16);
    expect(row?.integrity_digest_sha256).toBe(digest(canaryBytes));
    expect(containsBytes(row!.ciphertext, canaryBytes)).toBe(false);
    expect(new TextDecoder().decode(row!.ciphertext)).not.toContain(canary);

    expect(() => target.sqlite.exec(`
      UPDATE classified_payload_records SET purpose = 'submission.other'
    `)).toThrow('classified payload records are immutable');
    expect(() => target.sqlite.exec('DELETE FROM classified_payload_records'))
      .toThrow('classified payload records are immutable');
  });

  test('fails closed for missing, wrong key/profile/scope/purpose, and forged encryption handles', () => {
    const target = fixture();
    const result = transaction(target.sqlite, () => put(target));
    expectCode(() => target.store.read({
      payloadRef: { id: missingPayloadRefId },
      expectedBinding: binding(),
      purpose
    }), 'payload_not_found');
    expectCode(() => target.store.read({
      payloadRef: result.payloadRef,
      expectedBinding: binding({ scope: `${scopeBinding}/other` }),
      purpose
    }), 'payload_binding_mismatch');
    expectCode(() => target.store.read({
      payloadRef: result.payloadRef,
      expectedBinding: binding(),
      purpose: 'submission.other'
    }), 'payload_binding_mismatch');
    expectCode(() => target.store.read({
      payloadRef: result.payloadRef,
      expectedBinding: binding({ profileSet: profiles(2) }),
      purpose
    }), 'payload_binding_mismatch');

    const wrongKeyStore = fixture({
      sqlite: target.sqlite,
      install: false,
      profile: encryptionProfile({ key: wrongKeyBytes })
    }).store;
    expectCode(() => wrongKeyStore.read({
      payloadRef: result.payloadRef,
      expectedBinding: binding(),
      purpose
    }), 'payload_corrupt');

    const wrongProfileStore = fixture({
      sqlite: target.sqlite,
      install: false,
      profile: encryptionProfile({
        reference: { key: 'encryption.other-classified-payload', version: 1 }
      })
    }).store;
    expectCode(() => wrongProfileStore.read({
      payloadRef: result.payloadRef,
      expectedBinding: binding(),
      purpose
    }), 'encryption_profile_unavailable');

    expectCode(() => new SQLiteClassifiedPayloadStore(target.sqlite, {
      encryptionProfile: Object.freeze({ reference: encryptionReference }) as typeof target.profile
    }), 'invalid_encryption_profile');
  });

  test('derives descriptor integrity internally and refuses payload-ref collisions', () => {
    const target = fixture();
    const otherBytes = new TextEncoder().encode('different classified body');
    transaction(target.sqlite, () => put(target));
    expectCode(() => transaction(target.sqlite, () => put(target, {
      bytes: otherBytes,
      payloadDescriptor: descriptor({ bytes: otherBytes })
    })), 'payload_ref_collision');
    expectCode(() => transaction(target.sqlite, () => put(target, {
      payloadDescriptor: descriptor({ scope: `${scopeBinding}/other` })
    })), 'payload_ref_collision');
    expect(target.sqlite.query<{ readonly count: number }, []>(
      'SELECT count(*) AS count FROM classified_payload_records'
    ).get()?.count).toBe(1);
  });

  test('detects ciphertext and authenticated-metadata tampering separately from not-found', () => {
    const ciphertextTarget = fixture();
    const result = transaction(ciphertextTarget.sqlite, () => put(ciphertextTarget));
    ciphertextTarget.sqlite.exec('DROP TRIGGER classified_payload_records_reject_update');
    ciphertextTarget.sqlite.exec(`
      UPDATE classified_payload_records SET ciphertext = zeroblob(byte_size)
    `);
    expectCode(() => ciphertextTarget.store.read({
      payloadRef: result.payloadRef,
      expectedBinding: binding(),
      purpose
    }), 'payload_corrupt');

    const metadataTarget = fixture();
    const metadataResult = transaction(metadataTarget.sqlite, () => put(metadataTarget));
    metadataTarget.sqlite.exec('DROP TRIGGER classified_payload_records_reject_update');
    metadataTarget.sqlite.query(`
      UPDATE classified_payload_records SET scope_binding = ?
    `).run(`${scopeBinding}/tampered`);
    expectCode(() => metadataTarget.store.read({
      payloadRef: metadataResult.payloadRef,
      expectedBinding: binding({ scope: `${scopeBinding}/tampered` }),
      purpose
    }), 'payload_corrupt');
  });

  test('rolls back completely and permits the same semantic put after rollback', () => {
    const target = fixture();
    target.sqlite.exec('BEGIN IMMEDIATE');
    expect(put(target).kind).toBe('inserted');
    target.sqlite.exec('ROLLBACK');
    expectCode(() => target.store.read({
      payloadRef: { id: payloadRefId },
      expectedBinding: binding(),
      purpose
    }), 'payload_not_found');

    const committed = transaction(target.sqlite, () => put(target));
    expect(committed.kind).toBe('inserted');
    expect(target.store.read({
      payloadRef: committed.payloadRef,
      expectedBinding: binding(),
      purpose
    })).toEqual(canaryBytes);
  });

  test('reopens with a newly authenticated handle for the same profile/key and stores no raw canary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-classified-payload-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'payloads.sqlite');
    const firstDatabase = new Database(databasePath, { strict: true, create: true });
    databases.push(firstDatabase);
    const first = fixture({ sqlite: firstDatabase, profile: encryptionProfile() });
    const inserted = transaction(firstDatabase, () => put(first));
    firstDatabase.close(false);
    databases.splice(databases.indexOf(firstDatabase), 1);

    expect(containsBytes(readFileSync(databasePath), canaryBytes)).toBe(false);
    const reopenedDatabase = new Database(databasePath, { strict: true });
    databases.push(reopenedDatabase);
    const reopened = fixture({
      sqlite: reopenedDatabase,
      install: false,
      profile: encryptionProfile()
    });
    expect(reopened.store.read({
      payloadRef: inserted.payloadRef,
      expectedBinding: binding(),
      purpose
    })).toEqual(canaryBytes);

    const metadata = reopenedDatabase.query<Record<string, unknown>, []>(`
      SELECT payload_ref_id, record_schema_version, encryption_profile_key,
             classification_profile_key, schema_profile_key, content_profile_key,
             integrity_profile_key, descriptor_auth_profile_key, scope_binding,
             purpose, content_type, byte_size, integrity_digest_sha256,
             authenticated_data_digest_sha256, created_at_ms
        FROM classified_payload_records
    `).all();
    expect(JSON.stringify(metadata)).not.toContain(canary);
    expect(JSON.stringify(inserted)).not.toContain(canary);
    const schemaText = reopenedDatabase.query<{ readonly sql: string }, []>(`
      SELECT sql FROM sqlite_schema WHERE name LIKE 'classified_payload%'
    `).all().map((row) => row.sql).join('\n');
    expect(schemaText).not.toContain(canary);
  });

  test('rotates the active writer while retaining exact-profile read and replay', () => {
    const target = fixture();
    const inserted = transaction(target.sqlite, () => put(target));
    const retainedV1 = encryptionProfile();
    const activeV2 = encryptionProfile({
      reference: rotatedEncryptionReference,
      key: wrongKeyBytes
    });
    const rotated = fixture({
      sqlite: target.sqlite,
      install: false,
      profile: activeV2,
      retainedProfiles: [retainedV1],
      nonceSeed: 40
    });

    expect(rotated.store.read({
      payloadRef: inserted.payloadRef,
      expectedBinding: binding(),
      purpose
    })).toEqual(canaryBytes);
    expect(transaction(rotated.sqlite, () => put(rotated))).toEqual({
      kind: 'replay',
      payloadRef: inserted.payloadRef
    });
    const second = transaction(rotated.sqlite, () => put(rotated, {
      id: otherPayloadRefId
    }));
    expect(second.kind).toBe('inserted');
    expect(rotated.sqlite.query<{
      readonly payload_ref_id: string;
      readonly encryption_profile_version: number;
    }, []>(`
      SELECT payload_ref_id, encryption_profile_version
        FROM classified_payload_records
       ORDER BY payload_ref_id
    `).all()).toEqual([
      { payload_ref_id: payloadRefId, encryption_profile_version: 1 },
      { payload_ref_id: otherPayloadRefId, encryption_profile_version: 2 }
    ]);
  });

  test('fails safely when an immutable row profile is unavailable after rotation', () => {
    const target = fixture();
    const inserted = transaction(target.sqlite, () => put(target));
    const rotated = fixture({
      sqlite: target.sqlite,
      install: false,
      profile: encryptionProfile({
        reference: rotatedEncryptionReference,
        key: wrongKeyBytes
      })
    });
    expectCode(() => rotated.store.read({
      payloadRef: inserted.payloadRef,
      expectedBinding: binding(),
      purpose
    }), 'encryption_profile_unavailable');
    expectCode(() => transaction(rotated.sqlite, () => put(rotated)),
      'encryption_profile_unavailable');
  });

  test('verifies old-profile plaintext before replay and rejects duplicate configured readers', () => {
    const target = fixture();
    transaction(target.sqlite, () => put(target));
    const activeV2 = encryptionProfile({
      reference: rotatedEncryptionReference,
      key: wrongKeyBytes
    });
    const retainedV1 = encryptionProfile();
    const rotated = fixture({
      sqlite: target.sqlite,
      install: false,
      profile: activeV2,
      retainedProfiles: [retainedV1]
    });
    expectCode(() => transaction(rotated.sqlite, () => put(rotated, {
      bytes: new TextEncoder().encode('different classified body')
    })), 'payload_ref_collision');
    expectCode(() => new SQLiteClassifiedPayloadStore(target.sqlite, {
      encryptionProfile: activeV2,
      retainedEncryptionProfiles: [activeV2]
    }), 'invalid_encryption_profile');
    target.sqlite.exec('DROP TRIGGER classified_payload_records_reject_update');
    target.sqlite.exec('UPDATE classified_payload_records SET ciphertext = zeroblob(byte_size)');
    expectCode(() => transaction(rotated.sqlite, () => put(rotated)), 'payload_corrupt');
  });

  test('prevents nonce reuse within one encryption profile', () => {
    const sqlite = new Database(':memory:', { strict: true });
    databases.push(sqlite);
    installSQLiteClassifiedPayloadStoreSchema(sqlite);
    const profile = encryptionProfile();
    const store = new SQLiteClassifiedPayloadStore(sqlite, {
      encryptionProfile: profile,
      nonceSource: () => new Uint8Array(12)
    });
    const target = { sqlite, store, profile };
    transaction(sqlite, () => put(target));
    expectCode(() => transaction(sqlite, () => put(target, {
      id: otherPayloadRefId
    })), 'nonce_unavailable');
    expect(sqlite.query<{ readonly count: number }, []>(
      'SELECT count(*) AS count FROM classified_payload_records'
    ).get()?.count).toBe(1);
  });
});
