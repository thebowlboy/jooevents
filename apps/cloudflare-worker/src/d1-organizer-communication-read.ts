import {
  ImmutableClassifiedPayloadRecordCodec,
  type ImmutableClassifiedPayloadRecordCodecOptions
} from '@jooevents/application/immutable-classified-payload-record';
import type {
  OrganizerCommunicationCanonicalResult,
  OrganizerCommunicationReadPort,
  OrganizerCommunicationScope
} from '@jooevents/communication-operations';
import {
  ORGANIZER_AUTHORING_PAYLOAD_PROFILES,
  type OrganizerAuthoringPayloadKind,
  type OrganizerMessageDraftRecord
} from '@jooevents/communications';
import {
  ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID,
  ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
  organizerCommunicationAudienceDraftSchema,
  organizerCommunicationAuthoringPayloadInputSchema,
  organizerCommunicationDraftGetInputSchema,
  organizerCommunicationDraftListInputSchema,
  organizerCommunicationDraftPageSchema,
  organizerCommunicationDraftProjectionSchema,
  organizerCommunicationDraftProvenanceSchema,
  organizerCommunicationDraftSummarySchema,
  organizerCommunicationPurposeDetailSchema,
  organizerCommunicationPurposeGetInputSchema,
  organizerCommunicationPurposeListInputSchema,
  organizerCommunicationPurposePageSchema,
  organizerEmailMessageContentSchema,
  organizerMessageTemplateDetailSchema,
  organizerMessageTemplateGetInputSchema,
  organizerMessageTemplateListInputSchema,
  organizerMessageTemplatePageSchema,
  type OrganizerCommunicationAuthoringPayloadInput,
  type OrganizerCommunicationDraftProvenance
} from '@jooevents/contracts/communications/organizer';
import {
  canonicalJsonText,
  createPayloadRef,
  parseInstant,
  parsePayloadRefId,
  type Instant
} from '@jooevents/kernel';
import {
  communicationAuthoringClassifiedPayloadPurpose,
  createCommunicationAuthoringClassifiedPayloadBinding
} from '@jooevents/persistence/communication-authoring-classified-payload';
import { readD1ClassifiedPayloadRecords } from './d1-classified-payload-store';

type OutcomeClass = 'conflict' | 'stale_revision' | 'policy_violation';

class D1OrganizerCommunicationReadError extends Error {
  constructor(readonly code: 'data_corrupt' | 'payload_ref_invalid', cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'D1OrganizerCommunicationReadError';
  }
}

