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
  type ProgramVocabularyKind,
  type ProgramVocabularySnapshotDto
} from '@jooevents/contracts';
import {
  canonicalJsonSha256,
  canonicalJsonText,
  parseAggregateVersion,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  ProgramVocabularyPlanningError,
  createProgramReferenceContributorRegistry,
  parseProgramVocabularyMutationPlan,
  parseProgramVocabularyState,
  planProgramVocabularyMutation,
  type ProgramReferenceContributorRef,
  type ProgramReferenceContributorSnapshot,
  type ProgramReferenceRecord,
  type ProgramReferenceSnapshotSource,
  type ProgramVocabularyAuthorInput,
  type ProgramVocabularyMutationPlan,
  type ProgramVocabularyState
} from '@jooevents/program';
import {
  PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY,
  PROGRAM_VOCABULARY_DIRECT_PERMISSION_ID,
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  programVocabularyDirectContributionSchema,
  sealProgramVocabularyDirectPreparation,
  type ProgramVocabularyDirectAction
} from '@jooevents/program-operations';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';
import { createD1ProgramVocabularySnapshotReadSource } from './d1-program-vocabulary';

const INTAKE_FORM_CONTRIBUTOR = Object.freeze({ key: 'intake.forms', version: 1 });
const SCHEDULE_OCCURRENCE_CONTRIBUTOR = Object.freeze({
  key: 'schedule.occurrences', version: 1
});
const REFERENCE_CONTRIBUTORS = Object.freeze([
  INTAKE_FORM_CONTRIBUTOR,
  SCHEDULE_OCCURRENCE_CONTRIBUTOR
]);
const referenceRegistry = createProgramReferenceContributorRegistry({
  expected: REFERENCE_CONTRIBUTORS,
  contributors: REFERENCE_CONTRIBUTORS
});

interface EventSetRow {
  readonly version: number;
  readonly current_event_id: string | null;
}

interface SessionTargetRow {
  readonly id: unknown;
  readonly format_id: unknown;
  readonly track_id: unknown;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  const expected = eventId === undefined ? 1 : 2;
  return context.scope.subjects.length === expected
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && (eventId === undefined || context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId));
}

function actionForOperation(name: string, version: number): ProgramVocabularyDirectAction | undefined {
  if (version !== 1) return undefined;
  const match = /^program_vocabulary\.(create|edit|retire|restore|delete)$/.exec(name);
  return match?.[1] as ProgramVocabularyDirectAction | undefined;
}

function applicationUuid(value: unknown): string {
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('d1_program_vocabulary_item_id_invalid');
  }
  return value.toLowerCase();
}

function stateFromSnapshot(snapshot: ProgramVocabularySnapshotDto): ProgramVocabularyState {
  return parseProgramVocabularyState({
    scope: snapshot.scope,
    setVersion: snapshot.setVersion,
    rooms: snapshot.rooms.map(({ id, name, capacity, status, version }) => ({
      id, name, capacity, status, version
    })),
    tracks: snapshot.tracks.map(({ id, name, status, version }) => ({
      id, name, status, version
    })),
    formats: snapshot.formats.map(({ id, name, status, version }) => ({
      id, name, status, version
    }))
  });
}

function syntheticReferences(
  snapshot: ProgramVocabularySnapshotDto,
  contributor: ProgramReferenceContributorRef
): ProgramReferenceContributorSnapshot {
  // Direct writes never repoint a reference. Delete planning needs the complete,
  // integrity-checked live/historical counts, so rehydrate one opaque record per
  // proven reference and independently guard every source table at commit time.
  const references: ProgramReferenceRecord[] = [];
  for (const item of [...snapshot.rooms, ...snapshot.tracks, ...snapshot.formats]) {
    const belongsToIntake = item.kind !== 'room';
    if ((contributor.key === INTAKE_FORM_CONTRIBUTOR.key) !== belongsToIntake) continue;
    for (const [mode, count] of [
      ['current', item.usage.current],
      ['historical', item.usage.historicalPins]
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        references.push({
          referenceKey: `d1:${contributor.key}:${item.kind}:${item.id}:${mode}:${index}`,
          version: parseAggregateVersion(1),
          item: { kind: item.kind, id: item.id },
          mode,
          destination: { kind: 'd1.program_reference', id: `${item.id}:${mode}:${index}` }
        });
      }
    }
  }
  const guardVersion = snapshot.setVersion;
  return Object.freeze({
    contributor,
    scope: Object.freeze({
      workspaceId: parseWorkspaceId(snapshot.scope.workspaceId),
      eventId: parseEventId(snapshot.scope.eventId)
    }),
    guard: Object.freeze({
      id: `program_reference:${contributor.key}`,
      version: parseAggregateVersion(guardVersion),
      digest: canonicalJsonSha256({ contributor, guardVersion, references })
    }),
    references: Object.freeze(references)
  });
}

