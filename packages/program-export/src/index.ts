import {
  acceleventsExportConfigurationSchema,
  acceleventsExportViewSchema,
  type AcceleventsExportConfiguration,
  type AcceleventsExportView,
  type AcceleventsPreflight,
  type AcceleventsRemoteFormat,
  type ProgramReleaseDto,
  type ReleasedParticipantDto
} from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const ACCELEVENTS_LOCATIONS_HEADER = 'Location,Source URL,Attendee Meetings';
export const ACCELEVENTS_SPEAKERS_HEADER = 'Speaker Id,First Name,Last Name,Email,Pronouns,Title,Company,Bio,LinkedIn URL,Instagram Handle,Twitter Handle,Override Profile Details,Allow to Edit Sessions,Primary Sessions,Secondary Sessions';
export const ACCELEVENTS_SESSIONS_HEADER = 'ID,Title,Format,Session Type,Start Date,Start Time,End Time,Full Detail,Capacity,Short Description,Tags,Tracks,Location Id,Primary speaker,Secondary speaker';

export interface AcceleventsApprovedSpeakerProfile {
  readonly personId: string;
  readonly email?: string;
  readonly pronouns?: string;
  readonly headline?: string;
  readonly linkedInUrl?: string;
  readonly instagramHandle?: string;
  readonly twitterHandle?: string;
}

export interface AcceleventsEventSource {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface AcceleventsExportSource {
  readonly event: AcceleventsEventSource;
  readonly releases: readonly ProgramReleaseDto[];
  readonly profiles: readonly AcceleventsApprovedSpeakerProfile[];
  readonly configuration: AcceleventsExportConfiguration;
  readonly lastGenerated?: { readonly at: string; readonly releaseNumber: number } | null;
}

export interface AcceleventsPackageArtifact {
  readonly releaseId: string;
  readonly releaseNumber: number;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly files: Readonly<Record<string, Uint8Array>>;
}

const encoder = new TextEncoder();
const EMPTY_CONFIGURATION_DATE = null;

export function emptyAcceleventsExportConfiguration(eventId: string): AcceleventsExportConfiguration {
  return acceleventsExportConfigurationSchema.parse({
    schemaVersion: 1,
    eventId,
    version: 0,
    selectedReleaseId: null,
    sessionType: null,
    formatMappings: [],
    speakerNames: [],
    roomBindings: [],
    primarySpeakers: [],
    updatedAt: EMPTY_CONFIGURATION_DATE
  });
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(values: readonly (string | number)[]): string {
  return values.map(csvField).join(',');
}

function sorted<T>(values: readonly T[], key: (item: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right), 'en'));
}

function releaseOption(release: ProgramReleaseDto) {
  const personIds = new Set(release.sessions.flatMap((session) =>
    session.participants.map((participant) => participant.personId)
  ));
  return {
    id: release.id,
    number: release.number,
    releasedAt: release.releasedAt,
    sessionCount: release.sessions.length,
    occurrenceCount: release.sessions.reduce((count, session) => count + session.occurrences.length, 0),
    roomCount: release.rooms.length,
    speakerCount: personIds.size
  };
}

function exactFormatPrefill(name: string): AcceleventsRemoteFormat | null {
  const normalized = name.trim().toLocaleLowerCase('en-US');
  const exact: Readonly<Record<string, AcceleventsRemoteFormat>> = Object.freeze({
    workshop: 'WORKSHOP',
    'main stage session': 'MAIN_STAGE_SESSION',
    'regular session': 'REGULAR_SESSION',
    'meet-up': 'MEET_UP',
    break: 'BREAK',
    expo: 'EXPO',
    other: 'OTHER'
  });
  return exact[normalized] ?? null;
}

function prefillName(displayName: string): { firstName: string; lastName: string; prefilled: boolean } {
  const tokens = displayName.trim().split(/\s+/u);
  return tokens.length === 2 && tokens[0] && tokens[1]
    ? { firstName: tokens[0], lastName: tokens[1], prefilled: true }
    : { firstName: '', lastName: '', prefilled: false };
}

function participantRoleLabel(participant: ReleasedParticipantDto): string {
  const labels: Readonly<Record<ReleasedParticipantDto['role'], string>> = {
    speaker: 'Speaker', moderator: 'Moderator', host: 'Host', panelist: 'Panelist'
  };
  return `${labels[participant.role]} in JooEvents`;
}

