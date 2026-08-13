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
  fieldRegistryAddDraftRequestSchema,
  fieldRegistryEditDraftRequestSchema,
  fieldRegistryMoveDraftRequestSchema,
  fieldRegistryRemoveDraftRequestSchema,
  fieldRegistryRestoreDraftRequestSchema,
  fieldRegistryDraftOperationResultSchema,
  fieldRegistrySafeDiffSchema,
  type FieldRegistryDraftAction
} from '@jooevents/contracts';
import {
  FIELD_REGISTRY_CHANGESET_KIND,
  FIELD_REGISTRY_CHANGESET_VERSION,
  FieldRegistryPlanningError,
  assertFieldRegistryOrdinaryChangesetBundle,
  captureFieldRegistryChangesetApprovalPolicy,
  createFieldRegistryOrdinaryChangesetBundle,
  fieldRegistryReadPort,
  fieldRegistryStableKeyFor,
  type FieldRegistryAuthorInput,
  type FieldRegistryOrdinaryChangesetBundle,
  type FieldRegistryOrdinaryPolicy
} from '@jooevents/field-registry';
import {
  FIELD_REGISTRY_DRAFT_HANDLER_CAPABILITY,
  FIELD_REGISTRY_MANAGE_ACCESS_POLICY,
  fieldRegistryDraftActionForOperation,
  fieldRegistryDraftContributionSchema,
  fieldRegistryDraftDomainContributionSchema,
  fieldRegistryDraftEvidenceChildSchema,
  sealFieldRegistryDraftPreparation,
  type FieldRegistryDraftContribution
} from '@jooevents/field-registry';
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
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import {
  createSQLiteDraftOnlyChangesetLifecycleStore,
  type SQLiteChangesetLifecycleStore
} from './changeset-lifecycle';
import { SQLiteEventSpineRepository } from './event-spine';
import {
  SQLiteFieldRegistryRepository,
  SQLiteIntakeFieldRegistryFormReferenceResolver
} from './field-registry';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

export const FIELD_REGISTRY_DRAFT_EFFECT_SQL = `
CREATE TABLE field_registry_draft_receipt_links (
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
  action TEXT NOT NULL CHECK(action IN ('add', 'edit', 'move', 'remove', 'restore')),
  operation_name TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (action = 'add' AND operation_name = 'field_registry.add.draft')
    OR (action = 'edit' AND operation_name = 'field_registry.edit.draft')
    OR (action = 'move' AND operation_name = 'field_registry.move.draft')
    OR (action = 'remove' AND operation_name = 'field_registry.remove.draft')
    OR (action = 'restore' AND operation_name = 'field_registry.restore.draft')
  ),
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

CREATE TABLE field_registry_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES field_registry_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER field_registry_draft_receipt_links_no_update
BEFORE UPDATE ON field_registry_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'field registry draft receipt links are immutable'); END;
CREATE TRIGGER field_registry_draft_receipt_links_no_delete
BEFORE DELETE ON field_registry_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'field registry draft receipt links are immutable'); END;
CREATE TRIGGER field_registry_draft_timeline_no_update
BEFORE UPDATE ON field_registry_draft_timeline
BEGIN SELECT RAISE(ABORT, 'field registry draft timeline is immutable'); END;
CREATE TRIGGER field_registry_draft_timeline_no_delete
BEFORE DELETE ON field_registry_draft_timeline
BEGIN SELECT RAISE(ABORT, 'field registry draft timeline is immutable'); END;
`;

export function installFieldRegistryDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('field_registry_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(FIELD_REGISTRY_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteFieldRegistryDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
  newFieldId(): string;
  newChoiceId(): string;
}

type DraftSuccess = Extract<
  FieldRegistryDraftContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly action: FieldRegistryDraftAction;
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

function applicationUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !APPLICATION_UUID.test(value)) {
    throw new TypeError(`field_registry_draft_${label}_invalid`);
  }
  return value.toLowerCase();
}

function exactCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === FIELD_REGISTRY_DRAFT_HANDLER_CAPABILITY.key
    && value.version === FIELD_REGISTRY_DRAFT_HANDLER_CAPABILITY.version;
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
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId
    );
}

function authorInput(input: {
  readonly action: FieldRegistryDraftAction;
  readonly businessInput: unknown;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly actorUserId: UserId;
  readonly evaluatedAt: Instant;
  readonly repository: SQLiteFieldRegistryRepository;
  readonly newFieldId: () => string;
  readonly newChoiceId: () => string;
  readonly issuedIds: Set<string>;
}): FieldRegistryAuthorInput {
  const scope = { workspaceId: input.workspaceId, eventId: input.eventId };
  if (input.action === 'add') {
    const request = fieldRegistryAddDraftRequestSchema.parse(input.businessInput);
    const fieldId = applicationUuid(input.newFieldId(), 'field_id');
    const choices = request.field.options.kind === 'custom'
      ? request.field.options.labels.map((label) => {
          const id = applicationUuid(input.newChoiceId(), 'choice_id');
          return { id, key: fieldRegistryStableKeyFor(label, id) };
        })
      : [];
    for (const id of [fieldId, ...choices.map((choice) => choice.id)]) {
      if (input.issuedIds.has(id)) throw new TypeError('field_registry_draft_ids_not_unique');
      input.issuedIds.add(id);
    }
    return {
      action: 'add', scope, request,
      identities: {
        fieldId,
        fieldKey: fieldRegistryStableKeyFor(request.field.label, fieldId),
        choices
      }
    };
  }
  if (input.action === 'edit') {
    const request = fieldRegistryEditDraftRequestSchema.parse(input.businessInput);
    const state = input.repository.readFieldRegistry(scope);
    const previous = state?.fields.find((field) => field.id === request.fieldId);
    const previousByLabel = new Map(previous?.options.kind === 'custom'
      ? previous.options.choices.map((choice) => [choice.label.toLocaleLowerCase('en-US'), choice])
      : []);
    const choiceIdentities = request.changes.customOptionLabels?.map((label) => {
      const prior = previousByLabel.get(label.toLocaleLowerCase('en-US'));
      if (prior) return { id: prior.id, key: prior.key };
      const id = applicationUuid(input.newChoiceId(), 'choice_id');
      if (input.issuedIds.has(id)) throw new TypeError('field_registry_draft_ids_not_unique');
      input.issuedIds.add(id);
      return { id, key: fieldRegistryStableKeyFor(label, id) };
    }) ?? [];
    return { action: 'edit', scope, request, choiceIdentities };
  }
  if (input.action === 'move') {
    return { action: 'move', scope,
      request: fieldRegistryMoveDraftRequestSchema.parse(input.businessInput) };
  }
  if (input.action === 'remove') {
    return {
      action: 'remove', scope,
      request: fieldRegistryRemoveDraftRequestSchema.parse(input.businessInput),
      removedAt: input.evaluatedAt,
      removedByUserId: input.actorUserId
    };
  }
  return { action: 'restore', scope,
    request: fieldRegistryRestoreDraftRequestSchema.parse(input.businessInput) };
}

function fieldId(author: FieldRegistryAuthorInput): string {
  return author.action === 'add' ? author.identities.fieldId : author.request.fieldId;
}

