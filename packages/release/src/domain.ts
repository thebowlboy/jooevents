import { canonicalJsonSha256 } from '@jooevents/kernel';
import {
  canonicalFrameOriginAllowlist,
  releasedSessionSchema,
  releaseMutationPlanSchema,
  releaseMutationResultSchema,
  releaseActionSchema,
  releaseIdSchema,
  releasePlanningErrorCodeSchema,
  releasePlanningInputSchema,
  releaseProgramPlanSchema,
  releaseStyleSetPlanSchema,
  surfaceManifestSchema,
  releaseSurfaceAllowlistPlanSchema,
  releaseSurfacePublishPlanSchema,
  releaseSurfaceRollbackPlanSchema,
  releaseSurfaceSuccessorInputSchema,
  releaseSurfaceSuccessorPlanSchema,
  type ProgramReleaseDto,
  type PublicThemeTokenName,
  type ReleaseMutationPlanDto,
  type ReleaseMutationResultDto,
  type ReleaseNameDeclassificationDto,
  type ReleasePlanningErrorCode,
  type ReleasePlanningInput,
  type ReleaseProgramPlanDto,
  type ReleaseSafeDiffDto,
  type ReleaseScheduleConflictDto,
  type ReleaseScopeDto,
  type ReleaseStyleSetPlanDto,
  type ReleaseTemplateRevisionPinDto,
  type ReleaseSurfaceAllowlistPlanDto,
  type ReleaseSurfacePublishPlanDto,
  type ReleaseSurfaceRollbackPlanDto,
  type ReleaseSurfaceSuccessorInputDto,
  type ReleaseSurfaceSuccessorPlanDto,
  type ReleasedRoomDto,
  type ReleasedSessionDto,
  type SessionHeadDto,
  type StyleSetRecipeDto,
  type SurfaceManifestDto,
  type SurfaceHeadDto,
  type SurfaceKind,
  type SurfaceReleaseDto
} from '@jooevents/contracts';
import { z } from 'zod';

import { encodeCanonicalJson } from '@jooevents/kernel';
import {
  parseProgramRelease,
  parseStyleSetRelease,
  parseSurfaceHead,
  parseSurfaceRelease,
  releaseDigest,
  sameReleaseScope,
  type ProgramRelease,
  type ReleaseReadPort,
  type ReleaseScope,
  type StyleSetRelease,
  type SurfaceRelease
} from './model';

export class ReleasePlanningError extends Error {
  constructor(
    readonly code: ReleasePlanningErrorCode,
    readonly conflicts?: readonly ReleaseScheduleConflictDto[]
  ) {
    super(code);
    this.name = 'ReleasePlanningError';
  }
}

export const releaseStaleDetailSchema = z.strictObject({
  code: releasePlanningErrorCodeSchema,
  action: releaseActionSchema,
  subjectId: releaseIdSchema.nullable()
});

export function programReleaseChainGuardId(eventId: string): string {
  return `program_release_chain:${eventId}`;
}

export function styleSetReleaseChainGuardId(eventId: string): string {
  return `style_set_release_chain:${eventId}`;
}

export function surfaceHeadGuardId(eventId: string, kind: SurfaceKind): string {
  return `surface_head_state:${eventId}:${kind}`;
}

/**
 * Deterministic guard evidence over one release chain head, including its
 * absence: the same current state always produces the same `(version, digest)`
 * pair on the planning and commit sides.
 */
export function releaseChainGuard(
  current: { readonly number: number; readonly digestSha256: string } | undefined
): { readonly version: number; readonly digest: string } {
  return Object.freeze({
    version: (current?.number ?? 0) + 1,
    digest: canonicalJsonSha256({ current: current?.digestSha256 ?? null })
  });
}

export function surfaceHeadGuard(
  head: SurfaceHeadDto | undefined
): { readonly version: number; readonly digest: string } {
  return Object.freeze({
    version: (head?.version ?? 0) + 1,
    digest: canonicalJsonSha256({ active: head?.activeReleaseId ?? null })
  });
}

/**
 * Deterministic content-derived release identity for plans that must replay
 * byte-identically without an id factory (compensations and hosted successor
 * releases): the leading 128 bits of a canonical-JSON SHA-256 carrying UUID
 * version/variant nibbles. Opaque; nothing may infer chronology from it.
 */
export function deterministicReleaseId(
  scope: ReleaseScope,
  purpose: string,
  seed: Record<string, string | number>
): string {
  const hex = canonicalJsonSha256({
    domain: 'release',
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    purpose,
    ...seed
  });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}`
    + `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const NAME_MAX = 300;

function declassifiedDisplayName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return normalized.length > 0 && normalized.length <= NAME_MAX ? normalized : undefined;
}

interface MaterializedProgramContent {
  readonly pins: ProgramReleaseDto['pins'];
  readonly rooms: readonly ReleasedRoomDto[];
  readonly sessions: readonly ReleasedSessionDto[];
  readonly nameDeclassifications: readonly ReleaseNameDeclassificationDto[];
}