function referenceSource(snapshot: ProgramVocabularySnapshotDto): ProgramReferenceSnapshotSource {
  const snapshots = new Map<string, ProgramReferenceContributorSnapshot>(
    REFERENCE_CONTRIBUTORS.map((contributor) => [
      contributor.key,
      syntheticReferences(snapshot, contributor)
    ] as const));
  return Object.freeze({
    readContributor(contributor: ProgramReferenceContributorRef) {
      const resolved = snapshots.get(contributor.key);
      return resolved?.contributor.version === contributor.version ? resolved : undefined;
    }
  });
}

function sessionReferenceKeys(rows: readonly SessionTargetRow[]): ReadonlySet<string> {
  if (rows.length > 10_000) throw new TypeError('d1_program_vocabulary_session_limit_exceeded');
  const keys = new Set<string>();
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || sessionIds.has(row.id)
        || typeof row.format_id !== 'string'
        || (row.track_id !== null && typeof row.track_id !== 'string')) {
      throw new TypeError('d1_program_vocabulary_session_target_corrupt');
    }
    sessionIds.add(row.id);
    keys.add(`format\0${row.format_id}`);
    if (row.track_id !== null) keys.add(`track\0${row.track_id}`);
  }
  return keys;
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
      return { action: 'create', scope, expectedSetVersion: wire.expectedSetVersion,
        item: { kind: 'room', id, name: wire.name, capacity: wire.capacity } };
    }
    if (wire.kind === 'track') {
      return { action: 'create', scope, expectedSetVersion: wire.expectedSetVersion,
        item: { kind: 'track', id, name: wire.name } };
    }
    return { action: 'create', scope, expectedSetVersion: wire.expectedSetVersion,
      item: { kind: 'format', id, name: wire.name } };
  }
  if (input.action === 'edit') {
    const wire = programVocabularyEditDraftRequestSchema.parse(input.businessInput);
    return { action: 'edit', scope, kind: wire.kind, id: wire.id,
      expectedSetVersion: wire.expectedSetVersion,
      expectedItemVersion: wire.expectedItemVersion, changes: wire.changes } as ProgramVocabularyAuthorInput;
  }
  const schema = input.action === 'retire' ? programVocabularyRetireDraftRequestSchema
    : input.action === 'restore' ? programVocabularyRestoreDraftRequestSchema
      : programVocabularyDeleteDraftRequestSchema;
  const wire = schema.parse(input.businessInput);
  return { action: input.action, scope, kind: wire.kind, id: wire.id,
    expectedSetVersion: wire.expectedSetVersion,
    expectedItemVersion: wire.expectedItemVersion } as ProgramVocabularyAuthorInput;
}

function itemIdentity(
  action: ProgramVocabularyDirectAction,
  input: unknown,
  generatedId?: string
): { readonly kind: ProgramVocabularyKind; readonly id: string } {
  if (action === 'create') {
    return { kind: programVocabularyCreateDraftRequestSchema.parse(input).kind, id: generatedId! };
  }
  const schema = action === 'edit' ? programVocabularyEditDraftRequestSchema
    : action === 'retire' ? programVocabularyRetireDraftRequestSchema
      : action === 'restore' ? programVocabularyRestoreDraftRequestSchema
        : programVocabularyDeleteDraftRequestSchema;
  const wire = schema.parse(input);
  return { kind: wire.kind, id: wire.id };
}

