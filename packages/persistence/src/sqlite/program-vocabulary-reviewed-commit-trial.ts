import {
  sealReviewedChangesetCommitPreparation,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type TerminalNewOperationAuditRecord,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  applyPreparedChangeset,
  canonicalJsonSha256,
  createChangeset,
  markChangesetCommitted,
  prepareChangesetCommit,
  prepareChangesetCommitSynchronous,
  proposeChangeset,
  validateExactCommit,
  type ChangesetApplyContribution,
  type ChangesetDefinitionRegistry,
  type ChangesetHead,
  type ChangesetRevision,
  type CommitValidationInput,
  type FrozenChangesetOperation,
  type ValidatedChangesetCommit
} from '@jooevents/changesets';
import {
  programVocabularyScopeSchema,
  type ProgramVocabularyChangeResult,
  type ProgramVocabularyScopeDto
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseOperationReceiptId,
  type CanonicalJson
} from '@jooevents/kernel';
import {
  PROGRAM_VOCABULARY_CHANGESET_KIND,
  PROGRAM_VOCABULARY_CHANGESET_VERSION,
  plannedProgramVocabularyItem,
  programVocabularyAggregateId,
  programVocabularyItems,
  programVocabularySetDigest,
  programVocabularySetGuardId,
  type ProgramVocabularyAuthorInput,
  type ProgramVocabularyChangesetPlan
} from '@jooevents/program';
import { Database } from 'bun:sqlite';
import {
  planProgramVocabularyTrialOperation,
  type SQLiteProgramVocabularyTrialStore
} from './program-vocabulary-trial';
import type { SQLiteTrialEffectDomainAdapter } from './foundation-trial-uow';

