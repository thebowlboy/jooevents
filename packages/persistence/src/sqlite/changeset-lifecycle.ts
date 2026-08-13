import type { Database } from 'bun:sqlite';
import {
  assertCommitLink,
  assertCorrectionLink,
  assertRebuildLink,
  changesetCommitTerminalReceiptDigest,
  createStoredChangesetRecord,
  parseChangesetHead,
  parseChangesetCommitTerminalReceipt,
  parseStoredChangesetApproval,
  parseStoredChangesetCommitLink,
  parseStoredChangesetCorrectionLink,
  parseStoredChangesetRebuildLink,
  parseStoredChangesetRecord,
  parseStoredChangesetRevisionRecord,
  type ChangesetLifecycleStore,
  type ChangesetCommitTerminalReceipt,
  type StoredChangesetApproval,
  type StoredChangesetCommitLink,
  type StoredChangesetCorrectionLink,
  type StoredChangesetRebuildLink,
  type StoredChangesetRecord,
  type StoredChangesetRevisionRecord
} from '@jooevents/changeset-operations';
import { canonicalJsonText } from '@jooevents/kernel';

export const CHANGESET_LIFECYCLE_SQL = `
CREATE TABLE changeset_heads (
  changeset_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT,
  head_version INTEGER NOT NULL CHECK(head_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('draft', 'proposed', 'committed', 'discarded')),
  current_revision_number INTEGER NOT NULL CHECK(current_revision_number >= 1),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  head_digest_sha256 TEXT NOT NULL CHECK(length(head_digest_sha256) = 64),
  UNIQUE(changeset_id, workspace_id, event_id)
);

CREATE TABLE changeset_revisions (
  changeset_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
  revision_id TEXT NOT NULL UNIQUE,
  revision_digest_sha256 TEXT NOT NULL CHECK(length(revision_digest_sha256) = 64),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  record_digest_sha256 TEXT NOT NULL CHECK(length(record_digest_sha256) = 64),
  PRIMARY KEY(changeset_id, revision_number),
  UNIQUE(changeset_id, revision_id, revision_digest_sha256),
  FOREIGN KEY(changeset_id) REFERENCES changeset_heads(changeset_id)
);

CREATE TABLE changeset_approvals (
  approval_id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_digest_sha256 TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  record_digest_sha256 TEXT NOT NULL CHECK(length(record_digest_sha256) = 64),
  UNIQUE(changeset_id, revision_id, approval_id),
  FOREIGN KEY(changeset_id, revision_id, revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
);

CREATE TABLE changeset_commit_links (
  changeset_id TEXT PRIMARY KEY,
  committed_head_version INTEGER NOT NULL CHECK(committed_head_version >= 2),
  revision_id TEXT NOT NULL,
  revision_digest_sha256 TEXT NOT NULL,
  commit_receipt_id TEXT NOT NULL UNIQUE,
  approval_id TEXT,
  operation_name TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version >= 1),
  surface TEXT NOT NULL,
  scope_partition_key TEXT NOT NULL CHECK(length(scope_partition_key) = 64),
  authority_principal_key TEXT NOT NULL CHECK(length(authority_principal_key) = 64),
  request_hash_sha256 TEXT NOT NULL CHECK(length(request_hash_sha256) = 64),
  terminal_receipt_digest_sha256 TEXT NOT NULL CHECK(length(terminal_receipt_digest_sha256) = 64),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  record_digest_sha256 TEXT NOT NULL CHECK(length(record_digest_sha256) = 64),
  UNIQUE(changeset_id, revision_id, revision_digest_sha256, commit_receipt_id),
  FOREIGN KEY(changeset_id, revision_id, revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256),
  FOREIGN KEY(changeset_id, revision_id, approval_id)
    REFERENCES changeset_approvals(changeset_id, revision_id, approval_id)
);

CREATE TABLE changeset_rebuild_links (
  changeset_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  source_revision_digest_sha256 TEXT NOT NULL,
  target_revision_id TEXT NOT NULL,
  target_revision_digest_sha256 TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  record_digest_sha256 TEXT NOT NULL CHECK(length(record_digest_sha256) = 64),
  PRIMARY KEY(changeset_id, target_revision_id),
  FOREIGN KEY(changeset_id, source_revision_id, source_revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256),
  FOREIGN KEY(changeset_id, target_revision_id, target_revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
);

CREATE TABLE changeset_correction_links (
  correction_id TEXT PRIMARY KEY,
  source_changeset_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  source_revision_digest_sha256 TEXT NOT NULL,
  source_commit_receipt_id TEXT NOT NULL,
  result_kind TEXT NOT NULL CHECK(result_kind IN ('exact', 'semantic', 'partial', 'blocked', 'irreversible')),
  target_changeset_id TEXT,
  target_revision_id TEXT,
  target_revision_digest_sha256 TEXT,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  record_digest_sha256 TEXT NOT NULL CHECK(length(record_digest_sha256) = 64),
  CHECK(
    (result_kind IN ('exact', 'semantic', 'partial')
      AND target_changeset_id IS NOT NULL
      AND target_revision_id IS NOT NULL
      AND target_revision_digest_sha256 IS NOT NULL)
    OR
    (result_kind = 'blocked'
      AND target_changeset_id IS NULL
      AND target_revision_id IS NULL
      AND target_revision_digest_sha256 IS NULL)
    OR
    (result_kind = 'irreversible'
      AND (
        (target_changeset_id IS NULL
          AND target_revision_id IS NULL
          AND target_revision_digest_sha256 IS NULL)
        OR
        (target_changeset_id IS NOT NULL
          AND target_revision_id IS NOT NULL
          AND target_revision_digest_sha256 IS NOT NULL)
      ))
  ),
  FOREIGN KEY(source_changeset_id, source_revision_id, source_revision_digest_sha256, source_commit_receipt_id)
    REFERENCES changeset_commit_links(changeset_id, revision_id, revision_digest_sha256, commit_receipt_id),
  FOREIGN KEY(target_changeset_id, target_revision_id, target_revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
);

CREATE TRIGGER changeset_heads_scope_immutable
BEFORE UPDATE ON changeset_heads
WHEN NEW.changeset_id <> OLD.changeset_id
  OR NEW.workspace_id <> OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
BEGIN SELECT RAISE(ABORT, 'changeset_head_scope_immutable'); END;

CREATE TRIGGER changeset_heads_cas_only
BEFORE UPDATE ON changeset_heads
WHEN NEW.head_version <> OLD.head_version + 1
  OR NEW.current_revision_number < OLD.current_revision_number
  OR NEW.current_revision_number > OLD.current_revision_number + 1
  OR OLD.status IN ('committed', 'discarded')
  OR NOT (
    (OLD.status = 'draft' AND NEW.status = 'proposed'
      AND NEW.current_revision_number = OLD.current_revision_number)
    OR (OLD.status = 'draft' AND NEW.status = 'draft'
      AND NEW.current_revision_number = OLD.current_revision_number + 1)
    OR (OLD.status = 'proposed' AND NEW.status = 'draft'
      AND NEW.current_revision_number = OLD.current_revision_number + 1)
    OR (OLD.status = 'proposed' AND NEW.status = 'committed'
      AND NEW.current_revision_number = OLD.current_revision_number)
    OR (OLD.status IN ('draft', 'proposed') AND NEW.status = 'discarded'
      AND NEW.current_revision_number = OLD.current_revision_number)
  )
  OR NOT EXISTS (
    SELECT 1 FROM changeset_revisions AS revision
    WHERE revision.changeset_id = NEW.changeset_id
      AND revision.revision_number = NEW.current_revision_number
  )
BEGIN SELECT RAISE(ABORT, 'changeset_head_invalid_transition'); END;

CREATE TRIGGER changeset_approvals_require_current_proposal
BEFORE INSERT ON changeset_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM changeset_heads AS head
  JOIN changeset_revisions AS revision
    ON revision.changeset_id = head.changeset_id
   AND revision.revision_number = head.current_revision_number
  WHERE head.changeset_id = NEW.changeset_id
    AND head.status = 'proposed'
    AND revision.revision_id = NEW.revision_id
    AND revision.revision_digest_sha256 = NEW.revision_digest_sha256
)
BEGIN SELECT RAISE(ABORT, 'changeset_approval_not_current_proposal'); END;

CREATE TRIGGER changeset_commit_links_require_current_proposal
BEFORE INSERT ON changeset_commit_links
WHEN NOT EXISTS (
  SELECT 1
  FROM changeset_heads AS head
  JOIN changeset_revisions AS revision
    ON revision.changeset_id = head.changeset_id
   AND revision.revision_number = head.current_revision_number
  WHERE head.changeset_id = NEW.changeset_id
    AND head.status = 'proposed'
    AND NEW.committed_head_version = head.head_version + 1
    AND revision.revision_id = NEW.revision_id
    AND revision.revision_digest_sha256 = NEW.revision_digest_sha256
)
BEGIN SELECT RAISE(ABORT, 'changeset_commit_not_current_proposal'); END;

CREATE TRIGGER changeset_revisions_no_update
BEFORE UPDATE ON changeset_revisions
BEGIN SELECT RAISE(ABORT, 'changeset_revision_immutable'); END;
CREATE TRIGGER changeset_revisions_no_delete
BEFORE DELETE ON changeset_revisions
BEGIN SELECT RAISE(ABORT, 'changeset_revision_immutable'); END;
CREATE TRIGGER changeset_approvals_no_update
BEFORE UPDATE ON changeset_approvals
BEGIN SELECT RAISE(ABORT, 'changeset_approval_immutable'); END;
CREATE TRIGGER changeset_approvals_no_delete
BEFORE DELETE ON changeset_approvals
BEGIN SELECT RAISE(ABORT, 'changeset_approval_immutable'); END;
CREATE TRIGGER changeset_commit_links_no_update
BEFORE UPDATE ON changeset_commit_links
BEGIN SELECT RAISE(ABORT, 'changeset_commit_link_immutable'); END;
CREATE TRIGGER changeset_commit_links_no_delete
BEFORE DELETE ON changeset_commit_links
BEGIN SELECT RAISE(ABORT, 'changeset_commit_link_immutable'); END;
CREATE TRIGGER changeset_rebuild_links_no_update
BEFORE UPDATE ON changeset_rebuild_links
BEGIN SELECT RAISE(ABORT, 'changeset_rebuild_link_immutable'); END;
CREATE TRIGGER changeset_rebuild_links_no_delete
BEFORE DELETE ON changeset_rebuild_links
BEGIN SELECT RAISE(ABORT, 'changeset_rebuild_link_immutable'); END;
CREATE TRIGGER changeset_correction_links_no_update
BEFORE UPDATE ON changeset_correction_links
BEGIN SELECT RAISE(ABORT, 'changeset_correction_link_immutable'); END;
CREATE TRIGGER changeset_correction_links_no_delete
BEFORE DELETE ON changeset_correction_links
BEGIN SELECT RAISE(ABORT, 'changeset_correction_link_immutable'); END;
`;

