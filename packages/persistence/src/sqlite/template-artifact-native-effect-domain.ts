import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  templateArtifactMutationInputSchema,
  templateArtifactMutationPlanSchema,
  templateArtifactPublishInputSchema,
  templateArtifactSafeDiffSchema,
  type TemplateArtifactMutationPlanDto,
  type TemplateArtifactSafeDiffDto,
  type TemplateArtifactScopeDto
} from '@jooevents/contracts';
import { EVENT_MANAGE_ACCESS_POLICY } from '@jooevents/event-operations';
import {
  canonicalJsonSha256,
  canonicalJsonText,
  isApplicationId,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  TemplateArtifactPlanningError,
  planTemplateArtifactMutation,
  validateTemplateArtifactMutation
} from '@jooevents/template-authoring';
import {
  TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
  TEMPLATE_ARTIFACT_NATIVE_DRAFT_HANDLER_CAPABILITY,
  TEMPLATE_ARTIFACT_NATIVE_PUBLISH_HANDLER_CAPABILITY,
  TEMPLATE_ARTIFACT_PUBLISH_OPERATION,
  sealTemplateArtifactNativePreparation,
  templateArtifactNativeDraftContributionSchema,
  templateArtifactNativePublishContributionSchema
} from '@jooevents/template-authoring-operations';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteTemplateAuthoringRepository } from './template-authoring';

export const SQLITE_TEMPLATE_ARTIFACT_NATIVE_EFFECT_SQL = `
CREATE TABLE template_artifact_review_drafts (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  artifact_id TEXT NOT NULL CHECK(length(artifact_id) = 36),
  action TEXT NOT NULL CHECK(action IN ('replace','revert')),
  status TEXT NOT NULL CHECK(status IN ('draft','published')),
  head_revision_id TEXT NOT NULL CHECK(length(head_revision_id) = 36),
  head_revision_digest_sha256 TEXT NOT NULL CHECK(length(head_revision_digest_sha256) = 64 AND head_revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  published_by_user_id TEXT CHECK(published_by_user_id IS NULL OR length(published_by_user_id) = 36),
  published_at_ms INTEGER CHECK(published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,id),
  UNIQUE(workspace_id,event_id,id,head_revision_id,head_revision_digest_sha256),
  CHECK((status = 'published') = (published_by_user_id IS NOT NULL)),
  CHECK((published_by_user_id IS NULL) = (published_at_ms IS NULL)),
  FOREIGN KEY(workspace_id,event_id,artifact_id) REFERENCES template_artifact_heads(workspace_id,event_id,artifact_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(authored_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(published_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE template_artifact_review_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  draft_id TEXT NOT NULL CHECK(length(draft_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number = 1),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_type(plan_json) = 'object'),
  safe_diff_json TEXT NOT NULL CHECK(json_valid(safe_diff_json) AND json_type(safe_diff_json) = 'object'),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,draft_id,id),
  UNIQUE(workspace_id,event_id,draft_id,id,digest_sha256),
  FOREIGN KEY(workspace_id,event_id,draft_id) REFERENCES template_artifact_review_drafts(workspace_id,event_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(authored_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER template_artifact_review_revisions_no_update BEFORE UPDATE ON template_artifact_review_revisions BEGIN SELECT RAISE(ABORT, 'template artifact review revisions are immutable'); END;
CREATE TRIGGER template_artifact_review_revisions_no_delete BEFORE DELETE ON template_artifact_review_revisions BEGIN SELECT RAISE(ABORT, 'template artifact review revisions are immutable'); END;
CREATE TRIGGER template_artifact_review_drafts_no_delete BEFORE DELETE ON template_artifact_review_drafts BEGIN SELECT RAISE(ABORT, 'template artifact review drafts are retained'); END;
`;

export interface SQLiteTemplateArtifactNativeIds {
  newDraftId(): string;
  newRevisionId(): string;
  newArtifactRevisionId(): string;
}

type Prepared =
  | { readonly kind: 'draft'; readonly domain: Extract<ReturnType<typeof templateArtifactNativeDraftContributionSchema.parse>, { readonly result: { readonly kind: 'success' } }>['domain']; readonly actorUserId: UserId; readonly occurredAt: Instant }
  | { readonly kind: 'publish'; readonly domain: Extract<ReturnType<typeof templateArtifactNativePublishContributionSchema.parse>, { readonly result: { readonly kind: 'success' } }>['domain']; readonly actorUserId: UserId; readonly occurredAt: Instant };

