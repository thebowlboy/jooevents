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
import type { ReviewMutationPlanDto, ReviewScopeDto } from '@jooevents/contracts/reviews';
import type { PermissionId } from '@jooevents/identity-access';
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
  absentReviewHeadDigest,
  createReviewChangesetBundle,
  reviewCandidateSetDigest,
  reviewCatalogGuardId,
  reviewChangesetReadPort,
  reviewChangesetTransactionPort,
  reviewChangesetValidationPort,
  reviewRosterSetDigest,
  REVIEW_CORE_CHANGESET_KIND,
  REVIEW_CORE_CHANGESET_VERSION,
  type ReviewChangesetBundle
} from '@jooevents/review';
import {
  reviewDueDeadlinePlanningPort,
  reviewDueDeadlineTransactionPort,
  reviewDueDeadlineValidationPort
} from '@jooevents/deadline';
import {
  REVIEW_CHANGE_APPROVAL_POLICY,
  reviewDiffReadPermissionIdsForAction
} from '@jooevents/review-operations';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import type { SQLiteChangesetLifecycleStore } from './changeset-lifecycle';
import { createSQLiteOrdinaryChangesetLifecycleStore } from './program-vocabulary-changeset-effect-domain';
import type {
  SQLiteOperatorEventRelationshipSource,
  SQLiteOperatorSubjectRelationshipSource
} from './operator-authority-repositories';
import type { SQLiteReviewRepository } from './review';

/** Stable changeset-owner identity for every Review core changeset. */
export const REVIEW_CHANGESET_OWNER_ID = 'review' as const;

/** The single wrapped commit fact this owner emits per committed changeset. */
export const REVIEW_CHANGESET_COMMIT_FACT_KIND = 'review_core_changed' as const;

export const REVIEW_CHANGESET_EFFECT_SQL = `
CREATE TABLE review_changeset_receipt_links (
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
  FOREIGN KEY(changeset_id, revision_id, revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(receipt_id, workspace_id, event_id, changeset_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE review_changeset_domain_facts (
  fact_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  fact_kind TEXT NOT NULL CHECK(fact_kind = 'review_core_changed'),
  fact_version INTEGER NOT NULL CHECK(fact_version = 1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  FOREIGN KEY(receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES review_changeset_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(fact_id, receipt_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE review_changeset_outbox_pointers (
  pointer_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY(fact_id, receipt_id)
    REFERENCES review_changeset_domain_facts(fact_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE review_changeset_timeline (
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
    REFERENCES review_changeset_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER review_changeset_receipt_links_no_update
BEFORE UPDATE ON review_changeset_receipt_links
BEGIN SELECT RAISE(ABORT, 'review changeset receipt links are immutable'); END;
CREATE TRIGGER review_changeset_receipt_links_no_delete
BEFORE DELETE ON review_changeset_receipt_links
BEGIN SELECT RAISE(ABORT, 'review changeset receipt links are immutable'); END;
CREATE TRIGGER review_changeset_domain_facts_no_update
BEFORE UPDATE ON review_changeset_domain_facts
BEGIN SELECT RAISE(ABORT, 'review changeset facts are immutable'); END;
CREATE TRIGGER review_changeset_domain_facts_no_delete
BEFORE DELETE ON review_changeset_domain_facts
BEGIN SELECT RAISE(ABORT, 'review changeset facts are immutable'); END;
CREATE TRIGGER review_changeset_outbox_pointers_no_update
BEFORE UPDATE ON review_changeset_outbox_pointers
BEGIN SELECT RAISE(ABORT, 'review changeset pointers are immutable'); END;
CREATE TRIGGER review_changeset_outbox_pointers_no_delete
BEFORE DELETE ON review_changeset_outbox_pointers
BEGIN SELECT RAISE(ABORT, 'review changeset pointers are immutable'); END;
CREATE TRIGGER review_changeset_timeline_no_update
BEFORE UPDATE ON review_changeset_timeline
BEGIN SELECT RAISE(ABORT, 'review changeset timeline is immutable'); END;
CREATE TRIGGER review_changeset_timeline_no_delete
BEFORE DELETE ON review_changeset_timeline
BEGIN SELECT RAISE(ABORT, 'review changeset timeline is immutable'); END;
`;

export function installReviewChangesetEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('review_changeset_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(REVIEW_CHANGESET_EFFECT_SQL)).immediate();
}

export interface SQLiteReviewChangesetEffectIds extends ChangesetLifecycleIds {
  newPreparationHandle(): string;
  newTimelineId(): string;
  newFactId(): string;
  newPointerId(): string;
}

