import {
  submissionTriageSourceRowSchema,
  type SubmissionTriageSourceRowDto
} from '@jooevents/contracts/submission-triage';
import type {
  ReviewCandidateDisplayDto,
  ReviewCandidateSnapshotDto,
  ReviewScopeDto
} from '@jooevents/contracts/reviews';
import { canonicalJsonSha256 } from '@jooevents/changesets';
import {
  compareCandidates,
  parseReviewCandidate,
  parseReviewCandidateDisplay,
  parseReviewScope,
  type ReviewCandidateDisplaySource,
  type ReviewCandidateSet,
  type ReviewPlanningSource
} from '@jooevents/review';
import type { SubmissionTriageSourcePort } from '@jooevents/submission-triage';

/** The frozen review display contract caps speaker display names at 160 characters. */
const REVIEW_SPEAKER_DISPLAY_NAME_MAX_LENGTH = 160;

export type SQLiteReviewCandidateSourceErrorCode =
  | 'source_row_invalid'
  | 'source_row_out_of_scope'
  | 'duplicate_submission';

export class SQLiteReviewCandidateSourceError extends Error {
  constructor(readonly code: SQLiteReviewCandidateSourceErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteReviewCandidateSourceError';
  }
}

/**
 * One authority-shaped Review join over the least-disclosure submission-triage
 * source rows. Both Review faces — the assignment/scoping candidate snapshot and
 * the reviewer-visible candidate display — are derived from the same
 * `SubmissionTriageSourceRowDto` per submission, so `version`, `trackId`,
 * `formatId`, and `targetSessionId` always agree between the two reads for a
 * coherent source port.
 *
 * Version derivation: every candidate `version`, and the `ReviewCandidateSet`
 * `version`, are reduced deterministically from the immutable submission facts
 * `{ submissionId, formVersionId, submittedAt }` — for the set, the ordered
 * (submission-id ascending) array of those fact triples. Triage tray moves
 * (`set_aside`, `return_to_inbox`, discard/restore) touch none of those facts,
 * so triage churn can never invalidate a planned `review_candidates` guard; the
 * guard's digest, which covers the full candidate snapshots, remains the
 * authority for detecting genuine candidate drift such as category repoints.
 *
 * Disclosure: rows are revalidated against the strict source-row schema, so a
 * row smuggling contact material is refused rather than forwarded, and this
 * module never consults the permission-gated Intake contact projection. The
 * optional `speakers` key is present only when the caller releases identity
 * (`includeSpeakerIdentity: true`); absence means identity was not released.
 * A released speaker entry carries the source row's primary participant name
 * under a deterministic per-submission surrogate `speakerId` (the safe source
 * row releases no durable person identifier), and is omitted when the recorded
 * name cannot fit the frozen display contract. Submissions without a title are
 * not review candidates on either face: the frozen display contract requires a
 * title, and submitted answers are immutable, so the exclusion is permanent and
 * version-stable. Resources are not part of the safe triage row and project as
 * an empty list.
 */
export class SQLiteReviewCandidateSourceAdapter
implements Pick<ReviewPlanningSource, 'readCandidates' | 'readCandidate'>,
  ReviewCandidateDisplaySource {
  constructor(private readonly source: SubmissionTriageSourcePort) {}

  readCandidates(scopeInput: ReviewScopeDto): ReviewCandidateSet | undefined {
    const scope = parseReviewScope(scopeInput);
    const rows = this.reviewableRows(scope);
    const candidates = rows.map((row) => candidateFromRow(row)).sort(compareCandidates);
    return Object.freeze({
      version: deterministicVersion(rows.map((row) => immutableCandidateFacts(row))),
      candidates: Object.freeze(candidates)
    });
  }

  readCandidate(
    scopeInput: ReviewScopeDto,
    submissionId: string
  ): ReviewCandidateSnapshotDto | undefined {
    const row = this.reviewableRow(parseReviewScope(scopeInput), submissionId);
    return row === undefined ? undefined : candidateFromRow(row);
  }

  readReviewCandidateDisplay(input: {
    readonly scope: ReviewScopeDto;
    readonly roundId: string;
    readonly submissionId: string;
    readonly reviewerId: string;
    readonly includeSpeakerIdentity: boolean;
  }): ReviewCandidateDisplayDto | undefined {
    const row = this.reviewableRow(parseReviewScope(input.scope), input.submissionId);
    return row === undefined ? undefined : displayFromRow(row, input.includeSpeakerIdentity);
  }

  private reviewableRows(scope: ReviewScopeDto): readonly SubmissionTriageSourceRowDto[] {
    const seen = new Set<string>();
    const rows: SubmissionTriageSourceRowDto[] = [];
    for (const value of this.source.listSourceRows(scope)) {
      const row = assertSourceRow(scope, value);
      if (seen.has(row.summary.id)) {
        throw new SQLiteReviewCandidateSourceError('duplicate_submission');
      }
      seen.add(row.summary.id);
      if (row.summary.title !== null) rows.push(row);
    }
    return rows.sort((left, right) => compareText(left.summary.id, right.summary.id));
  }

  private reviewableRow(
    scope: ReviewScopeDto,
    submissionId: string
  ): SubmissionTriageSourceRowDto | undefined {
    const value = this.source.readSourceRow(scope, submissionId);
    if (value === undefined) return undefined;
    const row = assertSourceRow(scope, value);
    if (row.summary.id !== submissionId) {
      throw new SQLiteReviewCandidateSourceError('source_row_invalid');
    }
    return row.summary.title === null ? undefined : row;
  }
}

