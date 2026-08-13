import {
  sessionMutationPlanSchema,
  sessionMutationResultSchema,
  sessionPlanningInputSchema,
  sessionRestorePlanSchema,
  type SessionMutationPlanDto,
  type SessionMutationResult,
  type SessionPlanningInput,
  type SessionProgramTargetEvidenceDto,
  type SessionRestorePlanDto
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import {
  programVocabularySetDigest,
  resolveProgramVocabularyItem,
  type ProgramVocabularyState
} from '@jooevents/program';
import {
  findSession,
  parseSessionCatalog,
  parseSessionHead,
  sameSessionScope,
  sessionCatalogDigest,
  sessionHeadDigest,
  sessionRosterDigest,
  type SessionCatalog,
  type SessionHead,
  type SessionScope
} from './model';

export type SessionPlanningErrorCode =
  | 'wrong_scope'
  | 'stale_catalog'
  | 'session_exists'
  | 'session_missing'
  | 'stale_session'
  | 'format_missing'
  | 'format_retired'
  | 'track_missing'
  | 'track_retired'
  | 'invalid_transition'
  | 'invalid_plan';

export class SessionPlanningError extends Error {
  constructor(readonly code: SessionPlanningErrorCode) {
    super(code);
    this.name = 'SessionPlanningError';
  }
}

export interface SessionTransactionPort {
  applySessionPlan(plan: SessionMutationPlanDto | SessionRestorePlanDto): SessionMutationResult;
}

export function sessionCatalogGuardId(eventId: string): string {
  return `session_catalog:${eventId}`;
}

export function sessionAggregateId(sessionId: string): string {
  return `session:${sessionId}`;
}

export function planSessionMutation(input: {
  readonly planningInput: SessionPlanningInput;
  readonly catalog: SessionCatalog;
  readonly vocabulary: ProgramVocabularyState;
}): SessionMutationPlanDto {
  const planningInput = sessionPlanningInputSchema.parse(input.planningInput);
  const scope = planningInput.scope;
  requireEnvironment(scope, input.catalog, input.vocabulary);
  requireCatalogGuard(input.catalog, planningInput.expectedCatalogVersion, planningInput.expectedCatalogDigestSha256);
  const existing = findSession(input.catalog, planningInput.sessionId);

  let before: SessionHead | null;
  let after: SessionHead;
  if (planningInput.action === 'create') {
    if (existing) throw new SessionPlanningError('session_exists');
    before = null;
    const target = currentTargetEvidence(input.vocabulary, planningInput.formatId, planningInput.trackId);
    const rosterUnsigned = { version: 1, participants: [] };
    const roster = { ...rosterUnsigned, digestSha256: sessionRosterDigest(rosterUnsigned) };
    const unsigned = {
      schemaVersion: 1 as const,
      scope,
      id: planningInput.sessionId,
      title: planningInput.title,
      plannedDurationMinutes: planningInput.plannedDurationMinutes,
      lifecycle: planningInput.lifecycle,
      programTarget: target,
      roster,
      version: 1,
      createdByUserId: planningInput.actorUserId,
      createdAt: planningInput.occurredAt,
      updatedByUserId: planningInput.actorUserId,
      updatedAt: planningInput.occurredAt
    };
    after = parseSessionHead({ ...unsigned, digestSha256: sessionHeadDigest(unsigned) });
  } else {
    if (!existing) throw new SessionPlanningError('session_missing');
    if (existing.version !== planningInput.expectedSessionVersion
        || existing.digestSha256 !== planningInput.expectedSessionDigestSha256) {
      throw new SessionPlanningError('stale_session');
    }
    requireTransition(existing.lifecycle, planningInput.to);
    before = existing;
    const target = currentTargetEvidence(
      input.vocabulary,
      existing.programTarget.format.id,
      existing.programTarget.track?.id ?? null
    );
    const { digestSha256: _digest, ...unsignedBefore } = existing;
    const unsigned = {
      ...unsignedBefore,
      lifecycle: planningInput.to,
      programTarget: target,
      version: existing.version + 1,
      updatedByUserId: planningInput.actorUserId,
      updatedAt: planningInput.occurredAt
    };
    after = parseSessionHead({ ...unsigned, digestSha256: sessionHeadDigest(unsigned) });
  }
  return buildMutationPlan(planningInput, input.catalog, before, after);
}

export function validateSessionMutationPlan(input: {
  readonly plan: SessionMutationPlanDto;
  readonly catalog: SessionCatalog;
  readonly vocabulary: ProgramVocabularyState;
}): SessionPlanningErrorCode | undefined {
  let rebuilt: SessionMutationPlanDto;
  try {
    rebuilt = planSessionMutation({
      planningInput: input.plan.input,
      catalog: input.catalog,
      vocabulary: input.vocabulary
    });
  } catch (error) {
    return error instanceof SessionPlanningError ? error.code : 'invalid_plan';
  }
  return canonical(rebuilt) === canonical(input.plan) ? undefined : 'invalid_plan';
}

export function applySessionMutationPlan(input: {
  readonly plan: SessionMutationPlanDto;
  readonly catalog: SessionCatalog;
  readonly vocabulary: ProgramVocabularyState;
}): { readonly catalog: SessionCatalog; readonly result: SessionMutationResult } {
  const refusal = validateSessionMutationPlan(input);
  if (refusal) throw new SessionPlanningError(refusal);
  const sessions = input.catalog.sessions.filter((session) => session.id !== input.plan.after.id);
  sessions.push(input.plan.after);
  sessions.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const catalog = catalogWith(input.catalog.scope, input.plan.catalogVersion.after, sessions);
  if (catalog.digestSha256 !== input.plan.catalogDigestSha256.after) {
    throw new SessionPlanningError('invalid_plan');
  }
  return Object.freeze({
    catalog,
    result: sessionMutationResultSchema.parse({
      action: input.plan.input.action,
      catalogVersion: catalog.version,
      session: input.plan.after
    })
  });
}

export function planSessionCompensation(input: {
  readonly original: SessionMutationPlanDto;
  readonly catalog: SessionCatalog;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): SessionRestorePlanDto {
  const current = findSession(input.catalog, input.original.after.id);
  if (!current || current.digestSha256 !== input.original.after.digestSha256
      || input.catalog.version !== input.original.catalogVersion.after
      || input.catalog.digestSha256 !== input.original.catalogDigestSha256.after) {
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
  const afterSessions = input.catalog.sessions.filter((session) => session.id !== current.id);
  if (restore) afterSessions.push(restore);
  afterSessions.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const afterCatalog = catalogWith(input.catalog.scope, input.catalog.version + 1, afterSessions);
  return sessionRestorePlanSchema.parse({
    action: 'restore',
    scope: input.catalog.scope,
    expectedCatalogVersion: input.catalog.version,
    expectedCatalogDigestSha256: input.catalog.digestSha256,
    expectedCurrent: current,
    restore,
    catalogVersion: { before: input.catalog.version, after: afterCatalog.version },
    catalogDigestSha256: { before: input.catalog.digestSha256, after: afterCatalog.digestSha256 },
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt
  });
}

export function applySessionRestorePlan(input: {
  readonly plan: SessionRestorePlanDto;
  readonly catalog: SessionCatalog;
}): { readonly catalog: SessionCatalog; readonly result: SessionMutationResult } {
  const plan = sessionRestorePlanSchema.parse(input.plan);
  requireCatalogGuard(input.catalog, plan.expectedCatalogVersion, plan.expectedCatalogDigestSha256);
  if (!sameSessionScope(input.catalog.scope, plan.scope)) throw new SessionPlanningError('wrong_scope');
  const current = findSession(input.catalog, plan.expectedCurrent.id);
  if (!current || current.digestSha256 !== plan.expectedCurrent.digestSha256
      || current.version !== plan.expectedCurrent.version) throw new SessionPlanningError('stale_session');
  const sessions = input.catalog.sessions.filter((session) => session.id !== current.id);
  if (plan.restore) sessions.push(parseSessionHead(plan.restore));
  sessions.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const catalog = catalogWith(input.catalog.scope, plan.catalogVersion.after, sessions);
  if (catalog.digestSha256 !== plan.catalogDigestSha256.after) throw new SessionPlanningError('invalid_plan');
  return Object.freeze({
    catalog,
    result: sessionMutationResultSchema.parse({ action: 'restore', catalogVersion: catalog.version, session: plan.restore })
  });
}

function buildMutationPlan(
  planningInput: SessionPlanningInput,
  catalog: SessionCatalog,
  before: SessionHead | null,
  after: SessionHead
): SessionMutationPlanDto {
  const sessions = catalog.sessions.filter((session) => session.id !== after.id).concat(after)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const nextCatalog = catalogWith(catalog.scope, catalog.version + 1, sessions);
  return sessionMutationPlanSchema.parse({
    input: planningInput,
    before,
    after,
    catalogVersion: { before: catalog.version, after: nextCatalog.version },
    catalogDigestSha256: { before: catalog.digestSha256, after: nextCatalog.digestSha256 }
  });
}

function catalogWith(scope: SessionScope, version: number, sessions: readonly SessionHead[]): SessionCatalog {
  const unsigned = { schemaVersion: 1 as const, scope, version, sessions };
  return parseSessionCatalog({ ...unsigned, digestSha256: sessionCatalogDigest(unsigned) });
}

function currentTargetEvidence(
  vocabulary: ProgramVocabularyState,
  formatId: string,
  trackId: string | null
): SessionProgramTargetEvidenceDto {
  const format = resolveProgramVocabularyItem(vocabulary, 'format', formatId);
  if (!format) throw new SessionPlanningError('format_missing');
  if (format.status !== 'active') throw new SessionPlanningError('format_retired');
  const track = trackId === null ? null : resolveProgramVocabularyItem(vocabulary, 'track', trackId);
  if (trackId !== null && !track) throw new SessionPlanningError('track_missing');
  if (track && track.status !== 'active') throw new SessionPlanningError('track_retired');
  const formatEvidence = {
    kind: 'format' as const,
    id: format.id,
    name: format.name,
    status: 'active' as const,
    version: format.version
  };
  const trackEvidence = track ? {
    kind: 'track' as const,
    id: track.id,
    name: track.name,
    accent: track.accent,
    status: 'active' as const,
    version: track.version
  } : null;
  return Object.freeze({
    setVersion: vocabulary.setVersion,
    setDigestSha256: programVocabularySetDigest(vocabulary),
    format: formatEvidence,
    track: trackEvidence
  });
}

function requireEnvironment(
  scope: SessionScope,
  catalog: SessionCatalog,
  vocabulary: ProgramVocabularyState
): void {
  if (!sameSessionScope(scope, catalog.scope)
      || scope.workspaceId !== vocabulary.scope.workspaceId
      || scope.eventId !== vocabulary.scope.eventId) throw new SessionPlanningError('wrong_scope');
}

function requireCatalogGuard(catalog: SessionCatalog, version: number, digest: string): void {
  if (catalog.version !== version || catalog.digestSha256 !== digest) {
    throw new SessionPlanningError('stale_catalog');
  }
}

function requireTransition(from: SessionHead['lifecycle'], to: 'collecting' | 'programmed'): void {
  const valid = from === 'draft' ? (to === 'collecting' || to === 'programmed')
    : from === 'collecting' ? to === 'programmed'
      : false;
  if (!valid) throw new SessionPlanningError('invalid_transition');
}

function canonical(value: unknown): string {
  return Buffer.from(encodeCanonicalJson(value)).toString('utf8');
}
