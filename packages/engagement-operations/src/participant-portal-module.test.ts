import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createEffectInvocationBuilder,
  createOperationRegistry,
  createReadOperationExecutor,
  OperationInputError,
  type EffectInvocationContext,
  type InvocationEvidence
} from '@jooevents/application';
import {
  portalEngagementRespondInputSchema,
  portalSnapshotSchema,
  type EngagementHeadDto,
  type EngagementMutationPlanDto,
  type PortalFileDto,
  type PortalSnapshotDto
} from '@jooevents/contracts';
import type { EngagementReadPort, EngagementScope } from '@jooevents/engagement';
import type {
  ParticipantIdentityDirectory,
  ParticipantIdentityRecord,
  ParticipantLane,
  ParticipantRelationship,
  ParticipantRelationshipSource
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseParticipantIdentityId,
  parseParticipantSessionId,
  parsePersonId,
  parseWorkspaceId,
  type ParticipantIdentityId,
  type ParticipantSessionId,
  type PersonId
} from '@jooevents/kernel';
import {
  applyParticipantEngagementResponse,
  assembleParticipantPortalSnapshot,
  createParticipantCurrentAuthorityResolver,
  createParticipantPortalOperationModule,
  createParticipantPortalRespondPreparation,
  participantEngagementRespondContributionSchema,
  projectPortalTimelineEvent,
  PORTAL_ENGAGEMENT_RESPOND_OPERATION,
  PORTAL_ENGAGEMENT_RESPOND_REQUEST_HASH_PROFILE,
  PORTAL_HTTP_PATHS,
  PORTAL_PARTICIPANT_ACT_ACCESS_POLICY,
  PORTAL_PARTICIPANT_READ_ACCESS_POLICY,
  PORTAL_SNAPSHOT_READ_OPERATION,
  type ParticipantPortalActivityRecord,
  type ParticipantPortalReadSource,
  type ParticipantSessionAuthorityView
} from './participant-portal-module';

const NOW = parseInstant('2026-08-14T12:00:00.000Z');
const INVITED_AT = '2026-08-10T12:00:00.000Z';

const WS = parseWorkspaceId('11111111-1111-4111-8111-111111111111');
const EV = parseEventId('22222222-2222-4222-8222-222222222222');
const lane: ParticipantLane = Object.freeze({ workspaceId: WS, eventId: EV });
const scope: EngagementScope = Object.freeze({ workspaceId: WS, eventId: EV });

const MAYA = parsePersonId('33333333-1111-4111-8111-111111111111');
const ANA = parsePersonId('33333333-2222-4222-8222-222222222222');
const NOAH = parsePersonId('33333333-3333-4333-8333-333333333333');
const PI_MAYA = parseParticipantIdentityId('44444444-1111-4111-8111-111111111111');
const PI_ANA = parseParticipantIdentityId('44444444-2222-4222-8222-222222222222');
const PI_NOAH = parseParticipantIdentityId('44444444-3333-4333-8333-333333333333');
const SES_MAYA = parseParticipantSessionId('55555555-1111-4111-8111-111111111111');
const SES_ANA = parseParticipantSessionId('55555555-2222-4222-8222-222222222222');
const SES_NOAH = parseParticipantSessionId('55555555-3333-4333-8333-333333333333');

const S1 = '66666666-1111-4111-8111-111111111111';
const S2 = '66666666-2222-4222-8222-222222222222';
const S3 = '66666666-3333-4333-8333-333333333333';
const SUB_A = '77777777-1111-4111-8111-111111111111';
const SUB_B = '77777777-2222-4222-8222-222222222222';
const ENG_MAYA_S1 = '88888888-1111-4111-8111-111111111111';
const ENG_ANA_S1 = '88888888-2222-4222-8222-222222222222';
const ENG_NOAH_S2 = '88888888-3333-4333-8333-333333333333';
const FIL_S1 = '99999999-1111-4111-8111-111111111111';
const FIL_S2 = '99999999-2222-4222-8222-222222222222';
const FIL_S3 = '99999999-3333-4333-8333-333333333333';

const DISPLAY_NAMES: Record<string, string> = {
  [MAYA]: 'Maya Lindqvist',
  [ANA]: 'Ana Duarte',
  [NOAH]: 'Noah Petrov'
};
const SESSION_TITLES: Record<string, string> = {
  [S1]: 'Panel: Durable Agent Infrastructure',
  [S2]: 'The Cheapest Possible Eval Harness',
  [S3]: 'Closing Keynote'
};

