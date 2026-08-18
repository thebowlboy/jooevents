import type {
  ReviewAssignmentDto,
  ReviewCandidateDisplayDto,
  ReviewCandidateSnapshotDto,
  ReviewCatalogDto,
  ReviewDraftDto,
  ReviewHeadDto,
  ReviewRevisionDto,
  ReviewScopeDto,
  ReviewVacancyResolutionDto
} from '@jooevents/contracts/reviews';
import { compareRevisions } from './model';
import type {
  ReviewCandidateSet,
  ReviewPlanningSource,
  ReviewRepository,
  ReviewRosterSet
} from './model';
import type { ReviewProjectionEnvironment } from './projections';

/**
 * One snapshot-scoped working set. Review plans, the reviewer queue, and both
 * standing slices read the same catalog, assignments, heads, revisions, and
 * candidate set instead of repeating those queries per card or per standing.
 */
const memoizedEnvironments = new WeakSet<ReviewProjectionEnvironment>();

export function isMemoizedReviewProjectionEnvironment(
  environment: ReviewProjectionEnvironment
): boolean {
  return memoizedEnvironments.has(environment);
}

export function memoizeReviewProjectionEnvironment(
  environment: ReviewProjectionEnvironment
): ReviewProjectionEnvironment {
  if (memoizedEnvironments.has(environment)) return environment;
  const wrapped: ReviewProjectionEnvironment = {
    repository: memoizeReviewRepository(environment.repository),
    sources: memoizePlanningSource(environment.sources),
    candidateDisplay: memoizeCandidateDisplay(environment.candidateDisplay),
    accolades: environment.accolades
  };
  memoizedEnvironments.add(wrapped);
  return wrapped;
}

function scopeKey(scope: ReviewScopeDto): string {
  return `${scope.workspaceId}\0${scope.eventId}`;
}

function memoizeReviewRepository(repository: ReviewRepository): ReviewRepository {
  const catalogs = new Map<string, ReviewCatalogDto | undefined>();
  const rounds = new Map<string, ReturnType<ReviewRepository['readRound']>>();
  const assignments = new Map<string, readonly ReviewAssignmentDto[]>();
  const assignmentById = new Map<string, ReviewAssignmentDto | undefined>();
  const heads = new Map<string, ReviewHeadDto | undefined>();
  const revisions = new Map<string, ReviewRevisionDto | undefined>();
  const revisionsByAssignment = new Map<string, readonly ReviewRevisionDto[]>();
  const drafts = new Map<string, ReviewDraftDto | undefined>();
  const vacancies = new Map<string, ReviewVacancyResolutionDto | undefined>();

  function prefetchRound(scope: ReviewScopeDto, roundId: string, listed: readonly ReviewAssignmentDto[]): void {
    if (repository.listReviewHeadsForRound) {
      for (const assignment of listed) heads.set(assignment.id, undefined);
      for (const head of repository.listReviewHeadsForRound(scope, roundId)) {
        heads.set(head.assignmentId, head);
      }
    }
    if (repository.listRevisionsForRound) {
      const buckets = new Map<string, ReviewRevisionDto[]>();
      for (const assignment of listed) buckets.set(assignment.id, []);
      for (const revision of repository.listRevisionsForRound(scope, roundId)) {
        revisions.set(revision.id, revision);
        const bucket = buckets.get(revision.assignmentId) ?? [];
        bucket.push(revision);
        buckets.set(revision.assignmentId, bucket);
      }
      for (const [assignmentId, rows] of buckets) {
        revisionsByAssignment.set(assignmentId, Object.freeze([...rows].sort(compareRevisions)));
      }
    }
    if (repository.listVacancyResolutionsForRound) {
      for (const assignment of listed) vacancies.set(assignment.id, undefined);
      for (const resolution of repository.listVacancyResolutionsForRound(scope, roundId)) {
        vacancies.set(resolution.vacatedAssignmentId, resolution);
      }
    }
  }

  const wrapped: ReviewRepository = {
    readCatalog(scope) {
      const key = scopeKey(scope);
      if (!catalogs.has(key)) catalogs.set(key, repository.readCatalog(scope));
      return catalogs.get(key);
    },
    readRound(scope, roundId) {
      const key = `${scopeKey(scope)}\0${roundId}`;
      if (!rounds.has(key)) rounds.set(key, repository.readRound(scope, roundId));
      return rounds.get(key);
    },
    listAssignments(scope, roundId) {
      const key = `${scopeKey(scope)}\0${roundId}`;
      let listed = assignments.get(key);
      if (listed === undefined) {
        listed = repository.listAssignments(scope, roundId);
        assignments.set(key, listed);
        for (const assignment of listed) assignmentById.set(assignment.id, assignment);
        prefetchRound(scope, roundId, listed);
      }
      return listed;
    },
    readAssignment(scope, assignmentId) {
      if (assignmentById.has(assignmentId)) return assignmentById.get(assignmentId);
      const found = repository.readAssignment(scope, assignmentId);
      assignmentById.set(assignmentId, found);
      return found;
    },
    readDraft(scope, assignmentId) {
      if (drafts.has(assignmentId)) return drafts.get(assignmentId);
      const found = repository.readDraft(scope, assignmentId);
      drafts.set(assignmentId, found);
      return found;
    },
    readReviewHead(scope, assignmentId) {
      if (heads.has(assignmentId)) return heads.get(assignmentId);
      const found = repository.readReviewHead(scope, assignmentId);
      heads.set(assignmentId, found);
      return found;
    },
    readRevision(scope, revisionId) {
      if (revisions.has(revisionId)) return revisions.get(revisionId);
      const found = repository.readRevision(scope, revisionId);
      revisions.set(revisionId, found);
      return found;
    },
    listRevisions(scope, assignmentId) {
      if (revisionsByAssignment.has(assignmentId)) return revisionsByAssignment.get(assignmentId)!;
      const listed = repository.listRevisions(scope, assignmentId);
      revisionsByAssignment.set(assignmentId, listed);
      for (const revision of listed) revisions.set(revision.id, revision);
      return listed;
    }
  };
  if (repository.readVacancyResolution) {
    wrapped.readVacancyResolution = (scope, vacatedAssignmentId) => {
      if (vacancies.has(vacatedAssignmentId)) return vacancies.get(vacatedAssignmentId);
      const found = repository.readVacancyResolution!(scope, vacatedAssignmentId);
      vacancies.set(vacatedAssignmentId, found);
      return found;
    };
  }
  if (repository.listVacancyResolutionsForRound) {
    wrapped.listVacancyResolutionsForRound = (scope, roundId) =>
      repository.listVacancyResolutionsForRound!(scope, roundId);
  }
  if (repository.listReviewHeadsForRound) {
    wrapped.listReviewHeadsForRound = (scope, roundId) =>
      repository.listReviewHeadsForRound!(scope, roundId);
  }
  if (repository.listRevisionsForRound) {
    wrapped.listRevisionsForRound = (scope, roundId) =>
      repository.listRevisionsForRound!(scope, roundId);
  }
  return wrapped;
}

