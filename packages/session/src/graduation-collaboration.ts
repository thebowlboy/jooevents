import type { ChangesetApplyContribution, GuardRef, VersionRef } from '@jooevents/changesets';
import {
  defineChangesetReadPort,
  defineChangesetTransactionPort,
  defineChangesetValidationPort
} from '@jooevents/changesets';
import {
  sessionMutationPlanSchema,
  sessionMutationResultSchema,
  sessionRestorePlanSchema,
  type PlaceableSessionLifecycle,
  type SessionLifecycle,
  type SessionMutationPlanDto,
  type SessionMutationResult,
  type SessionRestorePlanDto,
  type SessionRosterParticipantInput,
  type SessionSafeDiffDto,
  type SessionScopeDto
} from '@jooevents/contracts';
import {
  applySessionRestorePlan,
  planSessionMutation,
  sessionAggregateId,
  sessionCatalogGuardId,
  SessionPlanningError,
  validateSessionMutationPlan,
  type SessionPlanningErrorCode,
  type SessionTransactionPort
} from './domain';
import type { SessionChangesetReadPort } from './changesets';
import {
  findSession,
  parseSessionCatalog,
  parseSessionHead,
  parseSessionScope,
  sessionCatalogDigest,
  sessionHeadDigest,
  type SessionCatalog,
  type SessionHead,
  type SessionReadPort
} from './model';

/**
 * One Session contribution a hosting changeset embeds so an acceptance can
 * spawn a new Session or attach onto an existing roster atomically with its own
 * commit. The contribution is an exact Session mutation plan; validation and
 * apply run through the canonical Session domain, so append-never-clobber and
 * one-way lifecycle rules hold identically for hosted graduations.
 *
 * Concurrency fencing: a spawned Session cannot carry a per-session guard (it
 * does not exist while the hosting changeset is proposed), so spawns fence on
 * the whole `session_catalog` guard only. Attaches add the target Session
 * aggregate ref beside the same catalog guard. The catalog guard makes any
 * concurrent Session change to the event a conflict for a pending graduation —
 * that whole-catalog false-conflict cost is accepted deliberately; the refusal
 * class is retry-by-replan, never a wrong commit.
 */
export type SessionGraduationContribution = SessionMutationPlanDto;

interface SessionGraduationChangeBase {
  readonly scope: SessionScopeDto;
  readonly attribution: { readonly userId: string; readonly at: string };
  readonly participants: readonly SessionRosterParticipantInput[];
}

export type SessionGraduationChangeInput =
  | (SessionGraduationChangeBase & {
      readonly kind: 'spawn';
      readonly identity: { readonly sessionId: string };
      readonly title: string;
      readonly plannedDurationMinutes: number;
      readonly lifecycle: PlaceableSessionLifecycle;
      readonly formatId: string;
      readonly trackId: string | null;
    })
  | (SessionGraduationChangeBase & {
      readonly kind: 'attach';
      readonly sessionId: string;
      readonly graduateTo?: 'programmed';
    });

export interface SessionGraduationReversalInput {
  readonly original: SessionGraduationContribution;
  readonly attribution: { readonly userId: string; readonly at: string };
}

export interface SessionGraduationPlanningPort extends SessionChangesetReadPort {
  planSessionGraduation(input: SessionGraduationChangeInput): SessionGraduationContribution;
  planSessionGraduationReversal(input: SessionGraduationReversalInput): SessionRestorePlanDto;
}

export type SessionGraduationValidation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused'; readonly code: SessionPlanningErrorCode };

export interface SessionGraduationValidationPort extends SessionChangesetReadPort {
  validateSessionGraduation(
    contribution: SessionGraduationContribution
  ): SessionGraduationValidation;
  validateSessionGraduationReversal(plan: SessionRestorePlanDto): SessionGraduationValidation;
}

export interface SessionGraduationPinDto {
  readonly sessionId: string;
  readonly version: number;
  readonly digestSha256: string;
  readonly lifecycle: SessionLifecycle;
}

export interface SessionGraduationAppliedContribution extends
  ChangesetApplyContribution<SessionMutationResult> {
  readonly pin: SessionGraduationPinDto;
}

export interface SessionGraduationTransactionPort extends SessionTransactionPort {
  applySessionGraduation(
    contribution: SessionGraduationContribution
  ): SessionGraduationAppliedContribution;
  applySessionGraduationReversal(plan: SessionRestorePlanDto): SessionMutationResult;
}

