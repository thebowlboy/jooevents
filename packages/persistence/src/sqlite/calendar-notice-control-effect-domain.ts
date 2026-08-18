import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  CALENDAR_NOTICE_CONTROL_HANDLER_CAPABILITY,
  CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION,
  CALENDAR_NOTICE_MANAGE_ACCESS_POLICY,
  CALENDAR_NOTICE_MANAGE_PERMISSION_ID,
  calendarNoticeControlContributionSchema,
  calendarNoticeControlDomainContributionSchema,
  sealCalendarNoticeControlPreparation
} from '@jooevents/calendar-operations';
import {
  calendarNoticeGenerationControlInputSchema,
  calendarNoticeGenerationSchema,
  type CalendarNoticeGenerationDto
} from '@jooevents/contracts/calendar';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import {
  SQLiteCalendarCanonicalStateError,
  SQLiteCalendarCanonicalStateRepository,
  type CalendarNoticeGenerationSummary
} from './calendar-canonical-state';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

function sameRef(left: { readonly key: string; readonly version: number }, right: {
  readonly key: string; readonly version: number;
}) {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId !== undefined && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === context.scope.eventId);
}

function dto(generation: CalendarNoticeGenerationSummary): CalendarNoticeGenerationDto {
  return calendarNoticeGenerationSchema.parse({
    generationId: generation.generationId,
    personId: generation.personId,
    generationNumber: generation.generationNumber,
    state: generation.state,
    openedAt: generation.openedAt,
    sealAt: generation.sealAt,
    held: generation.held,
    sealReason: generation.sealReason,
    sealedAt: generation.sealedAt,
    communicationReleaseId: generation.communicationReleaseId,
    version: generation.version,
    pendingUpdateCount: generation.netItemCount
  });
}

export class SQLiteCalendarNoticeControlEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly read;
  readonly #workspaceId: WorkspaceId;
  readonly #repository: SQLiteCalendarCanonicalStateRepository;
  #kickPending = false;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly kick: () => void | Promise<void>;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#repository = new SQLiteCalendarCanonicalStateRepository(input.sqlite);
    this.read = Object.freeze({
      listNoticeGenerations: (scope: { workspaceId: string; eventId: string }) =>
        this.#repository.listNoticeGenerations(scope).map(dto)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('calendar_notice_control_transaction_required');
    if (!sameRef(capability, CALENDAR_NOTICE_CONTROL_HANDLER_CAPABILITY)) {
      throw new TypeError('calendar_notice_control_capability_mismatch');
    }
    if (context.operation.name !== CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION.name
        || context.operation.version !== CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION.version
        || context.operation.effect !== 'commit' || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId || !exactSubjects(context)) {
      throw new TypeError('calendar_notice_control_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user' || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user' || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator' || authority.lane.surface !== 'operator_http'
        || !sameRef(authority.lane.policy, CALENDAR_NOTICE_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === CALENDAR_NOTICE_MANAGE_PERMISSION_ID)) {
      throw new TypeError('calendar_notice_control_authority_mismatch');
    }
    const eventId = context.scope.eventId!;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.#workspaceId);
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite,
      workspaceId: this.#workspaceId,
      eventId,
      userId: parseUserId(authority.actor.userId),
      evaluatedAt
    });
    if (relationship.kind !== 'valid' || current?.currentEvent?.id !== eventId) {
      throw new TypeError('calendar_notice_control_event_relationship_mismatch');
    }
    return sealCalendarNoticeControlPreparation({
      capability,
      context,
      prepare: (businessInput) => {
        const command = calendarNoticeGenerationControlInputSchema.parse(businessInput);
        const scope = { workspaceId: this.#workspaceId, eventId };
        const generation = this.#repository.listNoticeGenerations(scope)
          .find((candidate) => candidate.generationId === command.generationId);
        if (!generation || generation.state !== 'open'
            || generation.version !== command.expectedVersion) {
          return calendarNoticeControlContributionSchema.parse({
            result: { kind: 'outcome', outcome: {
              class: 'stale_revision', kind: 'calendar.notice_generation_changed',
              retryable: false, subjects: [{ type: 'calendar_notice_generation', id: command.generationId }],
              detail: null, detailSchemaVersion: 1
            } },
            domain: null,
            effectContributions: []
          });
        }
        const after: CalendarNoticeGenerationSummary = command.action === 'set_hold'
          ? { ...generation, held: command.held, version: generation.version + 1 }
          : {
              ...generation, state: 'sealed', held: generation.held,
              sealReason: 'manual_release', sealedAt: evaluatedAt,
              version: generation.version + 1
            };
        return calendarNoticeControlContributionSchema.parse({
          result: { kind: 'success', data: {
            schemaVersion: 1, action: command.action, generation: dto(after)
          } },
          domain: {
            kind: 'calendar_notice_generation_control', input: command, scope, occurredAt: evaluatedAt
          },
          effectContributions: []
        });
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('calendar_notice_control_transaction_required');
    const parsed = calendarNoticeControlDomainContributionSchema.parse(contribution);
    try {
      if (parsed.input.action === 'set_hold') {
        this.#repository.setGenerationHold(
          parsed.input.generationId, parsed.input.expectedVersion, parsed.input.held
        );
      } else {
        this.#repository.sealGeneration({
          generationId: parsed.input.generationId,
          expectedVersion: parsed.input.expectedVersion,
          reason: 'manual_release',
          sealedAt: parsed.occurredAt
        });
        this.#kickPending = true;
      }
    } catch (error) {
      if (error instanceof SQLiteCalendarCanonicalStateError) throw error;
      throw error;
    }
  }

  async afterUnitOfWorkCommitted(): Promise<void> {
    if (this.#kickPending) await this.input.kick();
    this.#kickPending = false;
  }

  afterUnitOfWorkFinished(): void {
    this.#kickPending = false;
  }
}

export function createSQLiteCalendarNoticeControlEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteCalendarNoticeControlEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration & {
  readonly read: SQLiteCalendarNoticeControlEffectDomainAdapter['read'];
} {
  const adapter = new SQLiteCalendarNoticeControlEffectDomainAdapter(input);
  return Object.freeze({
    capability: CALENDAR_NOTICE_CONTROL_HANDLER_CAPABILITY,
    adapter,
    read: adapter.read
  });
}
