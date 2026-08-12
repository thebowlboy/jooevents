import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createChangeset,
  planChangesetCompensation,
  proposeChangeset,
  type ChangesetHead,
  type FrozenChangesetOperation
} from '@jooevents/changesets';
import type { ProgramVocabularyDraftInput, ProgramVocabularyScopeDto } from '@jooevents/contracts';
import {
  encodeCanonicalJson,
  parseAggregateVersion,
  parseOperationReceiptId
} from '@jooevents/kernel';
import {
  createProgramReferenceContributorRegistry,
  createProgramVocabularyChangesetBundle,
  createProgramVocabularyState,
  programVocabularyValidationPort,
  programReferenceUsage,
  resolveProgramVocabularyItem,
  type ProgramReferenceContributorSnapshot,
  type ProgramVocabularyChangesetBundle,
  type ProgramVocabularyTransactionPort,
  type ProgramVocabularyState
} from '@jooevents/program';
import {
  SQLiteProgramVocabularyTrialStore,
  captureProgramVocabularyTrialReferences,
  executeProgramVocabularyTrialCommit,
  installProgramVocabularyTrialSchema,
  planProgramVocabularyTrialOperation,
  type ProgramVocabularyTrialCommitEvidence,
  type ProgramVocabularyTrialFailurePoint
} from './program-vocabulary-trial';
import {
  rewriteProgramVocabularyTrialReferenceForTest,
  seedProgramVocabularyTrialContributorForTest,
  seedProgramVocabularyTrialStateForTest
} from './program-vocabulary-trial-fixtures';

const workspaceId = '018f7d5a-4b3c-7abc-8def-0123456789a1';
const eventId = '018f7d5a-4b3c-7abc-8def-0123456789a2';
const otherEventId = '018f7d5a-4b3c-7abc-8def-0123456789a3';
const roomId = '018f7d5a-4b3c-7abc-8def-0123456789b1';
const newRoomId = '018f7d5a-4b3c-7abc-8def-0123456789b2';
const sourceTrackId = '018f7d5a-4b3c-7abc-8def-0123456789b3';
const targetTrackId = '018f7d5a-4b3c-7abc-8def-0123456789b4';
const formatId = '018f7d5a-4b3c-7abc-8def-0123456789b5';
const secondFormatId = '018f7d5a-4b3c-7abc-8def-0123456789b6';
const scope = { workspaceId, eventId } satisfies ProgramVocabularyScopeDto;
const contributor = { key: 'test.schedule_references', version: 1 } as const;

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function initialState(input?: {
  readonly includeRoom?: boolean;
  readonly targetStatus?: 'active' | 'retired';
}): ProgramVocabularyState {
  return createProgramVocabularyState({
    scope,
    setVersion: 1,
    rooms: input?.includeRoom === false ? [] : [{
      id: roomId,
      name: 'Main hall',
      capacity: 300,
      status: 'active',
      version: 1
    }],
    tracks: [{
      id: sourceTrackId,
      name: 'Leadership',
      status: 'active',
      version: 1
    }, {
      id: targetTrackId,
      name: 'People and culture',
      status: input?.targetStatus ?? 'active',
      version: 1
    }],
    formats: [{
      id: formatId,
      name: 'Talk',
      status: 'active',
      version: 1
    }]
  });
}

function contributorSnapshot(
  state: ProgramVocabularyState,
  input?: { readonly current?: number; readonly historical?: number }
): ProgramReferenceContributorSnapshot {
  const references: ProgramReferenceContributorSnapshot['references'][number][] = [];
  for (let index = 0; index < (input?.current ?? 0); index += 1) {
    references.push({
      referenceKey: `current-${index + 1}`,
      version: parseAggregateVersion(1),
      item: { kind: 'track', id: sourceTrackId },
      mode: 'current',
      destination: { kind: 'schedule_session', id: `session-${index + 1}` }
    });
  }
  for (let index = 0; index < (input?.historical ?? 0); index += 1) {
    references.push({
      referenceKey: `historical-${index + 1}`,
      version: parseAggregateVersion(1),
      item: { kind: 'track', id: sourceTrackId },
      mode: 'historical',
      destination: { kind: 'published_session', id: `release-session-${index + 1}` }
    });
  }
  return {
    contributor,
    scope: state.scope,
    guard: {
      id: 'program_reference:test_schedule',
      version: parseAggregateVersion(1),
      digest: digest(references)
    },
    references
  };
}

