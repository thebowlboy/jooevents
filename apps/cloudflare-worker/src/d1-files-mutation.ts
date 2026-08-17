import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';
import type {
  FileAssetDto,
  FileAttachmentDto,
  FileAttachmentSubjectDto,
  FileRequestDto,
  FileScopeDto,
  FileUploadIntentDto,
  FileUploadLimitsDto,
  FileUploaderPrincipalDto,
  ResourceShareDto
} from '@jooevents/contracts/files';
import { deadlineReferencePin, type DeadlineReferenceResolver } from '@jooevents/deadline';
import {
  NONE_SCAN_PROVIDER,
  parseFileAsset,
  parseFileAttachment,
  parseFileRequest,
  parseFileUploadIntent,
  parseResourceShare,
  type ResourceShareAudienceSource
} from '@jooevents/files/commands';
import {
  dispatchFilesCommand,
  FILES_COMMAND_ACCESS_POLICY,
  FILES_COMMAND_ACTIONS,
  FILES_COMMAND_HANDLER_CAPABILITY,
  filesCommandContributionSchema,
  filesCommandDomainContributionSchema,
  sealFilesCommandPreparation,
  type FilesCommandAction,
  type FilesCommandActor,
  type FilesCommandPreparedContribution,
  type FilesCommandRepository
} from '@jooevents/files-operations';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import { guardD1DeadlineCatalog, readD1DeadlineCatalog } from './d1-deadline';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

const MAX_ROWS = 10_000;
const FILES_PERMISSION_ID = 'event.manage';

interface EventSetRow { readonly version: number; readonly current_event_id: string | null }
interface ScopeRootRow { readonly event_id: string }
interface HeadRow { readonly head_json: string }
interface EngagementRow { readonly id: string; readonly state: string; readonly version: number }
interface IdRow { readonly id: string }
interface SubmissionIdRow { readonly submission_id: string }

interface Snapshot {
  readonly intents: readonly FileUploadIntentDto[];
  readonly assets: readonly FileAssetDto[];
  readonly attachments: readonly FileAttachmentDto[];
  readonly shares: readonly ResourceShareDto[];
  readonly requests: readonly FileRequestDto[];
  readonly engagements: readonly EngagementRow[];
  readonly submissions: ReadonlySet<string>;
  readonly sessions: ReadonlySet<string>;
  readonly tracks: ReadonlySet<string>;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameScope(left: FileScopeDto, right: FileScopeDto): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return eventId !== undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId);
}

function operationAction(name: string): FilesCommandAction | undefined {
  const prefix = 'file.';
  if (!name.startsWith(prefix)) return undefined;
  const action = name.slice(prefix.length);
  return (FILES_COMMAND_ACTIONS as readonly string[]).includes(action)
    ? action as FilesCommandAction
    : undefined;
}

function bounded<Row>(rows: readonly Row[], label: string): readonly Row[] {
  if (rows.length > MAX_ROWS) throw new TypeError(`d1_files_${label}_limit`);
  return rows;
}

function parseRows<Value>(
  rows: readonly HeadRow[],
  scope: FileScopeDto,
  parser: (value: unknown) => Value & { readonly scope: FileScopeDto },
  label: string
): readonly Value[] {
  return bounded(rows, label).map((row) => {
    let parsed: Value & { readonly scope: FileScopeDto };
    try {
      parsed = parser(JSON.parse(row.head_json));
    } catch (error) {
      throw new TypeError(`d1_files_${label}_corrupt`, { cause: error });
    }
    if (!sameScope(parsed.scope, scope) || canonicalJsonText(parsed) !== row.head_json) {
      throw new TypeError(`d1_files_${label}_corrupt`);
    }
    return parsed;
  });
}

