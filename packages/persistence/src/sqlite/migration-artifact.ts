import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SQLiteFoundationError } from './foundation-errors';

export interface VerifiedSQLiteArtifact {
  readonly bytes: Buffer;
  readonly checksumSha256: string;
  readonly sql: string;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function decodeSQLiteArtifact(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new SQLiteFoundationError(
      'artifact_invalid_encoding',
      'SQLite migration artifacts must not contain a UTF-8 byte-order mark.'
    );
  }
  if (bytes.includes(0)) {
    throw new SQLiteFoundationError(
      'artifact_invalid_encoding',
      'SQLite migration artifacts must not contain NUL bytes.'
    );
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new SQLiteFoundationError(
      'artifact_invalid_encoding',
      'SQLite migration artifacts must be valid UTF-8.',
      { cause: cause instanceof Error ? cause.message : String(cause) }
    );
  }
}

export function readVerifiedSQLiteArtifact(
  artifact: URL | string,
  expectedChecksumSha256: string
): VerifiedSQLiteArtifact {
  const bytes = readFileSync(artifact);
  const sql = decodeSQLiteArtifact(bytes);
  const checksumSha256 = sha256Hex(bytes);
  if (checksumSha256 !== expectedChecksumSha256) {
    throw new SQLiteFoundationError(
      'artifact_checksum_mismatch',
      'SQLite migration artifact bytes do not match the checked-in manifest.',
      { expectedChecksumSha256, actualChecksumSha256: checksumSha256 }
    );
  }
  return { bytes, checksumSha256, sql };
}