const ID_METHODS = [
  'newChangesetId', 'newRevisionId', 'newApprovalId', 'newCorrectionAttemptId',
  'newPreparationHandle', 'newTimelineId', 'newFactId', 'newPointerId'
] as const;

const REVIEW_PERMISSION_IDS: readonly PermissionId[] = Object.freeze([
  'event.manage', 'submission.comment', 'submission.score'
]);

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
    throw new TypeError(`review_changeset_${label}_invalid`);
  }
  return value;
}

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
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
      && subject.id === REVIEW_CHANGESET_OWNER_ID
    );
}

function operationPlan(input: {
  readonly bundle: ReviewChangesetBundle;
  readonly operation: FrozenChangesetOperation;
}): ReviewMutationPlanDto | undefined {
  if (input.operation.kind !== REVIEW_CORE_CHANGESET_KIND
      || input.operation.version !== REVIEW_CORE_CHANGESET_VERSION) return undefined;
  const definition = input.bundle.registry.get(input.operation.kind, input.operation.version);
  if (!definition
      || !sameReference(definition.schemas.plan, input.operation.planSchema)
      || !sameReference(definition.schemas.diff, input.operation.diffSchema)
      || !sameReference(definition.schemas.result, input.operation.resultSchema)) return undefined;
  const schema = input.bundle.registry.getSchema(input.operation.planSchema);
  return schema?.schema.parse(input.operation.plan) as ReviewMutationPlanDto | undefined;
}

