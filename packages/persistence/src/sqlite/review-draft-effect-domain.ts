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
  reviewChangeDraftOperationResultSchema,
  reviewEvaluationChangeDraftInputSchema,
  reviewMutationPlanningInputSchema,
  reviewRoundChangeDraftInputSchema,
  reviewStepBackChangeDraftInputSchema,
  type ReviewCriterionDto,
  type ReviewScopeDto
} from '@jooevents/contracts/reviews';
import { reviewDueDeadlinePlanningPort } from '@jooevents/deadline';
import type { PermissionId, VersionedAccessPolicyRef } from '@jooevents/identity-access';
import {
  canonicalJsonText,
  isApplicationId,
  parseChangesetId,
  parseChangesetRevisionId,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  createDefaultReviewCriteria,
  createReviewChangesetBundle,
  expectedReviewAssignmentPairs,
  reviewChangesetReadPort,
  ReviewPlanningError,
  REVIEW_CORE_CHANGESET_KIND,
  REVIEW_CORE_CHANGESET_VERSION
} from '@jooevents/review';
import {
  REVIEW_CHANGE_APPROVAL_POLICY,
  REVIEW_CHANGE_DRAFT_HANDLER_CAPABILITY,
  REVIEW_EVALUATE_ACCESS_POLICY,
  REVIEW_EVALUATE_PERMISSION_IDS,
  REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
  REVIEW_MANAGE_ACCESS_POLICY,
  REVIEW_MANAGE_PERMISSION_IDS,
  REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
  REVIEW_STEP_BACK_ACCESS_POLICY,
  REVIEW_STEP_BACK_DRAFT_OPERATION,
  REVIEW_STEP_BACK_PERMISSION_IDS,
  reviewChangesetDraftContributionSchema,
  reviewChangesetDraftDomainContributionSchema,
  reviewChangesetDraftEvidenceChildSchema,
  reviewDiffReadPermissionIdsForAction,
  reviewOpenRoundVisibilityPolicy,
  sealReviewChangeDraftPreparation,
  type ReviewChangesetAction
} from '@jooevents/review-operations';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { createSQLiteDraftOnlyChangesetLifecycleStore } from './changeset-lifecycle';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import type { SQLiteReviewRepository } from './review';

/**
 * Inert Review changeset-draft evidence. One receipt-link table serves all three
 * draft operations because they share one handler capability; the action/operation
 * CHECK pins each drafted action to the exact operation that may produce it.
 */
export const REVIEW_DRAFT_EFFECT_SQL = `
CREATE TABLE review_draft_receipt_links (
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
    'open_round', 'discard_empty_round', 'step_back', 'commit_review', 'amend_review'
  )),
  operation_name TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (action IN ('open_round', 'discard_empty_round')
      AND operation_name = 'review.round.change.draft')
    OR (action = 'step_back' AND operation_name = 'review.assignment.step-back.draft')
    OR (action IN ('commit_review', 'amend_review')
      AND operation_name = 'review.evaluation.change.draft')
  ),
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

CREATE TABLE review_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES review_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER review_draft_receipt_links_no_update
BEFORE UPDATE ON review_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'review draft receipt links are immutable'); END;
CREATE TRIGGER review_draft_receipt_links_no_delete
BEFORE DELETE ON review_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'review draft receipt links are immutable'); END;
CREATE TRIGGER review_draft_timeline_no_update
BEFORE UPDATE ON review_draft_timeline
BEGIN SELECT RAISE(ABORT, 'review draft timeline is immutable'); END;
CREATE TRIGGER review_draft_timeline_no_delete
BEFORE DELETE ON review_draft_timeline
BEGIN SELECT RAISE(ABORT, 'review draft timeline is immutable'); END;
`;

export function installReviewDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('review_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(REVIEW_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteReviewDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
  newRoundId(): string;
  /** Identity of the `review_due` Deadline the open-round contribution creates. */
  newDeadlineId(): string;
  newCriterionId(): string;
  newAssignmentId(): string;
  newReviewRevisionId(): string;
}

const ID_METHODS = [
  'newChangesetId', 'newRevisionId', 'newPreparationHandle', 'newTimelineId',
  'newRoundId', 'newDeadlineId', 'newCriterionId', 'newAssignmentId',
  'newReviewRevisionId'
] as const;

interface OperationSpec {
  readonly operation: { readonly name: string; readonly version: number };
  readonly policy: VersionedAccessPolicyRef;
  readonly permissionIds: readonly PermissionId[];
  readonly needsReviewer: boolean;
  parse(businessInput: unknown): Record<string, unknown> & { readonly action: ReviewChangesetAction };
}