interface RevisionRow {
  readonly status: 'draft' | 'published';
  readonly action: 'replace' | 'revert';
  readonly plan_json: string;
  readonly safe_diff_json: string;
}

function sameReference(left: { readonly key: string; readonly version: number }, right: { readonly key: string; readonly version: number }): boolean {
  return left.key === right.key && left.version === right.version;
}
function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) throw new TypeError(`template_artifact_native_${label}_invalid`);
  return value;
}
function projectSafeDiff(plan: TemplateArtifactMutationPlanDto): TemplateArtifactSafeDiffDto {
  return templateArtifactSafeDiffSchema.parse({ action: plan.action, artifactId: plan.artifactId, artifactKind: plan.before.document.kind, before: plan.before, after: plan.after, restoredFromRevisionNumber: plan.restoredFromRevisionNumber });
}
function outcome(kind: 'template.artifact.event_required' | 'template.artifact.draft_changed') {
  return { result: { kind: 'outcome' as const, outcome: { class: 'conflict' as const, kind, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } }, domain: null, effectContributions: [] as const };
}
function stale(error: TemplateArtifactPlanningError, action: 'replace' | 'revert', artifactId: string) {
  return { result: { kind: 'outcome' as const, outcome: { class: 'stale_revision' as const, kind: 'template.artifact_changed', retryable: false, subjects: [], detail: { code: error.code, action, artifactId }, detailSchemaVersion: 1 } }, domain: null, effectContributions: [] as const };
}

export class SQLiteTemplateArtifactNativeEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #ids: SQLiteTemplateArtifactNativeIds;
  readonly #issuedIds = new Set<string>();
  #prepared: Prepared | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteTemplateArtifactNativeIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#ids = Object.freeze({
      newDraftId: input.ids.newDraftId.bind(input.ids),
      newRevisionId: input.ids.newRevisionId.bind(input.ids),
      newArtifactRevisionId: input.ids.newArtifactRevisionId.bind(input.ids)
    });
  }

  openHandlerSnapshot(capability: { readonly key: string; readonly version: number }, context: EffectInvocationContext, authorityRecheck: SealedEffectAuthorityRecheckResult): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('template_artifact_native_transaction_required');
    const draft = sameReference(capability, TEMPLATE_ARTIFACT_NATIVE_DRAFT_HANDLER_CAPABILITY)
      && context.operation.name === TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION.name
      && context.operation.version === 1 && context.operation.effect === 'draft';
    const publish = sameReference(capability, TEMPLATE_ARTIFACT_NATIVE_PUBLISH_HANDLER_CAPABILITY)
      && context.operation.name === TEMPLATE_ARTIFACT_PUBLISH_OPERATION.name
      && context.operation.version === 1 && context.operation.effect === 'commit';
    if ((!draft && !publish) || context.surface !== 'operator_http' || context.scope.workspaceId !== this.input.workspaceId) throw new TypeError('template_artifact_native_scope_mismatch');
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user' || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http' || !sameReference(authority.lane.policy, EVENT_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) => grant.kind === 'permission' && grant.key === 'event.manage')) throw new TypeError('template_artifact_native_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite).readCurrentEventState(this.input.workspaceId);
    if (eventId !== undefined) {
      const relationship = this.input.eventRelationships.validateEvent({ sqlite: this.input.sqlite, workspaceId: this.input.workspaceId, eventId, userId: actorUserId, evaluatedAt });
      if (relationship.kind !== 'valid' || current?.currentEvent?.id !== eventId) throw new TypeError('template_artifact_native_event_relationship_mismatch');
    } else if (!current || current.currentEvent !== undefined) throw new TypeError('template_artifact_native_event_relationship_mismatch');
    this.#prepared = undefined;
    return sealTemplateArtifactNativePreparation({ capability, context, prepare: ({ businessInput, context: received }) => {
      if (received !== context || !this.input.sqlite.inTransaction) throw new TypeError('template_artifact_native_context_substitution');
      if (eventId === undefined) {
        if (draft) templateArtifactMutationInputSchema.parse(businessInput); else templateArtifactPublishInputSchema.parse(businessInput);
        return outcome('template.artifact.event_required');
      }
      return draft
        ? this.prepareDraft({ businessInput, eventId, actorUserId, evaluatedAt })
        : this.preparePublish({ businessInput, eventId, actorUserId, evaluatedAt });
    } });
  }

  private prepareDraft(input: { readonly businessInput: unknown; readonly eventId: EventId; readonly actorUserId: UserId; readonly evaluatedAt: Instant }) {
    const wire = templateArtifactMutationInputSchema.parse(input.businessInput);
    const scope: TemplateArtifactScopeDto = { workspaceId: this.input.workspaceId, eventId: input.eventId };
    const repository = new SQLiteTemplateAuthoringRepository(this.input.sqlite);
    const current = repository.readArtifact(scope, wire.artifactId);
    if (!current) return templateArtifactNativeDraftContributionSchema.parse(stale(new TemplateArtifactPlanningError('artifact_missing'), wire.action, wire.artifactId));
    let plan: TemplateArtifactMutationPlanDto;
    try {
      plan = planTemplateArtifactMutation({ scope, current, mutation: wire, revisionId: this.nextId('newArtifactRevisionId'), actorUserId: input.actorUserId, occurredAt: input.evaluatedAt });
    } catch (error) {
      if (error instanceof TemplateArtifactPlanningError) return templateArtifactNativeDraftContributionSchema.parse(stale(error, wire.action, wire.artifactId));
      throw error;
    }
    const safeDiff = projectSafeDiff(plan);
    const draftId = this.nextId('newDraftId');
    const revisionId = this.nextId('newRevisionId');
    const revisionDigestSha256 = canonicalJsonSha256({ schemaVersion: 1, plan, safeDiff });
    const contribution = templateArtifactNativeDraftContributionSchema.parse({
      result: { kind: 'success', data: { schemaVersion: 1, action: wire.action, draftId, status: 'draft', revision: { id: revisionId, number: 1, digestSha256: revisionDigestSha256 }, safeDiff } },
      domain: { kind: 'template_artifact_review_draft', draftId, revisionId, revisionDigestSha256, plan, safeDiff },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) throw new TypeError('template_artifact_native_draft_contribution_invalid');
    this.#prepared = { kind: 'draft', domain: contribution.domain, actorUserId: input.actorUserId, occurredAt: input.evaluatedAt };
    return contribution;
  }

  private preparePublish(input: { readonly businessInput: unknown; readonly eventId: EventId; readonly actorUserId: UserId; readonly evaluatedAt: Instant }) {
    const wire = templateArtifactPublishInputSchema.parse(input.businessInput);
    const row = this.input.sqlite.query<RevisionRow, [string, string, string, string, string]>(`
      SELECT d.status,d.action,r.plan_json,r.safe_diff_json
        FROM template_artifact_review_drafts d JOIN template_artifact_review_revisions r
          ON r.workspace_id=d.workspace_id AND r.event_id=d.event_id AND r.draft_id=d.id
         AND r.id=d.head_revision_id AND r.digest_sha256=d.head_revision_digest_sha256
       WHERE d.workspace_id=? AND d.event_id=? AND d.id=? AND r.id=? AND r.digest_sha256=? LIMIT 2
    `).get(this.input.workspaceId, input.eventId, wire.draftId, wire.revisionId, wire.revisionDigestSha256);
    if (!row || row.status !== 'draft') return templateArtifactNativePublishContributionSchema.parse(outcome('template.artifact.draft_changed'));
    const plan = templateArtifactMutationPlanSchema.parse(JSON.parse(row.plan_json));
    const safeDiff = templateArtifactSafeDiffSchema.parse(JSON.parse(row.safe_diff_json));
    const repository = new SQLiteTemplateAuthoringRepository(this.input.sqlite);
    const issue = validateTemplateArtifactMutation({ plan, read: repository });
    if (issue) return templateArtifactNativePublishContributionSchema.parse(stale(new TemplateArtifactPlanningError(issue), row.action, plan.artifactId));
    const contribution = templateArtifactNativePublishContributionSchema.parse({
      result: { kind: 'success', data: { schemaVersion: 1, action: plan.action, revision: plan.after, safeDiff } },
      domain: { kind: 'template_artifact_review_publish', draftId: wire.draftId, revisionId: wire.revisionId, revisionDigestSha256: wire.revisionDigestSha256, plan, safeDiff },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) throw new TypeError('template_artifact_native_publish_contribution_invalid');
    this.#prepared = { kind: 'publish', domain: contribution.domain, actorUserId: input.actorUserId, occurredAt: input.evaluatedAt };
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction || !this.#prepared) throw new TypeError('template_artifact_native_preparation_missing');
    const prepared = this.#prepared;
    if (prepared.kind === 'draft') {
      const parsed = templateArtifactNativeDraftContributionSchema.parse({ result: { kind: 'success', data: { schemaVersion: 1, action: prepared.domain.plan.action, draftId: prepared.domain.draftId, status: 'draft', revision: { id: prepared.domain.revisionId, number: 1, digestSha256: prepared.domain.revisionDigestSha256 }, safeDiff: prepared.domain.safeDiff } }, domain: contribution, effectContributions: [] });
      if (parsed.result.kind !== 'success' || parsed.domain === null || canonicalJsonText(parsed.domain) !== canonicalJsonText(prepared.domain)) throw new TypeError('template_artifact_native_draft_preparation_invalid');
      this.input.sqlite.query(`INSERT INTO template_artifact_review_drafts (workspace_id,event_id,id,artifact_id,action,status,head_revision_id,head_revision_digest_sha256,authored_by_user_id,authored_at_ms,published_by_user_id,published_at_ms) VALUES (?,?,?,?,?,'draft',?,?,?,?,NULL,NULL)`).run(this.input.workspaceId, prepared.domain.plan.scope.eventId, prepared.domain.draftId, prepared.domain.plan.artifactId, prepared.domain.plan.action, prepared.domain.revisionId, prepared.domain.revisionDigestSha256, prepared.actorUserId, Date.parse(prepared.occurredAt));
      this.input.sqlite.query(`INSERT INTO template_artifact_review_revisions (workspace_id,event_id,draft_id,id,number,digest_sha256,plan_json,safe_diff_json,authored_by_user_id,authored_at_ms) VALUES (?,?,?,?,1,?,?,?,?,?)`).run(this.input.workspaceId, prepared.domain.plan.scope.eventId, prepared.domain.draftId, prepared.domain.revisionId, prepared.domain.revisionDigestSha256, canonicalJsonText(prepared.domain.plan), canonicalJsonText(prepared.domain.safeDiff), prepared.actorUserId, Date.parse(prepared.occurredAt));
      return;
    }
    const parsed = templateArtifactNativePublishContributionSchema.parse({ result: { kind: 'success', data: { schemaVersion: 1, action: prepared.domain.plan.action, revision: prepared.domain.plan.after, safeDiff: prepared.domain.safeDiff } }, domain: contribution, effectContributions: [] });
    if (parsed.result.kind !== 'success' || parsed.domain === null || canonicalJsonText(parsed.domain) !== canonicalJsonText(prepared.domain)) throw new TypeError('template_artifact_native_publish_preparation_invalid');
    const repository = new SQLiteTemplateAuthoringRepository(this.input.sqlite);
    repository.applyMutation(prepared.domain.plan);
    const update = this.input.sqlite.query(`UPDATE template_artifact_review_drafts SET status='published',published_by_user_id=?,published_at_ms=? WHERE workspace_id=? AND event_id=? AND id=? AND status='draft' AND head_revision_id=? AND head_revision_digest_sha256=?`).run(prepared.actorUserId, Date.parse(prepared.occurredAt), this.input.workspaceId, prepared.domain.plan.scope.eventId, prepared.domain.draftId, prepared.domain.revisionId, prepared.domain.revisionDigestSha256);
    if (update.changes !== 1) throw new TypeError('template_artifact_native_publish_race');
  }

  private nextId(method: keyof SQLiteTemplateArtifactNativeIds): string {
    const id = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(id)) throw new TypeError('template_artifact_native_ids_not_unique');
    this.#issuedIds.add(id);
    return id;
  }
}

export function createSQLiteTemplateArtifactNativeEffectDomainRegistration(input: ConstructorParameters<typeof SQLiteTemplateArtifactNativeEffectDomainAdapter>[0]): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({ capability: TEMPLATE_ARTIFACT_NATIVE_DRAFT_HANDLER_CAPABILITY, adapter: new SQLiteTemplateArtifactNativeEffectDomainAdapter(input) });
}

export function createSQLiteTemplateArtifactNativeEffectDomainRegistrations(input: ConstructorParameters<typeof SQLiteTemplateArtifactNativeEffectDomainAdapter>[0]): readonly SQLiteEffectDomainAdapterRegistration[] {
  const adapter = new SQLiteTemplateArtifactNativeEffectDomainAdapter(input);
  return Object.freeze([
    Object.freeze({ capability: TEMPLATE_ARTIFACT_NATIVE_DRAFT_HANDLER_CAPABILITY, adapter }),
    Object.freeze({ capability: TEMPLATE_ARTIFACT_NATIVE_PUBLISH_HANDLER_CAPABILITY, adapter })
  ]);
}
