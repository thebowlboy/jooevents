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
  releaseActionSchema,
  releaseAuthorInputSchema,
  releaseDraftDataSchema,
  releaseDraftOperationResultSchema,
  structuredOutcomeSchema,
  type ReleaseAuthorInput,
  type ReleasePlanningInput,
  type ReleaseScopeDto,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
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
import {
  createReleaseChangesetBundle,
  releaseReadPort,
  ReleasePlanningError,
  RELEASE_CHANGESET_KIND,
  RELEASE_CHANGESET_VERSION
} from '@jooevents/release';
import { z } from 'zod';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { createSQLiteDraftOnlyChangesetLifecycleStore } from './changeset-lifecycle';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteReleaseRepository, type SQLiteReleaseUpstreamSources } from './release';

/** The one wire operation this adapter serves; the operations module must mount exactly it. */
export const RELEASE_CHANGE_DRAFT_OPERATION_NAME = 'release.change.draft';
export const RELEASE_CHANGE_DRAFT_OPERATION_VERSION = 1;

export const SQLITE_RELEASE_DRAFT_EFFECT_SQL = `
CREATE TABLE release_draft_receipt_links (
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
    'publish_schedule', 'program_rollback', 'style_set_publish',
    'surface_publish', 'surface_rollback', 'surface_allowlist'
  )),
  operation_name TEXT NOT NULL CHECK(operation_name = 'release.change.draft'),
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

CREATE TABLE release_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES release_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER release_draft_receipt_links_no_update
BEFORE UPDATE ON release_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'release draft receipt links are immutable'); END;
CREATE TRIGGER release_draft_receipt_links_no_delete
BEFORE DELETE ON release_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'release draft receipt links are immutable'); END;
CREATE TRIGGER release_draft_timeline_no_update
BEFORE UPDATE ON release_draft_timeline
BEGIN SELECT RAISE(ABORT, 'release draft timeline is immutable'); END;
CREATE TRIGGER release_draft_timeline_no_delete
BEFORE DELETE ON release_draft_timeline
BEGIN SELECT RAISE(ABORT, 'release draft timeline is immutable'); END;
`;

export function installReleaseDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('release_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_RELEASE_DRAFT_EFFECT_SQL)).immediate();
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
 * shape; both derive from the release draft contract.
 */
export const releaseDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('release_changeset_draft'),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigestSha256: sha256Schema,
  recordDigestSha256: sha256Schema,
  action: releaseActionSchema,
  occurredAt: canonicalInstantSchema
});
export const releaseDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: applicationIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  occurredAt: canonicalInstantSchema
});
export const releaseDraftContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: releaseDraftDataSchema }),
    domain: releaseDraftDomainContributionSchema,
    receiptChildren: z.tuple([releaseDraftEvidenceChildSchema])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    receiptChildren: z.tuple([])
  })
]);
export type SQLiteReleaseDraftContribution = z.infer<typeof releaseDraftContributionSchema>;

export interface SQLiteReleaseDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newReleaseId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
}

/**
 * The operations-layer identities this persistence adapter serves. They are
 * defined by the release operations module and injected at composition so one
 * definition exists; the adapter refuses construction when the injected
 * operation is not the pinned `release.change.draft` v1 its receipt tables
 * physically enforce.
 */