/**
 * The materialization gate. Content enters a program release only when every
 * clause holds — state, never placement:
 *
 * - the session's lifecycle is `programmed` (a placed `collecting` or `draft`
 *   session never appears, whatever the grid says);
 * - a participant appears only when its roster flag is `publiclyVisible` AND
 *   its `(sessionId, personId)` engagement is `confirmed`;
 * - each released participant's display name resolves through the governed
 *   declassification source — an unresolvable name refuses the publish rather
 *   than releasing a partial or contact-bearing row.
 *
 * Occurrences are projected for released sessions only; every other
 * occurrence — including placements of collecting sessions — is dropped here,
 * so serving can never re-leak it.
 */
export function materializeProgramContent(
  scope: ReleaseScope,
  port: ReleaseReadPort
): MaterializedProgramContent {
  const catalog = port.readReleaseSessionCatalog(scope);
  const schedule = port.readReleaseSchedule(scope);
  const engagements = port.readReleaseEngagementSnapshot(scope);
  const vocabulary = port.readReleaseVocabulary(scope);
  const eventSettingsVersion = port.readReleaseEventSettingsVersion(scope);
  if (!catalog || !schedule || !engagements || !vocabulary || eventSettingsVersion === undefined
      || !sameReleaseScope(catalog.scope, scope) || !sameReleaseScope(schedule.scope, scope)
      || !sameReleaseScope(engagements.scope, scope)
      || !sameReleaseScope(vocabulary.scope, scope)) {
    throw new ReleasePlanningError('wrong_scope');
  }

  const confirmed = new Set<string>();
  for (const engagement of engagements.engagements) {
    if (engagement.state === 'confirmed') {
      confirmed.add(`${engagement.sessionId}:${engagement.personId}`);
    }
  }

  const occurrencesBySession = new Map<string, ReleasedSessionDto['occurrences'][number][]>();
  for (const occurrence of schedule.occurrences) {
    const list = occurrencesBySession.get(occurrence.sessionId) ?? [];
    list.push({
      occurrenceId: occurrence.id,
      roomId: occurrence.roomId,
      startAt: occurrence.startAt,
      endAt: occurrence.endAt
    });
    occurrencesBySession.set(occurrence.sessionId, list);
  }

  const roomNames = new Map(vocabulary.rooms.map((room) => [room.id, room.name]));
  const eventUsesTracks = vocabulary.tracks.some((track) => track.status === 'active');
  const usedRoomIds = new Set<string>();
  const releasedNames = new Map<string, string>();
  const sessions: ReleasedSessionDto[] = [];
  for (const session of catalog.sessions) {
    if (session.lifecycle !== 'programmed') continue;
    if (eventUsesTracks && session.programTarget.track === null) {
      throw new ReleasePlanningError('session_track_required');
    }
    sessions.push(releasedSessionFrom({
      session,
      occurrences: occurrencesBySession.get(session.id) ?? [],
      confirmed,
      usedRoomIds,
      releasedNames,
      scope,
      port
    }));
  }

  const rooms = [...usedRoomIds].sort().map((roomId) => {
    const name = roomNames.get(roomId);
    if (name === undefined) throw new ReleasePlanningError('invalid_plan');
    return Object.freeze({ id: roomId, name });
  });

  return Object.freeze({
    pins: Object.freeze({
      sessionCatalog: Object.freeze({
        version: catalog.version,
        digestSha256: catalog.digestSha256
      }),
      scheduleVersion: schedule.scheduleVersion,
      engagementSnapshotDigestSha256: canonicalJsonSha256(engagements),
      vocabulary: Object.freeze({
        setVersion: vocabulary.setVersion,
        digestSha256: vocabulary.setDigestSha256
      }),
      eventSettingsVersion
    }),
    rooms: Object.freeze(rooms),
    sessions: Object.freeze(sessions),
    nameDeclassifications: Object.freeze(
      [...releasedNames.keys()].sort().map((personId) => Object.freeze({
        personId,
        displayName: releasedNames.get(personId)!
      }))
    )
  });
}

function releasedSessionFrom(input: {
  readonly session: SessionHeadDto;
  readonly occurrences: readonly ReleasedSessionDto['occurrences'][number][];
  readonly confirmed: ReadonlySet<string>;
  readonly usedRoomIds: Set<string>;
  readonly releasedNames: Map<string, string>;
  readonly scope: ReleaseScope;
  readonly port: ReleaseReadPort;
}): ReleasedSessionDto {
  const participants = [];
  for (const participant of input.session.roster.participants) {
    if (!participant.publiclyVisible) continue;
    if (!input.confirmed.has(`${input.session.id}:${participant.personId}`)) continue;
    const known = input.releasedNames.get(participant.personId);
    const displayName = known
      ?? declassifiedDisplayName(
        input.port.readReleaseParticipantDisplayName(input.scope, participant.personId)
      );
    if (displayName === undefined) throw new ReleasePlanningError('participant_name_unavailable');
    input.releasedNames.set(participant.personId, displayName);
    participants.push({
      personId: participant.personId,
      role: participant.role,
      position: participant.position,
      displayName
    });
  }
  participants.sort((left, right) =>
    left.position !== right.position
      ? left.position - right.position
      : left.personId < right.personId ? -1 : 1
  );
  const occurrences = [...input.occurrences].sort((left, right) => {
    const leftKey = `${left.startAt}:${left.endAt}:${left.occurrenceId}`;
    const rightKey = `${right.startAt}:${right.endAt}:${right.occurrenceId}`;
    return leftKey < rightKey ? -1 : 1;
  });
  for (const occurrence of occurrences) input.usedRoomIds.add(occurrence.roomId);
  return releasedSessionSchema.parse({
    sessionId: input.session.id,
    title: input.session.title,
    plannedDurationMinutes: input.session.plannedDurationMinutes,
    format: Object.freeze({
      id: input.session.programTarget.format.id,
      name: input.session.programTarget.format.name
    }),
    track: input.session.programTarget.track === null ? null : Object.freeze({
      id: input.session.programTarget.track.id,
      name: input.session.programTarget.track.name,
      accent: input.session.programTarget.track.accent
    }),
    occurrences: Object.freeze(occurrences),
    participants: Object.freeze(participants)
  });
}

