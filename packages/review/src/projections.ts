import {
  reviewPlanProjectionSchema,
  reviewAccoladeDefinitionProjectionSchema,
  reviewQueueItemProjectionSchema,
  reviewRoundSetupProjectionSchema,
  reviewSnapshotSchema,
  reviewStandingSchema,
  type ReviewCandidateSnapshotDto,
  type ReviewAccoladeDefinitionProjection,
  type ReviewPlanProjection,
  type ReviewQueueItemProjection,
  type ReviewRevisionDto,
  type ReviewRosterMemberSnapshotDto,
  type ReviewRoundDto,
  type ReviewRoundSetupProjection,
  type ReviewScopeDto,
  type ReviewSnapshot,
  type ReviewStanding
} from '@jooevents/contracts/reviews';
import {
  expectedReviewAssignmentPairs,
  reviewerCoversCandidate,
  weightedReviewScore
} from './domain';
import {
  compareCandidates,
  compareReviewers,
  compareRevisions,
  parseReviewCandidate,
  parseReviewCandidateDisplay,
  parseReviewRosterMember,
  parseReviewScope,
  type ReviewPlanningSource,
  type ReviewCandidateDisplaySource,
  type ReviewAccoladeSource,
  type ReviewRepository
} from './model';
import { memoizeReviewProjectionEnvironment } from './projection-cache';

export type ReviewProjectionViewer =
  | { readonly kind: 'organizer' }
  | { readonly kind: 'reviewer'; readonly reviewerId: string };

export interface ReviewProjectionEnvironment {
  readonly repository: ReviewRepository;
  readonly sources: ReviewPlanningSource;
  readonly candidateDisplay: ReviewCandidateDisplaySource;
  readonly accolades: ReviewAccoladeSource;
}

const REVIEW_ACCOLADE_KEYS = Object.freeze(new Set([
  'accolade.top_pick', 'accolade.hidden_gem',
  'accolade.crowd_draw', 'accolade.bold_bet'
]));

export function projectReviewAccoladeDefinitions(input: {
  readonly scope: ReviewScopeDto;
  readonly accolades: ReviewAccoladeSource;
}): readonly ReviewAccoladeDefinitionProjection[] {
  const scope = parseReviewScope(input.scope);
  return Object.freeze(input.accolades.listDefinitions(scope)
    .filter((definition) =>
      REVIEW_ACCOLADE_KEYS.has(definition.key)
      && definition.status === 'active'
      && definition.shown
      && definition.family === 'quality'
      && definition.valueKind === 'flag'
      && definition.visibility === 'reviewer'
      && definition.subjects.includes('submission')
      && definition.allowedProvenance.includes('human')
    )
    .sort((left, right) => left.position - right.position || compareText(left.key, right.key))
    .map((definition) => reviewAccoladeDefinitionProjectionSchema.parse({
      key: definition.key,
      version: definition.version,
      label: definition.label,
      description: definition.description,
      icon: definition.display.icon,
      ...(definition.writeCaps?.perActorPerPlan === undefined
        ? {}
        : { cap: definition.writeCaps.perActorPerPlan })
    })));
}

export function projectReviewRoundSetup(input: {
  readonly scope: ReviewScopeDto;
  readonly sources: ReviewPlanningSource;
}): ReviewRoundSetupProjection {
  const scope = parseReviewScope(input.scope);
  const candidateSet = input.sources.readCandidates(scope);
  const rosterSet = input.sources.readReviewerRoster(scope);
  if (!candidateSet || !rosterSet) throw new TypeError('review_projection_scope_missing');
  const candidates = [...candidateSet.candidates].map(parseReviewCandidate).sort(compareCandidates);
  const reviewers = [...rosterSet.reviewers].map(parseReviewRosterMember).sort(compareReviewers);
  const pairs = expectedReviewAssignmentPairs({ candidates, reviewers });
  const perReviewer = reviewers.filter((reviewer) => reviewer.status === 'active').map((reviewer) => ({
    reviewerId: reviewer.reviewerId,
    ...(reviewer.displayName === undefined ? {} : { displayName: reviewer.displayName }),
    assigned: pairs.filter((pair) => pair.reviewerId === reviewer.reviewerId).length
  }));
  return reviewRoundSetupProjectionSchema.parse({
    activeReviewers: reviewers.filter((reviewer) => reviewer.status === 'active').length,
    invitedReviewers: reviewers.filter((reviewer) => reviewer.status === 'invited').length,
    submissions: candidates.length,
    expectedReviews: pairs.length,
    perReviewer
  });
}

