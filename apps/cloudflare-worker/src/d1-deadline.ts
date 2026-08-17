import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  deadlineChangeDataSchema,
  deadlineChangeInputSchema,
  deadlineIdSchema,
  deadlineMutationPlanSchema,
  type DeadlineCatalogSnapshotDto,
  type DeadlineHeadDto,
  type DeadlineMutationPlanningInput,
  type DeadlineScopeDto
} from '@jooevents/contracts/deadlines';
import {
  DeadlinePlanningError,
  applyDeadlinePlanToCatalog,
  createEmptyDeadlineCatalog,
  parseDeadlineCatalog,
  parseDeadlineHead,
  planDeadlineMutation
} from '@jooevents/deadline';
import {
  DEADLINE_CHANGE_HANDLER_CAPABILITY,
  DEADLINE_CHANGE_OPERATION,
  DEADLINE_MANAGE_ACCESS_POLICY,
  DEADLINE_MANAGE_PERMISSION_ID,
  deadlineDirectContributionSchema,
  sealDeadlineDirectPreparation
} from '@jooevents/deadline-operations';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

interface ScopeRow { readonly event_id: string }
interface CatalogRow { readonly version: number; readonly digest_sha256: string }
interface EventSetRow { readonly version: number; readonly current_event_id: string | null }
interface EventHeadRow { readonly timezone: string; readonly version: number }
interface DeadlineRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly id: string;
  readonly kind: 'cfp_close' | 'review_due' | 'task_due';
  readonly status: 'active' | 'cleared';
  readonly version: number;
  readonly digest_sha256: string;
  readonly grace_policy: 'soft';
  readonly display_date: string | null;
  readonly effective_at_ms: number | null;
  readonly boundary_profile_key: string | null;
  readonly boundary_profile_version: number | null;
  readonly boundary_profile_digest_sha256: string | null;
  readonly event_timezone: string | null;
  readonly event_version: number | null;
  readonly local_boundary_date: string | null;
  readonly created_by_user_id: string;
  readonly created_at_ms: number;
  readonly updated_by_user_id: string;
  readonly updated_at_ms: number;
}

type D1ReadSource = Pick<D1Database, 'prepare' | 'batch'>
  | Pick<D1DatabaseSession, 'prepare' | 'batch'>;

const DEADLINE_COLUMNS = `workspace_id,event_id,id,kind,status,version,digest_sha256,
  grace_policy,display_date,effective_at_ms,boundary_profile_key,
  boundary_profile_version,boundary_profile_digest_sha256,event_timezone,
  event_version,local_boundary_date,created_by_user_id,created_at_ms,
  updated_by_user_id,updated_at_ms`;

function headFromRow(row: DeadlineRow): DeadlineHeadDto {
  if (!Number.isSafeInteger(row.version) || row.version <= 0
      || !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0
      || !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0
      || (row.status === 'active' && (
        row.display_date === null
        || row.effective_at_ms === null
        || !Number.isSafeInteger(row.effective_at_ms)
        || row.boundary_profile_key === null
        || row.boundary_profile_version === null
        || row.boundary_profile_digest_sha256 === null
        || row.event_timezone === null
        || row.event_version === null
        || row.local_boundary_date === null
      ))) {
    throw new TypeError('d1_deadline_head_corrupt');
  }
  const common = {
    schemaVersion: 1 as const,
    id: row.id,
    scope: { workspaceId: row.workspace_id, eventId: row.event_id },
    kind: row.kind,
    version: row.version,
    digestSha256: row.digest_sha256,
    gracePolicy: row.grace_policy,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedByUserId: row.updated_by_user_id,
    updatedAt: new Date(row.updated_at_ms).toISOString()
  };
  return row.status === 'active'
    ? parseDeadlineHead({
        ...common,
        status: 'active',
        displayDate: row.display_date,
        effectiveAt: new Date(row.effective_at_ms!).toISOString(),
        boundary: {
          profile: {
            key: row.boundary_profile_key,
            version: row.boundary_profile_version,
            digestSha256: row.boundary_profile_digest_sha256
          },
          eventTimezone: row.event_timezone,
          eventVersion: row.event_version,
          localBoundaryDate: row.local_boundary_date
        }
      })
    : parseDeadlineHead({
        ...common,
        status: 'cleared',
        displayDate: null,
        effectiveAt: null,
        boundary: null
      });
}