function invitedHead(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly personId: string;
  readonly submissionId: string | null;
}): EngagementHeadDto {
  return {
    schemaVersion: 1,
    id: input.id,
    scope: { workspaceId: WS, eventId: EV },
    sessionId: input.sessionId,
    personId: input.personId,
    submissionId: input.submissionId,
    seededByDecision: input.submissionId === null
      ? null
      : { version: 1, digestSha256: 'a'.repeat(64) },
    state: 'invited',
    invitedAt: INVITED_AT,
    respondBy: null,
    confirmation: null,
    cancellationRequest: null,
    cancelledAt: null,
    source: input.submissionId === null
      ? { kind: 'organizer', id: '00000000-aaaa-4aaa-8aaa-000000000001', version: 1 }
      : { kind: 'submission', id: input.submissionId, version: 1 },
    version: 1
  } as EngagementHeadDto;
}

interface World {
  readonly heads: Map<string, EngagementHeadDto>;
  readonly submissionSpeakers: Map<string, string[]>;
  readonly activity: ParticipantPortalActivityRecord[];
  readonly identities: Map<string, ParticipantIdentityRecord>;
  readonly sessions: Map<string, { participantIdentityId: ParticipantIdentityId; personId: PersonId }>;
  readonly engagements: EngagementReadPort & {
    applyEngagementResponsePlan(plan: EngagementMutationPlanDto): void;
  };
  readonly relationships: ParticipantRelationshipSource;
  readonly identityDirectory: ParticipantIdentityDirectory;
  readonly sessionView: ParticipantSessionAuthorityView;
  readonly portal: ParticipantPortalReadSource;
}

function identityRecord(
  participantIdentityId: ParticipantIdentityId,
  personId: PersonId,
  email: string
): ParticipantIdentityRecord {
  return Object.freeze({
    participantIdentityId,
    personId,
    lane,
    normalizedEmail: email,
    displayEmail: email,
    displayName: DISPLAY_NAMES[personId]!,
    standing: 'active',
    origin: 'portal_ceremony',
    mintedAt: NOW
  });
}

