import { describe, expect, test } from 'bun:test';
import {
  canonicalFrameOriginAllowlist,
  embedFrameOriginInputSchema,
  embedFrameOriginSchema,
  normalizeEmbedFrameOrigin,
  programReleaseSchema,
  publicThemeTokenNameSchema,
  releaseAuthorInputSchema,
  releaseProgramPlanSchema,
  releasePublicReadInputSchema,
  releaseOverviewSchema,
  releaseSafeDiffSchema,
  releaseSurfaceAllowlistPlanSchema,
  releaseSurfacePublishPlanSchema,
  releaseSurfaceRollbackPlanSchema,
  servedPublicRosterSchema,
  servedPublicScheduleSchema,
  styleSetReleaseSchema,
  surfaceFrameOriginAllowlistSchema,
  surfaceHeadSchema,
  surfaceReleaseSchema,
  type EmbedFrameOriginRefusalCode
} from './releases';

const scope = Object.freeze({
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfe101'
});
const userId = '019c1df7-86b5-769b-bba4-5f7097bfe201';
const releaseId = '019c1df7-86b5-769b-bba4-5f7097bfe301';
const priorReleaseId = '019c1df7-86b5-769b-bba4-5f7097bfe302';
const styleSetId = '019c1df7-86b5-769b-bba4-5f7097bfe303';
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfe401';
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfe501';
const personId = '019c1df7-86b5-769b-bba4-5f7097bfe601';
const formId = '019c1df7-86b5-769b-bba4-5f7097bfe701';
const formVersionId = '019c1df7-86b5-769b-bba4-5f7097bfe702';
const digest = 'a'.repeat(64);
const now = '2026-08-14T08:00:00.000Z';
const sourceTemplateRevision = Object.freeze({
  artifactId: '019c1df7-86b5-769b-bba4-5f7097bfe710',
  revisionId: '019c1df7-86b5-769b-bba4-5f7097bfe711',
  revisionNumber: 1,
  digestSha256: digest
});

function programRelease(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    scope,
    id: releaseId,
    number: 1,
    origin: { kind: 'publish' },
    predecessor: null,
    pins: {
      sessionCatalog: { version: 4, digestSha256: digest },
      scheduleVersion: 3,
      engagementSnapshotDigestSha256: digest,
      vocabulary: { setVersion: 2, digestSha256: digest },
      eventSettingsVersion: 5
    },
    rooms: [{ id: roomId, name: 'Main Hall' }],
    sessions: [{
      sessionId,
      title: 'Opening Keynote',
      plannedDurationMinutes: 60,
      format: { id: '019c1df7-86b5-769b-bba4-5f7097bfe801', name: 'Talk' },
      track: null,
      occurrences: [{
        occurrenceId: '019c1df7-86b5-769b-bba4-5f7097bfe901',
        roomId,
        startAt: '2026-11-01T09:00:00.000Z',
        endAt: '2026-11-01T10:00:00.000Z'
      }],
      participants: [{ personId, role: 'speaker', position: 0, displayName: 'Ada Lovelace' }]
    }],
    nameDeclassifications: [{ personId, displayName: 'Ada Lovelace' }],
    releasedByUserId: userId,
    releasedAt: now,
    digestSha256: digest,
    ...overrides
  };
}