interface HeadRow {
  readonly workspace_id: string;
  readonly event_id: string | null;
  readonly head_version: number;
  readonly status: StoredChangesetRecord['head']['status'];
  readonly current_revision_number: number;
  readonly head_json: string;
  readonly head_digest_sha256: string;
}

interface RevisionRow {
  readonly revision_number: number;
  readonly revision_id: string;
  readonly revision_digest_sha256: string;
  readonly record_json: string;
  readonly record_digest_sha256: string;
}

interface JsonRecordRow {
  readonly approval_id?: string | null;
  readonly changeset_id?: string;
  readonly revision_id?: string;
  readonly revision_digest_sha256?: string;
  readonly record_json: string;
  readonly record_digest_sha256: string;
}

interface CommitLinkRow extends JsonRecordRow {
  readonly committed_head_version: number;
  readonly commit_receipt_id: string;
  readonly approval_id: string | null;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: StoredChangesetCommitLink['terminalReceiptBinding']['surface'];
  readonly scope_partition_key: string;
  readonly authority_principal_key: string;
  readonly request_hash_sha256: string;
  readonly terminal_receipt_digest_sha256: string;
}

interface CorrectionLinkRow extends JsonRecordRow {
  readonly correction_id: string;
  readonly source_changeset_id: string;
  readonly source_revision_id: string;
  readonly source_revision_digest_sha256: string;
  readonly source_commit_receipt_id: string;
  readonly result_kind: StoredChangesetCorrectionLink['resultKind'];
  readonly target_changeset_id: string | null;
  readonly target_revision_id: string | null;
  readonly target_revision_digest_sha256: string | null;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`invalid_${label}_json`);
  }
}