/** Disposable F1 schema; it is not a retained migration or production binding. */
export const PROGRAM_VOCABULARY_REVIEWED_COMMIT_TRIAL_SQL = `
CREATE TABLE program_vocabulary_reviewed_trial_changeset_heads (
  changeset_id TEXT PRIMARY KEY CHECK(length(changeset_id) = 36),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  status TEXT NOT NULL CHECK(status IN ('proposed', 'committed')),
  current_revision_number INTEGER NOT NULL CHECK(current_revision_number > 0),
  committed_receipt_id TEXT UNIQUE,
  CHECK(
    (status = 'proposed' AND committed_receipt_id IS NULL)
    OR (status = 'committed' AND committed_receipt_id IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (committed_receipt_id)
    REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE program_vocabulary_reviewed_trial_changeset_revisions (
  changeset_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  revision_id TEXT NOT NULL CHECK(length(revision_id) = 36),
  revision_digest TEXT NOT NULL CHECK(length(revision_digest) = 64 AND revision_digest NOT GLOB '*[^0-9a-f]*'),
  revision_json TEXT NOT NULL CHECK(
    json_valid(revision_json)
    AND json_extract(revision_json, '$.number') = revision_number
    AND json_extract(revision_json, '$.id') = revision_id
    AND json_extract(revision_json, '$.digest') = revision_digest
  ),
  PRIMARY KEY (changeset_id, revision_number),
  UNIQUE (changeset_id, revision_id),
  UNIQUE (changeset_id, revision_id, revision_digest),
  FOREIGN KEY (changeset_id)
    REFERENCES program_vocabulary_reviewed_trial_changeset_heads(changeset_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE program_vocabulary_reviewed_trial_commit_links (
  receipt_id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL,
  revision_digest TEXT NOT NULL,
  FOREIGN KEY (receipt_id)
    REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id)
    REFERENCES program_vocabulary_reviewed_trial_changeset_heads(changeset_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id, revision_id, revision_digest)
    REFERENCES program_vocabulary_reviewed_trial_changeset_revisions(
      changeset_id, revision_id, revision_digest
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE program_vocabulary_reviewed_trial_domain_facts (
  fact_id TEXT PRIMARY KEY CHECK(length(fact_id) BETWEEN 1 AND 300),
  receipt_id TEXT NOT NULL UNIQUE,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  fact_kind TEXT NOT NULL CHECK(fact_kind = 'program_vocabulary_changed'),
  fact_version INTEGER NOT NULL CHECK(fact_version = 1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  UNIQUE (fact_id, receipt_id),
  FOREIGN KEY (receipt_id)
    REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id)
    REFERENCES program_vocabulary_reviewed_trial_changeset_heads(changeset_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id, revision_id)
    REFERENCES program_vocabulary_reviewed_trial_changeset_revisions(changeset_id, revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE program_vocabulary_reviewed_trial_outbox_pointers (
  pointer_id TEXT PRIMARY KEY CHECK(length(pointer_id) BETWEEN 1 AND 300),
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY (receipt_id)
    REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (fact_id, receipt_id)
    REFERENCES program_vocabulary_reviewed_trial_domain_facts(fact_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE program_vocabulary_reviewed_trial_timeline_projection (
  timeline_id TEXT PRIMARY KEY CHECK(length(timeline_id) BETWEEN 1 AND 300),
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY (fact_id, receipt_id)
    REFERENCES program_vocabulary_reviewed_trial_domain_facts(fact_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER program_vocabulary_reviewed_trial_heads_commit_only
BEFORE UPDATE ON program_vocabulary_reviewed_trial_changeset_heads
WHEN NOT (
  OLD.status = 'proposed'
  AND OLD.committed_receipt_id IS NULL
  AND NEW.status = 'committed'
  AND NEW.committed_receipt_id IS NOT NULL
  AND NEW.head_version = OLD.head_version + 1
  AND NEW.changeset_id = OLD.changeset_id
  AND NEW.workspace_id = OLD.workspace_id
  AND NEW.event_id = OLD.event_id
  AND NEW.current_revision_number = OLD.current_revision_number
)
BEGIN
  SELECT RAISE(ABORT, 'trial changeset head permits only exact commit');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_heads_no_delete
BEFORE DELETE ON program_vocabulary_reviewed_trial_changeset_heads
BEGIN
  SELECT RAISE(ABORT, 'trial changeset heads cannot be deleted');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_revisions_no_update
BEFORE UPDATE ON program_vocabulary_reviewed_trial_changeset_revisions
BEGIN
  SELECT RAISE(ABORT, 'trial changeset revisions are immutable');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_revisions_no_delete
BEFORE DELETE ON program_vocabulary_reviewed_trial_changeset_revisions
BEGIN
  SELECT RAISE(ABORT, 'trial changeset revisions are immutable');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_commit_links_no_update
BEFORE UPDATE ON program_vocabulary_reviewed_trial_commit_links
BEGIN
  SELECT RAISE(ABORT, 'trial changeset commit links are immutable');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_commit_links_no_delete
BEFORE DELETE ON program_vocabulary_reviewed_trial_commit_links
BEGIN
  SELECT RAISE(ABORT, 'trial changeset commit links are immutable');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_facts_no_update
BEFORE UPDATE ON program_vocabulary_reviewed_trial_domain_facts
BEGIN
  SELECT RAISE(ABORT, 'trial domain facts are immutable');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_facts_no_delete
BEFORE DELETE ON program_vocabulary_reviewed_trial_domain_facts
BEGIN
  SELECT RAISE(ABORT, 'trial domain facts are immutable');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_outbox_no_update
BEFORE UPDATE ON program_vocabulary_reviewed_trial_outbox_pointers
BEGIN
  SELECT RAISE(ABORT, 'trial outbox pointers are immutable');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_outbox_no_delete
BEFORE DELETE ON program_vocabulary_reviewed_trial_outbox_pointers
BEGIN
  SELECT RAISE(ABORT, 'trial outbox pointers are immutable');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_timeline_no_update
BEFORE UPDATE ON program_vocabulary_reviewed_trial_timeline_projection
BEGIN
  SELECT RAISE(ABORT, 'trial timeline entries are immutable');
END;

CREATE TRIGGER program_vocabulary_reviewed_trial_timeline_no_delete
BEFORE DELETE ON program_vocabulary_reviewed_trial_timeline_projection
BEGIN
  SELECT RAISE(ABORT, 'trial timeline entries are immutable');
END;
`;

export type ProgramVocabularyReviewedCommitTrialFailurePoint =
  | 'after_domain'
  | 'after_parent'
  | 'after_audit'
  | 'after_fact'
  | 'after_outbox'
  | 'after_timeline'
  | 'after_claim_release'
  | 'after_commit_response_loss';

export interface ProgramVocabularyReviewedCommitTrialControl {
  failAt: ProgramVocabularyReviewedCommitTrialFailurePoint | undefined;
}

export interface ProgramVocabularyReviewedCommitTrialRequest {
  readonly changesetId: string;
  readonly expectedHeadVersion: number;
  readonly expectedRevisionDigest: string;
}