function ownsReviewChangeset(input: {
  readonly bundle: ReviewChangesetBundle;
  readonly record: StoredChangesetRecord;
}): boolean {
  if (input.record.head.eventId === undefined) return false;
  for (const revision of input.record.revisions) {
    for (const operation of revision.revision.operations) {
      const plan = operationPlan({ bundle: input.bundle, operation });
      if (!plan) return false;
      if (plan.input.scope.workspaceId !== input.record.head.workspaceId
          || plan.input.scope.eventId !== input.record.head.eventId) return false;
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

/**
 * Owns the Review changeset transitions and the effective Review commit on one
 * caller-owned SQLite handle. Every lifecycle, Review, and collaborating
 * `review_due` Deadline write stays inside the Foundation effect unit of work:
 * the planning snapshot and commit transaction serve the Review ports and the
 * three Deadline collaboration ports from the one composed Review repository, so
 * opening a round creates its Deadline atomically with the round or not at all.
 */
export class SQLiteReviewChangesetEffectDomainAdapter
implements SQLiteEffectDomainAdapter, ChangesetLifecycleOwnerResolutionSource {
  readonly lifecycleStore: SQLiteChangesetLifecycleStore;
  readonly subjectRelationships: SQLiteOperatorSubjectRelationshipSource;
  readonly #bundle = createReviewChangesetBundle();
  readonly #ids: SQLiteReviewChangesetEffectIds;
  readonly #prepared = new Map<string, PreparedLifecycle>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedLifecycle | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteReviewRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteReviewChangesetEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.lifecycleStore = createSQLiteOrdinaryChangesetLifecycleStore(input.sqlite);
    for (const method of ID_METHODS) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('review_changeset_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      ID_METHODS.map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteReviewChangesetEffectIds);
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
            || subject.id !== REVIEW_CHANGESET_OWNER_ID
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
                `changeset-owner:review:${eventId}:${this.#bundle.registry.registryDigestSha256}`
              ])
            })
          : Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
    });
  }

  resolveOwner(record: StoredChangesetRecord): ChangesetLifecycleOwnerResolution | undefined {
    if (!ownsReviewChangeset({ bundle: this.#bundle, record })) return undefined;
    return Object.freeze({
      id: REVIEW_CHANGESET_OWNER_ID,
      evidenceIds: Object.freeze([
        `review-definition:${this.#bundle.registry.registryDigestSha256}`
      ]),
      diffReadPermissionIds: this.recordPermissionIds(record)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('review_changeset_transaction_required');
    if (!sameReference(capability, CHANGESET_LIFECYCLE_HANDLER_CAPABILITY)) {
      throw new TypeError('review_changeset_capability_mismatch');
    }
    const rawAction = changesetLifecycleActionForOperation(
      context.operation.name, context.operation.version
    );
    if (rawAction === 'approve') throw new TypeError('review_changeset_approval_not_mounted');
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
      throw new TypeError('review_changeset_scope_mismatch');
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
        || !sameReference(authority.lane.policy, CHANGESET_LIFECYCLE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission'
          && REVIEW_PERMISSION_IDS.includes(grant.key as PermissionId)
        )) throw new TypeError('review_changeset_authority_mismatch');
    const grantedPermissionIds = new Set(authority.grants.flatMap((grant) =>
      grant.kind === 'permission' ? [grant.key] : []
    ));
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
        kind: 'domain', domain: 'changeset', entity: 'owner', id: REVIEW_CHANGESET_OWNER_ID
      },
      evaluatedAt
    });
    if (relationship.kind !== 'valid' || subjectRelationship.kind !== 'valid') {
      throw new TypeError('review_changeset_relationship_mismatch');
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
            throw new TypeError('review_changeset_context_substitution');
          }
          return this.prepare({
            action, businessInput, context, eventId, actorUserId, evaluatedAt,
            grantedPermissionIds
          });
        }
      })
    });
  }

  private prepare(input: {
    readonly action: Exclude<ChangesetLifecycleAction, 'approve'>;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
    readonly grantedPermissionIds: ReadonlySet<string>;
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
      const current = this.exactRecord(wire.changesetId, input.eventId, input.grantedPermissionIds);
      if (!current) {
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
      if (!diff) throw new TypeError('review_changeset_proposal_diff_missing');
      data = { schemaVersion: 1, action: 'propose', diff };
    } else if (input.action === 'rebuild') {
      const wire = rebuildChangesetInputSchema.parse(input.businessInput);
      const current = this.exactRecord(wire.changesetId, input.eventId, input.grantedPermissionIds);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      let result: ReturnType<typeof rebuildStoredChangesetSynchronous>;
      try {
        result = rebuildStoredChangesetSynchronous({
          store: this.lifecycleStore,
          registry: this.#bundle.registry,
          snapshot: this.planningSnapshot(repository),
          ids,
          context: actorContext,
          changesetId: wire.changesetId,
          expectedHeadVersion: wire.expectedHeadVersion,
          sourceRevisionId: wire.sourceRevisionId,
          sourceRevisionDigest: wire.sourceRevisionDigest,
          groups: wire.groups,
          approvalPolicy: REVIEW_CHANGE_APPROVAL_POLICY
        });
      } catch {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'domain_changed' });
      }
      if (result.kind === 'refused') {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution(result.refusal);
      }
      record = result.record;
      const revision = record.revisions.at(-1)!.revision;
      const diff = projectStoredChangesetDiff(record, revision.id, revision.digest);
      if (!diff) throw new TypeError('review_changeset_rebuild_diff_missing');
      data = {
        schemaVersion: 1,
        action: 'rebuild',
        sourceRevisionId: wire.sourceRevisionId,
        sourceRevisionDigest: wire.sourceRevisionDigest,
        diff
      };
    } else if (input.action === 'correction') {
      const wire = draftChangesetCorrectionInputSchema.parse(input.businessInput);
      const current = this.exactRecord(
        wire.sourceChangesetId, input.eventId, input.grantedPermissionIds
      );
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      const result = draftChangesetCorrectionSynchronous({
        store: this.lifecycleStore,
        registry: this.#bundle.registry,
        snapshot: this.planningSnapshot(repository),
        ids,
        context: actorContext,
        ...wire,
        approvalPolicy: REVIEW_CHANGE_APPROVAL_POLICY
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
        throw new TypeError('review_changeset_correction_diff_missing');
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
      const current = this.exactRecord(wire.changesetId, input.eventId, input.grantedPermissionIds);
      if (!current) {
        this.#nonterminalReleaseContext = input.context;
        return refusalContribution({ kind: 'scope_changed' });
      }
      const evidence = this.currentCommitEvidence({ record: current, repository });
      const validation = validateStoredChangesetCommit({
        store: this.lifecycleStore,
        context: actorContext,
        ...wire,
        currentApprovalPolicy: REVIEW_CHANGE_APPROVAL_POLICY,
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
      const facts = applied.flatMap((contribution) => contribution.facts);
      if (facts.length < 1 || facts.length > 2
          || !['review_round_opened', 'review_round_discarded',
               'review_assignment_stepped_back', 'review_committed',
               'review_amended'].includes(facts[0]?.kind ?? '')
          || (facts.length === 2 && facts[1]?.kind !== 'deadline_changed')
          || facts.some((fact) => fact.version !== 1)) {
        throw new TypeError('review_changeset_fact_contribution_invalid');
      }
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
    if (!revision) throw new TypeError('review_changeset_revision_missing');
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
          factKind: REVIEW_CHANGESET_COMMIT_FACT_KIND,
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
      throw new TypeError('review_changeset_success_contribution_invalid');
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
    if (!this.input.sqlite.inTransaction) throw new TypeError('review_changeset_transaction_required');
    const parsed = changesetLifecycleDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('review_changeset_preparation_invalid');
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
      throw new TypeError('review_changeset_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    let record = active.record;
    if (active.action === 'commit') {
      if (!active.exactCommit) throw new TypeError('review_changeset_commit_missing');
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
      INSERT INTO review_changeset_receipt_links (
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
      throw new TypeError('review_changeset_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[active.nextChild];
    if (!expected || canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('review_changeset_evidence_mismatch');
    }
    if ((contribution as { readonly kind?: unknown }).kind === 'domain_fact') {
      const child = eventChangesetDomainFactEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query<never, [
        string, string, string, string, string, string, string, number, string
      ]>(`
        INSERT INTO review_changeset_domain_facts (
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
        INSERT INTO review_changeset_outbox_pointers (
          pointer_id, receipt_id, fact_id, source_kind
        ) VALUES (?, ?, ?, ?)
      `).run(child.pointerId, receiptId, child.factId, child.sourceKind);
    } else {
      const child = eventChangesetTimelineEvidenceChildSchema.parse(contribution);
      this.input.sqlite.query<never, [
        string, string, string, string, string, string, string, number
      ]>(`
        INSERT INTO review_changeset_timeline (
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
    if (!this.input.sqlite.inTransaction) throw new TypeError('review_changeset_transaction_required');
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('review_changeset_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('review_changeset_incomplete');
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

  private nextId(method: keyof SQLiteReviewChangesetEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('review_changeset_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }

  /** Ascending unique union of the exact per-action diff-owner grants. */
  private recordPermissionIds(
    record: StoredChangesetRecord
  ): readonly [PermissionId, ...PermissionId[]] {
    const permissions = new Set<PermissionId>();
    for (const revision of record.revisions) {
      for (const operation of revision.revision.operations) {
        const plan = operationPlan({ bundle: this.#bundle, operation });
        if (!plan) throw new TypeError('review_changeset_owner_mismatch');
        for (const permission of reviewDiffReadPermissionIdsForAction(plan.action)) {
          permissions.add(permission);
        }
      }
    }
    const sorted = [...permissions].sort();
    if (sorted.length === 0) throw new TypeError('review_changeset_permissions_missing');
    return sorted as unknown as readonly [PermissionId, ...PermissionId[]];
  }

  private requiredPermissionsGranted(
    record: StoredChangesetRecord,
    granted: ReadonlySet<string>
  ): boolean {
    return this.recordPermissionIds(record).every((permission) => granted.has(permission));
  }

  private planningSnapshot(repository: SQLiteReviewRepository): ChangesetPlanningSnapshot {
    return Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== reviewChangesetReadPort
            && (key as unknown) !== reviewDueDeadlinePlanningPort) {
          throw new TypeError('review_changeset_undeclared_read_port');
        }
        return repository as unknown as Port;
      }
    });
  }

  private commitTransaction(repository: SQLiteReviewRepository): ChangesetCommitTransaction {
    return Object.freeze({
      getPort<Port>(key: ChangesetValidationPortKey<Port> | ChangesetTransactionPortKey<Port>): Port {
        if ((key as unknown) !== reviewChangesetValidationPort
            && (key as unknown) !== reviewChangesetTransactionPort
            && (key as unknown) !== reviewDueDeadlineValidationPort
            && (key as unknown) !== reviewDueDeadlineTransactionPort) {
          throw new TypeError('review_changeset_undeclared_transaction_port');
        }
        return repository as unknown as Port;
      }
    });
  }

  /**
   * Current-state evidence for exact-commit validation: the review catalog,
   * candidate query, reviewer query, and Deadline catalog guards; the event and
   * every referenced `deadline:<id>` aggregate; per-subject review aggregates;
   * and the `review_head_absence` guard, published only while the head is truly
   * absent so a committed review always surfaces as `guard_changed`.
   */
  private currentCommitEvidence(input: {
    readonly record: StoredChangesetRecord;
    readonly repository: SQLiteReviewRepository;
  }) {
    const eventId = input.record.head.eventId;
    if (eventId === undefined) throw new TypeError('review_changeset_event_required');
    const scope: ReviewScopeDto = {
      workspaceId: parseWorkspaceId(input.record.head.workspaceId),
      eventId: parseEventId(eventId)
    };
    const repository = input.repository;
    const catalog = repository.readCatalog(scope);
    if (!catalog) throw new TypeError('review_changeset_domain_missing');
    const aggregateVersions = new Map<string, number>();
    const guardVersions = new Map<string, number>();
    const guardDigests = new Map<string, string>();

    aggregateVersions.set(reviewCatalogGuardId(eventId), catalog.version);
    guardVersions.set(reviewCatalogGuardId(eventId), catalog.version);
    guardDigests.set(reviewCatalogGuardId(eventId), catalog.digestSha256);

    const candidates = repository.readCandidates(scope);
    if (candidates) {
      guardVersions.set(`review_candidates:${eventId}`, candidates.version);
      guardDigests.set(
        `review_candidates:${eventId}`,
        reviewCandidateSetDigest(candidates.candidates)
      );
    }
    const reviewers = repository.readReviewerRoster(scope);
    if (reviewers) {
      guardVersions.set(`review_reviewers:${eventId}`, reviewers.version);
      guardDigests.set(`review_reviewers:${eventId}`, reviewRosterSetDigest(reviewers.reviewers));
    }
    const deadlineCatalog = repository.readDeadlineCatalog(scope);
    if (deadlineCatalog) {
      guardVersions.set(`deadline_catalog:${eventId}`, deadlineCatalog.version);
      guardDigests.set(`deadline_catalog:${eventId}`, deadlineCatalog.digestSha256);
    }
    const eventTimeBasis = repository.readDeadlineEventTimeBasis(scope);
    if (eventTimeBasis) aggregateVersions.set(`event:${eventId}`, eventTimeBasis.eventVersion);

    const head = input.record.revisions.at(-1);
    if (!head) throw new TypeError('review_changeset_revision_missing');
    for (const operation of head.revision.operations) {
      const plan = operationPlan({ bundle: this.#bundle, operation });
      if (!plan) throw new TypeError('review_changeset_owner_mismatch');
      for (const ref of operation.aggregateRefs) {
        const separator = ref.id.indexOf(':');
        if (separator < 0) continue;
        const kind = ref.id.slice(0, separator);
        const id = ref.id.slice(separator + 1);
        if (kind === 'deadline') {
          const current = repository.readDeadline(scope, id);
          if (current) aggregateVersions.set(ref.id, current.version);
        } else if (kind === 'review_round') {
          const current = repository.readRound(scope, id);
          if (current) aggregateVersions.set(ref.id, current.version);
        } else if (kind === 'review_assignment') {
          const current = repository.readAssignment(scope, id);
          if (current) aggregateVersions.set(ref.id, current.version);
        } else if (kind === 'review_draft') {
          const current = repository.readDraft(scope, id);
          if (current) aggregateVersions.set(ref.id, current.version);
        } else if (kind === 'review_head') {
          const current = repository.readReviewHead(scope, id);
          if (current) aggregateVersions.set(ref.id, current.version);
        }
      }
      for (const guard of operation.guardRefs) {
        if (!guard.id.startsWith('review_head_absence:')) continue;
        const assignmentId = guard.id.slice('review_head_absence:'.length);
        if (repository.readReviewHead(scope, assignmentId) === undefined) {
          guardVersions.set(guard.id, 1);
          guardDigests.set(guard.id, absentReviewHeadDigest(scope, assignmentId));
        }
      }
    }
    return Object.freeze({ aggregateVersions, guardVersions, guardDigests });
  }

  /**
   * The addressed record, only when it exists in this exact Workspace/Event
   * scope, resolves to the Review owner, and the caller holds every per-action
   * diff-owner grant the stored record unions. Every shortfall — absence,
   * foreign scope, foreign owner, or missing grants — returns `undefined` so
   * each caller refuses with the identical typed `scope_changed` outcome: a
   * partially privileged operator cannot distinguish a Review changeset above
   * their permission tier from one that does not exist.
   */
  private exactRecord(
    changesetId: string,
    eventId: EventId,
    grantedPermissionIds: ReadonlySet<string>
  ): StoredChangesetRecord | undefined {
    const record = this.lifecycleStore.read(changesetId);
    if (!record
        || record.head.workspaceId !== this.input.workspaceId
        || record.head.eventId !== eventId
        || this.resolveOwner(record)?.id !== REVIEW_CHANGESET_OWNER_ID
        || !this.requiredPermissionsGranted(record, grantedPermissionIds)) {
      return undefined;
    }
    return record;
  }
}

export function createSQLiteReviewChangesetEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly repository: SQLiteReviewRepository;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteReviewChangesetEffectIds;
}) {
  const adapter = new SQLiteReviewChangesetEffectDomainAdapter(input);
  return Object.freeze({
    ownerId: REVIEW_CHANGESET_OWNER_ID,
    capability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
    adapter,
    lifecycleStore: adapter.lifecycleStore,
    ownerResolution: adapter as ChangesetLifecycleOwnerResolutionSource,
    subjectRelationships: adapter.subjectRelationships
  });
}
