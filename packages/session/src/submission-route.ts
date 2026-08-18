import {
  sessionSubmissionAttachPlanSchema,
  sessionSubmissionMovePlanSchema,
  sessionSubmissionMoveRestorePlanSchema,
  sessionSubmissionRestorePlanBundleSchema,
  engagementSeedReversalPlanSchema,
  type DecisionHeadDto,
  type SessionSubmissionAttachPlanDto,
  type SessionSubmissionMovePlanDto,
  type SessionSubmissionMoveRestorePlanDto,
  type SessionParticipantSupportDto,
  type SessionParticipantSupportChangePlanDto,
  type SessionRosterSourceRefDto,
  type SessionSubmissionRouteInput,
  type SessionSubmissionRestorePlanBundleDto,
  type SubmissionSessionOriginDto
} from '@jooevents/contracts';
import {
  planEngagementSeedFrom,
  type EngagementReadPort
} from '@jooevents/engagement';
import { encodeCanonicalJson } from '@jooevents/kernel';
import type { ProgramVocabularyState } from '@jooevents/program';
import {
  applySessionMutationPlan,
  planSessionCompensation,
  planSessionMutation,
  SessionPlanningError
} from './domain';
import type { SessionCatalog } from './model';

export type SessionSubmissionRoutePlanningErrorCode =
  | 'wrong_scope'
  | 'stale_catalog'
  | 'session_missing'
  | 'stale_session'
  | 'submission_missing'
  | 'submission_not_accepted'
  | 'submission_already_routed'
  | 'submission_has_no_participants'
  | 'origin_changed'
  | 'support_changed'
  | 'engagement_advanced'
  | 'invalid_plan';

export class SessionSubmissionRoutePlanningError extends Error {
  constructor(
    readonly code: SessionSubmissionRoutePlanningErrorCode,
    readonly subjectId: string
  ) {
    super(code);
    this.name = 'SessionSubmissionRoutePlanningError';
  }
}

export interface SessionSubmissionRoutePlanningEnvironment {
  readonly sessions: {
    readSessionCatalog(scope: { readonly workspaceId: string; readonly eventId: string }): SessionCatalog | undefined;
    readSessionVocabulary(scope: { readonly workspaceId: string; readonly eventId: string }): ProgramVocabularyState | undefined;
  };
  readonly decisions: {
    readDecisionHead(scope: { readonly workspaceId: string; readonly eventId: string }, submissionId: string): DecisionHeadDto | undefined;
    readDecisionCandidate(scope: { readonly workspaceId: string; readonly eventId: string }, submissionId: string): {
      readonly submissionId: string;
      readonly candidateVersion: number;
      readonly participantPersonIds: readonly string[];
    } | undefined;
    readSubmissionSessionOrigin(scope: { readonly workspaceId: string; readonly eventId: string }, submissionId: string): SubmissionSessionOriginDto | undefined;
  };
  readonly engagements: EngagementReadPort;
  readonly supports: SessionParticipantSupportReadPort;
}

export interface SessionParticipantSupportReadPort {
  readParticipantSupport(
    scope: { readonly workspaceId: string; readonly eventId: string },
    sessionId: string,
    personId: string,
    support: { readonly kind: 'submission'; readonly submissionId: string }
      | { readonly kind: 'editorial'; readonly source: SessionRosterSourceRefDto }
  ): SessionParticipantSupportDto | undefined;
  listParticipantSupports(
    scope: { readonly workspaceId: string; readonly eventId: string },
    sessionId: string,
    personId: string
  ): readonly SessionParticipantSupportDto[];
}

export interface SessionParticipantSupportTransactionPort
extends SessionParticipantSupportReadPort {
  applyParticipantSupportChanges(plan: SessionParticipantSupportChangePlanDto): void;
}

function canonical(value: unknown): string {
  return Buffer.from(encodeCanonicalJson(value)).toString('utf8');
}

function routeError(error: unknown, subjectId: string): never {
  if (error instanceof SessionSubmissionRoutePlanningError) throw error;
  if (error instanceof SessionPlanningError) {
    const code = error.code === 'wrong_scope' || error.code === 'stale_catalog'
      || error.code === 'session_missing' || error.code === 'stale_session'
      ? error.code
      : 'invalid_plan';
    throw new SessionSubmissionRoutePlanningError(code, subjectId);
  }
  if (error instanceof Error && error.name === 'EngagementSeedError') {
    throw new SessionSubmissionRoutePlanningError(
      error.message === 'engagement_advanced' ? 'engagement_advanced' : 'invalid_plan',
      subjectId
    );
  }
  throw error;
}

