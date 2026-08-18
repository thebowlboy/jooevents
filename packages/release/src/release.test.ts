import { describe, expect, test } from 'bun:test';
import type {
  EngagementSnapshotDto,
  ReleaseMutationPlanDto,
  ReleasePlanningInput,
  ReleaseScheduleConflictDto,
  SchedulePlacementSnapshotDto,
  SpeakerProfileFieldKey,
  SpeakerProfileViewDto,
  SpeakerLineupSnapshotDto,
  SessionCatalogDto,
  SessionHeadDto
} from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import { sessionCatalogDigest, sessionHeadDigest, sessionRosterDigest } from '@jooevents/session';
import {
  compileStyleSetTokens,
  isProgramPlan,
  isStyleSetPlan,
  isSurfaceAllowlistPlan,
  isSurfacePublishPlan,
  isSurfaceRollbackPlan,
  deterministicReleaseId,
  materializeProgramContent,
  planReleaseCompensation,
  planReleaseMutation,
  projectReleaseSafeDiff,
  projectServedPublicPresentation,
  projectServedPublicRoster,
  projectServedPublicSchedule,
  planReleaseSurfaceSuccessorFrom,
  releaseChainGuard,
  releaseDigest,
  surfaceHeadGuard,
  validateReleaseMutationPlan,
  validateReleaseSurfaceSuccessorFrom,
  ReleasePlanningError,
  type ProgramRelease,
  type ReleaseReadPort,
  type StyleSetRelease,
  type SurfaceHead,
  type SurfaceRelease
} from './index';

const scope = Object.freeze({
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa101'
});
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa202';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfa601';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const personC = '019c1df7-86b5-769b-bba4-5f7097bfa403';
const speakerCategoryId = '019c1df7-86b5-769b-bba4-5f7097bfa404';
const programmedSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa201';
const collectingSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa203';
const draftSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa204';
const unplacedSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa205';
const formId = '019c1df7-86b5-769b-bba4-5f7097bfa701';
const formVersion1 = '019c1df7-86b5-769b-bba4-5f7097bfa702';
const formVersion2 = '019c1df7-86b5-769b-bba4-5f7097bfa703';
const releaseId1 = '019c1df7-86b5-769b-bba4-5f7097bfa801';
const releaseId2 = '019c1df7-86b5-769b-bba4-5f7097bfa802';
const releaseId3 = '019c1df7-86b5-769b-bba4-5f7097bfa803';
const now = '2026-08-14T08:00:00.000Z';
const later = '2026-08-14T09:00:00.000Z';
const themeArtifactId = '019c1df7-86b5-769b-bba4-5f7097bfa710';
const scheduleArtifactId = '019c1df7-86b5-769b-bba4-5f7097bfa711';
const speakersArtifactId = '019c1df7-86b5-769b-bba4-5f7097bfa712';
const applyArtifactId = '019c1df7-86b5-769b-bba4-5f7097bfa713';
const templateRevisionId = '019c1df7-86b5-769b-bba4-5f7097bfa714';
const templateDigest = 'd'.repeat(64);
const profileApprovalId = '019c1df7-86b5-769b-bba4-5f7097bfa405';
const recipe = {
  name: 'Warm default', canvas: '#faf8f5', surface: '#ffffff',
  text: '#2a2522', action: '#b05a4f', radius: 6, controlHeight: 36
};
const templatePin = (artifactId: string) => ({
  artifactId, revisionId: templateRevisionId, revisionNumber: 1, digestSha256: templateDigest
});
const surfaceArtifactId = (kind: 'schedule' | 'speakers' | 'apply') =>
  kind === 'schedule' ? scheduleArtifactId : kind === 'speakers' ? speakersArtifactId : applyArtifactId;

function participant(personId: string, position: number, publiclyVisible: boolean) {
  return {
    personId,
    role: 'speaker' as const,
    position,
    publiclyVisible,
    source: { kind: 'submission', id: 'seeded', version: 1 }
  };
}

function sessionHead(input: {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly lifecycle: 'draft' | 'collecting' | 'programmed';
  readonly participants?: SessionHeadDto['roster']['participants'];
}): SessionHeadDto {
  const rosterUnsigned = { version: 1, participants: input.participants ?? [] };
  const roster = { ...rosterUnsigned, digestSha256: sessionRosterDigest(rosterUnsigned) };
  const unsigned = {
    schemaVersion: 1 as const,
    scope,
    id: input.id,
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    plannedDurationMinutes: 60,
    lifecycle: input.lifecycle,
    programTarget: {
      setVersion: 1,
      setDigestSha256: 'a'.repeat(64),
      format: { kind: 'format' as const, id: formatId, name: 'Talk', status: 'active' as const, version: 1 },
      track: null
    },
    roster,
    version: 1,
    createdByUserId: userId,
    createdAt: now,
    updatedByUserId: userId,
    updatedAt: now
  };
  return { ...unsigned, digestSha256: sessionHeadDigest(unsigned) } as SessionHeadDto;
}

function catalogWith(sessions: readonly SessionHeadDto[]): SessionCatalogDto {
  const ordered = [...sessions].sort((left, right) => left.id < right.id ? -1 : 1);
  const unsigned = { schemaVersion: 1 as const, scope, version: 4, sessions: ordered };
  return { ...unsigned, digestSha256: sessionCatalogDigest(unsigned) } as SessionCatalogDto;
}

function engagement(sessionId: string, personId: string, state: 'invited' | 'confirmed') {
  return {
    schemaVersion: 1 as const,
    id: deterministicReleaseId(scope, 'test_engagement', { sessionId, personId }),
    scope,
    sessionId,
    personId,
    submissionId: null,
    seededByDecision: null,
    state,
    invitedAt: now,
    respondBy: null,
    confirmation: state === 'confirmed'
      ? { attribution: 'self' as const, personId, recordedByUserId: null, confirmedAt: now }
      : null,
    cancellationRequest: null,
    cancelledAt: null,
    source: { kind: 'organizer', id: 'direct', version: 1 },
    version: state === 'confirmed' ? 2 : 1
  };
}

function engagementSnapshot(
  entries: readonly ReturnType<typeof engagement>[]
): EngagementSnapshotDto {
  const ordered = [...entries].sort((left, right) =>
    `${left.sessionId}:${left.personId}` < `${right.sessionId}:${right.personId}` ? -1 : 1
  );
  return { schemaVersion: 1, scope, engagements: ordered } as EngagementSnapshotDto;
}

function scheduleSnapshot(
  occurrences: readonly {
    readonly id: string;
    readonly sessionId: string;
    readonly startAt: string;
    readonly endAt: string;
  }[]
): SchedulePlacementSnapshotDto {
  const ordered = [...occurrences].sort((left, right) =>
    `${left.startAt}:${left.endAt}:${left.id}` < `${right.startAt}:${right.endAt}:${right.id}` ? -1 : 1
  );
  return {
    schemaVersion: 1,
    scope,
    scheduleVersion: 3,
    occurrences: ordered.map((occurrence) => ({ ...occurrence, roomId, version: 1 }))
  } as SchedulePlacementSnapshotDto;
}

