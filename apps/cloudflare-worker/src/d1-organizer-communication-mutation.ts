import {
  effectOperationIdentityMatchesContext,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  adoptSynchronousClassifiedPayload,
  openSynchronousClassifiedPayloadAdoptionReceipt,
  SynchronousClassifiedPayloadStoreError
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION,
  organizerCommunicationMutationContributionSchema,
  organizerCommunicationMutationDomainContributionSchema,
  sealOrganizerCommunicationMutationPreparation
} from '@jooevents/communication-operations';
import {
  OrganizerMessageDraftError,
  createOrganizerMessageDraft,
  discardOrganizerMessageDraft,
  OrganizerAuthoringPayloadError,
  canonicalizeOrganizerAuthoringPayload,
  createOrganizerAuthoringPayloadRef,
  reviseOrganizerMessageDraft,
  type OrganizerAuthoringPayloadKind,
  type OrganizerMessageDraftRecord
} from '@jooevents/communications';
import {
  ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID,
  ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
  organizerCommunicationAudienceDraftSchema,
  organizerCommunicationAuthoringPayloadInputSchema,
  organizerCommunicationAuthoringPayloadOperationResultSchema,
  organizerCommunicationDraftMutationOperationResultSchema,
  organizerCommunicationDraftMutationResultSchema,
  organizerCommunicationDraftProvenanceSchema,
  organizerCreateCommunicationDraftInputSchema,
  organizerDiscardCommunicationDraftInputSchema,
  organizerEmailMessageContentSchema,
  organizerMessageAudiencePayloadRefSchema,
  organizerMessageContentPayloadRefSchema,
  organizerReviseCommunicationDraftInputSchema,
  organizerStoreAuthoringPayloadInputSchema,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  createPayloadRef,
  parseEventId,
  parseInstant,
  parsePayloadRefId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  communicationAuthoringClassifiedPayloadPurpose,
  createCommunicationAuthoringClassifiedPayloadBinding
} from '@jooevents/persistence/communication-authoring-classified-payload';
import type { ImmutableClassifiedPayloadRecordCodecOptions } from
  '@jooevents/application/immutable-classified-payload-record';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import {
  D1BufferedClassifiedPayloadStore,
  readD1ClassifiedPayloadRecords
} from './d1-classified-payload-store';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

const OPERATION_NAME = 'store_communication_authoring_payload';
const CAPABILITY =
  ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION[OPERATION_NAME];
const MAXIMUM_PRELOADED_AUTHORING_PAYLOADS = 1_000;
const MAXIMUM_PRELOADED_AUTHORING_BYTES = 16 * 1_048_576;
const MAXIMUM_PRELOADED_DRAFT_PAYLOAD_REFS = 2_000;

interface EventSetRow {
  readonly version: number;
  readonly current_event_id: string | null;
}