export const sessionGraduationPlanningPort = defineChangesetReadPort<SessionGraduationPlanningPort>(
  'session_graduation.planning', 1
);
export const sessionGraduationValidationPort =
  defineChangesetValidationPort<SessionGraduationValidationPort>(
    'session_graduation.validation', 1
  );
export const sessionGraduationTransactionPort =
  defineChangesetTransactionPort<SessionGraduationTransactionPort>(
    'session_graduation.transaction', 1
  );

export function planSessionGraduationFrom(
  port: SessionChangesetReadPort,
  input: SessionGraduationChangeInput
): SessionGraduationContribution {
  const scope = parseSessionScope(input.scope);
  const catalog = port.readSessionCatalog(scope);
  const vocabulary = port.readSessionVocabulary(scope);
  if (!catalog || !vocabulary) throw new TypeError('session_graduation_scope_missing');
  const catalogGuards = {
    expectedCatalogVersion: catalog.version,
    expectedCatalogDigestSha256: catalog.digestSha256
  } as const;
  const attribution = {
    actorUserId: input.attribution.userId,
    occurredAt: input.attribution.at
  } as const;
  if (input.kind === 'spawn') {
    return sessionMutationPlanSchema.parse(planSessionMutation({
      planningInput: {
        action: 'create',
        scope,
        ...catalogGuards,
        ...attribution,
        sessionId: input.identity.sessionId,
        title: input.title,
        plannedDurationMinutes: input.plannedDurationMinutes,
        lifecycle: input.lifecycle,
        formatId: input.formatId,
        trackId: input.trackId,
        participants: [...input.participants]
      },
      catalog,
      vocabulary
    }));
  }
  const current = findSession(catalog, input.sessionId);
  if (!current) throw new SessionPlanningError('session_missing');
  return sessionMutationPlanSchema.parse(planSessionMutation({
    planningInput: {
      action: 'roster_append',
      scope,
      ...catalogGuards,
      ...attribution,
      sessionId: input.sessionId,
      expectedSessionVersion: current.version,
      expectedSessionDigestSha256: current.digestSha256,
      participants: [...input.participants],
      ...(input.graduateTo === undefined ? {} : { graduateTo: input.graduateTo })
    },
    catalog,
    vocabulary
  }));
}

export function validateSessionGraduationFrom(
  port: SessionChangesetReadPort,
  contribution: SessionGraduationContribution
): SessionGraduationValidation {
  const scope = parseSessionScope(contribution.input.scope);
  const catalog = port.readSessionCatalog(scope);
  const vocabulary = port.readSessionVocabulary(scope);
  if (!catalog || !vocabulary) return Object.freeze({ kind: 'refused', code: 'wrong_scope' });
  const code = validateSessionMutationPlan({ plan: contribution, catalog, vocabulary });
  return code
    ? Object.freeze({ kind: 'refused', code })
    : Object.freeze({ kind: 'ready' });
}

export function applySessionGraduationFrom(
  port: SessionTransactionPort,
  contribution: SessionGraduationContribution
): SessionGraduationAppliedContribution {
  const result = port.applySessionPlan(contribution);
  return Object.freeze({
    result,
    pin: sessionGraduationPin(contribution),
    ...sessionGraduationEvidence(contribution)
  });
}

/**
 * Compensating restore for one applied graduation. Unlike whole-plan Session
 * compensation, the guard here is session-precise: the reversal is available
 * exactly while the graduated Session still matches the contribution's after
 * image, regardless of unrelated catalog movement, and refuses `stale_session`
 * once anything else has touched that Session.
 */
