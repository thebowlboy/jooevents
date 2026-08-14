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
  engagementAuthorInputSchema,
  engagementChangeDraftDataSchema,
  engagementChangeDraftOperationResultSchema,
  engagementResponseActionSchema,
  structuredOutcomeSchema,
  type EngagementAuthorInput,
  type EngagementScopeDto,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  createEngagementChangesetBundle,
  engagementReadPort,
  resolveEngagementMutationPlanningInput,
  EngagementPlanningError,
  ENGAGEMENT_CHANGESET_KIND,
  ENGAGEMENT_CHANGESET_VERSION
} from '@jooevents/engagement';
import type { PermissionId, VersionedAccessPolicyRef } from '@jooevents/identity-access';
import {
  canonicalJsonText,
  isApplicationId,
  parseChangesetId,
  parseChangesetRevisionId,
  parseInstant,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { createSQLiteDraftOnlyChangesetLifecycleStore } from './changeset-lifecycle';
import { SQLiteEngagementRepository } from './engagement';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

/** The one wire operation this adapter serves; the operations module must mount exactly it. */
export const ENGAGEMENT_CHANGE_DRAFT_OPERATION_NAME = 'engagement.change.draft';
export const ENGAGEMENT_CHANGE_DRAFT_OPERATION_VERSION = 1;

export const SQLITE_ENGAGEMENT_DRAFT_EFFECT_SQL = `
CREATE TABLE engagement_draft_receipt_links (
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
    'record_confirmation', 'decline', 'request_cancellation', 'accept_cancellation'
  )),
  engagement_id TEXT NOT NULL CHECK(length(engagement_id) = 36),
  operation_name TEXT NOT NULL CHECK(operation_name = 'engagement.change.draft'),
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

CREATE TABLE engagement_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES engagement_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER engagement_draft_receipt_links_no_update
BEFORE UPDATE ON engagement_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'engagement draft receipt links are immutable'); END;
CREATE TRIGGER engagement_draft_receipt_links_no_delete
BEFORE DELETE ON engagement_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'engagement draft receipt links are immutable'); END;
CREATE TRIGGER engagement_draft_timeline_no_update
BEFORE UPDATE ON engagement_draft_timeline
BEGIN SELECT RAISE(ABORT, 'engagement draft timeline is immutable'); END;
CREATE TRIGGER engagement_draft_timeline_no_delete
BEFORE DELETE ON engagement_draft_timeline
BEGIN SELECT RAISE(ABORT, 'engagement draft timeline is immutable'); END;
`;

export function installEngagementDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('engagement_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_ENGAGEMENT_DRAFT_EFFECT_SQL)).immediate();
}

const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Application IDs must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalInstantSchema = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}, 'Expected a canonical UTC instant.');

/**
 * Adapter-owned structural schemas for the contributions this adapter authors.
 * The operations module's mounted contribution schema must accept exactly this
 * shape; both derive from the map-pinned draft contract.
 */
export const engagementDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('engagement_changeset_draft'),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigestSha256: sha256Schema,
  recordDigestSha256: sha256Schema,
  action: engagementResponseActionSchema,
  engagementId: applicationIdSchema,
  occurredAt: canonicalInstantSchema
});
export const engagementDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: applicationIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  occurredAt: canonicalInstantSchema
});
export const engagementDraftContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: engagementChangeDraftDataSchema }),
    domain: engagementDraftDomainContributionSchema,
    receiptChildren: z.tuple([engagementDraftEvidenceChildSchema])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    receiptChildren: z.tuple([])
  })
]);
export type SQLiteEngagementDraftContribution = z.infer<typeof engagementDraftContributionSchema>;

export interface SQLiteEngagementDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
}

/**
 * The operations-layer identities this persistence adapter serves. They are
 * defined by the engagement operations module and injected at composition so
 * one definition exists; the adapter refuses construction when the injected
 * operation is not the map-pinned `engagement.change.draft` v1 its receipt
 * tables physically enforce.
 */