function assertSourceRow(scope: ReviewScopeDto, value: unknown): SubmissionTriageSourceRowDto {
  let row: SubmissionTriageSourceRowDto;
  try {
    row = submissionTriageSourceRowSchema.parse(value);
  } catch (error) {
    throw new SQLiteReviewCandidateSourceError('source_row_invalid', error);
  }
  if (row.scope.workspaceId !== scope.workspaceId || row.scope.eventId !== scope.eventId) {
    throw new SQLiteReviewCandidateSourceError('source_row_out_of_scope');
  }
  return row;
}

function immutableCandidateFacts(row: SubmissionTriageSourceRowDto): {
  readonly submissionId: string;
  readonly formVersionId: string;
  readonly submittedAt: string;
} {
  return {
    submissionId: row.summary.id,
    formVersionId: row.summary.formVersionId,
    submittedAt: row.summary.submittedAt
  };
}

/** Reduces canonical facts to a positive safe integer (48 digest bits, plus one). */
function deterministicVersion(facts: unknown): number {
  return Number.parseInt(canonicalJsonSha256(facts).slice(0, 12), 16) + 1;
}

function scopedProjection(row: SubmissionTriageSourceRowDto): {
  readonly version: number;
  readonly trackId?: string;
  readonly formatId?: string;
  readonly targetSessionId?: string;
} {
  const target = row.summary.target;
  return {
    version: deterministicVersion(immutableCandidateFacts(row)),
    ...(row.track === null ? {} : { trackId: row.track.id }),
    ...(row.format === null ? {} : { formatId: row.format.id }),
    ...(target.kind === 'session' ? { targetSessionId: target.sessionId } : {})
  };
}

function candidateFromRow(row: SubmissionTriageSourceRowDto): ReviewCandidateSnapshotDto {
  return parseReviewCandidate({
    submissionId: row.summary.id,
    ...scopedProjection(row)
  });
}

function displayFromRow(
  row: SubmissionTriageSourceRowDto,
  includeSpeakerIdentity: boolean
): ReviewCandidateDisplayDto {
  return parseReviewCandidateDisplay({
    submissionId: row.summary.id,
    ...scopedProjection(row),
    title: row.summary.title,
    abstract: row.abstract ?? '',
    submittedAt: row.summary.submittedAt,
    resources: [],
    ...(includeSpeakerIdentity ? { speakers: speakersFromRow(row) } : {})
  });
}

function speakersFromRow(row: SubmissionTriageSourceRowDto): readonly {
  readonly speakerId: string;
  readonly displayName: string;
}[] {
  const name = row.summary.primaryParticipantName;
  if (name === null || name.length > REVIEW_SPEAKER_DISPLAY_NAME_MAX_LENGTH) return [];
  return [{
    speakerId: surrogatePrimarySpeakerId(row.summary.id),
    displayName: name
  }];
}

/**
 * Deterministic per-submission surrogate for the primary participant. The safe
 * source row releases a display name but no durable person identifier, so this
 * ref is a content-derived UUID shape, not a directory id.
 */
function surrogatePrimarySpeakerId(submissionId: string): string {
  const digest = canonicalJsonSha256({
    purpose: 'review_candidate_primary_speaker',
    submissionId
  });
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(12, 15)}`
    + `-8${digest.slice(15, 18)}-${digest.slice(18, 30)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
