import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  programVocabularyMergeDraftRequestSchema,
  programVocabularyMergePublishInputSchema,
  programVocabularySafeDiffSchema,
  type ProgramVocabularyChangeResult,
  type ProgramVocabularyKind
} from '@jooevents/contracts';
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
  mergeReferenceCounts,
  parseProgramVocabularyMutationPlan,
  planProgramVocabularyMutation,
  ProgramVocabularyPlanningError,
  projectProgramVocabularySafeDiff,
  validateProgramVocabularyPlan,
  type ProgramMergePlan,
  type ProgramReferenceContributorRegistry
} from '@jooevents/program';
import {
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  PROGRAM_VOCABULARY_MANAGE_PERMISSION_ID,
  PROGRAM_VOCABULARY_MERGE_DRAFT_HANDLER_CAPABILITY,
  PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION,
  PROGRAM_VOCABULARY_MERGE_OPERATION,
  PROGRAM_VOCABULARY_MERGE_PUBLISH_HANDLER_CAPABILITY,
  programVocabularyMergeDraftContributionSchema,
  programVocabularyMergePublishContributionSchema,
  sealProgramVocabularyMergePreparation,
  type ProgramVocabularyMergeDraftContribution,
  type ProgramVocabularyMergePublishContribution
} from '@jooevents/program-operations';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import {
  SQLiteProgramVocabularyRepository,
  type SQLiteProgramVocabularyContributorAdapterRegistry
} from './program-vocabulary';

export const SQLITE_PROGRAM_VOCABULARY_MERGE_EFFECT_SQL = `
CREATE TABLE program_vocabulary_merge_drafts (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  status TEXT NOT NULL CHECK(status IN ('draft', 'published')),
  head_revision_id TEXT NOT NULL CHECK(length(head_revision_id) = 36),
  head_revision_digest_sha256 TEXT NOT NULL CHECK(
    length(head_revision_digest_sha256) = 64
    AND head_revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  published_by_user_id TEXT CHECK(
    published_by_user_id IS NULL OR length(published_by_user_id) = 36
  ),
  published_at_ms INTEGER CHECK(
    published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, id, head_revision_id, head_revision_digest_sha256),
  CHECK((status = 'published') = (published_by_user_id IS NOT NULL)),
  CHECK((published_by_user_id IS NULL) = (published_at_ms IS NULL)),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (published_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE program_vocabulary_merge_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  draft_id TEXT NOT NULL CHECK(length(draft_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number = 1),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_type(plan_json) = 'object'),
  safe_diff_json TEXT NOT NULL CHECK(
    json_valid(safe_diff_json) AND json_type(safe_diff_json) = 'object'
  ),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, draft_id, id),
  UNIQUE (workspace_id, event_id, draft_id, id, digest_sha256),
  FOREIGN KEY (workspace_id, event_id, draft_id)
    REFERENCES program_vocabulary_merge_drafts(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER program_vocabulary_merge_revisions_no_update
BEFORE UPDATE ON program_vocabulary_merge_revisions
BEGIN SELECT RAISE(ABORT, 'program vocabulary merge revisions are immutable'); END;
CREATE TRIGGER program_vocabulary_merge_revisions_no_delete
BEFORE DELETE ON program_vocabulary_merge_revisions
BEGIN SELECT RAISE(ABORT, 'program vocabulary merge revisions are immutable'); END;
CREATE TRIGGER program_vocabulary_merge_drafts_no_delete
BEFORE DELETE ON program_vocabulary_merge_drafts
BEGIN SELECT RAISE(ABORT, 'program vocabulary merge drafts are retained'); END;
`;

export function installProgramVocabularyMergeEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('program_vocabulary_merge_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_PROGRAM_VOCABULARY_MERGE_EFFECT_SQL)).immediate();
}

export interface SQLiteProgramVocabularyMergeIds {
  newDraftId(): string;
  newRevisionId(): string;
}

type DraftDomain = NonNullable<Extract<
  ProgramVocabularyMergeDraftContribution,
  { readonly result: { readonly kind: 'success' } }
>['domain']>;
type PublishDomain = NonNullable<Extract<
  ProgramVocabularyMergePublishContribution,
  { readonly result: { readonly kind: 'success' } }
>['domain']>;
type Prepared = {
  readonly kind: 'draft';
  readonly domain: DraftDomain;
  readonly actorUserId: UserId;
  readonly occurredAt: Instant;
  readonly plan: ProgramMergePlan;
} | {
  readonly kind: 'publish';
  readonly domain: PublishDomain;
  readonly actorUserId: UserId;
  readonly occurredAt: Instant;
  readonly plan: ProgramMergePlan;
};

