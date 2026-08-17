import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSecretStoreAdapterRef } from '@jooevents/application';
import { installSQLiteAirtableSync } from './airtable-sync';
import { SQLiteSecretStore } from './sqlite-secret-store';

describe('SQLite retained secret store', () => {
  test('encrypts exact versions, rotates atomically, and revokes the active head', async () => {
    const sqlite = new Database(':memory:', { strict: true });
    installSQLiteAirtableSync(sqlite);
    const adapter = createSecretStoreAdapterRef('secret.sqlite.aes-gcm', 1);
    let nowMs = 1_000;
    const store = new SQLiteSecretStore(sqlite, {
      adapter,
      keyBytes: new Uint8Array(32).fill(7),
      nowMs: () => nowMs,
      newReferenceId: () => 'secret:018f0f64-4d6c-7b2f-8a1e-1234567890ab'
    });
    const firstText = 'airtable-access-and-refresh-v1';
    const first = await store.create({
      adapter,
      purpose: 'airtable.oauth.grant',
      scopeBinding: 'connection-1',
      secret: new TextEncoder().encode(firstText)
    });
    expect(await store.withSecret({
      reference: first,
      purpose: first.purpose,
      scopeBinding: first.scopeBinding,
      consume: (secret) => new TextDecoder().decode(secret)
    })).toBe(firstText);
    expect(JSON.stringify(sqlite.query(`
      SELECT hex(nonce) AS nonce, hex(ciphertext) AS ciphertext
        FROM secret_store_versions
    `).all())).not.toContain(firstText);

    nowMs = 2_000;
    const second = await store.rotate({
      reference: first,
      expectedVersion: first.version,
      secret: new TextEncoder().encode('airtable-access-and-refresh-v2')
    });
    expect(Number(second.version)).toBe(2);
    expect(await store.withSecret({
      reference: first,
      purpose: first.purpose,
      scopeBinding: first.scopeBinding,
      consume: (secret) => new TextDecoder().decode(secret)
    })).toBe(firstText);
    expect(await store.withSecret({
      reference: second,
      purpose: second.purpose,
      scopeBinding: second.scopeBinding,
      consume: (secret) => new TextDecoder().decode(secret)
    })).toBe('airtable-access-and-refresh-v2');

    nowMs = 3_000;
    await store.revoke({ reference: second, expectedVersion: second.version });
    await expect(store.withSecret({
      reference: second,
      purpose: second.purpose,
      scopeBinding: second.scopeBinding,
      consume: () => undefined
    })).rejects.toThrow('unavailable');
    expect(sqlite.query<{ readonly count: number }, []>(`
      SELECT count(*) AS count FROM secret_store_versions
    `).get()).toEqual({ count: 2 });
    sqlite.close();
  });

  test('fails closed when retained ciphertext is opened with the wrong key', async () => {
    const sqlite = new Database(':memory:', { strict: true });
    installSQLiteAirtableSync(sqlite);
    const adapter = createSecretStoreAdapterRef('secret.sqlite.aes-gcm', 1);
    const original = new SQLiteSecretStore(sqlite, {
      adapter,
      keyBytes: new Uint8Array(32).fill(1)
    });
    const reference = await original.create({
      adapter,
      purpose: 'airtable.oauth.attempt',
      scopeBinding: 'connection-1',
      secret: new TextEncoder().encode('pkce-verifier')
    });
    const restartedWrong = new SQLiteSecretStore(sqlite, {
      adapter,
      keyBytes: new Uint8Array(32).fill(2)
    });
    await expect(restartedWrong.withSecret({
      reference,
      purpose: reference.purpose,
      scopeBinding: reference.scopeBinding,
      consume: () => undefined
    })).rejects.toThrow('unavailable');
    sqlite.close();
  });
});