export interface SQLiteReleaseDraftOperationsContract {
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
  SQLiteReleaseDraftContribution,
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
    throw new TypeError(`release_draft_${label}_invalid`);
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
  readonly detailSchemaVersion?: number;
}): SQLiteReleaseDraftContribution {
  return releaseDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        ...outcome,
        retryable: false,
        detailSchemaVersion: outcome.detailSchemaVersion ?? 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function eventRequiredContribution(): SQLiteReleaseDraftContribution {
  return outcomeContribution({
    class: 'conflict', kind: 'release.event_required', subjects: [], detail: null
  });
}

function collisionContribution(): SQLiteReleaseDraftContribution {
  return outcomeContribution({
    class: 'conflict', kind: 'changeset.id_collision', subjects: [], detail: null
  });
}

function staleContribution(
  error: ReleasePlanningError,
  action: ReleaseAuthorInput['action']
): SQLiteReleaseDraftContribution {
  return outcomeContribution({
    class: 'stale_revision',
    kind: 'release.changed',
    subjects: [],
    detail: { code: error.code, action, subjectId: null },
    detailSchemaVersion: 3
  });
}

/**
 * Drafts one consequential release changeset as an inert record on the
 * caller-owned SQLite handle. The draft never touches a release row or a
 * surface head; only the registered release changeset effect domain commits a
 * drafted plan. Release identities for the creating arms are server-assigned
 * here — a wire input can never name its own release id.
 */
export class SQLiteReleaseDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #changesets;
  readonly #ids: SQLiteReleaseDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly operations: SQLiteReleaseDraftOperationsContract;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly sources: SQLiteReleaseUpstreamSources;
    readonly ids: SQLiteReleaseDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    if (input.operations.operation.name !== RELEASE_CHANGE_DRAFT_OPERATION_NAME
        || input.operations.operation.version !== RELEASE_CHANGE_DRAFT_OPERATION_VERSION
        || typeof input.operations.seal !== 'function') {
      throw new TypeError('release_draft_operations_contract_invalid');
    }
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newReleaseId', 'newPreparationHandle', 'newTimelineId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('release_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newReleaseId', 'newPreparationHandle', 'newTimelineId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteReleaseDraftEffectIds);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('release_draft_transaction_required');
    }
    if (!sameReference(capability, this.input.operations.capability)) {
      throw new TypeError('release_draft_capability_mismatch');
    }
    if (context.operation.name !== this.input.operations.operation.name
        || context.operation.version !== this.input.operations.operation.version
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('release_draft_scope_mismatch');
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
        )) throw new TypeError('release_draft_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId === undefined) {
      if (!current || current.currentEvent !== undefined) {
        throw new TypeError('release_draft_event_relationship_mismatch');
      }
      this.clearTransient();
      return this.input.operations.seal({
        capability: this.input.operations.capability,
        context,
        preparation: {
          prepare: ({ businessInput, context: receivedContext }) => {
            if (receivedContext !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('release_draft_context_substitution');
            }
            releaseAuthorInputSchema.parse(businessInput);
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
      throw new TypeError('release_draft_event_relationship_mismatch');
    }
    this.clearTransient();

    const repository = new SQLiteReleaseRepository(this.input.sqlite, this.input.sources);
    const bundle = createReleaseChangesetBundle();
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== releaseReadPort) {
          throw new TypeError('release_draft_undeclared_read_port');
        }
        return repository as unknown as Port;
      }
    });
    const scope: ReleaseScopeDto = { workspaceId: this.input.workspaceId, eventId };

    return this.input.operations.seal({
      capability: this.input.operations.capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('release_draft_context_substitution');
          }
          const wire = releaseAuthorInputSchema.parse(businessInput);
          const changesetId = parseChangesetId(this.nextId('newChangesetId'));
          const revisionId = parseChangesetRevisionId(this.nextId('newRevisionId'));
          const handle = this.nextId('newPreparationHandle');
          const timelineId = this.nextId('newTimelineId');
          const author = this.planningInput({ wire, scope, actorUserId, evaluatedAt });
          const before = this.effectiveStateWitness(repository, scope);
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
                kind: RELEASE_CHANGESET_KIND,
                version: RELEASE_CHANGESET_VERSION,
                dependencyGroup: 'release',
                authorInput: author
              }],
              dependencyGroups: [{ key: 'release', dependsOn: [] }],
              approvalPolicy: this.input.operations.approvalPolicy,
              origin: 'human_ui'
            });
          } catch (error) {
            if (error instanceof ReleasePlanningError) {
              this.#nonterminalReleaseContext = context;
              return staleContribution(error, wire.action);
            }
            throw error;
          }
          if (appended.kind === 'refused') {
            if (appended.refusal.kind !== 'id_collision') {
              throw new TypeError('release_draft_unexpected_lifecycle_refusal');
            }
            this.#nonterminalReleaseContext = context;
            return collisionContribution();
          }
          if (this.effectiveStateWitness(repository, scope) !== before) {
            throw new TypeError('release_draft_mutated_effective_state');
          }
          const revision = appended.record.revisions[0];
          const operation = revision?.revision.operations[0];
          if (!revision || !operation
              || appended.record.revisions.length !== 1
              || revision.revision.operations.length !== 1) {
            throw new TypeError('release_draft_record_incoherent');
          }
          const candidate = releaseDraftContributionSchema.parse({
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
              kind: 'release_changeset_draft',
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
            throw new TypeError('release_draft_success_contribution_invalid');
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
      throw new TypeError('release_draft_transaction_required');
    }
    const parsed = releaseDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('release_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = releaseDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== RELEASE_CHANGE_DRAFT_OPERATION_NAME
        || receipt.ref.operationVersion !== RELEASE_CHANGE_DRAFT_OPERATION_VERSION
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('release_draft_receipt_mismatch');
    }
    const domain = active.contribution.domain;
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, string,
      number, number
    ]>(`
      INSERT INTO release_draft_receipt_links (
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
      throw new TypeError('release_draft_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('release_draft_evidence_mismatch');
    }
    const child = releaseDraftEvidenceChildSchema.parse(contribution);
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO release_draft_timeline (
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
      throw new TypeError('release_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('release_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('release_draft_incomplete');
    }
  }

  afterUnitOfWorkCommitted(): void {
    this.clearTransient();
  }

  afterUnitOfWorkFinished(): void {
    this.clearTransient();
  }

  private planningInput(input: {
    readonly wire: ReleaseAuthorInput;
    readonly scope: ReleaseScopeDto;
    readonly actorUserId: string;
    readonly evaluatedAt: string;
  }): ReleasePlanningInput {
    const attribution = {
      scope: input.scope,
      actorUserId: input.actorUserId,
      occurredAt: input.evaluatedAt
    };
    // Pointer and policy moves create no release, so no identity is assigned.
    return input.wire.action === 'surface_rollback' || input.wire.action === 'surface_allowlist'
      ? { ...input.wire, ...attribution }
      : { ...input.wire, ...attribution, releaseId: this.nextId('newReleaseId') };
  }

  /**
   * Canonical witness over the effective release state a draft may never
   * move: both chain heads and every surface head pointer.
   */
  private effectiveStateWitness(
    repository: SQLiteReleaseRepository,
    scope: ReleaseScopeDto
  ): string {
    return canonicalJsonText({
      program: repository.readCurrentProgramRelease(scope)?.digestSha256 ?? null,
      styleSet: repository.readCurrentStyleSetRelease(scope)?.digestSha256 ?? null,
      heads: (['schedule', 'speakers', 'apply'] as const).map((kind) => {
        const head = repository.readSurfaceHead(scope, kind);
        return head === undefined ? null : { active: head.activeReleaseId, version: head.version };
      })
    });
  }

  private clearTransient(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }

  private nextId(method: keyof SQLiteReleaseDraftEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('release_draft_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteReleaseDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly operations: SQLiteReleaseDraftOperationsContract;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly sources: SQLiteReleaseUpstreamSources;
  readonly ids: SQLiteReleaseDraftEffectIds;
}) {
  const adapter = new SQLiteReleaseDraftEffectDomainAdapter(input);
  return Object.freeze({
    capability: input.operations.capability,
    adapter
  });
}
