import type { Database } from 'bun:sqlite';
import {
  effectOperationIdentitiesEqual,
  effectOperationIdentityMatchesContext,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  organizerCommunicationAuthoringPayloadOperationResultSchema,
  organizerCommunicationDraftMutationOperationResultSchema,
  organizerMessageTemplateMutationOperationResultSchema
} from '@jooevents/contracts/communications/organizer';
import {
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION,
  organizerCommunicationMutationContributionSchema,
  organizerCommunicationMutationDomainContributionSchema,
  sealOrganizerCommunicationMutationPreparation,
  type OrganizerCommunicationMutationOperationName
} from '@jooevents/communication-operations';
import {
  canonicalJsonText,
  parseInstant,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from '../foundation-trial-uow';
import { SQLiteEventSpineRepository } from '../event-spine';
import type { SQLiteOperatorEventRelationshipSource } from '../operator-authority-repositories';
import {
  createSQLiteOrganizerCommunicationMutationPreparation,
  type OrganizerCommunicationDraftProvenanceResolver,
  type SQLiteOrganizerCommunicationAuthoringRepository
} from './organizer-authoring';

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_EFFECT_SQL = `
CREATE TABLE organizer_communication_authoring_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  authority_principal_key TEXT NOT NULL CHECK(length(authority_principal_key) BETWEEN 1 AND 256),
  operation_name TEXT NOT NULL CHECK(operation_name IN (
    'store_communication_authoring_payload',
    'create_message_draft',
    'message_template.create',
    'revise_message_batch',
    'discard_message_draft'
  )),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  payload_ref_id TEXT,
  draft_id TEXT,
  template_id TEXT,
  entity_version INTEGER NOT NULL CHECK(entity_version > 0),
  request_hash TEXT NOT NULL CHECK(
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (operation_name = 'store_communication_authoring_payload'
      AND payload_ref_id IS NOT NULL AND draft_id IS NULL AND template_id IS NULL
      AND entity_version = 1)
    OR
    (operation_name IN ('create_message_draft','revise_message_batch','discard_message_draft')
      AND payload_ref_id IS NULL AND draft_id IS NOT NULL AND template_id IS NULL)
    OR
    (operation_name = 'message_template.create'
      AND payload_ref_id IS NULL AND draft_id IS NULL AND template_id IS NOT NULL
      AND entity_version = 1)
  ),
  FOREIGN KEY(receipt_id)
    REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id)
    REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(payload_ref_id)
    REFERENCES communication_authoring_payloads(payload_ref_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,draft_id)
    REFERENCES communication_drafts(workspace_id,event_id,draft_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,template_id)
    REFERENCES message_templates(workspace_id,event_id,template_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(payload_ref_id),
  UNIQUE(workspace_id,event_id,draft_id,entity_version),
  UNIQUE(workspace_id,event_id,template_id,entity_version),
  UNIQUE(receipt_id,workspace_id,event_id,operation_name,entity_version)
) STRICT, WITHOUT ROWID;

CREATE TABLE organizer_communication_authoring_timeline (
  timeline_id TEXT PRIMARY KEY CHECK(length(timeline_id) = 36),
  receipt_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'operation_receipt'),
  FOREIGN KEY(receipt_id)
    REFERENCES organizer_communication_authoring_receipt_links(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER organizer_communication_authoring_receipt_payload_scope_guard
BEFORE INSERT ON organizer_communication_authoring_receipt_links
WHEN NEW.payload_ref_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM communication_authoring_payloads p
   WHERE p.payload_ref_id = NEW.payload_ref_id
     AND p.workspace_id = NEW.workspace_id
     AND p.event_id = NEW.event_id
     AND p.owner_key = NEW.authority_principal_key
)
BEGIN SELECT RAISE(ABORT, 'organizer communication payload receipt scope mismatch'); END;

CREATE TRIGGER organizer_communication_authoring_receipt_draft_scope_guard
BEFORE INSERT ON organizer_communication_authoring_receipt_links
WHEN NEW.draft_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM communication_drafts d
   WHERE d.workspace_id = NEW.workspace_id
     AND d.event_id = NEW.event_id
     AND d.draft_id = NEW.draft_id
     AND d.owner_key = NEW.authority_principal_key
     AND d.version = NEW.entity_version
)
BEGIN SELECT RAISE(ABORT, 'organizer communication draft receipt scope mismatch'); END;

CREATE TRIGGER organizer_communication_authoring_receipt_template_scope_guard
BEFORE INSERT ON organizer_communication_authoring_receipt_links
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM message_templates t
   WHERE t.workspace_id = NEW.workspace_id
     AND t.event_id = NEW.event_id
     AND t.template_id = NEW.template_id
)
BEGIN SELECT RAISE(ABORT, 'organizer communication template receipt scope mismatch'); END;

CREATE TRIGGER organizer_communication_authoring_receipt_links_no_update
BEFORE UPDATE ON organizer_communication_authoring_receipt_links
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring receipt links are immutable'); END;
CREATE TRIGGER organizer_communication_authoring_receipt_links_no_delete
BEFORE DELETE ON organizer_communication_authoring_receipt_links
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring receipt links are immutable'); END;
CREATE TRIGGER organizer_communication_authoring_timeline_no_update
BEFORE UPDATE ON organizer_communication_authoring_timeline
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring timeline is immutable'); END;
CREATE TRIGGER organizer_communication_authoring_timeline_no_delete
BEFORE DELETE ON organizer_communication_authoring_timeline
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring timeline is immutable'); END;
`;

/** Exact immutable schema contribution accepted into the epoch-2 sequence-1 baseline. */
export const SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_EFFECT_E2_0001_SQL =
  SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_EFFECT_SQL
    .replace("    'message_template.create',\n", '')
    .replace('  template_id TEXT,\n', '')
    .replace(
      '      AND payload_ref_id IS NOT NULL AND draft_id IS NULL AND template_id IS NULL\n      AND entity_version = 1)',
      '      AND payload_ref_id IS NOT NULL AND draft_id IS NULL AND entity_version = 1)'
    )
    .replace(
      "    (operation_name IN ('create_message_draft','revise_message_batch','discard_message_draft')\n      AND payload_ref_id IS NULL AND draft_id IS NOT NULL AND template_id IS NULL)\n    OR\n    (operation_name = 'message_template.create'\n      AND payload_ref_id IS NULL AND draft_id IS NULL AND template_id IS NOT NULL\n      AND entity_version = 1)",
      "    (operation_name IN ('create_message_draft','revise_message_batch','discard_message_draft')\n      AND payload_ref_id IS NULL AND draft_id IS NOT NULL)"
    )
    .replace(
      '  FOREIGN KEY(workspace_id,event_id,template_id)\n    REFERENCES message_templates(workspace_id,event_id,template_id)\n    ON UPDATE RESTRICT ON DELETE RESTRICT,\n',
      ''
    )
    .replace('  UNIQUE(workspace_id,event_id,template_id,entity_version),\n', '')
    .replace(
      "CREATE TRIGGER organizer_communication_authoring_receipt_template_scope_guard\nBEFORE INSERT ON organizer_communication_authoring_receipt_links\nWHEN NEW.template_id IS NOT NULL AND NOT EXISTS (\n  SELECT 1 FROM message_templates t\n   WHERE t.workspace_id = NEW.workspace_id\n     AND t.event_id = NEW.event_id\n     AND t.template_id = NEW.template_id\n)\nBEGIN SELECT RAISE(ABORT, 'organizer communication template receipt scope mismatch'); END;\n\n",
      ''
    );

export function installSQLiteOrganizerCommunicationAuthoringEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) {
    throw new TypeError('organizer_communication_authoring_effect_schema_inside_transaction');
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_EFFECT_SQL))
    .immediate();
}

