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
import type { ChangesetPlanningSnapshot, ChangesetReadPortKey } from '@jooevents/changesets';
import { appendChangesetDraftSynchronous } from '@jooevents/changeset-operations';
import {
  deadlineChangeDraftInputSchema,
  deadlineDraftOperationResultSchema,
  deadlineIdSchema,
  type DeadlineChangeDraftInput,
  type DeadlineMutationPlanningInput
} from '@jooevents/contracts/deadlines';
import {
  canonicalJsonText,
  isApplicationId,
  parseChangesetId,
  parseChangesetRevisionId,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  createDeadlineChangesetBundle,
  deadlineChangesetReadPort,
  DeadlinePlanningError,
  DEADLINE_CHANGESET_KIND,
  DEADLINE_CHANGESET_VERSION
} from '@jooevents/deadline';
import {
  DEADLINE_CHANGE_DRAFT_OPERATION,
  DEADLINE_DRAFT_APPROVAL_POLICY,
  DEADLINE_DRAFT_HANDLER_CAPABILITY,
  DEADLINE_MANAGE_ACCESS_POLICY,
  DEADLINE_MANAGE_PERMISSION_ID,
  deadlineDraftContributionSchema,
  deadlineDraftDomainContributionSchema,
  deadlineDraftEvidenceChildSchema,
  sealDeadlineDraftPreparation,
  type DeadlineDraftContribution
} from '@jooevents/deadline-operations';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { createSQLiteDraftOnlyChangesetLifecycleStore } from './changeset-lifecycle';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteDeadlineRepository } from './deadline';

export const DEADLINE_DRAFT_EFFECT_SQL = `
CREATE TABLE deadline_draft_receipt_links (
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
  action TEXT NOT NULL CHECK(action IN ('create', 'update', 'clear')),
  operation_name TEXT NOT NULL CHECK(operation_name = 'deadline.change.draft'),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (receipt_id) REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id, workspace_id, event_id)
    REFERENCES changeset_heads(changeset_id, workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id, revision_id, revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(receipt_id, workspace_id, event_id, changeset_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE deadline_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES deadline_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER deadline_draft_receipt_links_no_update
BEFORE UPDATE ON deadline_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'deadline draft receipt links are immutable'); END;
CREATE TRIGGER deadline_draft_receipt_links_no_delete
BEFORE DELETE ON deadline_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'deadline draft receipt links are immutable'); END;
CREATE TRIGGER deadline_draft_timeline_no_update
BEFORE UPDATE ON deadline_draft_timeline
BEGIN SELECT RAISE(ABORT, 'deadline draft timeline is immutable'); END;
CREATE TRIGGER deadline_draft_timeline_no_delete
BEFORE DELETE ON deadline_draft_timeline
BEGIN SELECT RAISE(ABORT, 'deadline draft timeline is immutable'); END;
`;

export function installDeadlineDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('deadline_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(DEADLINE_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteDeadlineDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newDeadlineId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
}

type DraftSuccess = Extract<
  DeadlineDraftContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete';
  receiptId?: string;
}