export function planSessionSubmissionAttach(input: {
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly author: {
    readonly expectedCatalogVersion: number;
    readonly expectedCatalogDigestSha256: string;
    readonly expectedSessionVersion: number;
    readonly expectedSessionDigestSha256: string;
    readonly targetSessionId: string;
    readonly submissionId: string;
  };
  readonly environment: SessionSubmissionRoutePlanningEnvironment;
}): SessionSubmissionAttachPlanDto {
  const subjectId = input.author.submissionId;
  try {
    const catalog = input.environment.sessions.readSessionCatalog(input.scope);
    const vocabulary = input.environment.sessions.readSessionVocabulary(input.scope);
    if (!catalog || !vocabulary) {
      throw new SessionSubmissionRoutePlanningError('wrong_scope', subjectId);
    }
    const decision = input.environment.decisions.readDecisionHead(input.scope, subjectId);
    const candidate = input.environment.decisions.readDecisionCandidate(input.scope, subjectId);
    if (!decision || !candidate) {
      throw new SessionSubmissionRoutePlanningError('submission_missing', subjectId);
    }
    if (decision.state !== 'accepted') {
      throw new SessionSubmissionRoutePlanningError('submission_not_accepted', subjectId);
    }
    if (input.environment.decisions.readSubmissionSessionOrigin(input.scope, subjectId)) {
      throw new SessionSubmissionRoutePlanningError('submission_already_routed', subjectId);
    }
    const personIds = [...new Set(candidate.participantPersonIds)].sort();
    if (personIds.length === 0) {
      throw new SessionSubmissionRoutePlanningError('submission_has_no_participants', subjectId);
    }
    const target = catalog.sessions.find((session) => session.id === input.author.targetSessionId);
    if (!target) throw new SessionSubmissionRoutePlanningError('session_missing', subjectId);
    const source = Object.freeze({
      kind: 'submission' as const,
      id: subjectId,
      version: candidate.candidateVersion
    });
    const sessionPlan = planSessionMutation({
      catalog,
      vocabulary,
      planningInput: {
        action: 'roster_append',
        scope: input.scope,
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
        expectedCatalogVersion: input.author.expectedCatalogVersion,
        expectedCatalogDigestSha256: input.author.expectedCatalogDigestSha256,
        sessionId: target.id,
        expectedSessionVersion: input.author.expectedSessionVersion,
        expectedSessionDigestSha256: input.author.expectedSessionDigestSha256,
        participants: personIds.map((personId) => ({
          personId,
          role: 'speaker' as const,
          publiclyVisible: true,
          source
        })),
        ...(target.lifecycle === 'programmed' ? {} : { graduateTo: 'programmed' as const })
      }
    });
    const origin = Object.freeze({
      schemaVersion: 1 as const,
      scope: input.scope,
      submissionId: subjectId,
      sessionId: target.id,
      kind: 'attached' as const,
      linkedByUserId: input.actorUserId,
      linkedAt: input.occurredAt
    });
    const engagementSeed = planEngagementSeedFrom(input.environment.engagements, {
      scope: input.scope,
      sessionId: target.id,
      submissionId: subjectId,
      seededByDecision: {
        version: decision.version,
        digestSha256: decision.digestSha256
      },
      source,
      personIds,
      invitedAt: input.occurredAt,
      respondBy: null
    });
    const supportInserts = personIds.map((personId) => {
      const support = Object.freeze({
        schemaVersion: 1 as const,
        scope: input.scope,
        sessionId: target.id,
        personId,
        kind: 'submission' as const,
        submissionId: subjectId
      });
      if (input.environment.supports.readParticipantSupport(
        input.scope, target.id, personId,
        { kind: 'submission', submissionId: subjectId }
      )) throw new SessionSubmissionRoutePlanningError('invalid_plan', personId);
      return support;
    });
    return sessionSubmissionAttachPlanSchema.parse({
      sessionPlan, origin, engagementSeed, supportInserts
    });
  } catch (error) {
    return routeError(error, subjectId);
  }
}