describe('program release contract', () => {
  test('round-trips a coherent release', () => {
    const parsed = programReleaseSchema.parse(programRelease());
    expect(parsed.sessions[0]!.participants[0]!.displayName).toBe('Ada Lovelace');
  });

  test('exactly the first release has no predecessor', () => {
    expect(() => programReleaseSchema.parse(programRelease({ number: 2 }))).toThrow();
    expect(() => programReleaseSchema.parse(programRelease({
      predecessor: { releaseId: priorReleaseId, digestSha256: digest }
    }))).toThrow();
  });

  test('name declassifications must record exactly the released names', () => {
    expect(() => programReleaseSchema.parse(programRelease({ nameDeclassifications: [] })))
      .toThrow();
    expect(() => programReleaseSchema.parse(programRelease({
      nameDeclassifications: [
        { personId, displayName: 'Ada Lovelace' },
        { personId: '019c1df7-86b5-769b-bba4-5f7097bfe602', displayName: 'Uninvited Extra' }
      ]
    }))).toThrow();
    expect(() => programReleaseSchema.parse(programRelease({
      nameDeclassifications: [{ personId, displayName: 'Different Name' }]
    }))).toThrow();
  });

  test('released occurrences must reference released rooms', () => {
    expect(() => programReleaseSchema.parse(programRelease({ rooms: [] }))).toThrow();
  });

  test('contact data has no representable field on a released participant', () => {
    const release = programRelease();
    (release.sessions[0]!.participants[0] as Record<string, unknown>).email = 'ada@example.org';
    expect(() => programReleaseSchema.parse(release)).toThrow();
  });

  test('exactly a rollback plan records its participant suppressions', () => {
    const publishPlan = {
      input: {
        action: 'publish_schedule',
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId,
        expectedCurrentReleaseNumber: null
      },
      chainBefore: null,
      rollbackSuppressions: null,
      release: programRelease()
    };
    expect(releaseProgramPlanSchema.safeParse(publishPlan).success).toBe(true);
    expect(releaseProgramPlanSchema.safeParse({
      ...publishPlan,
      rollbackSuppressions: []
    }).success).toBe(false);
    const rollbackPlan = {
      input: {
        action: 'program_rollback',
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId,
        targetReleaseId: priorReleaseId,
        expectedCurrentReleaseNumber: 2
      },
      chainBefore: { releaseId: priorReleaseId, number: 2, digestSha256: digest },
      rollbackSuppressions: [{ sessionId, personId }],
      release: programRelease({
        number: 3,
        origin: { kind: 'rollback', restoredFromReleaseId: priorReleaseId },
        predecessor: { releaseId: priorReleaseId, digestSha256: digest }
      })
    };
    expect(releaseProgramPlanSchema.safeParse(rollbackPlan).success).toBe(true);
    expect(releaseProgramPlanSchema.safeParse({
      ...rollbackPlan,
      rollbackSuppressions: null
    }).success).toBe(false);
    expect(releaseProgramPlanSchema.safeParse({
      ...rollbackPlan,
      rollbackSuppressions: [{ sessionId, personId }, { sessionId, personId }]
    }).success).toBe(false);
    expect(releaseSafeDiffSchema.safeParse({
      action: 'program_rollback',
      before: { releaseId: priorReleaseId, number: 2, digestSha256: digest },
      after: { releaseId, number: 3, digestSha256: digest },
      releasedSessionCount: 1,
      releasedOccurrenceCount: 1,
      nameDeclassifications: [],
      rollbackSuppressions: [{ sessionId, personId }]
    }).success).toBe(true);
  });

  test('a rollback release must restore a different release', () => {
    expect(() => programReleaseSchema.parse(programRelease({
      origin: { kind: 'rollback', restoredFromReleaseId: releaseId }
    }))).toThrow();
  });
});

