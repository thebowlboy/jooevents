import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  programVocabularyCreateDraftRequestSchema,
  programVocabularyDeleteDraftRequestSchema,
  programVocabularyEditDraftRequestSchema,
  programVocabularyRestoreDraftRequestSchema,
  programVocabularyRetireDraftRequestSchema,
  type ProgramVocabularyChangeResult,
  type ProgramVocabularyKind
} from '@jooevents/contracts';
import {
  ProgramVocabularyPlanningError,
  parseProgramVocabularyMutationPlan,
  planProgramVocabularyMutation,
  type ProgramReferenceContributorRegistry,
  type ProgramVocabularyAuthorInput,
  type ProgramVocabularyMutationPlan
} from '@jooevents/program';
import {
  PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY,
  PROGRAM_VOCABULARY_DIRECT_PERMISSION_ID,
  programVocabularyDirectContributionSchema,
  sealProgramVocabularyDirectPreparation,
  type ProgramVocabularyDirectAction
} from '@jooevents/program-operations';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
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

export interface SQLiteProgramVocabularyDirectIds {
  newVocabularyItemId(): string;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function actionForOperation(name: string): ProgramVocabularyDirectAction | undefined {
  const match = /^program_vocabulary\.(create|edit|retire|restore|delete)$/.exec(name);
  return match?.[1] as ProgramVocabularyDirectAction | undefined;
}

function itemIdentity(
  action: ProgramVocabularyDirectAction,
  input: unknown,
  generatedId: string | undefined
): { readonly kind: ProgramVocabularyKind; readonly id: string } {
  if (action === 'create') {
    return { kind: programVocabularyCreateDraftRequestSchema.parse(input).kind, id: generatedId! };
  }
  const parsed = (action === 'edit' ? programVocabularyEditDraftRequestSchema
    : action === 'retire' ? programVocabularyRetireDraftRequestSchema
      : action === 'restore' ? programVocabularyRestoreDraftRequestSchema
        : programVocabularyDeleteDraftRequestSchema).parse(input);
  return { kind: parsed.kind, id: parsed.id };
}

function authorInput(input: {
  readonly action: ProgramVocabularyDirectAction;
  readonly businessInput: unknown;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly generatedId?: string;
}): ProgramVocabularyAuthorInput {
  const scope = { workspaceId: input.workspaceId, eventId: input.eventId };
  if (input.action === 'create') {
    const wire = programVocabularyCreateDraftRequestSchema.parse(input.businessInput);
    const id = input.generatedId!;
    if (wire.kind === 'room') {
      return { action: 'create', scope, expectedSetVersion: wire.expectedSetVersion, item: { kind: 'room', id, name: wire.name, capacity: wire.capacity } };
    }
    if (wire.kind === 'track') {
      return { action: 'create', scope, expectedSetVersion: wire.expectedSetVersion, item: { kind: 'track', id, name: wire.name } };
    }
    return { action: 'create', scope, expectedSetVersion: wire.expectedSetVersion, item: { kind: 'format', id, name: wire.name } };
  }
  if (input.action === 'edit') {
    const wire = programVocabularyEditDraftRequestSchema.parse(input.businessInput);
    return { action: 'edit', scope, kind: wire.kind, id: wire.id, expectedSetVersion: wire.expectedSetVersion, expectedItemVersion: wire.expectedItemVersion, changes: wire.changes } as ProgramVocabularyAuthorInput;
  }
  const schema = input.action === 'retire' ? programVocabularyRetireDraftRequestSchema
    : input.action === 'restore' ? programVocabularyRestoreDraftRequestSchema
      : programVocabularyDeleteDraftRequestSchema;
  const wire = schema.parse(input.businessInput);
  return { action: input.action, scope, kind: wire.kind, id: wire.id, expectedSetVersion: wire.expectedSetVersion, expectedItemVersion: wire.expectedItemVersion } as ProgramVocabularyAuthorInput;
}

function resultFor(plan: ProgramVocabularyMutationPlan): ProgramVocabularyChangeResult {
  if (plan.action === 'merge' || plan.action === 'merge_compensation') {
    throw new TypeError('program_vocabulary_direct_merge_forbidden');
  }
  const item = plan.action === 'create' ? plan.after : plan.before;
  return {
    action: plan.action,
    kind: item.kind,
    affectedIds: [item.id],
    setVersion: plan.expectedSetVersion + 1,
    liveRepoints: 0
  };
}

function refusal(input: {
  readonly error: ProgramVocabularyPlanningError;
  readonly action: ProgramVocabularyDirectAction;
  readonly kind: ProgramVocabularyKind;
  readonly id: string;
}) {
  const stale = ['stale_set', 'stale_item', 'stale_reference'].includes(input.error.code);
  return programVocabularyDirectContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: stale ? 'stale_revision' : 'policy_violation',
      kind: stale ? 'program_vocabulary.changed' : 'program_vocabulary.change_refused',
      retryable: false,
      subjects: [{ type: 'program_vocabulary', id: input.id }],
      detail: { code: input.error.code, action: input.action, kind: input.kind, id: input.id },
      detailSchemaVersion: 1
    } },
    domain: null,
    effectContributions: []
  });
}

export class SQLiteProgramVocabularyDirectEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  #prepared: { readonly plan: ProgramVocabularyMutationPlan; readonly repository: SQLiteProgramVocabularyRepository } | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly referenceRegistry: ProgramReferenceContributorRegistry;
    readonly contributors: SQLiteProgramVocabularyContributorAdapterRegistry;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteProgramVocabularyDirectIds;
  }) {}

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('program_vocabulary_direct_transaction_required');
    if (!sameRef(capability, PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY)) throw new TypeError('program_vocabulary_direct_capability_mismatch');
    const action = actionForOperation(context.operation.name);
    if (!action || context.operation.version !== 1 || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http' || context.scope.workspaceId !== this.input.workspaceId) {
      throw new TypeError('program_vocabulary_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user' || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user' || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator' || authority.lane.surface !== 'operator_http'
        || !authority.grants.some((grant) => grant.kind === 'permission' && grant.key === PROGRAM_VOCABULARY_DIRECT_PERMISSION_ID)) {
      throw new TypeError('program_vocabulary_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const workspaceId = parseWorkspaceId(this.input.workspaceId);
    const eventId = context.scope.eventId;
    this.#prepared = undefined;

    return sealProgramVocabularyDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ action: receivedAction, businessInput, context: received }) => {
        if (received !== context || receivedAction !== action || !this.input.sqlite.inTransaction) {
          throw new TypeError('program_vocabulary_direct_context_substitution');
        }
        if (eventId === undefined) {
          return programVocabularyDirectContributionSchema.parse({ result: { kind: 'outcome', outcome: { class: 'conflict', kind: 'program_vocabulary.event_required', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } }, domain: null, effectContributions: [] });
        }
        const parsedEventId = parseEventId(eventId);
        const current = new SQLiteEventSpineRepository(this.input.sqlite).readCurrentEventState(workspaceId);
        const relationship = this.input.eventRelationships.validateEvent({ sqlite: this.input.sqlite, workspaceId, eventId: parsedEventId, userId: actorUserId, evaluatedAt });
        if (relationship.kind !== 'valid' || current?.currentEvent?.id !== parsedEventId) {
          throw new TypeError('program_vocabulary_direct_event_relationship_mismatch');
        }
        const repository = new SQLiteProgramVocabularyRepository(
          this.input.sqlite,
          this.input.referenceRegistry,
          this.input.contributors,
          () => ({ actorUserId, occurredAt: evaluatedAt })
        );
        const generatedId = action === 'create' ? this.input.ids.newVocabularyItemId() : undefined;
        const identity = itemIdentity(action, businessInput, generatedId);
        try {
          const state = repository.readVocabulary({ workspaceId, eventId: parsedEventId });
          if (!state) throw new ProgramVocabularyPlanningError('wrong_scope');
          const plan = planProgramVocabularyMutation({
            authorInput: authorInput({ action, businessInput, workspaceId, eventId: parsedEventId, ...(generatedId ? { generatedId } : {}) }),
            state,
            referenceRegistry: this.input.referenceRegistry,
            referenceSource: repository
          });
          const contribution = programVocabularyDirectContributionSchema.parse({
            result: { kind: 'success', data: resultFor(plan) },
            domain: { kind: 'program_vocabulary_direct_change', plan },
            effectContributions: []
          });
          this.#prepared = { plan, repository };
          return contribution;
        } catch (error) {
          if (error instanceof ProgramVocabularyPlanningError) {
            return refusal({ error, action, ...identity });
          }
          throw error;
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('program_vocabulary_direct_transaction_required');
    const parsed = programVocabularyDirectContributionSchema.parse({ result: { kind: 'success', data: resultFor(parseProgramVocabularyMutationPlan((contribution as { readonly plan?: unknown }).plan)) }, domain: contribution, effectContributions: [] });
    if (parsed.result.kind !== 'success' || parsed.domain === null) throw new TypeError('program_vocabulary_direct_contribution_invalid');
    const prepared = this.#prepared;
    if (!prepared || canonicalJsonText(prepared.plan) !== canonicalJsonText(parsed.domain.plan)) {
      throw new TypeError('program_vocabulary_direct_preparation_invalid');
    }
    prepared.repository.applyVocabularyPlan(prepared.plan);
  }
}

export function createSQLiteProgramVocabularyDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteProgramVocabularyDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteProgramVocabularyDirectEffectDomainAdapter(input)
  });
}
