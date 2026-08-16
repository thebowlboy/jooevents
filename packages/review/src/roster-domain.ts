import { canonicalJsonSha256 } from '@jooevents/kernel';
import {
  REVIEWER_CAPABILITY_IDS,
  reviewerRosterMutationInputSchema,
  reviewerRosterMutationPlanSchema,
  reviewerRosterMutationResultSchema,
  reviewerRosterSafeDiffSchema,
  reviewerRosterSnapshotSchema,
  type ReviewerAuthoritySetDto,
  type ReviewerEligibilityFactDto,
  type ReviewerRosterGuardDto,
  type ReviewerRosterMutationInput,
  type ReviewerRosterMutationPlanDto,
  type ReviewerRosterMutationResult,
  type ReviewerRosterRecordDto,
  type ReviewerRosterSafeDiff,
  type ReviewerRosterScopeDto,
  type ReviewerRosterSnapshotDto,
  type ReviewerRosterStateDto,
  type ReviewerScopeRefDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import type { ReviewRosterSet } from './model';

import {
  parseReviewerAuthoritySet,
  parseReviewerRosterRecord,
  parseReviewerRosterScope,
  parseReviewerRosterState,
  parseReviewerScopeTargetSet,
  sameAuthoritySubject,
  sameReviewerRosterScope,
  type ReviewerRosterMutationEnvironment,
  type ReviewerRosterReadEnvironment,
  type ReviewerRosterTransactionEnvironment
} from './roster-model';

export type ReviewerRosterPlanningErrorCode =
  | 'wrong_scope'
  | 'roster_missing'
  | 'stale_roster'
  | 'authority_unavailable'
  | 'authority_changed'
  | 'reviewer_not_eligible'
  | 'reviewer_exists'
  | 'reviewer_missing'
  | 'stale_reviewer'
  | 'reviewer_revoked'
  | 'already_revoked'
  | 'not_revoked'
  | 'scope_targets_unavailable'
  | 'scope_targets_changed'
  | 'scope_target_missing'
  | 'scope_target_retired'
  | 'invalid_plan';

export class ReviewerRosterPlanningError extends Error {
  constructor(readonly code: ReviewerRosterPlanningErrorCode) {
    super(code);
    this.name = 'ReviewerRosterPlanningError';
  }
}

export interface ReviewerRosterAttribution {
  readonly userId: string;
  readonly occurredAt: string;
}

export function reviewerRosterGuardId(eventId: string): string {
  return `reviewer_roster:${eventId}`;
}

export function reviewerAuthoritySetGuardId(eventId: string): string {
  return `reviewer_authority_set:${eventId}`;
}

export function reviewerAuthorityFactGuardId(reviewerId: string): string {
  return `reviewer_authority:${reviewerId}`;
}

export function reviewerScopeTargetSetGuardId(eventId: string): string {
  return `reviewer_scope_targets:${eventId}`;
}

export function reviewerScopeTargetGuardId(ref: ReviewerScopeRefDto): string {
  return `reviewer_scope_target:${ref.kind}:${ref.id}`;
}

export function createEmptyReviewerRoster(
  scopeInput: ReviewerRosterScopeDto
): ReviewerRosterStateDto {
  const scope = parseReviewerRosterScope(scopeInput);
  return parseReviewerRosterState({
    schemaVersion: 1,
    scope,
    version: 1,
    digestSha256: reviewerRosterDigest({ scope, version: 1, reviewers: [] }),
    reviewers: []
  });
}

export function reviewerRosterDigest(input: {
  readonly scope: ReviewerRosterScopeDto;
  readonly version: number;
  readonly reviewers: readonly ReviewerRosterRecordDto[];
}): string {
  return canonicalJsonSha256({
    schemaVersion: 1,
    scope: input.scope,
    version: input.version,
    reviewers: input.reviewers
  });
}

export function reviewerAuthorityFactDigest(
  fact: Omit<ReviewerEligibilityFactDto, 'digestSha256'>
): string {
  return canonicalJsonSha256(fact);
}

export function reviewerAuthoritySetDigest(
  set: Omit<ReviewerAuthoritySetDto, 'digestSha256'>
): string {
  return canonicalJsonSha256(set);
}

export function reviewerScopeTargetSetDigest(
  set: Omit<ReviewerScopeTargetSetDto, 'digestSha256'>
): string {
  return canonicalJsonSha256(set);
}

export function reviewerScopeTargetFactDigest(
  target: Omit<ReviewerScopeTargetSetDto['targets'][number], 'digestSha256'>
): string {
  return canonicalJsonSha256(target);
}

export function projectReviewerRosterSnapshot(
  input: ReviewerRosterReadEnvironment & { readonly scope: ReviewerRosterScopeDto }
): ReviewerRosterSnapshotDto | undefined {
  const scope = parseReviewerRosterScope(input.scope);
  const roster = input.repository.readReviewerRoster(scope);
  const authority = input.authority.readReviewerAuthority(scope);
  if (!roster || !authority) return undefined;
  const currentRoster = assertRosterState(roster, scope);
  const currentAuthority = assertAuthoritySet(authority, scope);
  const bySubject = authorityFactsBySubject(currentAuthority);
  const reviewers = currentRoster.reviewers.map((record) => {
    const fact = bySubject.get(authoritySubjectKey(record.accessSubject))
      ?? unavailableFactFor(record, currentAuthority);
    const eligible = record.state === 'included' && isEligibleReviewerFact(fact);
    const status = record.state === 'revoked'
      ? 'revoked' as const
      : eligible
        ? fact.state === 'reserved' ? 'invited' as const : 'active' as const
        : 'revoked' as const;
    return {
      reviewerId: record.reviewerId,
      recordVersion: record.version,
      projectionVersion: pairSafePositiveIntegers(record.version, fact.version),
      status,
      accessSubject: record.accessSubject,
      authority: fact,
      ...(fact.displayName === undefined ? {} : { displayName: fact.displayName }),
      reviews: record.reviews
    };
  });
  const version = pairSafePositiveIntegers(currentRoster.version, currentAuthority.version);
  return reviewerRosterSnapshotSchema.parse({
    schemaVersion: 1,
    scope,
    version,
    digestSha256: canonicalJsonSha256({
      schemaVersion: 1,
      scope,
      version,
      rosterDigestSha256: currentRoster.digestSha256,
      authorityDigestSha256: currentAuthority.digestSha256,
      reviewers
    }),
    rosterVersion: currentRoster.version,
    rosterDigestSha256: currentRoster.digestSha256,
    authorityVersion: currentAuthority.version,
    authorityDigestSha256: currentAuthority.digestSha256,
    reviewers
  });
}

/** Adapter consumed by the frozen Review core; revoked/lost-authority rows are omitted. */
export function createReviewerRosterReviewPlanningSource(
  environment: ReviewerRosterReadEnvironment
): { readReviewerRoster(scope: ReviewerRosterScopeDto): ReviewRosterSet | undefined } {
  return Object.freeze({
    readReviewerRoster(scope: ReviewerRosterScopeDto): ReviewRosterSet | undefined {
      const snapshot = projectReviewerRosterSnapshot({ ...environment, scope });
      if (!snapshot) return undefined;
      const reviewers: ReviewRosterSet['reviewers'][number][] = [];
      for (const reviewer of snapshot.reviewers) {
        if (reviewer.status === 'revoked') continue;
        reviewers.push(Object.freeze({
          reviewerId: reviewer.reviewerId,
          version: reviewer.projectionVersion,
          status: reviewer.status,
          ...(reviewer.displayName === undefined ? {} : { displayName: reviewer.displayName }),
          scope: reviewer.reviews
        }));
      }
      return Object.freeze({
        version: snapshot.version,
        reviewers: Object.freeze(reviewers)
      });
    }
  });
}

export function planReviewerRosterMutation(inputValue: ReviewerRosterMutationInput, input: {
  readonly environment: ReviewerRosterMutationEnvironment;
  readonly attribution: ReviewerRosterAttribution;
}): ReviewerRosterMutationPlanDto {
  const request = reviewerRosterMutationInputSchema.parse(inputValue);
  const scope = request.scope;
  const roster = input.environment.repository.readReviewerRoster(scope);
  if (!roster) fail('roster_missing');
  const current = assertRosterState(roster, scope);
  assertExpectedRoster(request, current);
  const authorityValue = input.environment.sources.readReviewerAuthority(scope);
  if (!authorityValue) fail('authority_unavailable');
  const authority = assertAuthoritySet(authorityValue, scope);
  const existing = current.reviewers.find((candidate) => candidate.reviewerId === request.reviewerId);
  // A register refuses any duplicate access subject, whatever its record state:
  // roster records are retained after revocation, one subject maps to at most one
  // reviewer identity, and a revoked reviewer returns through restore, not a
  // second registration.
  if (request.action === 'register' && current.reviewers.some((candidate) =>
    candidate.reviewerId !== request.reviewerId
      && sameAuthoritySubject(candidate.accessSubject, request.accessSubject)
  )) {
    fail('reviewer_exists');
  }
  const fact = resolveMutationAuthorityFact({ request, existing, authority });
  const targetValue = input.environment.sources.readReviewerScopeTargets(scope);
  if (!targetValue) fail('scope_targets_unavailable');
  const targets = assertTargetSet(targetValue, scope);
  const reviews = 'reviews' in request ? request.reviews : existing?.reviews ?? [];
  const targetGuards = validateScopeChange({ request, existing, reviews, targets });
  const after = createAfterRecord({ request, current, existing, fact, attribution: input.attribution });
  const reviewers = current.reviewers
    .filter((candidate) => candidate.reviewerId !== after.reviewerId)
    .concat(after)
    .sort((left, right) => compareText(left.reviewerId, right.reviewerId));
  const afterVersion = current.version + 1;
  return reviewerRosterMutationPlanSchema.parse({
    schemaVersion: 1,
    action: request.action,
    input: request,
    roster: {
      beforeVersion: current.version,
      beforeDigestSha256: current.digestSha256,
      afterVersion,
      afterDigestSha256: reviewerRosterDigest({ scope, version: afterVersion, reviewers })
    },
    authoritySetGuard: guard(
      reviewerAuthoritySetGuardId(scope.eventId), authority.version, authority.digestSha256
    ),
    authorityFactGuard: guard(
      reviewerAuthorityFactGuardId(request.reviewerId), fact.version, fact.digestSha256
    ),
    targetSetGuard: guard(
      reviewerScopeTargetSetGuardId(scope.eventId), targets.version, targets.digestSha256
    ),
    targetGuards,
    before: existing ?? null,
    after
  });
}

export function validateReviewerRosterMutationPlan(
  planValue: ReviewerRosterMutationPlanDto,
  environment: ReviewerRosterMutationEnvironment
): ReviewerRosterPlanningErrorCode | undefined {
  let plan: ReviewerRosterMutationPlanDto;
  try { plan = reviewerRosterMutationPlanSchema.parse(planValue); } catch { return 'invalid_plan'; }
  const rosterValue = environment.repository.readReviewerRoster(plan.input.scope);
  if (!rosterValue) return 'roster_missing';
  let roster: ReviewerRosterStateDto;
  try { roster = assertRosterState(rosterValue, plan.input.scope); } catch (error) {
    return planningErrorCode(error, 'wrong_scope');
  }
  if (roster.version !== plan.roster.beforeVersion
      || roster.digestSha256 !== plan.roster.beforeDigestSha256) return 'stale_roster';
  const currentRecord = roster.reviewers.find(
    (reviewer) => reviewer.reviewerId === plan.input.reviewerId
  ) ?? null;
  if (canonicalJsonSha256(currentRecord) !== canonicalJsonSha256(plan.before)) {
    return 'stale_reviewer';
  }
  const planInput = plan.input;
  if (planInput.action === 'register' && roster.reviewers.some((candidate) =>
    candidate.reviewerId !== planInput.reviewerId
      && sameAuthoritySubject(candidate.accessSubject, planInput.accessSubject)
  )) {
    return 'reviewer_exists';
  }
  const authorityValue = environment.sources.readReviewerAuthority(plan.input.scope);
  if (!authorityValue) return 'authority_unavailable';
  let authority: ReviewerAuthoritySetDto;
  try { authority = assertAuthoritySet(authorityValue, plan.input.scope); } catch (error) {
    return planningErrorCode(error, 'authority_changed');
  }
  if (!guardMatches(plan.authoritySetGuard, authority)) return 'authority_changed';
  const fact = authority.facts.find((candidate) => sameAuthoritySubject(
    candidate.rosterSubject, plan.after.accessSubject
  )) ?? unavailableFactFor(plan.after, authority);
  if ((plan.action !== 'revoke' && !isEligibleReviewerFact(fact))
      || !guardMatches(plan.authorityFactGuard, fact)) return 'authority_changed';
  const targetValue = environment.sources.readReviewerScopeTargets(plan.input.scope);
  if (!targetValue) return 'scope_targets_unavailable';
  let targets: ReviewerScopeTargetSetDto;
  try { targets = assertTargetSet(targetValue, plan.input.scope); } catch (error) {
    return planningErrorCode(error, 'scope_targets_changed');
  }
  if (!guardMatches(plan.targetSetGuard, targets)) return 'scope_targets_changed';
  for (const plannedGuard of plan.targetGuards) {
    const target = targets.targets.find((candidate) =>
      reviewerScopeTargetGuardId(candidate.ref) === plannedGuard.id
    );
    if (!target || !guardMatches(plannedGuard, target)) return 'scope_targets_changed';
  }
  const afterReviewers = roster.reviewers
    .filter((reviewer) => reviewer.reviewerId !== plan.after.reviewerId)
    .concat(plan.after)
    .sort((left, right) => compareText(left.reviewerId, right.reviewerId));
  if (reviewerRosterDigest({
    scope: plan.input.scope,
    version: plan.roster.afterVersion,
    reviewers: afterReviewers
  }) !== plan.roster.afterDigestSha256) return 'invalid_plan';
  return undefined;
}

export function applyReviewerRosterMutationPlan(input: {
  readonly plan: ReviewerRosterMutationPlanDto;
  readonly environment: ReviewerRosterTransactionEnvironment;
}): ReviewerRosterMutationResult {
  const code = validateReviewerRosterMutationPlan(input.plan, input.environment);
  if (code) fail(code);
  return reviewerRosterMutationResultSchema.parse(
    input.environment.repository.applyReviewerRosterPlan(input.plan)
  );
}

export function projectReviewerRosterSafeDiff(
  planValue: ReviewerRosterMutationPlanDto
): ReviewerRosterSafeDiff {
  const plan = reviewerRosterMutationPlanSchema.parse(planValue);
  return reviewerRosterSafeDiffSchema.parse({
    schemaVersion: 1,
    action: plan.action,
    reviewerId: plan.after.reviewerId,
    before: plan.before === null ? null : safeRecord(plan.before),
    after: safeRecord(plan.after)
  });
}

export function reviewerRosterMutationFact(planValue: ReviewerRosterMutationPlanDto) {
  const plan = reviewerRosterMutationPlanSchema.parse(planValue);
  return Object.freeze({
    kind: 'reviewer_roster_changed',
    version: 1,
    payload: Object.freeze({
      action: plan.action,
      reviewerId: plan.after.reviewerId,
      rosterVersion: plan.roster.afterVersion,
      reviewerVersion: plan.after.version
    })
  });
}

export function pairSafePositiveIntegers(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left <= 0 || !Number.isSafeInteger(right) || right <= 0) {
    throw new TypeError('reviewer_roster_projection_version_invalid');
  }
  const x = left - 1;
  const y = right - 1;
  const sum = x + y;
  const paired = (sum * (sum + 1)) / 2 + y + 1;
  if (!Number.isSafeInteger(paired) || paired <= 0) {
    throw new TypeError('reviewer_roster_projection_version_overflow');
  }
  return paired;
}