export function planSessionGraduationReversalAgainst(input: {
  readonly original: SessionGraduationContribution;
  readonly catalog: SessionCatalog;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): SessionRestorePlanDto {
  const catalog = input.catalog;
  const current = findSession(catalog, input.original.after.id);
  if (!current || current.digestSha256 !== input.original.after.digestSha256) {
    throw new SessionPlanningError('stale_session');
  }
  let restore: SessionHead | null = null;
  if (input.original.before) {
    const { digestSha256: _digest, ...prior } = input.original.before;
    const unsigned = {
      ...prior,
      version: current.version + 1,
      updatedByUserId: input.actorUserId,
      updatedAt: input.occurredAt
    };
    restore = parseSessionHead({ ...unsigned, digestSha256: sessionHeadDigest(unsigned) });
  }
  const sessions = catalog.sessions.filter((session) => session.id !== current.id);
  if (restore) sessions.push(restore);
  sessions.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const unsignedCatalog = {
    schemaVersion: 1 as const,
    scope: catalog.scope,
    version: catalog.version + 1,
    sessions
  };
  const afterCatalog = parseSessionCatalog({
    ...unsignedCatalog,
    digestSha256: sessionCatalogDigest(unsignedCatalog)
  });
  return sessionRestorePlanSchema.parse({
    action: 'restore',
    scope: catalog.scope,
    expectedCatalogVersion: catalog.version,
    expectedCatalogDigestSha256: catalog.digestSha256,
    expectedCurrent: current,
    restore,
    catalogVersion: { before: catalog.version, after: afterCatalog.version },
    catalogDigestSha256: { before: catalog.digestSha256, after: afterCatalog.digestSha256 },
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt
  });
}

export function planSessionGraduationReversalFrom(
  port: SessionReadPort,
  input: SessionGraduationReversalInput
): SessionRestorePlanDto {
  const scope = parseSessionScope(input.original.input.scope);
  const catalog = port.readSessionCatalog(scope);
  if (!catalog) throw new TypeError('session_graduation_scope_missing');
  return planSessionGraduationReversalAgainst({
    original: input.original,
    catalog,
    actorUserId: input.attribution.userId,
    occurredAt: input.attribution.at
  });
}

export function validateSessionGraduationReversalFrom(
  port: SessionReadPort,
  plan: SessionRestorePlanDto
): SessionGraduationValidation {
  const catalog = port.readSessionCatalog(parseSessionScope(plan.scope));
  if (!catalog) return Object.freeze({ kind: 'refused', code: 'wrong_scope' });
  try {
    applySessionRestorePlan({ plan, catalog });
    return Object.freeze({ kind: 'ready' });
  } catch (error) {
    return Object.freeze({
      kind: 'refused',
      code: error instanceof SessionPlanningError ? error.code : 'invalid_plan'
    });
  }
}

export function applySessionGraduationReversalFrom(
  port: SessionTransactionPort,
  plan: SessionRestorePlanDto
): SessionMutationResult {
  return port.applySessionPlan(sessionRestorePlanSchema.parse(plan));
}

export function sessionGraduationAggregateRefs(
  contribution: SessionGraduationContribution
): readonly VersionRef[] {
  return Object.freeze(contribution.before
    ? [{ id: sessionAggregateId(contribution.before.id), version: contribution.before.version }]
    : []);
}

export function sessionGraduationGuardRefs(
  contribution: SessionGraduationContribution
): readonly GuardRef[] {
  return Object.freeze([{
    id: sessionCatalogGuardId(contribution.input.scope.eventId),
    version: contribution.catalogVersion.before,
    digest: contribution.catalogDigestSha256.before
  }]);
}

export function projectSessionGraduationDiff(
  contribution: SessionGraduationContribution
): SessionSafeDiffDto {
  return Object.freeze({
    action: contribution.input.action,
    before: contribution.before,
    after: contribution.after
  });
}

export function sessionGraduationPin(
  contribution: SessionGraduationContribution
): SessionGraduationPinDto {
  return Object.freeze({
    sessionId: contribution.after.id,
    version: contribution.after.version,
    digestSha256: contribution.after.digestSha256,
    lifecycle: contribution.after.lifecycle
  });
}

/** Deterministic `session_changed` v1 fact bytes the applied contribution emits. */
export function sessionGraduationFactPayload(
  contribution: SessionGraduationContribution
): SessionMutationResult {
  return sessionMutationResultSchema.parse({
    action: contribution.input.action,
    catalogVersion: contribution.catalogVersion.after,
    session: contribution.after
  });
}

export function sessionGraduationEvidence(
  contribution: SessionGraduationContribution
): Pick<SessionGraduationAppliedContribution, 'facts' | 'effects'> {
  return Object.freeze({
    facts: Object.freeze([{
      kind: 'session_changed', version: 1,
      payload: sessionGraduationFactPayload(contribution)
    }]),
    effects: Object.freeze([])
  });
}
