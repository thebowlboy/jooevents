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
  applyPreparedChangesetSynchronous,
  canonicalJsonSha256,
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
  eventChangesetDomainFactEvidenceChildSchema,
  changesetLifecycleActionForOperation,
  changesetLifecycleContributionSchema,
  changesetLifecycleDomainContributionSchema,
  changesetLifecycleOperationResultSchema,
  changesetLifecycleRefusalOutcome,
  changesetOutboxEvidenceChildSchema,
  eventChangesetTimelineEvidenceChildSchema,
  commitChangesetInputSchema,
  commitStoredChangeset,
  draftChangesetCorrectionInputSchema,
  draftChangesetCorrectionSynchronous,
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
  canonicalJsonText,
  isApplicationId,
  parseEventId,
  parseInstant,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  SUBMISSION_TRIAGE_CHANGESET_KIND,
  SUBMISSION_TRIAGE_CHANGESET_VERSION,
  assertSubmissionTriageChangesetBundle,
  assertSubmissionTriageChangesetPolicy,
  captureSubmissionTriageApprovalPolicy,
  createSubmissionTriageChangesetBundle,
  parseSubmissionTriageTransitionPlan,
  submissionTriageAggregateId,
  submissionTriageQueryGuardId,
  submissionTriageChangesetReadPort,
  submissionTriageChangesetTransactionPort,
  submissionTriageChangesetValidationPort,
  submissionTriagePlanningAttributionReadPort,
  submissionTriageArrivalDigest,
  submissionArrivalGuardId,
  type SubmissionTriageTransitionPlan,
  type SubmissionTriageChangesetBundle,
  type SubmissionTriageChangesetPolicy
} from '@jooevents/submission-triage';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import {
  SQLiteChangesetLifecycleStore,
  type SQLiteChangesetTerminalReceiptSource
} from './changeset-lifecycle';
import type {
  SQLiteOperatorEventRelationshipSource,
  SQLiteOperatorSubjectRelationshipSource
} from './operator-authority-repositories';
import type { SQLiteSubmissionTriageRepository } from './submission-triage';

export const SUBMISSION_TRIAGE_CHANGESET_EFFECT_SQL = `
CREATE TABLE submission_triage_changeset_receipt_links (
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

CREATE TABLE submission_triage_changeset_domain_facts (
  fact_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  fact_kind TEXT NOT NULL CHECK(fact_kind = 'submission_triage_changed'),
  fact_version INTEGER NOT NULL CHECK(fact_version = 1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  FOREIGN KEY(receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES submission_triage_changeset_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(fact_id, receipt_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE submission_triage_changeset_outbox_pointers (
  pointer_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY(fact_id, receipt_id)
    REFERENCES submission_triage_changeset_domain_facts(fact_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE submission_triage_changeset_timeline (
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
    REFERENCES submission_triage_changeset_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER submission_triage_changeset_receipt_links_no_update
BEFORE UPDATE ON submission_triage_changeset_receipt_links
BEGIN SELECT RAISE(ABORT, 'submission triage changeset receipt links are immutable'); END;
CREATE TRIGGER submission_triage_changeset_receipt_links_no_delete
BEFORE DELETE ON submission_triage_changeset_receipt_links
BEGIN SELECT RAISE(ABORT, 'submission triage changeset receipt links are immutable'); END;
CREATE TRIGGER submission_triage_changeset_domain_facts_no_update
BEFORE UPDATE ON submission_triage_changeset_domain_facts
BEGIN SELECT RAISE(ABORT, 'submission triage changeset facts are immutable'); END;
CREATE TRIGGER submission_triage_changeset_domain_facts_no_delete
BEFORE DELETE ON submission_triage_changeset_domain_facts
BEGIN SELECT RAISE(ABORT, 'submission triage changeset facts are immutable'); END;
CREATE TRIGGER submission_triage_changeset_outbox_pointers_no_update
BEFORE UPDATE ON submission_triage_changeset_outbox_pointers
BEGIN SELECT RAISE(ABORT, 'submission triage changeset pointers are immutable'); END;
CREATE TRIGGER submission_triage_changeset_outbox_pointers_no_delete
BEFORE DELETE ON submission_triage_changeset_outbox_pointers
BEGIN SELECT RAISE(ABORT, 'submission triage changeset pointers are immutable'); END;
CREATE TRIGGER submission_triage_changeset_timeline_no_update
BEFORE UPDATE ON submission_triage_changeset_timeline
BEGIN SELECT RAISE(ABORT, 'submission triage changeset timeline is immutable'); END;
CREATE TRIGGER submission_triage_changeset_timeline_no_delete
BEFORE DELETE ON submission_triage_changeset_timeline
BEGIN SELECT RAISE(ABORT, 'submission triage changeset timeline is immutable'); END;
`;

