import type { Database } from 'bun:sqlite';
import type {
  FileAssetDto,
  FileAttachmentDto,
  FileAttachmentSubjectDto,
  FileRequestDto,
  FileScopeDto,
  FileUploadIntentDto,
  FileUploaderPrincipalDto,
  ResourceShareDto
} from '@jooevents/contracts/files';
import {
  parseFileAsset,
  parseFileAttachment,
  parseFileRequest,
  parseFileUploadIntent,
  parseResourceShare,
  type FileAssetWritePort,
  type FileAttachmentRepository,
  type FileAttachmentSubjectSource,
  type FileDownloadAssetSource,
  type FileOrphanSweepPort,
  type FileRequestEngagementSource,
  type FileRequestRepository,
  type FileUploadIntentRepository,
  type FileUploaderUsageSource,
  type ResourceShareRepository
} from '@jooevents/files';

/**
 * Additive schema installed only in an explicitly disposable SQLite runtime.
 * Five aggregates: upload intents (two-phase upload evidence), file assets
 * (blob metadata behind the D1 driver seam), attachments (asset OR typed link
 * on engagement/submission/session/resource-share subjects; the D7 refcount
 * source), resource shares (organizer → speaker audiences), and file requests
 * (the D9 ask loop referencing the existing deadline catalog).
 */