export interface SQLiteEngagementDraftOperationsContract {
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
      }): {
        readonly result: unknown;
        readonly domain: unknown;
        readonly receiptChildren: readonly unknown[];
      };
    };
  }) => EffectHandlerSnapshot;
}

type DraftSuccess = Extract<
  SQLiteEngagementDraftContribution,
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
    throw new TypeError(`engagement_draft_${label}_invalid`);
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

function outcomeContribution(outcome: {
  readonly class: string;
  readonly kind: string;
  readonly subjects: readonly { readonly type: string; readonly id: string }[];
  readonly detail: unknown;
}): SQLiteEngagementDraftContribution {
  return engagementDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: { ...outcome, retryable: false, detailSchemaVersion: 1 }
    },
    domain: null,
    receiptChildren: []
  });
}

function eventRequiredContribution(): SQLiteEngagementDraftContribution {
  return outcomeContribution({
    class: 'conflict', kind: 'engagement.event_required', subjects: [], detail: null
  });
}

function collisionContribution(): SQLiteEngagementDraftContribution {
  return outcomeContribution({
    class: 'conflict', kind: 'changeset.id_collision', subjects: [], detail: null
  });
}

function staleContribution(code: string, engagementId: string): SQLiteEngagementDraftContribution {
  return outcomeContribution({
    class: 'stale_revision',
    kind: 'engagement.changed',
    subjects: [{ type: 'engagement', id: engagementId }],
    detail: { code, engagementId }
  });
}

/**
 * Drafts one consequential engagement response changeset as an inert record
 * on the caller-owned SQLite handle. The draft never touches engagement
 * heads; only the registered engagement changeset effect domain commits a
 * drafted plan.
 */
