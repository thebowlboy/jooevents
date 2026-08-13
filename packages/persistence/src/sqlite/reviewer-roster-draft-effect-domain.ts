import { createHash } from 'node:crypto';
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
  reviewerRosterChangeDraftInputSchema,
  reviewerRosterChangeDraftOperationResultSchema,
  reviewerRosterMutationInputSchema
} from '@jooevents/contracts/reviewer-roster';
import {
  canonicalJsonText,
  encodeCanonicalJson,
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
  createReviewerRosterChangesetBundle,
  reviewerRosterChangesetReadPort,
  ReviewerRosterPlanningError,
  REVIEWER_ROSTER_CHANGESET_KIND,
  REVIEWER_ROSTER_CHANGESET_VERSION,
  type ReviewerRosterPlanningSource
} from '@jooevents/review/roster';
import {
  REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
  REVIEWER_ROSTER_DRAFT_HANDLER_CAPABILITY,
  REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
  REVIEWER_ROSTER_PERMISSION_IDS,
  reviewerRosterDraftContributionSchema,
  reviewerRosterDraftDomainContributionSchema,
  reviewerRosterDraftEvidenceChildSchema,
  sealReviewerRosterDraftPreparation
} from '@jooevents/review-operations/roster';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { createSQLiteDraftOnlyChangesetLifecycleStore } from './changeset-lifecycle';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteReviewerRosterRepository } from './reviewer-roster';

/**
 * The bounded approval policy every reviewer-roster changeset carries. Roster
 * mutations are consequential-risk but same-operator confirmable; a distinct
 * human approval path is not mounted for them.
 */
export const REVIEWER_ROSTER_CHANGE_APPROVAL_POLICY = (() => {
  const reference = Object.freeze({ key: 'policy.reviewer_roster.change.bounded', version: 1 });
  const definition = Object.freeze({ reference, requirement: 'none' as const });
  return Object.freeze({
    ...definition,
    definitionDigestSha256: createHash('sha256')
      .update(encodeCanonicalJson(definition))
      .digest('hex')
  });
})();

export const REVIEWER_ROSTER_DRAFT_EFFECT_SQL = `
CREATE TABLE reviewer_roster_draft_receipt_links (
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
  action TEXT NOT NULL CHECK(action IN ('register', 'set_scope', 'revoke', 'restore')),
  reviewer_id TEXT NOT NULL CHECK(length(reviewer_id) = 36),
  operation_name TEXT NOT NULL CHECK(operation_name = 'reviewer_roster.change.draft'),
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

CREATE TABLE reviewer_roster_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES reviewer_roster_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER reviewer_roster_draft_receipt_links_no_update
BEFORE UPDATE ON reviewer_roster_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'reviewer roster draft receipt links are immutable'); END;
CREATE TRIGGER reviewer_roster_draft_receipt_links_no_delete
BEFORE DELETE ON reviewer_roster_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'reviewer roster draft receipt links are immutable'); END;
CREATE TRIGGER reviewer_roster_draft_timeline_no_update
BEFORE UPDATE ON reviewer_roster_draft_timeline
BEGIN SELECT RAISE(ABORT, 'reviewer roster draft timeline is immutable'); END;
CREATE TRIGGER reviewer_roster_draft_timeline_no_delete
BEFORE DELETE ON reviewer_roster_draft_timeline
BEGIN SELECT RAISE(ABORT, 'reviewer roster draft timeline is immutable'); END;
`;

