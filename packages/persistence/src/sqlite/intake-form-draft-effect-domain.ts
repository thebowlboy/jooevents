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
  formDefinitionCreateDraftInputSchema,
  formDefinitionReviseDraftInputSchema,
  formClosingChangeDraftInputSchema,
  formLifecycleChangeDraftInputSchema,
  formVersionPublishDraftInputSchema,
  intakeIdSchema,
  type FormDefinitionContentDto
} from '@jooevents/contracts';
import {
  FORM_CHANGESET_KIND,
  FORM_CHANGESET_VERSION,
  FormPlanningError,
  assertFormOrdinaryChangesetBundle,
  captureFormOrdinaryApprovalPolicy,
  createFormOrdinaryChangesetBundle,
  formChangesetReadPort,
  formPlanningAttributionReadPort,
  parseFormChangesetAuthorInput,
  type FormChangesetAuthorInput,
  type FormDefinitionIdentityAssignment,
  type FormOrdinaryChangesetBundle,
  type FormOrdinaryPolicy
} from '@jooevents/intake';
import { formCloseDeadlinePlanningPort } from '@jooevents/deadline';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_FORM_DRAFT_HANDLER_CAPABILITY,
  intakeFormDraftActionForOperation,
  intakeFormDraftContributionSchema,
  intakeFormDraftDomainContributionSchema,
  intakeFormDraftEvidenceChildSchema,
  intakeFormDraftOperationResultSchema,
  intakeFormSafeDiffSchema,
  sealIntakePreparation,
  type IntakeFormDraftAction,
  type IntakeFormDraftContribution
} from '@jooevents/intake-operations';
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
import { SQLiteIntakeRepository } from './intake';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

export const INTAKE_FORM_DRAFT_EFFECT_SQL = `
CREATE TABLE intake_form_draft_receipt_links (
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
  action TEXT NOT NULL CHECK(action IN ('create', 'revise', 'publish', 'lifecycle', 'closing')),
  operation_name TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (action = 'create' AND operation_name = 'form.definition.create.draft')
    OR (action = 'revise' AND operation_name = 'form.definition.revise.draft')
    OR (action = 'publish' AND operation_name = 'form.version.publish.draft')
    OR (action = 'lifecycle' AND operation_name = 'form.lifecycle.change.draft')
    OR (action = 'closing' AND operation_name = 'form.closing.change.draft')
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

CREATE TABLE intake_form_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES intake_form_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER intake_form_draft_receipt_links_no_update
BEFORE UPDATE ON intake_form_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'Form draft receipt links are immutable'); END;
CREATE TRIGGER intake_form_draft_receipt_links_no_delete
BEFORE DELETE ON intake_form_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'Form draft receipt links are immutable'); END;
CREATE TRIGGER intake_form_draft_timeline_no_update
BEFORE UPDATE ON intake_form_draft_timeline
BEGIN SELECT RAISE(ABORT, 'Form draft timeline is immutable'); END;
CREATE TRIGGER intake_form_draft_timeline_no_delete
BEFORE DELETE ON intake_form_draft_timeline
BEGIN SELECT RAISE(ABORT, 'Form draft timeline is immutable'); END;
`;

export function installSQLiteIntakeFormDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('intake_form_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(INTAKE_FORM_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteIntakeFormDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
  newFormEntityId(): string;
  newFormVersionId(): string;
}

type DraftSuccess = Extract<
  IntakeFormDraftContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly action: IntakeFormDraftAction;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  receiptId?: string;
}

const APPLICATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function applicationUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !APPLICATION_UUID.test(value)) {
    throw new TypeError(`intake_form_draft_${label}_invalid`);
  }
  return value.toLowerCase();
}

function exactSubjects(context: EffectInvocationContext, eventId?: EventId): boolean {
  if (eventId === undefined) {
    return context.scope.subjects.length === 1
      && context.scope.subjects[0]?.kind === 'workspace'
      && context.scope.subjects[0].id === context.scope.workspaceId;
  }
  return context.scope.subjects.length === 2
    && context.scope.subjects.some((candidate) =>
      candidate.kind === 'workspace' && candidate.id === context.scope.workspaceId
    )
    && context.scope.subjects.some((candidate) =>
      candidate.kind === 'event' && candidate.id === eventId
    );
}

function sameCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === INTAKE_FORM_DRAFT_HANDLER_CAPABILITY.key
    && value.version === INTAKE_FORM_DRAFT_HANDLER_CAPABILITY.version;
}

function eventRequiredContribution(): IntakeFormDraftContribution {
  return intakeFormDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'intake_form.event_required', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function collisionContribution(): IntakeFormDraftContribution {
  return intakeFormDraftContributionSchema.parse({
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
  error: FormPlanningError,
  action: IntakeFormDraftAction,
  formId: string
): IntakeFormDraftContribution {
  const stale = [
    'stale_catalog', 'stale_definition', 'stale_registry', 'form_exists', 'form_missing',
    'form_version_exists', 'category_changed', 'session_changed', 'deadline_changed'
  ].includes(error.code);
  return intakeFormDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: stale ? 'stale_revision' : 'policy_violation',
        kind: stale ? 'intake_form.changed' : 'intake_form.change_refused',
        retryable: false,
        subjects: [{ type: 'intake_form', id: formId }],
        detail: { code: error.code, action, formId },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function assignIdentities(input: {
  readonly formId: string;
  readonly definition: { readonly rules: readonly { readonly key: string }[] };
  readonly existing?: FormDefinitionContentDto;
  readonly fresh: () => string;
}): FormDefinitionIdentityAssignment {
  const priorRules = new Map(input.existing?.rules.map((rule) => [rule.key, rule.id]) ?? []);
  const rules = input.definition.rules.map((rule) => ({
    key: rule.key,
    id: priorRules.get(rule.key) ?? input.fresh()
  }));
  return { formId: intakeIdSchema.parse(input.formId), rules };
}

/** Persists an inert Form changeset draft; effective Form tables are read-only here. */
export class SQLiteIntakeFormDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #bundle: FormOrdinaryChangesetBundle;
  readonly #changesets: SQLiteChangesetLifecycleStore;
  readonly #ids: SQLiteIntakeFormDraftEffectIds;
  readonly #issuedIds = new Set<string>();
  readonly #prepared = new Map<string, PreparedDraft>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy: FormOrdinaryPolicy;
    readonly repository: SQLiteIntakeRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteIntakeFormDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#bundle = createFormOrdinaryChangesetBundle({ policy: input.policy });
    assertFormOrdinaryChangesetBundle(this.#bundle);
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newPreparationHandle', 'newTimelineId',
      'newFormEntityId', 'newFormVersionId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('intake_form_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze({
      newChangesetId: input.ids.newChangesetId.bind(input.ids),
      newRevisionId: input.ids.newRevisionId.bind(input.ids),
      newPreparationHandle: input.ids.newPreparationHandle.bind(input.ids),
      newTimelineId: input.ids.newTimelineId.bind(input.ids),
      newFormEntityId: input.ids.newFormEntityId.bind(input.ids),
      newFormVersionId: input.ids.newFormVersionId.bind(input.ids)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('intake_form_draft_transaction_required');
    const action = intakeFormDraftActionForOperation(
      context.operation.name, context.operation.version
    );
    if (!sameCapability(capability) || action === undefined
        || context.operation.effect !== 'draft' || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('intake_form_draft_scope_mismatch');
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
        || authority.lane.policy.key !== INTAKE_EVENT_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== INTAKE_EVENT_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) {
      throw new TypeError('intake_form_draft_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    this.clearTransient();
    if (context.scope.eventId === undefined) {
      return sealIntakePreparation({
        capability,
        context,
        preparation: { prepare: ({ context: received }) => {
          if (received !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('intake_form_draft_context_substitution');
          }
          this.#nonterminalReleaseContext = context;
          return eventRequiredContribution();
        } }
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
    if (relationship.kind !== 'valid' || current?.currentEvent?.id !== eventId
        || current.currentEvent.workspaceId !== this.input.workspaceId) {
      throw new TypeError('intake_form_draft_event_relationship_mismatch');
    }
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort: <Port>(key: ChangesetReadPortKey<Port>): Port => {
        if ((key as unknown) === formChangesetReadPort) {
          return this.input.repository as unknown as Port;
        }
        if ((key as unknown) === formPlanningAttributionReadPort) {
          return Object.freeze({
            readFormPlanningAttribution: () => Object.freeze({ context, authorityRecheck })
          }) as unknown as Port;
        }
        if ((key as unknown) === formCloseDeadlinePlanningPort) {
          return this.input.repository as unknown as Port;
        }
        throw new TypeError('undeclared_intake_form_draft_read_port');
      }
    });
    return sealIntakePreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('intake_form_draft_context_substitution');
        }
        const changesetId = parseChangesetId(this.fresh(this.#ids.newChangesetId, 'changeset'));
        const revisionId = parseChangesetRevisionId(this.fresh(this.#ids.newRevisionId, 'revision'));
        const handle = this.fresh(this.#ids.newPreparationHandle, 'preparation_handle');
        const timelineId = this.fresh(this.#ids.newTimelineId, 'timeline');
        let author: FormChangesetAuthorInput;
        let formId: string;
        if (action === 'create') {
          const draft = formDefinitionCreateDraftInputSchema.parse(businessInput);
          formId = intakeIdSchema.parse(this.fresh(this.#ids.newFormEntityId, 'form'));
          author = parseFormChangesetAuthorInput({
            action,
            scope: { workspaceId: this.input.workspaceId, eventId },
            draft,
            identities: assignIdentities({
              formId,
              definition: draft.definition,
              fresh: () => this.fresh(this.#ids.newFormEntityId, 'form_entity')
            }),
            deadlineId: draft.definition.availability.kind === 'fixed_close_date'
              ? intakeIdSchema.parse(this.fresh(this.#ids.newFormEntityId, 'deadline'))
              : null
          });
        } else if (action === 'revise') {
          const draft = formDefinitionReviseDraftInputSchema.parse(businessInput);
          formId = draft.formId;
          const catalog = this.input.repository.readFormCatalog({
            workspaceId: this.input.workspaceId, eventId
          });
          const existing = catalog?.heads.find((head) => head.id === formId)?.definition;
          author = parseFormChangesetAuthorInput({
            action,
            scope: { workspaceId: this.input.workspaceId, eventId },
            draft,
            identities: assignIdentities({
              formId,
              definition: draft.definition,
              ...(existing === undefined ? {} : { existing }),
              fresh: () => this.fresh(this.#ids.newFormEntityId, 'form_entity')
            })
          });
        } else if (action === 'publish') {
          const draft = formVersionPublishDraftInputSchema.parse(businessInput);
          formId = draft.formId;
          author = parseFormChangesetAuthorInput({
            action,
            scope: { workspaceId: this.input.workspaceId, eventId },
            draft,
            formVersionId: intakeIdSchema.parse(
              this.fresh(this.#ids.newFormVersionId, 'form_version')
            )
          });
        } else if (action === 'lifecycle') {
          const draft = formLifecycleChangeDraftInputSchema.parse(businessInput);
          formId = draft.formId;
          author = parseFormChangesetAuthorInput({
            action,
            scope: { workspaceId: this.input.workspaceId, eventId },
            draft,
            formVersionId: draft.transition === 'publish_and_open'
              ? intakeIdSchema.parse(this.fresh(this.#ids.newFormVersionId, 'form_version'))
              : null
          });
        } else {
          const draft = formClosingChangeDraftInputSchema.parse(businessInput);
          formId = draft.formId;
          const head = this.input.repository.readFormHead({
            workspaceId: this.input.workspaceId, eventId
          }, formId);
          const needsDeadlineId = draft.closesAt !== null
            && head?.definition.availability.kind === 'evergreen';
          author = parseFormChangesetAuthorInput({
            action,
            scope: { workspaceId: this.input.workspaceId, eventId },
            draft,
            deadlineId: needsDeadlineId
              ? intakeIdSchema.parse(this.fresh(this.#ids.newFormEntityId, 'deadline'))
              : null
          });
        }
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
              kind: FORM_CHANGESET_KIND,
              version: FORM_CHANGESET_VERSION,
              dependencyGroup: 'intake_form',
              authorInput: author
            }],
            dependencyGroups: [{ key: 'intake_form', dependsOn: [] }],
            approvalPolicy: captureFormOrdinaryApprovalPolicy({
              policy: this.#bundle.policy, action
            }),
            origin: 'human_ui'
          });
        } catch (error) {
          if (error instanceof FormPlanningError) {
            this.#nonterminalReleaseContext = context;
            return planningRefusal(error, action, formId);
          }
          throw error;
        }
        if (appended.kind === 'refused') {
          if (appended.refusal.kind !== 'id_collision') {
            throw new TypeError('intake_form_draft_unexpected_lifecycle_refusal');
          }
          this.#nonterminalReleaseContext = context;
          return collisionContribution();
        }
        const revision = appended.record.revisions[0];
        const operation = revision?.revision.operations[0];
        if (!revision || !operation || appended.record.revisions.length !== 1
            || revision.revision.operations.length !== 1) {
          throw new TypeError('intake_form_draft_record_incoherent');
        }
        const safeDiff = intakeFormSafeDiffSchema.parse(operation.safeDiff);
        const candidate = intakeFormDraftContributionSchema.parse({
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
            kind: 'intake_form_changeset_draft',
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
          throw new TypeError('intake_form_draft_success_contribution_invalid');
        }
        const contribution = candidate as DraftSuccess;
        this.#prepared.set(handle, {
          handle, context, action, workspaceId: this.input.workspaceId, eventId,
          contribution, phase: 'prepared'
        });
        return contribution;
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('intake_form_draft_transaction_required');
    const parsed = intakeFormDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    const stored = prepared
      ? this.#changesets.read(prepared.contribution.domain.changesetId)
      : undefined;
    if (!prepared || prepared.phase !== 'prepared' || !stored
        || stored.recordDigestSha256 !== parsed.recordDigestSha256
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('intake_form_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = intakeFormDraftOperationResultSchema.safeParse(receipt.result);
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
      throw new TypeError('intake_form_draft_receipt_mismatch');
    }
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    const domain = active.contribution.domain;
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, string, number, number
    ]>(`
      INSERT INTO intake_form_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, active.workspaceId, active.eventId, domain.changesetId, domain.revisionId,
      domain.revisionDigestSha256, domain.recordDigestSha256, active.action,
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
        || !this.#expectedIdentity || active.receiptId === undefined
        || receiptId !== active.receiptId) {
      throw new TypeError('intake_form_draft_receipt_parent_missing');
    }
    const child = intakeFormDraftEvidenceChildSchema.parse(contribution);
    if (canonicalJsonText(child) !== canonicalJsonText(active.contribution.receiptChildren[0])) {
      throw new TypeError('intake_form_draft_evidence_mismatch');
    }
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO intake_form_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id,
        changeset_id, revision_id, occurred_at_ms, source_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      child.timelineId, active.receiptId, child.workspaceId, child.eventId,
      child.changesetId, child.revisionId, Date.parse(parseInstant(child.occurredAt)),
      child.sourceKind
    );
    active.phase = 'evidence_complete';
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('intake_form_draft_transaction_required');
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('intake_form_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('intake_form_draft_incomplete');
    }
    active.phase = 'claim_released';
  }

  afterUnitOfWorkCommitted(): void {
    this.clearTransient();
  }

  afterUnitOfWorkFinished(): void {
    this.clearTransient();
  }

  private fresh(factory: () => string, label: string): string {
    const value = applicationUuid(factory(), label);
    if (this.#issuedIds.has(value)) throw new TypeError('intake_form_draft_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }

  private clearTransient(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }
}

export function createSQLiteIntakeFormDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly policy: FormOrdinaryPolicy;
  readonly repository: SQLiteIntakeRepository;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteIntakeFormDraftEffectIds;
}): {
  readonly capability: typeof INTAKE_FORM_DRAFT_HANDLER_CAPABILITY;
  readonly adapter: SQLiteIntakeFormDraftEffectDomainAdapter;
} {
  return Object.freeze({
    capability: INTAKE_FORM_DRAFT_HANDLER_CAPABILITY,
    adapter: new SQLiteIntakeFormDraftEffectDomainAdapter(input)
  });
}