function lineupSnapshot(
  people: readonly string[] = [personA, personB, personC]
): SpeakerLineupSnapshotDto {
  return {
    schemaVersion: 1,
    scope,
    version: 1,
    digestSha256: 'c'.repeat(64),
    categories: [],
    entries: people.map((personId, position) => ({
      personId,
      position,
      categoryId: null,
      publiclyVisible: personId !== personC,
      version: 1
    }))
  };
}

function profileView(input: {
  readonly revision?: number;
  readonly approved?: readonly SpeakerProfileFieldKey[];
} = {}): SpeakerProfileViewDto {
  const revision = input.revision ?? 1;
  const digests = {
    headline: '1'.repeat(64),
    biography: '2'.repeat(64),
    location: '3'.repeat(64),
    links: '4'.repeat(64)
  };
  const fields = {
    headline: { revision, digestSha256: digests.headline, value: 'Computing pioneer' },
    biography: { revision, digestSha256: digests.biography, value: 'Private until approved.' },
    location: { revision, digestSha256: digests.location, value: 'London' },
    links: {
      revision,
      digestSha256: digests.links,
      value: [{ kind: 'website' as const, label: 'Notes', href: 'https://example.com/ada' }]
    }
  };
  return {
    schemaVersion: 1,
    ...scope,
    personId: personA,
    reviewPolicy: {
      schemaVersion: 1, ...scope, eventVersion: 1, reviewRequired: true
    },
    profile: {
      schemaVersion: 1,
      workspaceId: scope.workspaceId,
      personId: personA,
      version: revision,
      ...fields,
      updatedAt: now
    },
    approvals: (input.approved ?? []).map((field, index) => ({
      id: index === 0 ? profileApprovalId : deterministicReleaseId(scope, 'profile_approval', { index }),
      ...scope,
      personId: personA,
      field,
      fieldRevision: fields[field].revision,
      fieldDigestSha256: fields[field].digestSha256,
      actor: { kind: 'user' as const, userId },
      approvedAt: now
    }))
  };
}

interface FixtureState {
  currentProgram?: ProgramRelease;
  programs: Map<string, ProgramRelease>;
  currentStyleSet?: StyleSetRelease;
  styleSets: Map<string, StyleSetRelease>;
  heads: Map<string, SurfaceHead>;
  surfaces: Map<string, SurfaceRelease>;
  catalog: SessionCatalogDto;
  schedule: SchedulePlacementSnapshotDto;
  engagements: EngagementSnapshotDto;
  lineup: SpeakerLineupSnapshotDto;
  conflicts: readonly ReleaseScheduleConflictDto[];
  names: Map<string, string>;
  publishedFormVersions: Map<string, string>;
}

function fixture(overrides: Partial<FixtureState> = {}): {
  readonly state: FixtureState;
  readonly port: ReleaseReadPort;
} {
  const state: FixtureState = {
    programs: new Map(),
    styleSets: new Map(),
    heads: new Map(),
    surfaces: new Map(),
    catalog: catalogWith([
      sessionHead({
        id: programmedSessionId,
        title: 'Opening Keynote',
        lifecycle: 'programmed',
        participants: [
          participant(personA, 0, true),
          participant(personB, 1, true),
          participant(personC, 2, false)
        ]
      }),
      sessionHead({ id: collectingSessionId, title: 'Panel: Future of X', lifecycle: 'collecting' }),
      sessionHead({ id: draftSessionId, title: 'Secret Draft Idea', lifecycle: 'draft' }),
      sessionHead({ id: unplacedSessionId, title: 'Unplaced Programmed Talk', lifecycle: 'programmed' })
    ]),
    schedule: scheduleSnapshot([
      {
        id: '019c1df7-86b5-769b-bba4-5f7097bfa901',
        sessionId: programmedSessionId,
        startAt: '2026-11-01T09:00:00.000Z',
        endAt: '2026-11-01T10:00:00.000Z'
      },
      {
        id: '019c1df7-86b5-769b-bba4-5f7097bfa902',
        sessionId: collectingSessionId,
        startAt: '2026-11-01T10:00:00.000Z',
        endAt: '2026-11-01T11:00:00.000Z'
      }
    ]),
    engagements: engagementSnapshot([
      engagement(programmedSessionId, personA, 'confirmed'),
      engagement(programmedSessionId, personB, 'invited'),
      engagement(programmedSessionId, personC, 'confirmed')
    ]),
    lineup: lineupSnapshot(),
    conflicts: [],
    names: new Map([
      [personA, 'Ada Lovelace'],
      [personB, 'Grace Hopper'],
      [personC, 'Alan Turing']
    ]),
    publishedFormVersions: new Map([[formId, formVersion1]]),
    ...overrides
  };
  const port: ReleaseReadPort = {
    readCurrentProgramRelease: () => state.currentProgram,
    readProgramRelease: (_scope, releaseId) => state.programs.get(releaseId),
    readCurrentStyleSetRelease: () => state.currentStyleSet,
    readStyleSetRelease: (_scope, releaseId) => state.styleSets.get(releaseId),
    readSurfaceHead: (_scope, kind) => state.heads.get(kind),
    readSurfaceRelease: (_scope, releaseId) => state.surfaces.get(releaseId),
    listFormSurfaceHeads: () => [...state.heads.values()].filter((head) => head.kind === 'apply'),
    readReleaseSessionCatalog: () => state.catalog,
    readReleaseSchedule: () => state.schedule,
    readReleaseEngagementSnapshot: () => state.engagements,
    readReleaseSpeakerLineupSnapshot: () => state.lineup,
    readReleaseVocabulary: () => ({
      scope,
      setVersion: 2,
      setDigestSha256: 'b'.repeat(64),
      rooms: [{ id: roomId, name: 'Main Hall' }],
      tracks: []
    }),
    readReleaseEventSettingsVersion: () => 5,
    readReleaseScheduleConflicts: () => state.conflicts,
    readReleaseParticipantDisplayName: (_scope, personId) => state.names.get(personId),
    readReleasePublishedFormVersionId: (_scope, requestedFormId) =>
      state.publishedFormVersions.get(requestedFormId),
    readReleaseTemplateArtifact: (_scope, pin) => {
      if (pin.revisionId !== templateRevisionId || pin.revisionNumber !== 1
          || pin.digestSha256 !== templateDigest) return undefined;
      if (pin.artifactId === themeArtifactId) return {
        kind: 'theme' as const, recipe, markText: 'JE'
      };
      const surfaceKind = pin.artifactId === scheduleArtifactId
        ? 'schedule' as const
        : pin.artifactId === speakersArtifactId
          ? 'speaker-roster' as const
          : pin.artifactId === applyArtifactId ? 'application-form' as const : null;
      if (surfaceKind === null) return undefined;
      return {
        kind: 'surface' as const,
        surfaceKind,
        name: 'Public surface',
        purpose: 'Published presentation.',
        blocks: surfaceKind === 'application-form'
          ? [{ type: 'hero' as const, title: 'Apply to speak', intro: '' }]
          : [],
        usedBy: []
      };
    }
  };
  return Object.freeze({ state, port });
}