interface GatedRestoredProgramContent {
  readonly sessions: readonly ReleasedSessionDto[];
  readonly nameDeclassifications: readonly ReleaseNameDeclassificationDto[];
  readonly suppressions: readonly { readonly sessionId: string; readonly personId: string }[];
}

/**
 * The rollback arm of the materialization gate (owner decision, 2026-08-14:
 * "revocation = hide, the next successor release omits them" — and a rollback
 * IS a successor-creating path). Sessions, occurrences, rooms, and pins
 * restore exactly as targeted so a scheduling regression can be undone, but a
 * restored participant appearance survives only if that `(session, person)`
 * still passes the confirmed-and-visible gate against CURRENT state: roster
 * flag `publiclyVisible` AND engagement `confirmed`, both fail-closed (a
 * vanished session or roster entry withholds rather than re-declassifies).
 * Retained display names are copied from the target release's own audited
 * declassification record — never re-read from the classified store — and a
 * person hidden everywhere drops out of `nameDeclassifications` entirely.
 * Every withheld appearance is recorded so the reviewed diff shows exactly
 * what the rollback declines to restore.
 */
function gateRestoredProgramContent(
  scope: ReleaseScope,
  port: ReleaseReadPort,
  target: ProgramRelease
): GatedRestoredProgramContent {
  const catalog = port.readReleaseSessionCatalog(scope);
  const engagements = port.readReleaseEngagementSnapshot(scope);
  if (!catalog || !engagements
      || !sameReleaseScope(catalog.scope, scope) || !sameReleaseScope(engagements.scope, scope)) {
    throw new ReleasePlanningError('wrong_scope');
  }
  const confirmed = new Set<string>();
  for (const engagement of engagements.engagements) {
    if (engagement.state === 'confirmed') {
      confirmed.add(`${engagement.sessionId}:${engagement.personId}`);
    }
  }
  const visible = new Set<string>();
  for (const session of catalog.sessions) {
    for (const entry of session.roster.participants) {
      if (entry.publiclyVisible) visible.add(`${session.id}:${entry.personId}`);
    }
  }
  const suppressions: { sessionId: string; personId: string }[] = [];
  const sessions = target.sessions.map((session) => {
    const kept = session.participants.filter((entry) => {
      const key = `${session.sessionId}:${entry.personId}`;
      const qualifies = visible.has(key) && confirmed.has(key);
      if (!qualifies) {
        suppressions.push({ sessionId: session.sessionId, personId: entry.personId });
      }
      return qualifies;
    });
    return kept.length === session.participants.length
      ? session
      : { ...session, participants: kept };
  });
  const retained = new Set(
    sessions.flatMap((session) => session.participants.map((entry) => entry.personId))
  );
  suppressions.sort((left, right) =>
    `${left.sessionId}:${left.personId}` < `${right.sessionId}:${right.personId}` ? -1 : 1
  );
  return Object.freeze({
    sessions,
    nameDeclassifications: target.nameDeclassifications
      .filter((entry) => retained.has(entry.personId)),
    suppressions
  });
}

/** Deterministic first-slice style compiler: one typed recipe in, exactly the public tokens out. */
export function compileStyleSetTokens(
  recipe: StyleSetRecipeDto
): Record<PublicThemeTokenName, string> {
  const { canvas, surface, text, action } = recipe;
  return {
    '--je-color-canvas': canvas,
    '--je-color-page': canvas,
    '--je-color-surface': surface,
    '--je-color-surface-raised': surface,
    '--je-color-surface-sunken': mixHex(surface, text, 0.06),
    '--je-color-surface-selected': mixHex(surface, action, 0.1),
    '--je-color-text': text,
    '--je-color-text-muted': mixHex(text, surface, 0.35),
    '--je-color-border': mixHex(surface, text, 0.18),
    '--je-color-border-strong': mixHex(surface, text, 0.32),
    '--je-color-action': action,
    '--je-color-action-hover': mixHex(action, text, 0.12),
    '--je-color-action-active': mixHex(action, text, 0.2),
    '--je-color-action-contrast': contrastHex(action),
    '--je-color-action-soft': mixHex(surface, action, 0.12),
    '--je-color-action-soft-hover': mixHex(surface, action, 0.18),
    '--je-color-focus': action,
    '--je-color-link': action,
    '--je-radius-control': `${recipe.radius}px`,
    '--je-radius-surface': `${recipe.radius + 2}px`,
    '--je-control-height': `${recipe.controlHeight}px`,
    '--je-font-body': "system-ui, -apple-system, 'Segoe UI', sans-serif",
    '--je-font-display': "system-ui, -apple-system, 'Segoe UI', sans-serif"
  };
}