export const SUBMISSION_TRIAGE_CHANGESET_OWNER_ID = 'submission_triage' as const;

export function installSQLiteSubmissionTriageChangesetEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('submission_triage_changeset_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SUBMISSION_TRIAGE_CHANGESET_EFFECT_SQL)).immediate();
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

export interface SQLiteSubmissionTriageChangesetEffectIds extends ChangesetLifecycleIds {
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

function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) {
    throw new TypeError(`submission_triage_changeset_${label}_invalid`);
  }
  return value;
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

function timelineSource(action: Exclude<ChangesetLifecycleAction, 'approve'>) {
  return ({
    propose: 'changeset_proposal',
    rebuild: 'changeset_rebuild',
    correction: 'changeset_correction',
    commit: 'changeset_commit'
  } as const)[action];
}

function exactSubjects(context: EffectInvocationContext, eventId: EventId): boolean {
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
      && subject.id === SUBMISSION_TRIAGE_CHANGESET_OWNER_ID
      && subject.version === undefined
    );
}

function operationPlan(input: {
  readonly bundle: SubmissionTriageChangesetBundle;
  readonly operation: FrozenChangesetOperation;
}): SubmissionTriageTransitionPlan | undefined {
  if (input.operation.kind !== SUBMISSION_TRIAGE_CHANGESET_KIND
      || input.operation.version !== SUBMISSION_TRIAGE_CHANGESET_VERSION) return undefined;
  const definition = input.bundle.registry.get(input.operation.kind, input.operation.version);
  if (!definition
      || !sameSchemaReference(definition.schemas.plan, input.operation.planSchema)
      || !sameSchemaReference(definition.schemas.diff, input.operation.diffSchema)
      || !sameSchemaReference(definition.schemas.result, input.operation.resultSchema)) return undefined;
  const schema = input.bundle.registry.getSchema(input.operation.planSchema);
  if (!schema) return undefined;
  try {
    return parseSubmissionTriageTransitionPlan(schema.schema.parse(input.operation.plan));
  } catch {
    return undefined;
  }
}

function triagePlan(input: {
  readonly bundle: SubmissionTriageChangesetBundle;
  readonly operation: FrozenChangesetOperation;
}): SubmissionTriageTransitionPlan | undefined {
  return operationPlan(input);
}

function currentTriageApprovalPolicy(input: {
  readonly bundle: SubmissionTriageChangesetBundle;
  readonly policy: SubmissionTriageChangesetPolicy;
  readonly operations: readonly FrozenChangesetOperation[];
}) {
  const actions = new Set(input.operations.map((operation) => {
    const plan = triagePlan({ bundle: input.bundle, operation });
    if (!plan) throw new TypeError('submission_triage_changeset_owner_mismatch');
    return plan.action;
  }));
  if (actions.size !== 1) throw new TypeError('submission_triage_changeset_mixed_actions');
  const action = actions.values().next().value;
  if (!action) throw new TypeError('submission_triage_changeset_revision_missing');
  return captureSubmissionTriageApprovalPolicy({ policy: input.policy, action });
}