export const SQLITE_FILES_SQL = `
CREATE TABLE file_upload_intents (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  uploader_kind TEXT NOT NULL CHECK(uploader_kind IN ('operator_user', 'participant')),
  uploader_id TEXT NOT NULL CHECK(length(uploader_id) = 36),
  purpose TEXT NOT NULL CHECK(purpose IN (
    'engagement_material', 'submission_material', 'session_material',
    'resource_share_material', 'request_fulfillment'
  )),
  content_type TEXT NOT NULL CHECK(content_type IN (
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.apple.keynote', 'application/zip'
  )),
  declared_byte_size INTEGER NOT NULL CHECK(declared_byte_size > 0),
  maximum_byte_size INTEGER NOT NULL CHECK(maximum_byte_size > 0),
  storage_provider TEXT NOT NULL CHECK(length(storage_provider) BETWEEN 1 AND 64),
  storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK(state IN ('pending', 'stored', 'confirmed', 'discarded')),
  stored_byte_size INTEGER CHECK(stored_byte_size IS NULL OR stored_byte_size > 0),
  stored_sha256 TEXT CHECK(stored_sha256 IS NULL OR length(stored_sha256) = 64),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, storage_key),
  CHECK((stored_byte_size IS NULL) = (stored_sha256 IS NULL)),
  CHECK(state NOT IN ('stored', 'confirmed') OR stored_sha256 IS NOT NULL),
  CHECK(state <> 'pending' OR stored_sha256 IS NULL),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.contentType') = content_type),
  CHECK(json_extract(head_json, '$.storageKey') = storage_key),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX file_upload_intents_uploader
  ON file_upload_intents(workspace_id, event_id, uploader_kind, uploader_id, state);

CREATE TRIGGER file_upload_intents_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, uploader_kind, uploader_id,
  purpose, storage_provider, storage_key, created_at_ms
ON file_upload_intents
BEGIN
  SELECT RAISE(ABORT, 'file upload intent identity is immutable');
END;

CREATE TABLE file_assets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  uploader_kind TEXT NOT NULL CHECK(uploader_kind IN ('operator_user', 'participant')),
  uploader_id TEXT NOT NULL CHECK(length(uploader_id) = 36),
  purpose TEXT NOT NULL CHECK(purpose IN (
    'engagement_material', 'submission_material', 'session_material',
    'resource_share_material', 'request_fulfillment'
  )),
  display_filename TEXT NOT NULL CHECK(length(display_filename) BETWEEN 1 AND 200),
  content_type TEXT NOT NULL CHECK(content_type IN (
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.apple.keynote', 'application/zip'
  )),
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  storage_provider TEXT NOT NULL CHECK(length(storage_provider) BETWEEN 1 AND 64),
  storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 512),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('uploaded', 'pending_scan', 'available', 'blocked')),
  scan_provider TEXT NOT NULL CHECK(length(scan_provider) BETWEEN 1 AND 64),
  scan_verdict TEXT NOT NULL CHECK(scan_verdict IN ('pending', 'released', 'blocked')),
  scan_checked_at_ms INTEGER CHECK(
    scan_checked_at_ms IS NULL OR scan_checked_at_ms BETWEEN 0 AND 8640000000000000
  ),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, storage_key),
  CHECK((lifecycle = 'blocked') = (scan_verdict = 'blocked')),
  CHECK(NOT (lifecycle = 'available' AND scan_verdict = 'pending')),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.lifecycle') = lifecycle),
  CHECK(json_extract(head_json, '$.contentType') = content_type),
  CHECK(json_extract(head_json, '$.sha256') = sha256),
  CHECK(json_extract(head_json, '$.version') = version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX file_assets_uploader
  ON file_assets(workspace_id, event_id, uploader_kind, uploader_id);

CREATE TRIGGER file_assets_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, uploader_kind, uploader_id, purpose,
  content_type, byte_size, sha256, storage_provider, storage_key, created_at_ms
ON file_assets
BEGIN
  SELECT RAISE(ABORT, 'file asset identity is immutable');
END;

CREATE TABLE file_attachments (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN (
    'engagement', 'submission', 'session', 'resource_share'
  )),
  subject_id TEXT NOT NULL CHECK(length(subject_id) = 36),
  content_kind TEXT NOT NULL CHECK(content_kind IN ('asset', 'link')),
  asset_id TEXT CHECK(asset_id IS NULL OR length(asset_id) = 36),
  link_provider TEXT CHECK(link_provider IS NULL OR link_provider IN ('drive', 'dropbox', 'url')),
  link_label TEXT CHECK(link_label IS NULL OR length(link_label) BETWEEN 1 AND 200),
  link_url TEXT CHECK(link_url IS NULL OR (length(link_url) <= 2048 AND link_url LIKE 'https://%')),
  attached_by_kind TEXT NOT NULL CHECK(attached_by_kind IN ('operator_user', 'participant')),
  attached_by_id TEXT NOT NULL CHECK(length(attached_by_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('attached', 'detached')),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  attached_at_ms INTEGER NOT NULL CHECK(attached_at_ms BETWEEN 0 AND 8640000000000000),
  detached_at_ms INTEGER CHECK(
    detached_at_ms IS NULL OR detached_at_ms BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (workspace_id, event_id, id),
  CHECK((content_kind = 'asset') = (asset_id IS NOT NULL)),
  CHECK((content_kind = 'link') = (link_url IS NOT NULL)),
  CHECK((link_provider IS NULL) = (link_url IS NULL)),
  CHECK((link_label IS NULL) = (link_url IS NULL)),
  CHECK((state = 'detached') = (detached_at_ms IS NOT NULL)),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, asset_id)
    REFERENCES file_assets(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX file_attachments_subject
  ON file_attachments(workspace_id, event_id, subject_kind, subject_id, state);

CREATE INDEX file_attachments_asset
  ON file_attachments(workspace_id, event_id, asset_id, state)
  WHERE asset_id IS NOT NULL;

CREATE TRIGGER file_attachments_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, subject_kind, subject_id, content_kind,
  asset_id, link_provider, link_label, link_url, attached_by_kind, attached_by_id,
  attached_at_ms
ON file_attachments
BEGIN
  SELECT RAISE(ABORT, 'file attachment identity is immutable');
END;

CREATE TABLE resource_shares (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  audience_kind TEXT NOT NULL CHECK(audience_kind IN ('all_confirmed', 'track', 'engagement')),
  audience_id TEXT CHECK(audience_id IS NULL OR length(audience_id) = 36),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  revoked_at_ms INTEGER CHECK(
    revoked_at_ms IS NULL OR revoked_at_ms BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (workspace_id, event_id, id),
  CHECK((audience_kind = 'all_confirmed') = (audience_id IS NULL)),
  CHECK((state = 'revoked') = (revoked_at_ms IS NOT NULL)),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER resource_shares_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, audience_kind, audience_id,
  created_by_user_id, created_at_ms
ON resource_shares
BEGIN
  SELECT RAISE(ABORT, 'resource share identity is immutable');
END;

CREATE TABLE file_requests (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  engagement_id TEXT NOT NULL CHECK(length(engagement_id) = 36),
  what TEXT NOT NULL CHECK(length(what) BETWEEN 1 AND 200),
  deadline_id TEXT CHECK(deadline_id IS NULL OR length(deadline_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('open', 'fulfilled', 'withdrawn')),
  fulfilling_attachment_id TEXT CHECK(
    fulfilling_attachment_id IS NULL OR length(fulfilling_attachment_id) = 36
  ),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  CHECK((state = 'fulfilled') = (fulfilling_attachment_id IS NOT NULL)),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, engagement_id)
    REFERENCES engagement_heads(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, deadline_id)
    REFERENCES deadlines(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, fulfilling_attachment_id)
    REFERENCES file_attachments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX file_requests_engagement
  ON file_requests(workspace_id, event_id, engagement_id, state);

CREATE TRIGGER file_requests_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, engagement_id, what, deadline_id,
  created_by_user_id, created_at_ms
ON file_requests
BEGIN
  SELECT RAISE(ABORT, 'file request identity is immutable');
END;
`;