function resolveMutationAuthorityFact(input: {
  readonly request: ReviewerRosterMutationInput;
  readonly existing: ReviewerRosterRecordDto | undefined;
  readonly authority: ReviewerAuthoritySetDto;
}): ReviewerEligibilityFactDto {
  if (input.request.action === 'register') {
    const request = input.request;
    if (input.existing) fail('reviewer_exists');
    const fact = input.authority.facts.find((candidate) => sameAuthoritySubject(
      candidate.rosterSubject, request.accessSubject, { includeVersion: true }
    ));
    if (!fact || !isEligibleReviewerFact(fact)) fail('reviewer_not_eligible');
    return fact;
  }
  if (!input.existing) fail('reviewer_missing');
  if (input.existing.version !== input.request.expectedReviewerVersion) fail('stale_reviewer');
  if (input.request.action === 'revoke' && input.existing.state === 'revoked') fail('already_revoked');
  if (input.request.action === 'restore' && input.existing.state !== 'revoked') fail('not_revoked');
  if (input.request.action === 'set_scope' && input.existing.state === 'revoked') {
    fail('reviewer_revoked');
  }
  const fact = input.authority.facts.find((candidate) => sameAuthoritySubject(
    candidate.rosterSubject, input.existing!.accessSubject
  )) ?? unavailableFactFor(input.existing, input.authority);
  if (input.request.action !== 'revoke' && !isEligibleReviewerFact(fact)) {
    fail('reviewer_not_eligible');
  }
  return fact;
}