function pinnedTemplateArtifact(input: {
  readonly scope: ReleaseScope;
  readonly pin: ReleaseTemplateRevisionPinDto;
  readonly port: ReleaseReadPort;
}) {
  const document = input.port.readReleaseTemplateArtifact?.(input.scope, input.pin);
  if (!document) throw new ReleasePlanningError('template_revision_stale');
  return document;
}

function canonicalManifestText(value: string): string | null {
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return normalized.length === 0 ? null : normalized;
}

function manifestFromTemplate(input: {
  readonly scope: ReleaseScope;
  readonly kind: Extract<ReleasePlanningInput, { readonly action: 'surface_publish' }>['kind'];
  readonly pin: ReleaseTemplateRevisionPinDto;
  readonly port: ReleaseReadPort;
}): SurfaceManifestDto {
  const document = pinnedTemplateArtifact({ scope: input.scope, pin: input.pin, port: input.port });
  const expectedTemplateKind = input.kind === 'schedule'
    ? 'schedule'
    : input.kind === 'speakers' ? 'speaker-roster' : 'application-form';
  if (document.kind !== 'surface' || document.surfaceKind !== expectedTemplateKind) {
    throw new ReleasePlanningError('template_kind_mismatch');
  }
  const hero = document.blocks.find((block) => block.type === 'hero');
  try {
    return surfaceManifestSchema.parse({
      schemaVersion: 1,
      heading: hero ? canonicalManifestText(hero.title) : null,
      intro: hero ? canonicalManifestText(hero.intro) : null
    });
  } catch {
    throw new ReleasePlanningError('invalid_plan');
  }
}