export interface SQLiteOrganizerCommunicationAuthoringEffectIds {
  newTimelineId(): string;
}

export interface SQLiteOrganizerCommunicationAuthoringEffectDomainInput {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly repository: SQLiteOrganizerCommunicationAuthoringRepository;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteOrganizerCommunicationAuthoringEffectIds;
  readonly provenanceResolver?: OrganizerCommunicationDraftProvenanceResolver;
  readonly templateArtifactBridge?: Readonly<{
    create(input: Readonly<{
      workspaceId: string;
      eventId: string;
      templateId: string;
      createdByUserId: string;
      createdAt: string;
    }>): void;
  }>;
}

type MutationContribution = ReturnType<
  typeof organizerCommunicationMutationContributionSchema.parse
>;
type MutationSuccess = Extract<
  MutationContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedMutation {
  readonly context: EffectInvocationContext;
  readonly operationName: OrganizerCommunicationMutationOperationName;
  readonly contribution: MutationSuccess;
  readonly domainCanonical: string;
  readonly resultDataCanonical: string;
  readonly timelineId: string;
  phase: 'prepared' | 'applied' | 'evidence_complete' | 'effect_complete';
  receiptId?: string;
}

const APPLICATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactSubjects(context: EffectInvocationContext, eventId?: EventId): boolean {
  if (eventId === undefined) {
    return context.scope.subjects.length === 1
      && context.scope.subjects[0]?.kind === 'workspace'
      && context.scope.subjects[0].id === context.scope.workspaceId;
  }
  return context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId
    );
}

