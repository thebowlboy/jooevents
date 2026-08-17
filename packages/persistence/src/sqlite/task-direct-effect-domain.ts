import type { Database } from 'bun:sqlite';
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
  type TaskScopeDto
} from '@jooevents/contracts';
import {
  planTaskAssignmentRestore,
  planTaskMutation,
  TaskPlanningError
} from '@jooevents/tasks';
import {
  TASK_MANAGE_ACCESS_POLICY,
  TASK_MANAGE_PERMISSION_ID,
  TASK_MUTATION_HANDLER_CAPABILITY,
  TASK_MUTATION_OPERATION,
  taskDirectContributionSchema,
  sealTaskDirectPreparation
} from '@jooevents/task-operations';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import type { SQLiteEffectDomainAdapter, SQLiteEffectDomainAdapterRegistration } from './foundation-trial-uow';
import { SQLiteDeadlineRepository } from './deadline';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteTaskRepository } from './tasks';
import type { SQLiteVerifiedInboxAttributionResolver } from './verified-inbox-attribution';

function sameRef(left: { readonly key: string; readonly version: number }, right: { readonly key: string; readonly version: number }) {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId !== undefined && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) => subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) => subject.kind === 'event' && subject.id === context.scope.eventId);
}

function refusal(error: TaskPlanningError, scope: TaskScopeDto, action: string, subjectId: string) {
  return taskDirectContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: 'stale_revision', kind: 'task.changed', retryable: false,
      subjects: [{ type: 'event', id: scope.eventId }],
      detail: { code: error.code, action, subjectId: error.subjectId ?? subjectId },
      detailSchemaVersion: 1
    } }, domain: null, effectContributions: []
  });
}

export interface SQLiteTaskDirectIds {
  newTaskDefinitionId(): string;
  newTaskDefinitionRevisionId(): string;
  newDeadlineId(): string;
}

