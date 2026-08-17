import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  taskAssignmentRestorePlanSchema,
  taskMutationDataSchema,
  taskMutationInputSchema,
  taskMutationPlanSchema,
  type TaskAssignmentDto,
  type TaskBoardSnapshotDto,
  type TaskDefinitionCatalogDto,
  type TaskEventDto,
  type TaskScopeDto
} from '@jooevents/contracts';
import {
  deadlineReferencePin,
  planTaskDueDeadlineCreateFrom,
  resolveCurrentDeadlineFrom,
  type TaskDueDeadlineCreateInput,
  type TaskDueDeadlinePlanningPort
} from '@jooevents/deadline';
import {
  TASK_MANAGE_ACCESS_POLICY,
  TASK_MANAGE_PERMISSION_ID,
  TASK_MUTATION_HANDLER_CAPABILITY,
  TASK_MUTATION_OPERATION,
  sealTaskDirectPreparation,
  taskDirectContributionSchema
} from '@jooevents/task-operations';
import {
  TaskPlanningError,
  createEmptyTaskCatalog,
  parseTaskAssignment,
  parseTaskBoard,
  parseTaskCatalog,
  parseTaskDefinition,
  parseTaskEvent,
  planTaskAssignmentRestore,
  planTaskMutation,
  validateTaskMutation,
  validateTaskRestore,
  type ConfirmedTaskEngagement,
  type TaskMembershipSource,
  type TaskReadPort
} from '@jooevents/tasks';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import {
  bufferD1DeadlinePlan,
  guardD1DeadlineCatalog,
  readD1DeadlineCatalog
} from './d1-deadline';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

interface ScopeRow { readonly event_id: string }
interface CatalogRow { readonly version: number; readonly digest_sha256: string }
interface DefinitionRow {
  readonly id: string;
  readonly current_revision_id: string;
  readonly current_revision_number: number;
  readonly version: number;
  readonly revision_json: string;
}
interface AssignmentRow {
  readonly id: string;
  readonly version: number;
  readonly assignment_json: string;
}
interface EventRow {
  readonly id: string;
  readonly assignment_id: string;
  readonly assignment_version: number;
  readonly event_json: string;
}
interface EngagementRow {
  readonly id: string;
  readonly person_id: string;
  readonly version: number;
}
interface EventSetRow { readonly version: number; readonly current_event_id: string | null }
interface EventHeadRow { readonly timezone: string; readonly version: number }

type D1ReadSource = Pick<D1Database, 'prepare' | 'batch'>
  | Pick<D1DatabaseSession, 'prepare' | 'batch'>;

interface TaskData {
  readonly catalog: TaskDefinitionCatalogDto;
  readonly assignments: readonly TaskAssignmentDto[];
  readonly events: readonly TaskEventDto[];
  readonly engagements: readonly ConfirmedTaskEngagement[];
}

function sameScope(left: TaskScopeDto, right: TaskScopeDto): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

