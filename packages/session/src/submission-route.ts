import {
  sessionSubmissionAttachPlanSchema,
  sessionSubmissionRestorePlanBundleSchema,
  engagementSeedReversalPlanSchema,
  type DecisionHeadDto,
  type SessionSubmissionAttachPlanDto,
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
    return sessionSubmissionAttachPlanSchema.parse({ sessionPlan, origin, engagementSeed });
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
    return sessionSubmissionRestorePlanBundleSchema.parse({
      sessionPlan,
      origin,
      engagementSeedReversal,
      original
    });
  } catch (error) {
    return routeError(error, subjectId);
  }
}
