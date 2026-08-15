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
import {
  appendChangesetDraftSynchronous,
  type CapturedChangesetApprovalPolicy
} from '@jooevents/changeset-operations';
import {
  taskDraftOperationResultSchema,
  taskMutationDraftInputSchema,
  taskSafeDiffSchema,
  type TaskScopeDto,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { taskDueDeadlinePlanningPort } from '@jooevents/deadline';
import type { PermissionId, VersionedAccessPolicyRef } from '@jooevents/identity-access';
import {
  canonicalJsonText,
  isApplicationId,
  parseChangesetId,
  parseChangesetRevisionId,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  createTaskChangesetBundle,
  taskMembershipReadPort,
  taskReadPort,
  TaskPlanningError,
  TASK_CHANGESET_KIND,
  TASK_CHANGESET_VERSION
} from '@jooevents/tasks';
import {
  taskDraftContributionSchema,
  taskDraftDomainContributionSchema,
  taskDraftEvidenceChildSchema,
  type TaskDraftContribution
} from '@jooevents/task-operations';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { createSQLiteDraftOnlyChangesetLifecycleStore } from './changeset-lifecycle';
import { SQLiteDeadlineRepository } from './deadline';
import { SQLiteEventSpineRepository } from './event-spine';
import { SQLiteTaskRepository } from './tasks';

export const TASK_DRAFT_EFFECT_SQL = `
CREATE TABLE task_draft_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  revision_digest_sha256 TEXT NOT NULL CHECK(
    length(revision_digest_sha256)=64 AND revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  record_digest_sha256 TEXT NOT NULL CHECK(
    length(record_digest_sha256)=64 AND record_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  action TEXT NOT NULL CHECK(action IN (
    'create_definition','waive_assignment','accept_fulfillment'
  )),
  subject_id TEXT NOT NULL CHECK(length(subject_id)=36),
  operation_name TEXT NOT NULL CHECK(operation_name='task.mutation.draft'),
  operation_version INTEGER NOT NULL CHECK(operation_version=1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY(receipt_id) REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changeset_id,workspace_id,event_id)
    REFERENCES changeset_heads(changeset_id,workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changeset_id,revision_id,revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id,revision_id,revision_digest_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE task_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind='changeset_revision'),
  FOREIGN KEY(receipt_id) REFERENCES task_draft_receipt_links(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER task_draft_receipt_links_no_update BEFORE UPDATE ON task_draft_receipt_links
BEGIN SELECT RAISE(ABORT,'task draft receipt links are immutable'); END;
CREATE TRIGGER task_draft_receipt_links_no_delete BEFORE DELETE ON task_draft_receipt_links
BEGIN SELECT RAISE(ABORT,'task draft receipt links are immutable'); END;
CREATE TRIGGER task_draft_timeline_no_update BEFORE UPDATE ON task_draft_timeline
BEGIN SELECT RAISE(ABORT,'task draft timeline is immutable'); END;
CREATE TRIGGER task_draft_timeline_no_delete BEFORE DELETE ON task_draft_timeline
BEGIN SELECT RAISE(ABORT,'task draft timeline is immutable'); END;
`;

export function installTaskDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('task_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.transaction(() => sqlite.exec(TASK_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteTaskDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newTaskDefinitionId(): string;
  newTaskDefinitionRevisionId(): string;
  newDeadlineId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
}

export interface SQLiteTaskDraftOperationsContract {
  readonly operation: { readonly name: string; readonly version: number };
  readonly accessPolicy: VersionedAccessPolicyRef;
  readonly permissionId: PermissionId;
  readonly capability: VersionedDefinitionRef;
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
  readonly seal: (input: {
    readonly capability: VersionedDefinitionRef;
    readonly context: EffectInvocationContext;
    readonly preparation: {
      prepare(input: {
        readonly businessInput: unknown;
        readonly context: EffectInvocationContext;
      }): { readonly result: unknown; readonly domain: unknown; readonly receiptChildren: readonly unknown[] };
    };
  }) => EffectHandlerSnapshot;
}

type DraftSuccess = Extract<TaskDraftContribution, { readonly result: { readonly kind: 'success' } }>;
interface Prepared {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete';
  receiptId?: string;
}

function sameRef(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}
function exactSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId === undefined
    && context.scope.subjects.length === 1
    && context.scope.subjects[0]?.kind === 'workspace'
    && context.scope.subjects[0].id === context.scope.workspaceId;
}
function eventRequired(): TaskDraftContribution {
  return taskDraftContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: 'conflict', kind: 'task.event_required', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    } }, domain: null, receiptChildren: []
  });
}
function collision(): TaskDraftContribution {
  return taskDraftContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: 'conflict', kind: 'changeset.id_collision', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    } }, domain: null, receiptChildren: []
  });
}
function taskRefusal(error: TaskPlanningError, scope: TaskScopeDto, action: string): TaskDraftContribution {
  return taskDraftContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: 'stale_revision', kind: 'task.changed', retryable: false,
      subjects: [{ type: 'event', id: scope.eventId }],
      detail: { code: error.code, action, subjectId: error.subjectId ?? scope.eventId },
      detailSchemaVersion: 1
    } }, domain: null, receiptChildren: []
  });
}