function publishInput(releaseId: string, expected: number | null): ReleasePlanningInput {
  return {
    action: 'publish_schedule',
    scope,
    actorUserId: userId,
    occurredAt: now,
    releaseId,
    expectedCurrentReleaseNumber: expected
  };
}

function commitProgramPlan(state: FixtureState, plan: ReleaseMutationPlanDto): ProgramRelease {
  if (plan.input.action !== 'publish_schedule' && plan.input.action !== 'program_rollback') {
    throw new Error('not a program plan');
  }
  const release = (plan as { release: ProgramRelease }).release;
  state.currentProgram = release;
  state.programs.set(release.id, release);
  return release;
}

describe('program release materialization', () => {
  test('refuses programmed track omissions when the event uses tracks', () => {
    const { port } = fixture();
    const guarded: ReleaseReadPort = {
      ...port,
      readReleaseVocabulary: () => ({
        scope,
        setVersion: 2,
        setDigestSha256: 'b'.repeat(64),
        rooms: [{ id: roomId, name: 'Main Hall' }],
        tracks: [{
          id: '019c1df7-86b5-769b-bba4-5f7097bfa302',
          name: 'Platform',
          status: 'active',
          version: 1,
          accent: 'lavender'
        }]
      })
    };
    expect(() => materializeProgramContent(scope, guarded)).toThrow('session_track_required');
  });

  test('admits only programmed sessions and confirmed-and-visible participants', () => {
    const { port } = fixture();
    const content = materializeProgramContent(scope, port);
    expect(content.sessions.map((session) => session.sessionId).sort()).toEqual(
      [programmedSessionId, unplacedSessionId].sort()
    );
    const keynote = content.sessions.find((session) => session.sessionId === programmedSessionId)!;
    expect(keynote.participants).toEqual([
      { personId: personA, role: 'speaker', position: 0, displayName: 'Ada Lovelace' }
    ]);
    expect(content.nameDeclassifications).toEqual([
      { personId: personA, displayName: 'Ada Lovelace' }
    ]);
    const bytes = canonicalJsonText(content);
    expect(bytes).not.toContain('Grace Hopper');
    expect(bytes).not.toContain('Alan Turing');
    expect(bytes).not.toContain('email');
  });

  test('copies only canonical session copy into the immutable public release', () => {
    const { state, port } = fixture();
    const current = state.catalog.sessions.find((session) => session.id === programmedSessionId)!;
    const described = sessionHead({
      id: current.id,
      title: current.title,
      description: 'Published session description.',
      lifecycle: 'programmed',
      participants: current.roster.participants
    });
    state.catalog = catalogWith(state.catalog.sessions.map((session) =>
      session.id === programmedSessionId ? described : session
    ));

    const content = materializeProgramContent(scope, port);
    const released = content.sessions.find((session) => session.sessionId === programmedSessionId)!;
    expect(released.description).toBe('Published session description.');
  });

  test('a placed collecting session never enters a release, state not placement', () => {
    const { port } = fixture();
    const content = materializeProgramContent(scope, port);
    const bytes = canonicalJsonText(content);
    expect(bytes).not.toContain(collectingSessionId);
    expect(bytes).not.toContain('Panel: Future of X');
    expect(bytes).not.toContain('Secret Draft Idea');
    const releasedOccurrences = content.sessions.flatMap((session) => session.occurrences);
    expect(releasedOccurrences).toHaveLength(1);
    expect(releasedOccurrences[0]!.occurrenceId).toBe('019c1df7-86b5-769b-bba4-5f7097bfa901');
  });

  test('an unplaced programmed session is released with zero occurrences', () => {
    const { port } = fixture();
    const content = materializeProgramContent(scope, port);
    const unplaced = content.sessions.find((session) => session.sessionId === unplacedSessionId)!;
    expect(unplaced.occurrences).toEqual([]);
    expect(unplaced.title).toBe('Unplaced Programmed Talk');
  });

  test('an unresolvable display name refuses the publish', () => {
    const { state, port } = fixture();
    state.names.delete(personA);
    expect(() => materializeProgramContent(scope, port))
      .toThrow(new ReleasePlanningError('participant_name_unavailable'));
  });

  test('display names are normalized before release', () => {
    const { state, port } = fixture();
    state.names.set(personA, '  Ada   Lovelace ');
    const content = materializeProgramContent(scope, port);
    expect(content.nameDeclassifications[0]!.displayName).toBe('Ada Lovelace');
  });
});

describe('publish_schedule planning', () => {
  test('creates the first release with pinned upstream evidence', () => {
    const { port } = fixture();
    const plan = planReleaseMutation({ planningInput: publishInput(releaseId1, null), port });
    if (!isProgramPlan(plan)) throw new Error('wrong plan');
    expect(plan.chainBefore).toBeNull();
    expect(plan.release.number).toBe(1);
    expect(plan.release.predecessor).toBeNull();
    expect(plan.release.origin).toEqual({ kind: 'publish' });
    expect(plan.release.pins.scheduleVersion).toBe(3);
    expect(plan.release.pins.vocabulary).toEqual({ setVersion: 2, digestSha256: 'b'.repeat(64) });
    expect(plan.release.pins.eventSettingsVersion).toBe(5);
    expect(plan.release.rooms).toEqual([{ id: roomId, name: 'Main Hall' }]);
    expect(validateReleaseMutationPlan({ plan, port })).toBeUndefined();
  });

  test('refuses while block-severity schedule conflicts exist', () => {
    const conflicts: ReleaseScheduleConflictDto[] = [{
      severity: 'block',
      roomId,
      occurrences: [
        {
          occurrenceId: '019c1df7-86b5-769b-bba4-5f7097bfa901',
          sessionId: programmedSessionId,
          startAt: '2026-11-01T09:00:00.000Z',
          endAt: '2026-11-01T10:00:00.000Z'
        },
        {
          occurrenceId: '019c1df7-86b5-769b-bba4-5f7097bfa902',
          sessionId: collectingSessionId,
          startAt: '2026-11-01T09:30:00.000Z',
          endAt: '2026-11-01T10:30:00.000Z'
        }
      ]
    }];
    const { port } = fixture({ conflicts });
    let caught: unknown;
    try {
      planReleaseMutation({ planningInput: publishInput(releaseId1, null), port });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleasePlanningError);
    expect((caught as ReleasePlanningError).code).toBe('schedule_conflicts_block');
    expect((caught as ReleasePlanningError).conflicts).toEqual(conflicts);
  });

  test('fences the chain head and links successors immutably', () => {
    const { state, port } = fixture();
    const first = commitProgramPlan(
      state,
      planReleaseMutation({ planningInput: publishInput(releaseId1, null), port })
    );
    expect(() => planReleaseMutation({ planningInput: publishInput(releaseId2, null), port }))
      .toThrow(new ReleasePlanningError('stale_release_chain'));
    const second = commitProgramPlan(
      state,
      planReleaseMutation({ planningInput: publishInput(releaseId2, 1), port })
    );
    expect(second.number).toBe(2);
    expect(second.predecessor).toEqual({ releaseId: first.id, digestSha256: first.digestSha256 });
  });

  test('a tampered plan refuses instead of committing', () => {
    const { port } = fixture();
    const plan = planReleaseMutation({ planningInput: publishInput(releaseId1, null), port });
    if (!isProgramPlan(plan)) throw new Error('wrong plan');
    const tampered = {
      ...plan,
      release: {
        ...plan.release,
        nameDeclassifications: [{ personId: personB, displayName: 'Grace Hopper' }]
      }
    } as ReleaseMutationPlanDto;
    expect(validateReleaseMutationPlan({ plan: tampered, port })).toBe('invalid_plan');
  });

  test('a state change between propose and validate refuses the frozen plan', () => {
    const { state, port } = fixture();
    const plan = planReleaseMutation({ planningInput: publishInput(releaseId1, null), port });
    state.names.set(personA, 'Renamed Person');
    expect(validateReleaseMutationPlan({ plan, port })).toBe('invalid_plan');
  });
});

