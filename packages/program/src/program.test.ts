import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { parseOperationReceiptId } from '@jooevents/kernel';
import {
  applyPreparedChangeset,
  createChangeset,
  markChangesetCommitted,
  planChangesetCompensation,
  planChangesetOperation,
  prepareChangesetCommit,
  proposeChangeset,
  validateExactCommit,
  type ApprovalReceipt,
  type ChangesetCommitTransaction,
  type ChangesetPlanningSnapshot,
  type FrozenChangesetOperation
} from '@jooevents/changesets';
import type {
  ProgramVocabularyChangeResult,
  ProgramVocabularyDraftInput,
  ProgramVocabularyScopeDto
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import {
  activeProgramVocabularyItems,
  applyProgramReferenceRepoints,
  applyProgramVocabularyPlan,
  assertCompleteProgramReferenceSnapshot,
  assertProgramReferenceContributorRegistry,
  assertProgramVocabularyOrdinaryChangesetBundle,
  assertProgramVocabularyOrdinaryPolicy,
  captureProgramVocabularyOrdinaryApprovalPolicy,
  captureRegisteredProgramReferences,
  createProgramReferenceContributorRegistry,
  createProgramVocabularyOrdinaryChangesetBundle,
  createProgramVocabularyValidationView,
  createProgramVocabularyChangesetBundle,
  createProgramVocabularyState,
  mergeReferenceCounts,
  issueProgramVocabularyOrdinaryPolicy,
  parseProgramVocabularyOrdinaryAuthorInput,
  parseProgramVocabularyMutationPlan,
  parseProgramVocabularyItem,
  parseProgramVocabularyState,
  planProgramVocabularyMutation,
  programVocabularyTransactionPort,
  programVocabularyValidationPort,
  programReferenceUsage,
  projectProgramVocabularySnapshot,
  requireActiveProgramVocabularyAssignment,
  resolveProgramVocabularyItem,
  validateProgramVocabularyPlan,
  type CompleteProgramReferenceSnapshot,
  type ProgramReferenceContributorRef,
  type ProgramReferenceContributorSnapshot,
  type ProgramReferenceSnapshotSource,
  type ProgramVocabularyChangesetBundle,
  type ProgramVocabularyOrdinaryChangesetBundle,
  type ProgramVocabularyOrdinaryPolicy,
  type ProgramVocabularyMutationPlan,
  type ProgramVocabularyState,
  ProgramReferenceRegistryValidationError,
  ProgramReferenceSnapshotError,
  ProgramVocabularyPlanningError
} from '.';

const workspaceId = '018f7d5a-4b3c-7abc-8def-0123456789a1';
const eventId = '018f7d5a-4b3c-7abc-8def-0123456789a2';
const otherEventId = '018f7d5a-4b3c-7abc-8def-0123456789a3';
const roomId = '018f7d5a-4b3c-7abc-8def-0123456789b1';
const trackSourceId = '018f7d5a-4b3c-7abc-8def-0123456789b2';
const trackTargetId = '018f7d5a-4b3c-7abc-8def-0123456789b3';
const formatId = '018f7d5a-4b3c-7abc-8def-0123456789b4';
const newRoomId = '018f7d5a-4b3c-7abc-8def-0123456789b5';
const scope = { workspaceId, eventId };
const contributor = { key: 'test.schedule_references', version: 1 } as const;

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function registry() {
  return createProgramReferenceContributorRegistry({
    expected: [contributor],
    contributors: [contributor]
  });
}

function state(input?: {
  readonly setVersion?: number;
  readonly roomStatus?: 'active' | 'retired';
  readonly trackSourceStatus?: 'active' | 'retired';
  readonly includeRoom?: boolean;
  readonly includeSourceTrack?: boolean;
  readonly includeTargetTrack?: boolean;
  readonly includeFormat?: boolean;
}): ProgramVocabularyState {
  return createProgramVocabularyState({
    scope,
    setVersion: input?.setVersion ?? 1,
    rooms: input?.includeRoom === false ? [] : [{
      id: roomId,
      name: 'Main hall',
      capacity: 300,
      status: input?.roomStatus ?? 'active',
      version: 1
    }],
    tracks: [
      ...(input?.includeSourceTrack === false ? [] : [{
        id: trackSourceId,
        name: 'Leadership',
        status: input?.trackSourceStatus ?? 'active' as const,
        version: 1
      }]),
      ...(input?.includeTargetTrack === false ? [] : [{
        id: trackTargetId,
        name: 'People and culture',
        status: 'active' as const,
        version: 1
      }])
    ],
    formats: input?.includeFormat === false ? [] : [{
      id: formatId,
      name: 'Talk',
      status: 'active',
      version: 1
    }]
  });
}

function referenceSnapshot(input?: {
  readonly sourceCurrent?: number;
  readonly sourceHistorical?: number;
  readonly includePrivateField?: boolean;
}): unknown {
  const references: Record<string, unknown>[] = [];
  for (let index = 0; index < (input?.sourceCurrent ?? 0); index += 1) {
    references.push({
      referenceKey: `current-${index + 1}`,
      version: 1,
      item: { kind: 'track', id: trackSourceId },
      mode: 'current',
      destination: { kind: 'schedule_session', id: `session-${index + 1}` }
    });
  }
  for (let index = 0; index < (input?.sourceHistorical ?? 0); index += 1) {
    references.push({
      referenceKey: `historical-${index + 1}`,
      version: 1,
      item: { kind: 'track', id: trackSourceId },
      mode: 'historical',
      destination: { kind: 'published_session', id: `release-session-${index + 1}` }
    });
  }
  return {
    contributor,
    scope,
    guard: { id: 'program_reference:test_schedule', version: 1, digest: digest(references) },
    references,
    ...(input?.includePrivateField ? { privateSubmissionTitle: 'classified title' } : {})
  };
}

class TrialStore implements ProgramReferenceSnapshotSource {
  state: ProgramVocabularyState;
  contributorAvailable = true;
  contributorSnapshot: unknown;
  writes = 0;

  constructor(initialState: ProgramVocabularyState, references: unknown = referenceSnapshot()) {
    this.state = initialState;
    this.contributorSnapshot = references;
  }

  readVocabulary(requestedScope: ProgramVocabularyScopeDto): ProgramVocabularyState | undefined {
    return requestedScope.workspaceId === this.state.scope.workspaceId
      && requestedScope.eventId === this.state.scope.eventId
      ? this.state
      : undefined;
  }

  readContributor(requested: ProgramReferenceContributorRef): unknown {
    if (!this.contributorAvailable || requested.key !== contributor.key || requested.version !== contributor.version) {
      return undefined;
    }
    return this.contributorSnapshot;
  }

  completeReferences(referenceRegistry = registry()): CompleteProgramReferenceSnapshot {
    return referenceRegistry.capture(this.state.scope, this);
  }

  applyVocabularyPlan(plan: ProgramVocabularyMutationPlan): ProgramVocabularyChangeResult {
    let liveRepoints = 0;
    if (plan.action === 'merge' || plan.action === 'merge_compensation') {
      const current = this.completeReferences();
      const next = applyProgramReferenceRepoints(current, plan);
      this.contributorSnapshot = next.contributors[0];
      liveRepoints = mergeReferenceCounts(plan).liveRepoints;
    }
    this.state = applyProgramVocabularyPlan(this.state, plan);
    this.writes += 1;
    const affected = plan.action === 'create'
      ? { kind: plan.after.kind, ids: [plan.after.id] }
      : plan.action === 'merge' || plan.action === 'merge_compensation'
        ? { kind: plan.sourceBefore.kind, ids: [plan.sourceBefore.id, plan.target.id] }
        : { kind: plan.before.kind, ids: [plan.before.id] };
    return {
      action: plan.action,
      kind: affected.kind,
      affectedIds: affected.ids,
      setVersion: this.state.setVersion,
      liveRepoints
    };
  }

  changeReference(referenceKey: string, itemId: string): void {
    const current = this.completeReferences().contributors[0];
    if (!current) throw new TypeError('test_contributor_missing');
    const references = current.references.map((reference) => reference.referenceKey === referenceKey
      ? { ...reference, version: reference.version + 1, item: { ...reference.item, id: itemId } }
      : reference);
    this.contributorSnapshot = {
      ...current,
      guard: {
        ...current.guard,
        version: current.guard.version + 1,
        digest: digest(references)
      },
      references
    };
  }

  touchReferenceGuard(): void {
    const current = this.completeReferences().contributors[0];
    if (!current) throw new TypeError('test_contributor_missing');
    this.contributorSnapshot = {
      ...current,
      guard: {
        ...current.guard,
        version: current.guard.version + 1,
        digest: digest({ prior: current.guard.digest, touched: true })
      }
    };
  }
}

function bundle(referenceRegistry = registry()): ProgramVocabularyChangesetBundle {
  return createProgramVocabularyChangesetBundle({
    referenceRegistry,
    policy: {
      activation: 'test_only',
      key: 'program_vocabulary.trial_policy',
      version: 1,
      ordinaryRisk: 'low',
      mergeRisk: 'consequential'
    }
  });
}

function ordinaryPolicy(input?: {
  readonly ordinaryRisk?: 'low' | 'normal';
  readonly mergeRisk?: 'normal' | 'consequential';
  readonly ordinaryApproval?: 'none' | 'distinct_current_human';
  readonly mergeApproval?: 'none' | 'distinct_current_human';
}): ProgramVocabularyOrdinaryPolicy {
  return issueProgramVocabularyOrdinaryPolicy({
    key: 'program_vocabulary.bounded',
    version: 1,
    ordinaryRisk: input?.ordinaryRisk ?? 'low',
    mergeRisk: input?.mergeRisk ?? 'consequential',
    approval: {
      ordinary: input?.ordinaryApproval ?? 'none',
      merge: input?.mergeApproval ?? 'none'
    }
  });
}

function ordinaryBundle(
  policy = ordinaryPolicy(),
  referenceRegistry = registry()
): ProgramVocabularyOrdinaryChangesetBundle {
  return createProgramVocabularyOrdinaryChangesetBundle({ policy, referenceRegistry });
}

function planningSnapshot(store: TrialStore): ChangesetPlanningSnapshot {
  return { getPort: <Port>() => store as unknown as Port };
}

function transaction(store: TrialStore): ChangesetCommitTransaction {
  const validationView = createProgramVocabularyValidationView(store);
  return Object.freeze({
    getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
      if (key === programVocabularyValidationPort) return validationView as unknown as Port;
      if (key === programVocabularyTransactionPort) return store as unknown as Port;
      throw new TypeError('undeclared_program_vocabulary_test_transaction_port');
    }
  }) as ChangesetCommitTransaction;
}

