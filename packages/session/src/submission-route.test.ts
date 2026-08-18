import { describe, expect, test } from 'bun:test';
import type {
  EngagementHeadDto,
  EngagementSeedPlanDto,
  EngagementSeedResultDto,
  EngagementSeedReversalPlanDto
} from '@jooevents/contracts';
import {
  engagementSeedResultFromPlan,
  type EngagementReadPort,
  type EngagementSeedTransactionPort
} from '@jooevents/engagement';
import { canonicalJsonSha256 } from '@jooevents/kernel';
import { createProgramVocabularyState } from '@jooevents/program';
import {
  applySessionMutationPlan,
  applySessionRestorePlan,
  createEmptySessionCatalog,
  planSessionMutation,
  planSessionSubmissionAttach,
  planSessionSubmissionMove,
  planSessionSubmissionMoveRestore,
  planSessionSubmissionRestore,
  type SessionCatalog
} from './index';

const scope = Object.freeze({
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa101'
});
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa201';
const targetSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa202';
const submissionId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const otherSubmissionId = '019c1df7-86b5-769b-bba4-5f7097bfa302';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa501';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa601';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa602';
const now = '2026-08-18T11:00:00.000Z';
const later = '2026-08-18T11:05:00.000Z';

function vocabulary() {
  return createProgramVocabularyState({
    scope,
    setVersion: 1,
    formats: [{ id: formatId, name: 'Talk', status: 'active', version: 1 }],
    tracks: [{ id: trackId, name: 'Platform', status: 'active', version: 1 }]
  });
}

function collectingCatalog(): SessionCatalog {
  const empty = createEmptySessionCatalog(scope);
  const plan = planSessionMutation({
    catalog: empty,
    vocabulary: vocabulary(),
    planningInput: {
      action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
      expectedCatalogVersion: empty.version,
      expectedCatalogDigestSha256: empty.digestSha256,
      title: 'Assembled panel', plannedDurationMinutes: 45,
      lifecycle: 'collecting', formatId, trackId
    }
  });
  return applySessionMutationPlan({ plan, catalog: empty, vocabulary: vocabulary() }).catalog;
}

function moveCatalog(): SessionCatalog {
  let catalog = createEmptySessionCatalog(scope);
  for (const input of [
    {
      sessionId,
      title: 'Original panel',
      participants: [
        { personId: personA, role: 'speaker' as const, publiclyVisible: true,
          source: { kind: 'submission', id: submissionId, version: 7 } },
        { personId: personB, role: 'moderator' as const, publiclyVisible: true,
          source: { kind: 'submission', id: submissionId, version: 7 } }
      ]
    },
    {
      sessionId: targetSessionId,
      title: 'Destination panel',
      participants: [
        { personId: personB, role: 'host' as const, publiclyVisible: false,
          source: { kind: 'organizer', id: userId, version: 1 } }
      ]
    }
  ]) {
    const plan = planSessionMutation({
      catalog,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'create', scope, sessionId: input.sessionId,
        actorUserId: userId, occurredAt: now,
        expectedCatalogVersion: catalog.version,
        expectedCatalogDigestSha256: catalog.digestSha256,
        title: input.title, plannedDurationMinutes: 45,
        lifecycle: 'programmed', formatId, trackId,
        participants: input.participants
      }
    });
    catalog = applySessionMutationPlan({ plan, catalog, vocabulary: vocabulary() }).catalog;
  }
  return catalog;
}

function engagementWorld() {
  const heads = new Map<string, EngagementHeadDto>();
  const port: EngagementReadPort & EngagementSeedTransactionPort = {
    readEngagementHead: (_scope, id) => heads.get(id),
    readSessionPersonEngagement: (_scope, session, person) =>
      [...heads.values()].find((head) => head.sessionId === session && head.personId === person),
    listSeededEngagements: (_scope, session, submission) =>
      [...heads.values()].filter((head) =>
        head.sessionId === session && head.submissionId === submission),
    applyEngagementSeed(plan: EngagementSeedPlanDto): EngagementSeedResultDto {
      for (const row of plan.rows) heads.set(row.head.id, row.head);
      return engagementSeedResultFromPlan(plan);
    },
    applyEngagementSeedReversal(plan: EngagementSeedReversalPlanDto): EngagementSeedResultDto {
      for (const row of plan.rows) heads.delete(row.expectedCurrent.id);
      return {
        action: 'seed_reversal', sessionId: plan.sessionId, submissionId: plan.submissionId,
        seeded: [], skippedPersonIds: [], removedPersonIds: plan.rows.map((row) => row.personId)
      };
    }
  };
  return { heads, port };
}