interface RevisionRow {
  readonly status: 'draft' | 'published';
  readonly plan_json: string;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return context.scope.subjects.length === (eventId === undefined ? 1 : 2)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && (eventId === undefined || context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId
    ));
}

function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) {
    throw new TypeError(`program_vocabulary_merge_${label}_invalid`);
  }
  return value;
}

function mergeResult(plan: ProgramMergePlan): ProgramVocabularyChangeResult {
  const counts = mergeReferenceCounts(plan);
  return {
    action: 'merge',
    kind: plan.sourceBefore.kind,
    affectedIds: [plan.sourceBefore.id, plan.target.id],
    setVersion: plan.expectedSetVersion + 1,
    liveRepoints: counts.liveRepoints
  };
}

function outcome(kind: 'program_vocabulary.event_required' | 'program_vocabulary.merge_draft_changed') {
  return {
    result: {
      kind: 'outcome' as const,
      outcome: {
        class: 'conflict' as const, kind, retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: [] as const
  };
}

function refusal(input: {
  readonly error: ProgramVocabularyPlanningError;
  readonly kind: ProgramVocabularyKind;
  readonly ids: readonly string[];
}) {
  const stale = ['wrong_scope', 'stale_set', 'stale_item', 'stale_reference']
    .includes(input.error.code);
  return {
    result: {
      kind: 'outcome' as const,
      outcome: {
        class: stale ? 'stale_revision' as const : 'policy_violation' as const,
        kind: stale ? 'program_vocabulary.changed' : 'program_vocabulary.change_refused',
        retryable: false,
        subjects: input.ids.map((id) => ({ type: 'program_vocabulary', id })),
        detail: { code: input.error.code, action: 'merge', kind: input.kind, ids: input.ids },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: [] as const
  };
}

export class SQLiteProgramVocabularyMergeEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #ids: SQLiteProgramVocabularyMergeIds;
  readonly #issuedIds = new Set<string>();
  #prepared: Prepared | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly referenceRegistry: ProgramReferenceContributorRegistry;
    readonly contributors: SQLiteProgramVocabularyContributorAdapterRegistry;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteProgramVocabularyMergeIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    if (typeof input.ids.newDraftId !== 'function' || typeof input.ids.newRevisionId !== 'function') {
      throw new TypeError('program_vocabulary_merge_id_factory_invalid');
    }
    this.#ids = Object.freeze({
      newDraftId: input.ids.newDraftId.bind(input.ids),
      newRevisionId: input.ids.newRevisionId.bind(input.ids)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('program_vocabulary_merge_transaction_required');
    }
    const draft = sameRef(capability, PROGRAM_VOCABULARY_MERGE_DRAFT_HANDLER_CAPABILITY)
      && context.operation.name === PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION.name
      && context.operation.version === PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION.version
      && context.operation.effect === 'draft';
    const publish = sameRef(capability, PROGRAM_VOCABULARY_MERGE_PUBLISH_HANDLER_CAPABILITY)
      && context.operation.name === PROGRAM_VOCABULARY_MERGE_OPERATION.name
      && context.operation.version === PROGRAM_VOCABULARY_MERGE_OPERATION.version
      && context.operation.effect === 'commit';
    if ((!draft && !publish) || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId || !exactSubjects(context)) {
      throw new TypeError('program_vocabulary_merge_scope_mismatch');
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
        || !sameRef(authority.lane.policy, PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === PROGRAM_VOCABULARY_MANAGE_PERMISSION_ID
        )) {
      throw new TypeError('program_vocabulary_merge_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId !== undefined) {
      const relationship = this.input.eventRelationships.validateEvent({
        sqlite: this.input.sqlite, workspaceId: this.input.workspaceId,
        eventId, userId: actorUserId, evaluatedAt
      });
      if (relationship.kind !== 'valid' || current?.currentEvent?.id !== eventId) {
        throw new TypeError('program_vocabulary_merge_event_relationship_mismatch');
      }
    } else if (!current || current.currentEvent !== undefined) {
      throw new TypeError('program_vocabulary_merge_event_relationship_mismatch');
    }
    this.#prepared = undefined;
    return sealProgramVocabularyMergePreparation({
      capability,
      context,
      prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('program_vocabulary_merge_context_substitution');
        }
        if (eventId === undefined) {
          if (draft) programVocabularyMergeDraftRequestSchema.parse(businessInput);
          else programVocabularyMergePublishInputSchema.parse(businessInput);
          return outcome('program_vocabulary.event_required');
        }
        return draft
          ? this.prepareDraft({ businessInput, eventId, actorUserId, evaluatedAt })
          : this.preparePublish({ businessInput, eventId, actorUserId, evaluatedAt });
      }
    });
  }

  private repository(actorUserId: UserId, occurredAt: Instant) {
    return new SQLiteProgramVocabularyRepository(
      this.input.sqlite,
      this.input.referenceRegistry,
      this.input.contributors,
      () => ({ actorUserId, occurredAt })
    );
  }

  private prepareDraft(input: {
    readonly businessInput: unknown;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
  }) {
    const wire = programVocabularyMergeDraftRequestSchema.parse(input.businessInput);
    const repository = this.repository(input.actorUserId, input.evaluatedAt);
    const scope = { workspaceId: this.input.workspaceId, eventId: input.eventId };
    let plan: ProgramMergePlan;
    try {
      const state = repository.readVocabulary(scope);
      if (!state) throw new ProgramVocabularyPlanningError('wrong_scope');
      const candidate = planProgramVocabularyMutation({
        authorInput: { action: 'merge', scope, ...wire },
        state,
        referenceRegistry: this.input.referenceRegistry,
        referenceSource: repository
      });
      if (candidate.action !== 'merge') throw new TypeError('program_vocabulary_merge_plan_invalid');
      plan = candidate;
    } catch (error) {
      if (error instanceof ProgramVocabularyPlanningError) {
        return programVocabularyMergeDraftContributionSchema.parse(refusal({
          error, kind: wire.kind, ids: [wire.sourceId, wire.targetId]
        }));
      }
      throw error;
    }
    const draftId = this.nextId('newDraftId');
    const revisionId = this.nextId('newRevisionId');
    const safeDiff = programVocabularySafeDiffSchema.parse(projectProgramVocabularySafeDiff(plan));
    const revisionDigestSha256 = canonicalJsonSha256({ schemaVersion: 1, plan, safeDiff });
    const contribution = programVocabularyMergeDraftContributionSchema.parse({
      result: {
        kind: 'success',
        data: {
          schemaVersion: 1, action: 'merge', draftId, status: 'draft',
          revision: { id: revisionId, number: 1, digestSha256: revisionDigestSha256 },
          safeDiff
        }
      },
      domain: {
        kind: 'program_vocabulary_merge_review_draft',
        draftId, revisionId, revisionDigestSha256, plan, safeDiff
      },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) {
      throw new TypeError('program_vocabulary_merge_draft_contribution_invalid');
    }
    this.#prepared = {
      kind: 'draft', domain: contribution.domain,
      actorUserId: input.actorUserId, occurredAt: input.evaluatedAt, plan
    };
    return contribution;
  }

  private preparePublish(input: {
    readonly businessInput: unknown;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
  }) {
    const wire = programVocabularyMergePublishInputSchema.parse(input.businessInput);
    const row = this.input.sqlite.query<RevisionRow, [string, string, string, string, string]>(`
      SELECT d.status, r.plan_json
        FROM program_vocabulary_merge_drafts d
        JOIN program_vocabulary_merge_revisions r
          ON r.workspace_id = d.workspace_id AND r.event_id = d.event_id
         AND r.draft_id = d.id AND r.id = d.head_revision_id
         AND r.digest_sha256 = d.head_revision_digest_sha256
       WHERE d.workspace_id = ? AND d.event_id = ? AND d.id = ?
         AND r.id = ? AND r.digest_sha256 = ?
       LIMIT 2
    `).get(
      this.input.workspaceId, input.eventId, wire.draftId,
      wire.revisionId, wire.revisionDigestSha256
    );
    if (row === null || row.status !== 'draft') {
      return programVocabularyMergePublishContributionSchema.parse(
        outcome('program_vocabulary.merge_draft_changed')
      );
    }
    const parsed = parseProgramVocabularyMutationPlan(JSON.parse(row.plan_json));
    if (parsed.action !== 'merge') throw new TypeError('program_vocabulary_merge_revision_invalid');
    const plan = parsed;
    const repository = this.repository(input.actorUserId, input.evaluatedAt);
    const state = repository.readVocabulary(plan.scope);
    const code = state
      ? validateProgramVocabularyPlan(state, plan, this.input.referenceRegistry, repository)
      : 'wrong_scope';
    if (code) {
      return programVocabularyMergePublishContributionSchema.parse(refusal({
        error: new ProgramVocabularyPlanningError(code),
        kind: plan.sourceBefore.kind,
        ids: [plan.sourceBefore.id, plan.target.id]
      }));
    }
    const contribution = programVocabularyMergePublishContributionSchema.parse({
      result: { kind: 'success', data: mergeResult(plan) },
      domain: {
        kind: 'program_vocabulary_merge_publish',
        draftId: wire.draftId, revisionId: wire.revisionId,
        revisionDigestSha256: wire.revisionDigestSha256, plan
      },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) {
      throw new TypeError('program_vocabulary_merge_publish_contribution_invalid');
    }
    this.#prepared = {
      kind: 'publish', domain: contribution.domain,
      actorUserId: input.actorUserId, occurredAt: input.evaluatedAt, plan
    };
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('program_vocabulary_merge_transaction_required');
    }
    const prepared = this.#prepared;
    if (!prepared || canonicalJsonText(prepared.domain) !== canonicalJsonText(contribution)) {
      throw new TypeError('program_vocabulary_merge_preparation_invalid');
    }
    if (prepared.kind === 'draft') {
      const domain = programVocabularyMergeDraftContributionSchema.parse({
        result: {
          kind: 'success',
          data: {
            schemaVersion: 1, action: 'merge',
            draftId: prepared.domain.draftId, status: 'draft',
            revision: {
              id: prepared.domain.revisionId, number: 1,
              digestSha256: prepared.domain.revisionDigestSha256
            },
            safeDiff: prepared.domain.safeDiff
          }
        },
        domain: contribution,
        effectContributions: []
      });
      if (domain.result.kind !== 'success' || domain.domain === null) {
        throw new TypeError('program_vocabulary_merge_draft_apply_invalid');
      }
      const eventId = domain.domain.plan.scope.eventId;
      this.input.sqlite.query<never, [
        string, string, string, string, string, string, number
      ]>(`
        INSERT INTO program_vocabulary_merge_drafts (
          workspace_id, event_id, id, status, head_revision_id,
          head_revision_digest_sha256, authored_by_user_id, authored_at_ms,
          published_by_user_id, published_at_ms
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, NULL, NULL)
      `).run(
        this.input.workspaceId, eventId, domain.domain.draftId,
        domain.domain.revisionId, domain.domain.revisionDigestSha256,
        prepared.actorUserId, Date.parse(prepared.occurredAt)
      );
      this.input.sqlite.query<never, [
        string, string, string, string, string, string, string, string, number
      ]>(`
        INSERT INTO program_vocabulary_merge_revisions (
          workspace_id, event_id, draft_id, id, number, digest_sha256,
          plan_json, safe_diff_json, authored_by_user_id, authored_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        this.input.workspaceId, eventId, domain.domain.draftId, domain.domain.revisionId,
        domain.domain.revisionDigestSha256, canonicalJsonText(domain.domain.plan),
        canonicalJsonText(domain.domain.safeDiff), prepared.actorUserId,
        Date.parse(prepared.occurredAt)
      );
    } else {
      const domain = programVocabularyMergePublishContributionSchema.parse({
        result: { kind: 'success', data: mergeResult(prepared.plan) },
        domain: contribution,
        effectContributions: []
      });
      if (domain.result.kind !== 'success' || domain.domain === null) {
        throw new TypeError('program_vocabulary_merge_publish_apply_invalid');
      }
      const repository = this.repository(prepared.actorUserId, prepared.occurredAt);
      const applied = repository.applyVocabularyPlan(prepared.plan);
      if (canonicalJsonText(applied) !== canonicalJsonText(mergeResult(prepared.plan))) {
        throw new TypeError('program_vocabulary_merge_result_changed');
      }
      const updated = this.input.sqlite.query<never, [
        string, number, string, string, string, string, string
      ]>(`
        UPDATE program_vocabulary_merge_drafts
           SET status = 'published', published_by_user_id = ?, published_at_ms = ?
         WHERE workspace_id = ? AND event_id = ? AND id = ? AND status = 'draft'
           AND head_revision_id = ? AND head_revision_digest_sha256 = ?
      `).run(
        prepared.actorUserId, Date.parse(prepared.occurredAt), this.input.workspaceId,
        prepared.plan.scope.eventId, domain.domain.draftId,
        domain.domain.revisionId, domain.domain.revisionDigestSha256
      );
      if (updated.changes !== 1) throw new TypeError('program_vocabulary_merge_head_changed');
    }
    this.#prepared = undefined;
  }

  afterUnitOfWorkFinished(): void { this.#prepared = undefined; }

  private nextId(method: keyof SQLiteProgramVocabularyMergeIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('program_vocabulary_merge_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteProgramVocabularyMergeEffectDomainRegistrations(
  input: ConstructorParameters<typeof SQLiteProgramVocabularyMergeEffectDomainAdapter>[0]
): readonly [SQLiteEffectDomainAdapterRegistration, SQLiteEffectDomainAdapterRegistration] {
  const adapter = new SQLiteProgramVocabularyMergeEffectDomainAdapter(input);
  return Object.freeze([
    Object.freeze({ capability: PROGRAM_VOCABULARY_MERGE_DRAFT_HANDLER_CAPABILITY, adapter }),
    Object.freeze({ capability: PROGRAM_VOCABULARY_MERGE_PUBLISH_HANDLER_CAPABILITY, adapter })
  ]);
}