async function plan(
  changesets: ProgramVocabularyChangesetBundle,
  store: TrialStore,
  authorInput: ProgramVocabularyDraftInput
): Promise<FrozenChangesetOperation> {
  return planChangesetOperation({
    registry: changesets.registry,
    kind: 'program.vocabulary.mutate',
    version: 1,
    authorInput,
    dependencyGroup: 'program_vocabulary',
    snapshot: planningSnapshot(store)
  });
}

async function planOrdinary(
  changesets: ProgramVocabularyOrdinaryChangesetBundle,
  store: TrialStore,
  authorInput: ProgramVocabularyDraftInput
): Promise<FrozenChangesetOperation> {
  return planChangesetOperation({
    registry: changesets.registry,
    kind: 'program.vocabulary.mutate',
    version: 1,
    authorInput,
    dependencyGroup: 'program_vocabulary',
    snapshot: planningSnapshot(store)
  });
}

let commitSequence = 0;

function authorize(operations: readonly FrozenChangesetOperation[]) {
  commitSequence += 1;
  const created = createChangeset(
    { id: `program-commit-${commitSequence}`, workspaceId, eventId },
    {
      id: `program-commit-revision-${commitSequence}`,
      createdAt: '2026-08-11T04:00:00.000Z',
      proposerPrincipalKey: 'principal:test-author',
      origin: 'human_ui',
      operations,
      dependencyGroups: [{ key: 'program_vocabulary', dependsOn: [] }],
      approvalPolicy: { key: 'program_vocabulary.trial_policy', version: 1 }
    }
  );
  const proposed = proposeChangeset(created, created.version);
  const revision = proposed.revisions.at(-1);
  if (!revision) throw new TypeError('test_revision_missing');
  const approval: ApprovalReceipt = {
    id: `program-approval-${commitSequence}`,
    revisionId: revision.id,
    revisionDigest: revision.digest,
    policy: revision.approvalPolicy,
    scopeKey: `workspace:${workspaceId}/event:${eventId}`,
    approverPrincipalKey: 'principal:test-approver',
    issuedAt: '2026-08-11T04:01:00.000Z',
    expiresAt: '2026-08-12T04:01:00.000Z'
  };
  const validation = validateExactCommit(proposed, {
    expectedHeadVersion: proposed.version,
    expectedRevisionDigest: revision.digest,
    currentAggregateVersions: new Map(operations.flatMap((operation) =>
      operation.aggregateRefs.map((reference) => [reference.id, reference.version] as const)
    )),
    currentGuardDigests: new Map(operations.flatMap((operation) =>
      operation.guardRefs.map((reference) => [reference.id, reference.digest] as const)
    )),
    currentGuardVersions: new Map(operations.flatMap((operation) =>
      operation.guardRefs.map((reference) => [reference.id, reference.version] as const)
    )),
    now: '2026-08-11T04:02:00.000Z',
    approvalRequirement: revision.riskTier === 'consequential' ? 'distinct_current_human' : 'none',
    ...(revision.riskTier === 'consequential'
      ? { approval, approverCurrentlyAuthorized: true }
      : {})
  });
  if (validation.kind !== 'ready') throw new TypeError(`unexpected_commit_refusal:${validation.refusal.kind}`);
  return { authorization: validation.authorization, head: proposed };
}

