import type { Database } from 'bun:sqlite';
import { createHash, createHmac } from 'node:crypto';
import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles
} from '@jooevents/application';
import {
  adoptSynchronousClassifiedPayload,
  openSynchronousClassifiedPayloadAdoptionReceipt,
  type SynchronousClassifiedPayloadBinding,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT,
  ORGANIZER_COMMUNICATION_PAGE_LIMIT,
  organizerCommunicationAudienceDraftSchema,
  organizerCommunicationAudienceOptionListInputSchema,
  organizerCommunicationAudienceOptionPageSchema,
  organizerCommunicationAudienceOptionSchema,
	organizerCommunicationAudienceSelectionPreviewSchema,
  organizerCommunicationDefinitionRefSchema,
  organizerCommunicationDigestSchema,
  organizerCommunicationDraftProjectionSchema,
  organizerCommunicationOpaqueIdSchema,
  organizerCommunicationPurposeRevisionRefSchema,
  organizerCommunicationRecipientResolutionIdSchema,
  organizerCommunicationStableKeySchema,
  organizerCommunicationSubjectRefIdSchema,
  organizerCommunicationVersionSchema,
  organizerMessageBatchPreviewGetInputSchema,
  organizerMessagePreviewIdentitySchema,
  organizerMessagePreviewRecipientListInputSchema,
  organizerMessagePreviewSourceVersionSchema,
  organizerMessagePreviewSummarySchema,
  organizerMessageTemplateDetailSchema,
  organizerMessageTemplateRevisionRefSchema,
  organizerServerRenderedEmailSchema,
  type OrganizerCommunicationAudienceDraft,
  type OrganizerCommunicationAudienceOption,
  type OrganizerCommunicationDraftProjection,
  type OrganizerCommunicationPurposeRevisionRef,
  type OrganizerMessagePreviewSummary,
  type OrganizerMessageTemplateDetail
} from '@jooevents/contracts/communications/organizer';
import {
  OrganizerAudiencePreviewError,
  OrganizerAudienceResolutionError,
  getOrganizerMessageBatchPreview,
  isOrganizerMessageBatchPreviewCurrent,
  listOrganizerMessagePreviewRecipients,
  organizerAddressPolicyResolutionSchema,
  organizerAudienceCandidateSchema,
  organizerAudienceEvidenceRefSchema,
  organizerClassifiedEmailAddressSchema,
  prepareOrganizerMessageBatchPreview,
  type OrganizerAddressPolicyPort,
  type OrganizerAddressPolicyResolution,
  type OrganizerAudienceCandidate,
  type OrganizerAudienceScope,
  type OrganizerAudienceSourcePort,
  type OrganizerAudienceSourceSnapshot,
  type OrganizerClassifiedEmailAddress,
  type OrganizerMessagePreviewSourceVersion,
  type OrganizerPreparedMessageBatchPreview,
  type OrganizerPreviewDigestProfile,
  type OrganizerPreviewDraft,
  type OrganizerPreviewOpaqueTokenCodec,
  type OrganizerPreviewRenderPort
} from '@jooevents/communications';
import {
  type OrganizerAudiencePreviewReadPort,
  type OrganizerCommunicationCanonicalResult,
  type OrganizerCommunicationScope,
  type OrganizerPreviewContactDisclosure
} from '@jooevents/communication-operations';
import {
  canonicalJsonText,
  createPayloadRef,
  parseEventId,
  parseInstant,
  parsePayloadRefId,
  parseWorkspaceId,
  type Instant
} from '@jooevents/kernel';
import { z } from 'zod';

export const SQLITE_ORGANIZER_AUDIENCE_PREVIEW_SQL = `
CREATE TABLE communication_audience_scope_state (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  state_version INTEGER NOT NULL CHECK(state_version > 0),
  PRIMARY KEY(workspace_id,event_id)
);

CREATE TABLE communication_current_audience_contacts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  subject_ref_id TEXT NOT NULL,
  subject_version INTEGER NOT NULL CHECK(subject_version > 0),
  person_ref_id TEXT NOT NULL,
  contact_ref_id TEXT NOT NULL,
  safe_label TEXT NOT NULL,
  membership_evidence_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,subject_ref_id),
  UNIQUE(workspace_id,event_id,contact_ref_id)
);

CREATE TABLE communication_registered_audience_recipes (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL CHECK(recipe_version > 0),
  recipe_digest_sha256 TEXT NOT NULL CHECK(length(recipe_digest_sha256)=64),
  source_definition_key TEXT NOT NULL,
  source_definition_version INTEGER NOT NULL CHECK(source_definition_version > 0),
  source_definition_digest_sha256 TEXT NOT NULL CHECK(length(source_definition_digest_sha256)=64),
  option_id TEXT NOT NULL,
  option_version INTEGER NOT NULL CHECK(option_version > 0),
  purpose_id TEXT NOT NULL,
  option_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,recipe_id,recipe_version),
  UNIQUE(workspace_id,event_id,option_id,option_version)
);
CREATE INDEX communication_registered_audience_options_page
  ON communication_registered_audience_recipes(workspace_id,event_id,option_id,option_version);

CREATE TABLE communication_registered_audience_members (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  subject_ref_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,recipe_id,recipe_version,subject_ref_id),
  FOREIGN KEY(workspace_id,event_id,recipe_id,recipe_version)
    REFERENCES communication_registered_audience_recipes(workspace_id,event_id,recipe_id,recipe_version),
  FOREIGN KEY(workspace_id,event_id,subject_ref_id)
    REFERENCES communication_current_audience_contacts(workspace_id,event_id,subject_ref_id)
);

CREATE TABLE communication_registered_audience_source_versions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256)=64),
  PRIMARY KEY(workspace_id,event_id,recipe_id,recipe_version,source_key),
  FOREIGN KEY(workspace_id,event_id,recipe_id,recipe_version)
    REFERENCES communication_registered_audience_recipes(workspace_id,event_id,recipe_id,recipe_version)
);

CREATE TABLE communication_channel_address_versions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  address_ref_id TEXT NOT NULL,
  address_version INTEGER NOT NULL CHECK(address_version > 0),
  contact_ref_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel='email'),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','revoked')),
  lifecycle_evidence_json TEXT NOT NULL,
  lookup_profile TEXT NOT NULL,
  lookup_version INTEGER NOT NULL CHECK(lookup_version > 0),
  lookup_keyed_value TEXT NOT NULL CHECK(length(lookup_keyed_value)=64),
  classified_payload_ref_id TEXT NOT NULL REFERENCES classified_payload_records(payload_ref_id),
  payload_ref_version INTEGER NOT NULL CHECK(payload_ref_version=1),
  classification TEXT NOT NULL CHECK(classification='communication.contact.email'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,address_ref_id,address_version),
  UNIQUE(workspace_id,event_id,contact_ref_id,address_ref_id,address_version),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id)
    REFERENCES communication_current_audience_contacts(workspace_id,event_id,contact_ref_id)
);

CREATE TABLE communication_current_channel_addresses (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  contact_ref_id TEXT NOT NULL,
  address_ref_id TEXT NOT NULL,
  address_version INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,event_id,contact_ref_id),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id)
    REFERENCES communication_current_audience_contacts(workspace_id,event_id,contact_ref_id),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id,address_ref_id,address_version)
    REFERENCES communication_channel_address_versions(
      workspace_id,event_id,contact_ref_id,address_ref_id,address_version
    )
);

CREATE TABLE communication_current_address_policies (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  purpose_revision_id TEXT NOT NULL,
  contact_ref_id TEXT NOT NULL,
  purpose_revision_json TEXT NOT NULL,
  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('no_eligible_address','evaluated')),
  address_ref_id TEXT NULL,
  address_version INTEGER NULL,
  policy_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,purpose_revision_id,contact_ref_id),
  CHECK(
    (resolution_kind='no_eligible_address' AND address_ref_id IS NULL AND address_version IS NULL)
    OR
    (resolution_kind='evaluated' AND address_ref_id IS NOT NULL AND address_version IS NOT NULL)
  ),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id)
    REFERENCES communication_current_audience_contacts(workspace_id,event_id,contact_ref_id),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id,address_ref_id,address_version)
    REFERENCES communication_channel_address_versions(
      workspace_id,event_id,contact_ref_id,address_ref_id,address_version
    )
);

CREATE TABLE communication_message_preview_snapshots (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  audience_spec_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  preview_generation INTEGER NOT NULL CHECK(preview_generation > 0),
  preview_digest_profile TEXT NOT NULL,
  preview_digest_version INTEGER NOT NULL CHECK(preview_digest_version > 0),
  preview_digest_sha256 TEXT NOT NULL CHECK(length(preview_digest_sha256)=64),
  guard_digest_sha256 TEXT NOT NULL CHECK(length(guard_digest_sha256)=64),
  summary_json TEXT NOT NULL,
  snapshot_payload_ref_id TEXT NOT NULL REFERENCES classified_payload_records(payload_ref_id),
  snapshot_byte_size INTEGER NOT NULL CHECK(snapshot_byte_size > 0),
  snapshot_digest_sha256 TEXT NOT NULL CHECK(length(snapshot_digest_sha256)=64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,audience_spec_id),
  UNIQUE(workspace_id,event_id,draft_id,draft_version,preview_generation),
  UNIQUE(workspace_id,event_id,audience_spec_id,draft_id,draft_version,preview_generation,
    preview_digest_profile,preview_digest_version,preview_digest_sha256)
);
CREATE INDEX communication_message_preview_owner_exact
  ON communication_message_preview_snapshots(
    workspace_id,event_id,owner_key,draft_id,draft_version,preview_generation,audience_spec_id
  );

CREATE TRIGGER communication_registered_audience_recipes_immutable_update
BEFORE UPDATE ON communication_registered_audience_recipes
BEGIN SELECT RAISE(ABORT, 'registered audience recipes are immutable'); END;
CREATE TRIGGER communication_channel_address_versions_immutable_update
BEFORE UPDATE ON communication_channel_address_versions
BEGIN SELECT RAISE(ABORT, 'channel address versions are immutable'); END;
CREATE TRIGGER communication_message_preview_snapshots_immutable_update
BEFORE UPDATE ON communication_message_preview_snapshots
BEGIN SELECT RAISE(ABORT, 'message preview snapshots are immutable'); END;
CREATE TRIGGER communication_message_preview_snapshots_immutable_delete
BEFORE DELETE ON communication_message_preview_snapshots
BEGIN SELECT RAISE(ABORT, 'message preview snapshots are immutable'); END;
`;

export type SQLiteOrganizerAudiencePreviewErrorCode =
  | 'transaction_required'
  | 'invalid_input'
  | 'data_corrupt'
  | 'not_found'
  | 'stale_revision'
  | 'preparation_spent'
  | 'preparation_expired'
  | 'preparation_scope_mismatch'
  | 'preview_conflict';

export class SQLiteOrganizerAudiencePreviewError extends Error {
  constructor(readonly code: SQLiteOrganizerAudiencePreviewErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteOrganizerAudiencePreviewError';
  }
}

export function installSQLiteOrganizerAudiencePreviewSchema(sqlite: Database): void {
  if (sqlite.inTransaction) {
    throw new SQLiteOrganizerAudiencePreviewError('transaction_required');
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_ORGANIZER_AUDIENCE_PREVIEW_SQL)).immediate();
}

function requireTransaction(sqlite: Database): void {
  if (!sqlite.inTransaction) throw new SQLiteOrganizerAudiencePreviewError('transaction_required');
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex');
}

function bytesDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function equalAscii(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function scope(value: OrganizerCommunicationScope): OrganizerAudienceScope {
  try {
    return Object.freeze({
      workspaceId: parseWorkspaceId(value.workspaceId),
      eventId: parseEventId(value.eventId)
    });
  } catch (error) {
    throw new SQLiteOrganizerAudiencePreviewError('invalid_input', error);
  }
}

function owner(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
      || value.trim() !== value || value.includes('\0')) {
    throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
  }
  return value;
}