describe('surface release contract', () => {
  const common = {
    schemaVersion: 1,
    scope,
    id: releaseId,
    number: 1,
    predecessor: null,
    sourceTemplateRevision,
    manifest: { schemaVersion: 1, heading: null, intro: null },
    styleSetReleaseId: styleSetId,
    releasedByUserId: userId,
    releasedAt: now,
    digestSha256: digest
  };

  test('read-only kinds carry no form pin; the apply kind requires one', () => {
    expect(surfaceReleaseSchema.parse({ kind: 'schedule', ...common }).kind).toBe('schedule');
    expect(() => surfaceReleaseSchema.parse({
      kind: 'schedule', ...common, formRef: { formId, formVersionId }
    })).toThrow();
    expect(() => surfaceReleaseSchema.parse({ kind: 'apply', ...common })).toThrow();
    const apply = surfaceReleaseSchema.parse({
      kind: 'apply', ...common, formRef: { formId, formVersionId }
    });
    if (apply.kind !== 'apply') throw new Error('wrong kind');
    expect(apply.formRef.formVersionId).toBe(formVersionId);
  });

  test('an operator overview carries exactly the immutable releases selected by its heads', () => {
    const release = surfaceReleaseSchema.parse({ kind: 'schedule', ...common });
    const head = surfaceHeadSchema.parse({
      schemaVersion: 1,
      scope,
      kind: 'schedule',
      activeReleaseId: release.id,
      version: 1,
      allowedFrameOrigins: [],
      updatedByUserId: userId,
      updatedAt: now
    });
    expect(releaseOverviewSchema.parse({
      schemaVersion: 1,
      scope,
      currentProgramRelease: null,
      currentStyleSetRelease: null,
      surfaceHeads: [head],
      activeSurfaceReleases: [release]
    }).activeSurfaceReleases).toEqual([release]);
    expect(() => releaseOverviewSchema.parse({
      schemaVersion: 1,
      scope,
      currentProgramRelease: null,
      currentStyleSetRelease: null,
      surfaceHeads: [head],
      activeSurfaceReleases: []
    })).toThrow();
  });

  test('the surface publish wire input pins a form exactly for submission-bearing kinds', () => {
    const base = {
      action: 'surface_publish',
      kind: 'speakers',
      sourceTemplateRevision,
      manifest: { schemaVersion: 1, heading: null, intro: null },
      styleSetReleaseId: styleSetId,
      formRef: null,
      expectedSurfaceHeadVersion: null
    };
    expect(releaseAuthorInputSchema.parse(base).action).toBe('surface_publish');
    expect(() => releaseAuthorInputSchema.parse({
      ...base, formRef: { formId, formVersionId }
    })).toThrow();
    expect(() => releaseAuthorInputSchema.parse({ ...base, kind: 'apply' })).toThrow();
  });

  test('surface rollback plans must select a different release and advance by one', () => {
    const head = (version: number, active: string) => surfaceHeadSchema.parse({
      schemaVersion: 1,
      scope,
      kind: 'speakers',
      activeReleaseId: active,
      version,
      allowedFrameOrigins: [],
      updatedByUserId: userId,
      updatedAt: now
    });
    const input = {
      action: 'surface_rollback',
      kind: 'speakers',
      targetReleaseId: priorReleaseId,
      expectedSurfaceHeadVersion: 2,
      scope,
      actorUserId: userId,
      occurredAt: now
    };
    expect(releaseSurfaceRollbackPlanSchema.parse({
      input,
      headBefore: head(2, releaseId),
      headAfter: head(3, priorReleaseId)
    }).headAfter.version).toBe(3);
    expect(() => releaseSurfaceRollbackPlanSchema.parse({
      input,
      headBefore: head(2, priorReleaseId),
      headAfter: head(3, priorReleaseId)
    })).toThrow();
    expect(() => releaseSurfaceRollbackPlanSchema.parse({
      input,
      headBefore: head(2, releaseId),
      headAfter: head(4, priorReleaseId)
    })).toThrow();
  });

  test('surface publish plans must advance the head to their own release', () => {
    const release = surfaceReleaseSchema.parse({ kind: 'speakers', ...common });
    const plan = {
      input: {
        action: 'surface_publish',
        kind: 'speakers',
        sourceTemplateRevision,
        manifest: { schemaVersion: 1, heading: null, intro: null },
        styleSetReleaseId: styleSetId,
        formRef: null,
        expectedSurfaceHeadVersion: null,
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId
      },
      release,
      headBefore: null,
      headAfter: {
        schemaVersion: 1,
        scope,
        kind: 'speakers',
        activeReleaseId: releaseId,
        version: 1,
        allowedFrameOrigins: [],
        updatedByUserId: userId,
        updatedAt: now
      }
    };
    expect(releaseSurfacePublishPlanSchema.parse(plan).release.id).toBe(releaseId);
    expect(() => releaseSurfacePublishPlanSchema.parse({
      ...plan,
      headAfter: { ...plan.headAfter, activeReleaseId: priorReleaseId }
    })).toThrow();
  });
});

describe('style set release contract', () => {
  test('the compiled token record is exhaustive over the public vocabulary', () => {
    const tokens = Object.fromEntries(
      publicThemeTokenNameSchema.options.map((token) => [token, '#ffffff'])
    );
    const release = {
      schemaVersion: 1,
      scope,
      id: releaseId,
      number: 1,
      predecessor: null,
      sourceTemplateRevision,
      recipe: {
        name: 'Warm default', canvas: '#faf8f5', surface: '#ffffff',
        text: '#2a2522', action: '#b05a4f', radius: 6, controlHeight: 36
      },
      tokens,
      releasedByUserId: userId,
      releasedAt: now,
      digestSha256: digest
    };
    expect(styleSetReleaseSchema.parse(release).number).toBe(1);
    const { '--je-color-canvas': _dropped, ...missing } = tokens;
    expect(() => styleSetReleaseSchema.parse({ ...release, tokens: missing })).toThrow();
    expect(() => styleSetReleaseSchema.parse({
      ...release,
      tokens: { ...tokens, '--je-unknown': 'red' }
    })).toThrow();
    expect(() => styleSetReleaseSchema.parse({
      ...release,
      tokens: { ...tokens, '--je-color-canvas': 'body { background: url(x) }' }
    })).toThrow();
  });
});

