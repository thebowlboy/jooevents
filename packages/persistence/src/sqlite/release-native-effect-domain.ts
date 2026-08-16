import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  releaseAuthorInputSchema,
  releaseMutationPlanSchema,
  releasePlanningInputSchema,
  releasePublishInputSchema,
  type ReleaseAuthorInput,
  type ReleaseMutationPlanDto,
  type ReleaseScopeDto
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
  planReleaseMutation,
  projectReleaseSafeDiff,
  releaseMutationResultFromPlan,
  ReleasePlanningError
} from '@jooevents/release';
import {
  RELEASE_CHANGE_DRAFT_OPERATION,
  RELEASE_DRAFT_ACCESS_POLICY,
  RELEASE_DRAFT_PERMISSION_ID,
  RELEASE_NATIVE_DRAFT_HANDLER_CAPABILITY,
  RELEASE_NATIVE_PUBLISH_HANDLER_CAPABILITY,
  RELEASE_PUBLISH_OPERATION,
  releaseNativeDraftContributionSchema,
  releaseNativePublishContributionSchema,
  sealReleaseNativePreparation
} from '@jooevents/release-operations';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteReleaseRepository, type SQLiteReleaseUpstreamSources } from './release';

/**
 * Feature-owned Release review state. A revision is inert and immutable; only
 * `release.publish@1` may move its draft head to `published` while applying the
 * exact reviewed plan in the same Foundation unit of work.
 */
export const SQLITE_RELEASE_NATIVE_EFFECT_SQL = `
CREATE TABLE release_review_drafts (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  action TEXT NOT NULL CHECK(action IN (
    'publish_schedule', 'program_rollback', 'style_set_publish',
    'surface_publish', 'surface_rollback', 'surface_allowlist'
  )),
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

CREATE TABLE release_review_revisions (
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
    REFERENCES release_review_drafts(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER release_review_revisions_no_update
BEFORE UPDATE ON release_review_revisions
BEGIN SELECT RAISE(ABORT, 'release review revisions are immutable'); END;
CREATE TRIGGER release_review_revisions_no_delete
BEFORE DELETE ON release_review_revisions
BEGIN SELECT RAISE(ABORT, 'release review revisions are immutable'); END;
CREATE TRIGGER release_review_drafts_no_delete
BEFORE DELETE ON release_review_drafts
BEGIN SELECT RAISE(ABORT, 'release review drafts are retained'); END;
`;

export function installReleaseNativeEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('release_native_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_RELEASE_NATIVE_EFFECT_SQL)).immediate();
}

export interface SQLiteReleaseNativeIds {
  newDraftId(): string;
  newRevisionId(): string;
  newReleaseId(): string;
}

const ID_METHODS = Object.freeze(['newDraftId', 'newRevisionId', 'newReleaseId'] as const);

type Prepared =
  | {
      readonly kind: 'draft';
      readonly domain: Extract<
        ReturnType<typeof releaseNativeDraftContributionSchema.parse>,
        { readonly result: { readonly kind: 'success' } }
      >['domain'];
      readonly actorUserId: UserId;
      readonly occurredAt: Instant;
    }
  | {
      readonly kind: 'publish';
      readonly domain: Extract<
        ReturnType<typeof releaseNativePublishContributionSchema.parse>,
        { readonly result: { readonly kind: 'success' } }
      >['domain'];
      readonly actorUserId: UserId;
      readonly occurredAt: Instant;
    };

interface RevisionRow {
  readonly status: 'draft' | 'published';
  readonly action: ReleaseAuthorInput['action'];
  readonly plan_json: string;
  readonly safe_diff_json: string;
}

function sameReference(
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
    throw new TypeError(`release_native_${label}_invalid`);
  }
  return value;
}

