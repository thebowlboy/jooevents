import type {
  EngagementHeadDto,
  EngagementMutationPlanDto,
  EngagementScopeDto
} from '@jooevents/contracts';
import {
  EngagementPlanningError,
  planEngagementMutation,
  type EngagementPlanningErrorCode
} from './domain';
import type { EngagementReadPort } from './model';

/**
 * The participant-lane engagement group act under `any_participant_acts` (Q14,
 * D3): one listed speaker answers an invitation and the answer binds the whole
 * shared-submission group.
 *
 * Attribution is derived here and only here, from the authenticated person
 * against each engaged person: the actor's own head confirms as `self`, every
 * co-speaker head confirms as `co_speaker` with the actor as the confirming
 * person. No caller-supplied field participates, so a wire can never assert
 * whose act a confirmation records.
 *
 * The group is exactly the acceptance-seeded rows of the shared submission on
 * the shared Session — the D3 minimal carve-out reading. A head without a
 * submission link has no group: the act moves that single head alone.
 */

export type ParticipantEngagementResponse = 'confirm' | 'decline';

export type ParticipantEngagementActRefusalCode = 'unknown_record' | 'engagement_not_open';

export interface ParticipantEngagementGroupActInput {
  readonly scope: EngagementScopeDto;
  /** The authenticated participant's person; the only attribution source. */
  readonly actingPersonId: string;
  /** The actor's own engagement head id, exactly as their snapshot served it. */
  readonly engagementId: string;
  readonly response: ParticipantEngagementResponse;
  readonly occurredAt: string;
  readonly engagements: EngagementReadPort;
}

export type ParticipantEngagementGroupAct =
  | {
      readonly kind: 'planned';
      readonly response: ParticipantEngagementResponse;
      /** The actor's own head mutation; always present. */
      readonly actorPlan: EngagementMutationPlanDto;
      /** Co-speaker head mutations this same act performs, ordered by person. */
      readonly siblingPlans: readonly EngagementMutationPlanDto[];
      readonly sessionId: string;
      readonly submissionId: string | null;
      /** Everyone listed on the shared-submission group, ordered by person id. */
      readonly groupPersonIds: readonly string[];
      /** The informed set: every listed person other than the actor. */
      readonly informedPersonIds: readonly string[];
    }
  | { readonly kind: 'refused'; readonly code: ParticipantEngagementActRefusalCode };

function refusal(code: ParticipantEngagementActRefusalCode): ParticipantEngagementGroupAct {
  return Object.freeze({ kind: 'refused', code });
}

function planFor(input: {
  readonly head: EngagementHeadDto;
  readonly act: ParticipantEngagementGroupActInput;
}): EngagementMutationPlanDto {
  const { head, act } = input;
  const environment = { engagements: act.engagements };
  if (act.response === 'decline') {
    return planEngagementMutation({
      environment,
      planningInput: {
        action: 'decline',
        scope: act.scope,
        occurredAt: act.occurredAt,
        engagementId: head.id,
        expectedEngagementVersion: head.version
      }
    });
  }
  return planEngagementMutation({
    environment,
    planningInput: head.personId === act.actingPersonId
      ? {
          action: 'record_confirmation',
          scope: act.scope,
          occurredAt: act.occurredAt,
          engagementId: head.id,
          expectedEngagementVersion: head.version,
          attribution: 'self'
        }
      : {
          action: 'record_confirmation',
          scope: act.scope,
          occurredAt: act.occurredAt,
          engagementId: head.id,
          expectedEngagementVersion: head.version,
          attribution: 'co_speaker',
          confirmingPersonId: act.actingPersonId
        }
  });
}

const STATE_REFUSAL_CODES: ReadonlySet<EngagementPlanningErrorCode> = new Set([
  'invalid_transition', 'cancellation_already_requested', 'cancellation_not_requested'
]);

function isStateRefusal(error: unknown): boolean {
  return error instanceof EngagementPlanningError && STATE_REFUSAL_CODES.has(error.code);
}

/**
 * Plans one participant response as the exact set of head mutations it
 * performs. Refusals are deliberately coarse: a missing head, a head in
 * another scope, and a head engaging a different person all answer
 * `unknown_record` — indistinguishable from one another, so the act surface
 * enumerates nothing the participant's own snapshot would not show. Only the
 * actor's own currently-`invited` head opens the group act; sibling heads
 * that already left `invited` are skipped rather than replayed.
 */
export function planParticipantEngagementGroupAct(
  input: ParticipantEngagementGroupActInput
): ParticipantEngagementGroupAct {
  const head = input.engagements.readEngagementHead(input.scope, input.engagementId);
  if (!head) return refusal('unknown_record');
  if (head.scope.workspaceId !== input.scope.workspaceId
      || head.scope.eventId !== input.scope.eventId) {
    return refusal('unknown_record');
  }
  if (head.personId !== input.actingPersonId) {
    // A participant may open a group act only through their own engagement.
    return refusal('unknown_record');
  }
  if (head.state !== 'invited') return refusal('engagement_not_open');

  const group: readonly EngagementHeadDto[] = head.submissionId === null
    ? Object.freeze([head])
    : input.engagements.listSeededEngagements(input.scope, head.sessionId, head.submissionId);
  if (!group.some((member) => member.id === head.id)) {
    throw new TypeError('participant_engagement_group_missing_actor');
  }
  for (const [index, member] of group.entries()) {
    if (member.sessionId !== head.sessionId
        || member.submissionId !== head.submissionId
        || (index > 0 && group[index - 1]!.personId >= member.personId)) {
      throw new TypeError('participant_engagement_group_invalid');
    }
  }

  let actorPlan: EngagementMutationPlanDto | undefined;
  const siblingPlans: EngagementMutationPlanDto[] = [];
  for (const member of group) {
    if (member.state !== 'invited') continue;
    let plan: EngagementMutationPlanDto;
    try {
      plan = planFor({ head: member, act: input });
    } catch (error) {
      // The actor's head was checked above; a sibling that cannot move is a
      // state race inside one act, and skipping it keeps the act honest.
      if (member.id !== head.id && isStateRefusal(error)) continue;
      if (member.id === head.id && isStateRefusal(error)) return refusal('engagement_not_open');
      throw error;
    }
    if (member.id === head.id) actorPlan = plan;
    else siblingPlans.push(plan);
  }
  if (actorPlan === undefined) return refusal('engagement_not_open');

  const groupPersonIds = Object.freeze(group.map((member) => member.personId));
  return Object.freeze({
    kind: 'planned',
    response: input.response,
    actorPlan,
    siblingPlans: Object.freeze(siblingPlans),
    sessionId: head.sessionId,
    submissionId: head.submissionId,
    groupPersonIds,
    informedPersonIds: Object.freeze(
      groupPersonIds.filter((personId) => personId !== input.actingPersonId)
    )
  });
}
