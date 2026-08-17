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
  type TemplateArtifactScopeDto,
  type TemplateArtifactSnapshotDto
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
  parseTemplateArtifactRevision,
  parseTemplateArtifactSnapshot,
  planTemplateArtifactMutation,
  validateTemplateArtifactMutation,
  type TemplateArtifactReadPort
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
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

interface EventSetRow { readonly version: number; readonly current_event_id: string | null }
interface EventHeadRow { readonly version: number }
interface HeadRow {
  readonly artifact_id: string;
  readonly artifact_kind: 'message' | 'surface' | 'theme';
  readonly current_revision_id: string;
  readonly current_revision_number: number;
  readonly version: number;
}
interface RevisionRow {
  readonly artifact_id: string;
  readonly revision_id: string;
  readonly revision_number: number;
  readonly digest_sha256: string;
  readonly revision_json: string;
}
interface ReviewDraftRow {
  readonly status: 'draft' | 'published';
  readonly action: 'replace' | 'revert';
  readonly artifact_id: string;
  readonly head_revision_id: string;
  readonly head_revision_digest_sha256: string;
  readonly plan_json: string;
  readonly safe_diff_json: string;
}

type D1ReadSource = Pick<D1Database, 'prepare' | 'batch'>
  | Pick<D1DatabaseSession, 'prepare' | 'batch'>;

interface ArtifactRecord {
  readonly snapshot: TemplateArtifactSnapshotDto;
  readonly currentRevisionJson: string;
}

interface ReviewDraftRecord {
  readonly row: ReviewDraftRow;
  readonly plan: TemplateArtifactMutationPlanDto;
  readonly safeDiff: TemplateArtifactSafeDiffDto;
}

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameScope(left: TemplateArtifactScopeDto, right: TemplateArtifactScopeDto): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) {
    throw new TypeError(`d1_template_artifact_${label}_invalid`);
  }
  return value;
}

function requestTarget(context: EffectInvocationContext, prefix: string): string {
  const values = context.scope.resolutionEvidenceIds
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
  if (values.length !== 1) throw new TypeError('d1_template_artifact_request_target_missing');
  return applicationId(values[0], 'request_target');
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  if (eventId === undefined) {
    return context.scope.subjects.length === 1
      && context.scope.subjects[0]?.kind === 'workspace'
      && context.scope.subjects[0].id === context.scope.workspaceId;
  }
  return context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId);
}

