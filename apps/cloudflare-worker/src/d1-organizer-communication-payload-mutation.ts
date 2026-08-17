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
  OrganizerAuthoringPayloadError,
  canonicalizeOrganizerAuthoringPayload,
  createOrganizerAuthoringPayloadRef
} from '@jooevents/communications';
import {
  organizerCommunicationAuthoringPayloadInputSchema,
  organizerCommunicationAuthoringPayloadOperationResultSchema,
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
  outcomeClass: 'conflict' | 'policy_violation' | 'quota_exceeded' | 'idempotency_conflict',
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

async function deterministicPayloadRefId(context: EffectInvocationContext): Promise<string | undefined> {
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
    namespace: `communication.${OPERATION_NAME}`
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

    const payloadRefId = await deterministicPayloadRefId(context);
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

/** Mounts the encrypted authoring-payload operation without exposing draft mutations. */
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