async function apply(
  changesets: ProgramVocabularyChangesetBundle,
  store: TrialStore,
  operation: FrozenChangesetOperation
) {
  const validated = authorize([operation]);
  const prepared = await prepareChangesetCommit({
    registry: changesets.registry,
    authorization: validated.authorization,
    transaction: transaction(store)
  });
  if (prepared.kind !== 'ready') return prepared;
  const contributions = await applyPreparedChangeset(prepared.prepared);
  const committed = markChangesetCommitted(
    validated.head,
    validated.authorization,
    parseOperationReceiptId(`00000000-0000-4000-8001-${String(commitSequence).padStart(12, '0')}`)
  );
  return {
    kind: 'applied' as const,
    contributions,
    committedHead: committed.head,
    committedSource: committed.source
  };
}

describe('Program Vocabulary ordinary changeset policy', () => {
  test('only module-issued immutable policies and bundles activate the ordinary registry', () => {
    const policy = ordinaryPolicy();
    const changesets = ordinaryBundle(policy);

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.approval)).toBe(true);
    expect(Object.isFrozen(changesets)).toBe(true);
    expect(() => assertProgramVocabularyOrdinaryPolicy(policy)).not.toThrow();
    expect(() => assertProgramVocabularyOrdinaryChangesetBundle(changesets)).not.toThrow();

    const copiedPolicy = structuredClone(policy) as ProgramVocabularyOrdinaryPolicy;
    expect(() => assertProgramVocabularyOrdinaryPolicy(copiedPolicy))
      .toThrow('invalid_program_vocabulary_ordinary_policy');
    expect(() => ordinaryBundle(copiedPolicy))
      .toThrow('invalid_program_vocabulary_ordinary_policy');
    expect(() => assertProgramVocabularyOrdinaryChangesetBundle({
      ...changesets
    } as ProgramVocabularyOrdinaryChangesetBundle))
      .toThrow('invalid_program_vocabulary_ordinary_bundle');
    expect(() => createProgramVocabularyOrdinaryChangesetBundle({
      referenceRegistry: registry(),
      policy: {
        activation: 'test_only'
      } as unknown as ProgramVocabularyOrdinaryPolicy
    })).toThrow('invalid_program_vocabulary_ordinary_policy');
  });

  test('plans exactly the six ordinary author actions through the authenticated bundle', async () => {
    const changesets = ordinaryBundle();
    const cases: readonly {
      readonly store: TrialStore;
      readonly input: ProgramVocabularyDraftInput;
      readonly risk: 'low' | 'normal' | 'consequential';
    }[] = [{
      store: new TrialStore(state({ includeRoom: false })),
      input: {
        action: 'create', scope, expectedSetVersion: 1,
        item: { kind: 'room', id: newRoomId, name: 'Breakout room', capacity: 40 }
      },
      risk: 'low'
    }, {
      store: new TrialStore(state()),
      input: {
        action: 'edit', scope, kind: 'room', id: roomId,
        expectedSetVersion: 1, expectedItemVersion: 1,
        changes: { name: 'Main auditorium', capacity: 320 }
      },
      risk: 'low'
    }, {
      store: new TrialStore(state()),
      input: {
        action: 'retire', scope, kind: 'room', id: roomId,
        expectedSetVersion: 1, expectedItemVersion: 1
      },
      risk: 'low'
    }, {
      store: new TrialStore(state({ roomStatus: 'retired' })),
      input: {
        action: 'restore', scope, kind: 'room', id: roomId,
        expectedSetVersion: 1, expectedItemVersion: 1
      },
      risk: 'low'
    }, {
      store: new TrialStore(state()),
      input: {
        action: 'delete', scope, kind: 'format', id: formatId,
        expectedSetVersion: 1, expectedItemVersion: 1
      },
      risk: 'normal'
    }, {
      store: new TrialStore(state()),
      input: {
        action: 'merge', scope, kind: 'track', sourceId: trackSourceId,
        targetId: trackTargetId, expectedSetVersion: 1,
        expectedSourceVersion: 1, expectedTargetVersion: 1
      },
      risk: 'consequential'
    }];

    for (const entry of cases) {
      const planned = await planOrdinary(changesets, entry.store, entry.input);
      expect(planned.safeDiff).toMatchObject({ action: entry.input.action });
      expect(planned.riskTier).toBe(entry.risk);
      expect(planned.plan).toMatchObject({
        policy: {
          activation: 'ordinary',
          key: changesets.policy.key,
          version: changesets.policy.version,
          definitionDigestSha256: changesets.policy.definitionDigestSha256
        },
        mutation: { action: entry.input.action }
      });
    }
  });

  test('captures approval threshold independently from risk tier', async () => {
    const highRiskSelfConfirmation = ordinaryPolicy({
      mergeRisk: 'consequential',
      mergeApproval: 'none'
    });
    const lowerRiskDistinctApproval = ordinaryPolicy({
      ordinaryRisk: 'normal',
      mergeRisk: 'normal',
      ordinaryApproval: 'none',
      mergeApproval: 'distinct_current_human'
    });

    expect(captureProgramVocabularyOrdinaryApprovalPolicy({
      policy: highRiskSelfConfirmation,
      action: 'merge'
    })).toMatchObject({ requirement: 'none' });
    expect(captureProgramVocabularyOrdinaryApprovalPolicy({
      policy: lowerRiskDistinctApproval,
      action: 'merge'
    })).toMatchObject({ requirement: 'distinct_current_human' });
    expect(captureProgramVocabularyOrdinaryApprovalPolicy({
      policy: lowerRiskDistinctApproval,
      action: 'edit'
    })).toMatchObject({ requirement: 'none' });

    const highRiskPlan = await planOrdinary(
      ordinaryBundle(highRiskSelfConfirmation),
      new TrialStore(state()),
      {
        action: 'merge', scope, kind: 'track', sourceId: trackSourceId,
        targetId: trackTargetId, expectedSetVersion: 1,
        expectedSourceVersion: 1, expectedTargetVersion: 1
      }
    );
    const lowerRiskPlan = await planOrdinary(
      ordinaryBundle(lowerRiskDistinctApproval),
      new TrialStore(state()),
      {
        action: 'merge', scope, kind: 'track', sourceId: trackSourceId,
        targetId: trackTargetId, expectedSetVersion: 1,
        expectedSourceVersion: 1, expectedTargetVersion: 1
      }
    );
    expect(highRiskPlan.riskTier).toBe('consequential');
    expect(lowerRiskPlan.riskTier).toBe('normal');
  });

  test('ordinary author parsing cannot manufacture merge compensation', () => {
    const changesets = ordinaryBundle();
    const store = new TrialStore(state());
    const forgedCompensation = {
      action: 'merge_compensation', scope, kind: 'track',
      sourceId: trackSourceId, targetId: trackTargetId,
      expectedSetVersion: 1, expectedSourceVersion: 1,
      expectedTargetVersion: 1, restoreSource: true, references: []
    };
    expect(parseProgramVocabularyOrdinaryAuthorInput({
      action: 'merge', scope, kind: 'track', sourceId: trackSourceId,
      targetId: trackTargetId, expectedSetVersion: 1,
      expectedSourceVersion: 1, expectedTargetVersion: 1
    })).toMatchObject({ action: 'merge' });
    expect(() => parseProgramVocabularyOrdinaryAuthorInput(forgedCompensation)).toThrow();
    expect(() => planProgramVocabularyMutation({
      authorInput: parseProgramVocabularyOrdinaryAuthorInput(forgedCompensation),
      state: store.state,
      referenceRegistry: registry(),
      referenceSource: store
    })).toThrow();
    expect(() => createProgramVocabularyChangesetBundle({
      referenceRegistry: registry(),
      policy: ordinaryPolicy() as unknown as {
        readonly activation: 'test_only';
        readonly key: string;
        readonly version: number;
        readonly ordinaryRisk: 'low';
        readonly mergeRisk: 'consequential';
      }
    })).toThrow('program_vocabulary_trial_policy_required');
    expect(changesets.policy.activation).toBe('ordinary');
  });
});