function resultOutcome(
  outcomeClass: OutcomeClass,
  kind: string
): OrganizerCommunicationCanonicalResult {
  return Object.freeze({
    kind: 'outcome',
    outcome: Object.freeze({
      class: outcomeClass,
      kind,
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new D1OrganizerCommunicationReadError('data_corrupt');
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new D1OrganizerCommunicationReadError('data_corrupt', error);
  }
}

function instant(value: unknown): Instant {
  try {
    return parseInstant(value);
  } catch (error) {
    throw new D1OrganizerCommunicationReadError('data_corrupt', error);
  }
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
    throw new D1OrganizerCommunicationReadError('payload_ref_invalid');
  }
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

interface DraftListRow extends DraftRow {
  readonly purpose_id: string | null;
  readonly purpose_key: string | null;
  readonly purpose_revision_number: number | null;
  readonly purpose_digest_sha256: string | null;
  readonly purpose_lifecycle: string | null;
  readonly purpose_current_revision_id: string | null;
  readonly joined_template_id: string | null;
  readonly joined_template_revision_id: string | null;
  readonly template_revision_number: number | null;
  readonly template_digest_sha256: string | null;
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
    throw new D1OrganizerCommunicationReadError('payload_ref_invalid');
  }
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

interface PurposeRevisionRecord {
  readonly purposeId: string;
  readonly purposeKey: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly digestSha256: string;
  readonly lifecycle: string;
  readonly currentRevisionId: string;
}

interface TemplateRevisionRecord {
  readonly templateId: string;
  readonly templateRevisionId: string;
  readonly revisionNumber: number;
  readonly digestSha256: string;
}

interface TemplateProjectionRow {
  readonly template_id: string;
  readonly template_key: string;
  readonly template_name: string;
  readonly lifecycle: 'draft' | 'active' | 'archived';
  readonly purpose_revision_id: string;
  readonly template_revision_id: string;
  readonly revision_number: number;
  readonly digest_sha256: string;
  readonly content_payload_ref_id: string;
}

function payloadKind(value: unknown): OrganizerAuthoringPayloadKind {
  if (typeof value !== 'string' || !(value in ORGANIZER_AUTHORING_PAYLOAD_PROFILES)) {
    throw new D1OrganizerCommunicationReadError('data_corrupt');
  }
  return value as OrganizerAuthoringPayloadKind;
}

function canonicalMetadata(row: AuthoringMetadataRow): AuthoringMetadataRow & {
  readonly payload_kind: OrganizerAuthoringPayloadKind;
} {
  const kind = payloadKind(row.payload_kind);
  const expected = ORGANIZER_AUTHORING_PAYLOAD_PROFILES[kind];
  if (row.payload_schema_key !== expected.schemaKey || row.payload_schema_version !== 1
      || row.classification_key !== expected.classification
      || row.content_type !== expected.contentType
      || !/^[a-f0-9]{64}$/.test(row.digest_sha256)
      || !Number.isSafeInteger(row.byte_size) || row.byte_size < 0) {
    throw new D1OrganizerCommunicationReadError('data_corrupt');
  }
  instant(row.created_at);
  return Object.freeze({ ...row, payload_kind: kind });
}

type CanonicalAuthoringMetadata = ReturnType<typeof canonicalMetadata>;

interface OpenedAuthoringPayload {
  readonly metadata: CanonicalAuthoringMetadata;
  readonly envelope: OrganizerCommunicationAuthoringPayloadInput;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

class D1OrganizerCommunicationReadPort implements OrganizerCommunicationReadPort {
  readonly #codec: ImmutableClassifiedPayloadRecordCodec;

  constructor(private readonly input: {
    readonly database: D1Database;
    readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
  }) {
    this.#codec = new ImmutableClassifiedPayloadRecordCodec(input.classifiedPayload);
  }

  async #metadata(
    session: D1DatabaseSession,
    payloadRefId: string
  ): Promise<ReturnType<typeof canonicalMetadata> | undefined> {
    const rows = await session.prepare(`SELECT payload_ref_id,workspace_id,event_id,owner_key,
      payload_kind,payload_schema_key,payload_schema_version,classification_key,content_type,
      digest_sha256,byte_size,created_at FROM communication_authoring_payloads
      WHERE payload_ref_id = ? LIMIT 2`
    ).bind(payloadRefId).all<AuthoringMetadataRow>();
    if (rows.results.length > 1) throw new D1OrganizerCommunicationReadError('data_corrupt');
    return rows.results[0] === undefined ? undefined : canonicalMetadata(rows.results[0]);
  }

  async #metadataBatch(
    session: D1DatabaseSession,
    payloadRefIds: readonly string[]
  ): Promise<ReadonlyMap<string, ReturnType<typeof canonicalMetadata>>> {
    const unique = [...new Set(payloadRefIds)];
    const metadata = new Map<string, ReturnType<typeof canonicalMetadata>>();
    for (let offset = 0; offset < unique.length; offset += 50) {
      const batch = unique.slice(offset, offset + 50);
      const placeholders = batch.map(() => '?').join(',');
      const rows = await session.prepare(`SELECT payload_ref_id,workspace_id,event_id,owner_key,
        payload_kind,payload_schema_key,payload_schema_version,classification_key,content_type,
        digest_sha256,byte_size,created_at FROM communication_authoring_payloads
        WHERE payload_ref_id IN (${placeholders})`
      ).bind(...batch).all<AuthoringMetadataRow>();
      for (const rawRow of rows.results) {
        const row = canonicalMetadata(rawRow);
        if (metadata.has(row.payload_ref_id)) {
          throw new D1OrganizerCommunicationReadError('data_corrupt');
        }
        metadata.set(row.payload_ref_id, row);
      }
    }
    return metadata;
  }

  #validateExactMetadata<Kind extends OrganizerAuthoringPayloadKind>(
    row: ReturnType<typeof canonicalMetadata> | undefined,
    input: {
      readonly scope: OrganizerCommunicationScope;
      readonly ownerKey?: string;
      readonly payloadRefId: string;
      readonly kind: Kind;
    }
  ): ReturnType<typeof canonicalMetadata> & { readonly payload_kind: Kind } {
    if (!row || row.workspace_id !== input.scope.workspaceId || row.event_id !== input.scope.eventId
        || (input.ownerKey !== undefined && row.owner_key !== input.ownerKey)
        || row.payload_kind !== input.kind) {
      throw new D1OrganizerCommunicationReadError('payload_ref_invalid');
    }
    return row as ReturnType<typeof canonicalMetadata> & { readonly payload_kind: Kind };
  }

  async #exactMetadata<Kind extends OrganizerAuthoringPayloadKind>(session: D1DatabaseSession, input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey?: string;
    readonly payloadRefId: string;
    readonly kind: Kind;
  }): Promise<ReturnType<typeof canonicalMetadata> & { readonly payload_kind: Kind }> {
    const row = await this.#metadata(session, input.payloadRefId);
    return this.#validateExactMetadata(row, input);
  }

  async #openPayloadBatch(session: D1DatabaseSession, inputs: readonly {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey?: string;
    readonly payloadRefId: string;
    readonly kind: OrganizerAuthoringPayloadKind;
  }[]): Promise<ReadonlyMap<string, OpenedAuthoringPayload>> {
    const requirements = new Map<string, (typeof inputs)[number]>();
    for (const input of inputs) {
      const existing = requirements.get(input.payloadRefId);
      if (existing !== undefined && (existing.scope.workspaceId !== input.scope.workspaceId
          || existing.scope.eventId !== input.scope.eventId || existing.ownerKey !== input.ownerKey
          || existing.kind !== input.kind)) {
        throw new D1OrganizerCommunicationReadError('payload_ref_invalid');
      }
      requirements.set(input.payloadRefId, input);
    }
    const payloadRefIds = [...requirements.keys()];
    const metadata = await this.#metadataBatch(session, payloadRefIds);
    const parsedRefIds = payloadRefIds.map(parsePayloadRefId);
    const records = await readD1ClassifiedPayloadRecords(session, parsedRefIds);
    const recordById = new Map(records.map((record) => [record.payloadRefId, record]));
    if (recordById.size !== payloadRefIds.length) {
      throw new D1OrganizerCommunicationReadError('data_corrupt');
    }
    const opened = new Map<string, OpenedAuthoringPayload>();
    for (const [payloadRefId, input] of requirements) {
      const row = this.#validateExactMetadata(metadata.get(payloadRefId), input);
      const record = recordById.get(parsePayloadRefId(payloadRefId));
      if (record === undefined) throw new D1OrganizerCommunicationReadError('data_corrupt');
      let bytes: Uint8Array | undefined;
      try {
        bytes = this.#codec.read(record, {
          payloadRef: createPayloadRef(parsePayloadRefId(payloadRefId)),
          expectedBinding: createCommunicationAuthoringClassifiedPayloadBinding({
            scope: input.scope,
            ownerKey: row.owner_key,
            kind: row.payload_kind
          }),
          purpose: communicationAuthoringClassifiedPayloadPurpose(row.payload_kind)
        });
        if (bytes.byteLength !== row.byte_size || await sha256(bytes) !== row.digest_sha256) {
          throw new D1OrganizerCommunicationReadError('data_corrupt');
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const envelope = organizerCommunicationAuthoringPayloadInputSchema.parse(JSON.parse(text));
        if (envelope.payloadKind !== input.kind || canonicalJsonText(envelope) !== text) {
          throw new D1OrganizerCommunicationReadError('data_corrupt');
        }
        opened.set(payloadRefId, Object.freeze({ metadata: row, envelope }));
      } catch (error) {
        if (error instanceof D1OrganizerCommunicationReadError) throw error;
        throw new D1OrganizerCommunicationReadError('data_corrupt', error);
      } finally {
        bytes?.fill(0);
      }
    }
    return opened;
  }

  async #openPayload(session: D1DatabaseSession, input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey?: string;
    readonly payloadRefId: string;
    readonly kind: OrganizerAuthoringPayloadKind;
  }) {
    const opened = await this.#openPayloadBatch(session, [input]);
    return opened.get(input.payloadRefId)!.envelope;
  }

  async #purposeRevision(session: D1DatabaseSession, input: {
    readonly scope: OrganizerCommunicationScope;
    readonly revisionId: string;
  }): Promise<PurposeRevisionRecord | undefined> {
    interface Row {
      purpose_id: string; purpose_key: string; revision_id: string; revision_number: number;
      digest_sha256: string; lifecycle: string; current_revision_id: string;
    }
    const rows = await session.prepare(`SELECT r.purpose_id,r.purpose_key,r.revision_id,
      r.revision_number,r.digest_sha256,p.lifecycle,p.current_revision_id
      FROM communication_purpose_revisions r JOIN communication_purposes p
        ON p.workspace_id=r.workspace_id AND p.event_id=r.event_id AND p.purpose_id=r.purpose_id
      WHERE r.workspace_id=? AND r.event_id=? AND r.revision_id=? LIMIT 2`
    ).bind(input.scope.workspaceId, input.scope.eventId, input.revisionId).all<Row>();
    if (rows.results.length > 1) throw new D1OrganizerCommunicationReadError('data_corrupt');
    const row = rows.results[0];
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

  #publicPayloadRef<Kind extends OrganizerAuthoringPayloadKind>(
    row: ReturnType<typeof canonicalMetadata> & { readonly payload_kind: Kind }
  ) {
    return Object.freeze({
      payloadRefId: row.payload_ref_id,
      payloadRefVersion: 1 as const,
      payloadKind: row.payload_kind,
      schemaKey: row.payload_schema_key,
      schemaVersion: row.payload_schema_version,
      classification: row.classification_key
    });
  }

  async #readyAuthoring(session: D1DatabaseSession, input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly contentPayloadRefId: string;
    readonly audiencePayloadRefId: string;
    readonly purposeRevisionId: string;
  }) {
    const opened = await this.#openPayloadBatch(session, [
      {
        scope: input.scope, ownerKey: input.ownerKey,
        payloadRefId: input.contentPayloadRefId, kind: 'message_content'
      },
      {
        scope: input.scope, ownerKey: input.ownerKey,
        payloadRefId: input.audiencePayloadRefId, kind: 'message_audience_draft'
      }
    ]);
    return this.#readyAuthoringFromOpened(input, opened);
  }

  #readyAuthoringFromOpened(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly contentPayloadRefId: string;
    readonly audiencePayloadRefId: string;
    readonly purposeRevisionId: string;
  }, opened: ReadonlyMap<string, OpenedAuthoringPayload>) {
    const contentOpened = opened.get(input.contentPayloadRefId);
    const audienceOpened = opened.get(input.audiencePayloadRefId);
    if (contentOpened === undefined || audienceOpened === undefined) {
      throw new D1OrganizerCommunicationReadError('data_corrupt');
    }
    const content = organizerEmailMessageContentSchema.parse(contentOpened.envelope.value);
    const audience = organizerCommunicationAudienceDraftSchema.parse(audienceOpened.envelope.value);
    if (audience.purposeRevision.revisionId !== input.purposeRevisionId) {
      throw new D1OrganizerCommunicationReadError('payload_ref_invalid');
    }
    return Object.freeze({
      content,
      audience,
      contentPayload: this.#publicPayloadRef(
        contentOpened.metadata as CanonicalAuthoringMetadata & { payload_kind: 'message_content' }
      ),
      audiencePayload: this.#publicPayloadRef(
        audienceOpened.metadata as CanonicalAuthoringMetadata & {
          payload_kind: 'message_audience_draft';
        }
      )
    });
  }

  async #readDraftRow(
    session: D1DatabaseSession,
    scope: OrganizerCommunicationScope,
    draftId: string
  ): Promise<DraftRow | undefined> {
    const rows = await session.prepare(`SELECT workspace_id,event_id,draft_id,owner_key,version,
      state,channel,purpose_revision_id,template_revision_id,authoring_state,
      content_payload_ref_id,audience_payload_ref_id,subject,provenance_json,
      discard_reason_code,created_at,updated_at FROM communication_drafts
      WHERE workspace_id=? AND event_id=? AND draft_id=? LIMIT 2`
    ).bind(scope.workspaceId, scope.eventId, draftId).all<DraftRow>();
    if (rows.results.length > 1) throw new D1OrganizerCommunicationReadError('data_corrupt');
    const row = rows.results[0];
    if (!row) return undefined;
    if (!Number.isSafeInteger(row.version) || row.version < 1
        || !['active', 'proposed', 'discarded'].includes(row.state)
        || row.channel !== 'email'
        || !['uninitialized', 'ready'].includes(row.authoring_state)) {
      throw new D1OrganizerCommunicationReadError('data_corrupt');
    }
    instant(row.created_at);
    instant(row.updated_at);
    return Object.freeze({ ...row });
  }

  async #templateRevisionRef(
    session: D1DatabaseSession,
    scope: OrganizerCommunicationScope,
    revisionId: string
  ): Promise<TemplateRevisionRecord> {
    interface Row {
      template_id: string; template_revision_id: string;
      revision_number: number; digest_sha256: string;
    }
    const rows = await session.prepare(`SELECT template_id,template_revision_id,
      revision_number,digest_sha256 FROM message_template_revisions
      WHERE workspace_id=? AND event_id=? AND template_revision_id=? LIMIT 2`
    ).bind(scope.workspaceId, scope.eventId, revisionId).all<Row>();
    if (rows.results.length !== 1) throw new D1OrganizerCommunicationReadError('data_corrupt');
    const row = rows.results[0]!;
    return Object.freeze({
      templateId: row.template_id,
      templateRevisionId: row.template_revision_id,
      revisionNumber: row.revision_number,
      digestSha256: row.digest_sha256
    });
  }

  async #draftRecord(
    session: D1DatabaseSession,
    scope: OrganizerCommunicationScope,
    row: DraftRow,
    resolved?: Readonly<{
      purpose: PurposeRevisionRecord;
      templateRevision?: TemplateRevisionRecord;
      opened: ReadonlyMap<string, OpenedAuthoringPayload>;
    }>
  ): Promise<OrganizerMessageDraftRecord> {
    const purpose = resolved?.purpose ?? await this.#purposeRevision(session, {
      scope, revisionId: row.purpose_revision_id
    });
    if (!purpose) throw new D1OrganizerCommunicationReadError('data_corrupt');
    let provenance: OrganizerCommunicationDraftProvenance;
    try {
      provenance = organizerCommunicationDraftProvenanceSchema.parse(parseJson(row.provenance_json));
    } catch (error) {
      throw new D1OrganizerCommunicationReadError('data_corrupt', error);
    }
    let authoring: OrganizerMessageDraftRecord['authoring'];
    if (row.authoring_state === 'uninitialized') {
      if (row.content_payload_ref_id !== ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID
          || row.audience_payload_ref_id !== ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
          || row.subject !== null || row.state === 'proposed') {
        throw new D1OrganizerCommunicationReadError('data_corrupt');
      }
      authoring = Object.freeze({
        state: 'uninitialized',
        contentRefId: ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
        audienceRefId: ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
      });
    } else {
      if (row.subject === null) throw new D1OrganizerCommunicationReadError('data_corrupt');
      const readyInput = {
        scope,
        ownerKey: row.owner_key,
        contentPayloadRefId: row.content_payload_ref_id,
        audiencePayloadRefId: row.audience_payload_ref_id,
        purposeRevisionId: row.purpose_revision_id
      };
      const ready = resolved === undefined
        ? await this.#readyAuthoring(session, readyInput)
        : this.#readyAuthoringFromOpened(readyInput, resolved.opened);
      if (ready.content.subject !== row.subject) {
        throw new D1OrganizerCommunicationReadError('data_corrupt');
      }
      authoring = Object.freeze({
        state: 'ready',
        contentPayload: ready.contentPayload,
        audiencePayload: ready.audiencePayload
      });
    }
    let templateRevision: TemplateRevisionRecord | undefined;
    if (row.template_revision_id !== null) {
      templateRevision = resolved?.templateRevision
        ?? await this.#templateRevisionRef(session, scope, row.template_revision_id);
      if (templateRevision.templateRevisionId !== row.template_revision_id) {
        throw new D1OrganizerCommunicationReadError('data_corrupt');
      }
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
      ...(templateRevision === undefined ? {} : { templateRevision }),
      authoring,
      provenance,
      createdAt: instant(row.created_at),
      updatedAt: instant(row.updated_at),
      ...(row.discard_reason_code === null ? {} : { discardReasonCode: row.discard_reason_code })
    });
  }

  async #draftSummary(
    session: D1DatabaseSession,
    scope: OrganizerCommunicationScope,
    row: DraftRow,
    resolved?: Readonly<{
      purpose: PurposeRevisionRecord;
      templateRevision?: TemplateRevisionRecord;
      opened: ReadonlyMap<string, OpenedAuthoringPayload>;
    }>
  ) {
    const record = await this.#draftRecord(session, scope, row, resolved);
    return organizerCommunicationDraftSummarySchema.parse({
      schemaVersion: 1,
      draftId: record.draftId,
      version: record.version,
      state: record.state,
      channel: record.channel,
      purposeRevision: record.purposeRevision,
      ...(record.templateRevision === undefined ? {} : { templateRevision: record.templateRevision }),
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
            recipientEstimate: { knowledge: 'unknown', reasonCode: 'audience.not_resolved' },
            contentPayload: record.authoring.contentPayload,
            audiencePayload: record.authoring.audiencePayload
          }
    });
  }

  #purposeProjection(row: {
    readonly purpose_id: string; readonly purpose_key: string;
    readonly lifecycle: 'draft' | 'active' | 'archived'; readonly revision_id: string;
    readonly revision_number: number; readonly digest_sha256: string; readonly label: string;
    readonly communication_class: string; readonly policy_digest_sha256: string;
  }) {
    return Object.freeze({
      schemaVersion: 1 as const,
      revision: Object.freeze({
        purposeId: row.purpose_id,
        purposeKey: row.purpose_key,
        revisionId: row.revision_id,
        revisionNumber: row.revision_number,
        digestSha256: row.digest_sha256
      }),
      label: row.label,
      channel: 'email' as const,
      communicationClass: row.communication_class,
      lifecycle: row.lifecycle,
      policyDigestSha256: row.policy_digest_sha256
    });
  }

  #joinedPurpose(row: {
    readonly purpose_revision_id: string;
    readonly purpose_id: string | null;
    readonly purpose_key: string | null;
    readonly purpose_revision_number: number | null;
    readonly purpose_digest_sha256: string | null;
    readonly purpose_lifecycle: string | null;
    readonly purpose_current_revision_id: string | null;
  }): PurposeRevisionRecord {
    if (row.purpose_id === null || row.purpose_key === null
        || row.purpose_revision_number === null || row.purpose_digest_sha256 === null
        || row.purpose_lifecycle === null || row.purpose_current_revision_id === null) {
      throw new D1OrganizerCommunicationReadError('data_corrupt');
    }
    return Object.freeze({
      purposeId: row.purpose_id,
      purposeKey: row.purpose_key,
      revisionId: row.purpose_revision_id,
      revisionNumber: row.purpose_revision_number,
      digestSha256: row.purpose_digest_sha256,
      lifecycle: row.purpose_lifecycle,
      currentRevisionId: row.purpose_current_revision_id
    });
  }

  async listPurposes(scope: OrganizerCommunicationScope, rawInput: unknown) {
    let request: ReturnType<typeof organizerCommunicationPurposeListInputSchema.parse>;
    let after: string | undefined;
    try {
      request = organizerCommunicationPurposeListInputSchema.parse(rawInput);
      after = decodeCursor(request.cursor, 'purposes');
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const limit = request.limit ?? 50;
    const values: Array<string | number> = [scope.workspaceId, scope.eventId];
    let sql = `SELECT p.purpose_id,p.purpose_key,p.lifecycle,r.revision_id,r.revision_number,
      r.digest_sha256,r.label,r.communication_class,r.policy_digest_sha256
      FROM communication_purposes p JOIN communication_purpose_revisions r
        ON r.workspace_id=p.workspace_id AND r.event_id=p.event_id
       AND r.revision_id=p.current_revision_id
      WHERE p.workspace_id=? AND p.event_id=?`;
    if (after !== undefined) { sql += ' AND p.purpose_id > ?'; values.push(after); }
    if (request.lifecycle !== undefined) { sql += ' AND p.lifecycle = ?'; values.push(request.lifecycle); }
    sql += ' ORDER BY p.purpose_id ASC LIMIT ?';
    values.push(limit + 1);
    interface Row {
      purpose_id: string; purpose_key: string; lifecycle: 'draft' | 'active' | 'archived';
      revision_id: string; revision_number: number; digest_sha256: string; label: string;
      communication_class: string; policy_digest_sha256: string;
    }
    const rows = await this.input.database.withSession('first-primary').prepare(sql)
      .bind(...values).all<Row>();
    const selected = rows.results.slice(0, limit);
    return Object.freeze({
      kind: 'success' as const,
      data: organizerCommunicationPurposePageSchema.parse({
        schemaVersion: 1,
        rows: selected.map((row) => this.#purposeProjection(row)),
        page: rows.results.length > limit
          ? { hasMore: true, nextCursor: encodeCursor('purposes', selected.at(-1)!.purpose_id) }
          : { hasMore: false }
      })
    });
  }

  async getPurpose(scope: OrganizerCommunicationScope, rawInput: unknown) {
    let request: ReturnType<typeof organizerCommunicationPurposeGetInputSchema.parse>;
    try {
      request = organizerCommunicationPurposeGetInputSchema.parse(rawInput);
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    interface Row {
      purpose_id: string; purpose_key: string; lifecycle: 'draft' | 'active' | 'archived';
      revision_id: string; revision_number: number; digest_sha256: string; label: string;
      communication_class: string; policy_digest_sha256: string; description: string;
      allowed_audience_sources_json: string;
    }
    const rows = await this.input.database.withSession('first-primary').prepare(`SELECT
      p.purpose_id,p.purpose_key,p.lifecycle,r.revision_id,r.revision_number,r.digest_sha256,
      r.label,r.communication_class,r.policy_digest_sha256,r.description,
      r.allowed_audience_sources_json FROM communication_purposes p
      JOIN communication_purpose_revisions r ON r.workspace_id=p.workspace_id
       AND r.event_id=p.event_id AND r.purpose_id=p.purpose_id
      WHERE p.workspace_id=? AND p.event_id=? AND p.purpose_id=?
       AND ((? IS NULL AND r.revision_id=p.current_revision_id) OR r.revision_number=?) LIMIT 2`
    ).bind(
      scope.workspaceId, scope.eventId, request.purposeId,
      request.revisionNumber ?? null, request.revisionNumber ?? null
    ).all<Row>();
    if (rows.results.length === 0) return resultOutcome('conflict', 'communication.not_found');
    if (rows.results.length > 1) throw new D1OrganizerCommunicationReadError('data_corrupt');
    const row = rows.results[0]!;
    return Object.freeze({
      kind: 'success' as const,
      data: organizerCommunicationPurposeDetailSchema.parse({
        ...this.#purposeProjection(row),
        description: row.description,
        allowedAudienceSources: parseJson(row.allowed_audience_sources_json)
      })
    });
  }

  async #templateProjection(
    session: D1DatabaseSession,
    scope: OrganizerCommunicationScope,
    row: TemplateProjectionRow,
    resolved?: Readonly<{
      purpose: PurposeRevisionRecord;
      envelope: OrganizerCommunicationAuthoringPayloadInput;
    }>
  ) {
    const purpose = resolved?.purpose ?? await this.#purposeRevision(session, {
      scope, revisionId: row.purpose_revision_id
    });
    if (!purpose) throw new D1OrganizerCommunicationReadError('data_corrupt');
    const envelope = resolved?.envelope ?? await this.#openPayload(session, {
      scope, payloadRefId: row.content_payload_ref_id, kind: 'template_content'
    });
    if (envelope.payloadKind !== 'template_content') {
      throw new D1OrganizerCommunicationReadError('data_corrupt');
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      revision: Object.freeze({
        templateId: row.template_id,
        templateRevisionId: row.template_revision_id,
        revisionNumber: row.revision_number,
        digestSha256: row.digest_sha256
      }),
      key: row.template_key,
      name: row.template_name,
      purposeRevision: Object.freeze({
        purposeId: purpose.purposeId,
        purposeKey: purpose.purposeKey,
        revisionId: purpose.revisionId,
        revisionNumber: purpose.revisionNumber,
        digestSha256: purpose.digestSha256
      }),
      channel: 'email' as const,
      lifecycle: row.lifecycle,
      bodyMode: envelope.value.body.mode,
      subjectPreview: envelope.value.subject.map((node) =>
        node.kind === 'text' ? node.value : `{{${node.fieldKey}}}`
      ).join('')
    });
  }

  async listTemplates(scope: OrganizerCommunicationScope, rawInput: unknown) {
    let request: ReturnType<typeof organizerMessageTemplateListInputSchema.parse>;
    let after: string | undefined;
    try {
      request = organizerMessageTemplateListInputSchema.parse(rawInput);
      after = decodeCursor(request.cursor, 'templates');
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const limit = request.limit ?? 50;
    const values: Array<string | number> = [scope.workspaceId, scope.eventId];
    let sql = `SELECT t.template_id,t.template_key,t.template_name,t.lifecycle,
      t.purpose_revision_id,r.template_revision_id,r.revision_number,r.digest_sha256,
      r.content_payload_ref_id,pr.purpose_id,pr.purpose_key,
      pr.revision_number AS purpose_revision_number,
      pr.digest_sha256 AS purpose_digest_sha256,p.lifecycle AS purpose_lifecycle,
      p.current_revision_id AS purpose_current_revision_id
      FROM message_templates t JOIN message_template_revisions r
        ON r.workspace_id=t.workspace_id AND r.event_id=t.event_id
       AND r.template_revision_id=t.current_revision_id
      LEFT JOIN communication_purpose_revisions pr ON pr.workspace_id=t.workspace_id
       AND pr.event_id=t.event_id AND pr.revision_id=t.purpose_revision_id
      LEFT JOIN communication_purposes p ON p.workspace_id=pr.workspace_id
       AND p.event_id=pr.event_id AND p.purpose_id=pr.purpose_id
      WHERE t.workspace_id=? AND t.event_id=?`;
    if (after !== undefined) { sql += ' AND t.template_id > ?'; values.push(after); }
    if (request.lifecycle !== undefined) { sql += ' AND t.lifecycle = ?'; values.push(request.lifecycle); }
    if (request.purposeId !== undefined) {
      sql += ` AND EXISTS (SELECT 1 FROM communication_purpose_revisions pr
        WHERE pr.workspace_id=t.workspace_id AND pr.event_id=t.event_id
        AND pr.revision_id=t.purpose_revision_id AND pr.purpose_id=?)`;
      values.push(request.purposeId);
    }
    sql += ' ORDER BY t.template_id ASC LIMIT ?';
    values.push(limit + 1);
    interface Row extends TemplateProjectionRow {
      purpose_id: string | null; purpose_key: string | null;
      purpose_revision_number: number | null; purpose_digest_sha256: string | null;
      purpose_lifecycle: string | null; purpose_current_revision_id: string | null;
    }
    const session = this.input.database.withSession('first-primary');
    const rows = await session.prepare(sql).bind(...values).all<Row>();
    const selected = rows.results.slice(0, limit);
    const opened = await this.#openPayloadBatch(session, selected.map((row) => ({
      scope, payloadRefId: row.content_payload_ref_id, kind: 'template_content' as const
    })));
    return Object.freeze({
      kind: 'success' as const,
      data: organizerMessageTemplatePageSchema.parse({
        schemaVersion: 1,
        rows: await Promise.all(selected.map((row) => this.#templateProjection(session, scope, row, {
          purpose: this.#joinedPurpose(row),
          envelope: opened.get(row.content_payload_ref_id)!.envelope
        }))),
        page: rows.results.length > limit
          ? { hasMore: true, nextCursor: encodeCursor('templates', selected.at(-1)!.template_id) }
          : { hasMore: false }
      })
    });
  }

  async getTemplate(scope: OrganizerCommunicationScope, rawInput: unknown) {
    let request: ReturnType<typeof organizerMessageTemplateGetInputSchema.parse>;
    try {
      request = organizerMessageTemplateGetInputSchema.parse(rawInput);
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    interface Row {
      template_id: string; template_key: string; template_name: string;
      lifecycle: 'draft' | 'active' | 'archived'; purpose_revision_id: string;
      template_revision_id: string; revision_number: number; digest_sha256: string;
      content_payload_ref_id: string; field_bindings_payload_ref_id: string;
      renderer_key: string; renderer_version: number; renderer_digest_sha256: string;
      merge_registry_key: string; merge_registry_version: number;
      merge_registry_digest_sha256: string;
    }
    const session = this.input.database.withSession('first-primary');
    const rows = await session.prepare(`SELECT t.template_id,t.template_key,t.template_name,
      t.lifecycle,t.purpose_revision_id,r.template_revision_id,r.revision_number,
      r.digest_sha256,r.content_payload_ref_id,r.field_bindings_payload_ref_id,
      r.renderer_key,r.renderer_version,r.renderer_digest_sha256,r.merge_registry_key,
      r.merge_registry_version,r.merge_registry_digest_sha256 FROM message_templates t
      JOIN message_template_revisions r ON r.workspace_id=t.workspace_id
       AND r.event_id=t.event_id AND r.template_id=t.template_id
      WHERE t.workspace_id=? AND t.event_id=? AND t.template_id=?
       AND ((? IS NULL AND r.template_revision_id=t.current_revision_id) OR r.revision_number=?)
      LIMIT 2`
    ).bind(
      scope.workspaceId, scope.eventId, request.templateId,
      request.revisionNumber ?? null, request.revisionNumber ?? null
    ).all<Row>();
    if (rows.results.length === 0) return resultOutcome('conflict', 'communication.not_found');
    if (rows.results.length > 1) throw new D1OrganizerCommunicationReadError('data_corrupt');
    const row = rows.results[0]!;
    const [contentMetadata, bindingMetadata, contentEnvelope, bindingEnvelope] = await Promise.all([
      this.#exactMetadata(session, {
        scope, payloadRefId: row.content_payload_ref_id, kind: 'template_content'
      }),
      this.#exactMetadata(session, {
        scope, payloadRefId: row.field_bindings_payload_ref_id, kind: 'template_field_bindings'
      }),
      this.#openPayload(session, {
        scope, payloadRefId: row.content_payload_ref_id, kind: 'template_content'
      }),
      this.#openPayload(session, {
        scope, payloadRefId: row.field_bindings_payload_ref_id, kind: 'template_field_bindings'
      })
    ]);
    if (contentMetadata.owner_key !== bindingMetadata.owner_key
        || contentEnvelope.payloadKind !== 'template_content'
        || bindingEnvelope.payloadKind !== 'template_field_bindings') {
      throw new D1OrganizerCommunicationReadError('data_corrupt');
    }
    for (const binding of bindingEnvelope.value) {
      if (binding.fallback.kind !== 'payload_ref') continue;
      if (binding.fallback.payloadRefVersion !== 1) {
        throw new D1OrganizerCommunicationReadError('data_corrupt');
      }
      await this.#exactMetadata(session, {
        scope,
        ownerKey: contentMetadata.owner_key,
        payloadRefId: binding.fallback.payloadRefId,
        kind: 'template_field_fallback'
      });
    }
    return Object.freeze({
      kind: 'success' as const,
      data: organizerMessageTemplateDetailSchema.parse({
        ...await this.#templateProjection(session, scope, row),
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
      })
    });
  }

  async listDrafts(scope: OrganizerCommunicationScope, ownerKey: string, rawInput: unknown) {
    let request: ReturnType<typeof organizerCommunicationDraftListInputSchema.parse>;
    let after: ReturnType<typeof decodeDraftCursor>;
    try {
      request = organizerCommunicationDraftListInputSchema.parse(rawInput);
      after = decodeDraftCursor(request.cursor);
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const limit = request.limit ?? 50;
    const values: Array<string | number> = [scope.workspaceId, scope.eventId, ownerKey];
    let sql = `SELECT d.workspace_id,d.event_id,d.draft_id,d.owner_key,d.version,d.state,
      d.channel,d.purpose_revision_id,d.template_revision_id,d.authoring_state,
      d.content_payload_ref_id,d.audience_payload_ref_id,d.subject,d.provenance_json,
      d.discard_reason_code,d.created_at,d.updated_at,pr.purpose_id,pr.purpose_key,
      pr.revision_number AS purpose_revision_number,
      pr.digest_sha256 AS purpose_digest_sha256,p.lifecycle AS purpose_lifecycle,
      p.current_revision_id AS purpose_current_revision_id,
      tr.template_id AS joined_template_id,
      tr.template_revision_id AS joined_template_revision_id,
      tr.revision_number AS template_revision_number,
      tr.digest_sha256 AS template_digest_sha256
      FROM communication_drafts d
      LEFT JOIN communication_purpose_revisions pr ON pr.workspace_id=d.workspace_id
       AND pr.event_id=d.event_id AND pr.revision_id=d.purpose_revision_id
      LEFT JOIN communication_purposes p ON p.workspace_id=pr.workspace_id
       AND p.event_id=pr.event_id AND p.purpose_id=pr.purpose_id
      LEFT JOIN message_template_revisions tr ON tr.workspace_id=d.workspace_id
       AND tr.event_id=d.event_id AND tr.template_revision_id=d.template_revision_id
      WHERE d.workspace_id=? AND d.event_id=? AND d.owner_key=?`;
    if (after !== undefined) {
      sql += ' AND (d.updated_at < ? OR (d.updated_at = ? AND d.draft_id < ?))';
      values.push(after.updatedAt, after.updatedAt, after.lastId);
    }
    if (request.state !== undefined) { sql += ' AND d.state = ?'; values.push(request.state); }
    sql += ' ORDER BY d.updated_at DESC, d.draft_id DESC LIMIT ?';
    values.push(limit + 1);
    const session = this.input.database.withSession('first-primary');
    const rows = await session.prepare(sql).bind(...values).all<DraftListRow>();
    const selected = rows.results.slice(0, limit);
    const opened = await this.#openPayloadBatch(session, selected.flatMap((row) =>
      row.authoring_state === 'ready'
        ? [
            {
              scope, ownerKey: row.owner_key,
              payloadRefId: row.content_payload_ref_id, kind: 'message_content' as const
            },
            {
              scope, ownerKey: row.owner_key,
              payloadRefId: row.audience_payload_ref_id, kind: 'message_audience_draft' as const
            }
          ]
        : []
    ));
    return Object.freeze({
      kind: 'success' as const,
      data: organizerCommunicationDraftPageSchema.parse({
        schemaVersion: 1,
        rows: await Promise.all(selected.map((row) => {
          let templateRevision: TemplateRevisionRecord | undefined;
          if (row.template_revision_id !== null) {
            if (row.joined_template_id === null || row.joined_template_revision_id === null
                || row.template_revision_number === null || row.template_digest_sha256 === null) {
              throw new D1OrganizerCommunicationReadError('data_corrupt');
            }
            templateRevision = Object.freeze({
              templateId: row.joined_template_id,
              templateRevisionId: row.joined_template_revision_id,
              revisionNumber: row.template_revision_number,
              digestSha256: row.template_digest_sha256
            });
          } else if (row.joined_template_id !== null || row.joined_template_revision_id !== null
              || row.template_revision_number !== null || row.template_digest_sha256 !== null) {
            throw new D1OrganizerCommunicationReadError('data_corrupt');
          }
          return this.#draftSummary(session, scope, row, {
            purpose: this.#joinedPurpose(row),
            ...(templateRevision === undefined ? {} : { templateRevision }),
            opened
          });
        })),
        page: rows.results.length > limit
          ? { hasMore: true, nextCursor: encodeDraftCursor(selected.at(-1)!) }
          : { hasMore: false }
      })
    });
  }

  async getDraft(scope: OrganizerCommunicationScope, ownerKey: string, rawInput: unknown) {
    let request: ReturnType<typeof organizerCommunicationDraftGetInputSchema.parse>;
    try {
      request = organizerCommunicationDraftGetInputSchema.parse(rawInput);
    } catch {
      return resultOutcome('policy_violation', 'communication.authoring_invalid');
    }
    const session = this.input.database.withSession('first-primary');
    const row = await this.#readDraftRow(session, scope, request.draftId);
    if (!row || row.owner_key !== ownerKey) {
      return resultOutcome('conflict', 'communication.not_found');
    }
    if (request.expectedVersion !== undefined && request.expectedVersion !== row.version) {
      return resultOutcome('stale_revision', 'communication.revision_changed');
    }
    const summary = await this.#draftSummary(session, scope, row);
    if (summary.authoring.state === 'uninitialized') {
      return Object.freeze({
        kind: 'success' as const,
        data: organizerCommunicationDraftProjectionSchema.parse({
          ...summary,
          allowedNextActions: summary.state === 'active' ? ['revise', 'discard'] : []
        })
      });
    }
    const ready = await this.#readyAuthoring(session, {
      scope,
      ownerKey,
      contentPayloadRefId: summary.authoring.contentPayload.payloadRefId,
      audiencePayloadRefId: summary.authoring.audiencePayload.payloadRefId,
      purposeRevisionId: summary.purposeRevision.revisionId
    });
    return Object.freeze({
      kind: 'success' as const,
      data: organizerCommunicationDraftProjectionSchema.parse({
        ...summary,
        content: ready.content,
        audience: ready.audience,
        allowedNextActions: summary.state === 'active'
          ? ['revise', 'preview', 'discard', 'propose']
          : []
      })
    });
  }
}

/** Read-only organizer communication projections over retained D1 ciphertext. */
export function createD1OrganizerCommunicationReadPort(input: {
  readonly database: D1Database;
  readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
}): OrganizerCommunicationReadPort {
  return new D1OrganizerCommunicationReadPort(input);
}
