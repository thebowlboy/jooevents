import {
  programReleaseSchema,
  releaseScopeSchema,
  servedPublicRosterSchema,
  servedPublicPresentationSchema,
  servedPublicScheduleSchema,
  styleSetReleaseSchema,
  surfaceHeadSchema,
  surfaceReleaseSchema,
  type EngagementSnapshotDto,
  type ProgramReleaseDto,
  type ReleaseScheduleConflictDto,
  type ReleaseScopeDto,
  type SchedulePlacementSnapshotDto,
  type ServedPublicRosterDto,
  type ServedPublicPresentationDto,
  type ServedPublicScheduleDto,
  type SessionCatalogDto,
  type StyleSetReleaseDto,
  type SurfaceHeadDto,
  type SurfaceKind,
  type SurfaceReleaseDto,
  type ReleaseTemplateRevisionPinDto,
  type TemplateArtifactDocumentDto
} from '@jooevents/contracts';
import { canonicalJsonSha256 } from '@jooevents/changesets';

export type ReleaseScope = ReleaseScopeDto;
export type ProgramRelease = ProgramReleaseDto;
export type StyleSetRelease = StyleSetReleaseDto;
export type SurfaceRelease = SurfaceReleaseDto;
export type SurfaceHead = SurfaceHeadDto;

export function releaseDigest(unsigned: unknown): string {
  return canonicalJsonSha256(unsigned);
}

export function parseReleaseScope(value: unknown): ReleaseScope {
  return deepFreeze(releaseScopeSchema.parse(value));
}

export function parseProgramRelease(value: unknown): ProgramRelease {
  const release = programReleaseSchema.parse(value);
  const { digestSha256, ...unsigned } = release;
  if (releaseDigest(unsigned) !== digestSha256) throw new TypeError('program_release_digest_mismatch');
  return deepFreeze(release);
}

export function parseStyleSetRelease(value: unknown): StyleSetRelease {
  const release = styleSetReleaseSchema.parse(value);
  const { digestSha256, ...unsigned } = release;
  if (releaseDigest(unsigned) !== digestSha256) throw new TypeError('style_set_release_digest_mismatch');
  return deepFreeze(release);
}

export function parseSurfaceRelease(value: unknown): SurfaceRelease {
  const release = surfaceReleaseSchema.parse(value);
  const { digestSha256, ...unsigned } = release;
  if (releaseDigest(unsigned) !== digestSha256) throw new TypeError('surface_release_digest_mismatch');
  return deepFreeze(release);
}

export function parseSurfaceHead(value: unknown): SurfaceHead {
  return deepFreeze(surfaceHeadSchema.parse(value));
}

export function sameReleaseScope(left: ReleaseScope, right: ReleaseScope): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

/**
 * The public schedule as one immutable program release serves it. A named
 * projection over release content only: the confirmed-and-visible gate already
 * ran at materialization, so this derivation may only narrow — sessions keep
 * their released order, speakers become display names in released order, and
 * person identifiers do not survive into the output. The release is
 * re-verified (schema + content digest) so a tampered row refuses to serve.
 */
export function projectServedPublicSchedule(release: ProgramRelease): ServedPublicScheduleDto {
  const verified = parseProgramRelease(release);
  return deepFreeze(servedPublicScheduleSchema.parse({
    schemaVersion: 1,
    releaseNumber: verified.number,
    rooms: verified.rooms.map((room) => ({ id: room.id, name: room.name })),
    sessions: verified.sessions.map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      plannedDurationMinutes: session.plannedDurationMinutes,
      format: session.format.name,
      track: session.track === null
        ? null
        : { name: session.track.name, accent: session.track.accent },
      occurrences: session.occurrences.map((occurrence) => ({ ...occurrence })),
      speakers: session.participants.map((participant) => participant.displayName)
    }))
  }));
}

/**
 * The public speakers page as one immutable program release serves it: the
 * union of publicly visible session appearances, one card per released person,
 * ordered by display name. The released person key orders ties and groups
 * appearances internally but never enters the projection — a public card
 * carries a name and its appearances, not an identifier.
 */