describe('Program Vocabulary domain', () => {
  test('the validation view exposes only reads while sharing the transaction-owned store', () => {
    const store = new TrialStore(state());
    const view = createProgramVocabularyValidationView(store);
    expect(view.readVocabulary(scope)).toBe(store.state);
    expect(Object.isFrozen(view)).toBe(true);
    expect(view).not.toHaveProperty('applyVocabularyPlan');
  });

  test('new assignment is active-only while retired current and historical resolution stays available', () => {
    const initial = state({ trackSourceStatus: 'retired' });
    const store = new TrialStore(initial, referenceSnapshot({ sourceCurrent: 1, sourceHistorical: 2 }));
    const references = store.completeReferences();
    const projection = projectProgramVocabularySnapshot(initial, references);

    expect(activeProgramVocabularyItems(initial, 'track').map((item) => String(item.id))).toEqual([trackTargetId]);
    expect(resolveProgramVocabularyItem(initial, 'track', trackSourceId)?.status).toBe('retired');
    expect(() => requireActiveProgramVocabularyAssignment(initial, 'track', trackSourceId))
      .toThrow('program_vocabulary_item_retired');
    expect(projection.tracks.find((item) => item.id === trackSourceId)).toMatchObject({
      status: 'retired',
      usage: { current: 1, historicalPins: 2 },
      deleteEligibility: { kind: 'blocked', currentReferences: 1, historicalPins: 2 }
    });
  });

  test('create, edit, retire, and restore are exact item/set-guarded changesets', async () => {
    const changesets = bundle();
    const store = new TrialStore(state({ includeRoom: false }));
    const created = await plan(changesets, store, {
      action: 'create', scope, expectedSetVersion: 1,
      item: { kind: 'room', id: newRoomId, name: '  Breakout   room  ', capacity: 40 }
    });
    expect(created.safeDiff).toMatchObject({ action: 'create', after: { name: 'Breakout room', version: 1 } });
    expect(await apply(changesets, store, created)).toMatchObject({ kind: 'applied' });

    const edited = await plan(changesets, store, {
      action: 'edit', scope, kind: 'room', id: newRoomId,
      expectedSetVersion: 2, expectedItemVersion: 1,
      changes: { name: 'Workshop room', capacity: 55 }
    });
    expect(await apply(changesets, store, edited)).toMatchObject({ kind: 'applied' });
    const retired = await plan(changesets, store, {
      action: 'retire', scope, kind: 'room', id: newRoomId,
      expectedSetVersion: 3, expectedItemVersion: 2
    });
    expect(await apply(changesets, store, retired)).toMatchObject({ kind: 'applied' });
    const restored = await plan(changesets, store, {
      action: 'restore', scope, kind: 'room', id: newRoomId,
      expectedSetVersion: 4, expectedItemVersion: 3
    });
    expect(await apply(changesets, store, restored)).toMatchObject({ kind: 'applied' });
    expect(resolveProgramVocabularyItem(store.state, 'room', newRoomId)).toMatchObject({
      name: 'Workshop room', capacity: 55, status: 'active', version: 4
    });
    expect(Number(store.state.setVersion)).toBe(5);

    await expect(plan(changesets, store, {
      action: 'edit', scope, kind: 'room', id: newRoomId,
      expectedSetVersion: 4, expectedItemVersion: 4,
      changes: { name: 'Stale edit', capacity: 55 }
    })).rejects.toMatchObject({ code: 'stale_set' });
    await expect(plan(changesets, store, {
      action: 'edit', scope: { ...scope, eventId: otherEventId }, kind: 'room', id: newRoomId,
      expectedSetVersion: 5, expectedItemVersion: 4,
      changes: { name: 'Cross event', capacity: 55 }
    })).rejects.toThrow('program_vocabulary_scope_missing');
  });

  test('hard delete is available only with zero current and historical use', async () => {
    const changesets = bundle();
    const store = new TrialStore(state(), referenceSnapshot({ sourceHistorical: 1 }));
    await expect(plan(changesets, store, {
      action: 'delete', scope, kind: 'track', id: trackSourceId,
      expectedSetVersion: 1, expectedItemVersion: 1
    })).rejects.toMatchObject({ code: 'delete_referenced' });

    const deletion = await plan(changesets, store, {
      action: 'delete', scope, kind: 'format', id: formatId,
      expectedSetVersion: 1, expectedItemVersion: 1
    });
    expect(deletion.safeDiff).toMatchObject({
      action: 'delete', usage: { current: 0, historicalPins: 0 }
    });
    expect(await apply(changesets, store, deletion)).toMatchObject({ kind: 'applied' });
    expect(resolveProgramVocabularyItem(store.state, 'format', formatId)).toBeUndefined();
  });
});