export interface StagedProgramVocabularyReviewedCreateTrial {
  readonly head: ChangesetHead;
  readonly revision: ChangesetRevision;
  readonly safeDiff: CanonicalJson;
}

interface HeadRow {
  readonly changeset_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly head_version: number;
  readonly status: 'proposed' | 'committed';
  readonly current_revision_number: number;
}

interface RevisionRow {
  readonly revision_json: string;
}

type EvidenceChild =
  | {
      readonly kind: 'domain_fact';
      readonly factId: string;
      readonly factKind: 'program_vocabulary_changed';
      readonly factVersion: 1;
      readonly payload: CanonicalJson;
    }
  | {
      readonly kind: 'outbox_pointer';
      readonly pointerId: string;
      readonly sourceKind: 'domain_fact';
      readonly factId: string;
    }
  | {
      readonly kind: 'timeline';
      readonly timelineId: string;
      readonly sourceKind: 'domain_fact';
      readonly factId: string;
      readonly occurredAtMs: number;
    };

interface PreparedCommit {
  readonly handle: string;
  readonly head: ChangesetHead;
  readonly revision: ChangesetRevision;
  readonly operation: FrozenChangesetOperation;
  readonly authorization: ValidatedChangesetCommit;
  readonly prepared: Extract<Awaited<ReturnType<typeof prepareChangesetCommit>>, { readonly kind: 'ready' }>['prepared'];
  readonly result: ProgramVocabularyChangeResult;
  readonly resultDigest: string;
  readonly canonicalData: CanonicalJson;
  readonly factPayload: CanonicalJson;
  readonly children: readonly EvidenceChild[];
  readonly context: EffectInvocationContext;
  phase: 'prepared' | 'applying' | 'applied' | 'parent_linked' | 'evidence_complete';
  nextChild: number;
}

function exactRequest(value: unknown): ProgramVocabularyReviewedCommitTrialRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid_program_vocabulary_reviewed_commit_request');
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3
    || typeof candidate.changesetId !== 'string'
    || candidate.changesetId.length !== 36
    || !Number.isSafeInteger(candidate.expectedHeadVersion)
    || (candidate.expectedHeadVersion as number) <= 0
    || typeof candidate.expectedRevisionDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.expectedRevisionDigest)
  ) throw new TypeError('invalid_program_vocabulary_reviewed_commit_request');
  return {
    changesetId: candidate.changesetId,
    expectedHeadVersion: candidate.expectedHeadVersion as number,
    expectedRevisionDigest: candidate.expectedRevisionDigest
  };
}

function operationScope(operation: FrozenChangesetOperation): ProgramVocabularyScopeDto {
  if (
    operation.kind !== PROGRAM_VOCABULARY_CHANGESET_KIND
    || operation.version !== PROGRAM_VOCABULARY_CHANGESET_VERSION
    || !operation.plan
    || typeof operation.plan !== 'object'
    || Array.isArray(operation.plan)
  ) throw new TypeError('invalid_program_vocabulary_reviewed_operation');
  const mutation = (operation.plan as Record<string, unknown>).mutation;
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    throw new TypeError('invalid_program_vocabulary_reviewed_operation');
  }
  return programVocabularyScopeSchema.parse((mutation as Record<string, unknown>).scope);
}

function createResult(operation: FrozenChangesetOperation): ProgramVocabularyChangeResult {
  const wrapped = operation.plan as unknown as ProgramVocabularyChangesetPlan;
  const plan = wrapped.mutation;
  if (plan.action !== 'create') throw new TypeError('reviewed_commit_trial_requires_create');
  return {
    action: 'create',
    kind: plan.after.kind,
    affectedIds: [plan.after.id],
    setVersion: plan.expectedSetVersion + 1,
    liveRepoints: 0
  };
}

