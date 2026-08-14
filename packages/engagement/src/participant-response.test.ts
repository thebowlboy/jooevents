import { describe, expect, test } from 'bun:test';
import {
  engagementMutationPlanningInputSchema,
  type EngagementHeadDto,
  type EngagementMutationPlanDto
} from '@jooevents/contracts';
import { planParticipantEngagementGroupAct } from './participant-response';
import type { EngagementReadPort, EngagementScope } from './model';

const WS = '11111111-1111-4111-8111-111111111111';
const EV = '22222222-2222-4222-8222-222222222222';
const OTHER_EV = '22222222-9999-4999-8999-999999999999';
const scope: EngagementScope = { workspaceId: WS, eventId: EV };

const MAYA = '33333333-1111-4111-8111-111111111111';
const ANA = '33333333-2222-4222-8222-222222222222';
const NOAH = '33333333-3333-4333-8333-333333333333';
const S1 = '66666666-1111-4111-8111-111111111111';
const S2 = '66666666-2222-4222-8222-222222222222';
const SUB_A = '77777777-1111-4111-8111-111111111111';
const SUB_B = '77777777-2222-4222-8222-222222222222';
const ENG_MAYA = '88888888-1111-4111-8111-111111111111';
const ENG_ANA = '88888888-2222-4222-8222-222222222222';
const ENG_NOAH = '88888888-3333-4333-8333-333333333333';
const NOW = '2026-08-14T12:00:00.000Z';

function head(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly personId: string;
  readonly submissionId: string;
  readonly state?: EngagementHeadDto['state'];
  readonly eventId?: string;
}): EngagementHeadDto {
  const state = input.state ?? 'invited';
  return {
    schemaVersion: 1,
    id: input.id,
    scope: { workspaceId: WS, eventId: input.eventId ?? EV },
    sessionId: input.sessionId,
    personId: input.personId,
    submissionId: input.submissionId,
    seededByDecision: { version: 1, digestSha256: 'a'.repeat(64) },
    state,
    invitedAt: '2026-08-10T12:00:00.000Z',
    respondBy: null,
    confirmation: null,
    cancellationRequest: null,
    cancelledAt: state === 'cancelled' ? NOW : null,
    source: { kind: 'submission', id: input.submissionId, version: 1 },
    version: 1
  } as EngagementHeadDto;
}

function port(heads: readonly EngagementHeadDto[]): EngagementReadPort {
  return {
    readEngagementHead: (requested, engagementId) =>
      heads.find((candidate) => candidate.id === engagementId
        && candidate.scope.workspaceId === requested.workspaceId
        && candidate.scope.eventId === requested.eventId),
    readSessionPersonEngagement: (requested, sessionId, personId) =>
      heads.find((candidate) => candidate.sessionId === sessionId
        && candidate.personId === personId
        && candidate.scope.eventId === requested.eventId),
    listSeededEngagements: (requested, sessionId, submissionId) =>
      heads
        .filter((candidate) => candidate.sessionId === sessionId
          && candidate.submissionId === submissionId
          && candidate.scope.eventId === requested.eventId)
        .sort((left, right) => left.personId < right.personId ? -1 : 1)
  };
}

const sharedWorld = () => port([
  head({ id: ENG_MAYA, sessionId: S1, personId: MAYA, submissionId: SUB_A }),
  head({ id: ENG_ANA, sessionId: S1, personId: ANA, submissionId: SUB_A }),
  head({ id: ENG_NOAH, sessionId: S2, personId: NOAH, submissionId: SUB_B })
]);

describe('planning attribution seam (contracts)', () => {
  test('participant confirmation inputs carry no workspace user; organizer inputs must', () => {
    const base = {
      action: 'record_confirmation',
      scope,
      occurredAt: NOW,
      engagementId: ENG_MAYA,
      expectedEngagementVersion: 1
    } as const;
    expect(engagementMutationPlanningInputSchema.safeParse({
      ...base, attribution: 'self'
    }).success).toBe(true);
    expect(engagementMutationPlanningInputSchema.safeParse({
      ...base, attribution: 'co_speaker', confirmingPersonId: ANA
    }).success).toBe(true);
    // A participant surface fabricating a workspace user is refused …
    expect(engagementMutationPlanningInputSchema.safeParse({
      ...base, attribution: 'self', actorUserId: MAYA
    }).success).toBe(false);
    // … and an organizer-recorded confirmation without one is refused too.
    expect(engagementMutationPlanningInputSchema.safeParse({
      ...base, attribution: 'organizer_recorded'
    }).success).toBe(false);
    expect(engagementMutationPlanningInputSchema.safeParse({
      ...base, attribution: 'organizer_recorded', actorUserId: MAYA
    }).success).toBe(true);
    // Declines resolve on both surfaces: operator-attributed or participant-plain.
    expect(engagementMutationPlanningInputSchema.safeParse({
      action: 'decline', scope, occurredAt: NOW,
      engagementId: ENG_MAYA, expectedEngagementVersion: 1
    }).success).toBe(true);
    expect(engagementMutationPlanningInputSchema.safeParse({
      action: 'decline', scope, occurredAt: NOW, actorUserId: MAYA,
      engagementId: ENG_MAYA, expectedEngagementVersion: 1
    }).success).toBe(true);
  });
});