describe('Program Vocabulary reference registry and merge', () => {
  test('the contributor set is complete and version-exact before any reference answer is trusted', () => {
    expect(() => createProgramReferenceContributorRegistry({
      expected: [contributor],
      contributors: []
    })).toThrow(ProgramReferenceRegistryValidationError);
    expect(() => createProgramReferenceContributorRegistry({
      expected: [contributor],
      contributors: [{ ...contributor, version: 2 }]
    })).toThrow(ProgramReferenceRegistryValidationError);

    const formsContributor = { key: 'test.form_references', version: 2 } as const;
    const first = createProgramReferenceContributorRegistry({
      expected: [contributor, formsContributor],
      contributors: [formsContributor, contributor]
    });
    const second = createProgramReferenceContributorRegistry({
      expected: [formsContributor, contributor],
      contributors: [contributor, formsContributor]
    });
    expect(first.registryDigestSha256).toBe(second.registryDigestSha256);
    expect(first.contributors).toEqual([formsContributor, contributor]);

    const store = new TrialStore(state());
    store.contributorAvailable = false;
    expect(() => registry().capture(store.state.scope, store)).toThrow(ProgramReferenceSnapshotError);
  });

  test('merge repoints every live reference, preserves historical pins, and emits a deterministic privacy-safe diff', async () => {
    const changesets = bundle();
    const store = new TrialStore(state(), referenceSnapshot({ sourceCurrent: 2, sourceHistorical: 1 }));
    const operation = await plan(changesets, store, {
      action: 'merge', scope, kind: 'track', sourceId: trackSourceId, targetId: trackTargetId,
      expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
    });
    expect(operation.riskTier).toBe('consequential');
    expect(operation.safeDiff).toMatchObject({
      action: 'merge', liveRepoints: 2, historicalPinsPreserved: 1
    });
    const serializedDiff = JSON.stringify(operation.safeDiff);
    expect(serializedDiff).not.toContain('current-1');
    expect(serializedDiff).not.toContain('session-1');
    expect(serializedDiff).not.toContain(contributor.key);

    const applied = await apply(changesets, store, operation);
    expect(applied).toMatchObject({ kind: 'applied' });
    expect(resolveProgramVocabularyItem(store.state, 'track', trackSourceId)).toMatchObject({
      status: 'retired', version: 2
    });
    const references = store.completeReferences();
    expect(references.contributors[0]?.references.map((reference) => ({
      key: reference.referenceKey,
      mode: reference.mode,
      itemId: String(reference.item.id),
      version: Number(reference.version)
    }))).toEqual([
      { key: 'current-1', mode: 'current', itemId: trackTargetId, version: 2 },
      { key: 'current-2', mode: 'current', itemId: trackTargetId, version: 2 },
      { key: 'historical-1', mode: 'historical', itemId: trackSourceId, version: 1 }
    ]);
    expect(programReferenceUsage(references, { kind: 'track', id: trackSourceId })).toEqual({
      current: 0, historicalPins: 1
    });
  });

  test('a contributor guard change makes merge stale before the first write', async () => {
    const changesets = bundle();
    const store = new TrialStore(state(), referenceSnapshot({ sourceCurrent: 1 }));
    const operation = await plan(changesets, store, {
      action: 'merge', scope, kind: 'track', sourceId: trackSourceId, targetId: trackTargetId,
      expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
    });
    store.touchReferenceGuard();
    const prepared = await prepareChangesetCommit({
      registry: changesets.registry,
      authorization: authorize([operation]).authorization,
      transaction: transaction(store)
    });
    expect(prepared).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'stale_revision', detail: { code: 'stale_reference' } }
    });
    expect(store.writes).toBe(0);
    expect(resolveProgramVocabularyItem(store.state, 'track', trackSourceId)?.status).toBe('active');
  });

  test('strict contributor snapshots reject private or undeclared fields', () => {
    const store = new TrialStore(state(), referenceSnapshot({ includePrivateField: true }));
    expect(() => registry().capture(store.state.scope, store)).toThrow(ProgramReferenceSnapshotError);
  });
});