function currentCommitInput(
  store: SQLiteProgramVocabularyTrialStore,
  head: ChangesetHead,
  request: ProgramVocabularyReviewedCommitTrialRequest,
  now: string
): CommitValidationInput {
  const revision = head.revisions.at(-1);
  const operation = revision?.operations[0];
  if (!revision || revision.operations.length !== 1 || !operation) {
    throw new TypeError('reviewed_commit_trial_requires_one_operation');
  }
  const scope = operationScope(operation);
  if (scope.workspaceId !== head.workspaceId || scope.eventId !== head.eventId) {
    throw new TypeError('reviewed_commit_trial_scope_mismatch');
  }
  const state = store.readVocabulary(scope);
  if (!state) throw new TypeError('reviewed_commit_trial_scope_missing');
  const currentAggregateVersions = new Map<string, number>();
  for (const item of programVocabularyItems(state)) {
    currentAggregateVersions.set(programVocabularyAggregateId(plannedProgramVocabularyItem(item)), item.version);
  }
  const currentGuardVersions = new Map<string, number>([[programVocabularySetGuardId(scope.eventId), state.setVersion]]);
  const currentGuardDigests = new Map<string, string>([[programVocabularySetGuardId(scope.eventId), programVocabularySetDigest(state)]]);
  if (operation.guardRefs.some((guard) => guard.id.startsWith('program_reference:'))) {
    const references = store.referenceRegistry.capture(state.scope, store);
    for (const contributor of references.contributors) {
      currentGuardVersions.set(contributor.guard.id, contributor.guard.version);
      currentGuardDigests.set(contributor.guard.id, contributor.guard.digest);
    }
  }
  return {
    expectedHeadVersion: request.expectedHeadVersion,
    expectedRevisionDigest: request.expectedRevisionDigest,
    currentAggregateVersions,
    currentGuardVersions,
    currentGuardDigests,
    now
  };
}

function changedExactlyOnce(result: { readonly changes: number }, code: string): void {
  if (result.changes !== 1) throw new TypeError(code);
}

function requireEvidenceChild(value: unknown): EvidenceChild {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { kind?: unknown }).kind !== 'string') {
    throw new TypeError('invalid_program_vocabulary_reviewed_evidence_child');
  }
  return value as EvidenceChild;
}

function sameIdentity(left: EffectOperationIdentity, right: EffectOperationIdentity): boolean {
  return left.scopePartitionKey === right.scopePartitionKey
    && left.authorityPrincipalKey === right.authorityPrincipalKey
    && left.operationName === right.operationName
    && left.operationVersion === right.operationVersion
    && left.surface === right.surface
    && left.idempotencyVerifierProfile.key === right.idempotencyVerifierProfile.key
    && left.idempotencyVerifierProfile.version === right.idempotencyVerifierProfile.version
    && left.idempotencyKeyVerifier === right.idempotencyKeyVerifier;
}

export function installProgramVocabularyReviewedCommitTrialSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('reviewed_commit_trial_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(PROGRAM_VOCABULARY_REVIEWED_COMMIT_TRIAL_SQL);
}

export async function stageProgramVocabularyReviewedCreateTrial(input: {
  readonly sqlite: Database;
  readonly store: SQLiteProgramVocabularyTrialStore;
  readonly registry: ChangesetDefinitionRegistry;
  readonly authorInput: Extract<ProgramVocabularyAuthorInput, { readonly action: 'create' }>;
  readonly changesetId: string;
  readonly revisionId: string;
  readonly createdAt: string;
  readonly proposerPrincipalKey: string;
  readonly approvalPolicy?: { readonly key: string; readonly version: number };
}): Promise<StagedProgramVocabularyReviewedCreateTrial> {
  const operation = await planProgramVocabularyTrialOperation({
    store: input.store,
    registry: input.registry,
    authorInput: input.authorInput
  });
  const draft = createChangeset({
    id: input.changesetId,
    workspaceId: input.authorInput.scope.workspaceId,
    eventId: input.authorInput.scope.eventId
  }, {
    id: input.revisionId,
    createdAt: input.createdAt,
    proposerPrincipalKey: input.proposerPrincipalKey,
    origin: 'human_ui',
    operations: [operation],
    dependencyGroups: [{ key: 'program_vocabulary', dependsOn: [] }],
    approvalPolicy: input.approvalPolicy ?? { key: 'program_vocabulary.low_risk_trial', version: 1 }
  });
  const proposed = proposeChangeset(draft, draft.version);
  const revision = proposed.revisions.at(-1);
  if (!revision) throw new TypeError('missing_program_vocabulary_reviewed_revision');

  if (input.sqlite.inTransaction) throw new TypeError('reviewed_commit_trial_nested_stage');
  input.sqlite.exec('BEGIN IMMEDIATE;');
  try {
    input.sqlite.query<never, [string, string, string, number, string, number]>(`
      INSERT INTO program_vocabulary_reviewed_trial_changeset_heads (
        changeset_id, workspace_id, event_id, head_version, status, current_revision_number
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      proposed.id,
      proposed.workspaceId,
      proposed.eventId as string,
      proposed.version,
      proposed.status,
      proposed.currentRevisionNumber
    );
    for (const storedRevision of proposed.revisions) {
      input.sqlite.query<never, [string, number, string, string, string]>(`
        INSERT INTO program_vocabulary_reviewed_trial_changeset_revisions (
          changeset_id, revision_number, revision_id, revision_digest, revision_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        proposed.id,
        storedRevision.number,
        storedRevision.id,
        storedRevision.digest,
        canonicalJsonText(storedRevision)
      );
    }
    input.sqlite.exec('COMMIT;');
  } catch (error) {
    if (input.sqlite.inTransaction) input.sqlite.exec('ROLLBACK;');
    throw error;
  }
  return Object.freeze({ head: proposed, revision, safeDiff: operation.safeDiff });
}