function canonicalText(value: unknown): string {
  return canonicalJsonText(value);
}

function assertCanonicalRow(text: string, value: unknown, label: string): void {
  if (canonicalText(value) !== text) throw new TypeError(`${label}_row_not_canonical`);
}

function runAtomically<Value>(sqlite: Database, work: () => Value): Value {
  const transaction = sqlite.transaction(work);
  return sqlite.inTransaction ? transaction() : transaction.immediate();
}

function isConstraint(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes('UNIQUE constraint failed')
    || error.message.includes('PRIMARY KEY')
  );
}

function assertRevisionPrefix(
  existing: StoredChangesetRecord,
  candidate: StoredChangesetRecord
): void {
  if (candidate.revisions.length < existing.revisions.length) {
    throw new TypeError('changeset_revision_prefix_truncated');
  }
  for (const [index, revision] of existing.revisions.entries()) {
    const candidateRevision = candidate.revisions[index];
    if (!candidateRevision
      || candidateRevision.recordDigestSha256 !== revision.recordDigestSha256
      || canonicalText(candidateRevision) !== canonicalText(revision)
      || canonicalText(candidate.head.revisions[index]) !== canonicalText(existing.head.revisions[index])) {
      throw new TypeError('changeset_revision_prefix_changed');
    }
  }
}

export function installSQLiteChangesetLifecycleSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('changeset_lifecycle_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(CHANGESET_LIFECYCLE_SQL)).immediate();
}

export interface SQLiteChangesetTerminalReceiptSource {
  readonly commitOperations: readonly {
    readonly name: string;
    readonly version: number;
  }[];
  readTerminalReceipt(receiptId: string): ChangesetCommitTerminalReceipt | undefined;
}

const draftOnlyTerminalReceiptSource: SQLiteChangesetTerminalReceiptSource = Object.freeze({
  commitOperations: Object.freeze([]),
  readTerminalReceipt(): never {
    throw new TypeError('changeset_draft_only_terminal_receipt_unavailable');
  }
});

function commitOperationKey(operation: { readonly name: string; readonly version: number }): string {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(operation.name)
    || !Number.isSafeInteger(operation.version)
    || operation.version <= 0) {
    throw new TypeError('invalid_changeset_commit_operation_registration');
  }
  return `${operation.name}\u0000${operation.version}`;
}

export class SQLiteChangesetLifecycleStore implements ChangesetLifecycleStore {
  readonly #registeredCommitOperations: ReadonlySet<string>;

  constructor(
    private readonly sqlite: Database,
    private readonly terminalReceipts: SQLiteChangesetTerminalReceiptSource
  ) {
    if (typeof terminalReceipts.readTerminalReceipt !== 'function') {
      throw new TypeError('changeset_lifecycle_terminal_receipt_reader_required');
    }
    const operations = terminalReceipts.commitOperations.map(commitOperationKey);
    if (
      (operations.length === 0 && terminalReceipts !== draftOnlyTerminalReceiptSource)
      || new Set(operations).size !== operations.length
    ) {
      throw new TypeError('changeset_lifecycle_commit_operation_registry_invalid');
    }
    this.#registeredCommitOperations = new Set(operations);
  }

  read(changesetId: string): StoredChangesetRecord | undefined {
    const head = this.sqlite.query<HeadRow, [string]>(`
      SELECT workspace_id, event_id, head_version, status, current_revision_number,
             head_json, head_digest_sha256
      FROM changeset_heads
      WHERE changeset_id = ?
    `).get(changesetId);
    if (!head) return undefined;
    const revisions = this.sqlite.query<RevisionRow, [string]>(`
      SELECT revision_number, revision_id, revision_digest_sha256,
             record_json, record_digest_sha256
      FROM changeset_revisions
      WHERE changeset_id = ?
      ORDER BY revision_number
    `).all(changesetId).map((row) => {
      const record = parseStoredChangesetRevisionRecord(parseJson(row.record_json, 'changeset_revision'));
      assertCanonicalRow(row.record_json, record, 'changeset_revision');
      if (record.recordDigestSha256 !== row.record_digest_sha256
        || record.revision.number !== row.revision_number
        || record.revision.id !== row.revision_id
        || record.revision.digest !== row.revision_digest_sha256) {
        throw new TypeError('changeset_revision_row_digest_mismatch');
      }
      return record;
    });
    const parsedHead = parseChangesetHead(parseJson(head.head_json, 'changeset_head'));
    assertCanonicalRow(head.head_json, parsedHead, 'changeset_head');
    if (parsedHead.workspaceId !== head.workspace_id
      || (parsedHead.eventId ?? null) !== head.event_id
      || parsedHead.version !== head.head_version
      || parsedHead.status !== head.status
      || parsedHead.currentRevisionNumber !== head.current_revision_number) {
      throw new TypeError('changeset_head_row_columns_mismatch');
    }
    const record = createStoredChangesetRecord({
      head: parsedHead,
      revisions
    });
    if (record.headDigestSha256 !== head.head_digest_sha256) {
      throw new TypeError('changeset_head_row_digest_mismatch');
    }
    return record;
  }

