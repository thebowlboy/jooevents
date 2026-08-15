import type { Database } from 'bun:sqlite';
import {
  effectOperationIdentitiesEqual,
  effectOperationIdentityMatchesContext,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import type { ChangesetPlanningSnapshot, ChangesetReadPortKey } from '@jooevents/changesets';
import { appendChangesetDraftSynchronous } from '@jooevents/changeset-operations';
import {
  schedulePlacementInputSchema,
  type SchedulePlacementInput,
  type SchedulePlacementPlanningInput
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  isApplicationId,
  parseChangesetId,
  parseChangesetRevisionId,
  parseInstant,
  parseOperationReceiptId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  createSchedulePlacementChangesetBundle,
  parseScheduleOccurrenceId,
  schedulePlacementReadPort,
  SchedulePlacementPlanningError,
  SCHEDULE_PLACEMENT_CHANGESET_KIND,
  SCHEDULE_PLACEMENT_CHANGESET_VERSION,
  type PlaceableSessionIdentityPort
} from '@jooevents/schedule';
import {
  SCHEDULE_PLACEMENT_APPROVAL_POLICY,
  SCHEDULE_PLACEMENT_DRAFT_HANDLER_CAPABILITY,
  SCHEDULE_PLACEMENT_DRAFT_OPERATION,
  SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
  schedulePlacementDraftContributionSchema,
  schedulePlacementDraftDomainContributionSchema,
  schedulePlacementDraftEvidenceChildSchema,
  schedulePlacementDraftOperationResultSchema,
  sealSchedulePlacementDraftPreparation,
  type SchedulePlacementDraftContribution
} from '@jooevents/schedule-operations';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import { createSQLiteDraftOnlyChangesetLifecycleStore } from './changeset-lifecycle';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import type { SQLiteProgramVocabularyRepository } from './program-vocabulary';
import { SQLiteSchedulePlacementRepository } from './schedule-placement';

export const SCHEDULE_PLACEMENT_DRAFT_EFFECT_SQL = `
CREATE TABLE schedule_placement_draft_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  revision_digest_sha256 TEXT NOT NULL CHECK(
    length(revision_digest_sha256) = 64
    AND revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  record_digest_sha256 TEXT NOT NULL CHECK(
    length(record_digest_sha256) = 64
    AND record_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  action TEXT NOT NULL CHECK(action IN ('place', 'move')),
  operation_name TEXT NOT NULL CHECK(operation_name = 'schedule.placement.draft'),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (receipt_id) REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id, workspace_id, event_id)
    REFERENCES changeset_heads(changeset_id, workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changeset_id, revision_id, revision_digest_sha256)
    REFERENCES changeset_revisions(changeset_id, revision_id, revision_digest_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(receipt_id, workspace_id, event_id, changeset_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE schedule_placement_draft_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'changeset_revision'),
  FOREIGN KEY (receipt_id, workspace_id, event_id, changeset_id, revision_id)
    REFERENCES schedule_placement_draft_receipt_links(
      receipt_id, workspace_id, event_id, changeset_id, revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER schedule_placement_draft_receipt_links_no_update
BEFORE UPDATE ON schedule_placement_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'schedule placement draft receipt links are immutable'); END;
CREATE TRIGGER schedule_placement_draft_receipt_links_no_delete
BEFORE DELETE ON schedule_placement_draft_receipt_links
BEGIN SELECT RAISE(ABORT, 'schedule placement draft receipt links are immutable'); END;
CREATE TRIGGER schedule_placement_draft_timeline_no_update
BEFORE UPDATE ON schedule_placement_draft_timeline
BEGIN SELECT RAISE(ABORT, 'schedule placement draft timeline is immutable'); END;
CREATE TRIGGER schedule_placement_draft_timeline_no_delete
BEFORE DELETE ON schedule_placement_draft_timeline
BEGIN SELECT RAISE(ABORT, 'schedule placement draft timeline is immutable'); END;
`;

export function installSchedulePlacementDraftEffectSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('schedule_placement_draft_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SCHEDULE_PLACEMENT_DRAFT_EFFECT_SQL)).immediate();
}

export interface SQLiteSchedulePlacementDraftEffectIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newOccurrenceId(): string;
  newPreparationHandle(): string;
  newTimelineId(): string;
}

type DraftSuccess = Extract<
  SchedulePlacementDraftContribution,
  { readonly result: { readonly kind: 'success' } }
>;

interface PreparedDraft {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly contribution: DraftSuccess;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete';
  receiptId?: string;
}

function applicationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isApplicationId(value)) {
    throw new TypeError(`schedule_placement_draft_${label}_invalid`);
  }
  return value;
}

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext, eventId?: EventId): boolean {
  return context.scope.eventId === eventId
    && context.scope.subjects.length === (eventId === undefined ? 1 : 2)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && (eventId === undefined || context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId
    ));
}