describe('planParticipantEngagementGroupAct', () => {
  test('confirm plans self for the actor and co_speaker for every sibling, versions fenced', () => {
    const act = planParticipantEngagementGroupAct({
      scope, actingPersonId: MAYA, engagementId: ENG_MAYA,
      response: 'confirm', occurredAt: NOW, engagements: sharedWorld()
    });
    if (act.kind !== 'planned') throw new Error('expected planned');
    expect(act.actorPlan.after).toMatchObject({
      id: ENG_MAYA, state: 'confirmed', version: 2,
      confirmation: { attribution: 'self', personId: MAYA, recordedByUserId: null }
    });
    expect(act.siblingPlans).toHaveLength(1);
    expect(act.siblingPlans[0]!.after).toMatchObject({
      id: ENG_ANA, state: 'confirmed', version: 2,
      confirmation: { attribution: 'co_speaker', personId: MAYA, recordedByUserId: null }
    });
    expect(act.groupPersonIds).toEqual([MAYA, ANA]);
    expect(act.informedPersonIds).toEqual([ANA]);
    expect(act.submissionId).toBe(SUB_A);
    // The plans are pure: no attribution field came from any caller input.
    const planInputs = [act.actorPlan, ...act.siblingPlans]
      .map((plan: EngagementMutationPlanDto) => plan.input);
    for (const input of planInputs) {
      expect('actorUserId' in input && input.actorUserId !== undefined).toBe(false);
    }
  });

  test('decline plans the whole invited group without recording any confirmation', () => {
    const act = planParticipantEngagementGroupAct({
      scope, actingPersonId: ANA, engagementId: ENG_ANA,
      response: 'decline', occurredAt: NOW, engagements: sharedWorld()
    });
    if (act.kind !== 'planned') throw new Error('expected planned');
    expect(act.actorPlan.after).toMatchObject({ id: ENG_ANA, state: 'declined' });
    expect(act.siblingPlans[0]!.after).toMatchObject({ id: ENG_MAYA, state: 'declined' });
    expect(act.actorPlan.after.confirmation).toBeNull();
  });

  test('missing, cross-scope, and other-person heads refuse identically as unknown_record', () => {
    const engagements = port([
      head({ id: ENG_MAYA, sessionId: S1, personId: MAYA, submissionId: SUB_A }),
      head({ id: ENG_ANA, sessionId: S1, personId: ANA, submissionId: SUB_A }),
      head({ id: ENG_NOAH, sessionId: S2, personId: NOAH, submissionId: SUB_B, eventId: OTHER_EV })
    ]);
    const missing = planParticipantEngagementGroupAct({
      scope, actingPersonId: MAYA, engagementId: '88888888-9999-4999-8999-999999999999',
      response: 'confirm', occurredAt: NOW, engagements
    });
    const foreignPerson = planParticipantEngagementGroupAct({
      scope, actingPersonId: MAYA, engagementId: ENG_ANA,
      response: 'confirm', occurredAt: NOW, engagements
    });
    const crossScope = planParticipantEngagementGroupAct({
      scope, actingPersonId: NOAH, engagementId: ENG_NOAH,
      response: 'confirm', occurredAt: NOW, engagements
    });
    expect(missing).toEqual({ kind: 'refused', code: 'unknown_record' });
    expect(foreignPerson).toEqual(missing);
    expect(crossScope).toEqual(missing);
  });

  test('a non-invited own head refuses engagement_not_open', () => {
    const engagements = port([
      head({ id: ENG_MAYA, sessionId: S1, personId: MAYA, submissionId: SUB_A, state: 'declined' }),
      head({ id: ENG_ANA, sessionId: S1, personId: ANA, submissionId: SUB_A })
    ]);
    expect(planParticipantEngagementGroupAct({
      scope, actingPersonId: MAYA, engagementId: ENG_MAYA,
      response: 'confirm', occurredAt: NOW, engagements
    })).toEqual({ kind: 'refused', code: 'engagement_not_open' });
  });

  test('siblings that already left invited are skipped, never replayed', () => {
    const engagements = port([
      head({ id: ENG_MAYA, sessionId: S1, personId: MAYA, submissionId: SUB_A }),
      head({ id: ENG_ANA, sessionId: S1, personId: ANA, submissionId: SUB_A, state: 'cancelled' })
    ]);
    const act = planParticipantEngagementGroupAct({
      scope, actingPersonId: MAYA, engagementId: ENG_MAYA,
      response: 'confirm', occurredAt: NOW, engagements
    });
    if (act.kind !== 'planned') throw new Error('expected planned');
    expect(act.siblingPlans).toEqual([]);
    // The cancelled sibling is still a listed, informed group member.
    expect(act.groupPersonIds).toEqual([MAYA, ANA]);
    expect(act.informedPersonIds).toEqual([ANA]);
  });
});