function planningRefusal(
  error: FieldRegistryPlanningError,
  action: FieldRegistryDraftAction,
  author: FieldRegistryAuthorInput
): FieldRegistryDraftContribution | undefined {
  if (error.code === 'invalid_plan' || error.code === 'wrong_scope') return undefined;
  const stale = [
    'stale_registry', 'field_exists', 'field_missing', 'stale_field',
    'field_removed', 'field_active', 'form_missing', 'form_changed'
  ].includes(error.code);
  return fieldRegistryDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: stale ? 'stale_revision' : 'policy_violation',
        kind: stale ? 'field_registry.changed' : 'field_registry.change_refused',
        retryable: false,
        subjects: [{ type: 'field_registry_field', id: fieldId(author) }],
        detail: { code: error.code, action, fieldId: fieldId(author) },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function eventRequiredContribution(): FieldRegistryDraftContribution {
  return fieldRegistryDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'field_registry.event_required', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function collisionContribution(): FieldRegistryDraftContribution {
  return fieldRegistryDraftContributionSchema.parse({
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

/** Persists an inert Field Registry changeset draft without mutating effective state. */
export class SQLiteFieldRegistryDraftEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #bundle: FieldRegistryOrdinaryChangesetBundle;
  readonly #changesets: SQLiteChangesetLifecycleStore;
  readonly #ids: SQLiteFieldRegistryDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: FieldRegistryOrdinaryPolicy;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteFieldRegistryDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#bundle = createFieldRegistryOrdinaryChangesetBundle({ policy: input.policy });
    assertFieldRegistryOrdinaryChangesetBundle(this.#bundle);
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newPreparationHandle',
      'newTimelineId', 'newFieldId', 'newChoiceId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('field_registry_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newPreparationHandle',
        'newTimelineId', 'newFieldId', 'newChoiceId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteFieldRegistryDraftEffectIds);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('field_registry_draft_transaction_required');
    }
    if (!exactCapability(capability)) {
      throw new TypeError('field_registry_draft_capability_mismatch');
    }
    const action = fieldRegistryDraftActionForOperation(
      context.operation.name,
      context.operation.version
    );
    if (action === undefined
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('field_registry_draft_scope_mismatch');
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
        || authority.lane.policy.key !== FIELD_REGISTRY_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== FIELD_REGISTRY_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) {
      throw new TypeError('field_registry_draft_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;

    if (context.scope.eventId === undefined) {
      return sealFieldRegistryDraftPreparation({
        capability,
        context,
        preparation: {
          prepare: ({ context: received }) => {
            if (received !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('field_registry_draft_context_substitution');
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
    if (relationship.kind !== 'valid'
        || current?.currentEvent?.id !== eventId
        || current.currentEvent.workspaceId !== this.input.workspaceId) {
      throw new TypeError('field_registry_draft_event_relationship_mismatch');
    }

    const repository = new SQLiteFieldRegistryRepository(
      this.input.sqlite,
      new SQLiteIntakeFieldRegistryFormReferenceResolver(this.input.sqlite)
    );
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== fieldRegistryReadPort) {
          throw new TypeError('undeclared_field_registry_draft_read_port');
        }
        return repository as unknown as Port;
      }
    });

    return sealFieldRegistryDraftPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }) => {
          if (receivedContext !== context || receivedAction !== action
              || !this.input.sqlite.inTransaction) {
            throw new TypeError('field_registry_draft_context_substitution');
          }
          const changesetId = parseChangesetId(this.#ids.newChangesetId());
          const revisionId = parseChangesetRevisionId(this.#ids.newRevisionId());
          const handle = applicationUuid(
            this.#ids.newPreparationHandle(), 'preparation_handle'
          );
          const timelineId = applicationUuid(this.#ids.newTimelineId(), 'timeline_id');
          for (const id of [changesetId, revisionId, handle, timelineId]) {
            if (this.#issuedIds.has(id)) throw new TypeError('field_registry_draft_ids_not_unique');
            this.#issuedIds.add(id);
          }
          const author = authorInput({
            action,
            businessInput,
            workspaceId: this.input.workspaceId,
            eventId,
            actorUserId,
            evaluatedAt,
            repository,
            newFieldId: this.#ids.newFieldId,
            newChoiceId: this.#ids.newChoiceId,
            issuedIds: this.#issuedIds
          });
          const before = repository.readFieldRegistry({
            workspaceId: this.input.workspaceId,
            eventId
          });
          if (!before) throw new TypeError('field_registry_draft_scope_missing');
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
                kind: FIELD_REGISTRY_CHANGESET_KIND,
                version: FIELD_REGISTRY_CHANGESET_VERSION,
                dependencyGroup: 'field_registry',
                authorInput: author
              }],
              dependencyGroups: [{ key: 'field_registry', dependsOn: [] }],
              approvalPolicy: captureFieldRegistryChangesetApprovalPolicy({
                bundle: this.#bundle
              }),
              origin: 'human_ui'
            });
          } catch (error) {
            if (error instanceof FieldRegistryPlanningError) {
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
              throw new TypeError('field_registry_draft_unexpected_lifecycle_refusal');
            }
            this.#nonterminalReleaseContext = context;
            return collisionContribution();
          }
          const after = repository.readFieldRegistry({
            workspaceId: this.input.workspaceId,
            eventId
          });
          if (!after || canonicalJsonText(after) !== canonicalJsonText(before)) {
            throw new TypeError('field_registry_draft_mutated_effective_state');
          }
          const revision = appended.record.revisions[0];
          const operation = revision?.revision.operations[0];
          if (!revision || !operation || revision.revision.operations.length !== 1
              || appended.record.revisions.length !== 1) {
            throw new TypeError('field_registry_draft_record_incoherent');
          }
          const contribution = fieldRegistryDraftContributionSchema.parse({
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
                safeDiff: fieldRegistrySafeDiffSchema.parse(operation.safeDiff)
              }
            },
            domain: {
              kind: 'field_registry_changeset_draft',
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
          if (contribution.result.kind !== 'success' || contribution.domain === null) {
            throw new TypeError('field_registry_draft_success_contribution_invalid');
          }
          const success = contribution as DraftSuccess;
          this.#prepared.set(handle, {
            handle,
            context,
            action,
            workspaceId: this.input.workspaceId,
            eventId,
            actorUserId,
            evaluatedAt,
            contribution: success,
            phase: 'prepared'
          });
          return success;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('field_registry_draft_transaction_required');
    }
    const parsed = fieldRegistryDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    const stored = prepared
      ? this.#changesets.read(prepared.contribution.domain.changesetId)
      : undefined;
    if (!prepared || prepared.phase !== 'prepared' || !stored
        || stored.recordDigestSha256 !== parsed.recordDigestSha256
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('field_registry_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = fieldRegistryDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== active.context.operation.name
        || receipt.ref.operationVersion !== active.context.operation.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || parsedResult.data.receipt.operationName !== active.context.operation.name
        || parsedResult.data.receipt.operationVersion !== active.context.operation.version
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('field_registry_draft_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    const domain = active.contribution.domain;
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, string, number, number
    ]>(`
      INSERT INTO field_registry_draft_receipt_links (
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
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || !this.#expectedIdentity || active.receiptId === undefined
        || receiptId !== active.receiptId) {
      throw new TypeError('field_registry_draft_receipt_parent_missing');
    }
    const child = fieldRegistryDraftEvidenceChildSchema.parse(contribution);
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(child) !== canonicalJsonText(expected)) {
      throw new TypeError('field_registry_draft_evidence_mismatch');
    }
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO field_registry_draft_timeline (
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
      throw new TypeError('field_registry_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('field_registry_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('field_registry_draft_incomplete');
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

export function createSQLiteFieldRegistryDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly policy: FieldRegistryOrdinaryPolicy;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteFieldRegistryDraftEffectIds;
}): {
  readonly capability: typeof FIELD_REGISTRY_DRAFT_HANDLER_CAPABILITY;
  readonly adapter: SQLiteFieldRegistryDraftEffectDomainAdapter;
} {
  return Object.freeze({
    capability: FIELD_REGISTRY_DRAFT_HANDLER_CAPABILITY,
    adapter: new SQLiteFieldRegistryDraftEffectDomainAdapter(input)
  });
}
