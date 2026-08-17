import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  sessionDirectInputSchema,
  sessionMutationPlanSchema,
  sessionRemoveNewPlanSchema,
  type SessionHeadDto,
  type SessionMutationPlanDto,
  type SessionRemoveNewPlanDto
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  applyNewSessionRemovalPlan,
  applySessionMutationPlan,
  planNewSessionRemoval,
  planSessionMutation,
  SessionPlanningError,
  type SessionCatalog
} from '@jooevents/session';
import {
  SESSION_CHANGE_OPERATION,
  SESSION_DIRECT_HANDLER_CAPABILITY,
  SESSION_MANAGE_ACCESS_POLICY,
  SESSION_MANAGE_PERMISSION_ID,
  sealSessionDirectPreparation,
  sessionChangedOutcome,
  sessionDirectContributionSchema
} from '@jooevents/session-operations';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';
import {
  createD1ProgramVocabularySnapshotReadSource,
  programVocabularyStateFromSnapshot
} from './d1-program-vocabulary';
import { createD1SessionCatalogReadSource } from './d1-session-catalog';

const MAX_REFERENCES = 10_000;

interface EventSetRow {
  readonly version: number;
  readonly current_event_id: string | null;
}

interface SessionReferenceRow { readonly session_id: unknown }

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return eventId !== undefined && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId);
}

function applicationUuid(value: unknown): string {
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('d1_session_id_invalid');
  }
  return value.toLowerCase();
}

function referencedSessionIds(rows: readonly SessionReferenceRow[]): ReadonlySet<string> {
  if (rows.length > MAX_REFERENCES) throw new TypeError('d1_session_reference_limit_exceeded');
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.session_id !== 'string') throw new TypeError('d1_session_reference_corrupt');
    ids.add(row.session_id);
  }
  return ids;
}

function persistedHead(head: SessionHeadDto): readonly unknown[] {
  return [
    head.scope.workspaceId, head.scope.eventId, head.id, head.title,
    head.plannedDurationMinutes, head.lifecycle, head.programTarget.format.id,
    head.programTarget.track?.id ?? null, head.programTarget.setVersion,
    head.programTarget.setDigestSha256, head.roster.version, head.roster.digestSha256,
    canonicalJsonText(head.roster), canonicalJsonText(head), head.version, head.digestSha256,
    head.createdByUserId, Date.parse(head.createdAt), head.updatedByUserId,
    Date.parse(head.updatedAt)
  ];
}

type SessionPlan = SessionMutationPlanDto | SessionRemoveNewPlanDto;

function isRemoval(plan: SessionPlan): plan is SessionRemoveNewPlanDto {
  return 'action' in plan && plan.action === 'remove_new_session';
}

interface PreparedChange {
  readonly plan: SessionPlan;
  readonly catalog: SessionCatalog;
  phase: 'prepared' | 'applied';
}