export class SQLiteTaskDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #tasks: SQLiteTaskRepository;
  readonly #deadlines: SQLiteDeadlineRepository;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteTaskDirectIds;
    readonly verifiedInboxAttribution?: SQLiteVerifiedInboxAttributionResolver;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#tasks = new SQLiteTaskRepository(input.sqlite);
    this.#deadlines = new SQLiteDeadlineRepository(input.sqlite, new SQLiteEventSpineRepository(input.sqlite));
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('task_direct_transaction_required');
    if (!sameRef(capability, TASK_MUTATION_HANDLER_CAPABILITY)) throw new TypeError('task_direct_capability_mismatch');
    if (context.operation.name !== TASK_MUTATION_OPERATION.name
        || context.operation.version !== TASK_MUTATION_OPERATION.version
        || context.operation.effect !== 'commit'
        || (context.surface !== 'operator_http' && context.surface !== 'provider_ingress')
        || context.scope.workspaceId !== this.#workspaceId || !exactSubjects(context)) {
      throw new TypeError('task_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    const operator = authority.actor.kind === 'workspace_user'
      && authority.principal.kind === 'workspace_user'
      && authority.actor.userId === authority.principal.userId
      && context.actor.kind === 'workspace_user' && context.actor.userId === authority.actor.userId
      && authority.lane.kind === 'operator' && authority.lane.surface === 'operator_http';
    const inbox = authority.actor.kind === 'verified_inbox_processing'
      && authority.principal.kind === 'verified_inbox_processing'
      && context.actor.kind === 'verified_inbox_processing'
      && authority.actor.inboxReceiptId === authority.principal.inboxReceiptId
      && context.actor.inboxReceiptId === authority.actor.inboxReceiptId
      && authority.lane.kind === 'verified_inbox' && authority.lane.surface === 'provider_ingress';
    if ((!operator && !inbox)
        || !sameRef(authority.lane.policy, TASK_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) => grant.kind === 'permission' && grant.key === TASK_MANAGE_PERMISSION_ID)) {
      throw new TypeError('task_direct_authority_mismatch');
    }
    const eventId = context.scope.eventId!;
    const actorUserId = authority.actor.kind === 'workspace_user'
      ? parseUserId(authority.actor.userId)
      : authority.actor.kind === 'verified_inbox_processing'
        ? this.input.verifiedInboxAttribution?.resolve({
          sourceConnectionId: authority.actor.sourceConnectionId,
          workspaceId: this.#workspaceId, eventId, evaluatedAt
        }) : undefined;
    if (!actorUserId) throw new TypeError('task_direct_verified_inbox_attribution_missing');
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.#workspaceId);
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite,
      workspaceId: this.#workspaceId,
      eventId,
      userId: actorUserId,
      evaluatedAt
    });
    if (relationship.kind !== 'valid' || current?.currentEvent?.id !== eventId) {
      throw new TypeError('task_direct_current_event_mismatch');
    }
    const scope = { workspaceId: this.#workspaceId, eventId };
    return sealTaskDirectPreparation({ capability, context, preparation: {
      prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) throw new TypeError('task_direct_context_substitution');
        const wire = taskMutationInputSchema.parse(businessInput);
        try {
          const plan = wire.action === 'restore_assignment'
            ? (() => {
                const current = this.#tasks.readTaskAssignment(scope, wire.assignmentId);
                if (!current) throw new TaskPlanningError('assignment_missing', wire.assignmentId);
                if (current.version !== wire.expectedVersion) throw new TaskPlanningError('stale_assignment', wire.assignmentId);
                const latestEvent = this.#tasks.readTaskEvent(scope, current.id, current.version);
                if (!latestEvent) throw new TaskPlanningError('invalid_transition', current.id);
                return planTaskAssignmentRestore({ current, latestEvent, actorUserId, occurredAt: evaluatedAt });
              })()
            : planTaskMutation(wire.action === 'create_definition' ? {
                ...wire, scope,
                taskDefinitionId: this.input.ids.newTaskDefinitionId(),
                revisionId: this.input.ids.newTaskDefinitionRevisionId(),
                deadlineId: this.input.ids.newDeadlineId(), actorUserId, occurredAt: evaluatedAt
              } : { ...wire, scope, actorUserId, occurredAt: evaluatedAt }, {
                tasks: this.#tasks, memberships: this.#tasks, deadlines: this.#deadlines
              });
          const data = plan.action === 'create_definition'
            ? { schemaVersion: 1, action: plan.action, definition: plan.definition, assignments: plan.assignments }
            : { schemaVersion: 1, action: plan.action, assignment: plan.action === 'restore_assignment' ? plan.restore : plan.after };
          return taskDirectContributionSchema.parse({
            result: { kind: 'success', data: taskMutationDataSchema.parse(data) },
            domain: { kind: 'task_direct_mutation', plan }, effectContributions: []
          });
        } catch (error) {
          if (error instanceof TaskPlanningError) {
            const subjectId = wire.action === 'create_definition' ? scope.eventId : wire.assignmentId;
            return refusal(error, scope, wire.action, subjectId);
          }
          throw error;
        }
      }
    } });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('task_direct_transaction_required');
    if ((contribution as { readonly kind?: unknown })?.kind !== 'task_direct_mutation') {
      throw new TypeError('task_direct_contribution_invalid');
    }
    const candidate = (contribution as { readonly plan?: unknown }).plan;
    const plan = taskMutationPlanSchema.safeParse(candidate);
    const parsed = plan.success ? plan.data : taskAssignmentRestorePlanSchema.parse(candidate);
    if (parsed.action === 'create_definition') this.#deadlines.applyDeadlinePlan(parsed.deadlineContribution);
    this.#tasks.applyTaskPlan(parsed);
  }
}

export function createSQLiteTaskDirectEffectDomainRegistration(input: ConstructorParameters<typeof SQLiteTaskDirectEffectDomainAdapter>[0]): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({ capability: TASK_MUTATION_HANDLER_CAPABILITY, adapter: new SQLiteTaskDirectEffectDomainAdapter(input) });
}