const OPERATION_SPECS: readonly OperationSpec[] = Object.freeze([
  Object.freeze({
    operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
    policy: REVIEW_MANAGE_ACCESS_POLICY,
    permissionIds: REVIEW_MANAGE_PERMISSION_IDS,
    needsReviewer: false,
    parse: (businessInput: unknown) => reviewRoundChangeDraftInputSchema.parse(businessInput)
  }),
  Object.freeze({
    operation: REVIEW_STEP_BACK_DRAFT_OPERATION,
    policy: REVIEW_STEP_BACK_ACCESS_POLICY,
    permissionIds: REVIEW_STEP_BACK_PERMISSION_IDS,
    needsReviewer: true,
    parse: (businessInput: unknown) => reviewStepBackChangeDraftInputSchema.parse(businessInput)
  }),
  Object.freeze({
    operation: REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
    policy: REVIEW_EVALUATE_ACCESS_POLICY,
    permissionIds: REVIEW_EVALUATE_PERMISSION_IDS,
    needsReviewer: true,
    parse: (businessInput: unknown) => reviewEvaluationChangeDraftInputSchema.parse(businessInput)
  })
]);

type DraftContribution = ReturnType<typeof reviewChangesetDraftContributionSchema.parse>;
type DraftSuccess = Extract<DraftContribution, { readonly result: { readonly kind: 'success' } }>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete';
  receiptId?: string;
}

function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) {
    throw new TypeError(`review_draft_${label}_invalid`);
  }
  return value;
}

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext, eventId?: EventId): boolean {
  return context.scope.eventId === eventId
    && context.scope.subjects.length === (eventId === undefined ? 1 : 2)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && (eventId === undefined || context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId
    ));
}