  insertDraft(record: StoredChangesetRecord): 'inserted' | 'exists' {
    const parsed = parseStoredChangesetRecord(record);
    if (parsed.head.status !== 'draft' || parsed.head.version !== 1
      || parsed.head.currentRevisionNumber !== 1 || parsed.revisions.length !== 1) {
      throw new TypeError('invalid_initial_changeset_draft');
    }
    try {
      return runAtomically(this.sqlite, () => {
        this.insertHead(parsed);
        this.insertRevision(parsed.head.id, parsed.revisions[0]!);
        return 'inserted' as const;
      });
    } catch (error) {
      if (isConstraint(error)) return 'exists';
      throw error;
    }
  }

  replaceHead(input: {
    readonly expectedHeadVersion: number;
    readonly record: StoredChangesetRecord;
    readonly appendedRevision?: StoredChangesetRevisionRecord;
    readonly rebuildLink?: StoredChangesetRebuildLink;
  }): 'advanced' | 'stale' | 'not_found' {
    const parsed = parseStoredChangesetRecord(input.record);
    if ((input.appendedRevision === undefined) !== (input.rebuildLink === undefined)) {
      throw new TypeError('changeset_rebuild_requires_revision_and_link');
    }
    return runAtomically(this.sqlite, () => {
      const existing = this.read(parsed.head.id);
      if (!existing) return 'not_found' as const;
      if (existing.head.version !== input.expectedHeadVersion) return 'stale' as const;
      if (parsed.head.version !== input.expectedHeadVersion + 1
        || parsed.head.workspaceId !== existing.head.workspaceId
        || parsed.head.eventId !== existing.head.eventId) {
        throw new TypeError('invalid_changeset_head_advance');
      }
      assertRevisionPrefix(existing, parsed);
      if (input.appendedRevision === undefined) {
        if (parsed.revisions.length !== existing.revisions.length) {
          throw new TypeError('unexpected_changeset_revision_append');
        }
      } else {
        const revision = parseStoredChangesetRevisionRecord(input.appendedRevision);
        if (parsed.revisions.length !== existing.revisions.length + 1
          || parsed.revisions.at(-1)?.recordDigestSha256 !== revision.recordDigestSha256) {
          throw new TypeError('changeset_revision_append_mismatch');
        }
        const link = parseStoredChangesetRebuildLink(input.rebuildLink!);
        assertRebuildLink(parsed, link);
        this.insertRevision(parsed.head.id, revision);
        this.insertRebuildLink(link);
      }
      const changed = this.updateHead(parsed, input.expectedHeadVersion);
      if (changed !== 1) throw new TypeError('changeset_head_cas_lost_inside_transaction');
      return 'advanced' as const;
    });
  }

  readApprovals(changesetId: string, revisionId: string): readonly StoredChangesetApproval[] {
    return Object.freeze(this.sqlite.query<JsonRecordRow, [string, string]>(`
      SELECT approval_id, changeset_id, revision_id, revision_digest_sha256,
             record_json, record_digest_sha256
      FROM changeset_approvals
      WHERE changeset_id = ? AND revision_id = ?
      ORDER BY approval_id
    `).all(changesetId, revisionId).map((row) => {
      const record = parseStoredChangesetApproval(parseJson(row.record_json, 'changeset_approval'));
      assertCanonicalRow(row.record_json, record, 'changeset_approval');
      if (record.recordDigestSha256 !== row.record_digest_sha256
        || record.receipt.id !== row.approval_id
        || record.changesetId !== row.changeset_id
        || record.receipt.revisionId !== row.revision_id
        || record.receipt.revisionDigest !== row.revision_digest_sha256) {
        throw new TypeError('changeset_approval_row_digest_mismatch');
      }
      return record;
    }));
  }