interface Harness {
  readonly sqlite: Database;
  readonly state: ProgramVocabularyState;
  readonly store: SQLiteProgramVocabularyTrialStore;
  readonly changesets: ProgramVocabularyChangesetBundle;
}

function harness(input?: {
  readonly state?: ProgramVocabularyState;
  readonly currentReferences?: number;
  readonly historicalReferences?: number;
}): Harness {
  const sqlite = new Database(':memory:', { strict: true });
  installProgramVocabularyTrialSchema(sqlite);
  const state = input?.state ?? initialState();
  seedProgramVocabularyTrialStateForTest(sqlite, state);
  const references = contributorSnapshot(state, {
    current: input?.currentReferences ?? 0,
    historical: input?.historicalReferences ?? 0
  });
  seedProgramVocabularyTrialContributorForTest(sqlite, references);
  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [contributor],
    contributors: [contributor]
  });
  const store = new SQLiteProgramVocabularyTrialStore(sqlite, referenceRegistry);
  const changesets = createProgramVocabularyChangesetBundle({
    referenceRegistry,
    policy: {
      activation: 'test_only',
      key: 'program_vocabulary.sqlite_trial_policy',
      version: 1,
      ordinaryRisk: 'low',
      mergeRisk: 'consequential'
    }
  });
  return { sqlite, state, store, changesets };
}

async function plan(
  target: Harness,
  authorInput: ProgramVocabularyDraftInput
): Promise<FrozenChangesetOperation> {
  return planProgramVocabularyTrialOperation({
    store: target.store,
    registry: target.changesets.registry,
    authorInput
  });
}

function proposedHeadFor(operation: FrozenChangesetOperation, sequence: number): ChangesetHead {
  const head = createChangeset(
    { id: `trial-change-${sequence}`, workspaceId, eventId },
    {
      id: `trial-revision-${sequence}`,
      createdAt: `2026-08-11T04:${String(sequence).padStart(2, '0')}:00.000Z`,
      proposerPrincipalKey: 'principal:sqlite-trial-author',
      origin: 'human_ui',
      operations: [operation],
      dependencyGroups: [{ key: 'program_vocabulary', dependsOn: [] }],
      approvalPolicy: { key: 'program_vocabulary.sqlite_trial_policy', version: 1 }
    }
  );
  return proposeChangeset(head, head.version);
}

function evidenceFor(sequence: number): ProgramVocabularyTrialCommitEvidence {
  return {
    changeEvidenceId: `change-evidence-${sequence}`,
    receiptEvidenceId: parseOperationReceiptId(
      `00000000-0000-4000-8002-${String(sequence).padStart(12, '0')}`
    ),
    factEvidenceId: `fact-evidence-${sequence}`,
    timelineId: `timeline-${sequence}`,
    occurredAtMs: 1_786_422_000_000 + sequence
  };
}