type MoveAuthor = Extract<SessionSubmissionRouteInput, { readonly action: 'move' }>;
type MoveRestoreAuthor = Extract<SessionSubmissionRouteInput, { readonly action: 'restore_move' }>;

function sourceFromSupport(
  environment: SessionSubmissionRoutePlanningEnvironment,
  scope: { readonly workspaceId: string; readonly eventId: string },
  support: SessionParticipantSupportDto
): SessionRosterSourceRefDto {
  if (support.kind === 'editorial') return support.source;
  const candidate = environment.decisions.readDecisionCandidate(scope, support.submissionId);
  if (!candidate || !candidate.participantPersonIds.includes(support.personId)) {
    throw new SessionSubmissionRoutePlanningError('support_changed', support.personId);
  }
  return Object.freeze({
    kind: 'submission', id: support.submissionId, version: candidate.candidateVersion
  });
}

function planRosterReconciliations(input: {
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly catalog: SessionCatalog;
  readonly vocabulary: ProgramVocabularyState;
  readonly desired: ReadonlyMap<string, readonly import('@jooevents/contracts').SessionParticipantRefDto[]>;
}): { readonly catalog: SessionCatalog; readonly plans: readonly import('@jooevents/contracts').SessionMutationPlanDto[] } {
  let catalog = input.catalog;
  const plans: import('@jooevents/contracts').SessionMutationPlanDto[] = [];
  for (const sessionId of [...input.desired.keys()].sort()) {
    const current = catalog.sessions.find((session) => session.id === sessionId);
    if (!current) throw new SessionSubmissionRoutePlanningError('session_missing', sessionId);
    const participants = input.desired.get(sessionId)!;
    if (canonical(current.roster.participants) === canonical(participants)) continue;
    const plan = planSessionMutation({
      catalog,
      vocabulary: input.vocabulary,
      planningInput: {
        action: 'roster_reconcile',
        scope: input.scope,
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
        expectedCatalogVersion: catalog.version,
        expectedCatalogDigestSha256: catalog.digestSha256,
        sessionId,
        expectedSessionVersion: current.version,
        expectedSessionDigestSha256: current.digestSha256,
        expectedRosterVersion: current.roster.version,
        participants: [...participants]
      }
    });
    plans.push(plan);
    catalog = applySessionMutationPlan({ plan, catalog, vocabulary: input.vocabulary }).catalog;
  }
  return Object.freeze({ catalog, plans: Object.freeze(plans) });
}

