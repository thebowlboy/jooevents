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
  templateArtifactMutationInputSchema,
  templateArtifactMutationDraftOperationResultSchema,
  templateArtifactSafeDiffSchema
} from '@jooevents/contracts';
import {
  TEMPLATE_ARTIFACT_CHANGESET_KIND,
  TEMPLATE_ARTIFACT_CHANGESET_VERSION,
  TemplateArtifactPlanningError,
  assertTemplateArtifactChangesetBundle,
  captureTemplateArtifactApprovalPolicy,
  createTemplateArtifactChangesetBundle,
  templateArtifactReadPort,
  type TemplateArtifactChangesetBundle,
  type TemplateArtifactReadPort,
  type TemplateAuthoringPolicy
} from '@jooevents/template-authoring';
import {
  TEMPLATE_ARTIFACT_DRAFT_HANDLER_CAPABILITY,
  TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
  templateArtifactDraftContributionSchema,
  templateArtifactDraftDomainContributionSchema,
  templateArtifactDraftEvidenceChildSchema,
  sealTemplateArtifactDraftPreparation,
  type TemplateArtifactDraftContribution
} from '@jooevents/template-authoring-operations';
import { EVENT_MANAGE_ACCESS_POLICY } from '@jooevents/event-operations';
import {
  canonicalJsonText,
  parseChangesetId,
  parseChangesetRevisionId,
  parseInstant,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import {
  createSQLiteDraftOnlyChangesetLifecycleStore,
  SQLiteChangesetLifecycleStore
} from './changeset-lifecycle';
import { SQLiteTemplateAuthoringRepository } from './template-authoring';

export const TEMPLATE_ARTIFACT_DRAFT_EFFECT_SQL = `
CREATE TABLE template_artifact_draft_receipt_links (
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
  operation_name TEXT NOT NULL CHECK(operation_name = 'template.artifact.change.draft'),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY(receipt_id)
    REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changeset_id, workspace_id, event_id)
    REFERENCES changeset_heads(changeset_id, workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(changeset_id, revision_id, revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(receipt_id, workspace_id, event_id, changeset_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE template_artifact_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY(receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES template_artifact_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER template_artifact_draft_receipt_links_no_update
BEFORE UPDATE ON template_artifact_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'event create draft receipt links are immutable'); END;
CREATE TRIGGER template_artifact_draft_receipt_links_no_delete
BEFORE DELETE ON template_artifact_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'event create draft receipt links are immutable'); END;
CREATE TRIGGER template_artifact_draft_timeline_no_update
BEFORE UPDATE ON template_artifact_draft_timeline
BEGIN SELECT RAISE(ABORT, 'event create draft timeline is immutable'); END;
CREATE TRIGGER template_artifact_draft_timeline_no_delete
BEFORE DELETE ON template_artifact_draft_timeline
BEGIN SELECT RAISE(ABORT, 'event create draft timeline is immutable'); END;
`;

export function installTemplateArtifactDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('template_artifact_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(TEMPLATE_ARTIFACT_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteTemplateArtifactDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
}

type DraftSuccess = Extract<
  TemplateArtifactDraftContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly workspaceId: WorkspaceId;
  readonly eventId: string;
  readonly actorUserId: UserId;
  readonly evaluatedAt: Instant;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  receiptId?: string;
}

const APPLICATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function applicationUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !APPLICATION_UUID.test(value)) {
    throw new TypeError(`template_artifact_draft_${label}_invalid`);
  }
  return value.toLowerCase();
}

function exactCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === TEMPLATE_ARTIFACT_DRAFT_HANDLER_CAPABILITY.key
    && value.version === TEMPLATE_ARTIFACT_DRAFT_HANDLER_CAPABILITY.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId === undefined
    && context.scope.subjects.length === 1
    && context.scope.subjects[0]?.kind === 'workspace'
    && context.scope.subjects[0].id === context.scope.workspaceId;
}