function selectedRelease(source: AcceleventsExportSource): ProgramReleaseDto | undefined {
  const configured = source.configuration.selectedReleaseId;
  return configured === null
    ? [...source.releases].sort((a, b) => b.number - a.number)[0]
    : source.releases.find((release) => release.id === configured);
}

function viewRows(source: AcceleventsExportSource, release: ProgramReleaseDto | undefined) {
  if (!release) return { formats: [], speakers: [], rooms: [], primaries: [], unplacedSessions: [] };
  const formatMappings = new Map(source.configuration.formatMappings.map((item) => [item.formatId, item.remoteFormat]));
  const speakerNames = new Map(source.configuration.speakerNames.map((item) => [item.personId, item]));
  const roomBindings = new Map(source.configuration.roomBindings.map((item) => [item.roomId, item]));
  const primarySpeakers = new Map(source.configuration.primarySpeakers.map((item) => [item.occurrenceId, item.personId]));
  const profiles = new Map(source.profiles.map((profile) => [profile.personId, profile]));

  const formatsById = new Map<string, { formatId: string; name: string; sessionCount: number; remoteFormat: AcceleventsRemoteFormat | null }>();
  const speakersById = new Map<string, { personId: string; displayName: string; sessionCount: number; firstName: string; lastName: string; prefilled: boolean; hasApprovedEmail: boolean }>();
  const roomsById = new Map(release.rooms.map((room) => [room.id, room]));
  const roomCounts = new Map<string, number>();
  const primaries: Array<{
    occurrenceId: string; sessionId: string; sessionTitle: string;
    candidates: Array<{ personId: string; displayName: string; roleLabel: string }>;
    primaryPersonId: string | null;
  }> = [];

  for (const session of release.sessions) {
    const format = formatsById.get(session.format.id);
    formatsById.set(session.format.id, {
      formatId: session.format.id,
      name: session.format.name,
      sessionCount: (format?.sessionCount ?? 0) + 1,
      remoteFormat: formatMappings.get(session.format.id) ?? exactFormatPrefill(session.format.name)
    });
    for (const participant of session.participants) {
      const existing = speakersById.get(participant.personId);
      const configuredName = speakerNames.get(participant.personId);
      const prefilled = prefillName(participant.displayName);
      speakersById.set(participant.personId, {
        personId: participant.personId,
        displayName: participant.displayName,
        sessionCount: (existing?.sessionCount ?? 0) + 1,
        firstName: configuredName?.firstName ?? prefilled.firstName,
        lastName: configuredName?.lastName ?? prefilled.lastName,
        prefilled: configuredName === undefined && prefilled.prefilled,
        hasApprovedEmail: Boolean(profiles.get(participant.personId)?.email)
      });
    }
    for (const occurrence of session.occurrences) {
      roomCounts.set(occurrence.roomId, (roomCounts.get(occurrence.roomId) ?? 0) + 1);
      const candidates = session.participants
        .filter((participant) => participant.role === 'moderator' || participant.role === 'host')
        .map((participant) => ({
          personId: participant.personId,
          displayName: participant.displayName,
          roleLabel: participantRoleLabel(participant)
        }));
      if (candidates.length > 0) primaries.push({
        occurrenceId: occurrence.occurrenceId,
        sessionId: session.sessionId,
        sessionTitle: session.title,
        candidates,
        primaryPersonId: primarySpeakers.get(occurrence.occurrenceId) ?? null
      });
    }
  }

  return {
    formats: sorted([...formatsById.values()], (item) => `${item.name}\u0000${item.formatId}`),
    speakers: sorted([...speakersById.values()], (item) => `${item.displayName}\u0000${item.personId}`),
    rooms: sorted([...roomCounts.entries()].map(([roomId, occurrenceCount]) => {
      const room = roomsById.get(roomId);
      if (!room) throw new TypeError('accelevents_release_room_missing');
      const binding = roomBindings.get(roomId);
      return {
        roomId,
        name: room.name,
        occurrenceCount,
        binding: binding === undefined ? null : binding.kind === 'remote'
          ? { kind: 'remote' as const, locationId: binding.locationId }
          : { kind: 'no_location' as const }
      };
    }), (item) => `${item.name}\u0000${item.roomId}`),
    primaries: sorted(primaries, (item) => `${item.sessionTitle}\u0000${item.occurrenceId}`),
    unplacedSessions: sorted(release.sessions
      .filter((session) => session.occurrences.length === 0)
      .map((session) => ({ sessionId: session.sessionId, title: session.title })),
    (item) => `${item.title}\u0000${item.sessionId}`)
  };
}