describe('served public projection contracts', () => {
  const occurrence = {
    occurrenceId: '019c1df7-86b5-769b-bba4-5f7097bfe901',
    roomId,
    startAt: '2026-11-01T09:00:00.000Z',
    endAt: '2026-11-01T10:00:00.000Z'
  };

  function servedSchedule(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      releaseNumber: 1,
      rooms: [{ id: roomId, name: 'Main Hall' }],
      sessions: [{
        sessionId,
        title: 'Opening Keynote',
        plannedDurationMinutes: 60,
        format: 'Talk',
        track: { name: 'Product', accent: 'lavender' },
        occurrences: [occurrence],
        speakers: ['Ada Lovelace']
      }],
      ...overrides
    };
  }

  function servedRoster(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      releaseNumber: 1,
      speakers: [{ name: 'Ada Lovelace', sessions: [{ sessionId, title: 'Opening Keynote' }] }],
      ...overrides
    };
  }

  test('the public read input carries no parameters', () => {
    expect(releasePublicReadInputSchema.safeParse({}).success).toBe(true);
    expect(releasePublicReadInputSchema.safeParse({ eventId: scope.eventId }).success).toBe(false);
    expect(releasePublicReadInputSchema.safeParse({ releaseId }).success).toBe(false);
  });

  test('round-trips the served schedule and refuses unlisted or unused rooms', () => {
    const parsed = servedPublicScheduleSchema.parse(servedSchedule());
    expect(parsed.sessions[0]!.speakers).toEqual(['Ada Lovelace']);
    expect(() => servedPublicScheduleSchema.parse(servedSchedule({
      rooms: [{ id: '019c1df7-86b5-769b-bba4-5f7097bfe402', name: 'Other Hall' }]
    }))).toThrow();
    expect(() => servedPublicScheduleSchema.parse(servedSchedule({
      rooms: [
        { id: roomId, name: 'Main Hall' },
        { id: '019c1df7-86b5-769b-bba4-5f7097bfe402', name: 'Unreferenced Hall' }
      ]
    }))).toThrow();
  });

  test('a person identifier or contact field is unrepresentable on served projections', () => {
    const scheduleSession = (servedSchedule() as { sessions: Record<string, unknown>[] })
      .sessions[0]!;
    expect(servedPublicScheduleSchema.safeParse(servedSchedule({
      sessions: [{ ...scheduleSession, speakers: [{ personId, name: 'Ada Lovelace' }] }]
    })).success).toBe(false);
    expect(servedPublicScheduleSchema.safeParse(servedSchedule({
      sessions: [{ ...scheduleSession, participants: [] }]
    })).success).toBe(false);
    const card = (servedRoster() as { speakers: Record<string, unknown>[] }).speakers[0]!;
    for (const smuggled of [
      { personId }, { email: 'ada@example.com' }, { note: 'internal' }, { state: 'invited' }
    ]) {
      expect(servedPublicRosterSchema.safeParse(servedRoster({
        speakers: [{ ...card, ...smuggled }]
      })).success).toBe(false);
    }
  });

  test('served projections require canonical order and appearance-backed cards', () => {
    expect(() => servedPublicScheduleSchema.parse(servedSchedule({
      rooms: [
        { id: '019c1df7-86b5-769b-bba4-5f7097bfe402', name: 'B' },
        { id: roomId, name: 'A' }
      ]
    }))).toThrow();
    expect(servedPublicRosterSchema.safeParse(servedRoster({
      speakers: [
        { name: 'Grace Hopper', sessions: [{ sessionId, title: 'Opening Keynote' }] },
        { name: 'Ada Lovelace', sessions: [{ sessionId, title: 'Opening Keynote' }] }
      ]
    })).success).toBe(false);
    expect(servedPublicRosterSchema.safeParse(servedRoster({
      speakers: [{ name: 'Ada Lovelace', sessions: [] }]
    })).success).toBe(false);
    expect(servedPublicRosterSchema.safeParse(servedRoster({ speakers: [] })).success).toBe(true);
  });
});