interface MetadataRow {
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

interface PreparedPayload {
  readonly context: EffectInvocationContext;
  readonly contribution: Extract<
    ReturnType<typeof organizerCommunicationMutationContributionSchema.parse>,
    { readonly result: { readonly kind: 'success' } }
  >;
  readonly domainCanonical: string;
  readonly resultDataCanonical: string;
  readonly timelineId: string;
  phase: 'prepared' | 'applied' | 'evidence_complete';
}

interface PreparedDraftCreate {
  readonly context: EffectInvocationContext;
  readonly contribution: Extract<
    ReturnType<typeof organizerCommunicationMutationContributionSchema.parse>,
    { readonly result: { readonly kind: 'success' } }
  >;
  readonly domainCanonical: string;
  readonly resultDataCanonical: string;
  readonly timelineId: string;
  phase: 'prepared' | 'applied' | 'evidence_complete';
}

interface PreparedDraftEdit extends PreparedDraftCreate {
  readonly operationName: 'revise_message_batch' | 'discard_message_draft';
}

interface PurposeRow {
  readonly purpose_id: string;
  readonly purpose_key: string;
  readonly lifecycle: string;
  readonly current_revision_id: string;
  readonly revision_id: string;
  readonly revision_number: number;
  readonly digest_sha256: string;
}

interface TemplateRow {
  readonly template_id: string;
  readonly lifecycle: string;
  readonly current_revision_id: string;
  readonly purpose_revision_id: string;
  readonly template_revision_id: string;
  readonly revision_number: number;
  readonly digest_sha256: string;
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

interface PurposeRevisionRow {
  readonly purpose_id: string;
  readonly purpose_key: string;
  readonly revision_id: string;
  readonly revision_number: number;
  readonly digest_sha256: string;
}

interface TemplateRevisionRow {
  readonly template_id: string;
  readonly template_revision_id: string;
  readonly revision_number: number;
  readonly digest_sha256: string;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  if (eventId === undefined) {
    return context.scope.subjects.length === 1
      && context.scope.subjects[0]?.kind === 'workspace'
      && context.scope.subjects[0].id === context.scope.workspaceId;
  }
  return context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId);
}

function isPermissionGrant(grant: { readonly kind: string; readonly key: string }): boolean {
  return grant.kind === 'permission' && grant.key === 'communication.draft';
}

function outcome(
  outcomeClass: 'conflict' | 'stale_revision' | 'policy_violation' | 'quota_exceeded'
    | 'idempotency_conflict',
  kind: string
) {
  return organizerCommunicationMutationContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: outcomeClass,
        kind,
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: []
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deterministicMutationId(
  context: EffectInvocationContext,
  operationName: string
): Promise<string | undefined> {
  const idempotency = context.requestBinding.idempotency;
  if (idempotency === undefined) return undefined;
  const material = canonicalJsonText({
    authorityPrincipalKey: context.authorityPrincipalKey,
    idempotencyVerifierProfile: idempotency.verifierProfile,
    idempotencyVerifierSha256: idempotency.verifierSha256,
    scopePartitionKey: context.requestBinding.scopePartitionKey
  });
  const hex = await sha256Hex(new TextEncoder().encode(canonicalJsonText({
    material,
    namespace: `communication.${operationName}`
  })));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function metadataMatches(input: {
  readonly row: MetadataRow;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly ownerKey: string;
  readonly canonical: ReturnType<typeof canonicalizeOrganizerAuthoringPayload>;
}): boolean {
  const profile = input.canonical.profile;
  return input.row.workspace_id === input.workspaceId
    && input.row.event_id === input.eventId
    && input.row.owner_key === input.ownerKey
    && input.row.payload_kind === profile.payloadKind
    && input.row.payload_schema_key === profile.schemaKey
    && input.row.payload_schema_version === profile.schemaVersion
    && input.row.classification_key === profile.classification
    && input.row.content_type === profile.contentType
    && input.row.digest_sha256 === input.canonical.digestSha256
    && input.row.byte_size === input.canonical.bytes.byteLength;
}

function guardMetadata(unitOfWork: D1BufferedUnitOfWork, row: MetadataRow): void {
  unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM communication_authoring_payloads
    WHERE payload_ref_id=? AND workspace_id=? AND event_id=? AND owner_key=?
      AND payload_kind=? AND payload_schema_key=? AND payload_schema_version=?
      AND classification_key=? AND content_type=? AND digest_sha256=?
      AND byte_size=? AND created_at=?)`, [
    row.payload_ref_id, row.workspace_id, row.event_id, row.owner_key, row.payload_kind,
    row.payload_schema_key, row.payload_schema_version, row.classification_key,
    row.content_type, row.digest_sha256, row.byte_size, row.created_at
  ]);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

class D1OrganizerCommunicationPayloadEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedPayload | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
    readonly ids: { newTimelineId(): string };
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (!sameRef(capability, CAPABILITY)
        || context.operation.name !== OPERATION_NAME
        || context.operation.version !== 1
        || context.operation.effect !== 'draft'
        || (context.surface !== 'operator_http' && context.surface !== 'app_model')
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_organizer_communication_payload_binding_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (!sameRef(authority.lane.policy, ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY)
        || !authority.grants.some(isPermissionGrant)) {
      throw new TypeError('d1_organizer_communication_payload_authority_mismatch');
    }
    if (context.surface === 'operator_http') {
      if (context.provenance.kind !== 'operator'
          || authority.lane.kind !== 'operator'
          || authority.lane.surface !== 'operator_http'
          || authority.actor.kind !== 'workspace_user'
          || authority.principal.kind !== 'workspace_user'
          || context.actor.kind !== 'workspace_user'
          || authority.actor.userId !== authority.principal.userId
          || authority.actor.userId !== context.actor.userId) {
        throw new TypeError('d1_organizer_communication_payload_authority_mismatch');
      }
    } else if (context.provenance.kind !== 'app_model'
        || authority.lane.kind !== 'app_model'
        || authority.lane.surface !== 'app_model'
        || authority.actor.kind !== 'app_model_run'
        || context.actor.kind !== 'app_model_run'
        || authority.actor.agentRunId !== context.actor.agentRunId
        || authority.actor.delegatedByPrincipalId !== context.actor.delegatedByPrincipalId
        || authority.actor.agentRunId !== context.provenance.agentRunId
        || (authority.principal.kind !== 'workspace_user'
          && authority.principal.kind !== 'service')) {
      throw new TypeError('d1_organizer_communication_payload_authority_mismatch');
    }

    const eventSet = await this.input.unitOfWork.readSession.prepare(
      `SELECT version,current_event_id FROM event_spine_workspace_sets WHERE workspace_id=?`
    ).bind(this.#workspaceId).first<EventSetRow>();
    if (!eventSet || eventSet.current_event_id !== (context.scope.eventId ?? null)) {
      throw new TypeError('d1_organizer_communication_payload_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id=? AND version=? AND current_event_id IS ?)`, [
      this.#workspaceId, eventSet.version, context.scope.eventId ?? null
    ]);

    if (context.scope.eventId === undefined) {
      return sealOrganizerCommunicationMutationPreparation({
        capability,
        context,
        operationName: OPERATION_NAME,
        preparation: {
          prepare: ({ operationName, context: receivedContext }) => {
            if (operationName !== OPERATION_NAME || receivedContext !== context) {
              throw new TypeError('d1_organizer_communication_payload_context_substitution');
            }
            return outcome('conflict', 'communication.event_required');
          }
        }
      });
    }
    const eventId = parseEventId(context.scope.eventId);

    const payloadRefId = await deterministicMutationId(context, OPERATION_NAME);
    const metadataRows = payloadRefId === undefined ? [] : (await this.input.unitOfWork.readSession
      .prepare(`SELECT payload_ref_id,workspace_id,event_id,owner_key,payload_kind,
        payload_schema_key,payload_schema_version,classification_key,content_type,
        digest_sha256,byte_size,created_at FROM communication_authoring_payloads
        WHERE payload_ref_id=? LIMIT 2`)
      .bind(payloadRefId).all<MetadataRow>()).results;
    if (metadataRows.length > 1) {
      throw new TypeError('d1_organizer_communication_payload_metadata_corrupt');
    }
    const preloadedRecords = payloadRefId === undefined
      ? []
      : await readD1ClassifiedPayloadRecords(
          this.input.unitOfWork.readSession,
          [parsePayloadRefId(payloadRefId)]
        );
    if (preloadedRecords.length > 1) {
      throw new TypeError('d1_organizer_communication_payload_ciphertext_corrupt');
    }
    const store = new D1BufferedClassifiedPayloadStore({
      ...this.input.classifiedPayload,
      unitOfWork: this.input.unitOfWork,
      preloadedRecords
    });
    const timelineId = this.input.ids.newTimelineId();
    parsePayloadRefId(timelineId);
    this.#prepared = undefined;

    return sealOrganizerCommunicationMutationPreparation({
      capability,
      context,
      operationName: OPERATION_NAME,
      preparation: {
        prepare: ({ operationName, businessInput, context: receivedContext }) => {
          if (operationName !== OPERATION_NAME || receivedContext !== context
              || this.#prepared !== undefined) {
            throw new TypeError('d1_organizer_communication_payload_context_substitution');
          }
          if (payloadRefId === undefined) {
            return outcome('policy_violation', 'communication.authoring_invalid');
          }
          const request = organizerStoreAuthoringPayloadInputSchema.safeParse(businessInput);
          if (!request.success) {
            return outcome('policy_violation', 'communication.authoring_invalid');
          }
          let canonical: ReturnType<typeof canonicalizeOrganizerAuthoringPayload>;
          try {
            canonical = canonicalizeOrganizerAuthoringPayload(request.data.payload);
          } catch (error) {
            if (error instanceof OrganizerAuthoringPayloadError) {
              return error.code === 'payload_too_large'
                ? outcome('quota_exceeded', 'communication.authoring_quota')
                : outcome('policy_violation', 'communication.authoring_invalid');
            }
            throw error;
          }
          try {
            const metadata = metadataRows[0];
            if (metadata !== undefined) {
              parseInstant(metadata.created_at);
              if (preloadedRecords.length !== 1) {
                throw new TypeError('d1_organizer_communication_payload_ciphertext_missing');
              }
              if (!metadataMatches({
                row: metadata,
                workspaceId: this.#workspaceId,
                eventId,
                ownerKey: context.authorityPrincipalKey,
                canonical
              })) {
                return outcome('idempotency_conflict', 'operation.request_changed');
              }
              guardMetadata(this.input.unitOfWork, metadata);
              let existingBytes: Uint8Array | undefined;
              try {
                existingBytes = store.read({
                  payloadRef: createPayloadRef(parsePayloadRefId(payloadRefId)),
                  expectedBinding: createCommunicationAuthoringClassifiedPayloadBinding({
                    scope: { workspaceId: this.#workspaceId, eventId },
                    ownerKey: context.authorityPrincipalKey,
                    kind: canonical.profile.payloadKind
                  }),
                  purpose: communicationAuthoringClassifiedPayloadPurpose(
                    canonical.profile.payloadKind
                  )
                });
                const text = new TextDecoder('utf-8', { fatal: true }).decode(existingBytes);
                const envelope = organizerCommunicationAuthoringPayloadInputSchema.parse(
                  JSON.parse(text)
                );
                if (!bytesEqual(existingBytes, canonical.bytes)
                    || canonicalJsonText(envelope) !== text) {
                  return outcome('idempotency_conflict', 'operation.request_changed');
                }
              } finally {
                existingBytes?.fill(0);
              }
            } else {
              this.input.unitOfWork.assertCurrent(`NOT EXISTS (
                SELECT 1 FROM communication_authoring_payloads WHERE payload_ref_id=?)`, [
                payloadRefId
              ]);
              try {
                const receipt = adoptSynchronousClassifiedPayload({
                  store,
                  put: {
                    payloadRefId: parsePayloadRefId(payloadRefId),
                    binding: createCommunicationAuthoringClassifiedPayloadBinding({
                      scope: { workspaceId: this.#workspaceId, eventId },
                      ownerKey: context.authorityPrincipalKey,
                      kind: canonical.profile.payloadKind
                    }),
                    purpose: communicationAuthoringClassifiedPayloadPurpose(
                      canonical.profile.payloadKind
                    ),
                    bytes: canonical.bytes,
                    createdAt: parseInstant(context.receivedAt)
                  }
                });
                const adopted = openSynchronousClassifiedPayloadAdoptionReceipt({
                  receipt,
                  expectedStore: store
                });
                if (adopted.payloadRef.id !== payloadRefId) {
                  throw new TypeError('d1_organizer_communication_payload_adoption_mismatch');
                }
              } catch (error) {
                if (error instanceof SynchronousClassifiedPayloadStoreError
                    && error.code === 'payload_ref_collision') {
                  return outcome('idempotency_conflict', 'operation.request_changed');
                }
                throw error;
              }
              this.input.unitOfWork.write(`INSERT INTO communication_authoring_payloads (
                payload_ref_id,workspace_id,event_id,owner_key,payload_kind,payload_schema_key,
                payload_schema_version,classification_key,content_type,digest_sha256,byte_size,
                created_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
                payloadRefId,
                this.#workspaceId,
                eventId,
                context.authorityPrincipalKey,
                canonical.profile.payloadKind,
                canonical.profile.schemaKey,
                canonical.profile.schemaVersion,
                canonical.profile.classification,
                canonical.profile.contentType,
                canonical.digestSha256,
                canonical.bytes.byteLength,
                parseInstant(context.receivedAt)
              ]);
            }
            const data = createOrganizerAuthoringPayloadRef({
              payloadRefId: parsePayloadRefId(payloadRefId),
              canonical
            });
            const contribution = organizerCommunicationMutationContributionSchema.parse({
              result: { kind: 'success', data },
              domain: {
                kind: 'organizer_communication_authoring',
                operationName: OPERATION_NAME,
                workspaceId: this.#workspaceId,
                eventId,
                entityId: payloadRefId,
                entityVersion: 1,
                occurredAt: parseInstant(context.receivedAt)
              },
              effectContributions: []
            });
            if (contribution.result.kind !== 'success' || contribution.domain === null) {
              throw new TypeError('d1_organizer_communication_payload_evidence_missing');
            }
            this.#prepared = {
              context,
              contribution,
              domainCanonical: canonicalJsonText(contribution.domain),
              resultDataCanonical: canonicalJsonText(contribution.result.data),
              timelineId,
              phase: 'prepared'
            };
            return contribution;
          } finally {
            canonical.bytes.fill(0);
          }
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const parsed = organizerCommunicationMutationDomainContributionSchema.parse(contribution);
    if (!this.#prepared || this.#prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== this.#prepared.domainCanonical) {
      throw new TypeError('d1_organizer_communication_payload_preparation_invalid');
    }
    this.#prepared.phase = 'applied';
  }

  afterOperationLogInserted(receipt: TerminalEffectReceipt): void {
    const prepared = this.#prepared;
    const result = organizerCommunicationAuthoringPayloadOperationResultSchema.safeParse(
      receipt.result
    );
    if (!prepared || prepared.phase !== 'applied' || !result.success
        || result.data.kind !== 'success'
        || !effectOperationIdentityMatchesContext(receipt.identity, prepared.context)
        || receipt.requestHash !== prepared.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== OPERATION_NAME || receipt.ref.operationVersion !== 1
        || result.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(result.data.data) !== prepared.resultDataCanonical) {
      throw new TypeError('d1_organizer_communication_payload_receipt_mismatch');
    }
    const domain = prepared.contribution.domain;
    this.input.unitOfWork.write(`INSERT INTO organizer_communication_authoring_receipt_links (
      receipt_id,workspace_id,event_id,authority_principal_key,operation_name,
      operation_version,payload_ref_id,draft_id,entity_version,request_hash,occurred_at_ms
    ) VALUES (?,?,?,?,?,1,?,NULL,1,?,?)`, [
      receipt.ref.id,
      domain.workspaceId,
      domain.eventId,
      prepared.context.authorityPrincipalKey,
      OPERATION_NAME,
      domain.entityId,
      receipt.requestHash,
      Date.parse(parseInstant(domain.occurredAt))
    ]);
    this.input.unitOfWork.write(`INSERT INTO organizer_communication_authoring_timeline (
      timeline_id,receipt_id,occurred_at_ms,source_kind
    ) VALUES (?,?,?,'operation_receipt')`, [
      prepared.timelineId,
      receipt.ref.id,
      Date.parse(parseInstant(domain.occurredAt))
    ]);
    prepared.phase = 'evidence_complete';
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared = undefined;
  }
}

class D1OrganizerCommunicationDraftCreateEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedDraftCreate | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
    readonly ids: { newTimelineId(): string };
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    const operationName = 'create_message_draft' as const;
    const expectedCapability =
      ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION[operationName];
    if (!sameRef(capability, expectedCapability)
        || context.operation.name !== operationName
        || context.operation.version !== 1
        || context.operation.effect !== 'draft'
        || (context.surface !== 'operator_http' && context.surface !== 'app_model')
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_organizer_communication_draft_create_binding_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (!sameRef(authority.lane.policy, ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY)
        || !authority.grants.some(isPermissionGrant)) {
      throw new TypeError('d1_organizer_communication_draft_create_authority_mismatch');
    }
    if (context.surface === 'operator_http') {
      if (context.provenance.kind !== 'operator'
          || authority.lane.kind !== 'operator'
          || authority.lane.surface !== 'operator_http'
          || authority.actor.kind !== 'workspace_user'
          || authority.principal.kind !== 'workspace_user'
          || context.actor.kind !== 'workspace_user'
          || authority.actor.userId !== authority.principal.userId
          || authority.actor.userId !== context.actor.userId) {
        throw new TypeError('d1_organizer_communication_draft_create_authority_mismatch');
      }
    } else if (context.provenance.kind !== 'app_model'
        || authority.lane.kind !== 'app_model'
        || authority.lane.surface !== 'app_model'
        || authority.actor.kind !== 'app_model_run'
        || context.actor.kind !== 'app_model_run'
        || authority.actor.agentRunId !== context.actor.agentRunId
        || authority.actor.delegatedByPrincipalId !== context.actor.delegatedByPrincipalId
        || authority.actor.agentRunId !== context.provenance.agentRunId
        || (authority.principal.kind !== 'workspace_user'
          && authority.principal.kind !== 'service')) {
      throw new TypeError('d1_organizer_communication_draft_create_authority_mismatch');
    }

    const eventSet = await this.input.unitOfWork.readSession.prepare(
      `SELECT version,current_event_id FROM event_spine_workspace_sets WHERE workspace_id=?`
    ).bind(this.#workspaceId).first<EventSetRow>();
    if (!eventSet || eventSet.current_event_id !== (context.scope.eventId ?? null)) {
      throw new TypeError('d1_organizer_communication_draft_create_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id=? AND version=? AND current_event_id IS ?)`, [
      this.#workspaceId, eventSet.version, context.scope.eventId ?? null
    ]);
    if (context.scope.eventId === undefined) {
      return sealOrganizerCommunicationMutationPreparation({
        capability,
        context,
        operationName,
        preparation: {
          prepare: ({ operationName: receivedOperation, context: receivedContext }) => {
            if (receivedOperation !== operationName || receivedContext !== context) {
              throw new TypeError('d1_organizer_communication_draft_create_context_substitution');
            }
            return outcome('conflict', 'communication.event_required');
          }
        }
      });
    }
    const eventId = parseEventId(context.scope.eventId);
    const draftId = await deterministicMutationId(context, operationName);
    const existingDraft = draftId === undefined ? undefined : (await this.input.unitOfWork.readSession
      .prepare(`SELECT draft_id FROM communication_drafts
        WHERE workspace_id=? AND event_id=? AND draft_id=? LIMIT 1`)
      .bind(this.#workspaceId, eventId, draftId).first<{ readonly draft_id: string }>()) ?? undefined;
    const purposes = (await this.input.unitOfWork.readSession.prepare(`SELECT
      p.purpose_id,p.purpose_key,p.lifecycle,p.current_revision_id,
      r.revision_id,r.revision_number,r.digest_sha256
      FROM communication_purposes p JOIN communication_purpose_revisions r
        ON r.workspace_id=p.workspace_id AND r.event_id=p.event_id
       AND r.revision_id=p.current_revision_id
      WHERE p.workspace_id=? AND p.event_id=? LIMIT 1001`
    ).bind(this.#workspaceId, eventId).all<PurposeRow>()).results;
    const templates = (await this.input.unitOfWork.readSession.prepare(`SELECT
      t.template_id,t.lifecycle,t.current_revision_id,t.purpose_revision_id,
      r.template_revision_id,r.revision_number,r.digest_sha256
      FROM message_templates t JOIN message_template_revisions r
        ON r.workspace_id=t.workspace_id AND r.event_id=t.event_id
       AND r.template_revision_id=t.current_revision_id
      WHERE t.workspace_id=? AND t.event_id=? LIMIT 1001`
    ).bind(this.#workspaceId, eventId).all<TemplateRow>()).results;
    if (purposes.length > 1000 || templates.length > 1000) {
      throw new TypeError('d1_organizer_communication_draft_catalog_unbounded');
    }
    const metadata = (await this.input.unitOfWork.readSession.prepare(`SELECT
      payload_ref_id,workspace_id,event_id,owner_key,payload_kind,payload_schema_key,
      payload_schema_version,classification_key,content_type,digest_sha256,byte_size,created_at
      FROM communication_authoring_payloads
      WHERE workspace_id=? AND event_id=? AND owner_key=? LIMIT 1001`
    ).bind(this.#workspaceId, eventId, context.authorityPrincipalKey)
      .all<MetadataRow>()).results;
    const payloadsBounded = metadata.length <= MAXIMUM_PRELOADED_AUTHORING_PAYLOADS
      && metadata.reduce((total, row) => total + row.byte_size, 0)
        <= MAXIMUM_PRELOADED_AUTHORING_BYTES;
    const records = payloadsBounded
      ? await readD1ClassifiedPayloadRecords(
          this.input.unitOfWork.readSession,
          metadata.map((row) => parsePayloadRefId(row.payload_ref_id))
        )
      : [];
    if (payloadsBounded && records.length !== metadata.length) {
      throw new TypeError('d1_organizer_communication_draft_payload_corrupt');
    }
    const metadataById = new Map<string, MetadataRow>();
    for (const row of metadata) {
      if (metadataById.has(row.payload_ref_id)) {
        throw new TypeError('d1_organizer_communication_draft_payload_corrupt');
      }
      metadataById.set(row.payload_ref_id, row);
    }
    const store = new D1BufferedClassifiedPayloadStore({
      ...this.input.classifiedPayload,
      unitOfWork: this.input.unitOfWork,
      preloadedRecords: records
    });
    const timelineId = this.input.ids.newTimelineId();
    parsePayloadRefId(timelineId);
    this.#prepared = undefined;

    const openPayload = (payloadRefId: string, kind: OrganizerAuthoringPayloadKind) => {
      const row = metadataById.get(payloadRefId);
      if (!row || row.workspace_id !== this.#workspaceId || row.event_id !== eventId
          || row.owner_key !== context.authorityPrincipalKey || row.payload_kind !== kind) {
        return undefined;
      }
      const profile = {
        payloadKind: row.payload_kind,
        schemaKey: row.payload_schema_key,
        schemaVersion: row.payload_schema_version,
        classification: row.classification_key,
        contentType: row.content_type
      };
      parseInstant(row.created_at);
      let bytes: Uint8Array | undefined;
      let canonical: ReturnType<typeof canonicalizeOrganizerAuthoringPayload> | undefined;
      try {
        bytes = store.read({
          payloadRef: createPayloadRef(parsePayloadRefId(payloadRefId)),
          expectedBinding: createCommunicationAuthoringClassifiedPayloadBinding({
            scope: { workspaceId: this.#workspaceId, eventId },
            ownerKey: context.authorityPrincipalKey,
            kind
          }),
          purpose: communicationAuthoringClassifiedPayloadPurpose(kind)
        });
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const envelope = organizerCommunicationAuthoringPayloadInputSchema.parse(JSON.parse(text));
        canonical = canonicalizeOrganizerAuthoringPayload(envelope);
        if (envelope.payloadKind !== kind || canonicalJsonText(envelope) !== text
            || !bytesEqual(bytes, canonical.bytes)
            || canonical.digestSha256 !== row.digest_sha256
            || canonical.bytes.byteLength !== row.byte_size
            || canonical.profile.payloadKind !== profile.payloadKind
            || canonical.profile.schemaKey !== profile.schemaKey
            || canonical.profile.schemaVersion !== profile.schemaVersion
            || canonical.profile.classification !== profile.classification
            || canonical.profile.contentType !== profile.contentType) {
          throw new TypeError('d1_organizer_communication_draft_payload_corrupt');
        }
        guardMetadata(this.input.unitOfWork, row);
        return Object.freeze({
          envelope,
          ref: createOrganizerAuthoringPayloadRef({
            payloadRefId: parsePayloadRefId(payloadRefId),
            canonical
          })
        });
      } finally {
        bytes?.fill(0);
        canonical?.bytes.fill(0);
      }
    };

    return sealOrganizerCommunicationMutationPreparation({
      capability,
      context,
      operationName,
      preparation: {
        prepare: ({ operationName: receivedOperation, businessInput, context: receivedContext }) => {
          if (receivedOperation !== operationName || receivedContext !== context
              || this.#prepared !== undefined) {
            throw new TypeError('d1_organizer_communication_draft_create_context_substitution');
          }
          if (draftId === undefined) {
            return outcome('policy_violation', 'communication.authoring_invalid');
          }
          const request = organizerCreateCommunicationDraftInputSchema.safeParse(businessInput);
          if (!request.success) return outcome('policy_violation', 'communication.authoring_invalid');
          if (existingDraft !== undefined) {
            return outcome('idempotency_conflict', 'operation.request_changed');
          }
          const purpose = purposes.find((row) =>
            row.revision_id === request.data.purposeRevision.revisionId);
          if (!purpose || purpose.lifecycle !== 'active'
              || purpose.current_revision_id !== request.data.purposeRevision.revisionId
              || purpose.purpose_id !== request.data.purposeRevision.purposeId
              || purpose.purpose_key !== request.data.purposeRevision.purposeKey
              || purpose.revision_number !== request.data.purposeRevision.revisionNumber
              || purpose.digest_sha256 !== request.data.purposeRevision.digestSha256) {
            return outcome('policy_violation', 'communication.authoring_invalid');
          }
          this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1
            FROM communication_purposes p JOIN communication_purpose_revisions r
              ON r.workspace_id=p.workspace_id AND r.event_id=p.event_id
             AND r.revision_id=p.current_revision_id
            WHERE p.workspace_id=? AND p.event_id=? AND p.purpose_id=?
              AND p.purpose_key=? AND p.lifecycle='active' AND p.current_revision_id=?
              AND r.revision_number=? AND r.digest_sha256=?)`, [
            this.#workspaceId, eventId, purpose.purpose_id, purpose.purpose_key,
            purpose.revision_id, purpose.revision_number, purpose.digest_sha256
          ]);
          if (request.data.templateRevision !== undefined) {
            const template = templates.find((row) =>
              row.template_revision_id === request.data.templateRevision?.templateRevisionId);
            if (!template || template.lifecycle !== 'active'
                || template.current_revision_id !== template.template_revision_id
                || template.purpose_revision_id !== purpose.revision_id
                || template.template_id !== request.data.templateRevision.templateId
                || template.revision_number !== request.data.templateRevision.revisionNumber
                || template.digest_sha256 !== request.data.templateRevision.digestSha256) {
              return outcome('policy_violation', 'communication.authoring_invalid');
            }
            this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1
              FROM message_templates t JOIN message_template_revisions r
                ON r.workspace_id=t.workspace_id AND r.event_id=t.event_id
               AND r.template_revision_id=t.current_revision_id
              WHERE t.workspace_id=? AND t.event_id=? AND t.template_id=?
                AND t.lifecycle='active' AND t.current_revision_id=?
                AND t.purpose_revision_id=? AND r.revision_number=? AND r.digest_sha256=?)`, [
              this.#workspaceId, eventId, template.template_id, template.template_revision_id,
              template.purpose_revision_id, template.revision_number, template.digest_sha256
            ]);
          }
          let subject: string | undefined;
          let contentRef: ReturnType<typeof createOrganizerAuthoringPayloadRef> | undefined;
          let audienceRef: ReturnType<typeof createOrganizerAuthoringPayloadRef> | undefined;
          if (request.data.initial.kind === 'adopted_payload_refs') {
            if (!payloadsBounded) return outcome('quota_exceeded', 'communication.authoring_quota');
            const content = openPayload(
              request.data.initial.contentPayload.payloadRefId,
              'message_content'
            );
            const audience = openPayload(
              request.data.initial.audiencePayload.payloadRefId,
              'message_audience_draft'
            );
            if (!content || !audience
                || canonicalJsonText(content.ref)
                  !== canonicalJsonText(request.data.initial.contentPayload)
                || canonicalJsonText(audience.ref)
                  !== canonicalJsonText(request.data.initial.audiencePayload)) {
              return outcome('policy_violation', 'communication.authoring_invalid');
            }
            const message = organizerEmailMessageContentSchema.safeParse(content.envelope.value);
            const audienceDraft = organizerCommunicationAudienceDraftSchema.safeParse(
              audience.envelope.value
            );
            if (!message.success || !audienceDraft.success
                || audienceDraft.data.purposeRevision.revisionId !== purpose.revision_id) {
              return outcome('policy_violation', 'communication.authoring_invalid');
            }
            subject = message.data.subject;
            contentRef = content.ref;
            audienceRef = audience.ref;
          }
          let draft: ReturnType<typeof createOrganizerMessageDraft>;
          try {
            draft = createOrganizerMessageDraft({
              workspaceId: this.#workspaceId,
              eventId,
              ownerKey: context.authorityPrincipalKey,
              draftId,
              businessInput: request.data,
              provenance: context.provenance.kind === 'operator' ? { kind: 'human' } : undefined,
              now: context.receivedAt
            });
          } catch {
            return outcome('policy_violation', 'communication.authoring_invalid');
          }
          this.input.unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM communication_drafts
            WHERE workspace_id=? AND event_id=? AND draft_id=?)`, [
            this.#workspaceId, eventId, draftId
          ]);
          this.input.unitOfWork.write(`INSERT INTO communication_drafts (
            workspace_id,event_id,draft_id,owner_key,version,state,channel,purpose_revision_id,
            template_revision_id,authoring_state,content_payload_ref_id,audience_payload_ref_id,
            subject,provenance_json,discard_reason_code,created_at,updated_at
          ) VALUES (?,?,?,?,1,'active','email',?,?,?,?,?,?,?,NULL,?,?)`, [
            this.#workspaceId,
            eventId,
            draftId,
            context.authorityPrincipalKey,
            purpose.revision_id,
            request.data.templateRevision?.templateRevisionId ?? null,
            draft.authoring.state,
            draft.authoring.state === 'uninitialized'
              ? draft.authoring.contentRefId
              : draft.authoring.contentPayload.payloadRefId,
            draft.authoring.state === 'uninitialized'
              ? draft.authoring.audienceRefId
              : draft.authoring.audiencePayload.payloadRefId,
            subject ?? null,
            canonicalJsonText(draft.provenance),
            draft.createdAt,
            draft.updatedAt
          ]);
          const resultData = organizerCommunicationDraftMutationResultSchema.parse({
            schemaVersion: 1,
            draftId,
            version: 1,
            state: 'active',
            authoring: draft.authoring.state === 'uninitialized'
              ? {
                  state: 'uninitialized',
                  contentRefId: draft.authoring.contentRefId,
                  audienceRefId: draft.authoring.audienceRefId
                }
              : {
                  state: 'ready',
                  subject,
                  recipientEstimate: {
                    knowledge: 'unknown', reasonCode: 'audience.not_resolved'
                  },
                  contentPayload: contentRef,
                  audiencePayload: audienceRef
                },
            nextRead: { operationName: 'get_message_draft', draftId, expectedVersion: 1 }
          });
          const contribution = organizerCommunicationMutationContributionSchema.parse({
            result: { kind: 'success', data: resultData },
            domain: {
              kind: 'organizer_communication_authoring',
              operationName,
              workspaceId: this.#workspaceId,
              eventId,
              entityId: draftId,
              entityVersion: 1,
              occurredAt: parseInstant(context.receivedAt)
            },
            effectContributions: []
          });
          if (contribution.result.kind !== 'success' || contribution.domain === null) {
            throw new TypeError('d1_organizer_communication_draft_create_evidence_missing');
          }
          this.#prepared = {
            context,
            contribution,
            domainCanonical: canonicalJsonText(contribution.domain),
            resultDataCanonical: canonicalJsonText(contribution.result.data),
            timelineId,
            phase: 'prepared'
          };
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const parsed = organizerCommunicationMutationDomainContributionSchema.parse(contribution);
    if (!this.#prepared || this.#prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== this.#prepared.domainCanonical) {
      throw new TypeError('d1_organizer_communication_draft_create_preparation_invalid');
    }
    this.#prepared.phase = 'applied';
  }

  afterOperationLogInserted(receipt: TerminalEffectReceipt): void {
    const prepared = this.#prepared;
    const result = organizerCommunicationDraftMutationOperationResultSchema.safeParse(
      receipt.result
    );
    if (!prepared || prepared.phase !== 'applied' || !result.success
        || result.data.kind !== 'success'
        || !effectOperationIdentityMatchesContext(receipt.identity, prepared.context)
        || receipt.requestHash !== prepared.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== 'create_message_draft'
        || receipt.ref.operationVersion !== 1
        || result.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(result.data.data) !== prepared.resultDataCanonical) {
      throw new TypeError('d1_organizer_communication_draft_create_receipt_mismatch');
    }
    const domain = prepared.contribution.domain;
    this.input.unitOfWork.write(`INSERT INTO organizer_communication_authoring_receipt_links (
      receipt_id,workspace_id,event_id,authority_principal_key,operation_name,
      operation_version,payload_ref_id,draft_id,entity_version,request_hash,occurred_at_ms
    ) VALUES (?,?,?,?,?,1,NULL,?,1,?,?)`, [
      receipt.ref.id,
      domain.workspaceId,
      domain.eventId,
      prepared.context.authorityPrincipalKey,
      'create_message_draft',
      domain.entityId,
      receipt.requestHash,
      Date.parse(parseInstant(domain.occurredAt))
    ]);
    this.input.unitOfWork.write(`INSERT INTO organizer_communication_authoring_timeline (
      timeline_id,receipt_id,occurred_at_ms,source_kind
    ) VALUES (?,?,?,'operation_receipt')`, [
      prepared.timelineId,
      receipt.ref.id,
      Date.parse(parseInstant(domain.occurredAt))
    ]);
    prepared.phase = 'evidence_complete';
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared = undefined;
  }
}

class D1OrganizerCommunicationDraftEditEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedDraftEdit | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
    readonly ids: { newTimelineId(): string };
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    const operationName = sameRef(
      capability,
      ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION.revise_message_batch
    )
      ? 'revise_message_batch' as const
      : sameRef(
          capability,
          ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION.discard_message_draft
        )
        ? 'discard_message_draft' as const
        : undefined;
    if (operationName === undefined
        || context.operation.name !== operationName
        || context.operation.version !== 1
        || context.operation.effect !== 'draft'
        || (context.surface !== 'operator_http' && context.surface !== 'app_model')
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_organizer_communication_draft_edit_binding_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (!sameRef(authority.lane.policy, ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY)
        || !authority.grants.some(isPermissionGrant)) {
      throw new TypeError('d1_organizer_communication_draft_edit_authority_mismatch');
    }
    if (context.surface === 'operator_http') {
      if (context.provenance.kind !== 'operator'
          || authority.lane.kind !== 'operator'
          || authority.lane.surface !== 'operator_http'
          || authority.actor.kind !== 'workspace_user'
          || authority.principal.kind !== 'workspace_user'
          || context.actor.kind !== 'workspace_user'
          || authority.actor.userId !== authority.principal.userId
          || authority.actor.userId !== context.actor.userId) {
        throw new TypeError('d1_organizer_communication_draft_edit_authority_mismatch');
      }
    } else if (context.provenance.kind !== 'app_model'
        || authority.lane.kind !== 'app_model'
        || authority.lane.surface !== 'app_model'
        || authority.actor.kind !== 'app_model_run'
        || context.actor.kind !== 'app_model_run'
        || authority.actor.agentRunId !== context.actor.agentRunId
        || authority.actor.delegatedByPrincipalId !== context.actor.delegatedByPrincipalId
        || authority.actor.agentRunId !== context.provenance.agentRunId
        || (authority.principal.kind !== 'workspace_user'
          && authority.principal.kind !== 'service')) {
      throw new TypeError('d1_organizer_communication_draft_edit_authority_mismatch');
    }

    const eventSet = await this.input.unitOfWork.readSession.prepare(
      `SELECT version,current_event_id FROM event_spine_workspace_sets WHERE workspace_id=?`
    ).bind(this.#workspaceId).first<EventSetRow>();
    if (!eventSet || eventSet.current_event_id !== (context.scope.eventId ?? null)) {
      throw new TypeError('d1_organizer_communication_draft_edit_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id=? AND version=? AND current_event_id IS ?)`, [
      this.#workspaceId, eventSet.version, context.scope.eventId ?? null
    ]);
    if (context.scope.eventId === undefined) {
      return sealOrganizerCommunicationMutationPreparation({
        capability,
        context,
        operationName,
        preparation: {
          prepare: ({ operationName: receivedOperation, context: receivedContext }) => {
            if (receivedOperation !== operationName || receivedContext !== context) {
              throw new TypeError('d1_organizer_communication_draft_edit_context_substitution');
            }
            return outcome('conflict', 'communication.event_required');
          }
        }
      });
    }
    const eventId = parseEventId(context.scope.eventId);
    const drafts = (await this.input.unitOfWork.readSession.prepare(`SELECT
      workspace_id,event_id,draft_id,owner_key,version,state,channel,purpose_revision_id,
      template_revision_id,authoring_state,content_payload_ref_id,audience_payload_ref_id,
      subject,provenance_json,discard_reason_code,created_at,updated_at
      FROM communication_drafts WHERE workspace_id=? AND event_id=? AND owner_key=? LIMIT 1001`
    ).bind(this.#workspaceId, eventId, context.authorityPrincipalKey).all<DraftRow>()).results;
    const purposeRevisions = (await this.input.unitOfWork.readSession.prepare(`SELECT
      purpose_id,purpose_key,revision_id,revision_number,digest_sha256
      FROM communication_purpose_revisions WHERE workspace_id=? AND event_id=? LIMIT 1001`
    ).bind(this.#workspaceId, eventId).all<PurposeRevisionRow>()).results;
    const templateRevisions = (await this.input.unitOfWork.readSession.prepare(`SELECT
      template_id,template_revision_id,revision_number,digest_sha256
      FROM message_template_revisions WHERE workspace_id=? AND event_id=? LIMIT 1001`
    ).bind(this.#workspaceId, eventId).all<TemplateRevisionRow>()).results;
    if (drafts.length > 1000 || purposeRevisions.length > 1000
        || templateRevisions.length > 1000) {
      throw new TypeError('d1_organizer_communication_draft_edit_snapshot_unbounded');
    }
    const metadata = operationName === 'revise_message_batch'
      ? (await this.input.unitOfWork.readSession.prepare(`SELECT
          payload_ref_id,workspace_id,event_id,owner_key,payload_kind,payload_schema_key,
          payload_schema_version,classification_key,content_type,digest_sha256,byte_size,
          created_at
          FROM communication_authoring_payloads
          WHERE workspace_id=? AND event_id=? AND owner_key=? LIMIT 1001`
        ).bind(this.#workspaceId, eventId, context.authorityPrincipalKey)
          .all<MetadataRow>()).results
      : (await this.input.unitOfWork.readSession.prepare(`SELECT DISTINCT
          payload.payload_ref_id,payload.workspace_id,payload.event_id,payload.owner_key,
          payload.payload_kind,payload.payload_schema_key,payload.payload_schema_version,
          payload.classification_key,payload.content_type,payload.digest_sha256,
          payload.byte_size,payload.created_at
          FROM communication_authoring_payloads payload
          INNER JOIN communication_drafts draft
            ON draft.workspace_id=payload.workspace_id
            AND draft.event_id=payload.event_id
            AND draft.owner_key=payload.owner_key
            AND (draft.content_payload_ref_id=payload.payload_ref_id
              OR draft.audience_payload_ref_id=payload.payload_ref_id)
          WHERE payload.workspace_id=? AND payload.event_id=? AND payload.owner_key=?
          LIMIT 2001`
        ).bind(this.#workspaceId, eventId, context.authorityPrincipalKey)
          .all<MetadataRow>()).results;
    const payloadsBounded = operationName === 'revise_message_batch'
      ? metadata.length <= MAXIMUM_PRELOADED_AUTHORING_PAYLOADS
        && metadata.reduce((total, row) => total + row.byte_size, 0)
          <= MAXIMUM_PRELOADED_AUTHORING_BYTES
      : metadata.length <= MAXIMUM_PRELOADED_DRAFT_PAYLOAD_REFS;
    const records = payloadsBounded && operationName === 'revise_message_batch'
      ? await readD1ClassifiedPayloadRecords(
          this.input.unitOfWork.readSession,
          metadata.map((row) => parsePayloadRefId(row.payload_ref_id))
        )
      : [];
    if (payloadsBounded && operationName === 'revise_message_batch'
        && records.length !== metadata.length) {
      throw new TypeError('d1_organizer_communication_draft_edit_payload_corrupt');
    }
    const metadataById = new Map(metadata.map((row) => [row.payload_ref_id, row]));
    if (metadataById.size !== metadata.length) {
      throw new TypeError('d1_organizer_communication_draft_edit_payload_corrupt');
    }
    const store = new D1BufferedClassifiedPayloadStore({
      ...this.input.classifiedPayload,
      unitOfWork: this.input.unitOfWork,
      preloadedRecords: records
    });
    const timelineId = this.input.ids.newTimelineId();
    parsePayloadRefId(timelineId);
    this.#prepared = undefined;

    const openPayload = (payloadRefId: string, kind: OrganizerAuthoringPayloadKind) => {
      const row = metadataById.get(payloadRefId);
      if (!row || row.workspace_id !== this.#workspaceId || row.event_id !== eventId
          || row.owner_key !== context.authorityPrincipalKey || row.payload_kind !== kind) {
        return undefined;
      }
      parseInstant(row.created_at);
      let bytes: Uint8Array | undefined;
      let canonical: ReturnType<typeof canonicalizeOrganizerAuthoringPayload> | undefined;
      try {
        bytes = store.read({
          payloadRef: createPayloadRef(parsePayloadRefId(payloadRefId)),
          expectedBinding: createCommunicationAuthoringClassifiedPayloadBinding({
            scope: { workspaceId: this.#workspaceId, eventId },
            ownerKey: context.authorityPrincipalKey,
            kind
          }),
          purpose: communicationAuthoringClassifiedPayloadPurpose(kind)
        });
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const envelope = organizerCommunicationAuthoringPayloadInputSchema.parse(JSON.parse(text));
        canonical = canonicalizeOrganizerAuthoringPayload(envelope);
        if (envelope.payloadKind !== kind || canonicalJsonText(envelope) !== text
            || !bytesEqual(bytes, canonical.bytes)
            || canonical.digestSha256 !== row.digest_sha256
            || canonical.bytes.byteLength !== row.byte_size
            || canonical.profile.payloadKind !== row.payload_kind
            || canonical.profile.schemaKey !== row.payload_schema_key
            || canonical.profile.schemaVersion !== row.payload_schema_version
            || canonical.profile.classification !== row.classification_key
            || canonical.profile.contentType !== row.content_type) {
          throw new TypeError('d1_organizer_communication_draft_edit_payload_corrupt');
        }
        guardMetadata(this.input.unitOfWork, row);
        return Object.freeze({
          envelope,
          ref: createOrganizerAuthoringPayloadRef({
            payloadRefId: parsePayloadRefId(payloadRefId),
            canonical
          })
        });
      } finally {
        bytes?.fill(0);
        canonical?.bytes.fill(0);
      }
    };

    const currentRecord = (row: DraftRow): OrganizerMessageDraftRecord => {
      if (row.workspace_id !== this.#workspaceId || row.event_id !== eventId
          || row.owner_key !== context.authorityPrincipalKey || row.channel !== 'email'
          || !Number.isSafeInteger(row.version) || row.version < 1) {
        throw new TypeError('d1_organizer_communication_draft_edit_row_corrupt');
      }
      const purpose = purposeRevisions.find((candidate) =>
        candidate.revision_id === row.purpose_revision_id);
      if (!purpose) throw new TypeError('d1_organizer_communication_draft_edit_row_corrupt');
      const template = row.template_revision_id === null ? undefined : templateRevisions.find(
        (candidate) => candidate.template_revision_id === row.template_revision_id
      );
      if (row.template_revision_id !== null && !template) {
        throw new TypeError('d1_organizer_communication_draft_edit_row_corrupt');
      }
      const provenance = organizerCommunicationDraftProvenanceSchema.parse(
        JSON.parse(row.provenance_json)
      );
      let authoring: OrganizerMessageDraftRecord['authoring'];
      if (row.authoring_state === 'uninitialized') {
        if (row.content_payload_ref_id !== ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID
            || row.audience_payload_ref_id !== ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
            || row.subject !== null || row.state === 'proposed') {
          throw new TypeError('d1_organizer_communication_draft_edit_row_corrupt');
        }
        authoring = Object.freeze({
          state: 'uninitialized' as const,
          contentRefId: ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
          audienceRefId: ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
        });
      } else {
        if (operationName === 'discard_message_draft') {
          const content = metadataById.get(row.content_payload_ref_id);
          const audience = metadataById.get(row.audience_payload_ref_id);
          if (!content || !audience || content.payload_kind !== 'message_content'
              || audience.payload_kind !== 'message_audience_draft' || row.subject === null) {
            throw new TypeError('d1_organizer_communication_draft_edit_row_corrupt');
          }
          guardMetadata(this.input.unitOfWork, content);
          guardMetadata(this.input.unitOfWork, audience);
          authoring = Object.freeze({
            state: 'ready' as const,
            contentPayload: organizerMessageContentPayloadRefSchema.parse({
              payloadRefId: content.payload_ref_id,
              payloadRefVersion: 1,
              payloadKind: content.payload_kind,
              schemaKey: content.payload_schema_key,
              schemaVersion: content.payload_schema_version,
              classification: content.classification_key
            }),
            audiencePayload: organizerMessageAudiencePayloadRefSchema.parse({
              payloadRefId: audience.payload_ref_id,
              payloadRefVersion: 1,
              payloadKind: audience.payload_kind,
              schemaKey: audience.payload_schema_key,
              schemaVersion: audience.payload_schema_version,
              classification: audience.classification_key
            })
          });
        } else {
          const content = openPayload(row.content_payload_ref_id, 'message_content');
          const audience = openPayload(row.audience_payload_ref_id, 'message_audience_draft');
          const message = content === undefined ? undefined
            : organizerEmailMessageContentSchema.safeParse(content.envelope.value);
          const audienceDraft = audience === undefined ? undefined
            : organizerCommunicationAudienceDraftSchema.safeParse(audience.envelope.value);
          if (!content || !audience || !message?.success || !audienceDraft?.success
              || message.data.subject !== row.subject
              || audienceDraft.data.purposeRevision.revisionId !== purpose.revision_id) {
            throw new TypeError('d1_organizer_communication_draft_edit_row_corrupt');
          }
          authoring = Object.freeze({
            state: 'ready' as const,
            contentPayload: organizerMessageContentPayloadRefSchema.parse(content.ref),
            audiencePayload: organizerMessageAudiencePayloadRefSchema.parse(audience.ref)
          });
        }
      }
      return Object.freeze({
        workspaceId: this.#workspaceId,
        eventId,
        ownerKey: context.authorityPrincipalKey,
        draftId: row.draft_id,
        version: row.version,
        state: row.state,
        channel: 'email' as const,
        purposeRevision: Object.freeze({
          purposeId: purpose.purpose_id,
          purposeKey: purpose.purpose_key,
          revisionId: purpose.revision_id,
          revisionNumber: purpose.revision_number,
          digestSha256: purpose.digest_sha256
        }),
        ...(template === undefined ? {} : {
          templateRevision: Object.freeze({
            templateId: template.template_id,
            templateRevisionId: template.template_revision_id,
            revisionNumber: template.revision_number,
            digestSha256: template.digest_sha256
          })
        }),
        authoring,
        provenance,
        createdAt: parseInstant(row.created_at),
        updatedAt: parseInstant(row.updated_at),
        ...(row.discard_reason_code === null ? {} : {
          discardReasonCode: row.discard_reason_code
        })
      });
    };

    const guardDraft = (row: DraftRow) => {
      this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM communication_drafts
        WHERE workspace_id=? AND event_id=? AND draft_id=? AND owner_key=?
          AND version=? AND state=? AND authoring_state=?
          AND content_payload_ref_id=? AND audience_payload_ref_id=?
          AND subject IS ? AND provenance_json=? AND discard_reason_code IS ?
          AND updated_at=?)`, [
        row.workspace_id, row.event_id, row.draft_id, row.owner_key, row.version,
        row.state, row.authoring_state, row.content_payload_ref_id,
        row.audience_payload_ref_id, row.subject, row.provenance_json,
        row.discard_reason_code, row.updated_at
      ]);
    };

    return sealOrganizerCommunicationMutationPreparation({
      capability,
      context,
      operationName,
      preparation: {
        prepare: ({ operationName: receivedOperation, businessInput, context: receivedContext }) => {
          if (receivedOperation !== operationName || receivedContext !== context
              || this.#prepared !== undefined) {
            throw new TypeError('d1_organizer_communication_draft_edit_context_substitution');
          }
          if (!payloadsBounded) {
            return outcome('quota_exceeded', 'communication.authoring_quota');
          }
          const parsed = operationName === 'revise_message_batch'
            ? organizerReviseCommunicationDraftInputSchema.safeParse(businessInput)
            : organizerDiscardCommunicationDraftInputSchema.safeParse(businessInput);
          if (!parsed.success) return outcome('policy_violation', 'communication.authoring_invalid');
          const row = drafts.find((candidate) => candidate.draft_id === parsed.data.draftId);
          if (!row) return outcome('conflict', 'communication.not_found');
          if (row.version !== parsed.data.expectedVersion) {
            return outcome('stale_revision', 'communication.revision_changed');
          }
          if (row.state !== 'active') {
            return outcome('conflict', 'communication.draft_not_active');
          }
          const current = currentRecord(row);
          guardDraft(row);
          let next: OrganizerMessageDraftRecord;
          let subject: string | null = row.subject;
          let contentRef: ReturnType<typeof createOrganizerAuthoringPayloadRef> | undefined;
          let audienceRef: ReturnType<typeof createOrganizerAuthoringPayloadRef> | undefined;
          try {
            if (operationName === 'revise_message_batch') {
              const revision = organizerReviseCommunicationDraftInputSchema.parse(parsed.data);
              const content = openPayload(revision.contentPayload.payloadRefId, 'message_content');
              const audience = openPayload(
                revision.audiencePayload.payloadRefId,
                'message_audience_draft'
              );
              const message = content === undefined ? undefined
                : organizerEmailMessageContentSchema.safeParse(content.envelope.value);
              const audienceDraft = audience === undefined ? undefined
                : organizerCommunicationAudienceDraftSchema.safeParse(audience.envelope.value);
              if (!content || !audience || !message?.success || !audienceDraft?.success
                  || audienceDraft.data.purposeRevision.revisionId
                    !== current.purposeRevision.revisionId
                  || canonicalJsonText(content.ref) !== canonicalJsonText(revision.contentPayload)
                  || canonicalJsonText(audience.ref) !== canonicalJsonText(revision.audiencePayload)) {
                return outcome('policy_violation', 'communication.authoring_invalid');
              }
              next = reviseOrganizerMessageDraft({
                current,
                businessInput: revision,
                now: context.receivedAt
              });
              subject = message.data.subject;
              contentRef = content.ref;
              audienceRef = audience.ref;
              this.input.unitOfWork.write(`UPDATE communication_drafts
                SET version=?,authoring_state='ready',content_payload_ref_id=?,
                    audience_payload_ref_id=?,subject=?,updated_at=?
                WHERE workspace_id=? AND event_id=? AND draft_id=? AND owner_key=?
                  AND version=? AND state='active'`, [
                next.version, revision.contentPayload.payloadRefId,
                revision.audiencePayload.payloadRefId, subject, next.updatedAt,
                this.#workspaceId, eventId, row.draft_id, context.authorityPrincipalKey,
                row.version
              ]);
            } else {
              const discard = organizerDiscardCommunicationDraftInputSchema.parse(parsed.data);
              next = discardOrganizerMessageDraft({
                current,
                businessInput: discard,
                now: context.receivedAt
              });
              this.input.unitOfWork.write(`UPDATE communication_drafts
                SET version=?,state='discarded',discard_reason_code=?,updated_at=?
                WHERE workspace_id=? AND event_id=? AND draft_id=? AND owner_key=?
                  AND version=? AND state='active'`, [
                next.version, discard.reasonCode, next.updatedAt, this.#workspaceId,
                eventId, row.draft_id, context.authorityPrincipalKey, row.version
              ]);
            }
          } catch (error) {
            if (error instanceof OrganizerMessageDraftError) {
              return error.code === 'stale_revision'
                ? outcome('stale_revision', 'communication.revision_changed')
                : error.code === 'draft_not_active'
                  ? outcome('conflict', 'communication.draft_not_active')
                  : outcome('policy_violation', 'communication.authoring_invalid');
            }
            throw error;
          }
          const resultData = organizerCommunicationDraftMutationResultSchema.parse({
            schemaVersion: 1,
            draftId: next.draftId,
            version: next.version,
            state: next.state,
            authoring: next.authoring.state === 'uninitialized'
              ? {
                  state: 'uninitialized',
                  contentRefId: next.authoring.contentRefId,
                  audienceRefId: next.authoring.audienceRefId
                }
              : {
                  state: 'ready',
                  subject,
                  recipientEstimate: {
                    knowledge: 'unknown', reasonCode: 'audience.not_resolved'
                  },
                  contentPayload: contentRef ?? next.authoring.contentPayload,
                  audiencePayload: audienceRef ?? next.authoring.audiencePayload
                },
            nextRead: {
              operationName: 'get_message_draft',
              draftId: next.draftId,
              expectedVersion: next.version
            }
          });
          const contribution = organizerCommunicationMutationContributionSchema.parse({
            result: { kind: 'success', data: resultData },
            domain: {
              kind: 'organizer_communication_authoring',
              operationName,
              workspaceId: this.#workspaceId,
              eventId,
              entityId: next.draftId,
              entityVersion: next.version,
              occurredAt: parseInstant(context.receivedAt)
            },
            effectContributions: []
          });
          if (contribution.result.kind !== 'success' || contribution.domain === null) {
            throw new TypeError('d1_organizer_communication_draft_edit_evidence_missing');
          }
          this.#prepared = {
            context,
            operationName,
            contribution,
            domainCanonical: canonicalJsonText(contribution.domain),
            resultDataCanonical: canonicalJsonText(contribution.result.data),
            timelineId,
            phase: 'prepared'
          };
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const parsed = organizerCommunicationMutationDomainContributionSchema.parse(contribution);
    if (!this.#prepared || this.#prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== this.#prepared.domainCanonical) {
      throw new TypeError('d1_organizer_communication_draft_edit_preparation_invalid');
    }
    this.#prepared.phase = 'applied';
  }

  afterOperationLogInserted(receipt: TerminalEffectReceipt): void {
    const prepared = this.#prepared;
    const result = organizerCommunicationDraftMutationOperationResultSchema.safeParse(
      receipt.result
    );
    if (!prepared || prepared.phase !== 'applied' || !result.success
        || result.data.kind !== 'success'
        || !effectOperationIdentityMatchesContext(receipt.identity, prepared.context)
        || receipt.requestHash !== prepared.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== prepared.operationName
        || receipt.ref.operationVersion !== 1
        || result.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(result.data.data) !== prepared.resultDataCanonical) {
      throw new TypeError('d1_organizer_communication_draft_edit_receipt_mismatch');
    }
    const domain = prepared.contribution.domain;
    this.input.unitOfWork.write(`INSERT INTO organizer_communication_authoring_receipt_links (
      receipt_id,workspace_id,event_id,authority_principal_key,operation_name,
      operation_version,payload_ref_id,draft_id,entity_version,request_hash,occurred_at_ms
    ) VALUES (?,?,?,?,?,1,NULL,?,?,?,?)`, [
      receipt.ref.id,
      domain.workspaceId,
      domain.eventId,
      prepared.context.authorityPrincipalKey,
      prepared.operationName,
      domain.entityId,
      domain.entityVersion,
      receipt.requestHash,
      Date.parse(parseInstant(domain.occurredAt))
    ]);
    this.input.unitOfWork.write(`INSERT INTO organizer_communication_authoring_timeline (
      timeline_id,receipt_id,occurred_at_ms,source_kind
    ) VALUES (?,?,?,'operation_receipt')`, [
      prepared.timelineId,
      receipt.ref.id,
      Date.parse(parseInstant(domain.occurredAt))
    ]);
    prepared.phase = 'evidence_complete';
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared = undefined;
  }
}

/** Mounts the encrypted authoring-payload operation independently of draft mutation rollout. */
export function createD1OrganizerCommunicationPayloadEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
  readonly ids: { newTimelineId(): string };
}): D1EffectDomainAdapterRegistration {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    capability: CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) =>
      new D1OrganizerCommunicationPayloadEffectDomainAdapter({
        unitOfWork,
        workspaceId,
        classifiedPayload: input.classifiedPayload,
        ids: input.ids
      })
  });
}

/** Mounts draft creation only after its catalog and encrypted-payload join is complete. */
export function createD1OrganizerCommunicationDraftCreateEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
  readonly ids: { newTimelineId(): string };
}): D1EffectDomainAdapterRegistration {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    capability:
      ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION.create_message_draft,
    create: (unitOfWork: D1BufferedUnitOfWork) =>
      new D1OrganizerCommunicationDraftCreateEffectDomainAdapter({
        unitOfWork,
        workspaceId,
        classifiedPayload: input.classifiedPayload,
        ids: input.ids
      })
  });
}

/** Mounts guarded draft revision and discard against the retained D1 authoring snapshot. */
export function createD1OrganizerCommunicationDraftEditEffectDomainRegistrations(input: {
  readonly workspaceId: WorkspaceId;
  readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
  readonly ids: { newTimelineId(): string };
}): readonly D1EffectDomainAdapterRegistration[] {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return (['revise_message_batch', 'discard_message_draft'] as const).map(
    (operationName) => Object.freeze({
      capability: ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION[operationName],
      create: (unitOfWork: D1BufferedUnitOfWork) =>
        new D1OrganizerCommunicationDraftEditEffectDomainAdapter({
          unitOfWork,
          workspaceId,
          classifiedPayload: input.classifiedPayload,
          ids: input.ids
        })
    })
  );
}
