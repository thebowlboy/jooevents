import type { Database } from 'bun:sqlite';
import {
  createSecretReference,
  type SecretReference,
  type SecretStore,
  type SecretStoreAdapterRef
} from '@jooevents/application';
import { canonicalJsonText } from '@jooevents/kernel';

interface SecretRow {
  readonly reference_id: string;
  readonly version: number;
  readonly adapter_key: string;
  readonly adapter_version: number;
  readonly purpose: string;
  readonly scope_binding: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly is_current: number;
  readonly revoked_at_ms: number | null;
}

const encoder = new TextEncoder();

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function sameAdapter(left: SecretStoreAdapterRef, right: SecretStoreAdapterRef): boolean {
  return left.key === right.key && left.version === right.version;
}

function associatedData(input: Readonly<{
  referenceId: string;
  version: number;
  adapter: SecretStoreAdapterRef;
  purpose: string;
  scopeBinding: string;
}>): Uint8Array<ArrayBuffer> {
  return ownedBytes(encoder.encode(canonicalJsonText({
    referenceId: input.referenceId,
    version: input.version,
    adapterKey: input.adapter.key,
    adapterVersion: input.adapter.version,
    purpose: input.purpose,
    scopeBinding: input.scopeBinding
  })));
}

/** Retained AES-GCM SecretStore. Key material is supplied by server composition. */
export class SQLiteSecretStore implements SecretStore {
  readonly #keyBytes: Uint8Array<ArrayBuffer>;

  constructor(
    private readonly sqlite: Database,
    private readonly options: Readonly<{
      adapter: SecretStoreAdapterRef;
      keyBytes: Uint8Array;
      nowMs?: () => number;
      newReferenceId?: () => string;
    }>
  ) {
    if (options.keyBytes.byteLength !== 32) throw new TypeError('secret_store_key_invalid');
    this.#keyBytes = ownedBytes(options.keyBytes);
  }