async function readD1TemplateArtifactRecords(
  source: D1ReadSource,
  scope: TemplateArtifactScopeDto,
  artifactId?: string
): Promise<readonly ArtifactRecord[]> {
  const headSql = artifactId === undefined
    ? `SELECT artifact_id,artifact_kind,current_revision_id,current_revision_number,version
       FROM template_artifact_heads WHERE workspace_id = ? AND event_id = ?
       ORDER BY artifact_kind COLLATE BINARY,artifact_id COLLATE BINARY`
    : `SELECT artifact_id,artifact_kind,current_revision_id,current_revision_number,version
       FROM template_artifact_heads
       WHERE workspace_id = ? AND event_id = ? AND artifact_id = ? LIMIT 2`;
  const revisionSql = artifactId === undefined
    ? `SELECT artifact_id,revision_id,revision_number,digest_sha256,revision_json
       FROM template_artifact_revisions WHERE workspace_id = ? AND event_id = ?
       ORDER BY artifact_id COLLATE BINARY,revision_number`
    : `SELECT artifact_id,revision_id,revision_number,digest_sha256,revision_json
       FROM template_artifact_revisions
       WHERE workspace_id = ? AND event_id = ? AND artifact_id = ?
       ORDER BY revision_number`;
  const bindings = artifactId === undefined
    ? [scope.workspaceId, scope.eventId]
    : [scope.workspaceId, scope.eventId, artifactId];
  const [headResult, revisionResult] = await source.batch([
    source.prepare(headSql).bind(...bindings),
    source.prepare(revisionSql).bind(...bindings)
  ]);
  const heads = (headResult as D1Result<HeadRow>).results;
  const revisions = (revisionResult as D1Result<RevisionRow>).results;
  if (artifactId !== undefined && heads.length > 1) {
    throw new TypeError('d1_template_artifact_head_not_unique');
  }
  const revisionsByArtifact = new Map<string, RevisionRow[]>();
  for (const row of revisions) {
    const group = revisionsByArtifact.get(row.artifact_id);
    if (group) group.push(row);
    else revisionsByArtifact.set(row.artifact_id, [row]);
  }
  const records = heads.map((head) => {
    const rows = revisionsByArtifact.get(head.artifact_id) ?? [];
    const history = rows.map((row) => {
      const revision = parseTemplateArtifactRevision(JSON.parse(row.revision_json));
      if (revision.artifactId !== row.artifact_id
          || revision.revisionId !== row.revision_id
          || revision.number !== row.revision_number
          || revision.digestSha256 !== row.digest_sha256
          || !sameScope(revision.scope, scope)) {
        throw new TypeError('d1_template_artifact_revision_corrupt');
      }
      return revision;
    });
    const current = history.at(-1);
    const currentRow = rows.at(-1);
    if (!current || !currentRow) throw new TypeError('d1_template_artifact_history_missing');
    const snapshot = parseTemplateArtifactSnapshot({
      head: {
        schemaVersion: 1,
        scope,
        artifactId: head.artifact_id,
        artifactKind: head.artifact_kind,
        currentRevisionId: head.current_revision_id,
        currentRevisionNumber: head.current_revision_number,
        version: head.version
      },
      current,
      history
    });
    revisionsByArtifact.delete(head.artifact_id);
    return Object.freeze({ snapshot, currentRevisionJson: currentRow.revision_json });
  });
  if (revisionsByArtifact.size > 0) throw new TypeError('d1_template_artifact_orphan_revision');
  return Object.freeze(records);
}

async function readD1TemplateArtifact(
  source: D1ReadSource,
  scope: TemplateArtifactScopeDto,
  artifactId: string
): Promise<ArtifactRecord | undefined> {
  const records = await readD1TemplateArtifactRecords(source, scope, artifactId);
  return records[0];
}

async function readD1ReviewDraft(
  source: D1ReadSource,
  scope: TemplateArtifactScopeDto,
  draftId: string
): Promise<ReviewDraftRecord | undefined> {
  const result = await source.prepare(`SELECT d.status,d.action,d.artifact_id,
    d.head_revision_id,d.head_revision_digest_sha256,r.plan_json,r.safe_diff_json
    FROM template_artifact_review_drafts d
    JOIN template_artifact_review_revisions r
      ON r.workspace_id = d.workspace_id AND r.event_id = d.event_id
     AND r.draft_id = d.id AND r.id = d.head_revision_id
     AND r.digest_sha256 = d.head_revision_digest_sha256
    WHERE d.workspace_id = ? AND d.event_id = ? AND d.id = ? LIMIT 2`)
    .bind(scope.workspaceId, scope.eventId, draftId).all<ReviewDraftRow>();
  const rows = result.results;
  if (rows.length > 1) throw new TypeError('d1_template_review_draft_not_unique');
  const row = rows[0];
  if (!row) return undefined;
  const plan = templateArtifactMutationPlanSchema.parse(JSON.parse(row.plan_json));
  const safeDiff = templateArtifactSafeDiffSchema.parse(JSON.parse(row.safe_diff_json));
  if (!sameScope(plan.scope, scope)
      || plan.artifactId !== row.artifact_id
      || plan.action !== row.action
      || safeDiff.artifactId !== plan.artifactId
      || safeDiff.action !== plan.action
      || canonicalJsonText(plan) !== row.plan_json
      || canonicalJsonText(safeDiff) !== row.safe_diff_json) {
    throw new TypeError('d1_template_review_draft_corrupt');
  }
  return Object.freeze({ row, plan, safeDiff });
}