function outcome(
  kind: 'release.event_required' | 'release.draft_changed',
  outcomeClass: 'conflict' = 'conflict'
) {
  return {
    result: {
      kind: 'outcome' as const,
      outcome: {
        class: outcomeClass,
        kind,
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: [] as const
  };
}

function stale(error: ReleasePlanningError, action: ReleaseAuthorInput['action']) {
  return {
    result: {
      kind: 'outcome' as const,
      outcome: {
        class: 'stale_revision' as const,
        kind: 'release.changed',
        retryable: false,
        subjects: [],
        detail: { code: error.code, action, subjectId: null },
        detailSchemaVersion: 3
      }
    },
    domain: null,
    effectContributions: [] as const
  };
}

export class SQLiteReleaseNativeEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #ids: SQLiteReleaseNativeIds;
  readonly #issuedIds = new Set<string>();
  #prepared: Prepared | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly sources: SQLiteReleaseUpstreamSources;
    readonly ids: SQLiteReleaseNativeIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    for (const method of ID_METHODS) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('release_native_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      ID_METHODS.map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteReleaseNativeIds);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('release_native_transaction_required');
    const draft = sameReference(capability, RELEASE_NATIVE_DRAFT_HANDLER_CAPABILITY)
      && context.operation.name === RELEASE_CHANGE_DRAFT_OPERATION.name
      && context.operation.version === RELEASE_CHANGE_DRAFT_OPERATION.version
      && context.operation.effect === 'draft';
    const publish = sameReference(capability, RELEASE_NATIVE_PUBLISH_HANDLER_CAPABILITY)
      && context.operation.name === RELEASE_PUBLISH_OPERATION.name
      && context.operation.version === RELEASE_PUBLISH_OPERATION.version
      && context.operation.effect === 'commit';
    if ((!draft && !publish) || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId || !exactSubjects(context)) {
      throw new TypeError('release_native_scope_mismatch');
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
        || !sameReference(authority.lane.policy, RELEASE_DRAFT_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === RELEASE_DRAFT_PERMISSION_ID
        )) {
      throw new TypeError('release_native_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId !== undefined) {
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
        throw new TypeError('release_native_event_relationship_mismatch');
      }
    } else if (!current || current.currentEvent !== undefined) {
      throw new TypeError('release_native_event_relationship_mismatch');
    }
    this.#prepared = undefined;
    return sealReleaseNativePreparation({
      capability,
      context,
      prepare: ({ businessInput, context: receivedContext }) => {
        if (receivedContext !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('release_native_context_substitution');
        }
        if (eventId === undefined) {
          if (draft) releaseAuthorInputSchema.parse(businessInput);
          else releasePublishInputSchema.parse(businessInput);
          return outcome('release.event_required');
        }
        return draft
          ? this.prepareDraft({ businessInput, context, eventId, actorUserId, evaluatedAt })
          : this.preparePublish({ businessInput, context, eventId, actorUserId, evaluatedAt });
      }
    });
  }

  private prepareDraft(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
  }) {
    const wire = releaseAuthorInputSchema.parse(input.businessInput);
    const draftId = this.nextId('newDraftId');
    const revisionId = this.nextId('newRevisionId');
    const scope: ReleaseScopeDto = { workspaceId: this.input.workspaceId, eventId: input.eventId };
    const planningInput = releasePlanningInputSchema.parse({
      ...wire,
      scope,
      actorUserId: input.actorUserId,
      occurredAt: input.evaluatedAt,
      ...(
        wire.action === 'surface_rollback' || wire.action === 'surface_allowlist'
          ? {}
          : { releaseId: this.nextId('newReleaseId') }
      )
    });
    const repository = new SQLiteReleaseRepository(this.input.sqlite, this.input.sources);
    let plan: ReleaseMutationPlanDto;
    try {
      plan = planReleaseMutation({ planningInput, port: repository });
    } catch (error) {
      if (error instanceof ReleasePlanningError) {
        return releaseNativeDraftContributionSchema.parse(stale(error, wire.action));
      }
      throw error;
    }
    const safeDiff = projectReleaseSafeDiff(plan);
    const revisionDigestSha256 = canonicalJsonSha256({ schemaVersion: 1, plan, safeDiff });
    const contribution = releaseNativeDraftContributionSchema.parse({
      result: {
        kind: 'success',
        data: {
          schemaVersion: 1,
          action: wire.action,
          draftId,
          status: 'draft',
          revision: { id: revisionId, number: 1, digestSha256: revisionDigestSha256 },
          safeDiff
        }
      },
      domain: {
        kind: 'release_review_draft',
        draftId,
        revisionId,
        revisionDigestSha256,
        plan,
        safeDiff
      },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) {
      throw new TypeError('release_native_draft_contribution_invalid');
    }
    this.#prepared = {
      kind: 'draft', domain: contribution.domain,
      actorUserId: input.actorUserId, occurredAt: input.evaluatedAt
    };
    return contribution;
  }

  private preparePublish(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
  }) {
    const wire = releasePublishInputSchema.parse(input.businessInput);
    const row = this.input.sqlite.query<RevisionRow, [string, string, string, string, string]>(`
      SELECT d.status, d.action, r.plan_json, r.safe_diff_json
        FROM release_review_drafts d
        JOIN release_review_revisions r
          ON r.workspace_id = d.workspace_id
         AND r.event_id = d.event_id
         AND r.draft_id = d.id
         AND r.id = d.head_revision_id
         AND r.digest_sha256 = d.head_revision_digest_sha256
       WHERE d.workspace_id = ? AND d.event_id = ? AND d.id = ?
         AND r.id = ? AND r.digest_sha256 = ?
       LIMIT 2
    `).get(
      this.input.workspaceId, input.eventId, wire.draftId,
      wire.revisionId, wire.revisionDigestSha256
    );
    if (row === null || row.status !== 'draft') {
      return releaseNativePublishContributionSchema.parse(outcome('release.draft_changed'));
    }
    const plan = releaseMutationPlanSchema.parse(JSON.parse(row.plan_json));
    const repository = new SQLiteReleaseRepository(this.input.sqlite, this.input.sources);
    const refusal = (() => {
      try {
        return planReleaseMutation({ planningInput: plan.input, port: repository });
      } catch (error) {
        if (error instanceof ReleasePlanningError) return error;
        throw error;
      }
    })();
    if (refusal instanceof ReleasePlanningError) {
      return releaseNativePublishContributionSchema.parse(stale(refusal, row.action));
    }
    if (canonicalJsonText(refusal) !== canonicalJsonText(plan)) {
      return releaseNativePublishContributionSchema.parse(stale(
        new ReleasePlanningError('invalid_plan'), row.action
      ));
    }
    const contribution = releaseNativePublishContributionSchema.parse({
      result: { kind: 'success', data: releaseMutationResultFromPlan(plan) },
      domain: {
        kind: 'release_review_publish',
        draftId: wire.draftId,
        revisionId: wire.revisionId,
        revisionDigestSha256: wire.revisionDigestSha256,
        plan
      },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) {
      throw new TypeError('release_native_publish_contribution_invalid');
    }
    this.#prepared = {
      kind: 'publish', domain: contribution.domain,
      actorUserId: input.actorUserId, occurredAt: input.evaluatedAt
    };
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('release_native_transaction_required');
    const prepared = this.#prepared;
    if (!prepared || canonicalJsonText(prepared.domain) !== canonicalJsonText(contribution)) {
      throw new TypeError('release_native_preparation_invalid');
    }
    if (prepared.kind === 'draft') {
      const domain = releaseNativeDraftContributionSchema.parse({
        result: {
          kind: 'success',
          data: {
            schemaVersion: 1,
            action: prepared.domain.plan.input.action,
            draftId: prepared.domain.draftId,
            status: 'draft',
            revision: {
              id: prepared.domain.revisionId,
              number: 1,
              digestSha256: prepared.domain.revisionDigestSha256
            },
            safeDiff: prepared.domain.safeDiff
          }
        },
        domain: contribution,
        effectContributions: []
      });
      if (domain.result.kind !== 'success' || domain.domain === null) {
        throw new TypeError('release_native_draft_apply_invalid');
      }
      this.input.sqlite.query<never, [
        string, string, string, string, string, string, string, number
      ]>(`
        INSERT INTO release_review_drafts (
          workspace_id, event_id, id, action, status,
          head_revision_id, head_revision_digest_sha256,
          authored_by_user_id, authored_at_ms, published_by_user_id, published_at_ms
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL, NULL)
      `).run(
        this.input.workspaceId, domain.domain.plan.input.scope.eventId,
        domain.domain.draftId, domain.domain.plan.input.action,
        domain.domain.revisionId, domain.domain.revisionDigestSha256,
        prepared.actorUserId, Date.parse(prepared.occurredAt)
      );
      this.input.sqlite.query<never, [string, string, string, string, string, string, string, string, number]>(`
        INSERT INTO release_review_revisions (
          workspace_id, event_id, draft_id, id, number, digest_sha256,
          plan_json, safe_diff_json, authored_by_user_id, authored_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        this.input.workspaceId, domain.domain.plan.input.scope.eventId,
        domain.domain.draftId, domain.domain.revisionId,
        domain.domain.revisionDigestSha256, canonicalJsonText(domain.domain.plan),
        canonicalJsonText(domain.domain.safeDiff), prepared.actorUserId,
        Date.parse(prepared.occurredAt)
      );
    } else {
      const domain = releaseNativePublishContributionSchema.parse({
        result: { kind: 'success', data: releaseMutationResultFromPlan(prepared.domain.plan) },
        domain: contribution,
        effectContributions: []
      });
      if (domain.result.kind !== 'success' || domain.domain === null) {
        throw new TypeError('release_native_publish_apply_invalid');
      }
      const repository = new SQLiteReleaseRepository(this.input.sqlite, this.input.sources);
      repository.applyReleasePlan(domain.domain.plan);
      const updated = this.input.sqlite.query<never, [string, number, string, string, string, string, string]>(`
        UPDATE release_review_drafts
           SET status = 'published', published_by_user_id = ?, published_at_ms = ?
         WHERE workspace_id = ? AND event_id = ? AND id = ?
           AND status = 'draft' AND head_revision_id = ?
           AND head_revision_digest_sha256 = ?
      `).run(
        prepared.actorUserId, Date.parse(prepared.occurredAt), this.input.workspaceId,
        domain.domain.plan.input.scope.eventId, domain.domain.draftId,
        domain.domain.revisionId, domain.domain.revisionDigestSha256
      );
      if (updated.changes !== 1) throw new TypeError('release_native_publish_head_changed');
    }
    this.#prepared = undefined;
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared = undefined;
  }

  private nextId(method: keyof SQLiteReleaseNativeIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('release_native_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteReleaseNativeEffectDomainRegistrations(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly sources: SQLiteReleaseUpstreamSources;
  readonly ids: SQLiteReleaseNativeIds;
}): readonly [SQLiteEffectDomainAdapterRegistration, SQLiteEffectDomainAdapterRegistration] {
  const adapter = new SQLiteReleaseNativeEffectDomainAdapter(input);
  return Object.freeze([
    Object.freeze({ capability: RELEASE_NATIVE_DRAFT_HANDLER_CAPABILITY, adapter }),
    Object.freeze({ capability: RELEASE_NATIVE_PUBLISH_HANDLER_CAPABILITY, adapter })
  ]);
}
