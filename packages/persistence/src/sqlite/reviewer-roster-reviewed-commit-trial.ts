import type { Database } from 'bun:sqlite';
import {
  applyPreparedChangesetSynchronous,
  createChangeset,
  markChangesetCommitted,
  planChangesetCompensationSynchronous,
  planChangesetOperationSynchronous,
  prepareChangesetCommitSynchronous,
  proposeChangeset,
  validateExactCommit,
  type ChangesetApplyContribution,
  type ChangesetHead,
  type ChangesetPlanningSnapshot,
  type CommittedChangesetSource,
  type FrozenChangesetOperation
} from '@jooevents/changesets';
import type {
  ReviewerRosterMutationInput,
  ReviewerRosterMutationPlanDto
} from '@jooevents/contracts/reviewer-roster';
import { canonicalJsonText, parseOperationReceiptId } from '@jooevents/kernel';
import {
  REVIEWER_ROSTER_CHANGESET_KIND,
  REVIEWER_ROSTER_CHANGESET_VERSION,
  createReviewerRosterChangesetBundle,
  reviewerRosterChangesetReadPort,
  reviewerRosterChangesetTransactionPort,
  reviewerRosterChangesetValidationPort,
  reviewerRosterGuardId,
  type ReviewerRosterAttribution,
  type ReviewerRosterChangesetAuthorInput
} from '@jooevents/review/roster';
import type { SQLiteReviewerRosterTrialRepository } from './reviewer-roster-trial';

export const REVIEWER_ROSTER_REVIEWED_COMMIT_TRIAL_SQL = `
CREATE TABLE reviewer_roster_trial_commit_replays (
  commit_key TEXT PRIMARY KEY CHECK(length(commit_key) BETWEEN 1 AND 300),
  receipt_id TEXT NOT NULL UNIQUE CHECK(length(receipt_id) = 36),
  changeset_id TEXT NOT NULL CHECK(length(changeset_id) = 36),
  revision_id TEXT NOT NULL CHECK(length(revision_id) = 36),
  revision_digest_sha256 TEXT NOT NULL CHECK(length(revision_digest_sha256) = 64),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  fact_json TEXT NOT NULL CHECK(json_valid(fact_json)),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_roster_trial_timeline (
  timeline_id TEXT PRIMARY KEY CHECK(length(timeline_id) = 36),
  commit_key TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  reviewer_id TEXT NOT NULL CHECK(length(reviewer_id) = 36),
  action TEXT NOT NULL CHECK(action IN ('register', 'set_scope', 'revoke', 'restore')),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (commit_key) REFERENCES reviewer_roster_trial_commit_replays(commit_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER reviewer_roster_trial_commit_replays_immutable
BEFORE UPDATE ON reviewer_roster_trial_commit_replays
BEGIN SELECT RAISE(ABORT, 'reviewer roster trial commit evidence is immutable'); END;
CREATE TRIGGER reviewer_roster_trial_commit_replays_retained
BEFORE DELETE ON reviewer_roster_trial_commit_replays
BEGIN SELECT RAISE(ABORT, 'reviewer roster trial commit evidence is retained'); END;
CREATE TRIGGER reviewer_roster_trial_timeline_immutable
BEFORE UPDATE ON reviewer_roster_trial_timeline
BEGIN SELECT RAISE(ABORT, 'reviewer roster trial timeline is immutable'); END;
CREATE TRIGGER reviewer_roster_trial_timeline_retained
BEFORE DELETE ON reviewer_roster_trial_timeline
BEGIN SELECT RAISE(ABORT, 'reviewer roster trial timeline is retained'); END;
`;

export interface ReviewerRosterReviewedDraftIds {
  readonly changesetId: string;
  readonly revisionId: string;
}

export interface ReviewerRosterReviewedCommitInput {
  readonly commitKey: string;
  readonly proposed: ChangesetHead;
  readonly receiptId: string;
  readonly timelineId: string;
  readonly permissionIds: readonly string[];
  readonly occurredAt: string;
  readonly failAfterApplyForTest?: boolean;
}

export type ReviewerRosterReviewedCommitResult =
  | {
      readonly kind: 'committed';
      readonly head: ChangesetHead;
      readonly source: CommittedChangesetSource;
      readonly contributions: readonly ChangesetApplyContribution<unknown>[];
    }
  | {
      readonly kind: 'replayed';
      readonly receiptId: string;
      readonly result: unknown;
      readonly fact: unknown;
    }
  | { readonly kind: 'refused'; readonly reason: string };

export function installReviewerRosterReviewedCommitTrialSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('reviewer_roster_reviewed_commit_transaction_forbidden');
  sqlite.exec(REVIEWER_ROSTER_REVIEWED_COMMIT_TRIAL_SQL);
}

/**
 * Disposable proof of the real generic changeset ceremony. It is intentionally
 * separate from runtime composition and retained migration history.
 */
