import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createReadInvocationContextBuilder,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  isSealedInvocationContext,
  type EffectHandlerRegistration,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type RequestHashSealer
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS,
  portalEngagementRespondInputSchema,
  portalEngagementRespondResultSchema,
  portalEngagementResponseSchema,
  portalEngagementSchema,
  portalSnapshotReadInputSchema,
  portalSnapshotReadResultSchema,
  portalSnapshotSchema,
  structuredOutcomeSchema,
  type PortalEngagementConfirmationDto,
  type PortalEngagementDto,
  type PortalEngagementRespondInput,
  type PortalEngagementResponse,
  type PortalEventDto,
  type PortalFileDto,
  type PortalProfileDto,
  type PortalResourceDto,
  type PortalSnapshotDto,
  type PortalSubmissionDto,
  type PortalTimelineEventDto,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import type {
  EngagementHeadDto,
  EngagementMutationPlanDto,
  EngagementScopeDto
} from '@jooevents/contracts';
import {
  planParticipantEngagementGroupAct,
  type EngagementReadPort,
  type ParticipantEngagementGroupAct
} from '@jooevents/engagement';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  participantSubjectAccess,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolution,
  type CurrentAuthorityResolutionInput,
  type CurrentAuthorityResolver,
  type ISODateTime,
  type OperationAccessLane,
  type ParticipantIdentityDirectory,
  type ParticipantLane,
  type ParticipantRelationship,
  type ParticipantRelationshipSource,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseInstant,
  type Clock,
  type InvocationId,
  type ParticipantIdentityId,
  type ParticipantSessionId,
  type PersonId
} from '@jooevents/kernel';
import { z } from 'zod';

/**
 * Participant-portal operations: the first consumer of the reserved
 * `participant_http` binding surface. Two operations serve the portal lane —
 * the snapshot read and the engagement response act — both scoped to one
 * workspace/event participant lane and authorized per request against the
 * participant's *current* relationship (D2: removal bites on the next
 * request; the session only ever proves identity).
 *
 * Isolation is structural, not filtered: the snapshot is assembled only from
 * the subjects the freshly evaluated relationship lists, so another person's
 * submissions, engagements, and files are never even read. The D3 co-speaker
 * scope follows the same rule — a co-speaker's relationship lists the shared
 * submission and their own engagement on the shared Session, and files are
 * fetched exclusively for the sessions the viewer is engaged on.
 *
 * Participant acts are guarded operations with receipts and portal timeline
 * entries rather than generic review artifacts (20-confirmation-history binding).
 */

export const PORTAL_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'portal.snapshot.read', version: 1
});
export const PORTAL_ENGAGEMENT_RESPOND_OPERATION = Object.freeze({
  name: 'portal.engagement.respond', version: 1
});

export const PORTAL_PARTICIPANT_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.portal.participant.read', version: parseContractVersion(1)
});
export const PORTAL_PARTICIPANT_ACT_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.portal.participant.act', version: parseContractVersion(1)
});

export const PORTAL_HTTP_PATHS = Object.freeze({
  snapshot: '/api/portal/snapshot',
  engagementRespond: '/api/portal/engagements/respond'
});

export const PORTAL_ENGAGEMENT_RESPOND_HANDLER_CAPABILITY: VersionedDefinitionRef = Object.freeze({
  key: 'capability.portal.engagement.respond', version: parseContractVersion(1)
});
export const PORTAL_ENGAGEMENT_RESPOND_REQUEST_HASH_PROFILE: VersionedDefinitionRef = Object.freeze({
  key: 'request-hash.portal.engagement.respond', version: parseContractVersion(1)
});

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Current view of one participant session by its id, for per-request
 * authority re-evaluation. The transport boundary already proved the bearer
 * token; this port answers whether that session still stands *now*.
 * `undefined` uniformly covers missing, expired, and signed-out sessions.
 */
export interface ParticipantSessionAuthorityView {
  readCurrentSession(input: {
    readonly lane: ParticipantLane;
    readonly participantSessionId: ParticipantSessionId;
    readonly now: ISODateTime;
  }): { readonly participantIdentityId: ParticipantIdentityId; readonly personId: PersonId } | undefined;
}

/** Everything of one portal submission except its viewer-dependent fields. */
export interface PortalSubmissionMaterial {
  readonly id: string;
  readonly title: string;
  readonly formVersion: number;
  readonly answers: PortalSubmissionDto['answers'];
  readonly target: PortalSubmissionDto['target'];
  readonly status: PortalSubmissionDto['status'];
  readonly statusNotifiedAt: string | null;
  readonly submittedAt: string;
  readonly editableUntilClose: boolean;
  readonly late: boolean;
  readonly appeal: PortalSubmissionDto['appeal'];
}

/**
 * One canonical, append-only portal activity record. It is stored once per
 * act on the shared submission's timeline and projected per viewer: the
 * acting participant reads the second-person summary, every informed
 * co-speaker reads the third-person one (D3: "informed" lands as portal
 * timeline entries now). Organizer-side entries carry no person at all.
 */
export interface ParticipantPortalActivityRecord {
  readonly activityId: string;
  readonly submissionId: string;
  readonly kind: PortalTimelineEventDto['kind'];
  readonly occurredAt: string;
  readonly acting:
    | { readonly kind: 'participant'; readonly personId: string }
    | { readonly kind: 'organizers' };
  readonly summaryForActor: string;
  readonly summaryForOthers: string;
}

/** Appends inside the caller's transaction; records are never rewritten. */
export interface ParticipantPortalActivityStore {
  append(input: {
    readonly lane: ParticipantLane;
    readonly record: ParticipantPortalActivityRecord;
  }): void;
}

/** Applies one planned head mutation inside the caller's transaction. */
export interface ParticipantEngagementWritePort {
  applyEngagementResponsePlan(plan: EngagementMutationPlanDto): void;
}