/** Plans one accepted Submission move across origin, support, Session, and Engagement owners. */
export function planSessionSubmissionMove(input: {
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly author: MoveAuthor;
  readonly environment: SessionSubmissionRoutePlanningEnvironment;
}): SessionSubmissionMovePlanDto {
  const subjectId = input.author.submissionId;
  try {
    const catalog = input.environment.sessions.readSessionCatalog(input.scope);
    const vocabulary = input.environment.sessions.readSessionVocabulary(input.scope);
    if (!catalog || !vocabulary) throw new SessionSubmissionRoutePlanningError('wrong_scope', subjectId);
    if (catalog.version !== input.author.expectedCatalogVersion
        || catalog.digestSha256 !== input.author.expectedCatalogDigestSha256) {
      throw new SessionSubmissionRoutePlanningError('stale_catalog', subjectId);
    }
    const source = catalog.sessions.find((session) => session.id === input.author.sourceSessionId);
    const target = catalog.sessions.find((session) => session.id === input.author.targetSessionId);
    if (!source || !target) throw new SessionSubmissionRoutePlanningError('session_missing', subjectId);
    if (source.version !== input.author.expectedSourceSessionVersion
        || source.digestSha256 !== input.author.expectedSourceSessionDigestSha256
        || target.version !== input.author.expectedTargetSessionVersion
        || target.digestSha256 !== input.author.expectedTargetSessionDigestSha256) {
      throw new SessionSubmissionRoutePlanningError('stale_session', subjectId);
    }
    const decision = input.environment.decisions.readDecisionHead(input.scope, subjectId);
    const candidate = input.environment.decisions.readDecisionCandidate(input.scope, subjectId);
    if (!decision || !candidate) throw new SessionSubmissionRoutePlanningError('submission_missing', subjectId);
    if (decision.state !== 'accepted') {
      throw new SessionSubmissionRoutePlanningError('submission_not_accepted', subjectId);
    }
    const originBefore = input.environment.decisions.readSubmissionSessionOrigin(input.scope, subjectId);
    if (!originBefore || originBefore.sessionId !== source.id) {
      throw new SessionSubmissionRoutePlanningError('origin_changed', subjectId);
    }
    const personIds = [...new Set(candidate.participantPersonIds)].sort();
    if (personIds.length === 0) {
      throw new SessionSubmissionRoutePlanningError('submission_has_no_participants', subjectId);
    }
    const submissionSource = Object.freeze({
      kind: 'submission' as const, id: subjectId, version: candidate.candidateVersion
    });
    const remove: SessionParticipantSupportDto[] = [];
    const insert: SessionParticipantSupportDto[] = [];
    const desiredSource = [...source.roster.participants];
    const desiredTarget = [...target.roster.participants];
    for (const personId of personIds) {
      const sourceSupport = input.environment.supports.readParticipantSupport(
        input.scope, source.id, personId, { kind: 'submission', submissionId: subjectId }
      );
      if (!sourceSupport || sourceSupport.kind !== 'submission') {
        throw new SessionSubmissionRoutePlanningError('support_changed', personId);
      }
      if (input.environment.supports.readParticipantSupport(
        input.scope, target.id, personId, { kind: 'submission', submissionId: subjectId }
      )) throw new SessionSubmissionRoutePlanningError('support_changed', personId);
      remove.push(sourceSupport);
      insert.push(Object.freeze({
        schemaVersion: 1 as const,
        scope: input.scope,
        sessionId: target.id,
        personId,
        kind: 'submission' as const,
        submissionId: subjectId
      }));

      const sourceIndex = desiredSource.findIndex((participant) => participant.personId === personId);
      if (sourceIndex >= 0) {
        const participant = desiredSource[sourceIndex]!;
        const remaining = input.environment.supports
          .listParticipantSupports(input.scope, source.id, personId)
          .filter((support) => !(support.kind === 'submission' && support.submissionId === subjectId));
        if (remaining.length === 0) {
          desiredSource.splice(sourceIndex, 1);
        } else {
          const sources = remaining.map((support) => sourceFromSupport(
            input.environment, input.scope, support
          )).sort((left, right) => canonical(left).localeCompare(canonical(right)));
          const movingDisplayedSource = participant.source.kind === 'submission'
            && participant.source.id === subjectId;
          if (!movingDisplayedSource
              && !sources.some((candidateSource) => canonical(candidateSource) === canonical(participant.source))) {
            throw new SessionSubmissionRoutePlanningError('support_changed', personId);
          }
          if (movingDisplayedSource) desiredSource[sourceIndex] = { ...participant, source: sources[0]! };
        }
      }
      if (!desiredTarget.some((participant) => participant.personId === personId)) {
        desiredTarget.push({
          personId, role: 'speaker', publiclyVisible: true,
          position: desiredTarget.length, source: submissionSource
        });
      }
    }
    const compactSource = desiredSource.map((participant, position) => ({ ...participant, position }));
    const reconciled = planRosterReconciliations({
      scope: input.scope,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      catalog,
      vocabulary,
      desired: new Map([
        [source.id, compactSource],
        [target.id, desiredTarget]
      ])
    });
    const sourceAfter = reconciled.catalog.sessions.find((session) => session.id === source.id)!;
    const targetAfter = reconciled.catalog.sessions.find((session) => session.id === target.id)!;
    const originAfter = Object.freeze({
      schemaVersion: 1 as const,
      scope: input.scope,
      submissionId: subjectId,
      sessionId: target.id,
      kind: 'attached' as const,
      linkedByUserId: input.actorUserId,
      linkedAt: input.occurredAt
    });
    const engagementSeed = planEngagementSeedFrom(input.environment.engagements, {
      scope: input.scope,
      sessionId: target.id,
      submissionId: subjectId,
      seededByDecision: { version: decision.version, digestSha256: decision.digestSha256 },
      source: submissionSource,
      personIds,
      invitedAt: input.occurredAt,
      respondBy: null
    });
    return sessionSubmissionMovePlanSchema.parse({
      scope: input.scope,
      submissionId: subjectId,
      sourceSession: { before: source, after: sourceAfter },
      targetSession: { before: target, after: targetAfter },
      catalogVersion: { before: catalog.version, after: reconciled.catalog.version },
      catalogDigestSha256: {
        before: catalog.digestSha256, after: reconciled.catalog.digestSha256
      },
      sessionPlans: reconciled.plans,
      originBefore,
      originAfter,
      supportChanges: { remove, insert },
      engagementSeed
    });
  } catch (error) {
    return routeError(error, subjectId);
  }
}

