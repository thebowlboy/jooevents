import {
  decisionAuthorInputSchema,
  decisionIdSchema,
  decisionMutationPlanSchema,
  decisionMutationResultSchema,
  decisionMutationPlanningInputSchema,
  type DecisionAuthorInput,
  type DecisionEvidenceDto,
  type DecisionHeadDto,
  type DecisionMutationPlanDto,
  type DecisionMutationPlanningInput,
  type DecisionMutationResult,
  type DecisionPlanningGraduation,
  type DecisionRowPlanDto,
  type DecisionScopeDto,
  type DecisionTargetPinDto,
  type DecisionTargetUnavailableDetail,
  type SessionRosterParticipantInput,
  type SubmissionSessionOriginDto
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import {
  applySessionMutationPlan,
  planSessionGraduationFrom,
  sessionGraduationFactPayload,
  SessionPlanningError,
  type SessionCatalog,
  type SessionGraduationReadPort,
  type SessionGraduationContribution,
  type SessionPlanningErrorCode
} from '@jooevents/session';
import {
  decisionHeadDigest,
  type DecisionOperationReadPort,
  type DecisionScope
} from './model';

/** Recorded default duration for a spawned Session until a richer basis exists. */
export const DECISION_SPAWN_PLANNED_DURATION_MINUTES = 30;

export type DecisionPlanningErrorCode =
  | 'wrong_scope'
  | 'submission_missing'
  | 'decision_exists'
  | 'decision_missing'
  | 'stale_decision'
  | 'origin_exists'
  | 'origin_changed'
  | 'session_placed'
  | 'title_missing'
  | 'title_unrepresentable'
  | 'format_missing'
  | SessionPlanningErrorCode;

export const DECISION_PLANNING_ERROR_CODES = Object.freeze([
  'wrong_scope', 'submission_missing', 'decision_exists', 'decision_missing',
  'stale_decision', 'origin_exists', 'origin_changed', 'session_placed',
  'title_missing', 'title_unrepresentable', 'format_missing', 'stale_catalog',
  'session_exists', 'session_missing', 'stale_session', 'format_retired',
  'track_missing', 'track_retired', 'track_required', 'invalid_transition', 'invalid_plan'
] as const satisfies readonly DecisionPlanningErrorCode[]);

export class DecisionPlanningError extends Error {
  constructor(
    readonly code: DecisionPlanningErrorCode,
    readonly submissionId?: string
  ) {
    super(code);
    this.name = 'DecisionPlanningError';
  }
}

/**
 * The structured filled-target condition: the addressed attach target cannot
 * take this acceptance, and the caller is offered the two decided exits. This
 * is deliberately not a stale-plan code — it survives as its own typed outcome.
 */
export class DecisionTargetUnavailableError extends Error {
  readonly detail: DecisionTargetUnavailableDetail;

  constructor(
    reason: DecisionTargetUnavailableDetail['reason'],
    readonly submissionId: string,
    readonly sessionId: string
  ) {
    super('decision_target_unavailable');
    this.name = 'DecisionTargetUnavailableError';
    this.detail = Object.freeze({ reason, exits: Object.freeze(['retarget', 'spawn']) as ['retarget', 'spawn'] });
  }
}

export interface DecisionEnvironment {
  readonly decisions: DecisionOperationReadPort;
  readonly sessions: SessionGraduationReadPort;
}

export function planDecisionMutation(input: {
  readonly planningInput: DecisionMutationPlanningInput;
  readonly environment: DecisionEnvironment;
}): DecisionMutationPlanDto {
  const planningInput = decisionMutationPlanningInputSchema.parse(input.planningInput);
  const scope = planningInput.scope;
  const sessionView = openSessionView(scope, input.environment.sessions);
  const rows: DecisionRowPlanDto[] = [];
  for (const row of planningInput.decisions) {
    const candidate = input.environment.decisions.readDecisionCandidate(scope, row.submissionId);
    if (!candidate || candidate.submissionId !== row.submissionId) {
      throw new DecisionPlanningError('submission_missing', row.submissionId);
    }
    const before = input.environment.decisions.readDecisionHead(scope, row.submissionId) ?? null;
    if (row.expectedDecisionVersion === null) {
      if (before !== null) throw new DecisionPlanningError('decision_exists', row.submissionId);
    } else {
      if (before === null) throw new DecisionPlanningError('decision_missing', row.submissionId);
      if (before.version !== row.expectedDecisionVersion
          || before.digestSha256 !== row.expectedDecisionDigestSha256) {
        throw new DecisionPlanningError('stale_decision', row.submissionId);
      }
    }
    const review = input.environment.decisions.readDecisionReviewBasis(scope, row.submissionId) ?? null;
    let graduation: SessionGraduationContribution | null = null;
    let target: DecisionTargetPinDto | null = null;
    let origin: SubmissionSessionOriginDto | null = null;
    if (row.state === 'accepted') {
      const routing = row.graduation;
      if (routing === null) throw new DecisionPlanningError('invalid_plan', row.submissionId);
      if (input.environment.decisions.readSubmissionSessionOrigin(scope, row.submissionId)) {
        throw new DecisionPlanningError('origin_exists', row.submissionId);
      }
      const participants = candidateParticipants(candidate.participantPersonIds, {
        submissionId: row.submissionId,
        candidateVersion: candidate.candidateVersion
      });
      const attribution = { userId: planningInput.actorUserId, at: planningInput.occurredAt };
      if (routing.kind === 'attach') {
        const resolved = sessionView.find(routing.sessionId);
        if (!resolved) {
          throw new DecisionTargetUnavailableError('target_missing', row.submissionId, routing.sessionId);
        }
        if (resolved.lifecycle === 'draft') {
          throw new DecisionTargetUnavailableError('target_closed', row.submissionId, routing.sessionId);
        }
        if (resolved.lifecycle === 'programmed') {
          throw new DecisionTargetUnavailableError('target_graduated', row.submissionId, routing.sessionId);
        }
        target = Object.freeze({
          kind: 'session' as const,
          id: resolved.id,
          title: resolved.title,
          version: resolved.version,
          lifecycle: 'collecting' as const
        });
        graduation = sessionView.plan({
          kind: 'attach',
          scope,
          attribution,
          sessionId: routing.sessionId,
          participants,
          ...(routing.graduateTo === undefined ? {} : { graduateTo: routing.graduateTo })
        });
      } else {
        if (candidate.title === null) throw new DecisionPlanningError('title_missing', row.submissionId);
        if (candidate.formatId === null) throw new DecisionPlanningError('format_missing', row.submissionId);
        const spawnTitle = candidate.title.normalize('NFC').trim().replace(/\s+/gu, ' ');
        if (spawnTitle.length === 0 || spawnTitle.length > 300) {
          throw new DecisionPlanningError('title_unrepresentable', row.submissionId);
        }
        graduation = sessionView.plan({
          kind: 'spawn',
          scope,
          attribution,
          identity: { sessionId: routing.sessionId },
          title: spawnTitle,
          plannedDurationMinutes: DECISION_SPAWN_PLANNED_DURATION_MINUTES,
          lifecycle: 'programmed',
          formatId: candidate.formatId,
          trackId: routing.trackId,
          participants
        });
      }
      origin = Object.freeze({
        schemaVersion: 1 as const,
        scope,
        submissionId: row.submissionId,
        sessionId: graduation.after.id,
        kind: routing.kind === 'spawn' ? 'spawned' as const : 'attached' as const,
        linkedByUserId: planningInput.actorUserId,
        linkedAt: planningInput.occurredAt
      });
    }
    const unsignedAfter = {
      schemaVersion: 1 as const,
      scope,
      submissionId: row.submissionId,
      state: row.state,
      version: (before?.version ?? 0) + 1,
      decidedByUserId: planningInput.actorUserId,
      decidedAt: planningInput.occurredAt
    };
    rows.push({
      submissionId: row.submissionId,
      before,
      after: { ...unsignedAfter, digestSha256: decisionHeadDigest(unsignedAfter) },
      evidence: {
        submission: {
          submissionId: candidate.submissionId,
          formVersionId: candidate.formVersionId,
          candidateVersion: candidate.candidateVersion
        },
        review,
        target
      },
      graduation,
      origin
    });
  }
  return decisionMutationPlanSchema.parse({ input: planningInput, rows });
}

export type DecisionPlanRefusal =
  | { readonly kind: 'stale'; readonly code: DecisionPlanningErrorCode; readonly submissionId: string }
  | {
      readonly kind: 'target_unavailable';
      readonly submissionId: string;
      readonly sessionId: string;
      readonly detail: DecisionTargetUnavailableDetail;
    };

export function validateDecisionMutationPlan(input: {
  readonly plan: DecisionMutationPlanDto;
  readonly environment: DecisionEnvironment;
}): DecisionPlanRefusal | undefined {
  let rebuilt: DecisionMutationPlanDto;
  try {
    rebuilt = planDecisionMutation({
      planningInput: input.plan.input,
      environment: input.environment
    });
  } catch (error) {
    return refusalFromError(error, subjectSubmissionId(input.plan));
  }
  return canonical(rebuilt) === canonical(input.plan)
    ? undefined
    : { kind: 'stale', code: 'invalid_plan', submissionId: subjectSubmissionId(input.plan) };
}

export function decisionMutationResultFromPlan(plan: DecisionMutationPlanDto): DecisionMutationResult {
  return decisionMutationResultSchema.parse({
    action: 'decide',
    rows: plan.rows.map((row) => ({
      submissionId: row.submissionId,
      head: row.after,
      origin: row.origin
    })),
    sessions: plan.rows.flatMap((row) =>
      row.graduation === null ? [] : [sessionGraduationFactPayload(row.graduation)]
    )
  });
}

/**
 * Resolves the operator wire input into deterministic planning input. Every
 * accepted row leaves with explicit graduation routing: an explicit choice is
 * honored (spawn identities are server-minted), and an omitted choice routes by
 * the submission's effective target — a resolvable collecting target Session
 * attaches, a submission without any target spawns, and an addressed target
 * that cannot take the attach (missing, not yet collecting, or already
 * graduated) raises the structured `DecisionTargetUnavailableError` instead of
 * silently spawning. Resolution reads the current Session catalog; a target
 * filled by an earlier row of the same bulk decide is still refused
 * deterministically when the composite plan replans its sequential view.
 */
export function resolveDecisionMutationPlanningInput(input: {
  readonly authorInput: DecisionAuthorInput;
  readonly scope: DecisionScopeDto;
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly environment: DecisionEnvironment;
  readonly newSessionId: () => string;
}): DecisionMutationPlanningInput {
  const wire = decisionAuthorInputSchema.parse(input.authorInput);
  const catalog = input.environment.sessions.readSessionCatalog(input.scope);
  if (!catalog) throw new DecisionPlanningError('wrong_scope');
  const decisions = wire.decisions.map((row) => {
    let graduation: DecisionPlanningGraduation | null = null;
    if (row.state === 'accepted') {
      const choice = row.graduation ?? effectiveTargetChoice({
        environment: input.environment,
        scope: input.scope,
        submissionId: row.submissionId,
        catalog
      });
      graduation = choice.kind === 'spawn'
        ? {
            kind: 'spawn',
            sessionId: decisionIdSchema.parse(input.newSessionId()),
            trackId: resolvedSpawnTrackId({
              environment: input.environment,
              scope: input.scope,
              submissionId: row.submissionId,
              ...(choice.trackId === undefined ? {} : { explicitTrackId: choice.trackId })
            })
          }
        : {
            kind: 'attach',
            sessionId: choice.sessionId,
            ...(choice.graduateTo === undefined ? {} : { graduateTo: choice.graduateTo })
          };
    }
    return {
      submissionId: row.submissionId,
      state: row.state,
      expectedDecisionVersion: row.expectedDecisionVersion,
      expectedDecisionDigestSha256: row.expectedDecisionDigestSha256,
      graduation
    };
  });
  return decisionMutationPlanningInputSchema.parse({
    action: 'decide',
    scope: input.scope,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    decisions
  });
}

function resolvedSpawnTrackId(input: {
  readonly environment: DecisionEnvironment;
  readonly scope: DecisionScopeDto;
  readonly submissionId: string;
  readonly explicitTrackId?: string;
}): string | null {
  if (input.explicitTrackId !== undefined) return decisionIdSchema.parse(input.explicitTrackId);
  const candidate = input.environment.decisions.readDecisionCandidate(input.scope, input.submissionId);
  if (!candidate || candidate.submissionId !== input.submissionId) {
    throw new DecisionPlanningError('submission_missing', input.submissionId);
  }
  return candidate.trackId;
}

function effectiveTargetChoice(input: {
  readonly environment: DecisionEnvironment;
  readonly scope: DecisionScopeDto;
  readonly submissionId: string;
  readonly catalog: SessionCatalog;
}): { readonly kind: 'spawn'; readonly trackId?: string } | {
  readonly kind: 'attach';
  readonly sessionId: string;
  readonly graduateTo?: 'programmed';
} {
  const candidate = input.environment.decisions.readDecisionCandidate(
    input.scope,
    input.submissionId
  );
  if (!candidate || candidate.submissionId !== input.submissionId) {
    throw new DecisionPlanningError('submission_missing', input.submissionId);
  }
  if (candidate.targetSessionId === null) return { kind: 'spawn' };
  const target = input.catalog.sessions.find(
    (session) => session.id === candidate.targetSessionId
  );
  if (!target) {
    throw new DecisionTargetUnavailableError(
      'target_missing', input.submissionId, candidate.targetSessionId
    );
  }
  if (target.lifecycle === 'draft') {
    throw new DecisionTargetUnavailableError(
      'target_closed', input.submissionId, candidate.targetSessionId
    );
  }
  if (target.lifecycle === 'programmed') {
    throw new DecisionTargetUnavailableError(
      'target_graduated', input.submissionId, candidate.targetSessionId
    );
  }
  return { kind: 'attach', sessionId: target.id };
}

interface SessionViewPort {
  find(sessionId: string): SessionCatalog['sessions'][number] | undefined;
  plan(input: Parameters<typeof planSessionGraduationFrom>[1]): SessionGraduationContribution;
}

/**
 * Sequential planning view over the Session catalog: each planned contribution
 * advances the in-memory catalog, so chained graduations inside one decide plan
 * line their catalog and per-session guards up for sequential apply.
 */
function openSessionView(scope: DecisionScope, sessions: SessionGraduationReadPort): SessionViewPort {
  let catalog = sessions.readSessionCatalog(scope);
  const vocabulary = sessions.readSessionVocabulary(scope);
  if (!catalog || !vocabulary) throw new DecisionPlanningError('wrong_scope');
  const overlay: SessionGraduationReadPort = Object.freeze({
    readSessionCatalog: () => catalog,
    readSessionVocabulary: () => vocabulary,
    countSessionSchedulePlacements: (placementScope: DecisionScope, sessionId: string) =>
      sessions.countSessionSchedulePlacements(placementScope, sessionId)
  });
  return Object.freeze({
    find(sessionId: string) {
      return catalog!.sessions.find((session) => session.id === sessionId);
    },
    plan(input: Parameters<typeof planSessionGraduationFrom>[1]) {
      const contribution = planSessionGraduationFrom(overlay, input);
      catalog = applySessionMutationPlan({ plan: contribution, catalog: catalog!, vocabulary }).catalog;
      return contribution;
    }
  });
}

function candidateParticipants(
  personIds: readonly string[],
  source: { readonly submissionId: string; readonly candidateVersion: number }
): readonly SessionRosterParticipantInput[] {
  return Object.freeze(personIds.map((personId) => ({
    personId,
    role: 'speaker' as const,
    publiclyVisible: true,
    source: {
      kind: 'submission',
      id: source.submissionId,
      version: source.candidateVersion
    }
  })));
}

function refusalFromError(error: unknown, fallbackSubmissionId: string): DecisionPlanRefusal {
  if (error instanceof DecisionTargetUnavailableError) {
    return {
      kind: 'target_unavailable',
      submissionId: error.submissionId,
      sessionId: error.sessionId,
      detail: error.detail
    };
  }
  if (error instanceof DecisionPlanningError) {
    return {
      kind: 'stale',
      code: error.code,
      submissionId: error.submissionId ?? fallbackSubmissionId
    };
  }
  if (error instanceof SessionPlanningError) {
    return { kind: 'stale', code: error.code, submissionId: fallbackSubmissionId };
  }
  return { kind: 'stale', code: 'invalid_plan', submissionId: fallbackSubmissionId };
}

function subjectSubmissionId(plan: DecisionMutationPlanDto): string {
  return plan.rows[0]?.submissionId ?? plan.input.decisions[0]!.submissionId;
}

function canonical(value: unknown): string {
  return Buffer.from(encodeCanonicalJson(value)).toString('utf8');
}