export function planReleaseMutation(input: {
  readonly planningInput: ReleasePlanningInput;
  readonly port: ReleaseReadPort;
}): ReleaseMutationPlanDto {
  const planningInput = releasePlanningInputSchema.parse(input.planningInput);
  const scope = planningInput.scope;
  const port = input.port;
  switch (planningInput.action) {
    case 'publish_schedule': {
      const current = port.readCurrentProgramRelease(scope);
      requireChainFence(current, planningInput.expectedCurrentReleaseNumber);
      const conflicts = port.readReleaseScheduleConflicts(scope);
      if (conflicts.length > 0) {
        throw new ReleasePlanningError('schedule_conflicts_block', conflicts);
      }
      const content = materializeProgramContent(scope, port);
      return releaseProgramPlanSchema.parse({
        input: planningInput,
        chainBefore: chainImage(current),
        rollbackSuppressions: null,
        release: signedProgramRelease({
          scope,
          id: planningInput.releaseId,
          number: (current?.number ?? 0) + 1,
          origin: { kind: 'publish' },
          predecessor: predecessorRef(current),
          ...content,
          releasedByUserId: planningInput.actorUserId,
          releasedAt: planningInput.occurredAt
        })
      });
    }
    case 'program_rollback': {
      const current = port.readCurrentProgramRelease(scope);
      if (!current) throw new ReleasePlanningError('stale_release_chain');
      requireChainFence(current, planningInput.expectedCurrentReleaseNumber);
      const target = port.readProgramRelease(scope, planningInput.targetReleaseId);
      if (!target) throw new ReleasePlanningError('release_missing');
      if (target.id === current.id) throw new ReleasePlanningError('invalid_plan');
      const gated = gateRestoredProgramContent(scope, port, target);
      return releaseProgramPlanSchema.parse({
        input: planningInput,
        chainBefore: chainImage(current),
        rollbackSuppressions: gated.suppressions,
        release: signedProgramRelease({
          scope,
          id: planningInput.releaseId,
          number: current.number + 1,
          origin: { kind: 'rollback', restoredFromReleaseId: target.id },
          predecessor: predecessorRef(current),
          pins: target.pins,
          rooms: target.rooms,
          sessions: gated.sessions,
          nameDeclassifications: gated.nameDeclassifications,
          releasedByUserId: planningInput.actorUserId,
          releasedAt: planningInput.occurredAt
        })
      });
    }
    case 'style_set_publish': {
      const current = port.readCurrentStyleSetRelease(scope);
      requireChainFence(current, planningInput.expectedCurrentStyleSetNumber);
      const document = pinnedTemplateArtifact({
        scope,
        pin: planningInput.sourceTemplateRevision,
        port
      });
      if (document.kind !== 'theme') throw new ReleasePlanningError('template_kind_mismatch');
      if (canonical(document.recipe) !== canonical(planningInput.recipe)) {
        throw new ReleasePlanningError('invalid_plan');
      }
      const unsigned = {
        schemaVersion: 1 as const,
        scope,
        id: planningInput.releaseId,
        number: (current?.number ?? 0) + 1,
        predecessor: predecessorRef(current),
        sourceTemplateRevision: planningInput.sourceTemplateRevision,
        recipe: document.recipe,
        tokens: compileStyleSetTokens(document.recipe),
        releasedByUserId: planningInput.actorUserId,
        releasedAt: planningInput.occurredAt
      };
      return releaseStyleSetPlanSchema.parse({
        input: planningInput,
        chainBefore: chainImage(current),
        release: parseStyleSetRelease({ ...unsigned, digestSha256: releaseDigest(unsigned) })
      });
    }
    case 'surface_publish': {
      const head = port.readSurfaceHead(scope, planningInput.kind);
      requireHeadFence(head, planningInput.expectedSurfaceHeadVersion);
      if (!port.readStyleSetRelease(scope, planningInput.styleSetReleaseId)) {
        throw new ReleasePlanningError('style_set_release_missing');
      }
      const active = head === undefined
        ? undefined
        : port.readSurfaceRelease(scope, head.activeReleaseId);
      if (head !== undefined && active === undefined) throw new ReleasePlanningError('invalid_plan');
      if (planningInput.kind === 'apply') {
        const publishedVersionId =
          port.readReleasePublishedFormVersionId(scope, planningInput.formRef!.formId);
        if (publishedVersionId === undefined
            || publishedVersionId !== planningInput.formRef!.formVersionId) {
          throw new ReleasePlanningError('form_version_unpinned');
        }
      }
      const manifest = manifestFromTemplate({
        scope,
        kind: planningInput.kind,
        pin: planningInput.sourceTemplateRevision,
        port
      });
      if (canonical(manifest) !== canonical(planningInput.manifest)) {
        throw new ReleasePlanningError('invalid_plan');
      }
      const unsigned = {
        kind: planningInput.kind,
        schemaVersion: 1 as const,
        scope,
        id: planningInput.releaseId,
        number: (head?.version ?? 0) + 1,
        predecessor: active === undefined
          ? null
          : { releaseId: active.id, digestSha256: active.digestSha256 },
        sourceTemplateRevision: planningInput.sourceTemplateRevision,
        manifest,
        styleSetReleaseId: planningInput.styleSetReleaseId,
        ...(planningInput.kind === 'apply' ? { formRef: planningInput.formRef! } : {}),
        releasedByUserId: planningInput.actorUserId,
        releasedAt: planningInput.occurredAt
      };
      const release = parseSurfaceRelease({ ...unsigned, digestSha256: releaseDigest(unsigned) });
      return releaseSurfacePublishPlanSchema.parse({
        input: planningInput,
        release,
        headBefore: head ?? null,
        headAfter: advancedHead(scope, planningInput.kind, head, release.id, planningInput)
      });
    }
    case 'surface_rollback': {
      const head = port.readSurfaceHead(scope, planningInput.kind);
      if (!head) throw new ReleasePlanningError('stale_surface_head');
      requireHeadFence(head, planningInput.expectedSurfaceHeadVersion);
      const target = port.readSurfaceRelease(scope, planningInput.targetReleaseId);
      if (!target) throw new ReleasePlanningError('release_missing');
      if (target.kind !== planningInput.kind) throw new ReleasePlanningError('surface_kind_mismatch');
      if (target.id === head.activeReleaseId) throw new ReleasePlanningError('invalid_plan');
      return releaseSurfaceRollbackPlanSchema.parse({
        input: planningInput,
        headBefore: head,
        headAfter: advancedHead(scope, planningInput.kind, head, target.id, planningInput)
      });
    }
    case 'surface_allowlist': {
      // Framing policy rides the published head: absence means there is no
      // surface to frame yet and nothing to carry the allowlist on.
      const head = port.readSurfaceHead(scope, planningInput.kind);
      if (!head) throw new ReleasePlanningError('stale_surface_head');
      requireHeadFence(head, planningInput.expectedSurfaceHeadVersion);
      const requested = canonicalFrameOriginAllowlist(planningInput.allowedFrameOrigins);
      if (sameOriginList(requested, head.allowedFrameOrigins)) {
        throw new ReleasePlanningError('invalid_plan');
      }
      return releaseSurfaceAllowlistPlanSchema.parse({
        input: planningInput,
        headBefore: head,
        headAfter: advancedHead(
          scope, planningInput.kind, head, head.activeReleaseId, planningInput, requested
        )
      });
    }
  }
}

export function validateReleaseMutationPlan(input: {
  readonly plan: ReleaseMutationPlanDto;
  readonly port: ReleaseReadPort;
}): ReleasePlanningErrorCode | undefined {
  let rebuilt: ReleaseMutationPlanDto;
  try {
    rebuilt = planReleaseMutation({ planningInput: input.plan.input, port: input.port });
  } catch (error) {
    return error instanceof ReleasePlanningError ? error.code : 'invalid_plan';
  }
  return canonical(rebuilt) === canonical(input.plan) ? undefined : 'invalid_plan';
}