describe('embed frame origin contract', () => {
  test('normalizes trivial noise to exactly scheme + host', () => {
    expect(normalizeEmbedFrameOrigin('HTTPS://Example.COM/')).toEqual({
      kind: 'normalized', origin: 'https://example.com'
    });
    expect(normalizeEmbedFrameOrigin('example.com')).toEqual({
      kind: 'normalized', origin: 'https://example.com'
    });
    expect(normalizeEmbedFrameOrigin(' https://example.com:443 ')).toEqual({
      kind: 'normalized', origin: 'https://example.com'
    });
    expect(normalizeEmbedFrameOrigin('http://localhost:5176')).toEqual({
      kind: 'normalized', origin: 'http://localhost:5176'
    });
    expect(normalizeEmbedFrameOrigin('https://host.example.com:8443')).toEqual({
      kind: 'normalized', origin: 'https://host.example.com:8443'
    });
  });

  test('refuses in place what an origin cannot carry', () => {
    const refused = (value: string, code: EmbedFrameOriginRefusalCode) =>
      expect(normalizeEmbedFrameOrigin(value)).toEqual({ kind: 'refused', code });
    refused('', 'empty');
    refused('   ', 'empty');
    refused('https://example.com/embed', 'path_present');
    refused('https://example.com/?page=1', 'query_present');
    refused('https://example.com/#top', 'fragment_present');
    refused('https://user:secret@example.com', 'credentials_present');
    refused('https://*.example.com', 'wildcard_host');
    refused('*', 'wildcard_host');
    refused('ftp://example.com', 'unsupported_scheme');
    refused('examplecom', 'hostname_unqualified');
    refused('javascript:alert(1)', 'not_an_origin');
    refused('data:text/html,x', 'not_an_origin');
    refused('https://exa mple.com', 'not_an_origin');
  });

  test('refuses hosts a frame-ancestors header cannot carry', () => {
    const refused = (value: string, code: EmbedFrameOriginRefusalCode) =>
      expect(normalizeEmbedFrameOrigin(value)).toEqual({ kind: 'refused', code });
    // URL() accepts all of these; a served header would misparse every one.
    refused('https://evil.example;x', 'hostname_forbidden_characters');
    refused('https://a,b.com', 'hostname_forbidden_characters');
    refused('https://a&b.example.com', 'hostname_forbidden_characters');
    refused("https://a'b.example.com", 'hostname_forbidden_characters');
    refused('https://a"b.example.com', 'hostname_forbidden_characters');
    refused('https://a_b.example.com', 'hostname_forbidden_characters');
    refused('https://a!b.example.com', 'hostname_forbidden_characters');
    refused('https://ex%3Bample.com', 'hostname_forbidden_characters');
    refused('https://[::1]', 'hostname_forbidden_characters');
    refused('https://a..b.example.com', 'hostname_forbidden_characters');
    refused('https://.example.com', 'hostname_forbidden_characters');
    expect(embedFrameOriginSchema.safeParse('https://evil.example;x').success).toBe(false);
    expect(embedFrameOriginInputSchema.safeParse('https://a,b.com').success).toBe(false);
    expect(surfaceFrameOriginAllowlistSchema.safeParse(['https://evil.example;x']).success)
      .toBe(false);
  });

  test('the wildcard guard sees the decoded hostname, not the raw bytes', () => {
    expect(normalizeEmbedFrameOrigin('https://%2A.example.com'))
      .toEqual({ kind: 'refused', code: 'wildcard_host' });
    // The wire schema refuses in place; nothing rewrites toward a stored value
    // the stored-entry schema would later reject at plan time.
    expect(embedFrameOriginInputSchema.safeParse('https://%2A.example.com').success).toBe(false);
    expect(embedFrameOriginInputSchema.safeParse('%2A.example.com').success).toBe(false);
  });

  test('every accepted wire value is a fixed point of the stored schema', () => {
    for (const raw of [
      'Example.com/',
      ' https://example.com:443 ',
      'https://host.example.com:8443',
      'http://localhost:5176',
      'https://münchen.example',
      'https://example.com.'
    ]) {
      const accepted = embedFrameOriginInputSchema.parse(raw);
      expect(embedFrameOriginSchema.safeParse(accepted).success).toBe(true);
    }
  });

  test('the stored entry schema admits only already-normalized bytes', () => {
    expect(embedFrameOriginSchema.safeParse('https://example.com').success).toBe(true);
    expect(embedFrameOriginSchema.safeParse('https://Example.com').success).toBe(false);
    expect(embedFrameOriginSchema.safeParse('example.com').success).toBe(false);
    expect(embedFrameOriginSchema.safeParse('https://example.com/').success).toBe(false);
    expect(embedFrameOriginInputSchema.parse('Example.com/')).toBe('https://example.com');
    expect(embedFrameOriginInputSchema.safeParse('https://example.com/apply').success).toBe(false);
  });

  test('the stored allowlist is canonical unique ascending and bounded', () => {
    expect(surfaceFrameOriginAllowlistSchema.safeParse([]).success).toBe(true);
    expect(surfaceFrameOriginAllowlistSchema.safeParse(
      ['https://a.example.com', 'https://b.example.com']
    ).success).toBe(true);
    expect(surfaceFrameOriginAllowlistSchema.safeParse(
      ['https://b.example.com', 'https://a.example.com']
    ).success).toBe(false);
    expect(surfaceFrameOriginAllowlistSchema.safeParse(
      ['https://a.example.com', 'https://a.example.com']
    ).success).toBe(false);
    expect(canonicalFrameOriginAllowlist([
      'https://b.example.com', 'https://a.example.com', 'https://b.example.com'
    ])).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  test('allowlist plans keep the pointer, advance by one, and apply canonical origins', () => {
    const head = (version: number, origins: readonly string[]) => ({
      schemaVersion: 1,
      scope,
      kind: 'apply',
      activeReleaseId: releaseId,
      version,
      allowedFrameOrigins: origins,
      updatedByUserId: userId,
      updatedAt: now
    });
    const input = {
      action: 'surface_allowlist',
      kind: 'apply',
      allowedFrameOrigins: ['https://b.example.com', 'https://a.example.com'],
      expectedSurfaceHeadVersion: 2,
      scope,
      actorUserId: userId,
      occurredAt: now
    };
    const plan = {
      input,
      headBefore: head(2, []),
      headAfter: head(3, ['https://a.example.com', 'https://b.example.com'])
    };
    expect(releaseSurfaceAllowlistPlanSchema.parse(plan).headAfter.allowedFrameOrigins)
      .toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(() => releaseSurfaceAllowlistPlanSchema.parse({
      ...plan,
      headAfter: head(3, ['https://a.example.com'])
    })).toThrow();
    expect(() => releaseSurfaceAllowlistPlanSchema.parse({
      ...plan,
      headAfter: { ...head(3, ['https://a.example.com', 'https://b.example.com']), activeReleaseId: priorReleaseId }
    })).toThrow();
    expect(() => releaseSurfaceAllowlistPlanSchema.parse({
      input: { ...input, allowedFrameOrigins: [] },
      headBefore: head(2, []),
      headAfter: head(3, [])
    })).toThrow();
    const changeDiff = releaseSafeDiffSchema.parse({
      action: 'surface_allowlist',
      kind: 'apply',
      before: head(2, []),
      after: head(3, ['https://a.example.com', 'https://b.example.com'])
    });
    expect(changeDiff.action).toBe('surface_allowlist');
  });

  test('publish and rollback plans must carry the allowlist forward unchanged', () => {
    const origins = ['https://a.example.com'];
    const rollbackInput = {
      action: 'surface_rollback',
      kind: 'speakers',
      targetReleaseId: priorReleaseId,
      expectedSurfaceHeadVersion: 2,
      scope,
      actorUserId: userId,
      occurredAt: now
    };
    const head = (version: number, active: string, list: readonly string[]) => ({
      schemaVersion: 1,
      scope,
      kind: 'speakers',
      activeReleaseId: active,
      version,
      allowedFrameOrigins: list,
      updatedByUserId: userId,
      updatedAt: now
    });
    expect(releaseSurfaceRollbackPlanSchema.safeParse({
      input: rollbackInput,
      headBefore: head(2, releaseId, origins),
      headAfter: head(3, priorReleaseId, origins)
    }).success).toBe(true);
    expect(releaseSurfaceRollbackPlanSchema.safeParse({
      input: rollbackInput,
      headBefore: head(2, releaseId, origins),
      headAfter: head(3, priorReleaseId, [])
    }).success).toBe(false);
  });
});
