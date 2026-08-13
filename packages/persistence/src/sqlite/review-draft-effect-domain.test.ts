import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type EffectOperationIdentity,
  type EffectUnitOfWorkPort,
  type InvocationEvidence
} from '@jooevents/application';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  appendChangesetDraftSynchronous,
  createChangesetOperationModule,
  draftChangesetCorrectionSynchronous
} from '@jooevents/changeset-operations';
import {
  REVIEWER_CAPABILITY_IDS,
  reviewerRosterMutationInputSchema,
  type ReviewerAuthoritySetDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import {
  reviewChangeDraftOperationResultSchema,
  reviewDraftSaveInputSchema,
  reviewMutationPlanningInputSchema,
  type ReviewScopeDto
} from '@jooevents/contracts/reviews';
import {
  submissionTriageSourceRowSchema,
  type SubmissionTriageSourceRowDto
} from '@jooevents/contracts/submission-triage';
import { planEventCreation } from '@jooevents/event';
import { CURRENT_AUTHORITY_DENIAL_REASONS, type CurrentAuthorityDenialReason } from '@jooevents/identity-access';
import {
  parseApplicationId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseUserId,
  parseWorkspaceId,
  type Instant
} from '@jooevents/kernel';
import {
  applyReviewMutationPlan,
  createReviewChangesetBundle,
  expectedReviewAssignmentPairs,
  planReviewMutation,
  saveReviewDraft,
  REVIEW_CORE_CHANGESET_KIND,
  REVIEW_CORE_CHANGESET_VERSION,
  reviewChangesetReadPort
} from '@jooevents/review';
import {
  planReviewerRosterMutation,
  reviewerAuthorityFactDigest,
  reviewerAuthoritySetDigest,
  reviewerScopeTargetSetDigest,
  type ReviewerRosterPlanningSource
} from '@jooevents/review/roster';
import { reviewDueDeadlinePlanningPort } from '@jooevents/deadline';
import {
  REVIEW_CHANGE_APPROVAL_POLICY,
  REVIEW_EVALUATE_ACCESS_POLICY,
  REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
  REVIEW_MANAGE_ACCESS_POLICY,
  REVIEW_REQUEST_HASH_PROFILE,
  REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
  REVIEW_SNAPSHOT_ACCESS_POLICY,
  REVIEW_STEP_BACK_ACCESS_POLICY,
  REVIEW_STEP_BACK_DRAFT_OPERATION,
  createReviewOperationModule
} from '@jooevents/review-operations';
import type { SubmissionTriageScope, SubmissionTriageSourcePort } from '@jooevents/submission-triage';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import { installDeadlineSchema } from './deadline';
import { openSQLite } from './database';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema,
  SQLiteEventSpineRepository
} from './event-spine';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import { installReviewSchema, SQLiteReviewRepository } from './review';
import {
  createSQLiteReviewChangesetEffectDomainRegistration,
  installReviewChangesetEffectSchema,
  type SQLiteReviewChangesetEffectIds
} from './review-changeset-effect-domain';
import {
  createSQLiteReviewDraftEffectDomainRegistration,
  installReviewDraftEffectSchema,
  type SQLiteReviewDraftEffectIds
} from './review-draft-effect-domain';
import {
  createSQLiteReviewEvaluationDraftSaveEffectDomainRegistration,
  installReviewEvaluationDraftSaveEffectSchema
} from './review-evaluation-draft-save-effect-domain';
import { installReviewerRosterSchema, SQLiteReviewerRosterRepository } from './reviewer-roster';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df9-86b5-769b-bba4-5f7097bfa121');
const organizerUserId = parseUserId('019c1df9-86b5-769b-bba4-5f7097bfa221');
const organizerMembershipId = '019c1df9-86b5-769b-bba4-5f7097bfa222';
const reviewerUserId = parseUserId('019c1df9-86b5-769b-bba4-5f7097bfa223');
const reviewerMembershipId = '019c1df9-86b5-769b-bba4-5f7097bfa224';
const reviewerId = '019c1df9-86b5-769b-bba4-5f7097bfa225';
const submissionId = '019c1df9-86b5-769b-bba4-5f7097bfa301';
const formId = '019c1df9-86b5-769b-bba4-5f7097bfa302';
const formVersionId = '019c1df9-86b5-769b-bba4-5f7097bfa303';
const fieldId = '019c1df9-86b5-769b-bba4-5f7097bfa304';
const strayId = '019c1df9-86b5-769b-bba4-5f7097bfa305';
const scope: ReviewScopeDto = Object.freeze({ workspaceId, eventId });
const now = parseInstant('2026-08-13T09:00:00.000Z');
const profile = Object.freeze({ key: 'review-draft-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-review-draft-session'
});