describe('program rollback', () => {
  test('restores prior content as an immutable successor', () => {
    const { state, port } = fixture();
    const first = commitProgramPlan(
      state,
      planReleaseMutation({ planningInput: publishInput(releaseId1, null), port })
    );
    state.names.set(personA, 'Ada King');
    const second = commitProgramPlan(
      state,
      planReleaseMutation({ planningInput: publishInput(releaseId2, 1), port })
    );
    expect(second.nameDeclassifications[0]!.displayName).toBe('Ada King');
    const rollbackPlan = planReleaseMutation({
      planningInput: {
        action: 'program_rollback',
        scope,
        actorUserId: userId,
        occurredAt: later,
        releaseId: releaseId3,
        targetReleaseId: first.id,
        expectedCurrentReleaseNumber: 2
      },
      port
    });
    if (!isProgramPlan(rollbackPlan)) throw new Error('wrong plan');
    const restored = rollbackPlan.release;
    expect(restored.number).toBe(3);
    expect(restored.origin).toEqual({ kind: 'rollback', restoredFromReleaseId: first.id });
    expect(restored.predecessor).toEqual({
      releaseId: second.id, digestSha256: second.digestSha256
    });
    expect(restored.sessions).toEqual(first.sessions);
    expect(restored.nameDeclassifications).toEqual(first.nameDeclassifications);
    expect(restored.pins).toEqual(first.pins);
    expect(rollbackPlan.rollbackSuppressions).toEqual([]);
    expect(validateReleaseMutationPlan({ plan: rollbackPlan, port })).toBeUndefined();
  });

  test('a publish plan carries no suppression record', () => {
    const { port } = fixture();
    const plan = planReleaseMutation({ planningInput: publishInput(releaseId1, null), port });
    if (!isProgramPlan(plan)) throw new Error('wrong plan');
    expect(plan.rollbackSuppressions).toBeNull();
  });

  function rollbackInput(targetReleaseId: string) {
    return {
      action: 'program_rollback' as const,
      scope,
      actorUserId: userId,
      occurredAt: later,
      releaseId: releaseId3,
      targetReleaseId,
      expectedCurrentReleaseNumber: 2
    };
  }

  function publishedThenChanged(mutate: (state: FixtureState) => void): {
    readonly state: FixtureState;
    readonly port: ReleaseReadPort;
    readonly first: ProgramRelease;
  } {
    const { state, port } = fixture();
    const first = commitProgramPlan(
      state,
      planReleaseMutation({ planningInput: publishInput(releaseId1, null), port })
    );
    mutate(state);
    commitProgramPlan(state, planReleaseMutation({ planningInput: publishInput(releaseId2, 1), port }));
    return { state, port, first };
  }

  test('rollback re-applies the visibility gate: a since-hidden participant never returns', () => {
    const { port, first } = publishedThenChanged((state) => {
      // The speaker revoked consent: organizer flipped the roster flag off,
      // and release 2 correctly omitted them. Rolling back to release 1 to fix
      // the schedule must NOT re-declassify the hidden name.
      state.catalog = catalogWith([
        sessionHead({
          id: programmedSessionId,
          title: 'Opening Keynote',
          lifecycle: 'programmed',
          participants: [
            participant(personA, 0, false),
            participant(personB, 1, true),
            participant(personC, 2, false)
          ]
        }),
        sessionHead({ id: unplacedSessionId, title: 'Unplaced Programmed Talk', lifecycle: 'programmed' })
      ]);
      state.lineup = {
        ...state.lineup,
        digestSha256: 'd'.repeat(64),
        entries: state.lineup.entries.map((entry) => entry.personId === personA
          ? { ...entry, publiclyVisible: false, version: entry.version + 1 }
          : entry)
      };
    });
    expect(first.nameDeclassifications).toEqual([
      { personId: personA, displayName: 'Ada Lovelace' }
    ]);
    const plan = planReleaseMutation({ planningInput: rollbackInput(first.id), port });
    if (!isProgramPlan(plan)) throw new Error('wrong plan');
    expect(canonicalJsonText(plan.release)).not.toContain('Ada Lovelace');
    expect(plan.release.nameDeclassifications).toEqual([]);
    expect(plan.release.sessions.flatMap((session) => session.participants)).toEqual([]);
    expect(plan.rollbackSuppressions).toEqual([
      { sessionId: programmedSessionId, personId: personA }
    ]);
    expect(validateReleaseMutationPlan({ plan, port })).toBeUndefined();
    const diff = projectReleaseSafeDiff(plan);
    if (diff.action !== 'program_rollback') throw new Error('wrong diff');
    expect(diff.rollbackSuppressions).toEqual([
      { sessionId: programmedSessionId, personId: personA }
    ]);
  });

  test('rollback re-applies the engagement gate: a since-cancelled participant never returns', () => {
    const { port, first } = publishedThenChanged((state) => {
      state.engagements = engagementSnapshot([
        engagement(programmedSessionId, personA, 'invited'),
        engagement(programmedSessionId, personB, 'invited'),
        engagement(programmedSessionId, personC, 'confirmed')
      ]);
    });
    const plan = planReleaseMutation({ planningInput: rollbackInput(first.id), port });
    if (!isProgramPlan(plan)) throw new Error('wrong plan');
    expect(canonicalJsonText(plan.release)).not.toContain('Ada Lovelace');
    expect(plan.rollbackSuppressions).toEqual([
      { sessionId: programmedSessionId, personId: personA }
    ]);
  });

  test('a visibility flip between propose and commit refuses the frozen rollback plan', () => {
    const { state, port } = fixture();
    const first = commitProgramPlan(
      state,
      planReleaseMutation({ planningInput: publishInput(releaseId1, null), port })
    );
    commitProgramPlan(state, planReleaseMutation({ planningInput: publishInput(releaseId2, 1), port }));
    const plan = planReleaseMutation({ planningInput: rollbackInput(first.id), port });
    state.catalog = catalogWith([
      sessionHead({
        id: programmedSessionId,
        title: 'Opening Keynote',
        lifecycle: 'programmed',
        participants: [
          participant(personA, 0, false),
          participant(personB, 1, true),
          participant(personC, 2, false)
        ]
      }),
      sessionHead({ id: unplacedSessionId, title: 'Unplaced Programmed Talk', lifecycle: 'programmed' })
    ]);
    expect(validateReleaseMutationPlan({ plan, port })).toBe('invalid_plan');
  });

  test('refuses a missing target and a rollback to the current release', () => {
    const { state, port } = fixture();
    const first = commitProgramPlan(
      state,
      planReleaseMutation({ planningInput: publishInput(releaseId1, null), port })
    );
    expect(() => planReleaseMutation({
      planningInput: {
        action: 'program_rollback',
        scope,
        actorUserId: userId,
        occurredAt: later,
        releaseId: releaseId3,
        targetReleaseId: releaseId2,
        expectedCurrentReleaseNumber: 1
      },
      port
    })).toThrow(new ReleasePlanningError('release_missing'));
    expect(() => planReleaseMutation({
      planningInput: {
        action: 'program_rollback',
        scope,
        actorUserId: userId,
        occurredAt: later,
        releaseId: releaseId3,
        targetReleaseId: first.id,
        expectedCurrentReleaseNumber: 1
      },
      port
    })).toThrow(new ReleasePlanningError('invalid_plan'));
  });
});

