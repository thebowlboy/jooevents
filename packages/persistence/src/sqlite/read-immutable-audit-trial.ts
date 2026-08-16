import {
  isSealedReadImmutableAuditRecord,
  type ReadImmutableAuditPort,
  type ReadImmutableAuditRecord
} from '@jooevents/application';
import { canonicalJsonText } from '@jooevents/kernel';
import { Database } from 'bun:sqlite';

const eventKind = 'read_immutable_audit' as const;
const maximumRecordBytes = 131_072;

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const READ_IMMUTABLE_AUDIT_TRIAL_SQL = `
CREATE TABLE _trial_read_immutable_audits (
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  event_kind TEXT NOT NULL CHECK(event_kind = 'read_immutable_audit'),
  audit_target_key TEXT NOT NULL CHECK(length(audit_target_key) BETWEEN 1 AND 160),
  audit_target_version INTEGER NOT NULL CHECK(audit_target_version > 0),
  record_profile_key TEXT NOT NULL CHECK(length(record_profile_key) BETWEEN 1 AND 160),
  record_profile_version INTEGER NOT NULL CHECK(record_profile_version > 0),
  canonical_record_bytes BLOB NOT NULL CHECK(
    typeof(canonical_record_bytes) = 'blob'
    AND length(canonical_record_bytes) BETWEEN 2 AND ${maximumRecordBytes}
    AND json_valid(CAST(canonical_record_bytes AS TEXT))
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.eventId') = event_id
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.recordKind') = event_kind
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.auditTarget.key') = audit_target_key
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.auditTarget.version') = audit_target_version
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.recordProfile.key') = record_profile_key
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.recordProfile.version') = record_profile_version
  ),
  PRIMARY KEY (event_id, event_kind)
) WITHOUT ROWID;

CREATE TRIGGER _trial_read_immutable_audits_no_update
BEFORE UPDATE ON _trial_read_immutable_audits
BEGIN
  SELECT RAISE(ABORT, 'read immutable audit records are append-only');
END;

CREATE TRIGGER _trial_read_immutable_audits_no_delete
BEFORE DELETE ON _trial_read_immutable_audits
BEGIN
  SELECT RAISE(ABORT, 'read immutable audit records are append-only');
END;
`;

interface StoredRecordBytes {
  readonly canonical_record_bytes: Uint8Array;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export class ReadImmutableAuditConflictError extends Error {
  readonly eventId: string;
  readonly eventKind = eventKind;

  constructor(eventId: string) {
    super('A different immutable read-audit record already owns this event identity.');
    this.name = 'ReadImmutableAuditConflictError';
    this.eventId = eventId;
  }
}

export function installReadImmutableAuditTrialSchema(sqlite: Database): void {
  sqlite.exec(READ_IMMUTABLE_AUDIT_TRIAL_SQL);
}

/**
 * Capability-limited append seam for the ephemeral SQLite store. It accepts only
 * application-sealed records and never exposes a SQL handle or stored row.
 */
export class SQLiteReadImmutableAuditPort implements ReadImmutableAuditPort {
  constructor(private readonly sqlite: Database) {}

  append(record: ReadImmutableAuditRecord): void {
    if (!isSealedReadImmutableAuditRecord(record)) {
      throw new TypeError('unsealed_read_immutable_audit_record');
    }
    const canonicalBytes = new TextEncoder().encode(canonicalJsonText(record));
    if (canonicalBytes.byteLength < 2 || canonicalBytes.byteLength > maximumRecordBytes) {
      throw new TypeError('read_immutable_audit_record_size_out_of_bounds');
    }

    let ownsTransaction = false;
    try {
      this.sqlite.exec('BEGIN IMMEDIATE;');
      ownsTransaction = true;
      const existing = this.sqlite.query<StoredRecordBytes, [string, typeof eventKind]>(`
        SELECT canonical_record_bytes
          FROM _trial_read_immutable_audits
         WHERE event_id = ? AND event_kind = ?
      `).get(record.eventId, eventKind);
      if (existing) {
        if (!equalBytes(existing.canonical_record_bytes, canonicalBytes)) {
          throw new ReadImmutableAuditConflictError(record.eventId);
        }
      } else {
        this.sqlite.query<never, [string, typeof eventKind, string, number, string, number, Uint8Array]>(`
          INSERT INTO _trial_read_immutable_audits (
            event_id,
            event_kind,
            audit_target_key,
            audit_target_version,
            record_profile_key,
            record_profile_version,
            canonical_record_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.eventId,
          eventKind,
          record.auditTarget.key,
          record.auditTarget.version,
          record.recordProfile.key,
          record.recordProfile.version,
          canonicalBytes
        );
      }
      this.sqlite.exec('COMMIT;');
      ownsTransaction = false;
    } catch (error) {
      if (ownsTransaction && this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK;');
      throw error;
    }
  }
}

/** Compatibility name for existing isolated conformance callers. */
export const SQLiteTrialReadImmutableAuditPort = SQLiteReadImmutableAuditPort;