/** Presentation lookups an act needs to speak about its subjects. */
export interface ParticipantPortalPresentationSource {
  readSessionTitle(input: {
    readonly lane: ParticipantLane;
    readonly sessionId: string;
  }): string | undefined;
  readPersonDisplayName(input: {
    readonly lane: ParticipantLane;
    readonly personId: string;
  }): string | undefined;
}

/**
 * Lane-scoped projection material for the snapshot read. Every read is keyed
 * by an id the freshly evaluated relationship produced — the assembler never
 * asks for a subject the viewer is not currently on, and a source must never
 * widen an answer beyond the exact subject asked for.
 */
export interface ParticipantPortalReadSource extends ParticipantPortalPresentationSource {
  readPortalEvent(lane: ParticipantLane): PortalEventDto | undefined;
  readSubmissionMaterial(input: {
    readonly lane: ParticipantLane;
    readonly submissionId: string;
  }): PortalSubmissionMaterial | undefined;
  /** Listed speakers of one submission, unique and ordered by person id. */
  listSubmissionSpeakerPersonIds(input: {
    readonly lane: ParticipantLane;
    readonly submissionId: string;
  }): readonly string[];
  /** Files attached to one Session — the D3 shared-session file scope. */
  listSessionFiles(input: {
    readonly lane: ParticipantLane;
    readonly sessionId: string;
  }): readonly PortalFileDto[];
  listEventResources(lane: ParticipantLane): readonly PortalResourceDto[];
  readProfile(input: {
    readonly lane: ParticipantLane;
    readonly personId: string;
  }): PortalProfileDto;
  listSubmissionActivity(input: {
    readonly lane: ParticipantLane;
    readonly submissionId: string;
  }): readonly ParticipantPortalActivityRecord[];
}

// ---------------------------------------------------------------------------
// Per-request authority (D2: session proves identity; standing is re-read)
// ---------------------------------------------------------------------------

const PARTICIPANT_AUTHORITY_EVIDENCE_IDS = Object.freeze([
  'participant.session.current',
  'participant.identity.standing',
  'participant.relationship.current'
]);

/**
 * Builds the participant-lane `CurrentAuthorityResolver`. Every invocation
 * re-reads the session's current standing, the identity's current standing,
 * and the person's current submission/engagement relationship — nothing is
 * carried over from the session mint, so removal or revocation bites on the
 * very next request. A relationship of `none` still authorizes the lane
 * (an honest empty portal); subject access is refused per act instead.
 */
