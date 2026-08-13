import {
  decisionHeadSchema,
  submissionSessionOriginSchema,
  type DecisionHeadDto,
  type DecisionMutationPlanDto,
  type DecisionMutationResult,
  type DecisionRestorePlanDto,
  type DecisionReviewPinDto,
  type DecisionScopeDto,
  type SubmissionSessionOriginDto
} from '@jooevents/contracts';
import { canonicalJsonSha256 } from '@jooevents/changesets';

export type DecisionScope = DecisionScopeDto;
export type DecisionHead = DecisionHeadDto;

export function decisionHeadDigest(head: unknown): string {
  return canonicalJsonSha256(head);
}

export function parseDecisionHead(value: unknown): DecisionHead {
  const head = decisionHeadSchema.parse(value);
  const { digestSha256, ...unsigned } = head;
  if (decisionHeadDigest(unsigned) !== digestSha256) throw new TypeError('decision_head_digest_mismatch');
  return deepFreeze(head);
}

export function parseSubmissionSessionOrigin(value: unknown): SubmissionSessionOriginDto {
  return deepFreeze(submissionSessionOriginSchema.parse(value));
}

export function decisionAggregateId(submissionId: string): string {
  return `decision_head:${submissionId}`;
}

export function decisionHeadAbsenceGuardId(submissionId: string): string {
  return `decision_head_absence:${submissionId}`;
}

/** Published as guard evidence only while the Decision head is truly absent. */
export function absentDecisionHeadDigest(scope: DecisionScope, submissionId: string): string {
  return canonicalJsonSha256({ scope, submissionId, state: 'absent' });
}

/**
 * Submission facts a decide plans over. Everything here is either an immutable
 * submission fact or a deterministic derivation of one; nothing exposes reviewer
 * identities or free-text answers.
 */
export interface DecisionCandidateDto {
  readonly submissionId: string;
  readonly formVersionId: string;
  readonly candidateVersion: number;
  readonly title: string | null;
  readonly formatId: string | null;
  readonly trackId: string | null;
  readonly targetSessionId: string | null;
  readonly participantPersonIds: readonly string[];
}

export interface DecisionEnvironmentSource {
  readDecisionCandidate(scope: DecisionScope, submissionId: string): DecisionCandidateDto | undefined;
  /** Aggregate review basis only; undefined when no round basis exists. */
  readDecisionReviewBasis(scope: DecisionScope, submissionId: string): DecisionReviewPinDto | undefined;
}

export interface DecisionReadPort {
  readDecisionHead(scope: DecisionScope, submissionId: string): DecisionHead | undefined;
  readSubmissionSessionOrigin(
    scope: DecisionScope,
    submissionId: string
  ): SubmissionSessionOriginDto | undefined;
  listSessionOrigins(scope: DecisionScope, sessionId: string): readonly SubmissionSessionOriginDto[];
  countSessionSchedulePlacements(scope: DecisionScope, sessionId: string): number;
}

export interface DecisionChangesetReadPort extends DecisionReadPort, DecisionEnvironmentSource {}

export interface DecisionChangesetTransactionPort extends DecisionChangesetReadPort {
  /**
   * Writes Decision heads and origin links for one validated plan. Session
   * graduation contributions are applied separately through the Session
   * graduation transaction port inside the same unit of work.
   */
  applyDecisionPlan(plan: DecisionMutationPlanDto | DecisionRestorePlanDto): DecisionMutationResult;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