export function projectReviewPlans(input: {
  readonly scope: ReviewScopeDto;
  readonly viewer: ReviewProjectionViewer;
  readonly environment: ReviewProjectionEnvironment;
}): readonly ReviewPlanProjection[] {
  const environment = memoizeReviewProjectionEnvironment(input.environment);
  const scope = parseReviewScope(input.scope);
  const catalog = environment.repository.readCatalog(scope);
  const roster = environment.sources.readReviewerRoster(scope);
  if (!catalog || !roster) throw new TypeError('review_projection_scope_missing');
  const rosterById = new Map(roster.reviewers.map((reviewer) => [reviewer.reviewerId, reviewer]));
  return Object.freeze(catalog.rounds.filter((round) => round.state !== 'discarded').map((round) => {
    const assignments = environment.repository.listAssignments(scope, round.id);
    const resolutionByAssignment = new Map(assignments.map((assignment) => [
      assignment.id,
      environment.repository.readVacancyResolution?.(scope, assignment.id)
    ]));
    const isUnresolved = (assignment: (typeof assignments)[number]) =>
      assignment.state === 'stepped_back' && resolutionByAssignment.get(assignment.id) === undefined;
    const isEffective = (assignment: (typeof assignments)[number]) =>
      assignment.state === 'assigned' || isUnresolved(assignment);
    const effectiveLoad = (reviewerId: string) => assignments.filter((assignment) =>
      assignment.reviewerId === reviewerId && isEffective(assignment)
    ).length;
    const reviewerIds = [...new Set(assignments.map((assignment) => assignment.reviewerId))].sort();
    const allReviewers = reviewerIds.map((reviewerId) => {
      const own = assignments.filter((assignment) => assignment.reviewerId === reviewerId);
      const steppedBackAssignments = own
        .filter((assignment) => assignment.state === 'stepped_back')
        .sort((left, right) => compareText(left.id, right.id));
      const uncovered = input.viewer.kind === 'organizer'
        ? steppedBackAssignments.filter(isUnresolved).map((assignment) => {
            const candidate = environment.candidateDisplay.readReviewCandidateDisplay({
              scope,
              roundId: round.id,
              submissionId: assignment.submissionId,
              reviewerId,
              includeSpeakerIdentity: false
            });
            if (!candidate) throw new TypeError('review_projection_candidate_display_missing');
            const candidateScope = environment.sources.readCandidate(scope, assignment.submissionId);
            if (!candidateScope) throw new TypeError('review_projection_candidate_missing');
            const alreadyAssigned = new Set(assignments.filter((other) =>
              other.submissionId === assignment.submissionId
            ).map((other) => other.reviewerId));
            const replacementCandidates = roster.reviewers
              .filter((reviewer) => reviewer.status === 'active' && !alreadyAssigned.has(reviewer.reviewerId))
              .map((reviewer) => {
                const scopeMatch = reviewerCoversCandidate(reviewer, candidateScope);
                return {
                  reviewerId: reviewer.reviewerId,
                  ...(reviewer.displayName === undefined ? {} : { displayName: reviewer.displayName }),
                  assigned: effectiveLoad(reviewer.reviewerId),
                  scopeMatch,
                  ...(scopeMatch ? {} : { conflict: 'Outside this reviewer’s current scope' })
                };
              })
              .sort((left, right) => Number(right.scopeMatch) - Number(left.scopeMatch)
                || left.assigned - right.assigned
                || compareText(left.displayName ?? left.reviewerId, right.displayName ?? right.reviewerId)
                || compareText(left.reviewerId, right.reviewerId));
            return {
              assignmentId: assignment.id,
              assignmentVersion: assignment.version,
              roundId: assignment.roundId,
              submissionId: assignment.submissionId,
              title: parseReviewCandidateDisplay(candidate).title,
              remainingReviewers: assignments.filter((other) =>
                other.submissionId === assignment.submissionId && other.state === 'assigned'
              ).length,
              replacementCandidates
            };
          })
        : undefined;
      const steppedBack = steppedBackAssignments.length;
      return {
        reviewerId,
        ...(rosterById.get(reviewerId)?.displayName === undefined
          || (input.viewer.kind === 'reviewer'
            && input.viewer.reviewerId !== reviewerId
            && round.visibility.peerReviewerIdentity === 'hidden')
          ? {}
          : { displayName: rosterById.get(reviewerId)!.displayName }),
        assigned: own.filter(isEffective).length,
        done: own.filter((assignment) =>
          environment.repository.readReviewHead(scope, assignment.id) !== undefined
        ).length,
        steppedBack,
        awaitingReassignment: own.filter(isUnresolved).length,
        ...(uncovered === undefined || uncovered.length === 0 ? {} : { uncovered })
      };
    });
    const done = assignments.filter((assignment) => assignment.state === 'assigned'
      && environment.repository.readReviewHead(scope, assignment.id) !== undefined).length;
    const total = assignments.filter(isEffective).length;
    const viewerReviewerId = input.viewer.kind === 'reviewer'
      ? input.viewer.reviewerId
      : undefined;
    const reviewers = viewerReviewerId !== undefined
      && round.visibility.peerReviewerIdentity === 'hidden'
      ? allReviewers.filter((reviewer) => reviewer.reviewerId === viewerReviewerId)
      : allReviewers;
    return reviewPlanProjectionSchema.parse({
      id: round.id,
      ordinal: round.ordinal,
      name: round.name,
      state: round.state,
      version: round.version,
      scaleMax: 5,
      // Criterion identities are served verbatim from the canonical round so
      // evaluation writes score the same ids every reader saw.
      criteria: round.criteria,
      deadlineEffectiveAt: round.deadline.effectiveAt,
      anonymized: round.visibility.participantIdentity === 'hidden',
      antiAnchoring: round.visibility.peerContentUnlock === 'after_own_commit',
      done,
      total,
      reviewers
    });
  }));
}