function instant(value: unknown): Instant {
  try {
    return parseInstant(value);
  } catch (error) {
    throw new SQLiteOrganizerAudiencePreviewError('invalid_input', error);
  }
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', error);
  }
}

function deterministicUuid(namespace: string, value: unknown): string {
  const hex = digest({ namespace, value });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function outcome(
  outcomeClass: 'conflict' | 'stale_revision' | 'policy_violation',
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

function profiles(kind: 'address' | 'preview'): ClassifiedPayloadProfiles {
  const suffix = kind === 'address' ? 'contact.email' : 'preview.exact';
  return Object.freeze({
    classification: createClassifiedPayloadProfileRef(
      'classification', `classification.communication.${suffix}`, 1
    ),
    schema: createClassifiedPayloadProfileRef('schema', `schema.communication.${suffix}`, 1),
    content: createClassifiedPayloadProfileRef('content', `content.communication.${suffix}`, 1),
    integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
    descriptorAuth: createClassifiedPayloadProfileRef(
      'descriptor_auth', 'descriptor_auth.communication.audience-preview', 1
    )
  });
}

function addressBinding(input: {
  readonly scope: OrganizerAudienceScope;
  readonly contactRefId: string;
  readonly addressRefId: string;
  readonly addressVersion: number;
}): SynchronousClassifiedPayloadBinding {
  return Object.freeze({
    profiles: profiles('address'),
    scopeBinding: [
      input.scope.workspaceId, input.scope.eventId, input.contactRefId,
      input.addressRefId, input.addressVersion
    ].join(':'),
    contentType: 'text/plain'
  });
}

function previewBinding(input: {
  readonly scope: OrganizerAudienceScope;
  readonly ownerKey: string;
  readonly audienceSpecId: string;
}): SynchronousClassifiedPayloadBinding {
  return Object.freeze({
    profiles: profiles('preview'),
    scopeBinding: canonicalJsonText({
      workspaceId: input.scope.workspaceId,
      eventId: input.scope.eventId,
      ownerKey: input.ownerKey,
      audienceSpecId: input.audienceSpecId
    }),
    contentType: 'application/json'
  });
}

const preparedDraftSchema = z.strictObject({
  draftId: organizerCommunicationOpaqueIdSchema,
  version: organizerCommunicationVersionSchema,
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  templateRevision: organizerMessageTemplateRevisionRefSchema.optional(),
  audience: organizerCommunicationAudienceDraftSchema
});

const preparedRowBase = {
  recipientResolutionId: organizerCommunicationRecipientResolutionIdSchema,
  candidate: organizerAudienceCandidateSchema,
  address: organizerClassifiedEmailAddressSchema.optional(),
  evidence: z.array(organizerAudienceEvidenceRefSchema).max(20),
  mergeFallbackFieldKeys: z.array(organizerCommunicationStableKeySchema).max(100)
} as const;

const preparedSnapshotSchema = z.strictObject({
  scope: z.strictObject({ workspaceId: z.string(), eventId: z.string() }),
  draft: preparedDraftSchema,
  previewGeneration: organizerCommunicationVersionSchema,
  digestProfile: z.strictObject({
    key: organizerCommunicationStableKeySchema,
    version: organizerCommunicationVersionSchema
  }),
  summary: organizerMessagePreviewSummarySchema,
  rows: z.array(z.discriminatedUnion('state', [
    z.strictObject({
      ...preparedRowBase,
      state: z.literal('included'),
      releaseId: organizerCommunicationOpaqueIdSchema,
      releaseDigestSha256: organizerCommunicationDigestSchema,
      render: organizerServerRenderedEmailSchema
    }),
    z.strictObject({
      ...preparedRowBase,
      state: z.literal('excluded'),
      reasonCode: organizerCommunicationStableKeySchema
    }),
    z.strictObject({
      ...preparedRowBase,
      state: z.literal('blocked'),
      reasonCode: organizerCommunicationStableKeySchema
    })
  ])).max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT)
}).superRefine((snapshot, context) => {
  if (!exactJson(snapshot.summary.identity, {
    audienceSpecId: snapshot.summary.identity.audienceSpecId,
    draftId: snapshot.draft.draftId,
    draftVersion: snapshot.draft.version,
    previewGeneration: snapshot.previewGeneration,
    previewDigestProfile: snapshot.digestProfile.key,
    previewDigestVersion: snapshot.digestProfile.version,
    previewDigestSha256: snapshot.summary.identity.previewDigestSha256
  })) {
    context.addIssue({ code: 'custom', path: ['summary', 'identity'], message: 'Preview tuple mismatch.' });
  }
  if (!exactJson(snapshot.summary.purposeRevision, snapshot.draft.purposeRevision)
      || !exactJson(snapshot.summary.templateRevision ?? null, snapshot.draft.templateRevision ?? null)
      || !exactJson(snapshot.draft.audience.purposeRevision, snapshot.draft.purposeRevision)) {
    context.addIssue({ code: 'custom', path: ['summary'], message: 'Preview draft binding mismatch.' });
  }
  const included = snapshot.rows.filter((row) => row.state === 'included');
  const excluded = snapshot.rows.filter((row) => row.state === 'excluded');
  const blocked = snapshot.rows.filter((row) => row.state === 'blocked');
  if (snapshot.summary.counts.visibleCandidateCount !== snapshot.rows.length
      || snapshot.summary.counts.includedCount !== included.length
      || snapshot.summary.counts.excludedCount !== excluded.length
      || snapshot.summary.counts.blockedCount !== blocked.length
      || new Set(snapshot.rows.map((row) => row.recipientResolutionId)).size !== snapshot.rows.length) {
    context.addIssue({ code: 'custom', path: ['rows'], message: 'Preview row evidence mismatch.' });
  }
  for (const row of included) {
    const index = snapshot.rows.indexOf(row);
    if (row.releaseId !== row.render.releaseId
        || row.releaseDigestSha256 !== row.render.releaseDigestSha256
        || row.recipientResolutionId !== row.render.recipientResolutionId
        || !exactJson(row.render.renderer, snapshot.summary.renderer)
        || !exactJson(row.render.mergeRegistry, snapshot.summary.mergeRegistry)) {
      context.addIssue({
        code: 'custom', path: ['rows', index], message: 'Preview render binding mismatch.'
      });
    }
  }
});

export interface OrganizerPreviewDraftBinding {
  readonly draft: OrganizerPreviewDraft;
  readonly renderer: ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;
  readonly mergeRegistry: ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;
}

export interface OrganizerPreviewDraftBindingSource {
  readCurrent(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly draftId: string;
    readonly expectedVersion: number;
  }): OrganizerPreviewDraftBinding | undefined;
}

/** Adapts the frozen authoring read leaf without exposing its classified payload references. */
export function createOrganizerPreviewDraftBindingSource(input: {
  readonly authoring: {
    getDraft(
      scope: OrganizerCommunicationScope,
      ownerKey: string,
      input: unknown
    ): OrganizerCommunicationCanonicalResult;
    getTemplate(
      scope: OrganizerCommunicationScope,
      input: unknown
    ): OrganizerCommunicationCanonicalResult;
  };
  readonly plainTextRenderer: ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;
  readonly plainTextMergeRegistry: ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;
}): OrganizerPreviewDraftBindingSource {
  const plainTextRenderer = organizerCommunicationDefinitionRefSchema.parse(input.plainTextRenderer);
  const plainTextMergeRegistry = organizerCommunicationDefinitionRefSchema.parse(
    input.plainTextMergeRegistry
  );
  return Object.freeze({
    readCurrent({ scope, ownerKey, draftId, expectedVersion }: {
      readonly scope: OrganizerCommunicationScope;
      readonly ownerKey: string;
      readonly draftId: string;
      readonly expectedVersion: number;
    }) {
      const draftResult = input.authoring.getDraft(scope, ownerKey, { draftId, expectedVersion });
      if (draftResult.kind !== 'success') return undefined;
      let draft: OrganizerCommunicationDraftProjection;
      try {
        draft = organizerCommunicationDraftProjectionSchema.parse(draftResult.data);
      } catch (error) {
        throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', error);
      }
      if (draft.version !== expectedVersion || draft.authoring.state !== 'ready'
          || draft.content === undefined || draft.audience === undefined
          || draft.state === 'discarded') return undefined;
      let renderer = plainTextRenderer;
      let mergeRegistry = plainTextMergeRegistry;
      if (draft.templateRevision !== undefined) {
        const templateResult = input.authoring.getTemplate(scope, {
          templateId: draft.templateRevision.templateId,
          revisionNumber: draft.templateRevision.revisionNumber
        });
        if (templateResult.kind !== 'success') return undefined;
        let template: OrganizerMessageTemplateDetail;
        try {
          template = organizerMessageTemplateDetailSchema.parse(templateResult.data);
        } catch (error) {
          throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', error);
        }
        if (!exactJson(template.revision, draft.templateRevision)) return undefined;
        renderer = template.renderer;
        mergeRegistry = template.mergeRegistry;
      }
      return Object.freeze({
        draft: Object.freeze({
          draftId: draft.draftId,
          version: draft.version,
          purposeRevision: draft.purposeRevision,
          ...(draft.templateRevision === undefined ? {} : { templateRevision: draft.templateRevision }),
          audience: draft.audience
        }),
        renderer,
        mergeRegistry
      });
    }
  });
}

declare const preparedBrand: unique symbol;
export interface SQLiteOrganizerPreparedPreview {
  readonly kind: 'sqlite_organizer_prepared_preview';
  readonly version: 1;
  readonly [preparedBrand]: true;
}

interface PreparedRecord {
  readonly handle: SQLiteOrganizerPreparedPreview;
  readonly scope: OrganizerAudienceScope;
  readonly ownerKey: string;
  readonly guardDigestSha256: string;
  readonly bytes: Uint8Array;
  readonly createdAt: Instant;
  readonly expiresAtMs: number;
  timer?: ReturnType<typeof setTimeout>;
  phase: 'ready' | 'spent';
  zeroized: boolean;
}

interface RecipeRow {
  readonly recipe_id: string;
  readonly recipe_version: number;
  readonly recipe_digest_sha256: string;
  readonly source_definition_key: string;
  readonly source_definition_version: number;
  readonly source_definition_digest_sha256: string;
  readonly option_json: string;
}

interface CandidateRow {
  readonly subject_ref_id: string;
  readonly subject_version: number;
  readonly person_ref_id: string;
  readonly contact_ref_id: string;
  readonly safe_label: string;
  readonly membership_evidence_json: string;
}

interface AddressRow {
  readonly address_ref_id: string;
  readonly address_version: number;
  readonly contact_ref_id: string;
  readonly lifecycle: 'active' | 'revoked';
  readonly lifecycle_evidence_json: string;
  readonly lookup_profile: string;
  readonly lookup_version: number;
  readonly lookup_keyed_value: string;
  readonly classified_payload_ref_id: string;
  readonly payload_ref_version: number;
  readonly classification: 'communication.contact.email';
}

interface PreviewRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly owner_key: string;
  readonly audience_spec_id: string;
  readonly draft_id: string;
  readonly draft_version: number;
  readonly preview_generation: number;
  readonly preview_digest_profile: string;
  readonly preview_digest_version: number;
  readonly preview_digest_sha256: string;
  readonly guard_digest_sha256: string;
  readonly summary_json: string;
  readonly snapshot_payload_ref_id: string;
  readonly snapshot_byte_size: number;
  readonly snapshot_digest_sha256: string;
  readonly created_at: string;
}

