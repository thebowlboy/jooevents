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
  decisionAuthorInputSchema,
  type DecisionAuthorInput,
  type DecisionScopeDto
} from '@jooevents/contracts';
import {
  createDecisionChangesetBundle,
  decisionReadPort,
  resolveDecisionMutationPlanningInput,
  DecisionPlanningError,
  DecisionTargetUnavailableError,
  DECISION_CHANGESET_KIND,
  DECISION_CHANGESET_VERSION,
  type DecisionEnvironmentSource
} from '@jooevents/decision';
import {
  DECISION_DECIDE_DRAFT_OPERATION,
  DECISION_DRAFT_ACCESS_POLICY,
  DECISION_DRAFT_APPROVAL_POLICY,
  DECISION_DRAFT_HANDLER_CAPABILITY,
  DECISION_DRAFT_PERMISSION_ID,
  sealDecisionDraftPreparation,
  decisionDraftContributionSchema,
  decisionDraftDomainContributionSchema,
  decisionDraftEvidenceChildSchema,
  decisionDecideDraftOperationResultSchema,
  type DecisionDraftContribution
} from '@jooevents/decision-operations';
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
import { sessionGraduationPlanningPort, SessionPlanningError } from '@jooevents/session';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { createSQLiteDraftOnlyChangesetLifecycleStore } from './changeset-lifecycle';
import { SQLiteDecisionRepository } from './decision';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import type { SQLiteProgramVocabularyRepository } from './program-vocabulary';
import { SQLiteSessionRepository } from './session';

export const DECISION_DRAFT_EFFECT_SQL = `
CREATE TABLE decision_draft_receipt_links (
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
  action TEXT NOT NULL CHECK(action = 'decide'),
  decision_count INTEGER NOT NULL CHECK(decision_count BETWEEN 1 AND 100),
  operation_name TEXT NOT NULL CHECK(operation_name = 'decision.decide.draft'),
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

CREATE TABLE decision_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES decision_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER decision_draft_receipt_links_no_update
BEFORE UPDATE ON decision_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'decision draft receipt links are immutable'); END;
CREATE TRIGGER decision_draft_receipt_links_no_delete
BEFORE DELETE ON decision_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'decision draft receipt links are immutable'); END;
CREATE TRIGGER decision_draft_timeline_no_update
BEFORE UPDATE ON decision_draft_timeline
BEGIN SELECT RAISE(ABORT, 'decision draft timeline is immutable'); END;
CREATE TRIGGER decision_draft_timeline_no_delete
BEFORE DELETE ON decision_draft_timeline
BEGIN SELECT RAISE(ABORT, 'decision draft timeline is immutable'); END;
`;

export function installDecisionDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('decision_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(DECISION_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteDecisionDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newSessionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
}

type DraftSuccess = Extract<
  DecisionDraftContribution,
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
    throw new TypeError(`decision_draft_${label}_invalid`);
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