export class SQLiteTaskDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #bundle = createTaskChangesetBundle();
  readonly #changesets;
  readonly #ids: SQLiteTaskDraftEffectIds;
  readonly #issued = new Set<string>();
  readonly #prepared = new Map<string, Prepared>();
  #active: Prepared | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminal: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly operations: SQLiteTaskDraftOperationsContract;
    readonly ids: SQLiteTaskDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newTaskDefinitionId',
      'newTaskDefinitionRevisionId', 'newDeadlineId', 'newPreparationHandle', 'newTimelineId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') throw new TypeError('task_draft_id_factory_invalid');
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newTaskDefinitionId',
        'newTaskDefinitionRevisionId', 'newDeadlineId', 'newPreparationHandle', 'newTimelineId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteTaskDraftEffectIds);
  }

  openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('task_draft_transaction_required');
    if (!sameRef(capability, this.input.operations.capability)) {
      throw new TypeError('task_draft_capability_mismatch');
    }
    if (context.operation.name !== this.input.operations.operation.name
        || context.operation.version !== this.input.operations.operation.version
        || context.operation.effect !== 'draft' || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId || !exactSubjects(context)) {
      throw new TypeError('task_draft_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user' || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user' || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator' || authority.lane.surface !== 'operator_http'
        || !sameRef(authority.lane.policy, this.input.operations.accessPolicy)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === this.input.operations.permissionId)) {
      throw new TypeError('task_draft_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    this.clear();
    return this.input.operations.seal({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: received }) => {
          if (received !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('task_draft_context_substitution');
          }
          const business = taskMutationDraftInputSchema.parse(businessInput);
          const selected = this.input.sqlite.query<{ readonly current_event_id: string | null }, [string]>(`
            SELECT current_event_id FROM event_spine_workspace_sets WHERE workspace_id=? LIMIT 2
          `).all(this.input.workspaceId);
          const eventId = selected.length === 1 ? selected[0]?.current_event_id : null;
          if (!eventId) {
            this.#nonterminal = context;
            return eventRequired();
          }
          const scope = { workspaceId: this.input.workspaceId, eventId };
          const tasks = new SQLiteTaskRepository(this.input.sqlite);
          const deadlines = new SQLiteDeadlineRepository(
            this.input.sqlite, new SQLiteEventSpineRepository(this.input.sqlite)
          );
          const before = canonicalJsonText({
            board: tasks.readTaskBoard(scope),
            deadlines: deadlines.readDeadlineCatalog(scope)
          });
          const snapshot: ChangesetPlanningSnapshot = Object.freeze({
            getPort: <Port>(key: ChangesetReadPortKey<Port>): Port => {
              if ((key as unknown) === taskReadPort || (key as unknown) === taskMembershipReadPort) {
                return tasks as unknown as Port;
              }
              if ((key as unknown) === taskDueDeadlinePlanningPort) return deadlines as unknown as Port;
              throw new TypeError('task_draft_undeclared_read_port');
            }
          });
          const changesetId = parseChangesetId(this.next('newChangesetId'));
          const revisionId = parseChangesetRevisionId(this.next('newRevisionId'));
          const handle = this.next('newPreparationHandle');
          const timelineId = this.next('newTimelineId');
          const createdTaskDefinitionId = business.action === 'create_definition'
            ? this.next('newTaskDefinitionId') : null;
          const authorInput = business.action === 'create_definition'
            ? {
                ...business,
                scope,
                taskDefinitionId: createdTaskDefinitionId!,
                revisionId: this.next('newTaskDefinitionRevisionId'),
                deadlineId: this.next('newDeadlineId'),
                actorUserId,
                occurredAt: evaluatedAt
              }
            : { ...business, scope, actorUserId, occurredAt: evaluatedAt };
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
                kind: TASK_CHANGESET_KIND,
                version: TASK_CHANGESET_VERSION,
                dependencyGroup: 'task',
                authorInput
              }],
              dependencyGroups: [{ key: 'task', dependsOn: [] }],
              approvalPolicy: this.input.operations.approvalPolicy,
              origin: 'human_ui'
            });
          } catch (error) {
            if (error instanceof TaskPlanningError) {
              this.#nonterminal = context;
              return taskRefusal(error, scope, business.action);
            }
            throw error;
          }
          if (appended.kind === 'refused') {
            if (appended.refusal.kind !== 'id_collision') {
              throw new TypeError('task_draft_unexpected_lifecycle_refusal');
            }
            this.#nonterminal = context;
            return collision();
          }
          const after = canonicalJsonText({
            board: tasks.readTaskBoard(scope),
            deadlines: deadlines.readDeadlineCatalog(scope)
          });
          if (before !== after) throw new TypeError('task_draft_mutated_effective_state');
          const storedRevision = appended.record.revisions[0];
          const operation = storedRevision?.revision.operations[0];
          if (!storedRevision || !operation || appended.record.revisions.length !== 1
              || storedRevision.revision.operations.length !== 1) {
            throw new TypeError('task_draft_record_incoherent');
          }
          const safeDiff = taskSafeDiffSchema.parse(operation.safeDiff);
          const subjectId = business.action === 'create_definition'
            ? createdTaskDefinitionId! : business.assignmentId;
          const candidate = taskDraftContributionSchema.parse({
            result: { kind: 'success', data: {
              schemaVersion: 1,
              action: business.action,
              changesetId,
              headVersion: appended.record.head.version,
              status: appended.record.head.status,
              revision: {
                id: storedRevision.revision.id,
                number: storedRevision.revision.number,
                digestSha256: storedRevision.revision.digest
              },
              riskTier: storedRevision.revision.riskTier,
              approvalPolicy: storedRevision.approvalPolicy,
              safeDiff
            } },
            domain: {
              kind: 'task_changeset_draft', preparationHandle: handle,
              workspaceId: this.input.workspaceId, eventId, changesetId, revisionId,
              revisionDigestSha256: storedRevision.revision.digest,
              recordDigestSha256: appended.record.recordDigestSha256,
              action: business.action, subjectId, occurredAt: evaluatedAt
            },
            receiptChildren: [{
              kind: 'timeline', timelineId, sourceKind: 'changeset_revision',
              workspaceId: this.input.workspaceId, eventId, changesetId, revisionId,
              occurredAt: evaluatedAt
            }]
          });
          if (candidate.result.kind !== 'success' || candidate.domain === null) {
            throw new TypeError('task_draft_success_contribution_invalid');
          }
          const contribution = candidate as DraftSuccess;
          this.#prepared.set(handle, { handle, context, contribution, phase: 'prepared' });
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('task_draft_transaction_required');
    const parsed = taskDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    const stored = prepared ? this.#changesets.read(parsed.changesetId) : undefined;
    if (!prepared || prepared.phase !== 'prepared' || !stored
        || stored.recordDigestSha256 !== parsed.recordDigestSha256
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('task_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsed = taskDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || !parsed.success || parsed.data.kind !== 'success'
        || parsed.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsed.data.data) !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('task_draft_receipt_mismatch');
    }
    const domain = active.contribution.domain;
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query(`
      INSERT INTO task_draft_receipt_links(
        receipt_id,workspace_id,event_id,changeset_id,revision_id,
        revision_digest_sha256,record_digest_sha256,action,subject_id,
        operation_name,operation_version,occurred_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      receiptId, domain.workspaceId, domain.eventId, domain.changesetId, domain.revisionId,
      domain.revisionDigestSha256, domain.recordDigestSha256, domain.action, domain.subjectId,
      active.context.operation.name, active.context.operation.version, Date.parse(domain.occurredAt)
    );
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || active.receiptId !== receiptId || !this.#expectedIdentity) {
      throw new TypeError('task_draft_receipt_parent_missing');
    }
    const child = taskDraftEvidenceChildSchema.parse(contribution);
    if (canonicalJsonText(child) !== canonicalJsonText(active.contribution.receiptChildren[0])) {
      throw new TypeError('task_draft_evidence_mismatch');
    }
    this.input.sqlite.query(`
      INSERT INTO task_draft_timeline(
        timeline_id,receipt_id,workspace_id,event_id,changeset_id,revision_id,
        occurred_at_ms,source_kind
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      child.timelineId, receiptId, child.workspaceId, child.eventId,
      child.changesetId, child.revisionId, Date.parse(child.occurredAt), child.sourceKind
    );
    active.phase = 'evidence_complete';
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('task_draft_transaction_required');
    if (!this.#active) {
      if (!this.#nonterminal || !effectOperationIdentityMatchesContext(identity, this.#nonterminal)) {
        throw new TypeError('task_draft_incomplete');
      }
      this.#nonterminal = undefined;
      return;
    }
    if (this.#active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('task_draft_incomplete');
    }
  }

  afterUnitOfWorkCommitted(): void { this.clear(); }

  private clear(): void {
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminal = undefined;
  }

  private next(method: keyof SQLiteTaskDraftEffectIds): string {
    const value = this.#ids[method]();
    if (!isApplicationId(value)) throw new TypeError(`task_draft_${method}_invalid`);
    if (this.#issued.has(value)) throw new TypeError('task_draft_ids_not_unique');
    this.#issued.add(value);
    return value;
  }
}

export function createSQLiteTaskDraftEffectDomainRegistration(input: ConstructorParameters<
  typeof SQLiteTaskDraftEffectDomainAdapter
>[0]) {
  return Object.freeze({
    capability: input.operations.capability,
    adapter: new SQLiteTaskDraftEffectDomainAdapter(input)
  });
}
