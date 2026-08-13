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
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import {
  REVIEWER_CAPABILITY_IDS,
  reviewerRosterChangeDraftOperationResultSchema,
  reviewerRosterMutationInputSchema,
  type ReviewerAuthoritySetDto,
  type ReviewerRosterScopeDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import { planEventCreation } from '@jooevents/event';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  type CurrentAuthorityDenialReason
} from '@jooevents/identity-access';
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
  createReviewerRosterChangesetBundle,
  reviewerAuthorityFactDigest,
  reviewerAuthoritySetDigest,
  reviewerRosterChangesetReadPort,
  reviewerScopeTargetSetDigest,
  REVIEWER_ROSTER_CHANGESET_KIND,
  REVIEWER_ROSTER_CHANGESET_VERSION,
  type ReviewerRosterPlanningSource
} from '@jooevents/review/roster';
import {
  REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
  REVIEWER_ROSTER_DRAFT_REQUEST_HASH_PROFILE,
  REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
  createReviewerRosterOperationModule
} from '@jooevents/review-operations/roster';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
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
import { installReviewerRosterSchema, SQLiteReviewerRosterRepository } from './reviewer-roster';
import {
  createSQLiteReviewerRosterChangesetEffectDomainRegistration,
  installReviewerRosterChangesetEffectSchema,
  type SQLiteReviewerRosterChangesetEffectIds
} from './reviewer-roster-changeset-effect-domain';
import {
  createSQLiteReviewerRosterDraftEffectDomainRegistration,
  installReviewerRosterDraftEffectSchema,
  REVIEWER_ROSTER_CHANGE_APPROVAL_POLICY,
  type SQLiteReviewerRosterDraftEffectIds
} from './reviewer-roster-draft-effect-domain';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1dfa-86b5-769b-bba4-5f7097bfa121');
const organizerUserId = parseUserId('019c1dfa-86b5-769b-bba4-5f7097bfa221');
const organizerMembershipId = '019c1dfa-86b5-769b-bba4-5f7097bfa222';
const candidateMembershipId = '019c1dfa-86b5-769b-bba4-5f7097bfa223';
const reviewerId = '019c1dfa-86b5-769b-bba4-5f7097bfa224';
const strayId = '019c1dfa-86b5-769b-bba4-5f7097bfa225';
const scope: ReviewerRosterScopeDto = Object.freeze({ workspaceId, eventId });
const now = parseInstant('2026-08-13T09:00:00.000Z');
const profile = Object.freeze({ key: 'roster-draft-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-roster-draft-session'
});