export function createParticipantCurrentAuthorityResolver(input: {
  readonly lane: ParticipantLane;
  readonly policies: readonly VersionedAccessPolicyRef[];
  readonly sessions: ParticipantSessionAuthorityView;
  readonly identities: ParticipantIdentityDirectory;
  readonly relationships: ParticipantRelationshipSource;
}): CurrentAuthorityResolver<InvocationEvidence> {
  const policyKeys = new Set(input.policies.map((policy) => `${policy.key}@${policy.version}`));
  return Object.freeze({
    resolve({ evidence, lane, scope, evaluatedAt }: CurrentAuthorityResolutionInput<InvocationEvidence>): CurrentAuthorityResolution {
      if (evidence.kind !== 'participant' || lane.kind !== 'participant') {
        return Object.freeze({ kind: 'denied', reason: 'lane_mismatch' });
      }
      if (!policyKeys.has(`${lane.policy.key}@${lane.policy.version}`)) {
        return Object.freeze({ kind: 'denied', reason: 'lane_mismatch' });
      }
      if (scope.workspaceId !== input.lane.workspaceId || scope.eventId !== input.lane.eventId) {
        return Object.freeze({ kind: 'denied', reason: 'cross_scope' });
      }
      const session = input.sessions.readCurrentSession({
        lane: input.lane,
        participantSessionId: evidence.participantSessionId,
        now: evaluatedAt
      });
      if (session === undefined) return Object.freeze({ kind: 'denied', reason: 'missing' });
      const identity = input.identities.get({
        lane: input.lane,
        participantIdentityId: session.participantIdentityId
      });
      if (identity === undefined) return Object.freeze({ kind: 'denied', reason: 'missing' });
      if (identity.standing !== 'active') return Object.freeze({ kind: 'denied', reason: 'revoked' });
      if (identity.personId !== session.personId) {
        // The person + participant-identity pair is immutable; a divergence is
        // corrupt composition state, never a request condition.
        throw new TypeError('participant_identity_pair_divergent');
      }
      const relationship = input.relationships.evaluate({
        lane: input.lane,
        personId: identity.personId
      });
      const grants = relationship.kind === 'related'
        ? [
            ...relationship.submissionIds.map((id) => Object.freeze({
              kind: 'participant_relationship' as const, key: `submission:${id}`
            })),
            ...relationship.engagementIds.map((id) => Object.freeze({
              kind: 'participant_relationship' as const, key: `engagement:${id}`
            }))
          ]
        : [];
      return Object.freeze({
        kind: 'authorized',
        authority: Object.freeze({
          actor: Object.freeze({
            kind: 'participant' as const,
            participantIdentityId: identity.participantIdentityId,
            personId: identity.personId
          }),
          principal: Object.freeze({
            kind: 'participant' as const,
            participantIdentityId: identity.participantIdentityId,
            personId: identity.personId,
            participantSessionId: evidence.participantSessionId
          }),
          lane,
          scope,
          grants: Object.freeze(grants),
          evidenceIds: PARTICIPANT_AUTHORITY_EVIDENCE_IDS,
          authorityCitationIds: Object.freeze([]),
          evaluatedAt
        })
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Timeline projection (per-viewer rendering of the canonical record)
// ---------------------------------------------------------------------------

/**
 * Projects one canonical activity record for one viewer. Participant-side
 * acts render on the `you` side of the actor line regardless of *which*
 * listed speaker performed them — persons are named in the summary, never as
 * a projected identity — and the summary chooses the second-person form
 * exactly for the acting participant.
 */
export function projectPortalTimelineEvent(
  record: ParticipantPortalActivityRecord,
  viewerPersonId: string
): PortalTimelineEventDto {
  const viewerActed = record.acting.kind === 'participant'
    && record.acting.personId === viewerPersonId;
  return {
    id: record.activityId,
    occurredAt: record.occurredAt,
    actor: record.acting.kind === 'organizers' ? 'organizers' : 'you',
    kind: record.kind,
    summary: viewerActed ? record.summaryForActor : record.summaryForOthers
  };
}

function composeEngagementResponseActivity(input: {
  readonly activityId: string;
  readonly submissionId: string;
  readonly occurredAt: string;
  readonly actingPersonId: string;
  readonly actorDisplayName: string;
  readonly sessionTitle: string;
  readonly response: PortalEngagementResponse;
  readonly groupSize: number;
}): ParticipantPortalActivityRecord {
  const group = input.groupSize > 1;
  const title = `“${input.sessionTitle}”`;
  const summaryForActor = input.response === 'confirm'
    ? group
      ? `You confirmed ${title} for everyone listed.`
      : `You confirmed ${title}.`
    : `You told the organizers you cannot do ${title}.`;
  const summaryForOthers = input.response === 'confirm'
    ? `${input.actorDisplayName} confirmed ${title} for everyone listed.`
    : `${input.actorDisplayName} declined ${title} for everyone listed.`;
  return Object.freeze({
    activityId: input.activityId,
    submissionId: input.submissionId,
    kind: 'engagement_responded',
    occurredAt: input.occurredAt,
    acting: Object.freeze({ kind: 'participant', personId: input.actingPersonId }),
    summaryForActor,
    summaryForOthers
  });
}

// ---------------------------------------------------------------------------
// Projections shared by the snapshot read and the response act
// ---------------------------------------------------------------------------

function displayNameOf(
  portal: ParticipantPortalPresentationSource,
  lane: ParticipantLane,
  personId: string
): string {
  const displayName = portal.readPersonDisplayName({ lane, personId });
  if (displayName === undefined) throw new TypeError('participant_portal_person_unnamed');
  return displayName;
}

function sessionTitleOf(
  portal: ParticipantPortalPresentationSource,
  lane: ParticipantLane,
  sessionId: string
): string {
  const title = portal.readSessionTitle({ lane, sessionId });
  if (title === undefined) throw new TypeError('participant_portal_session_untitled');
  return title;
}

function projectConfirmation(
  head: EngagementHeadDto,
  viewerPersonId: string,
  portal: ParticipantPortalPresentationSource,
  lane: ParticipantLane
): PortalEngagementConfirmationDto | null {
  const confirmation = head.confirmation;
  if (confirmation === null) return null;
  if (confirmation.attribution === 'organizer_recorded') {
    // Organizer identities are never projected into this lane; the actor is a
    // kind, so the confirmation names the side, not the person.
    return { by: 'organizer', at: confirmation.confirmedAt, displayName: 'Organizers' };
  }
  if (confirmation.personId === viewerPersonId) {
    return { by: 'you', at: confirmation.confirmedAt };
  }
  return {
    by: 'co_speaker',
    at: confirmation.confirmedAt,
    displayName: displayNameOf(portal, lane, confirmation.personId)
  };
}

function projectEngagement(input: {
  readonly head: EngagementHeadDto;
  readonly viewerPersonId: string;
  readonly groupPersonIds: readonly string[];
  readonly portal: ParticipantPortalPresentationSource;
  readonly lane: ParticipantLane;
}): PortalEngagementDto {
  const { head, lane, portal } = input;
  return portalEngagementSchema.parse({
    id: head.id,
    sessionId: head.sessionId,
    sessionTitle: sessionTitleOf(portal, lane, head.sessionId),
    submissionId: head.submissionId,
    status: head.state,
    invitedAt: head.invitedAt,
    respondBy: head.respondBy,
    confirmation: projectConfirmation(head, input.viewerPersonId, portal, lane),
    speakers: input.groupPersonIds.map((personId) => ({
      participantId: personId,
      displayName: displayNameOf(portal, lane, personId)
    }))
  });
}

function engagementGroupPersonIds(input: {
  readonly head: EngagementHeadDto;
  readonly scope: EngagementScopeDto;
  readonly engagements: EngagementReadPort;
}): readonly string[] {
  if (input.head.submissionId === null) return Object.freeze([input.head.personId]);
  const group = input.engagements.listSeededEngagements(
    input.scope, input.head.sessionId, input.head.submissionId
  );
  if (!group.some((member) => member.id === input.head.id)) {
    throw new TypeError('participant_portal_engagement_group_incoherent');
  }
  return Object.freeze(group.map((member) => member.personId));
}

// ---------------------------------------------------------------------------
// Snapshot assembly (the read handler's whole truth)
// ---------------------------------------------------------------------------

export interface ParticipantPortalViewer {
  readonly personId: string;
  readonly displayName: string;
  readonly email: string;
}

/**
 * Assembles the frozen `portalSnapshotSchema` shape for one viewer from
 * exactly the subjects the current relationship lists. Two guards fail
 * closed as composition faults rather than serve a leak: a listed submission
 * whose speaker roster does not include the viewer, and an engagement head
 * engaging a different person. Tasks are deliberately empty — no live task
 * domain exists in this wave, and an empty list is the honest projection.
 */
export function assembleParticipantPortalSnapshot(input: {
  readonly lane: ParticipantLane;
  readonly viewer: ParticipantPortalViewer;
  readonly relationship: ParticipantRelationship;
  readonly engagements: EngagementReadPort;
  readonly portal: ParticipantPortalReadSource;
}): PortalSnapshotDto {
  const { lane, viewer, portal } = input;
  const event = portal.readPortalEvent(lane);
  if (event === undefined) throw new TypeError('participant_portal_event_missing');
  const scope: EngagementScopeDto = { workspaceId: lane.workspaceId, eventId: lane.eventId };
  const related = input.relationship.kind === 'related' ? input.relationship : undefined;
  const submissionIds = [...(related?.submissionIds ?? [])].sort();
  const engagementIds = [...(related?.engagementIds ?? [])].sort();

  const submissions = submissionIds.map((submissionId) => {
    const material = portal.readSubmissionMaterial({ lane, submissionId });
    if (material === undefined || material.id !== submissionId) {
      throw new TypeError('participant_portal_submission_missing');
    }
    const speakerPersonIds = portal.listSubmissionSpeakerPersonIds({ lane, submissionId });
    if (!speakerPersonIds.includes(viewer.personId)) {
      // Serving a submission the viewer is not listed on would be a leak.
      throw new TypeError('participant_portal_submission_not_owned');
    }
    const timeline = [...portal.listSubmissionActivity({ lane, submissionId })]
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
        || left.activityId.localeCompare(right.activityId))
      .map((record) => projectPortalTimelineEvent(record, viewer.personId));
    return {
      ...material,
      speakers: speakerPersonIds.map((personId) => ({
        participantId: personId,
        displayName: displayNameOf(portal, lane, personId)
      })),
      speakerAuthority: 'any_participant_acts' as const,
      timeline
    };
  });

  const heads = engagementIds.map((engagementId) => {
    const head = input.engagements.readEngagementHead(scope, engagementId);
    if (head === undefined) throw new TypeError('participant_portal_engagement_missing');
    if (head.personId !== viewer.personId) {
      // A relationship may list only the viewer's own heads.
      throw new TypeError('participant_portal_engagement_not_owned');
    }
    return head;
  });
  const engagements = heads.map((head) => projectEngagement({
    head,
    viewerPersonId: viewer.personId,
    groupPersonIds: engagementGroupPersonIds({ head, scope, engagements: input.engagements }),
    portal,
    lane
  }));

  const engagedSessionIds = [...new Set(heads.map((head) => head.sessionId))].sort();
  const files = engagedSessionIds.flatMap((sessionId) =>
    portal.listSessionFiles({ lane, sessionId })
  );

  return portalSnapshotSchema.parse({
    schemaVersion: 1,
    participant: {
      id: viewer.personId,
      displayName: viewer.displayName,
      email: viewer.email
    },
    event,
    submissions,
    engagements,
    tasks: [],
    files,
    resources: portal.listEventResources(lane),
    profile: portal.readProfile({ lane, personId: viewer.personId })
  });
}

// ---------------------------------------------------------------------------
// The response act (transaction semantics; called by the sealed preparation)
// ---------------------------------------------------------------------------

export interface ParticipantPortalActPorts {
  readonly relationships: ParticipantRelationshipSource;
  readonly engagements: EngagementReadPort;
  readonly writer: ParticipantEngagementWritePort;
  readonly activity: ParticipantPortalActivityStore;
  readonly presentation: ParticipantPortalPresentationSource;
}

export type ParticipantEngagementResponseApplication =
  | {
      readonly kind: 'responded';
      readonly engagement: PortalEngagementDto;
      readonly act: Extract<ParticipantEngagementGroupAct, { readonly kind: 'planned' }>;
      readonly activity: ParticipantPortalActivityRecord | null;
    }
  | { readonly kind: 'refused'; readonly code: 'unknown_record' | 'engagement_not_open' };

/**
 * Performs one participant engagement response inside the caller's
 * transaction. The relationship is evaluated here — against the same
 * transaction-local state the write will land in — so a participant removed
 * a moment ago is refused `unknown_record`, indistinguishably from an id
 * that never existed. Attribution derives exclusively from the authenticated
 * person; the timeline record informs every other listed speaker.
 */
export function applyParticipantEngagementResponse(input: {
  readonly lane: ParticipantLane;
  readonly actingPersonId: PersonId;
  readonly act: PortalEngagementRespondInput;
  readonly occurredAt: string;
  readonly newActivityId: () => string;
  readonly ports: ParticipantPortalActPorts;
}): ParticipantEngagementResponseApplication {
  const { lane, ports } = input;
  const relationship = ports.relationships.evaluate({
    lane,
    personId: input.actingPersonId
  });
  const access = participantSubjectAccess(relationship, {
    kind: 'engagement', id: input.act.engagementId
  });
  if (!access.allowed) return Object.freeze({ kind: 'refused', code: 'unknown_record' });

  const scope: EngagementScopeDto = { workspaceId: lane.workspaceId, eventId: lane.eventId };
  const planned = planParticipantEngagementGroupAct({
    scope,
    actingPersonId: input.actingPersonId,
    engagementId: input.act.engagementId,
    response: input.act.response,
    occurredAt: input.occurredAt,
    engagements: ports.engagements
  });
  if (planned.kind === 'refused') return Object.freeze({ kind: 'refused', code: planned.code });

  ports.writer.applyEngagementResponsePlan(planned.actorPlan);
  for (const plan of planned.siblingPlans) ports.writer.applyEngagementResponsePlan(plan);

  let activity: ParticipantPortalActivityRecord | null = null;
  if (planned.submissionId !== null) {
    activity = composeEngagementResponseActivity({
      activityId: input.newActivityId(),
      submissionId: planned.submissionId,
      occurredAt: input.occurredAt,
      actingPersonId: input.actingPersonId,
      actorDisplayName: displayNameOf(ports.presentation, lane, input.actingPersonId),
      sessionTitle: sessionTitleOf(ports.presentation, lane, planned.sessionId),
      response: input.act.response,
      groupSize: planned.groupPersonIds.length
    });
    ports.activity.append({ lane, record: activity });
  }

  return Object.freeze({
    kind: 'responded',
    engagement: projectEngagement({
      head: planned.actorPlan.after,
      viewerPersonId: input.actingPersonId,
      groupPersonIds: planned.groupPersonIds,
      portal: ports.presentation,
      lane
    }),
    act: planned,
    activity
  });
}

// ---------------------------------------------------------------------------
// Contribution contract (what the transaction adapter must hand the engine)
// ---------------------------------------------------------------------------

const canonicalUuid = z.uuid().refine((value) => value === value.toLowerCase());
const canonicalInstant = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}, 'Expected a canonical UTC instant.');
const nullDetailSchema = z.null();

export const participantEngagementResponseDomainContributionSchema = z.strictObject({
  kind: z.literal('participant_engagement_response'),
  preparationHandle: canonicalUuid,
  workspaceId: canonicalUuid,
  eventId: canonicalUuid,
  personId: canonicalUuid,
  participantIdentityId: canonicalUuid,
  sessionId: canonicalUuid,
  submissionId: canonicalUuid.nullable(),
  response: portalEngagementResponseSchema,
  /** Every head this act moved, actor first, then siblings by person id. */
  respondedEngagementIds: z.array(canonicalUuid).min(1).max(500),
  activityId: canonicalUuid.nullable(),
  occurredAt: canonicalInstant
});

export const participantEngagementResponseEffectContributionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('engagement_response'),
    engagementId: canonicalUuid,
    /** The engaged person whose head moved. */
    personId: canonicalUuid,
    /** Server-derived confirmation attribution; null for a decline. */
    attribution: z.enum(['self', 'co_speaker']).nullable(),
    version: z.number().int().positive()
  }),
  z.strictObject({
    kind: z.literal('portal_timeline'),
    activityId: canonicalUuid,
    submissionId: canonicalUuid,
    occurredAt: canonicalInstant
  })
]);

const respondSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: portalEngagementSchema }),
  domain: participantEngagementResponseDomainContributionSchema,
  effectContributions: z.array(participantEngagementResponseEffectContributionSchema).min(1).max(501)
}).superRefine((contribution, context) => {
  const data = contribution.result.data;
  const domain = contribution.domain;
  const responses = contribution.effectContributions.filter(
    (child) => child.kind === 'engagement_response'
  );
  const timelines = contribution.effectContributions.filter(
    (child) => child.kind === 'portal_timeline'
  );
  const respondedIds = responses.map((child) => child.engagementId);
  const coherent = data.sessionId === domain.sessionId
    && data.submissionId === domain.submissionId
    && domain.respondedEngagementIds.includes(data.id)
    && respondedIds.length === domain.respondedEngagementIds.length
    && respondedIds.every((id, index) => id === domain.respondedEngagementIds[index])
    && new Set(respondedIds).size === respondedIds.length
    && responses.every((child) => domain.response === 'decline'
      ? child.attribution === null
      : child.attribution === (child.personId === domain.personId ? 'self' : 'co_speaker'))
    && (domain.activityId === null
      ? timelines.length === 0
      : timelines.length === 1
        && timelines[0]!.activityId === domain.activityId
        && timelines[0]!.submissionId === domain.submissionId
        && timelines[0]!.occurredAt === domain.occurredAt)
    && (domain.activityId === null || domain.submissionId !== null);
  if (!coherent) {
    context.addIssue({ code: 'custom', message: 'Participant response evidence is incoherent.' });
  }
});

const respondOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const allowed = new Set([
    'access_denied:portal.unknown_record',
    'conflict:portal.engagement_not_open'
  ]);
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || outcome.subjects.length !== 0
      || outcome.detail !== null) {
    context.addIssue({ code: 'custom', message: 'Participant response refusal is invalid.' });
  }
});

export const participantEngagementRespondContributionSchema = z.union([
  respondSuccessContributionSchema,
  respondOutcomeContributionSchema
]);

export type ParticipantEngagementRespondContribution =
  z.infer<typeof participantEngagementRespondContributionSchema>;

// ---------------------------------------------------------------------------
// Preparation seam (composition supplies transaction-bound ports)
// ---------------------------------------------------------------------------

export interface ParticipantPortalPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly effectContributions: readonly unknown[];
}

/** Transaction-owned preparation for one participant response commit. */
export interface ParticipantPortalPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): ParticipantPortalPreparedContribution;
}

export interface ParticipantPortalPreparationIds {
  newPreparationHandle(): string;
  newActivityId(): string;
}

const REFUSAL_OUTCOMES = Object.freeze({
  unknown_record: Object.freeze({
    class: 'access_denied' as const,
    kind: 'portal.unknown_record',
    retryable: false,
    subjects: Object.freeze([]),
    detail: null,
    detailSchemaVersion: 1
  }),
  engagement_not_open: Object.freeze({
    class: 'conflict' as const,
    kind: 'portal.engagement_not_open',
    retryable: false,
    subjects: Object.freeze([]),
    detail: null,
    detailSchemaVersion: 1
  })
});

/**
 * The complete respond preparation over transaction-bound ports: parse the
 * wire act, apply the group act, and assemble the pinned contribution. The
 * acting person comes from the sealed invocation's actor — resolved by the
 * participant authority path — and from nowhere else.
 */