export function projectReviewerQueue(input: {
  readonly scope: ReviewScopeDto;
  readonly reviewerId: string;
  readonly environment: ReviewProjectionEnvironment;
}): readonly ReviewQueueItemProjection[] {
  const environment = memoizeReviewProjectionEnvironment(input.environment);
  const scope = parseReviewScope(input.scope);
  const catalog = environment.repository.readCatalog(scope);
  if (!catalog) throw new TypeError('review_projection_scope_missing');
  const openRounds = catalog.rounds.filter((round) => round.state === 'open');
  const rows: ReviewQueueItemProjection[] = [];
  for (const round of openRounds) {
    const assignments = environment.repository.listAssignments(scope, round.id);
    const accoladePins = environment.accolades.listCurrentHumanFlags({
      scope,
      actorReviewerId: input.reviewerId,
      reviewPlanId: round.id
    });
    for (const assignment of assignments) {
      if (assignment.reviewerId !== input.reviewerId || assignment.state !== 'assigned') continue;
      const draft = environment.repository.readDraft(scope, assignment.id);
      const joinedCandidate = environment.candidateDisplay.readReviewCandidateDisplay({
        scope,
        roundId: round.id,
        submissionId: assignment.submissionId,
        reviewerId: input.reviewerId,
        includeSpeakerIdentity: round.visibility.participantIdentity === 'shown'
      });
      if (!joinedCandidate) throw new TypeError('review_projection_candidate_display_missing');
      const parsedCandidate = parseReviewCandidateDisplay(joinedCandidate);
      const assignmentCandidate = environment.sources.readCandidate(
        scope,
        assignment.submissionId
      );
      const parsedAssignmentCandidate = assignmentCandidate === undefined
        ? undefined
        : parseReviewCandidate(assignmentCandidate);
      if (parsedCandidate.submissionId !== assignment.submissionId
          || parsedAssignmentCandidate === undefined
          || parsedCandidate.version !== parsedAssignmentCandidate.version
          || parsedCandidate.trackId !== parsedAssignmentCandidate.trackId
          || parsedCandidate.formatId !== parsedAssignmentCandidate.formatId
          || parsedCandidate.targetSessionId !== parsedAssignmentCandidate.targetSessionId) {
        throw new TypeError('review_projection_candidate_display_scope_mismatch');
      }
      const candidate = (() => {
        if (round.visibility.participantIdentity === 'shown') return parsedCandidate;
        const { speakers: _withheldSpeakers, ...blindCandidate } = parsedCandidate;
        return parseReviewCandidateDisplay(blindCandidate);
      })();
      const head = environment.repository.readReviewHead(scope, assignment.id);
      const revisions = environment.repository.listRevisions(scope, assignment.id)
        .slice().sort(compareRevisions);
      const current = head
        ? revisions.find((revision) => revision.id === head.currentRevisionId)
        : undefined;
      if (head && !current) throw new TypeError('review_projection_current_revision_missing');
      const ownAccolades = accoladePins.filter((observation) =>
        REVIEW_ACCOLADE_KEYS.has(observation.definitionKey)
        &&
        observation.subject.kind === 'submission'
        && observation.subject.id === assignment.submissionId
        && observation.provenance.kind === 'human'
        && observation.value === true
      );
      if (ownAccolades.length > 0 && head === undefined) {
        throw new TypeError('review_projection_accolade_without_review');
      }
      const peerScores = peerContentUnlocked(round, head !== undefined)
        ? currentScoresForSubmission({
            scope,
            round,
            submissionId: assignment.submissionId,
            repository: environment.repository,
            excludingAssignmentId: assignment.id
          }).map((entry) => entry.score)
        : undefined;
      rows.push(reviewQueueItemProjectionSchema.parse({
        assignmentId: assignment.id,
        roundId: assignment.roundId,
        submissionId: assignment.submissionId,
        assignmentVersion: assignment.version,
        candidate,
        ...(draft === undefined || head !== undefined ? {} : {
          draft: {
            version: draft.version,
            score: weightedReviewScore(round, draft.scores),
            comment: draft.comment
          }
        }),
        committed: head !== undefined,
        ...(current === undefined ? {} : { current: projectRevision(current) }),
        revisions: revisions.map(projectRevision),
        ...(peerScores === undefined ? {} : { peerScores }),
        ...(ownAccolades.length === 0 ? {} : {
          accolades: ownAccolades.map((observation) => ({
            key: observation.definitionKey,
            definitionVersion: observation.definitionVersion,
            observationId: observation.id
          }))
        })
      }));
    }
  }
  return Object.freeze(rows.sort((left, right) =>
    left.roundId === right.roundId
      ? compareText(left.submissionId, right.submissionId)
      : compareText(left.roundId, right.roundId)
  ));
}