function resultFor(plan: ProgramVocabularyMutationPlan): ProgramVocabularyChangeResult {
  if (plan.action === 'merge' || plan.action === 'merge_compensation') {
    throw new TypeError('d1_program_vocabulary_direct_merge_forbidden');
  }
  const item = plan.action === 'create' ? plan.after : plan.before;
  return { action: plan.action, kind: item.kind, affectedIds: [item.id],
    setVersion: plan.expectedSetVersion + 1, liveRepoints: 0 };
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

function tableFor(kind: ProgramVocabularyKind): string {
  return kind === 'room' ? 'program_vocabulary_rooms'
    : kind === 'track' ? 'program_vocabulary_tracks'
      : 'program_vocabulary_formats';
}

interface PreparedChange {
  readonly plan: ProgramVocabularyMutationPlan;
  readonly actorUserId: string;
  readonly occurredAtMs: number;
  phase: 'prepared' | 'applied';
}

export class D1ProgramVocabularyDirectEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedChange | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly newVocabularyItemId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (!sameRef(capability, PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('d1_program_vocabulary_direct_capability_mismatch');
    }
    const action = actionForOperation(context.operation.name, context.operation.version);
    if (!action || context.operation.effect !== 'commit' || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId || !exactSubjects(context)) {
      throw new TypeError('d1_program_vocabulary_direct_scope_mismatch');
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
          grant.kind === 'permission' && grant.key === PROGRAM_VOCABULARY_DIRECT_PERMISSION_ID)) {
      throw new TypeError('d1_program_vocabulary_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    this.#prepared = undefined;

    if (eventId === undefined) {
      return sealProgramVocabularyDirectPreparation({
        capability,
        context,
        preparation: { prepare: ({ action: receivedAction, context: received }) => {
          if (received !== context || receivedAction !== action) {
            throw new TypeError('d1_program_vocabulary_direct_context_substitution');
          }
          return programVocabularyDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: { class: 'conflict',
              kind: 'program_vocabulary.event_required', retryable: false,
              subjects: [], detail: null, detailSchemaVersion: 1 } },
            domain: null, effectContributions: []
          });
        } }
      });
    }

    const parsedEventId = parseEventId(eventId);
    const eventSet = await this.input.unitOfWork.readSession.prepare(
      'SELECT version,current_event_id FROM event_spine_workspace_sets WHERE workspace_id = ?'
    ).bind(this.#workspaceId).first<EventSetRow>();
    if (!eventSet || eventSet.current_event_id !== parsedEventId) {
      throw new TypeError('d1_program_vocabulary_direct_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id = ? AND version = ? AND current_event_id = ?)`, [
      this.#workspaceId, eventSet.version, parsedEventId
    ]);
    const sessionDatabase = {
      withSession: () => this.input.unitOfWork.readSession
    } as unknown as D1Database;
    const snapshot = await createD1ProgramVocabularySnapshotReadSource({
      database: sessionDatabase,
      workspaceId: this.#workspaceId
    }).readSnapshot({ workspaceId: this.#workspaceId, eventId: parsedEventId });
    if (!snapshot) throw new ProgramVocabularyPlanningError('wrong_scope');
    const state = stateFromSnapshot(snapshot);
    const references = referenceSource(snapshot);
    const sessionTargets = sessionReferenceKeys((await this.input.unitOfWork.readSession
      .prepare(`SELECT id,format_id,track_id FROM sessions
        WHERE workspace_id = ? AND event_id = ?
        ORDER BY id COLLATE BINARY LIMIT 10001`)
      .bind(this.#workspaceId, parsedEventId).all<SessionTargetRow>()).results);

    this.input.unitOfWork.assertCurrent(snapshot.setVersion === 1
      ? `NOT EXISTS (SELECT 1 FROM program_vocabulary_sets
          WHERE workspace_id = ? AND event_id = ?)`
      : `EXISTS (SELECT 1 FROM program_vocabulary_sets
          WHERE workspace_id = ? AND event_id = ? AND set_version = ?)`,
    snapshot.setVersion === 1
      ? [this.#workspaceId, parsedEventId]
      : [this.#workspaceId, parsedEventId, snapshot.setVersion]);

    return sealProgramVocabularyDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ action: receivedAction, businessInput, context: received }) => {
        if (received !== context || receivedAction !== action) {
          throw new TypeError('d1_program_vocabulary_direct_context_substitution');
        }
        const generatedId = action === 'create'
          ? applicationUuid(this.input.newVocabularyItemId()) : undefined;
        const identity = itemIdentity(action, businessInput, generatedId);
        try {
          if (action === 'delete'
              && sessionTargets.has(`${identity.kind}\0${identity.id}`)) {
            throw new ProgramVocabularyPlanningError('delete_referenced');
          }
          const plan = planProgramVocabularyMutation({
            authorInput: authorInput({ action, businessInput,
              workspaceId: this.#workspaceId, eventId: parsedEventId,
              ...(generatedId ? { generatedId } : {}) }),
            state,
            referenceRegistry,
            referenceSource: references
          });
          const contribution = programVocabularyDirectContributionSchema.parse({
            result: { kind: 'success', data: resultFor(plan) },
            domain: { kind: 'program_vocabulary_direct_change', plan },
            effectContributions: []
          });
          this.#prepared = { plan, actorUserId,
            occurredAtMs: Date.parse(evaluatedAt), phase: 'prepared' };
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
    const candidate = contribution as { readonly kind?: unknown; readonly plan?: unknown };
    if (candidate.kind !== 'program_vocabulary_direct_change') {
      throw new TypeError('d1_program_vocabulary_direct_contribution_invalid');
    }
    const plan = parseProgramVocabularyMutationPlan(candidate.plan);
    if (plan.action === 'merge' || plan.action === 'merge_compensation') {
      throw new TypeError('d1_program_vocabulary_direct_merge_forbidden');
    }
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(prepared.plan) !== canonicalJsonText(plan)) {
      throw new TypeError('d1_program_vocabulary_direct_preparation_invalid');
    }
    this.bufferPlan(plan, prepared.actorUserId, prepared.occurredAtMs);
    prepared.phase = 'applied';
  }

  private bufferPlan(plan: Exclude<ProgramVocabularyMutationPlan,
  { readonly action: 'merge' | 'merge_compensation' }>, actorUserId: string, occurredAtMs: number) {
    const scope = plan.scope;
    if (plan.expectedSetVersion === 1) {
      this.input.unitOfWork.write(`INSERT INTO program_vocabulary_sets (
        workspace_id,event_id,set_version,created_by_user_id,created_at_ms,
        updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?)`, [
        scope.workspaceId, scope.eventId, 2, actorUserId, occurredAtMs, actorUserId, occurredAtMs
      ]);
    }
    if (plan.action === 'create') {
      const item = plan.after;
      this.input.unitOfWork.assertCurrent(`NOT EXISTS (
        SELECT id FROM program_vocabulary_rooms WHERE workspace_id = ? AND event_id = ? AND id = ?
        UNION ALL SELECT id FROM program_vocabulary_tracks WHERE workspace_id = ? AND event_id = ? AND id = ?
        UNION ALL SELECT id FROM program_vocabulary_formats WHERE workspace_id = ? AND event_id = ? AND id = ?)`, [
        scope.workspaceId, scope.eventId, item.id,
        scope.workspaceId, scope.eventId, item.id,
        scope.workspaceId, scope.eventId, item.id
      ]);
      if (item.kind === 'room') {
        this.input.unitOfWork.write(`INSERT INTO program_vocabulary_rooms (
          workspace_id,event_id,id,name,capacity,status,version,created_by_user_id,
          created_at_ms,updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
          scope.workspaceId, scope.eventId, item.id, item.name, item.capacity, item.status,
          item.version, actorUserId, occurredAtMs, actorUserId, occurredAtMs
        ]);
      } else {
        this.input.unitOfWork.write(`INSERT INTO ${tableFor(item.kind)} (
          workspace_id,event_id,id,name,status,version,created_by_user_id,
          created_at_ms,updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
          scope.workspaceId, scope.eventId, item.id, item.name, item.status,
          item.version, actorUserId, occurredAtMs, actorUserId, occurredAtMs
        ]);
      }
    } else {
      const before = plan.before;
      const table = tableFor(before.kind);
      this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM ${table}
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
          AND name = ? AND status = ?${before.kind === 'room' ? ' AND capacity IS ?' : ''})`, [
        scope.workspaceId, scope.eventId, before.id, before.version, before.name, before.status,
        ...(before.kind === 'room' ? [before.capacity] : [])
      ]);
      if (plan.action === 'delete') {
        this.assertUnreferenced(before.kind, before.id, scope.workspaceId, scope.eventId);
        this.input.unitOfWork.write(`DELETE FROM ${table}
          WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?`, [
          scope.workspaceId, scope.eventId, before.id, before.version
        ]);
      } else {
        const after = plan.after;
        this.input.unitOfWork.write(`UPDATE ${table}
          SET name = ?,${after.kind === 'room' ? ' capacity = ?,' : ''}
              status = ?,version = ?,updated_by_user_id = ?,updated_at_ms = ?
          WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?`, [
          after.name,
          ...(after.kind === 'room' ? [after.capacity] : []),
          after.status, after.version, actorUserId, occurredAtMs,
          scope.workspaceId, scope.eventId, before.id, before.version
        ]);
      }
    }
    if (plan.expectedSetVersion !== 1) {
      this.input.unitOfWork.write(`UPDATE program_vocabulary_sets
        SET set_version = ?,updated_by_user_id = ?,updated_at_ms = ?
        WHERE workspace_id = ? AND event_id = ? AND set_version = ?`, [
        plan.expectedSetVersion + 1, actorUserId, occurredAtMs,
        scope.workspaceId, scope.eventId, plan.expectedSetVersion
      ]);
    }
  }

  private assertUnreferenced(
    kind: ProgramVocabularyKind,
    id: string,
    workspaceId: string,
    eventId: string
  ): void {
    this.input.unitOfWork.assertCurrent(`NOT EXISTS (
      SELECT 1 FROM intake_form_program_reference_slots
       WHERE workspace_id = ? AND event_id = ? AND item_kind = ? AND item_id = ?)`,
    [workspaceId, eventId, kind, id]);
    if (kind === 'room') {
      this.input.unitOfWork.assertCurrent(`NOT EXISTS (
        SELECT 1 FROM schedule_occurrences
         WHERE workspace_id = ? AND event_id = ? AND room_id = ?)`,
      [workspaceId, eventId, id]);
    }
    this.input.unitOfWork.assertCurrent(`NOT EXISTS (
      SELECT 1 FROM intake_form_versions
       WHERE workspace_id = ? AND event_id = ? AND instr(version_json, ?) > 0)`,
    [workspaceId, eventId, id]);
    this.input.unitOfWork.assertCurrent(`NOT EXISTS (
      SELECT 1 FROM intake_submission_submit_evidence
       WHERE workspace_id = ? AND event_id = ? AND instr(evidence_json, ?) > 0)`,
    [workspaceId, eventId, id]);
    if (kind === 'track' || kind === 'format') {
      const column = kind === 'track' ? 'track_id' : 'format_id';
      this.input.unitOfWork.assertCurrent(`NOT EXISTS (
        SELECT 1 FROM sessions
         WHERE workspace_id = ? AND event_id = ? AND ${column} = ?)`,
      [workspaceId, eventId, id]);
    }
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared = undefined;
  }
}

export function createD1ProgramVocabularyDirectEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly newVocabularyItemId: () => string;
}): D1EffectDomainAdapterRegistration {
  return Object.freeze({
    capability: PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) =>
      new D1ProgramVocabularyDirectEffectDomainAdapter({
      ...input, unitOfWork
    })
  });
}
