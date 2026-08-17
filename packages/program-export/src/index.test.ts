import { describe, expect, test } from 'bun:test';
import { programReleaseSchema, type AcceleventsExportConfiguration } from '@jooevents/contracts';
import {
  ACCELEVENTS_LOCATIONS_HEADER, ACCELEVENTS_SESSIONS_HEADER, ACCELEVENTS_SPEAKERS_HEADER,
  buildAcceleventsPackage, projectAcceleventsExportView, renderAcceleventsLocationsCsv,
  type AcceleventsExportSource
} from './index';

const digest = 'a'.repeat(64);
const ids = {
  workspace: '550e8400-e29b-41d4-a716-446655440000', event: '019c1df7-86b5-769b-bba4-5f7097bfe101',
  release: '019c1df7-86b5-769b-bba4-5f7097bfe301', user: '019c1df7-86b5-769b-bba4-5f7097bfe201',
  roomA: '019c1df7-86b5-769b-bba4-5f7097bfe401', roomB: '019c1df7-86b5-769b-bba4-5f7097bfe402',
  sessionA: '019c1df7-86b5-769b-bba4-5f7097bfe501', sessionB: '019c1df7-86b5-769b-bba4-5f7097bfe502',
  person: '019c1df7-86b5-769b-bba4-5f7097bfe601', format: '019c1df7-86b5-769b-bba4-5f7097bfe701',
  track: '019c1df7-86b5-769b-bba4-5f7097bfe801', occurrenceA: '019c1df7-86b5-769b-bba4-5f7097bfe901',
  occurrenceB: '019c1df7-86b5-769b-bba4-5f7097bfe902'
} as const;

function configuration(overrides: Partial<AcceleventsExportConfiguration> = {}): AcceleventsExportConfiguration {
  return {
    schemaVersion: 1, eventId: ids.event, version: 1, selectedReleaseId: ids.release,
    sessionType: 'IN_PERSON', formatMappings: [{ formatId: ids.format, remoteFormat: 'WORKSHOP' }],
    speakerNames: [{ personId: ids.person, firstName: 'Maya, "May"', lastName: '陈' }],
    roomBindings: [{ roomId: ids.roomA, kind: 'remote', locationId: 41 }, { roomId: ids.roomB, kind: 'no_location' }],
    primarySpeakers: [{ occurrenceId: ids.occurrenceA, personId: ids.person }],
    updatedAt: '2026-08-17T10:00:00.000Z', ...overrides
  };
}

function source(config = configuration()): AcceleventsExportSource {
  const release = programReleaseSchema.parse({
    schemaVersion: 1, scope: { workspaceId: ids.workspace, eventId: ids.event }, id: ids.release,
    number: 1, origin: { kind: 'publish' }, predecessor: null,
    pins: { sessionCatalog: { version: 1, digestSha256: digest }, scheduleVersion: 1, engagementSnapshotDigestSha256: digest, vocabulary: { setVersion: 1, digestSha256: digest }, eventSettingsVersion: 1 },
    rooms: [{ id: ids.roomA, name: 'Main, Hall' }, { id: ids.roomB, name: 'Side room' }],
    sessions: [{
      sessionId: ids.sessionA, title: 'Unicode systems — "now"', plannedDurationMinutes: 60,
      format: { id: ids.format, name: 'Workshop' }, track: { id: ids.track, name: 'AI, Systems', accent: 'sea' },
      occurrences: [
        { occurrenceId: ids.occurrenceA, roomId: ids.roomA, startAt: '2026-03-08T06:30:00.000Z', endAt: '2026-03-08T07:30:00.000Z' },
        { occurrenceId: ids.occurrenceB, roomId: ids.roomB, startAt: '2026-03-09T03:30:00.000Z', endAt: '2026-03-09T04:30:00.000Z' }
      ],
      participants: [{ personId: ids.person, role: 'moderator', position: 0, displayName: 'Maya 陈' }]
    }, {
      sessionId: ids.sessionB, title: 'Unplaced session', plannedDurationMinutes: 30,
      format: { id: ids.format, name: 'Workshop' }, track: null, occurrences: [],
      participants: [{ personId: ids.person, role: 'speaker', position: 0, displayName: 'Maya 陈' }]
    }],
    nameDeclassifications: [{ personId: ids.person, displayName: 'Maya 陈' }],
    releasedByUserId: ids.user, releasedAt: '2026-08-17T09:00:00.000Z', digestSha256: digest
  });
  return {
    event: { id: ids.event, name: 'River / Future', timezone: 'America/New_York', startDate: '2026-03-08', endDate: '2026-03-09' },
    releases: [release], profiles: [{ personId: ids.person, email: 'maya@example.test', pronouns: 'she/her', linkedInUrl: 'https://example.test/maya' }],
    configuration: config, lastGenerated: null
  };
}

describe('Accelevents export package', () => {
  test('freezes the exact vendor headers and RFC 4180 escaping', () => {
    const artifact = buildAcceleventsPackage(source(), '2026-08-17T10:05:00.000Z');
    expect(new TextDecoder().decode(artifact.files['locations.csv'])).toStartWith(`${ACCELEVENTS_LOCATIONS_HEADER}\r\n"Main, Hall",,N\r\n`);
    expect(new TextDecoder().decode(artifact.files['speakers.csv'])).toStartWith(`${ACCELEVENTS_SPEAKERS_HEADER}\r\n,"Maya, ""May""",陈,maya@example.test`);
    expect(new TextDecoder().decode(artifact.files['sessions.csv'])).toStartWith(`${ACCELEVENTS_SESSIONS_HEADER}\r\n`);
  });

  test('fans each occurrence into one row, converts in the event timezone, and emits no-location as zero', () => {
    const csv = new TextDecoder().decode(buildAcceleventsPackage(source(), '2026-08-17T10:05:00.000Z').files['sessions.csv']);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3);
    expect(csv).toContain('08/03/2026,01:30,03:30');
    expect(csv).toContain('08/03/2026,23:30,00:30');
    expect(csv).toContain(',0,,maya@example.test\r\n');
    expect(csv).not.toContain('Unplaced session');
  });

  test('reports every configured disclosure field and unplaced exclusion', () => {
    const view = projectAcceleventsExportView(source());
    expect(view.preflight.contains?.personalFields).toEqual(['name', 'email address', 'pronouns', 'profile links']);
    expect(view.unplacedSessions).toEqual([{ sessionId: ids.sessionB, title: 'Unplaced session' }]);
    expect(view.preflight.leftOut.some((item) => item.id === `unplaced-${ids.sessionB}`)).toBe(true);
  });

  test('names all missing preparation and stale-reference blockers', () => {
    const view = projectAcceleventsExportView(source(configuration({
      sessionType: null, formatMappings: [], speakerNames: [], roomBindings: [], primarySpeakers: [],
      selectedReleaseId: ids.release
    })));
    expect(view.preflight.blockers.map((item) => item.id)).toEqual(['session-type', 'locations']);
  });

  test('produces byte-identical ZIPs for identical inputs and generation time', () => {
    const first = buildAcceleventsPackage(source(), '2026-08-17T10:05:00.000Z');
    const second = buildAcceleventsPackage(source(), '2026-08-17T10:05:00.000Z');
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.filename).toBe('accelevents-program-export-river-future-r1.zip');
  });

  test('locations stage is available before the remote IDs are known', () => {
    const csv = renderAcceleventsLocationsCsv(source(configuration({ roomBindings: [] })));
    expect(csv).toBe(`${ACCELEVENTS_LOCATIONS_HEADER}\r\n"Main, Hall",,N\r\nSide room,,N\r\n`);
  });
});