function supportWorld() {
  const rows: import('@jooevents/contracts').SessionParticipantSupportDto[] = [];
  const apply = (plan: import('@jooevents/contracts').SessionParticipantSupportChangePlanDto) => {
    for (const removed of plan.remove) {
      const index = rows.findIndex((row) => JSON.stringify(row) === JSON.stringify(removed));
      if (index < 0) throw new Error('support_changed');
      rows.splice(index, 1);
    }
    for (const inserted of plan.insert) rows.push(inserted);
  };
  return {
    rows,
    apply,
    port: {
      readParticipantSupport: (
        _scope: typeof scope,
        session: string,
        person: string,
        support: { kind: 'submission'; submissionId: string }
          | { kind: 'editorial'; source: import('@jooevents/contracts').SessionRosterSourceRefDto }
      ) => rows.find((row) => row.sessionId === session && row.personId === person
        && row.kind === support.kind
        && (row.kind === 'submission'
          ? row.submissionId === (support as { submissionId: string }).submissionId
          : JSON.stringify(row.source) === JSON.stringify((support as { source: unknown }).source))),
      listParticipantSupports: (_scope: typeof scope, session: string, person: string) =>
        rows.filter((row) => row.sessionId === session && row.personId === person)
    }
  };
}

describe('accepted Submission routing', () => {
  test('attaches atomically shaped roster/origin/engagement plans and prepares an exact restore', () => {
    let catalog = collectingCatalog();
    let origin: import('@jooevents/contracts').SubmissionSessionOriginDto | undefined;
    const engagements = engagementWorld();
    const supports = supportWorld();
    const unsignedDecision = {
      schemaVersion: 1 as const, scope, submissionId, state: 'accepted' as const,
      version: 1, decidedByUserId: userId, decidedAt: now
    };
    const decision = { ...unsignedDecision, digestSha256: canonicalJsonSha256(unsignedDecision) };
    const environment = {
      sessions: {
        readSessionCatalog: () => catalog,
        readSessionVocabulary: () => vocabulary()
      },
      decisions: {
        readDecisionHead: () => decision,
        readDecisionCandidate: () => ({
          submissionId, candidateVersion: 7, participantPersonIds: [personB, personA, personA]
        }),
        readSubmissionSessionOrigin: () => origin
      },
      engagements: engagements.port,
      supports: supports.port
    };
    const before = catalog.sessions[0]!;
    const attach = planSessionSubmissionAttach({
      scope, actorUserId: userId, occurredAt: later,
      author: {
        expectedCatalogVersion: catalog.version,
        expectedCatalogDigestSha256: catalog.digestSha256,
        expectedSessionVersion: before.version,
        expectedSessionDigestSha256: before.digestSha256,
        targetSessionId: sessionId,
        submissionId
      },
      environment
    });
    expect(attach.sessionPlan.after).toMatchObject({
      lifecycle: 'programmed',
      roster: { participants: [
        { personId: personA, position: 0, source: { kind: 'submission', id: submissionId, version: 7 } },
        { personId: personB, position: 1, source: { kind: 'submission', id: submissionId, version: 7 } }
      ] }
    });
    expect(attach.engagementSeed.rows).toHaveLength(2);
    expect(attach.origin).toMatchObject({ kind: 'attached', sessionId, submissionId });

    catalog = applySessionMutationPlan({
      plan: attach.sessionPlan, catalog, vocabulary: vocabulary()
    }).catalog;
    engagements.port.applyEngagementSeed(attach.engagementSeed);
    supports.rows.push(...attach.supportInserts);
    origin = attach.origin;

    const current = catalog.sessions[0]!;
    const restore = planSessionSubmissionRestore({
      scope, actorUserId: userId, occurredAt: '2026-08-18T11:10:00.000Z',
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      expectedSessionVersion: current.version,
      expectedSessionDigestSha256: current.digestSha256,
      original: attach,
      environment
    });
    expect(restore.engagementSeedReversal.rows.map((row) => row.personId)).toEqual([personA, personB]);
    const restored = applySessionRestorePlan({ plan: restore.sessionPlan, catalog }).catalog;
    expect(restored.sessions[0]).toMatchObject({
      lifecycle: 'collecting', roster: { participants: [] }
    });
  });

  test('refuses an accepted Submission that already has a current origin', () => {
    const catalog = collectingCatalog();
    const engagements = engagementWorld();
    const supports = supportWorld();
    const before = catalog.sessions[0]!;
    expect(() => planSessionSubmissionAttach({
      scope, actorUserId: userId, occurredAt: later,
      author: {
        expectedCatalogVersion: catalog.version,
        expectedCatalogDigestSha256: catalog.digestSha256,
        expectedSessionVersion: before.version,
        expectedSessionDigestSha256: before.digestSha256,
        targetSessionId: sessionId,
        submissionId
      },
      environment: {
        sessions: { readSessionCatalog: () => catalog, readSessionVocabulary: () => vocabulary() },
        decisions: {
          readDecisionHead: () => ({
            schemaVersion: 1, scope, submissionId, state: 'accepted', version: 1,
            digestSha256: 'a'.repeat(64), decidedByUserId: userId, decidedAt: now
          }),
          readDecisionCandidate: () => ({ submissionId, candidateVersion: 1, participantPersonIds: [personA] }),
          readSubmissionSessionOrigin: () => ({
            schemaVersion: 1, scope, submissionId, sessionId, kind: 'spawned',
            linkedByUserId: userId, linkedAt: now
          })
        },
        engagements: engagements.port,
        supports: supports.port
      }
    })).toThrow('submission_already_routed');
  });

  test('moves and restores one talk without dropping people who retain other support', () => {
    let catalog = moveCatalog();
    let origin: import('@jooevents/contracts').SubmissionSessionOriginDto = {
      schemaVersion: 1, scope, submissionId, sessionId, kind: 'spawned',
      linkedByUserId: userId, linkedAt: now
    };
    const engagements = engagementWorld();
    const supports = supportWorld();
    supports.rows.push(
      { schemaVersion: 1, scope, sessionId, personId: personA, kind: 'submission', submissionId },
      { schemaVersion: 1, scope, sessionId, personId: personB, kind: 'submission', submissionId },
      { schemaVersion: 1, scope, sessionId, personId: personA, kind: 'submission', submissionId: otherSubmissionId },
      { schemaVersion: 1, scope, sessionId, personId: personB, kind: 'editorial',
        source: { kind: 'organizer', id: userId, version: 1 } },
      { schemaVersion: 1, scope, sessionId: targetSessionId, personId: personB, kind: 'editorial',
        source: { kind: 'organizer', id: userId, version: 1 } }
    );
    const unsignedDecision = {
      schemaVersion: 1 as const, scope, submissionId, state: 'accepted' as const,
      version: 1, decidedByUserId: userId, decidedAt: now
    };
    const decision = { ...unsignedDecision, digestSha256: canonicalJsonSha256(unsignedDecision) };
    const environment = {
      sessions: {
        readSessionCatalog: () => catalog,
        readSessionVocabulary: () => vocabulary()
      },
      decisions: {
        readDecisionHead: (_scope: typeof scope, id: string) => id === submissionId ? decision : undefined,
        readDecisionCandidate: (_scope: typeof scope, id: string) => id === submissionId
          ? { submissionId, candidateVersion: 7, participantPersonIds: [personB, personA] }
          : id === otherSubmissionId
            ? { submissionId: otherSubmissionId, candidateVersion: 3, participantPersonIds: [personA] }
            : undefined,
        readSubmissionSessionOrigin: () => origin
      },
      engagements: engagements.port,
      supports: supports.port
    };
    const source = catalog.sessions.find((session) => session.id === sessionId)!;
    const target = catalog.sessions.find((session) => session.id === targetSessionId)!;
    const move = planSessionSubmissionMove({
      scope, actorUserId: userId, occurredAt: later,
      author: {
        action: 'move',
        expectedCatalogVersion: catalog.version,
        expectedCatalogDigestSha256: catalog.digestSha256,
        submissionId,
        sourceSessionId: sessionId,
        expectedSourceSessionVersion: source.version,
        expectedSourceSessionDigestSha256: source.digestSha256,
        targetSessionId,
        expectedTargetSessionVersion: target.version,
        expectedTargetSessionDigestSha256: target.digestSha256
      },
      environment
    });
    expect(move.sourceSession.after.roster.participants).toMatchObject([
      { personId: personA, source: { kind: 'submission', id: otherSubmissionId, version: 3 } },
      { personId: personB, source: { kind: 'organizer', id: userId, version: 1 } }
    ]);
    expect(move.targetSession.after.roster.participants).toMatchObject([
      { personId: personB, role: 'host', publiclyVisible: false },
      { personId: personA, role: 'speaker', publiclyVisible: true }
    ]);
    expect(move.supportChanges).toMatchObject({ remove: [{ sessionId }, { sessionId }],
      insert: [{ sessionId: targetSessionId }, { sessionId: targetSessionId }] });

    for (const plan of move.sessionPlans) {
      catalog = applySessionMutationPlan({ plan, catalog, vocabulary: vocabulary() }).catalog;
    }
    supports.apply(move.supportChanges);
    engagements.port.applyEngagementSeed(move.engagementSeed);
    origin = move.originAfter;

    const movedSource = catalog.sessions.find((session) => session.id === sessionId)!;
    const movedTarget = catalog.sessions.find((session) => session.id === targetSessionId)!;
    const restore = planSessionSubmissionMoveRestore({
      scope, actorUserId: userId, occurredAt: '2026-08-18T11:10:00.000Z',
      author: {
        action: 'restore_move',
        expectedCatalogVersion: catalog.version,
        expectedCatalogDigestSha256: catalog.digestSha256,
        expectedSourceSessionVersion: movedSource.version,
        expectedSourceSessionDigestSha256: movedSource.digestSha256,
        expectedTargetSessionVersion: movedTarget.version,
        expectedTargetSessionDigestSha256: movedTarget.digestSha256,
        original: move
      },
      environment
    });
    for (const plan of restore.sessionPlans) {
      catalog = applySessionMutationPlan({ plan, catalog, vocabulary: vocabulary() }).catalog;
    }
    expect(catalog.sessions.find((session) => session.id === sessionId)?.roster.participants)
      .toEqual(move.sourceSession.before.roster.participants);
    expect(catalog.sessions.find((session) => session.id === targetSessionId)?.roster.participants)
      .toEqual(move.targetSession.before.roster.participants);
  });
});