function listNames(names: readonly string[]): string {
  return names.join(', ');
}

function localDateTime(instant: string, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute) {
    throw new TypeError('accelevents_timezone_projection_failed');
  }
  return {
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    date: `${parts.day}/${parts.month}/${parts.year}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

function preflight(source: AcceleventsExportSource, release: ProgramReleaseDto | undefined, rows: ReturnType<typeof viewRows>): AcceleventsPreflight {
  if (!release) return { blockers: [], leftOut: [], contains: null, consequences: [], ready: false };
  const blockers: Array<{ id: string; summary: string; anchor: string }> = [];
  if (source.configuration.sessionType === null) blockers.push({
    id: 'session-type', summary: 'Every session row needs a session type — in person, virtual, or hybrid — and none is chosen yet.', anchor: '#mapping'
  });
  const unmapped = rows.formats.filter((format) => format.remoteFormat === null);
  if (unmapped.length) blockers.push({
    id: 'formats', summary: `${unmapped.length === 1 ? 'One format has' : `${unmapped.length} formats have`} no Accelevents format yet: ${listNames(unmapped.map((format) => format.name))}.`, anchor: '#mapping'
  });
  const unnamed = rows.speakers.filter((speaker) => !speaker.firstName.trim() || !speaker.lastName.trim());
  if (unnamed.length) blockers.push({
    id: 'names', summary: `${unnamed.length === 1 ? 'One speaker is' : `${unnamed.length} speakers are`} missing a first or last name: ${listNames(unnamed.map((speaker) => speaker.displayName))}.`, anchor: '#speakers'
  });
  const unmailed = rows.speakers.filter((speaker) => !speaker.hasApprovedEmail);
  if (unmailed.length) blockers.push({
    id: 'emails', summary: `${unmailed.length === 1 ? 'One speaker has' : `${unmailed.length} speakers have`} no email on file: ${listNames(unmailed.map((speaker) => speaker.displayName))}. Accelevents matches speakers by email.`, anchor: '/app/speakers'
  });
  const unbound = rows.rooms.filter((room) => room.binding === null);
  if (unbound.length) blockers.push({
    id: 'locations', summary: `${unbound.length === 1 ? 'One room has' : `${unbound.length} rooms have`} no Accelevents location ID yet: ${listNames(unbound.map((room) => room.name))}.`, anchor: '#locations'
  });

  for (const session of release.sessions) {
    if (session.title.length > 255) blockers.push({
      id: `title-${session.sessionId}`,
      summary: `“${session.title}” is longer than Accelevents' 255-character session-title limit.`,
      anchor: '/app/schedule'
    });
    if (session.track && session.track.name.length > 50) blockers.push({
      id: `track-${session.track.id}`,
      summary: `The track “${session.track.name}” is longer than Accelevents' 50-character track-name limit.`,
      anchor: '/app/settings/program'
    });
    for (const occurrence of session.occurrences) {
      if (!(occurrence.startAt < occurrence.endAt)) blockers.push({
        id: `time-${occurrence.occurrenceId}`,
        summary: `“${session.title}” has an end time that does not follow its start time.`,
        anchor: '/app/schedule'
      });
      const start = localDateTime(occurrence.startAt, source.event.timezone).isoDate;
      const end = localDateTime(occurrence.endAt, source.event.timezone).isoDate;
      if (start < source.event.startDate || end > source.event.endDate) blockers.push({
        id: `date-${occurrence.occurrenceId}`,
        summary: `“${session.title}” falls outside the event's date range in ${source.event.timezone}.`,
        anchor: '/app/schedule'
      });
    }
  }

  const formatIds = new Set(rows.formats.map((item) => item.formatId));
  const roomIds = new Set(rows.rooms.map((item) => item.roomId));
  const personIds = new Set(rows.speakers.map((item) => item.personId));
  const occurrenceIds = new Set(release.sessions.flatMap((session) => session.occurrences.map((item) => item.occurrenceId)));
  const validPrimaryChoices = new Set(rows.primaries.flatMap((row) =>
    row.candidates.map((candidate) => `${row.occurrenceId}:${candidate.personId}`)
  ));
  const stale = [
    ...source.configuration.formatMappings.filter((item) => !formatIds.has(item.formatId)).map((item) => `format ${item.formatId}`),
    ...source.configuration.roomBindings.filter((item) => !roomIds.has(item.roomId)).map((item) => `room ${item.roomId}`),
    ...source.configuration.speakerNames.filter((item) => !personIds.has(item.personId)).map((item) => `speaker ${item.personId}`),
    ...source.configuration.primarySpeakers.filter((item) => !occurrenceIds.has(item.occurrenceId)).map((item) => `occurrence ${item.occurrenceId}`),
    ...source.configuration.primarySpeakers
      .filter((item) => occurrenceIds.has(item.occurrenceId) && !validPrimaryChoices.has(`${item.occurrenceId}:${item.personId}`))
      .map((item) => `primary choice for occurrence ${item.occurrenceId}`)
  ];
  if (stale.length) blockers.push({
    id: 'stale-configuration',
    summary: `The saved preparation refers to ${stale.length === 1 ? 'an item' : `${stale.length} items`} outside this release. Choose the release again to review its mappings.`,
    anchor: '#release'
  });

  const leftOut = [
    ...rows.unplacedSessions.map((session) => ({
      id: `unplaced-${session.sessionId}`,
      summary: `“${session.title}” is released but not scheduled, so it has no time to import.`
    })),
    { id: 'headshots', summary: 'Headshots — the Accelevents CSV import cannot carry images.' },
    { id: 'editorial', summary: 'Bios, company names, and session descriptions — no approved copy exists for them, so those columns stay blank.' }
  ];
  const consequences = [
    ...(release.sessions.some((session) => session.track)
      ? [{ id: 'tracks', summary: 'Create the listed tracks in Accelevents before importing sessions.' }]
      : []),
    { id: 'notifications', summary: 'Accelevents may email each imported speaker if its own notifications are turned on.' },
    ...rows.primaries.filter((item) => item.primaryPersonId).map((item) => ({
      id: `primary-${item.occurrenceId}`,
      summary: `${item.candidates.find((candidate) => candidate.personId === item.primaryPersonId)?.displayName ?? 'The chosen speaker'} becomes a primary speaker in Accelevents and can edit and moderate “${item.sessionTitle}” there.`
    })),
    ...(source.lastGenerated ? [{
      id: 'repeat',
      summary: 'A package for this event was already generated. Importing both creates duplicate speakers and sessions in Accelevents.'
    }] : [])
  ];
  return {
    blockers,
    leftOut,
    contains: {
      locations: rows.rooms.filter((room) => room.binding?.kind !== 'no_location').length,
      speakers: rows.speakers.length,
      sessionRows: release.sessions.reduce((count, session) => count + session.occurrences.length, 0),
      personalFields: [
        'name', 'email address',
        ...(source.profiles.some((profile) => profile.pronouns) ? ['pronouns'] : []),
        ...(source.profiles.some((profile) => profile.headline) ? ['headline'] : []),
        ...(source.profiles.some((profile) => profile.linkedInUrl || profile.instagramHandle || profile.twitterHandle) ? ['profile links'] : [])
      ]
    },
    consequences,
    ready: blockers.length === 0
  };
}