describe('Program Vocabulary compensation', () => {
  test('merge compensation carries source lineage, restores attributable work, and leaves later reference edits intact', async () => {
    const changesets = bundle();
    const store = new TrialStore(state(), referenceSnapshot({ sourceCurrent: 2, sourceHistorical: 1 }));
    const merge = await plan(changesets, store, {
      action: 'merge', scope, kind: 'track', sourceId: trackSourceId, targetId: trackTargetId,
      expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
    });
    const mergeApplied = await apply(changesets, store, merge);
    expect(mergeApplied).toMatchObject({ kind: 'applied' });
    if (mergeApplied.kind !== 'applied') throw new TypeError('expected_applied_merge');
    const source = mergeApplied.committedSource;
    store.changeReference('current-2', trackTargetId);

    const compensation = await planChangesetCompensation({
      registry: changesets.registry,
      source,
      snapshot: planningSnapshot(store)
    });
    expect(compensation.kind).toBe('partial');
    if (compensation.kind !== 'partial') throw new TypeError('expected_partial_compensation');
    expect(compensation.conflicts).toMatchObject([{
      conflictKeys: ['program.merge_reference_changed']
    }]);
    expect(compensation.draft.operations[0]?.compensationLineage).toMatchObject({
      sourceRevisionId: source.revisionId,
      sourceRevisionDigest: source.revisionDigest,
      sourceOperationIndex: 0,
      sourceOperationKind: 'program.vocabulary.mutate'
    });
    expect(compensation.draft.operations[0]?.safeDiff).toMatchObject({
      action: 'merge_compensation',
      liveRepoints: 1,
      historicalPinsPreserved: 1
    });

    const prepared = await prepareChangesetCommit({
      registry: changesets.registry,
      authorization: authorize(compensation.draft.operations).authorization,
      transaction: transaction(store)
    });
    if (prepared.kind !== 'ready') throw new TypeError('unexpected_compensation_stale');
    await applyPreparedChangeset(prepared.prepared);
    expect(resolveProgramVocabularyItem(store.state, 'track', trackSourceId)?.status).toBe('active');
    const references = store.completeReferences().contributors[0]?.references;
    expect(references?.find((reference) => reference.referenceKey === 'current-1')?.item.id).toBe(trackSourceId);
    expect(references?.find((reference) => reference.referenceKey === 'current-2')).toMatchObject({
      item: { id: trackTargetId },
      version: 3
    });
    expect(references?.find((reference) => reference.referenceKey === 'historical-1')).toMatchObject({
      mode: 'historical',
      item: { id: trackSourceId },
      version: 1
    });
  });
});