/** Exact selected-Event Template artifact projection for registered reads. */
export function createD1TemplateArtifactReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async listCurrent(requestedWorkspaceId: WorkspaceId, requestedEventId: EventId) {
      if (parseWorkspaceId(requestedWorkspaceId) !== workspaceId) {
        throw new TypeError('d1_template_artifact_workspace_mismatch');
      }
      const scope = Object.freeze({
        workspaceId,
        eventId: parseEventId(requestedEventId)
      });
      const records = await readD1TemplateArtifactRecords(input.database, scope);
      return Object.freeze(records.map((record) => record.snapshot));
    }
  });
}

function projectSafeDiff(plan: TemplateArtifactMutationPlanDto): TemplateArtifactSafeDiffDto {
  return templateArtifactSafeDiffSchema.parse({
    action: plan.action,
    artifactId: plan.artifactId,
    artifactKind: plan.before.document.kind,
    before: plan.before,
    after: plan.after,
    restoredFromRevisionNumber: plan.restoredFromRevisionNumber
  });
}

function outcome(kind: 'template.artifact.event_required' | 'template.artifact.draft_changed') {
  return {
    result: { kind: 'outcome' as const, outcome: {
      class: 'conflict' as const,
      kind,
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    } },
    domain: null,
    effectContributions: [] as const
  };
}

function stale(
  error: TemplateArtifactPlanningError,
  action: 'replace' | 'revert',
  artifactId: string
) {
  return {
    result: { kind: 'outcome' as const, outcome: {
      class: 'stale_revision' as const,
      kind: 'template.artifact_changed' as const,
      retryable: false,
      subjects: [],
      detail: { code: error.code, action, artifactId },
      detailSchemaVersion: 1
    } },
    domain: null,
    effectContributions: [] as const
  };
}

function artifactPort(record: ArtifactRecord | undefined): TemplateArtifactReadPort {
  return Object.freeze({
    readArtifact(scope: TemplateArtifactScopeDto, artifactId: string) {
      return record && sameScope(scope, record.snapshot.head.scope)
          && artifactId === record.snapshot.head.artifactId
        ? record.snapshot
        : undefined;
    }
  });
}