/** Guarded inverse of one exact move receipt. */
export function planSessionSubmissionMoveRestore(input: {
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly author: MoveRestoreAuthor;
  readonly environment: SessionSubmissionRoutePlanningEnvironment;
}): SessionSubmissionMoveRestorePlanDto {
  const original = sessionSubmissionMovePlanSchema.parse(input.author.original);
  const subjectId = original.submissionId;
  try {
    const catalog = input.environment.sessions.readSessionCatalog(input.scope);
    const vocabulary = input.environment.sessions.readSessionVocabulary(input.scope);
    if (!catalog || !vocabulary) throw new SessionSubmissionRoutePlanningError('wrong_scope', subjectId);
    if (catalog.version !== input.author.expectedCatalogVersion
        || catalog.digestSha256 !== input.author.expectedCatalogDigestSha256) {
      throw new SessionSubmissionRoutePlanningError('stale_catalog', subjectId);
    }
    const source = catalog.sessions.find((session) => session.id === original.sourceSession.after.id);
    const target = catalog.sessions.find((session) => session.id === original.targetSession.after.id);
    if (!source || !target) throw new SessionSubmissionRoutePlanningError('session_missing', subjectId);
    if (source.version !== input.author.expectedSourceSessionVersion
        || source.digestSha256 !== input.author.expectedSourceSessionDigestSha256
        || target.version !== input.author.expectedTargetSessionVersion
        || target.digestSha256 !== input.author.expectedTargetSessionDigestSha256
        || canonical(source) !== canonical(original.sourceSession.after)
        || canonical(target) !== canonical(original.targetSession.after)) {
      throw new SessionSubmissionRoutePlanningError('stale_session', subjectId);
    }
    const currentOrigin = input.environment.decisions.readSubmissionSessionOrigin(input.scope, subjectId);
    if (!currentOrigin || canonical(currentOrigin) !== canonical(original.originAfter)) {
      throw new SessionSubmissionRoutePlanningError('origin_changed', subjectId);
    }
    for (const expected of original.supportChanges.insert) {
      if (expected.kind !== 'submission') {
        throw new SessionSubmissionRoutePlanningError('invalid_plan', expected.personId);
      }
      const current = input.environment.supports.readParticipantSupport(
        input.scope, expected.sessionId, expected.personId,
        { kind: 'submission', submissionId: expected.submissionId }
      );
      if (!current || canonical(current) !== canonical(expected)) {
        throw new SessionSubmissionRoutePlanningError('support_changed', expected.personId);
      }
    }
    for (const expected of original.supportChanges.remove) {
      if (expected.kind !== 'submission') {
        throw new SessionSubmissionRoutePlanningError('invalid_plan', expected.personId);
      }
      if (input.environment.supports.readParticipantSupport(
        input.scope, expected.sessionId, expected.personId,
        { kind: 'submission', submissionId: expected.submissionId }
      )) throw new SessionSubmissionRoutePlanningError('support_changed', expected.personId);
    }
    const engagementSeedReversal = engagementSeedReversalPlanSchema.parse({
      action: 'seed_reversal',
      scope: input.scope,
      sessionId: original.engagementSeed.input.sessionId,
      submissionId: original.engagementSeed.input.submissionId,
      seededByDecision: original.engagementSeed.input.seededByDecision,
      rows: original.engagementSeed.rows.map((row) => {
        const current = input.environment.engagements.readSessionPersonEngagement(
          input.scope, original.engagementSeed.input.sessionId, row.personId
        );
        if (!current || canonical(current) !== canonical(row.head)) {
          throw new SessionSubmissionRoutePlanningError('engagement_advanced', row.personId);
        }
        return { personId: row.personId, expectedCurrent: current };
      })
    });
    const reconciled = planRosterReconciliations({
      scope: input.scope,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      catalog,
      vocabulary,
      desired: new Map([
        [source.id, original.sourceSession.before.roster.participants],
        [target.id, original.targetSession.before.roster.participants]
      ])
    });
    return sessionSubmissionMoveRestorePlanSchema.parse({
      original,
      sessionPlans: reconciled.plans,
      originBefore: original.originAfter,
      originAfter: original.originBefore,
      supportChanges: {
        remove: original.supportChanges.insert,
        insert: original.supportChanges.remove
      },
      engagementSeedReversal,
      catalogVersion: { before: catalog.version, after: reconciled.catalog.version },
      catalogDigestSha256: {
        before: catalog.digestSha256, after: reconciled.catalog.digestSha256
      },
      sourceSession: reconciled.catalog.sessions.find((session) => session.id === source.id),
      targetSession: reconciled.catalog.sessions.find((session) => session.id === target.id)
    });
  } catch (error) {
    return routeError(error, subjectId);
  }
}

