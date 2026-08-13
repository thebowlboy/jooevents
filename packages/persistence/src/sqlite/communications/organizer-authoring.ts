import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles,
  type EffectInvocationContext
} from '@jooevents/application';
import {
  adoptSynchronousClassifiedPayload,
  openSynchronousClassifiedPayloadAdoptionReceipt,
  SynchronousClassifiedPayloadStoreError,
  type SynchronousClassifiedPayloadBinding,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID,
  ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
  organizerCommunicationAudienceDraftSchema,
  organizerCommunicationAuthoringPayloadInputSchema,
  organizerCommunicationDraftGetInputSchema,
  organizerCommunicationDraftListInputSchema,
  organizerCommunicationDraftMutationResultSchema,
  organizerCommunicationDraftPageSchema,
  organizerCommunicationDraftProjectionSchema,
  organizerCommunicationDraftProvenanceSchema,
  organizerCommunicationDraftSummarySchema,
  organizerCommunicationPurposeDetailSchema,
  organizerCommunicationPurposeGetInputSchema,
  organizerCommunicationPurposeListInputSchema,
  organizerCommunicationPurposePageSchema,
  organizerCreateCommunicationDraftInputSchema,
  organizerDiscardCommunicationDraftInputSchema,
  organizerEmailMessageContentSchema,
  organizerMessageTemplateDetailSchema,
  organizerMessageTemplateGetInputSchema,
  organizerMessageTemplateListInputSchema,
  organizerMessageTemplatePageSchema,
  organizerReviseCommunicationDraftInputSchema,
  organizerStoreAuthoringPayloadInputSchema,
  type OrganizerCommunicationDraftProvenance
} from '@jooevents/contracts/communications/organizer';
import {
  ORGANIZER_AUTHORING_PAYLOAD_PROFILES,
  OrganizerAuthoringPayloadError,
  OrganizerMessageDraftError,
  canonicalizeOrganizerAuthoringPayload,
  createOrganizerAuthoringPayloadRef,
  createOrganizerMessageDraft,
  discardOrganizerMessageDraft,
  reviseOrganizerMessageDraft,
  type CanonicalOrganizerAuthoringPayload,
  type OrganizerAuthoringPayloadKind,
  type OrganizerMessageDraftRecord
} from '@jooevents/communications';
import {
  organizerCommunicationMutationContributionSchema,
  type OrganizerCommunicationCanonicalResult,
  type OrganizerCommunicationReadPort,
  type OrganizerCommunicationScope,
  type OrganizerCommunicationMutationOperationName,
  type OrganizerCommunicationMutationPreparation
} from '@jooevents/communication-operations';
import {
  canonicalJsonText,
  createPayloadRef,
  parseEventId,
  parseInstant,
  parsePayloadRefId,
  parseWorkspaceId,
  type Instant,
  type PayloadRefId
} from '@jooevents/kernel';

export const SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_SQL = `
CREATE TABLE communication_authoring_payloads (
  payload_ref_id TEXT PRIMARY KEY NOT NULL REFERENCES classified_payload_records(payload_ref_id),
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  owner_key TEXT NOT NULL CHECK(length(owner_key) BETWEEN 1 AND 256),
  payload_kind TEXT NOT NULL CHECK(payload_kind IN (
    'template_content','template_field_bindings','template_field_fallback',
    'message_content','message_audience_draft'
  )),
  payload_schema_key TEXT NOT NULL,
  payload_schema_version INTEGER NOT NULL CHECK(payload_schema_version = 1),
  classification_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id,event_id,owner_key,payload_ref_id)
);
CREATE INDEX communication_authoring_payloads_scope_kind
  ON communication_authoring_payloads(workspace_id,event_id,owner_key,payload_kind,payload_ref_id);
CREATE TRIGGER communication_authoring_payloads_immutable_update
BEFORE UPDATE ON communication_authoring_payloads
BEGIN SELECT RAISE(ABORT, 'communication authoring payload metadata is immutable'); END;
CREATE TRIGGER communication_authoring_payloads_immutable_delete
BEFORE DELETE ON communication_authoring_payloads
BEGIN SELECT RAISE(ABORT, 'communication authoring payload metadata is immutable'); END;

CREATE TABLE communication_purposes (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  purpose_id TEXT NOT NULL,
  purpose_key TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','active','archived')),
  current_revision_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,purpose_id),
  UNIQUE(workspace_id,event_id,purpose_key)
);
CREATE TABLE communication_purpose_revisions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  purpose_id TEXT NOT NULL,
  purpose_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64),
  label TEXT NOT NULL,
  communication_class TEXT NOT NULL,
  policy_digest_sha256 TEXT NOT NULL CHECK(length(policy_digest_sha256) = 64),
  description TEXT NOT NULL,
  allowed_audience_sources_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,revision_id),
  UNIQUE(workspace_id,event_id,purpose_id,revision_number),
  FOREIGN KEY(workspace_id,event_id,purpose_id)
    REFERENCES communication_purposes(workspace_id,event_id,purpose_id)
);

CREATE TABLE message_templates (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','active','archived')),
  purpose_revision_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,template_id),
  UNIQUE(workspace_id,event_id,template_key)
);
CREATE TABLE message_template_revisions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_revision_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64),
  content_payload_ref_id TEXT NOT NULL REFERENCES communication_authoring_payloads(payload_ref_id),
  field_bindings_payload_ref_id TEXT NOT NULL REFERENCES communication_authoring_payloads(payload_ref_id),
  renderer_key TEXT NOT NULL,
  renderer_version INTEGER NOT NULL CHECK(renderer_version > 0),
  renderer_digest_sha256 TEXT NOT NULL CHECK(length(renderer_digest_sha256) = 64),
  merge_registry_key TEXT NOT NULL,
  merge_registry_version INTEGER NOT NULL CHECK(merge_registry_version > 0),
  merge_registry_digest_sha256 TEXT NOT NULL CHECK(length(merge_registry_digest_sha256) = 64),
  PRIMARY KEY(workspace_id,event_id,template_revision_id),
  UNIQUE(workspace_id,event_id,template_id,revision_number),
  FOREIGN KEY(workspace_id,event_id,template_id)
    REFERENCES message_templates(workspace_id,event_id,template_id)
);

CREATE TABLE communication_drafts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN ('active','proposed','discarded')),
  channel TEXT NOT NULL CHECK(channel = 'email'),
  purpose_revision_id TEXT NOT NULL,
  template_revision_id TEXT NULL,
  authoring_state TEXT NOT NULL CHECK(authoring_state IN ('uninitialized','ready')),
  content_payload_ref_id TEXT NOT NULL,
  audience_payload_ref_id TEXT NOT NULL,
  subject TEXT NULL,
  provenance_json TEXT NOT NULL,
  discard_reason_code TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,draft_id),
  FOREIGN KEY(workspace_id,event_id,purpose_revision_id)
    REFERENCES communication_purpose_revisions(workspace_id,event_id,revision_id),
  FOREIGN KEY(workspace_id,event_id,template_revision_id)
    REFERENCES message_template_revisions(workspace_id,event_id,template_revision_id),
  CHECK(
    (authoring_state = 'uninitialized'
      AND content_payload_ref_id = '${ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID}'
      AND audience_payload_ref_id = '${ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID}'
      AND subject IS NULL
      AND state != 'proposed')
    OR
    (authoring_state = 'ready'
      AND content_payload_ref_id != '${ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID}'
      AND audience_payload_ref_id != '${ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID}'
      AND subject IS NOT NULL)
  )
);
CREATE INDEX communication_drafts_owner_page
  ON communication_drafts(workspace_id,event_id,owner_key,updated_at DESC,draft_id DESC);
`;

export type SQLiteOrganizerCommunicationAuthoringErrorCode =
  | 'transaction_required'
  | 'invalid_input'
  | 'data_corrupt'
  | 'not_found'
  | 'stale_revision'
  | 'draft_not_active'
  | 'purpose_unavailable'
  | 'template_unavailable'
  | 'authoring_quota'
  | 'payload_ref_invalid'
  | 'payload_ref_collision';

export class SQLiteOrganizerCommunicationAuthoringError extends Error {
  constructor(readonly code: SQLiteOrganizerCommunicationAuthoringErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteOrganizerCommunicationAuthoringError';
  }
}

function requireTransaction(sqlite: Database): void {
  if (!sqlite.inTransaction) {
    throw new SQLiteOrganizerCommunicationAuthoringError('transaction_required');
  }
}

