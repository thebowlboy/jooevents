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
import { appendChangesetDraftSynchronous } from '@jooevents/changeset-operations';
import type { ChangesetPlanningSnapshot, ChangesetReadPortKey } from '@jooevents/changesets';
import {
  submissionTriageSafeDiffSchema,
  submissionTriageTransitionDraftInputSchema,
  submissionTriageDraftOperationResultSchema,
  type SubmissionTriageAction
} from '@jooevents/contracts/submission-triage';
import {
  SUBMISSION_TRIAGE_CHANGESET_KIND,
  SUBMISSION_TRIAGE_CHANGESET_VERSION,
  SUBMISSION_TRIAGE_DRAFT_HANDLER_CAPABILITY,
  SUBMISSION_TRIAGE_DRAFT_OPERATION,
  SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY,
  SubmissionTriageDomainError,
  assertSubmissionTriageChangesetBundle,
  assertSubmissionTriageChangesetPolicy,
  captureSubmissionTriageApprovalPolicy,
  createSubmissionTriageChangesetBundle,
  parseSubmissionTriageChangesetAuthorInput,
  sealSubmissionTriageDraftPreparation,
  submissionTriageChangesetReadPort,
  submissionTriageDraftContributionSchema,
  submissionTriageDraftDomainContributionSchema,
  submissionTriageDraftEvidenceChildSchema,
  submissionTriagePlanningAttributionReadPort,
  type SubmissionTriageChangesetBundle,
  type SubmissionTriageChangesetPolicy,
  type SubmissionTriagePreparedContribution
} from '@jooevents/submission-triage';
import {
  canonicalJsonText,
  parseChangesetId,
  parseChangesetRevisionId,
  parseInstant,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import {
  createSQLiteDraftOnlyChangesetLifecycleStore,
  type SQLiteChangesetLifecycleStore
} from './changeset-lifecycle';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteSubmissionTriageRepository } from './submission-triage';

export const SQLITE_SUBMISSION_TRIAGE_DRAFT_EFFECT_SQL = `
CREATE TABLE submission_triage_draft_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
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
  action TEXT NOT NULL CHECK(action IN (
    'set_aside', 'return_to_inbox', 'discard_recoverable', 'restore'
  )),
  operation_name TEXT NOT NULL CHECK(operation_name = 'submission.triage.transition.draft'),
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

CREATE TABLE submission_triage_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES submission_triage_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER submission_triage_draft_receipt_links_no_update
BEFORE UPDATE ON submission_triage_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'submission triage draft receipt links are immutable'); END;
CREATE TRIGGER submission_triage_draft_receipt_links_no_delete
BEFORE DELETE ON submission_triage_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'submission triage draft receipt links are immutable'); END;
CREATE TRIGGER submission_triage_draft_timeline_no_update
BEFORE UPDATE ON submission_triage_draft_timeline
BEGIN SELECT RAISE(ABORT, 'submission triage draft timeline is immutable'); END;
CREATE TRIGGER submission_triage_draft_timeline_no_delete
BEFORE DELETE ON submission_triage_draft_timeline
BEGIN SELECT RAISE(ABORT, 'submission triage draft timeline is immutable'); END;
`;

export function installSQLiteSubmissionTriageDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('submission_triage_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_SUBMISSION_TRIAGE_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteSubmissionTriageDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
}

type DraftContribution = ReturnType<typeof submissionTriageDraftContributionSchema.parse>;
type DraftSuccess = Extract<DraftContribution, { readonly result: { readonly kind: 'success' } }>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly action: SubmissionTriageAction;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  receiptId?: string;
}

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

function sameCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === SUBMISSION_TRIAGE_DRAFT_HANDLER_CAPABILITY.key
    && value.version === SUBMISSION_TRIAGE_DRAFT_HANDLER_CAPABILITY.version;
}

function eventRequiredContribution(): DraftContribution {
  return submissionTriageDraftContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: 'conflict', kind: 'submission_triage.event_required', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    } },
    domain: null,
    receiptChildren: []
  });
}

function collisionContribution(): DraftContribution {
  return submissionTriageDraftContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: 'conflict', kind: 'changeset.id_collision', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    } },
    domain: null,
    receiptChildren: []
  });
}

function planningRefusal(
  error: SubmissionTriageDomainError,
  action: SubmissionTriageAction,
  submissionIds: readonly string[]
): DraftContribution {
  const stale = new Set([
    'wrong_scope', 'projection_incomplete', 'source_changed', 'submission_missing',
    'stale_query_set', 'stale_submission'
  ]).has(error.code);
  return submissionTriageDraftContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: stale ? 'stale_revision' : 'policy_violation',
      kind: stale ? 'submission_triage.changed' : 'submission_triage.change_refused',
      retryable: false,
      subjects: submissionIds.map((id) => ({ type: 'submission_triage', id })),
      detail: { code: error.code, action, submissionIds },
      detailSchemaVersion: 1
    } },
    domain: null,
    receiptChildren: []
  });
}