function guardArtifact(
  unitOfWork: D1BufferedUnitOfWork,
  record: ArtifactRecord
): void {
  const snapshot = record.snapshot;
  unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM template_artifact_heads h
    JOIN template_artifact_revisions r
      ON r.workspace_id = h.workspace_id AND r.event_id = h.event_id
     AND r.revision_id = h.current_revision_id
    WHERE h.workspace_id = ? AND h.event_id = ? AND h.artifact_id = ?
      AND h.artifact_kind = ? AND h.current_revision_id = ?
      AND h.current_revision_number = ? AND h.version = ?
      AND r.digest_sha256 = ? AND r.revision_json = ?)`, [
    snapshot.head.scope.workspaceId,
    snapshot.head.scope.eventId,
    snapshot.head.artifactId,
    snapshot.head.artifactKind,
    snapshot.head.currentRevisionId,
    snapshot.head.currentRevisionNumber,
    snapshot.head.version,
    snapshot.current.digestSha256,
    record.currentRevisionJson
  ]);
}

type DraftDomain = Extract<
  ReturnType<typeof templateArtifactNativeDraftContributionSchema.parse>,
  { readonly result: { readonly kind: 'success' } }
>['domain'];
type PublishDomain = Extract<
  ReturnType<typeof templateArtifactNativePublishContributionSchema.parse>,
  { readonly result: { readonly kind: 'success' } }
>['domain'];

type Prepared =
  | {
      readonly kind: 'draft';
      readonly domain: DraftDomain;
      readonly actorUserId: UserId;
      readonly occurredAt: Instant;
      phase: 'prepared' | 'applied';
    }
  | {
      readonly kind: 'publish';
      readonly domain: PublishDomain;
      readonly actorUserId: UserId;
      readonly occurredAt: Instant;
      readonly draft: ReviewDraftRecord;
      phase: 'prepared' | 'applied';
    };

interface D1TemplateArtifactNativeIds {
  newDraftId(): string;
  newRevisionId(): string;
  newArtifactRevisionId(): string;
}

/** D1 adapter for owner-native Template review drafts and publication. */
export class D1TemplateArtifactNativeEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #ids: D1TemplateArtifactNativeIds;
  readonly #issuedIds = new Set<string>();
  #prepared: Prepared | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly ids: D1TemplateArtifactNativeIds;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#ids = Object.freeze({
      newDraftId: input.ids.newDraftId.bind(input.ids),
      newRevisionId: input.ids.newRevisionId.bind(input.ids),
      newArtifactRevisionId: input.ids.newArtifactRevisionId.bind(input.ids)
    });
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    const draft = sameReference(capability, TEMPLATE_ARTIFACT_NATIVE_DRAFT_HANDLER_CAPABILITY)
      && context.operation.name === TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION.name
      && context.operation.version === TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION.version
      && context.operation.effect === 'draft';
    const publish = sameReference(capability, TEMPLATE_ARTIFACT_NATIVE_PUBLISH_HANDLER_CAPABILITY)
      && context.operation.name === TEMPLATE_ARTIFACT_PUBLISH_OPERATION.name
      && context.operation.version === TEMPLATE_ARTIFACT_PUBLISH_OPERATION.version
      && context.operation.effect === 'commit';
    if ((!draft && !publish)
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_template_artifact_scope_mismatch');
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
        || !sameReference(authority.lane.policy, EVENT_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('d1_template_artifact_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const eventSetRows = (await this.input.unitOfWork.readSession.prepare(
      'SELECT version,current_event_id FROM event_spine_workspace_sets WHERE workspace_id = ?'
    ).bind(this.#workspaceId).all<EventSetRow>()).results;
    if (eventSetRows.length !== 1) throw new TypeError('d1_template_artifact_event_set_missing');
    const eventSet = eventSetRows[0]!;
    if (eventSet.current_event_id !== (eventId ?? null)) {
      throw new TypeError('d1_template_artifact_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id = ? AND version = ? AND current_event_id IS ?)`, [
      this.#workspaceId, eventSet.version, eventId ?? null
    ]);
    this.#prepared = undefined;
    if (eventId === undefined) {
      return sealTemplateArtifactNativePreparation({
        capability,
        context,
        prepare: ({ businessInput, context: received }: {
          readonly businessInput: unknown;
          readonly context: EffectInvocationContext;
        }) => {
          if (received !== context) throw new TypeError('d1_template_artifact_context_substitution');
          if (draft) templateArtifactMutationInputSchema.parse(businessInput);
          else templateArtifactPublishInputSchema.parse(businessInput);
          return outcome('template.artifact.event_required');
        }
      });
    }
    const scope = Object.freeze({ workspaceId: this.#workspaceId, eventId: parseEventId(eventId) });
    const eventHeadRows = (await this.input.unitOfWork.readSession.prepare(
      'SELECT version FROM event_spine_heads WHERE workspace_id = ? AND id = ?'
    ).bind(this.#workspaceId, eventId).all<EventHeadRow>()).results;
    if (eventHeadRows.length !== 1) throw new TypeError('d1_template_artifact_event_missing');
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_heads
      WHERE workspace_id = ? AND id = ? AND version = ?)`, [
      this.#workspaceId, eventId, eventHeadRows[0]!.version
    ]);
    const draftTarget = draft
      ? requestTarget(context, 'template-artifact-request:')
      : undefined;
    const reviewDraft = publish
      ? await readD1ReviewDraft(
          this.input.unitOfWork.readSession,
          scope,
          requestTarget(context, 'template-review-draft-request:')
        )
      : undefined;
    const artifactId = draftTarget ?? reviewDraft?.plan.artifactId;
    const artifact = artifactId === undefined
      ? undefined
      : await readD1TemplateArtifact(this.input.unitOfWork.readSession, scope, artifactId);
    if (artifact) guardArtifact(this.input.unitOfWork, artifact);
    return sealTemplateArtifactNativePreparation({
      capability,
      context,
      prepare: ({ businessInput, context: received }: {
        readonly businessInput: unknown;
        readonly context: EffectInvocationContext;
      }) => {
        if (received !== context) throw new TypeError('d1_template_artifact_context_substitution');
        return draft
          ? this.prepareDraft({ businessInput, scope, artifact, actorUserId, evaluatedAt })
          : this.preparePublish({
              businessInput,
              scope,
              artifact,
              reviewDraft,
              actorUserId,
              evaluatedAt
            });
      }
    });
  }

  private prepareDraft(input: {
    readonly businessInput: unknown;
    readonly scope: TemplateArtifactScopeDto;
    readonly artifact: ArtifactRecord | undefined;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
  }) {
    const wire = templateArtifactMutationInputSchema.parse(input.businessInput);
    if (!input.artifact) {
      return templateArtifactNativeDraftContributionSchema.parse(stale(
        new TemplateArtifactPlanningError('artifact_missing'),
        wire.action,
        wire.artifactId
      ));
    }
    let plan: TemplateArtifactMutationPlanDto;
    try {
      plan = planTemplateArtifactMutation({
        scope: input.scope,
        current: input.artifact.snapshot,
        mutation: wire,
        revisionId: this.nextId('newArtifactRevisionId'),
        actorUserId: input.actorUserId,
        occurredAt: input.evaluatedAt
      });
    } catch (error) {
      if (error instanceof TemplateArtifactPlanningError) {
        return templateArtifactNativeDraftContributionSchema.parse(stale(
          error,
          wire.action,
          wire.artifactId
        ));
      }
      throw error;
    }
    const safeDiff = projectSafeDiff(plan);
    const draftId = this.nextId('newDraftId');
    const revisionId = this.nextId('newRevisionId');
    const revisionDigestSha256 = canonicalJsonSha256({ schemaVersion: 1, plan, safeDiff });
    const contribution = templateArtifactNativeDraftContributionSchema.parse({
      result: { kind: 'success', data: {
        schemaVersion: 1,
        action: wire.action,
        draftId,
        status: 'draft',
        revision: { id: revisionId, number: 1, digestSha256: revisionDigestSha256 },
        safeDiff
      } },
      domain: {
        kind: 'template_artifact_review_draft',
        draftId,
        revisionId,
        revisionDigestSha256,
        plan,
        safeDiff
      },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) {
      throw new TypeError('d1_template_artifact_draft_contribution_invalid');
    }
    this.#prepared = {
      kind: 'draft',
      domain: contribution.domain,
      actorUserId: input.actorUserId,
      occurredAt: input.evaluatedAt,
      phase: 'prepared'
    };
    return contribution;
  }

  private preparePublish(input: {
    readonly businessInput: unknown;
    readonly scope: TemplateArtifactScopeDto;
    readonly artifact: ArtifactRecord | undefined;
    readonly reviewDraft: ReviewDraftRecord | undefined;
    readonly actorUserId: UserId;
    readonly evaluatedAt: Instant;
  }) {
    const wire = templateArtifactPublishInputSchema.parse(input.businessInput);
    const draft = input.reviewDraft;
    if (!draft
        || draft.row.status !== 'draft'
        || draft.row.head_revision_id !== wire.revisionId
        || draft.row.head_revision_digest_sha256 !== wire.revisionDigestSha256) {
      return templateArtifactNativePublishContributionSchema.parse(
        outcome('template.artifact.draft_changed')
      );
    }
    const issue = validateTemplateArtifactMutation({
      plan: draft.plan,
      read: artifactPort(input.artifact)
    });
    if (issue) {
      return templateArtifactNativePublishContributionSchema.parse(stale(
        new TemplateArtifactPlanningError(issue),
        draft.row.action,
        draft.plan.artifactId
      ));
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (
      SELECT 1 FROM template_artifact_review_drafts d
      JOIN template_artifact_review_revisions r
        ON r.workspace_id = d.workspace_id AND r.event_id = d.event_id
       AND r.draft_id = d.id AND r.id = d.head_revision_id
       AND r.digest_sha256 = d.head_revision_digest_sha256
      WHERE d.workspace_id = ? AND d.event_id = ? AND d.id = ?
        AND d.status = ? AND d.action = ? AND d.artifact_id = ?
        AND d.head_revision_id = ? AND d.head_revision_digest_sha256 = ?
        AND r.plan_json = ? AND r.safe_diff_json = ?)`, [
      input.scope.workspaceId,
      input.scope.eventId,
      wire.draftId,
      draft.row.status,
      draft.row.action,
      draft.row.artifact_id,
      draft.row.head_revision_id,
      draft.row.head_revision_digest_sha256,
      draft.row.plan_json,
      draft.row.safe_diff_json
    ]);
    const contribution = templateArtifactNativePublishContributionSchema.parse({
      result: { kind: 'success', data: {
        schemaVersion: 1,
        action: draft.plan.action,
        revision: draft.plan.after,
        safeDiff: draft.safeDiff
      } },
      domain: {
        kind: 'template_artifact_review_publish',
        draftId: wire.draftId,
        revisionId: wire.revisionId,
        revisionDigestSha256: wire.revisionDigestSha256,
        plan: draft.plan,
        safeDiff: draft.safeDiff
      },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) {
      throw new TypeError('d1_template_artifact_publish_contribution_invalid');
    }
    this.#prepared = {
      kind: 'publish',
      domain: contribution.domain,
      actorUserId: input.actorUserId,
      occurredAt: input.evaluatedAt,
      draft,
      phase: 'prepared'
    };
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared') {
      throw new TypeError('d1_template_artifact_preparation_missing');
    }
    if (prepared.kind === 'draft') {
      const parsed = templateArtifactNativeDraftContributionSchema.parse({
        result: { kind: 'success', data: {
          schemaVersion: 1,
          action: prepared.domain.plan.action,
          draftId: prepared.domain.draftId,
          status: 'draft',
          revision: {
            id: prepared.domain.revisionId,
            number: 1,
            digestSha256: prepared.domain.revisionDigestSha256
          },
          safeDiff: prepared.domain.safeDiff
        } },
        domain: contribution,
        effectContributions: []
      });
      if (parsed.result.kind !== 'success' || parsed.domain === null
          || canonicalJsonText(parsed.domain) !== canonicalJsonText(prepared.domain)) {
        throw new TypeError('d1_template_artifact_draft_preparation_invalid');
      }
      this.input.unitOfWork.write(`INSERT INTO template_artifact_review_drafts (
        workspace_id,event_id,id,artifact_id,action,status,head_revision_id,
        head_revision_digest_sha256,authored_by_user_id,authored_at_ms,
        published_by_user_id,published_at_ms
      ) VALUES (?,?,?,?,?,'draft',?,?,?,?,NULL,NULL)`, [
        this.#workspaceId,
        prepared.domain.plan.scope.eventId,
        prepared.domain.draftId,
        prepared.domain.plan.artifactId,
        prepared.domain.plan.action,
        prepared.domain.revisionId,
        prepared.domain.revisionDigestSha256,
        prepared.actorUserId,
        Date.parse(prepared.occurredAt)
      ]);
      this.input.unitOfWork.write(`INSERT INTO template_artifact_review_revisions (
        workspace_id,event_id,draft_id,id,number,digest_sha256,plan_json,
        safe_diff_json,authored_by_user_id,authored_at_ms
      ) VALUES (?,?,?,?,1,?,?,?,?,?)`, [
        this.#workspaceId,
        prepared.domain.plan.scope.eventId,
        prepared.domain.draftId,
        prepared.domain.revisionId,
        prepared.domain.revisionDigestSha256,
        canonicalJsonText(prepared.domain.plan),
        canonicalJsonText(prepared.domain.safeDiff),
        prepared.actorUserId,
        Date.parse(prepared.occurredAt)
      ]);
      prepared.phase = 'applied';
      return;
    }
    const parsed = templateArtifactNativePublishContributionSchema.parse({
      result: { kind: 'success', data: {
        schemaVersion: 1,
        action: prepared.domain.plan.action,
        revision: prepared.domain.plan.after,
        safeDiff: prepared.domain.safeDiff
      } },
      domain: contribution,
      effectContributions: []
    });
    if (parsed.result.kind !== 'success' || parsed.domain === null
        || canonicalJsonText(parsed.domain) !== canonicalJsonText(prepared.domain)) {
      throw new TypeError('d1_template_artifact_publish_preparation_invalid');
    }
    const plan = prepared.domain.plan;
    const after = plan.after;
    this.input.unitOfWork.write(`INSERT INTO template_artifact_revisions (
      workspace_id,event_id,artifact_id,revision_id,revision_number,
      predecessor_revision_id,predecessor_digest_sha256,artifact_kind,
      revision_json,digest_sha256,created_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
      plan.scope.workspaceId,
      plan.scope.eventId,
      plan.artifactId,
      after.revisionId,
      after.number,
      after.predecessor!.revisionId,
      after.predecessor!.digestSha256,
      after.document.kind,
      canonicalJsonText(after),
      after.digestSha256,
      Date.parse(after.createdAt)
    ]);
    this.input.unitOfWork.write(`UPDATE template_artifact_heads
      SET current_revision_id = ?,current_revision_number = ?,version = ?
      WHERE workspace_id = ? AND event_id = ? AND artifact_id = ? AND version = ?`, [
      after.revisionId,
      after.number,
      plan.expectedHeadVersion + 1,
      plan.scope.workspaceId,
      plan.scope.eventId,
      plan.artifactId,
      plan.expectedHeadVersion
    ]);
    this.input.unitOfWork.write(`UPDATE template_artifact_review_drafts
      SET status = 'published',published_by_user_id = ?,published_at_ms = ?
      WHERE workspace_id = ? AND event_id = ? AND id = ? AND status = 'draft'
        AND head_revision_id = ? AND head_revision_digest_sha256 = ?`, [
      prepared.actorUserId,
      Date.parse(prepared.occurredAt),
      plan.scope.workspaceId,
      plan.scope.eventId,
      prepared.domain.draftId,
      prepared.domain.revisionId,
      prepared.domain.revisionDigestSha256
    ]);
    prepared.phase = 'applied';
  }

  private nextId(method: keyof D1TemplateArtifactNativeIds): string {
    const id = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(id)) throw new TypeError('d1_template_artifact_ids_not_unique');
    this.#issuedIds.add(id);
    return id;
  }

  afterUnitOfWorkCommitted(): void {
    this.#prepared = undefined;
  }
}

export function createD1TemplateArtifactNativeEffectDomainRegistrations(input: {
  readonly workspaceId: WorkspaceId;
  readonly ids: D1TemplateArtifactNativeIds;
}): readonly D1EffectDomainAdapterRegistration[] {
  const create = (unitOfWork: D1BufferedUnitOfWork) =>
    new D1TemplateArtifactNativeEffectDomainAdapter({
      unitOfWork,
      workspaceId: input.workspaceId,
      ids: input.ids
    });
  return Object.freeze([
    Object.freeze({ capability: TEMPLATE_ARTIFACT_NATIVE_DRAFT_HANDLER_CAPABILITY, create }),
    Object.freeze({ capability: TEMPLATE_ARTIFACT_NATIVE_PUBLISH_HANDLER_CAPABILITY, create })
  ]);
}