export class D1SessionDirectEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedChange | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly newSessionId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (!sameRef(capability, SESSION_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('d1_session_direct_capability_mismatch');
    }
    if (context.operation.name !== SESSION_CHANGE_OPERATION.name
        || context.operation.version !== SESSION_CHANGE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_session_direct_scope_mismatch');
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
        || !sameRef(authority.lane.policy, SESSION_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === SESSION_MANAGE_PERMISSION_ID)) {
      throw new TypeError('d1_session_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = parseEventId(context.scope.eventId!);
    this.#prepared = undefined;

    const eventSet = await this.input.unitOfWork.readSession.prepare(
      'SELECT version,current_event_id FROM event_spine_workspace_sets WHERE workspace_id = ?'
    ).bind(this.#workspaceId).first<EventSetRow>();
    if (!eventSet || eventSet.current_event_id !== eventId) {
      throw new TypeError('d1_session_direct_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id = ? AND version = ? AND current_event_id = ?)`, [
      this.#workspaceId, eventSet.version, eventId
    ]);

    const sessionDatabase = {
      withSession: () => this.input.unitOfWork.readSession
    } as unknown as D1Database;
    const scope = { workspaceId: this.#workspaceId, eventId };
    const [catalog, vocabularySnapshot, scheduleReferences, submissionReferences,
      engagementReferences] = await Promise.all([
      createD1SessionCatalogReadSource({
        database: sessionDatabase,
        workspaceId: this.#workspaceId
      }).readSessionCatalog(scope),
      createD1ProgramVocabularySnapshotReadSource({
        database: sessionDatabase,
        workspaceId: this.#workspaceId
      }).readSnapshot(scope),
      this.input.unitOfWork.readSession.prepare(`SELECT session_id FROM schedule_occurrences
        WHERE workspace_id = ? AND event_id = ?
        ORDER BY session_id COLLATE BINARY LIMIT ?`)
        .bind(this.#workspaceId, eventId, MAX_REFERENCES + 1).all<SessionReferenceRow>(),
      this.input.unitOfWork.readSession.prepare(`SELECT session_id FROM submission_session_origins
        WHERE workspace_id = ? AND event_id = ?
        ORDER BY session_id COLLATE BINARY LIMIT ?`)
        .bind(this.#workspaceId, eventId, MAX_REFERENCES + 1).all<SessionReferenceRow>(),
      this.input.unitOfWork.readSession.prepare(`SELECT session_id FROM engagement_heads
        WHERE workspace_id = ? AND event_id = ?
        ORDER BY session_id COLLATE BINARY LIMIT ?`)
        .bind(this.#workspaceId, eventId, MAX_REFERENCES + 1).all<SessionReferenceRow>()
    ]);
    if (!catalog || !vocabularySnapshot) throw new SessionPlanningError('wrong_scope');
    const vocabulary = programVocabularyStateFromSnapshot(vocabularySnapshot);
    const referenced = new Set<string>([
      ...referencedSessionIds(scheduleReferences.results),
      ...referencedSessionIds(submissionReferences.results),
      ...referencedSessionIds(engagementReferences.results)
    ]);

    this.input.unitOfWork.assertCurrent(catalog.version === 1
      ? `NOT EXISTS (SELECT 1 FROM session_catalogs
          WHERE workspace_id = ? AND event_id = ?)`
      : `EXISTS (SELECT 1 FROM session_catalogs
          WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?)`,
    catalog.version === 1
      ? [this.#workspaceId, eventId]
      : [this.#workspaceId, eventId, catalog.version, catalog.digestSha256]);
    this.input.unitOfWork.assertCurrent(vocabulary.setVersion === 1
      ? `NOT EXISTS (SELECT 1 FROM program_vocabulary_sets
          WHERE workspace_id = ? AND event_id = ?)`
      : `EXISTS (SELECT 1 FROM program_vocabulary_sets
          WHERE workspace_id = ? AND event_id = ? AND set_version = ?)`,
    vocabulary.setVersion === 1
      ? [this.#workspaceId, eventId]
      : [this.#workspaceId, eventId, vocabulary.setVersion]);

    return sealSessionDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context) throw new TypeError('d1_session_direct_context_substitution');
        const wire = sessionDirectInputSchema.parse(businessInput);
        const generatedSessionId = wire.action === 'create'
          ? applicationUuid(this.input.newSessionId()) : undefined;
        try {
          const plan: SessionPlan = wire.action === 'remove_new_session'
            ? (() => {
                const current = catalog.sessions.find((session) => session.id === wire.sessionId);
                if (!current || current.version !== 1
                    || current.version !== wire.expectedSessionVersion
                    || current.digestSha256 !== wire.expectedSessionDigestSha256
                    || current.roster.participants.length !== 0
                    || referenced.has(current.id)) {
                  throw new SessionPlanningError('stale_session');
                }
                return planNewSessionRemoval({ current, catalog, actorUserId, occurredAt });
              })()
            : planSessionMutation({
                planningInput: wire.action === 'create'
                  ? { ...wire, scope, sessionId: generatedSessionId!, actorUserId, occurredAt }
                  : { ...wire, scope, actorUserId, occurredAt },
                catalog,
                vocabulary
              });
          if (isRemoval(plan)) {
            applyNewSessionRemovalPlan({ plan, catalog });
          } else {
            applySessionMutationPlan({ plan, catalog, vocabulary });
          }
          const data = isRemoval(plan)
            ? { action: 'remove_new_session' as const,
                catalogVersion: plan.catalogVersion.after, session: null }
            : { action: plan.input.action, catalogVersion: plan.catalogVersion.after,
                session: plan.after };
          this.#prepared = { plan, catalog, phase: 'prepared' };
          return sessionDirectContributionSchema.parse({
            result: { kind: 'success', data },
            domain: { kind: 'session_direct_change', plan },
            effectContributions: []
          });
        } catch (error) {
          if (!(error instanceof SessionPlanningError)) throw error;
          return sessionDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: sessionChangedOutcome({
              code: error.code,
              action: wire.action,
              sessionId: wire.action === 'create' ? generatedSessionId! : wire.sessionId
            }) },
            domain: null,
            effectContributions: []
          });
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const candidate = contribution as { readonly kind?: unknown; readonly plan?: unknown };
    if (candidate.kind !== 'session_direct_change') {
      throw new TypeError('d1_session_direct_contribution_invalid');
    }
    const mutation = sessionMutationPlanSchema.safeParse(candidate.plan);
    const plan: SessionPlan = mutation.success
      ? mutation.data : sessionRemoveNewPlanSchema.parse(candidate.plan);
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(prepared.plan) !== canonicalJsonText(plan)) {
      throw new TypeError('d1_session_direct_preparation_invalid');
    }
    this.bufferPlan(plan, prepared.catalog);
    prepared.phase = 'applied';
  }

  private bufferPlan(plan: SessionPlan, catalog: SessionCatalog): void {
    const removal = isRemoval(plan);
    const before = removal ? plan.expectedCurrent : plan.before;
    const after = removal ? null : plan.after;
    const scope = removal ? plan.scope : plan.input.scope;

    if (before === null && after) {
      this.input.unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM sessions
        WHERE workspace_id = ? AND event_id = ? AND id = ?)`, [
        scope.workspaceId, scope.eventId, after.id
      ]);
    } else if (before) {
      this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM sessions
        WHERE workspace_id = ? AND event_id = ? AND id = ?
          AND version = ? AND digest_sha256 = ? AND head_json = ?)`, [
        scope.workspaceId, scope.eventId, before.id, before.version,
        before.digestSha256, canonicalJsonText(before)
      ]);
    }

    if (removal) {
      for (const table of ['schedule_occurrences', 'submission_session_origins',
        'engagement_heads'] as const) {
        this.input.unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM ${table}
          WHERE workspace_id = ? AND event_id = ? AND session_id = ?)`, [
          scope.workspaceId, scope.eventId, before!.id
        ]);
      }
    }

    if (catalog.version === 1) {
      this.input.unitOfWork.write(`INSERT INTO session_catalogs
        (workspace_id,event_id,version,digest_sha256) VALUES (?,?,?,?)`, [
        scope.workspaceId, scope.eventId, plan.catalogVersion.after,
        plan.catalogDigestSha256.after
      ]);
    }

    if (before === null && after) {
      this.input.unitOfWork.write(`INSERT INTO sessions (
        workspace_id,event_id,id,title,planned_duration_minutes,lifecycle,format_id,track_id,
        program_set_version,program_set_digest_sha256,roster_version,roster_digest_sha256,
        roster_json,head_json,version,digest_sha256,created_by_user_id,created_at_ms,
        updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      persistedHead(after));
    } else if (before && after) {
      const values = persistedHead(after);
      this.input.unitOfWork.write(`UPDATE sessions SET
        title = ?,planned_duration_minutes = ?,lifecycle = ?,format_id = ?,track_id = ?,
        program_set_version = ?,program_set_digest_sha256 = ?,roster_version = ?,
        roster_digest_sha256 = ?,roster_json = ?,head_json = ?,version = ?,
        digest_sha256 = ?,updated_by_user_id = ?,updated_at_ms = ?
        WHERE workspace_id = ? AND event_id = ? AND id = ?
          AND version = ? AND digest_sha256 = ?`, [
        values[3], values[4], values[5], values[6], values[7], values[8], values[9],
        values[10], values[11], values[12], values[13], values[14], values[15],
        values[18], values[19], scope.workspaceId, scope.eventId, before.id,
        before.version, before.digestSha256
      ]);
    } else if (before && after === null) {
      this.input.unitOfWork.write(`DELETE FROM sessions
        WHERE workspace_id = ? AND event_id = ? AND id = ?
          AND version = ? AND digest_sha256 = ?`, [
        scope.workspaceId, scope.eventId, before.id, before.version, before.digestSha256
      ]);
    } else {
      throw new TypeError('d1_session_direct_plan_invalid');
    }

    if (catalog.version !== 1) {
      this.input.unitOfWork.write(`UPDATE session_catalogs
        SET version = ?,digest_sha256 = ?
        WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?`, [
        plan.catalogVersion.after, plan.catalogDigestSha256.after,
        scope.workspaceId, scope.eventId, catalog.version, catalog.digestSha256
      ]);
    }
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared = undefined;
  }
}

export function createD1SessionDirectEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly newSessionId: () => string;
}): D1EffectDomainAdapterRegistration {
  return Object.freeze({
    capability: SESSION_DIRECT_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) =>
      new D1SessionDirectEffectDomainAdapter({ ...input, unitOfWork })
  });
}
