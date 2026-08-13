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
import {
  programVocabularySafeDiffSchema,
  type ProgramVocabularyDraftInput,
  type ProgramVocabularyKind
} from '@jooevents/contracts';
import {
  PROGRAM_VOCABULARY_CHANGESET_KIND,
  PROGRAM_VOCABULARY_CHANGESET_VERSION,
  assertProgramVocabularyOrdinaryChangesetBundle,
  captureProgramVocabularyOrdinaryApprovalPolicy,
  createProgramVocabularyOrdinaryChangesetBundle,
  createProgramVocabularyValidationView,
  parseProgramVocabularyId,
  parseProgramVocabularyOrdinaryAuthorInput,
  programVocabularyReadPort,
  ProgramVocabularyPlanningError,
  type ProgramReferenceContributorRegistry,
  type ProgramVocabularyOrdinaryChangesetBundle,
  type ProgramVocabularyOrdinaryPolicy
} from '@jooevents/program';
import {
  PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  programVocabularyCreateDraftInputSchema,
  programVocabularyDeleteDraftInputSchema,
  programVocabularyDraftActionForOperation,
  programVocabularyDraftContributionSchema,
  programVocabularyDraftDomainContributionSchema,
  programVocabularyDraftEvidenceChildSchema,
  programVocabularyDraftOperationResultSchema,
  programVocabularyEditDraftInputSchema,
  programVocabularyMergeDraftInputSchema,
  programVocabularyRestoreDraftInputSchema,
  programVocabularyRetireDraftInputSchema,
  sealProgramVocabularyDraftPreparation,
  type ProgramVocabularyDraftAction,
  type ProgramVocabularyDraftContribution
} from '@jooevents/program-operations';
import {
  canonicalJsonText,
  parseChangesetId,
  parseChangesetRevisionId,
  parseInstant,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { ChangesetPlanningSnapshot, ChangesetReadPortKey } from '@jooevents/changesets';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import {
  createSQLiteDraftOnlyChangesetLifecycleStore,
  SQLiteChangesetLifecycleStore,
} from './changeset-lifecycle';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import {
  SQLiteProgramVocabularyRepository,
  type SQLiteProgramVocabularyContributorAdapterRegistry
} from './program-vocabulary';

export const PROGRAM_VOCABULARY_DRAFT_EFFECT_SQL = `
CREATE TABLE program_vocabulary_draft_receipt_links (
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
  action TEXT NOT NULL CHECK(action IN ('create', 'edit', 'retire', 'restore', 'delete', 'merge')),
  operation_name TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (action = 'create' AND operation_name = 'program_vocabulary.create.draft')
    OR (action = 'edit' AND operation_name = 'program_vocabulary.edit.draft')
    OR (action = 'retire' AND operation_name = 'program_vocabulary.retire.draft')
    OR (action = 'restore' AND operation_name = 'program_vocabulary.restore.draft')
    OR (action = 'delete' AND operation_name = 'program_vocabulary.delete.draft')
    OR (action = 'merge' AND operation_name = 'program_vocabulary.merge.draft')
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

CREATE TABLE program_vocabulary_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES program_vocabulary_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER program_vocabulary_draft_receipt_links_no_update
BEFORE UPDATE ON program_vocabulary_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'program vocabulary draft receipt links are immutable'); END;

CREATE TRIGGER program_vocabulary_draft_receipt_links_no_delete
BEFORE DELETE ON program_vocabulary_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'program vocabulary draft receipt links are immutable'); END;

CREATE TRIGGER program_vocabulary_draft_timeline_no_update
BEFORE UPDATE ON program_vocabulary_draft_timeline
BEGIN SELECT RAISE(ABORT, 'program vocabulary draft timeline is immutable'); END;

CREATE TRIGGER program_vocabulary_draft_timeline_no_delete
BEFORE DELETE ON program_vocabulary_draft_timeline
BEGIN SELECT RAISE(ABORT, 'program vocabulary draft timeline is immutable'); END;
`;

export function installProgramVocabularyDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('program_vocabulary_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(PROGRAM_VOCABULARY_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteProgramVocabularyDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
  newVocabularyItemId(): string;
}

type DraftSuccess = Extract<
  ProgramVocabularyDraftContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly action: ProgramVocabularyDraftAction;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly actorUserId: UserId;
  readonly evaluatedAt: Instant;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  receiptId?: string;
}

const APPLICATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function neutralApplicationUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !APPLICATION_UUID.test(value)) {
    throw new TypeError(`program_vocabulary_draft_${label}_invalid`);
  }
  return value.toLowerCase();
}

function exactCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY.key
    && value.version === PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY.version;
}