async function commit(
  target: Harness,
  operation: FrozenChangesetOperation,
  sequence: number,
  options?: {
    readonly proposedHead?: ChangesetHead;
    readonly failAt?: ProgramVocabularyTrialFailurePoint;
  }
) {
  const proposedHead = options?.proposedHead ?? proposedHeadFor(operation, sequence);
  const revision = proposedHead.revisions.at(-1);
  if (!revision) throw new TypeError('program_vocabulary_trial_revision_missing');
  const approval = revision.riskTier === 'consequential'
    ? {
        id: `approval-${sequence}`,
        revisionId: revision.id,
        revisionDigest: revision.digest,
        policy: { ...revision.approvalPolicy },
        scopeKey: `workspace:${workspaceId}/event:${eventId}`,
        approverPrincipalKey: 'principal:sqlite-trial-approver',
        issuedAt: '2026-08-11T04:30:00.000Z',
        expiresAt: '2026-08-12T04:30:00.000Z'
      }
    : undefined;
  return executeProgramVocabularyTrialCommit({
    store: target.store,
    registry: target.changesets.registry,
    proposedHead,
    exactCommit: {
      expectedHeadVersion: proposedHead.version,
      expectedRevisionDigest: revision.digest,
      now: '2026-08-11T05:00:00.000Z',
      ...(approval === undefined
        ? {}
        : { approval, approverCurrentlyAuthorized: true })
    },
    evidence: evidenceFor(sequence),
    ...(options?.failAt === undefined ? {} : { failAt: options.failAt })
  });
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? -1;
}