  insertApproval(record: StoredChangesetApproval): 'inserted' | 'exists' {
    const parsed = parseStoredChangesetApproval(record);
    const changeset = this.read(parsed.changesetId);
    const revision = changeset?.revisions.find((candidate) =>
      candidate.revision.id === parsed.receipt.revisionId
      && candidate.revision.digest === parsed.receipt.revisionDigest
    );
    if (!changeset || !revision || changeset.head.status !== 'proposed'
      || revision.approvalPolicy.requirement !== 'distinct_current_human'
      || revision.revision.approvalPolicy.key !== parsed.receipt.policy.key
      || revision.revision.approvalPolicy.version !== parsed.receipt.policy.version) {
      throw new TypeError('changeset_approval_relationship_mismatch');
    }
    try {
      this.sqlite.query(`
        INSERT INTO changeset_approvals (
          approval_id, changeset_id, revision_id, revision_digest_sha256,
          record_json, record_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        parsed.receipt.id,
        parsed.changesetId,
        parsed.receipt.revisionId,
        parsed.receipt.revisionDigest,
        canonicalText(parsed),
        parsed.recordDigestSha256
      );
      return 'inserted';
    } catch (error) {
      if (isConstraint(error)) return 'exists';
      throw error;
    }
  }

  readCommitLink(changesetId: string): StoredChangesetCommitLink | undefined {
    const row = this.sqlite.query<CommitLinkRow, [string]>(`
      SELECT changeset_id, committed_head_version, revision_id, revision_digest_sha256,
             commit_receipt_id, approval_id, operation_name, operation_version, surface,
             scope_partition_key, authority_principal_key, request_hash_sha256,
             terminal_receipt_digest_sha256, record_json, record_digest_sha256
      FROM changeset_commit_links
      WHERE changeset_id = ?
    `).get(changesetId);
    if (!row) return undefined;
    const link = parseStoredChangesetCommitLink(parseJson(row.record_json, 'changeset_commit_link'));
    assertCanonicalRow(row.record_json, link, 'changeset_commit_link');
    if (link.recordDigestSha256 !== row.record_digest_sha256
      || link.changesetId !== row.changeset_id
      || link.committedHeadVersion !== row.committed_head_version
      || link.revisionId !== row.revision_id
      || link.revisionDigest !== row.revision_digest_sha256
      || link.commitReceiptId !== row.commit_receipt_id
      || (link.approvalId ?? null) !== row.approval_id
      || link.terminalReceiptBinding.operation.name !== row.operation_name
      || link.terminalReceiptBinding.operation.version !== row.operation_version
      || link.terminalReceiptBinding.surface !== row.surface
      || link.terminalReceiptBinding.scopePartitionKey !== row.scope_partition_key
      || link.terminalReceiptBinding.authorityPrincipalKey !== row.authority_principal_key
      || link.terminalReceiptBinding.requestHashSha256 !== row.request_hash_sha256
      || link.terminalReceiptBinding.terminalReceiptDigestSha256 !== row.terminal_receipt_digest_sha256) {
      throw new TypeError('changeset_commit_link_row_digest_mismatch');
    }
    const record = this.read(changesetId);
    if (!record) throw new TypeError('changeset_commit_link_head_missing');
    assertCommitLink(record, link);
    this.assertTerminalReceipt(record, link);
    return link;
  }

  commit(input: {
    readonly expectedHeadVersion: number;
    readonly record: StoredChangesetRecord;
    readonly link: StoredChangesetCommitLink;
  }): 'committed' | 'stale' | 'not_found' {
    if (!this.sqlite.inTransaction) {
      throw new TypeError('changeset_commit_requires_enclosing_transaction');
    }
    const parsed = parseStoredChangesetRecord(input.record);
    const link = parseStoredChangesetCommitLink(input.link);
    assertCommitLink(parsed, link);
    return runAtomically(this.sqlite, () => {
      const existing = this.read(parsed.head.id);
      if (!existing) return 'not_found' as const;
      if (existing.head.version !== input.expectedHeadVersion) return 'stale' as const;
      if (existing.head.status !== 'proposed'
        || parsed.head.status !== 'committed'
        || parsed.head.version !== input.expectedHeadVersion + 1
        || parsed.revisions.length !== existing.revisions.length) {
        throw new TypeError('invalid_changeset_commit_advance');
      }
      assertRevisionPrefix(existing, parsed);
      const revision = parsed.revisions.at(-1)!;
      if ((revision.approvalPolicy.requirement === 'distinct_current_human') !== (link.approvalId !== undefined)) {
        throw new TypeError('changeset_commit_approval_requirement_mismatch');
      }
      if (link.approvalId !== undefined) {
        const selected = this.readApprovals(link.changesetId, link.revisionId)
          .find((approval) => approval.receipt.id === link.approvalId);
        if (!selected) throw new TypeError('changeset_commit_approval_missing');
      }
      this.assertTerminalReceipt(parsed, link);
      this.sqlite.query(`
        INSERT INTO changeset_commit_links (
          changeset_id, committed_head_version, revision_id, revision_digest_sha256,
          commit_receipt_id, approval_id, operation_name, operation_version, surface,
          scope_partition_key, authority_principal_key, request_hash_sha256,
          terminal_receipt_digest_sha256, record_json, record_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        link.changesetId,
        link.committedHeadVersion,
        link.revisionId,
        link.revisionDigest,
        link.commitReceiptId,
        link.approvalId ?? null,
        link.terminalReceiptBinding.operation.name,
        link.terminalReceiptBinding.operation.version,
        link.terminalReceiptBinding.surface,
        link.terminalReceiptBinding.scopePartitionKey,
        link.terminalReceiptBinding.authorityPrincipalKey,
        link.terminalReceiptBinding.requestHashSha256,
        link.terminalReceiptBinding.terminalReceiptDigestSha256,
        canonicalText(link),
        link.recordDigestSha256
      );
      if (this.updateHead(parsed, input.expectedHeadVersion) !== 1) {
        throw new TypeError('changeset_commit_cas_lost_inside_transaction');
      }
      return 'committed' as const;
    });
  }

