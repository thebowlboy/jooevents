import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createR2FileBlobStore,
  type StreamingSha256,
  type StreamingSha256Factory
} from './r2-file-blob-store';

function nodeSha256Factory(): StreamingSha256Factory {
  return (): StreamingSha256 => {
    const hash = createHash('sha256');
    return {
      async write(chunk) { hash.update(chunk); },
      async finish() { return hash.digest('hex'); },
      async abort() {}
    };
  };
}

class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  abortedUploads = 0;

  async createMultipartUpload(key: string): Promise<R2MultipartUpload> {
    const bucket = this;
    const parts = new Map<number, Uint8Array>();
    let aborted = false;
    return {
      key,
      uploadId: 'fake-upload',
      async uploadPart(partNumber: number, value: ArrayBufferView) {
        if (aborted) throw new Error('aborted');
        parts.set(partNumber, new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
        return { partNumber, etag: `part-${partNumber}` };
      },
      async complete(uploaded: R2UploadedPart[]) {
        if (aborted) throw new Error('aborted');
        const total = uploaded.reduce((size, item) => size + (parts.get(item.partNumber)?.byteLength ?? 0), 0);
        const stored = new Uint8Array(total);
        let offset = 0;
        for (const item of uploaded) {
          const bytes = parts.get(item.partNumber)!;
          stored.set(bytes, offset);
          offset += bytes.byteLength;
        }
        bucket.objects.set(key, stored);
        return { size: total } as R2Object;
      },
      async abort() {
        aborted = true;
        bucket.abortedUploads += 1;
      }
    } as R2MultipartUpload;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) return null;
    return {
      size: bytes.byteLength,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        }
      })
    } as R2ObjectBody;
  }

  async head(key: string): Promise<R2Object | null> {
    const bytes = this.objects.get(key);
    return bytes === undefined ? null : ({ size: bytes.byteLength } as R2Object);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

async function collect(bytes: AsyncIterable<Uint8Array>): Promise<string> {
  const values: number[] = [];
  for await (const chunk of bytes) values.push(...chunk);
  return new TextDecoder().decode(new Uint8Array(values));
}

describe('R2 streaming blob store', () => {
  test('streams byte-exact content while enforcing the inline SHA-256', async () => {
    const bucket = new FakeR2Bucket();
    const store = createR2FileBlobStore({
      bucket: bucket as unknown as R2Bucket,
      createSha256: nodeSha256Factory()
    });
    const result = await store.writeStream({
      key: 'files/workspace/event/intent',
      bytes: chunks('hello ', 'from ', 'R2'),
      maximumByteSize: 1024
    });
    const payload = 'hello from R2';
    expect(result).toEqual({
      kind: 'stored',
      byteSize: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex')
    });
    const opened = await store.openReadStream('files/workspace/event/intent');
    expect(opened.kind).toBe('found');
    if (opened.kind === 'found') expect(await collect(opened.bytes)).toBe(payload);
  });

  test('refuses an empty stream and the first chunk over the cap without an object', async () => {
    const bucket = new FakeR2Bucket();
    const store = createR2FileBlobStore({
      bucket: bucket as unknown as R2Bucket,
      createSha256: nodeSha256Factory()
    });
    expect(await store.writeStream({ key: 'files/a/b/empty', bytes: chunks(), maximumByteSize: 2 }))
      .toEqual({ kind: 'refused', code: 'empty_stream' });
    expect(await store.writeStream({ key: 'files/a/b/large', bytes: chunks('abc'), maximumByteSize: 2 }))
      .toEqual({ kind: 'refused', code: 'byte_cap_exceeded' });
    expect(bucket.objects.size).toBe(0);
    expect(bucket.abortedUploads).toBe(2);
  });

  test('preserves missing/read/delete semantics and validates server-minted keys', async () => {
    const bucket = new FakeR2Bucket();
    const store = createR2FileBlobStore({
      bucket: bucket as unknown as R2Bucket,
      createSha256: nodeSha256Factory()
    });
    expect(await store.openReadStream('files/a/b/missing')).toEqual({ kind: 'missing' });
    expect(await store.deleteObject('files/a/b/missing')).toEqual({ deleted: false });
    await expect(store.openReadStream('../escape')).rejects.toThrow('file_storage_key_invalid');
    await store.writeStream({ key: 'files/a/b/object', bytes: chunks('x'), maximumByteSize: 2 });
    expect(await store.deleteObject('files/a/b/object')).toEqual({ deleted: true });
    expect(await store.openReadStream('files/a/b/object')).toEqual({ kind: 'missing' });
  });
});
