import { canonicalJsonSha256 } from '@jooevents/kernel';
import {
  taskAssignmentSchema,
  taskBoardSnapshotSchema,
  taskDefinitionCatalogSchema,
  taskDefinitionRevisionSchema,
  taskDefinitionSnapshotSchema,
  taskEventSchema,
  taskScopeSchema,
  type TaskAssignmentDto,
  type TaskBoardSnapshotDto,
  type TaskDefinitionCatalogDto,
  type TaskDefinitionRevisionDto,
  type TaskDefinitionSnapshotDto,
  type TaskEventDto,
  type TaskScopeDto
} from '@jooevents/contracts';


export function parseTaskScope(value: unknown): TaskScopeDto {
  return deepFreeze(taskScopeSchema.parse(value));
}

export function taskRevisionDigest(
  value: Omit<TaskDefinitionRevisionDto, 'digestSha256'>
): string {
  return canonicalJsonSha256(value);
}

export function parseTaskRevision(value: unknown): TaskDefinitionRevisionDto {
  const parsed = taskDefinitionRevisionSchema.parse(value);
  const { digestSha256, ...content } = parsed;
  if (taskRevisionDigest(content) !== digestSha256) throw new TypeError('invalid_task_revision_digest');
  return deepFreeze(parsed);
}

export function parseTaskDefinition(value: unknown): TaskDefinitionSnapshotDto {
  const parsed = taskDefinitionSnapshotSchema.parse(value);
  const current = parseTaskRevision(parsed.current);
  return deepFreeze({ head: parsed.head, current });
}

export function taskCatalogDigest(value: {
  readonly schemaVersion: 1;
  readonly scope: TaskScopeDto;
  readonly version: number;
  readonly definitions: readonly TaskDefinitionSnapshotDto[];
}): string {
  return canonicalJsonSha256({
    schemaVersion: value.schemaVersion,
    scope: value.scope,
    version: value.version,
    definitionHeads: value.definitions.map((entry) => ({
      id: entry.head.id,
      version: entry.head.version,
      revisionId: entry.current.revisionId,
      digestSha256: entry.current.digestSha256
    }))
  });
}

export function createEmptyTaskCatalog(scopeInput: TaskScopeDto): TaskDefinitionCatalogDto {
  const scope = parseTaskScope(scopeInput);
  const value = { schemaVersion: 1 as const, scope, version: 1, definitions: [] };
  return parseTaskCatalog({ ...value, digestSha256: taskCatalogDigest(value) });
}

export function parseTaskCatalog(value: unknown): TaskDefinitionCatalogDto {
  const parsed = taskDefinitionCatalogSchema.parse(value);
  const definitions = parsed.definitions.map(parseTaskDefinition);
  const expected = taskCatalogDigest({
    schemaVersion: 1,
    scope: parsed.scope,
    version: parsed.version,
    definitions
  });
  if (expected !== parsed.digestSha256) throw new TypeError('invalid_task_catalog_digest');
  return deepFreeze({ ...parsed, definitions });
}

export function parseTaskAssignment(value: unknown): TaskAssignmentDto {
  return deepFreeze(taskAssignmentSchema.parse(value));
}

export function parseTaskEvent(value: unknown): TaskEventDto {
  return deepFreeze(taskEventSchema.parse(value));
}

export function parseTaskBoard(value: unknown): TaskBoardSnapshotDto {
  const parsed = taskBoardSnapshotSchema.parse(value);
  const definitions = parsed.definitions.map(parseTaskDefinition);
  const assignments = parsed.assignments.map(parseTaskAssignment);
  const catalog = parseTaskCatalog({
    schemaVersion: 1,
    scope: parsed.scope,
    version: parsed.catalogVersion,
    digestSha256: parsed.catalogDigestSha256,
    definitions
  });
  return deepFreeze({ ...parsed, definitions: catalog.definitions, assignments });
}

function uuidFromDigest(digest: string): string {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}`
    + `-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function deterministicTaskAssignmentId(input: {
  readonly scope: TaskScopeDto;
  readonly taskDefinitionId: string;
  readonly engagementId: string;
}): string {
  return uuidFromDigest(canonicalJsonSha256({ domain: 'task_assignment', ...input }));
}

export function deterministicTaskEventId(input: {
  readonly assignmentId: string;
  readonly assignmentVersion: number;
  readonly kind: TaskEventDto['kind'];
}): string {
  return uuidFromDigest(canonicalJsonSha256({ domain: 'task_event', ...input }));
}

export function taskDefinitionAggregateId(id: string): string {
  return `task_definition:${id}`;
}
export function taskAssignmentAggregateId(id: string): string {
  return `task_assignment:${id}`;
}
export function taskCatalogGuardId(eventId: string): string {
  return `task_catalog:${eventId}`;
}
export function taskMembershipGuardId(eventId: string): string {
  return `task_membership:${eventId}`;
}

export interface TaskReadPort {
  readTaskCatalog(scope: TaskScopeDto): TaskDefinitionCatalogDto | undefined;
  readTaskAssignment(scope: TaskScopeDto, assignmentId: string): TaskAssignmentDto | undefined;
  readTaskBoard(scope: TaskScopeDto): TaskBoardSnapshotDto | undefined;
}

export interface TaskEventReadPort {
  readTaskEvent(scope: TaskScopeDto, assignmentId: string, assignmentVersion: number): TaskEventDto | undefined;
}

export interface TaskTransactionPort extends TaskReadPort {
  applyTaskPlan(plan: import('@jooevents/contracts').TaskMutationPlanDto
    | import('@jooevents/contracts').TaskAssignmentRestorePlanDto):
    import('@jooevents/contracts').TaskMutationResultDto;
  applyEngagementReconciliation(
    plan: import('./engagement-collaboration').TaskEngagementReconciliationPlan
  ): { readonly action: 'materialize' | 'waive'; readonly assignmentIds: readonly string[] };
}

export interface ConfirmedTaskEngagement {
  readonly engagementId: string;
  readonly personId: string;
  readonly version: number;
  readonly state: 'confirmed';
}

export interface TaskMembershipSource {
  listConfirmedTaskEngagements(scope: TaskScopeDto): readonly ConfirmedTaskEngagement[];
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