async function readSnapshot(
  unitOfWork: D1BufferedUnitOfWork,
  scope: FileScopeDto
): Promise<{ readonly root: ScopeRootRow; readonly snapshot: Snapshot }> {
  const session = unitOfWork.readSession;
  const results = await session.batch([
    session.prepare(`SELECT event_id FROM event_spine_scope_roots
      WHERE workspace_id = ? AND event_id = ? LIMIT 2`)
      .bind(scope.workspaceId, scope.eventId),
    session.prepare(`SELECT head_json FROM file_upload_intents
      WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(scope.workspaceId, scope.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT head_json FROM file_assets
      WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(scope.workspaceId, scope.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT head_json FROM file_attachments
      WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(scope.workspaceId, scope.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT head_json FROM resource_shares
      WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(scope.workspaceId, scope.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT head_json FROM file_requests
      WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(scope.workspaceId, scope.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT id,state,version FROM engagement_heads
      WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(scope.workspaceId, scope.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT submission_id FROM intake_submission_heads
      WHERE workspace_id = ? AND event_id = ? ORDER BY submission_id COLLATE BINARY LIMIT ?`)
      .bind(scope.workspaceId, scope.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT id FROM sessions
      WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(scope.workspaceId, scope.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT id FROM program_vocabulary_tracks
      WHERE workspace_id = ? AND event_id = ? AND status = 'active'
      ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(scope.workspaceId, scope.eventId, MAX_ROWS + 1)
  ]);
  const roots = (results[0] as D1Result<ScopeRootRow>).results;
  if (roots.length !== 1 || roots[0]!.event_id !== scope.eventId) {
    throw new TypeError('d1_files_scope_missing');
  }
  const engagements = bounded(
    (results[6] as D1Result<EngagementRow>).results,
    'engagements'
  );
  for (const row of engagements) {
    if (!['invited', 'confirmed', 'declined', 'cancelled'].includes(row.state)
        || !Number.isSafeInteger(row.version) || row.version <= 0) {
      throw new TypeError('d1_files_engagements_corrupt');
    }
  }
  const submissions = bounded(
    (results[7] as D1Result<SubmissionIdRow>).results,
    'submissions'
  );
  const sessions = bounded((results[8] as D1Result<IdRow>).results, 'sessions');
  const tracks = bounded((results[9] as D1Result<IdRow>).results, 'tracks');
  return Object.freeze({
    root: roots[0]!,
    snapshot: Object.freeze({
      intents: parseRows(
        (results[1] as D1Result<HeadRow>).results, scope, parseFileUploadIntent, 'intents'
      ),
      assets: parseRows(
        (results[2] as D1Result<HeadRow>).results, scope, parseFileAsset, 'assets'
      ),
      attachments: parseRows(
        (results[3] as D1Result<HeadRow>).results, scope, parseFileAttachment, 'attachments'
      ),
      shares: parseRows(
        (results[4] as D1Result<HeadRow>).results, scope, parseResourceShare, 'shares'
      ),
      requests: parseRows(
        (results[5] as D1Result<HeadRow>).results, scope, parseFileRequest, 'requests'
      ),
      engagements,
      submissions: new Set(submissions.map((row) => row.submission_id)),
      sessions: new Set(sessions.map((row) => row.id)),
      tracks: new Set(tracks.map((row) => row.id))
    })
  });
}

function uploaderColumns(principal: FileUploaderPrincipalDto): readonly [string, string] {
  return principal.kind === 'operator_user'
    ? ['operator_user', principal.userId]
    : ['participant', principal.participantIdentityId];
}

function subjectColumns(
  subject: FileAttachmentSubjectDto
): readonly [FileAttachmentSubjectDto['kind'], string] {
  switch (subject.kind) {
    case 'engagement': return ['engagement', subject.engagementId];
    case 'submission': return ['submission', subject.submissionId];
    case 'session': return ['session', subject.sessionId];
    case 'resource_share': return ['resource_share', subject.resourceShareId];
  }
}

function instantMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError('d1_files_instant_invalid');
  return parsed;
}

function assertHead(
  unitOfWork: D1BufferedUnitOfWork,
  table: string,
  idColumn: string,
  scope: FileScopeDto,
  id: string,
  value: { readonly scope: FileScopeDto } | undefined
): void {
  unitOfWork.assertCurrent(value
    ? `EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = ? AND event_id = ?
        AND ${idColumn} = ? AND head_json = ?)`
    : `NOT EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = ? AND event_id = ?
        AND ${idColumn} = ?)`, value
    ? [scope.workspaceId, scope.eventId, id, canonicalJsonText(value)]
    : [scope.workspaceId, scope.eventId, id]);
}

/** Synchronous snapshot repository whose writes are buffered into the D1 batch. */
class D1FilesCommandRepository implements FilesCommandRepository {
  readonly #intents = new Map<string, FileUploadIntentDto>();
  readonly #assets = new Map<string, FileAssetDto>();
  readonly #attachments = new Map<string, FileAttachmentDto>();
  readonly #shares = new Map<string, ResourceShareDto>();
  readonly #requests = new Map<string, FileRequestDto>();
  readonly #engagements = new Map<string, EngagementRow>();

  constructor(
    private readonly unitOfWork: D1BufferedUnitOfWork,
    private readonly scope: FileScopeDto,
    private readonly snapshot: Snapshot
  ) {
    for (const row of snapshot.intents) this.#intents.set(row.id, row);
    for (const row of snapshot.assets) this.#assets.set(row.id, row);
    for (const row of snapshot.attachments) this.#attachments.set(row.id, row);
    for (const row of snapshot.shares) this.#shares.set(row.id, row);
    for (const row of snapshot.requests) this.#requests.set(row.id, row);
    for (const row of snapshot.engagements) this.#engagements.set(row.id, row);
  }

  #same(requested: FileScopeDto): boolean { return sameScope(requested, this.scope); }

  readIntent(scope: FileScopeDto, id: string): FileUploadIntentDto | undefined {
    if (!this.#same(scope)) return undefined;
    const value = this.#intents.get(id);
    assertHead(this.unitOfWork, 'file_upload_intents', 'id', scope, id, value);
    return value;
  }

  createIntent(intent: FileUploadIntentDto): void {
    if (!this.#same(intent.scope) || this.#intents.has(intent.id)) {
      throw new TypeError('d1_files_intent_create_invalid');
    }
    const [uploaderKind, uploaderId] = uploaderColumns(intent.uploader);
    this.unitOfWork.write(`INSERT INTO file_upload_intents (
      workspace_id,event_id,id,uploader_kind,uploader_id,purpose,content_type,
      declared_byte_size,maximum_byte_size,storage_provider,storage_key,state,
      stored_byte_size,stored_sha256,head_json,created_at_ms,expires_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      intent.scope.workspaceId, intent.scope.eventId, intent.id, uploaderKind, uploaderId,
      intent.purpose, intent.contentType, intent.declaredByteSize, intent.maximumByteSize,
      intent.storageProvider, intent.storageKey, intent.state, intent.storedByteSize,
      intent.storedSha256, canonicalJsonText(intent), instantMs(intent.createdAt),
      instantMs(intent.expiresAt)
    ]);
    this.#intents.set(intent.id, intent);
  }

  transitionIntent(input: {
    readonly expected: FileUploadIntentDto;
    readonly next: FileUploadIntentDto;
  }): void {
    const current = this.#intents.get(input.expected.id);
    if (!current || canonicalJsonText(current) !== canonicalJsonText(input.expected)) {
      throw new TypeError('d1_files_intent_transition_invalid');
    }
    this.unitOfWork.write(`UPDATE file_upload_intents
      SET state = ?,stored_byte_size = ?,stored_sha256 = ?,head_json = ?
      WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?`, [
      input.next.state, input.next.storedByteSize, input.next.storedSha256,
      canonicalJsonText(input.next), input.expected.scope.workspaceId,
      input.expected.scope.eventId, input.expected.id, canonicalJsonText(input.expected)
    ]);
    this.#intents.set(input.next.id, input.next);
  }

  readAsset(scope: FileScopeDto, id: string): FileAssetDto | undefined {
    if (!this.#same(scope)) return undefined;
    const value = this.#assets.get(id);
    assertHead(this.unitOfWork, 'file_assets', 'id', scope, id, value);
    return value;
  }

  createAsset(asset: FileAssetDto): void {
    if (!this.#same(asset.scope) || this.#assets.has(asset.id)) {
      throw new TypeError('d1_files_asset_create_invalid');
    }
    const [uploaderKind, uploaderId] = uploaderColumns(asset.uploader);
    this.unitOfWork.write(`INSERT INTO file_assets (
      workspace_id,event_id,id,uploader_kind,uploader_id,purpose,display_filename,
      content_type,byte_size,sha256,storage_provider,storage_key,lifecycle,
      scan_provider,scan_verdict,scan_checked_at_ms,version,head_json,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      asset.scope.workspaceId, asset.scope.eventId, asset.id, uploaderKind, uploaderId,
      asset.purpose, asset.displayFilename, asset.contentType, asset.byteSize, asset.sha256,
      asset.storageProvider, asset.storageKey, asset.lifecycle, asset.scan.provider,
      asset.scan.verdict, asset.scan.checkedAt === null ? null : instantMs(asset.scan.checkedAt),
      asset.version, canonicalJsonText(asset), instantMs(asset.createdAt), instantMs(asset.updatedAt)
    ]);
    this.#assets.set(asset.id, asset);
  }

  readUploaderStoredBytes(
    scope: FileScopeDto,
    uploader: FileUploaderPrincipalDto,
    asOf: string
  ): number {
    if (!this.#same(scope)) return 0;
    const [kind, id] = uploaderColumns(uploader);
    const asOfMs = instantMs(asOf);
    const assetBytes = this.snapshot.assets
      .filter((asset) => {
        const columns = uploaderColumns(asset.uploader);
        return columns[0] === kind && columns[1] === id;
      })
      .reduce((total, asset) => total + asset.byteSize, 0);
    const reservedBytes = this.snapshot.intents
      .filter((intent) => {
        const columns = uploaderColumns(intent.uploader);
        return columns[0] === kind && columns[1] === id
          && (intent.state === 'pending' || intent.state === 'stored')
          && instantMs(intent.expiresAt) > asOfMs;
      })
      .reduce((total, intent) =>
        total + Math.max(intent.declaredByteSize, intent.storedByteSize ?? 0), 0);
    const total = assetBytes + reservedBytes;
    this.unitOfWork.assertCurrent(`(
      SELECT COALESCE(sum(byte_size),0) FROM file_assets
       WHERE workspace_id = ? AND event_id = ? AND uploader_kind = ? AND uploader_id = ?
    ) + (
      SELECT COALESCE(sum(MAX(declared_byte_size,COALESCE(stored_byte_size,0))),0)
        FROM file_upload_intents WHERE workspace_id = ? AND event_id = ?
         AND uploader_kind = ? AND uploader_id = ? AND state IN ('pending','stored')
         AND expires_at_ms > ?
    ) = ?`, [scope.workspaceId, scope.eventId, kind, id, scope.workspaceId,
      scope.eventId, kind, id, asOfMs, total]);
    return total;
  }

  readAttachment(scope: FileScopeDto, id: string): FileAttachmentDto | undefined {
    if (!this.#same(scope)) return undefined;
    const value = this.#attachments.get(id);
    assertHead(this.unitOfWork, 'file_attachments', 'id', scope, id, value);
    return value;
  }

  listAttachmentsForSubject(
    scope: FileScopeDto,
    subject: FileAttachmentSubjectDto
  ): readonly FileAttachmentDto[] {
    if (!this.#same(scope)) return Object.freeze([]);
    const [kind, id] = subjectColumns(subject);
    const values = [...this.#attachments.values()].filter((entry) => {
      const columns = subjectColumns(entry.subject);
      return columns[0] === kind && columns[1] === id;
    });
    this.unitOfWork.assertCurrent(`(SELECT count(*) FROM file_attachments
      WHERE workspace_id = ? AND event_id = ? AND subject_kind = ? AND subject_id = ?) = ?`,
    [scope.workspaceId, scope.eventId, kind, id, values.length]);
    return Object.freeze(values);
  }

  countLiveAssetReferences(scope: FileScopeDto, assetId: string): number {
    if (!this.#same(scope)) return 0;
    const count = [...this.#attachments.values()].filter((entry) =>
      entry.state === 'attached' && entry.content.kind === 'asset'
      && entry.content.assetId === assetId).length;
    this.unitOfWork.assertCurrent(`(SELECT count(*) FROM file_attachments
      WHERE workspace_id = ? AND event_id = ? AND asset_id = ? AND state = 'attached') = ?`,
    [scope.workspaceId, scope.eventId, assetId, count]);
    return count;
  }

  createAttachment(attachment: FileAttachmentDto): void {
    if (!this.#same(attachment.scope) || this.#attachments.has(attachment.id)) {
      throw new TypeError('d1_files_attachment_create_invalid');
    }
    const [subjectKind, subjectId] = subjectColumns(attachment.subject);
    const [actorKind, actorId] = uploaderColumns(attachment.attachedBy);
    const link = attachment.content.kind === 'link' ? attachment.content.link : null;
    this.unitOfWork.write(`INSERT INTO file_attachments (
      workspace_id,event_id,id,subject_kind,subject_id,content_kind,asset_id,
      link_provider,link_label,link_url,attached_by_kind,attached_by_id,state,
      version,head_json,attached_at_ms,detached_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      attachment.scope.workspaceId, attachment.scope.eventId, attachment.id,
      subjectKind, subjectId, attachment.content.kind,
      attachment.content.kind === 'asset' ? attachment.content.assetId : null,
      link?.provider ?? null, link?.label ?? null, link?.url ?? null,
      actorKind, actorId, attachment.state, attachment.version,
      canonicalJsonText(attachment), instantMs(attachment.attachedAt),
      attachment.detachedAt === null ? null : instantMs(attachment.detachedAt)
    ]);
    this.#attachments.set(attachment.id, attachment);
  }

  transitionAttachment(input: {
    readonly expected: FileAttachmentDto;
    readonly next: FileAttachmentDto;
  }): void {
    const current = this.#attachments.get(input.expected.id);
    if (!current || canonicalJsonText(current) !== canonicalJsonText(input.expected)) {
      throw new TypeError('d1_files_attachment_transition_invalid');
    }
    this.unitOfWork.write(`UPDATE file_attachments SET state = ?,version = ?,head_json = ?,
      detached_at_ms = ? WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?`, [
      input.next.state, input.next.version, canonicalJsonText(input.next),
      input.next.detachedAt === null ? null : instantMs(input.next.detachedAt),
      input.expected.scope.workspaceId, input.expected.scope.eventId, input.expected.id,
      canonicalJsonText(input.expected)
    ]);
    this.#attachments.set(input.next.id, input.next);
  }

  subjectExists(scope: FileScopeDto, subject: FileAttachmentSubjectDto): boolean {
    if (!this.#same(scope)) return false;
    const [kind, id] = subjectColumns(subject);
    const locations = {
      engagement: ['engagement_heads', 'id'],
      submission: ['intake_submission_heads', 'submission_id'],
      session: ['sessions', 'id'],
      resource_share: ['resource_shares', 'id']
    } as const;
    const [table, column] = locations[kind];
    const exists = kind === 'engagement' ? this.#engagements.has(id)
      : kind === 'submission' ? this.snapshot.submissions.has(id)
        : kind === 'session' ? this.snapshot.sessions.has(id)
          : this.#shares.has(id);
    this.unitOfWork.assertCurrent(`${exists ? 'EXISTS' : 'NOT EXISTS'}
      (SELECT 1 FROM ${table} WHERE workspace_id = ? AND event_id = ? AND ${column} = ?)`,
    [scope.workspaceId, scope.eventId, id]);
    return exists;
  }

  readResourceShare(scope: FileScopeDto, id: string): ResourceShareDto | undefined {
    if (!this.#same(scope)) return undefined;
    const value = this.#shares.get(id);
    assertHead(this.unitOfWork, 'resource_shares', 'id', scope, id, value);
    return value;
  }

  listResourceShares(scope: FileScopeDto): readonly ResourceShareDto[] {
    if (!this.#same(scope)) return Object.freeze([]);
    const values = [...this.#shares.values()];
    this.unitOfWork.assertCurrent(`(SELECT count(*) FROM resource_shares
      WHERE workspace_id = ? AND event_id = ?) = ?`,
    [scope.workspaceId, scope.eventId, values.length]);
    return Object.freeze(values);
  }

  createResourceShare(share: ResourceShareDto): void {
    if (!this.#same(share.scope) || this.#shares.has(share.id)) {
      throw new TypeError('d1_files_share_create_invalid');
    }
    const audienceId = share.audience.kind === 'track' ? share.audience.trackId
      : share.audience.kind === 'engagement' ? share.audience.engagementId : null;
    this.unitOfWork.write(`INSERT INTO resource_shares (
      workspace_id,event_id,id,title,audience_kind,audience_id,created_by_user_id,
      state,version,head_json,created_at_ms,revoked_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      share.scope.workspaceId, share.scope.eventId, share.id, share.title,
      share.audience.kind, audienceId, share.createdByUserId, share.state, share.version,
      canonicalJsonText(share), instantMs(share.createdAt),
      share.revokedAt === null ? null : instantMs(share.revokedAt)
    ]);
    this.#shares.set(share.id, share);
  }

  transitionResourceShare(input: {
    readonly expected: ResourceShareDto;
    readonly next: ResourceShareDto;
  }): void {
    const current = this.#shares.get(input.expected.id);
    if (!current || canonicalJsonText(current) !== canonicalJsonText(input.expected)) {
      throw new TypeError('d1_files_share_transition_invalid');
    }
    this.unitOfWork.write(`UPDATE resource_shares SET state = ?,version = ?,head_json = ?,
      revoked_at_ms = ? WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?`, [
      input.next.state, input.next.version, canonicalJsonText(input.next),
      input.next.revokedAt === null ? null : instantMs(input.next.revokedAt),
      input.expected.scope.workspaceId, input.expected.scope.eventId, input.expected.id,
      canonicalJsonText(input.expected)
    ]);
    this.#shares.set(input.next.id, input.next);
  }

  readFileRequest(scope: FileScopeDto, id: string): FileRequestDto | undefined {
    if (!this.#same(scope)) return undefined;
    const value = this.#requests.get(id);
    assertHead(this.unitOfWork, 'file_requests', 'id', scope, id, value);
    return value;
  }

  listFileRequestsForEngagement(
    scope: FileScopeDto,
    engagementId: string
  ): readonly FileRequestDto[] {
    if (!this.#same(scope)) return Object.freeze([]);
    const values = [...this.#requests.values()].filter((entry) =>
      entry.engagementId === engagementId);
    this.unitOfWork.assertCurrent(`(SELECT count(*) FROM file_requests
      WHERE workspace_id = ? AND event_id = ? AND engagement_id = ?) = ?`,
    [scope.workspaceId, scope.eventId, engagementId, values.length]);
    return Object.freeze(values);
  }

  createFileRequest(request: FileRequestDto): void {
    if (!this.#same(request.scope) || this.#requests.has(request.id)) {
      throw new TypeError('d1_files_request_create_invalid');
    }
    this.unitOfWork.write(`INSERT INTO file_requests (
      workspace_id,event_id,id,engagement_id,what,deadline_id,state,
      fulfilling_attachment_id,created_by_user_id,version,head_json,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      request.scope.workspaceId, request.scope.eventId, request.id, request.engagementId,
      request.what, request.deadlineId, request.state, request.fulfillingAttachmentId,
      request.createdByUserId, request.version, canonicalJsonText(request),
      instantMs(request.createdAt), instantMs(request.updatedAt)
    ]);
    this.#requests.set(request.id, request);
  }

  transitionFileRequest(input: {
    readonly expected: FileRequestDto;
    readonly next: FileRequestDto;
  }): void {
    const current = this.#requests.get(input.expected.id);
    if (!current || canonicalJsonText(current) !== canonicalJsonText(input.expected)) {
      throw new TypeError('d1_files_request_transition_invalid');
    }
    this.unitOfWork.write(`UPDATE file_requests SET state = ?,fulfilling_attachment_id = ?,
      version = ?,head_json = ?,updated_at_ms = ?
      WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?`, [
      input.next.state, input.next.fulfillingAttachmentId, input.next.version,
      canonicalJsonText(input.next), instantMs(input.next.updatedAt),
      input.expected.scope.workspaceId, input.expected.scope.eventId, input.expected.id,
      canonicalJsonText(input.expected)
    ]);
    this.#requests.set(input.next.id, input.next);
  }

  readEngagementState(
    scope: FileScopeDto,
    engagementId: string
  ): 'invited' | 'confirmed' | 'declined' | 'cancelled' | undefined {
    if (!this.#same(scope)) return undefined;
    const row = this.#engagements.get(engagementId);
    this.unitOfWork.assertCurrent(row
      ? `EXISTS (SELECT 1 FROM engagement_heads WHERE workspace_id = ? AND event_id = ?
          AND id = ? AND state = ? AND version = ?)`
      : `NOT EXISTS (SELECT 1 FROM engagement_heads WHERE workspace_id = ? AND event_id = ?
          AND id = ?)`, row
      ? [scope.workspaceId, scope.eventId, engagementId, row.state, row.version]
      : [scope.workspaceId, scope.eventId, engagementId]);
    return row?.state as 'invited' | 'confirmed' | 'declined' | 'cancelled' | undefined;
  }
}

interface Prepared {
  readonly domain: ReturnType<typeof filesCommandDomainContributionSchema.parse>;
  phase: 'prepared' | 'applied';
}

/** Complete organizer-only Files command family over guarded D1 writes. */
export class D1FilesCommandEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #issuedIds = new Set<string>();
  #prepared: Prepared | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly limits: FileUploadLimitsDto;
    readonly storageProvider: string;
    readonly ids: {
      newPreparationHandle(): string;
      newFactId(): string;
    };
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (!sameRef(capability, FILES_COMMAND_HANDLER_CAPABILITY)) {
      throw new TypeError('d1_files_capability_mismatch');
    }
    const action = operationAction(context.operation.name);
    if (!action || context.operation.version !== 1 || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId || !exactSubjects(context)) {
      throw new TypeError('d1_files_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !sameRef(authority.lane.policy, FILES_COMMAND_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === FILES_PERMISSION_ID)) {
      throw new TypeError('d1_files_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = parseEventId(context.scope.eventId!);
    const scope = Object.freeze({ workspaceId: this.#workspaceId, eventId });
    const eventSet = await this.input.unitOfWork.readSession.prepare(
      `SELECT version,current_event_id FROM event_spine_workspace_sets WHERE workspace_id = ?`
    ).bind(this.#workspaceId).first<EventSetRow>();
    if (!eventSet || eventSet.current_event_id !== eventId) {
      throw new TypeError('d1_files_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id = ? AND version = ? AND current_event_id = ?)`, [
      this.#workspaceId, eventSet.version, eventId
    ]);
    const [{ snapshot }, deadlineCatalog] = await Promise.all([
      readSnapshot(this.input.unitOfWork, scope),
      readD1DeadlineCatalog(this.input.unitOfWork.readSession, scope)
    ]);
    if (!deadlineCatalog) throw new TypeError('d1_files_deadline_catalog_missing');
    const repository = new D1FilesCommandRepository(this.input.unitOfWork, scope, snapshot);
    const actor: FilesCommandActor = Object.freeze({
      principal: Object.freeze({ kind: 'operator_user' as const, userId: actorUserId }),
      operatorUserId: actorUserId,
      freshEngagementIds: undefined
    });
    const deadlines: DeadlineReferenceResolver = Object.freeze({
      resolveCurrentDeadline: (
        requestedScope: FileScopeDto,
        reference: { readonly deadlineId: string }
      ) => {
        if (!sameScope(requestedScope, scope)) return undefined;
        guardD1DeadlineCatalog(this.input.unitOfWork, deadlineCatalog);
        const head = deadlineCatalog.deadlines.find((entry) =>
          entry.id === reference.deadlineId && entry.status === 'active');
        return head ? deadlineReferencePin(head) : undefined;
      }
    });
    const audiences: ResourceShareAudienceSource = Object.freeze({
      trackExists: (requestedScope: FileScopeDto, trackId: string) => {
        if (!sameScope(requestedScope, scope)) return false;
        const exists = snapshot.tracks.has(trackId);
        this.input.unitOfWork.assertCurrent(`${exists ? 'EXISTS' : 'NOT EXISTS'}
          (SELECT 1 FROM program_vocabulary_tracks WHERE workspace_id = ? AND event_id = ?
           AND id = ? AND status = 'active')`, [scope.workspaceId, scope.eventId, trackId]);
        return exists;
      },
      engagementExists: (requestedScope: FileScopeDto, engagementId: string) =>
        repository.subjectExists(requestedScope, { kind: 'engagement', engagementId })
    });
    this.#prepared = undefined;
    return sealFilesCommandPreparation({
      capability,
      context,
      preparation: Object.freeze({
        prepare: ({ action: receivedAction, businessInput, context: receivedContext,
          portalRelationship }: {
          readonly action: FilesCommandAction;
          readonly businessInput: unknown;
          readonly context: EffectInvocationContext;
          readonly portalRelationship: { readonly engagementIds: readonly string[] } | null;
        }): FilesCommandPreparedContribution => {
          if (receivedAction !== action || receivedContext !== context
              || portalRelationship !== null) {
            throw new TypeError('d1_files_context_substitution');
          }
          const dispatched = dispatchFilesCommand({
            action,
            businessInput,
            scope,
            actor,
            occurredAt,
            repository,
            limits: this.input.limits,
            storageProvider: this.input.storageProvider,
            scanProvider: NONE_SCAN_PROVIDER,
            deadlines,
            audiences
          });
          if (dispatched.kind === 'refused') {
            return Object.freeze({
              result: Object.freeze({
                kind: 'outcome' as const,
                outcome: Object.freeze({
                  class: 'policy_violation' as const,
                  kind: 'file.command_refused',
                  retryable: false,
                  subjects: [],
                  detail: Object.freeze({ action, code: dispatched.code }),
                  detailSchemaVersion: 1
                })
              }),
              domain: null,
              effectContributions: Object.freeze([])
            });
          }
          const handle = this.#fresh(this.input.ids.newPreparationHandle);
          const parsed = filesCommandContributionSchema(action).parse({
            result: { kind: 'success', data: dispatched.success.data },
            domain: {
              kind: 'files_command', preparationHandle: handle, action,
              workspaceId: scope.workspaceId, eventId: scope.eventId,
              recordId: dispatched.success.recordId,
              recordVersion: dispatched.success.recordVersion,
              occurredAt
            },
            effectContributions: dispatched.success.facts.map((fact) => ({
              kind: 'domain_fact',
              factId: this.#fresh(this.input.ids.newFactId),
              factKind: fact.kind,
              payload: fact.payload,
              occurredAt
            }))
          });
          if (parsed.domain === null) throw new TypeError('d1_files_evidence_missing');
          this.#prepared = { domain: parsed.domain, phase: 'prepared' };
          return parsed;
        }
      })
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const parsed = filesCommandDomainContributionSchema.parse(contribution);
    if (!this.#prepared || this.#prepared.phase !== 'prepared'
        || canonicalJsonText(this.#prepared.domain) !== canonicalJsonText(parsed)) {
      throw new TypeError('d1_files_preparation_invalid');
    }
    this.#prepared.phase = 'applied';
  }

  afterUnitOfWorkFinished(): void { this.#prepared = undefined; }

  #fresh(factory: () => string): string {
    const value = factory();
    if (typeof value !== 'string' || value.length === 0 || this.#issuedIds.has(value)) {
      throw new TypeError('d1_files_ids_not_unique');
    }
    this.#issuedIds.add(value);
    return value;
  }
}

export function createD1FilesCommandEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly limits: FileUploadLimitsDto;
  readonly storageProvider: string;
  readonly ids: {
    newPreparationHandle(): string;
    newFactId(): string;
  };
}): D1EffectDomainAdapterRegistration {
  return Object.freeze({
    capability: FILES_COMMAND_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) => new D1FilesCommandEffectDomainAdapter({
      unitOfWork,
      workspaceId: input.workspaceId,
      limits: input.limits,
      storageProvider: input.storageProvider,
      ids: input.ids
    })
  });
}