function planningInput(input: {
  readonly wire: SchedulePlacementInput;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly newOccurrenceId: () => string;
}): SchedulePlacementPlanningInput {
  const scope = { workspaceId: input.workspaceId, eventId: input.eventId };
  return input.wire.action === 'place'
    ? {
        ...input.wire,
        scope,
        occurrenceId: parseScheduleOccurrenceId(input.newOccurrenceId())
      }
    : { ...input.wire, scope };
}

function eventRequiredContribution(): SchedulePlacementDraftContribution {
  return schedulePlacementDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'schedule.event_required', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function collisionContribution(): SchedulePlacementDraftContribution {
  return schedulePlacementDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'changeset.id_collision', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    receiptChildren: []
  });
}

function planningRefusal(
  error: SchedulePlacementPlanningError,
  input: SchedulePlacementPlanningInput
): SchedulePlacementDraftContribution {
  if (error.code === 'room_overlap' && error.conflict) {
    return schedulePlacementDraftContributionSchema.parse({
      result: {
        kind: 'outcome',
        outcome: {
          class: 'conflict', kind: 'schedule_room_overlap', retryable: false,
          subjects: [{ type: 'schedule_occurrence', id: input.occurrenceId }],
          detail: error.conflict,
          detailSchemaVersion: 1
        }
      },
      domain: null,
      receiptChildren: []
    });
  }
  return schedulePlacementDraftContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'stale_revision', kind: 'schedule_placement_changed', retryable: false,
        subjects: [{ type: 'schedule_occurrence', id: input.occurrenceId }],
        detail: { code: error.code, action: input.action, occurrenceId: input.occurrenceId },
        detailSchemaVersion: 2
      }
    },
    domain: null,
    receiptChildren: []
  });
}

export class SQLiteSchedulePlacementDraftEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly scheduleRead: Pick<SQLiteSchedulePlacementRepository, 'readSchedule'>;
  readonly #changesets;
  readonly #ids: SQLiteSchedulePlacementDraftEffectIds;
  readonly #prepared = new Map<string, PreparedDraft>();
  readonly #issuedIds = new Set<string>();
  #active: PreparedDraft | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;
  #nonterminalReleaseContext: EffectInvocationContext | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly sessions: PlaceableSessionIdentityPort;
    readonly vocabulary: SQLiteProgramVocabularyRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteSchedulePlacementDraftEffectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    this.#changesets = createSQLiteDraftOnlyChangesetLifecycleStore(input.sqlite);
    for (const method of [
      'newChangesetId', 'newRevisionId', 'newOccurrenceId',
      'newPreparationHandle', 'newTimelineId'
    ] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('schedule_placement_draft_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      (['newChangesetId', 'newRevisionId', 'newOccurrenceId',
        'newPreparationHandle', 'newTimelineId'] as const)
        .map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteSchedulePlacementDraftEffectIds);
    const readRepository = this.repository(
      parseUserId('00000000-0000-4000-8000-000000000001'),
      parseInstant('1970-01-01T00:00:00.000Z')
    );
    this.scheduleRead = Object.freeze({
      readSchedule: readRepository.readSchedule.bind(readRepository)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('schedule_placement_draft_transaction_required');
    }
    if (!sameReference(capability, SCHEDULE_PLACEMENT_DRAFT_HANDLER_CAPABILITY)) {
      throw new TypeError('schedule_placement_draft_capability_mismatch');
    }
    if (context.operation.name !== SCHEDULE_PLACEMENT_DRAFT_OPERATION.name
        || context.operation.version !== SCHEDULE_PLACEMENT_DRAFT_OPERATION.version
        || context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context, context.scope.eventId)) {
      throw new TypeError('schedule_placement_draft_scope_mismatch');
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
        || !sameReference(authority.lane.policy, SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'schedule.manage'
        )) throw new TypeError('schedule_placement_draft_authority_mismatch');
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.input.workspaceId);
    if (eventId === undefined) {
      if (!current || current.currentEvent !== undefined) {
        throw new TypeError('schedule_placement_draft_event_relationship_mismatch');
      }
      this.#prepared.clear();
      this.#active = undefined;
      this.#expectedIdentity = undefined;
      this.#nonterminalReleaseContext = undefined;
      return sealSchedulePlacementDraftPreparation({
        capability,
        context,
        preparation: {
          prepare: ({ businessInput, context: receivedContext }) => {
            if (receivedContext !== context || !this.input.sqlite.inTransaction) {
              throw new TypeError('schedule_placement_draft_context_substitution');
            }
            schedulePlacementInputSchema.parse(businessInput);
            this.#nonterminalReleaseContext = context;
            return eventRequiredContribution();
          }
        }
      });
    }
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
      throw new TypeError('schedule_placement_draft_event_relationship_mismatch');
    }
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;

    const repository = this.repository(actorUserId, evaluatedAt);
    const bundle = createSchedulePlacementChangesetBundle();
    const snapshot: ChangesetPlanningSnapshot = Object.freeze({
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== schedulePlacementReadPort) {
          throw new TypeError('schedule_placement_draft_undeclared_read_port');
        }
        return repository as unknown as Port;
      }
    });

    return sealSchedulePlacementDraftPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('schedule_placement_draft_context_substitution');
          }
          const wire = schedulePlacementInputSchema.parse(businessInput);
          const changesetId = parseChangesetId(this.nextId('newChangesetId'));
          const revisionId = parseChangesetRevisionId(this.nextId('newRevisionId'));
          const handle = this.nextId('newPreparationHandle');
          const timelineId = this.nextId('newTimelineId');
          const author = planningInput({
            wire,
            workspaceId: this.input.workspaceId,
            eventId,
            newOccurrenceId: () => this.nextId('newOccurrenceId')
          });
          const before = repository.readSchedule({ workspaceId: this.input.workspaceId, eventId });
          if (!before) throw new TypeError('schedule_placement_draft_scope_missing');
          let appended: ReturnType<typeof appendChangesetDraftSynchronous>;
          try {
            appended = appendChangesetDraftSynchronous({
              store: this.#changesets,
              registry: bundle.registry,
              snapshot,
              ids: {
                newChangesetId: () => changesetId,
                newRevisionId: () => revisionId,
                newApprovalId: () => { throw new TypeError('approval_id_unavailable_during_draft'); },
                newCorrectionAttemptId: () => {
                  throw new TypeError('correction_id_unavailable_during_draft');
                }
              },
              context: {
                workspaceId: this.input.workspaceId,
                eventId,
                principalKey: `workspace_user:${actorUserId}`,
                authorityPrincipalKey: context.authorityPrincipalKey,
                evaluatedAt
              },
              operations: [{
                kind: SCHEDULE_PLACEMENT_CHANGESET_KIND,
                version: SCHEDULE_PLACEMENT_CHANGESET_VERSION,
                dependencyGroup: 'schedule_placement',
                authorInput: author
              }],
              dependencyGroups: [{ key: 'schedule_placement', dependsOn: [] }],
              approvalPolicy: SCHEDULE_PLACEMENT_APPROVAL_POLICY,
              origin: 'human_ui'
            });
          } catch (error) {
            if (error instanceof SchedulePlacementPlanningError) {
              this.#nonterminalReleaseContext = context;
              return planningRefusal(error, author);
            }
            throw error;
          }
          if (appended.kind === 'refused') {
            if (appended.refusal.kind !== 'id_collision') {
              throw new TypeError('schedule_placement_draft_unexpected_lifecycle_refusal');
            }
            this.#nonterminalReleaseContext = context;
            return collisionContribution();
          }
          const after = repository.readSchedule({ workspaceId: this.input.workspaceId, eventId });
          if (!after || canonicalJsonText(after) !== canonicalJsonText(before)) {
            throw new TypeError('schedule_placement_draft_mutated_effective_state');
          }
          const revision = appended.record.revisions[0];
          const operation = revision?.revision.operations[0];
          if (!revision || !operation
              || appended.record.revisions.length !== 1
              || revision.revision.operations.length !== 1) {
            throw new TypeError('schedule_placement_draft_record_incoherent');
          }
          const candidate = schedulePlacementDraftContributionSchema.parse({
            result: {
              kind: 'success',
              data: {
                schemaVersion: 1,
                action: wire.action,
                changesetId,
                headVersion: appended.record.head.version,
                status: appended.record.head.status,
                revision: {
                  id: revision.revision.id,
                  number: revision.revision.number,
                  digestSha256: revision.revision.digest
                },
                riskTier: revision.revision.riskTier,
                approvalPolicy: revision.approvalPolicy,
                safeDiff: operation.safeDiff
              }
            },
            domain: {
              kind: 'schedule_placement_changeset_draft',
              preparationHandle: handle,
              workspaceId: this.input.workspaceId,
              eventId,
              changesetId,
              revisionId,
              revisionDigestSha256: revision.revision.digest,
              recordDigestSha256: appended.record.recordDigestSha256,
              action: wire.action,
              occurredAt: evaluatedAt
            },
            receiptChildren: [{
              kind: 'timeline',
              timelineId,
              sourceKind: 'changeset_revision',
              workspaceId: this.input.workspaceId,
              eventId,
              changesetId,
              revisionId,
              occurredAt: evaluatedAt
            }]
          });
          if (candidate.result.kind !== 'success' || candidate.domain === null) {
            throw new TypeError('schedule_placement_draft_success_contribution_invalid');
          }
          const contribution = candidate as DraftSuccess;
          this.#prepared.set(handle, {
            handle,
            context,
            contribution,
            phase: 'prepared'
          });
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('schedule_placement_draft_transaction_required');
    }
    const parsed = schedulePlacementDraftDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)) {
      throw new TypeError('schedule_placement_draft_preparation_invalid');
    }
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    const active = this.#active;
    const parsedResult = schedulePlacementDraftOperationResultSchema.safeParse(receipt.result);
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'applied'
        || !effectOperationIdentityMatchesContext(receipt.identity, active.context)
        || receipt.requestHash !== active.context.requestBinding.requestHashSha256
        || receipt.ref.operationName !== SCHEDULE_PLACEMENT_DRAFT_OPERATION.name
        || receipt.ref.operationVersion !== SCHEDULE_PLACEMENT_DRAFT_OPERATION.version
        || !parsedResult.success || parsedResult.data.kind !== 'success'
        || parsedResult.data.receipt.id !== receipt.ref.id
        || canonicalJsonText(parsedResult.data.data)
          !== canonicalJsonText(active.contribution.result.data)) {
      throw new TypeError('schedule_placement_draft_receipt_mismatch');
    }
    const domain = active.contribution.domain;
    const receiptId = parseOperationReceiptId(receipt.ref.id);
    this.input.sqlite.query<never, [
      string, string, string, string, string, string, string, string, string,
      number, number
    ]>(`
      INSERT INTO schedule_placement_draft_receipt_links (
        receipt_id, workspace_id, event_id, changeset_id, revision_id,
        revision_digest_sha256, record_digest_sha256, action,
        operation_name, operation_version, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, domain.workspaceId, domain.eventId, domain.changesetId, domain.revisionId,
      domain.revisionDigestSha256, domain.recordDigestSha256, domain.action,
      active.context.operation.name, active.context.operation.version,
      Date.parse(domain.occurredAt)
    );
    active.receiptId = receiptId;
    active.phase = 'parent_linked';
    this.#expectedIdentity = receipt.identity;
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.input.sqlite.inTransaction || !active || active.phase !== 'parent_linked'
        || !this.#expectedIdentity || active.receiptId !== receiptId) {
      throw new TypeError('schedule_placement_draft_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[0];
    if (canonicalJsonText(contribution) !== canonicalJsonText(expected)) {
      throw new TypeError('schedule_placement_draft_evidence_mismatch');
    }
    const child = schedulePlacementDraftEvidenceChildSchema.parse(contribution);
    this.input.sqlite.query<never, [string, string, string, string, string, string, number, string]>(`
      INSERT INTO schedule_placement_draft_timeline (
        timeline_id, receipt_id, workspace_id, event_id, changeset_id,
        revision_id, occurred_at_ms, source_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      child.timelineId, receiptId, child.workspaceId, child.eventId,
      child.changesetId, child.revisionId, Date.parse(child.occurredAt), child.sourceKind
    );
    active.phase = 'evidence_complete';
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('schedule_placement_draft_transaction_required');
    }
    const active = this.#active;
    if (!active) {
      const context = this.#nonterminalReleaseContext;
      if (!context || !effectOperationIdentityMatchesContext(identity, context)) {
        throw new TypeError('schedule_placement_draft_incomplete');
      }
      this.#nonterminalReleaseContext = undefined;
      return;
    }
    if (active.phase !== 'evidence_complete' || !this.#expectedIdentity
        || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('schedule_placement_draft_incomplete');
    }
  }

  afterUnitOfWorkCommitted(): void {
    this.#active = undefined;
    this.#expectedIdentity = undefined;
    this.#nonterminalReleaseContext = undefined;
    this.#prepared.clear();
  }

  private nextId(method: keyof SQLiteSchedulePlacementDraftEffectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('schedule_placement_draft_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }

  private repository(actorUserId: UserId, evaluatedAt: Instant): SQLiteSchedulePlacementRepository {
    return new SQLiteSchedulePlacementRepository(
      this.input.sqlite,
      this.input.sessions,
      this.input.vocabulary,
      () => ({ actorUserId, occurredAt: evaluatedAt })
    );
  }
}

export function createSQLiteSchedulePlacementDraftEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly sessions: PlaceableSessionIdentityPort;
  readonly vocabulary: SQLiteProgramVocabularyRepository;
  readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  readonly ids: SQLiteSchedulePlacementDraftEffectIds;
}) {
  const adapter = new SQLiteSchedulePlacementDraftEffectDomainAdapter(input);
  return Object.freeze({
    capability: SCHEDULE_PLACEMENT_DRAFT_HANDLER_CAPABILITY,
    adapter,
    scheduleRead: adapter.scheduleRead
  });
}