export function installReviewerRosterDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) {
    throw new TypeError('reviewer_roster_draft_schema_inside_transaction');
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(REVIEWER_ROSTER_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteReviewerRosterDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
}

const ID_METHODS = [
  'newChangesetId', 'newRevisionId', 'newPreparationHandle', 'newTimelineId'
] as const;

type DraftContribution = ReturnType<typeof reviewerRosterDraftContributionSchema.parse>;
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
    throw new TypeError(`reviewer_roster_draft_${label}_invalid`);
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
  kind: 'reviewer_roster.event_required' | 'changeset.id_collision'
): DraftContribution {
  return reviewerRosterDraftContributionSchema.parse({
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
  error: ReviewerRosterPlanningError,
  action: 'register' | 'set_scope' | 'revoke' | 'restore',
  reviewerId: string
): DraftContribution {
  return reviewerRosterDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'stale_revision', kind: 'reviewer_roster.changed', retryable: false,
        subjects: [{ type: 'reviewer', id: reviewerId }],
        detail: { code: error.code, action, reviewerId },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

/**
 * Drafts one reviewer-roster registration, scope, revoke, or restore change as an
 * inert changeset on the caller-owned SQLite handle. Effective roster state is
 * read for planning against current authority and scope-target facts but never
 * mutated; only the registered roster changeset owner commits a drafted plan.
 */
export class SQLiteReviewerRosterDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #changesets;
  readonly #bundle = createReviewerRosterChangesetBundle();
  readonly #ids: SQLiteReviewerRosterDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly sources: ReviewerRosterPlanningSource;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteReviewerRosterDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of ID_METHODS) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('reviewer_roster_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      ID_METHODS.map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteReviewerRosterDraftEffectIds);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('reviewer_roster_draft_transaction_required');
    }
    if (!sameReference(capability, REVIEWER_ROSTER_DRAFT_HANDLER_CAPABILITY)) {
      throw new TypeError('reviewer_roster_draft_capability_mismatch');
    }
    if (context.operation.name !== REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION.name
        || context.operation.version !== REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION.version
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('reviewer_roster_draft_scope_mismatch');
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
        || !sameReference(authority.lane.policy, REVIEWER_ROSTER_MANAGE_ACCESS_POLICY)
        || !REVIEWER_ROSTER_PERMISSION_IDS.every((permissionId) =>
          authority.grants.some((grant) =>
            grant.kind === 'permission' && grant.key === permissionId
          ))) throw new TypeError('reviewer_roster_draft_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId === undefined) {
      if (!current || current.currentEvent !== undefined) {
        throw new TypeError('reviewer_roster_draft_event_relationship_mismatch');
      }
      this.clearTransient();
      return sealReviewerRosterDraftPreparation({
        capability,
        context,
        preparation: {
          prepare: ({ businessInput, context: receivedContext }) => {
            if (receivedContext !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('reviewer_roster_draft_context_substitution');
            }
            reviewerRosterChangeDraftInputSchema.parse(businessInput);
            this.#nonterminalReleaseContext = context;
            return conflictContribution('reviewer_roster.event_required');
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
      throw new TypeError('reviewer_roster_draft_event_relationship_mismatch');
    }
    this.clearTransient();
    return sealReviewerRosterDraftPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('reviewer_roster_draft_context_substitution');
          }
          return this.prepare({ businessInput, context, eventId, actorUserId, evaluatedAt });
        }
      }
    });
  }

  private prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
  }): DraftContribution {
    const wire = reviewerRosterChangeDraftInputSchema.parse(input.businessInput);
    const scope = { workspaceId: this.input.workspaceId, eventId: input.eventId };
    const request = reviewerRosterMutationInputSchema.parse({ ...wire, scope });
    const repository = new SQLiteReviewerRosterRepository(this.input.sqlite, this.input.sources);
    const changesetId = parseChangesetId(this.nextId('newChangesetId'));
    const revisionId = parseChangesetRevisionId(this.nextId('newRevisionId'));
    const handle = this.nextId('newPreparationHandle');
    const timelineId = this.nextId('newTimelineId');
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== reviewerRosterChangesetReadPort) {
          throw new TypeError('reviewer_roster_draft_undeclared_read_port');
        }
        return repository as unknown as Port;
      }
    });
    const before = repository.readReviewerRoster(scope);
    if (!before) throw new TypeError('reviewer_roster_draft_scope_missing');
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
          kind: REVIEWER_ROSTER_CHANGESET_KIND,
          version: REVIEWER_ROSTER_CHANGESET_VERSION,
          dependencyGroup: 'reviewer_roster',
          authorInput: {
            request,
            attribution: { userId: input.actorUserId, occurredAt: input.evaluatedAt }
          }
        }],
        dependencyGroups: [{ key: 'reviewer_roster', dependsOn: [] }],
        approvalPolicy: REVIEWER_ROSTER_CHANGE_APPROVAL_POLICY,
        origin: 'human_ui'
      });
    } catch (error) {
      if (error instanceof ReviewerRosterPlanningError) {
        this.#nonterminalReleaseContext = input.context;
        return planningRefusal(error, wire.action, wire.reviewerId);
      }
      throw error;
    }
    if (appended.kind === 'refused') {
      if (appended.refusal.kind !== 'id_collision') {
        throw new TypeError('reviewer_roster_draft_unexpected_lifecycle_refusal');
      }
      this.#nonterminalReleaseContext = input.context;
      return conflictContribution('changeset.id_collision');
    }
    const after = repository.readReviewerRoster(scope);
    if (!after || canonicalJsonText(after) !== canonicalJsonText(before)) {
      throw new TypeError('reviewer_roster_draft_mutated_effective_state');
    }
    const revision = appended.record.revisions[0];
    const operation = revision?.revision.operations[0];
    if (!revision || !operation
        || appended.record.revisions.length !== 1
        || revision.revision.operations.length !== 1) {
      throw new TypeError('reviewer_roster_draft_record_incoherent');
    }
    const candidate = reviewerRosterDraftContributionSchema.parse({
      result: {
        kind: 'success',
        data: {
          changesetId,
          revision: { id: revisionId, digestSha256: revision.revision.digest },
          action: wire.action,
          reviewerId: wire.reviewerId
        }
      },
      domain: {
        kind: 'reviewer_roster_changeset_draft',
        preparationHandle: handle,
        workspaceId: this.input.workspaceId,
        eventId: input.eventId,
        changesetId,
        revisionId,
        revisionDigestSha256: revision.revision.digest,
        action: wire.action,
        reviewerId: wire.reviewerId,
        diffReadPermissionIds: ['event.manage'],
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
      throw new TypeError('reviewer_roster_draft_success_contribution_invalid');
    }
    const contribution = candidate as DraftSuccess;
    this.#prepared.set(handle, {
      handle,
      context: input.context,
      contribution,
      phase: 'prepared'
    });
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('reviewer_roster_draft_transaction_required');
    }
    const parsed = reviewerRosterDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('reviewer_roster_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = reviewerRosterChangeDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION.name
        || receipt.ref.operationVersion !== REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('reviewer_roster_draft_receipt_mismatch');
    }
    const domain = active.contribution.domain;
    const record = this.#changesets.read(domain.changesetId);
    if (!record) throw new TypeError('reviewer_roster_draft_record_missing');
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, string,
      string, number, number
    ]>(`
      INSERT INTO reviewer_roster_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action, reviewer_id,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, domain.workspaceId, domain.eventId, domain.changesetId, domain.revisionId,
      domain.revisionDigestSha256, record.recordDigestSha256, domain.action, domain.reviewerId,
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
      throw new TypeError('reviewer_roster_draft_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('reviewer_roster_draft_evidence_mismatch');
    }
    const child = reviewerRosterDraftEvidenceChildSchema.parse(contribution);
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO reviewer_roster_draft_timeline (
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
      throw new TypeError('reviewer_roster_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('reviewer_roster_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('reviewer_roster_draft_incomplete');
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

  private nextId(method: keyof SQLiteReviewerRosterDraftEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('reviewer_roster_draft_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteReviewerRosterDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly sources: ReviewerRosterPlanningSource;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteReviewerRosterDraftEffectIds;
}) {
  const adapter = new SQLiteReviewerRosterDraftEffectDomainAdapter(input);
  return Object.freeze({
    capability: REVIEWER_ROSTER_DRAFT_HANDLER_CAPABILITY,
    adapter
  });
}