describe('style-set and surface releases', () => {
  function publishStyleSet(state: FixtureState, port: ReleaseReadPort): StyleSetRelease {
    const plan = planReleaseMutation({
      planningInput: {
        action: 'style_set_publish',
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId: releaseId1,
        sourceTemplateRevision: templatePin(themeArtifactId),
        recipe,
        expectedCurrentStyleSetNumber: null
      },
      port
    });
    if (!isStyleSetPlan(plan)) throw new Error('wrong plan');
    state.currentStyleSet = plan.release;
    state.styleSets.set(plan.release.id, plan.release);
    return plan.release;
  }

  function publishSurface(
    state: FixtureState,
    port: ReleaseReadPort,
    input: {
      readonly releaseId: string;
      readonly kind: 'schedule' | 'speakers' | 'apply';
      readonly styleSetReleaseId: string;
      readonly formRef?: { readonly formId: string; readonly formVersionId: string };
      readonly expectedSurfaceHeadVersion: number | null;
    }
  ): { readonly release: SurfaceRelease; readonly head: SurfaceHead } {
    const plan = planReleaseMutation({
      planningInput: {
        action: 'surface_publish',
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId: input.releaseId,
        kind: input.kind,
        sourceTemplateRevision: templatePin(surfaceArtifactId(input.kind)),
        manifest: {
          schemaVersion: 1,
          heading: input.kind === 'apply' ? 'Apply to speak' : null,
          intro: null
        },
        styleSetReleaseId: input.styleSetReleaseId,
        formRef: input.formRef ?? null,
        expectedSurfaceHeadVersion: input.expectedSurfaceHeadVersion
      },
      port
    });
    if (!isSurfacePublishPlan(plan)) throw new Error('wrong plan');
    state.surfaces.set(plan.release.id, plan.release);
    state.heads.set(plan.headAfter.kind, plan.headAfter);
    return { release: plan.release, head: plan.headAfter };
  }

  test('compiles exactly the documented public theme tokens', () => {
    const tokens = compileStyleSetTokens(recipe);
    expect(Object.keys(tokens).sort()).toEqual([
      '--je-color-action', '--je-color-action-active', '--je-color-action-contrast',
      '--je-color-action-hover', '--je-color-action-soft', '--je-color-action-soft-hover',
      '--je-color-border', '--je-color-border-strong', '--je-color-canvas', '--je-color-focus',
      '--je-color-link', '--je-color-page', '--je-color-surface', '--je-color-surface-raised',
      '--je-color-surface-selected', '--je-color-surface-sunken', '--je-color-text',
      '--je-color-text-muted', '--je-control-height', '--je-font-body', '--je-font-display',
      '--je-radius-control', '--je-radius-surface'
    ]);
    expect(tokens['--je-color-action']).toBe('#b05a4f');
    expect(tokens['--je-control-height']).toBe('36px');
    expect(compileStyleSetTokens(recipe)).toEqual(tokens);
  });

  test('surface publish pins its style set and refuses a missing one', () => {
    const { state, port } = fixture();
    expect(() => publishSurface(state, port, {
      releaseId: releaseId2,
      kind: 'schedule',
      styleSetReleaseId: releaseId1,
      expectedSurfaceHeadVersion: null
    })).toThrow(new ReleasePlanningError('style_set_release_missing'));
    const styleSet = publishStyleSet(state, port);
    const { release, head } = publishSurface(state, port, {
      releaseId: releaseId2,
      kind: 'schedule',
      styleSetReleaseId: styleSet.id,
      expectedSurfaceHeadVersion: null
    });
    expect(release.kind).toBe('schedule');
    expect('formRef' in release).toBe(false);
    expect(head.activeReleaseId).toBe(release.id);
    expect(head.version).toBe(1);
  });

  test('a submission-bearing surface pins the exact published form version', () => {
    const { state, port } = fixture();
    const styleSet = publishStyleSet(state, port);
    expect(() => publishSurface(state, port, {
      releaseId: releaseId2,
      kind: 'apply',
      styleSetReleaseId: styleSet.id,
      formRef: { formId, formVersionId: formVersion2 },
      expectedSurfaceHeadVersion: null
    })).toThrow(new ReleasePlanningError('form_version_unpinned'));
    const { release } = publishSurface(state, port, {
      releaseId: releaseId2,
      kind: 'apply',
      styleSetReleaseId: styleSet.id,
      formRef: { formId, formVersionId: formVersion1 },
      expectedSurfaceHeadVersion: null
    });
    if (release.kind !== 'apply') throw new Error('wrong kind');
    expect(release.formRef).toEqual({ formId, formVersionId: formVersion1 });
    const presentation = projectServedPublicPresentation({ surface: release, style: styleSet });
    if (presentation.surfaceKind !== 'apply') throw new Error('wrong presentation kind');
    expect(presentation.formRef).toEqual({ formId, formVersionId: formVersion1 });
  });

  test('surface rollback moves only the presentation pointer', () => {
    const { state, port } = fixture();
    const styleSet = publishStyleSet(state, port);
    const first = publishSurface(state, port, {
      releaseId: releaseId2,
      kind: 'speakers',
      styleSetReleaseId: styleSet.id,
      expectedSurfaceHeadVersion: null
    });
    const second = publishSurface(state, port, {
      releaseId: releaseId3,
      kind: 'speakers',
      styleSetReleaseId: styleSet.id,
      expectedSurfaceHeadVersion: 1
    });
    expect(second.release.predecessor).toEqual({
      releaseId: first.release.id, digestSha256: first.release.digestSha256
    });
    const programBefore = state.currentProgram;
    const rollback = planReleaseMutation({
      planningInput: {
        action: 'surface_rollback',
        scope,
        actorUserId: userId,
        occurredAt: later,
        kind: 'speakers',
        targetReleaseId: first.release.id,
        expectedSurfaceHeadVersion: 2
      },
      port
    });
    if (!isSurfaceRollbackPlan(rollback)) throw new Error('wrong plan');
    expect(rollback.headAfter.activeReleaseId).toBe(first.release.id);
    expect(rollback.headAfter.version).toBe(3);
    expect(state.currentProgram).toBe(programBefore);
    expect(validateReleaseMutationPlan({ plan: rollback, port })).toBeUndefined();
    expect(() => planReleaseMutation({
      planningInput: {
        action: 'surface_rollback',
        scope,
        actorUserId: userId,
        occurredAt: later,
        kind: 'schedule',
        targetReleaseId: first.release.id,
        expectedSurfaceHeadVersion: 2
      },
      port
    })).toThrow(new ReleasePlanningError('stale_surface_head'));
  });

  test('an allowlist change keeps the pointer; publishes carry it; compensation restores it', () => {
    const { state, port } = fixture();
    const styleSet = publishStyleSet(state, port);
    const first = publishSurface(state, port, {
      releaseId: releaseId2,
      kind: 'apply',
      styleSetReleaseId: styleSet.id,
      formRef: { formId, formVersionId: formVersion1 },
      expectedSurfaceHeadVersion: null
    });
    expect(first.head.allowedFrameOrigins).toEqual([]);
    expect(() => planReleaseMutation({
      planningInput: {
        action: 'surface_allowlist',
        scope,
        actorUserId: userId,
        occurredAt: later,
        kind: 'schedule',
        allowedFrameOrigins: ['https://conference.example.com'],
        expectedSurfaceHeadVersion: 1
      },
      port
    })).toThrow(new ReleasePlanningError('stale_surface_head'));
    const plan = planReleaseMutation({
      planningInput: {
        action: 'surface_allowlist',
        scope,
        actorUserId: userId,
        occurredAt: later,
        kind: 'apply',
        allowedFrameOrigins: ['https://B.example.com/', 'https://a.example.com'],
        expectedSurfaceHeadVersion: 1
      },
      port
    });
    if (!isSurfaceAllowlistPlan(plan)) throw new Error('wrong plan');
    expect(plan.headAfter.activeReleaseId).toBe(first.release.id);
    expect(plan.headAfter.version).toBe(2);
    expect(plan.headAfter.allowedFrameOrigins)
      .toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(validateReleaseMutationPlan({ plan, port })).toBeUndefined();
    state.heads.set(plan.headAfter.kind, plan.headAfter);
    expect(() => planReleaseMutation({
      planningInput: {
        action: 'surface_allowlist',
        scope,
        actorUserId: userId,
        occurredAt: later,
        kind: 'apply',
        allowedFrameOrigins: ['https://b.example.com', 'https://a.example.com'],
        expectedSurfaceHeadVersion: 2
      },
      port
    })).toThrow(new ReleasePlanningError('invalid_plan'));
    const compensation = planReleaseCompensation({
      original: plan, port, actorUserId: userId, occurredAt: later
    });
    if (compensation.kind !== 'exact') throw new Error('expected exact compensation');
    expect(compensation.authorInput).toEqual({
      action: 'surface_allowlist',
      scope,
      actorUserId: userId,
      occurredAt: later,
      kind: 'apply',
      allowedFrameOrigins: [],
      expectedSurfaceHeadVersion: 2
    });
    const second = publishSurface(state, port, {
      releaseId: releaseId3,
      kind: 'apply',
      styleSetReleaseId: styleSet.id,
      formRef: { formId, formVersionId: formVersion1 },
      expectedSurfaceHeadVersion: 2
    });
    expect(second.head.allowedFrameOrigins)
      .toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(planReleaseCompensation({
      original: plan, port, actorUserId: userId, occurredAt: later
    })).toEqual({ kind: 'blocked', reasonKey: 'release.superseded' });
  });
});