async function readTaskData(
  source: D1ReadSource,
  scope: TaskScopeDto
): Promise<TaskData | undefined> {
  const results = await source.batch([
    source.prepare(`SELECT event_id FROM event_spine_scope_roots
      WHERE workspace_id = ? AND event_id = ? LIMIT 2`).bind(scope.workspaceId, scope.eventId),
    source.prepare(`SELECT version,digest_sha256 FROM task_definition_catalogs
      WHERE workspace_id = ? AND event_id = ? LIMIT 2`).bind(scope.workspaceId, scope.eventId),
    source.prepare(`SELECT h.id,h.current_revision_id,h.current_revision_number,h.version,
      r.revision_json FROM task_definition_heads h
      JOIN task_definition_revisions r
        ON r.workspace_id = h.workspace_id AND r.event_id = h.event_id
       AND r.revision_id = h.current_revision_id
      WHERE h.workspace_id = ? AND h.event_id = ?
      ORDER BY h.id COLLATE BINARY`).bind(scope.workspaceId, scope.eventId),
    source.prepare(`SELECT id,version,assignment_json FROM task_assignments
      WHERE workspace_id = ? AND event_id = ?
      ORDER BY task_definition_id COLLATE BINARY,engagement_id COLLATE BINARY`)
      .bind(scope.workspaceId, scope.eventId),
    source.prepare(`SELECT id,assignment_id,assignment_version,event_json FROM task_events
      WHERE workspace_id = ? AND event_id = ?
      ORDER BY assignment_id COLLATE BINARY,assignment_version`)
      .bind(scope.workspaceId, scope.eventId),
    source.prepare(`SELECT id,person_id,version FROM engagement_heads
      WHERE workspace_id = ? AND event_id = ? AND state = 'confirmed'
      ORDER BY id COLLATE BINARY`).bind(scope.workspaceId, scope.eventId)
  ]);
  const roots = (results[0] as D1Result<ScopeRow>).results;
  const catalogs = (results[1] as D1Result<CatalogRow>).results;
  if (roots.length > 1 || catalogs.length > 1) throw new TypeError('d1_task_data_not_unique');
  if (!roots[0]) return undefined;
  if (roots[0].event_id !== scope.eventId) throw new TypeError('d1_task_scope_corrupt');
  const definitions = (results[2] as D1Result<DefinitionRow>).results.map((row) => {
    const definition = parseTaskDefinition({
      head: {
        schemaVersion: 1,
        scope,
        id: row.id,
        currentRevisionId: row.current_revision_id,
        currentRevisionNumber: row.current_revision_number,
        version: row.version
      },
      current: JSON.parse(row.revision_json)
    });
    if (canonicalJsonText(definition.current) !== row.revision_json) {
      throw new TypeError('d1_task_revision_noncanonical');
    }
    return definition;
  });
  const catalogRow = catalogs[0];
  if (!catalogRow && definitions.length > 0) throw new TypeError('d1_task_catalog_missing');
  const catalog = catalogRow
    ? parseTaskCatalog({
        schemaVersion: 1,
        scope,
        version: catalogRow.version,
        digestSha256: catalogRow.digest_sha256,
        definitions
      })
    : createEmptyTaskCatalog(scope);
  const assignments = (results[3] as D1Result<AssignmentRow>).results.map((row) => {
    const assignment = parseTaskAssignment(JSON.parse(row.assignment_json));
    if (assignment.id !== row.id || assignment.version !== row.version
        || !sameScope(assignment.scope, scope)
        || canonicalJsonText(assignment) !== row.assignment_json) {
      throw new TypeError('d1_task_assignment_corrupt');
    }
    return assignment;
  });
  const events = (results[4] as D1Result<EventRow>).results.map((row) => {
    const event = parseTaskEvent(JSON.parse(row.event_json));
    if (event.id !== row.id || event.assignmentId !== row.assignment_id
        || event.assignmentVersion !== row.assignment_version
        || !sameScope(event.scope, scope)
        || canonicalJsonText(event) !== row.event_json) {
      throw new TypeError('d1_task_event_corrupt');
    }
    return event;
  });
  const engagements = (results[5] as D1Result<EngagementRow>).results.map((row) => {
    if (typeof row.id !== 'string' || typeof row.person_id !== 'string'
        || !Number.isSafeInteger(row.version) || row.version <= 0) {
      throw new TypeError('d1_task_engagement_corrupt');
    }
    return Object.freeze({
      engagementId: row.id,
      personId: row.person_id,
      version: row.version,
      state: 'confirmed' as const
    });
  });
  if (!catalogRow && (assignments.length > 0 || events.length > 0)) {
    throw new TypeError('d1_task_rows_without_catalog');
  }
  return Object.freeze({
    catalog,
    assignments: Object.freeze(assignments),
    events: Object.freeze(events),
    engagements: Object.freeze(engagements)
  });
}

function taskBoard(scope: TaskScopeDto, data: TaskData): TaskBoardSnapshotDto {
  return parseTaskBoard({
    schemaVersion: 1,
    scope,
    catalogVersion: data.catalog.version,
    catalogDigestSha256: data.catalog.digestSha256,
    definitions: data.catalog.definitions,
    assignments: data.assignments
  });
}