/**
 * A synchronous registered-query source mounted beside the mirror tables. A
 * delegate serves an exact minted recipe live from its owning domain (for
 * example the decision heads), so `binding: 'current_snapshot'` resolves the
 * current domain state on every preview and currency check. Delegates must be
 * synchronous: the preview guard digests their snapshot inline.
 */
export interface SQLiteRegisteredAudienceSourceDelegate {
  /** Matches `communication_registered_audience_recipes.source_definition_key`. */
  readonly sourceDefinitionKey: string;
  ownsContactRef(contactRefId: string): boolean;
  /**
   * Optional live resolution for explicit opaque contact references owned by
   * this domain. This keeps the browser from disclosing or reconstructing an
   * address and lets eligibility be re-read at preview and send time.
   */
  resolveExplicitContacts?(input: {
    readonly scope: OrganizerAudienceScope;
    readonly audience: OrganizerCommunicationAudienceDraft;
    readonly contactRefIds: readonly string[];
  }): OrganizerAudienceSourceSnapshot;
  resolveCurrentSnapshot(input: {
    readonly scope: OrganizerAudienceScope;
    readonly audience: OrganizerCommunicationAudienceDraft;
  }): OrganizerAudienceSourceSnapshot;
  resolveEmail(input: {
    readonly scope: OrganizerAudienceScope;
    readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
    readonly candidate: OrganizerAudienceCandidate;
    readonly asOf: string;
  }): OrganizerAddressPolicyResolution;
}

export interface SQLiteOrganizerAudiencePreviewRepositoryOptions {
  readonly drafts: OrganizerPreviewDraftBindingSource;
  readonly opaqueTokens: OrganizerPreviewOpaqueTokenCodec;
  readonly render: OrganizerPreviewRenderPort;
  readonly digestProfile: OrganizerPreviewDigestProfile;
  readonly audienceCursorKeyBytes: Uint8Array;
  readonly audienceCursorRetainedKeyBytes?: readonly Uint8Array[];
  /** Live registered-query sources; recipes stay minted immutable rows. */
  readonly registeredSources?: readonly SQLiteRegisteredAudienceSourceDelegate[];
  /** Deliberately short: prepared material is process-local and nonrenewable. */
  readonly preparedTtlMs?: number;
  /** Receives only already-zeroed bytes; used by executable security tests. */
  readonly testOnlyAfterPreparedBytesZeroized?: (bytes: Uint8Array) => void;
}