function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) {
    throw new TypeError(`deadline_draft_${label}_invalid`);
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

function planningInput(input: {
  readonly wire: DeadlineChangeDraftInput;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly actorUserId: string;
  readonly evaluatedAt: string;
  readonly newDeadlineId: () => string;
}): DeadlineMutationPlanningInput {
  const scope = { workspaceId: input.workspaceId, eventId: input.eventId };
  return input.wire.action === 'create'
    ? {
        ...input.wire,
        scope,
        deadlineId: deadlineIdSchema.parse(input.newDeadlineId()),
        attributedByUserId: input.actorUserId,
        attributedAt: input.evaluatedAt
      }
    : {
        ...input.wire,
        scope,
        attributedByUserId: input.actorUserId,
        attributedAt: input.evaluatedAt
      };
}

function eventRequiredContribution(): DeadlineDraftContribution {
  return deadlineDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'deadline.event_required', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function collisionContribution(): DeadlineDraftContribution {
  return deadlineDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'changeset.id_collision', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function planningRefusal(
  error: DeadlinePlanningError,
  input: DeadlineMutationPlanningInput
): DeadlineDraftContribution {
  if (error.code === 'deadline_unchanged') {
    return deadlineDraftContributionSchema.parse({
      result: {
        kind: 'outcome',
        outcome: {
          class: 'conflict', kind: 'deadline.no_change', retryable: false,
          subjects: [{ type: 'deadline', id: input.deadlineId }],
          detail: null,
          detailSchemaVersion: 1
        }
      },
      domain: null,
      receiptChildren: []
    });
  }
  return deadlineDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'stale_revision', kind: 'deadline.canonical_changed', retryable: false,
        subjects: [{ type: 'deadline', id: input.deadlineId }],
        detail: { code: error.code, action: input.action, deadlineId: input.deadlineId },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

export class SQLiteDeadlineDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly deadlineRead: Pick<SQLiteDeadlineRepository, 'readDeadlineCatalog'>;
  readonly #changesets;
  readonly #ids: SQLiteDeadlineDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteDeadlineDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newDeadlineId',
      'newPreparationHandle', 'newTimelineId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('deadline_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newDeadlineId',
        'newPreparationHandle', 'newTimelineId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteDeadlineDraftEffectIds);
    const readRepository = this.repository();
    this.deadlineRead = Object.freeze({
      readDeadlineCatalog: readRepository.readDeadlineCatalog.bind(readRepository)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('deadline_draft_transaction_required');
    }
    if (!sameReference(capability, DEADLINE_DRAFT_HANDLER_CAPABILITY)) {
      throw new TypeError('deadline_draft_capability_mismatch');
    }
    if (context.operation.name !== DEADLINE_CHANGE_DRAFT_OPERATION.name
        || context.operation.version !== DEADLINE_CHANGE_DRAFT_OPERATION.version
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('deadline_draft_scope_mismatch');
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
        || !sameReference(authority.lane.policy, DEADLINE_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === DEADLINE_MANAGE_PERMISSION_ID
        )) throw new TypeError('deadline_draft_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId === undefined) {
      if (!current || current.currentEvent !== undefined) {
        throw new TypeError('deadline_draft_event_relationship_mismatch');
      }
      this.#prepared.clear();
      this.#active = undefined;
      this.#expectedIdentity = undefined;
      this.#nonterminalReleaseContext = undefined;
      return sealDeadlineDraftPreparation({
        capability,
        context,
        preparation: {
          prepare: ({ businessInput, context: receivedContext }) => {
            if (receivedContext !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('deadline_draft_context_substitution');
            }
            deadlineChangeDraftInputSchema.parse(businessInput);
            this.#nonterminalReleaseContext = context;
            return eventRequiredContribution();
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
      throw new TypeError('deadline_draft_event_relationship_mismatch');
    }
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;

    const repository = this.repository();
    const bundle = createDeadlineChangesetBundle();
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== deadlineChangesetReadPort) {
          throw new TypeError('deadline_draft_undeclared_read_port');
        }
        return repository as unknown as Port;
      }
    });

    return sealDeadlineDraftPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('deadline_draft_context_substitution');
          }
          const wire = deadlineChangeDraftInputSchema.parse(businessInput);
          const changesetId = parseChangesetId(this.nextId('newChangesetId'));
          const revisionId = parseChangesetRevisionId(this.nextId('newRevisionId'));
          const handle = this.nextId('newPreparationHandle');
          const timelineId = this.nextId('newTimelineId');
          const author = planningInput({
            wire,
            workspaceId: this.input.workspaceId,
            eventId,
            actorUserId,
            evaluatedAt,
            newDeadlineId: () => this.nextId('newDeadlineId')
          });
          const before = repository.readDeadlineCatalog({
            workspaceId: this.input.workspaceId, eventId
          });
          if (!before) throw new TypeError('deadline_draft_scope_missing');
          let appended: ReturnType<typeof appendChangesetDraftSynchronous>;
          try {
            appended = appendChangesetDraftSynchronous({
              store: this.#changesets,
              registry: bundle.registry,
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
                eventId,
                principalKey: `workspace_user:${actorUserId}`,
                authorityPrincipalKey: context.authorityPrincipalKey,
                evaluatedAt
              },
              operations: [{
                kind: DEADLINE_CHANGESET_KIND,
                version: DEADLINE_CHANGESET_VERSION,
                dependencyGroup: 'deadline',
                authorInput: author
              }],
              dependencyGroups: [{ key: 'deadline', dependsOn: [] }],
              approvalPolicy: DEADLINE_DRAFT_APPROVAL_POLICY,
              origin: 'human_ui'
            });
          } catch (error) {
            if (error instanceof DeadlinePlanningError) {
              this.#nonterminalReleaseContext = context;
              return planningRefusal(error, author);
            }
            throw error;
          }
          if (appended.kind === 'refused') {
            if (appended.refusal.kind !== 'id_collision') {
              throw new TypeError('deadline_draft_unexpected_lifecycle_refusal');
            }
            this.#nonterminalReleaseContext = context;
            return collisionContribution();
          }
          const after = repository.readDeadlineCatalog({
            workspaceId: this.input.workspaceId, eventId
          });
          if (!after || canonicalJsonText(after) !== canonicalJsonText(before)) {
            throw new TypeError('deadline_draft_mutated_effective_state');
          }
          const revision = appended.record.revisions[0];
          const operation = revision?.revision.operations[0];
          if (!revision || !operation
              || appended.record.revisions.length !== 1
              || revision.revision.operations.length !== 1) {
            throw new TypeError('deadline_draft_record_incoherent');
          }
          const candidate = deadlineDraftContributionSchema.parse({
            result: {
              kind: 'success',
              data: {
                schemaVersion: 1,
                action: wire.action,
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
              kind: 'deadline_changeset_draft',
              preparationHandle: handle,
              workspaceId: this.input.workspaceId,
              eventId,
              changesetId,
              revisionId,
              revisionDigestSha256: revision.revision.digest,
              recordDigestSha256: appended.record.recordDigestSha256,
              action: wire.action,
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
            throw new TypeError('deadline_draft_success_contribution_invalid');
          }
          const contribution = candidate as DraftSuccess;
          this.#prepared.set(handle, {
            handle,
            context,
            contribution,
            phase: 'prepared'
          });
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('deadline_draft_transaction_required');
    }
    const parsed = deadlineDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('deadline_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = deadlineDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== DEADLINE_CHANGE_DRAFT_OPERATION.name
        || receipt.ref.operationVersion !== DEADLINE_CHANGE_DRAFT_OPERATION.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('deadline_draft_receipt_mismatch');
    }
    const domain = active.contribution.domain;
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, string,
      number, number
    ]>(`
      INSERT INTO deadline_draft_receipt_links (
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
      throw new TypeError('deadline_draft_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('deadline_draft_evidence_mismatch');
    }
    const child = deadlineDraftEvidenceChildSchema.parse(contribution);
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO deadline_draft_timeline (
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
      throw new TypeError('deadline_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('deadline_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('deadline_draft_incomplete');
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

  private nextId(method: keyof SQLiteDeadlineDraftEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('deadline_draft_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }

  private repository(): SQLiteDeadlineRepository {
    return new SQLiteDeadlineRepository(
      this.input.sqlite,
      new SQLiteEventSpineRepository(this.input.sqlite)
    );
  }
}

export function createSQLiteDeadlineDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteDeadlineDraftEffectIds;
}) {
  const adapter = new SQLiteDeadlineDraftEffectDomainAdapter(input);
  return Object.freeze({
    capability: DEADLINE_DRAFT_HANDLER_CAPABILITY,
    adapter,
    deadlineRead: adapter.deadlineRead
  });
}
