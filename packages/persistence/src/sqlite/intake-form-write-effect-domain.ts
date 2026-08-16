import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  fieldRegistrySnapshotSchema,
  formClosingChangeDraftInputSchema,
  formDefinitionCreateDraftInputSchema,
  formDefinitionReviseDraftInputSchema,
  intakeFormDirectLifecycleInputSchema,
  intakeFormVersionPublishInputSchema,
  intakeFormVersionReviewInputSchema,
  intakeIdSchema,
  releaseSurfaceSuccessorPlanSchema,
  type FormDefinitionContentDto,
  type IntakeFormVersionReviewSafeDiff,
  type IntakeFormWriteAction,
  type ReleaseSurfaceSuccessorPlanDto
} from '@jooevents/contracts';
import {
  planFormCloseDeadlineChangeFrom
} from '@jooevents/deadline';
import {
  FormPlanningError,
  parseFormMutationPlan,
  planFormClosingChange,
  planFormCreation,
  planFormLifecycleChange,
  planFormPublication,
  planFormRevision,
  validateFormMutationPlan,
  type FormDefinitionIdentityAssignment,
  type FormMutationPlan,
  type FormPlanningErrorCode
} from '@jooevents/intake';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_FORM_CLOSING_OPERATION,
  INTAKE_FORM_CREATE_OPERATION,
  INTAKE_FORM_DIRECT_HANDLER_CAPABILITY,
  INTAKE_FORM_LIFECYCLE_OPERATION,
  INTAKE_FORM_PUBLISH_HANDLER_CAPABILITY,
  INTAKE_FORM_REVIEW_DRAFT_HANDLER_CAPABILITY,
  INTAKE_FORM_REVISE_OPERATION,
  INTAKE_FORM_VERSION_PUBLISH_OPERATION,
  INTAKE_FORM_VERSION_REVIEW_DRAFT_OPERATION,
  intakeFormDirectContributionSchema,
  intakeFormVersionPublishContributionSchema,
  intakeFormVersionReviewDraftContributionSchema,
  sealIntakeFormWritePreparation
} from '@jooevents/intake-operations';
import {
  canonicalJsonSha256,
  canonicalJsonText,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  planReleaseSurfaceSuccessorFrom,
  validateReleaseSurfaceSuccessorFrom
} from '@jooevents/release';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';
import { SQLiteIntakeRepository } from './intake';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteReleaseSurfaceSuccessorStore } from './release';

export const SQLITE_INTAKE_FORM_WRITE_EFFECT_SQL = `
CREATE TABLE intake_form_version_review_drafts (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  action TEXT NOT NULL CHECK(action IN ('publish', 'publish_and_open')),
  status TEXT NOT NULL CHECK(status IN ('draft', 'published')),
  head_revision_id TEXT NOT NULL CHECK(length(head_revision_id) = 36),
  head_revision_digest_sha256 TEXT NOT NULL CHECK(
    length(head_revision_digest_sha256) = 64
    AND head_revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  published_by_user_id TEXT CHECK(published_by_user_id IS NULL OR length(published_by_user_id) = 36),
  published_at_ms INTEGER CHECK(published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, id, head_revision_id, head_revision_digest_sha256),
  CHECK((status = 'published') = (published_by_user_id IS NOT NULL)),
  CHECK((published_by_user_id IS NULL) = (published_at_ms IS NULL)),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (published_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_form_version_review_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  draft_id TEXT NOT NULL CHECK(length(draft_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number = 1),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  review_json TEXT NOT NULL CHECK(json_valid(review_json) AND json_type(review_json) = 'object'),
  safe_diff_json TEXT NOT NULL CHECK(json_valid(safe_diff_json) AND json_type(safe_diff_json) = 'object'),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, draft_id, id),
  UNIQUE (workspace_id, event_id, draft_id, id, digest_sha256),
  FOREIGN KEY (workspace_id, event_id, draft_id)
    REFERENCES intake_form_version_review_drafts(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER intake_form_version_review_revisions_no_update
BEFORE UPDATE ON intake_form_version_review_revisions
BEGIN SELECT RAISE(ABORT, 'Form version review revisions are immutable'); END;
CREATE TRIGGER intake_form_version_review_revisions_no_delete
BEFORE DELETE ON intake_form_version_review_revisions
BEGIN SELECT RAISE(ABORT, 'Form version review revisions are immutable'); END;
CREATE TRIGGER intake_form_version_review_drafts_no_delete
BEFORE DELETE ON intake_form_version_review_drafts
BEGIN SELECT RAISE(ABORT, 'Form version review drafts are retained'); END;
`;