function validateScopeChange(input: {
  readonly request: ReviewerRosterMutationInput;
  readonly existing: ReviewerRosterRecordDto | undefined;
  readonly reviews: readonly ReviewerScopeRefDto[];
  readonly targets: ReviewerScopeTargetSetDto;
}): readonly ReviewerRosterGuardDto[] {
  if (input.request.action === 'revoke') return Object.freeze([]);
  const beforeKeys = new Set((input.existing?.reviews ?? []).map(scopeRefKey));
  const guards: ReviewerRosterGuardDto[] = [];
  for (const ref of input.reviews) {
    const target = input.targets.targets.find((candidate) => scopeRefKey(candidate.ref) === scopeRefKey(ref));
    if (!target) fail('scope_target_missing');
    if (target.assignability !== 'assignable' && !beforeKeys.has(scopeRefKey(ref))) {
      fail('scope_target_retired');
    }
    guards.push(guard(reviewerScopeTargetGuardId(ref), target.version, target.digestSha256));
  }
  return Object.freeze(guards);
}

function createAfterRecord(input: {
  readonly request: ReviewerRosterMutationInput;
  readonly current: ReviewerRosterStateDto;
  readonly existing: ReviewerRosterRecordDto | undefined;
  readonly fact: ReviewerEligibilityFactDto;
  readonly attribution: ReviewerRosterAttribution;
}): ReviewerRosterRecordDto {
  if (input.request.action === 'register') {
    return parseReviewerRosterRecord({
      schemaVersion: 1,
      scope: input.request.scope,
      reviewerId: input.request.reviewerId,
      version: 1,
      accessSubject: input.request.accessSubject,
      reviews: input.request.reviews,
      state: 'included',
      addedByUserId: input.attribution.userId,
      addedAt: input.attribution.occurredAt
    });
  }
  const existing = input.existing;
  if (!existing) fail('reviewer_missing');
  if (input.request.action === 'set_scope') {
    return parseReviewerRosterRecord({
      ...existing,
      version: existing.version + 1,
      reviews: input.request.reviews
    });
  }
  if (input.request.action === 'revoke') {
    const { revokedByUserId: _oldUser, revokedAt: _oldAt, ...base } = existing.state === 'revoked'
      ? existing
      : { ...existing, revokedByUserId: undefined, revokedAt: undefined };
    return parseReviewerRosterRecord({
      ...base,
      version: existing.version + 1,
      state: 'revoked',
      revokedByUserId: input.attribution.userId,
      revokedAt: input.attribution.occurredAt
    });
  }
  const { revokedByUserId: _user, revokedAt: _at, ...base } = existing as Extract<
    ReviewerRosterRecordDto, { state: 'revoked' }
  >;
  return parseReviewerRosterRecord({
    ...base,
    version: existing.version + 1,
    state: 'included'
  });
}