export function projectReleaseSafeDiff(plan: ReleaseMutationPlanDto): ReleaseSafeDiffDto {
  if (isProgramPlan(plan)) {
    return {
      action: plan.input.action,
      before: plan.chainBefore,
      after: {
        releaseId: plan.release.id,
        number: plan.release.number,
        digestSha256: plan.release.digestSha256
      },
      releasedSessionCount: plan.release.sessions.length,
      releasedOccurrenceCount: plan.release.sessions
        .reduce((total, session) => total + session.occurrences.length, 0),
      nameDeclassifications: plan.release.nameDeclassifications,
      rollbackSuppressions: plan.rollbackSuppressions
    };
  }
  if (isStyleSetPlan(plan)) {
    return {
      action: 'style_set_publish',
      before: plan.chainBefore,
      after: {
        releaseId: plan.release.id,
        number: plan.release.number,
        digestSha256: plan.release.digestSha256
      },
      sourceTemplateRevision: plan.release.sourceTemplateRevision,
      recipe: plan.release.recipe
    };
  }
  if (isSurfacePublishPlan(plan)) {
    return {
      action: 'surface_publish',
      kind: plan.input.kind,
      before: plan.headBefore,
      after: plan.headAfter,
      sourceTemplateRevision: plan.release.sourceTemplateRevision,
      styleSetReleaseId: plan.release.styleSetReleaseId,
      formRef: plan.release.kind === 'apply' ? plan.release.formRef : null
    };
  }
  if (isSurfaceAllowlistPlan(plan)) {
    // The before/after head images carry both origin lists verbatim, so the
    // reviewed diff shows exactly which pages the change admits or removes.
    return {
      action: 'surface_allowlist',
      kind: plan.input.kind,
      before: plan.headBefore,
      after: plan.headAfter
    };
  }
  return {
    action: 'surface_rollback',
    kind: plan.input.kind,
    before: plan.headBefore,
    after: plan.headAfter
  };
}

export function releaseMutationResultFromPlan(plan: ReleaseMutationPlanDto): ReleaseMutationResultDto {
  if (isProgramPlan(plan)) {
    return releaseMutationResultSchema.parse({ action: plan.input.action, release: plan.release });
  }
  if (isStyleSetPlan(plan)) {
    return releaseMutationResultSchema.parse({ action: 'style_set_publish', release: plan.release });
  }
  if (isSurfacePublishPlan(plan)) {
    return releaseMutationResultSchema.parse({
      action: 'surface_publish',
      release: plan.release,
      head: plan.headAfter
    });
  }
  if (isSurfaceAllowlistPlan(plan)) {
    return releaseMutationResultSchema.parse({ action: 'surface_allowlist', head: plan.headAfter });
  }
  return releaseMutationResultSchema.parse({ action: 'surface_rollback', head: plan.headAfter });
}

export type ReleaseCompensationDerivation =
  | { readonly kind: 'exact'; readonly authorInput: ReleasePlanningInput }
  | { readonly kind: 'blocked'; readonly reasonKey: string };

/**
 * Per-kind rollback semantics. Program compensation restores the predecessor's
 * content as a new immutable successor; presentation compensation moves the
 * surface pointer back — never the other release type. A first release of any
 * chain has no prior public state, so its compensation is honestly blocked
 * rather than inventing an unpublish the model does not have.
 */
