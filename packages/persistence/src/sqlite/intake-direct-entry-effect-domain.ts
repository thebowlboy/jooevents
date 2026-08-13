import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import {
  effectOperationIdentitiesEqual,
  effectOperationIdentityMatchesContext,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type ClassifiedPayloadProfiles,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  adoptSynchronousClassifiedPayload,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  applyPreparedChangesetSynchronous,
  prepareChangesetCommitSynchronous,
  type ChangesetCommitTransaction,
  type ChangesetPlanningSnapshot,
  type ChangesetReadPortKey,
  type ChangesetTransactionPortKey,
  type ChangesetValidationPortKey,
  type FrozenChangesetOperation
} from '@jooevents/changesets';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
  COMMIT_CHANGESET_OPERATION,
  appendChangesetDraftSynchronous,
  changesetLifecycleActionForOperation,
  changesetLifecycleContributionSchema,
  changesetLifecycleDomainContributionSchema,
  changesetLifecycleOperationResultSchema,
  changesetLifecycleRefusalOutcome,
  changesetOutboxEvidenceChildSchema,
  commitChangesetInputSchema,
  commitStoredChangeset,
  draftChangesetCorrectionInputSchema,
  draftChangesetCorrectionSynchronous,
  eventChangesetDomainFactEvidenceChildSchema,
  eventChangesetTimelineEvidenceChildSchema,
  parseChangesetCommitTerminalReceipt,
  projectStoredChangesetDiff,
  proposeChangesetInputSchema,
  proposeStoredChangeset,
  rebuildChangesetInputSchema,
  rebuildStoredChangesetSynchronous,
  sealChangesetLifecyclePreparation,
  validateStoredChangesetCommit,
  type ChangesetLifecycleAction,
  type ChangesetLifecycleContribution,
  type ChangesetLifecycleIds,
  type ChangesetLifecycleOwnerResolution,
  type ChangesetLifecycleOwnerResolutionSource,
  type ChangesetLifecyclePreparation,
  type ChangesetLifecycleRefusal,
  type ExactStoredChangesetCommit,
  type StoredChangesetRecord
} from '@jooevents/changeset-operations';
import {
  submissionDirectEntryDraftInputSchema,
  submissionDirectEntryResultSchema,
  submissionDirectEntrySafeDiffSchema,
  type IntakeScopeDto,
  type SubmissionDirectEntryResultDto
} from '@jooevents/contracts';
import {
  ApplicationAnswerError,
  ApplicationPlanningError,
  SUBMISSION_DIRECT_ENTRY_CHANGESET_KIND,
  SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID,
  SUBMISSION_DIRECT_ENTRY_CHANGESET_VERSION,
  assertSubmissionDirectEntryChangesetBundle,
  assertSubmissionDirectEntryChangesetPolicy,
  captureSubmissionDirectEntryApprovalPolicy,
  createSubmissionDirectEntryChangesetBundle,
  finalizeGovernedAnswerIndex,
  parseApplicationDirectEntryPlan,
  parseFormVersion,
  prepareApplicationAnswers,
  submissionDirectEntryAnswerOwner,
  submissionDirectEntryChangesetReadPort,
  submissionDirectEntryChangesetTransactionPort,
  submissionDirectEntryChangesetValidationPort,
  submissionDirectEntryPlanningAttributionReadPort,
  submissionDirectEntryRecordDigest,
  submissionDirectEntryReferenceReadPort,
  type ApplicationDirectEntryPlan,
  type SubmissionDirectEntryChangesetAuthorInput,
  type SubmissionDirectEntryChangesetBundle,
  type SubmissionDirectEntryChangesetPolicy,
  type SubmissionDirectEntryRefusalCode,
  type SubmissionDirectEntryValidationPort
} from '@jooevents/intake';
import {
  SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
  SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY,
  SUBMISSION_DIRECT_ENTRY_DRAFT_OPERATION,
  sealIntakePreparation,
  submissionDirectEntryDraftContributionSchema,
  submissionDirectEntryDraftDomainContributionSchema,
  submissionDirectEntryDraftEvidenceChildSchema
} from '@jooevents/intake-operations';
import {
  canonicalJsonText,
  encodeCanonicalJson,
  isApplicationId,
  parseEventId,
  parseInstant,
  parseOperationReceiptId,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SubmissionTriageInitializationPort } from '@jooevents/submission-triage';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import {
  SQLiteChangesetLifecycleStore,
  createSQLiteDraftOnlyChangesetLifecycleStore,
  type SQLiteChangesetTerminalReceiptSource
} from './changeset-lifecycle';
import type { SQLiteIntakeClassifiedProjection } from './intake-classified-projection';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  SQLiteOperatorEventRelationshipSource,
  SQLiteOperatorSubjectRelationshipSource
} from './operator-authority-repositories';
import { SQLiteIntakeRepository } from './intake';

