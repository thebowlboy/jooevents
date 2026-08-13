import {
  reviewAssignmentSchema,
  reviewCandidateDisplaySchema,
  reviewCandidateSnapshotSchema,
  reviewCatalogSchema,
  reviewDeadlinePinSchema,
  reviewDraftSchema,
  reviewHeadSchema,
  reviewQueryGuardSchema,
  reviewRevisionSchema,
  reviewRosterMemberSnapshotSchema,
  reviewRoundSchema,
  reviewScopeSchema,
  type ReviewAssignmentDto,
  type ReviewCandidateDisplayDto,
  type ReviewCandidateSnapshotDto,
  type ReviewCatalogDto,
  type ReviewDeadlinePinDto,
  type ReviewDraftDto,
  type ReviewHeadDto,
  type ReviewRevisionDto,
  type ReviewRosterMemberSnapshotDto,
  type ReviewRoundDto,
  type ReviewScopeDto
} from '@jooevents/contracts/reviews';

export interface ReviewQueryGuard {
  readonly id: string;
  readonly version: number;
  readonly digestSha256: string;
}

export interface ReviewCandidateSet {
  readonly version: number;
  readonly candidates: readonly ReviewCandidateSnapshotDto[];
}

export interface ReviewRosterSet {
  readonly version: number;
  readonly reviewers: readonly ReviewRosterMemberSnapshotDto[];
}

/** Imported facts used by Review planning and projections; this package owns none of them. */
export interface ReviewPlanningSource {
  readCandidates(scope: ReviewScopeDto): ReviewCandidateSet | undefined;
  readCandidate(
    scope: ReviewScopeDto,
    submissionId: string
  ): ReviewCandidateSnapshotDto | undefined;
  readReviewerRoster(scope: ReviewScopeDto): ReviewRosterSet | undefined;
  resolveReviewDeadline(scope: ReviewScopeDto, deadlineId: string): ReviewDeadlinePinDto | undefined;
}

/**
 * Required authority-shaped Intake join for Review queue content. The caller
 * supplies current reviewer/round context; this port never returns contacts.
 */
export interface ReviewCandidateDisplaySource {
  readReviewCandidateDisplay(input: {
    readonly scope: ReviewScopeDto;
    readonly roundId: string;
    readonly submissionId: string;
    readonly reviewerId: string;
    readonly includeSpeakerIdentity: boolean;
  }): ReviewCandidateDisplayDto | undefined;
}

export interface ReviewRepository {
  readCatalog(scope: ReviewScopeDto): ReviewCatalogDto | undefined;
  readRound(scope: ReviewScopeDto, roundId: string): ReviewRoundDto | undefined;
  listAssignments(scope: ReviewScopeDto, roundId: string): readonly ReviewAssignmentDto[];
  readAssignment(scope: ReviewScopeDto, assignmentId: string): ReviewAssignmentDto | undefined;
  readDraft(scope: ReviewScopeDto, assignmentId: string): ReviewDraftDto | undefined;
  readReviewHead(scope: ReviewScopeDto, assignmentId: string): ReviewHeadDto | undefined;
  readRevision(scope: ReviewScopeDto, revisionId: string): ReviewRevisionDto | undefined;
  listRevisions(scope: ReviewScopeDto, assignmentId: string): readonly ReviewRevisionDto[];
}

export interface ReviewTransactionRepository extends ReviewRepository {
  applyCatalog(input: {
    readonly before: ReviewCatalogDto;
    readonly after: ReviewCatalogDto;
  }): void;
  insertRound(round: ReviewRoundDto): void;
  updateRound(input: { readonly before: ReviewRoundDto; readonly after: ReviewRoundDto }): void;
  insertAssignments(assignments: readonly ReviewAssignmentDto[]): void;
  updateAssignment(input: {
    readonly before: ReviewAssignmentDto;
    readonly after: ReviewAssignmentDto;
  }): void;
  saveDraft(input: {
    readonly expectedVersion: number | null;
    readonly draft: ReviewDraftDto;
  }): void;
  insertFirstReview(input: {
    readonly head: ReviewHeadDto;
    readonly revision: ReviewRevisionDto;
  }): void;
  appendReviewRevision(input: {
    readonly before: ReviewHeadDto;
    readonly after: ReviewHeadDto;
    readonly revision: ReviewRevisionDto;
  }): void;
}

export function parseReviewScope(value: unknown): ReviewScopeDto {
  return Object.freeze(reviewScopeSchema.parse(value));
}

export function parseReviewCatalog(value: unknown): ReviewCatalogDto {
  return deepFreeze(reviewCatalogSchema.parse(value));
}

export function parseReviewRound(value: unknown): ReviewRoundDto {
  return deepFreeze(reviewRoundSchema.parse(value));
}

export function parseReviewAssignment(value: unknown): ReviewAssignmentDto {
  return deepFreeze(reviewAssignmentSchema.parse(value));
}

export function parseReviewDraft(value: unknown): ReviewDraftDto {
  return deepFreeze(reviewDraftSchema.parse(value));
}

export function parseReviewHead(value: unknown): ReviewHeadDto {
  return deepFreeze(reviewHeadSchema.parse(value));
}

export function parseReviewRevision(value: unknown): ReviewRevisionDto {
  return deepFreeze(reviewRevisionSchema.parse(value));
}

export function parseReviewCandidate(value: unknown): ReviewCandidateSnapshotDto {
  return deepFreeze(reviewCandidateSnapshotSchema.parse(value));
}

export function parseReviewCandidateDisplay(value: unknown): ReviewCandidateDisplayDto {
  return deepFreeze(reviewCandidateDisplaySchema.parse(value));
}

export function parseReviewRosterMember(value: unknown): ReviewRosterMemberSnapshotDto {
  return deepFreeze(reviewRosterMemberSnapshotSchema.parse(value));
}

export function parseReviewDeadlinePin(value: unknown): ReviewDeadlinePinDto {
  return deepFreeze(reviewDeadlinePinSchema.parse(value));
}

export function parseReviewQueryGuard(value: unknown): ReviewQueryGuard {
  return Object.freeze(reviewQueryGuardSchema.parse(value));
}

export function sameReviewScope(
  left: { readonly workspaceId: string; readonly eventId: string },
  right: { readonly workspaceId: string; readonly eventId: string }
): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

export function compareAssignments(left: ReviewAssignmentDto, right: ReviewAssignmentDto): number {
  if (left.reviewerId !== right.reviewerId) return compareText(left.reviewerId, right.reviewerId);
  if (left.submissionId !== right.submissionId) return compareText(left.submissionId, right.submissionId);
  return compareText(left.id, right.id);
}

export function compareCandidates(
  left: ReviewCandidateSnapshotDto,
  right: ReviewCandidateSnapshotDto
): number {
  return compareText(left.submissionId, right.submissionId);
}

export function compareReviewers(
  left: ReviewRosterMemberSnapshotDto,
  right: ReviewRosterMemberSnapshotDto
): number {
  return compareText(left.reviewerId, right.reviewerId);
}

export function compareRevisions(left: ReviewRevisionDto, right: ReviewRevisionDto): number {
  if (left.revisionNumber !== right.revisionNumber) return left.revisionNumber - right.revisionNumber;
  return compareText(left.id, right.id);
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