  async #key(): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', this.#keyBytes, { name: 'AES-GCM' }, false, [
      'encrypt', 'decrypt'
    ]);
  }

  async #seal(input: Readonly<{
    referenceId: string;
    version: number;
    purpose: string;
    scopeBinding: string;
    secret: Uint8Array;
  }>): Promise<Readonly<{ nonce: Uint8Array; ciphertext: Uint8Array }>> {
    if (input.secret.byteLength < 1 || input.secret.byteLength > 1_048_560) {
      throw new TypeError('secret_store_secret_size_invalid');
    }
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: associatedData({
        referenceId: input.referenceId,
        version: input.version,
        adapter: this.options.adapter,
        purpose: input.purpose,
        scopeBinding: input.scopeBinding
      }),
      tagLength: 128
    }, await this.#key(), ownedBytes(input.secret)));
    return Object.freeze({ nonce: ownedBytes(nonce), ciphertext });
  }

  async create(input: Parameters<SecretStore['create']>[0]): Promise<SecretReference> {
    if (!sameAdapter(input.adapter, this.options.adapter)) {
      throw new TypeError('secret_store_adapter_mismatch');
    }
    const referenceId = (this.options.newReferenceId ?? (() => `secret:${crypto.randomUUID()}`))();
    const reference = createSecretReference({
      id: referenceId,
      version: 1,
      adapter: input.adapter,
      purpose: input.purpose,
      scopeBinding: input.scopeBinding
    });
    const sealed = await this.#seal({
      referenceId,
      version: 1,
      purpose: input.purpose,
      scopeBinding: input.scopeBinding,
      secret: input.secret
    });
    this.sqlite.query(`
      INSERT INTO secret_store_versions(
        reference_id, version, adapter_key, adapter_version, purpose,
        scope_binding, nonce, ciphertext, is_current, created_at_ms
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      referenceId,
      input.adapter.key,
      input.adapter.version,
      input.purpose,
      input.scopeBinding,
      sealed.nonce,
      sealed.ciphertext,
      (this.options.nowMs ?? Date.now)()
    );
    return reference;
  }

  async rotate(input: Parameters<SecretStore['rotate']>[0]): Promise<SecretReference> {
    if (!sameAdapter(input.reference.adapter, this.options.adapter)
      || input.reference.version !== input.expectedVersion) {
      throw new TypeError('stale_secret_reference');
    }
    const nextVersion = Number(input.expectedVersion) + 1;
    const sealed = await this.#seal({
      referenceId: input.reference.id,
      version: nextVersion,
      purpose: input.reference.purpose,
      scopeBinding: input.reference.scopeBinding,
      secret: input.secret
    });
    this.sqlite.transaction(() => {
      const current = this.sqlite.query<SecretRow, [string, number]>(`
        SELECT reference_id, version, adapter_key, adapter_version, purpose,
               scope_binding, nonce, ciphertext, is_current, revoked_at_ms
          FROM secret_store_versions
         WHERE reference_id = ? AND version = ?
      `).get(input.reference.id, input.expectedVersion);
      if (!current || current.is_current !== 1 || current.revoked_at_ms !== null
        || current.adapter_key !== input.reference.adapter.key
        || current.adapter_version !== input.reference.adapter.version
        || current.purpose !== input.reference.purpose
        || current.scope_binding !== input.reference.scopeBinding) {
        throw new TypeError('stale_secret_reference');
      }
      this.sqlite.query(`
        UPDATE secret_store_versions SET is_current = 0
         WHERE reference_id = ? AND version = ? AND is_current = 1
      `).run(input.reference.id, input.expectedVersion);
      this.sqlite.query(`
        INSERT INTO secret_store_versions(
          reference_id, version, adapter_key, adapter_version, purpose,
          scope_binding, nonce, ciphertext, is_current, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        input.reference.id,
        nextVersion,
        input.reference.adapter.key,
        input.reference.adapter.version,
        input.reference.purpose,
        input.reference.scopeBinding,
        sealed.nonce,
        sealed.ciphertext,
        (this.options.nowMs ?? Date.now)()
      );
    })();
    return createSecretReference({
      id: input.reference.id,
      version: nextVersion,
      adapter: input.reference.adapter,
      purpose: input.reference.purpose,
      scopeBinding: input.reference.scopeBinding
    });
  }

  async revoke(input: Parameters<SecretStore['revoke']>[0]): Promise<void> {
    if (input.reference.version !== input.expectedVersion) {
      throw new TypeError('stale_secret_reference');
    }
    const updated = this.sqlite.query(`
      UPDATE secret_store_versions
         SET is_current = 0, revoked_at_ms = ?
       WHERE reference_id = ? AND version = ? AND is_current = 1
         AND revoked_at_ms IS NULL
    `).run(
      (this.options.nowMs ?? Date.now)(),
      input.reference.id,
      input.expectedVersion
    );
    if (updated.changes !== 1) throw new TypeError('stale_secret_reference');
  }

  async withSecret<Value>(input: {
    readonly reference: SecretReference;
    readonly purpose: string;
    readonly scopeBinding: string;
    readonly consume: (secret: Uint8Array) => Value | Promise<Value>;
  }): Promise<Value> {
    const row = this.sqlite.query<SecretRow, [string, number]>(`
      SELECT reference_id, version, adapter_key, adapter_version, purpose,
             scope_binding, nonce, ciphertext, is_current, revoked_at_ms
        FROM secret_store_versions
       WHERE reference_id = ? AND version = ?
    `).get(input.reference.id, input.reference.version);
    if (!row || row.revoked_at_ms !== null
      || row.adapter_key !== input.reference.adapter.key
      || row.adapter_version !== input.reference.adapter.version
      || row.purpose !== input.purpose
      || row.scope_binding !== input.scopeBinding
      || input.reference.purpose !== input.purpose
      || input.reference.scopeBinding !== input.scopeBinding) {
      throw new TypeError('secret_unavailable');
    }
    let plaintext: Uint8Array;
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: ownedBytes(row.nonce),
        additionalData: associatedData({
          referenceId: row.reference_id,
          version: row.version,
          adapter: input.reference.adapter,
          purpose: row.purpose,
          scopeBinding: row.scope_binding
        }),
        tagLength: 128
      }, await this.#key(), ownedBytes(row.ciphertext)));
    } catch {
      throw new TypeError('secret_unavailable');
    }
    try {
      return await input.consume(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }
}