export function planSessionSubmissionRestore(input: {
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly expectedCatalogVersion: number;
  readonly expectedCatalogDigestSha256: string;
  readonly expectedSessionVersion: number;
  readonly expectedSessionDigestSha256: string;
  readonly original: SessionSubmissionAttachPlanDto;
  readonly environment: SessionSubmissionRoutePlanningEnvironment;
}): SessionSubmissionRestorePlanBundleDto {
  const original = sessionSubmissionAttachPlanSchema.parse(input.original);
  const subjectId = original.origin.submissionId;
  try {
    const catalog = input.environment.sessions.readSessionCatalog(input.scope);
    if (!catalog) throw new SessionSubmissionRoutePlanningError('wrong_scope', subjectId);
    if (catalog.version !== input.expectedCatalogVersion
        || catalog.digestSha256 !== input.expectedCatalogDigestSha256) {
      throw new SessionSubmissionRoutePlanningError('stale_catalog', subjectId);
    }
    const current = catalog.sessions.find((session) => session.id === original.origin.sessionId);
    if (!current) throw new SessionSubmissionRoutePlanningError('session_missing', subjectId);
    if (current.version !== input.expectedSessionVersion
        || current.digestSha256 !== input.expectedSessionDigestSha256) {
      throw new SessionSubmissionRoutePlanningError('stale_session', subjectId);
    }
    const origin = input.environment.decisions.readSubmissionSessionOrigin(input.scope, subjectId);
    if (!origin || canonical(origin) !== canonical(original.origin)) {
      throw new SessionSubmissionRoutePlanningError('origin_changed', subjectId);
    }
    const sessionPlan = planSessionCompensation({
      original: original.sessionPlan,
      catalog,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt
    });
    const engagementSeedReversal = engagementSeedReversalPlanSchema.parse({
      action: 'seed_reversal',
      scope: input.scope,
      sessionId: original.engagementSeed.input.sessionId,
      submissionId: original.engagementSeed.input.submissionId,
      seededByDecision: original.engagementSeed.input.seededByDecision,
      rows: original.engagementSeed.rows.map((row) => {
        const current = input.environment.engagements.readSessionPersonEngagement(
          input.scope,
          original.engagementSeed.input.sessionId,
          row.personId
        );
        if (!current || canonical(current) !== canonical(row.head)) {
          throw new SessionSubmissionRoutePlanningError('engagement_advanced', row.personId);
        }
        return { personId: row.personId, expectedCurrent: current };
      })
    });
    const supportRemovals = original.supportInserts.map((expected) => {
      if (expected.kind !== 'submission') {
        throw new SessionSubmissionRoutePlanningError('invalid_plan', expected.personId);
      }
      const current = input.environment.supports.readParticipantSupport(
        input.scope,
        expected.sessionId,
        expected.personId,
        { kind: 'submission', submissionId: expected.submissionId }
      );
      if (!current || canonical(current) !== canonical(expected)) {
        throw new SessionSubmissionRoutePlanningError('origin_changed', expected.personId);
      }
      return current;
    });
    return sessionSubmissionRestorePlanBundleSchema.parse({
      sessionPlan,
      origin,
      engagementSeedReversal,
      supportRemovals,
      original
    });
  } catch (error) {
    return routeError(error, subjectId);
  }
}