function createWorld(): World {
  const heads = new Map<string, EngagementHeadDto>([
    [ENG_MAYA_S1, invitedHead({ id: ENG_MAYA_S1, sessionId: S1, personId: MAYA, submissionId: SUB_A })],
    [ENG_ANA_S1, invitedHead({ id: ENG_ANA_S1, sessionId: S1, personId: ANA, submissionId: SUB_A })],
    [ENG_NOAH_S2, invitedHead({ id: ENG_NOAH_S2, sessionId: S2, personId: NOAH, submissionId: SUB_B })]
  ]);
  const submissionSpeakers = new Map<string, string[]>([
    [SUB_A, [MAYA, ANA]],
    [SUB_B, [NOAH]]
  ]);
  const activity: ParticipantPortalActivityRecord[] = [];
  const identities = new Map<string, ParticipantIdentityRecord>([
    [PI_MAYA, identityRecord(PI_MAYA, MAYA, 'maya@example.com')],
    [PI_ANA, identityRecord(PI_ANA, ANA, 'ana@example.com')],
    [PI_NOAH, identityRecord(PI_NOAH, NOAH, 'noah@example.com')]
  ]);
  const sessions = new Map<string, { participantIdentityId: ParticipantIdentityId; personId: PersonId }>([
    [SES_MAYA, { participantIdentityId: PI_MAYA, personId: MAYA }],
    [SES_ANA, { participantIdentityId: PI_ANA, personId: ANA }],
    [SES_NOAH, { participantIdentityId: PI_NOAH, personId: NOAH }]
  ]);

  const engagements: World['engagements'] = {
    readEngagementHead(requested, engagementId) {
      const head = heads.get(engagementId);
      if (!head) return undefined;
      if (head.scope.workspaceId !== requested.workspaceId
          || head.scope.eventId !== requested.eventId) return undefined;
      return head;
    },
    readSessionPersonEngagement(requested, sessionId, personId) {
      return [...heads.values()].find((head) =>
        head.scope.workspaceId === requested.workspaceId
        && head.scope.eventId === requested.eventId
        && head.sessionId === sessionId && head.personId === personId);
    },
    listSeededEngagements(requested, sessionId, submissionId) {
      return [...heads.values()]
        .filter((head) => head.scope.workspaceId === requested.workspaceId
          && head.scope.eventId === requested.eventId
          && head.sessionId === sessionId && head.submissionId === submissionId)
        .sort((left, right) => left.personId < right.personId ? -1 : 1);
    },
    applyEngagementResponsePlan(plan) {
      const current = heads.get(plan.after.id);
      if (!current || current.version !== plan.before.version) {
        throw new TypeError('stale_engagement_write');
      }
      heads.set(plan.after.id, plan.after);
    }
  };

  const relationships: ParticipantRelationshipSource = {
    evaluate({ personId }) {
      const submissionIds = [...submissionSpeakers.entries()]
        .filter(([, speakers]) => speakers.includes(personId))
        .map(([submissionId]) => submissionId)
        .sort();
      const engagementIds = [...heads.values()]
        .filter((head) => head.personId === personId && head.state !== 'cancelled')
        .map((head) => head.id)
        .sort();
      return submissionIds.length === 0 && engagementIds.length === 0
        ? { kind: 'none' }
        : { kind: 'related', submissionIds, engagementIds };
    }
  };

  const identityDirectory: ParticipantIdentityDirectory = {
    resolveByEmail({ normalizedEmail }) {
      return [...identities.values()].find((record) => record.normalizedEmail === normalizedEmail);
    },
    get({ participantIdentityId }) {
      return identities.get(participantIdentityId);
    },
    mint() {
      throw new TypeError('mint_not_expected_in_this_test');
    }
  };

  const sessionView: ParticipantSessionAuthorityView = {
    readCurrentSession({ participantSessionId }) {
      return sessions.get(participantSessionId);
    }
  };

  const files: Record<string, PortalFileDto[]> = {
    [S1]: [{ id: FIL_S1, name: 'panel-brief.pdf', sizeBytes: 1024, version: 1, uploadedAt: INVITED_AT, taskId: null }],
    [S2]: [{ id: FIL_S2, name: 'noah-slides.pdf', sizeBytes: 2048, version: 1, uploadedAt: INVITED_AT, taskId: null }],
    [S3]: [{ id: FIL_S3, name: 'keynote-notes.pdf', sizeBytes: 512, version: 1, uploadedAt: INVITED_AT, taskId: null }]
  };

  const portal: ParticipantPortalReadSource = {
    readPortalEvent() {
      return {
        id: EV,
        name: 'AIE NYC 2026',
        timezone: 'America/New_York',
        cfpClosesAt: '2026-09-01T03:59:00.000Z',
        closePolicy: 'soft'
      };
    },
    readSubmissionMaterial({ submissionId }) {
      if (submissionId === SUB_A) {
        return {
          id: SUB_A,
          title: 'Durable Agent Infrastructure',
          formVersion: 3,
          answers: [{ fieldId: 'fld-abstract', label: 'Abstract', value: 'Panels all the way down.' }],
          target: { kind: 'collecting_session', sessionId: S1, name: SESSION_TITLES[S1]! },
          status: 'accepted',
          statusNotifiedAt: INVITED_AT,
          submittedAt: '2026-06-20T19:47:00.000Z',
          editableUntilClose: false,
          late: false,
          appeal: { kind: 'unavailable' }
        };
      }
      if (submissionId === SUB_B) {
        return {
          id: SUB_B,
          title: 'The Cheapest Possible Eval Harness',
          formVersion: 3,
          answers: [{ fieldId: 'fld-abstract', label: 'Abstract', value: 'Grade nothing by hand.' }],
          target: { kind: 'new_session' },
          status: 'accepted',
          statusNotifiedAt: INVITED_AT,
          submittedAt: '2026-07-02T13:31:00.000Z',
          editableUntilClose: false,
          late: true,
          appeal: { kind: 'unavailable' }
        };
      }
      return undefined;
    },
    listSubmissionSpeakerPersonIds({ submissionId }) {
      return [...(submissionSpeakers.get(submissionId) ?? [])].sort();
    },
    readSessionTitle({ sessionId }) {
      return SESSION_TITLES[sessionId];
    },
    readPersonDisplayName({ personId }) {
      return DISPLAY_NAMES[personId];
    },
    listSessionFiles({ sessionId }) {
      return files[sessionId] ?? [];
    },
    listEventResources() {
      return [{
        id: 'res-guide',
        title: 'Speaker guide',
        kind: 'link',
        url: 'https://example.invalid/guide',
        detail: null
      }];
    },
    readProfile({ personId }) {
      return {
        fields: [{
          id: 'prf-name',
          label: 'Name',
          value: DISPLAY_NAMES[personId] ?? 'Unknown',
          kind: 'text',
          access: { kind: 'editable' }
        }]
      };
    },
    listSubmissionActivity({ submissionId }) {
      return activity.filter((record) => record.submissionId === submissionId);
    }
  };

  return {
    heads, submissionSpeakers, activity, identities, sessions,
    engagements, relationships, identityDirectory, sessionView, portal
  };
}

const profile = Object.freeze({ key: 'portal-operation-test', version: parseContractVersion(1) });

function createModule(world: World) {
  return createParticipantPortalOperationModule({
    lane,
    policies: {
      read: PORTAL_PARTICIPANT_READ_ACCESS_POLICY,
      act: PORTAL_PARTICIPANT_ACT_ACCESS_POLICY
    },
    currentAuthority: createParticipantCurrentAuthorityResolver({
      lane,
      policies: [PORTAL_PARTICIPANT_READ_ACCESS_POLICY, PORTAL_PARTICIPANT_ACT_ACCESS_POLICY],
      sessions: world.sessionView,
      identities: world.identityDirectory,
      relationships: world.relationships
    }),
    clock: { now: () => NOW },
    ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: {
        seal: (bytes: Uint8Array) => Object.freeze({
          verifierProfile: PORTAL_ENGAGEMENT_RESPOND_REQUEST_HASH_PROFILE,
          verifierSha256: createHash('sha256').update('sealed:').update(bytes).digest('hex')
        })
      } as never,
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal: (raw: string) => Object.freeze({
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`portal-key:${raw}`).digest('hex')
        })
      }
    },
    identities: world.identityDirectory,
    relationships: world.relationships,
    engagements: world.engagements,
    portal: world.portal
  });
}