function assertExpectedRoster(
  request: ReviewerRosterMutationInput,
  roster: ReviewerRosterStateDto
): void {
  if (request.expectedRosterVersion !== roster.version
      || request.expectedRosterDigestSha256 !== roster.digestSha256) fail('stale_roster');
}

function assertRosterState(
  value: ReviewerRosterStateDto,
  scope: ReviewerRosterScopeDto
): ReviewerRosterStateDto {
  const parsed = parseReviewerRosterState(value);
  if (!sameReviewerRosterScope(parsed.scope, scope)) fail('wrong_scope');
  if (parsed.digestSha256 !== reviewerRosterDigest(parsed)) throw new TypeError('reviewer_roster_digest_mismatch');
  return parsed;
}

function assertAuthoritySet(
  value: ReviewerAuthoritySetDto,
  scope: ReviewerRosterScopeDto
): ReviewerAuthoritySetDto {
  const parsed = parseReviewerAuthoritySet(value);
  if (!sameReviewerRosterScope(parsed.scope, scope)) fail('wrong_scope');
  for (const fact of parsed.facts) {
    const { digestSha256: _digest, ...unsigned } = fact;
    if (fact.digestSha256 !== reviewerAuthorityFactDigest(unsigned)) {
      throw new TypeError('reviewer_authority_fact_digest_mismatch');
    }
  }
  const { digestSha256: _digest, ...unsigned } = parsed;
  if (parsed.digestSha256 !== reviewerAuthoritySetDigest(unsigned)) {
    throw new TypeError('reviewer_authority_set_digest_mismatch');
  }
  return parsed;
}