export function planReleaseCompensation(input: {
  readonly original: ReleaseMutationPlanDto;
  readonly port: ReleaseReadPort;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): ReleaseCompensationDerivation {
  const plan = input.original;
  if (isProgramPlan(plan)) {
    if (plan.chainBefore === null) return blocked('release.first_release');
    const scope = plan.input.scope;
    const current = input.port.readCurrentProgramRelease(scope);
    if (!current || current.id !== plan.release.id) return blocked('release.superseded');
    return exact({
      action: 'program_rollback',
      scope,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      releaseId: deterministicReleaseId(scope, 'program_compensation', {
        compensates: plan.release.id
      }),
      targetReleaseId: plan.chainBefore.releaseId,
      expectedCurrentReleaseNumber: current.number
    });
  }
  if (isStyleSetPlan(plan)) return blocked('release.retained_release');
  if (isSurfacePublishPlan(plan)) {
    if (plan.headBefore === null) return blocked('release.first_release');
    const current = input.port.readSurfaceHead(plan.input.scope, plan.input.kind);
    if (!current || current.activeReleaseId !== plan.release.id) return blocked('release.superseded');
    return exact({
      action: 'surface_rollback',
      scope: plan.input.scope,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      kind: plan.input.kind,
      targetReleaseId: plan.headBefore.activeReleaseId,
      expectedSurfaceHeadVersion: current.version
    });
  }
  if (isSurfaceAllowlistPlan(plan)) {
    // Compensation restores the previous origin list through the same
    // reviewed gesture. Any head movement since — a publish, a rollback, or
    // another allowlist change — supersedes it.
    const current = input.port.readSurfaceHead(plan.input.scope, plan.input.kind);
    if (!current || current.version !== plan.headAfter.version
        || !sameOriginList(current.allowedFrameOrigins, plan.headAfter.allowedFrameOrigins)) {
      return blocked('release.superseded');
    }
    return exact({
      action: 'surface_allowlist',
      scope: plan.input.scope,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      kind: plan.input.kind,
      allowedFrameOrigins: [...plan.headBefore.allowedFrameOrigins],
      expectedSurfaceHeadVersion: current.version
    });
  }
  const current = input.port.readSurfaceHead(plan.input.scope, plan.input.kind);
  if (!current || current.activeReleaseId !== plan.headAfter.activeReleaseId) {
    return blocked('release.superseded');
  }
  return exact({
    action: 'surface_rollback',
    scope: plan.input.scope,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    kind: plan.input.kind,
    targetReleaseId: plan.headBefore.activeReleaseId,
    expectedSurfaceHeadVersion: current.version
  });
}

/**
 * Exactly the release reads the successor seam consumes, so the hosting
 * intake commit can be bridged over a lean surface-release store without the
 * full upstream materialization sources.
 */
export type ReleaseSurfaceSuccessorReadPort =
  Pick<ReleaseReadPort, 'listFormSurfaceHeads' | 'readSurfaceRelease' | 'readSurfaceHead'>;

/**
 * The form-republish successor seam (owner Model 3): for every
 * submission-bearing surface whose ACTIVE release renders the republished
 * form, plan one successor surface release pinning the new form version, with
 * presentation and style pins copied verbatim. Read-only surfaces are never
 * touched — their data follows the newest program release and a form
 * republish is not their concern. Successor identities are content-derived so
 * the hosting reviewed Form-version publish replays byte-identically. Consumed by
 * that publish through its surface-successor collaboration
 * ports; the release domain never mounts an implicit side effect.
 */
export function planReleaseSurfaceSuccessorFrom(
  port: ReleaseSurfaceSuccessorReadPort,
  input: ReleaseSurfaceSuccessorInputDto
): ReleaseSurfaceSuccessorPlanDto {
  const parsed = releaseSurfaceSuccessorInputSchema.parse(input);
  const scope = parsed.scope;
  const successors = [];
  for (const head of port.listFormSurfaceHeads(scope)) {
    const active = port.readSurfaceRelease(scope, head.activeReleaseId);
    if (!active || active.kind !== 'apply') throw new ReleasePlanningError('invalid_plan');
    if (active.formRef.formId !== parsed.formId) continue;
    if (active.formRef.formVersionId === parsed.formVersionId) continue;
    const unsigned = {
      kind: 'apply' as const,
      schemaVersion: 1 as const,
      scope,
      id: deterministicReleaseId(scope, 'form_successor', {
        supersedes: active.id,
        formVersionId: parsed.formVersionId
      }),
      number: head.version + 1,
      predecessor: { releaseId: active.id, digestSha256: active.digestSha256 },
      sourceTemplateRevision: active.sourceTemplateRevision,
      manifest: active.manifest,
      styleSetReleaseId: active.styleSetReleaseId,
      formRef: { formId: parsed.formId, formVersionId: parsed.formVersionId },
      releasedByUserId: parsed.actorUserId,
      releasedAt: parsed.occurredAt
    };
    const release = parseSurfaceRelease({ ...unsigned, digestSha256: releaseDigest(unsigned) });
    successors.push({
      release,
      headBefore: head,
      headAfter: advancedHead(scope, 'apply', head, release.id, {
        actorUserId: parsed.actorUserId,
        occurredAt: parsed.occurredAt
      })
    });
  }
  return releaseSurfaceSuccessorPlanSchema.parse({ input: parsed, successors });
}

export type ReleaseSurfaceSuccessorValidation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused'; readonly code: ReleasePlanningErrorCode };

export function validateReleaseSurfaceSuccessorFrom(
  port: ReleaseSurfaceSuccessorReadPort,
  plan: ReleaseSurfaceSuccessorPlanDto
): ReleaseSurfaceSuccessorValidation {
  let rebuilt: ReleaseSurfaceSuccessorPlanDto;
  try {
    rebuilt = planReleaseSurfaceSuccessorFrom(port, plan.input);
  } catch (error) {
    return Object.freeze({
      kind: 'refused',
      code: error instanceof ReleasePlanningError ? error.code : 'invalid_plan'
    });
  }
  return canonical(rebuilt) === canonical(plan)
    ? Object.freeze({ kind: 'ready' })
    : Object.freeze({ kind: 'refused', code: 'stale_surface_head' });
}

/**
 * Concurrency fence a hosting reviewed publish records beside a successor plan: the
 * one `apply` surface-head slot, absence included, in exactly the evidence
 * shape the owner-native Release workflow itself uses. Any surface publish or rollback
 * between propose and commit moves it and conflicts the pending republish.
 */
export function releaseSurfaceSuccessorGuardRef(
  port: ReleaseSurfaceSuccessorReadPort,
  scope: ReleaseScope
): { readonly id: string; readonly version: number; readonly digest: string } {
  return Object.freeze({
    id: surfaceHeadGuardId(scope.eventId, 'apply'),
    ...surfaceHeadGuard(port.readSurfaceHead(scope, 'apply'))
  });
}

export function isProgramPlan(plan: ReleaseMutationPlanDto): plan is ReleaseProgramPlanDto {
  return plan.input.action === 'publish_schedule' || plan.input.action === 'program_rollback';
}

export function isStyleSetPlan(plan: ReleaseMutationPlanDto): plan is ReleaseStyleSetPlanDto {
  return plan.input.action === 'style_set_publish';
}

export function isSurfacePublishPlan(
  plan: ReleaseMutationPlanDto
): plan is ReleaseSurfacePublishPlanDto {
  return plan.input.action === 'surface_publish';
}

export function isSurfaceRollbackPlan(
  plan: ReleaseMutationPlanDto
): plan is ReleaseSurfaceRollbackPlanDto {
  return plan.input.action === 'surface_rollback';
}

export function isSurfaceAllowlistPlan(
  plan: ReleaseMutationPlanDto
): plan is ReleaseSurfaceAllowlistPlanDto {
  return plan.input.action === 'surface_allowlist';
}

export function parseReleaseMutationPlan(value: unknown): ReleaseMutationPlanDto {
  return releaseMutationPlanSchema.parse(value);
}

function signedProgramRelease(unsigned: {
  readonly scope: ReleaseScopeDto;
  readonly id: string;
  readonly number: number;
  readonly origin: ProgramReleaseDto['origin'];
  readonly predecessor: { readonly releaseId: string; readonly digestSha256: string } | null;
  readonly pins: ProgramReleaseDto['pins'];
  readonly rooms: readonly ReleasedRoomDto[];
  readonly sessions: readonly ReleasedSessionDto[];
  readonly nameDeclassifications: readonly ReleaseNameDeclassificationDto[];
  readonly releasedByUserId: string;
  readonly releasedAt: string;
}): ProgramRelease {
  const complete = { schemaVersion: 1 as const, ...unsigned };
  return parseProgramRelease({ ...complete, digestSha256: releaseDigest(complete) });
}

function chainImage(
  current: ProgramRelease | StyleSetRelease | undefined
): { readonly releaseId: string; readonly number: number; readonly digestSha256: string } | null {
  return current === undefined
    ? null
    : { releaseId: current.id, number: current.number, digestSha256: current.digestSha256 };
}

function predecessorRef(
  current: ProgramRelease | StyleSetRelease | SurfaceRelease | undefined
): { readonly releaseId: string; readonly digestSha256: string } | null {
  return current === undefined
    ? null
    : { releaseId: current.id, digestSha256: current.digestSha256 };
}

/**
 * The advanced head image every pointer move shares. The framing allowlist is
 * event configuration, not released content: publish, rollback, and successor
 * moves carry it forward unchanged, and only an explicit allowlist change
 * passes a replacement.
 */
function advancedHead(
  scope: ReleaseScopeDto,
  kind: SurfaceKind,
  head: SurfaceHeadDto | undefined,
  activeReleaseId: string,
  attribution: { readonly actorUserId: string; readonly occurredAt: string },
  allowedFrameOrigins?: readonly string[]
): SurfaceHeadDto {
  return parseSurfaceHead({
    schemaVersion: 1,
    scope,
    kind,
    activeReleaseId,
    version: (head?.version ?? 0) + 1,
    allowedFrameOrigins: allowedFrameOrigins ?? head?.allowedFrameOrigins ?? [],
    updatedByUserId: attribution.actorUserId,
    updatedAt: attribution.occurredAt
  });
}

function sameOriginList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin, index) => origin === right[index]);
}