export class SQLiteOrganizerAudiencePreviewRepository implements
  OrganizerAudienceSourcePort,
  OrganizerAddressPolicyPort,
  OrganizerAudiencePreviewReadPort {
  readonly #cursorKeys: readonly Uint8Array[];
  readonly #preparedTtlMs: number;
  readonly #preparedRecords = new WeakMap<object, PreparedRecord>();
  readonly #livePreparedRecords = new Set<PreparedRecord>();
  readonly #registeredSources: ReadonlyMap<string, SQLiteRegisteredAudienceSourceDelegate>;

  constructor(
    private readonly sqlite: Database,
    private readonly classifiedStore: SynchronousClassifiedPayloadStore,
    private readonly options: SQLiteOrganizerAudiencePreviewRepositoryOptions
  ) {
    if (!(options.audienceCursorKeyBytes instanceof Uint8Array)
        || options.audienceCursorKeyBytes.byteLength < 32) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
    }
    const ttl = options.preparedTtlMs ?? 30_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 60_000) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
    }
    const registeredSources = new Map<string, SQLiteRegisteredAudienceSourceDelegate>();
    for (const delegate of options.registeredSources ?? []) {
      if (typeof delegate.sourceDefinitionKey !== 'string'
          || delegate.sourceDefinitionKey.length === 0
          || registeredSources.has(delegate.sourceDefinitionKey)
          || typeof delegate.ownsContactRef !== 'function'
          || typeof delegate.resolveCurrentSnapshot !== 'function'
          || typeof delegate.resolveEmail !== 'function') {
        throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
      }
      registeredSources.set(delegate.sourceDefinitionKey, delegate);
    }
    this.#registeredSources = registeredSources;
    this.#cursorKeys = Object.freeze([
      Uint8Array.from(options.audienceCursorKeyBytes),
      ...(options.audienceCursorRetainedKeyBytes ?? []).map((keyBytes) => {
        if (!(keyBytes instanceof Uint8Array) || keyBytes.byteLength < 32) {
          throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
        }
        return Uint8Array.from(keyBytes);
      })
    ]);
    this.#preparedTtlMs = ttl;
  }

  #destroyPrepared(record: PreparedRecord): void {
    if (record.zeroized) return;
    record.phase = 'spent';
    record.zeroized = true;
    this.#preparedRecords.delete(record.handle);
    this.#livePreparedRecords.delete(record);
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.bytes.fill(0);
    if (record.bytes.some((byte) => byte !== 0)) {
      throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    }
    this.options.testOnlyAfterPreparedBytesZeroized?.(record.bytes);
  }

  #bumpScopeState(selected: OrganizerAudienceScope): void {
    this.sqlite.query(`
      INSERT INTO communication_audience_scope_state(workspace_id,event_id,state_version)
      VALUES (?,?,1)
      ON CONFLICT(workspace_id,event_id)
      DO UPDATE SET state_version=communication_audience_scope_state.state_version+1
    `).run(selected.workspaceId, selected.eventId);
  }

  upsertCurrentCandidate(rawScope: OrganizerCommunicationScope, raw: unknown): void {
    requireTransaction(this.sqlite);
    const selected = scope(rawScope);
    let candidate: OrganizerAudienceCandidate;
    try {
      candidate = organizerAudienceCandidateSchema.parse(raw);
    } catch (error) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input', error);
    }
    const existing = this.sqlite.query<CandidateRow, [string, string, string]>(`
      SELECT subject_ref_id,subject_version,person_ref_id,contact_ref_id,safe_label,
             membership_evidence_json
        FROM communication_current_audience_contacts
       WHERE workspace_id=? AND event_id=? AND subject_ref_id=? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, candidate.subjectRefId);
    if (existing.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    const row = existing[0];
    const evidenceJson = canonicalJsonText(candidate.membershipEvidence);
    if (row !== undefined) {
      if (row.person_ref_id !== candidate.personRefId || row.contact_ref_id !== candidate.contactRefId) {
        // Identity is reference-bound. It is never re-linked through equal address text.
        throw new SQLiteOrganizerAudiencePreviewError('preview_conflict');
      }
      if (candidate.subjectVersion < row.subject_version) {
        throw new SQLiteOrganizerAudiencePreviewError('stale_revision');
      }
      if (candidate.subjectVersion === row.subject_version) {
        if (row.safe_label !== candidate.safeLabel || row.membership_evidence_json !== evidenceJson) {
          throw new SQLiteOrganizerAudiencePreviewError('preview_conflict');
        }
        return;
      }
      this.sqlite.query(`
        UPDATE communication_current_audience_contacts
           SET subject_version=?,safe_label=?,membership_evidence_json=?
         WHERE workspace_id=? AND event_id=? AND subject_ref_id=?
      `).run(
        candidate.subjectVersion, candidate.safeLabel, evidenceJson,
        selected.workspaceId, selected.eventId, candidate.subjectRefId
      );
    } else {
      this.sqlite.query(`
        INSERT INTO communication_current_audience_contacts(
          workspace_id,event_id,subject_ref_id,subject_version,person_ref_id,contact_ref_id,
          safe_label,membership_evidence_json
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        selected.workspaceId, selected.eventId, candidate.subjectRefId,
        candidate.subjectVersion, candidate.personRefId, candidate.contactRefId,
        candidate.safeLabel, evidenceJson
      );
    }
    this.#bumpScopeState(selected);
  }

  registerAudienceRecipe(rawScope: OrganizerCommunicationScope, rawOption: unknown): void {
    requireTransaction(this.sqlite);
    const selected = scope(rawScope);
    let option: OrganizerCommunicationAudienceOption;
    try {
      option = organizerCommunicationAudienceOptionSchema.parse(rawOption);
    } catch (error) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input', error);
    }
    if (option.audienceDraft.source.kind !== 'registered_query') {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
    }
    const source = option.audienceDraft.source;
    const optionJson = canonicalJsonText(option);
    const existing = this.sqlite.query<RecipeRow, [string, string, string, number]>(`
      SELECT recipe_id,recipe_version,recipe_digest_sha256,source_definition_key,
             source_definition_version,source_definition_digest_sha256,option_json
        FROM communication_registered_audience_recipes
       WHERE workspace_id=? AND event_id=? AND recipe_id=? AND recipe_version=? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, source.recipeId, source.recipeVersion);
    if (existing.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    if (existing[0] !== undefined) {
      if (existing[0]!.option_json !== optionJson) {
        throw new SQLiteOrganizerAudiencePreviewError('preview_conflict');
      }
      return;
    }
    try {
      this.sqlite.query(`
        INSERT INTO communication_registered_audience_recipes(
          workspace_id,event_id,recipe_id,recipe_version,recipe_digest_sha256,
          source_definition_key,source_definition_version,source_definition_digest_sha256,
          option_id,option_version,purpose_id,option_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        selected.workspaceId, selected.eventId, source.recipeId, source.recipeVersion,
        source.recipeDigestSha256, source.sourceDefinition.reference.key,
        source.sourceDefinition.reference.version, source.sourceDefinition.definitionDigestSha256,
        option.optionId, option.optionVersion, option.audienceDraft.purposeRevision.purposeId,
        optionJson
      );
    } catch (error) {
      throw new SQLiteOrganizerAudiencePreviewError('preview_conflict', error);
    }
  }

  replaceRegisteredAudienceCurrentSnapshot(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly source: Extract<OrganizerCommunicationAudienceDraft['source'], { readonly kind: 'registered_query' }>;
    readonly candidates: readonly unknown[];
    readonly sourceVersions: readonly unknown[];
  }): void {
    requireTransaction(this.sqlite);
    const selected = scope(input.scope);
    const source = organizerCommunicationAudienceDraftSchema.shape.source.parse(input.source);
    if (source.kind !== 'registered_query') {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
    }
    const recipe = this.#exactRecipe(selected, source);
    if (recipe === undefined) throw new SQLiteOrganizerAudiencePreviewError('not_found');
    let candidates: OrganizerAudienceCandidate[];
    let sourceVersions: OrganizerMessagePreviewSourceVersion[];
    try {
      candidates = input.candidates.map((candidate) => organizerAudienceCandidateSchema.parse(candidate));
      sourceVersions = input.sourceVersions.map((version) =>
        organizerMessagePreviewSourceVersionSchema.parse(version)
      );
    } catch (error) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input', error);
    }
    candidates.sort((left, right) => left.subjectRefId.localeCompare(right.subjectRefId));
    sourceVersions.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
    if (new Set(candidates.map((candidate) => candidate.subjectRefId)).size !== candidates.length
        || new Set(sourceVersions.map((version) => version.sourceKey)).size !== sourceVersions.length
        || sourceVersions.length < 1 || sourceVersions.length > 100) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
    }
    for (const candidate of candidates) this.upsertCurrentCandidate(selected, candidate);
    this.sqlite.query(`
      DELETE FROM communication_registered_audience_members
       WHERE workspace_id=? AND event_id=? AND recipe_id=? AND recipe_version=?
    `).run(selected.workspaceId, selected.eventId, source.recipeId, source.recipeVersion);
    this.sqlite.query(`
      DELETE FROM communication_registered_audience_source_versions
       WHERE workspace_id=? AND event_id=? AND recipe_id=? AND recipe_version=?
    `).run(selected.workspaceId, selected.eventId, source.recipeId, source.recipeVersion);
    for (const candidate of candidates) {
      this.sqlite.query(`
        INSERT INTO communication_registered_audience_members(
          workspace_id,event_id,recipe_id,recipe_version,subject_ref_id
        ) VALUES (?,?,?,?,?)
      `).run(
        selected.workspaceId, selected.eventId, source.recipeId, source.recipeVersion,
        candidate.subjectRefId
      );
    }
    for (const version of sourceVersions) {
      this.sqlite.query(`
        INSERT INTO communication_registered_audience_source_versions(
          workspace_id,event_id,recipe_id,recipe_version,source_key,source_version,digest_sha256
        ) VALUES (?,?,?,?,?,?,?)
      `).run(
        selected.workspaceId, selected.eventId, source.recipeId, source.recipeVersion,
        version.sourceKey, version.sourceVersion, version.digestSha256
      );
    }
    this.#bumpScopeState(selected);
  }

  #exactRecipe(
    selected: OrganizerAudienceScope,
    source: Extract<OrganizerCommunicationAudienceDraft['source'], { readonly kind: 'registered_query' }>
  ): RecipeRow | undefined {
    const rows = this.sqlite.query<RecipeRow, [string, string, string, number]>(`
      SELECT recipe_id,recipe_version,recipe_digest_sha256,source_definition_key,
             source_definition_version,source_definition_digest_sha256,option_json
        FROM communication_registered_audience_recipes
       WHERE workspace_id=? AND event_id=? AND recipe_id=? AND recipe_version=? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, source.recipeId, source.recipeVersion);
    if (rows.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    const row = rows[0];
    if (row === undefined) return undefined;
    if (row.recipe_digest_sha256 !== source.recipeDigestSha256
        || row.source_definition_key !== source.sourceDefinition.reference.key
        || row.source_definition_version !== source.sourceDefinition.reference.version
        || row.source_definition_digest_sha256 !== source.sourceDefinition.definitionDigestSha256) {
      return undefined;
    }
    return row;
  }

  #candidateRows(selected: OrganizerAudienceScope, audience: OrganizerCommunicationAudienceDraft): CandidateRow[] {
    if (audience.source.kind === 'registered_query') {
      if (this.#exactRecipe(selected, audience.source) === undefined) {
        throw new OrganizerAudienceResolutionError('source_not_registered');
      }
      return this.sqlite.query<CandidateRow, [string, string, string, number]>(`
        SELECT c.subject_ref_id,c.subject_version,c.person_ref_id,c.contact_ref_id,c.safe_label,
               c.membership_evidence_json
          FROM communication_registered_audience_members m
          JOIN communication_current_audience_contacts c
            ON c.workspace_id=m.workspace_id AND c.event_id=m.event_id
           AND c.subject_ref_id=m.subject_ref_id
         WHERE m.workspace_id=? AND m.event_id=? AND m.recipe_id=? AND m.recipe_version=?
         ORDER BY c.subject_ref_id
      `).all(
        selected.workspaceId, selected.eventId,
        audience.source.recipeId, audience.source.recipeVersion
      );
    }
    if (audience.source.kind !== 'explicit_contacts') {
      throw new OrganizerAudienceResolutionError('source_contract_mismatch');
    }
    if (audience.source.contactRefIds.length === 0) return [];
    const placeholders = audience.source.contactRefIds.map(() => '?').join(',');
    return this.sqlite.query<CandidateRow, Array<string>>(`
      SELECT subject_ref_id,subject_version,person_ref_id,contact_ref_id,safe_label,
             membership_evidence_json
        FROM communication_current_audience_contacts
       WHERE workspace_id=? AND event_id=? AND contact_ref_id IN (${placeholders})
       ORDER BY subject_ref_id
    `).all(selected.workspaceId, selected.eventId, ...audience.source.contactRefIds);
  }

  resolveCurrentSnapshot({ scope: rawScope, audience: rawAudience }: {
    readonly scope: OrganizerAudienceScope;
    readonly audience: OrganizerCommunicationAudienceDraft;
  }) {
    const selected = scope(rawScope);
    let audience: OrganizerCommunicationAudienceDraft;
    try {
      audience = organizerCommunicationAudienceDraftSchema.parse(rawAudience);
    } catch (error) {
      throw new OrganizerAudienceResolutionError('source_contract_mismatch');
    }
    if (audience.source.kind === 'composite') {
      const candidates: OrganizerAudienceCandidate[] = [];
      const versions = new Map<string, OrganizerMessagePreviewSourceVersion>();
      for (const group of audience.source.groups) {
        const snapshot = this.resolveCurrentSnapshot({
          scope: selected,
          audience: { ...audience, source: group.source }
        });
        candidates.push(...snapshot.candidates);
        for (const version of snapshot.sourceVersions) {
          const prior = versions.get(version.sourceKey);
          if (prior !== undefined && !exactJson(prior, version)) {
            throw new OrganizerAudienceResolutionError('source_contract_mismatch');
          }
          versions.set(version.sourceKey, version);
        }
      }
      return Object.freeze({
        source: audience.source,
        candidates: Object.freeze(candidates),
        sourceVersions: Object.freeze([...versions.values()].sort((left, right) =>
          left.sourceKey.localeCompare(right.sourceKey)
        ))
      });
    }
    if (audience.source.kind === 'registered_query') {
      // A minted immutable recipe row remains the authorization to resolve; a
      // registered live delegate then serves the recipe's current snapshot.
      const recipe = this.#exactRecipe(selected, audience.source);
      if (recipe === undefined) {
        throw new OrganizerAudienceResolutionError('source_not_registered');
      }
      const delegate = this.#registeredSources.get(recipe.source_definition_key);
      if (delegate !== undefined) {
        const snapshot = delegate.resolveCurrentSnapshot({ scope: selected, audience });
        if (!exactJson(snapshot.source, audience.source)) {
          throw new OrganizerAudienceResolutionError('source_contract_mismatch');
        }
        return snapshot;
      }
    }
    if (audience.source.kind === 'explicit_contacts') {
      const grouped = new Map<SQLiteRegisteredAudienceSourceDelegate, string[]>();
      for (const contactRefId of audience.source.contactRefIds) {
        const matching = [...this.#registeredSources.values()].filter((delegate) =>
          delegate.resolveExplicitContacts !== undefined && delegate.ownsContactRef(contactRefId)
        );
		const owners = matching.filter((delegate, index) => matching.findIndex((candidate) =>
			candidate.resolveExplicitContacts === delegate.resolveExplicitContacts
		) === index);
        if (owners.length > 1) {
          throw new OrganizerAudienceResolutionError('source_contract_mismatch');
        }
        if (owners[0]) grouped.set(owners[0], [...(grouped.get(owners[0]) ?? []), contactRefId]);
      }
      if (grouped.size > 0) {
        const candidates: OrganizerAudienceCandidate[] = [];
        const sourceVersions: OrganizerMessagePreviewSourceVersion[] = [];
        for (const [delegate, contactRefIds] of grouped) {
          const source = delegate.resolveExplicitContacts!({
            scope: selected,
            audience,
            contactRefIds: Object.freeze([...contactRefIds].sort())
          });
          candidates.push(...source.candidates);
          sourceVersions.push(...source.sourceVersions);
        }
        const owned = new Set(candidates.map((candidate) => candidate.contactRefId));
        const unowned = audience.source.contactRefIds.filter((contactRefId) =>
          ![...grouped.values()].flat().includes(contactRefId)
        );
        if (unowned.length === 0 && owned.size === candidates.length) {
          return Object.freeze({
            source: audience.source,
            candidates: Object.freeze(candidates.sort((left, right) =>
              left.subjectRefId.localeCompare(right.subjectRefId)
            )),
            sourceVersions: Object.freeze(sourceVersions.sort((left, right) =>
              left.sourceKey.localeCompare(right.sourceKey)
            ))
          });
        }
      }
    }
    const rows = this.#candidateRows(selected, audience);
    const candidates = rows.map((row) => {
      try {
        return organizerAudienceCandidateSchema.parse({
          subjectRefId: row.subject_ref_id,
          subjectVersion: row.subject_version,
          personRefId: row.person_ref_id,
          contactRefId: row.contact_ref_id,
          safeLabel: row.safe_label,
          membershipEvidence: parsedJson(row.membership_evidence_json)
        });
      } catch (error) {
        throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', error);
      }
    });
    let sourceVersions: OrganizerMessagePreviewSourceVersion[];
    if (audience.source.kind === 'registered_query') {
      sourceVersions = this.sqlite.query<{
        source_key: string; source_version: number; digest_sha256: string;
      }, [string, string, string, number]>(`
        SELECT source_key,source_version,digest_sha256
          FROM communication_registered_audience_source_versions
         WHERE workspace_id=? AND event_id=? AND recipe_id=? AND recipe_version=?
         ORDER BY source_key
      `).all(
        selected.workspaceId, selected.eventId,
        audience.source.recipeId, audience.source.recipeVersion
      ).map((row) => organizerMessagePreviewSourceVersionSchema.parse({
        sourceKey: row.source_key,
        sourceVersion: row.source_version,
        digestSha256: row.digest_sha256
      }));
    } else if (audience.source.kind === 'explicit_contacts') {
      const state = this.sqlite.query<{ state_version: number }, [string, string]>(`
        SELECT state_version FROM communication_audience_scope_state
         WHERE workspace_id=? AND event_id=? LIMIT 2
      `).all(selected.workspaceId, selected.eventId);
      if (state.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
      sourceVersions = [organizerMessagePreviewSourceVersionSchema.parse({
        sourceKey: 'contact-registry.current',
        sourceVersion: state[0]?.state_version ?? 1,
        digestSha256: digest({ candidates })
      })];
    } else {
      throw new OrganizerAudienceResolutionError('source_contract_mismatch');
    }
    return Object.freeze({ source: audience.source, candidates, sourceVersions });
  }

  putCurrentAddress(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly address: unknown;
    readonly createdAt: unknown;
  }): void {
    requireTransaction(this.sqlite);
    const selected = scope(input.scope);
    const createdAt = instant(input.createdAt);
    let address: ReturnType<typeof organizerClassifiedEmailAddressSchema.parse>;
    try {
      address = organizerClassifiedEmailAddressSchema.parse(input.address);
      parsePayloadRefId(address.classifiedValue.payloadRefId);
    } catch (error) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input', error);
    }
    const contact = this.sqlite.query<{ contact_ref_id: string }, [string, string, string]>(`
      SELECT contact_ref_id FROM communication_current_audience_contacts
       WHERE workspace_id=? AND event_id=? AND contact_ref_id=? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, address.contactRefId);
    if (contact.length !== 1) throw new SQLiteOrganizerAudiencePreviewError('not_found');
    const existing = this.#addressRow(selected, address.addressRefId, address.addressVersion);
    if (existing !== undefined) {
      const opened = this.#openAddress(selected, existing);
      if (!exactJson(opened, address)) {
        throw new SQLiteOrganizerAudiencePreviewError('preview_conflict');
      }
    } else {
      const bytes = new TextEncoder().encode(address.classifiedValue.value);
      try {
        const receipt = adoptSynchronousClassifiedPayload({
          store: this.classifiedStore,
          put: {
            payloadRefId: parsePayloadRefId(address.classifiedValue.payloadRefId),
            binding: addressBinding({
              scope: selected,
              contactRefId: address.contactRefId,
              addressRefId: address.addressRefId,
              addressVersion: address.addressVersion
            }),
            purpose: 'communication.contact.email',
            bytes,
            createdAt
          }
        });
        const adopted = openSynchronousClassifiedPayloadAdoptionReceipt({
          receipt,
          expectedStore: this.classifiedStore
        });
        if (adopted.payloadRef.id !== address.classifiedValue.payloadRefId) {
          throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
        }
        this.sqlite.query(`
          INSERT INTO communication_channel_address_versions(
            workspace_id,event_id,address_ref_id,address_version,contact_ref_id,channel,lifecycle,
            lifecycle_evidence_json,lookup_profile,lookup_version,lookup_keyed_value,
            classified_payload_ref_id,payload_ref_version,classification,created_at
          ) VALUES (?,?,?,?,?,'email',?,?,?,?,?,?,?,?,?)
        `).run(
          selected.workspaceId, selected.eventId, address.addressRefId, address.addressVersion,
          address.contactRefId, address.lifecycle, canonicalJsonText(address.lifecycleEvidence),
          address.lookupFingerprint.profile, address.lookupFingerprint.version,
          address.lookupFingerprint.keyedValue, address.classifiedValue.payloadRefId,
          address.classifiedValue.payloadRefVersion, address.classifiedValue.classification, createdAt
        );
      } catch (error) {
        if (error instanceof SQLiteOrganizerAudiencePreviewError) throw error;
        throw new SQLiteOrganizerAudiencePreviewError('preview_conflict', error);
      } finally {
        bytes.fill(0);
      }
    }
    this.sqlite.query(`
      INSERT INTO communication_current_channel_addresses(
        workspace_id,event_id,contact_ref_id,address_ref_id,address_version
      ) VALUES (?,?,?,?,?)
      ON CONFLICT(workspace_id,event_id,contact_ref_id)
      DO UPDATE SET address_ref_id=excluded.address_ref_id,address_version=excluded.address_version
    `).run(
      selected.workspaceId, selected.eventId, address.contactRefId,
      address.addressRefId, address.addressVersion
    );
    this.#bumpScopeState(selected);
  }

  readCurrentAddress(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly contactRefId: string;
  }): OrganizerClassifiedEmailAddress | undefined {
    const selected = scope(input.scope);
    const contactRefId = organizerCommunicationSubjectRefIdSchema.parse(input.contactRefId);
    const row = this.#currentAddressRow(selected, contactRefId);
    return row === undefined ? undefined : this.#openAddress(selected, row);
  }

  #addressRow(
    selected: OrganizerAudienceScope,
    addressRefId: string,
    addressVersion: number
  ): AddressRow | undefined {
    const rows = this.sqlite.query<AddressRow, [string, string, string, number]>(`
      SELECT address_ref_id,address_version,contact_ref_id,lifecycle,lifecycle_evidence_json,
             lookup_profile,lookup_version,lookup_keyed_value,classified_payload_ref_id,
             payload_ref_version,classification
        FROM communication_channel_address_versions
       WHERE workspace_id=? AND event_id=? AND address_ref_id=? AND address_version=? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, addressRefId, addressVersion);
    if (rows.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    return rows[0];
  }

  #currentAddressRow(selected: OrganizerAudienceScope, contactRefId: string): AddressRow | undefined {
    const rows = this.sqlite.query<AddressRow, [string, string, string]>(`
      SELECT a.address_ref_id,a.address_version,a.contact_ref_id,a.lifecycle,
             a.lifecycle_evidence_json,a.lookup_profile,a.lookup_version,a.lookup_keyed_value,
             a.classified_payload_ref_id,a.payload_ref_version,a.classification
        FROM communication_current_channel_addresses c
        JOIN communication_channel_address_versions a
          ON a.workspace_id=c.workspace_id AND a.event_id=c.event_id
         AND a.address_ref_id=c.address_ref_id AND a.address_version=c.address_version
       WHERE c.workspace_id=? AND c.event_id=? AND c.contact_ref_id=? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, contactRefId);
    if (rows.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    return rows[0];
  }

  #openAddress(selected: OrganizerAudienceScope, row: AddressRow) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = this.classifiedStore.read({
        payloadRef: createPayloadRef(parsePayloadRefId(row.classified_payload_ref_id)),
        expectedBinding: addressBinding({
          scope: selected,
          contactRefId: row.contact_ref_id,
          addressRefId: row.address_ref_id,
          addressVersion: row.address_version
        }),
        purpose: 'communication.contact.email'
      });
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return organizerClassifiedEmailAddressSchema.parse({
        addressRefId: row.address_ref_id,
        addressVersion: row.address_version,
        contactRefId: row.contact_ref_id,
        channel: 'email',
        lifecycle: row.lifecycle,
        lifecycleEvidence: parsedJson(row.lifecycle_evidence_json),
        lookupFingerprint: {
          profile: row.lookup_profile,
          version: row.lookup_version,
          keyedValue: row.lookup_keyed_value
        },
        classifiedValue: {
          payloadRefId: row.classified_payload_ref_id,
          payloadRefVersion: row.payload_ref_version,
          classification: row.classification,
          value
        }
      });
    } catch (error) {
      if (error instanceof SQLiteOrganizerAudiencePreviewError) throw error;
      throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', error);
    } finally {
      bytes?.fill(0);
    }
  }

  putCurrentAddressPolicy(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly purposeRevision: unknown;
    readonly contactRefId: unknown;
    readonly resolution: unknown;
  }): void {
    requireTransaction(this.sqlite);
    const selected = scope(input.scope);
    let purposeRevision: OrganizerCommunicationPurposeRevisionRef;
    let contactRefId: string;
    let resolution: OrganizerAddressPolicyResolution;
    try {
      purposeRevision = organizerCommunicationPurposeRevisionRefSchema.parse(input.purposeRevision);
      contactRefId = organizerCommunicationSubjectRefIdSchema.parse(input.contactRefId);
      resolution = organizerAddressPolicyResolutionSchema.parse(input.resolution);
    } catch (error) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input', error);
    }
    const contact = this.sqlite.query<{ contact_ref_id: string }, [string, string, string]>(`
      SELECT contact_ref_id FROM communication_current_audience_contacts
       WHERE workspace_id=? AND event_id=? AND contact_ref_id=? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, contactRefId);
    if (contact.length !== 1) throw new SQLiteOrganizerAudiencePreviewError('not_found');
    let addressRefId: string | null = null;
    let addressVersion: number | null = null;
    let policyJson: string;
    if (resolution.kind === 'no_eligible_address') {
      policyJson = canonicalJsonText({ evidence: resolution.evidence });
    } else {
      if (resolution.address.contactRefId !== contactRefId) {
        throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
      }
      const stored = this.#addressRow(
        selected, resolution.address.addressRefId, resolution.address.addressVersion
      );
      if (stored === undefined || stored.contact_ref_id !== contactRefId) {
        throw new SQLiteOrganizerAudiencePreviewError('not_found');
      }
      addressRefId = resolution.address.addressRefId;
      addressVersion = resolution.address.addressVersion;
      policyJson = canonicalJsonText({
        selectionPolicy: resolution.selectionPolicy,
        purposeBasis: resolution.purposeBasis,
        consent: resolution.consent,
        suppression: resolution.suppression,
        doNotContact: resolution.doNotContact
      });
    }
    this.sqlite.query(`
      INSERT INTO communication_current_address_policies(
        workspace_id,event_id,purpose_revision_id,contact_ref_id,purpose_revision_json,
        resolution_kind,address_ref_id,address_version,policy_json
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,event_id,purpose_revision_id,contact_ref_id)
      DO UPDATE SET purpose_revision_json=excluded.purpose_revision_json,
        resolution_kind=excluded.resolution_kind,address_ref_id=excluded.address_ref_id,
        address_version=excluded.address_version,policy_json=excluded.policy_json
    `).run(
      selected.workspaceId, selected.eventId, purposeRevision.revisionId, contactRefId,
      canonicalJsonText(purposeRevision), resolution.kind, addressRefId, addressVersion, policyJson
    );
    this.#bumpScopeState(selected);
  }

  resolveEmail({ scope: rawScope, purposeRevision: rawPurpose, candidate, asOf: rawAsOf }: {
    readonly scope: OrganizerAudienceScope;
    readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
    readonly candidate: OrganizerAudienceCandidate;
    readonly asOf: string;
  }): OrganizerAddressPolicyResolution {
    const selected = scope(rawScope);
    const purposeRevision = organizerCommunicationPurposeRevisionRefSchema.parse(rawPurpose);
    for (const delegate of this.#registeredSources.values()) {
      if (delegate.ownsContactRef(candidate.contactRefId)) {
        const delegated = organizerAddressPolicyResolutionSchema.parse(delegate.resolveEmail({
          scope: selected,
          purposeRevision,
          candidate,
          asOf: rawAsOf
        }));
        if (delegated.kind === 'no_eligible_address') return delegated;
        const current = this.#currentAddressRow(selected, candidate.contactRefId);
        const address = current === undefined
          ? delegated.address
          : this.#openAddress(selected, current);
        let suppression: { readonly state: 'suppressed' | 'clear' } | undefined;
        try {
          suppression = this.sqlite.query<{ readonly state: 'suppressed' | 'clear' }, [
            string, string, number, string
          ]>(`
            SELECT state FROM communication_current_address_suppressions
             WHERE workspace_id=? AND lookup_profile=? AND lookup_version=? AND lookup_keyed_value=?
          `).get(
            selected.workspaceId, address.lookupFingerprint.profile,
            address.lookupFingerprint.version, address.lookupFingerprint.keyedValue
          ) ?? undefined;
        } catch (error) {
          if (!(error instanceof Error)
              || !error.message.includes('no such table: communication_current_address_suppressions')) {
            throw error;
          }
        }
        return organizerAddressPolicyResolutionSchema.parse({
          ...delegated,
          address,
          ...(suppression?.state !== 'suppressed' ? {} : {
            suppression: {
              state: 'suppressed',
              evidence: {
                evidenceRefId: `evi1_${digest({
                  workspaceId: selected.workspaceId,
                  lookup: address.lookupFingerprint,
                  state: 'suppressed'
                }).slice(0, 40)}`,
                evidenceVersion: 1,
                evidenceDigestSha256: digest({
                  kind: 'communication.address.workspace_suppression',
                  workspaceId: selected.workspaceId,
                  lookup: address.lookupFingerprint
                })
              }
            }
          })
        });
      }
    }
    const rows = this.sqlite.query<{
      purpose_revision_json: string;
      resolution_kind: 'no_eligible_address' | 'evaluated';
      address_ref_id: string | null;
      address_version: number | null;
      policy_json: string;
    }, [string, string, string, string]>(`
      SELECT purpose_revision_json,resolution_kind,address_ref_id,address_version,policy_json
        FROM communication_current_address_policies
       WHERE workspace_id=? AND event_id=? AND purpose_revision_id=? AND contact_ref_id=? LIMIT 2
    `).all(
      selected.workspaceId, selected.eventId, purposeRevision.revisionId, candidate.contactRefId
    );
    if (rows.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    const row = rows[0];
    if (row === undefined) {
      const material = {
        workspaceId: selected.workspaceId,
        eventId: selected.eventId,
        purposeRevision,
        contactRefId: candidate.contactRefId
      };
      return organizerAddressPolicyResolutionSchema.parse({
        kind: 'no_eligible_address',
        evidence: {
          evidenceRefId: `evi1_${digest(material).slice(0, 40)}`,
          evidenceVersion: 1,
          evidenceDigestSha256: digest({ kind: 'address.no_current_policy', material })
        }
      });
    }
    if (!exactJson(parsedJson(row.purpose_revision_json), purposeRevision)) {
      throw new OrganizerAudienceResolutionError('address_evidence_invalid');
    }
    const policy = parsedJson(row.policy_json) as Record<string, unknown>;
    if (row.resolution_kind === 'no_eligible_address') {
      return organizerAddressPolicyResolutionSchema.parse({
        kind: 'no_eligible_address',
        evidence: policy.evidence
      });
    }
    if (row.address_ref_id === null || row.address_version === null) {
      throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    }
    const current = this.#currentAddressRow(selected, candidate.contactRefId);
    if (current === undefined || current.address_ref_id !== row.address_ref_id
        || current.address_version !== row.address_version) {
      return organizerAddressPolicyResolutionSchema.parse({
        kind: 'no_eligible_address',
        evidence: {
          evidenceRefId: `evi1_${digest({ row, candidate: candidate.contactRefId }).slice(0, 40)}`,
          evidenceVersion: 1,
          evidenceDigestSha256: digest({ kind: 'address.policy_pointer_stale', row })
        }
      });
    }
    return organizerAddressPolicyResolutionSchema.parse({
      kind: 'evaluated',
      selectionPolicy: policy.selectionPolicy,
      address: this.#openAddress(selected, current),
      purposeBasis: policy.purposeBasis,
      consent: policy.consent,
      suppression: policy.suppression,
      doNotContact: policy.doNotContact
    });
  }

  #audienceCursorTag(keyBytes: Uint8Array, bindingDigestSha256: string, offset: number): string {
    return createHmac('sha256', keyBytes)
      .update(canonicalJsonText({
        schemaVersion: 1,
        namespace: 'communication.audience-options.cursor',
        bindingDigestSha256,
        offset
      }), 'utf8')
      .digest('hex')
      .slice(0, 40);
  }

  #issueAudienceCursor(bindingDigestSha256: string, offset: number): string {
    return `cur1_${offset.toString(36)}_${this.#audienceCursorTag(
      this.#cursorKeys[0]!,
      bindingDigestSha256,
      offset
    )}`;
  }

  #readAudienceCursor(bindingDigestSha256: string, cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const match = /^cur1_([0-9a-z]+)_([a-f0-9]{40})$/u.exec(cursor);
    if (match === null) throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
    const offset = Number.parseInt(match[1]!, 36);
    if (!Number.isSafeInteger(offset) || offset < 0
        || !this.#cursorKeys.some((keyBytes) => equalAscii(
          this.#audienceCursorTag(keyBytes, bindingDigestSha256, offset),
          match[2]!
        ))) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
    }
    return offset;
  }

	#recipientEstimate(
		selected: OrganizerAudienceScope,
		audience: OrganizerCommunicationAudienceDraft
	): number {
		const snapshot = this.resolveCurrentSnapshot({ scope: selected, audience });
		const byAddress = new Map<string, boolean>();
		for (const candidate of snapshot.candidates) {
			const resolution = this.resolveEmail({
				scope: selected,
				purposeRevision: audience.purposeRevision,
				candidate,
				asOf: new Date().toISOString()
			});
			if (resolution.kind === 'no_eligible_address') continue;
			const key = resolution.address.classifiedValue.value.trim().toLocaleLowerCase('en-US');
			const eligible = resolution.address.lifecycle === 'active'
				&& resolution.purposeBasis.state === 'allowed'
				&& (resolution.consent.state === 'not_required' || resolution.consent.state === 'granted')
				&& resolution.suppression.state === 'clear'
				&& resolution.doNotContact.state === 'clear';
			byAddress.set(key, (byAddress.get(key) ?? true) && eligible);
		}
		return [...byAddress.values()].filter(Boolean).length;
	}

	#selectionPreview(
		selected: OrganizerAudienceScope,
		options: readonly OrganizerCommunicationAudienceOption[],
		optionIds: readonly string[]
	) {
		if (options.length !== optionIds.length) {
			throw new SQLiteOrganizerAudiencePreviewError('not_found');
		}
		const purpose = options[0]!.audienceDraft.purposeRevision;
		if (options.some((option) => option.audienceDraft.purposeRevision.revisionId
			!== purpose.revisionId)) {
			throw new SQLiteOrganizerAudiencePreviewError('invalid_input');
		}
		type Row = {
			personRefId: string;
			safeLabel: string;
			state: 'included' | 'excluded';
			reasonCode?: string;
			via?: string;
		};
		const rows: Row[] = [];
		const byAddress = new Map<string, number>();
		const groupCounts = new Map<string, number>();
		options.forEach((option, groupIndex) => {
			const seenInGroup = new Set<string>();
			const snapshot = this.resolveCurrentSnapshot({ scope: selected, audience: option.audienceDraft });
			snapshot.candidates.forEach((candidate, candidateIndex) => {
				const resolution = this.resolveEmail({
					scope: selected,
					purposeRevision: purpose,
					candidate,
					asOf: new Date().toISOString()
				});
				let included = false;
				let reasonCode = 'address.no_eligible';
				let addressKey = `\u0000unkeyed:${groupIndex}:${candidateIndex}`;
				if (resolution.kind === 'evaluated') {
					addressKey = resolution.address.classifiedValue.value.trim().toLocaleLowerCase('en-US');
					if (resolution.address.lifecycle === 'revoked') reasonCode = 'address.revoked';
					else if (resolution.purposeBasis.state === 'denied') reasonCode = 'purpose.not_allowed';
					else if (resolution.consent.state === 'missing') reasonCode = 'purpose.consent_missing';
					else if (resolution.consent.state === 'withdrawn') reasonCode = 'purpose.consent_withdrawn';
					else if (resolution.doNotContact.state === 'active') reasonCode = 'person.do_not_contact';
					else if (resolution.suppression.state === 'suppressed') reasonCode = 'address.suppressed';
					else included = true;
				}
				const priorIndex = byAddress.get(addressKey);
				if (priorIndex === undefined) {
					byAddress.set(addressKey, rows.length);
					rows.push({
						personRefId: candidate.personRefId,
						safeLabel: candidate.safeLabel,
						state: included ? 'included' : 'excluded',
						...(included ? {} : { reasonCode }),
						...(options.length > 1 ? { via: option.label } : {})
					});
				} else if (!included && rows[priorIndex]!.state === 'included') {
					rows[priorIndex] = { ...rows[priorIndex]!, state: 'excluded', reasonCode };
				}
				if (!seenInGroup.has(addressKey)) {
					seenInGroup.add(addressKey);
					groupCounts.set(addressKey, (groupCounts.get(addressKey) ?? 0) + 1);
				}
			});
		});
		const audienceDraft: OrganizerCommunicationAudienceDraft = {
			schemaVersion: 1,
			binding: 'current_snapshot',
			purposeRevision: purpose,
			source: options.length === 1
				? options[0]!.audienceDraft.source
				: {
					kind: 'composite',
					groups: options.map((option) => ({
						label: option.label,
						source: option.audienceDraft.source.kind === 'composite'
							? (() => { throw new SQLiteOrganizerAudiencePreviewError('invalid_input'); })()
							: option.audienceDraft.source
					}))
				}
		};
		return organizerCommunicationAudienceSelectionPreviewSchema.parse({
			schemaVersion: 1,
			optionIds,
			label: options.map((option) => option.label).join(' + '),
			reach: rows.filter((row) => row.state === 'included').length,
			overlap: [...groupCounts.values()].filter((count) => count > 1).length,
			rows,
			audienceDraft
		});
	}

  listAudienceOptions(
    rawScope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    rawInput: unknown
  ): OrganizerCommunicationCanonicalResult {
    const selected = scope(rawScope);
    owner(authorityPrincipalKey);
    let input: ReturnType<typeof organizerCommunicationAudienceOptionListInputSchema.parse>;
    let offset: number;
    let bindingDigestSha256: string;
    try {
      input = organizerCommunicationAudienceOptionListInputSchema.parse(rawInput);
      bindingDigestSha256 = digest({
        schemaVersion: 1,
        scope: selected,
        personRefId: input.personRefId ?? null,
        purposeId: input.purposeId ?? null,
		selectionOptionIds: input.selectionOptionIds ?? null
      });
      offset = this.#readAudienceCursor(bindingDigestSha256, input.cursor);
    } catch {
      return outcome('policy_violation', 'communication.preview_invalid');
    }
    const limit = input.limit ?? 50;
    const values: Array<string | number> = [selected.workspaceId, selected.eventId];
    let sql = `
      SELECT r.recipe_id,r.recipe_version,r.recipe_digest_sha256,r.source_definition_key,
             r.source_definition_version,r.source_definition_digest_sha256,r.option_json
        FROM communication_registered_audience_recipes r
       WHERE r.workspace_id=? AND r.event_id=?
         AND r.option_version=(
           SELECT MAX(newer.option_version)
             FROM communication_registered_audience_recipes newer
            WHERE newer.workspace_id=r.workspace_id AND newer.event_id=r.event_id
              AND newer.option_id=r.option_id
         )
    `;
    if (input.purposeId !== undefined) {
      sql += ' AND r.purpose_id=?';
      values.push(input.purposeId);
    }
	if (input.selectionOptionIds !== undefined && input.personRefId === undefined) {
		sql += ` AND r.option_id IN (${input.selectionOptionIds.map(() => '?').join(',')})`;
		values.push(...input.selectionOptionIds);
	}
    // A scoped compose needs an explicit one-person audience. Registered live
    // delegates deliberately do not mirror their memberships into the generic
    // tables, so an SQL membership filter would return no option for those
    // sources. Read the minted recipes and let their owning delegates resolve
    // the current person-bearing candidate below.
    sql += ' ORDER BY r.option_id,r.option_version LIMIT ? OFFSET ?';
	const selectionOptionIds = input.selectionOptionIds;
	const selectedOnly = selectionOptionIds !== undefined && input.personRefId === undefined;
	values.push(selectedOnly ? selectionOptionIds!.length + 1
		: input.personRefId === undefined ? limit + 1 : ORGANIZER_COMMUNICATION_PAGE_LIMIT + 1,
		selectedOnly ? 0 : input.personRefId === undefined ? offset : 0);
    let rows: RecipeRow[];
    try {
      rows = this.sqlite.query<RecipeRow, Array<string | number>>(sql).all(...values);
    } catch (error) {
      throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', error);
    }
    let projected = rows.map((row) => organizerCommunicationAudienceOptionSchema.parse(
      parsedJson(row.option_json)
    ));
    if (input.personRefId !== undefined) {
	  const ordinary = projected;
      const scoped = projected.flatMap((option) => {
        if (option.audienceDraft.source.kind !== 'registered_query') return [];
        const delegate = this.#registeredSources.get(
          option.audienceDraft.source.sourceDefinition.reference.key
        );
        if (delegate === undefined) return [];
        const candidate = delegate.resolveCurrentSnapshot({
          scope: selected,
          audience: option.audienceDraft
        }).candidates.find((entry) => entry.personRefId === input.personRefId);
        if (candidate === undefined) return [];
        const audienceDraft = organizerCommunicationAudienceDraftSchema.parse({
          schemaVersion: 1,
          binding: 'current_snapshot',
          purposeRevision: option.audienceDraft.purposeRevision,
          source: { kind: 'explicit_contacts', contactRefIds: [candidate.contactRefId] }
        });
        const material = {
          recipeOptionId: option.optionId,
          personRefId: input.personRefId,
          contactRefId: candidate.contactRefId,
          audienceDraft
        };
        return [organizerCommunicationAudienceOptionSchema.parse({
          schemaVersion: 1,
          optionId: `person.${digest(material).slice(0, 40)}`,
          optionVersion: option.optionVersion,
          optionDigestSha256: digest(material),
          label: candidate.safeLabel,
          recipientEstimate: { knowledge: 'unknown', reasonCode: 'audience.resolved_at_preview' },
          audienceDraft
        })];
	  });
	  projected = input.selectionOptionIds === undefined ? scoped : [...ordinary, ...scoped];
    }
	if (input.selectionOptionIds !== undefined) {
		const byId = new Map(projected.map((option) => [option.optionId, option]));
		projected = input.selectionOptionIds.flatMap((optionId) => {
			const option = byId.get(optionId);
			return option ? [option] : [];
		});
		if (projected.length !== input.selectionOptionIds.length) {
			return outcome('conflict', 'communication.not_found');
		}
	}
	projected = projected.map((option) => organizerCommunicationAudienceOptionSchema.parse({
		...option,
		recipientEstimate: {
			knowledge: 'known',
			value: this.#recipientEstimate(selected, option.audienceDraft)
		}
	}));
    const pageRows = projected.slice(offset, offset + limit);
    const hasMore = offset + pageRows.length < projected.length;
    try {
      const page = organizerCommunicationAudienceOptionPageSchema.parse({
        schemaVersion: 1,
        rows: pageRows,
        page: hasMore
          ? {
              hasMore: true,
              nextCursor: this.#issueAudienceCursor(bindingDigestSha256, offset + pageRows.length)
            }
		  : { hasMore: false },
		...(input.selectionOptionIds === undefined ? {} : {
			selectionPreview: this.#selectionPreview(selected, projected, input.selectionOptionIds)
		})
      });
      return Object.freeze({ kind: 'success', data: page });
    } catch (error) {
      throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', error);
    }
  }

  #nextGeneration(selected: OrganizerAudienceScope, draftId: string, draftVersion: number): number {
    const row = this.sqlite.query<{ generation: number }, [string, string, string, number]>(`
      SELECT COALESCE(MAX(preview_generation),0)+1 AS generation
        FROM communication_message_preview_snapshots
       WHERE workspace_id=? AND event_id=? AND draft_id=? AND draft_version=?
    `).get(selected.workspaceId, selected.eventId, draftId, draftVersion);
    if (row === null || !Number.isSafeInteger(row.generation) || row.generation < 1) {
      throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    }
    return row.generation;
  }

  #currentGuard(input: {
    readonly scope: OrganizerAudienceScope;
    readonly ownerKey: string;
    readonly binding: OrganizerPreviewDraftBinding;
  }): string {
    const source = this.resolveCurrentSnapshot({
      scope: input.scope,
      audience: input.binding.draft.audience
    });
    const addressPolicyState = source.candidates.map((candidate) => {
      const address = this.#currentAddressRow(input.scope, candidate.contactRefId);
      const policy = this.sqlite.query<{
        purpose_revision_json: string;
        resolution_kind: string;
        address_ref_id: string | null;
        address_version: number | null;
        policy_json: string;
      }, [string, string, string, string]>(`
        SELECT purpose_revision_json,resolution_kind,address_ref_id,address_version,policy_json
          FROM communication_current_address_policies
         WHERE workspace_id=? AND event_id=? AND purpose_revision_id=? AND contact_ref_id=? LIMIT 2
      `).all(
        input.scope.workspaceId, input.scope.eventId,
        input.binding.draft.purposeRevision.revisionId, candidate.contactRefId
      );
      if (policy.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
      return {
        contactRefId: candidate.contactRefId,
        address: address === undefined ? null : {
          addressRefId: address.address_ref_id,
          addressVersion: address.address_version,
          lifecycle: address.lifecycle,
          lifecycleEvidence: parsedJson(address.lifecycle_evidence_json),
          lookupFingerprint: {
            profile: address.lookup_profile,
            version: address.lookup_version,
            keyedValue: address.lookup_keyed_value
          },
          classifiedPayloadRefId: address.classified_payload_ref_id,
          payloadRefVersion: address.payload_ref_version,
          classification: address.classification
        },
        policy: policy[0] === undefined ? null : {
          purposeRevision: parsedJson(policy[0].purpose_revision_json),
          resolutionKind: policy[0].resolution_kind,
          addressRefId: policy[0].address_ref_id,
          addressVersion: policy[0].address_version,
          policy: parsedJson(policy[0].policy_json)
        }
      };
    });
    return digest({
      schemaVersion: 1,
      scope: input.scope,
      ownerKey: input.ownerKey,
      draft: input.binding.draft,
      renderer: input.binding.renderer,
      mergeRegistry: input.binding.mergeRegistry,
      source,
      addressPolicyState
    });
  }

  /**
   * Commit-side currency probe for an adopted preview snapshot. It re-proves,
   * synchronously and from live domain state, exactly what adoption pinned:
   * the immutable snapshot row still carries the requested identity, the draft
   * binding still reads at the pinned version, and re-resolving the audience
   * plus address-policy state reproduces the adopted guard digest. Any drift —
   * a re-decide, a revised or discarded draft, a changed address or policy —
   * fails closed to 'stale'. The reviewed send batch consumes this inside its
   * one commit transaction; the asynchronous full re-render check remains the
   * read path's stronger gate.
   */
  checkAdoptedPreviewCurrency(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly identity: unknown;
  }): 'current' | 'stale' | 'not_found' {
    const selected = scope(input.scope);
    let identity: ReturnType<typeof organizerMessagePreviewIdentitySchema.parse>;
    try {
      identity = organizerMessagePreviewIdentitySchema.parse(input.identity);
    } catch (error) {
      throw new SQLiteOrganizerAudiencePreviewError('invalid_input', error);
    }
    const rows = this.sqlite.query<{
      readonly owner_key: string;
      readonly draft_id: string;
      readonly draft_version: number;
      readonly preview_generation: number;
      readonly preview_digest_profile: string;
      readonly preview_digest_version: number;
      readonly preview_digest_sha256: string;
      readonly guard_digest_sha256: string;
    }, [string, string, string]>(`
      SELECT owner_key,draft_id,draft_version,preview_generation,preview_digest_profile,
             preview_digest_version,preview_digest_sha256,guard_digest_sha256
        FROM communication_message_preview_snapshots
       WHERE workspace_id=? AND event_id=? AND audience_spec_id=? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, identity.audienceSpecId);
    if (rows.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    const row = rows[0];
    if (row === undefined) return 'not_found';
    if (row.draft_id !== identity.draftId
        || row.draft_version !== identity.draftVersion
        || row.preview_generation !== identity.previewGeneration
        || row.preview_digest_profile !== identity.previewDigestProfile
        || row.preview_digest_version !== identity.previewDigestVersion
        || row.preview_digest_sha256 !== identity.previewDigestSha256) {
      return 'stale';
    }
    const binding = this.options.drafts.readCurrent({
      scope: selected,
      ownerKey: row.owner_key,
      draftId: identity.draftId,
      expectedVersion: identity.draftVersion
    });
    if (binding === undefined) return 'stale';
    try {
      return this.#currentGuard({ scope: selected, ownerKey: row.owner_key, binding })
        === row.guard_digest_sha256
        ? 'current'
        : 'stale';
    } catch (error) {
      // A source that can no longer resolve is drifted domain state, not corruption.
      if (error instanceof OrganizerAudienceResolutionError) return 'stale';
      throw error;
    }
  }

  async preparePreview(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly draftId: string;
    readonly expectedDraftVersion: number;
    readonly now: unknown;
  }): Promise<SQLiteOrganizerPreparedPreview> {
    const selected = scope(input.scope);
    const ownerKey = owner(input.ownerKey);
    const createdAt = instant(input.now);
    const binding = this.options.drafts.readCurrent({
      scope: selected,
      ownerKey,
      draftId: input.draftId,
      expectedVersion: input.expectedDraftVersion
    });
    if (binding === undefined) throw new SQLiteOrganizerAudiencePreviewError('stale_revision');
    const previewGeneration = this.#nextGeneration(
      selected, binding.draft.draftId, binding.draft.version
    );
    const guardDigestSha256 = this.#currentGuard({ scope: selected, ownerKey, binding });
    let bytes: Uint8Array | undefined;
    try {
      const prepared = await prepareOrganizerMessageBatchPreview({
        scope: selected,
        draft: binding.draft,
        previewGeneration,
        digestProfile: this.options.digestProfile,
        renderer: binding.renderer,
        mergeRegistry: binding.mergeRegistry,
        asOf: createdAt,
        source: this,
        addressPolicy: this,
        opaqueTokens: this.options.opaqueTokens,
        render: this.options.render
      });
      const canonical = canonicalJsonText(prepared);
      bytes = new TextEncoder().encode(canonical);
      const handle = Object.freeze({
        kind: 'sqlite_organizer_prepared_preview' as const,
        version: 1 as const
      }) as SQLiteOrganizerPreparedPreview;
      const record: PreparedRecord = {
        handle,
        scope: selected,
        ownerKey,
        guardDigestSha256,
        bytes,
        createdAt,
        expiresAtMs: Date.parse(createdAt) + this.#preparedTtlMs,
        phase: 'ready',
        zeroized: false
      };
      this.#preparedRecords.set(handle, record);
      this.#livePreparedRecords.add(record);
      record.timer = setTimeout(() => {
        this.#destroyPrepared(record);
      }, this.#preparedTtlMs);
      record.timer.unref?.();
      bytes = undefined;
      return handle;
    } catch (error) {
      bytes?.fill(0);
      if (error instanceof SQLiteOrganizerAudiencePreviewError) throw error;
      if (error instanceof OrganizerAudiencePreviewError
          || error instanceof OrganizerAudienceResolutionError) {
        throw new SQLiteOrganizerAudiencePreviewError('invalid_input', error);
      }
      throw error;
    }
  }

  disposePreparedPreview(preparation: SQLiteOrganizerPreparedPreview): void {
    const record = this.#preparedRecords.get(preparation);
    if (record === undefined || record.phase !== 'ready') {
      throw new SQLiteOrganizerAudiencePreviewError('preparation_spent');
    }
    this.#destroyPrepared(record);
  }

  purgeExpiredPrepared(now: unknown): number {
    const cutoff = Date.parse(instant(now));
    let purged = 0;
    for (const record of [...this.#livePreparedRecords]) {
      if (record.expiresAtMs > cutoff) continue;
      this.#destroyPrepared(record);
      purged += 1;
    }
    return purged;
  }

  /**
   * Adopts only already-prepared bytes inside a caller-owned SQL transaction.
   * This is intentionally not an operation receipt or transaction-bound resolver.
   */
  adoptPreparedPreview(input: {
    readonly preparation: SQLiteOrganizerPreparedPreview;
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly now: unknown;
  }): OrganizerMessagePreviewSummary {
    requireTransaction(this.sqlite);
    const record = this.#preparedRecords.get(input.preparation);
    if (record === undefined || record.phase !== 'ready') {
      throw new SQLiteOrganizerAudiencePreviewError('preparation_spent');
    }
    record.phase = 'spent';
    let parsed: OrganizerPreparedMessageBatchPreview | undefined;
    let savepointOpen = false;
    try {
      const selected = scope(input.scope);
      const ownerKey = owner(input.ownerKey);
      this.sqlite.exec('SAVEPOINT communication_audience_preview_adopt');
      savepointOpen = true;
      if (record.scope.workspaceId !== selected.workspaceId
          || record.scope.eventId !== selected.eventId
          || record.ownerKey !== ownerKey) {
        throw new SQLiteOrganizerAudiencePreviewError('preparation_scope_mismatch');
      }
      if (record.expiresAtMs <= Date.parse(instant(input.now))) {
        throw new SQLiteOrganizerAudiencePreviewError('preparation_expired');
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(record.bytes);
        parsed = preparedSnapshotSchema.parse(JSON.parse(text)) as unknown as
          OrganizerPreparedMessageBatchPreview;
        if (canonicalJsonText(parsed) !== text) throw new TypeError('not_canonical');
      } catch (error) {
        throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', error);
      }
      if (parsed.scope.workspaceId !== selected.workspaceId
          || parsed.scope.eventId !== selected.eventId) {
        throw new SQLiteOrganizerAudiencePreviewError('preparation_scope_mismatch');
      }
      const binding = this.options.drafts.readCurrent({
        scope: selected,
        ownerKey,
        draftId: parsed.draft.draftId,
        expectedVersion: parsed.draft.version
      });
      if (binding === undefined
          || this.#currentGuard({ scope: selected, ownerKey, binding }) !== record.guardDigestSha256) {
        throw new SQLiteOrganizerAudiencePreviewError('stale_revision');
      }
      if (this.#nextGeneration(selected, parsed.draft.draftId, parsed.draft.version)
          !== parsed.previewGeneration) {
        throw new SQLiteOrganizerAudiencePreviewError('stale_revision');
      }
      const identity = organizerMessagePreviewIdentitySchema.parse(parsed.summary.identity);
      const payloadRefId = deterministicUuid('communication.preview.snapshot', {
        scope: selected,
        ownerKey,
        identity
      });
      const existing = this.#previewRow(selected, ownerKey, identity);
      if (existing !== undefined) {
        throw new SQLiteOrganizerAudiencePreviewError('preview_conflict');
      }
      const adoption = adoptSynchronousClassifiedPayload({
        store: this.classifiedStore,
        put: {
          payloadRefId: parsePayloadRefId(payloadRefId),
          binding: previewBinding({
            scope: selected,
            ownerKey,
            audienceSpecId: identity.audienceSpecId
          }),
          purpose: 'communication.preview.exact',
          bytes: record.bytes,
          createdAt: record.createdAt
        }
      });
      const adopted = openSynchronousClassifiedPayloadAdoptionReceipt({
        receipt: adoption,
        expectedStore: this.classifiedStore
      });
      if (adopted.payloadRef.id !== payloadRefId) {
        throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
      }
      const summaryJson = canonicalJsonText(parsed.summary);
      // Summary is contract-classified as safe; exact address/render material lives only in ciphertext.
      this.sqlite.query(`
        INSERT INTO communication_message_preview_snapshots(
          workspace_id,event_id,owner_key,audience_spec_id,draft_id,draft_version,
          preview_generation,preview_digest_profile,preview_digest_version,
          preview_digest_sha256,guard_digest_sha256,summary_json,snapshot_payload_ref_id,
          snapshot_byte_size,snapshot_digest_sha256,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        selected.workspaceId, selected.eventId, ownerKey, identity.audienceSpecId,
        identity.draftId, identity.draftVersion, identity.previewGeneration,
        identity.previewDigestProfile, identity.previewDigestVersion,
        identity.previewDigestSha256, record.guardDigestSha256, summaryJson, payloadRefId,
        record.bytes.byteLength, bytesDigest(record.bytes), record.createdAt
      );
      this.sqlite.exec('RELEASE communication_audience_preview_adopt');
      savepointOpen = false;
      return parsed.summary;
    } catch (error) {
      if (savepointOpen) {
        try {
          this.sqlite.exec('ROLLBACK TO communication_audience_preview_adopt');
          this.sqlite.exec('RELEASE communication_audience_preview_adopt');
          savepointOpen = false;
        } catch (rollbackError) {
          throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', rollbackError);
        }
      }
      if (error instanceof SQLiteOrganizerAudiencePreviewError) throw error;
      throw new SQLiteOrganizerAudiencePreviewError('preview_conflict', error);
    } finally {
      // The handle is terminal whether adoption succeeds, refuses, or throws.
      this.#destroyPrepared(record);
      parsed = undefined;
    }
  }

  #previewRow(
    selected: OrganizerAudienceScope,
    ownerKey: string,
    identity: ReturnType<typeof organizerMessagePreviewIdentitySchema.parse>
  ): PreviewRow | undefined {
    const rows = this.sqlite.query<PreviewRow, [
      string, string, string, string, string, number, number, string, number, string
    ]>(`
      SELECT workspace_id,event_id,owner_key,audience_spec_id,draft_id,draft_version,
             preview_generation,preview_digest_profile,preview_digest_version,
             preview_digest_sha256,guard_digest_sha256,summary_json,snapshot_payload_ref_id,
             snapshot_byte_size,snapshot_digest_sha256,created_at
        FROM communication_message_preview_snapshots
       WHERE workspace_id=? AND event_id=? AND owner_key=? AND audience_spec_id=?
         AND draft_id=? AND draft_version=? AND preview_generation=?
         AND preview_digest_profile=? AND preview_digest_version=? AND preview_digest_sha256=?
       LIMIT 2
    `).all(
      selected.workspaceId, selected.eventId, ownerKey, identity.audienceSpecId,
      identity.draftId, identity.draftVersion, identity.previewGeneration,
      identity.previewDigestProfile, identity.previewDigestVersion, identity.previewDigestSha256
    );
    if (rows.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    return rows[0];
  }

  #previewAudienceExists(
    selected: OrganizerAudienceScope,
    ownerKey: string,
    audienceSpecId: string
  ): boolean {
    const rows = this.sqlite.query<{ present: number }, [string, string, string, string]>(`
      SELECT 1 AS present
        FROM communication_message_preview_snapshots
       WHERE workspace_id=? AND event_id=? AND owner_key=? AND audience_spec_id=? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, ownerKey, audienceSpecId);
    if (rows.length > 1) throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
    return rows.length === 1;
  }

  #openPreview(row: PreviewRow): OrganizerPreparedMessageBatchPreview {
    let bytes: Uint8Array | undefined;
    try {
      bytes = this.classifiedStore.read({
        payloadRef: createPayloadRef(parsePayloadRefId(row.snapshot_payload_ref_id)),
        expectedBinding: previewBinding({
          scope: { workspaceId: parseWorkspaceId(row.workspace_id), eventId: parseEventId(row.event_id) },
          ownerKey: row.owner_key,
          audienceSpecId: row.audience_spec_id
        }),
        purpose: 'communication.preview.exact'
      });
      if (bytes.byteLength !== row.snapshot_byte_size
          || bytesDigest(bytes) !== row.snapshot_digest_sha256) {
        throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const snapshot = preparedSnapshotSchema.parse(JSON.parse(text)) as unknown as
        OrganizerPreparedMessageBatchPreview;
      if (canonicalJsonText(snapshot) !== text
          || canonicalJsonText(snapshot.summary) !== row.summary_json
          || snapshot.scope.workspaceId !== row.workspace_id
          || snapshot.scope.eventId !== row.event_id
          || !exactJson(snapshot.summary.identity, {
            audienceSpecId: row.audience_spec_id,
            draftId: row.draft_id,
            draftVersion: row.draft_version,
            previewGeneration: row.preview_generation,
            previewDigestProfile: row.preview_digest_profile,
            previewDigestVersion: row.preview_digest_version,
            previewDigestSha256: row.preview_digest_sha256
          })) {
        throw new SQLiteOrganizerAudiencePreviewError('data_corrupt');
      }
      instant(row.created_at);
      return snapshot;
    } catch (error) {
      if (error instanceof SQLiteOrganizerAudiencePreviewError) throw error;
      throw new SQLiteOrganizerAudiencePreviewError('data_corrupt', error);
    } finally {
      bytes?.fill(0);
    }
  }

  #identityFromGet(rawInput: unknown) {
    const query = organizerMessageBatchPreviewGetInputSchema.parse(rawInput);
    return organizerMessagePreviewIdentitySchema.parse({
      audienceSpecId: query.audienceSpecId,
      draftId: query.draftId,
      draftVersion: query.draftVersion,
      previewGeneration: query.previewGeneration,
      previewDigestProfile: query.previewDigestProfile,
      previewDigestVersion: query.previewDigestVersion,
      previewDigestSha256: query.previewDigestSha256
    });
  }

  #identityFromList(rawInput: unknown) {
    const query = organizerMessagePreviewRecipientListInputSchema.parse(rawInput);
    return organizerMessagePreviewIdentitySchema.parse({
      audienceSpecId: query.audienceSpecId,
      draftId: query.draftId,
      draftVersion: query.draftVersion,
      previewGeneration: query.previewGeneration,
      previewDigestProfile: query.previewDigestProfile,
      previewDigestVersion: query.previewDigestVersion,
      previewDigestSha256: query.previewDigestSha256
    });
  }

  async #currentSnapshot(input: {
    readonly scope: OrganizerAudienceScope;
    readonly ownerKey: string;
    readonly identity: ReturnType<typeof organizerMessagePreviewIdentitySchema.parse>;
  }): Promise<OrganizerPreparedMessageBatchPreview | 'not_found' | 'stale'> {
    const row = this.#previewRow(input.scope, input.ownerKey, input.identity);
    if (row === undefined) {
      return this.#previewAudienceExists(
        input.scope, input.ownerKey, input.identity.audienceSpecId
      ) ? 'stale' : 'not_found';
    }
    const expected = this.#openPreview(row);
    const binding = this.options.drafts.readCurrent({
      scope: input.scope,
      ownerKey: input.ownerKey,
      draftId: input.identity.draftId,
      expectedVersion: input.identity.draftVersion
    });
    if (binding === undefined) return 'stale';
    if (this.#currentGuard({ scope: input.scope, ownerKey: input.ownerKey, binding })
        !== row.guard_digest_sha256) return 'stale';
    const current = await isOrganizerMessageBatchPreviewCurrent({
      expected,
      current: {
        scope: input.scope,
        draft: binding.draft,
        previewGeneration: input.identity.previewGeneration,
        digestProfile: {
          key: input.identity.previewDigestProfile,
          version: input.identity.previewDigestVersion
        },
        renderer: binding.renderer,
        mergeRegistry: binding.mergeRegistry,
        asOf: row.created_at,
        source: this,
        addressPolicy: this,
        opaqueTokens: this.options.opaqueTokens,
        render: this.options.render
      }
    });
    return current ? expected : 'stale';
  }

  async getMessageBatchPreview(
    rawScope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    rawInput: unknown
  ): Promise<OrganizerCommunicationCanonicalResult> {
    const selected = scope(rawScope);
    const ownerKey = owner(authorityPrincipalKey);
    let identity: ReturnType<typeof organizerMessagePreviewIdentitySchema.parse>;
    try {
      identity = this.#identityFromGet(rawInput);
    } catch {
      return outcome('policy_violation', 'communication.preview_invalid');
    }
    const snapshot = await this.#currentSnapshot({ scope: selected, ownerKey, identity });
    if (snapshot === 'not_found') return outcome('conflict', 'communication.not_found');
    if (snapshot === 'stale') return outcome('stale_revision', 'communication.revision_changed');
    try {
      return Object.freeze({
        kind: 'success',
        data: getOrganizerMessageBatchPreview({ snapshot, query: rawInput })
      });
    } catch (error) {
      if (error instanceof OrganizerAudiencePreviewError) {
        if (error.code === 'stale_preview') {
          return outcome('stale_revision', 'communication.revision_changed');
        }
        if (error.code === 'recipient_not_available') {
          return outcome('conflict', 'communication.not_found');
        }
        return outcome('policy_violation', 'communication.preview_invalid');
      }
      throw error;
    }
  }

  async listMessagePreviewRecipients(
    rawScope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    rawInput: unknown,
    disclosure: OrganizerPreviewContactDisclosure
  ): Promise<OrganizerCommunicationCanonicalResult> {
    const selected = scope(rawScope);
    const ownerKey = owner(authorityPrincipalKey);
    let identity: ReturnType<typeof organizerMessagePreviewIdentitySchema.parse>;
    try {
      identity = this.#identityFromList(rawInput);
    } catch {
      return outcome('policy_violation', 'communication.preview_invalid');
    }
    const snapshot = await this.#currentSnapshot({ scope: selected, ownerKey, identity });
    if (snapshot === 'not_found') return outcome('conflict', 'communication.not_found');
    if (snapshot === 'stale') return outcome('stale_revision', 'communication.revision_changed');
    try {
      return Object.freeze({
        kind: 'success',
        data: listOrganizerMessagePreviewRecipients({
          snapshot,
          query: rawInput,
          disclosure,
          opaqueTokens: this.options.opaqueTokens
        })
      });
    } catch (error) {
      if (error instanceof OrganizerAudiencePreviewError) {
        if (error.code === 'stale_preview') {
          return outcome('stale_revision', 'communication.revision_changed');
        }
        return outcome('policy_violation', 'communication.preview_invalid');
      }
      throw error;
    }
  }
}