function participantEvidence(participantSessionId: ParticipantSessionId): InvocationEvidence {
  return {
    kind: 'participant',
    surface: 'participant_http',
    client: { key: 'portal-web' },
    participantSessionId
  };
}

async function readSnapshotThroughExecutor(
  world: World,
  participantSessionId: ParticipantSessionId
) {
  const registry = await createOperationRegistry(createModule(world).source);
  const executor = createReadOperationExecutor(registry, {
    operationalTrace: { emit: () => {} },
    immutableAudit: { append: () => {} },
    clock: { now: () => NOW },
    newInvocationId: () => parseInvocationId(crypto.randomUUID())
  });
  return executor.execute({
    operationName: PORTAL_SNAPSHOT_READ_OPERATION.name,
    operationVersion: PORTAL_SNAPSHOT_READ_OPERATION.version,
    surface: 'participant_http',
    correlationId: crypto.randomUUID(),
    businessInput: {},
    verifiedEvidence: participantEvidence(participantSessionId)
  });
}

function successSnapshot(result: unknown): PortalSnapshotDto {
  const value = result as { kind: string; data?: unknown };
  expect(value.kind).toBe('success');
  return portalSnapshotSchema.parse(value.data);
}

function act(world: World, personId: PersonId, engagementId: string, response: 'confirm' | 'decline') {
  let issued = 0;
  return applyParticipantEngagementResponse({
    lane,
    actingPersonId: personId,
    act: { engagementId, response },
    occurredAt: NOW,
    newActivityId: () => `aaaaaaa${(issued += 1)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    ports: {
      relationships: world.relationships,
      engagements: world.engagements,
      writer: world.engagements,
      activity: { append: ({ record }) => { world.activity.push(record); } },
      presentation: world.portal
    }
  });
}

describe('participant_http registration (first consumer of the reserved arm)', () => {
  test('registers the snapshot read and the respond commit on participant_http only', async () => {
    const registry = await createOperationRegistry(createModule(createWorld()).source);
    expect(registry.participantHttpBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path,
      input: binding.input
    }))).toEqual([{
      operation: `${PORTAL_SNAPSHOT_READ_OPERATION.name}@1`,
      method: 'GET',
      path: PORTAL_HTTP_PATHS.snapshot,
      input: 'query'
    }]);
    expect(registry.participantHttpEffectBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path,
      input: binding.input
    }))).toEqual([{
      operation: `${PORTAL_ENGAGEMENT_RESPOND_OPERATION.name}@1`,
      method: 'POST',
      path: PORTAL_HTTP_PATHS.engagementRespond,
      input: 'body'
    }]);
    // The reserved arm stays isolated: nothing leaks onto the other surfaces.
    expect(registry.operatorHttpBindings).toEqual([]);
    expect(registry.publicHttpBindings).toEqual([]);
    expect(registry.operatorHttpEffectBindings).toEqual([]);
    expect(registry.publicHttpEffectBindings).toEqual([]);

    const respond = registry.safeManifest.operations.find(
      (operation) => operation.name === PORTAL_ENGAGEMENT_RESPOND_OPERATION.name
    );
    expect(respond).toMatchObject({ effect: 'commit', maxRisk: 'normal' });
    const outcomeKeys = (respond as { outcomes: readonly { class: string; kind: string }[] })
      .outcomes.map((outcome) => `${outcome.class}:${outcome.kind}`);
    expect(outcomeKeys).toContain('access_denied:portal.unknown_record');
    expect(outcomeKeys).toContain('conflict:portal.engagement_not_open');
    const bindingSurfaces = registry.safeManifest.operations.flatMap((operation) =>
      operation.enabledBindings.map((binding) => binding.surface));
    expect(new Set(bindingSurfaces)).toEqual(new Set(['participant_http']));
  });
});

describe('portal snapshot read (served end-to-end through the executor)', () => {
  test('serves exactly the participant’s own world and nothing of anyone else’s', async () => {
    const world = createWorld();
    const snapshot = successSnapshot(await readSnapshotThroughExecutor(world, SES_MAYA));
    expect(snapshot.participant).toEqual({
      id: MAYA, displayName: 'Maya Lindqvist', email: 'maya@example.com'
    });
    expect(snapshot.submissions.map((submission) => submission.id)).toEqual([SUB_A]);
    expect(snapshot.engagements.map((engagement) => engagement.id)).toEqual([ENG_MAYA_S1]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.files.map((file) => file.id)).toEqual([FIL_S1]);

    // Cross-person isolation, byte-level: nothing of Noah's world appears.
    const serialized = JSON.stringify(snapshot);
    for (const foreign of [SUB_B, ENG_NOAH_S2, ENG_ANA_S1, NOAH, FIL_S2, FIL_S3,
      'noah@example.com', 'ana@example.com', 'Noah Petrov']) {
      expect(serialized).not.toContain(foreign);
    }
  });

  test('the same lane serves another participant their own isolated world', async () => {
    const world = createWorld();
    const snapshot = successSnapshot(await readSnapshotThroughExecutor(world, SES_NOAH));
    expect(snapshot.participant.id).toBe(NOAH);
    expect(snapshot.submissions.map((submission) => submission.id)).toEqual([SUB_B]);
    expect(snapshot.engagements.map((engagement) => engagement.id)).toEqual([ENG_NOAH_S2]);
    expect(snapshot.files.map((file) => file.id)).toEqual([FIL_S2]);
    const serialized = JSON.stringify(snapshot);
    for (const foreign of [SUB_A, ENG_MAYA_S1, ENG_ANA_S1, MAYA, ANA, FIL_S1, FIL_S3]) {
      expect(serialized).not.toContain(foreign);
    }
  });

  test('a co-speaker sees exactly the D3 scope: shared submission, own engagement, shared-session files', async () => {
    const world = createWorld();
    const snapshot = successSnapshot(await readSnapshotThroughExecutor(world, SES_ANA));
    // Shared submission with the full speaker group.
    expect(snapshot.submissions.map((submission) => submission.id)).toEqual([SUB_A]);
    expect(snapshot.submissions[0]!.speakers.map((speaker) => speaker.participantId))
      .toEqual([MAYA, ANA]);
    expect(snapshot.submissions[0]!.speakerAuthority).toBe('any_participant_acts');
    // Her OWN engagement head — never a co-speaker's row.
    expect(snapshot.engagements.map((engagement) => engagement.id)).toEqual([ENG_ANA_S1]);
    expect(snapshot.engagements[0]!.speakers.map((speaker) => speaker.participantId))
      .toEqual([MAYA, ANA]);
    // Shared-session files only; every other session stays isolated.
    expect(snapshot.files.map((file) => file.id)).toEqual([FIL_S1]);
    const serialized = JSON.stringify(snapshot);
    for (const foreign of [ENG_MAYA_S1, SUB_B, ENG_NOAH_S2, FIL_S2, FIL_S3, 'maya@example.com']) {
      expect(serialized).not.toContain(foreign);
    }
  });

  test('no current session and revoked identity fail closed as typed authority outcomes', async () => {
    const world = createWorld();
    const unknownSession = parseParticipantSessionId('55555555-9999-4999-8999-999999999999');
    const missing = await readSnapshotThroughExecutor(world, unknownSession) as {
      kind: string; outcome?: { class: string; kind: string };
    };
    expect(missing.kind).toBe('outcome');
    expect(missing.outcome).toMatchObject({ class: 'access_denied', kind: 'authority.missing' });

    world.identities.set(PI_MAYA, { ...world.identities.get(PI_MAYA)!, standing: 'revoked' });
    const revoked = await readSnapshotThroughExecutor(world, SES_MAYA) as {
      kind: string; outcome?: { class: string; kind: string };
    };
    expect(revoked.kind).toBe('outcome');
    expect(revoked.outcome).toMatchObject({ class: 'access_denied', kind: 'authority.revoked' });
  });

  test('removal bites the very next read: the relationship is re-evaluated per request', async () => {
    const world = createWorld();
    const before = successSnapshot(await readSnapshotThroughExecutor(world, SES_ANA));
    expect(before.submissions.map((submission) => submission.id)).toEqual([SUB_A]);

    // Organizer-side removal: Ana leaves the submission group and her
    // engagement is cancelled. Her session is untouched and still live.
    world.submissionSpeakers.set(SUB_A, [MAYA]);
    const anaHead = world.heads.get(ENG_ANA_S1)!;
    world.heads.set(ENG_ANA_S1, {
      ...anaHead, state: 'cancelled', cancelledAt: NOW, version: anaHead.version + 1
    });

    const after = successSnapshot(await readSnapshotThroughExecutor(world, SES_ANA));
    expect(after.submissions).toEqual([]);
    expect(after.engagements).toEqual([]);
    expect(after.files).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(SUB_A);
  });
});

describe('engagement response act (any_participant_acts under D3)', () => {
  test('confirm binds the whole seeded group with server-derived attribution', () => {
    const world = createWorld();
    const application = act(world, MAYA, ENG_MAYA_S1, 'confirm');
    expect(application.kind).toBe('responded');

    const maya = world.heads.get(ENG_MAYA_S1)!;
    const ana = world.heads.get(ENG_ANA_S1)!;
    expect(maya.state).toBe('confirmed');
    expect(maya.confirmation).toMatchObject({ attribution: 'self', personId: MAYA, recordedByUserId: null });
    expect(ana.state).toBe('confirmed');
    expect(ana.confirmation).toMatchObject({ attribution: 'co_speaker', personId: MAYA, recordedByUserId: null });
    // Noah's unrelated engagement never moves.
    expect(world.heads.get(ENG_NOAH_S2)!.state).toBe('invited');

    if (application.kind !== 'responded') throw new Error('unreachable');
    expect(application.engagement.status).toBe('confirmed');
    expect(application.engagement.confirmation).toEqual({ by: 'you', at: NOW });
    expect(application.act.informedPersonIds).toEqual([ANA]);
  });

  test('the acting co-speaker’s answer projects as co_speaker on the other head', async () => {
    const world = createWorld();
    expect(act(world, ANA, ENG_ANA_S1, 'confirm').kind).toBe('responded');
    const mayaSnapshot = successSnapshot(await readSnapshotThroughExecutor(world, SES_MAYA));
    expect(mayaSnapshot.engagements[0]!.confirmation).toEqual({
      by: 'co_speaker', at: NOW, displayName: 'Ana Duarte'
    });
    const anaSnapshot = successSnapshot(await readSnapshotThroughExecutor(world, SES_ANA));
    expect(anaSnapshot.engagements[0]!.confirmation).toEqual({ by: 'you', at: NOW });
  });

  test('decline closes every invited head in the group and stays terminal', () => {
    const world = createWorld();
    const application = act(world, MAYA, ENG_MAYA_S1, 'decline');
    expect(application.kind).toBe('responded');
    expect(world.heads.get(ENG_MAYA_S1)!.state).toBe('declined');
    expect(world.heads.get(ENG_ANA_S1)!.state).toBe('declined');
    expect(world.heads.get(ENG_MAYA_S1)!.confirmation).toBeNull();

    const replay = act(world, MAYA, ENG_MAYA_S1, 'confirm');
    expect(replay).toEqual({ kind: 'refused', code: 'engagement_not_open' });
  });

  test('attribution cannot be forged from the wire: the shape refuses every claim field', async () => {
    for (const forged of [
      { engagementId: ENG_MAYA_S1, response: 'confirm', attribution: 'organizer_recorded' },
      { engagementId: ENG_MAYA_S1, response: 'confirm', attribution: 'self' },
      { engagementId: ENG_MAYA_S1, response: 'confirm', confirmingPersonId: ANA },
      { engagementId: ENG_MAYA_S1, response: 'confirm', personId: ANA },
      { engagementId: ENG_MAYA_S1, response: 'confirm', actorUserId: MAYA },
      { engagementId: ENG_MAYA_S1, response: 'confirm', expectedEngagementVersion: 1 }
    ]) {
      expect(portalEngagementRespondInputSchema.safeParse(forged).success).toBe(false);
    }

    // The registered operation enforces the same shape at the engine boundary.
    const registry = await createOperationRegistry(createModule(createWorld()).source);
    const builder = createEffectInvocationBuilder(registry);
    await expect(builder.build({
      operationName: PORTAL_ENGAGEMENT_RESPOND_OPERATION.name,
      operationVersion: PORTAL_ENGAGEMENT_RESPOND_OPERATION.version,
      surface: 'participant_http',
      correlationId: crypto.randomUUID(),
      businessInput: { engagementId: ENG_MAYA_S1, response: 'confirm', attribution: 'organizer_recorded' },
      verifiedEvidence: participantEvidence(SES_MAYA),
      rawIdempotencyKey: 'portal-act-1'
    })).rejects.toBeInstanceOf(OperationInputError);
  });

  test('another person’s engagement and a nonexistent one refuse identically (no enumeration)', () => {
    const world = createWorld();
    const foreign = act(world, MAYA, ENG_NOAH_S2, 'confirm');
    const missing = act(world, MAYA, '88888888-9999-4999-8999-999999999999', 'confirm');
    expect(foreign).toEqual({ kind: 'refused', code: 'unknown_record' });
    expect(missing).toEqual(foreign);
    // Nothing moved anywhere.
    expect(world.heads.get(ENG_NOAH_S2)!.state).toBe('invited');
    expect(world.activity).toEqual([]);
  });

  test('acts re-evaluate the relationship per request: removal refuses the next act', () => {
    const world = createWorld();
    // Ana is removed from the group; her session remains live.
    world.submissionSpeakers.set(SUB_A, [MAYA]);
    const anaHead = world.heads.get(ENG_ANA_S1)!;
    world.heads.set(ENG_ANA_S1, {
      ...anaHead, state: 'cancelled', cancelledAt: NOW, version: anaHead.version + 1
    });

    const refused = act(world, ANA, ENG_ANA_S1, 'confirm');
    expect(refused).toEqual({ kind: 'refused', code: 'unknown_record' });
    expect(world.heads.get(ENG_MAYA_S1)!.state).toBe('invited');

    // Maya still acts for the remaining group.
    expect(act(world, MAYA, ENG_MAYA_S1, 'confirm').kind).toBe('responded');
    expect(world.heads.get(ENG_MAYA_S1)!.state).toBe('confirmed');
    // The cancelled head is terminal and untouched by the group act.
    expect(world.heads.get(ENG_ANA_S1)!.state).toBe('cancelled');
  });

  test('a participant cannot act through a co-speaker’s head id even while related to it', () => {
    const world = createWorld();
    // Maya addresses Ana's head directly: refused like an unknown id, and the
    // group act cannot be opened through someone else's engagement.
    const refused = act(world, MAYA, ENG_ANA_S1, 'confirm');
    expect(refused).toEqual({ kind: 'refused', code: 'unknown_record' });
    expect(world.heads.get(ENG_ANA_S1)!.state).toBe('invited');
    expect(world.heads.get(ENG_MAYA_S1)!.state).toBe('invited');
  });
});

describe('portal timeline (D3: informed = timeline entries now)', () => {
  test('one act lands one canonical record and every other participant reads it', async () => {
    const world = createWorld();
    expect(act(world, MAYA, ENG_MAYA_S1, 'confirm').kind).toBe('responded');

    expect(world.activity).toHaveLength(1);
    const record = world.activity[0]!;
    expect(record).toMatchObject({
      submissionId: SUB_A,
      kind: 'engagement_responded',
      occurredAt: NOW,
      acting: { kind: 'participant', personId: MAYA }
    });

    // The informed co-speaker sees the entry in her own snapshot, named.
    const anaSnapshot = successSnapshot(await readSnapshotThroughExecutor(world, SES_ANA));
    const anaTimeline = anaSnapshot.submissions[0]!.timeline;
    expect(anaTimeline).toHaveLength(1);
    expect(anaTimeline[0]).toMatchObject({ actor: 'you', kind: 'engagement_responded' });
    expect(anaTimeline[0]!.summary).toBe(
      'Maya Lindqvist confirmed “Panel: Durable Agent Infrastructure” for everyone listed.'
    );

    // The actor reads the same fact in second person.
    const mayaSnapshot = successSnapshot(await readSnapshotThroughExecutor(world, SES_MAYA));
    expect(mayaSnapshot.submissions[0]!.timeline[0]!.summary).toBe(
      'You confirmed “Panel: Durable Agent Infrastructure” for everyone listed.'
    );

    // The unrelated participant never sees it.
    const noahSnapshot = successSnapshot(await readSnapshotThroughExecutor(world, SES_NOAH));
    expect(JSON.stringify(noahSnapshot)).not.toContain(record.activityId);
  });

  test('a decline informs the group in the same shape', () => {
    const world = createWorld();
    expect(act(world, ANA, ENG_ANA_S1, 'decline').kind).toBe('responded');
    const record = world.activity[0]!;
    expect(projectPortalTimelineEvent(record, MAYA).summary).toBe(
      'Ana Duarte declined “Panel: Durable Agent Infrastructure” for everyone listed.'
    );
    expect(projectPortalTimelineEvent(record, ANA).summary).toBe(
      'You told the organizers you cannot do “Panel: Durable Agent Infrastructure”.'
    );
    expect(projectPortalTimelineEvent(record, MAYA).actor).toBe('you');
  });

  test('an engagement without a submission group acts alone and informs no one', () => {
    const world = createWorld();
    const soloEngagement = '88888888-4444-4444-8444-444444444444';
    world.heads.set(soloEngagement, invitedHead({
      id: soloEngagement, sessionId: S3, personId: MAYA, submissionId: null
    }));
    const application = act(world, MAYA, soloEngagement, 'confirm');
    expect(application.kind).toBe('responded');
    if (application.kind !== 'responded') throw new Error('unreachable');
    expect(application.act.groupPersonIds).toEqual([MAYA]);
    expect(application.act.informedPersonIds).toEqual([]);
    expect(world.activity).toEqual([]);
    expect(world.heads.get(ENG_ANA_S1)!.state).toBe('invited');
  });
});

describe('respond preparation contribution (the transaction adapter contract)', () => {
  function fakeContext(personId: PersonId, participantIdentityId: ParticipantIdentityId) {
    return {
      actor: { kind: 'participant', participantIdentityId, personId },
      receivedAt: NOW
    } as unknown as EffectInvocationContext;
  }

  test('a confirm prepares coherent pinned evidence that parses against the contribution schema', () => {
    const world = createWorld();
    const preparation = createParticipantPortalRespondPreparation({
      lane,
      ports: {
        relationships: world.relationships,
        engagements: world.engagements,
        writer: world.engagements,
        activity: { append: ({ record }) => { world.activity.push(record); } },
        presentation: world.portal
      },
      ids: {
        newPreparationHandle: () => 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        newActivityId: () => 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      }
    });
    const contribution = preparation.prepare({
      businessInput: { engagementId: ENG_MAYA_S1, response: 'confirm' },
      context: fakeContext(MAYA, PI_MAYA)
    });
    const parsed = participantEngagementRespondContributionSchema.parse(contribution);
    if (!('kind' in parsed.result) || parsed.result.kind !== 'success') {
      throw new Error('expected success contribution');
    }
    expect(parsed.domain).toMatchObject({
      kind: 'participant_engagement_response',
      personId: MAYA,
      participantIdentityId: PI_MAYA,
      sessionId: S1,
      submissionId: SUB_A,
      response: 'confirm',
      respondedEngagementIds: [ENG_MAYA_S1, ENG_ANA_S1],
      activityId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      occurredAt: NOW
    });
    const children = contribution.effectContributions as readonly Record<string, unknown>[];
    expect(children).toHaveLength(3);
    expect(children[0]).toMatchObject({
      kind: 'engagement_response', engagementId: ENG_MAYA_S1, personId: MAYA, attribution: 'self'
    });
    expect(children[1]).toMatchObject({
      kind: 'engagement_response', engagementId: ENG_ANA_S1, personId: ANA, attribution: 'co_speaker'
    });
    expect(children[2]).toMatchObject({ kind: 'portal_timeline', submissionId: SUB_A });

    // Tampered attribution is incoherent evidence: the schema refuses it.
    const tampered = structuredClone(contribution) as unknown as {
      effectContributions: { attribution?: string }[];
    };
    tampered.effectContributions[1]!.attribution = 'self';
    expect(participantEngagementRespondContributionSchema.safeParse(tampered).success).toBe(false);
  });

  test('a refusal prepares exactly the declared typed outcome and nothing else', () => {
    const world = createWorld();
    const preparation = createParticipantPortalRespondPreparation({
      lane,
      ports: {
        relationships: world.relationships,
        engagements: world.engagements,
        writer: world.engagements,
        activity: { append: () => { throw new TypeError('no_activity_on_refusal'); } },
        presentation: world.portal
      },
      ids: {
        newPreparationHandle: () => 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        newActivityId: () => 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      }
    });
    const contribution = preparation.prepare({
      businessInput: { engagementId: ENG_NOAH_S2, response: 'confirm' },
      context: fakeContext(MAYA, PI_MAYA)
    });
    const parsed = participantEngagementRespondContributionSchema.parse(contribution);
    if (!('kind' in parsed.result) || parsed.result.kind !== 'outcome') {
      throw new Error('expected outcome contribution');
    }
    expect(parsed.result.outcome).toMatchObject({
      class: 'access_denied', kind: 'portal.unknown_record', retryable: false
    });
    expect(parsed.domain).toBeNull();
    expect(parsed.effectContributions).toEqual([]);
    // An undeclared refusal kind can never parse as a contribution.
    const forged = structuredClone(contribution) as {
      result: { outcome: { kind: string } };
    };
    forged.result.outcome.kind = 'portal.some_new_refusal';
    expect(participantEngagementRespondContributionSchema.safeParse(forged).success).toBe(false);
  });
});

describe('assembleParticipantPortalSnapshot leak guards', () => {
  test('a relationship that lists someone else’s engagement fails closed instead of serving it', () => {
    const world = createWorld();
    const lyingRelationship: ParticipantRelationship = {
      kind: 'related', submissionIds: [], engagementIds: [ENG_NOAH_S2]
    };
    expect(() => assembleParticipantPortalSnapshot({
      lane,
      viewer: { personId: MAYA, displayName: 'Maya Lindqvist', email: 'maya@example.com' },
      relationship: lyingRelationship,
      engagements: world.engagements,
      portal: world.portal
    })).toThrow('participant_portal_engagement_not_owned');
  });

  test('a submission whose roster does not list the viewer fails closed instead of serving it', () => {
    const world = createWorld();
    const lyingRelationship: ParticipantRelationship = {
      kind: 'related', submissionIds: [SUB_B], engagementIds: []
    };
    expect(() => assembleParticipantPortalSnapshot({
      lane,
      viewer: { personId: MAYA, displayName: 'Maya Lindqvist', email: 'maya@example.com' },
      relationship: lyingRelationship,
      engagements: world.engagements,
      portal: world.portal
    })).toThrow('participant_portal_submission_not_owned');
  });
});