function collisionContribution(): TemplateArtifactDraftContribution {
  return templateArtifactDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'changeset.id_collision',
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function eventRequiredContribution(): TemplateArtifactDraftContribution {
  return templateArtifactDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'template.artifact.event_required',
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function planningRefusal(
  error: TemplateArtifactPlanningError,
  eventId: string,
  action: 'replace' | 'revert',
  artifactId: string
): TemplateArtifactDraftContribution | undefined {
  if (error.code === 'invalid_plan' || error.code === 'wrong_scope') {
    return undefined;
  }
  return templateArtifactDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'template.artifact_changed',
        retryable: false,
        subjects: [{ type: 'event', id: eventId }],
        detail: { code: error.code, action, artifactId },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

/** Persists an inert selected-Event artifact draft in the Foundation UoW. */
export class SQLiteTemplateArtifactDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #bundle: TemplateArtifactChangesetBundle;
  readonly #changesets: SQLiteChangesetLifecycleStore;
  readonly #ids: SQLiteTemplateArtifactDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: TemplateAuthoringPolicy;
    readonly ids: SQLiteTemplateArtifactDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#bundle = createTemplateArtifactChangesetBundle({ policy: input.policy });
    assertTemplateArtifactChangesetBundle(this.#bundle);
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newPreparationHandle',
      'newTimelineId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('template_artifact_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newPreparationHandle',
        'newTimelineId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteTemplateArtifactDraftEffectIds);
  }

  private nextId(method: keyof SQLiteTemplateArtifactDraftEffectIds): string {
    const value = applicationUuid(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('template_artifact_draft_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }

  private readPort(): TemplateArtifactReadPort {
    return new SQLiteTemplateAuthoringRepository(this.input.sqlite);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('template_artifact_draft_transaction_required');
    }
    if (!exactCapability(capability)) {
      throw new TypeError('template_artifact_draft_capability_mismatch');
    }
    if (context.operation.name !== TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION.name
        || context.operation.version !== TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION.version
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('template_artifact_draft_scope_mismatch');
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
        || authority.lane.policy.key !== EVENT_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== EVENT_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) throw new TypeError('template_artifact_draft_authority_mismatch');

    const actorUserId = parseUserId(authority.actor.userId);
    const readView = this.readPort();
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== templateArtifactReadPort) {
          throw new TypeError('template_artifact_draft_undeclared_read_port');
        }
        return readView as unknown as Port;
      }
    });
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;

    return sealTemplateArtifactDraftPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('template_artifact_draft_context_substitution');
          }
          const business = templateArtifactMutationInputSchema.parse(businessInput);
          const changesetId = parseChangesetId(this.nextId('newChangesetId'));
          const revisionId = parseChangesetRevisionId(this.nextId('newRevisionId'));
          const handle = this.nextId('newPreparationHandle');
          const timelineId = this.nextId('newTimelineId');
          const repository = new SQLiteTemplateAuthoringRepository(this.input.sqlite);
          const selected = this.input.sqlite.query<{
            readonly current_event_id: string | null;
          }, [string]>(`
            SELECT current_event_id FROM event_spine_workspace_sets
             WHERE workspace_id = ? LIMIT 2
          `).all(this.input.workspaceId);
          const eventId = selected.length === 1 ? selected[0]?.current_event_id : null;
          if (!eventId) {
            this.#nonterminalReleaseContext = context;
            return eventRequiredContribution();
          }
          const scope = { workspaceId: this.input.workspaceId, eventId };
          const before = repository.readArtifact(scope, business.artifactId);
          if (!before) {
            const refusal = planningRefusal(
              new TemplateArtifactPlanningError('artifact_missing'),
              eventId,
              business.action,
              business.artifactId
            );
            if (!refusal) throw new TypeError('template_artifact_draft_missing_refusal');
            this.#nonterminalReleaseContext = context;
            return refusal;
          }
          const approvalPolicy = captureTemplateArtifactApprovalPolicy({
            bundle: this.#bundle
          });
          let appended: ReturnType<typeof appendChangesetDraftSynchronous>;
          try {
            appended = appendChangesetDraftSynchronous({
              store: this.#changesets,
              registry: this.#bundle.registry,
              snapshot,
              ids: {
                newChangesetId: () => changesetId,
                newRevisionId: () => revisionId,
                newApprovalId: () => {
                  throw new TypeError('approval_id_unavailable_during_draft');
                },
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
                kind: TEMPLATE_ARTIFACT_CHANGESET_KIND,
                version: TEMPLATE_ARTIFACT_CHANGESET_VERSION,
                dependencyGroup: 'template_artifact',
                authorInput: {
                  scope,
                  mutation: business,
                  revisionId: this.nextId('newRevisionId'),
                  actorUserId,
                  occurredAt: evaluatedAt
                }
              }],
              dependencyGroups: [{ key: 'template_artifact', dependsOn: [] }],
              approvalPolicy,
              origin: 'human_ui'
            });
          } catch (error) {
            if (error instanceof TemplateArtifactPlanningError) {
              const refusal = planningRefusal(error, eventId, business.action, business.artifactId);
              if (refusal) {
                this.#nonterminalReleaseContext = context;
                return refusal;
              }
            }
            throw error;
          }
          if (appended.kind === 'refused') {
            if (appended.refusal.kind !== 'id_collision') {
              throw new TypeError('template_artifact_draft_unexpected_lifecycle_refusal');
            }
            this.#nonterminalReleaseContext = context;
            return collisionContribution();
          }
          const after = repository.readArtifact(scope, business.artifactId);
          if (canonicalJsonText(after) !== canonicalJsonText(before)) {
            throw new TypeError('template_artifact_draft_mutated_effective_state');
          }
          const revision = appended.record.revisions[0];
          const operation = revision?.revision.operations[0];
          if (!revision || !operation
              || revision.revision.operations.length !== 1
              || appended.record.revisions.length !== 1
              || appended.record.head.eventId !== eventId) {
            throw new TypeError('template_artifact_draft_record_incoherent');
          }
          const safeDiff = templateArtifactSafeDiffSchema.parse(operation.safeDiff);
          const candidate = templateArtifactDraftContributionSchema.parse({
            result: {
              kind: 'success',
              data: {
                schemaVersion: 1,
                action: business.action,
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
                safeDiff
              }
            },
            domain: {
              kind: 'template_artifact_changeset_draft',
              preparationHandle: handle,
              action: business.action,
              workspaceId: this.input.workspaceId,
              eventId,
              artifactId: business.artifactId,
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
            throw new TypeError('template_artifact_draft_success_contribution_invalid');
          }
          const contribution = candidate as DraftSuccess;
          this.#prepared.set(handle, {
            handle,
            context,
            workspaceId: this.input.workspaceId,
            eventId,
            actorUserId,
            evaluatedAt,
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
      throw new TypeError('template_artifact_draft_transaction_required');
    }
    const parsed = templateArtifactDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    const stored = prepared ? this.#changesets.read(parsed.changesetId) : undefined;
    if (!prepared || prepared.phase !== 'prepared' || !stored
        || stored.head.workspaceId !== this.input.workspaceId
        || stored.head.eventId !== parsed.eventId
        || stored.recordDigestSha256 !== parsed.recordDigestSha256
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('template_artifact_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = templateArtifactMutationDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION.name
        || receipt.ref.operationVersion !== TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || parsedResult.data.receipt.operationName !== TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION.name
        || parsedResult.data.receipt.operationVersion !== TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION.version
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('template_artifact_draft_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    const domain = active.contribution.domain;
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, number, number
    ]>(`
      INSERT INTO template_artifact_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      active.workspaceId,
      active.eventId,
      domain.changesetId,
      domain.revisionId,
      domain.revisionDigestSha256,
      domain.recordDigestSha256,
      active.context.operation.name,
      active.context.operation.version,
      Date.parse(active.evaluatedAt)
    );
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || !this.#expectedIdentity || active.receiptId === undefined
        || receiptId !== active.receiptId) {
      throw new TypeError('template_artifact_draft_receipt_parent_missing');
    }
    const child = templateArtifactDraftEvidenceChildSchema.parse(contribution);
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(child) !== canonicalJsonText(expected)) {
      throw new TypeError('template_artifact_draft_evidence_mismatch');
    }
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO template_artifact_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id,
        changeset_id, revision_id, occurred_at_ms, source_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      child.timelineId,
      active.receiptId,
      child.workspaceId,
      child.eventId,
      child.changesetId,
      child.revisionId,
      Date.parse(parseInstant(child.occurredAt)),
      child.sourceKind
    );
    active.phase = 'evidence_complete';
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('template_artifact_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('template_artifact_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('template_artifact_draft_incomplete');
    }
    active.phase = 'claim_released';
  }

  afterUnitOfWorkCommitted(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }
}

export function createSQLiteTemplateArtifactDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly policy: TemplateAuthoringPolicy;
  readonly ids: SQLiteTemplateArtifactDraftEffectIds;
}): {
  readonly capability: typeof TEMPLATE_ARTIFACT_DRAFT_HANDLER_CAPABILITY;
  readonly adapter: SQLiteTemplateArtifactDraftEffectDomainAdapter;
} {
  return Object.freeze({
    capability: TEMPLATE_ARTIFACT_DRAFT_HANDLER_CAPABILITY,
    adapter: new SQLiteTemplateArtifactDraftEffectDomainAdapter(input)
  });
}