describe('disposable SQLite Program Vocabulary persistence', () => {
  test('validation receives a method-only read facade over the open transaction', () => {
    const target = harness();
    target.sqlite.exec('BEGIN IMMEDIATE;');
    try {
      const view = target.store.transactionPort().getPort(programVocabularyValidationPort);
      expect(view.readVocabulary(scope)?.setVersion).toBe(parseAggregateVersion(1));
      expect('applyVocabularyPlan' in (view as unknown as ProgramVocabularyTransactionPort)).toBe(false);
      expect(Object.isFrozen(view)).toBe(true);
    } finally {
      target.sqlite.exec('ROLLBACK;');
      target.sqlite.close();
    }
  });

  test('distinct normalized families execute create/edit/retire/restore/delete through deterministic registered changesets', async () => {
    const target = harness({ state: initialState({ includeRoom: false }) });
    try {
      const createInput = {
        action: 'create',
        scope,
        expectedSetVersion: 1,
        item: { kind: 'room', id: newRoomId, name: '  Breakout   room  ', capacity: 40 }
      } as const;
      const firstPlan = await plan(target, createInput);
      const repeatedPlan = await plan(target, createInput);
      expect(firstPlan.plan).toEqual(repeatedPlan.plan);
      expect(firstPlan.safeDiff).toEqual(repeatedPlan.safeDiff);
      expect(firstPlan.safeDiff).toMatchObject({
        action: 'create',
        after: { kind: 'room', name: 'Breakout room', capacity: 40, version: 1 }
      });
      expect(await commit(target, firstPlan, 1)).toMatchObject({ kind: 'applied' });
      await expect(plan(target, {
        ...createInput,
        expectedSetVersion: 2
      })).rejects.toMatchObject({ code: 'item_exists' });

      const edited = await plan(target, {
        action: 'edit', scope, kind: 'room', id: newRoomId,
        expectedSetVersion: 2, expectedItemVersion: 1,
        changes: { name: 'Workshop room', capacity: 55 }
      });
      expect(await commit(target, edited, 2)).toMatchObject({ kind: 'applied' });
      const retired = await plan(target, {
        action: 'retire', scope, kind: 'room', id: newRoomId,
        expectedSetVersion: 3, expectedItemVersion: 2
      });
      expect(await commit(target, retired, 3)).toMatchObject({ kind: 'applied' });
      expect(resolveProgramVocabularyItem(target.store.readVocabulary(scope)!, 'room', newRoomId))
        .toMatchObject({ name: 'Workshop room', capacity: 55, status: 'retired', version: 3 });
      await expect(plan(target, {
        action: 'retire', scope, kind: 'room', id: newRoomId,
        expectedSetVersion: 4, expectedItemVersion: 3
      })).rejects.toMatchObject({ code: 'invalid_transition' });
      const restored = await plan(target, {
        action: 'restore', scope, kind: 'room', id: newRoomId,
        expectedSetVersion: 4, expectedItemVersion: 3
      });
      expect(await commit(target, restored, 4)).toMatchObject({ kind: 'applied' });
      const deleted = await plan(target, {
        action: 'delete', scope, kind: 'room', id: newRoomId,
        expectedSetVersion: 5, expectedItemVersion: 4
      });
      expect(deleted.safeDiff).toMatchObject({
        action: 'delete', usage: { current: 0, historicalPins: 0 }
      });
      expect(await commit(target, deleted, 5)).toMatchObject({ kind: 'applied' });

      const persisted = target.store.readVocabulary(scope)!;
      expect(resolveProgramVocabularyItem(persisted, 'room', newRoomId)).toBeUndefined();
      expect(Number(persisted.setVersion)).toBe(6);
      expect(count(target.sqlite, 'program_vocabulary_trial_rooms')).toBe(0);
      expect(count(target.sqlite, 'program_vocabulary_trial_tracks')).toBe(2);
      expect(count(target.sqlite, 'program_vocabulary_trial_formats')).toBe(1);
      expect(count(target.sqlite, 'program_vocabulary_trial_commit_evidence')).toBe(5);
      expect(count(target.sqlite, 'program_vocabulary_trial_timeline_spine')).toBe(5);
      expect(target.sqlite.query<{ readonly count: number }, []>(`
        SELECT count(*) AS count
          FROM program_vocabulary_trial_timeline_spine AS timeline
          JOIN program_vocabulary_trial_commit_evidence AS evidence
            ON evidence.change_evidence_id = timeline.change_evidence_id
           AND evidence.receipt_evidence_id = timeline.receipt_evidence_id
           AND evidence.fact_evidence_id = timeline.fact_evidence_id
      `).get()?.count).toBe(5);
      expect(() => target.sqlite.query<never, []>(`
        UPDATE program_vocabulary_trial_commit_evidence
           SET revision_id = revision_id
      `).run()).toThrow('program vocabulary trial commit evidence is immutable');
      expect(() => target.sqlite.query<never, []>(`
        DELETE FROM program_vocabulary_trial_timeline_spine
      `).run()).toThrow('program vocabulary trial timeline is immutable');

      const trackColumns = target.sqlite.query<{ readonly name: string }, []>(
        'PRAGMA table_info(program_vocabulary_trial_tracks)'
      ).all().map((column) => column.name);
      const formatColumns = target.sqlite.query<{ readonly name: string }, []>(
        'PRAGMA table_info(program_vocabulary_trial_formats)'
      ).all().map((column) => column.name);
      expect(trackColumns).not.toContain('capacity');
      expect(formatColumns).not.toContain('capacity');
      expect(target.sqlite.query<unknown, []>('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      target.sqlite.close();
    }
  });

  test('merge atomically repoints live uses, preserves historical pins, retires the source, and keeps evidence payload-safe', async () => {
    const target = harness({ currentReferences: 2, historicalReferences: 1 });
    try {
      await expect(plan(target, {
        action: 'merge', scope, kind: 'track',
        sourceId: sourceTrackId, targetId: sourceTrackId,
        expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
      })).rejects.toMatchObject({ code: 'invalid_merge' });
      const operation = await plan(target, {
        action: 'merge', scope, kind: 'track',
        sourceId: sourceTrackId, targetId: targetTrackId,
        expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
      });
      expect(operation.riskTier).toBe('consequential');
      expect(operation.safeDiff).toMatchObject({
        action: 'merge', liveRepoints: 2, historicalPinsPreserved: 1
      });
      expect(JSON.stringify(operation.safeDiff)).not.toContain('current-1');
      expect(JSON.stringify(operation.safeDiff)).not.toContain('session-1');
      expect(await commit(target, operation, 1)).toMatchObject({ kind: 'applied' });

      const state = target.store.readVocabulary(scope)!;
      expect(resolveProgramVocabularyItem(state, 'track', sourceTrackId)).toMatchObject({
        status: 'retired', version: 2
      });
      expect(resolveProgramVocabularyItem(state, 'track', targetTrackId)).toMatchObject({
        status: 'active', version: 1
      });
      const references = captureProgramVocabularyTrialReferences(target.store, scope);
      expect(references.contributors[0]?.references.map((reference) => ({
        key: reference.referenceKey,
        mode: reference.mode,
        itemId: String(reference.item.id),
        version: Number(reference.version)
      }))).toEqual([
        { key: 'current-1', mode: 'current', itemId: targetTrackId, version: 2 },
        { key: 'current-2', mode: 'current', itemId: targetTrackId, version: 2 },
        { key: 'historical-1', mode: 'historical', itemId: sourceTrackId, version: 1 }
      ]);
      expect(programReferenceUsage(references, { kind: 'track', id: sourceTrackId })).toEqual({
        current: 0, historicalPins: 1
      });
      await expect(plan(target, {
        action: 'delete', scope, kind: 'track', id: sourceTrackId,
        expectedSetVersion: 2, expectedItemVersion: 2
      })).rejects.toMatchObject({ code: 'delete_referenced' });

      const evidence = target.sqlite.query<{
        readonly result_json: string;
        readonly fact_payload_json: string;
      }, []>(`
        SELECT result_json, fact_payload_json
          FROM program_vocabulary_trial_commit_evidence
      `).get();
      expect(evidence).toBeDefined();
      expect(evidence?.result_json).not.toContain('Leadership');
      expect(evidence?.fact_payload_json).not.toContain('Leadership');
      const timelineColumns = target.sqlite.query<{ readonly name: string }, []>(
        'PRAGMA table_info(program_vocabulary_trial_timeline_spine)'
      ).all().map((column) => column.name);
      expect(timelineColumns).not.toContain('payload_json');
      expect(target.sqlite.query<unknown, []>('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      target.sqlite.close();
    }
  });

  test('item, whole-set, scope, and contributor guards fail before effective writes', async () => {
    const target = harness({ currentReferences: 1 });
    try {
      await expect(plan(target, {
        action: 'edit', scope, kind: 'track', id: sourceTrackId,
        expectedSetVersion: 1, expectedItemVersion: 99,
        changes: { name: 'Wrong version' }
      })).rejects.toMatchObject({ code: 'stale_item' });
      await expect(plan(target, {
        action: 'edit', scope: { workspaceId, eventId: otherEventId },
        kind: 'track', id: sourceTrackId,
        expectedSetVersion: 1, expectedItemVersion: 1,
        changes: { name: 'Wrong event' }
      })).rejects.toThrow('program_vocabulary_scope_missing');

      const staleSetOperation = await plan(target, {
        action: 'edit', scope, kind: 'format', id: formatId,
        expectedSetVersion: 1, expectedItemVersion: 1,
        changes: { name: 'Stale planned format' }
      });
      const winningOperation = await plan(target, {
        action: 'create', scope, expectedSetVersion: 1,
        item: { kind: 'format', id: secondFormatId, name: 'Workshop' }
      });
      expect(await commit(target, winningOperation, 1)).toMatchObject({ kind: 'applied' });
      expect(await commit(target, staleSetOperation, 2)).toMatchObject({
        kind: 'commit_refused',
        refusal: { kind: 'guard_changed', id: `program_vocabulary_set:${eventId}` }
      });
      expect(resolveProgramVocabularyItem(target.store.readVocabulary(scope)!, 'format', formatId)?.name)
        .toBe('Talk');

      const merge = await plan(target, {
        action: 'merge', scope, kind: 'track',
        sourceId: sourceTrackId, targetId: targetTrackId,
        expectedSetVersion: 2, expectedSourceVersion: 1, expectedTargetVersion: 1
      });
      rewriteProgramVocabularyTrialReferenceForTest({
        sqlite: target.sqlite,
        store: target.store,
        scope,
        contributor,
        referenceKey: 'current-1',
        to: { kind: 'track', id: sourceTrackId }
      });
      expect(await commit(target, merge, 3)).toMatchObject({
        kind: 'commit_refused',
        refusal: { kind: 'guard_changed', id: 'program_reference:test_schedule' }
      });
      expect(resolveProgramVocabularyItem(target.store.readVocabulary(scope)!, 'track', sourceTrackId))
        .toMatchObject({ status: 'active', version: 1 });
      expect(count(target.sqlite, 'program_vocabulary_trial_commit_evidence')).toBe(1);
      expect(count(target.sqlite, 'program_vocabulary_trial_timeline_spine')).toBe(1);
    } finally {
      target.sqlite.close();
    }
  });

  test('a rehydrated revision with changed reviewed bytes cannot reach prepare or domain apply', async () => {
    const target = harness({ state: initialState({ includeRoom: false }) });
    try {
      const operation = await plan(target, {
        action: 'create', scope, expectedSetVersion: 1,
        item: { kind: 'room', id: newRoomId, name: 'Reviewed room', capacity: 25 }
      });
      const proposed = proposedHeadFor(operation, 1);
      const tampered = structuredClone(proposed) as ChangesetHead;
      const tamperedDiff = tampered.revisions[0]?.operations[0]?.safeDiff as {
        after?: { name?: string };
      } | undefined;
      if (!tamperedDiff?.after) throw new TypeError('tamper_fixture_missing');
      tamperedDiff.after.name = 'Changed after review';

      expect(await commit(target, operation, 1, { proposedHead: tampered })).toEqual({
        kind: 'commit_refused',
        refusal: { kind: 'digest_changed' }
      });
      expect(resolveProgramVocabularyItem(target.store.readVocabulary(scope)!, 'room', newRoomId))
        .toBeUndefined();
      expect(count(target.sqlite, 'program_vocabulary_trial_commit_evidence')).toBe(0);
      expect(count(target.sqlite, 'program_vocabulary_trial_timeline_spine')).toBe(0);
    } finally {
      target.sqlite.close();
    }
  });

  for (const failAt of ['after_apply', 'after_evidence', 'after_timeline'] as const) {
    test(`failure ${failAt} rolls back domain, fact/receipt/change evidence, and timeline together`, async () => {
      const target = harness({ state: initialState({ includeRoom: false }) });
      try {
        const operation = await plan(target, {
          action: 'create', scope, expectedSetVersion: 1,
          item: { kind: 'room', id: newRoomId, name: 'Rollback room', capacity: 30 }
        });
        await expect(commit(target, operation, 1, { failAt }))
          .rejects.toThrow(`injected_program_vocabulary_trial_failure:${failAt}`);
        const state = target.store.readVocabulary(scope)!;
        expect(resolveProgramVocabularyItem(state, 'room', newRoomId)).toBeUndefined();
        expect(Number(state.setVersion)).toBe(1);
        expect(count(target.sqlite, 'program_vocabulary_trial_commit_evidence')).toBe(0);
        expect(count(target.sqlite, 'program_vocabulary_trial_timeline_spine')).toBe(0);
        expect(target.sqlite.query<unknown, []>('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        target.sqlite.close();
      }
    });
  }

  test('merge compensation restores only attributable work while preserving later item and reference edits', async () => {
    const target = harness({ currentReferences: 2, historicalReferences: 1 });
    try {
      const merge = await plan(target, {
        action: 'merge', scope, kind: 'track',
        sourceId: sourceTrackId, targetId: targetTrackId,
        expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
      });
      const sourceHead = proposedHeadFor(merge, 1);
      const mergeCommit = await commit(target, merge, 1, { proposedHead: sourceHead });
      expect(mergeCommit).toMatchObject({ kind: 'applied', committedHead: { status: 'committed' } });
      if (mergeCommit.kind !== 'applied') throw new TypeError('expected_applied_merge');
      const source = mergeCommit.committedSource;

      const laterItemEdit = await plan(target, {
        action: 'edit', scope, kind: 'track', id: sourceTrackId,
        expectedSetVersion: 2, expectedItemVersion: 2,
        changes: { name: 'Leadership evolved' }
      });
      expect(await commit(target, laterItemEdit, 2)).toMatchObject({ kind: 'applied' });
      rewriteProgramVocabularyTrialReferenceForTest({
        sqlite: target.sqlite,
        store: target.store,
        scope,
        contributor,
        referenceKey: 'current-2',
        to: { kind: 'track', id: targetTrackId }
      });

      target.sqlite.exec('BEGIN DEFERRED;');
      let compensation;
      try {
        compensation = await planChangesetCompensation({
          registry: target.changesets.registry,
          source,
          snapshot: target.store.planningSnapshot()
        });
        target.sqlite.exec('COMMIT;');
      } catch (error) {
        if (target.sqlite.inTransaction) target.sqlite.exec('ROLLBACK;');
        throw error;
      }
      expect(compensation.kind).toBe('partial');
      if (compensation.kind !== 'partial') throw new TypeError('expected_partial_compensation');
      expect(compensation.conflicts).toMatchObject([{
        conflictKeys: ['program.merge_reference_changed']
      }]);
      const compensationOperation = compensation.draft.operations[0];
      if (!compensationOperation) throw new TypeError('compensation_operation_missing');
      expect(compensationOperation.safeDiff).toMatchObject({
        action: 'merge_compensation', liveRepoints: 1, historicalPinsPreserved: 1
      });
      expect(compensationOperation.compensationLineage).toMatchObject({
        sourceRevisionId: source.revisionId,
        sourceRevisionDigest: source.revisionDigest,
        sourceOperationIndex: 0
      });
      expect(await commit(target, compensationOperation, 3)).toMatchObject({ kind: 'applied' });

      const state = target.store.readVocabulary(scope)!;
      expect(resolveProgramVocabularyItem(state, 'track', sourceTrackId)).toMatchObject({
        name: 'Leadership evolved', status: 'active', version: 4
      });
      const references = captureProgramVocabularyTrialReferences(target.store, scope)
        .contributors[0]?.references;
      expect(references?.find((reference) => reference.referenceKey === 'current-1')).toMatchObject({
        item: { id: sourceTrackId }, version: 3
      });
      expect(references?.find((reference) => reference.referenceKey === 'current-2')).toMatchObject({
        item: { id: targetTrackId }, version: 3
      });
      expect(references?.find((reference) => reference.referenceKey === 'historical-1')).toMatchObject({
        mode: 'historical', item: { id: sourceTrackId }, version: 1
      });
      expect(count(target.sqlite, 'program_vocabulary_trial_commit_evidence')).toBe(3);
      expect(count(target.sqlite, 'program_vocabulary_trial_timeline_spine')).toBe(3);
    } finally {
      target.sqlite.close();
    }
  });

  test('physical constraints reject cross-kind identity collision and direct deletion of referenced history', async () => {
    const target = harness({ historicalReferences: 1 });
    try {
      expect(() => target.sqlite.query<never, [string, string, string, string, string, number]>(`
        INSERT INTO program_vocabulary_trial_formats (
          workspace_id, event_id, id, name, status, version
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(workspaceId, eventId, sourceTrackId, 'Collision', 'active', 1))
        .toThrow('program vocabulary ids must be distinct across kinds');
      expect(() => target.sqlite.query<never, [string, string, string]>(`
        DELETE FROM program_vocabulary_trial_tracks
         WHERE workspace_id = ? AND event_id = ? AND id = ?
      `).run(workspaceId, eventId, sourceTrackId))
        .toThrow('referenced program vocabulary item cannot be deleted');
      expect(target.sqlite.query<unknown, []>('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      target.sqlite.close();
    }

    const retiredTarget = harness({ state: initialState({ targetStatus: 'retired' }) });
    try {
      await expect(plan(retiredTarget, {
        action: 'merge', scope, kind: 'track',
        sourceId: sourceTrackId, targetId: targetTrackId,
        expectedSetVersion: 1, expectedSourceVersion: 1, expectedTargetVersion: 1
      })).rejects.toMatchObject({ code: 'invalid_merge' });
    } finally {
      retiredTarget.sqlite.close();
    }
  });
});