function operationForCapability(
  capability: { readonly key: string; readonly version: number }
): OrganizerCommunicationMutationOperationName | undefined {
  for (const [operationName, expected] of Object.entries(
    ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION
  ) as Array<[
    OrganizerCommunicationMutationOperationName,
    { readonly key: string; readonly version: number }
  ]>) {
    if (capability.key === expected.key && capability.version === expected.version) {
      return operationName;
    }
  }
  return undefined;
}

function isPermissionGrant(
  grant: { readonly kind: string; readonly key: string }
): boolean {
  return grant.kind === 'permission' && grant.key === 'communication.draft';
}

interface ExpectedReceiptSuccess {
  readonly kind: 'success';
  readonly data: unknown;
  readonly receipt: {
    readonly id: string;
    readonly operationName: string;
    readonly operationVersion: number;
  };
}

function expectedReceiptSuccess(
  operationName: OrganizerCommunicationMutationOperationName,
  value: unknown
): ExpectedReceiptSuccess | undefined {
  const parsed = operationName === 'store_communication_authoring_payload'
    ? organizerCommunicationAuthoringPayloadOperationResultSchema.safeParse(value)
    : operationName === 'message_template.create'
      ? organizerMessageTemplateMutationOperationResultSchema.safeParse(value)
      : organizerCommunicationDraftMutationOperationResultSchema.safeParse(value);
  return parsed.success && parsed.data.kind === 'success' ? parsed.data : undefined;
}

/**
 * Executes the five inert organizer-authoring mutations on the Foundation-owned
 * SQLite transaction. It owns no transaction, transport binding, or provider work.
 */