function assertTargetSet(
  value: ReviewerScopeTargetSetDto,
  scope: ReviewerRosterScopeDto
): ReviewerScopeTargetSetDto {
  const parsed = parseReviewerScopeTargetSet(value);
  if (!sameReviewerRosterScope(parsed.scope, scope)) fail('wrong_scope');
  for (const target of parsed.targets) {
    const { digestSha256: _targetDigest, ...unsignedTarget } = target;
    if (target.digestSha256 !== reviewerScopeTargetFactDigest(unsignedTarget)) {
      throw new TypeError('reviewer_scope_target_fact_digest_mismatch');
    }
  }
  const { digestSha256: _digest, ...unsigned } = parsed;
  if (parsed.digestSha256 !== reviewerScopeTargetSetDigest(unsigned)) {
    throw new TypeError('reviewer_scope_target_set_digest_mismatch');
  }
  return parsed;
}

function authorityFactsBySubject(
  authority: ReviewerAuthoritySetDto
): ReadonlyMap<string, ReviewerEligibilityFactDto> {
  return new Map(authority.facts.map((fact) => [authoritySubjectKey(fact.rosterSubject), fact]));
}

function unavailableFactFor(
  record: ReviewerRosterRecordDto,
  authority: ReviewerAuthoritySetDto
): ReviewerEligibilityFactDto {
  const capabilityIds: [] = [];
  const evidenceIds: string[] = [`reviewer_authority_set:${authority.digestSha256}`];
  const unsigned = {
    schemaVersion: 1 as const,
    scope: record.scope,
    rosterSubject: record.accessSubject,
    state: 'unavailable' as const,
    version: authority.version,
    capabilityIds,
    evidenceIds
  };
  return {
    ...unsigned,
    digestSha256: reviewerAuthorityFactDigest(unsigned)
  };
}