async function readCatalog(
  source: D1ReadSource,
  scope: DeadlineScopeDto
): Promise<DeadlineCatalogSnapshotDto | undefined> {
  const [scopeResult, catalogResult, deadlinesResult] = await source.batch([
    source.prepare(`SELECT event_id FROM event_spine_scope_roots
      WHERE workspace_id = ? AND event_id = ?
      ORDER BY workspace_id,event_id LIMIT 2`).bind(scope.workspaceId, scope.eventId),
    source.prepare(`SELECT version,digest_sha256 FROM deadline_catalogs
      WHERE workspace_id = ? AND event_id = ?
      ORDER BY workspace_id,event_id LIMIT 2`).bind(scope.workspaceId, scope.eventId),
    source.prepare(`SELECT ${DEADLINE_COLUMNS} FROM deadlines
      WHERE workspace_id = ? AND event_id = ?
      ORDER BY id COLLATE BINARY`).bind(scope.workspaceId, scope.eventId)
  ]);
  const roots = (scopeResult as D1Result<ScopeRow>).results;
  const catalogs = (catalogResult as D1Result<CatalogRow>).results;
  const rows = (deadlinesResult as D1Result<DeadlineRow>).results;
  if (roots.length > 1 || catalogs.length > 1) {
    throw new TypeError('d1_deadline_data_not_unique');
  }
  if (!roots[0]) return undefined;
  if (roots[0].event_id !== scope.eventId) throw new TypeError('d1_deadline_scope_corrupt');
  const catalog = catalogs[0];
  if (!catalog) {
    if (rows.length > 0) throw new TypeError('d1_deadline_catalog_missing');
    return createEmptyDeadlineCatalog(scope);
  }
  return parseDeadlineCatalog({
    schemaVersion: 1,
    scope,
    version: catalog.version,
    digestSha256: catalog.digest_sha256,
    deadlines: rows.map(headFromRow)
  });
}

/** Atomic D1 source for both registered Deadline reads. */
export function createD1DeadlineReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readDeadlineCatalog(scopeInput: DeadlineScopeDto) {
      const scope = Object.freeze({
        workspaceId: parseWorkspaceId(scopeInput.workspaceId),
        eventId: parseEventId(scopeInput.eventId)
      });
      if (scope.workspaceId !== workspaceId) {
        throw new TypeError('d1_deadline_workspace_mismatch');
      }
      return readCatalog(input.database, scope);
    }
  });
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return eventId !== undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId);
}

function refusal(
  error: DeadlinePlanningError,
  action: 'create' | 'update' | 'clear',
  deadlineId: string
) {
  return deadlineDirectContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: error.code === 'deadline_unchanged' ? 'conflict' : 'stale_revision',
      kind: error.code === 'deadline_unchanged'
        ? 'deadline.no_change'
        : 'deadline.canonical_changed',
      retryable: false,
      subjects: [{ type: 'deadline', id: deadlineId }],
      detail: error.code === 'deadline_unchanged'
        ? null
        : { code: error.code, action, deadlineId },
      detailSchemaVersion: 1
    } },
    domain: null,
    effectContributions: []
  });
}

function persistedHead(head: DeadlineHeadDto): readonly unknown[] {
  return Object.freeze([
    head.scope.workspaceId,
    head.scope.eventId,
    head.id,
    head.kind,
    head.status,
    head.version,
    head.digestSha256,
    head.gracePolicy,
    head.displayDate,
    head.effectiveAt === null ? null : Date.parse(head.effectiveAt),
    head.boundary?.profile.key ?? null,
    head.boundary?.profile.version ?? null,
    head.boundary?.profile.digestSha256 ?? null,
    head.boundary?.eventTimezone ?? null,
    head.boundary?.eventVersion ?? null,
    head.boundary?.localBoundaryDate ?? null,
    head.createdByUserId,
    Date.parse(head.createdAt),
    head.updatedByUserId,
    Date.parse(head.updatedAt)
  ]);
}