function ownsTriageChangeset(input: {
  readonly bundle: SubmissionTriageChangesetBundle;
  readonly policy: SubmissionTriageChangesetPolicy;
  readonly record: StoredChangesetRecord;
}): boolean {
  if (input.record.head.eventId === undefined || input.record.revisions.length === 0) return false;
  for (const revision of input.record.revisions) {
    if (revision.revision.operations.length === 0) return false;
    for (const operation of revision.revision.operations) {
      const plan = triagePlan({ bundle: input.bundle, operation });
      if (!plan
          || plan.scope.workspaceId !== input.record.head.workspaceId
          || plan.scope.eventId !== input.record.head.eventId) return false;
    }
    try {
      if (canonicalJsonText(revision.approvalPolicy) !== canonicalJsonText(
        currentTriageApprovalPolicy({
          bundle: input.bundle,
          policy: input.policy,
          operations: revision.revision.operations
        })
      )) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function refusalContribution(refusal: ChangesetLifecycleRefusal | { readonly kind: 'domain_changed' }) {
  return changesetLifecycleContributionSchema.parse({
    result: { kind: 'outcome', outcome: changesetLifecycleRefusalOutcome(refusal) },
    domain: null,
    receiptChildren: []
  });
}

export class SQLiteSubmissionTriageChangesetEffectDomainAdapter
implements SQLiteEffectDomainAdapter, ChangesetLifecycleOwnerResolutionSource {
  readonly lifecycleStore: SQLiteChangesetLifecycleStore;
  readonly subjectRelationships: SQLiteOperatorSubjectRelationshipSource;
  readonly #bundle: SubmissionTriageChangesetBundle;
  readonly #policy: SubmissionTriageChangesetPolicy;
  readonly #ids: SQLiteSubmissionTriageChangesetEffectIds;
  readonly #prepared = new Map<string, PreparedLifecycle>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedLifecycle | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: SubmissionTriageChangesetPolicy;
    readonly repository: SQLiteSubmissionTriageRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteSubmissionTriageChangesetEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    assertSubmissionTriageChangesetPolicy(input.policy);
    this.#policy = input.policy;
    this.#bundle = createSubmissionTriageChangesetBundle();
    assertSubmissionTriageChangesetBundle(this.#bundle);
    this.lifecycleStore = new SQLiteChangesetLifecycleStore(
      input.sqlite,
      terminalReceiptSource(input.sqlite)
    );
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newApprovalId', 'newCorrectionAttemptId',
      'newPreparationHandle', 'newTimelineId', 'newFactId', 'newPointerId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('submission_triage_changeset_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newApprovalId', 'newCorrectionAttemptId',
        'newPreparationHandle', 'newTimelineId', 'newFactId', 'newPointerId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteSubmissionTriageChangesetEffectIds);
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
            || subject.id !== SUBMISSION_TRIAGE_CHANGESET_OWNER_ID
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
                `changeset-owner:${SUBMISSION_TRIAGE_CHANGESET_OWNER_ID}:${eventId}:${this.#bundle.registry.registryDigestSha256}`
              ])
            })
          : Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
    });
  }

  resolveOwner(record: StoredChangesetRecord): ChangesetLifecycleOwnerResolution | undefined {
    if (!ownsTriageChangeset({ bundle: this.#bundle, policy: this.#policy, record })) return undefined;
    return Object.freeze({
      id: SUBMISSION_TRIAGE_CHANGESET_OWNER_ID,
      evidenceIds: Object.freeze([
        `submission-triage-definition:${this.#bundle.registry.registryDigestSha256}`
      ])
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('submission_triage_changeset_transaction_required');
    if (!sameReference(capability, CHANGESET_LIFECYCLE_HANDLER_CAPABILITY)) {
      throw new TypeError('submission_triage_changeset_capability_mismatch');
    }
    const rawAction = changesetLifecycleActionForOperation(
      context.operation.name, context.operation.version
    );
    if (rawAction === 'approve') throw new TypeError('submission_triage_changeset_approval_not_mounted');
    const action = rawAction;
    const expectedEffect = action === 'propose' || action === 'rebuild' || action === 'correction'
      ? 'draft'
      : 'commit';
    if (action === undefined
        || context.operation.effect !== expectedEffect
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || context.scope.eventId === undefined
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('submission_triage_changeset_scope_mismatch');
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
        )) throw new TypeError('submission_triage_changeset_authority_mismatch');
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
        kind: 'domain', domain: 'changeset', entity: 'owner', id: SUBMISSION_TRIAGE_CHANGESET_OWNER_ID
      },
      evaluatedAt
    });
    if (relationship.kind !== 'valid' || subjectRelationship.kind !== 'valid') {
      throw new TypeError('submission_triage_changeset_relationship_mismatch');
    }
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    return sealChangesetLifecyclePreparation({
      capability,
      context,
      preparation: Object.freeze({
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }:
          Parameters<ChangesetLifecyclePreparation['prepare']>[0]) => {
          if (receivedAction !== action || receivedContext !== context
              || !this.input.sqlite.inTransaction) {
            throw new TypeError('submission_triage_changeset_context_substitution');
          }
          return this.prepare({
            action,
            businessInput,
            context,
            authorityRecheck,
            eventId,
            actorUserId,
            evaluatedAt
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
    const repository = this.input.repository;
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
      if (!diff) throw new TypeError('submission_triage_changeset_proposal_diff_missing');
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
        snapshot: this.planningSnapshot(repository, input.context, input.authorityRecheck),
        ids,
        context: actorContext,
        changesetId: wire.changesetId,
        expectedHeadVersion: wire.expectedHeadVersion,
        sourceRevisionId: wire.sourceRevisionId,
        sourceRevisionDigest: wire.sourceRevisionDigest,
        groups: wire.groups,
        approvalPolicy: this.approvalPolicy(current, wire.sourceRevisionId)
      });
      if (result.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(result.refusal);
      }
      record = result.record;
      const revision = record.revisions.at(-1)!.revision;
      const diff = projectStoredChangesetDiff(record, revision.id, revision.digest);
      if (!diff) throw new TypeError('submission_triage_changeset_rebuild_diff_missing');
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
        snapshot: this.planningSnapshot(repository, input.context, input.authorityRecheck),
        ids,
        context: actorContext,
        ...wire,
        approvalPolicy: this.approvalPolicy(current, wire.sourceRevisionId)
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
        throw new TypeError('submission_triage_changeset_correction_diff_missing');
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
      const evidence = this.currentCommitEvidence({ record: current, repository });
      const validation = validateStoredChangesetCommit({
        store: this.lifecycleStore,
        context: actorContext,
        ...wire,
        currentApprovalPolicy: this.approvalPolicy(current, wire.revisionId),
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
        transaction: this.commitTransaction(repository)
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
    if (!revision) throw new TypeError('submission_triage_changeset_revision_missing');
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
      contributionDigestSha256: canonicalJsonSha256({ action: input.action, data }),
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
          factKind: 'submission_triage_changed',
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
      throw new TypeError('submission_triage_changeset_success_contribution_invalid');
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
    if (!this.input.sqlite.inTransaction) throw new TypeError('submission_triage_changeset_transaction_required');
    const parsed = changesetLifecycleDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('submission_triage_changeset_preparation_invalid');
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
      throw new TypeError('submission_triage_changeset_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    let record = active.record;
    if (active.action === 'commit') {
      if (!active.exactCommit) throw new TypeError('submission_triage_changeset_commit_missing');
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
      INSERT INTO submission_triage_changeset_receipt_links (
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
      throw new TypeError('submission_triage_changeset_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[active.nextChild];
    if (!expected || canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('submission_triage_changeset_evidence_mismatch');
    }
    if ((contribution as { readonly kind?: unknown }).kind === 'domain_fact') {
      const child = eventChangesetDomainFactEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query<never, [
        string, string, string, string, string, string, string, number, string
      ]>(`
        INSERT INTO submission_triage_changeset_domain_facts (
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
        INSERT INTO submission_triage_changeset_outbox_pointers (
          pointer_id, receipt_id, fact_id, source_kind
        ) VALUES (?, ?, ?, ?)
      `).run(child.pointerId, receiptId, child.factId, child.sourceKind);
    } else {
      const child = eventChangesetTimelineEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query<never, [
        string, string, string, string, string, string, string, number
      ]>(`
        INSERT INTO submission_triage_changeset_timeline (
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
    if (!this.input.sqlite.inTransaction) throw new TypeError('submission_triage_changeset_transaction_required');
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('submission_triage_changeset_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('submission_triage_changeset_incomplete');
    }
  }

  afterUnitOfWorkCommitted(): void {
    this.clearTransient();
  }

  afterUnitOfWorkFinished(): void {
    this.clearTransient();
  }

  private clearTransient(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }

  private nextId(method: keyof SQLiteSubmissionTriageChangesetEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('submission_triage_changeset_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }

  private planningSnapshot(
    repository: SQLiteSubmissionTriageRepository,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): ChangesetPlanningSnapshot {
    const expectedScope = Object.freeze({
      workspaceId: this.input.workspaceId,
      eventId: context.scope.eventId
    });
    return Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) === submissionTriageChangesetReadPort) {
          return repository as unknown as Port;
        }
        if ((key as unknown) === submissionTriagePlanningAttributionReadPort) {
          return Object.freeze({
            readSubmissionTriagePlanningAttribution(scope: {
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
        throw new TypeError('submission_triage_changeset_undeclared_read_port');
      }
    });
  }

  private commitTransaction(repository: SQLiteSubmissionTriageRepository): ChangesetCommitTransaction {
    return Object.freeze({
      getPort<Port>(key: ChangesetValidationPortKey<Port> | ChangesetTransactionPortKey<Port>): Port {
        if ((key as unknown) !== submissionTriageChangesetValidationPort
            && (key as unknown) !== submissionTriageChangesetTransactionPort) {
          throw new TypeError('submission_triage_changeset_undeclared_transaction_port');
        }
        return repository as unknown as Port;
      }
    });
  }

  private currentCommitEvidence(input: {
    readonly record: StoredChangesetRecord;
    readonly repository: SQLiteSubmissionTriageRepository;
  }) {
    const eventId = input.record.head.eventId;
    if (eventId === undefined) throw new TypeError('submission_triage_changeset_event_required');
    const scope = {
      workspaceId: parseWorkspaceId(input.record.head.workspaceId),
      eventId: parseEventId(eventId)
    };
    const state = input.repository.readTriageState(scope);
    if (!state) throw new TypeError('submission_triage_changeset_domain_missing');
    const aggregateVersions = new Map<string, number>();
    for (const entry of state.entries) {
      aggregateVersions.set(
        submissionTriageAggregateId(entry.head.submissionId),
        entry.head.version
      );
    }
    const guardVersions = new Map<string, number>([
      [submissionTriageQueryGuardId(eventId), state.queryGuard.version]
    ]);
    const guardDigests = new Map<string, string>([
      [submissionTriageQueryGuardId(eventId), state.queryGuard.digestSha256]
    ]);
    for (const entry of state.entries) {
      const guardId = submissionArrivalGuardId(entry.head.submissionId);
      guardVersions.set(guardId, 1);
      guardDigests.set(guardId, submissionTriageArrivalDigest(entry.arrival));
    }
    return Object.freeze({ aggregateVersions, guardVersions, guardDigests });
  }

  private approvalPolicy(record: StoredChangesetRecord, revisionId: string) {
    const revision = record.revisions.find((candidate) => candidate.revision.id === revisionId);
    if (!revision || revision.revision.operations.length === 0) {
      throw new TypeError('submission_triage_changeset_revision_missing');
    }
    return currentTriageApprovalPolicy({
      bundle: this.#bundle,
      policy: this.#policy,
      operations: revision.revision.operations
    });
  }

  private exactRecord(changesetId: string, eventId: EventId): StoredChangesetRecord | undefined {
    const record = this.lifecycleStore.read(changesetId);
    return record
      && record.head.workspaceId === this.input.workspaceId
      && record.head.eventId === eventId
      && this.resolveOwner(record)?.id === SUBMISSION_TRIAGE_CHANGESET_OWNER_ID
      ? record
      : undefined;
  }
}

export function createSQLiteSubmissionTriageChangesetEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly policy: SubmissionTriageChangesetPolicy;
  readonly repository: SQLiteSubmissionTriageRepository;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteSubmissionTriageChangesetEffectIds;
}) {
  const adapter = new SQLiteSubmissionTriageChangesetEffectDomainAdapter(input);
  return Object.freeze({
    ownerId: SUBMISSION_TRIAGE_CHANGESET_OWNER_ID,
    capability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
    adapter,
    lifecycleStore: adapter.lifecycleStore,
    ownerResolution: adapter as ChangesetLifecycleOwnerResolutionSource,
    subjectRelationships: adapter.subjectRelationships
  });
}