export function installIntakeFormWriteEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('intake_form_write_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_INTAKE_FORM_WRITE_EFFECT_SQL)).immediate();
}

export interface SQLiteIntakeFormWriteIds {
  newFormEntityId(): string;
  newFormVersionId(): string;
  newReviewDraftId(): string;
  newReviewRevisionId(): string;
}

interface ReviewPlan {
  readonly action: 'publish' | 'publish_and_open';
  readonly mutation: FormMutationPlan;
  readonly surfaceSuccessors: ReleaseSurfaceSuccessorPlanDto;
}

type Prepared =
  | { readonly kind: 'direct'; readonly plan: FormMutationPlan; readonly result: FormWriteResult }
  | { readonly kind: 'review'; readonly draftId: string; readonly revisionId: string; readonly digest: string; readonly review: ReviewPlan; readonly safeDiff: IntakeFormVersionReviewSafeDiff; readonly actorUserId: UserId; readonly occurredAt: Instant }
  | { readonly kind: 'publish'; readonly draftId: string; readonly revisionId: string; readonly digest: string; readonly review: ReviewPlan; readonly result: FormWriteResult; readonly actorUserId: UserId; readonly occurredAt: Instant };

interface FormWriteResult {
  readonly schemaVersion: 1;
  readonly action: IntakeFormWriteAction;
  readonly formId: string;
  readonly formDefinitionVersion: number;
  readonly catalogVersion: number;
  readonly publishedVersionId: string | null;
}

interface ReviewRow {
  readonly status: 'draft' | 'published';
  readonly action: 'publish' | 'publish_and_open';
  readonly review_json: string;
  readonly safe_diff_json: string;
}

function sameRef(left: { readonly key: string; readonly version: number }, right: { readonly key: string; readonly version: number }): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameOperation(left: { readonly name: string; readonly version: number }, right: { readonly name: string; readonly version: number }): boolean {
  return left.name === right.name && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return context.scope.subjects.length === (eventId === undefined ? 1 : 2)
    && context.scope.subjects.some((subject) => subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && (eventId === undefined || context.scope.subjects.some((subject) => subject.kind === 'event' && subject.id === eventId));
}

function directOperation(context: EffectInvocationContext): 'create' | 'revise' | 'closing' | 'lifecycle' | undefined {
  const candidates = [
    ['create', INTAKE_FORM_CREATE_OPERATION],
    ['revise', INTAKE_FORM_REVISE_OPERATION],
    ['closing', INTAKE_FORM_CLOSING_OPERATION],
    ['lifecycle', INTAKE_FORM_LIFECYCLE_OPERATION]
  ] as const;
  return candidates.find(([, operation]) => operation.name === context.operation.name && operation.version === context.operation.version)?.[0];
}

function formIdForBusinessInput(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'formId' in value) {
    const formId = (value as { readonly formId?: unknown }).formId;
    if (typeof formId === 'string') return intakeIdSchema.parse(formId);
  }
  return '00000000-0000-4000-8000-000000000000';
}

function outcome(kind: 'intake_form.event_required' | 'intake_form.review_changed') {
  return { result: { kind: 'outcome' as const, outcome: { class: 'conflict' as const, kind, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } }, domain: null, effectContributions: [] as const };
}