export function projectReviewStandings(input: {
  readonly scope: ReviewScopeDto;
  readonly viewer: ReviewProjectionViewer;
  readonly submissionIds: readonly string[];
  readonly slice: 'track' | 'all';
  readonly environment: ReviewProjectionEnvironment;
}): Readonly<Record<string, ReviewStanding>> {
  const environment = memoizeReviewProjectionEnvironment(input.environment);
  const scope = parseReviewScope(input.scope);
  const catalog = environment.repository.readCatalog(scope);
  if (!catalog) throw new TypeError('review_projection_scope_missing');
  const round = [...catalog.rounds].reverse().find((candidate) => candidate.state !== 'discarded');
  if (!round) return Object.freeze({});
  const assignments = environment.repository.listAssignments(scope, round.id);
  const candidateSet = environment.sources.readCandidates(scope);
  const candidateById = new Map<string, ReviewCandidateSnapshotDto>();
  if (candidateSet) {
    for (const candidate of candidateSet.candidates) {
      candidateById.set(candidate.submissionId, parseReviewCandidate(candidate));
    }
  }
  for (const assignment of assignments) {
    if (candidateById.has(assignment.submissionId)) continue;
    const candidate = environment.sources.readCandidate(scope, assignment.submissionId);
    if (candidate) candidateById.set(candidate.submissionId, parseReviewCandidate(candidate));
  }
  const scoresBySubmission = new Map<string, { assignmentId: string; score: number }[]>();
  for (const assignment of assignments) {
    const head = environment.repository.readReviewHead(scope, assignment.id);
    if (!head) continue;
    const revision = environment.repository.readRevision(scope, head.currentRevisionId);
    if (!revision || revision.assignmentId !== assignment.id) {
      throw new TypeError('review_projection_current_revision_missing');
    }
    const bucket = scoresBySubmission.get(assignment.submissionId) ?? [];
    bucket.push({ assignmentId: assignment.id, score: revision.weightedScore });
    scoresBySubmission.set(assignment.submissionId, bucket);
  }
  const averages = new Map<string, { readonly submissionId: string; readonly average: number; readonly reviews: number }>();
  for (const [submissionId, scores] of scoresBySubmission) {
    averages.set(submissionId, {
      submissionId,
      average: rounded(scores.reduce((sum, entry) => sum + entry.score, 0) / scores.length),
      reviews: scores.length
    });
  }
  const populations = new Map<string, readonly {
    readonly submissionId: string;
    readonly average: number;
    readonly reviews: number;
  }[]>();
  function populationFor(trackId: string | undefined) {
    const key = input.slice === 'all' ? 'all' : `track:${trackId ?? ''}`;
    const cached = populations.get(key);
    if (cached) return cached;
    const population = [...averages.values()]
      .filter((entry) => input.slice === 'all'
        || candidateById.get(entry.submissionId)?.trackId === trackId)
      .sort((left, right) => left.average - right.average || compareText(left.submissionId, right.submissionId));
    populations.set(key, population);
    return population;
  }
  const result: Record<string, ReviewStanding> = {};
  for (const submissionId of [...new Set(input.submissionIds)].sort()) {
    if (!mayReadStanding({
      viewer: input.viewer, round, submissionId, assignments,
      repository: environment.repository, scope
    })) {
      continue;
    }
    const focusCandidate = candidateById.get(submissionId);
    if (!focusCandidate) continue;
    const population = populationFor(focusCandidate.trackId);
    const focus = population.find((entry) => entry.submissionId === submissionId);
    if (!focus) continue;
    result[submissionId] = standingFor({
      focus,
      population,
      slice: input.slice,
      ...(input.slice === 'track' && focusCandidate.trackId !== undefined
        ? { trackId: focusCandidate.trackId }
        : {})
    });
  }
  return Object.freeze(result);
}

