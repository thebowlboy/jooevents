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
  reviewDraftSaveInputSchema,
  reviewDraftSaveOperationResultSchema,
  type ReviewScopeDto
} from '@jooevents/contracts/reviews';
import {
  canonicalJsonText,
  isApplicationId,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import { ReviewPlanningError, saveReviewDraft } from '@jooevents/review';
import {
  REVIEW_DRAFT_SAVE_HANDLER_CAPABILITY,
  REVIEW_EVALUATE_ACCESS_POLICY,
  REVIEW_EVALUATE_PERMISSION_IDS,
  REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
  reviewEvaluationDraftSaveContributionSchema,
  reviewEvaluationDraftSavedDomainContributionSchema,
  sealReviewEvaluationDraftSavePreparation
} from '@jooevents/review-operations';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import type { SQLiteReviewRepository } from './review';

/**
 * Terminal receipt evidence for the sanctioned non-changeset Review write: the
 * reviewer's own evaluation draft save. Exactly one link row per receipt, and a
 * given (assignment, draft version) is saved at most once.
 */
export const REVIEW_EVALUATION_DRAFT_SAVE_EFFECT_SQL = `
CREATE TABLE review_evaluation_draft_save_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  operation_name TEXT NOT NULL CHECK(operation_name = 'review.evaluation.draft.save'),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (receipt_id)
    REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(workspace_id, event_id, assignment_id, draft_version)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER review_evaluation_draft_save_receipt_links_no_update
BEFORE UPDATE ON review_evaluation_draft_save_receipt_links
BEGIN SELECT RAISE(ABORT, 'review draft-save receipt links are immutable'); END;
CREATE TRIGGER review_evaluation_draft_save_receipt_links_no_delete
BEFORE DELETE ON review_evaluation_draft_save_receipt_links
BEGIN SELECT RAISE(ABORT, 'review draft-save receipt links are immutable'); END;
`;

export function installReviewEvaluationDraftSaveEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) {
    throw new TypeError('review_draft_save_schema_inside_transaction');
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(REVIEW_EVALUATION_DRAFT_SAVE_EFFECT_SQL)).immediate();
}

export interface SQLiteReviewEvaluationDraftSaveEffectIds {
  newPreparationHandle(): string;
}

type SaveContribution = ReturnType<typeof reviewEvaluationDraftSaveContributionSchema.parse>;
type SaveSuccess = Extract<SaveContribution, { readonly result: { readonly kind: 'success' } }>;

interface PreparedSave {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly contribution: SaveSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked';
  receiptId?: string;
}

