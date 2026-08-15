import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageKeyError, assertFileStorageKey, newFileStorageKey } from './blob';
import { createFilesystemFileBlobStore } from './filesystem-blob-store';
import { FIXTURE_SCOPE, chunked } from './test-fixtures';

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jooevents-files-blob-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function drain(bytes: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of bytes) {
    chunks.push(Uint8Array.from(chunk));
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

describe('storage keys', () => {
  test('are minted server-side, event-scoped, and traversal-free', () => {
    const key = newFileStorageKey(FIXTURE_SCOPE, '22222222-0000-4000-8000-000000000001');
    expect(key).toBe(
      `files/${FIXTURE_SCOPE.workspaceId}/${FIXTURE_SCOPE.eventId}/22222222-0000-4000-8000-000000000001`
    );
    for (const bad of ['', '/abs', 'a//b', 'a/../b', '../a', 'a/./b', 'UPPER', 'key with space', 'a'.repeat(600)]) {
      expect(() => assertFileStorageKey(bad)).toThrow(FileStorageKeyError);
    }
  });
});

describe('filesystem blob store (D1 v1 driver)', () => {
  test('streams bytes with an inline sha256 and serves them back byte-exact', async () => {
    const store = createFilesystemFileBlobStore({ rootDirectory: newRoot() });
    const payload = new TextEncoder().encode('deck bytes '.repeat(1000));
    const key = newFileStorageKey(FIXTURE_SCOPE, '22222222-0000-4000-8000-000000000002');

    const written = await store.writeStream({
      key, bytes: chunked(payload), maximumByteSize: payload.byteLength
    });
    expect(written).toEqual({
      kind: 'stored',
      byteSize: payload.byteLength,
      sha256: createHash('sha256').update(payload).digest('hex')
    });

    const read = await store.openReadStream(key);
    if (read.kind !== 'found') throw new Error('expected stored object');
    expect(read.byteSize).toBe(payload.byteLength);
    expect(Buffer.from(await drain(read.bytes)).equals(Buffer.from(payload))).toBe(true);
  });

  test('enforces the hard byte cap mid-stream and leaves no object or partial behind', async () => {
    const root = newRoot();
    const store = createFilesystemFileBlobStore({ rootDirectory: root });
    const payload = new Uint8Array(1000).fill(7);
    const key = newFileStorageKey(FIXTURE_SCOPE, '22222222-0000-4000-8000-000000000003');

    const refused = await store.writeStream({
      key, bytes: chunked(payload, 64), maximumByteSize: 999
    });
    expect(refused).toEqual({ kind: 'refused', code: 'byte_cap_exceeded' });
    expect(await store.openReadStream(key)).toEqual({ kind: 'missing' });
    const leftovers = readdirSync(root, { recursive: true }) as string[];
    expect(leftovers.filter((name) => name.includes('.partial-'))).toEqual([]);
  });

  test('refuses an empty stream instead of storing a zero-byte object', async () => {
    const store = createFilesystemFileBlobStore({ rootDirectory: newRoot() });
    const key = newFileStorageKey(FIXTURE_SCOPE, '22222222-0000-4000-8000-000000000004');
    expect(await store.writeStream({
      key, bytes: chunked(new Uint8Array(0)), maximumByteSize: 10
    })).toEqual({ kind: 'refused', code: 'empty_stream' });
    expect(await store.openReadStream(key)).toEqual({ kind: 'missing' });
  });

  test('delete is idempotent and absence is reported, never thrown', async () => {
    const root = newRoot();
    const store = createFilesystemFileBlobStore({ rootDirectory: root });
    const key = newFileStorageKey(FIXTURE_SCOPE, '22222222-0000-4000-8000-000000000005');
    await store.writeStream({
      key, bytes: chunked(new Uint8Array([1, 2, 3])), maximumByteSize: 10
    });
    expect(await store.deleteObject(key)).toEqual({ deleted: true });
    expect(await store.deleteObject(key)).toEqual({ deleted: false });
    expect(existsSync(join(root, key))).toBe(false);
  });

  test('a traversal-shaped key can never escape the root', async () => {
    const store = createFilesystemFileBlobStore({ rootDirectory: newRoot() });
    await expect(store.openReadStream('../escape')).rejects.toThrow(FileStorageKeyError);
    await expect(store.writeStream({
      key: 'a/../../escape',
      bytes: chunked(new Uint8Array([1])),
      maximumByteSize: 10
    })).rejects.toThrow(FileStorageKeyError);
  });

  test('a missing root refuses at construction, never at first write', () => {
    expect(() => createFilesystemFileBlobStore({
      rootDirectory: join(tmpdir(), 'jooevents-files-blob-test-missing-root')
    })).toThrow('root_directory_invalid');
  });
});