export function installSQLiteOrganizerCommunicationAuthoringSchema(sqlite: Database): void {
  if (sqlite.inTransaction) {
    throw new SQLiteOrganizerCommunicationAuthoringError('transaction_required');
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_SQL)).immediate();
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex');
}

function bytesDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function profiles(kind: OrganizerAuthoringPayloadKind): ClassifiedPayloadProfiles {
  const profile = ORGANIZER_AUTHORING_PAYLOAD_PROFILES[kind];
  return Object.freeze({
    classification: createClassifiedPayloadProfileRef(
      'classification', `classification.${profile.classification}`, 1
    ),
    schema: createClassifiedPayloadProfileRef('schema', `schema.${profile.schemaKey}`, 1),
    content: createClassifiedPayloadProfileRef('content', `content.${kind}`, 1),
    integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
    descriptorAuth: createClassifiedPayloadProfileRef(
      'descriptor_auth', 'descriptor_auth.communication.authoring', 1
    )
  });
}

function scopeBinding(scope: OrganizerCommunicationScope, ownerKey: string): string {
  return canonicalJsonText({
    eventId: parseEventId(scope.eventId),
    ownerKey,
    workspaceId: parseWorkspaceId(scope.workspaceId)
  });
}

function payloadBinding(input: {
  readonly scope: OrganizerCommunicationScope;
  readonly ownerKey: string;
  readonly kind: OrganizerAuthoringPayloadKind;
}): SynchronousClassifiedPayloadBinding {
  return Object.freeze({
    profiles: profiles(input.kind),
    scopeBinding: scopeBinding(input.scope, input.ownerKey),
    contentType: ORGANIZER_AUTHORING_PAYLOAD_PROFILES[input.kind].contentType
  });
}

function payloadPurpose(kind: OrganizerAuthoringPayloadKind): string {
  return `communication.authoring.${kind}`;
}

function instant(value: unknown): Instant {
  try {
    return parseInstant(value);
  } catch {
    throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input');
  }
}

function deterministicUuid(namespace: string, material: string): string {
  const hex = digest({ material, namespace });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
  try {
    return JSON.parse(value);
  } catch {
    throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
  }
}