export function projectReviewSnapshot(input: {
  readonly scope: ReviewScopeDto;
  readonly viewer: ReviewProjectionViewer;
  readonly standingSubmissionIds?: readonly string[];
  readonly standingSlice?: 'track' | 'all';
  readonly environment: ReviewProjectionEnvironment;
}): ReviewSnapshot {
  const environment = memoizeReviewProjectionEnvironment(input.environment);
  const scope = parseReviewScope(input.scope);
  const plans = projectReviewPlans({
    scope,
    viewer: input.viewer,
    environment
  });
  const catalog = environment.repository.readCatalog(scope);
  if (!catalog) throw new TypeError('review_projection_scope_missing');
  const viewerReviewerId = input.viewer.kind === 'reviewer'
    ? input.viewer.reviewerId
    : undefined;
  const reviewer = viewerReviewerId !== undefined
    ? environment.sources.readReviewerRoster(scope)?.reviewers
      .find((candidate) => candidate.reviewerId === viewerReviewerId)
    : undefined;
  if (input.viewer.kind === 'reviewer' && reviewer?.status !== 'active') {
    throw new TypeError('review_projection_reviewer_missing');
  }
  return reviewSnapshotSchema.parse({
    schemaVersion: 1,
    viewer: input.viewer,
    plans,
    accoladeDefinitions: projectReviewAccoladeDefinitions({ scope, accolades: environment.accolades }),
    ...(input.viewer.kind === 'organizer' && !catalog.rounds.some((round) => round.state === 'open')
      ? { roundSetup: projectReviewRoundSetup({ scope, sources: environment.sources }) }
      : {}),
    ...(reviewer === undefined ? {} : { reviewerScope: reviewer.scope }),
    ...(input.viewer.kind === 'reviewer' ? {
      queue: projectReviewerQueue({
        scope,
        reviewerId: viewerReviewerId!,
        environment
      })
    } : {}),
    standings: projectReviewStandings({
      scope,
      viewer: input.viewer,
      submissionIds: input.standingSubmissionIds ?? [],
      slice: input.standingSlice ?? 'track',
      environment
    })
  });
}

function mayReadStanding(input: {
  readonly viewer: ReviewProjectionViewer;
  readonly round: ReviewRoundDto;
  readonly submissionId: string;
  readonly assignments: readonly { id: string; submissionId: string; reviewerId: string; state: string }[];
  readonly repository: ReviewRepository;
  readonly scope: ReviewScopeDto;
}): boolean {
  if (input.viewer.kind === 'organizer') return true;
  const reviewerId = input.viewer.reviewerId;
  const own = input.assignments.find((assignment) =>
    assignment.submissionId === input.submissionId
      && assignment.reviewerId === reviewerId
      && assignment.state === 'assigned'
  );
  if (!own) return false;
  return peerContentUnlocked(
    input.round,
    input.repository.readReviewHead(input.scope, own.id) !== undefined
  );
}