function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) {
    throw new TypeError(`review_draft_save_${label}_invalid`);
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

function conflictContribution(
  kind: 'review.event_required' | 'review.viewer_required'
): SaveContribution {
  return reviewEvaluationDraftSaveContributionSchema.parse({
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

function planningRefusal(error: ReviewPlanningError, assignmentId: string): SaveContribution {
  return reviewEvaluationDraftSaveContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'stale_revision', kind: 'review.canonical_changed', retryable: false,
        subjects: [{ type: 'review', id: assignmentId }],
        detail: { code: error.code, action: 'commit_review', subjectId: assignmentId },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

/**
 * Saves one reviewer evaluation draft inside the Foundation effect unit of work.
 * The save is the sanctioned non-changeset Review write: it touches only the
 * acting reviewer's own `review_drafts` row through the frozen `saveReviewDraft`
 * ceremony, never the round, assignment, head, or Deadline state.
 */
export class SQLiteReviewEvaluationDraftSaveEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #ids: SQLiteReviewEvaluationDraftSaveEffectIds;
  readonly #prepared = new Map<string, PreparedSave>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedSave | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteReviewRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteReviewEvaluationDraftSaveEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    if (typeof input.ids.newPreparationHandle !== 'function') {
      throw new TypeError('review_draft_save_id_factory_invalid');
    }
    this.#ids = Object.freeze({
      newPreparationHandle: input.ids.newPreparationHandle.bind(input.ids)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('review_draft_save_transaction_required');
    }
    if (!sameReference(capability, REVIEW_DRAFT_SAVE_HANDLER_CAPABILITY)) {
      throw new TypeError('review_draft_save_capability_mismatch');
    }
    if (context.operation.name !== REVIEW_EVALUATION_DRAFT_SAVE_OPERATION.name
        || context.operation.version !== REVIEW_EVALUATION_DRAFT_SAVE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('review_draft_save_scope_mismatch');
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
        || !sameReference(authority.lane.policy, REVIEW_EVALUATE_ACCESS_POLICY)
        || !REVIEW_EVALUATE_PERMISSION_IDS.every((permissionId) =>
          authority.grants.some((grant) =>
            grant.kind === 'permission' && grant.key === permissionId
          ))) throw new TypeError('review_draft_save_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const membershipId: string = authority.principal.membershipId;
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId === undefined) {
      if (!current || current.currentEvent !== undefined) {
        throw new TypeError('review_draft_save_event_relationship_mismatch');
      }
      this.clearTransient();
      return sealReviewEvaluationDraftSavePreparation({
        capability,
        context,
        preparation: {
          prepare: ({ businessInput, context: receivedContext }) => {
            if (receivedContext !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('review_draft_save_context_substitution');
            }
            reviewDraftSaveInputSchema.parse(businessInput);
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
      throw new TypeError('review_draft_save_event_relationship_mismatch');
    }
    this.clearTransient();
    return sealReviewEvaluationDraftSavePreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('review_draft_save_context_substitution');
          }
          return this.prepare({
            businessInput, context, eventId, actorUserId, membershipId, evaluatedAt
          });
        }
      }
    });
  }

  private prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly membershipId: string;
    readonly evaluatedAt: Instant;
  }): SaveContribution {
    const wire = reviewDraftSaveInputSchema.parse(input.businessInput);
    const scope: ReviewScopeDto = { workspaceId: this.input.workspaceId, eventId: input.eventId };
    const reviewerId = this.input.repository.resolveActingReviewer(scope, input.membershipId);
    if (reviewerId === undefined) {
      this.#nonterminalReleaseContext = input.context;
      return conflictContribution('review.viewer_required');
    }
    let saved: ReturnType<typeof saveReviewDraft>;
    try {
      saved = saveReviewDraft({
        scope,
        reviewerId,
        attributedByUserId: input.actorUserId,
        attributedAt: input.evaluatedAt,
        businessInput: wire,
        transaction: this.input.repository
      });
    } catch (error) {
      if (error instanceof ReviewPlanningError) {
        this.#nonterminalReleaseContext = input.context;
        return planningRefusal(error, wire.assignmentId);
      }
      throw error;
    }
    const handle = this.nextId('newPreparationHandle');
    const candidate = reviewEvaluationDraftSaveContributionSchema.parse({
      result: { kind: 'success', data: saved },
      domain: {
        kind: 'review_evaluation_draft_saved',
        preparationHandle: handle,
        workspaceId: this.input.workspaceId,
        eventId: input.eventId,
        assignmentId: saved.draft.assignmentId,
        draftVersion: saved.draft.version,
        occurredAt: input.evaluatedAt
      },
      receiptChildren: []
    });
    if (candidate.result.kind !== 'success' || candidate.domain === null) {
      throw new TypeError('review_draft_save_success_contribution_invalid');
    }
    const contribution = candidate as SaveSuccess;
    this.#prepared.set(handle, {
      handle, context: input.context, contribution, phase: 'prepared'
    });
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('review_draft_save_transaction_required');
    }
    const parsed = reviewEvaluationDraftSavedDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('review_draft_save_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = reviewDraftSaveOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== REVIEW_EVALUATION_DRAFT_SAVE_OPERATION.name
        || receipt.ref.operationVersion !== REVIEW_EVALUATION_DRAFT_SAVE_OPERATION.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('review_draft_save_receipt_mismatch');
    }
    const domain = active.contribution.domain;
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query<never, [string, string, string, string, number, string, number, number]>(`
      INSERT INTO review_evaluation_draft_save_receipt_links (
        receipt_id, workspace_id, event_id, assignment_id, draft_version,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, domain.workspaceId, domain.eventId, domain.assignmentId, domain.draftVersion,
      active.context.operation.name, active.context.operation.version,
      Date.parse(domain.occurredAt)
    );
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(): void {
    throw new TypeError('review_draft_save_expects_no_receipt_children');
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('review_draft_save_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('review_draft_save_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'parent_linked' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('review_draft_save_incomplete');
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

  private nextId(method: keyof SQLiteReviewEvaluationDraftSaveEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('review_draft_save_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteReviewEvaluationDraftSaveEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly repository: SQLiteReviewRepository;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteReviewEvaluationDraftSaveEffectIds;
}) {
  const adapter = new SQLiteReviewEvaluationDraftSaveEffectDomainAdapter(input);
  return Object.freeze({
    capability: REVIEW_DRAFT_SAVE_HANDLER_CAPABILITY,
    adapter
  });
}