/** Exact selected-Event Task board source for the registered read. */
export function createD1TaskBoardReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readCurrent(requestedWorkspaceId: WorkspaceId, requestedEventId: EventId) {
      if (parseWorkspaceId(requestedWorkspaceId) !== workspaceId) {
        throw new TypeError('d1_task_workspace_mismatch');
      }
      const scope = Object.freeze({
        workspaceId,
        eventId: parseEventId(requestedEventId)
      });
      const data = await readTaskData(input.database, scope);
      return data ? taskBoard(scope, data) : undefined;
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

function taskPorts(scope: TaskScopeDto, data: TaskData) {
  const tasks: TaskReadPort & { readTaskEvent(
    requestedScope: TaskScopeDto,
    assignmentId: string,
    assignmentVersion: number
  ): TaskEventDto | undefined } = Object.freeze({
    readTaskCatalog: (requestedScope: TaskScopeDto) =>
      sameScope(requestedScope, scope) ? data.catalog : undefined,
    readTaskAssignment: (requestedScope: TaskScopeDto, assignmentId: string) =>
      sameScope(requestedScope, scope)
        ? data.assignments.find((entry) => entry.id === assignmentId)
        : undefined,
    readTaskBoard: (requestedScope: TaskScopeDto) =>
      sameScope(requestedScope, scope) ? taskBoard(scope, data) : undefined,
    readTaskEvent: (
      requestedScope: TaskScopeDto,
      assignmentId: string,
      assignmentVersion: number
    ) => sameScope(requestedScope, scope)
      ? data.events.find((entry) =>
          entry.assignmentId === assignmentId && entry.assignmentVersion === assignmentVersion)
      : undefined
  });
  const memberships: TaskMembershipSource = Object.freeze({
    listConfirmedTaskEngagements: (requestedScope: TaskScopeDto) =>
      sameScope(requestedScope, scope) ? data.engagements : Object.freeze([])
  });
  return Object.freeze({ tasks, memberships });
}

function guardTaskCatalog(
  unitOfWork: D1BufferedUnitOfWork,
  catalog: TaskDefinitionCatalogDto
): void {
  if (catalog.version === 1) {
    unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM task_definition_catalogs
      WHERE workspace_id = ? AND event_id = ?)`, [
      catalog.scope.workspaceId, catalog.scope.eventId
    ]);
    return;
  }
  unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM task_definition_catalogs
    WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?)`, [
    catalog.scope.workspaceId,
    catalog.scope.eventId,
    catalog.version,
    catalog.digestSha256
  ]);
}