function planningOutcome(error: FormPlanningError, action: IntakeFormWriteAction, formId: string) {
  const staleCodes: readonly FormPlanningErrorCode[] = ['stale_catalog', 'stale_definition', 'stale_registry', 'form_exists', 'form_missing', 'form_version_exists', 'category_changed', 'session_changed', 'deadline_changed'];
  const stale = staleCodes.includes(error.code);
  return { result: { kind: 'outcome' as const, outcome: { class: stale ? 'stale_revision' as const : 'policy_violation' as const, kind: stale ? 'intake_form.changed' : 'intake_form.change_refused', retryable: false, subjects: [{ type: 'intake_form', id: formId }], detail: { code: error.code, action, formId }, detailSchemaVersion: 1 } }, domain: null, effectContributions: [] as const };
}

function assignIdentities(input: { readonly formId: string; readonly definition: { readonly rules: readonly { readonly key: string }[] }; readonly existing?: FormDefinitionContentDto; readonly fresh: () => string }): FormDefinitionIdentityAssignment {
  const prior = new Map(input.existing?.rules.map((rule) => [rule.key, rule.id]) ?? []);
  return { formId: intakeIdSchema.parse(input.formId), rules: input.definition.rules.map((rule) => ({ key: rule.key, id: prior.get(rule.key) ?? input.fresh() })) };
}

function safeHead(head: FormMutationPlan['after']) {
  return { id: head.id, version: head.version, status: head.status, currentPublishedVersionId: head.currentPublishedVersionId, definition: head.definition };
}

function safeSurfaceSuccessors(plan: ReleaseSurfaceSuccessorPlanDto) {
  return plan.successors.map((successor) => ({ surfaceReleaseId: successor.release.id, supersedesReleaseId: successor.headBefore.activeReleaseId, formVersionId: plan.input.formVersionId, headVersion: successor.headAfter.version }));
}

function reviewSafeDiff(review: ReviewPlan): IntakeFormVersionReviewSafeDiff {
  const mutation = review.mutation;
  if (mutation.action !== 'publish' && (mutation.action !== 'lifecycle' || mutation.publishedVersion === null)) throw new TypeError('intake_form_review_plan_invalid');
  const version = mutation.publishedVersion;
  if (version === null) throw new TypeError('intake_form_review_version_missing');
  return {
    action: review.action,
    before: safeHead(mutation.before),
    after: safeHead(mutation.after),
    publishedVersion: { id: version.id, number: version.number, definitionDigestSha256: version.definitionDigestSha256 },
    surfaceSuccessors: safeSurfaceSuccessors(review.surfaceSuccessors)
  };
}

function semanticAction(plan: FormMutationPlan): IntakeFormWriteAction {
  if (plan.action === 'create' || plan.action === 'revise' || plan.action === 'publish') return plan.action;
  if (plan.action === 'lifecycle') return plan.publishedVersion !== null ? 'publish_and_open' : plan.after.status === 'closed' ? 'close' : 'reopen';
  if (plan.deadlineContribution.input.action === 'create') return 'set_closing';
  return plan.deadlineContribution.input.action === 'clear' ? 'remove_closing' : 'update_closing';
}

export class SQLiteIntakeFormWriteEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #ids: SQLiteIntakeFormWriteIds;
  readonly #issuedIds = new Set<string>();
  #prepared: Prepared | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteIntakeRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteIntakeFormWriteIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    for (const method of ['newFormEntityId', 'newFormVersionId', 'newReviewDraftId', 'newReviewRevisionId'] as const) if (typeof input.ids[method] !== 'function') throw new TypeError('intake_form_write_id_factory_invalid');
    this.#ids = Object.freeze(Object.fromEntries((['newFormEntityId', 'newFormVersionId', 'newReviewDraftId', 'newReviewRevisionId'] as const).map((method) => [method, input.ids[method].bind(input.ids)])) as unknown as SQLiteIntakeFormWriteIds);
  }

  openHandlerSnapshot(capability: { readonly key: string; readonly version: number }, context: EffectInvocationContext, authorityRecheck: SealedEffectAuthorityRecheckResult): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('intake_form_write_transaction_required');
    const direct = sameRef(capability, INTAKE_FORM_DIRECT_HANDLER_CAPABILITY) && directOperation(context) !== undefined && context.operation.effect === 'commit';
    const review = sameRef(capability, INTAKE_FORM_REVIEW_DRAFT_HANDLER_CAPABILITY) && sameOperation(context.operation, INTAKE_FORM_VERSION_REVIEW_DRAFT_OPERATION) && context.operation.effect === 'draft';
    const publish = sameRef(capability, INTAKE_FORM_PUBLISH_HANDLER_CAPABILITY) && sameOperation(context.operation, INTAKE_FORM_VERSION_PUBLISH_OPERATION) && context.operation.effect === 'commit';
    if ((!direct && !review && !publish) || context.surface !== 'operator_http' || context.scope.workspaceId !== this.input.workspaceId || !exactSubjects(context)) throw new TypeError('intake_form_write_scope_mismatch');
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user' || authority.principal.kind !== 'workspace_user' || authority.actor.userId !== authority.principal.userId || context.actor.kind !== 'workspace_user' || context.actor.userId !== authority.actor.userId || authority.lane.kind !== 'operator' || authority.lane.surface !== 'operator_http' || !sameRef(authority.lane.policy, INTAKE_EVENT_MANAGE_ACCESS_POLICY) || !authority.grants.some((grant) => grant.kind === 'permission' && grant.key === 'event.manage')) throw new TypeError('intake_form_write_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite).readCurrentEventState(this.input.workspaceId);
    if (eventId !== undefined) {
      const relationship = this.input.eventRelationships.validateEvent({ sqlite: this.input.sqlite, workspaceId: this.input.workspaceId, eventId, userId: actorUserId, evaluatedAt });
      if (relationship.kind !== 'valid' || current?.currentEvent?.id !== eventId || current.currentEvent.workspaceId !== this.input.workspaceId) throw new TypeError('intake_form_write_event_relationship_mismatch');
    } else if (!current || current.currentEvent !== undefined) throw new TypeError('intake_form_write_event_relationship_mismatch');
    this.#prepared = undefined;
    return sealIntakeFormWritePreparation({ capability, context, prepare: ({ businessInput, context: received }) => {
      if (received !== context || !this.input.sqlite.inTransaction) throw new TypeError('intake_form_write_context_substitution');
      if (eventId === undefined) return outcome('intake_form.event_required');
      if (direct) return this.prepareDirect({ operation: directOperation(context)!, businessInput, eventId, actorUserId, evaluatedAt });
      if (review) return this.prepareReview({ businessInput, eventId, actorUserId, evaluatedAt });
      return this.preparePublish({ businessInput, eventId, actorUserId, evaluatedAt });
    } });
  }

  private prepareDirect(input: { readonly operation: 'create' | 'revise' | 'closing' | 'lifecycle'; readonly businessInput: unknown; readonly eventId: EventId; readonly actorUserId: UserId; readonly evaluatedAt: Instant }) {
    const scope = { workspaceId: this.input.workspaceId, eventId: input.eventId };
    const catalog = this.input.repository.readFormCatalog(scope);
    const registry = this.input.repository.readFieldRegistrySnapshot(scope);
    if (!catalog || !registry) return intakeFormDirectContributionSchema.parse(outcome('intake_form.event_required'));
    let plan: FormMutationPlan;
    let candidateFormId = formIdForBusinessInput(input.businessInput);
    try {
      if (input.operation === 'create') {
        const draft = formDefinitionCreateDraftInputSchema.parse(input.businessInput);
        const formId = this.nextId('newFormEntityId');
        candidateFormId = formId;
        const deadlineContribution = draft.definition.availability.kind === 'fixed_close_date' ? planFormCloseDeadlineChangeFrom(this.input.repository, { scope, currentDeadlineId: null, closesAt: draft.definition.availability.displayDate, identity: { deadlineId: this.nextId('newFormEntityId') }, attribution: { userId: input.actorUserId, at: input.evaluatedAt } }) : null;
        plan = planFormCreation({ catalog, registry, authorInput: draft, identities: assignIdentities({ formId, definition: draft.definition, fresh: () => this.nextId('newFormEntityId') }), references: this.input.repository, deadlineContribution, server: { createdByUserId: input.actorUserId, createdAt: input.evaluatedAt } });
      } else {
        const formId = formIdForBusinessInput(input.businessInput);
        candidateFormId = formId;
        const head = catalog.heads.find((value) => value.id === formId);
        if (!head) throw new FormPlanningError('form_missing');
        if (input.operation === 'revise') {
          const draft = formDefinitionReviseDraftInputSchema.parse(input.businessInput);
          plan = planFormRevision({ head, registry, authorInput: draft, identities: assignIdentities({ formId: head.id, definition: draft.definition, existing: head.definition, fresh: () => this.nextId('newFormEntityId') }), references: this.input.repository, server: { updatedByUserId: input.actorUserId, updatedAt: input.evaluatedAt } });
        } else if (input.operation === 'lifecycle') {
          const draft = intakeFormDirectLifecycleInputSchema.parse(input.businessInput);
          plan = planFormLifecycleChange({ head, authorInput: draft, references: this.input.repository, server: { updatedByUserId: input.actorUserId, updatedAt: input.evaluatedAt } });
        } else {
          const draft = formClosingChangeDraftInputSchema.parse(input.businessInput);
          const currentDeadlineId = head.definition.availability.kind === 'deadline' ? head.definition.availability.deadlineId : null;
          if (currentDeadlineId === null && draft.closesAt === null) throw new FormPlanningError('invalid_transition');
          const contribution = currentDeadlineId === null ? planFormCloseDeadlineChangeFrom(this.input.repository, { scope, currentDeadlineId: null, closesAt: draft.closesAt!, identity: { deadlineId: this.nextId('newFormEntityId') }, attribution: { userId: input.actorUserId, at: input.evaluatedAt } }) : planFormCloseDeadlineChangeFrom(this.input.repository, { scope, currentDeadlineId, closesAt: draft.closesAt, attribution: { userId: input.actorUserId, at: input.evaluatedAt } });
          plan = planFormClosingChange({ head, authorInput: draft, deadlineContribution: contribution, server: { updatedByUserId: input.actorUserId, updatedAt: input.evaluatedAt } });
        }
      }
    } catch (error) {
      if (error instanceof FormPlanningError) return intakeFormDirectContributionSchema.parse(planningOutcome(error, input.operation === 'create' ? 'create' : input.operation === 'revise' ? 'revise' : input.operation === 'lifecycle' ? 'close' : 'set_closing', candidateFormId));
      throw error;
    }
    const result = this.resultFor(plan, catalog.version + 1);
    const contribution = intakeFormDirectContributionSchema.parse({ result: { kind: 'success', data: result }, domain: { kind: 'intake_form_direct_change', plan }, effectContributions: [] });
    this.#prepared = { kind: 'direct', plan, result };
    return contribution;
  }

  private prepareReview(input: { readonly businessInput: unknown; readonly eventId: EventId; readonly actorUserId: UserId; readonly evaluatedAt: Instant }) {
    const wire = intakeFormVersionReviewInputSchema.parse(input.businessInput);
    const scope = { workspaceId: this.input.workspaceId, eventId: input.eventId };
    const catalog = this.input.repository.readFormCatalog(scope);
    const registry = this.input.repository.readFieldRegistrySnapshot(scope);
    const head = catalog?.heads.find((value) => value.id === wire.formId);
    if (!catalog || !registry || !head) return intakeFormVersionReviewDraftContributionSchema.parse(planningOutcome(new FormPlanningError(head ? 'wrong_scope' : 'form_missing'), wire.action, wire.formId));
    let mutation: FormMutationPlan;
    try {
      const formVersionId = this.nextId('newFormVersionId');
      mutation = wire.action === 'publish' ? planFormPublication({ head, registry, existingVersions: this.input.repository.readFormVersions(scope, head.id), authorInput: { formId: wire.formId, expectedDefinitionVersion: wire.expectedDefinitionVersion, expectedRegistryVersion: wire.expectedRegistryVersion }, references: this.input.repository, server: { formVersionId, publishedByUserId: input.actorUserId, publishedAt: input.evaluatedAt } }) : planFormLifecycleChange({ head, registry, existingVersions: this.input.repository.readFormVersions(scope, head.id), authorInput: { transition: 'publish_and_open', formId: wire.formId, expectedDefinitionVersion: wire.expectedDefinitionVersion, expectedRegistryVersion: wire.expectedRegistryVersion }, references: this.input.repository, server: { updatedByUserId: input.actorUserId, updatedAt: input.evaluatedAt, formVersionId } });
      const version = mutation.action === 'publish' ? mutation.publishedVersion : mutation.publishedVersion!;
      const surfaceSuccessors = planReleaseSurfaceSuccessorFrom(new SQLiteReleaseSurfaceSuccessorStore(this.input.sqlite), { scope, formId: head.id, formVersionId: version.id, actorUserId: input.actorUserId, occurredAt: input.evaluatedAt });
      const review: ReviewPlan = { action: wire.action, mutation, surfaceSuccessors };
      const safeDiff = reviewSafeDiff(review);
      const draftId = this.nextId('newReviewDraftId');
      const revisionId = this.nextId('newReviewRevisionId');
      const digest = canonicalJsonSha256({ schemaVersion: 1, review, safeDiff });
      const contribution = intakeFormVersionReviewDraftContributionSchema.parse({ result: { kind: 'success', data: { schemaVersion: 1, action: wire.action, draftId, status: 'draft', revision: { id: revisionId, number: 1, digestSha256: digest }, safeDiff } }, domain: { kind: 'intake_form_version_review_draft', draftId, revisionId, revisionDigestSha256: digest, review, safeDiff }, effectContributions: [] });
      this.#prepared = { kind: 'review', draftId, revisionId, digest, review, safeDiff, actorUserId: input.actorUserId, occurredAt: input.evaluatedAt };
      return contribution;
    } catch (error) {
      if (error instanceof FormPlanningError) return intakeFormVersionReviewDraftContributionSchema.parse(planningOutcome(error, wire.action, wire.formId));
      throw error;
    }
  }

  private preparePublish(input: { readonly businessInput: unknown; readonly eventId: EventId; readonly actorUserId: UserId; readonly evaluatedAt: Instant }) {
    const wire = intakeFormVersionPublishInputSchema.parse(input.businessInput);
    const row = this.input.sqlite.query<ReviewRow, [string, string, string, string, string]>(`SELECT d.status, d.action, r.review_json, r.safe_diff_json FROM intake_form_version_review_drafts d JOIN intake_form_version_review_revisions r ON r.workspace_id=d.workspace_id AND r.event_id=d.event_id AND r.draft_id=d.id AND r.id=d.head_revision_id AND r.digest_sha256=d.head_revision_digest_sha256 WHERE d.workspace_id=? AND d.event_id=? AND d.id=? AND r.id=? AND r.digest_sha256=? LIMIT 2`).get(this.input.workspaceId, input.eventId, wire.draftId, wire.revisionId, wire.revisionDigestSha256);
    if (!row || row.status !== 'draft') return intakeFormVersionPublishContributionSchema.parse(outcome('intake_form.review_changed'));
    const parsedReview = JSON.parse(row.review_json) as { readonly action?: unknown; readonly mutation?: unknown; readonly surfaceSuccessors?: unknown };
    const mutation = parseFormMutationPlan(parsedReview.mutation);
    const surfaceSuccessors = releaseSurfaceSuccessorPlanSchema.parse(parsedReview.surfaceSuccessors);
    if (parsedReview.action !== row.action || (row.action !== 'publish' && row.action !== 'publish_and_open')) return intakeFormVersionPublishContributionSchema.parse(outcome('intake_form.review_changed'));
    const review: ReviewPlan = { action: row.action, mutation, surfaceSuccessors };
    if (canonicalJsonSha256({ schemaVersion: 1, review, safeDiff: JSON.parse(row.safe_diff_json) }) !== wire.revisionDigestSha256 || !this.reviewReady(review)) return intakeFormVersionPublishContributionSchema.parse(outcome('intake_form.review_changed'));
    const catalog = this.input.repository.readFormCatalog(mutation.scope);
    if (!catalog) return intakeFormVersionPublishContributionSchema.parse(outcome('intake_form.review_changed'));
    const result = this.resultFor(mutation, catalog.version + 1);
    const contribution = intakeFormVersionPublishContributionSchema.parse({ result: { kind: 'success', data: result }, domain: { kind: 'intake_form_version_publish', draftId: wire.draftId, revisionId: wire.revisionId, revisionDigestSha256: wire.revisionDigestSha256, review }, effectContributions: [] });
    this.#prepared = { kind: 'publish', draftId: wire.draftId, revisionId: wire.revisionId, digest: wire.revisionDigestSha256, review, result, actorUserId: input.actorUserId, occurredAt: input.evaluatedAt };
    return contribution;
  }

  private reviewReady(review: ReviewPlan): boolean {
    const mutation = review.mutation;
    const catalog = this.input.repository.readFormCatalog(mutation.scope);
    const registry = this.input.repository.readFieldRegistrySnapshot(mutation.scope);
    if (!catalog || !registry) return false;
    const code = validateFormMutationPlan({ catalog, registry: fieldRegistrySnapshotSchema.parse(registry), plan: mutation, references: this.input.repository, existingVersions: this.input.repository.readFormVersions(mutation.scope, mutation.after.id) });
    return code === undefined && validateReleaseSurfaceSuccessorFrom(new SQLiteReleaseSurfaceSuccessorStore(this.input.sqlite), review.surfaceSuccessors).kind === 'ready';
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('intake_form_write_transaction_required');
    const prepared = this.#prepared;
    if (!prepared) throw new TypeError('intake_form_write_preparation_missing');
    if (prepared.kind === 'direct') {
      const parsed = intakeFormDirectContributionSchema.parse({ result: { kind: 'success', data: prepared.result }, domain: contribution, effectContributions: [] });
      if (parsed.result.kind !== 'success' || parsed.domain === null || canonicalJsonText(parsed.domain.plan) !== canonicalJsonText(prepared.plan)) throw new TypeError('intake_form_direct_preparation_invalid');
      this.applyMutation(prepared.plan, prepared.result);
    } else if (prepared.kind === 'review') {
      const parsed = intakeFormVersionReviewDraftContributionSchema.parse({ result: { kind: 'success', data: { schemaVersion: 1, action: prepared.review.action, draftId: prepared.draftId, status: 'draft', revision: { id: prepared.revisionId, number: 1, digestSha256: prepared.digest }, safeDiff: prepared.safeDiff } }, domain: contribution, effectContributions: [] });
      if (parsed.result.kind !== 'success' || parsed.domain === null || canonicalJsonText(parsed.domain.review) !== canonicalJsonText(prepared.review)) throw new TypeError('intake_form_review_preparation_invalid');
      this.insertReview(prepared);
    } else {
      const parsed = intakeFormVersionPublishContributionSchema.parse({ result: { kind: 'success', data: prepared.result }, domain: contribution, effectContributions: [] });
      if (parsed.result.kind !== 'success' || parsed.domain === null || canonicalJsonText(parsed.domain.review) !== canonicalJsonText(prepared.review)) throw new TypeError('intake_form_publish_preparation_invalid');
      this.applyMutation(prepared.review.mutation, prepared.result);
      const heads = new SQLiteReleaseSurfaceSuccessorStore(this.input.sqlite).applyReleaseSurfaceSuccessorPlan(prepared.review.surfaceSuccessors);
      if (canonicalJsonText(heads) !== canonicalJsonText(prepared.review.surfaceSuccessors.successors.map((value) => value.headAfter))) throw new TypeError('intake_form_surface_successor_apply_changed');
      const updated = this.input.sqlite.query<never, [string, number, string, string, string, string, string]>(`UPDATE intake_form_version_review_drafts SET status='published', published_by_user_id=?, published_at_ms=? WHERE workspace_id=? AND event_id=? AND id=? AND head_revision_id=? AND head_revision_digest_sha256=? AND status='draft'`).run(prepared.actorUserId, Date.parse(prepared.occurredAt), this.input.workspaceId, prepared.review.mutation.scope.eventId, prepared.draftId, prepared.revisionId, prepared.digest);
      if (updated.changes !== 1) throw new TypeError('intake_form_review_changed');
    }
    this.#prepared = undefined;
  }

  private applyMutation(plan: FormMutationPlan, expected: FormWriteResult): void {
    if (plan.action === 'create' && plan.deadlineContribution !== null) {
      const applied = this.input.repository.applyFormCloseDeadline(plan.deadlineContribution);
      if (canonicalJsonText(applied.pin) !== canonicalJsonText(plan.deadlinePin)) throw new TypeError('intake_form_deadline_apply_changed');
    } else if (plan.action === 'closing') {
      const applied = this.input.repository.applyFormCloseDeadline(plan.deadlineContribution);
      if (canonicalJsonText(applied.pin) !== canonicalJsonText(plan.deadlinePin)) throw new TypeError('intake_form_deadline_apply_changed');
    }
    const applied = this.input.repository.applyFormMutation(plan);
    if (applied.catalog.version !== expected.catalogVersion || applied.catalog.heads.find((value) => value.id === expected.formId)?.version !== expected.formDefinitionVersion) throw new TypeError('intake_form_apply_result_changed');
  }

  private insertReview(prepared: Extract<Prepared, { readonly kind: 'review' }>): void {
    this.input.sqlite.query<never, [string, string, string, string, string, string, string, number]>(`INSERT INTO intake_form_version_review_drafts (workspace_id,event_id,id,action,status,head_revision_id,head_revision_digest_sha256,authored_by_user_id,authored_at_ms) VALUES (?,?,?,?,'draft',?,?,?,?)`).run(this.input.workspaceId, prepared.review.mutation.scope.eventId, prepared.draftId, prepared.review.action, prepared.revisionId, prepared.digest, prepared.actorUserId, Date.parse(prepared.occurredAt));
    this.input.sqlite.query<never, [string, string, string, string, string, string, string, string, number]>(`INSERT INTO intake_form_version_review_revisions (workspace_id,event_id,draft_id,id,number,digest_sha256,review_json,safe_diff_json,authored_by_user_id,authored_at_ms) VALUES (?,?,?,?,1,?,?,?,?,?)`).run(this.input.workspaceId, prepared.review.mutation.scope.eventId, prepared.draftId, prepared.revisionId, prepared.digest, canonicalJsonText(prepared.review), canonicalJsonText(prepared.safeDiff), prepared.actorUserId, Date.parse(prepared.occurredAt));
  }

  private resultFor(plan: FormMutationPlan, catalogVersion: number): FormWriteResult {
    return { schemaVersion: 1, action: semanticAction(plan), formId: plan.after.id, formDefinitionVersion: plan.after.version, catalogVersion, publishedVersionId: plan.after.currentPublishedVersionId };
  }

  private nextId(method: keyof SQLiteIntakeFormWriteIds): string {
    const value = intakeIdSchema.parse(this.#ids[method]());
    if (this.#issuedIds.has(value)) throw new TypeError('intake_form_write_id_reused');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteIntakeFormWriteEffectDomainRegistrations(input: ConstructorParameters<typeof SQLiteIntakeFormWriteEffectDomainAdapter>[0]): readonly SQLiteEffectDomainAdapterRegistration[] {
  const adapter = new SQLiteIntakeFormWriteEffectDomainAdapter(input);
  return Object.freeze([
    Object.freeze({ capability: INTAKE_FORM_DIRECT_HANDLER_CAPABILITY, adapter }),
    Object.freeze({ capability: INTAKE_FORM_REVIEW_DRAFT_HANDLER_CAPABILITY, adapter }),
    Object.freeze({ capability: INTAKE_FORM_PUBLISH_HANDLER_CAPABILITY, adapter })
  ]);
}