export class SQLiteEngagementDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #changesets;
  readonly #ids: SQLiteEngagementDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly operations: SQLiteEngagementDraftOperationsContract;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteEngagementDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    if (input.operations.operation.name !== ENGAGEMENT_CHANGE_DRAFT_OPERATION_NAME
        || input.operations.operation.version !== ENGAGEMENT_CHANGE_DRAFT_OPERATION_VERSION
        || typeof input.operations.seal !== 'function') {
      throw new TypeError('engagement_draft_operations_contract_invalid');
    }
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newPreparationHandle', 'newTimelineId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('engagement_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newPreparationHandle', 'newTimelineId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteEngagementDraftEffectIds);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('engagement_draft_transaction_required');
    }
    if (!sameReference(capability, this.input.operations.capability)) {
      throw new TypeError('engagement_draft_capability_mismatch');
    }
    if (context.operation.name !== this.input.operations.operation.name
        || context.operation.version !== this.input.operations.operation.version
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('engagement_draft_scope_mismatch');
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
        || !sameReference(authority.lane.policy, this.input.operations.accessPolicy)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === this.input.operations.permissionId
        )) throw new TypeError('engagement_draft_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId === undefined) {
      if (!current || current.currentEvent !== undefined) {
        throw new TypeError('engagement_draft_event_relationship_mismatch');
      }
      this.clearTransient();
      return this.input.operations.seal({
        capability: this.input.operations.capability,
        context,
        preparation: {
          prepare: ({ businessInput, context: receivedContext }) => {
            if (receivedContext !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('engagement_draft_context_substitution');
            }
            engagementAuthorInputSchema.parse(businessInput);
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
      throw new TypeError('engagement_draft_event_relationship_mismatch');
    }
    this.clearTransient();

    const repository = new SQLiteEngagementRepository(this.input.sqlite);
    const bundle = createEngagementChangesetBundle();
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== engagementReadPort) {
          throw new TypeError('engagement_draft_undeclared_read_port');
        }
        return repository as unknown as Port;
      }
    });
    const scope: EngagementScopeDto = { workspaceId: this.input.workspaceId, eventId };

    return this.input.operations.seal({
      capability: this.input.operations.capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('engagement_draft_context_substitution');
          }
          const wire = engagementAuthorInputSchema.parse(businessInput);
          const changesetId = parseChangesetId(this.nextId('newChangesetId'));
          const revisionId = parseChangesetRevisionId(this.nextId('newRevisionId'));
          const handle = this.nextId('newPreparationHandle');
          const timelineId = this.nextId('newTimelineId');
          const before = this.effectiveStateWitness(repository, scope, wire);
          const author = resolveEngagementMutationPlanningInput({
            authorInput: wire,
            scope,
            actorUserId,
            occurredAt: evaluatedAt
          });
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
                kind: ENGAGEMENT_CHANGESET_KIND,
                version: ENGAGEMENT_CHANGESET_VERSION,
                dependencyGroup: 'engagement',
                authorInput: author
              }],
              dependencyGroups: [{ key: 'engagement', dependsOn: [] }],
              approvalPolicy: this.input.operations.approvalPolicy,
              origin: 'human_ui'
            });
          } catch (error) {
            if (error instanceof EngagementPlanningError) {
              this.#nonterminalReleaseContext = context;
              return staleContribution(error.code, error.engagementId ?? wire.engagementId);
            }
            throw error;
          }
          if (appended.kind === 'refused') {
            if (appended.refusal.kind !== 'id_collision') {
              throw new TypeError('engagement_draft_unexpected_lifecycle_refusal');
            }
            this.#nonterminalReleaseContext = context;
            return collisionContribution();
          }
          if (this.effectiveStateWitness(repository, scope, wire) !== before) {
            throw new TypeError('engagement_draft_mutated_effective_state');
          }
          const revision = appended.record.revisions[0];
          const operation = revision?.revision.operations[0];
          if (!revision || !operation
              || appended.record.revisions.length !== 1
              || revision.revision.operations.length !== 1) {
            throw new TypeError('engagement_draft_record_incoherent');
          }
          const candidate = engagementDraftContributionSchema.parse({
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
              kind: 'engagement_changeset_draft',
              preparationHandle: handle,
              workspaceId: this.input.workspaceId,
              eventId,
              changesetId,
              revisionId,
              revisionDigestSha256: revision.revision.digest,
              recordDigestSha256: appended.record.recordDigestSha256,
              action: wire.action,
              engagementId: wire.engagementId,
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
            throw new TypeError('engagement_draft_success_contribution_invalid');
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
      throw new TypeError('engagement_draft_transaction_required');
    }
    const parsed = engagementDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('engagement_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = engagementChangeDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== this.input.operations.operation.name
        || receipt.ref.operationVersion !== this.input.operations.operation.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('engagement_draft_receipt_mismatch');
    }
    const domain = active.contribution.domain;
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, string,
      string, number, number
    ]>(`
      INSERT INTO engagement_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action, engagement_id,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, domain.workspaceId, domain.eventId, domain.changesetId, domain.revisionId,
      domain.revisionDigestSha256, domain.recordDigestSha256, domain.action, domain.engagementId,
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
      throw new TypeError('engagement_draft_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('engagement_draft_evidence_mismatch');
    }
    const child = engagementDraftEvidenceChildSchema.parse(contribution);
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO engagement_draft_timeline (
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
      throw new TypeError('engagement_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('engagement_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('engagement_draft_incomplete');
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

  /**
   * Canonical witness over the one effective row this draft could reach: the
   * addressed engagement head. The draft must leave it byte-identical.
   */
  private effectiveStateWitness(
    repository: SQLiteEngagementRepository,
    scope: EngagementScopeDto,
    wire: EngagementAuthorInput
  ): string {
    return canonicalJsonText({
      head: repository.readEngagementHead(scope, wire.engagementId) ?? null
    });
  }

  private nextId(method: keyof SQLiteEngagementDraftEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('engagement_draft_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteEngagementDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly operations: SQLiteEngagementDraftOperationsContract;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteEngagementDraftEffectIds;
}) {
  const adapter = new SQLiteEngagementDraftEffectDomainAdapter(input);
  return Object.freeze({
    capability: input.operations.capability,
    adapter
  });
}
