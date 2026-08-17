import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  assertFileStorageKey,
  type FileBlobReadOutcome,
  type FileBlobStreamingStore,
  type FileBlobWriteOutcome
} from './blob';

export class FilesystemFileBlobStoreError extends Error {
  constructor(
    readonly code:
      | 'root_directory_invalid'
      | 'object_path_escapes_root'
      | 'object_directory_unsafe'
      | 'partial_cleanup_failed',
    cause?: unknown
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'FilesystemFileBlobStoreError';
  }
}

/**
 * The v1 blob driver behind the streaming seam: one local directory, one
 * object per storage key, crash-safe writes (temp file + fsync + rename), the
 * hard byte cap and SHA-256 enforced inline while bytes arrive. The root is
 * pinned at construction; keys can never traverse outside it.
 */
export function createFilesystemFileBlobStore(input: {
  readonly rootDirectory: string;
}): FileBlobStreamingStore {
  const root = resolveRoot(input.rootDirectory);

  function objectPath(key: string): string {
    const safeKey = assertFileStorageKey(key);
    const resolved = join(root, ...safeKey.split('/'));
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
      throw new FilesystemFileBlobStoreError('object_path_escapes_root');
    }
    return resolved;
  }

  function ensureObjectDirectory(finalPath: string): string {
    const directory = dirname(finalPath);
    const fromRoot = relative(root, directory);
    let cursor = root;
    for (const segment of fromRoot.split(sep).filter(Boolean)) {
      cursor = join(cursor, segment);
      try {
        const existing = lstatSync(cursor);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new FilesystemFileBlobStoreError('object_directory_unsafe');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(cursor, { mode: 0o700 });
        const created = lstatSync(cursor);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new FilesystemFileBlobStoreError('object_directory_unsafe');
        }
      }
      const canonical = realpathSync(cursor);
      if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
        throw new FilesystemFileBlobStoreError('object_directory_unsafe');
      }
    }
    return directory;
  }

  return Object.freeze({
    provider: 'filesystem',

    async writeStream({ key, bytes, maximumByteSize }: {
      readonly key: string;
      readonly bytes: AsyncIterable<Uint8Array>;
      readonly maximumByteSize: number;
    }): Promise<FileBlobWriteOutcome> {
      if (!Number.isSafeInteger(maximumByteSize) || maximumByteSize <= 0) {
        throw new TypeError('file_blob_maximum_byte_size_invalid');
      }
      const finalPath = objectPath(key);
      const directory = ensureObjectDirectory(finalPath);
      const partialPath = `${finalPath}.partial-${randomBytes(8).toString('hex')}`;
      const descriptor = openSync(partialPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let total = 0;
      let open = true;
      const discardPartial = (): void => {
        if (open) {
          closeSync(descriptor);
          open = false;
        }
        try {
          unlinkSync(partialPath);
        } catch (error) {
          throw new FilesystemFileBlobStoreError('partial_cleanup_failed', error);
        }
      };
      try {
        for await (const chunk of bytes) {
          if (!(chunk instanceof Uint8Array)) throw new TypeError('file_blob_chunk_invalid');
          total += chunk.byteLength;
          if (total > maximumByteSize) {
            discardPartial();
            return Object.freeze({ kind: 'refused', code: 'byte_cap_exceeded' });
          }
          hash.update(chunk);
          let written = 0;
          while (written < chunk.byteLength) {
            written += writeSync(descriptor, chunk, written, chunk.byteLength - written);
          }
        }
        if (total === 0) {
          discardPartial();
          return Object.freeze({ kind: 'refused', code: 'empty_stream' });
        }
        fsyncSync(descriptor);
        closeSync(descriptor);
        open = false;
        renameSync(partialPath, finalPath);
        const directoryDescriptor = openSync(directory, 'r');
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
        return Object.freeze({
          kind: 'stored',
          byteSize: total,
          sha256: hash.digest('hex')
        });
      } catch (error) {
        discardPartial();
        throw error;
      }
    },

    async openReadStream(key: string): Promise<FileBlobReadOutcome> {
      const path = objectPath(key);
      let size: number;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile()) return Object.freeze({ kind: 'missing' });
        size = stat.size;
      } catch {
        return Object.freeze({ kind: 'missing' });
      }
      const stream = createReadStream(path);
      return Object.freeze({
        kind: 'found',
        byteSize: size,
        bytes: stream as AsyncIterable<Uint8Array>
      });
    },

    async deleteObject(key: string): Promise<{ readonly deleted: boolean }> {
      const path = objectPath(key);
      try {
        unlinkSync(path);
        return Object.freeze({ deleted: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return Object.freeze({ deleted: false });
        }
        throw error;
      }
    }
  });
}

function resolveRoot(rootDirectory: string): string {
  let resolved: string;
  try {
    const supplied = lstatSync(rootDirectory);
    if (!supplied.isDirectory() || supplied.isSymbolicLink() || (supplied.mode & 0o077) !== 0) {
      throw new FilesystemFileBlobStoreError('root_directory_invalid');
    }
    resolved = realpathSync(rootDirectory);
  } catch (error) {
    if (error instanceof FilesystemFileBlobStoreError) throw error;
    throw new FilesystemFileBlobStoreError('root_directory_invalid', error);
  }
  return resolved;
}