function guardMemberships(
  unitOfWork: D1BufferedUnitOfWork,
  scope: TaskScopeDto,
  engagements: readonly ConfirmedTaskEngagement[]
): void {
  unitOfWork.assertCurrent(`(SELECT count(*) FROM engagement_heads
    WHERE workspace_id = ? AND event_id = ? AND state = 'confirmed') = ?`, [
    scope.workspaceId, scope.eventId, engagements.length
  ]);
  for (const engagement of engagements) {
    unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM engagement_heads
      WHERE workspace_id = ? AND event_id = ? AND id = ? AND person_id = ?
        AND version = ? AND state = 'confirmed')`, [
      scope.workspaceId,
      scope.eventId,
      engagement.engagementId,
      engagement.personId,
      engagement.version
    ]);
  }
}

function refusal(error: TaskPlanningError, scope: TaskScopeDto, action: string, subjectId: string) {
  return taskDirectContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: 'stale_revision',
      kind: 'task.changed',
      retryable: false,
      subjects: [{ type: 'event', id: scope.eventId }],
      detail: { code: error.code, action, subjectId: error.subjectId ?? subjectId },
      detailSchemaVersion: 1
    } },
    domain: null,
    effectContributions: []
  });
}

type TaskPlan = ReturnType<typeof taskMutationPlanSchema.parse>
  | ReturnType<typeof taskAssignmentRestorePlanSchema.parse>;

interface PreparedTaskChange {
  readonly plan: TaskPlan;
  readonly data: TaskData;
  readonly deadlineCatalog: NonNullable<Awaited<ReturnType<typeof readD1DeadlineCatalog>>>;
  readonly tasks: ReturnType<typeof taskPorts>['tasks'];
  readonly memberships: ReturnType<typeof taskPorts>['memberships'];
  phase: 'prepared' | 'applied';
}

/** D1 adapter for the complete organizer Task mutation contract. */
export class D1TaskDirectEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedTaskChange | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly ids: {
      newTaskDefinitionId(): string;
      newTaskDefinitionRevisionId(): string;
      newDeadlineId(): string;
    };
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (capability.key !== TASK_MUTATION_HANDLER_CAPABILITY.key
        || capability.version !== TASK_MUTATION_HANDLER_CAPABILITY.version) {
      throw new TypeError('d1_task_capability_mismatch');
    }
    if (context.operation.name !== TASK_MUTATION_OPERATION.name
        || context.operation.version !== TASK_MUTATION_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_task_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || authority.lane.policy.key !== TASK_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== TASK_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === TASK_MANAGE_PERMISSION_ID)) {
      throw new TypeError('d1_task_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = parseEventId(context.scope.eventId);
    const scope = Object.freeze({ workspaceId: this.#workspaceId, eventId });
    const [eventSetResult, eventHeadResult] = await this.input.unitOfWork.readSession.batch([
      this.input.unitOfWork.readSession.prepare(`SELECT version,current_event_id
        FROM event_spine_workspace_sets WHERE workspace_id = ?`).bind(this.#workspaceId),
      this.input.unitOfWork.readSession.prepare(`SELECT timezone,version FROM event_spine_heads
        WHERE workspace_id = ? AND id = ?`).bind(this.#workspaceId, eventId)
    ]);
    const eventSets = (eventSetResult as D1Result<EventSetRow>).results;
    const eventHeads = (eventHeadResult as D1Result<EventHeadRow>).results;
    if (eventSets.length !== 1 || eventHeads.length !== 1
        || eventSets[0]!.current_event_id !== eventId) {
      throw new TypeError('d1_task_current_event_mismatch');
    }
    const eventSet = eventSets[0]!;
    const eventHead = eventHeads[0]!;
    const data = await readTaskData(this.input.unitOfWork.readSession, scope);
    const deadlineCatalog = await readD1DeadlineCatalog(
      this.input.unitOfWork.readSession,
      scope
    );
    if (!data || !deadlineCatalog) throw new TypeError('d1_task_state_missing');
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id = ? AND version = ? AND current_event_id = ?)`, [
      this.#workspaceId, eventSet.version, eventId
    ]);
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_heads
      WHERE workspace_id = ? AND id = ? AND timezone = ? AND version = ?)`, [
      this.#workspaceId, eventId, eventHead.timezone, eventHead.version
    ]);
    guardTaskCatalog(this.input.unitOfWork, data.catalog);
    const ports = taskPorts(scope, data);
    const deadlines: TaskDueDeadlinePlanningPort = Object.freeze({
      readDeadlineCatalog: (requestedScope: TaskScopeDto) =>
        sameScope(requestedScope, scope) ? deadlineCatalog : undefined,
      readDeadline: (requestedScope: TaskScopeDto, deadlineId: string) =>
        sameScope(requestedScope, scope)
          ? deadlineCatalog.deadlines.find((entry) => entry.id === deadlineId)
          : undefined,
      readDeadlineEventTimeBasis: (requestedScope: TaskScopeDto) =>
        sameScope(requestedScope, scope)
          ? { timezone: eventHead.timezone, eventVersion: eventHead.version }
          : undefined,
      resolveCurrentDeadline(requestedScope: TaskScopeDto, reference: { deadlineId: string }) {
        return sameScope(requestedScope, scope)
          ? resolveCurrentDeadlineFrom(this, requestedScope, reference)
          : undefined;
      },
      planTaskDueDeadlineCreate(request: TaskDueDeadlineCreateInput) {
        return planTaskDueDeadlineCreateFrom(this, request);
      }
    });
    this.#prepared = undefined;
    return sealTaskDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context) throw new TypeError('d1_task_context_substitution');
        const wire = taskMutationInputSchema.parse(businessInput);
        try {
          let plan: TaskPlan;
          if (wire.action === 'restore_assignment') {
            const current = ports.tasks.readTaskAssignment(scope, wire.assignmentId);
            if (!current) throw new TaskPlanningError('assignment_missing', wire.assignmentId);
            if (current.version !== wire.expectedVersion) {
              throw new TaskPlanningError('stale_assignment', wire.assignmentId);
            }
            const latestEvent = ports.tasks.readTaskEvent(scope, current.id, current.version);
            if (!latestEvent) throw new TaskPlanningError('invalid_transition', current.id);
            plan = planTaskAssignmentRestore({ current, latestEvent, actorUserId, occurredAt });
            this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM task_events
              WHERE workspace_id = ? AND event_id = ? AND id = ? AND assignment_id = ?
                AND assignment_version = ? AND event_json = ?)`, [
              scope.workspaceId, scope.eventId, latestEvent.id, latestEvent.assignmentId,
              latestEvent.assignmentVersion, canonicalJsonText(latestEvent)
            ]);
          } else {
            plan = planTaskMutation(wire.action === 'create_definition' ? {
              ...wire,
              scope,
              taskDefinitionId: this.input.ids.newTaskDefinitionId(),
              revisionId: this.input.ids.newTaskDefinitionRevisionId(),
              deadlineId: this.input.ids.newDeadlineId(),
              actorUserId,
              occurredAt
            } : { ...wire, scope, actorUserId, occurredAt }, {
              tasks: ports.tasks,
              memberships: ports.memberships,
              deadlines
            });
          }
          if (plan.action === 'create_definition') {
            guardMemberships(this.input.unitOfWork, scope, data.engagements);
            guardD1DeadlineCatalog(this.input.unitOfWork, deadlineCatalog);
          } else {
            const current = plan.action === 'restore_assignment' ? plan.expectedCurrent : plan.before;
            this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM task_assignments
              WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
                AND assignment_json = ?)`, [
              scope.workspaceId, scope.eventId, current.id, current.version,
              canonicalJsonText(current)
            ]);
          }
          const resultData = plan.action === 'create_definition'
            ? { schemaVersion: 1, action: plan.action,
                definition: plan.definition, assignments: plan.assignments }
            : { schemaVersion: 1, action: plan.action,
                assignment: plan.action === 'restore_assignment' ? plan.restore : plan.after };
          const contribution = taskDirectContributionSchema.parse({
            result: { kind: 'success', data: taskMutationDataSchema.parse(resultData) },
            domain: { kind: 'task_direct_mutation', plan },
            effectContributions: []
          });
          this.#prepared = {
            plan,
            data,
            deadlineCatalog,
            tasks: ports.tasks,
            memberships: ports.memberships,
            phase: 'prepared'
          };
          return contribution;
        } catch (error) {
          if (error instanceof TaskPlanningError) {
            const subjectId = wire.action === 'create_definition' ? scope.eventId : wire.assignmentId;
            return refusal(error, scope, wire.action, subjectId);
          }
          throw error;
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const candidate = contribution as { readonly kind?: unknown; readonly plan?: unknown };
    if (candidate.kind !== 'task_direct_mutation') {
      throw new TypeError('d1_task_contribution_invalid');
    }
    const direct = taskMutationPlanSchema.safeParse(candidate.plan);
    const plan: TaskPlan = direct.success
      ? direct.data
      : taskAssignmentRestorePlanSchema.parse(candidate.plan);
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(prepared.plan) !== canonicalJsonText(plan)) {
      throw new TypeError('d1_task_preparation_invalid');
    }
    const validation = plan.action === 'restore_assignment'
      ? validateTaskRestore(plan, prepared.tasks)
      : validateTaskMutation(plan, {
          tasks: prepared.tasks,
          memberships: prepared.memberships,
          deadlines: Object.freeze({
            readDeadlineCatalog: () => prepared.deadlineCatalog,
            readDeadline: (_scope: TaskScopeDto, deadlineId: string) =>
              prepared.deadlineCatalog.deadlines.find((entry) => entry.id === deadlineId),
            readDeadlineEventTimeBasis: () => plan.action === 'create_definition'
              ? plan.deadlineContribution.eventTimeBasis ?? undefined
              : undefined,
            resolveCurrentDeadline: (_scope: TaskScopeDto, reference: { deadlineId: string }) => {
              const head = prepared.deadlineCatalog.deadlines.find((entry) =>
                entry.id === reference.deadlineId && entry.status === 'active');
              return head ? deadlineReferencePin(head) : undefined;
            },
            planTaskDueDeadlineCreate: () => plan.action === 'create_definition'
              ? plan.deadlineContribution
              : (() => { throw new TypeError('d1_task_deadline_plan_unavailable'); })()
          })
        });
    if (validation) throw new TypeError(`d1_task_plan_${validation}`);
    if (plan.action === 'create_definition') {
      bufferD1DeadlinePlan({
        unitOfWork: this.input.unitOfWork,
        catalog: prepared.deadlineCatalog,
        plan: plan.deadlineContribution
      });
      if (plan.catalog.beforeVersion === 1) {
        this.input.unitOfWork.write(`INSERT INTO task_definition_catalogs (
          workspace_id,event_id,version,digest_sha256
        ) SELECT ?,?,?,? FROM event_spine_scope_roots
          WHERE workspace_id = ? AND event_id = ?
            AND NOT EXISTS (SELECT 1 FROM task_definition_catalogs
              WHERE workspace_id = ? AND event_id = ?)`, [
          plan.input.scope.workspaceId, plan.input.scope.eventId,
          plan.catalog.afterVersion, plan.catalog.afterDigestSha256,
          plan.input.scope.workspaceId, plan.input.scope.eventId,
          plan.input.scope.workspaceId, plan.input.scope.eventId
        ]);
      } else {
        this.input.unitOfWork.write(`UPDATE task_definition_catalogs
          SET version = ?,digest_sha256 = ?
          WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?`, [
          plan.catalog.afterVersion, plan.catalog.afterDigestSha256,
          plan.input.scope.workspaceId, plan.input.scope.eventId,
          plan.catalog.beforeVersion, plan.catalog.beforeDigestSha256
        ]);
      }
      const { head, current } = plan.definition;
      this.input.unitOfWork.write(`INSERT INTO task_definition_heads (
        workspace_id,event_id,id,current_revision_id,current_revision_number,version
      ) VALUES (?,?,?,?,?,?)`, [
        head.scope.workspaceId, head.scope.eventId, head.id,
        head.currentRevisionId, head.currentRevisionNumber, head.version
      ]);
      this.input.unitOfWork.write(`INSERT INTO task_definition_revisions (
        workspace_id,event_id,task_definition_id,revision_id,revision_number,
        deadline_id,completion_mode,subject_kind,required,revision_json,digest_sha256,created_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
        current.scope.workspaceId, current.scope.eventId, current.taskDefinitionId,
        current.revisionId, current.number, current.deadline.reference.id,
        current.completionMode, current.subjectKind, current.required ? 1 : 0,
        canonicalJsonText(current), current.digestSha256, Date.parse(current.createdAt)
      ]);
      for (const assignment of plan.assignments) this.bufferAssignmentInsert(assignment);
      for (const event of plan.events) this.bufferEventInsert(event);
    } else {
      const before = plan.action === 'restore_assignment' ? plan.expectedCurrent : plan.before;
      const after = plan.action === 'restore_assignment' ? plan.restore : plan.after;
      this.input.unitOfWork.write(`UPDATE task_assignments
        SET state = ?,version = ?,assignment_json = ?,updated_at_ms = ?
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
          AND assignment_json = ?`, [
        after.state, after.version, canonicalJsonText(after), Date.parse(after.updatedAt),
        after.scope.workspaceId, after.scope.eventId, before.id, before.version,
        canonicalJsonText(before)
      ]);
      this.bufferEventInsert(plan.event);
    }
    prepared.phase = 'applied';
  }

  private bufferAssignmentInsert(assignment: TaskAssignmentDto): void {
    this.input.unitOfWork.write(`INSERT INTO task_assignments (
      workspace_id,event_id,id,task_definition_id,task_definition_revision_id,
      engagement_id,person_id,state,version,assignment_json,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
      assignment.scope.workspaceId, assignment.scope.eventId, assignment.id,
      assignment.taskDefinitionId, assignment.taskDefinitionRevisionId,
      assignment.engagementId, assignment.personId, assignment.state, assignment.version,
      canonicalJsonText(assignment), Date.parse(assignment.updatedAt)
    ]);
  }

  private bufferEventInsert(event: TaskEventDto): void {
    this.input.unitOfWork.write(`INSERT INTO task_events (
      workspace_id,event_id,id,assignment_id,kind,assignment_version,event_json,occurred_at_ms
    ) VALUES (?,?,?,?,?,?,?,?)`, [
      event.scope.workspaceId, event.scope.eventId, event.id, event.assignmentId,
      event.kind, event.assignmentVersion, canonicalJsonText(event), Date.parse(event.occurredAt)
    ]);
  }

  afterUnitOfWorkCommitted(): void {
    this.#prepared = undefined;
  }
}

export function createD1TaskDirectEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly ids: {
    newTaskDefinitionId(): string;
    newTaskDefinitionRevisionId(): string;
    newDeadlineId(): string;
  };
}): D1EffectDomainAdapterRegistration {
  return Object.freeze({
    capability: TASK_MUTATION_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) => new D1TaskDirectEffectDomainAdapter({
      unitOfWork,
      workspaceId: input.workspaceId,
      ids: input.ids
    })
  });
}
