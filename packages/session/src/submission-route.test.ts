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
  planSessionSubmissionRestore,
  type SessionCatalog
} from './index';

const scope = Object.freeze({
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa101'
});
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa201';
const submissionId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
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

describe('accepted Submission routing', () => {
  test('attaches atomically shaped roster/origin/engagement plans and prepares an exact restore', () => {
    let catalog = collectingCatalog();
    let origin: import('@jooevents/contracts').SubmissionSessionOriginDto | undefined;
    const engagements = engagementWorld();
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
      engagements: engagements.port
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
        engagements: engagements.port
      }
    })).toThrow('submission_already_routed');
  });
});