  insertCorrection(input: {
    readonly link: StoredChangesetCorrectionLink;
    readonly target?: StoredChangesetRecord;
  }): 'inserted' | 'exists' {
    const link = parseStoredChangesetCorrectionLink(input.link);
    const source = this.read(link.sourceChangesetId);
    const sourceCommit = this.readCommitLink(link.sourceChangesetId);
    if (!source || !sourceCommit) throw new TypeError('changeset_correction_source_missing');
    const target = input.target === undefined ? undefined : parseStoredChangesetRecord(input.target);
    assertCorrectionLink(source, sourceCommit, target, link);
    try {
      return runAtomically(this.sqlite, () => {
        if (target !== undefined) {
          if (target.head.status !== 'draft' || target.head.version !== 1 || target.revisions.length !== 1) {
            throw new TypeError('invalid_changeset_correction_target');
          }
          this.insertHead(target);
          this.insertRevision(target.head.id, target.revisions[0]!);
        }
        this.sqlite.query(`
          INSERT INTO changeset_correction_links (
            correction_id, source_changeset_id, source_revision_id,
            source_revision_digest_sha256, source_commit_receipt_id, result_kind,
            target_changeset_id, target_revision_id, target_revision_digest_sha256,
            record_json, record_digest_sha256
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          link.id,
          link.sourceChangesetId,
          link.sourceRevisionId,
          link.sourceRevisionDigest,
          link.sourceCommitReceiptId,
          link.resultKind,
          link.target?.changesetId ?? null,
          link.target?.revisionId ?? null,
          link.target?.revisionDigest ?? null,
          canonicalText(link),
          link.recordDigestSha256
        );
        return 'inserted' as const;
      });
    } catch (error) {
      if (isConstraint(error)) return 'exists';
      throw error;
    }
  }

  readCorrection(correctionId: string): StoredChangesetCorrectionLink | undefined {
    const row = this.sqlite.query<CorrectionLinkRow, [string]>(`
      SELECT correction_id, source_changeset_id, source_revision_id,
             source_revision_digest_sha256, source_commit_receipt_id, result_kind,
             target_changeset_id, target_revision_id, target_revision_digest_sha256,
             record_json, record_digest_sha256
      FROM changeset_correction_links
      WHERE correction_id = ?
    `).get(correctionId);
    return row ? this.parseCorrectionRow(row) : undefined;
  }

  readCorrections(sourceChangesetId: string): readonly StoredChangesetCorrectionLink[] {
    return Object.freeze(this.sqlite.query<CorrectionLinkRow, [string]>(`
      SELECT correction_id, source_changeset_id, source_revision_id,
             source_revision_digest_sha256, source_commit_receipt_id, result_kind,
             target_changeset_id, target_revision_id, target_revision_digest_sha256,
             record_json, record_digest_sha256
      FROM changeset_correction_links
      WHERE source_changeset_id = ?
      ORDER BY correction_id
    `).all(sourceChangesetId).map((row) => this.parseCorrectionRow(row)));
  }

  private insertHead(record: StoredChangesetRecord): void {
    this.sqlite.query(`
      INSERT INTO changeset_heads (
        changeset_id, workspace_id, event_id, head_version, status,
        current_revision_number, head_json, head_digest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.head.id,
      record.head.workspaceId,
      record.head.eventId ?? null,
      record.head.version,
      record.head.status,
      record.head.currentRevisionNumber,
      canonicalText(record.head),
      record.headDigestSha256
    );
  }

  private parseCorrectionRow(row: CorrectionLinkRow): StoredChangesetCorrectionLink {
    const link = parseStoredChangesetCorrectionLink(parseJson(row.record_json, 'changeset_correction_link'));
    assertCanonicalRow(row.record_json, link, 'changeset_correction_link');
    if (link.recordDigestSha256 !== row.record_digest_sha256
      || link.id !== row.correction_id
      || link.sourceChangesetId !== row.source_changeset_id
      || link.sourceRevisionId !== row.source_revision_id
      || link.sourceRevisionDigest !== row.source_revision_digest_sha256
      || link.sourceCommitReceiptId !== row.source_commit_receipt_id
      || link.resultKind !== row.result_kind
      || (link.target?.changesetId ?? null) !== row.target_changeset_id
      || (link.target?.revisionId ?? null) !== row.target_revision_id
      || (link.target?.revisionDigest ?? null) !== row.target_revision_digest_sha256) {
      throw new TypeError('changeset_correction_link_row_mismatch');
    }
    const source = this.read(link.sourceChangesetId);
    const commit = this.readCommitLink(link.sourceChangesetId);
    const target = link.target === null ? undefined : this.read(link.target.changesetId);
    if (!source || !commit) throw new TypeError('changeset_correction_link_source_missing');
    assertCorrectionLink(source, commit, target, link);
    return link;
  }

  private insertRevision(changesetId: string, record: StoredChangesetRevisionRecord): void {
    this.sqlite.query(`
      INSERT INTO changeset_revisions (
        changeset_id, revision_number, revision_id, revision_digest_sha256,
        record_json, record_digest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      changesetId,
      record.revision.number,
      record.revision.id,
      record.revision.digest,
      canonicalText(record),
      record.recordDigestSha256
    );
  }

  private insertRebuildLink(link: StoredChangesetRebuildLink): void {
    this.sqlite.query(`
      INSERT INTO changeset_rebuild_links (
        changeset_id, source_revision_id, source_revision_digest_sha256,
        target_revision_id, target_revision_digest_sha256,
        record_json, record_digest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      link.changesetId,
      link.sourceRevisionId,
      link.sourceRevisionDigest,
      link.targetRevisionId,
      link.targetRevisionDigest,
      canonicalText(link),
      link.recordDigestSha256
    );
  }

  private updateHead(record: StoredChangesetRecord, expectedHeadVersion: number): number {
    return this.sqlite.query(`
      UPDATE changeset_heads
      SET head_version = ?, status = ?, current_revision_number = ?,
          head_json = ?, head_digest_sha256 = ?
      WHERE changeset_id = ? AND head_version = ?
    `).run(
      record.head.version,
      record.head.status,
      record.head.currentRevisionNumber,
      canonicalText(record.head),
      record.headDigestSha256,
      record.head.id,
      expectedHeadVersion
    ).changes;
  }

  private assertTerminalReceipt(
    record: StoredChangesetRecord,
    link: StoredChangesetCommitLink
  ): void {
    if (!this.#registeredCommitOperations.has(commitOperationKey(link.terminalReceiptBinding.operation))) {
      throw new TypeError('changeset_commit_operation_unregistered');
    }
    const value = this.terminalReceipts.readTerminalReceipt(link.commitReceiptId);
    if (!value) throw new TypeError('changeset_commit_terminal_receipt_missing');
    const receipt = parseChangesetCommitTerminalReceipt(value);
    const result = receipt.result.data;
    const binding = link.terminalReceiptBinding;
    if (changesetCommitTerminalReceiptDigest(receipt) !== binding.terminalReceiptDigestSha256
      || receipt.ref.id !== link.commitReceiptId
      || receipt.ref.operationName !== binding.operation.name
      || receipt.ref.operationVersion !== binding.operation.version
      || receipt.identity.surface !== binding.surface
      || receipt.identity.scopePartitionKey !== binding.scopePartitionKey
      || receipt.identity.authorityPrincipalKey !== binding.authorityPrincipalKey
      || receipt.requestHash !== binding.requestHashSha256
      || result.changesetId !== record.head.id
      || result.expectedHeadVersion !== link.committedHeadVersion - 1
      || result.committedHeadVersion !== link.committedHeadVersion
      || result.revisionId !== link.revisionId
      || result.revisionDigest !== link.revisionDigest) {
      throw new TypeError('changeset_commit_terminal_receipt_mismatch');
    }
  }
}

/**
 * Opens the lifecycle for a composition that can author drafts but has no registered
 * commit operation. Commit and persisted commit-link reads remain fail-closed.
 */
export function createSQLiteDraftOnlyChangesetLifecycleStore(
  sqlite: Database
): SQLiteChangesetLifecycleStore {
  return new SQLiteChangesetLifecycleStore(sqlite, draftOnlyTerminalReceiptSource);
}