interface PreparedDeadlineChange {
  readonly catalog: DeadlineCatalogSnapshotDto;
  readonly plan: ReturnType<typeof deadlineMutationPlanSchema.parse>;
  phase: 'prepared' | 'applied';
}

/** D1 adapter for the unchanged direct audited Deadline change operation. */
export class D1DeadlineDirectEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedDeadlineChange | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly newDeadlineId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (capability.key !== DEADLINE_CHANGE_HANDLER_CAPABILITY.key
        || capability.version !== DEADLINE_CHANGE_HANDLER_CAPABILITY.version) {
      throw new TypeError('d1_deadline_capability_mismatch');
    }
    if (context.operation.name !== DEADLINE_CHANGE_OPERATION.name
        || context.operation.version !== DEADLINE_CHANGE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_deadline_scope_mismatch');
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
        || authority.lane.policy.key !== DEADLINE_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== DEADLINE_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === DEADLINE_MANAGE_PERMISSION_ID)) {
      throw new TypeError('d1_deadline_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = parseEventId(context.scope.eventId);
    const scope = Object.freeze({ workspaceId: this.#workspaceId, eventId });
    const [eventSetResult, eventHeadResult] = await this.input.unitOfWork.readSession.batch([
      this.input.unitOfWork.readSession.prepare(`SELECT version,current_event_id
        FROM event_spine_workspace_sets WHERE workspace_id = ?`)
        .bind(this.#workspaceId),
      this.input.unitOfWork.readSession.prepare(`SELECT timezone,version
        FROM event_spine_heads WHERE workspace_id = ? AND id = ?`)
        .bind(this.#workspaceId, eventId)
    ]);
    const eventSetRows = (eventSetResult as D1Result<EventSetRow>).results;
    const eventHeadRows = (eventHeadResult as D1Result<EventHeadRow>).results;
    if (eventSetRows.length > 1 || eventHeadRows.length > 1) {
      throw new TypeError('d1_deadline_event_not_unique');
    }
    const eventSet = eventSetRows[0];
    const eventHead = eventHeadRows[0];
    if (!eventSet || eventSet.current_event_id !== eventId || !eventHead) {
      throw new TypeError('d1_deadline_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id = ? AND version = ? AND current_event_id = ?)`, [
      this.#workspaceId, eventSet.version, eventId
    ]);
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_heads
      WHERE workspace_id = ? AND id = ? AND timezone = ? AND version = ?)`, [
      this.#workspaceId, eventId, eventHead.timezone, eventHead.version
    ]);
    const catalog = await readCatalog(this.input.unitOfWork.readSession, scope);
    if (!catalog) throw new TypeError('d1_deadline_catalog_missing');
    if (catalog.version === 1) {
      this.input.unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM deadline_catalogs
        WHERE workspace_id = ? AND event_id = ?)`, [scope.workspaceId, scope.eventId]);
    } else {
      this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM deadline_catalogs
        WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?)`, [
        scope.workspaceId, scope.eventId, catalog.version, catalog.digestSha256
      ]);
    }
    this.#prepared = undefined;
    return sealDeadlineDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context) throw new TypeError('d1_deadline_context_substitution');
        const wire = deadlineChangeInputSchema.parse(businessInput);
        const deadlineId = wire.action === 'create'
          ? deadlineIdSchema.parse(this.input.newDeadlineId())
          : wire.deadlineId;
        const planningInput: DeadlineMutationPlanningInput = {
          ...wire,
          scope,
          deadlineId,
          attributedByUserId: actorUserId,
          attributedAt: evaluatedAt
        };
        try {
          const plan = planDeadlineMutation({
            planningInput,
            catalog,
            ...(wire.action === 'clear' ? {} : {
              eventTimeBasis: {
                timezone: eventHead.timezone,
                eventVersion: eventHead.version
              }
            })
          });
          const parsedPlan = deadlineMutationPlanSchema.parse(plan);
          const contribution = deadlineDirectContributionSchema.parse({
            result: { kind: 'success', data: deadlineChangeDataSchema.parse({
              schemaVersion: 1,
              action: parsedPlan.input.action,
              catalogVersion: parsedPlan.catalog.afterVersion,
              deadline: parsedPlan.after,
              pin: parsedPlan.after.status === 'active' ? {
                id: parsedPlan.after.id,
                version: parsedPlan.after.version,
                digestSha256: parsedPlan.after.digestSha256,
                effectiveAt: parsedPlan.after.effectiveAt,
                displayDate: parsedPlan.after.displayDate,
                gracePolicy: parsedPlan.after.gracePolicy
              } : null
            }) },
            domain: { kind: 'deadline_direct_change', plan: parsedPlan },
            effectContributions: []
          });
          this.#prepared = { catalog, plan: parsedPlan, phase: 'prepared' };
          return contribution;
        } catch (error) {
          if (error instanceof DeadlinePlanningError) {
            return refusal(error, wire.action, deadlineId);
          }
          throw error;
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const candidate = contribution as { readonly kind?: unknown; readonly plan?: unknown };
    if (candidate.kind !== 'deadline_direct_change') {
      throw new TypeError('d1_deadline_contribution_invalid');
    }
    const plan = deadlineMutationPlanSchema.parse(candidate.plan);
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(prepared.plan) !== canonicalJsonText(plan)) {
      throw new TypeError('d1_deadline_preparation_invalid');
    }
    applyDeadlinePlanToCatalog({
      plan: prepared.plan,
      catalog: prepared.catalog,
      ...(prepared.plan.eventTimeBasis === null ? {} : {
        eventTimeBasis: prepared.plan.eventTimeBasis
      })
    });
    if (plan.catalog.beforeVersion === 1) {
      this.input.unitOfWork.write(`INSERT INTO deadline_catalogs (
        workspace_id,event_id,version,digest_sha256
      ) SELECT ?,?,?,? FROM event_spine_scope_roots
        WHERE workspace_id = ? AND event_id = ?
          AND NOT EXISTS (SELECT 1 FROM deadline_catalogs
            WHERE workspace_id = ? AND event_id = ?)`, [
        plan.input.scope.workspaceId,
        plan.input.scope.eventId,
        plan.catalog.afterVersion,
        plan.catalog.afterDigestSha256,
        plan.input.scope.workspaceId,
        plan.input.scope.eventId,
        plan.input.scope.workspaceId,
        plan.input.scope.eventId
      ]);
    }
    if (plan.input.action === 'create') {
      this.input.unitOfWork.write(`INSERT INTO deadlines (${DEADLINE_COLUMNS})
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, persistedHead(plan.after));
    } else {
      const values = persistedHead(plan.after);
      this.input.unitOfWork.write(`UPDATE deadlines SET
        status = ?,version = ?,digest_sha256 = ?,grace_policy = ?,display_date = ?,
        effective_at_ms = ?,boundary_profile_key = ?,boundary_profile_version = ?,
        boundary_profile_digest_sha256 = ?,event_timezone = ?,event_version = ?,
        local_boundary_date = ?,updated_by_user_id = ?,updated_at_ms = ?
        WHERE workspace_id = ? AND event_id = ? AND id = ?
          AND version = ? AND digest_sha256 = ?`, [
        values[4], values[5], values[6], values[7], values[8], values[9],
        values[10], values[11], values[12], values[13], values[14], values[15],
        values[18], values[19], plan.before!.scope.workspaceId,
        plan.before!.scope.eventId, plan.before!.id, plan.before!.version,
        plan.before!.digestSha256
      ]);
    }
    if (plan.catalog.beforeVersion !== 1) {
      this.input.unitOfWork.write(`UPDATE deadline_catalogs
        SET version = ?,digest_sha256 = ?
        WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?`, [
        plan.catalog.afterVersion,
        plan.catalog.afterDigestSha256,
        plan.input.scope.workspaceId,
        plan.input.scope.eventId,
        plan.catalog.beforeVersion,
        plan.catalog.beforeDigestSha256
      ]);
    }
    prepared.phase = 'applied';
  }

  afterUnitOfWorkCommitted(): void {
    this.#prepared = undefined;
  }
}

export function createD1DeadlineDirectEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly newDeadlineId: () => string;
}): D1EffectDomainAdapterRegistration {
  return Object.freeze({
    capability: DEADLINE_CHANGE_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) =>
      new D1DeadlineDirectEffectDomainAdapter({
        unitOfWork,
        workspaceId: input.workspaceId,
        newDeadlineId: input.newDeadlineId
      })
  });
}