function requireChainFence(
  current: { readonly number: number } | undefined,
  expected: number | null
): void {
  if ((current?.number ?? null) !== expected) throw new ReleasePlanningError('stale_release_chain');
}

function requireHeadFence(head: SurfaceHeadDto | undefined, expected: number | null): void {
  if ((head?.version ?? null) !== expected) throw new ReleasePlanningError('stale_surface_head');
}

function exact(authorInput: unknown): ReleaseCompensationDerivation {
  return Object.freeze({
    kind: 'exact',
    authorInput: releasePlanningInputSchema.parse(authorInput)
  });
}

function blocked(reasonKey: string): ReleaseCompensationDerivation {
  return Object.freeze({ kind: 'blocked', reasonKey });
}

function canonical(value: unknown): string {
  return Buffer.from(encodeCanonicalJson(value)).toString('utf8');
}

function mixHex(base: string, into: string, amount: number): string {
  const from = hexChannels(base);
  const to = hexChannels(into);
  const mixed = from.map((channel, index) =>
    Math.round(channel + (to[index]! - channel) * amount)
  );
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function contrastHex(background: string): '#ffffff' | '#000000' {
  const luminance = relativeLuminance(background);
  const white = 1.05 / (luminance + 0.05);
  const black = (luminance + 0.05) / 0.05;
  return white >= black ? '#ffffff' : '#000000';
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = hexChannels(hex).map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function hexChannels(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
}