export class SQLiteReviewerRosterReviewedCommitTrial {
  private readonly bundle = createReviewerRosterChangesetBundle();

  constructor(
    private readonly sqlite: Database,
    private readonly repository: SQLiteReviewerRosterTrialRepository
  ) {}

  draft(input: {
    readonly request: ReviewerRosterMutationInput;
    readonly attribution: ReviewerRosterAttribution;
    readonly ids: ReviewerRosterReviewedDraftIds;
    readonly proposerPrincipalKey: string;
  }): ChangesetHead {
    const operation = planChangesetOperationSynchronous({
      registry: this.bundle.registry,
      kind: REVIEWER_ROSTER_CHANGESET_KIND,
      version: REVIEWER_ROSTER_CHANGESET_VERSION,
      authorInput: {
        request: input.request,
        attribution: input.attribution
      } satisfies ReviewerRosterChangesetAuthorInput,
      dependencyGroup: 'reviewer-roster',
      snapshot: this.snapshot()
    });
    const draft = createChangeset({
      id: input.ids.changesetId,
      workspaceId: input.request.scope.workspaceId,
      eventId: input.request.scope.eventId
    }, {
      id: input.ids.revisionId,
      createdAt: input.attribution.occurredAt,
      proposerPrincipalKey: input.proposerPrincipalKey,
      origin: 'human_ui',
      operations: [operation],
      dependencyGroups: [{ key: 'reviewer-roster', dependsOn: [] }],
      approvalPolicy: { key: 'reviewer-roster-reviewed', version: 1 }
    });
    return proposeChangeset(draft, draft.version);
  }