export function createParticipantPortalRespondPreparation(input: {
  readonly lane: ParticipantLane;
  readonly ports: ParticipantPortalActPorts;
  readonly ids: ParticipantPortalPreparationIds;
}): ParticipantPortalPreparation {
  return Object.freeze({
    prepare({ businessInput, context }: {
      readonly businessInput: unknown;
      readonly context: EffectInvocationContext;
    }): ParticipantPortalPreparedContribution {
      const actor = context.actor;
      if (actor.kind !== 'participant') {
        throw new TypeError('participant_portal_actor_invalid');
      }
      const act = portalEngagementRespondInputSchema.parse(businessInput);
      const occurredAt = parseInstant(context.receivedAt);
      const application = applyParticipantEngagementResponse({
        lane: input.lane,
        actingPersonId: actor.personId,
        act,
        occurredAt,
        newActivityId: () => input.ids.newActivityId(),
        ports: input.ports
      });
      if (application.kind === 'refused') {
        return Object.freeze({
          result: Object.freeze({ kind: 'outcome', outcome: REFUSAL_OUTCOMES[application.code] }),
          domain: null,
          effectContributions: Object.freeze([])
        });
      }
      const planned = application.act;
      const plans = [planned.actorPlan, ...planned.siblingPlans];
      const respondedEngagementIds = plans.map((plan) => plan.after.id);
      const attributionOf = (plan: EngagementMutationPlanDto): 'self' | 'co_speaker' | null =>
        plan.input.action === 'record_confirmation'
          ? (plan.input.attribution === 'self' ? 'self' : 'co_speaker')
          : null;
      const effectContributions: unknown[] = plans.map((plan) => Object.freeze({
        kind: 'engagement_response',
        engagementId: plan.after.id,
        personId: plan.after.personId,
        attribution: attributionOf(plan),
        version: plan.after.version
      }));
      if (application.activity !== null) {
        effectContributions.push(Object.freeze({
          kind: 'portal_timeline',
          activityId: application.activity.activityId,
          submissionId: application.activity.submissionId,
          occurredAt: application.activity.occurredAt
        }));
      }
      return Object.freeze({
        result: Object.freeze({ kind: 'success', data: application.engagement }),
        domain: Object.freeze({
          kind: 'participant_engagement_response',
          preparationHandle: input.ids.newPreparationHandle(),
          workspaceId: input.lane.workspaceId,
          eventId: input.lane.eventId,
          personId: actor.personId,
          participantIdentityId: actor.participantIdentityId,
          sessionId: planned.sessionId,
          submissionId: planned.submissionId,
          response: planned.response,
          respondedEngagementIds: Object.freeze(respondedEngagementIds),
          activityId: application.activity?.activityId ?? null,
          occurredAt
        }),
        effectContributions: Object.freeze(effectContributions)
      });
    }
  });
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: ParticipantPortalPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealParticipantPortalPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: ParticipantPortalPreparation;
}): EffectHandlerSnapshot {
  if (!isSealedInvocationContext(input.context) || input.context.operation.effect !== 'commit') {
    throw new TypeError('participant_portal_preparation_context_invalid');
  }
  if (typeof input.preparation.prepare !== 'function') {
    throw new TypeError('participant_portal_preparation_invalid');
  }
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('participant_portal_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'participant_engagement_response', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

function createParticipantRespondHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const handlerCapability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'commit' as const,
    handlerCapability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed
          || !sameReference(sealed.capability, handlerCapability)
          || sealed.context !== context
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_participant_portal_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('participant_portal_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return {
          result: contribution.result,
          domain: contribution.domain,
          effectContributions: [...contribution.effectContributions]
        };
      } catch (error) {
        sealed.phase = 'spent';
        throw error;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Operation registry module
// ---------------------------------------------------------------------------

export const participantPortalSnapshotCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: portalSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const participantEngagementRespondCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: portalEngagementSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: parseContractVersion(1) });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

type ParticipantAccessLane = Extract<OperationAccessLane, { readonly kind: 'participant' }>;

function participantAccessLane(policy: VersionedAccessPolicyRef): ParticipantAccessLane {
  const lane = parseOperationAccessLane({
    kind: 'participant', surface: 'participant_http', policy
  });
  if (lane.kind !== 'participant') throw new TypeError('participant_portal_lane_invalid');
  return lane;
}

function participantLaneScopeResolver(lane: ParticipantLane): InvocationScopeResolver {
  return Object.freeze({
    resolve() {
      return Object.freeze({
        workspaceId: lane.workspaceId,
        eventId: lane.eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: lane.workspaceId },
          { kind: 'event' as const, id: lane.eventId }
        ]),
        resolutionEvidenceIds: Object.freeze(['portal.lane.event'])
      });
    }
  });
}

function assertPolicy(
  actual: VersionedAccessPolicyRef,
  expected: VersionedAccessPolicyRef,
  code: string
): void {
  if (actual.key !== expected.key || actual.version !== expected.version) {
    throw new TypeError(code);
  }
}

export interface ParticipantPortalOperationIds {
  newInvocationId(): InvocationId;
}