export function projectAcceleventsExportView(sourceInput: AcceleventsExportSource): AcceleventsExportView {
  const configuration = acceleventsExportConfigurationSchema.parse(sourceInput.configuration);
  if (configuration.eventId !== sourceInput.event.id) throw new TypeError('accelevents_export_scope_mismatch');
  const releases = [...sourceInput.releases].sort((left, right) => right.number - left.number);
  const release = selectedRelease({ ...sourceInput, releases, configuration });
  const effectiveConfiguration = configuration.selectedReleaseId === null && release
    ? { ...configuration, selectedReleaseId: release.id }
    : configuration;
  const source = { ...sourceInput, releases, configuration: effectiveConfiguration };
  const rows = viewRows(source, release);
  const report = preflight(source, release, rows);
  return acceleventsExportViewSchema.parse({
    schemaVersion: 1,
    eventId: source.event.id,
    configurationVersion: configuration.version,
    timezone: source.event.timezone,
    releases: releases.map(releaseOption),
    selectedReleaseId: release?.id ?? null,
    sessionType: configuration.sessionType,
    ...rows,
    preflight: report,
    lastGenerated: source.lastGenerated ?? null,
    locationsCsvPath: release ? `/api/events/current/integrations/accelevents/locations.csv?releaseId=${release.id}` : null,
    packagePath: report.ready && source.lastGenerated
      ? `/api/events/current/integrations/accelevents/package.zip?releaseId=${release!.id}`
      : null
  });
}