function resultOutcome(
  outcomeClass:
    | 'conflict'
    | 'idempotency_conflict'
    | 'stale_revision'
    | 'policy_violation'
    | 'quota_exceeded',
  kind: string,
  retryable = false
): OrganizerCommunicationCanonicalResult {
  return Object.freeze({
    kind: 'outcome',
    outcome: Object.freeze({
      class: outcomeClass,
      kind,
      retryable,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });
}

function encodeCursor(cursorKind: string, lastId: string): string {
  return `cur1_${Buffer.from(canonicalJsonText({ cursorKind, lastId }), 'utf8').toString('base64url')}`;
}

function decodeCursor(value: string | undefined, cursorKind: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (!value.startsWith('cur1_')) throw new TypeError();
    const parsed = JSON.parse(Buffer.from(value.slice(5), 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).sort().join(',') !== 'cursorKind,lastId') throw new TypeError();
    const candidate = parsed as { readonly cursorKind: unknown; readonly lastId: unknown };
    if (candidate.cursorKind !== cursorKind || typeof candidate.lastId !== 'string'
        || candidate.lastId.length < 1 || candidate.lastId.length > 256) throw new TypeError();
    return candidate.lastId;
  } catch {
    throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input');
  }
}

function encodeDraftCursor(row: Pick<DraftRow, 'draft_id' | 'updated_at'>): string {
  return `cur1_${Buffer.from(canonicalJsonText({
    cursorKind: 'drafts',
    lastId: row.draft_id,
    updatedAt: row.updated_at
  }), 'utf8').toString('base64url')}`;
}

function decodeDraftCursor(value: string | undefined): {
  readonly lastId: string;
  readonly updatedAt: Instant;
} | undefined {
  if (value === undefined) return undefined;
  try {
    if (!value.startsWith('cur1_')) throw new TypeError();
    const parsed = JSON.parse(Buffer.from(value.slice(5), 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).sort().join(',') !== 'cursorKind,lastId,updatedAt') throw new TypeError();
    const candidate = parsed as {
      readonly cursorKind: unknown;
      readonly lastId: unknown;
      readonly updatedAt: unknown;
    };
    if (candidate.cursorKind !== 'drafts' || typeof candidate.lastId !== 'string'
        || candidate.lastId.length < 1 || candidate.lastId.length > 256) throw new TypeError();
    return Object.freeze({ lastId: candidate.lastId, updatedAt: instant(candidate.updatedAt) });
  } catch {
    throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input');
  }
}

function pageLimit(value: number | undefined): number {
  return value ?? 50;
}

interface AuthoringMetadataRow {
  readonly payload_ref_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly owner_key: string;
  readonly payload_kind: string;
  readonly payload_schema_key: string;
  readonly payload_schema_version: number;
  readonly classification_key: string;
  readonly content_type: string;
  readonly digest_sha256: string;
  readonly byte_size: number;
  readonly created_at: string;
}

interface DraftRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly draft_id: string;
  readonly owner_key: string;
  readonly version: number;
  readonly state: 'active' | 'proposed' | 'discarded';
  readonly channel: 'email';
  readonly purpose_revision_id: string;
  readonly template_revision_id: string | null;
  readonly authoring_state: 'uninitialized' | 'ready';
  readonly content_payload_ref_id: string;
  readonly audience_payload_ref_id: string;
  readonly subject: string | null;
  readonly provenance_json: string;
  readonly discard_reason_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const READ_METADATA_SQL = `
SELECT payload_ref_id,workspace_id,event_id,owner_key,payload_kind,payload_schema_key,
       payload_schema_version,classification_key,content_type,digest_sha256,byte_size,created_at
  FROM communication_authoring_payloads WHERE payload_ref_id = ? LIMIT 2
`;

function kind(value: unknown): OrganizerAuthoringPayloadKind {
  if (typeof value !== 'string' || !(value in ORGANIZER_AUTHORING_PAYLOAD_PROFILES)) {
    throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
  }
  return value as OrganizerAuthoringPayloadKind;
}

function canonicalMetadata(row: AuthoringMetadataRow): AuthoringMetadataRow & {
  readonly payload_kind: OrganizerAuthoringPayloadKind;
} {
  const payloadKind = kind(row.payload_kind);
  const expected = ORGANIZER_AUTHORING_PAYLOAD_PROFILES[payloadKind];
  if (row.payload_schema_key !== expected.schemaKey || row.payload_schema_version !== 1
      || row.classification_key !== expected.classification
      || row.content_type !== expected.contentType
      || !/^[a-f0-9]{64}$/.test(row.digest_sha256)
      || !Number.isSafeInteger(row.byte_size) || row.byte_size < 0) {
    throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
  }
  instant(row.created_at);
  return Object.freeze({ ...row, payload_kind: payloadKind });
}

export class SQLiteOrganizerCommunicationAuthoringRepository implements OrganizerCommunicationReadPort {
  constructor(
    private readonly sqlite: Database,
    private readonly classifiedStore: SynchronousClassifiedPayloadStore
  ) {}

  private metadata(payloadRefId: string): ReturnType<typeof canonicalMetadata> | undefined {
    let rows: AuthoringMetadataRow[];
    try {
      rows = this.sqlite.query<AuthoringMetadataRow, [string]>(READ_METADATA_SQL).all(payloadRefId);
    } catch (error) {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt', error);
    }
    if (rows.length > 1) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    return rows[0] === undefined ? undefined : canonicalMetadata(rows[0]);
  }

  private exactMetadata(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey?: string;
    readonly payloadRefId: string;
    readonly kind: OrganizerAuthoringPayloadKind;
  }): ReturnType<typeof canonicalMetadata> {
    const row = this.metadata(input.payloadRefId);
    if (row === undefined
        || row.workspace_id !== input.scope.workspaceId
        || row.event_id !== input.scope.eventId
        || (input.ownerKey !== undefined && row.owner_key !== input.ownerKey)
        || row.payload_kind !== input.kind) {
      throw new SQLiteOrganizerCommunicationAuthoringError('payload_ref_invalid');
    }
    return row;
  }

  private openPayload(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey?: string;
    readonly payloadRefId: string;
    readonly kind: OrganizerAuthoringPayloadKind;
  }): ReturnType<typeof organizerCommunicationAuthoringPayloadInputSchema.parse> {
    const row = this.exactMetadata(input);
    let bytes: Uint8Array | undefined;
    try {
      bytes = this.classifiedStore.read({
        payloadRef: createPayloadRef(parsePayloadRefId(row.payload_ref_id)),
        expectedBinding: payloadBinding({
          scope: input.scope,
          ownerKey: row.owner_key,
          kind: row.payload_kind
        }),
        purpose: payloadPurpose(row.payload_kind)
      });
      if (bytes.byteLength !== row.byte_size || bytesDigest(bytes) !== row.digest_sha256) {
        throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
      }
      const canonicalText = new TextDecoder().decode(bytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(canonicalText);
      } catch {
        throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
      }
      const payload = organizerCommunicationAuthoringPayloadInputSchema.safeParse(parsed);
      if (!payload.success || payload.data.payloadKind !== input.kind
          || canonicalJsonText(payload.data) !== canonicalText) {
        throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
      }
      return payload.data;
    } catch (error) {
      if (error instanceof SQLiteOrganizerCommunicationAuthoringError) throw error;
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt', error);
    } finally {
      bytes?.fill(0);
    }
  }

  storeAuthoringPayload(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly payloadRefId: string;
    readonly payload: unknown;
    readonly createdAt: unknown;
  }): ReturnType<typeof createOrganizerAuthoringPayloadRef> {
    requireTransaction(this.sqlite);
    let canonical: CanonicalOrganizerAuthoringPayload;
    let payloadRefId: PayloadRefId;
    try {
      canonical = canonicalizeOrganizerAuthoringPayload(input.payload);
      payloadRefId = parsePayloadRefId(input.payloadRefId);
    } catch (error) {
      if (error instanceof OrganizerAuthoringPayloadError) {
        throw new SQLiteOrganizerCommunicationAuthoringError(
          error.code === 'payload_too_large' ? 'authoring_quota' : 'invalid_input',
          error
        );
      }
      throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input', error);
    }
    const createdAt = instant(input.createdAt);
    try {
      const existing = this.metadata(payloadRefId);
      if (existing !== undefined) {
        if (existing.workspace_id !== input.scope.workspaceId
            || existing.event_id !== input.scope.eventId
            || existing.owner_key !== input.ownerKey
            || existing.payload_kind !== canonical.profile.payloadKind
            || existing.digest_sha256 !== canonical.digestSha256
            || existing.byte_size !== canonical.bytes.byteLength) {
          throw new SQLiteOrganizerCommunicationAuthoringError('payload_ref_collision');
        }
        this.openPayload({
          scope: input.scope,
          ownerKey: input.ownerKey,
          payloadRefId,
          kind: canonical.profile.payloadKind
        });
        return createOrganizerAuthoringPayloadRef({ payloadRefId, canonical });
      }
      try {
        const receipt = adoptSynchronousClassifiedPayload({
          store: this.classifiedStore,
          put: {
            payloadRefId,
            binding: payloadBinding({
              scope: input.scope,
              ownerKey: input.ownerKey,
              kind: canonical.profile.payloadKind
            }),
            purpose: payloadPurpose(canonical.profile.payloadKind),
            bytes: canonical.bytes,
            createdAt
          }
        });
        const adopted = openSynchronousClassifiedPayloadAdoptionReceipt({
          receipt,
          expectedStore: this.classifiedStore
        });
        if (adopted.payloadRef.id !== payloadRefId) {
          throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
        }
        this.sqlite.query(`
          INSERT INTO communication_authoring_payloads (
            payload_ref_id,workspace_id,event_id,owner_key,payload_kind,payload_schema_key,
            payload_schema_version,classification_key,content_type,digest_sha256,byte_size,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          payloadRefId, input.scope.workspaceId, input.scope.eventId, input.ownerKey,
          canonical.profile.payloadKind, canonical.profile.schemaKey, canonical.profile.schemaVersion,
          canonical.profile.classification, canonical.profile.contentType, canonical.digestSha256,
          canonical.bytes.byteLength, createdAt
        );
      } catch (error) {
        if (error instanceof SQLiteOrganizerCommunicationAuthoringError) throw error;
        if (error instanceof SynchronousClassifiedPayloadStoreError) {
          if (error.code === 'payload_ref_collision') {
            throw new SQLiteOrganizerCommunicationAuthoringError('payload_ref_collision', error);
          }
          if (error.code === 'transaction_required') {
            throw new SQLiteOrganizerCommunicationAuthoringError('transaction_required', error);
          }
          if (error.code === 'invalid_payload_input') {
            throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input', error);
          }
        }
        throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt', error);
      }
      return createOrganizerAuthoringPayloadRef({ payloadRefId, canonical });
    } finally {
      canonical.bytes.fill(0);
    }
  }

  private publicPayloadRef(row: ReturnType<typeof canonicalMetadata>) {
    return {
      payloadRefId: row.payload_ref_id,
      payloadRefVersion: 1,
      payloadKind: row.payload_kind,
      schemaKey: row.payload_schema_key,
      schemaVersion: row.payload_schema_version,
      classification: row.classification_key
    };
  }

  private purposeRevision(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly revisionId: string;
  }): {
    readonly purposeId: string;
    readonly purposeKey: string;
    readonly revisionId: string;
    readonly revisionNumber: number;
    readonly digestSha256: string;
    readonly lifecycle: string;
    readonly currentRevisionId: string;
  } | undefined {
    const rows = this.sqlite.query<{
      purpose_id: string;
      purpose_key: string;
      revision_id: string;
      revision_number: number;
      digest_sha256: string;
      lifecycle: string;
      current_revision_id: string;
    }, [string, string, string]>(`
      SELECT r.purpose_id,r.purpose_key,r.revision_id,r.revision_number,r.digest_sha256,
             p.lifecycle,p.current_revision_id
        FROM communication_purpose_revisions r
        JOIN communication_purposes p
          ON p.workspace_id=r.workspace_id AND p.event_id=r.event_id AND p.purpose_id=r.purpose_id
       WHERE r.workspace_id=? AND r.event_id=? AND r.revision_id=? LIMIT 2
    `).all(input.scope.workspaceId, input.scope.eventId, input.revisionId);
    if (rows.length > 1) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    const row = rows[0];
    return row === undefined ? undefined : Object.freeze({
      purposeId: row.purpose_id,
      purposeKey: row.purpose_key,
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      digestSha256: row.digest_sha256,
      lifecycle: row.lifecycle,
      currentRevisionId: row.current_revision_id
    });
  }

  private exactPurposeRevision(
    scope: OrganizerCommunicationScope,
    expected: ReturnType<typeof organizerCreateCommunicationDraftInputSchema.parse>['purposeRevision']
  ) {
    const current = this.purposeRevision({ scope, revisionId: expected.revisionId });
    if (current === undefined
        || current.purposeId !== expected.purposeId
        || current.purposeKey !== expected.purposeKey
        || current.revisionNumber !== expected.revisionNumber
        || current.digestSha256 !== expected.digestSha256
        || current.lifecycle !== 'active'
        || current.currentRevisionId !== expected.revisionId) {
      throw new SQLiteOrganizerCommunicationAuthoringError('purpose_unavailable');
    }
    return current;
  }

  private exactTemplateRevision(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly expected: NonNullable<
      ReturnType<typeof organizerCreateCommunicationDraftInputSchema.parse>['templateRevision']
    >;
    readonly purposeRevisionId: string;
  }): void {
    const rows = this.sqlite.query<{
      template_id: string;
      template_revision_id: string;
      revision_number: number;
      digest_sha256: string;
      lifecycle: string;
      current_revision_id: string;
      purpose_revision_id: string;
    }, [string, string, string]>(`
      SELECT r.template_id,r.template_revision_id,r.revision_number,r.digest_sha256,
             t.lifecycle,t.current_revision_id,t.purpose_revision_id
        FROM message_template_revisions r
        JOIN message_templates t
          ON t.workspace_id=r.workspace_id AND t.event_id=r.event_id AND t.template_id=r.template_id
       WHERE r.workspace_id=? AND r.event_id=? AND r.template_revision_id=? LIMIT 2
    `).all(input.scope.workspaceId, input.scope.eventId, input.expected.templateRevisionId);
    if (rows.length !== 1) throw new SQLiteOrganizerCommunicationAuthoringError('template_unavailable');
    const row = rows[0]!;
    if (row.template_id !== input.expected.templateId
        || row.revision_number !== input.expected.revisionNumber
        || row.digest_sha256 !== input.expected.digestSha256
        || row.lifecycle !== 'active'
        || row.current_revision_id !== input.expected.templateRevisionId
        || row.purpose_revision_id !== input.purposeRevisionId) {
      throw new SQLiteOrganizerCommunicationAuthoringError('template_unavailable');
    }
  }

  private readyAuthoring(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly contentPayloadRefId: string;
    readonly audiencePayloadRefId: string;
    readonly purposeRevisionId: string;
  }) {
    const contentMetadata = this.exactMetadata({
      scope: input.scope,
      ownerKey: input.ownerKey,
      payloadRefId: input.contentPayloadRefId,
      kind: 'message_content'
    });
    const audienceMetadata = this.exactMetadata({
      scope: input.scope,
      ownerKey: input.ownerKey,
      payloadRefId: input.audiencePayloadRefId,
      kind: 'message_audience_draft'
    });
    const contentEnvelope = this.openPayload({
      scope: input.scope,
      ownerKey: input.ownerKey,
      payloadRefId: input.contentPayloadRefId,
      kind: 'message_content'
    });
    const audienceEnvelope = this.openPayload({
      scope: input.scope,
      ownerKey: input.ownerKey,
      payloadRefId: input.audiencePayloadRefId,
      kind: 'message_audience_draft'
    });
    if (contentEnvelope.payloadKind !== 'message_content'
        || audienceEnvelope.payloadKind !== 'message_audience_draft') {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    }
    const content = organizerEmailMessageContentSchema.parse(contentEnvelope.value);
    const audience = organizerCommunicationAudienceDraftSchema.parse(audienceEnvelope.value);
    if (audience.purposeRevision.revisionId !== input.purposeRevisionId) {
      throw new SQLiteOrganizerCommunicationAuthoringError('payload_ref_invalid');
    }
    return Object.freeze({
      content,
      audience,
      contentPayload: this.publicPayloadRef(contentMetadata),
      audiencePayload: this.publicPayloadRef(audienceMetadata)
    });
  }

  private mutationResult(input: {
    readonly draftId: string;
    readonly version: number;
    readonly state: 'active' | 'proposed' | 'discarded';
    readonly authoring:
      | { readonly state: 'uninitialized' }
      | {
          readonly state: 'ready';
          readonly subject: string;
          readonly contentPayload: ReturnType<SQLiteOrganizerCommunicationAuthoringRepository['publicPayloadRef']>;
          readonly audiencePayload: ReturnType<SQLiteOrganizerCommunicationAuthoringRepository['publicPayloadRef']>;
        };
  }) {
    return organizerCommunicationDraftMutationResultSchema.parse({
      schemaVersion: 1,
      draftId: input.draftId,
      version: input.version,
      state: input.state,
      authoring: input.authoring.state === 'uninitialized'
        ? {
            state: 'uninitialized',
            contentRefId: ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
            audienceRefId: ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
          }
        : {
            state: 'ready',
            subject: input.authoring.subject,
            recipientEstimate: { knowledge: 'unknown', reasonCode: 'audience.not_resolved' },
            contentPayload: input.authoring.contentPayload,
            audiencePayload: input.authoring.audiencePayload
          },
      nextRead: {
        operationName: 'get_message_draft',
        draftId: input.draftId,
        expectedVersion: input.version
      }
    });
  }

  createDraft(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly draftId: string;
    readonly businessInput: unknown;
    readonly provenance: OrganizerCommunicationDraftProvenance;
    readonly now: unknown;
  }) {
    requireTransaction(this.sqlite);
    let business: ReturnType<typeof organizerCreateCommunicationDraftInputSchema.parse>;
    try {
      business = organizerCreateCommunicationDraftInputSchema.parse(input.businessInput);
    } catch (error) {
      throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input', error);
    }
    this.exactPurposeRevision(input.scope, business.purposeRevision);
    if (business.templateRevision !== undefined) {
      this.exactTemplateRevision({
        scope: input.scope,
        expected: business.templateRevision,
        purposeRevisionId: business.purposeRevision.revisionId
      });
    }
    let ready: ReturnType<SQLiteOrganizerCommunicationAuthoringRepository['readyAuthoring']> | undefined;
    if (business.initial.kind === 'adopted_payload_refs') {
      ready = this.readyAuthoring({
        scope: input.scope,
        ownerKey: input.ownerKey,
        contentPayloadRefId: business.initial.contentPayload.payloadRefId,
        audiencePayloadRefId: business.initial.audiencePayload.payloadRefId,
        purposeRevisionId: business.purposeRevision.revisionId
      });
      if (canonicalJsonText(ready.contentPayload) !== canonicalJsonText(business.initial.contentPayload)
          || canonicalJsonText(ready.audiencePayload) !== canonicalJsonText(business.initial.audiencePayload)) {
        throw new SQLiteOrganizerCommunicationAuthoringError('payload_ref_invalid');
      }
    }
    let draft: OrganizerMessageDraftRecord;
    try {
      draft = createOrganizerMessageDraft({
        workspaceId: input.scope.workspaceId,
        eventId: input.scope.eventId,
        ownerKey: input.ownerKey,
        draftId: input.draftId,
        businessInput: business,
        provenance: input.provenance,
        now: input.now
      });
    } catch (error) {
      throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input', error);
    }
    const existing = this.readDraftRow(input.scope, draft.draftId);
    if (existing !== undefined) {
      if (existing.owner_key !== input.ownerKey
          || existing.version !== 1
          || existing.state !== 'active'
          || existing.purpose_revision_id !== business.purposeRevision.revisionId
          || existing.template_revision_id !== (business.templateRevision?.templateRevisionId ?? null)
          || existing.content_payload_ref_id !== (business.initial.kind === 'registered_empty_refs'
            ? business.initial.contentRefId
            : business.initial.contentPayload.payloadRefId)
          || existing.audience_payload_ref_id !== (business.initial.kind === 'registered_empty_refs'
            ? business.initial.audienceRefId
            : business.initial.audiencePayload.payloadRefId)
          || existing.provenance_json !== canonicalJsonText(input.provenance)) {
        throw new SQLiteOrganizerCommunicationAuthoringError('payload_ref_collision');
      }
      return this.draftMutationResult(input.scope, existing);
    }
    try {
      this.sqlite.query(`
        INSERT INTO communication_drafts (
          workspace_id,event_id,draft_id,owner_key,version,state,channel,purpose_revision_id,
          template_revision_id,authoring_state,content_payload_ref_id,audience_payload_ref_id,
          subject,provenance_json,discard_reason_code,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        input.scope.workspaceId, input.scope.eventId, draft.draftId, input.ownerKey,
        draft.version, draft.state, draft.channel, draft.purposeRevision.revisionId,
        draft.templateRevision?.templateRevisionId ?? null, draft.authoring.state,
        draft.authoring.state === 'uninitialized'
          ? draft.authoring.contentRefId
          : draft.authoring.contentPayload.payloadRefId,
        draft.authoring.state === 'uninitialized'
          ? draft.authoring.audienceRefId
          : draft.authoring.audiencePayload.payloadRefId,
        ready?.content.subject ?? null, canonicalJsonText(draft.provenance), null,
        draft.createdAt, draft.updatedAt
      );
    } catch (error) {
      throw new SQLiteOrganizerCommunicationAuthoringError('payload_ref_collision', error);
    }
    return this.mutationResult({
      draftId: draft.draftId,
      version: draft.version,
      state: draft.state,
      authoring: ready === undefined
        ? { state: 'uninitialized' }
        : {
            state: 'ready',
            subject: ready.content.subject,
            contentPayload: ready.contentPayload,
            audiencePayload: ready.audiencePayload
          }
    });
  }

  private readDraftRow(scope: OrganizerCommunicationScope, draftId: string): DraftRow | undefined {
    const rows = this.sqlite.query<DraftRow, [string, string, string]>(`
      SELECT workspace_id,event_id,draft_id,owner_key,version,state,channel,purpose_revision_id,
             template_revision_id,authoring_state,content_payload_ref_id,audience_payload_ref_id,
             subject,provenance_json,discard_reason_code,created_at,updated_at
        FROM communication_drafts
       WHERE workspace_id=? AND event_id=? AND draft_id=? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, draftId);
    if (rows.length > 1) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    const row = rows[0];
    if (row === undefined) return undefined;
    if (!Number.isSafeInteger(row.version) || row.version < 1
        || !['active', 'proposed', 'discarded'].includes(row.state)
        || row.channel !== 'email'
        || !['uninitialized', 'ready'].includes(row.authoring_state)) {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    }
    instant(row.created_at);
    instant(row.updated_at);
    return Object.freeze({ ...row });
  }

  private templateRevisionRef(scope: OrganizerCommunicationScope, revisionId: string) {
    const rows = this.sqlite.query<{
      template_id: string;
      template_revision_id: string;
      revision_number: number;
      digest_sha256: string;
    }, [string, string, string]>(`
      SELECT template_id,template_revision_id,revision_number,digest_sha256
        FROM message_template_revisions
       WHERE workspace_id=? AND event_id=? AND template_revision_id=? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, revisionId);
    if (rows.length !== 1) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    const row = rows[0]!;
    return Object.freeze({
      templateId: row.template_id,
      templateRevisionId: row.template_revision_id,
      revisionNumber: row.revision_number,
      digestSha256: row.digest_sha256
    });
  }

  private draftRecord(scope: OrganizerCommunicationScope, row: DraftRow): OrganizerMessageDraftRecord {
    const purpose = this.purposeRevision({ scope, revisionId: row.purpose_revision_id });
    if (purpose === undefined) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    let provenance: OrganizerCommunicationDraftProvenance;
    try {
      provenance = organizerCommunicationDraftProvenanceSchema.parse(parseJson(row.provenance_json));
    } catch (error) {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt', error);
    }
    let authoring: OrganizerMessageDraftRecord['authoring'];
    if (row.authoring_state === 'uninitialized') {
      if (row.content_payload_ref_id !== ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID
          || row.audience_payload_ref_id !== ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
          || row.subject !== null || row.state === 'proposed') {
        throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
      }
      authoring = Object.freeze({
        state: 'uninitialized',
        contentRefId: ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
        audienceRefId: ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
      });
    } else {
      if (row.subject === null) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
      const ready = this.readyAuthoring({
        scope,
        ownerKey: row.owner_key,
        contentPayloadRefId: row.content_payload_ref_id,
        audiencePayloadRefId: row.audience_payload_ref_id,
        purposeRevisionId: row.purpose_revision_id
      });
      if (ready.content.subject !== row.subject) {
        throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
      }
      authoring = Object.freeze({
        state: 'ready',
        contentPayload: ready.contentPayload as Extract<
          OrganizerMessageDraftRecord['authoring'],
          { readonly state: 'ready' }
        >['contentPayload'],
        audiencePayload: ready.audiencePayload as Extract<
          OrganizerMessageDraftRecord['authoring'],
          { readonly state: 'ready' }
        >['audiencePayload']
      });
    }
    return Object.freeze({
      workspaceId: row.workspace_id,
      eventId: row.event_id,
      ownerKey: row.owner_key,
      draftId: row.draft_id,
      version: row.version,
      state: row.state,
      channel: row.channel,
      purposeRevision: Object.freeze({
        purposeId: purpose.purposeId,
        purposeKey: purpose.purposeKey,
        revisionId: purpose.revisionId,
        revisionNumber: purpose.revisionNumber,
        digestSha256: purpose.digestSha256
      }),
      ...(row.template_revision_id === null
        ? {}
        : { templateRevision: this.templateRevisionRef(scope, row.template_revision_id) }),
      authoring,
      provenance,
      createdAt: instant(row.created_at),
      updatedAt: instant(row.updated_at),
      ...(row.discard_reason_code === null ? {} : { discardReasonCode: row.discard_reason_code })
    });
  }

  private draftMutationResult(scope: OrganizerCommunicationScope, row: DraftRow) {
    if (row.authoring_state === 'uninitialized') {
      return this.mutationResult({
        draftId: row.draft_id,
        version: row.version,
        state: row.state,
        authoring: { state: 'uninitialized' }
      });
    }
    const ready = this.readyAuthoring({
      scope,
      ownerKey: row.owner_key,
      contentPayloadRefId: row.content_payload_ref_id,
      audiencePayloadRefId: row.audience_payload_ref_id,
      purposeRevisionId: row.purpose_revision_id
    });
    if (row.subject !== ready.content.subject) {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    }
    return this.mutationResult({
      draftId: row.draft_id,
      version: row.version,
      state: row.state,
      authoring: {
        state: 'ready',
        subject: ready.content.subject,
        contentPayload: ready.contentPayload,
        audiencePayload: ready.audiencePayload
      }
    });
  }

  reviseDraft(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly businessInput: unknown;
    readonly now: unknown;
  }) {
    requireTransaction(this.sqlite);
    let business: ReturnType<typeof organizerReviseCommunicationDraftInputSchema.parse>;
    try {
      business = organizerReviseCommunicationDraftInputSchema.parse(input.businessInput);
    } catch (error) {
      throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input', error);
    }
    const row = this.readDraftRow(input.scope, business.draftId);
    if (row === undefined || row.owner_key !== input.ownerKey) {
      throw new SQLiteOrganizerCommunicationAuthoringError('not_found');
    }
    if (row.version !== business.expectedVersion) {
      throw new SQLiteOrganizerCommunicationAuthoringError('stale_revision');
    }
    if (row.state !== 'active') {
      throw new SQLiteOrganizerCommunicationAuthoringError('draft_not_active');
    }
    const current = this.draftRecord(input.scope, row);
    const ready = this.readyAuthoring({
      scope: input.scope,
      ownerKey: input.ownerKey,
      contentPayloadRefId: business.contentPayload.payloadRefId,
      audiencePayloadRefId: business.audiencePayload.payloadRefId,
      purposeRevisionId: row.purpose_revision_id
    });
    if (canonicalJsonText(ready.contentPayload) !== canonicalJsonText(business.contentPayload)
        || canonicalJsonText(ready.audiencePayload) !== canonicalJsonText(business.audiencePayload)) {
      throw new SQLiteOrganizerCommunicationAuthoringError('payload_ref_invalid');
    }
    let revised: OrganizerMessageDraftRecord;
    try {
      revised = reviseOrganizerMessageDraft({ current, businessInput: business, now: input.now });
    } catch (error) {
      if (error instanceof OrganizerMessageDraftError) {
        throw new SQLiteOrganizerCommunicationAuthoringError(
          error.code === 'stale_revision' ? 'stale_revision'
            : error.code === 'draft_not_active' ? 'draft_not_active' : 'invalid_input',
          error
        );
      }
      throw error;
    }
    const update = this.sqlite.query(`
      UPDATE communication_drafts
         SET version=?,authoring_state='ready',content_payload_ref_id=?,audience_payload_ref_id=?,
             subject=?,updated_at=?
       WHERE workspace_id=? AND event_id=? AND draft_id=? AND owner_key=? AND version=? AND state='active'
    `).run(
      revised.version, business.contentPayload.payloadRefId, business.audiencePayload.payloadRefId,
      ready.content.subject, revised.updatedAt, input.scope.workspaceId, input.scope.eventId,
      business.draftId, input.ownerKey, business.expectedVersion
    );
    if (update.changes !== 1) throw new SQLiteOrganizerCommunicationAuthoringError('stale_revision');
    return this.mutationResult({
      draftId: revised.draftId,
      version: revised.version,
      state: revised.state,
      authoring: {
        state: 'ready',
        subject: ready.content.subject,
        contentPayload: ready.contentPayload,
        audiencePayload: ready.audiencePayload
      }
    });
  }

  discardDraft(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly businessInput: unknown;
    readonly now: unknown;
  }) {
    requireTransaction(this.sqlite);
    let business: ReturnType<typeof organizerDiscardCommunicationDraftInputSchema.parse>;
    try {
      business = organizerDiscardCommunicationDraftInputSchema.parse(input.businessInput);
    } catch (error) {
      throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input', error);
    }
    const row = this.readDraftRow(input.scope, business.draftId);
    if (row === undefined || row.owner_key !== input.ownerKey) {
      throw new SQLiteOrganizerCommunicationAuthoringError('not_found');
    }
    if (row.version !== business.expectedVersion) {
      throw new SQLiteOrganizerCommunicationAuthoringError('stale_revision');
    }
    if (row.state !== 'active') {
      throw new SQLiteOrganizerCommunicationAuthoringError('draft_not_active');
    }
    const current = this.draftRecord(input.scope, row);
    let discarded: OrganizerMessageDraftRecord;
    try {
      discarded = discardOrganizerMessageDraft({ current, businessInput: business, now: input.now });
    } catch (error) {
      if (error instanceof OrganizerMessageDraftError) {
        throw new SQLiteOrganizerCommunicationAuthoringError(
          error.code === 'stale_revision' ? 'stale_revision'
            : error.code === 'draft_not_active' ? 'draft_not_active' : 'invalid_input',
          error
        );
      }
      throw error;
    }
    const update = this.sqlite.query(`
      UPDATE communication_drafts
         SET version=?,state='discarded',discard_reason_code=?,updated_at=?
       WHERE workspace_id=? AND event_id=? AND draft_id=? AND owner_key=? AND version=? AND state='active'
    `).run(
      discarded.version, business.reasonCode, discarded.updatedAt,
      input.scope.workspaceId, input.scope.eventId, business.draftId, input.ownerKey,
      business.expectedVersion
    );
    if (update.changes !== 1) throw new SQLiteOrganizerCommunicationAuthoringError('stale_revision');
    const updated = this.readDraftRow(input.scope, business.draftId);
    if (updated === undefined) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    return this.draftMutationResult(input.scope, updated);
  }

  private purposeProjection(row: {
    readonly purpose_id: string;
    readonly purpose_key: string;
    readonly lifecycle: 'draft' | 'active' | 'archived';
    readonly revision_id: string;
    readonly revision_number: number;
    readonly digest_sha256: string;
    readonly label: string;
    readonly communication_class: string;
    readonly policy_digest_sha256: string;
  }) {
    return {
      schemaVersion: 1 as const,
      revision: {
        purposeId: row.purpose_id,
        purposeKey: row.purpose_key,
        revisionId: row.revision_id,
        revisionNumber: row.revision_number,
        digestSha256: row.digest_sha256
      },
      label: row.label,
      channel: 'email' as const,
      communicationClass: row.communication_class,
      lifecycle: row.lifecycle,
      policyDigestSha256: row.policy_digest_sha256
    };
  }

  listPurposes(scope: OrganizerCommunicationScope, rawInput: unknown): OrganizerCommunicationCanonicalResult {
    let input: ReturnType<typeof organizerCommunicationPurposeListInputSchema.parse>;
    let after: string | undefined;
    try {
      input = organizerCommunicationPurposeListInputSchema.parse(rawInput);
      after = decodeCursor(input.cursor, 'purposes');
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const limit = pageLimit(input.limit);
    const values: Array<string | number> = [scope.workspaceId, scope.eventId];
    let sql = `
      SELECT p.purpose_id,p.purpose_key,p.lifecycle,r.revision_id,r.revision_number,
             r.digest_sha256,r.label,r.communication_class,r.policy_digest_sha256
        FROM communication_purposes p
        JOIN communication_purpose_revisions r
          ON r.workspace_id=p.workspace_id AND r.event_id=p.event_id
         AND r.revision_id=p.current_revision_id
       WHERE p.workspace_id=? AND p.event_id=?
    `;
    if (after !== undefined) { sql += ' AND p.purpose_id > ?'; values.push(after); }
    if (input.lifecycle !== undefined) { sql += ' AND p.lifecycle = ?'; values.push(input.lifecycle); }
    sql += ' ORDER BY p.purpose_id ASC LIMIT ?'; values.push(limit + 1);
    const rows = this.sqlite.query<{
      purpose_id: string;
      purpose_key: string;
      lifecycle: 'draft' | 'active' | 'archived';
      revision_id: string;
      revision_number: number;
      digest_sha256: string;
      label: string;
      communication_class: string;
      policy_digest_sha256: string;
    }, any[]>(sql).all(...values);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const page = organizerCommunicationPurposePageSchema.parse({
      schemaVersion: 1,
      rows: selected.map((row) => this.purposeProjection(row)),
      page: hasMore
        ? { hasMore: true, nextCursor: encodeCursor('purposes', selected.at(-1)!.purpose_id) }
        : { hasMore: false }
    });
    return Object.freeze({ kind: 'success', data: page });
  }

  getPurpose(scope: OrganizerCommunicationScope, rawInput: unknown): OrganizerCommunicationCanonicalResult {
    let input: ReturnType<typeof organizerCommunicationPurposeGetInputSchema.parse>;
    try {
      input = organizerCommunicationPurposeGetInputSchema.parse(rawInput);
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const rows = this.sqlite.query<{
      purpose_id: string;
      purpose_key: string;
      lifecycle: 'draft' | 'active' | 'archived';
      revision_id: string;
      revision_number: number;
      digest_sha256: string;
      label: string;
      communication_class: string;
      policy_digest_sha256: string;
      description: string;
      allowed_audience_sources_json: string;
    }, [string, string, string, number | null, number | null]>(`
      SELECT p.purpose_id,p.purpose_key,p.lifecycle,r.revision_id,r.revision_number,
             r.digest_sha256,r.label,r.communication_class,r.policy_digest_sha256,
             r.description,r.allowed_audience_sources_json
        FROM communication_purposes p
        JOIN communication_purpose_revisions r
          ON r.workspace_id=p.workspace_id AND r.event_id=p.event_id AND r.purpose_id=p.purpose_id
       WHERE p.workspace_id=? AND p.event_id=? AND p.purpose_id=?
         AND ((? IS NULL AND r.revision_id=p.current_revision_id) OR r.revision_number=?)
       LIMIT 2
    `).all(
      scope.workspaceId, scope.eventId, input.purposeId,
      input.revisionNumber ?? null, input.revisionNumber ?? null
    );
    if (rows.length === 0) return resultOutcome('conflict', 'communication.not_found');
    if (rows.length > 1) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    const row = rows[0]!;
    try {
      const detail = organizerCommunicationPurposeDetailSchema.parse({
        ...this.purposeProjection(row),
        description: row.description,
        allowedAudienceSources: parseJson(row.allowed_audience_sources_json)
      });
      return Object.freeze({ kind: 'success', data: detail });
    } catch (error) {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt', error);
    }
  }

  private templateProjection(row: {
    readonly template_id: string;
    readonly template_key: string;
    readonly template_name: string;
    readonly lifecycle: 'draft' | 'active' | 'archived';
    readonly purpose_revision_id: string;
    readonly template_revision_id: string;
    readonly revision_number: number;
    readonly digest_sha256: string;
    readonly content_payload_ref_id: string;
  }, scope: OrganizerCommunicationScope) {
    const purpose = this.purposeRevision({ scope, revisionId: row.purpose_revision_id });
    if (purpose === undefined) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    const envelope = this.openPayload({
      scope,
      payloadRefId: row.content_payload_ref_id,
      kind: 'template_content'
    });
    if (envelope.payloadKind !== 'template_content') {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    }
    const content = envelope.value;
    const subjectPreview = content.subject.map((node) =>
      node.kind === 'text' ? node.value : `{{${node.fieldKey}}}`
    ).join('');
    return {
      schemaVersion: 1 as const,
      revision: {
        templateId: row.template_id,
        templateRevisionId: row.template_revision_id,
        revisionNumber: row.revision_number,
        digestSha256: row.digest_sha256
      },
      key: row.template_key,
      name: row.template_name,
      purposeRevision: {
        purposeId: purpose.purposeId,
        purposeKey: purpose.purposeKey,
        revisionId: purpose.revisionId,
        revisionNumber: purpose.revisionNumber,
        digestSha256: purpose.digestSha256
      },
      channel: 'email' as const,
      lifecycle: row.lifecycle,
      bodyMode: content.body.mode,
      subjectPreview
    };
  }

  listTemplates(scope: OrganizerCommunicationScope, rawInput: unknown): OrganizerCommunicationCanonicalResult {
    let input: ReturnType<typeof organizerMessageTemplateListInputSchema.parse>;
    let after: string | undefined;
    try {
      input = organizerMessageTemplateListInputSchema.parse(rawInput);
      after = decodeCursor(input.cursor, 'templates');
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const limit = pageLimit(input.limit);
    const values: Array<string | number> = [scope.workspaceId, scope.eventId];
    let sql = `
      SELECT t.template_id,t.template_key,t.template_name,t.lifecycle,t.purpose_revision_id,
             r.template_revision_id,r.revision_number,r.digest_sha256,r.content_payload_ref_id
        FROM message_templates t
        JOIN message_template_revisions r
          ON r.workspace_id=t.workspace_id AND r.event_id=t.event_id
         AND r.template_revision_id=t.current_revision_id
       WHERE t.workspace_id=? AND t.event_id=?
    `;
    if (after !== undefined) { sql += ' AND t.template_id > ?'; values.push(after); }
    if (input.lifecycle !== undefined) { sql += ' AND t.lifecycle = ?'; values.push(input.lifecycle); }
    if (input.purposeId !== undefined) {
      sql += ` AND EXISTS (
        SELECT 1 FROM communication_purpose_revisions pr
         WHERE pr.workspace_id=t.workspace_id AND pr.event_id=t.event_id
           AND pr.revision_id=t.purpose_revision_id AND pr.purpose_id=?
      )`;
      values.push(input.purposeId);
    }
    sql += ' ORDER BY t.template_id ASC LIMIT ?'; values.push(limit + 1);
    const rows = this.sqlite.query<{
      template_id: string;
      template_key: string;
      template_name: string;
      lifecycle: 'draft' | 'active' | 'archived';
      purpose_revision_id: string;
      template_revision_id: string;
      revision_number: number;
      digest_sha256: string;
      content_payload_ref_id: string;
    }, any[]>(sql).all(...values);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const page = organizerMessageTemplatePageSchema.parse({
      schemaVersion: 1,
      rows: selected.map((row) => this.templateProjection(row, scope)),
      page: hasMore
        ? { hasMore: true, nextCursor: encodeCursor('templates', selected.at(-1)!.template_id) }
        : { hasMore: false }
    });
    return Object.freeze({ kind: 'success', data: page });
  }

  getTemplate(scope: OrganizerCommunicationScope, rawInput: unknown): OrganizerCommunicationCanonicalResult {
    let input: ReturnType<typeof organizerMessageTemplateGetInputSchema.parse>;
    try {
      input = organizerMessageTemplateGetInputSchema.parse(rawInput);
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const rows = this.sqlite.query<{
      template_id: string;
      template_key: string;
      template_name: string;
      lifecycle: 'draft' | 'active' | 'archived';
      purpose_revision_id: string;
      template_revision_id: string;
      revision_number: number;
      digest_sha256: string;
      content_payload_ref_id: string;
      field_bindings_payload_ref_id: string;
      renderer_key: string;
      renderer_version: number;
      renderer_digest_sha256: string;
      merge_registry_key: string;
      merge_registry_version: number;
      merge_registry_digest_sha256: string;
    }, [string, string, string, number | null, number | null]>(`
      SELECT t.template_id,t.template_key,t.template_name,t.lifecycle,t.purpose_revision_id,
             r.template_revision_id,r.revision_number,r.digest_sha256,r.content_payload_ref_id,
             r.field_bindings_payload_ref_id,r.renderer_key,r.renderer_version,
             r.renderer_digest_sha256,r.merge_registry_key,r.merge_registry_version,
             r.merge_registry_digest_sha256
        FROM message_templates t
        JOIN message_template_revisions r
          ON r.workspace_id=t.workspace_id AND r.event_id=t.event_id AND r.template_id=t.template_id
       WHERE t.workspace_id=? AND t.event_id=? AND t.template_id=?
         AND ((? IS NULL AND r.template_revision_id=t.current_revision_id) OR r.revision_number=?)
       LIMIT 2
    `).all(
      scope.workspaceId, scope.eventId, input.templateId,
      input.revisionNumber ?? null, input.revisionNumber ?? null
    );
    if (rows.length === 0) return resultOutcome('conflict', 'communication.not_found');
    if (rows.length > 1) throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    const row = rows[0]!;
    const contentMetadata = this.exactMetadata({
      scope, payloadRefId: row.content_payload_ref_id, kind: 'template_content'
    });
    const bindingMetadata = this.exactMetadata({
      scope, payloadRefId: row.field_bindings_payload_ref_id, kind: 'template_field_bindings'
    });
    if (contentMetadata.owner_key !== bindingMetadata.owner_key) {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    }
    const contentEnvelope = this.openPayload({
      scope, payloadRefId: row.content_payload_ref_id, kind: 'template_content'
    });
    const bindingEnvelope = this.openPayload({
      scope, payloadRefId: row.field_bindings_payload_ref_id, kind: 'template_field_bindings'
    });
    if (contentEnvelope.payloadKind !== 'template_content'
        || bindingEnvelope.payloadKind !== 'template_field_bindings') {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
    }
    for (const binding of bindingEnvelope.value) {
      if (binding.fallback.kind !== 'payload_ref') continue;
      if (binding.fallback.payloadRefVersion !== 1) {
        throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt');
      }
      this.exactMetadata({
        scope,
        ownerKey: contentMetadata.owner_key,
        payloadRefId: binding.fallback.payloadRefId,
        kind: 'template_field_fallback'
      });
    }
    try {
      const detail = organizerMessageTemplateDetailSchema.parse({
        ...this.templateProjection(row, scope),
        content: contentEnvelope.value,
        fieldBindings: bindingEnvelope.value,
        renderer: {
          reference: { key: row.renderer_key, version: row.renderer_version },
          definitionDigestSha256: row.renderer_digest_sha256
        },
        mergeRegistry: {
          reference: { key: row.merge_registry_key, version: row.merge_registry_version },
          definitionDigestSha256: row.merge_registry_digest_sha256
        }
      });
      return Object.freeze({ kind: 'success', data: detail });
    } catch (error) {
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt', error);
    }
  }

  private draftSummary(scope: OrganizerCommunicationScope, row: DraftRow) {
    const record = this.draftRecord(scope, row);
    return organizerCommunicationDraftSummarySchema.parse({
      schemaVersion: 1,
      draftId: record.draftId,
      version: record.version,
      state: record.state,
      channel: record.channel,
      purposeRevision: record.purposeRevision,
      ...(record.templateRevision === undefined
        ? {}
        : { templateRevision: record.templateRevision }),
      provenance: record.provenance,
      updatedAt: record.updatedAt,
      authoring: record.authoring.state === 'uninitialized'
        ? {
            state: 'uninitialized',
            contentRefId: record.authoring.contentRefId,
            audienceRefId: record.authoring.audienceRefId
          }
        : {
            state: 'ready',
            subject: row.subject,
            recipientEstimate: {
              knowledge: 'unknown',
              reasonCode: 'audience.not_resolved'
            },
            contentPayload: record.authoring.contentPayload,
            audiencePayload: record.authoring.audiencePayload
          }
    });
  }

  listDrafts(
    scope: OrganizerCommunicationScope,
    ownerKey: string,
    rawInput: unknown
  ): OrganizerCommunicationCanonicalResult {
    let input: ReturnType<typeof organizerCommunicationDraftListInputSchema.parse>;
    let after: ReturnType<typeof decodeDraftCursor>;
    try {
      input = organizerCommunicationDraftListInputSchema.parse(rawInput);
      after = decodeDraftCursor(input.cursor);
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const limit = pageLimit(input.limit);
    const values: Array<string | number> = [scope.workspaceId, scope.eventId, ownerKey];
    let sql = `
      SELECT workspace_id,event_id,draft_id,owner_key,version,state,channel,purpose_revision_id,
             template_revision_id,authoring_state,content_payload_ref_id,audience_payload_ref_id,
             subject,provenance_json,discard_reason_code,created_at,updated_at
        FROM communication_drafts
       WHERE workspace_id=? AND event_id=? AND owner_key=?
    `;
    if (after !== undefined) {
      sql += ' AND (updated_at < ? OR (updated_at = ? AND draft_id < ?))';
      values.push(after.updatedAt, after.updatedAt, after.lastId);
    }
    if (input.state !== undefined) {
      sql += ' AND state = ?';
      values.push(input.state);
    }
    sql += ' ORDER BY updated_at DESC, draft_id DESC LIMIT ?';
    values.push(limit + 1);
    const rows = this.sqlite.query<DraftRow, any[]>(sql).all(...values);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    try {
      const page = organizerCommunicationDraftPageSchema.parse({
        schemaVersion: 1,
        rows: selected.map((row) => this.draftSummary(scope, row)),
        page: hasMore
          ? { hasMore: true, nextCursor: encodeDraftCursor(selected.at(-1)!) }
          : { hasMore: false }
      });
      return Object.freeze({ kind: 'success', data: page });
    } catch (error) {
      if (error instanceof SQLiteOrganizerCommunicationAuthoringError) throw error;
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt', error);
    }
  }

  getDraft(
    scope: OrganizerCommunicationScope,
    ownerKey: string,
    rawInput: unknown
  ): OrganizerCommunicationCanonicalResult {
    let input: ReturnType<typeof organizerCommunicationDraftGetInputSchema.parse>;
    try {
      input = organizerCommunicationDraftGetInputSchema.parse(rawInput);
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const row = this.readDraftRow(scope, input.draftId);
    if (row === undefined || row.owner_key !== ownerKey) {
      return resultOutcome('conflict', 'communication.not_found');
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      return resultOutcome('stale_revision', 'communication.revision_changed');
    }
    const summary = this.draftSummary(scope, row);
    try {
      if (summary.authoring.state === 'uninitialized') {
        return Object.freeze({
          kind: 'success',
          data: organizerCommunicationDraftProjectionSchema.parse({
            ...summary,
            allowedNextActions: summary.state === 'active' ? ['revise', 'discard'] : []
          })
        });
      }
      const ready = this.readyAuthoring({
        scope,
        ownerKey,
        contentPayloadRefId: summary.authoring.contentPayload.payloadRefId,
        audiencePayloadRefId: summary.authoring.audiencePayload.payloadRefId,
        purposeRevisionId: summary.purposeRevision.revisionId
      });
      return Object.freeze({
        kind: 'success',
        data: organizerCommunicationDraftProjectionSchema.parse({
          ...summary,
          content: ready.content,
          audience: ready.audience,
          allowedNextActions: summary.state === 'active'
            ? ['revise', 'preview', 'discard', 'propose']
            : []
        })
      });
    } catch (error) {
      if (error instanceof SQLiteOrganizerCommunicationAuthoringError) throw error;
      throw new SQLiteOrganizerCommunicationAuthoringError('data_corrupt', error);
    }
  }
}

export interface OrganizerCommunicationDraftProvenanceResolver {
  resolveAgentProvenance(context: EffectInvocationContext): unknown;
}

function preparationOutcome(
  outcome: OrganizerCommunicationCanonicalResult
): ReturnType<typeof organizerCommunicationMutationContributionSchema.parse> {
  if (outcome.kind !== 'outcome') throw new TypeError('organizer_communication_outcome_required');
  return organizerCommunicationMutationContributionSchema.parse({
    result: outcome,
    domain: null,
    receiptChildren: []
  });
}

function mapPreparationError(
  error: unknown
): ReturnType<typeof organizerCommunicationMutationContributionSchema.parse> {
  if (!(error instanceof SQLiteOrganizerCommunicationAuthoringError)) throw error;
  switch (error.code) {
    case 'not_found':
      return preparationOutcome(resultOutcome('conflict', 'communication.not_found'));
    case 'stale_revision':
      return preparationOutcome(resultOutcome('stale_revision', 'communication.revision_changed'));
    case 'draft_not_active':
      return preparationOutcome(resultOutcome('conflict', 'communication.draft_not_active'));
    case 'authoring_quota':
      return preparationOutcome(resultOutcome('quota_exceeded', 'communication.authoring_quota'));
    case 'payload_ref_collision':
      return preparationOutcome(resultOutcome('idempotency_conflict', 'operation.request_changed'));
    case 'invalid_input':
    case 'purpose_unavailable':
    case 'template_unavailable':
    case 'payload_ref_invalid':
      return preparationOutcome(resultOutcome('policy_violation', 'communication.authoring_invalid'));
    case 'transaction_required':
    case 'data_corrupt':
      throw error;
  }
}

function deterministicMutationId(
  context: EffectInvocationContext,
  operationName: OrganizerCommunicationMutationOperationName
): string | undefined {
  const idempotency = context.requestBinding.idempotency;
  if (idempotency === undefined) return undefined;
  return deterministicUuid(`communication.${operationName}`, canonicalJsonText({
    authorityPrincipalKey: context.authorityPrincipalKey,
    idempotencyVerifierProfile: idempotency.verifierProfile,
    idempotencyVerifierSha256: idempotency.verifierSha256,
    scopePartitionKey: context.requestBinding.scopePartitionKey
  }));
}

function mutationSuccess(input: {
  readonly operationName: OrganizerCommunicationMutationOperationName;
  readonly scope: OrganizerCommunicationScope;
  readonly data: unknown;
  readonly occurredAt: Instant;
}) {
  const parsed = input.data as {
    readonly payloadRefId?: string;
    readonly payloadRefVersion?: number;
    readonly draftId?: string;
    readonly version?: number;
  };
  const isPayload = input.operationName === 'store_communication_authoring_payload';
  return organizerCommunicationMutationContributionSchema.parse({
    result: { kind: 'success', data: input.data },
    domain: {
      kind: 'organizer_communication_authoring',
      operationName: input.operationName,
      workspaceId: input.scope.workspaceId,
      eventId: input.scope.eventId,
      entityId: isPayload ? parsed.payloadRefId : parsed.draftId,
      entityVersion: isPayload ? parsed.payloadRefVersion : parsed.version,
      occurredAt: input.occurredAt
    },
    receiptChildren: []
  });
}

/** Creates the synchronous transaction-local adapter consumed by the B1 draft operation handlers. */
export function createSQLiteOrganizerCommunicationMutationPreparation(input: {
  readonly repository: SQLiteOrganizerCommunicationAuthoringRepository;
  readonly provenanceResolver?: OrganizerCommunicationDraftProvenanceResolver;
}): OrganizerCommunicationMutationPreparation {
  return Object.freeze({
    prepare(args: Parameters<OrganizerCommunicationMutationPreparation['prepare']>[0]) {
      const { operationName, businessInput, context } = args;
      if (context.scope.eventId === undefined) {
        return preparationOutcome(resultOutcome('conflict', 'communication.event_required'));
      }
      const scope: OrganizerCommunicationScope = Object.freeze({
        workspaceId: parseWorkspaceId(context.scope.workspaceId),
        eventId: parseEventId(context.scope.eventId)
      });
      const mutationId = deterministicMutationId(context, operationName);
      if (mutationId === undefined) {
        return preparationOutcome(resultOutcome('policy_violation', 'communication.authoring_invalid'));
      }
      try {
        let data: unknown;
        switch (operationName) {
          case 'store_communication_authoring_payload': {
            const parsedResult = organizerStoreAuthoringPayloadInputSchema.safeParse(businessInput);
            if (!parsedResult.success) {
              throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input');
            }
            data = input.repository.storeAuthoringPayload({
              scope,
              ownerKey: context.authorityPrincipalKey,
              payloadRefId: mutationId,
              payload: parsedResult.data.payload,
              createdAt: context.receivedAt
            });
            break;
          }
          case 'create_message_draft': {
            let provenance: OrganizerCommunicationDraftProvenance;
            if (context.provenance.kind === 'operator') {
              provenance = Object.freeze({ kind: 'human' });
            } else {
              const resolved = input.provenanceResolver?.resolveAgentProvenance(context);
              const parsed = organizerCommunicationDraftProvenanceSchema.safeParse(resolved);
              if (!parsed.success || parsed.data.kind !== 'agent') {
                throw new SQLiteOrganizerCommunicationAuthoringError('invalid_input');
              }
              provenance = parsed.data;
            }
            data = input.repository.createDraft({
              scope,
              ownerKey: context.authorityPrincipalKey,
              draftId: mutationId,
              businessInput,
              provenance,
              now: context.receivedAt
            });
            break;
          }
          case 'revise_message_batch':
            data = input.repository.reviseDraft({
              scope,
              ownerKey: context.authorityPrincipalKey,
              businessInput,
              now: context.receivedAt
            });
            break;
          case 'discard_message_draft':
            data = input.repository.discardDraft({
              scope,
              ownerKey: context.authorityPrincipalKey,
              businessInput,
              now: context.receivedAt
            });
            break;
        }
        return mutationSuccess({
          operationName,
          scope,
          data,
          occurredAt: parseInstant(context.receivedAt)
        });
      } catch (error) {
        if (error instanceof SQLiteOrganizerCommunicationAuthoringError) {
          return mapPreparationError(error);
        }
        throw error;
      }
    }
  });
}