describe('Program Vocabulary canonical evidence', () => {
  test('strict state parsing refuses storage bytes that would need repair', () => {
    const canonical = {
      scope,
      setVersion: 1,
      rooms: [{
        id: roomId,
        name: 'Main hall',
        capacity: 300,
        status: 'active' as const,
        version: 1
      }],
      tracks: [
        { id: trackSourceId, name: 'Leadership', status: 'active' as const, version: 1 },
        { id: trackTargetId, name: 'People and culture', status: 'active' as const, version: 1 }
      ],
      formats: [{ id: formatId, name: 'Talk', status: 'active' as const, version: 1 }]
    };
    expect(parseProgramVocabularyState(canonical)).toEqual(state());
    expect(() => parseProgramVocabularyState({
      ...canonical,
      rooms: [{ ...canonical.rooms[0]!, name: ' Main   hall ' }]
    })).toThrow('invalid_canonical_program_vocabulary_state');
    expect(() => parseProgramVocabularyState({
      ...canonical,
      rooms: [{ ...canonical.rooms[0]!, id: roomId.toUpperCase() }]
    })).toThrow('invalid_canonical_program_vocabulary_state');
    expect(() => parseProgramVocabularyState({
      ...canonical,
      tracks: [...canonical.tracks].reverse()
    })).toThrow('invalid_canonical_program_vocabulary_state');
    expect(() => parseProgramVocabularyState({
      ...canonical,
      formats: [{ ...canonical.formats[0]!, id: roomId }]
    })).toThrow('invalid_canonical_program_vocabulary_state');
    expect(parseProgramVocabularyItem({
      kind: 'room',
      scope,
      ...canonical.rooms[0]
    })).toMatchObject({ kind: 'room', id: roomId, name: 'Main hall', scope });
    expect(() => parseProgramVocabularyItem({
      kind: 'room',
      scope,
      ...canonical.rooms[0],
      name: ' Main hall '
    })).toThrow('invalid_canonical_program_vocabulary_item');
  });

  test('create planning rejects an id already owned by another vocabulary kind', () => {
    const store = new TrialStore(state());
    expect(() => planProgramVocabularyMutation({
      authorInput: {
        action: 'create',
        scope,
        expectedSetVersion: 1,
        item: { kind: 'track', id: roomId, name: 'Conflicting track' }
      },
      state: store.state,
      referenceRegistry: registry(),
      referenceSource: store
    })).toThrow(new ProgramVocabularyPlanningError('item_exists'));
  });

  test('merge validation rejects omitted, extra, redirected, and stale reference evidence', () => {
    const store = new TrialStore(state(), referenceSnapshot({ sourceCurrent: 2, sourceHistorical: 1 }));
    const referenceRegistry = registry();
    const merge = planProgramVocabularyMutation({
      authorInput: {
        action: 'merge', scope, kind: 'track', sourceId: trackSourceId, targetId: trackTargetId,
        expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
      },
      state: store.state,
      referenceRegistry,
      referenceSource: store
    });
    if (merge.action !== 'merge') throw new TypeError('expected_merge_plan');
    expect(parseProgramVocabularyMutationPlan(merge)).toEqual(merge);
    const predicted = applyProgramReferenceRepoints(store.completeReferences(referenceRegistry), merge);
    expect(() => assertCompleteProgramReferenceSnapshot(predicted)).not.toThrow();

    const [contribution] = merge.references;
    if (!contribution) throw new TypeError('expected_reference_contribution');
    const omitted = {
      ...merge,
      references: [{ ...contribution, liveRepoints: contribution.liveRepoints.slice(1) }]
    };
    expect(validateProgramVocabularyPlan(store.state, omitted, referenceRegistry, store))
      .toBe('stale_reference');

    const extra = {
      ...merge,
      references: [{
        ...contribution,
        liveRepoints: [...contribution.liveRepoints, {
          ...contribution.liveRepoints[0]!,
          referenceKey: 'current-extra'
        }].sort((left, right) => left.referenceKey < right.referenceKey ? -1 : 1)
      }]
    };
    expect(validateProgramVocabularyPlan(store.state, extra, referenceRegistry, store))
      .toBe('stale_reference');

    const duplicated = {
      ...merge,
      references: [{
        ...contribution,
        liveRepoints: [...contribution.liveRepoints, contribution.liveRepoints[0]!]
      }]
    };
    expect(() => parseProgramVocabularyMutationPlan(duplicated))
      .toThrow(new ProgramVocabularyPlanningError('invalid_plan'));

    const omittedPin = {
      ...merge,
      references: [{ ...contribution, historicalPins: [] }]
    };
    expect(validateProgramVocabularyPlan(store.state, omittedPin, referenceRegistry, store))
      .toBe('stale_reference');

    const changedPinDestination = {
      ...merge,
      references: [{
        ...contribution,
        historicalPins: contribution.historicalPins.map((pin) => ({
          ...pin,
          destination: { ...pin.destination, id: `${pin.destination.id}-tampered` }
        }))
      }]
    };
    expect(validateProgramVocabularyPlan(store.state, changedPinDestination, referenceRegistry, store))
      .toBe('stale_reference');

    const redirected = {
      ...merge,
      references: merge.references.map((entry, contributionIndex) => ({
        ...entry,
        liveRepoints: entry.liveRepoints.map((repoint, repointIndex) =>
          contributionIndex === 0 && repointIndex === 0
            ? { ...repoint, to: { ...repoint.to, id: trackSourceId } }
            : repoint
        )
      }))
    };
    expect(() => parseProgramVocabularyMutationPlan(redirected))
      .toThrow(new ProgramVocabularyPlanningError('invalid_plan'));

    const changedTarget = {
      ...merge,
      target: { ...merge.target, name: 'Changed after review' }
    };
    expect(validateProgramVocabularyPlan(store.state, changedTarget, referenceRegistry, store))
      .toBe('stale_item');
  });

  test('plan parsing binds before/after identities, versions, and merge source semantics', () => {
    const store = new TrialStore(state(), referenceSnapshot({ sourceCurrent: 1 }));
    const referenceRegistry = registry();
    const merge = planProgramVocabularyMutation({
      authorInput: {
        action: 'merge', scope, kind: 'track', sourceId: trackSourceId, targetId: trackTargetId,
        expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
      },
      state: store.state,
      referenceRegistry,
      referenceSource: store
    });
    if (merge.action !== 'merge') throw new TypeError('expected_merge_plan');
    expect(() => parseProgramVocabularyMutationPlan({
      ...merge,
      sourceAfter: { ...merge.sourceAfter, name: 'Redirected source' }
    })).toThrow(new ProgramVocabularyPlanningError('invalid_plan'));
    expect(() => parseProgramVocabularyMutationPlan({
      ...merge,
      sourceAfter: { ...merge.sourceAfter, version: merge.sourceBefore.version + 2 }
    })).toThrow(new ProgramVocabularyPlanningError('invalid_plan'));
    expect(() => parseProgramVocabularyMutationPlan({
      ...merge,
      sourceAfter: { ...merge.sourceAfter, status: 'active' }
    })).toThrow(new ProgramVocabularyPlanningError('invalid_plan'));

    const edit = planProgramVocabularyMutation({
      authorInput: {
        action: 'edit', scope, kind: 'room', id: roomId,
        expectedSetVersion: 1, expectedItemVersion: 1,
        changes: { name: 'Updated hall', capacity: 301 }
      },
      state: store.state,
      referenceRegistry,
      referenceSource: store
    });
    if (edit.action !== 'edit') throw new TypeError('expected_edit_plan');
    expect(() => parseProgramVocabularyMutationPlan({
      ...edit,
      after: { ...edit.after, id: newRoomId }
    })).toThrow(new ProgramVocabularyPlanningError('invalid_plan'));
    expect(() => parseProgramVocabularyMutationPlan({
      ...edit,
      after: { ...edit.after, name: ' Updated  hall ' }
    })).toThrow(new ProgramVocabularyPlanningError('invalid_plan'));
  });

  test('registered reference capture is authenticated, synchronous, and code-unit ordered', () => {
    const dot = { key: 'test.references', version: 1 } as const;
    const underscore = { key: 'test_references', version: 1 } as const;
    const referenceRegistry = createProgramReferenceContributorRegistry({
      expected: [underscore, dot],
      contributors: [underscore, dot]
    });
    expect(referenceRegistry.contributors).toEqual([dot, underscore]);
    expect(() => assertProgramReferenceContributorRegistry({
      ...referenceRegistry,
      capture: referenceRegistry.capture.bind(referenceRegistry)
    })).toThrow(new ProgramReferenceSnapshotError('invalid_registry'));
    expect(() => captureRegisteredProgramReferences({
      registry: referenceRegistry,
      scope: state().scope,
      source: { readContributor: () => Promise.resolve(undefined) }
    })).toThrow(new ProgramReferenceSnapshotError('invalid_snapshot'));

    const captured = captureRegisteredProgramReferences({
      registry: referenceRegistry,
      scope: state().scope,
      source: {
        readContributor(requested) {
          return {
            contributor: requested,
            scope,
            guard: {
              id: `program_reference:${requested.key}`,
              version: 1,
              digest: digest(requested)
            },
            references: requested.key === dot.key ? [
              {
                referenceKey: 'é', version: 1, item: { kind: 'room', id: roomId }, mode: 'current',
                destination: { kind: 'schedule_session', id: 'session-accent' }
              },
              {
                referenceKey: 'z', version: 1, item: { kind: 'room', id: roomId }, mode: 'current',
                destination: { kind: 'schedule_session', id: 'session-z' }
              }
            ] : []
          };
        }
      }
    });
    expect(captured.contributors[0]?.references.map((reference) => reference.referenceKey))
      .toEqual(['z', 'é']);
    expect(() => assertCompleteProgramReferenceSnapshot({ ...captured }))
      .toThrow(new ProgramReferenceSnapshotError('invalid_snapshot'));
  });
});