function conflictContribution(kind: 'review.event_required' | 'review.viewer_required' | 'changeset.id_collision'): DraftContribution {
  return reviewChangesetDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind, retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function planningRefusal(
  error: ReviewPlanningError,
  action: ReviewChangesetAction,
  subjectId: string
): DraftContribution {
  const subjectType = action === 'open_round' || action === 'discard_empty_round'
    ? 'review_round'
    : action === 'step_back'
      ? 'review_assignment'
      : 'review';
  return reviewChangesetDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'stale_revision', kind: 'review.canonical_changed', retryable: false,
        subjects: [{ type: subjectType, id: subjectId }],
        detail: { code: error.code, action, subjectId },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

/**
 * Drafts every guarded Review change — round open/discard, reviewer step-back,
 * and evaluation commit/amend — as an inert changeset on the caller-owned SQLite
 * handle. One adapter serves all three draft operations because they share the
 * Review change-draft handler capability; the lane policy, required grants, and
 * diff-owner permission ids are re-derived per action. Drafting never touches
 * the Review catalog, assignments, drafts, heads, or the Deadline domain.
 */
export class SQLiteReviewDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #changesets;
  readonly #bundle = createReviewChangesetBundle();
  readonly #ids: SQLiteReviewDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteReviewRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteReviewDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of ID_METHODS) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('review_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      ID_METHODS.map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteReviewDraftEffectIds);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('review_draft_transaction_required');
    }
    if (!sameReference(capability, REVIEW_CHANGE_DRAFT_HANDLER_CAPABILITY)) {
      throw new TypeError('review_draft_capability_mismatch');
    }
    const spec = OPERATION_SPECS.find((candidate) =>
      candidate.operation.name === context.operation.name
      && candidate.operation.version === context.operation.version);
    if (spec === undefined
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('review_draft_scope_mismatch');
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
        || !sameReference(authority.lane.policy, spec.policy)
        || !spec.permissionIds.every((permissionId) => authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === permissionId
        ))) throw new TypeError('review_draft_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const membershipId: string = authority.principal.membershipId;
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId === undefined) {
      if (!current || current.currentEvent !== undefined) {
        throw new TypeError('review_draft_event_relationship_mismatch');
      }
      this.clearTransient();
      return sealReviewChangeDraftPreparation({
        capability,
        context,
        preparation: {
          prepare: ({ businessInput, context: receivedContext }) => {
            if (receivedContext !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('review_draft_context_substitution');
            }
            spec.parse(businessInput);
            this.#nonterminalReleaseContext = context;
            return conflictContribution('review.event_required');
          }
        }
      });
    }
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite,
      workspaceId: this.input.workspaceId,
      eventId,
      userId: actorUserId,
      evaluatedAt
    });
    if (relationship.kind !== 'valid'
        || current?.currentEvent?.id !== eventId
        || current.currentEvent.workspaceId !== this.input.workspaceId) {
      throw new TypeError('review_draft_event_relationship_mismatch');
    }
    this.clearTransient();

    return sealReviewChangeDraftPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('review_draft_context_substitution');
          }
          return this.prepare({
            spec,
            businessInput,
            context,
            eventId,
            actorUserId,
            membershipId,
            evaluatedAt
          });
        }
      }
    });
  }

  private prepare(input: {
    readonly spec: OperationSpec;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly membershipId: string;
    readonly evaluatedAt: Instant;
  }): DraftContribution {
    const wire = input.spec.parse(input.businessInput);
    const action = wire.action;
    const scope: ReviewScopeDto = { workspaceId: this.input.workspaceId, eventId: input.eventId };
    const repository = this.input.repository;

    let reviewerId: string | undefined;
    if (input.spec.needsReviewer) {
      reviewerId = repository.resolveActingReviewer(scope, input.membershipId);
      if (reviewerId === undefined) {
        this.#nonterminalReleaseContext = input.context;
        return conflictContribution('review.viewer_required');
      }
    }

    const changesetId = parseChangesetId(this.nextId('newChangesetId'));
    const revisionId = parseChangesetRevisionId(this.nextId('newRevisionId'));
    const handle = this.nextId('newPreparationHandle');
    const timelineId = this.nextId('newTimelineId');

    const attribution = {
      attributedByUserId: input.actorUserId,
      attributedAt: input.evaluatedAt
    };
    let authorValue: Record<string, unknown>;
    let subjectId: string;
    if (action === 'open_round') {
      const open = wire as unknown as {
        readonly deadlineDate: string;
        readonly criteria?: readonly ReviewCriterionDto[];
        readonly anonymized: boolean;
      };
      const roundId = this.nextId('newRoundId');
      const criteria = open.criteria
        ?? createDefaultReviewCriteria(
          this.nextId('newCriterionId') as ReviewCriterionDto['id']
        );
      const candidates = repository.readCandidates(scope);
      const roster = repository.readReviewerRoster(scope);
      const pairs = candidates && roster
        ? expectedReviewAssignmentPairs({
            candidates: candidates.candidates,
            reviewers: roster.reviewers
          })
        : [];
      authorValue = {
        action,
        scope,
        expectedCatalogVersion: repository.readCatalog(scope)?.version ?? 1,
        roundId,
        deadlineIdentity: { deadlineId: this.nextId('newDeadlineId') },
        deadlineDate: open.deadlineDate,
        criteria,
        visibility: reviewOpenRoundVisibilityPolicy(open.anonymized),
        assignmentIds: pairs.map((pair) => ({
          ...pair,
          assignmentId: this.nextId('newAssignmentId')
        })),
        ...attribution
      };
      subjectId = roundId;
    } else if (action === 'discard_empty_round') {
      const discard = wire as unknown as {
        readonly roundId: string;
        readonly expectedRoundVersion: number;
      };
      authorValue = { action, scope, ...discard, ...attribution };
      subjectId = discard.roundId;
    } else if (action === 'step_back') {
      const step = wire as unknown as {
        readonly assignmentId: string;
        readonly expectedAssignmentVersion: number;
      };
      authorValue = { action, scope, ...step, reviewerId, ...attribution };
      subjectId = step.assignmentId;
    } else if (action === 'commit_review') {
      const commit = wire as unknown as {
        readonly assignmentId: string;
        readonly expectedAssignmentVersion: number;
        readonly expectedDraftVersion: number;
      };
      authorValue = {
        action, scope, ...commit,
        revisionId: this.nextId('newReviewRevisionId'),
        reviewerId,
        ...attribution
      };
      subjectId = commit.assignmentId;
    } else {
      const amend = wire as unknown as {
        readonly assignmentId: string;
        readonly expectedAssignmentVersion: number;
        readonly expectedReviewVersion: number;
        readonly expectedCurrentRevisionId: string;
        readonly scores: readonly { readonly criterionId: string; readonly score: number }[];
        readonly comment: string;
      };
      authorValue = {
        action, scope, ...amend,
        revisionId: this.nextId('newReviewRevisionId'),
        reviewerId,
        ...attribution
      };
      subjectId = amend.assignmentId;
    }
    const author = reviewMutationPlanningInputSchema.parse(authorValue);

    const before = this.inertEvidence(scope, subjectId);
    const snapshot = this.planningSnapshot();
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
          newCorrectionAttemptId: () => {
            throw new TypeError('correction_id_unavailable_during_draft');
          }
        },
        context: {
          workspaceId: this.input.workspaceId,
          eventId: input.eventId,
          principalKey: `workspace_user:${input.actorUserId}`,
          authorityPrincipalKey: input.context.authorityPrincipalKey,
          evaluatedAt: input.evaluatedAt
        },
        operations: [{
          kind: REVIEW_CORE_CHANGESET_KIND,
          version: REVIEW_CORE_CHANGESET_VERSION,
          dependencyGroup: 'review',
          authorInput: author
        }],
        dependencyGroups: [{ key: 'review', dependsOn: [] }],
        approvalPolicy: REVIEW_CHANGE_APPROVAL_POLICY,
        origin: 'human_ui'
      });
    } catch (error) {
      if (error instanceof ReviewPlanningError) {
        this.#nonterminalReleaseContext = input.context;
        return planningRefusal(error, action, subjectId);
      }
      throw error;
    }
    if (appended.kind === 'refused') {
      if (appended.refusal.kind !== 'id_collision') {
        throw new TypeError('review_draft_unexpected_lifecycle_refusal');
      }
      this.#nonterminalReleaseContext = input.context;
      return conflictContribution('changeset.id_collision');
    }
    if (this.inertEvidence(scope, subjectId) !== before) {
      throw new TypeError('review_draft_mutated_effective_state');
    }
    const revision = appended.record.revisions[0];
    const operation = revision?.revision.operations[0];
    if (!revision || !operation
        || appended.record.revisions.length !== 1
        || revision.revision.operations.length !== 1) {
      throw new TypeError('review_draft_record_incoherent');
    }
    const candidate = reviewChangesetDraftContributionSchema.parse({
      result: {
        kind: 'success',
        data: {
          schemaVersion: 1,
          action,
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
          safeDiff: operation.safeDiff
        }
      },
      domain: {
        kind: 'review_changeset_draft',
        preparationHandle: handle,
        workspaceId: this.input.workspaceId,
        eventId: input.eventId,
        changesetId,
        revisionId,
        revisionDigestSha256: revision.revision.digest,
        recordDigestSha256: appended.record.recordDigestSha256,
        action,
        diffReadPermissionIds: [...reviewDiffReadPermissionIdsForAction(action)],
        occurredAt: input.evaluatedAt
      },
      receiptChildren: [{
        kind: 'timeline',
        timelineId,
        sourceKind: 'changeset_revision',
        workspaceId: this.input.workspaceId,
        eventId: input.eventId,
        changesetId,
        revisionId,
        occurredAt: input.evaluatedAt
      }]
    });
    if (candidate.result.kind !== 'success' || candidate.domain === null) {
      throw new TypeError('review_draft_success_contribution_invalid');
    }
    const contribution = candidate as DraftSuccess;
    this.#prepared.set(handle, { handle, context: input.context, contribution, phase: 'prepared' });
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('review_draft_transaction_required');
    }
    const parsed = reviewChangesetDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('review_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = reviewChangeDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== active.context.operation.name
        || receipt.ref.operationVersion !== active.context.operation.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('review_draft_receipt_mismatch');
    }
    const domain = active.contribution.domain;
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, string,
      number, number
    ]>(`
      INSERT INTO review_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, domain.workspaceId, domain.eventId, domain.changesetId, domain.revisionId,
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
        || !this.#expectedIdentity || active.receiptId !== receiptId) {
      throw new TypeError('review_draft_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('review_draft_evidence_mismatch');
    }
    const child = reviewChangesetDraftEvidenceChildSchema.parse(contribution);
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO review_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id, changeset_id,
        revision_id, occurred_at_ms, source_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      child.timelineId, receiptId, child.workspaceId, child.eventId,
      child.changesetId, child.revisionId, Date.parse(child.occurredAt), child.sourceKind
    );
    active.phase = 'evidence_complete';
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('review_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('review_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('review_draft_incomplete');
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

  private nextId(method: keyof SQLiteReviewDraftEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('review_draft_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }

  private planningSnapshot(): ChangesetPlanningSnapshot {
    const repository = this.input.repository;
    return Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) === reviewChangesetReadPort
            || (key as unknown) === reviewDueDeadlinePlanningPort) {
          return repository as unknown as Port;
        }
        throw new TypeError('review_draft_undeclared_read_port');
      }
    });
  }

  /** Canonical proof material that drafting left effective Review state alone. */
  private inertEvidence(scope: ReviewScopeDto, subjectId: string): string {
    return canonicalJsonText({
      catalog: this.input.repository.readCatalog(scope) ?? null,
      assignment: this.input.repository.readAssignment(scope, subjectId) ?? null,
      draft: this.input.repository.readDraft(scope, subjectId) ?? null,
      head: this.input.repository.readReviewHead(scope, subjectId) ?? null,
      deadlineCatalog: this.input.repository.readDeadlineCatalog(scope) ?? null
    });
  }
}

export function createSQLiteReviewDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly repository: SQLiteReviewRepository;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteReviewDraftEffectIds;
}) {
  const adapter = new SQLiteReviewDraftEffectDomainAdapter(input);
  return Object.freeze({
    capability: REVIEW_CHANGE_DRAFT_HANDLER_CAPABILITY,
    adapter
  });
}