function exactSubjects(context: EffectInvocationContext, eventId?: EventId): boolean {
  if (eventId === undefined) {
    return context.scope.subjects.length === 1
      && context.scope.subjects[0]?.kind === 'workspace'
      && context.scope.subjects[0].id === context.scope.workspaceId;
  }
  return context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && context.scope.subjects.some((subject) => subject.kind === 'event' && subject.id === eventId);
}

function authorInput(input: {
  readonly action: ProgramVocabularyDraftAction;
  readonly businessInput: unknown;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly newItemId: () => string;
}): ProgramVocabularyDraftInput {
  const scope = { workspaceId: input.workspaceId, eventId: input.eventId };
  switch (input.action) {
    case 'create': {
      const wire = programVocabularyCreateDraftInputSchema.parse(input.businessInput);
      const id = parseProgramVocabularyId(wire.kind, input.newItemId());
      const item = wire.kind === 'room'
        ? { kind: wire.kind, id, name: wire.name, capacity: wire.capacity }
        : { kind: wire.kind, id, name: wire.name };
      return parseProgramVocabularyOrdinaryAuthorInput({
        action: input.action,
        scope,
        expectedSetVersion: wire.expectedSetVersion,
        item
      });
    }
    case 'edit': {
      const wire = programVocabularyEditDraftInputSchema.parse(input.businessInput);
      return parseProgramVocabularyOrdinaryAuthorInput({ action: input.action, scope, ...wire });
    }
    case 'retire': {
      const wire = programVocabularyRetireDraftInputSchema.parse(input.businessInput);
      return parseProgramVocabularyOrdinaryAuthorInput({ action: input.action, scope, ...wire });
    }
    case 'restore': {
      const wire = programVocabularyRestoreDraftInputSchema.parse(input.businessInput);
      return parseProgramVocabularyOrdinaryAuthorInput({ action: input.action, scope, ...wire });
    }
    case 'delete': {
      const wire = programVocabularyDeleteDraftInputSchema.parse(input.businessInput);
      return parseProgramVocabularyOrdinaryAuthorInput({ action: input.action, scope, ...wire });
    }
    case 'merge': {
      const wire = programVocabularyMergeDraftInputSchema.parse(input.businessInput);
      return parseProgramVocabularyOrdinaryAuthorInput({ action: input.action, scope, ...wire });
    }
  }
}

function subject(input: ProgramVocabularyDraftInput): {
  readonly kind: ProgramVocabularyKind;
  readonly ids: readonly string[];
} {
  if (input.action === 'create') return { kind: input.item.kind, ids: [input.item.id] };
  if (input.action === 'merge') return { kind: input.kind, ids: [input.sourceId, input.targetId] };
  return { kind: input.kind, ids: [input.id] };
}