export const SQLITE_INTAKE_DIRECT_ENTRY_EFFECT_SQL = `
CREATE TABLE intake_direct_entry_draft_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL UNIQUE,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  revision_digest_sha256 TEXT NOT NULL CHECK(
    length(revision_digest_sha256) = 64
    AND revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  record_digest_sha256 TEXT NOT NULL CHECK(
    length(record_digest_sha256) = 64
    AND record_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  action TEXT NOT NULL CHECK(action = 'create'),
  operation_name TEXT NOT NULL CHECK(operation_name = 'submission.direct_entry.create.draft'),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (receipt_id)
    REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id, workspace_id, event_id)
    REFERENCES changeset_heads(changeset_id, workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id, revision_id, revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(receipt_id, workspace_id, event_id, changeset_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_direct_entry_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES intake_direct_entry_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_direct_entry_changeset_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('propose', 'rebuild', 'correction', 'commit')),
  operation_name TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_digest_sha256 TEXT NOT NULL CHECK(
    length(revision_digest_sha256) = 64
    AND revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  record_digest_sha256 TEXT NOT NULL CHECK(
    length(record_digest_sha256) = 64
    AND record_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (action = 'propose' AND operation_name = 'changeset.propose')
    OR (action = 'rebuild' AND operation_name = 'changeset.rebuild')
    OR (action = 'correction' AND operation_name = 'changeset.correction.draft')
    OR (action = 'commit' AND operation_name = 'changeset.commit')
  ),
  FOREIGN KEY(receipt_id) REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changeset_id, workspace_id, event_id)
    REFERENCES changeset_heads(changeset_id, workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changeset_id, revision_id, revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(receipt_id, workspace_id, event_id, changeset_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_direct_entry_changeset_domain_facts (
  fact_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  fact_kind TEXT NOT NULL CHECK(fact_kind = 'submission_created'),
  fact_version INTEGER NOT NULL CHECK(fact_version = 1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  FOREIGN KEY(receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES intake_direct_entry_changeset_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(fact_id, receipt_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_direct_entry_changeset_outbox_pointers (
  pointer_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY(fact_id, receipt_id)
    REFERENCES intake_direct_entry_changeset_domain_facts(fact_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_direct_entry_changeset_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'changeset_proposal', 'changeset_rebuild', 'changeset_correction', 'changeset_commit'
  )),
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY(receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES intake_direct_entry_changeset_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER intake_direct_entry_draft_receipt_links_no_update
BEFORE UPDATE ON intake_direct_entry_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'direct entry draft receipt links are immutable'); END;
CREATE TRIGGER intake_direct_entry_draft_receipt_links_no_delete
BEFORE DELETE ON intake_direct_entry_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'direct entry draft receipt links are immutable'); END;
CREATE TRIGGER intake_direct_entry_draft_timeline_no_update
BEFORE UPDATE ON intake_direct_entry_draft_timeline
BEGIN SELECT RAISE(ABORT, 'direct entry draft timeline is immutable'); END;
CREATE TRIGGER intake_direct_entry_draft_timeline_no_delete
BEFORE DELETE ON intake_direct_entry_draft_timeline
BEGIN SELECT RAISE(ABORT, 'direct entry draft timeline is immutable'); END;
CREATE TRIGGER intake_direct_entry_changeset_receipt_links_no_update
BEFORE UPDATE ON intake_direct_entry_changeset_receipt_links
BEGIN SELECT RAISE(ABORT, 'direct entry changeset receipt links are immutable'); END;
CREATE TRIGGER intake_direct_entry_changeset_receipt_links_no_delete
BEFORE DELETE ON intake_direct_entry_changeset_receipt_links
BEGIN SELECT RAISE(ABORT, 'direct entry changeset receipt links are immutable'); END;
CREATE TRIGGER intake_direct_entry_changeset_domain_facts_no_update
BEFORE UPDATE ON intake_direct_entry_changeset_domain_facts
BEGIN SELECT RAISE(ABORT, 'direct entry changeset facts are immutable'); END;
CREATE TRIGGER intake_direct_entry_changeset_domain_facts_no_delete
BEFORE DELETE ON intake_direct_entry_changeset_domain_facts
BEGIN SELECT RAISE(ABORT, 'direct entry changeset facts are immutable'); END;
CREATE TRIGGER intake_direct_entry_changeset_outbox_pointers_no_update
BEFORE UPDATE ON intake_direct_entry_changeset_outbox_pointers
BEGIN SELECT RAISE(ABORT, 'direct entry changeset pointers are immutable'); END;
CREATE TRIGGER intake_direct_entry_changeset_outbox_pointers_no_delete
BEFORE DELETE ON intake_direct_entry_changeset_outbox_pointers
BEGIN SELECT RAISE(ABORT, 'direct entry changeset pointers are immutable'); END;
CREATE TRIGGER intake_direct_entry_changeset_timeline_no_update
BEFORE UPDATE ON intake_direct_entry_changeset_timeline
BEGIN SELECT RAISE(ABORT, 'direct entry changeset timeline is immutable'); END;
CREATE TRIGGER intake_direct_entry_changeset_timeline_no_delete
BEFORE DELETE ON intake_direct_entry_changeset_timeline
BEGIN SELECT RAISE(ABORT, 'direct entry changeset timeline is immutable'); END;
`;

export function installSQLiteIntakeDirectEntryEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) {
    throw new TypeError('intake_direct_entry_effect_schema_inside_transaction');
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_INTAKE_DIRECT_ENTRY_EFFECT_SQL)).immediate();
}

/** Census contributor consulted by compensation derivation only. */
export interface SQLiteSubmissionReferenceSource {
  countSubmissionReferences(scope: IntakeScopeDto, submissionId: string): number;
}

interface FoundationReceiptRow {
  readonly id: string;
  readonly scope_partition_key: string;
  readonly authority_principal_key: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: EffectOperationIdentity['surface'];
  readonly idempotency_verifier_profile_key: string;
  readonly idempotency_verifier_profile_version: number;
  readonly idempotency_key_verifier: string;
  readonly request_hash: string;
  readonly result_json: string;
}

function terminalReceiptSource(sqlite: Database): SQLiteChangesetTerminalReceiptSource {
  return Object.freeze({
    commitOperations: Object.freeze([COMMIT_CHANGESET_OPERATION]),
    readTerminalReceipt(receiptId: string) {
      const row = sqlite.query<FoundationReceiptRow, [string]>(`
        SELECT id, scope_partition_key, authority_principal_key, operation_name,
               operation_version, surface, idempotency_verifier_profile_key,
               idempotency_verifier_profile_version, idempotency_key_verifier,
               request_hash, result_json
          FROM foundation_trial_operation_receipts
         WHERE id = ?
      `).get(parseOperationReceiptId(receiptId));
      if (!row) return undefined;
      return Object.freeze({
        ref: Object.freeze({
          id: row.id,
          operationName: row.operation_name,
          operationVersion: row.operation_version
        }),
        identity: Object.freeze({
          scopePartitionKey: row.scope_partition_key,
          authorityPrincipalKey: row.authority_principal_key,
          operationName: row.operation_name,
          operationVersion: row.operation_version,
          surface: row.surface,
          idempotencyVerifierProfile: Object.freeze({
            key: row.idempotency_verifier_profile_key,
            version: row.idempotency_verifier_profile_version
          }),
          idempotencyKeyVerifier: row.idempotency_key_verifier
        }),
        requestHash: row.request_hash,
        result: JSON.parse(row.result_json) as never
      });
    }
  });
}

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameSchemaReference(
  left: { readonly key: string; readonly version: number; readonly digestSha256: string },
  right: { readonly key: string; readonly version: number; readonly digestSha256: string }
): boolean {
  return sameReference(left, right) && left.digestSha256 === right.digestSha256;
}

function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) {
    throw new TypeError(`intake_direct_entry_${label}_invalid`);
  }
  return value;
}

const STALE_REFUSAL_CODES = new Set<SubmissionDirectEntryRefusalCode>([
  'wrong_scope', 'form_missing', 'form_not_open', 'form_version_mismatch',
  'target_unavailable', 'deadline_unavailable', 'deadline_changed'
]);

function planningRefusalContribution(
  code: SubmissionDirectEntryRefusalCode,
  formId: string
) {
  const stale = STALE_REFUSAL_CODES.has(code);
  return submissionDirectEntryDraftContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: stale ? 'stale_revision' : 'policy_violation',
      kind: stale ? 'submission_direct_entry.changed' : 'submission_direct_entry.refused',
      retryable: false,
      subjects: [{ type: 'intake_form', id: formId }],
      detail: { code, action: 'create', formId },
      detailSchemaVersion: 1
    } },
    domain: null,
    receiptChildren: []
  });
}

function planningRefusalCode(error: unknown): SubmissionDirectEntryRefusalCode {
  if (error instanceof ApplicationAnswerError) return 'invalid_answers';
  if (error instanceof ApplicationPlanningError) {
    const codes: readonly SubmissionDirectEntryRefusalCode[] = [
      'wrong_scope', 'form_missing', 'form_not_open', 'form_version_mismatch',
      'target_unavailable', 'deadline_unavailable', 'deadline_changed',
      'invalid_answers', 'invalid_submission_identity',
      'direct_entry_title_required', 'direct_entry_email_required', 'invalid_plan'
    ];
    return (codes as readonly string[]).includes(error.code)
      ? error.code as SubmissionDirectEntryRefusalCode
      : 'invalid_plan';
  }
  return 'invalid_plan';
}

function eventRequiredContribution() {
  return submissionDirectEntryDraftContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: 'conflict', kind: 'submission_direct_entry.event_required', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    } },
    domain: null,
    receiptChildren: []
  });
}

function collisionContribution() {
  return submissionDirectEntryDraftContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: 'conflict', kind: 'changeset.id_collision', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    } },
    domain: null,
    receiptChildren: []
  });
}

export interface SQLiteIntakeDirectEntryDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
  newPayloadRefId(): string;
  newSubmissionId(): string;
  newEntryEvidenceId(): string;
  newPersonId(): string;
  newParticipantIdentityId(): string;
  newParticipantEvidenceId(): string;
}

type DraftContribution = ReturnType<typeof submissionDirectEntryDraftContributionSchema.parse>;
type DraftSuccess = Extract<DraftContribution, { readonly result: { readonly kind: 'success' } }>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  receiptId?: string;
}

function draftExactSubjects(context: EffectInvocationContext, eventId?: EventId): boolean {
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

/**
 * Persists an inert bounded direct-entry create changeset. Effective
 * submission state is read-only here; the write happens only when the
 * changeset lifecycle commits.
 */
export class SQLiteIntakeDirectEntryDraftEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #bundle: SubmissionDirectEntryChangesetBundle;
  readonly #changesets: ReturnType<typeof createSQLiteDraftOnlyChangesetLifecycleStore>;
  readonly #ids: SQLiteIntakeDirectEntryDraftEffectIds;
  readonly #issuedIds = new Set<string>();
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #pendingBuffers = new Set<Uint8Array>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: SubmissionDirectEntryChangesetPolicy;
    readonly repository: SQLiteIntakeRepository;
    readonly classifiedStore: SynchronousClassifiedPayloadStore;
    readonly classifiedProfiles: ClassifiedPayloadProfiles;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteIntakeDirectEntryDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    assertSubmissionDirectEntryChangesetPolicy(input.policy);
    this.#bundle = createSubmissionDirectEntryChangesetBundle({ policy: input.policy });
    assertSubmissionDirectEntryChangesetBundle(this.#bundle);
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newPreparationHandle', 'newTimelineId',
      'newPayloadRefId', 'newSubmissionId', 'newEntryEvidenceId', 'newPersonId',
      'newParticipantIdentityId', 'newParticipantEvidenceId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('intake_direct_entry_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newPreparationHandle', 'newTimelineId',
        'newPayloadRefId', 'newSubmissionId', 'newEntryEvidenceId', 'newPersonId',
        'newParticipantIdentityId', 'newParticipantEvidenceId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteIntakeDirectEntryDraftEffectIds);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('intake_direct_entry_draft_transaction_required');
    }
    if (!sameReference(capability, SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY)
        || context.operation.name !== SUBMISSION_DIRECT_ENTRY_DRAFT_OPERATION.name
        || context.operation.version !== SUBMISSION_DIRECT_ENTRY_DRAFT_OPERATION.version
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !draftExactSubjects(context, context.scope.eventId)) {
      throw new TypeError('intake_direct_entry_draft_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !sameReference(authority.lane.policy, SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) throw new TypeError('intake_direct_entry_draft_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    this.clearTransient();
    if (context.scope.eventId === undefined) {
      return sealIntakePreparation({
        capability,
        context,
        preparation: { prepare: ({ context: received }) => {
          if (received !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('intake_direct_entry_draft_context_substitution');
          }
          this.#nonterminalContext = context;
          return eventRequiredContribution();
        } }
      });
    }
    const eventId = context.scope.eventId;
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite,
      workspaceId: this.input.workspaceId,
      eventId,
      userId: actorUserId,
      evaluatedAt
    });
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (relationship.kind !== 'valid'
        || current?.currentEvent?.id !== eventId
        || current.currentEvent.workspaceId !== this.input.workspaceId) {
      throw new TypeError('intake_direct_entry_draft_event_relationship_mismatch');
    }
    const scope: IntakeScopeDto = { workspaceId: this.input.workspaceId, eventId };
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort: <Port>(key: ChangesetReadPortKey<Port>): Port => {
        if ((key as unknown) === submissionDirectEntryChangesetReadPort) {
          return this.input.repository as unknown as Port;
        }
        if ((key as unknown) === submissionDirectEntryPlanningAttributionReadPort) {
          return Object.freeze({
            readSubmissionDirectEntryPlanningAttribution: () =>
              Object.freeze({ context, authorityRecheck })
          }) as unknown as Port;
        }
        throw new TypeError('intake_direct_entry_draft_undeclared_read_port');
      }
    });
    return sealIntakePreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('intake_direct_entry_draft_context_substitution');
        }
        const wire = submissionDirectEntryDraftInputSchema.parse(businessInput);
        const rawBuffers: Uint8Array[] = [];
        this.input.sqlite.exec('SAVEPOINT intake_direct_entry_prepare');
        try {
          const formHead = this.input.repository.readFormHead(scope, wire.formId);
          if (!formHead) throw new SQLiteIntakeDirectEntryRefusal('form_missing');
          if (formHead.status !== 'open' || formHead.currentPublishedVersionId === null) {
            throw new ApplicationPlanningError('form_not_open');
          }
          const formVersion = this.input.repository.readFormVersion(
            scope, formHead.currentPublishedVersionId
          );
          if (!formVersion) throw new ApplicationPlanningError('form_version_mismatch');
          const identities = {
            submissionId: this.fresh(this.#ids.newSubmissionId),
            entryEvidenceId: this.fresh(this.#ids.newEntryEvidenceId),
            personId: this.fresh(this.#ids.newPersonId),
            participantIdentityId: this.fresh(this.#ids.newParticipantIdentityId),
            participantEvidenceId: this.fresh(this.#ids.newParticipantEvidenceId)
          };
          const prepared = prepareApplicationAnswers({
            answers: wire.answers,
            formVersion,
            optionSource: this.input.repository,
            mode: 'direct_entry',
            owner: submissionDirectEntryAnswerOwner({
              scope: formVersion.scope,
              submissionId: identities.submissionId,
              entryEvidenceId: identities.entryEvidenceId,
              enteredByUserId: actorUserId
            })
          });
          const adoptions = prepared.payloads.map((payload) => {
            rawBuffers.push(payload.bytes);
            this.#pendingBuffers.add(payload.bytes);
            return adoptSynchronousClassifiedPayload({
              store: this.input.classifiedStore,
              put: {
                payloadRefId: parsePayloadRefId(this.fresh(this.#ids.newPayloadRefId)),
                binding: {
                  profiles: this.input.classifiedProfiles,
                  scopeBinding: payload.binding.scopeBinding,
                  contentType: payload.binding.contentType
                },
                purpose: payload.binding.profileKey,
                bytes: payload.bytes,
                createdAt: parseInstant(evaluatedAt)
              }
            });
          });
          const answers = finalizeGovernedAnswerIndex({
            prepared,
            adoptions,
            expectedStore: this.input.classifiedStore,
            expectedProfiles: this.input.classifiedProfiles
          });
          const author: SubmissionDirectEntryChangesetAuthorInput = {
            action: 'create',
            scope,
            formId: wire.formId,
            expectedFormDefinitionVersion: wire.expectedFormDefinitionVersion,
            answers,
            identities,
            requestDigestSha256: context.requestBinding.requestHashSha256
          };
          const changesetId = this.fresh(this.#ids.newChangesetId);
          const revisionId = this.fresh(this.#ids.newRevisionId);
          const handle = this.fresh(this.#ids.newPreparationHandle);
          const timelineId = this.fresh(this.#ids.newTimelineId);
          const appended = appendChangesetDraftSynchronous({
            store: this.#changesets,
            registry: this.#bundle.registry,
            snapshot,
            ids: {
              newChangesetId: () => changesetId,
              newRevisionId: () => revisionId,
              newApprovalId: () => {
                throw new TypeError('approval_id_unavailable_during_draft');
              },
              newCorrectionAttemptId: () => {
                throw new TypeError('correction_id_unavailable_during_draft');
              }
            },
            context: {
              workspaceId: this.input.workspaceId,
              eventId,
              principalKey: `workspace_user:${actorUserId}`,
              authorityPrincipalKey: context.authorityPrincipalKey,
              evaluatedAt
            },
            operations: [{
              kind: SUBMISSION_DIRECT_ENTRY_CHANGESET_KIND,
              version: SUBMISSION_DIRECT_ENTRY_CHANGESET_VERSION,
              dependencyGroup: 'submission_direct_entry',
              authorInput: author
            }],
            dependencyGroups: [{ key: 'submission_direct_entry', dependsOn: [] }],
            approvalPolicy: captureSubmissionDirectEntryApprovalPolicy({
              policy: this.input.policy
            }),
            origin: 'human_ui'
          });
          if (appended.kind === 'refused') {
            if (appended.refusal.kind !== 'id_collision') {
              throw new TypeError('intake_direct_entry_draft_unexpected_lifecycle_refusal');
            }
            throw new SQLiteIntakeDirectEntryDraftIdCollision();
          }
          const revision = appended.record.revisions[0];
          const operation = revision?.revision.operations[0];
          if (!revision || !operation
              || appended.record.revisions.length !== 1
              || revision.revision.operations.length !== 1) {
            throw new TypeError('intake_direct_entry_draft_record_incoherent');
          }
          const safeDiff = submissionDirectEntrySafeDiffSchema.parse(operation.safeDiff);
          const candidate = submissionDirectEntryDraftContributionSchema.parse({
            result: { kind: 'success', data: {
              schemaVersion: 1,
              action: 'create',
              changesetId,
              headVersion: appended.record.head.version,
              status: appended.record.head.status,
              revision: {
                id: revision.revision.id,
                number: revision.revision.number,
                digestSha256: revision.revision.digest
              },
              riskTier: revision.revision.riskTier,
              approvalPolicy: revision.approvalPolicy,
              safeDiff
            } },
            domain: {
              kind: 'submission_direct_entry_changeset_draft',
              preparationHandle: handle,
              workspaceId: this.input.workspaceId,
              eventId,
              action: 'create',
              submissionId: safeDiff.submission.id,
              changesetId,
              revisionId,
              revisionDigestSha256: revision.revision.digest,
              recordDigestSha256: appended.record.recordDigestSha256,
              occurredAt: evaluatedAt
            },
            receiptChildren: [{
              kind: 'timeline',
              timelineId,
              sourceKind: 'changeset_revision',
              workspaceId: this.input.workspaceId,
              eventId,
              changesetId,
              revisionId,
              occurredAt: evaluatedAt
            }]
          });
          if (candidate.result.kind !== 'success' || candidate.domain === null) {
            throw new TypeError('intake_direct_entry_draft_success_contribution_invalid');
          }
          const contribution = candidate as DraftSuccess;
          this.#prepared.set(handle, {
            handle,
            context,
            workspaceId: this.input.workspaceId,
            eventId,
            contribution,
            phase: 'prepared'
          });
          this.input.sqlite.exec('RELEASE SAVEPOINT intake_direct_entry_prepare');
          return contribution;
        } catch (error) {
          this.input.sqlite.exec('ROLLBACK TO SAVEPOINT intake_direct_entry_prepare');
          this.input.sqlite.exec('RELEASE SAVEPOINT intake_direct_entry_prepare');
          rawBuffers.forEach((buffer) => buffer.fill(0));
          if (error instanceof SQLiteIntakeDirectEntryDraftIdCollision) {
            this.#nonterminalContext = context;
            return collisionContribution();
          }
          if (error instanceof SQLiteIntakeDirectEntryRefusal) {
            this.#nonterminalContext = context;
            return planningRefusalContribution(error.code, wire.formId);
          }
          if (error instanceof ApplicationPlanningError
              || error instanceof ApplicationAnswerError) {
            this.#nonterminalContext = context;
            return planningRefusalContribution(planningRefusalCode(error), wire.formId);
          }
          throw error;
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('intake_direct_entry_draft_transaction_required');
    }
    const parsed = submissionDirectEntryDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    const stored = prepared ? this.#changesets.read(parsed.changesetId) : undefined;
    if (!prepared || prepared.phase !== 'prepared' || !stored
        || stored.recordDigestSha256 !== parsed.recordDigestSha256
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('intake_direct_entry_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== active.context.operation.name
        || receipt.ref.operationVersion !== active.context.operation.version) {
      throw new TypeError('intake_direct_entry_draft_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    const domain = active.contribution.domain;
    this.input.sqlite.query(`
      INSERT INTO intake_direct_entry_draft_receipt_links (
        receipt_id, workspace_id, event_id, submission_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, active.workspaceId, active.eventId, domain.submissionId,
      domain.changesetId, domain.revisionId,
      domain.revisionDigestSha256, domain.recordDigestSha256, domain.action,
      active.context.operation.name, active.context.operation.version,
      Date.parse(domain.occurredAt)
    );
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || active.receiptId !== receiptId || !this.#expectedIdentity) {
      throw new TypeError('intake_direct_entry_draft_receipt_parent_missing');
    }
    const child = submissionDirectEntryDraftEvidenceChildSchema.parse(contribution);
    if (canonicalJsonText(child) !== canonicalJsonText(active.contribution.receiptChildren[0])) {
      throw new TypeError('intake_direct_entry_draft_evidence_mismatch');
    }
    this.input.sqlite.query(`
      INSERT INTO intake_direct_entry_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id,
        changeset_id, revision_id, occurred_at_ms, source_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      child.timelineId, receiptId, child.workspaceId, child.eventId,
      child.changesetId, child.revisionId, Date.parse(parseInstant(child.occurredAt)),
      child.sourceKind
    );
    active.phase = 'evidence_complete';
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('intake_direct_entry_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      if (!this.#nonterminalContext
          || !effectOperationIdentityMatchesContext(identity, this.#nonterminalContext)) {
        throw new TypeError('intake_direct_entry_draft_incomplete');
      }
      this.#nonterminalContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete'
        || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('intake_direct_entry_draft_incomplete');
    }
    active.phase = 'claim_released';
  }

  afterUnitOfWorkCommitted(): void { this.clearTransient(); }
  afterUnitOfWorkFinished(): void { this.clearTransient(); }

  private fresh(factory: () => string): string {
    const value = factory();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)) throw new TypeError('intake_direct_entry_draft_id_invalid');
    const canonical = value.toLowerCase();
    if (this.#issuedIds.has(canonical)) {
      throw new TypeError('intake_direct_entry_draft_ids_not_unique');
    }
    this.#issuedIds.add(canonical);
    return canonical;
  }

  private clearTransient(): void {
    for (const buffer of this.#pendingBuffers) buffer.fill(0);
    this.#pendingBuffers.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalContext = undefined;
    this.#prepared.clear();
  }
}

class SQLiteIntakeDirectEntryDraftIdCollision extends Error {
  constructor() {
    super('changeset_id_collision');
    this.name = 'SQLiteIntakeDirectEntryDraftIdCollision';
  }
}

class SQLiteIntakeDirectEntryRefusal extends Error {
  constructor(readonly code: SubmissionDirectEntryRefusalCode) {
    super(code);
    this.name = 'SQLiteIntakeDirectEntryRefusal';
  }
}

export function createSQLiteIntakeDirectEntryDraftEffectDomainRegistration(input:
  ConstructorParameters<typeof SQLiteIntakeDirectEntryDraftEffectDomainAdapter>[0]
): {
  readonly capability: typeof SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY;
  readonly adapter: SQLiteIntakeDirectEntryDraftEffectDomainAdapter;
} {
  return Object.freeze({
    capability: SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY,
    adapter: new SQLiteIntakeDirectEntryDraftEffectDomainAdapter(input)
  });
}

export interface SQLiteIntakeDirectEntryChangesetEffectIds extends ChangesetLifecycleIds {
  newPreparationHandle(): string;
  newTimelineId(): string;
  newFactId(): string;
  newPointerId(): string;
}

type LifecycleSuccess = Extract<
  ChangesetLifecycleContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedLifecycle {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly action: Exclude<ChangesetLifecycleAction, 'approve'>;
  readonly eventId: EventId;
  readonly evaluatedAt: Instant;
  readonly record: StoredChangesetRecord;
  readonly contribution: LifecycleSuccess;
  readonly exactCommit?: ExactStoredChangesetCommit;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete';
  receiptId?: string;
  nextChild: number;
}

function timelineSource(action: Exclude<ChangesetLifecycleAction, 'approve'>) {
  return ({
    propose: 'changeset_proposal',
    rebuild: 'changeset_rebuild',
    correction: 'changeset_correction',
    commit: 'changeset_commit'
  } as const)[action];
}

function lifecycleExactSubjects(context: EffectInvocationContext, eventId: EventId): boolean {
  return context.scope.eventId === eventId
    && context.scope.subjects.length === 3
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId
    )
    && context.scope.subjects.some((subject) =>
      subject.kind === 'domain'
      && subject.domain === 'changeset'
      && subject.entity === 'owner'
      && subject.id === SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID
      && subject.version === undefined
    );
}

function refusalContribution(
  refusal: ChangesetLifecycleRefusal | { readonly kind: 'domain_changed' }
) {
  return changesetLifecycleContributionSchema.parse({
    result: { kind: 'outcome', outcome: changesetLifecycleRefusalOutcome(refusal) },
    domain: null,
    receiptChildren: []
  });
}

/** Changeset-lifecycle owner adapter that commits direct entries atomically. */
export class SQLiteIntakeDirectEntryChangesetEffectDomainAdapter
implements SQLiteEffectDomainAdapter, ChangesetLifecycleOwnerResolutionSource {
  readonly lifecycleStore: SQLiteChangesetLifecycleStore;
  readonly subjectRelationships: SQLiteOperatorSubjectRelationshipSource;
  readonly #bundle: SubmissionDirectEntryChangesetBundle;
  readonly #policy: SubmissionDirectEntryChangesetPolicy;
  readonly #ids: SQLiteIntakeDirectEntryChangesetEffectIds;
  readonly #issuedIds = new Set<string>();
  readonly #prepared = new Map<string, PreparedLifecycle>();
  #active: PreparedLifecycle | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: SubmissionDirectEntryChangesetPolicy;
    readonly repository: SQLiteIntakeRepository;
    readonly projection: SQLiteIntakeClassifiedProjection;
    readonly submissionTriage: SubmissionTriageInitializationPort;
    readonly references: readonly SQLiteSubmissionReferenceSource[];
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteIntakeDirectEntryChangesetEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    assertSubmissionDirectEntryChangesetPolicy(input.policy);
    if (typeof input.submissionTriage?.initializeWithinTransaction !== 'function') {
      throw new TypeError('intake_direct_entry_submission_triage_invalid');
    }
    for (const source of input.references) {
      if (typeof source?.countSubmissionReferences !== 'function') {
        throw new TypeError('intake_direct_entry_reference_source_invalid');
      }
    }
    this.#policy = input.policy;
    this.#bundle = createSubmissionDirectEntryChangesetBundle({ policy: input.policy });
    assertSubmissionDirectEntryChangesetBundle(this.#bundle);
    this.lifecycleStore = new SQLiteChangesetLifecycleStore(
      input.sqlite,
      terminalReceiptSource(input.sqlite)
    );
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newApprovalId', 'newCorrectionAttemptId',
      'newPreparationHandle', 'newTimelineId', 'newFactId', 'newPointerId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('intake_direct_entry_changeset_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newApprovalId', 'newCorrectionAttemptId',
        'newPreparationHandle', 'newTimelineId', 'newFactId', 'newPointerId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteIntakeDirectEntryChangesetEffectIds);
    this.subjectRelationships = Object.freeze({
      validateSubject: ({
        sqlite, workspaceId, eventId, subject
      }: Parameters<SQLiteOperatorSubjectRelationshipSource['validateSubject']>[0]) => {
        if (sqlite !== this.input.sqlite
            || workspaceId !== this.input.workspaceId
            || eventId === undefined
            || subject.kind !== 'domain'
            || subject.domain !== 'changeset'
            || subject.entity !== 'owner'
            || subject.id !== SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID
            || subject.version !== undefined) {
          return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
        }
        const rows = sqlite.query<{ readonly event_id: string }, [string, string]>(`
          SELECT event_id FROM event_spine_scope_roots
           WHERE workspace_id = ? AND event_id = ?
           LIMIT 2
        `).all(workspaceId, eventId);
        return rows.length === 1 && rows[0]?.event_id === eventId
          ? Object.freeze({
              kind: 'valid' as const,
              evidenceIds: Object.freeze([
                `changeset-owner:${SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID}:${eventId}:${this.#bundle.registry.registryDigestSha256}`
              ])
            })
          : Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
    });
  }

  resolveOwner(record: StoredChangesetRecord): ChangesetLifecycleOwnerResolution | undefined {
    if (!this.ownsRecord(record)) return undefined;
    return Object.freeze({
      id: SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID,
      evidenceIds: Object.freeze([
        `submission-direct-entry-definition:${this.#bundle.registry.registryDigestSha256}`
      ])
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('intake_direct_entry_changeset_transaction_required');
    }
    if (!sameReference(capability, CHANGESET_LIFECYCLE_HANDLER_CAPABILITY)) {
      throw new TypeError('intake_direct_entry_changeset_capability_mismatch');
    }
    const rawAction = changesetLifecycleActionForOperation(
      context.operation.name, context.operation.version
    );
    if (rawAction === 'approve') {
      throw new TypeError('intake_direct_entry_changeset_approval_not_mounted');
    }
    const action = rawAction;
    const expectedEffect = action === 'propose' || action === 'rebuild' || action === 'correction'
      ? 'draft'
      : 'commit';
    if (action === undefined
        || context.operation.effect !== expectedEffect
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || context.scope.eventId === undefined
        || !lifecycleExactSubjects(context, context.scope.eventId)) {
      throw new TypeError('intake_direct_entry_changeset_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || authority.scope.workspaceId !== this.input.workspaceId
        || authority.scope.eventId !== context.scope.eventId
        || !sameReference(authority.lane.policy, CHANGESET_LIFECYCLE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) throw new TypeError('intake_direct_entry_changeset_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite,
      workspaceId: this.input.workspaceId,
      eventId,
      userId: actorUserId,
      evaluatedAt
    });
    const subjectRelationship = this.subjectRelationships.validateSubject({
      sqlite: this.input.sqlite,
      workspaceId: this.input.workspaceId,
      eventId,
      userId: actorUserId,
      subject: {
        kind: 'domain', domain: 'changeset', entity: 'owner',
        id: SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID
      },
      evaluatedAt
    });
    if (relationship.kind !== 'valid' || subjectRelationship.kind !== 'valid') {
      throw new TypeError('intake_direct_entry_changeset_relationship_mismatch');
    }
    this.clearTransient();
    return sealChangesetLifecyclePreparation({
      capability,
      context,
      preparation: Object.freeze({
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }:
          Parameters<ChangesetLifecyclePreparation['prepare']>[0]) => {
          if (receivedAction !== action || receivedContext !== context
              || !this.input.sqlite.inTransaction) {
            throw new TypeError('intake_direct_entry_changeset_context_substitution');
          }
          return this.prepare({
            action, businessInput, context, authorityRecheck, eventId, actorUserId, evaluatedAt
          });
        }
      })
    });
  }

  private prepare(input: {
    readonly action: Exclude<ChangesetLifecycleAction, 'approve'>;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    readonly authorityRecheck: SealedEffectAuthorityRecheckResult;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
  }): ChangesetLifecycleContribution {
    const actorContext = Object.freeze({
      workspaceId: this.input.workspaceId,
      eventId: input.eventId,
      principalKey: `workspace_user:${input.actorUserId}`,
      authorityPrincipalKey: input.context.authorityPrincipalKey,
      evaluatedAt: input.evaluatedAt
    });
    const ids: ChangesetLifecycleIds = Object.freeze({
      newChangesetId: () => this.nextId('newChangesetId'),
      newRevisionId: () => this.nextId('newRevisionId'),
      newApprovalId: () => this.nextId('newApprovalId'),
      newCorrectionAttemptId: () => this.nextId('newCorrectionAttemptId')
    });
    let record: StoredChangesetRecord;
    let data: Record<string, unknown>;
    let exactCommit: ExactStoredChangesetCommit | undefined;
    let factPayload: unknown;

    if (input.action === 'propose') {
      const wire = proposeChangesetInputSchema.parse(input.businessInput);
      if (!this.exactRecord(wire.changesetId, input.eventId)) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      const result = proposeStoredChangeset({
        store: this.lifecycleStore, context: actorContext, ...wire
      });
      if (result.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(result.refusal);
      }
      record = result.record;
      const diff = projectStoredChangesetDiff(record, wire.revisionId, wire.revisionDigest);
      if (!diff) throw new TypeError('intake_direct_entry_changeset_proposal_diff_missing');
      data = { schemaVersion: 1, action: 'propose', diff };
    } else if (input.action === 'rebuild') {
      const wire = rebuildChangesetInputSchema.parse(input.businessInput);
      const current = this.exactRecord(wire.changesetId, input.eventId);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      const result = rebuildStoredChangesetSynchronous({
        store: this.lifecycleStore,
        registry: this.#bundle.registry,
        snapshot: this.planningSnapshot(input.context, input.authorityRecheck),
        ids,
        context: actorContext,
        changesetId: wire.changesetId,
        expectedHeadVersion: wire.expectedHeadVersion,
        sourceRevisionId: wire.sourceRevisionId,
        sourceRevisionDigest: wire.sourceRevisionDigest,
        groups: wire.groups,
        approvalPolicy: captureSubmissionDirectEntryApprovalPolicy({ policy: this.#policy })
      });
      if (result.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(result.refusal);
      }
      record = result.record;
      const revision = record.revisions.at(-1)!.revision;
      const diff = projectStoredChangesetDiff(record, revision.id, revision.digest);
      if (!diff) throw new TypeError('intake_direct_entry_changeset_rebuild_diff_missing');
      data = {
        schemaVersion: 1,
        action: 'rebuild',
        sourceRevisionId: wire.sourceRevisionId,
        sourceRevisionDigest: wire.sourceRevisionDigest,
        diff
      };
    } else if (input.action === 'correction') {
      const wire = draftChangesetCorrectionInputSchema.parse(input.businessInput);
      const current = this.exactRecord(wire.sourceChangesetId, input.eventId);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      const result = draftChangesetCorrectionSynchronous({
        store: this.lifecycleStore,
        registry: this.#bundle.registry,
        snapshot: this.planningSnapshot(input.context, input.authorityRecheck),
        ids,
        context: actorContext,
        ...wire,
        approvalPolicy: captureSubmissionDirectEntryApprovalPolicy({ policy: this.#policy })
      });
      if (result.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(result.refusal);
      }
      record = result.record ?? current;
      const target = result.record === null
        ? null
        : projectStoredChangesetDiff(
            result.record,
            result.record.revisions.at(-1)!.revision.id,
            result.record.revisions.at(-1)!.revision.digest
          );
      if (result.record !== null && !target) {
        throw new TypeError('intake_direct_entry_changeset_correction_diff_missing');
      }
      data = {
        schemaVersion: 1,
        action: 'correction',
        sourceChangesetId: wire.sourceChangesetId,
        sourceRevisionId: wire.sourceRevisionId,
        sourceRevisionDigest: wire.sourceRevisionDigest,
        resultKind: result.kind,
        target,
        evidence: result.link.evidence
      };
    } else {
      const wire = commitChangesetInputSchema.parse(input.businessInput);
      const current = this.exactRecord(wire.changesetId, input.eventId);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      const evidence = this.currentCommitEvidence(current);
      const validation = validateStoredChangesetCommit({
        store: this.lifecycleStore,
        context: actorContext,
        ...wire,
        currentApprovalPolicy: captureSubmissionDirectEntryApprovalPolicy({
          policy: this.#policy
        }),
        currentAggregateVersions: evidence.aggregateVersions,
        currentGuardVersions: evidence.guardVersions,
        currentGuardDigests: evidence.guardDigests,
        approverCurrentlyAuthorized: () => false,
        receiptExpectation: {
          operation: COMMIT_CHANGESET_OPERATION,
          surface: input.context.surface,
          scopePartitionKey: input.context.requestBinding.scopePartitionKey,
          authorityPrincipalKey: input.context.authorityPrincipalKey,
          requestHashSha256: input.context.requestBinding.requestHashSha256
        }
      });
      if (validation.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(validation.refusal);
      }
      const prepared = prepareChangesetCommitSynchronous({
        registry: this.#bundle.registry,
        authorization: validation.commit.authorization,
        transaction: this.commitTransaction()
      });
      if (prepared.kind === 'outcome') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'domain_changed' });
      }
      const applied = applyPreparedChangesetSynchronous(prepared.prepared);
      exactCommit = validation.commit;
      record = current;
      factPayload = {
        changesetId: wire.changesetId,
        revisionId: wire.revisionId,
        revisionDigest: wire.revisionDigest,
        contributions: applied.map((contribution) => ({
          result: contribution.result,
          facts: contribution.facts
        }))
      };
      data = {
        schemaVersion: 1,
        action: 'commit',
        changesetId: wire.changesetId,
        expectedHeadVersion: wire.expectedHeadVersion,
        committedHeadVersion: wire.expectedHeadVersion + 1,
        revisionId: wire.revisionId,
        revisionDigest: wire.revisionDigest
      };
    }

    const revision = input.action === 'correction' && data.target === null
      ? record.revisions.find((candidate) => candidate.revision.id === data.sourceRevisionId)
      : record.revisions.at(-1);
    if (!revision) throw new TypeError('intake_direct_entry_changeset_revision_missing');
    const handle = this.nextId('newPreparationHandle');
    const timelineId = this.nextId('newTimelineId');
    const domain = {
      kind: 'changeset_lifecycle',
      action: input.action,
      preparationHandle: handle,
      workspaceId: this.input.workspaceId,
      eventId: input.eventId,
      changesetId: record.head.id,
      revisionId: revision.revision.id,
      revisionDigest: revision.revision.digest,
      contributionDigestSha256: canonicalJsonSha256Text({ action: input.action, data }),
      occurredAt: input.evaluatedAt
    };
    const timeline = {
      kind: 'timeline',
      timelineId,
      sourceKind: timelineSource(input.action),
      workspaceId: this.input.workspaceId,
      eventId: input.eventId,
      changesetId: record.head.id,
      revisionId: revision.revision.id,
      occurredAt: input.evaluatedAt
    };
    const receiptChildren = input.action === 'commit'
      ? [{
          kind: 'domain_fact',
          factId: this.nextId('newFactId'),
          factKind: 'submission_created',
          factVersion: 1,
          workspaceId: this.input.workspaceId,
          eventId: input.eventId,
          changesetId: record.head.id,
          revisionId: revision.revision.id,
          payload: factPayload
        }, {
          kind: 'outbox_pointer',
          pointerId: this.nextId('newPointerId'),
          sourceKind: 'domain_fact',
          factId: ''
        }, timeline]
      : [timeline];
    if (input.action === 'commit') {
      (receiptChildren[1] as { factId: string }).factId =
        (receiptChildren[0] as { factId: string }).factId;
    }
    const candidate = changesetLifecycleContributionSchema.parse({
      result: { kind: 'success', data },
      domain,
      receiptChildren
    });
    if (candidate.result.kind !== 'success' || candidate.domain === null) {
      throw new TypeError('intake_direct_entry_changeset_success_contribution_invalid');
    }
    const contribution = candidate as LifecycleSuccess;
    this.#prepared.set(handle, {
      handle,
      context: input.context,
      action: input.action,
      eventId: input.eventId,
      evaluatedAt: input.evaluatedAt,
      record,
      contribution,
      ...(exactCommit === undefined ? {} : { exactCommit }),
      phase: 'prepared',
      nextChild: 0
    });
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('intake_direct_entry_changeset_transaction_required');
    }
    const parsed = changesetLifecycleDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('intake_direct_entry_changeset_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = changesetLifecycleOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== active.context.operation.name
        || receipt.ref.operationVersion !== active.context.operation.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('intake_direct_entry_changeset_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    let record = active.record;
    if (active.action === 'commit') {
      if (!active.exactCommit) throw new TypeError('intake_direct_entry_changeset_commit_missing');
      record = commitStoredChangeset({
        store: this.lifecycleStore,
        commit: active.exactCommit,
        terminalReceipt: parseChangesetCommitTerminalReceipt(receipt)
      }).record;
    }
    const domain = active.contribution.domain;
    this.input.sqlite.query<never, [
      string, string, string, number, string, string, string, string, string, string, number
    ]>(`
      INSERT INTO intake_direct_entry_changeset_receipt_links (
        receipt_id, action, operation_name, operation_version,
        workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      active.action,
      active.context.operation.name,
      active.context.operation.version,
      this.input.workspaceId,
      active.eventId,
      domain.changesetId,
      domain.revisionId,
      domain.revisionDigest,
      record.recordDigestSha256,
      Date.parse(active.evaluatedAt)
    );
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || !this.#expectedIdentity || active.receiptId !== receiptId) {
      throw new TypeError('intake_direct_entry_changeset_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[active.nextChild];
    if (!expected || canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('intake_direct_entry_changeset_evidence_mismatch');
    }
    if ((contribution as { readonly kind?: unknown }).kind === 'domain_fact') {
      const child = eventChangesetDomainFactEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query<never, [
        string, string, string, string, string, string, string, number, string
      ]>(`
        INSERT INTO intake_direct_entry_changeset_domain_facts (
          fact_id, receipt_id, workspace_id, event_id, changeset_id, revision_id,
          fact_kind, fact_version, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.factId, receiptId, child.workspaceId, child.eventId,
        child.changesetId, child.revisionId, child.factKind, child.factVersion,
        canonicalJsonText(child.payload)
      );
    } else if ((contribution as { readonly kind?: unknown }).kind === 'outbox_pointer') {
      const child = changesetOutboxEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query<never, [string, string, string, string]>(`
        INSERT INTO intake_direct_entry_changeset_outbox_pointers (
          pointer_id, receipt_id, fact_id, source_kind
        ) VALUES (?, ?, ?, ?)
      `).run(child.pointerId, receiptId, child.factId, child.sourceKind);
    } else {
      const child = eventChangesetTimelineEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query<never, [
        string, string, string, string, string, string, string, number
      ]>(`
        INSERT INTO intake_direct_entry_changeset_timeline (
          timeline_id, receipt_id, source_kind, workspace_id, event_id,
          changeset_id, revision_id, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.timelineId, receiptId, child.sourceKind, child.workspaceId,
        child.eventId, child.changesetId, child.revisionId,
        Date.parse(parseInstant(child.occurredAt))
      );
    }
    active.nextChild += 1;
    if (active.nextChild === active.contribution.receiptChildren.length) {
      active.phase = 'evidence_complete';
    }
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('intake_direct_entry_changeset_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('intake_direct_entry_changeset_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('intake_direct_entry_changeset_incomplete');
    }
  }

  afterUnitOfWorkCommitted(): void { this.clearTransient(); }
  afterUnitOfWorkFinished(): void { this.clearTransient(); }

  private clearTransient(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }

  private nextId(method: keyof SQLiteIntakeDirectEntryChangesetEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) {
      throw new TypeError('intake_direct_entry_changeset_ids_not_unique');
    }
    this.#issuedIds.add(value);
    return value;
  }

  private readPort() {
    const repository = this.input.repository;
    return Object.freeze({
      readFormHead: repository.readFormHead.bind(repository),
      readFormVersion: repository.readFormVersion.bind(repository),
      resolveActiveCategory: repository.resolveActiveCategory.bind(repository),
      resolveCollectingSession: repository.resolveCollectingSession.bind(repository),
      resolveCurrentDeadline: repository.resolveCurrentDeadline.bind(repository),
      readLiveOptions: repository.readLiveOptions.bind(repository)
    });
  }

  private referencePort() {
    const repository = this.input.repository;
    const sources = this.input.references;
    return Object.freeze({
      readCurrentEntryRecordDigest: (scope: IntakeScopeDto, submissionId: string) => {
        const head = repository.readSubmissionHead(scope, submissionId);
        if (!head || head.source !== 'direct_entry') return undefined;
        const evidence = repository.readDirectEntryEvidence(scope, submissionId);
        if (!evidence) return undefined;
        return submissionDirectEntryRecordDigest({ submission: head, entryEvidence: evidence });
      },
      countSubmissionReferences: (scope: IntakeScopeDto, submissionId: string) => {
        let total = 0;
        for (const source of sources) {
          const value = source.countSubmissionReferences(scope, submissionId);
          if (!Number.isSafeInteger(value) || value < 0) {
            throw new TypeError('intake_direct_entry_reference_census_invalid');
          }
          total += value;
        }
        return total;
      }
    });
  }

  private planningSnapshot(
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): ChangesetPlanningSnapshot {
    const expectedScope = Object.freeze({
      workspaceId: this.input.workspaceId,
      eventId: context.scope.eventId
    });
    const readPort = this.readPort();
    const referencePort = this.referencePort();
    return Object.freeze({
      getPort: <Port>(key: ChangesetReadPortKey<Port>): Port => {
        if ((key as unknown) === submissionDirectEntryChangesetReadPort) {
          return readPort as unknown as Port;
        }
        if ((key as unknown) === submissionDirectEntryReferenceReadPort) {
          return referencePort as unknown as Port;
        }
        if ((key as unknown) === submissionDirectEntryPlanningAttributionReadPort) {
          return Object.freeze({
            readSubmissionDirectEntryPlanningAttribution(scope: {
              readonly workspaceId: string;
              readonly eventId: string;
            }) {
              return scope.workspaceId === expectedScope.workspaceId
                && scope.eventId === expectedScope.eventId
                ? Object.freeze({ context, authorityRecheck })
                : undefined;
            }
          }) as unknown as Port;
        }
        throw new TypeError('intake_direct_entry_changeset_undeclared_read_port');
      }
    });
  }

  private commitTransaction(): ChangesetCommitTransaction {
    const validationPort: SubmissionDirectEntryValidationPort = Object.freeze({
      ...this.readPort(),
      payloadReferences: this.input.projection
    });
    const repository = this.input.repository;
    const projection = this.input.projection;
    const submissionTriage = this.input.submissionTriage;
    const transactionPort = Object.freeze({
      applyDirectEntryPlan: (planInput: ApplicationDirectEntryPlan): SubmissionDirectEntryResultDto => {
        const plan = parseApplicationDirectEntryPlan(planInput);
        repository.applyApplicationMutation(plan, projection);
        const initialized = submissionTriage.initializeWithinTransaction({
          scope: plan.submission.scope,
          submission: {
            id: plan.submission.id,
            formId: plan.submission.formId,
            formVersionId: plan.submission.formVersionId,
            source: 'direct_entry',
            submittedAt: plan.submission.submittedAt
          },
          recordedAt: plan.submission.submittedAt,
          closeEvidence: plan.closeEvidence
        });
        if (initialized.submissionId !== plan.submission.id) {
          throw new TypeError('intake_direct_entry_submission_triage_mismatch');
        }
        return submissionDirectEntryResultSchema.parse({
          schemaVersion: 1,
          submissionId: plan.submission.id,
          formId: plan.submission.formId,
          formVersionId: plan.submission.formVersionId,
          source: 'direct_entry',
          submittedAt: plan.submission.submittedAt,
          triage: {
            queryGuard: {
              version: initialized.queryGuard.version,
              digestSha256: initialized.queryGuard.digestSha256
            },
            replay: initialized.replay
          },
          undo: {
            kind: 'submission_triage_discard_recoverable',
            submissionId: plan.submission.id
          }
        });
      }
    });
    return Object.freeze({
      getPort<Port>(key: ChangesetValidationPortKey<Port> | ChangesetTransactionPortKey<Port>): Port {
        if ((key as unknown) === submissionDirectEntryChangesetValidationPort) {
          return validationPort as unknown as Port;
        }
        if ((key as unknown) === submissionDirectEntryChangesetTransactionPort) {
          return transactionPort as unknown as Port;
        }
        throw new TypeError('intake_direct_entry_changeset_undeclared_transaction_port');
      }
    });
  }

  private currentCommitEvidence(record: StoredChangesetRecord) {
    const eventId = record.head.eventId;
    if (eventId === undefined) throw new TypeError('intake_direct_entry_changeset_event_required');
    const scope: IntakeScopeDto = {
      workspaceId: parseWorkspaceId(record.head.workspaceId),
      eventId: parseEventId(eventId)
    };
    const aggregateVersions = new Map<string, number>();
    const guardVersions = new Map<string, number>();
    const guardDigests = new Map<string, string>();
    for (const revision of record.revisions) {
      for (const operation of revision.revision.operations) {
        const plan = this.operationPlan(operation);
        if (!plan) continue;
        const head = this.input.repository.readFormHead(scope, plan.submission.formId);
        if (!head || head.currentPublishedVersionId === null) continue;
        const version = this.input.repository.readFormVersion(
          scope, head.currentPublishedVersionId
        );
        if (!version) continue;
        aggregateVersions.set(`intake_form:${plan.submission.formId}`, head.version);
        guardVersions.set(
          `intake_form_current_version:${plan.submission.formId}`, head.version
        );
        guardDigests.set(
          `intake_form_current_version:${plan.submission.formId}`,
          createHash('sha256')
            .update(encodeCanonicalJson(parseFormVersion(version)))
            .digest('hex')
        );
      }
    }
    return Object.freeze({ aggregateVersions, guardVersions, guardDigests });
  }

  private operationPlan(
    operation: FrozenChangesetOperation
  ): ApplicationDirectEntryPlan | undefined {
    if (operation.kind !== SUBMISSION_DIRECT_ENTRY_CHANGESET_KIND
        || operation.version !== SUBMISSION_DIRECT_ENTRY_CHANGESET_VERSION) return undefined;
    const definition = this.#bundle.registry.get(operation.kind, operation.version);
    if (!definition
        || !sameSchemaReference(definition.schemas.plan, operation.planSchema)
        || !sameSchemaReference(definition.schemas.diff, operation.diffSchema)
        || !sameSchemaReference(definition.schemas.result, operation.resultSchema)) {
      return undefined;
    }
    try {
      return parseApplicationDirectEntryPlan(operation.plan);
    } catch {
      return undefined;
    }
  }

  private ownsRecord(record: StoredChangesetRecord): boolean {
    if (record.head.eventId === undefined || record.revisions.length === 0) return false;
    const expectedApproval = canonicalJsonText(
      captureSubmissionDirectEntryApprovalPolicy({ policy: this.#policy })
    );
    for (const revision of record.revisions) {
      if (revision.revision.operations.length === 0) return false;
      for (const operation of revision.revision.operations) {
        const plan = this.operationPlan(operation);
        if (!plan
            || plan.submission.scope.workspaceId !== record.head.workspaceId
            || plan.submission.scope.eventId !== record.head.eventId) return false;
      }
      if (canonicalJsonText(revision.approvalPolicy) !== expectedApproval) return false;
    }
    return true;
  }

  private exactRecord(changesetId: string, eventId: EventId): StoredChangesetRecord | undefined {
    const record = this.lifecycleStore.read(changesetId);
    return record
      && record.head.workspaceId === this.input.workspaceId
      && record.head.eventId === eventId
      && this.resolveOwner(record)?.id === SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID
      ? record
      : undefined;
  }
}

function canonicalJsonSha256Text(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

export function createSQLiteIntakeDirectEntryChangesetEffectDomainRegistration(input:
  ConstructorParameters<typeof SQLiteIntakeDirectEntryChangesetEffectDomainAdapter>[0]
) {
  const adapter = new SQLiteIntakeDirectEntryChangesetEffectDomainAdapter(input);
  return Object.freeze({
    ownerId: SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID,
    capability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
    adapter,
    lifecycleStore: adapter.lifecycleStore,
    ownerResolution: adapter as ChangesetLifecycleOwnerResolutionSource,
    subjectRelationships: adapter.subjectRelationships
  });
}