describe('compensation, per release kind', () => {
  test('first program release blocks; a successor rolls back to its predecessor', () => {
    const { state, port } = fixture();
    const firstPlan = planReleaseMutation({ planningInput: publishInput(releaseId1, null), port });
    commitProgramPlan(state, firstPlan);
    expect(planReleaseCompensation({
      original: firstPlan, port, actorUserId: userId, occurredAt: later
    })).toEqual({ kind: 'blocked', reasonKey: 'release.first_release' });

    const secondPlan = planReleaseMutation({ planningInput: publishInput(releaseId2, 1), port });
    const second = commitProgramPlan(state, secondPlan);
    const derived = planReleaseCompensation({
      original: secondPlan, port, actorUserId: userId, occurredAt: later
    });
    if (derived.kind !== 'exact') throw new Error('expected exact compensation');
    expect(derived.authorInput).toMatchObject({
      action: 'program_rollback',
      targetReleaseId: releaseId1,
      expectedCurrentReleaseNumber: 2
    });
    const compensationPlan = planReleaseMutation({ planningInput: derived.authorInput, port });
    if (!isProgramPlan(compensationPlan)) throw new Error('wrong plan');
    expect(compensationPlan.release.sessions).toEqual(
      state.programs.get(releaseId1)!.sessions
    );
    expect(compensationPlan.release.predecessor!.releaseId).toBe(second.id);
  });

  test('a superseded program release blocks compensation', () => {
    const { state, port } = fixture();
    const firstPlan = planReleaseMutation({ planningInput: publishInput(releaseId1, null), port });
    commitProgramPlan(state, firstPlan);
    const secondPlan = planReleaseMutation({ planningInput: publishInput(releaseId2, 1), port });
    commitProgramPlan(state, secondPlan);
    commitProgramPlan(
      state,
      planReleaseMutation({ planningInput: publishInput(releaseId3, 2), port })
    );
    expect(planReleaseCompensation({
      original: secondPlan, port, actorUserId: userId, occurredAt: later
    })).toEqual({ kind: 'blocked', reasonKey: 'release.superseded' });
  });
});