export class SQLiteProgramVocabularyReviewedCommitTrialAdapter
implements SQLiteTrialEffectDomainAdapter {
  readonly trace: string[] = [];
  #prepared = new Map<string, PreparedCommit>();
  #active: PreparedCommit | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;

  constructor(
    private readonly sqlite: Database,
    private readonly store: SQLiteProgramVocabularyTrialStore,
    private readonly registry: ChangesetDefinitionRegistry,
    private readonly handlerCapability: { readonly key: string; readonly version: number },
    private readonly control: ProgramVocabularyReviewedCommitTrialControl,
    private readonly newPreparationHandle: () => string = () => crypto.randomUUID()
  ) {}

  private fail(at: ProgramVocabularyReviewedCommitTrialFailurePoint): void {
    if (this.control.failAt === at) throw new Error(`injected_program_vocabulary_reviewed_commit_failure:${at}`);
  }

  private loadHead(changesetId: string): ChangesetHead {
    const row = this.sqlite.query<HeadRow, [string]>(`
      SELECT changeset_id, workspace_id, event_id, head_version, status, current_revision_number
        FROM program_vocabulary_reviewed_trial_changeset_heads
       WHERE changeset_id = ?
    `).get(changesetId);
    if (!row) throw new TypeError('program_vocabulary_reviewed_changeset_missing');
    const revisions = this.sqlite.query<RevisionRow, [string]>(`
      SELECT revision_json
        FROM program_vocabulary_reviewed_trial_changeset_revisions
       WHERE changeset_id = ?
       ORDER BY revision_number
    `).all(changesetId).map((revision) => JSON.parse(revision.revision_json) as ChangesetRevision);
    return {
      id: row.changeset_id,
      workspaceId: row.workspace_id,
      eventId: row.event_id,
      version: row.head_version,
      status: row.status,
      currentRevisionNumber: row.current_revision_number,
      revisions
    };
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext
  ): EffectHandlerSnapshot {
    if (!this.sqlite.inTransaction) throw new TypeError('reviewed_commit_trial_transaction_required');
    if (capability.key !== this.handlerCapability.key || capability.version !== this.handlerCapability.version) {
      throw new TypeError('reviewed_commit_trial_capability_mismatch');
    }
    this.trace.push('snapshot');
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    return sealReviewedChangesetCommitPreparation({
      capability,
      preparation: {
        prepare: ({ businessInput, context: sealedContext }) => {
          if (sealedContext !== context) throw new TypeError('reviewed_commit_trial_context_substitution');
          const request = exactRequest(businessInput);
          const head = this.loadHead(request.changesetId);
          if (
            sealedContext.scope.workspaceId !== head.workspaceId
            || sealedContext.scope.eventId !== head.eventId
            || sealedContext.surface !== 'operator_http'
            || sealedContext.operation.effect !== 'commit'
          ) throw new TypeError('reviewed_commit_trial_authority_scope_mismatch');
          const exact = validateExactCommit(
            head,
            currentCommitInput(this.store, head, request, sealedContext.receivedAt)
          );
          if (exact.kind === 'refused') throw new TypeError(`reviewed_commit_trial_refused:${exact.refusal.kind}`);
          const preparedResult = prepareChangesetCommitSynchronous({
            registry: this.registry,
            authorization: exact.authorization,
            transaction: this.store.transactionPort()
          });
          if (preparedResult.kind === 'outcome') {
            throw new TypeError(`reviewed_commit_trial_outcome:${preparedResult.outcome.kind}`);
          }
          const revision = head.revisions.at(-1);
          const operation = revision?.operations[0];
          if (!revision || revision.operations.length !== 1 || !operation) {
            throw new TypeError('reviewed_commit_trial_requires_one_operation');
          }
          const result = createResult(operation);
          const canonicalData = {
            changesetId: head.id,
            revisionId: revision.id,
            revisionDigest: revision.digest,
            action: result.action,
            itemKind: result.kind,
            affectedIds: result.affectedIds,
            setVersion: result.setVersion
          } as const;
          const factPayload = {
            action: result.action,
            kind: result.kind,
            affectedIds: result.affectedIds,
            setVersion: result.setVersion,
            liveRepoints: result.liveRepoints
          } as const;
          const factId = `${revision.id}:fact`;
          const children: readonly EvidenceChild[] = Object.freeze([{
            kind: 'domain_fact',
            factId,
            factKind: 'program_vocabulary_changed',
            factVersion: 1,
            payload: factPayload
          }, {
            kind: 'outbox_pointer',
            pointerId: `${revision.id}:outbox`,
            sourceKind: 'domain_fact',
            factId
          }, {
            kind: 'timeline',
            timelineId: `${revision.id}:timeline`,
            sourceKind: 'domain_fact',
            factId,
            occurredAtMs: Date.parse(sealedContext.receivedAt)
          }]);
          const handle = this.newPreparationHandle();
          const prepared: PreparedCommit = {
            handle,
            head,
            revision,
            operation,
            authorization: exact.authorization,
            prepared: preparedResult.prepared,
            result,
            resultDigest: canonicalJsonSha256(result),
            canonicalData,
            factPayload,
            children,
            context: sealedContext,
            phase: 'prepared',
            nextChild: 0
          };
          this.#prepared.set(handle, prepared);
          this.trace.push('prepare');
          return {
            result: { kind: 'success', data: canonicalData },
            domain: {
              kind: 'program_vocabulary_reviewed_commit_trial',
              preparationHandle: handle,
              expectedResultDigest: prepared.resultDigest
            },
            receiptChildren: children
          };
        }
      }
    });
  }

  async applyDomainContribution(contribution: unknown): Promise<void> {
    if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) {
      throw new TypeError('invalid_program_vocabulary_reviewed_domain_contribution');
    }
    const candidate = contribution as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 3
      || candidate.kind !== 'program_vocabulary_reviewed_commit_trial'
      || typeof candidate.preparationHandle !== 'string'
      || typeof candidate.expectedResultDigest !== 'string'
    ) throw new TypeError('invalid_program_vocabulary_reviewed_domain_contribution');
    const prepared = this.#prepared.get(candidate.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared' || prepared.resultDigest !== candidate.expectedResultDigest) {
      throw new TypeError('invalid_program_vocabulary_reviewed_preparation_handle');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applying';
    const contributions = await applyPreparedChangeset(prepared.prepared);
    const applied = contributions[0] as ChangesetApplyContribution<ProgramVocabularyChangeResult> | undefined;
    if (
      contributions.length !== 1
      || !applied
      || canonicalJsonSha256(applied.result) !== prepared.resultDigest
      || applied.facts.length !== 1
      || applied.facts[0]?.kind !== 'program_vocabulary_changed'
      || applied.facts[0]?.version !== 1
      || canonicalJsonSha256(applied.facts[0]?.payload) !== canonicalJsonSha256(prepared.factPayload)
      || applied.effects.length !== 0
    ) throw new TypeError('program_vocabulary_reviewed_contribution_mismatch');
    prepared.phase = 'applied';
    this.#active = prepared;
    this.trace.push('domain');
    this.fail('after_domain');
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    if (!active || active.phase !== 'applied') throw new TypeError('missing_program_vocabulary_reviewed_apply');
    if (
      receipt.identity.authorityPrincipalKey !== active.context.authorityPrincipalKey
      || receipt.identity.scopePartitionKey !== active.context.requestBinding.scopePartitionKey
      || receipt.identity.operationName !== active.context.operation.name
      || receipt.identity.operationVersion !== active.context.operation.version
      || receipt.identity.surface !== active.context.surface
      || receipt.identity.idempotencyVerifierProfile.key !== active.context.requestBinding.idempotency?.verifierProfile.key
      || receipt.identity.idempotencyVerifierProfile.version !== active.context.requestBinding.idempotency?.verifierProfile.version
      || receipt.identity.idempotencyKeyVerifier !== active.context.requestBinding.idempotency?.verifierSha256
      || receipt.requestHash !== active.context.requestBinding.requestHashSha256
    ) throw new TypeError('program_vocabulary_reviewed_receipt_identity_mismatch');
    const marked = markChangesetCommitted(
      active.head,
      active.authorization,
      parseOperationReceiptId(receipt.ref.id)
    );
    // `markChangesetCommitted` also mints a process-local compensation source.
    // This adapter deliberately persists only the durable link and never returns
    // or otherwise exposes that source before (or after) SQL COMMIT.
    changedExactlyOnce(this.sqlite.query<never, [number, string, string, number]>(`
      UPDATE program_vocabulary_reviewed_trial_changeset_heads
         SET head_version = ?, status = 'committed', committed_receipt_id = ?
       WHERE changeset_id = ? AND status = 'proposed' AND head_version = ?
         AND committed_receipt_id IS NULL
    `).run(marked.head.version, receipt.ref.id, active.head.id, active.head.version), 'stale_program_vocabulary_reviewed_head');
    this.sqlite.query<never, [string, string, string, string]>(`
      INSERT INTO program_vocabulary_reviewed_trial_commit_links (
        receipt_id, changeset_id, revision_id, revision_digest
      ) VALUES (?, ?, ?, ?)
    `).run(receipt.ref.id, active.head.id, active.revision.id, active.revision.digest);
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
    this.trace.push('parent');
    this.fail('after_parent');
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!active || active.phase !== 'parent_linked' || !this.#expectedIdentity) {
      throw new TypeError('missing_program_vocabulary_reviewed_parent');
    }
    const expected = active.children[active.nextChild];
    const child = requireEvidenceChild(contribution);
    if (!expected || canonicalJsonSha256(child) !== canonicalJsonSha256(expected)) {
      throw new TypeError('program_vocabulary_reviewed_evidence_order_mismatch');
    }
    if (child.kind === 'domain_fact') {
      this.sqlite.query<never, [string, string, string, string, string, number, string]>(`
        INSERT INTO program_vocabulary_reviewed_trial_domain_facts (
          fact_id, receipt_id, changeset_id, revision_id,
          fact_kind, fact_version, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.factId,
        receiptId,
        active.head.id,
        active.revision.id,
        child.factKind,
        child.factVersion,
        canonicalJsonText(child.payload)
      );
      this.trace.push('fact');
      this.fail('after_fact');
    } else if (child.kind === 'outbox_pointer') {
      this.sqlite.query<never, [string, string, string, string]>(`
        INSERT INTO program_vocabulary_reviewed_trial_outbox_pointers (
          pointer_id, receipt_id, fact_id, source_kind
        ) VALUES (?, ?, ?, ?)
      `).run(child.pointerId, receiptId, child.factId, child.sourceKind);
      this.trace.push('outbox');
      this.fail('after_outbox');
    } else {
      const scope = operationScope(active.operation);
      this.sqlite.query<never, [string, string, string, string, string, number, string]>(`
        INSERT INTO program_vocabulary_reviewed_trial_timeline_projection (
          timeline_id, receipt_id, fact_id, workspace_id,
          event_id, occurred_at_ms, source_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.timelineId,
        receiptId,
        child.factId,
        scope.workspaceId,
        scope.eventId,
        child.occurredAtMs,
        child.sourceKind
      );
      this.trace.push('timeline');
      this.fail('after_timeline');
    }
    active.nextChild += 1;
    if (active.nextChild === active.children.length) active.phase = 'evidence_complete';
  }

  afterTerminalAuditInserted(record: TerminalNewOperationAuditRecord): void {
    const active = this.#active;
    if (!active
      || active.phase !== 'parent_linked'
      || record.eventId !== active.context.invocationId
      || record.correlationId !== active.context.correlationId) {
      throw new TypeError('program_vocabulary_reviewed_audit_mismatch');
    }
    this.trace.push('audit');
    this.fail('after_audit');
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    const active = this.#active;
    if (!active || active.phase !== 'evidence_complete' || !this.#expectedIdentity || !sameIdentity(identity, this.#expectedIdentity)) {
      throw new TypeError('incomplete_program_vocabulary_reviewed_commit');
    }
    this.trace.push('claim_release');
    this.fail('after_claim_release');
  }

  afterUnitOfWorkCommitted(): void {
    this.trace.push('commit');
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#prepared.clear();
    this.fail('after_commit_response_loss');
  }
}