  commit(input: ReviewerRosterReviewedCommitInput): ReviewerRosterReviewedCommitResult {
    const replay = this.sqlite.query<{
      receipt_id: string; changeset_id: string; revision_id: string;
      revision_digest_sha256: string; result_json: string; fact_json: string
    }, [string]>(`
      SELECT receipt_id, changeset_id, revision_id, revision_digest_sha256,
             result_json, fact_json
        FROM reviewer_roster_trial_commit_replays WHERE commit_key = ? LIMIT 1
    `).get(input.commitKey);
    if (replay) {
      const requestedRevision = input.proposed.revisions.at(-1);
      if (!requestedRevision
          || replay.changeset_id !== input.proposed.id
          || replay.revision_id !== requestedRevision.id
          || replay.revision_digest_sha256 !== requestedRevision.digest) {
        return { kind: 'refused', reason: 'replay_request_changed' };
      }
      return {
        kind: 'replayed', receiptId: replay.receipt_id,
        result: JSON.parse(replay.result_json), fact: JSON.parse(replay.fact_json)
      };
    }
    if (input.permissionIds.length !== 1 || input.permissionIds[0] !== 'event.manage') {
      return { kind: 'refused', reason: 'access_denied' };
    }
    const revision = input.proposed.revisions.at(-1);
    const operation = revision?.operations[0];
    if (!revision || !operation) return { kind: 'refused', reason: 'revision_missing' };
    const plan = operation.plan as unknown as ReviewerRosterMutationPlanDto;
    const current = this.currentEvidence(plan, operation);
    const validation = validateExactCommit(input.proposed, {
      expectedHeadVersion: input.proposed.version,
      expectedRevisionDigest: revision.digest,
      currentAggregateVersions: current.aggregateVersions,
      currentGuardVersions: current.guardVersions,
      currentGuardDigests: current.guardDigests,
      now: input.occurredAt,
      approvalRequirement: 'none'
    });
    if (validation.kind !== 'ready') {
      return { kind: 'refused', reason: validation.refusal.kind };
    }
    return this.sqlite.transaction(() => {
      const prepared = prepareChangesetCommitSynchronous({
        registry: this.bundle.registry,
        authorization: validation.authorization,
        transaction: {
          getPort: <Port>(key: { readonly key: string; readonly version: number }): Port => {
            if (key !== reviewerRosterChangesetValidationPort
                && key !== reviewerRosterChangesetTransactionPort) {
              throw new TypeError('unexpected_reviewer_roster_trial_port');
            }
            return this.repository as unknown as Port;
          }
        }
      });
      if (prepared.kind !== 'ready') {
        return { kind: 'refused', reason: prepared.outcome.kind } as const;
      }
      const contributions = applyPreparedChangesetSynchronous(prepared.prepared);
      if (input.failAfterApplyForTest) throw new Error('reviewer_roster_trial_forced_rollback');
      const contribution = contributions[0];
      const fact = contribution?.facts[0];
      if (!contribution || !fact) throw new TypeError('reviewer_roster_trial_evidence_missing');
      const receiptId = parseOperationReceiptId(input.receiptId);
      const marked = markChangesetCommitted(input.proposed, validation.authorization, receiptId);
      this.sqlite.query(`
        INSERT INTO reviewer_roster_trial_commit_replays(
          commit_key, receipt_id, changeset_id, revision_id, revision_digest_sha256,
          result_json, fact_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.commitKey, receiptId, input.proposed.id, revision.id, revision.digest,
        canonicalJsonText(contribution.result), canonicalJsonText(fact), Date.parse(input.occurredAt)
      );
      this.sqlite.query(`
        INSERT INTO reviewer_roster_trial_timeline(
          timeline_id, commit_key, workspace_id, event_id, reviewer_id, action, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.timelineId, input.commitKey, plan.input.scope.workspaceId,
        plan.input.scope.eventId, plan.input.reviewerId, plan.action,
        Date.parse(input.occurredAt)
      );
      return {
        kind: 'committed' as const,
        head: marked.head,
        source: marked.source,
        contributions
      };
    }).immediate();
  }

  planCompensation(source: CommittedChangesetSource) {
    return planChangesetCompensationSynchronous({
      registry: this.bundle.registry,
      source,
      snapshot: this.snapshot()
    });
  }

  draftCompensation(input: {
    readonly operations: readonly FrozenChangesetOperation[];
    readonly dependencyGroups: readonly { readonly key: string; readonly dependsOn: readonly string[] }[];
    readonly scope: ReviewerRosterMutationInput['scope'];
    readonly ids: ReviewerRosterReviewedDraftIds;
    readonly proposerPrincipalKey: string;
    readonly occurredAt: string;
  }): ChangesetHead {
    const draft = createChangeset({
      id: input.ids.changesetId,
      workspaceId: input.scope.workspaceId,
      eventId: input.scope.eventId
    }, {
      id: input.ids.revisionId,
      createdAt: input.occurredAt,
      proposerPrincipalKey: input.proposerPrincipalKey,
      origin: 'human_ui',
      operations: input.operations,
      dependencyGroups: input.dependencyGroups,
      approvalPolicy: { key: 'reviewer-roster-reviewed', version: 1 }
    });
    return proposeChangeset(draft, draft.version);
  }

  private snapshot(): ChangesetPlanningSnapshot {
    return Object.freeze({
      getPort: <Port>(key: { readonly key: string; readonly version: number }): Port => {
        if (key !== reviewerRosterChangesetReadPort) {
          throw new TypeError('unexpected_reviewer_roster_trial_read_port');
        }
        return this.repository as unknown as Port;
      }
    });
  }

  private currentEvidence(plan: ReviewerRosterMutationPlanDto, operation: FrozenChangesetOperation) {
    const roster = this.repository.readReviewerRoster(plan.input.scope);
    const authority = this.repository.readReviewerAuthority(plan.input.scope);
    const targets = this.repository.readReviewerScopeTargets(plan.input.scope);
    const aggregateVersions = new Map<string, number>();
    const guardVersions = new Map<string, number>();
    const guardDigests = new Map<string, string>();
    if (roster) {
      aggregateVersions.set(reviewerRosterGuardId(plan.input.scope.eventId), roster.version);
      guardVersions.set(reviewerRosterGuardId(plan.input.scope.eventId), roster.version);
      guardDigests.set(reviewerRosterGuardId(plan.input.scope.eventId), roster.digestSha256);
      const reviewer = roster.reviewers.find((candidate) => candidate.reviewerId === plan.input.reviewerId);
      if (reviewer) aggregateVersions.set(`reviewer:${reviewer.reviewerId}`, reviewer.version);
    }
    if (authority) {
      guardVersions.set(plan.authoritySetGuard.id, authority.version);
      guardDigests.set(plan.authoritySetGuard.id, authority.digestSha256);
      const fact = authority.facts.find((candidate) =>
        candidate.rosterSubject.kind === plan.after.accessSubject.kind
        && candidate.rosterSubject.id === plan.after.accessSubject.id
      );
      if (fact) {
        guardVersions.set(plan.authorityFactGuard.id, fact.version);
        guardDigests.set(plan.authorityFactGuard.id, fact.digestSha256);
      }
    }
    if (targets) {
      guardVersions.set(plan.targetSetGuard.id, targets.version);
      guardDigests.set(plan.targetSetGuard.id, targets.digestSha256);
      for (const targetGuard of plan.targetGuards) {
        const target = targets.targets.find((candidate) =>
          `reviewer_scope_target:${candidate.ref.kind}:${candidate.ref.id}` === targetGuard.id
        );
        if (target) {
          guardVersions.set(targetGuard.id, target.version);
          guardDigests.set(targetGuard.id, target.digestSha256);
        }
      }
    }
    for (const reference of operation.aggregateRefs) {
      if (!aggregateVersions.has(reference.id) && reference.id.startsWith('reviewer_roster:') && roster) {
        aggregateVersions.set(reference.id, roster.version);
      }
    }
    return { aggregateVersions, guardVersions, guardDigests };
  }
}
