import type { FileScopeDto } from '@jooevents/contracts/files';

/**
 * The streaming half of the blob driver seam. It deliberately mirrors the
 * whole-buffer avatar `BlobStore` posture — provider-named adapters behind one
 * port — but carries bytes as an async iterable so uploads stream through the
 * app (D2) with the SHA-256 and the hard byte cap computed inline. The
 * filesystem adapter is the v1 driver; an S3/R2 adapter implements this same
 * port later without changing any caller.
 */
export interface FileBlobStreamingStore {
  readonly provider: string;
  /**
   * Streams `bytes` to storage under `key`, hashing inline and refusing the
   * moment the hard cap is crossed. A refusal leaves no readable object at
   * `key`. The returned digest is of the exact stored bytes.
   */
  writeStream(input: {
    readonly key: string;
    readonly bytes: AsyncIterable<Uint8Array>;
    readonly maximumByteSize: number;
  }): Promise<FileBlobWriteOutcome>;
  openReadStream(key: string): Promise<FileBlobReadOutcome>;
  /** Deleting an absent object reports `deleted: false`; it never throws for absence. */
  deleteObject(key: string): Promise<{ readonly deleted: boolean }>;
}

export type FileBlobWriteOutcome =
  | { readonly kind: 'stored'; readonly byteSize: number; readonly sha256: string }
  | { readonly kind: 'refused'; readonly code: 'byte_cap_exceeded' | 'empty_stream' };

export type FileBlobReadOutcome =
  | {
      readonly kind: 'found';
      readonly byteSize: number;
      readonly bytes: AsyncIterable<Uint8Array>;
    }
  | { readonly kind: 'missing' };

const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9/_-]{0,510}[a-z0-9]$/;

export class FileStorageKeyError extends TypeError {
  constructor(readonly key: string) {
    super('file_storage_key_invalid');
    this.name = 'FileStorageKeyError';
  }
}

/** Storage keys are minted server-side and never derived from a display filename. */
export function assertFileStorageKey(key: string): string {
  if (typeof key !== 'string'
      || !STORAGE_KEY_PATTERN.test(key)
      || key.includes('//')
      || key.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new FileStorageKeyError(key);
  }
  return key;
}

/** The canonical key layout: event-scoped, keyed by the upload intent identity. */
export function newFileStorageKey(scope: FileScopeDto, intentId: string): string {
  return assertFileStorageKey(`files/${scope.workspaceId}/${scope.eventId}/${intentId}`);
}

/** Wraps whole buffers for ports that stream. */
export async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/** Collects a bounded stream into one buffer; refuses past `maximumByteSize`. */
export async function collectBounded(
  bytes: AsyncIterable<Uint8Array>,
  maximumByteSize: number
): Promise<{ readonly kind: 'collected'; readonly bytes: Uint8Array } | { readonly kind: 'refused'; readonly code: 'byte_cap_exceeded' | 'empty_stream' }> {
  if (!Number.isSafeInteger(maximumByteSize) || maximumByteSize <= 0) {
    throw new TypeError('file_blob_maximum_byte_size_invalid');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of bytes) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('file_blob_chunk_invalid');
    total += chunk.byteLength;
    if (total > maximumByteSize) return { kind: 'refused', code: 'byte_cap_exceeded' };
    chunks.push(chunk);
  }
  if (total === 0) return { kind: 'refused', code: 'empty_stream' };
  const collected = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    collected.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'collected', bytes: collected };
}
