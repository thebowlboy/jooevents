import {
  assertFileStorageKey,
  type FileBlobReadOutcome,
  type FileBlobStreamingStore,
  type FileBlobWriteOutcome
} from '@jooevents/files/blob';
import { createHash } from 'node:crypto';

export interface StreamingSha256 {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<string>;
  abort(reason?: unknown): Promise<void>;
}

export type StreamingSha256Factory = () => StreamingSha256;

const R2_MULTIPART_PART_BYTES = 5 * 1024 * 1024;

function createWorkerdSha256(): StreamingSha256 {
  const digest = createHash('sha256');
  let finished = false;
  return Object.freeze({
    async write(chunk: Uint8Array): Promise<void> {
      if (finished) throw new TypeError('file_blob_sha256_already_finished');
      digest.update(chunk);
    },
    async finish(): Promise<string> {
      if (finished) throw new TypeError('file_blob_sha256_already_finished');
      finished = true;
      return digest.digest('hex');
    },
    async abort(): Promise<void> {
      finished = true;
    }
  });
}

/** Cloudflare R2 implementation of the same streaming blob seam as the Bun filesystem driver. */
export function createR2FileBlobStore(input: {
  readonly bucket: R2Bucket;
  readonly createSha256?: StreamingSha256Factory;
}): FileBlobStreamingStore {
  const createSha256 = input.createSha256 ?? createWorkerdSha256;
  return Object.freeze({
    provider: 'cloudflare-r2',

    async writeStream({ key, bytes, maximumByteSize }: Parameters<FileBlobStreamingStore['writeStream']>[0]): Promise<FileBlobWriteOutcome> {
      const safeKey = assertFileStorageKey(key);
      if (!Number.isSafeInteger(maximumByteSize) || maximumByteSize <= 0) {
        throw new TypeError('file_blob_maximum_byte_size_invalid');
      }
      const digest = createSha256();
      let byteSize = 0;
      const upload = await input.bucket.createMultipartUpload(safeKey);
      const uploadedParts: R2UploadedPart[] = [];
      const partCapacity = Math.min(R2_MULTIPART_PART_BYTES, maximumByteSize);
      let part = new Uint8Array(partCapacity);
      let partBytes = 0;
      let completed = false;
      const abort = async (reason?: unknown): Promise<void> => {
        await digest.abort(reason);
        if (completed) return;
        try {
          await upload.abort();
        } catch {
          // Preserve the typed refusal or storage error that caused cleanup.
        }
      };
      try {
        for await (const chunk of bytes) {
          if (!(chunk instanceof Uint8Array)) throw new TypeError('file_blob_chunk_invalid');
          byteSize += chunk.byteLength;
          if (byteSize > maximumByteSize) {
            await abort('byte_cap_exceeded');
            return Object.freeze({ kind: 'refused', code: 'byte_cap_exceeded' });
          }
          await digest.write(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const copied = Math.min(partCapacity - partBytes, chunk.byteLength - offset);
            part.set(chunk.subarray(offset, offset + copied), partBytes);
            offset += copied;
            partBytes += copied;
            if (partBytes === partCapacity) {
              uploadedParts.push(await upload.uploadPart(uploadedParts.length + 1, part));
              part = new Uint8Array(partCapacity);
              partBytes = 0;
            }
          }
        }
        if (byteSize === 0) {
          await abort('empty_stream');
          return Object.freeze({ kind: 'refused', code: 'empty_stream' });
        }
        if (partBytes > 0) {
          uploadedParts.push(await upload.uploadPart(
            uploadedParts.length + 1,
            part.subarray(0, partBytes)
          ));
        }
        const object = await upload.complete(uploadedParts);
        completed = true;
        if (object.size !== byteSize) {
          await input.bucket.delete(safeKey);
          throw new TypeError('file_blob_r2_size_mismatch');
        }
        return Object.freeze({
          kind: 'stored',
          byteSize,
          sha256: await digest.finish()
        });
      } catch (error) {
        await abort(error);
        throw error;
      }
    },

    async openReadStream(key: string): Promise<FileBlobReadOutcome> {
      const object = await input.bucket.get(assertFileStorageKey(key));
      if (object === null) return Object.freeze({ kind: 'missing' });
      return Object.freeze({
        kind: 'found',
        byteSize: object.size,
        bytes: object.body as unknown as AsyncIterable<Uint8Array>
      });
    },

    async deleteObject(key: string): Promise<{ readonly deleted: boolean }> {
      const safeKey = assertFileStorageKey(key);
      const existing = await input.bucket.head(safeKey);
      if (existing === null) return Object.freeze({ deleted: false });
      await input.bucket.delete(safeKey);
      return Object.freeze({ deleted: true });
    }
  });
}