export function installFilesSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteFilesError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SQLITE_FILES_SQL);
}

export type SQLiteFilesErrorCode =
  | 'transaction_required'
  | 'scope_corrupt'
  | 'data_corrupt'
  | 'stale_row'
  | 'duplicate_row';

export class SQLiteFilesError extends Error {
  constructor(readonly code: SQLiteFilesErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteFilesError';
  }
}

interface HeadRow { readonly head_json: string }
interface CountRow { readonly count: number }
interface SumRow { readonly total: number | null }
interface StateRow { readonly state: string }

function instantMs(instant: string): number {
  const value = Date.parse(instant);
  if (!Number.isFinite(value)) throw new SQLiteFilesError('data_corrupt');
  return value;
}

function uploaderColumns(principal: FileUploaderPrincipalDto): {
  readonly kind: string;
  readonly id: string;
} {
  return principal.kind === 'operator_user'
    ? { kind: 'operator_user', id: principal.userId }
    : { kind: 'participant', id: principal.participantIdentityId };
}

function subjectColumns(subject: FileAttachmentSubjectDto): {
  readonly kind: string;
  readonly id: string;
} {
  switch (subject.kind) {
    case 'engagement': return { kind: 'engagement', id: subject.engagementId };
    case 'submission': return { kind: 'submission', id: subject.submissionId };
    case 'session': return { kind: 'session', id: subject.sessionId };
    case 'resource_share': return { kind: 'resource_share', id: subject.resourceShareId };
  }
}

/**
 * Canonical files persistence on one caller-owned handle, implementing every
 * repository port of `@jooevents/files`. Writes require the caller's
 * transaction and are guarded by exact expected images; drift refuses. The
 * subject-existence and engagement-state ports read the owning aggregates'
 * tables — files never invents cross-aggregate state.
 */