export class SQLiteOrganizerCommunicationAuthoringEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #preparation: ReturnType<typeof createSQLiteOrganizerCommunicationMutationPreparation>;
  readonly #newTimelineId: () => string;
  readonly #validateEvent: SQLiteOperatorEventRelationshipSource['validateEvent'];
  readonly #issuedTimelineIds = new Set<string>();
  #prepared: PreparedMutation | undefined;
  #active: PreparedMutation | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalContext: EffectInvocationContext | undefined;

  constructor(private readonly input: SQLiteOrganizerCommunicationAuthoringEffectDomainInput) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    if (typeof input.eventRelationships?.validateEvent !== 'function'
        || typeof input.ids?.newTimelineId !== 'function'
        || (input.provenanceResolver !== undefined
          && typeof input.provenanceResolver.resolveAgentProvenance !== 'function')) {
      throw new TypeError('organizer_communication_authoring_effect_dependency_invalid');
    }
    this.#newTimelineId = input.ids.newTimelineId.bind(input.ids);
    this.#validateEvent = input.eventRelationships.validateEvent.bind(input.eventRelationships);
    const resolveAgentProvenance = input.provenanceResolver?.resolveAgentProvenance.bind(
      input.provenanceResolver
    );
    this.#preparation = createSQLiteOrganizerCommunicationMutationPreparation({
      repository: input.repository,
      ...(resolveAgentProvenance === undefined
        ? {}
        : { provenanceResolver: Object.freeze({ resolveAgentProvenance }) })
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('organizer_communication_authoring_effect_transaction_required');
    }
    const operationName = operationForCapability(capability);
    if (operationName === undefined
        || context.operation.name !== operationName
        || context.operation.version !== 1
        || context.operation.effect !== 'draft'
        || (context.surface !== 'operator_http' && context.surface !== 'app_model')
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('organizer_communication_authoring_effect_binding_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(
      context,
      authorityRecheck
    );
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(
      context,
      authorityRecheck
    );
    if (authority.lane.policy.key !== ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY.key
        || authority.lane.policy.version !== ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY.version
        || !authority.grants.some(isPermissionGrant)) {
      throw new TypeError('organizer_communication_authoring_effect_authority_mismatch');
    }

    let relationshipUserId: ReturnType<typeof parseUserId> | undefined;
    if (context.surface === 'operator_http') {
      if (context.provenance.kind !== 'operator'
          || authority.lane.kind !== 'operator'
          || authority.lane.surface !== 'operator_http'
          || authority.actor.kind !== 'workspace_user'
          || authority.principal.kind !== 'workspace_user'
          || context.actor.kind !== 'workspace_user'
          || authority.actor.userId !== authority.principal.userId
          || authority.actor.userId !== context.actor.userId) {
        throw new TypeError('organizer_communication_authoring_effect_authority_mismatch');
      }
      relationshipUserId = parseUserId(authority.principal.userId);
    } else {
      if (context.provenance.kind !== 'app_model'
          || authority.lane.kind !== 'app_model'
          || authority.lane.surface !== 'app_model'
          || authority.actor.kind !== 'app_model_run'
          || context.actor.kind !== 'app_model_run'
          || authority.actor.agentRunId !== context.actor.agentRunId
          || authority.actor.delegatedByPrincipalId !== context.actor.delegatedByPrincipalId
          || authority.actor.agentRunId !== context.provenance.agentRunId
          || (authority.principal.kind !== 'workspace_user'
            && authority.principal.kind !== 'service')) {
        throw new TypeError('organizer_communication_authoring_effect_authority_mismatch');
      }
      if (authority.principal.kind === 'workspace_user') {
        relationshipUserId = parseUserId(authority.principal.userId);
      }
    }

    this.#clearTransient();
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.#workspaceId);
    const eventId = context.scope.eventId;
    if (eventId === undefined) {
      if (!current || current.currentEvent !== undefined) {
        throw new TypeError('organizer_communication_authoring_effect_current_event_mismatch');
      }
    } else {
      if (!current?.currentEvent
          || current.currentEvent.id !== eventId
          || current.currentEvent.workspaceId !== this.#workspaceId) {
        throw new TypeError('organizer_communication_authoring_effect_current_event_mismatch');
      }
      if (relationshipUserId !== undefined) {
        const relationship = this.#validateEvent({
          sqlite: this.input.sqlite,
          workspaceId: this.#workspaceId,
          eventId,
          userId: relationshipUserId,
          evaluatedAt
        });
        if (relationship.kind !== 'valid') {
          throw new TypeError('organizer_communication_authoring_effect_event_relationship_mismatch');
        }
      }
    }

    return sealOrganizerCommunicationMutationPreparation({
      capability,
      context,
      operationName,
      preparation: {
        prepare: ({ operationName: receivedOperation, businessInput, context: receivedContext }) => {
          if (!this.input.sqlite.inTransaction
              || receivedContext !== context
              || receivedOperation !== operationName
              || this.#prepared !== undefined
              || this.#active !== undefined
              || this.#nonterminalContext !== undefined) {
            throw new TypeError('organizer_communication_authoring_effect_context_substitution');
          }
          const candidate = organizerCommunicationMutationContributionSchema.parse(
            this.#preparation.prepare({
              operationName,
              businessInput,
              context
            })
          );
          if (candidate.result.kind === 'outcome') {
            this.#nonterminalContext = context;
            return candidate;
          }
          if (eventId === undefined || candidate.domain === null
              || candidate.domain.operationName !== operationName
              || candidate.domain.workspaceId !== this.#workspaceId
              || candidate.domain.eventId !== eventId
              || candidate.domain.occurredAt !== parseInstant(context.receivedAt)) {
            throw new TypeError('organizer_communication_authoring_effect_contribution_mismatch');
          }
          const success = candidate as MutationSuccess;
          this.#prepared = {
            context,
            operationName,
            contribution: success,
            domainCanonical: canonicalJsonText(success.domain),
            resultDataCanonical: canonicalJsonText(success.result.data),
            timelineId: this.#freshTimelineId(),
            phase: 'prepared'
          };
          return success;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('organizer_communication_authoring_effect_transaction_required');
    }
    const parsed = organizerCommunicationMutationDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== prepared.domainCanonical
        || !this.#persistedEntityMatches(prepared)) {
      throw new TypeError('organizer_communication_authoring_effect_preparation_invalid');
    }
    if (prepared.operationName === 'message_template.create'
        && this.input.templateArtifactBridge !== undefined) {
      if (prepared.context.actor.kind !== 'workspace_user') {
        throw new TypeError('organizer_communication_template_artifact_actor_invalid');
      }
      this.input.templateArtifactBridge.create({
        workspaceId: parsed.workspaceId,
        eventId: parsed.eventId,
        templateId: parsed.entityId,
        createdByUserId: prepared.context.actor.userId,
        createdAt: parsed.occurredAt
      });
    }
    this.#prepared = undefined;
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterOperationLogInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = active === undefined
      ? undefined
      : expectedReceiptSuccess(active.operationName, receipt.result);
    if (!this.input.sqlite.inTransaction
        || !active
        || active.phase !== 'applied'
        || parsedResult === undefined
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== active.operationName
        || receipt.ref.operationVersion !== active.context.operation.version
        || parsedResult.receipt.id !== receipt.ref.id
        || parsedResult.receipt.operationName !== active.operationName
        || parsedResult.receipt.operationVersion !== active.context.operation.version
        || canonicalJsonText(parsedResult.data) !== active.resultDataCanonical) {
      throw new TypeError('organizer_communication_authoring_effect_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    const domain = active.contribution.domain;
    const payloadRefId = active.operationName === 'store_communication_authoring_payload'
      ? domain.entityId
      : null;
    const templateId = active.operationName === 'message_template.create' ? domain.entityId : null;
    const draftId = active.operationName === 'store_communication_authoring_payload'
        || active.operationName === 'message_template.create' ? null : domain.entityId;
    this.input.sqlite.query<never, [
      string, string, string, string, string, number, string | null, string | null,
      string | null, number, string, number
    ]>(`
      INSERT INTO organizer_communication_authoring_receipt_links (
        receipt_id,workspace_id,event_id,authority_principal_key,
        operation_name,operation_version,payload_ref_id,draft_id,template_id,
        entity_version,request_hash,occurred_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      receiptId,
      domain.workspaceId,
      domain.eventId,
      active.context.authorityPrincipalKey,
      active.operationName,
      active.context.operation.version,
      payloadRefId,
      draftId,
      templateId,
      domain.entityVersion,
      receipt.requestHash,
      Date.parse(parseInstant(domain.occurredAt))
    );
    this.input.sqlite.query<never, [string, string, number]>(`
      INSERT INTO organizer_communication_authoring_timeline (
        timeline_id,receipt_id,occurred_at_ms,source_kind
      ) VALUES (?,?,?,'operation_receipt')
    `).run(
      active.timelineId,
      receiptId,
      Date.parse(parseInstant(domain.occurredAt))
    );
    active.receiptId = receiptId;
    active.phase = 'evidence_complete';
    this.#expectedIdentity = receipt.identity;
  }

  afterEffectApplicationCommitted(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('organizer_communication_authoring_effect_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      if (!this.#nonterminalContext
          || !effectOperationIdentityMatchesContext(identity, this.#nonterminalContext)) {
        throw new TypeError('organizer_communication_authoring_effect_incomplete');
      }
      this.#nonterminalContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete'
        || active.receiptId === undefined
        || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('organizer_communication_authoring_effect_incomplete');
    }
    active.phase = 'effect_complete';
  }

  afterUnitOfWorkCommitted(): void {
    this.#clearTransient();
  }

  afterUnitOfWorkFinished(): void {
    this.#clearTransient();
  }

  #persistedEntityMatches(prepared: PreparedMutation): boolean {
    const domain = prepared.contribution.domain;
    if (prepared.operationName === 'store_communication_authoring_payload') {
      const rows = this.input.sqlite.query<{
        readonly workspace_id: string;
        readonly event_id: string;
        readonly owner_key: string;
      }, [string]>(`
        SELECT workspace_id,event_id,owner_key
          FROM communication_authoring_payloads
         WHERE payload_ref_id=? LIMIT 2
      `).all(domain.entityId);
      return rows.length === 1
        && rows[0]?.workspace_id === domain.workspaceId
        && rows[0].event_id === domain.eventId
        && rows[0].owner_key === prepared.context.authorityPrincipalKey
        && domain.entityVersion === 1;
    }
    if (prepared.operationName === 'message_template.create') {
      const rows = this.input.sqlite.query<{
        readonly current_revision_id: string;
        readonly revision_number: number;
      }, [string, string, string]>(`
        SELECT t.current_revision_id,r.revision_number
          FROM message_templates t
          JOIN message_template_revisions r
            ON r.workspace_id=t.workspace_id AND r.event_id=t.event_id
           AND r.template_revision_id=t.current_revision_id
         WHERE t.workspace_id=? AND t.event_id=? AND t.template_id=? LIMIT 2
      `).all(domain.workspaceId, domain.eventId, domain.entityId);
      const data = prepared.contribution.result.data as {
        readonly revision?: { readonly templateId?: string; readonly revisionNumber?: number };
      };
      return rows.length === 1
        && domain.entityVersion === 1
        && rows[0]?.revision_number === 1
        && data.revision?.templateId === domain.entityId
        && data.revision.revisionNumber === 1;
    }
    const rows = this.input.sqlite.query<{
      readonly owner_key: string;
      readonly version: number;
      readonly state: string;
    }, [string, string, string]>(`
      SELECT owner_key,version,state
        FROM communication_drafts
       WHERE workspace_id=? AND event_id=? AND draft_id=? LIMIT 2
    `).all(domain.workspaceId, domain.eventId, domain.entityId);
    const data = prepared.contribution.result.data as {
      readonly version?: number;
      readonly state?: string;
    };
    const operationStateMatches = prepared.operationName === 'create_message_draft'
      ? data.version === 1 && data.state === 'active'
      : prepared.operationName === 'revise_message_batch'
        ? data.state === 'active'
        : data.state === 'discarded';
    return rows.length === 1
      && rows[0]?.owner_key === prepared.context.authorityPrincipalKey
      && rows[0].version === domain.entityVersion
      && rows[0].version === data.version
      && rows[0].state === data.state
      && operationStateMatches;
  }

  #freshTimelineId(): string {
    const value = this.#newTimelineId();
    if (typeof value !== 'string' || !APPLICATION_UUID.test(value)) {
      throw new TypeError('organizer_communication_authoring_effect_timeline_id_invalid');
    }
    const canonical = value.toLowerCase();
    if (this.#issuedTimelineIds.has(canonical)) {
      throw new TypeError('organizer_communication_authoring_effect_timeline_id_reused');
    }
    this.#issuedTimelineIds.add(canonical);
    return canonical;
  }

  #clearTransient(): void {
    this.#prepared = undefined;
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalContext = undefined;
  }
}

export function createSQLiteOrganizerCommunicationAuthoringEffectDomainRegistrations(
  input: SQLiteOrganizerCommunicationAuthoringEffectDomainInput
): readonly SQLiteEffectDomainAdapterRegistration[] {
  const adapter = new SQLiteOrganizerCommunicationAuthoringEffectDomainAdapter(input);
  return Object.freeze((Object.values(
    ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION
  )).map((capability) => Object.freeze({ capability, adapter })));
}