function memoizePlanningSource(sources: ReviewPlanningSource): ReviewPlanningSource {
  const sets = new Map<string, ReviewCandidateSet | undefined>();
  const candidates = new Map<string, ReviewCandidateSnapshotDto | undefined>();
  const rosters = new Map<string, ReviewRosterSet | undefined>();
  const loadedCandidateScopes = new Set<string>();

  return {
    readCandidates(scope) {
      const key = scopeKey(scope);
      if (!sets.has(key)) {
        const set = sources.readCandidates(scope);
        sets.set(key, set);
        loadedCandidateScopes.add(key);
        if (set) {
          for (const candidate of set.candidates) candidates.set(candidate.submissionId, candidate);
        }
      }
      return sets.get(key);
    },
    readCandidate(scope, submissionId) {
      if (candidates.has(submissionId)) return candidates.get(submissionId);
      const key = scopeKey(scope);
      if (!loadedCandidateScopes.has(key)) this.readCandidates(scope);
      if (candidates.has(submissionId)) return candidates.get(submissionId);
      const found = sources.readCandidate(scope, submissionId);
      candidates.set(submissionId, found);
      return found;
    },
    readReviewerRoster(scope) {
      const key = scopeKey(scope);
      if (!rosters.has(key)) rosters.set(key, sources.readReviewerRoster(scope));
      return rosters.get(key);
    },
    resolveReviewDeadline(scope, deadlineId) {
      return sources.resolveReviewDeadline(scope, deadlineId);
    }
  };
}

function memoizeCandidateDisplay(
  source: ReviewProjectionEnvironment['candidateDisplay']
): ReviewProjectionEnvironment['candidateDisplay'] {
  const displays = new Map<string, ReviewCandidateDisplayDto | undefined>();
  return {
    readReviewCandidateDisplay(input) {
      const key = [
        scopeKey(input.scope),
        input.roundId,
        input.submissionId,
        input.reviewerId,
        input.includeSpeakerIdentity ? '1' : '0'
      ].join('\0');
      if (!displays.has(key)) displays.set(key, source.readReviewCandidateDisplay(input));
      return displays.get(key);
    }
  };
}