function peerContentUnlocked(round: ReviewRoundDto, ownCommitted: boolean): boolean {
  return round.visibility.peerContentUnlock === 'open' || ownCommitted;
}

function currentScoresForSubmission(input: {
  readonly scope: ReviewScopeDto;
  readonly round: ReviewRoundDto;
  readonly submissionId: string;
  readonly repository: ReviewRepository;
  readonly excludingAssignmentId?: string;
}): readonly { readonly assignmentId: string; readonly score: number }[] {
  const scores: { assignmentId: string; score: number }[] = [];
  for (const assignment of input.repository.listAssignments(input.scope, input.round.id)) {
    if (assignment.submissionId !== input.submissionId
        || assignment.id === input.excludingAssignmentId) continue;
    const head = input.repository.readReviewHead(input.scope, assignment.id);
    if (!head) continue;
    const revision = input.repository.readRevision(input.scope, head.currentRevisionId);
    if (!revision || revision.assignmentId !== assignment.id) {
      throw new TypeError('review_projection_current_revision_missing');
    }
    scores.push({ assignmentId: assignment.id, score: revision.weightedScore });
  }
  return Object.freeze(scores.sort((left, right) => compareText(left.assignmentId, right.assignmentId)));
}

function projectRevision(revision: ReviewRevisionDto) {
  return {
    revisionId: revision.id,
    score: revision.weightedScore,
    comment: revision.comment,
    at: revision.committedAt,
    postUnlock: revision.postUnlock,
    ...(revision.correctionOfRevisionId === undefined
      ? {}
      : { correctionOfRevisionId: revision.correctionOfRevisionId })
  };
}

function standingFor(input: {
  readonly focus: { submissionId: string; average: number; reviews: number };
  readonly population: readonly { submissionId: string; average: number; reviews: number }[];
  readonly slice: 'track' | 'all';
  readonly trackId?: string;
}): ReviewStanding {
  const values = input.population.map((entry) => entry.average);
  const n = values.length;
  const sorted = [...values].sort((left, right) => left - right);
  const median = rounded(n % 2 === 1
    ? sorted[Math.floor(n / 2)]!
    : (sorted[(n / 2) - 1]! + sorted[n / 2]!) / 2);
  const lower = values.filter((value) => value < input.focus.average).length;
  const ties = values.filter((value) => value === input.focus.average).length;
  const percentile = n <= 1 ? 0.5 : (lower + Math.max(0, ties - 1) / 2) / (n - 1);
  const strictMaximum = values.every((value) => value <= input.focus.average)
    && values.some((value) => value < input.focus.average);
  const strictMinimum = values.every((value) => value >= input.focus.average)
    && values.some((value) => value > input.focus.average);
  const band = n < 8 ? 'few'
    : strictMaximum || percentile >= 0.9 ? 'top'
      : percentile >= 0.75 ? 'upper'
        : strictMinimum || percentile <= 0.1 ? 'bottom'
          : percentile <= 0.25 ? 'lower'
            : 'mid';
  const phrase = n < 8
    ? `Only ${n} scored so far — too few to rank`
    : strictMaximum
      ? `Highest of ${n} scored`
      : strictMinimum
        ? `Lowest of ${n} scored`
        : `Higher than ${Math.round(percentile * 100)}% of ${n} scored`;
  const others = input.population
    .filter((entry) => entry.submissionId !== input.focus.submissionId)
    .map((entry) => entry.average);
  return reviewStandingSchema.parse({
    submissionId: input.focus.submissionId,
    value: input.focus.average,
    scaleMax: 5,
    reviews: input.focus.reviews,
    n,
    median,
    band,
    phrase,
    slice: {
      ...(input.slice === 'all' ? { label: 'All scored submissions' } : {}),
      ...(input.trackId === undefined ? {} : { trackId: input.trackId })
    },
    ...(n <= 120 ? { points: others } : { bins: histogram(values) })
  });
}

function histogram(values: readonly number[]): readonly number[] {
  const bins = Array.from({ length: 24 }, () => 0);
  for (const value of values) {
    const position = Math.max(0, Math.min(23, Math.floor(((value - 1) / 4) * 24)));
    bins[position] = (bins[position] ?? 0) + 1;
  }
  return bins;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