function planningRefusal(
  error: ProgramVocabularyPlanningError,
  action: ProgramVocabularyDraftAction,
  input: ProgramVocabularyDraftInput
): ProgramVocabularyDraftContribution | undefined {
  if (error.code === 'invalid_plan' || error.code === 'wrong_scope') return undefined;
  const target = subject(input);
  const stale = [
    'stale_set', 'stale_item', 'stale_reference', 'item_exists', 'item_missing'
  ].includes(error.code);
  return programVocabularyDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: stale ? 'stale_revision' : 'policy_violation',
        kind: stale ? 'program_vocabulary.changed' : 'program_vocabulary.change_refused',
        retryable: false,
        subjects: target.ids.map((id) => ({ type: `program_${target.kind}`, id })),
        detail: { code: error.code, action, kind: target.kind, ids: target.ids },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function eventRequiredContribution(): ProgramVocabularyDraftContribution {
  return programVocabularyDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'program_vocabulary.event_required',
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

function collisionContribution(): ProgramVocabularyDraftContribution {
  return programVocabularyDraftContributionSchema.parse({
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

/**
 * Persists an inert Program Vocabulary changeset draft inside the Foundation UoW.
 * Effective vocabulary state is read for planning but never mutated by this adapter.
 */
export class SQLiteProgramVocabularyDraftEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #bundle: ProgramVocabularyOrdinaryChangesetBundle;
  readonly #changesets: SQLiteChangesetLifecycleStore;
  readonly #ids: SQLiteProgramVocabularyDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: ProgramVocabularyOrdinaryPolicy;
    readonly referenceRegistry: ProgramReferenceContributorRegistry;
    readonly contributors: SQLiteProgramVocabularyContributorAdapterRegistry;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteProgramVocabularyDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#bundle = createProgramVocabularyOrdinaryChangesetBundle({
      referenceRegistry: input.referenceRegistry,
      policy: input.policy
    });
    assertProgramVocabularyOrdinaryChangesetBundle(this.#bundle);
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId',
      'newRevisionId',
      'newPreparationHandle',
      'newTimelineId',
      'newVocabularyItemId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('program_vocabulary_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze({
      newChangesetId: input.ids.newChangesetId.bind(input.ids),
      newRevisionId: input.ids.newRevisionId.bind(input.ids),
      newPreparationHandle: input.ids.newPreparationHandle.bind(input.ids),
      newTimelineId: input.ids.newTimelineId.bind(input.ids),
      newVocabularyItemId: input.ids.newVocabularyItemId.bind(input.ids)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('program_vocabulary_draft_transaction_required');
    }
    if (!exactCapability(capability)) {
      throw new TypeError('program_vocabulary_draft_capability_mismatch');
    }
    const action = programVocabularyDraftActionForOperation(
      context.operation.name,
      context.operation.version
    );
    if (
      action === undefined
      || context.operation.effect !== 'draft'
      || context.surface !== 'operator_http'
      || context.scope.workspaceId !== this.input.workspaceId
      || !exactSubjects(context, context.scope.eventId)
    ) throw new TypeError('program_vocabulary_draft_scope_mismatch');

    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (
      authority.actor.kind !== 'workspace_user'
      || authority.principal.kind !== 'workspace_user'
      || authority.actor.userId !== authority.principal.userId
      || context.actor.kind !== 'workspace_user'
      || context.actor.userId !== authority.actor.userId
      || authority.lane.kind !== 'operator'
      || authority.lane.surface !== 'operator_http'
      || authority.lane.policy.key !== PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY.key
      || authority.lane.policy.version !== PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY.version
      || !authority.grants.some((grant) =>
        grant.kind === 'permission' && grant.key === 'program.vocabulary.manage'
      )
    ) throw new TypeError('program_vocabulary_draft_authority_mismatch');

    const actorUserId = parseUserId(authority.actor.userId);
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;

    if (context.scope.eventId === undefined) {
      return sealProgramVocabularyDraftPreparation({
        capability,
        context,
        preparation: {
          prepare: ({ context: received }) => {
            if (received !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('program_vocabulary_draft_context_substitution');
            }
            this.#nonterminalReleaseContext = context;
            return eventRequiredContribution();
          }
        }
      });
    }

    const eventId = context.scope.eventId;
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite,
      workspaceId: this.input.workspaceId,
      eventId,
      userId: actorUserId,
      evaluatedAt
    });
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (
      relationship.kind !== 'valid'
      || current?.currentEvent?.id !== eventId
      || current.currentEvent.workspaceId !== this.input.workspaceId
    ) throw new TypeError('program_vocabulary_draft_event_relationship_mismatch');

    const repository = new SQLiteProgramVocabularyRepository(
      this.input.sqlite,
      this.input.referenceRegistry,
      this.input.contributors,
      () => ({ actorUserId, occurredAt: evaluatedAt })
    );
    const readView = createProgramVocabularyValidationView(repository);
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== programVocabularyReadPort) {
          throw new TypeError('undeclared_program_vocabulary_draft_read_port');
        }
        return readView as unknown as Port;
      }
    });

    return sealProgramVocabularyDraftPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }) => {
          if (
            receivedContext !== context
            || receivedAction !== action
            || !this.input.sqlite.inTransaction
          ) throw new TypeError('program_vocabulary_draft_context_substitution');

          const changesetId = parseChangesetId(this.#ids.newChangesetId());
          const revisionId = parseChangesetRevisionId(this.#ids.newRevisionId());
          const handle = neutralApplicationUuid(
            this.#ids.newPreparationHandle(),
            'preparation_handle'
          );
          const timelineId = neutralApplicationUuid(this.#ids.newTimelineId(), 'timeline_id');
          const author = authorInput({
            action,
            businessInput,
            workspaceId: this.input.workspaceId,
            eventId,
            newItemId: this.#ids.newVocabularyItemId
          });
          const generatedIds = [changesetId, revisionId, handle, timelineId];
          if (author.action === 'create') generatedIds.push(author.item.id);
          if (
            new Set(generatedIds).size !== generatedIds.length
            || generatedIds.some((id) => this.#issuedIds.has(id))
          ) throw new TypeError('program_vocabulary_draft_ids_not_unique');
          for (const id of generatedIds) this.#issuedIds.add(id);

          const before = repository.readVocabulary({
            workspaceId: this.input.workspaceId,
            eventId
          });
          if (!before) throw new TypeError('program_vocabulary_draft_scope_missing');
          const approvalPolicy = captureProgramVocabularyOrdinaryApprovalPolicy({
            policy: this.#bundle.policy,
            action
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
                kind: PROGRAM_VOCABULARY_CHANGESET_KIND,
                version: PROGRAM_VOCABULARY_CHANGESET_VERSION,
                dependencyGroup: 'program_vocabulary',
                authorInput: author
              }],
              dependencyGroups: [{ key: 'program_vocabulary', dependsOn: [] }],
              approvalPolicy,
              origin: 'human_ui'
            });
          } catch (error) {
            if (error instanceof ProgramVocabularyPlanningError) {
              const refusal = planningRefusal(error, action, author);
              if (refusal) {
                this.#nonterminalReleaseContext = context;
                return refusal;
              }
            }
            throw error;
          }
          if (appended.kind === 'refused') {
            if (appended.refusal.kind !== 'id_collision') {
              throw new TypeError('program_vocabulary_draft_unexpected_lifecycle_refusal');
            }
            this.#nonterminalReleaseContext = context;
            return collisionContribution();
          }
          const after = repository.readVocabulary({
            workspaceId: this.input.workspaceId,
            eventId
          });
          if (!after || canonicalJsonText(after) !== canonicalJsonText(before)) {
            throw new TypeError('program_vocabulary_draft_mutated_effective_state');
          }
          const revision = appended.record.revisions[0];
          const operation = revision?.revision.operations[0];
          if (
            !revision
            || !operation
            || revision.revision.operations.length !== 1
            || appended.record.revisions.length !== 1
          ) throw new TypeError('program_vocabulary_draft_record_incoherent');
          const safeDiff = programVocabularySafeDiffSchema.parse(operation.safeDiff);
          const candidate = programVocabularyDraftContributionSchema.parse({
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
                safeDiff
              }
            },
            domain: {
              kind: 'program_vocabulary_changeset_draft',
              preparationHandle: handle,
              action,
              workspaceId: this.input.workspaceId,
              eventId,
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
            throw new TypeError('program_vocabulary_draft_success_contribution_invalid');
          }
          const contribution = candidate as DraftSuccess;
          this.#prepared.set(handle, {
            handle,
            context,
            action,
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
      throw new TypeError('program_vocabulary_draft_transaction_required');
    }
    const parsed = programVocabularyDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    const stored = prepared ? this.#changesets.read(prepared.contribution.domain.changesetId) : undefined;
    if (
      !prepared
      || prepared.phase !== 'prepared'
      || !stored
      || stored.recordDigestSha256 !== parsed.recordDigestSha256
      || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)
    ) throw new TypeError('program_vocabulary_draft_preparation_invalid');
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = programVocabularyDraftOperationResultSchema.safeParse(receipt.result);
    if (
      !this.input.sqlite.inTransaction
      || !active
      || active.phase !== 'applied'
      || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
      || receipt.requestHash !== active.context.requestBinding.requestHashSha256
      || receipt.ref.operationName !== active.context.operation.name
      || receipt.ref.operationVersion !== active.context.operation.version
      || !parsedResult.success
      || parsedResult.data.kind !== 'success'
      || parsedResult.data.receipt.id !== receipt.ref.id
      || parsedResult.data.receipt.operationName !== active.context.operation.name
      || parsedResult.data.receipt.operationVersion !== active.context.operation.version
      || canonicalJsonText(parsedResult.data.data)
        !== canonicalJsonText(active.contribution.result.data)
    ) throw new TypeError('program_vocabulary_draft_receipt_mismatch');
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    const domain = active.contribution.domain;
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, string, number, number
    ]>(`
      INSERT INTO program_vocabulary_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      active.workspaceId,
      active.eventId,
      domain.changesetId,
      domain.revisionId,
      domain.revisionDigestSha256,
      domain.recordDigestSha256,
      active.action,
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
    if (
      !this.input.sqlite.inTransaction
      || !active
      || active.phase !== 'parent_linked'
      || !this.#expectedIdentity
      || active.receiptId === undefined
      || receiptId !== active.receiptId
    ) throw new TypeError('program_vocabulary_draft_receipt_parent_missing');
    const child = programVocabularyDraftEvidenceChildSchema.parse(contribution);
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(child) !== canonicalJsonText(expected)) {
      throw new TypeError('program_vocabulary_draft_evidence_mismatch');
    }
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO program_vocabulary_draft_timeline (
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
      throw new TypeError('program_vocabulary_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('program_vocabulary_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (
      active.phase !== 'evidence_complete'
      || !this.#expectedIdentity
      || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)
    ) throw new TypeError('program_vocabulary_draft_incomplete');
    active.phase = 'claim_released';
  }

  afterUnitOfWorkCommitted(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }
}

export function createSQLiteProgramVocabularyDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly policy: ProgramVocabularyOrdinaryPolicy;
  readonly referenceRegistry: ProgramReferenceContributorRegistry;
  readonly contributors: SQLiteProgramVocabularyContributorAdapterRegistry;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteProgramVocabularyDraftEffectIds;
}): {
  readonly capability: typeof PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY;
  readonly adapter: SQLiteProgramVocabularyDraftEffectDomainAdapter;
} {
  return Object.freeze({
    capability: PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
    adapter: new SQLiteProgramVocabularyDraftEffectDomainAdapter(input)
  });
}