/** Persists an inert bounded triage changeset; effective heads are read-only here. */
export class SQLiteSubmissionTriageDraftEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #bundle: SubmissionTriageChangesetBundle;
  readonly #changesets: SQLiteChangesetLifecycleStore;
  readonly #ids: SQLiteSubmissionTriageDraftEffectIds;
  readonly #issuedIds = new Set<string>();
  readonly #prepared = new Map<string, PreparedDraft>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: SubmissionTriageChangesetPolicy;
    readonly repository: SQLiteSubmissionTriageRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteSubmissionTriageDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    assertSubmissionTriageChangesetPolicy(input.policy);
    this.#bundle = createSubmissionTriageChangesetBundle();
    assertSubmissionTriageChangesetBundle(this.#bundle);
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newPreparationHandle', 'newTimelineId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('submission_triage_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze({
      newChangesetId: input.ids.newChangesetId.bind(input.ids),
      newRevisionId: input.ids.newRevisionId.bind(input.ids),
      newPreparationHandle: input.ids.newPreparationHandle.bind(input.ids),
      newTimelineId: input.ids.newTimelineId.bind(input.ids)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('submission_triage_draft_transaction_required');
    }
    if (!sameCapability(capability)
        || context.operation.name !== SUBMISSION_TRIAGE_DRAFT_OPERATION.name
        || context.operation.version !== SUBMISSION_TRIAGE_DRAFT_OPERATION.version
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('submission_triage_draft_scope_mismatch');
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
        || authority.lane.policy.key !== SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) throw new TypeError('submission_triage_draft_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    this.clearTransient();
    if (context.scope.eventId === undefined) {
      return sealSubmissionTriageDraftPreparation({
        capability,
        context,
        preparation: { prepare: ({ context: received }) => {
          if (received !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('submission_triage_draft_context_substitution');
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
      throw new TypeError('submission_triage_draft_event_relationship_mismatch');
    }
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort: <Port>(key: ChangesetReadPortKey<Port>): Port => {
        if ((key as unknown) === submissionTriageChangesetReadPort) {
          return this.input.repository as unknown as Port;
        }
        if ((key as unknown) === submissionTriagePlanningAttributionReadPort) {
          return Object.freeze({
            readSubmissionTriagePlanningAttribution: () =>
              Object.freeze({ context, authorityRecheck })
          }) as unknown as Port;
        }
        throw new TypeError('undeclared_submission_triage_draft_read_port');
      }
    });
    return sealSubmissionTriageDraftPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('submission_triage_draft_context_substitution');
        }
        const draft = submissionTriageTransitionDraftInputSchema.parse(businessInput);
        const author = parseSubmissionTriageChangesetAuthorInput({
          action: draft.action,
          scope: { workspaceId: this.input.workspaceId, eventId },
          submissionIds: draft.submissionIds,
          expectedHeads: draft.expectedHeads,
          expectedQueryGuard: draft.expectedQueryGuard
        });
        const changesetId = parseChangesetId(this.fresh(this.#ids.newChangesetId));
        const revisionId = parseChangesetRevisionId(this.fresh(this.#ids.newRevisionId));
        const handle = this.fresh(this.#ids.newPreparationHandle);
        const timelineId = this.fresh(this.#ids.newTimelineId);
        let appended: ReturnType<typeof appendChangesetDraftSynchronous>;
        try {
          appended = appendChangesetDraftSynchronous({
            store: this.#changesets,
            registry: this.#bundle.registry,
            snapshot,
            ids: {
              newChangesetId: () => changesetId,
              newRevisionId: () => revisionId,
              newApprovalId: () => { throw new TypeError('approval_id_unavailable_during_draft'); },
              newCorrectionAttemptId: () => { throw new TypeError('correction_id_unavailable_during_draft'); }
            },
            context: {
              workspaceId: this.input.workspaceId,
              eventId,
              principalKey: `workspace_user:${actorUserId}`,
              authorityPrincipalKey: context.authorityPrincipalKey,
              evaluatedAt
            },
            operations: [{
              kind: SUBMISSION_TRIAGE_CHANGESET_KIND,
              version: SUBMISSION_TRIAGE_CHANGESET_VERSION,
              dependencyGroup: 'submission_triage',
              authorInput: author
            }],
            dependencyGroups: [{ key: 'submission_triage', dependsOn: [] }],
            approvalPolicy: captureSubmissionTriageApprovalPolicy({
              policy: this.input.policy,
              action: draft.action
            }),
            origin: 'human_ui'
          });
        } catch (error) {
          if (error instanceof SubmissionTriageDomainError) {
            this.#nonterminalContext = context;
            return planningRefusal(error, draft.action, draft.submissionIds);
          }
          throw error;
        }
        if (appended.kind === 'refused') {
          if (appended.refusal.kind !== 'id_collision') {
            throw new TypeError('submission_triage_draft_unexpected_lifecycle_refusal');
          }
          this.#nonterminalContext = context;
          return collisionContribution();
        }
        const revision = appended.record.revisions[0];
        const operation = revision?.revision.operations[0];
        if (!revision || !operation
            || appended.record.revisions.length !== 1
            || revision.revision.operations.length !== 1) {
          throw new TypeError('submission_triage_draft_record_incoherent');
        }
        const safeDiff = submissionTriageSafeDiffSchema.parse(operation.safeDiff);
        const candidate = submissionTriageDraftContributionSchema.parse({
          result: { kind: 'success', data: {
            schemaVersion: 1,
            action: draft.action,
            changesetId,
            headVersion: appended.record.head.version,
            status: appended.record.head.status,
            revision: {
              id: revision.revision.id,
              number: revision.revision.number,
              digestSha256: revision.revision.digest
            },
            affectedCount: safeDiff.transitions.length,
            riskTier: revision.revision.riskTier,
            approvalPolicy: revision.approvalPolicy,
            safeDiff
          } },
          domain: {
            kind: 'submission_triage_changeset_draft',
            preparationHandle: handle,
            workspaceId: this.input.workspaceId,
            eventId,
            action: draft.action,
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
          throw new TypeError('submission_triage_draft_success_contribution_invalid');
        }
        const contribution = candidate as DraftSuccess;
        this.#prepared.set(handle, {
          handle,
          context,
          action: draft.action,
          workspaceId: this.input.workspaceId,
          eventId,
          contribution,
          phase: 'prepared'
        });
        return contribution;
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('submission_triage_draft_transaction_required');
    }
    const parsed = submissionTriageDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    const stored = prepared ? this.#changesets.read(parsed.changesetId) : undefined;
    if (!prepared || prepared.phase !== 'prepared' || !stored
        || stored.recordDigestSha256 !== parsed.recordDigestSha256
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('submission_triage_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = submissionTriageDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== active.context.operation.name
        || receipt.ref.operationVersion !== active.context.operation.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('submission_triage_draft_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    const domain = active.contribution.domain;
    this.input.sqlite.query(`
      INSERT INTO submission_triage_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, active.workspaceId, active.eventId, domain.changesetId, domain.revisionId,
      domain.revisionDigestSha256, domain.recordDigestSha256, active.action,
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
      throw new TypeError('submission_triage_draft_receipt_parent_missing');
    }
    const child = submissionTriageDraftEvidenceChildSchema.parse(contribution);
    if (canonicalJsonText(child) !== canonicalJsonText(active.contribution.receiptChildren[0])) {
      throw new TypeError('submission_triage_draft_evidence_mismatch');
    }
    this.input.sqlite.query(`
      INSERT INTO submission_triage_draft_timeline (
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
      throw new TypeError('submission_triage_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      if (!this.#nonterminalContext
          || !effectOperationIdentityMatchesContext(identity, this.#nonterminalContext)) {
        throw new TypeError('submission_triage_draft_incomplete');
      }
      this.#nonterminalContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete'
        || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('submission_triage_draft_incomplete');
    }
    active.phase = 'claim_released';
  }

  afterUnitOfWorkCommitted(): void { this.clearTransient(); }
  afterUnitOfWorkFinished(): void { this.clearTransient(); }

  private fresh(factory: () => string): string {
    const value = factory();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)) throw new TypeError('submission_triage_draft_id_invalid');
    const canonical = value.toLowerCase();
    if (this.#issuedIds.has(canonical)) {
      throw new TypeError('submission_triage_draft_ids_not_unique');
    }
    this.#issuedIds.add(canonical);
    return canonical;
  }

  private clearTransient(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalContext = undefined;
    this.#prepared.clear();
  }
}

export function createSQLiteSubmissionTriageDraftEffectDomainRegistration(input:
  ConstructorParameters<typeof SQLiteSubmissionTriageDraftEffectDomainAdapter>[0]
): {
  readonly capability: typeof SUBMISSION_TRIAGE_DRAFT_HANDLER_CAPABILITY;
  readonly adapter: SQLiteSubmissionTriageDraftEffectDomainAdapter;
} {
  return Object.freeze({
    capability: SUBMISSION_TRIAGE_DRAFT_HANDLER_CAPABILITY,
    adapter: new SQLiteSubmissionTriageDraftEffectDomainAdapter(input)
  });
}