export function renderAcceleventsLocationsCsv(source: AcceleventsExportSource): string {
  const view = projectAcceleventsExportView(source);
  const rows = view.rooms
    .filter((room) => room.binding?.kind !== 'no_location')
    .map((room) => csvLine([room.name, '', 'N']));
  return [ACCELEVENTS_LOCATIONS_HEADER, ...rows].join('\r\n') + '\r\n';
}

function requireReady(source: AcceleventsExportSource) {
  const view = projectAcceleventsExportView(source);
  const release = source.releases.find((candidate) => candidate.id === view.selectedReleaseId);
  if (!release || !view.preflight.ready) {
    const error = new Error('accelevents_export_blocked');
    Object.assign(error, { blockers: view.preflight.blockers });
    throw error;
  }
  return { view, release };
}

function speakerEmailsByOccurrence(source: AcceleventsExportSource, release: ProgramReleaseDto) {
  const profiles = new Map(source.profiles.map((profile) => [profile.personId, profile]));
  const primaries = new Map(source.configuration.primarySpeakers.map((item) => [item.occurrenceId, item.personId]));
  return new Map(release.sessions.flatMap((session) => session.occurrences.map((occurrence) => {
    const primary = primaries.get(occurrence.occurrenceId);
    const participantEmails = session.participants.map((participant) => ({
      personId: participant.personId,
      email: profiles.get(participant.personId)?.email ?? ''
    }));
    return [occurrence.occurrenceId, {
      primary: participantEmails.filter((item) => item.personId === primary).map((item) => item.email),
      secondary: participantEmails.filter((item) => item.personId !== primary).map((item) => item.email)
    }] as const;
  })));
}

function renderSpeakersCsv(source: AcceleventsExportSource, release: ProgramReleaseDto, view: AcceleventsExportView): string {
  const profiles = new Map(source.profiles.map((profile) => [profile.personId, profile]));
  const rows = view.speakers.map((speaker) => {
    const profile = profiles.get(speaker.personId);
    return csvLine([
      '', speaker.firstName, speaker.lastName, profile?.email ?? '', profile?.pronouns ?? '',
      profile?.headline ?? '', '', '', profile?.linkedInUrl ?? '', profile?.instagramHandle ?? '',
      profile?.twitterHandle ?? '', 'N', 'N', '', ''
    ]);
  });
  return [ACCELEVENTS_SPEAKERS_HEADER, ...rows].join('\r\n') + '\r\n';
}

function renderSessionsCsv(source: AcceleventsExportSource, release: ProgramReleaseDto, view: AcceleventsExportView): string {
  const formats = new Map(view.formats.map((item) => [item.formatId, item.remoteFormat]));
  const roomBindings = new Map(view.rooms.map((item) => [item.roomId, item.binding]));
  const emails = speakerEmailsByOccurrence(source, release);
  const rows: string[] = [];
  for (const session of release.sessions) {
    for (const occurrence of session.occurrences) {
      const start = localDateTime(occurrence.startAt, source.event.timezone);
      const end = localDateTime(occurrence.endAt, source.event.timezone);
      const binding = roomBindings.get(occurrence.roomId);
      const occurrenceEmails = emails.get(occurrence.occurrenceId);
      rows.push(csvLine([
        '', session.title, formats.get(session.format.id) ?? '', source.configuration.sessionType ?? '',
        start.date, start.time, end.time, '', '', '', '', session.track?.name ?? '',
        binding?.kind === 'remote' ? binding.locationId : 0,
        occurrenceEmails?.primary.join(',') ?? '', occurrenceEmails?.secondary.join(',') ?? ''
      ]));
    }
  }
  return [ACCELEVENTS_SESSIONS_HEADER, ...rows].join('\r\n') + '\r\n';
}