function uuid(suffix: number): string {
  return `019c1dfa-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
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

/** Mutable lower-owner fact ports so tests can move authority under a proposal. */
class RosterSources implements ReviewerRosterPlanningSource {
  #authorityVersion = 1;

  bumpAuthorityVersion(): void {
    this.#authorityVersion += 1;
  }

  readReviewerAuthority(requested: ReviewerRosterScopeDto): ReviewerAuthoritySetDto | undefined {
    if (requested.workspaceId !== workspaceId || requested.eventId !== eventId) return undefined;
    const factUnsigned = {
      schemaVersion: 1 as const,
      scope,
      rosterSubject: {
        kind: 'workspace_membership' as const, id: candidateMembershipId, version: 1
      },
      currentSubject: {
        kind: 'workspace_membership' as const, id: candidateMembershipId, version: 1
      },
      state: 'active' as const,
      version: 1,
      capabilityIds: [...REVIEWER_CAPABILITY_IDS],
      evidenceIds: [`workspace_membership:${candidateMembershipId}:v1`],
      displayName: 'Reviewer Candidate'
    };
    const fact = {
      ...factUnsigned,
      digestSha256: reviewerAuthorityFactDigest(factUnsigned as never)
    };
    const setUnsigned = {
      schemaVersion: 1 as const, scope, version: this.#authorityVersion, facts: [fact]
    };
    return {
      ...setUnsigned,
      digestSha256: reviewerAuthoritySetDigest(setUnsigned as never)
    } as unknown as ReviewerAuthoritySetDto;
  }

  readReviewerScopeTargets(
    requested: ReviewerRosterScopeDto
  ): ReviewerScopeTargetSetDto | undefined {
    if (requested.workspaceId !== workspaceId || requested.eventId !== eventId) return undefined;
    const unsigned = { schemaVersion: 1 as const, scope, version: 1, targets: [] };
    return {
      ...unsigned,
      digestSha256: reviewerScopeTargetSetDigest(unsigned as never)
    } as unknown as ReviewerScopeTargetSetDto;
  }
}

export function openRosterFixture(options: { readonly currentEvent?: boolean } = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installReviewerRosterSchema(sqlite);
  installReviewerRosterDraftEffectSchema(sqlite);
  installReviewerRosterChangesetEffectSchema(sqlite);

  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Roster workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(organizerUserId, 'Organizer', 1, 1, 1);
  const spine = new SQLiteEventSpineRepository(sqlite);
  transaction(sqlite, () => {
    spine.bootstrapWorkspaceEventSet(workspaceId);
    spine.commitEventCreatePlan(planEventCreation({
      eventSet: spine.requireEventSet(workspaceId),
      authorInput: {
        expectedEventSetVersion: 1,
        name: 'Roster Event',
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

  const sources = new RosterSources();
  const repository = new SQLiteReviewerRosterRepository(sqlite, sources);
  let nextId = 0x100;
  const forcedChangesetIds: string[] = [];
  const next = () => uuid(nextId++);
  const draftIds: SQLiteReviewerRosterDraftEffectIds = {
    newChangesetId: () => forcedChangesetIds.shift() ?? next(),
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next
  };
  const forcedLifecycleIds = new Map<keyof SQLiteReviewerRosterChangesetEffectIds, string[]>();
  const lifecycleId = (method: keyof SQLiteReviewerRosterChangesetEffectIds) => () =>
    forcedLifecycleIds.get(method)?.shift() ?? next();
  const changesetIds: SQLiteReviewerRosterChangesetEffectIds = {
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
  const draftRegistration = createSQLiteReviewerRosterDraftEffectDomainRegistration({
    sqlite, workspaceId, sources, eventRelationships, ids: draftIds
  });
  const changesetRegistration = createSQLiteReviewerRosterChangesetEffectDomainRegistration({
    sqlite, workspaceId, sources, eventRelationships, ids: changesetIds
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    changesetRegistration
  ]);

  let currentTime: Instant = now;
  const state = {
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
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId: organizerUserId }),
          principal: Object.freeze({
            kind: 'workspace_user' as const,
            userId: organizerUserId,
            membershipId: parseApplicationId('membership', organizerMembershipId)
          }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([
            Object.freeze({ kind: 'permission' as const, key: 'event.manage' })
          ]),
          evidenceIds: Object.freeze(['roster-membership.current']),
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
        verifierSha256: createHash('sha256').update(`roster-key:${raw}`).digest('hex')
      });
    }
  };
  const rosterModule = createReviewerRosterOperationModule({
    workspaceId,
    policy: REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
    currentAuthority: authority as never,
    currentEvent: {
      resolveCurrentEvent(requestedWorkspaceId: typeof workspaceId) {
        if (requestedWorkspaceId !== workspaceId) throw new TypeError('roster_workspace_mismatch');
        const current = new SQLiteEventSpineRepository(sqlite).readCurrentEventState(workspaceId);
        if (!current) throw new TypeError('roster_event_set_missing');
        return Object.freeze({
          ...(current.currentEvent ? { eventId: current.currentEvent.id } : {}),
          evidenceIds: Object.freeze([
            `event-spine-set:${workspaceId}@${current.eventSet.version}`
          ])
        });
      }
    },
    rosterRead: { repository, authority: sources },
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: REVIEWER_ROSTER_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x67)
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
      keyBytes: new Uint8Array(32).fill(0x68)
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
    source: composeOperationRegistryModules([rosterModule, changesetModule]),
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
    sources,
    lifecycle: changesetRegistration.lifecycleStore,
    subjectRelationships: changesetRegistration.subjectRelationships,
    close: () => sqlite.close(),
    deny(reason: CurrentAuthorityDenialReason | undefined) { state.denyReason = reason; },
    setContention(active: boolean) { state.contention = active; },
    forceChangesetId(id: string) { forcedChangesetIds.push(id); },
    /** Forces the changeset-lifecycle adapter's next id for one method. */
    forceLifecycleId(
      method: 'newChangesetId' | 'newRevisionId' | 'newCorrectionAttemptId',
      id: string
    ) {
      const queue = forcedLifecycleIds.get(method) ?? [];
      queue.push(id);
      forcedLifecycleIds.set(method, queue);
    },
    roster() {
      const value = repository.readReviewerRoster(scope);
      if (!value) throw new TypeError('roster_fixture_state_missing');
      return value;
    },
    registerInput(overrides: Record<string, unknown> = {}) {
      const roster = repository.readReviewerRoster(scope);
      if (!roster) throw new TypeError('roster_fixture_state_missing');
      return {
        action: 'register',
        reviewerId,
        accessSubject: { kind: 'workspace_membership', id: candidateMembershipId, version: 1 },
        reviews: [],
        expectedRosterVersion: roster.version,
        expectedRosterDigestSha256: roster.digestSha256,
        ...overrides
      };
    },
    seedForeignChangeset(changesetId: string, revisionId: string) {
      const roster = repository.readReviewerRoster(scope);
      if (!roster) throw new TypeError('roster_fixture_state_missing');
      const bundle = createReviewerRosterChangesetBundle();
      transaction(sqlite, () => appendChangesetDraftSynchronous({
        store: changesetRegistration.lifecycleStore,
        registry: bundle.registry,
        snapshot: {
          getPort: <Port>(key: { readonly key: string; readonly version: number }): Port => {
            if ((key as unknown) === reviewerRosterChangesetReadPort) {
              return repository as unknown as Port;
            }
            throw new TypeError('roster_fixture_unexpected_port');
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
          kind: REVIEWER_ROSTER_CHANGESET_KIND,
          version: REVIEWER_ROSTER_CHANGESET_VERSION,
          dependencyGroup: 'reviewer_roster',
          authorInput: {
            request: reviewerRosterMutationInputSchema.parse({
              action: 'register',
              scope,
              reviewerId: uuid(0xf05),
              accessSubject: {
                kind: 'workspace_membership', id: candidateMembershipId, version: 1
              },
              reviews: [],
              expectedRosterVersion: roster.version,
              expectedRosterDigestSha256: roster.digestSha256
            }),
            attribution: { userId: organizerUserId, occurredAt: now }
          }
        }],
        dependencyGroups: [{ key: 'reviewer_roster', dependsOn: [] }],
        approvalPolicy: REVIEWER_ROSTER_CHANGE_APPROVAL_POLICY,
        origin: 'human_ui'
      }));
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

export function rosterCounts(fixture: { readonly sqlite: ReturnType<typeof openSQLite>['sqlite'] }) {
  return {
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    sets: count(fixture.sqlite, 'reviewer_roster_sets'),
    records: count(fixture.sqlite, 'reviewer_roster_records'),
    scopes: count(fixture.sqlite, 'reviewer_roster_scopes'),
    draftLinks: count(fixture.sqlite, 'reviewer_roster_draft_receipt_links'),
    draftTimeline: count(fixture.sqlite, 'reviewer_roster_draft_timeline'),
    lifecycleLinks: count(fixture.sqlite, 'reviewer_roster_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'reviewer_roster_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'reviewer_roster_changeset_outbox_pointers'),
    timeline: count(fixture.sqlite, 'reviewer_roster_changeset_timeline'),
    changesetHeads: count(fixture.sqlite, 'changeset_heads'),
    changesetRevisions: count(fixture.sqlite, 'changeset_revisions')
  };
}

describe('SQLite reviewer-roster draft effect domain', () => {
  test('returns the typed current-Event prerequisite without allocating draft state', async () => {
    const fixture = openRosterFixture({ currentEvent: false });
    try {
      expect(await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'register',
          reviewerId,
          accessSubject: { kind: 'workspace_membership', id: candidateMembershipId, version: 1 },
          reviews: [],
          expectedRosterVersion: 1,
          expectedRosterDigestSha256: 'a'.repeat(64)
        },
        key: 'event-required'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'reviewer_roster.event_required' }
      });
      expect(rosterCounts(fixture)).toMatchObject({
        receipts: 0, changesetHeads: 0, draftLinks: 0, records: 0
      });
    } finally {
      fixture.close();
    }
  });

  test('writes an inert register draft carrying exactly one timeline receipt child', async () => {
    const fixture = openRosterFixture();
    try {
      const before = fixture.roster();
      const draft = reviewerRosterChangeDraftOperationResultSchema.parse(await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: fixture.registerInput(),
        key: 'inert-register'
      }));
      if (draft.kind !== 'success') throw new TypeError('roster_draft_failed');
      expect(draft.data).toMatchObject({ action: 'register', reviewerId });
      expect(fixture.roster()).toEqual(before);
      expect(rosterCounts(fixture)).toMatchObject({
        receipts: 1,
        sets: 0,
        records: 0,
        draftLinks: 1,
        draftTimeline: 1,
        changesetHeads: 1,
        changesetRevisions: 1
      });
      const children = fixture.sqlite.query<{ readonly contribution_json: string }, [string]>(`
        SELECT contribution_json FROM foundation_trial_operation_receipt_children
         WHERE receipt_id = ? ORDER BY ordinal
      `).all(draft.receipt.id);
      expect(children).toHaveLength(1);
      expect(JSON.parse(children[0]!.contribution_json)).toMatchObject({
        kind: 'timeline', sourceKind: 'changeset_revision', changesetId: draft.data.changesetId
      });
      const record = fixture.lifecycle.read(draft.data.changesetId);
      expect(record?.head).toMatchObject({ status: 'draft', version: 1, eventId });
      expect(record?.revisions[0]?.revision.operations[0]).toMatchObject({
        kind: 'reviewer_roster.mutate', version: 1, riskTier: 'consequential'
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses stale roster state and ineligible reviewers as typed reviewer_roster.changed outcomes', async () => {
    const fixture = openRosterFixture();
    try {
      expect(await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: fixture.registerInput({ expectedRosterVersion: 9 }),
        key: 'stale-roster'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'reviewer_roster.changed',
          detail: { code: 'stale_roster', action: 'register', reviewerId }
        }
      });
      expect(await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: fixture.registerInput({
          accessSubject: { kind: 'workspace_membership', id: strayId, version: 1 }
        }),
        key: 'not-eligible'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'reviewer_not_eligible', action: 'register', reviewerId } }
      });
      expect(await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'revoke',
          reviewerId: strayId,
          expectedReviewerVersion: 1,
          expectedRosterVersion: fixture.roster().version,
          expectedRosterDigestSha256: fixture.roster().digestSha256
        },
        key: 'reviewer-missing'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'reviewer_missing', action: 'revoke', reviewerId: strayId } }
      });
      expect(rosterCounts(fixture)).toMatchObject({
        receipts: 0, changesetHeads: 0, draftLinks: 0, records: 0
      });
    } finally {
      fixture.close();
    }
  });

  test('surfaces every current-authority denial reason on the manage lane without writing', async () => {
    const fixture = openRosterFixture();
    try {
      for (const reason of CURRENT_AUTHORITY_DENIAL_REASONS) {
        fixture.deny(reason);
        expect(await fixture.effect({
          operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
          businessInput: fixture.registerInput(),
          key: `denied-${reason}`
        })).toMatchObject({
          kind: 'outcome',
          outcome: { class: 'access_denied', kind: `authority.${reason}` }
        });
      }
      fixture.deny(undefined);
      expect(rosterCounts(fixture)).toMatchObject({
        receipts: 0, changesetHeads: 0, draftLinks: 0
      });
    } finally {
      fixture.close();
    }
  });

  test('surfaces a changeset id collision and claim contention as typed conflicts', async () => {
    const fixture = openRosterFixture();
    try {
      fixture.seedForeignChangeset(uuid(0xe01), uuid(0xe02));
      const before = rosterCounts(fixture);
      fixture.forceChangesetId(uuid(0xe01));
      expect(await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: fixture.registerInput(),
        key: 'id-collision'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'changeset.id_collision' }
      });
      expect(rosterCounts(fixture)).toEqual(before);

      fixture.setContention(true);
      expect(await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: fixture.registerInput(),
        key: 'contended-register'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true }
      });
      fixture.setContention(false);
      expect(rosterCounts(fixture)).toEqual(before);
    } finally {
      fixture.close();
    }
  });

  test('replays the identical draft receipt for the same idempotency key', async () => {
    const fixture = openRosterFixture();
    try {
      const first = await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: fixture.registerInput(),
        key: 'replayed-register'
      });
      expect(first).toMatchObject({ kind: 'success' });
      const after = rosterCounts(fixture);
      expect(await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: fixture.registerInput(),
        key: 'replayed-register'
      })).toEqual(first);
      expect(rosterCounts(fixture)).toEqual(after);
    } finally {
      fixture.close();
    }
  });

  test('rolls the whole unit of work back when late draft evidence persistence fails', async () => {
    const fixture = openRosterFixture();
    try {
      const before = rosterCounts(fixture);
      fixture.sqlite.exec(`
        CREATE TRIGGER roster_draft_fail_timeline
        BEFORE INSERT ON reviewer_roster_draft_timeline
        BEGIN SELECT RAISE(ABORT, 'injected roster draft evidence failure'); END;
      `);
      await expect(fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: fixture.registerInput(),
        key: 'atomic-register'
      })).rejects.toThrow();
      expect(rosterCounts(fixture)).toEqual(before);
      fixture.sqlite.exec('DROP TRIGGER roster_draft_fail_timeline;');
      expect(await fixture.effect({
        operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        businessInput: fixture.registerInput(),
        key: 'atomic-register'
      })).toMatchObject({ kind: 'success' });
    } finally {
      fixture.close();
    }
  });
});