describe('form-republish successor collaboration', () => {
  function withApplySurface() {
    const { state, port } = fixture();
    const stylePlan = planReleaseMutation({
      planningInput: {
        action: 'style_set_publish',
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId: releaseId1,
        sourceTemplateRevision: templatePin(themeArtifactId),
        recipe: {
          name: 'Warm default', canvas: '#faf8f5', surface: '#ffffff',
          text: '#2a2522', action: '#b05a4f', radius: 6, controlHeight: 36
        },
        expectedCurrentStyleSetNumber: null
      },
      port
    });
    if (!isStyleSetPlan(stylePlan)) throw new Error('wrong plan');
    state.currentStyleSet = stylePlan.release;
    state.styleSets.set(stylePlan.release.id, stylePlan.release);
    const surfacePlan = planReleaseMutation({
      planningInput: {
        action: 'surface_publish',
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId: releaseId2,
        kind: 'apply',
        sourceTemplateRevision: templatePin(applyArtifactId),
        manifest: { schemaVersion: 1, heading: 'Apply to speak', intro: null },
        styleSetReleaseId: stylePlan.release.id,
        formRef: { formId, formVersionId: formVersion1 },
        expectedSurfaceHeadVersion: null
      },
      port
    });
    if (!isSurfacePublishPlan(surfacePlan)) throw new Error('wrong plan');
    state.surfaces.set(surfacePlan.release.id, surfacePlan.release);
    state.heads.set('apply', surfacePlan.headAfter);
    return { state, port, active: surfacePlan.release };
  }

  test('plans one successor per surface rendering the republished form', () => {
    const { state, port, active } = withApplySurface();
    state.publishedFormVersions.set(formId, formVersion2);
    const plan = planReleaseSurfaceSuccessorFrom(port, {
      scope, formId, formVersionId: formVersion2, actorUserId: userId, occurredAt: later
    });
    expect(plan.successors).toHaveLength(1);
    const successor = plan.successors[0]!;
    if (successor.release.kind !== 'apply') throw new Error('wrong kind');
    expect(successor.release.formRef).toEqual({ formId, formVersionId: formVersion2 });
    expect(successor.release.manifest).toEqual(active.manifest);
    expect(successor.release.styleSetReleaseId).toBe(active.styleSetReleaseId);
    expect(successor.release.predecessor).toEqual({
      releaseId: active.id, digestSha256: active.digestSha256
    });
    expect(successor.headAfter.activeReleaseId).toBe(successor.release.id);
    expect(validateReleaseSurfaceSuccessorFrom(port, plan)).toEqual({ kind: 'ready' });
    const replay = planReleaseSurfaceSuccessorFrom(port, plan.input);
    expect(canonicalJsonText(replay)).toBe(canonicalJsonText(plan));
  });

  test('a form no surface renders plans zero successors', () => {
    const { port } = withApplySurface();
    const plan = planReleaseSurfaceSuccessorFrom(port, {
      scope,
      formId: releaseId3,
      formVersionId: formVersion2,
      actorUserId: userId,
      occurredAt: later
    });
    expect(plan.successors).toEqual([]);
  });

  test('a moved head refuses the frozen successor plan', () => {
    const { state, port } = withApplySurface();
    const plan = planReleaseSurfaceSuccessorFrom(port, {
      scope, formId, formVersionId: formVersion2, actorUserId: userId, occurredAt: later
    });
    const head = state.heads.get('apply')!;
    state.heads.set('apply', { ...head, version: head.version + 1 });
    expect(validateReleaseSurfaceSuccessorFrom(port, plan))
      .toEqual({ kind: 'refused', code: 'stale_surface_head' });
  });
});

describe('release guards and digests', () => {
  test('guard evidence is deterministic across sides', () => {
    expect(releaseChainGuard(undefined)).toEqual(releaseChainGuard(undefined));
    expect(releaseChainGuard({ number: 2, digestSha256: 'c'.repeat(64) }))
      .toEqual(releaseChainGuard({ number: 2, digestSha256: 'c'.repeat(64) }));
    expect(releaseChainGuard(undefined).digest)
      .not.toBe(releaseChainGuard({ number: 1, digestSha256: 'c'.repeat(64) }).digest);
    const head: SurfaceHead = {
      schemaVersion: 1,
      scope,
      kind: 'schedule',
      activeReleaseId: releaseId1,
      version: 1,
      allowedFrameOrigins: [],
      updatedByUserId: userId,
      updatedAt: now
    };
    expect(surfaceHeadGuard(head)).toEqual(surfaceHeadGuard(head));
    expect(surfaceHeadGuard(undefined).version).toBe(1);
  });

  test('release digests are content digests', () => {
    const { port } = fixture();
    const plan = planReleaseMutation({ planningInput: publishInput(releaseId1, null), port });
    if (!isProgramPlan(plan)) throw new Error('wrong plan');
    const { digestSha256, ...unsigned } = plan.release;
    expect(releaseDigest(unsigned)).toBe(digestSha256);
  });
});