export class SQLiteFilesRepository implements
  FileUploadIntentRepository,
  FileAssetWritePort,
  FileDownloadAssetSource,
  FileUploaderUsageSource,
  FileAttachmentRepository,
  FileAttachmentSubjectSource,
  ResourceShareRepository,
  FileRequestRepository,
  FileRequestEngagementSource,
  FileOrphanSweepPort {
  constructor(private readonly sqlite: Database) {}

  // -- upload intents -------------------------------------------------------

  readIntent(scope: FileScopeDto, intentId: string): FileUploadIntentDto | undefined {
    const row = this.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT head_json FROM file_upload_intents
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, intentId);
    return row === null ? undefined : this.parse(row, parseFileUploadIntent);
  }

  createIntent(intent: FileUploadIntentDto): void {
    this.requireTransaction();
    const uploader = uploaderColumns(intent.uploader);
    this.run(() => this.sqlite.query(`
      INSERT INTO file_upload_intents (
        workspace_id, event_id, id, uploader_kind, uploader_id, purpose,
        content_type, declared_byte_size, maximum_byte_size, storage_provider,
        storage_key, state, stored_byte_size, stored_sha256, head_json,
        created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      intent.scope.workspaceId, intent.scope.eventId, intent.id,
      uploader.kind, uploader.id, intent.purpose,
      intent.contentType, intent.declaredByteSize, intent.maximumByteSize,
      intent.storageProvider, intent.storageKey, intent.state,
      intent.storedByteSize, intent.storedSha256,
      JSON.stringify(intent), instantMs(intent.createdAt), instantMs(intent.expiresAt)
    ));
  }

  transitionIntent(input: {
    readonly expected: FileUploadIntentDto;
    readonly next: FileUploadIntentDto;
  }): void {
    this.requireTransaction();
    const changes = this.sqlite.query(`
      UPDATE file_upload_intents
         SET state = ?, stored_byte_size = ?, stored_sha256 = ?, head_json = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND state = ?
    `).run(
      input.next.state, input.next.storedByteSize, input.next.storedSha256,
      JSON.stringify(input.next),
      input.expected.scope.workspaceId, input.expected.scope.eventId,
      input.expected.id, input.expected.state
    ).changes;
    if (changes !== 1) throw new SQLiteFilesError('stale_row');
  }

  // -- assets ---------------------------------------------------------------

  readAsset(scope: FileScopeDto, assetId: string): FileAssetDto | undefined {
    const row = this.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT head_json FROM file_assets
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, assetId);
    return row === null ? undefined : this.parse(row, parseFileAsset);
  }

  readAssetForDownload(scope: FileScopeDto, assetId: string): FileAssetDto | undefined {
    return this.readAsset(scope, assetId);
  }

  createAsset(asset: FileAssetDto): void {
    this.requireTransaction();
    const uploader = uploaderColumns(asset.uploader);
    this.run(() => this.sqlite.query(`
      INSERT INTO file_assets (
        workspace_id, event_id, id, uploader_kind, uploader_id, purpose,
        display_filename, content_type, byte_size, sha256, storage_provider,
        storage_key, lifecycle, scan_provider, scan_verdict, scan_checked_at_ms,
        version, head_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.scope.workspaceId, asset.scope.eventId, asset.id,
      uploader.kind, uploader.id, asset.purpose,
      asset.displayFilename, asset.contentType, asset.byteSize, asset.sha256,
      asset.storageProvider, asset.storageKey, asset.lifecycle,
      asset.scan.provider, asset.scan.verdict,
      asset.scan.checkedAt === null ? null : instantMs(asset.scan.checkedAt),
      asset.version, JSON.stringify(asset),
      instantMs(asset.createdAt), instantMs(asset.updatedAt)
    ));
  }

  /** Version-guarded head replacement used by scan verdict transitions. */
  transitionAsset(input: {
    readonly expected: FileAssetDto;
    readonly next: FileAssetDto;
  }): void {
    this.requireTransaction();
    const changes = this.sqlite.query(`
      UPDATE file_assets
         SET lifecycle = ?, scan_provider = ?, scan_verdict = ?, scan_checked_at_ms = ?,
             version = ?, head_json = ?, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
    `).run(
      input.next.lifecycle, input.next.scan.provider, input.next.scan.verdict,
      input.next.scan.checkedAt === null ? null : instantMs(input.next.scan.checkedAt),
      input.next.version, JSON.stringify(input.next), instantMs(input.next.updatedAt),
      input.expected.scope.workspaceId, input.expected.scope.eventId,
      input.expected.id, input.expected.version
    ).changes;
    if (changes !== 1) throw new SQLiteFilesError('stale_row');
  }

  readUploaderStoredBytes(
    scope: FileScopeDto,
    uploader: FileUploaderPrincipalDto,
    asOf: string
  ): number {
    const columns = uploaderColumns(uploader);
    // Confirmed assets plus the reservations of open, unexpired intents at
    // the larger of declared and stored size: the quota binds at
    // registration, and expired reservations release themselves without
    // waiting for the sweep.
    const row = this.sqlite.query<SumRow, [
      string, string, string, string, string, string, string, string, number
    ]>(`
      SELECT
        (SELECT COALESCE(sum(byte_size), 0) FROM file_assets
          WHERE workspace_id = ? AND event_id = ?
            AND uploader_kind = ? AND uploader_id = ?)
        + (SELECT COALESCE(sum(MAX(declared_byte_size, COALESCE(stored_byte_size, 0))), 0)
             FROM file_upload_intents
            WHERE workspace_id = ? AND event_id = ?
              AND uploader_kind = ? AND uploader_id = ?
              AND state IN ('pending', 'stored')
              AND expires_at_ms > ?) AS total
    `).get(
      scope.workspaceId, scope.eventId, columns.kind, columns.id,
      scope.workspaceId, scope.eventId, columns.kind, columns.id,
      instantMs(asOf)
    );
    return row?.total ?? 0;
  }

  /** Open intents whose window has closed; their reservations and blobs are reclaimable. */
  listExpiredOpenIntents(input: {
    readonly asOf: string;
    readonly limit: number;
  }): readonly FileUploadIntentDto[] {
    const rows = this.sqlite.query<HeadRow, [number, number]>(`
      SELECT head_json FROM file_upload_intents
       WHERE state IN ('pending', 'stored') AND expires_at_ms <= ?
       ORDER BY expires_at_ms, id LIMIT ?
    `).all(instantMs(input.asOf), input.limit);
    return Object.freeze(rows.map((row) => this.parse(row, parseFileUploadIntent)));
  }

  // -- attachments ----------------------------------------------------------

  readAttachment(scope: FileScopeDto, attachmentId: string): FileAttachmentDto | undefined {
    const row = this.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT head_json FROM file_attachments
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, attachmentId);
    return row === null ? undefined : this.parse(row, parseFileAttachment);
  }

  listAttachmentsForSubject(
    scope: FileScopeDto,
    subject: FileAttachmentSubjectDto
  ): readonly FileAttachmentDto[] {
    const columns = subjectColumns(subject);
    const rows = this.sqlite.query<HeadRow, [string, string, string, string]>(`
      SELECT head_json FROM file_attachments
       WHERE workspace_id = ? AND event_id = ? AND subject_kind = ? AND subject_id = ?
       ORDER BY attached_at_ms, id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId, columns.kind, columns.id);
    return Object.freeze(rows.map((row) => this.parse(row, parseFileAttachment)));
  }

  listAttachmentsForEvent(scope: FileScopeDto): readonly FileAttachmentDto[] {
    const rows = this.sqlite.query<HeadRow, [string, string]>(`
      SELECT head_json FROM file_attachments
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY attached_at_ms, id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
    return Object.freeze(rows.map((row) => this.parse(row, parseFileAttachment)));
  }

  countLiveAssetReferences(scope: FileScopeDto, assetId: string): number {
    const row = this.sqlite.query<CountRow, [string, string, string]>(`
      SELECT count(*) AS count FROM file_attachments
       WHERE workspace_id = ? AND event_id = ? AND asset_id = ? AND state = 'attached'
    `).get(scope.workspaceId, scope.eventId, assetId);
    return row?.count ?? 0;
  }

  createAttachment(attachment: FileAttachmentDto): void {
    this.requireTransaction();
    const subject = subjectColumns(attachment.subject);
    const actor = uploaderColumns(attachment.attachedBy);
    const link = attachment.content.kind === 'link' ? attachment.content.link : null;
    this.run(() => this.sqlite.query(`
      INSERT INTO file_attachments (
        workspace_id, event_id, id, subject_kind, subject_id, content_kind,
        asset_id, link_provider, link_label, link_url, attached_by_kind,
        attached_by_id, state, version, head_json, attached_at_ms, detached_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attachment.scope.workspaceId, attachment.scope.eventId, attachment.id,
      subject.kind, subject.id, attachment.content.kind,
      attachment.content.kind === 'asset' ? attachment.content.assetId : null,
      link?.provider ?? null, link?.label ?? null, link?.url ?? null,
      actor.kind, actor.id, attachment.state, attachment.version,
      JSON.stringify(attachment), instantMs(attachment.attachedAt),
      attachment.detachedAt === null ? null : instantMs(attachment.detachedAt)
    ));
  }

  transitionAttachment(input: {
    readonly expected: FileAttachmentDto;
    readonly next: FileAttachmentDto;
  }): void {
    this.requireTransaction();
    const changes = this.sqlite.query(`
      UPDATE file_attachments
         SET state = ?, version = ?, head_json = ?, detached_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
    `).run(
      input.next.state, input.next.version, JSON.stringify(input.next),
      input.next.detachedAt === null ? null : instantMs(input.next.detachedAt),
      input.expected.scope.workspaceId, input.expected.scope.eventId,
      input.expected.id, input.expected.version
    ).changes;
    if (changes !== 1) throw new SQLiteFilesError('stale_row');
  }

  subjectExists(scope: FileScopeDto, subject: FileAttachmentSubjectDto): boolean {
    const columns = subjectColumns(subject);
    const table = {
      engagement: 'engagement_heads',
      submission: 'intake_submission_heads',
      session: 'sessions',
      resource_share: 'resource_shares'
    }[subject.kind];
    const row = this.sqlite.query<CountRow, [string, string, string]>(`
      SELECT count(*) AS count FROM ${table}
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, columns.id);
    return (row?.count ?? 0) === 1;
  }

  // -- resource shares ------------------------------------------------------

  readResourceShare(scope: FileScopeDto, resourceShareId: string): ResourceShareDto | undefined {
    const row = this.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT head_json FROM resource_shares
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, resourceShareId);
    return row === null ? undefined : this.parse(row, parseResourceShare);
  }

  listResourceShares(scope: FileScopeDto): readonly ResourceShareDto[] {
    const rows = this.sqlite.query<HeadRow, [string, string]>(`
      SELECT head_json FROM resource_shares
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY created_at_ms, id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
    return Object.freeze(rows.map((row) => this.parse(row, parseResourceShare)));
  }

  createResourceShare(share: ResourceShareDto): void {
    this.requireTransaction();
    this.run(() => this.sqlite.query(`
      INSERT INTO resource_shares (
        workspace_id, event_id, id, title, audience_kind, audience_id,
        created_by_user_id, state, version, head_json, created_at_ms, revoked_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      share.scope.workspaceId, share.scope.eventId, share.id, share.title,
      share.audience.kind,
      share.audience.kind === 'track'
        ? share.audience.trackId
        : share.audience.kind === 'engagement' ? share.audience.engagementId : null,
      share.createdByUserId, share.state, share.version, JSON.stringify(share),
      instantMs(share.createdAt),
      share.revokedAt === null ? null : instantMs(share.revokedAt)
    ));
  }

  transitionResourceShare(input: {
    readonly expected: ResourceShareDto;
    readonly next: ResourceShareDto;
  }): void {
    this.requireTransaction();
    const changes = this.sqlite.query(`
      UPDATE resource_shares
         SET state = ?, version = ?, head_json = ?, revoked_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
    `).run(
      input.next.state, input.next.version, JSON.stringify(input.next),
      input.next.revokedAt === null ? null : instantMs(input.next.revokedAt),
      input.expected.scope.workspaceId, input.expected.scope.eventId,
      input.expected.id, input.expected.version
    ).changes;
    if (changes !== 1) throw new SQLiteFilesError('stale_row');
  }

  // -- file requests --------------------------------------------------------

  readFileRequest(scope: FileScopeDto, requestId: string): FileRequestDto | undefined {
    const row = this.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT head_json FROM file_requests
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, requestId);
    return row === null ? undefined : this.parse(row, parseFileRequest);
  }

  listFileRequestsForEngagement(
    scope: FileScopeDto,
    engagementId: string
  ): readonly FileRequestDto[] {
    const rows = this.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT head_json FROM file_requests
       WHERE workspace_id = ? AND event_id = ? AND engagement_id = ?
       ORDER BY created_at_ms, id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId, engagementId);
    return Object.freeze(rows.map((row) => this.parse(row, parseFileRequest)));
  }

  listFileRequestsForEvent(scope: FileScopeDto): readonly FileRequestDto[] {
    const rows = this.sqlite.query<HeadRow, [string, string]>(`
      SELECT head_json FROM file_requests
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY created_at_ms, id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
    return Object.freeze(rows.map((row) => this.parse(row, parseFileRequest)));
  }

  createFileRequest(request: FileRequestDto): void {
    this.requireTransaction();
    this.run(() => this.sqlite.query(`
      INSERT INTO file_requests (
        workspace_id, event_id, id, engagement_id, what, deadline_id, state,
        fulfilling_attachment_id, created_by_user_id, version, head_json,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.scope.workspaceId, request.scope.eventId, request.id,
      request.engagementId, request.what, request.deadlineId, request.state,
      request.fulfillingAttachmentId, request.createdByUserId, request.version,
      JSON.stringify(request), instantMs(request.createdAt), instantMs(request.updatedAt)
    ));
  }

  transitionFileRequest(input: {
    readonly expected: FileRequestDto;
    readonly next: FileRequestDto;
  }): void {
    this.requireTransaction();
    const changes = this.sqlite.query(`
      UPDATE file_requests
         SET state = ?, fulfilling_attachment_id = ?, version = ?, head_json = ?,
             updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
    `).run(
      input.next.state, input.next.fulfillingAttachmentId, input.next.version,
      JSON.stringify(input.next), instantMs(input.next.updatedAt),
      input.expected.scope.workspaceId, input.expected.scope.eventId,
      input.expected.id, input.expected.version
    ).changes;
    if (changes !== 1) throw new SQLiteFilesError('stale_row');
  }

  readEngagementState(
    scope: FileScopeDto,
    engagementId: string
  ): 'invited' | 'confirmed' | 'declined' | 'cancelled' | undefined {
    const row = this.sqlite.query<StateRow, [string, string, string]>(`
      SELECT state FROM engagement_heads
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, engagementId);
    if (row === null) return undefined;
    if (row.state !== 'invited' && row.state !== 'confirmed'
        && row.state !== 'declined' && row.state !== 'cancelled') {
      throw new SQLiteFilesError('data_corrupt');
    }
    return row.state;
  }

  // -- orphan sweep (D7) ----------------------------------------------------

  /**
   * Conservative v1 orphan definition: assets never referenced by ANY
   * attachment row (live or detached history) whose creation is older than the
   * grace window and that are not quarantined. Assets whose attachments were
   * detached keep their record AND their bytes so compensating re-attachment
   * always finds them; post-event retention is a later, separate policy.
   */
  listCollectableAssets(input: {
    readonly asOf: string;
    readonly graceMs: number;
    readonly limit: number;
  }): readonly FileAssetDto[] {
    const threshold = instantMs(input.asOf) - input.graceMs;
    const rows = this.sqlite.query<HeadRow, [number, number]>(`
      SELECT head_json FROM file_assets AS asset
       WHERE asset.created_at_ms <= ?
         AND asset.lifecycle <> 'blocked'
         AND NOT EXISTS (
           SELECT 1 FROM file_attachments AS attachment
            WHERE attachment.workspace_id = asset.workspace_id
              AND attachment.event_id = asset.event_id
              AND attachment.asset_id = asset.id
         )
       ORDER BY asset.created_at_ms, asset.id COLLATE BINARY
       LIMIT ?
    `).all(threshold, input.limit);
    return Object.freeze(rows.map((row) => this.parse(row, parseFileAsset)));
  }

  deleteAssetRecord(input: { readonly assetId: string; readonly expectedVersion: number }): boolean {
    this.requireTransaction();
    return this.sqlite.query(`
      DELETE FROM file_assets
       WHERE id = ? AND version = ?
         AND NOT EXISTS (
           SELECT 1 FROM file_attachments AS attachment
            WHERE attachment.workspace_id = file_assets.workspace_id
              AND attachment.event_id = file_assets.event_id
              AND attachment.asset_id = file_assets.id
         )
    `).run(input.assetId, input.expectedVersion).changes === 1;
  }

  // -- shared ---------------------------------------------------------------

  private requireTransaction(): void {
    if (!this.sqlite.inTransaction) throw new SQLiteFilesError('transaction_required');
  }

  private parse<Value>(row: HeadRow, parser: (value: unknown) => Value): Value {
    try {
      return parser(JSON.parse(row.head_json));
    } catch (error) {
      throw new SQLiteFilesError('data_corrupt', error);
    }
  }

  private run(operation: () => unknown): void {
    try {
      operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed')) {
        throw new SQLiteFilesError('duplicate_row', error);
      }
      if (message.includes('FOREIGN KEY constraint failed')) {
        throw new SQLiteFilesError('scope_corrupt', error);
      }
      throw error;
    }
  }
}