type Actor = 'organizer' | 'reviewer';

function uuid(suffix: number): string {
  return `019c1df9-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function transaction<Result>(sqlite: ReturnType<typeof openSQLite>['sqlite'], work: () => Result) {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    sqlite.exec('COMMIT;');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function sourceRow(submission: string): SubmissionTriageSourceRowDto {
  return submissionTriageSourceRowSchema.parse({
    schemaVersion: 1,
    scope,
    source: 'public_form',
    summary: {
      schemaVersion: 1,
      id: submission,
      formId,
      formVersionId,
      target: { kind: 'general_pool' },
      title: `Proposal ${submission.slice(-2)}`,
      primaryParticipantName: 'José Sørensen',
      submittedAt: '2026-08-12T10:00:00.000Z'
    },
    detail: {
      schemaVersion: 1,
      submissionId: submission,
      formId,
      formVersionId,
      submittedAt: '2026-08-12T10:00:00.000Z',
      participantCount: 1,
      answers: [{
        kind: 'textarea', fieldId, fieldLabel: 'Abstract', value: 'Durable event systems'
      }],
      affirmedConsentFieldIds: []
    },
    abstract: 'Durable event systems',
    track: null,
    format: null
  });
}

class TriageSource implements SubmissionTriageSourcePort {
  rows: SubmissionTriageSourceRowDto[] = [sourceRow(submissionId)];

  listSourceRows(requested: SubmissionTriageScope): readonly SubmissionTriageSourceRowDto[] {
    return requested.workspaceId === workspaceId && requested.eventId === eventId
      ? this.rows
      : [];
  }

  readSourceRow(requested: SubmissionTriageScope, submission: string) {
    return this.listSourceRows(requested).find((row) => row.summary.id === submission);
  }
}

function rosterSources(): ReviewerRosterPlanningSource {
  const factUnsigned = {
    schemaVersion: 1 as const,
    scope,
    rosterSubject: { kind: 'workspace_membership' as const, id: reviewerMembershipId, version: 1 },
    currentSubject: { kind: 'workspace_membership' as const, id: reviewerMembershipId, version: 1 },
    state: 'active' as const,
    version: 1,
    capabilityIds: [...REVIEWER_CAPABILITY_IDS],
    evidenceIds: [`workspace_membership:${reviewerMembershipId}:v1`],
    displayName: 'Reviewer One'
  };
  const fact = {
    ...factUnsigned,
    digestSha256: reviewerAuthorityFactDigest(factUnsigned as never)
  };
  const setUnsigned = { schemaVersion: 1 as const, scope, version: 1, facts: [fact] };
  const authority = {
    ...setUnsigned,
    digestSha256: reviewerAuthoritySetDigest(setUnsigned as never)
  } as unknown as ReviewerAuthoritySetDto;
  const targetsUnsigned = { schemaVersion: 1 as const, scope, version: 1, targets: [] };
  const targets = {
    ...targetsUnsigned,
    digestSha256: reviewerScopeTargetSetDigest(targetsUnsigned as never)
  } as unknown as ReviewerScopeTargetSetDto;
  return Object.freeze({
    readReviewerAuthority: (requested: { workspaceId: string; eventId: string }) =>
      requested.workspaceId === workspaceId && requested.eventId === eventId
        ? authority
        : undefined,
    readReviewerScopeTargets: (requested: { workspaceId: string; eventId: string }) =>
      requested.workspaceId === workspaceId && requested.eventId === eventId
        ? targets
        : undefined
  });
}

function grantsFor(actor: Actor, policyKey: string): readonly string[] {
  if (policyKey === REVIEW_MANAGE_ACCESS_POLICY.key) return ['event.manage'];
  if (policyKey === REVIEW_STEP_BACK_ACCESS_POLICY.key) return ['submission.score'];
  if (policyKey === REVIEW_EVALUATE_ACCESS_POLICY.key) {
    return ['submission.comment', 'submission.score'];
  }
  if (policyKey === CHANGESET_LIFECYCLE_ACCESS_POLICY.key) {
    return actor === 'organizer'
      ? ['event.manage']
      : ['submission.comment', 'submission.score'];
  }
  return ['event.read'];
}

export function openFixture(options: { readonly currentEvent?: boolean } = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installDeadlineSchema(sqlite);
  installReviewerRosterSchema(sqlite);
  installReviewSchema(sqlite);
  installReviewDraftEffectSchema(sqlite);
  installReviewEvaluationDraftSaveEffectSchema(sqlite);
  installReviewChangesetEffectSchema(sqlite);

  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Review workspace', 1, 1, 1);
  for (const [id, name] of [
    [organizerUserId, 'Organizer'], [reviewerUserId, 'Reviewer']
  ] as const) {
    sqlite.query<never, [string, string, number, number, number]>(`
      INSERT INTO users (id, status, display_name, created_at, updated_at, version)
      VALUES (?, 'active', ?, ?, ?, ?)
    `).run(id, name, 1, 1, 1);
  }
  const spine = new SQLiteEventSpineRepository(sqlite);
  transaction(sqlite, () => {
    spine.bootstrapWorkspaceEventSet(workspaceId);
    spine.commitEventCreatePlan(planEventCreation({
      eventSet: spine.requireEventSet(workspaceId),
      authorInput: {
        expectedEventSetVersion: 1,
        name: 'Review Event',
        timezone: 'UTC',
        startDate: '2026-11-01',
        endDate: '2026-11-02'
      },
      server: {
        workspaceId, eventId, createdByUserId: organizerUserId,
        createdAt: '2026-08-13T01:00:00.000Z'
      }
    }));
    if (options.currentEvent === false) {
      sqlite.query<never, [string]>(`
        UPDATE event_spine_workspace_sets SET version = version + 1, current_event_id = NULL
         WHERE workspace_id = ?
      `).run(workspaceId);
    }
  });

  const triage = new TriageSource();
  const sources = rosterSources();
  const repository = new SQLiteReviewRepository(sqlite, { triage, roster: sources });
  const rosterRepository = new SQLiteReviewerRosterRepository(sqlite, sources);
  const roster = rosterRepository.readReviewerRoster(scope);
  if (!roster) throw new TypeError('review_fixture_roster_missing');
  transaction(sqlite, () => rosterRepository.applyReviewerRosterPlan(planReviewerRosterMutation(
    reviewerRosterMutationInputSchema.parse({
      action: 'register',
      scope,
      reviewerId,
      accessSubject: { kind: 'workspace_membership', id: reviewerMembershipId, version: 1 },
      reviews: [],
      expectedRosterVersion: roster.version,
      expectedRosterDigestSha256: roster.digestSha256
    }), {
    environment: { repository: rosterRepository, sources },
    attribution: { userId: organizerUserId, occurredAt: now }
  })));

  let nextId = 0x100;
  const forcedChangesetIds: string[] = [];
  const next = () => uuid(nextId++);
  const draftIds: SQLiteReviewDraftEffectIds = {
    newChangesetId: () => forcedChangesetIds.shift() ?? next(),
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newRoundId: next,
    newDeadlineId: next,
    newCriterionId: next,
    newAssignmentId: next,
    newReviewRevisionId: next
  };
  const forcedLifecycleIds = new Map<keyof SQLiteReviewChangesetEffectIds, string[]>();
  const lifecycleId = (method: keyof SQLiteReviewChangesetEffectIds) => () =>
    forcedLifecycleIds.get(method)?.shift() ?? next();
  const changesetIds: SQLiteReviewChangesetEffectIds = {
    newChangesetId: lifecycleId('newChangesetId'),
    newRevisionId: lifecycleId('newRevisionId'),
    newApprovalId: next,
    newCorrectionAttemptId: lifecycleId('newCorrectionAttemptId'),
    newPreparationHandle: next,
    newTimelineId: next,
    newFactId: next,
    newPointerId: next
  };
  const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
  const draftRegistration = createSQLiteReviewDraftEffectDomainRegistration({
    sqlite, workspaceId, repository, eventRelationships, ids: draftIds
  });
  const saveRegistration = createSQLiteReviewEvaluationDraftSaveEffectDomainRegistration({
    sqlite, workspaceId, repository, eventRelationships,
    ids: { newPreparationHandle: next }
  });
  const changesetRegistration = createSQLiteReviewChangesetEffectDomainRegistration({
    sqlite, workspaceId, repository, eventRelationships, ids: changesetIds
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    saveRegistration,
    changesetRegistration
  ]);

  let currentTime: Instant = now;
  const state = {
    actor: 'organizer' as Actor,
    denyReason: undefined as CurrentAuthorityDenialReason | undefined,
    contention: false
  };
  const authority = {
    resolve(input: {
      readonly evidence: InvocationEvidence;
      readonly lane: { readonly kind: string; readonly policy: { readonly key: string } };
      readonly scope: unknown;
      readonly evaluatedAt: Instant;
    }) {
      if (state.denyReason !== undefined) {
        return Object.freeze({ kind: 'denied' as const, reason: state.denyReason });
      }
      if (input.evidence.kind !== 'operator') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      const userId = state.actor === 'organizer' ? organizerUserId : reviewerUserId;
      const membershipId = state.actor === 'organizer'
        ? organizerMembershipId
        : reviewerMembershipId;
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
          principal: Object.freeze({
            kind: 'workspace_user' as const,
            userId,
            membershipId: parseApplicationId('membership', membershipId)
          }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze(grantsFor(state.actor, input.lane.policy.key).map((key) =>
            Object.freeze({ kind: 'permission' as const, key })
          )),
          evidenceIds: Object.freeze(['review-membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  };
  const keySealer = {
    seal(raw: string) {
      return Object.freeze({
        verifierProfile: profile,
        verifierSha256: createHash('sha256').update(`review-key:${raw}`).digest('hex')
      });
    }
  };
  const currentEvent = {
    resolveCurrentEvent(requestedWorkspaceId: typeof workspaceId) {
      if (requestedWorkspaceId !== workspaceId) throw new TypeError('review_workspace_mismatch');
      const current = new SQLiteEventSpineRepository(sqlite).readCurrentEventState(workspaceId);
      if (!current) throw new TypeError('review_event_set_missing');
      return Object.freeze({
        ...(current.currentEvent ? { eventId: current.currentEvent.id } : {}),
        evidenceIds: Object.freeze([
          `event-spine-set:${workspaceId}@${current.eventSet.version}`
        ])
      });
    }
  };
  const reviewModule = createReviewOperationModule({
    workspaceId,
    policies: {
      snapshot: REVIEW_SNAPSHOT_ACCESS_POLICY,
      manage: REVIEW_MANAGE_ACCESS_POLICY,
      stepBack: REVIEW_STEP_BACK_ACCESS_POLICY,
      evaluate: REVIEW_EVALUATE_ACCESS_POLICY
    },
    currentAuthority: authority as never,
    currentEvent,
    viewer: {
      resolveViewer: () => Object.freeze({
        kind: 'viewer' as const,
        viewer: Object.freeze({ kind: 'organizer' as const })
      })
    },
    repository,
    sources: repository,
    candidateDisplay: repository,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: REVIEW_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x65)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const changesetModule = createChangesetOperationModule({
    workspaceId,
    policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    currentAuthority: authority as never,
    lifecycleStore: changesetRegistration.lifecycleStore,
    ownerResolution: changesetRegistration.ownerResolution,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x66)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve as never,
    now: () => currentTime
  });
  const wrappedUnitOfWork: EffectUnitOfWorkPort = {
    findTerminalReceipt: (identity) => unitOfWork.findTerminalReceipt(identity),
    recordShortOperationAudit: (record) => unitOfWork.recordShortOperationAudit(record),
    runInUnitOfWork: (work) => unitOfWork.runInUnitOfWork((uow) => work(Object.freeze({
      ...uow,
      acquireExecutionClaim: (identity: EffectOperationIdentity, requestHash: string) =>
        state.contention
          ? { kind: 'contended_same_request' as const }
          : uow.acquireExecutionClaim(identity, requestHash)
    })))
  };
  let receiptId = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([reviewModule, changesetModule]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => currentTime },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork: wrappedUnitOfWork,
    newReceiptId: () => uuid(receiptId++)
  });
  let correlation = 0x900;

  return {
    sqlite,
    repository,
    triage,
    lifecycle: changesetRegistration.lifecycleStore,
    subjectRelationships: changesetRegistration.subjectRelationships,
    close: () => sqlite.close(),
    actAs(actor: Actor) { state.actor = actor; },
    deny(reason: CurrentAuthorityDenialReason | undefined) { state.denyReason = reason; },
    setContention(active: boolean) { state.contention = active; },
    forceNextId(id: string) { forcedChangesetIds.push(id); },
    /** Forces the changeset-lifecycle adapter's next id for one method. */
    forceLifecycleId(
      method: 'newChangesetId' | 'newRevisionId' | 'newCorrectionAttemptId',
      id: string
    ) {
      const queue = forcedLifecycleIds.get(method) ?? [];
      queue.push(id);
      forcedLifecycleIds.set(method, queue);
    },
    advance(milliseconds: number) {
      currentTime = parseInstant(new Date(Date.parse(currentTime) + milliseconds).toISOString());
    },
    /** Seeds an open round through the frozen domain ceremony, not the adapters. */
    seedOpenRound(seed: {
      readonly roundId: string;
      readonly deadlineId: string;
      readonly criterionId: string;
      readonly assignmentId: string;
    }) {
      const candidates = repository.readCandidates(scope);
      const roster = repository.readReviewerRoster(scope);
      if (!candidates || !roster) throw new TypeError('review_fixture_sources_missing');
      const pairs = expectedReviewAssignmentPairs({
        candidates: candidates.candidates,
        reviewers: roster.reviewers
      });
      const plan = planReviewMutation(reviewMutationPlanningInputSchema.parse({
        action: 'open_round',
        scope,
        expectedCatalogVersion: repository.readCatalog(scope)?.version ?? 1,
        roundId: seed.roundId,
        deadlineIdentity: { deadlineId: seed.deadlineId },
        deadlineDate: '2026-08-31',
        criteria: [{
          id: seed.criterionId, key: 'overall', label: 'Overall',
          position: 0, weightBps: 10_000, scaleMin: 1, scaleMax: 5
        }],
        visibility: {
          participantIdentity: 'hidden',
          peerReviewerIdentity: 'hidden',
          peerContentUnlock: 'after_own_commit'
        },
        assignmentIds: pairs.map((pair) => ({ ...pair, assignmentId: seed.assignmentId })),
        attributedByUserId: organizerUserId,
        attributedAt: now
      }), { repository, sources: repository, deadlines: repository });
      if (plan.action !== 'open_round') throw new TypeError('review_fixture_plan_action');
      transaction(sqlite, () => {
        repository.applyReviewDueDeadline(plan.deadlineContribution);
        applyReviewMutationPlan({ plan, transaction: repository, sources: repository });
      });
    },
    seedSavedDraft(assignmentId: string, criterionId: string) {
      transaction(sqlite, () => saveReviewDraft({
        scope,
        reviewerId,
        attributedByUserId: reviewerUserId,
        attributedAt: now,
        businessInput: reviewDraftSaveInputSchema.parse({
          assignmentId,
          expectedDraftVersion: null,
          scores: [{ criterionId, score: 4 }],
          comment: 'Solid.'
        }),
        transaction: repository
      }));
    },
    seedForeignChangeset(changesetId: string, revisionId: string) {
      const bundle = createReviewChangesetBundle();
      const candidates = repository.readCandidates(scope);
      const roster = repository.readReviewerRoster(scope);
      if (!candidates || !roster) throw new TypeError('review_fixture_sources_missing');
      const pairs = expectedReviewAssignmentPairs({
        candidates: candidates.candidates,
        reviewers: roster.reviewers
      });
      transaction(sqlite, () => appendChangesetDraftSynchronous({
        store: changesetRegistration.lifecycleStore,
        registry: bundle.registry,
        snapshot: {
          getPort: <Port>(key: { readonly key: string; readonly version: number }): Port => {
            if ((key as unknown) === reviewChangesetReadPort
                || (key as unknown) === reviewDueDeadlinePlanningPort) {
              return repository as unknown as Port;
            }
            throw new TypeError('review_fixture_unexpected_port');
          }
        },
        ids: {
          newChangesetId: () => changesetId,
          newRevisionId: () => revisionId,
          newApprovalId: () => { throw new TypeError('unused'); },
          newCorrectionAttemptId: () => { throw new TypeError('unused'); }
        },
        context: {
          workspaceId,
          eventId,
          principalKey: `workspace_user:${organizerUserId}`,
          authorityPrincipalKey: 'a'.repeat(64),
          evaluatedAt: now
        },
        operations: [{
          kind: REVIEW_CORE_CHANGESET_KIND,
          version: REVIEW_CORE_CHANGESET_VERSION,
          dependencyGroup: 'review',
          authorInput: reviewMutationPlanningInputSchema.parse({
            action: 'open_round',
            scope,
            expectedCatalogVersion: repository.readCatalog(scope)?.version ?? 1,
            roundId: uuid(0xf01),
            deadlineIdentity: { deadlineId: uuid(0xf02) },
            deadlineDate: '2026-08-31',
            criteria: [{
              id: uuid(0xf03), key: 'overall', label: 'Overall',
              position: 0, weightBps: 10_000, scaleMin: 1, scaleMax: 5
            }],
            visibility: {
              participantIdentity: 'hidden',
              peerReviewerIdentity: 'hidden',
              peerContentUnlock: 'after_own_commit'
            },
            assignmentIds: pairs.map((pair) => ({ ...pair, assignmentId: uuid(0xf04) })),
            attributedByUserId: organizerUserId,
            attributedAt: now
          })
        }],
        dependencyGroups: [{ key: 'review', dependsOn: [] }],
        approvalPolicy: REVIEW_CHANGE_APPROVAL_POLICY,
        origin: 'human_ui'
      }));
    },
    /** Inserts a correction link outside the adapters so an adapter attempt can collide. */
    seedCorrectionLink(seed: {
      readonly sourceChangesetId: string;
      readonly sourceRevisionId: string;
      readonly sourceRevisionDigest: string;
      readonly sourceCommitReceiptId: string;
      readonly correctionAttemptId: string;
    }) {
      const bundle = createReviewChangesetBundle();
      const result = transaction(sqlite, () => draftChangesetCorrectionSynchronous({
        store: changesetRegistration.lifecycleStore,
        registry: bundle.registry,
        snapshot: {
          getPort: <Port>(key: { readonly key: string; readonly version: number }): Port => {
            if ((key as unknown) === reviewChangesetReadPort
                || (key as unknown) === reviewDueDeadlinePlanningPort) {
              return repository as unknown as Port;
            }
            throw new TypeError('review_fixture_unexpected_port');
          }
        },
        ids: {
          newChangesetId: () => { throw new TypeError('unused'); },
          newRevisionId: () => { throw new TypeError('unused'); },
          newApprovalId: () => { throw new TypeError('unused'); },
          newCorrectionAttemptId: () => seed.correctionAttemptId
        },
        context: {
          workspaceId,
          eventId,
          principalKey: `workspace_user:${organizerUserId}`,
          authorityPrincipalKey: 'a'.repeat(64),
          evaluatedAt: now
        },
        sourceChangesetId: seed.sourceChangesetId,
        sourceRevisionId: seed.sourceRevisionId,
        sourceRevisionDigest: seed.sourceRevisionDigest,
        sourceCommitReceiptId: seed.sourceCommitReceiptId,
        approvalPolicy: REVIEW_CHANGE_APPROVAL_POLICY
      }));
      if (!('record' in result) || result.kind !== 'blocked') {
        throw new TypeError(`review_fixture_correction_seed_unexpected:${result.kind}`);
      }
    },
    async effect(input: {
      readonly operation: { readonly name: string; readonly version: number };
      readonly businessInput: unknown;
      readonly key: string;
    }) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: input.operation.name,
        operationVersion: input.operation.version,
        surface: 'operator_http',
        correlationId: uuid(correlation++),
        businessInput: input.businessInput,
        verifiedEvidence: evidence,
        rawIdempotencyKey: input.key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

export function durableCounts(fixture: { readonly sqlite: ReturnType<typeof openSQLite>['sqlite'] }) {
  return {
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    catalogs: count(fixture.sqlite, 'review_catalogs'),
    rounds: count(fixture.sqlite, 'review_rounds'),
    assignments: count(fixture.sqlite, 'review_assignments'),
    drafts: count(fixture.sqlite, 'review_drafts'),
    heads: count(fixture.sqlite, 'review_heads'),
    deadlines: count(fixture.sqlite, 'deadlines'),
    draftLinks: count(fixture.sqlite, 'review_draft_receipt_links'),
    draftTimeline: count(fixture.sqlite, 'review_draft_timeline'),
    changesetHeads: count(fixture.sqlite, 'changeset_heads'),
    changesetRevisions: count(fixture.sqlite, 'changeset_revisions')
  };
}

describe('SQLite Review draft effect domain', () => {
  test('returns the typed current-Event prerequisite without allocating draft state', async () => {
    const fixture = openFixture({ currentEvent: false });
    try {
      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
        key: 'event-required'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'review.event_required' }
      });
      expect(durableCounts(fixture)).toMatchObject({
        receipts: 0, catalogs: 0, rounds: 0, deadlines: 0,
        draftLinks: 0, draftTimeline: 0, changesetHeads: 0, changesetRevisions: 0
      });
    } finally {
      fixture.close();
    }
  });

  test('writes an inert open-round draft that touches neither Review nor Deadline state', async () => {
    const fixture = openFixture();
    try {
      const draft = reviewChangeDraftOperationResultSchema.parse(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
        key: 'inert-open-round'
      }));
      if (draft.kind !== 'success') throw new TypeError('review_draft_failed');
      expect(draft.data).toMatchObject({
        schemaVersion: 1,
        action: 'open_round',
        headVersion: 1,
        status: 'draft',
        revision: { number: 1 },
        riskTier: 'normal',
        approvalPolicy: { requirement: 'none' },
        safeDiff: {
          action: 'open_round',
          assignmentCount: 1,
          reviewerCount: 1,
          submissionCount: 1,
          anonymized: true,
          criterionLabels: ['Overall'],
          deadline: { action: 'create' }
        }
      });
      expect(durableCounts(fixture)).toMatchObject({
        receipts: 1,
        catalogs: 0,
        rounds: 0,
        assignments: 0,
        deadlines: 0,
        draftLinks: 1,
        draftTimeline: 1,
        changesetHeads: 1,
        changesetRevisions: 1
      });
      const link = fixture.sqlite.query<{
        readonly action: string;
        readonly operation_name: string;
        readonly changeset_id: string;
      }, [string]>(`
        SELECT action, operation_name, changeset_id
          FROM review_draft_receipt_links WHERE receipt_id = ?
      `).get(draft.receipt.id);
      expect(link).toMatchObject({
        action: 'open_round',
        operation_name: 'review.round.change.draft',
        changeset_id: draft.data.changesetId
      });
      const record = fixture.lifecycle.read(draft.data.changesetId);
      expect(record?.head).toMatchObject({ status: 'draft', version: 1, eventId });
      const operation = record?.revisions[0]?.revision.operations[0];
      expect(operation).toMatchObject({ kind: 'review.core.mutate', version: 1 });
      expect(operation?.guardRefs.map((guard) => guard.id).sort()).toEqual([
        `deadline_catalog:${eventId}`,
        `review_candidates:${eventId}`,
        `review_catalog:${eventId}`,
        `review_reviewers:${eventId}`
      ]);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses each reachable planning code as the typed review.canonical_changed outcome', async () => {
    const fixture = openFixture();
    try {
      fixture.seedOpenRound({
        roundId: uuid(0xa01), deadlineId: uuid(0xa02),
        criterionId: uuid(0xa03), assignmentId: uuid(0xa04)
      });
      const before = durableCounts(fixture);

      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-09-30' },
        key: 'open-round-exists'
      })).toMatchObject({
        kind: 'outcome', terminal: false,
        outcome: {
          class: 'stale_revision', kind: 'review.canonical_changed',
          detail: { code: 'open_round_exists', action: 'open_round' }
        }
      });

      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'discard_empty_round', roundId: strayId, expectedRoundVersion: 1
        },
        key: 'round-missing'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'round_missing', action: 'discard_empty_round' } }
      });
      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'discard_empty_round', roundId: uuid(0xa01), expectedRoundVersion: 9
        },
        key: 'stale-round'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'stale_round', action: 'discard_empty_round' } }
      });

      fixture.actAs('reviewer');
      expect(await fixture.effect({
        operation: REVIEW_STEP_BACK_DRAFT_OPERATION,
        businessInput: {
          action: 'step_back', assignmentId: strayId, expectedAssignmentVersion: 1
        },
        key: 'assignment-missing'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'assignment_missing', action: 'step_back' } }
      });
      expect(await fixture.effect({
        operation: REVIEW_STEP_BACK_DRAFT_OPERATION,
        businessInput: {
          action: 'step_back', assignmentId: uuid(0xa04), expectedAssignmentVersion: 9
        },
        key: 'stale-assignment'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'stale_assignment', action: 'step_back' } }
      });
      expect(await fixture.effect({
        operation: REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'commit_review', assignmentId: uuid(0xa04),
          expectedAssignmentVersion: 1, expectedDraftVersion: 1
        },
        key: 'draft-missing'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'draft_missing', action: 'commit_review' } }
      });
      fixture.seedSavedDraft(uuid(0xa04), uuid(0xa03));
      expect(await fixture.effect({
        operation: REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'commit_review', assignmentId: uuid(0xa04),
          expectedAssignmentVersion: 1, expectedDraftVersion: 9
        },
        key: 'stale-draft'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'stale_draft', action: 'commit_review' } }
      });
      expect(await fixture.effect({
        operation: REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'amend_review', assignmentId: uuid(0xa04),
          expectedAssignmentVersion: 1, expectedReviewVersion: 1,
          expectedCurrentRevisionId: strayId,
          scores: [{ criterionId: uuid(0xa03), score: 5 }],
          comment: ''
        },
        key: 'review-missing'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'review_missing', action: 'amend_review' } }
      });

      expect(durableCounts(fixture)).toEqual({ ...before, drafts: 1 });
    } finally {
      fixture.close();
    }
  });

  test('refuses no_assignments when the candidate query is empty', async () => {
    const fixture = openFixture();
    try {
      fixture.triage.rows = [];
      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
        key: 'no-assignments'
      })).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'stale_revision', kind: 'review.canonical_changed',
          detail: { code: 'no_assignments', action: 'open_round' }
        }
      });
      expect(durableCounts(fixture)).toMatchObject({
        receipts: 0, changesetHeads: 0, rounds: 0, deadlines: 0
      });
    } finally {
      fixture.close();
    }
  });

  test('returns viewer_required when the actor has no active reviewer binding', async () => {
    const fixture = openFixture();
    try {
      fixture.seedOpenRound({
        roundId: uuid(0xa01), deadlineId: uuid(0xa02),
        criterionId: uuid(0xa03), assignmentId: uuid(0xa04)
      });
      expect(await fixture.effect({
        operation: REVIEW_STEP_BACK_DRAFT_OPERATION,
        businessInput: {
          action: 'step_back', assignmentId: uuid(0xa04), expectedAssignmentVersion: 1
        },
        key: 'organizer-not-reviewer'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'review.viewer_required' }
      });
      expect(count(fixture.sqlite, 'changeset_heads')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test('surfaces every current-authority denial reason on the manage lane without writing', async () => {
    const fixture = openFixture();
    try {
      for (const reason of CURRENT_AUTHORITY_DENIAL_REASONS) {
        fixture.deny(reason);
        expect(await fixture.effect({
          operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
          businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
          key: `denied-${reason}`
        })).toMatchObject({
          kind: 'outcome',
          outcome: { class: 'access_denied', kind: `authority.${reason}` }
        });
      }
      fixture.deny(undefined);
      expect(durableCounts(fixture)).toMatchObject({
        receipts: 0, changesetHeads: 0, draftLinks: 0
      });
    } finally {
      fixture.close();
    }
  });

  test('surfaces a changeset id collision as the typed conflict without partial writes', async () => {
    const fixture = openFixture();
    try {
      fixture.seedForeignChangeset(uuid(0xe01), uuid(0xe02));
      const before = durableCounts(fixture);
      fixture.forceNextId(uuid(0xe01));
      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
        key: 'id-collision'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'changeset.id_collision' }
      });
      expect(durableCounts(fixture)).toEqual(before);
    } finally {
      fixture.close();
    }
  });

  test('surfaces execution-claim contention as operation.in_progress and replays terminally after', async () => {
    const fixture = openFixture();
    try {
      fixture.setContention(true);
      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
        key: 'contended-draft'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true }
      });
      expect(durableCounts(fixture)).toMatchObject({ receipts: 0, changesetHeads: 0 });

      fixture.setContention(false);
      const first = await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
        key: 'contended-draft'
      });
      expect(first).toMatchObject({ kind: 'success' });
      const after = durableCounts(fixture);
      // Response-loss retry: the identical idempotency key replays the receipt.
      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
        key: 'contended-draft'
      })).toEqual(first);
      expect(durableCounts(fixture)).toEqual(after);
    } finally {
      fixture.close();
    }
  });

  test('rolls the whole unit of work back when late draft evidence persistence fails', async () => {
    const fixture = openFixture();
    try {
      const before = durableCounts(fixture);
      fixture.sqlite.exec(`
        CREATE TRIGGER review_draft_fail_timeline
        BEFORE INSERT ON review_draft_timeline
        BEGIN SELECT RAISE(ABORT, 'injected review draft evidence failure'); END;
      `);
      await expect(fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
        key: 'atomic-draft'
      })).rejects.toThrow();
      expect(durableCounts(fixture)).toEqual(before);
      fixture.sqlite.exec('DROP TRIGGER review_draft_fail_timeline;');
      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-08-31' },
        key: 'atomic-draft'
      })).toMatchObject({ kind: 'success' });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