describe('served public projections', () => {
  function publishedRelease(state: FixtureState, port: ReleaseReadPort, releaseId: string, expected: number | null): ProgramRelease {
    const plan = planReleaseMutation({ planningInput: publishInput(releaseId, expected), port });
    if (!isProgramPlan(plan)) throw new Error('wrong plan');
    return commitProgramPlan(state, plan);
  }

  test('serves released names only and never a person identifier', () => {
    const { state, port } = fixture();
    const release = publishedRelease(state, port, releaseId1, null);

    const schedule = projectServedPublicSchedule(release);
    expect(schedule.releaseNumber).toBe(1);
    expect(schedule.sessions.map((session) => session.sessionId).sort()).toEqual(
      [programmedSessionId, unplacedSessionId].sort()
    );
    const keynote = schedule.sessions.find((session) => session.sessionId === programmedSessionId)!;
    expect(keynote.speakers).toEqual(['Ada Lovelace']);
    expect(keynote.format).toBe('Talk');
    expect(keynote.description).toBeUndefined();
    expect(schedule.rooms).toEqual([{ id: roomId, name: 'Main Hall' }]);

    const roster = projectServedPublicRoster(release);
    expect(roster.speakers).toEqual([{
      id: expect.any(String),
      name: 'Ada Lovelace',
      categoryId: null,
      sessions: [{ sessionId: programmedSessionId, title: 'Opening Keynote' }]
    }]);

    for (const bytes of [canonicalJsonText(schedule), canonicalJsonText(roster)]) {
      expect(bytes).not.toContain('personId');
      expect(bytes).not.toContain(personA);
      expect(bytes).not.toContain(personB);
      expect(bytes).not.toContain(personC);
      expect(bytes).not.toContain('Grace Hopper');
      expect(bytes).not.toContain('Alan Turing');
      expect(bytes).not.toContain('email');
      expect(bytes).not.toContain(collectingSessionId);
      expect(bytes).not.toContain(draftSessionId);
    }
  });

  test('publishes only exact approved profile fields from the immutable release', () => {
    const { state, port } = fixture();
    const approved = profileView({ approved: ['headline', 'location', 'links'] });
    const release = publishedRelease(state, {
      ...port,
      readReleaseSpeakerProfileView: (_scope, personId) => personId === personA
        ? approved
        : {
            schemaVersion: 1, ...scope, personId,
            reviewPolicy: {
              schemaVersion: 1, ...scope, eventVersion: 1, reviewRequired: true
            },
            profile: null, approvals: []
          }
    }, releaseId1, null);

    expect(release.speakerProfiles?.profiles).toEqual([{
      personId: personA,
      headline: approved.profile!.headline,
      location: approved.profile!.location,
      links: approved.profile!.links
    }]);
    const roster = projectServedPublicRoster(release);
    expect(roster.speakers).toEqual([{
      id: expect.any(String),
      name: 'Ada Lovelace',
      categoryId: null,
      headline: 'Computing pioneer',
      location: 'London',
      links: [{ kind: 'website', label: 'Notes', href: 'https://example.com/ada' }],
      sessions: [{ sessionId: programmedSessionId, title: 'Opening Keynote' }]
    }]);
    const bytes = canonicalJsonText(roster);
    expect(bytes).not.toContain('Private until approved.');
    expect(bytes).not.toContain(personA);
    expect(bytes).not.toContain('personId');

    const plan = planReleaseMutation({
      planningInput: publishInput(releaseId2, 1),
      port: {
        ...port,
        readReleaseSpeakerProfileView: () => approved
      }
    });
    if (!isProgramPlan(plan)) throw new Error('wrong plan');
    const diff = projectReleaseSafeDiff(plan);
    if (diff.action !== 'publish_schedule') throw new Error('wrong diff');
    expect(diff.speakerProfiles).toEqual(plan.release.speakerProfiles);
  });

  test('rollback withholds a profile field whose current approval was revoked', () => {
    const { state, port } = fixture();
    let currentProfile = profileView({ approved: ['headline'] });
    const profilePort: ReleaseReadPort = {
      ...port,
      readReleaseSpeakerProfileView: (_scope, personId) => personId === personA
        ? currentProfile
        : {
            schemaVersion: 1, ...scope, personId,
            reviewPolicy: {
              schemaVersion: 1, ...scope, eventVersion: 1, reviewRequired: true
            },
            profile: null, approvals: []
          }
    };
    const first = publishedRelease(state, profilePort, releaseId1, null);
    expect(projectServedPublicRoster(first).speakers[0]!.headline).toBe('Computing pioneer');
    currentProfile = profileView({ revision: 2, approved: [] });
    publishedRelease(state, profilePort, releaseId2, 1);

    const rollback = planReleaseMutation({
      planningInput: {
        action: 'program_rollback',
        scope,
        actorUserId: userId,
        occurredAt: later,
        releaseId: releaseId3,
        targetReleaseId: first.id,
        expectedCurrentReleaseNumber: 2
      },
      port: profilePort
    });
    if (!isProgramPlan(rollback)) throw new Error('wrong plan');
    expect(rollback.release.speakerProfiles?.profiles).toEqual([]);
    expect(projectServedPublicRoster(rollback.release).speakers[0]!.headline).toBeUndefined();
  });

  test('the roster is the union of visible appearances, one card per released person', () => {
    const { state, port } = fixture({
      catalog: catalogWith([
        sessionHead({
          id: programmedSessionId,
          title: 'Opening Keynote',
          lifecycle: 'programmed',
          participants: [participant(personA, 0, true)]
        }),
        sessionHead({
          id: unplacedSessionId,
          title: 'Unplaced Programmed Talk',
          lifecycle: 'programmed',
          participants: [participant(personA, 0, true), participant(personB, 1, true)]
        })
      ]),
      engagements: engagementSnapshot([
        engagement(programmedSessionId, personA, 'confirmed'),
        engagement(unplacedSessionId, personA, 'confirmed'),
        engagement(unplacedSessionId, personB, 'confirmed')
      ])
    });
    const roster = projectServedPublicRoster(publishedRelease(state, port, releaseId1, null));
    expect(roster.speakers).toEqual([
      {
        id: expect.any(String),
        name: 'Ada Lovelace',
        categoryId: null,
        sessions: [
          { sessionId: programmedSessionId, title: 'Opening Keynote' },
          { sessionId: unplacedSessionId, title: 'Unplaced Programmed Talk' }
        ]
      },
      {
        id: expect.any(String),
        name: 'Grace Hopper',
        categoryId: null,
        sessions: [{ sessionId: unplacedSessionId, title: 'Unplaced Programmed Talk' }]
      }
    ]);
  });

  test('a lineup-backed roster preserves global order, category, and zero-session speakers', () => {
    const { state, port } = fixture({
      engagements: engagementSnapshot([
        engagement(programmedSessionId, personA, 'confirmed'),
        engagement(unplacedSessionId, personB, 'confirmed')
      ]),
      lineup: {
        schemaVersion: 1,
        scope,
        version: 4,
        digestSha256: 'e'.repeat(64),
        categories: [{
          id: speakerCategoryId,
          name: 'Keynotes',
          accent: 'lavender',
          status: 'active',
          position: 0,
          version: 1
        }],
        entries: [
          { personId: personB, position: 0, categoryId: speakerCategoryId, publiclyVisible: true, version: 2 },
          { personId: personA, position: 1, categoryId: null, publiclyVisible: true, version: 1 }
        ]
      }
    });
    const roster = projectServedPublicRoster(publishedRelease(state, port, releaseId1, null));
    expect(roster.categories).toEqual([{
      id: speakerCategoryId,
      name: 'Keynotes',
      accent: 'lavender',
      position: 0
    }]);
    expect(roster.speakers.map((speaker) => ({
      name: speaker.name,
      categoryId: speaker.categoryId,
      sessions: speaker.sessions
    }))).toEqual([
      { name: 'Grace Hopper', categoryId: speakerCategoryId, sessions: [] },
      {
        name: 'Ada Lovelace',
        categoryId: null,
        sessions: [{ sessionId: programmedSessionId, title: 'Opening Keynote' }]
      }
    ]);
    expect(roster.speakers.every((speaker) => speaker.id && ![personA, personB].includes(speaker.id)))
      .toBe(true);
  });

  test('an immutable pre-lineup release retains the historical name-ordered projection', () => {
    const { state, port } = fixture();
    const current = publishedRelease(state, port, releaseId1, null);
    const { speakerLineup: _lineup, digestSha256: _digest, pins, ...base } = current;
    const { speakerLineupDigestSha256: _lineupPin, ...legacyPins } = pins;
    const unsigned = { ...base, pins: legacyPins };
    const legacy = { ...unsigned, digestSha256: releaseDigest(unsigned) } as ProgramRelease;
    const roster = projectServedPublicRoster(legacy);
    expect(roster.categories).toBeUndefined();
    expect(roster.speakers).toEqual([{
      name: 'Ada Lovelace',
      sessions: [{ sessionId: programmedSessionId, title: 'Opening Keynote' }]
    }]);
  });

  test('lineup visibility, not one session appearance, controls the public card', () => {
    const { state, port } = fixture();
    const first = publishedRelease(state, port, releaseId1, null);
    expect(projectServedPublicRoster(first).speakers).toHaveLength(1);

    state.catalog = catalogWith([
      sessionHead({
        id: programmedSessionId,
        title: 'Opening Keynote',
        lifecycle: 'programmed',
        participants: [participant(personA, 0, false)]
      })
    ]);
    const second = publishedRelease(state, port, releaseId2, 1);

    const schedule = projectServedPublicSchedule(second);
    const roster = projectServedPublicRoster(second);
    expect(schedule.releaseNumber).toBe(2);
    expect(schedule.sessions[0]!.speakers).toEqual([]);
    expect(roster.speakers).toEqual([{
      id: expect.any(String),
      name: 'Ada Lovelace',
      categoryId: null,
      sessions: []
    }]);
    expect(canonicalJsonText(schedule)).not.toContain('Ada Lovelace');
    expect(canonicalJsonText(roster)).toContain('Ada Lovelace');

    state.lineup = {
      ...state.lineup,
      digestSha256: 'd'.repeat(64),
      entries: state.lineup.entries.map((entry) => entry.personId === personA
        ? { ...entry, publiclyVisible: false, version: entry.version + 1 }
        : entry)
    };
    const third = publishedRelease(state, port, releaseId3, 2);
    expect(projectServedPublicRoster(third).speakers).toEqual([]);
  });

  test('a tampered release refuses to serve', () => {
    const { state, port } = fixture();
    const release = publishedRelease(state, port, releaseId1, null);
    const tampered = {
      ...release,
      sessions: release.sessions.map((session, index) => index === 0
        ? { ...session, title: 'Renamed After Signing' }
        : session)
    };
    expect(() => projectServedPublicSchedule(tampered as ProgramRelease))
      .toThrow('program_release_digest_mismatch');
    expect(() => projectServedPublicRoster(tampered as ProgramRelease))
      .toThrow('program_release_digest_mismatch');
  });
});