export function projectServedPublicRoster(release: ProgramRelease): ServedPublicRosterDto {
  const verified = parseProgramRelease(release);
  const byPerson = new Map<string, {
    readonly name: string;
    readonly sessions: Map<string, string>;
  }>();
  for (const session of verified.sessions) {
    for (const participant of session.participants) {
      const card = byPerson.get(participant.personId)
        ?? { name: participant.displayName, sessions: new Map<string, string>() };
      card.sessions.set(session.sessionId, session.title);
      byPerson.set(participant.personId, card);
    }
  }
  const speakers = [...byPerson.entries()]
    .sort(([leftPersonId, left], [rightPersonId, right]) =>
      left.name !== right.name
        ? (left.name < right.name ? -1 : 1)
        : (leftPersonId < rightPersonId ? -1 : 1))
    .map(([, card]) => ({
      name: card.name,
      sessions: [...card.sessions.keys()].sort().map((sessionId) => ({
        sessionId,
        title: card.sessions.get(sessionId)!
      }))
    }));
  return deepFreeze(servedPublicRosterSchema.parse({
    schemaVersion: 1,
    releaseNumber: verified.number,
    speakers
  }));
}

/**
 * Narrows an active surface release and its exact style-set pin to the
 * presentation facts an anonymous renderer needs. The pair is re-verified and
 * must share scope; a broken style pin is never replaced with live/default
 * organizer state.
 */
export function projectServedPublicPresentation(input: {
  readonly surface: SurfaceRelease;
  readonly style: StyleSetRelease;
}): ServedPublicPresentationDto {
  const surface = parseSurfaceRelease(input.surface);
  const style = parseStyleSetRelease(input.style);
  if (!sameReleaseScope(surface.scope, style.scope)
      || surface.styleSetReleaseId !== style.id) {
    throw new TypeError('surface_style_release_mismatch');
  }
  return deepFreeze(servedPublicPresentationSchema.parse({
    schemaVersion: 1,
    surfaceKind: surface.kind,
    surfaceReleaseNumber: surface.number,
    manifest: surface.manifest,
    styleSetReleaseNumber: style.number,
    style: style.recipe
  }));
}

/**
 * Program Vocabulary evidence exactly as release materialization consumes it:
 * the set pin plus the room-name projection released occurrences reference.
 * The composing runtime derives it from the canonical vocabulary repository.
 */
export interface ReleaseVocabularyEvidence {
  readonly scope: ReleaseScope;
  readonly setVersion: number;
  readonly setDigestSha256: string;
  readonly rooms: readonly { readonly id: string; readonly name: string }[];
  readonly tracks: readonly { readonly id: string; readonly status: 'active' | 'retired' }[];
}

/**
 * Read surface of the release domain. Release-chain reads serve the domain's
 * own state; the `readRelease*` materialization sources snapshot the upstream
 * domains a program release is derived from, wired by composition to the
 * canonical repositories — the release domain never re-implements them.
 * `readReleaseParticipantDisplayName` is the audited declassification source:
 * it resolves one person's display name (never contact data) from the
 * governed intake projection, and the copy it feeds appears verbatim in the
 * reviewed release diff.
 */
export interface ReleaseReadPort {
  readCurrentProgramRelease(scope: ReleaseScope): ProgramRelease | undefined;
  readProgramRelease(scope: ReleaseScope, releaseId: string): ProgramRelease | undefined;
  readCurrentStyleSetRelease(scope: ReleaseScope): StyleSetRelease | undefined;
  readStyleSetRelease(scope: ReleaseScope, releaseId: string): StyleSetRelease | undefined;
  readSurfaceHead(scope: ReleaseScope, kind: SurfaceKind): SurfaceHead | undefined;
  readSurfaceRelease(scope: ReleaseScope, releaseId: string): SurfaceRelease | undefined;
  listFormSurfaceHeads(scope: ReleaseScope): readonly SurfaceHead[];

  readReleaseSessionCatalog(scope: ReleaseScope): SessionCatalogDto | undefined;
  readReleaseSchedule(scope: ReleaseScope): SchedulePlacementSnapshotDto | undefined;
  readReleaseEngagementSnapshot(scope: ReleaseScope): EngagementSnapshotDto | undefined;
  readReleaseVocabulary(scope: ReleaseScope): ReleaseVocabularyEvidence | undefined;
  readReleaseEventSettingsVersion(scope: ReleaseScope): number | undefined;
  /** Current block-severity conflict sweep from the schedule domain; any entry refuses publish. */
  readReleaseScheduleConflicts(scope: ReleaseScope): readonly ReleaseScheduleConflictDto[];
  readReleaseParticipantDisplayName(scope: ReleaseScope, personId: string): string | undefined;
  /** The republished-form pin source: the form's current published version, if any. */
  readReleasePublishedFormVersionId(scope: ReleaseScope, formId: string): string | undefined;
  /** Canonical current Template snapshot used to verify and derive presentation releases. */
  readReleaseTemplateArtifact?(
    scope: ReleaseScope,
    pin: ReleaseTemplateRevisionPinDto
  ): TemplateArtifactDocumentDto | undefined;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