function isEligibleReviewerFact(fact: ReviewerEligibilityFactDto): boolean {
  if (fact.state === 'unavailable') return false;
  return fact.capabilityIds.length === REVIEWER_CAPABILITY_IDS.length
    && fact.capabilityIds.every((capability, index) => capability === REVIEWER_CAPABILITY_IDS[index]);
}

function safeRecord(record: ReviewerRosterRecordDto) {
  return Object.freeze({
    reviewerId: record.reviewerId,
    status: record.state,
    reviews: record.reviews,
    accessSubjectKind: record.accessSubject.kind
  });
}

function guard(id: string, version: number, digestSha256: string): ReviewerRosterGuardDto {
  return Object.freeze({ id, version, digestSha256 });
}

function guardMatches(
  guardValue: ReviewerRosterGuardDto,
  current: { readonly version: number; readonly digestSha256: string }
): boolean {
  return guardValue.version === current.version && guardValue.digestSha256 === current.digestSha256;
}

function authoritySubjectKey(subject: { readonly kind: string; readonly id: string }): string {
  return `${subject.kind}\u0000${subject.id}`;
}

function scopeRefKey(ref: ReviewerScopeRefDto): string {
  return `${ref.kind}\u0000${ref.id}`;
}

function planningErrorCode(
  error: unknown,
  fallback: ReviewerRosterPlanningErrorCode
): ReviewerRosterPlanningErrorCode {
  return error instanceof ReviewerRosterPlanningError ? error.code : fallback;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: ReviewerRosterPlanningErrorCode): never {
  throw new ReviewerRosterPlanningError(code);
}