function eventRequiredContribution(): DecisionDraftContribution {
  return decisionDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'decision.event_required', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function collisionContribution(): DecisionDraftContribution {
  return decisionDraftContributionSchema.parse({
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

function staleContribution(code: string, submissionId: string): DecisionDraftContribution {
  return decisionDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'stale_revision', kind: 'decision.changed', retryable: false,
        subjects: [{ type: 'submission', id: submissionId }],
        detail: { code, submissionId },
        detailSchemaVersion: 2
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function targetUnavailableContribution(
  error: DecisionTargetUnavailableError
): DecisionDraftContribution {
  return decisionDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'decision.target_unavailable', retryable: false,
        subjects: [
          { type: 'submission', id: error.submissionId },
          { type: 'session', id: error.sessionId }
        ],
        detail: error.detail,
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

/**
 * Drafts one consequential decide changeset as an inert record on the
 * caller-owned SQLite handle. Wire routing resolves here — spawn identities are
 * server-minted and an omitted graduation routes by the submission's effective
 * target — and the draft never touches Decision heads, origin links, or the
 * Session catalog; only the registered decision changeset effect domain commits
 * a drafted plan.
 */
export class SQLiteDecisionDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #changesets;
  readonly #ids: SQLiteDecisionDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly vocabulary: Pick<SQLiteProgramVocabularyRepository, 'readVocabulary'>;
    readonly environment: DecisionEnvironmentSource;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteDecisionDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newSessionId',
      'newPreparationHandle', 'newTimelineId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('decision_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newSessionId',
        'newPreparationHandle', 'newTimelineId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteDecisionDraftEffectIds);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('decision_draft_transaction_required');
    }
    if (!sameReference(capability, DECISION_DRAFT_HANDLER_CAPABILITY)) {
      throw new TypeError('decision_draft_capability_mismatch');
    }
    if (context.operation.name !== DECISION_DECIDE_DRAFT_OPERATION.name
        || context.operation.version !== DECISION_DECIDE_DRAFT_OPERATION.version
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('decision_draft_scope_mismatch');
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
        || !sameReference(authority.lane.policy, DECISION_DRAFT_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === DECISION_DRAFT_PERMISSION_ID
        )) throw new TypeError('decision_draft_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId === undefined) {
      if (!current || current.currentEvent !== undefined) {
        throw new TypeError('decision_draft_event_relationship_mismatch');
      }
      this.clearTransient();
      return sealDecisionDraftPreparation({
        capability,
        context,
        preparation: {
          prepare: ({ businessInput, context: receivedContext }) => {
            if (receivedContext !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('decision_draft_context_substitution');
            }
            decisionAuthorInputSchema.parse(businessInput);
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
      throw new TypeError('decision_draft_event_relationship_mismatch');
    }
    this.clearTransient();

    const repository = this.repository();
    const bundle = createDecisionChangesetBundle();
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== decisionReadPort
            && (key as unknown) !== sessionGraduationPlanningPort) {
          throw new TypeError('decision_draft_undeclared_read_port');
        }
        return repository as unknown as Port;
      }
    });
    const scope: DecisionScopeDto = { workspaceId: this.input.workspaceId, eventId };

    return sealDecisionDraftPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('decision_draft_context_substitution');
          }
          const wire = decisionAuthorInputSchema.parse(businessInput);
          const changesetId = parseChangesetId(this.nextId('newChangesetId'));
          const revisionId = parseChangesetRevisionId(this.nextId('newRevisionId'));
          const handle = this.nextId('newPreparationHandle');
          const timelineId = this.nextId('newTimelineId');
          const before = this.effectiveStateWitness(repository, scope, wire);
          let author;
          try {
            author = resolveDecisionMutationPlanningInput({
              authorInput: wire,
              scope,
              actorUserId,
              occurredAt: evaluatedAt,
              environment: { decisions: repository, sessions: repository },
              newSessionId: () => this.nextId('newSessionId')
            });
          } catch (error) {
            const refusal = this.planningRefusal(error, wire, context);
            if (refusal) return refusal;
            throw error;
          }
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
                kind: DECISION_CHANGESET_KIND,
                version: DECISION_CHANGESET_VERSION,
                dependencyGroup: 'decision',
                authorInput: author
              }],
              dependencyGroups: [{ key: 'decision', dependsOn: [] }],
              approvalPolicy: DECISION_DRAFT_APPROVAL_POLICY,
              origin: 'human_ui'
            });
          } catch (error) {
            const refusal = this.planningRefusal(error, wire, context);
            if (refusal) return refusal;
            throw error;
          }
          if (appended.kind === 'refused') {
            if (appended.refusal.kind !== 'id_collision') {
              throw new TypeError('decision_draft_unexpected_lifecycle_refusal');
            }
            this.#nonterminalReleaseContext = context;
            return collisionContribution();
          }
          if (this.effectiveStateWitness(repository, scope, wire) !== before) {
            throw new TypeError('decision_draft_mutated_effective_state');
          }
          const revision = appended.record.revisions[0];
          const operation = revision?.revision.operations[0];
          if (!revision || !operation
              || appended.record.revisions.length !== 1
              || revision.revision.operations.length !== 1) {
            throw new TypeError('decision_draft_record_incoherent');
          }
          const candidate = decisionDraftContributionSchema.parse({
            result: {
              kind: 'success',
              data: {
                schemaVersion: 1,
                action: 'decide',
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
              kind: 'decision_changeset_draft',
              preparationHandle: handle,
              workspaceId: this.input.workspaceId,
              eventId,
              changesetId,
              revisionId,
              revisionDigestSha256: revision.revision.digest,
              recordDigestSha256: appended.record.recordDigestSha256,
              action: 'decide',
              decisionCount: wire.decisions.length,
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
            throw new TypeError('decision_draft_success_contribution_invalid');
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
      throw new TypeError('decision_draft_transaction_required');
    }
    const parsed = decisionDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('decision_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = decisionDecideDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== DECISION_DECIDE_DRAFT_OPERATION.name
        || receipt.ref.operationVersion !== DECISION_DECIDE_DRAFT_OPERATION.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('decision_draft_receipt_mismatch');
    }
    const domain = active.contribution.domain;
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, number,
      string, number, number
    ]>(`
      INSERT INTO decision_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action, decision_count,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, domain.workspaceId, domain.eventId, domain.changesetId, domain.revisionId,
      domain.revisionDigestSha256, domain.recordDigestSha256, domain.action, domain.decisionCount,
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
      throw new TypeError('decision_draft_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('decision_draft_evidence_mismatch');
    }
    const child = decisionDraftEvidenceChildSchema.parse(contribution);
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO decision_draft_timeline (
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
      throw new TypeError('decision_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('decision_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('decision_draft_incomplete');
    }
  }

  afterUnitOfWorkCommitted(): void {
    this.clearTransient();
  }

  private clearTransient(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }

  private planningRefusal(
    error: unknown,
    wire: DecisionAuthorInput,
    context: EffectInvocationContext
  ): DecisionDraftContribution | undefined {
    if (error instanceof DecisionTargetUnavailableError) {
      this.#nonterminalReleaseContext = context;
      return targetUnavailableContribution(error);
    }
    const fallbackSubmissionId = wire.decisions[0]!.submissionId;
    if (error instanceof DecisionPlanningError) {
      this.#nonterminalReleaseContext = context;
      return staleContribution(error.code, error.submissionId ?? fallbackSubmissionId);
    }
    if (error instanceof SessionPlanningError) {
      this.#nonterminalReleaseContext = context;
      return staleContribution(error.code, fallbackSubmissionId);
    }
    return undefined;
  }

  /**
   * Canonical witness over every effective row this draft could reach: the
   * Session catalog plus the addressed Decision heads and origin links. The
   * draft must leave it byte-identical.
   */
  private effectiveStateWitness(
    repository: SQLiteDecisionRepository,
    scope: DecisionScopeDto,
    wire: DecisionAuthorInput
  ): string {
    const catalog = repository.readSessionCatalog(scope);
    if (!catalog) throw new TypeError('decision_draft_scope_missing');
    return canonicalJsonText({
      catalog,
      rows: wire.decisions.map((row) => ({
        submissionId: row.submissionId,
        head: repository.readDecisionHead(scope, row.submissionId) ?? null,
        origin: repository.readSubmissionSessionOrigin(scope, row.submissionId) ?? null
      }))
    });
  }

  private repository(): SQLiteDecisionRepository {
    return new SQLiteDecisionRepository({
      sqlite: this.input.sqlite,
      sessions: new SQLiteSessionRepository(this.input.sqlite, this.input.vocabulary),
      environment: this.input.environment
    });
  }

  private nextId(method: keyof SQLiteDecisionDraftEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('decision_draft_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteDecisionDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly vocabulary: Pick<SQLiteProgramVocabularyRepository, 'readVocabulary'>;
  readonly environment: DecisionEnvironmentSource;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteDecisionDraftEffectIds;
}) {
  const adapter = new SQLiteDecisionDraftEffectDomainAdapter(input);
  return Object.freeze({
    capability: DECISION_DRAFT_HANDLER_CAPABILITY,
    adapter
  });
}