function slug(value: string): string {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 80);
  return normalized || 'event';
}

function guide(source: AcceleventsExportSource, release: ProgramReleaseDto, view: AcceleventsExportView): string {
  const tracks = sorted([...new Set(release.sessions.flatMap((session) => session.track?.name ?? []))], (item) => item);
  return `# Import this JooEvents program into Accelevents\n\n`
    + `This package was prepared from ${source.event.name}, program release ${release.number}. `
    + `Its session dates and times use ${source.event.timezone}.\n\n`
    + `The files contain speaker contact data and leave JooEvents control when downloaded.\n\n`
    + `## Import order\n\n`
    + `1. Import locations.csv. If you used the guided room step, these locations already exist; use this file only for the initial location stage.\n`
    + `${tracks.length ? `2. Create these tracks in Accelevents exactly as written: ${tracks.join(', ')}.\n` : '2. No tracks need to be prepared.\n'}`
    + `3. Turn off or review Accelevents speaker notifications before continuing. Accelevents may email imported speakers when its notifications are enabled.\n`
    + `4. Import speakers.csv.\n`
    + `5. Import sessions.csv.\n\n`
    + `## What this package does not do\n\n`
    + `This is an initial-import package. Speaker Id and session ID are blank, so importing another package can create duplicates. `
    + `The package does not update or delete Accelevents records. It omits headshots, bios, company names, and session descriptions. `
    + `${view.unplacedSessions.length} released ${view.unplacedSessions.length === 1 ? 'session was' : 'sessions were'} left out because ${view.unplacedSessions.length === 1 ? 'it was' : 'they were'} not scheduled.\n`;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 255, (value >>> 8) & 255);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

/** Deterministic ZIP (stored entries, UTF-8 names, fixed 1980 DOS timestamp). */
export function deterministicZip(files: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const name of Object.keys(files).sort()) {
    const data = files[name]!;
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
      u32(crc), u32(data.byteLength), u32(data.byteLength), u16(nameBytes.byteLength), u16(0),
      nameBytes, data
    ]);
    localParts.push(local);
    centralParts.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
      u32(crc), u32(data.byteLength), u32(data.byteLength), u16(nameBytes.byteLength),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes
    ]));
    offset += local.byteLength;
  }
  const central = concat(centralParts);
  const count = centralParts.length;
  return concat([...localParts, central, concat([
    u32(0x06054b50), u16(0), u16(0), u16(count), u16(count),
    u32(central.byteLength), u32(offset), u16(0)
  ])]);
}

export function buildAcceleventsPackage(source: AcceleventsExportSource, generatedAt: string): AcceleventsPackageArtifact {
  const { view, release } = requireReady(source);
  const manifest = {
    schemaVersion: 1,
    source: {
      eventId: source.event.id,
      programReleaseId: release.id,
      programReleaseNumber: release.number,
      programReleaseDigestSha256: release.digestSha256
    },
    generatedAt,
    timezone: source.event.timezone,
    sessionType: source.configuration.sessionType,
    rows: release.sessions.flatMap((session) => session.occurrences.map((occurrence) => ({
      sourceIdentity: `${session.sessionId}:${occurrence.occurrenceId}`,
      sessionId: session.sessionId,
      occurrenceId: occurrence.occurrenceId
    }))),
    exclusions: view.unplacedSessions.map((session) => ({
      kind: 'unplaced_session', sessionId: session.sessionId, title: session.title
    }))
  };
  const files = Object.freeze({
    'import-guide.md': encoder.encode(guide(source, release, view)),
    'locations.csv': encoder.encode(renderAcceleventsLocationsCsv(source)),
    'manifest.json': encoder.encode(`${canonicalJsonText(manifest)}\n`),
    'sessions.csv': encoder.encode(renderSessionsCsv(source, release, view)),
    'speakers.csv': encoder.encode(renderSpeakersCsv(source, release, view))
  });
  const bytes = deterministicZip(files);
  return Object.freeze({
    releaseId: release.id,
    releaseNumber: release.number,
    filename: `accelevents-program-export-${slug(source.event.name)}-r${release.number}.zip`,
    bytes,
    sha256: bytesToHex(sha256(bytes)),
    files
  });
}