export interface ParticipantPortalOperationCrypto {
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

export interface CreateParticipantPortalOperationModuleInput {
  readonly lane: ParticipantLane;
  readonly policies: {
    readonly read: VersionedAccessPolicyRef;
    readonly act: VersionedAccessPolicyRef;
  };
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: ParticipantPortalOperationIds;
  readonly crypto: ParticipantPortalOperationCrypto;
  readonly identities: ParticipantIdentityDirectory;
  readonly relationships: ParticipantRelationshipSource;
  readonly engagements: EngagementReadPort;
  readonly portal: ParticipantPortalReadSource;
}

const schemas = Object.freeze({
  snapshotInput: PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
  snapshotProjected: PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
  respondInput: PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.engagementRespond.inputSchema,
  respondProjected: PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.engagementRespond.resultSchema
});

const refs = Object.freeze({
  snapshotContext: ref('context.portal.snapshot-read'),
  snapshotAutonomy: ref('autonomy.portal.snapshot-read'),
  snapshotCapability: ref('capability.portal.snapshot-read'),
  snapshotHandler: ref('handler.portal.snapshot-read'),
  snapshotProjection: ref('projection.portal.snapshot-read.participant'),
  snapshotCanonical: 'schema.portal.snapshot-read.canonical-result',
  trace: ref('trace.portal.snapshot-read'),
  traceRecordProfile: ref('record-profile.portal.read-operational-trace'),
  respondContext: ref('context.portal.engagement-respond'),
  respondAutonomy: ref('autonomy.portal.engagement-respond'),
  respondHandler: ref('handler.portal.engagement-respond'),
  respondProjection: ref('projection.portal.engagement-respond.participant'),
  respondContribution: 'schema.portal.engagement-respond.contribution',
  respondCanonical: 'schema.portal.engagement-respond.canonical-result',
  respondConcurrency: ref('concurrency.portal.engagement-respond'),
  respondFamily: ref('portal.engagement-respond.execution-family'),
  respondPhase: ref('portal.engagement-respond.phase.single-uow'),
  respondTerminalization: ref('portal.engagement-respond.terminalization'),
  respondRisk: ref('portal.engagement-respond.risk-resolver'),
  respondAutonomyEvidence: ref('portal.engagement-respond.autonomy-evidence'),
  respondApproval: ref('portal.engagement-respond.approval-resolver'),
  respondPreflight: ref('portal.engagement-respond.autonomy-preflight'),
  audit: ref('audit.portal.engagement-respond'),
  auditRecordProfile: ref('record-profile.portal.operation-audit'),
  keySource: ref('idempotency.participant-header'),
  nullDetail: 'schema.portal.operation.null-detail'
});

/**
 * Registers the two participant-portal operations on `participant_http` —
 * the reserved binding arm's first consumer. The composition supplies the
 * participant `CurrentAuthorityResolver`
 * ({@link createParticipantCurrentAuthorityResolver}) and, at the effect
 * boundary, seals {@link createParticipantPortalRespondPreparation} over the
 * open transaction's ports.
 */
export function createParticipantPortalOperationModule(
  input: CreateParticipantPortalOperationModuleInput
): OperationRegistryModule {
  assertPolicy(input.policies.read, PORTAL_PARTICIPANT_READ_ACCESS_POLICY,
    'portal_participant_read_policy_catalog_mismatch');
  assertPolicy(input.policies.act, PORTAL_PARTICIPANT_ACT_ACCESS_POLICY,
    'portal_participant_act_policy_catalog_mismatch');
  const lane = input.lane;
  const readLane = participantAccessLane(input.policies.read);
  const actLane = participantAccessLane(input.policies.act);
  const scopeResolver = participantLaneScopeResolver(lane);

  const snapshotCanonical = schemaRef(
    refs.snapshotCanonical, participantPortalSnapshotCanonicalResultSchema
  );
  const respondCanonical = schemaRef(
    refs.respondCanonical, participantEngagementRespondCanonicalResultSchema
  );
  const respondContribution = schemaRef(
    refs.respondContribution, participantEngagementRespondContributionSchema
  );
  const nullDetail = schemaRef(refs.nullDetail, nullDetailSchema);

  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: nullDetail
  }));

  const snapshotAutonomy = createOperationAutonomyPolicy({
    definition: refs.snapshotAutonomy,
    operation: PORTAL_SNAPSHOT_READ_OPERATION,
    riskFloor: 'low', unattendedRiskCeiling: 'low',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
  const snapshotContext = createReadInvocationContextBuilder({
    reference: refs.snapshotContext,
    operation: PORTAL_SNAPSHOT_READ_OPERATION,
    effect: 'read',
    lanes: [readLane],
    scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const snapshotCapability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.snapshotCapability,
    openSnapshot(context: ReadInvocationContext) {
      const actor = context.actor;
      if (actor.kind !== 'participant') throw new TypeError('participant_portal_actor_invalid');
      const identity = input.identities.get({
        lane, participantIdentityId: actor.participantIdentityId
      });
      if (identity === undefined || identity.standing !== 'active') {
        return Object.freeze({ kind: 'authority_gone' as const });
      }
      return Object.freeze({
        kind: 'ready' as const,
        viewer: Object.freeze({
          personId: identity.personId,
          displayName: identity.displayName,
          email: identity.displayEmail
        }),
        relationship: input.relationships.evaluate({ lane, personId: identity.personId })
      });
    }
  });

  const respondAutonomy = createOperationAutonomyPolicy({
    definition: refs.respondAutonomy,
    operation: PORTAL_ENGAGEMENT_RESPOND_OPERATION,
    riskFloor: 'normal', unattendedRiskCeiling: 'normal',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
  const respondContext = createEffectInvocationContextBuilder({
    reference: refs.respondContext,
    operation: PORTAL_ENGAGEMENT_RESPOND_OPERATION,
    effect: 'commit',
    lanes: [actLane],
    scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    requestHashProfile: PORTAL_ENGAGEMENT_RESPOND_REQUEST_HASH_PROFILE,
    requestHashSealer: input.crypto.requestHashSealer,
    idempotencyCredentialProfile: input.crypto.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.crypto.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const respondFamily = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.respondFamily, phase: refs.respondPhase
  });
  const respondTerminalization = createTerminalizationResolverRegistration({
    reference: refs.respondTerminalization,
    operation: PORTAL_ENGAGEMENT_RESPOND_OPERATION,
    phase: refs.respondPhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const respondPhase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.respondPhase,
    family: refs.respondFamily,
    operation: PORTAL_ENGAGEMENT_RESPOND_OPERATION,
    effect: 'commit',
    handler: refs.respondHandler,
    handlerCapability: PORTAL_ENGAGEMENT_RESPOND_HANDLER_CAPABILITY,
    contributionSchema: respondContribution,
    terminalization: refs.respondTerminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: Object.freeze({
      class: 'conflict' as const,
      kind: 'operation.in_progress',
      retryable: true,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });
  const respondRisk = createOperationRiskResolverRegistration({
    reference: refs.respondRisk,
    operation: PORTAL_ENGAGEMENT_RESPOND_OPERATION,
    resolve: () => Object.freeze({
      risk: 'normal' as const,
      consequenceTags: Object.freeze(['engagement-responded']),
      evidenceIds: Object.freeze(['portal.engagement.respond.risk'])
    })
  });
  const respondAutonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.respondAutonomyEvidence,
    operation: PORTAL_ENGAGEMENT_RESPOND_OPERATION,
    resolve: ({ subject }) => {
      const notAfter = parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString());
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]),
        maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt,
        hardBounds: bounds,
        unattendedBounds: bounds,
        spendMicros: 0,
        actionCount: 1,
        completesBy: subject.evaluatedAt,
        proposedAction: Object.freeze({
          key: 'portal.engagement.respond.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const respondApproval = createRenewedApprovalResolverRegistration({
    reference: refs.respondApproval,
    operation: PORTAL_ENGAGEMENT_RESPOND_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const respondPreflight = createAutonomyPreflightRegistration({
    reference: refs.respondPreflight,
    operation: PORTAL_ENGAGEMENT_RESPOND_OPERATION,
    policy: refs.respondAutonomy,
    riskResolver: refs.respondRisk,
    evidenceResolver: refs.respondAutonomyEvidence,
    approvalResolver: refs.respondApproval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const respondHandler = createParticipantRespondHandler({
    reference: refs.respondHandler,
    handlerCapability: PORTAL_ENGAGEMENT_RESPOND_HANDLER_CAPABILITY,
    contributionSchema: respondContribution,
    canonicalResultSchema: respondCanonical
  });

  return Object.freeze({
    id: 'portal.participant-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([snapshotAutonomy, respondAutonomy]),
      schemas: Object.freeze([
        { reference: schemas.snapshotInput, schema: portalSnapshotReadInputSchema },
        { reference: snapshotCanonical, schema: participantPortalSnapshotCanonicalResultSchema },
        { reference: schemas.snapshotProjected, schema: portalSnapshotReadResultSchema },
        { reference: schemas.respondInput, schema: portalEngagementRespondInputSchema },
        { reference: respondContribution, schema: participantEngagementRespondContributionSchema },
        { reference: respondCanonical, schema: participantEngagementRespondCanonicalResultSchema },
        { reference: schemas.respondProjected, schema: portalEngagementRespondResultSchema },
        { reference: nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([snapshotContext]),
      readCapabilities: Object.freeze([snapshotCapability]),
      handlers: Object.freeze([{
        reference: refs.snapshotHandler,
        readCapability: refs.snapshotCapability,
        canonicalResultSchema: snapshotCanonical,
        handle: ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => {
          portalSnapshotReadInputSchema.parse(businessInput);
          if (snapshot.kind === 'authority_gone') {
            return Object.freeze({ kind: 'outcome' as const, outcome: authorityOutcome('revoked') });
          }
          if (snapshot.kind !== 'ready') throw new TypeError('participant_portal_snapshot_invalid');
          const viewer = snapshot.viewer as ParticipantPortalViewer;
          const relationship = snapshot.relationship as ParticipantRelationship;
          return Object.freeze({
            kind: 'success' as const,
            data: assembleParticipantPortalSnapshot({
              lane,
              viewer,
              relationship,
              engagements: input.engagements,
              portal: input.portal
            })
          });
        }
      }]),
      projections: Object.freeze([
        {
          reference: refs.snapshotProjection,
          canonicalResultSchema: snapshotCanonical,
          projectedResultSchema: schemas.snapshotProjected,
          project: (candidate: unknown) =>
            participantPortalSnapshotCanonicalResultSchema.parse(candidate)
        },
        {
          reference: refs.respondProjection,
          canonicalResultSchema: respondCanonical,
          projectedResultSchema: schemas.respondProjected,
          project: (candidate: unknown) =>
            participantEngagementRespondCanonicalResultSchema.parse(candidate)
        }
      ]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.traceRecordProfile
      }]),
      operationAuditTargets: Object.freeze([{
        reference: refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([
        {
          reference: refs.traceRecordProfile,
          kind: 'canonical_json' as const,
          maximumBytes: 262_144
        },
        {
          reference: refs.auditRecordProfile,
          kind: 'canonical_json' as const,
          maximumBytes: 262_144
        }
      ]),
      operations: Object.freeze([{
        ...PORTAL_SNAPSHOT_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read the signed-in participant’s own portal world: submissions, engagements, files, resources, and profile.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.snapshotAutonomy,
        consequenceTags: [],
        inputSchema: schemas.snapshotInput,
        canonicalResultSchema: snapshotCanonical,
        outcomes: [...accessOutcomes],
        accessLanes: [readLane],
        contextBuilder: refs.snapshotContext,
        readCapability: refs.snapshotCapability,
        handler: refs.snapshotHandler,
        observability: {
          trace: { mode: 'required' as const, target: refs.trace },
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [{
          surface: 'participant_http' as const,
          method: 'GET' as const,
          path: PORTAL_HTTP_PATHS.snapshot,
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.snapshotProjection
        }]
      }]),
      effectContextBuilders: Object.freeze([respondContext]),
      effectHandlers: Object.freeze([respondHandler]),
      effectExecutionFamilies: Object.freeze([respondFamily]),
      effectPhases: Object.freeze([respondPhase]),
      terminalizationResolvers: Object.freeze([respondTerminalization]),
      riskResolvers: Object.freeze([respondRisk]),
      autonomyEvidenceResolvers: Object.freeze([respondAutonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([respondApproval]),
      autonomyPreflights: Object.freeze([respondPreflight]),
      effectOperations: Object.freeze([{
        ...PORTAL_ENGAGEMENT_RESPOND_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Answer one of the participant’s own invitations; under any_participant_acts the answer binds every listed speaker and informs them.',
        effect: 'commit' as const,
        maxRisk: 'normal' as const,
        autonomyPolicy: refs.respondAutonomy,
        consequenceTags: ['engagement-responded'],
        inputSchema: schemas.respondInput,
        contributionSchema: respondContribution,
        canonicalResultSchema: respondCanonical,
        outcomes: [
          {
            class: 'idempotency_conflict' as const,
            kind: 'operation.request_changed',
            retryable: false,
            detailSchema: nullDetail
          },
          ...accessOutcomes,
          {
            class: 'access_denied' as const,
            kind: 'portal.unknown_record',
            retryable: false,
            detailSchema: nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'portal.engagement_not_open',
            retryable: false,
            detailSchema: nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress',
            retryable: true,
            detailSchema: nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(nullDetail)
        ],
        accessLanes: [actLane],
        contextBuilder: refs.respondContext,
        handlerCapability: PORTAL_ENGAGEMENT_RESPOND_HANDLER_CAPABILITY,
        handler: refs.respondHandler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.crypto.idempotencyCredentialProfile,
          requestHashProfile: PORTAL_ENGAGEMENT_RESPOND_REQUEST_HASH_PROFILE
        },
        concurrency: refs.respondConcurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: refs.respondFamily,
          phase: refs.respondPhase,
          terminalization: refs.respondTerminalization,
          autonomyPreflight: refs.respondPreflight
        },
        bindings: [{
          surface: 'participant_http' as const,
          method: 'POST' as const,
          path: PORTAL_HTTP_PATHS.engagementRespond,
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.respondProjection
        }]
      }])
    })
  });
}
