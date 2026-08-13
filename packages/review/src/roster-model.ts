import {
  reviewerAuthoritySetSchema,
  reviewerEligibilityFactSchema,
  reviewerRosterRecordSchema,
  reviewerRosterScopeSchema,
  reviewerRosterStateSchema,
  reviewerScopeTargetSetSchema,
  type ReviewerAuthoritySetDto,
  type ReviewerAuthoritySubjectRefDto,
  type ReviewerEligibilityFactDto,
  type ReviewerRosterMutationPlanDto,
  type ReviewerRosterMutationResult,
  type ReviewerRosterRecordDto,
  type ReviewerRosterScopeDto,
  type ReviewerRosterStateDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';

export interface ReviewerRosterRepository {
  readReviewerRoster(scope: ReviewerRosterScopeDto): ReviewerRosterStateDto | undefined;
}

export interface ReviewerRosterTransactionRepository extends ReviewerRosterRepository {
  applyReviewerRosterPlan(plan: ReviewerRosterMutationPlanDto): ReviewerRosterMutationResult;
}

/** Lower-owner identity/access facts. Implementations must never resolve by email. */
export interface ReviewerAuthoritySource {
  readReviewerAuthority(scope: ReviewerRosterScopeDto): ReviewerAuthoritySetDto | undefined;
}

/** Lower-owner track/format/session facts used to authorize application-level scope refs. */
export interface ReviewerScopeTargetSource {
  readReviewerScopeTargets(scope: ReviewerRosterScopeDto): ReviewerScopeTargetSetDto | undefined;
}

export interface ReviewerRosterPlanningSource
  extends ReviewerAuthoritySource, ReviewerScopeTargetSource {}

export interface ReviewerRosterReadEnvironment {
  readonly repository: ReviewerRosterRepository;
  readonly authority: ReviewerAuthoritySource;
}

export interface ReviewerRosterMutationEnvironment {
  readonly repository: ReviewerRosterRepository;
  readonly sources: ReviewerRosterPlanningSource;
}

export interface ReviewerRosterTransactionEnvironment {
  readonly repository: ReviewerRosterTransactionRepository;
  readonly sources: ReviewerRosterPlanningSource;
}

export function parseReviewerRosterScope(value: unknown): ReviewerRosterScopeDto {
  return Object.freeze(reviewerRosterScopeSchema.parse(value));
}

export function parseReviewerRosterRecord(value: unknown): ReviewerRosterRecordDto {
  return deepFreeze(reviewerRosterRecordSchema.parse(value));
}

export function parseReviewerRosterState(value: unknown): ReviewerRosterStateDto {
  return deepFreeze(reviewerRosterStateSchema.parse(value));
}

export function parseReviewerEligibilityFact(value: unknown): ReviewerEligibilityFactDto {
  return deepFreeze(reviewerEligibilityFactSchema.parse(value));
}

export function parseReviewerAuthoritySet(value: unknown): ReviewerAuthoritySetDto {
  return deepFreeze(reviewerAuthoritySetSchema.parse(value));
}

export function parseReviewerScopeTargetSet(value: unknown): ReviewerScopeTargetSetDto {
  return deepFreeze(reviewerScopeTargetSetSchema.parse(value));
}

export function sameReviewerRosterScope(
  left: ReviewerRosterScopeDto,
  right: ReviewerRosterScopeDto
): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

export function sameAuthoritySubject(
  left: ReviewerAuthoritySubjectRefDto,
  right: ReviewerAuthoritySubjectRefDto,
  options: { readonly includeVersion?: boolean } = {}
): boolean {
  return left.kind === right.kind
    && left.id === right.id
    && (options.includeVersion !== true || left.version === right.version);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
