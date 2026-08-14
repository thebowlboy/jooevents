import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  versionedDefinitionRefSchema
} from './operations';
import {
  programTrackAccentSchema,
  programVocabularyIdInputSchema,
  programVocabularyIdSchema,
  programVocabularyNameSchema,
  programVocabularyScopeSchema,
  programVocabularyVersionSchema
} from './program-vocabulary';
import { schedulePlacementInstantSchema } from './schedule-placement';
import { sessionParticipantRoleSchema, sessionPlannedDurationMinutesSchema } from './sessions';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalInstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith('Z') && value.includes('.'),
  'instant must use canonical UTC millisecond form'
);
const canonicalText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ') === value);

export const releaseIdInputSchema = programVocabularyIdInputSchema;
export const releaseIdSchema = programVocabularyIdSchema;
export const releaseScopeSchema = programVocabularyScopeSchema;
export const releaseVersionSchema = programVocabularyVersionSchema;

/**
 * The release types are never conflated: program-data releases carry what is
 * publicly visible, surface releases carry how public pages render, style-set
 * releases carry compiled presentation tokens, and form-schema versions stay
 * owned by intake and are referenced by exact pin only.
 */
export const surfaceKindSchema = z.enum(['schedule', 'speakers', 'apply']);
/** Surface kinds whose data follows the newest program release under a stable presentation. */
export const READ_ONLY_SURFACE_KINDS = Object.freeze(['schedule', 'speakers'] as const);
/** Submission-bearing surface kinds; each release pins the exact form version it renders. */
export const FORM_SURFACE_KINDS = Object.freeze(['apply'] as const);

/** Chain link: the immediate predecessor release and its content digest. */
export const releasePredecessorRefSchema = z.strictObject({
  releaseId: releaseIdSchema,
  digestSha256: digestSchema
});

/**
 * Why a program release exists: an ordinary publish over current state, or a
 * rollback that restores a prior release's content as a new immutable
 * successor. Rollback never rewinds the chain in place.
 */
export const programReleaseOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('publish') }),
  z.strictObject({ kind: z.literal('rollback'), restoredFromReleaseId: releaseIdSchema })
]);

/**
 * The exact upstream evidence a program release was materialized from. Serving
 * never re-derives from live operator state; these pins exist so a release is
 * auditable against the states it snapshotted.
 */
export const programReleaseEvidencePinsSchema = z.strictObject({
  sessionCatalog: z.strictObject({
    version: releaseVersionSchema,
    digestSha256: digestSchema
  }),
  scheduleVersion: releaseVersionSchema,
  engagementSnapshotDigestSha256: digestSchema,
  vocabulary: z.strictObject({
    setVersion: releaseVersionSchema,
    digestSha256: digestSchema
  }),
  eventSettingsVersion: releaseVersionSchema
});

/**
 * One publicly visible participant inside a released session. `displayName` is
 * the audited materialization-time copy for a confirmed-and-visible
 * participant; contact data has no field here and never enters a release.
 */
export const releasedParticipantSchema = z.strictObject({
  personId: releaseIdSchema,
  role: sessionParticipantRoleSchema,
  position: z.number().int().nonnegative().safe(),
  displayName: canonicalText(300)
});

export const releasedOccurrenceSchema = z.strictObject({
  occurrenceId: releaseIdSchema,
  roomId: releaseIdSchema,
  startAt: schedulePlacementInstantSchema,
  endAt: schedulePlacementInstantSchema
}).refine((occurrence) => occurrence.startAt < occurrence.endAt, {
  path: ['endAt'],
  message: 'released occurrence end must follow its start'
});

export const releasedRoomSchema = z.strictObject({
  id: releaseIdSchema,
  name: programVocabularyNameSchema
});

/**
 * One session as released. Only `programmed` sessions can appear (state, not
 * placement): a placed `collecting` session is never in any program release,
 * and an unplaced `programmed` session may appear with zero occurrences.
 */
export const releasedSessionSchema = z.strictObject({
  sessionId: releaseIdSchema,
  title: canonicalText(300),
  plannedDurationMinutes: sessionPlannedDurationMinutesSchema,
  format: z.strictObject({ id: releaseIdSchema, name: programVocabularyNameSchema }),
  track: z.strictObject({
    id: releaseIdSchema,
    name: programVocabularyNameSchema,
    accent: programTrackAccentSchema
  }).nullable(),
  occurrences: z.array(releasedOccurrenceSchema).max(100),
  participants: z.array(releasedParticipantSchema).max(500)
}).superRefine((session, context) => {
  for (const [index, occurrence] of session.occurrences.entries()) {
    if (index === 0) continue;
    const previous = session.occurrences[index - 1]!;
    const previousKey = `${previous.startAt}:${previous.endAt}:${previous.occurrenceId}`;
    const key = `${occurrence.startAt}:${occurrence.endAt}:${occurrence.occurrenceId}`;
    if (previousKey >= key) {
      context.addIssue({
        code: 'custom', path: ['occurrences', index],
        message: 'released occurrences must use canonical order'
      });
    }
  }
  const personIds = new Set<string>();
  for (const [index, participant] of session.participants.entries()) {
    if (personIds.has(participant.personId)) {
      context.addIssue({
        code: 'custom', path: ['participants', index],
        message: 'released participants must be unique per person'
      });
    }
    personIds.add(participant.personId);
    if (index > 0) {
      const previous = session.participants[index - 1]!;
      if (previous.position > participant.position
          || (previous.position === participant.position
            && previous.personId >= participant.personId)) {
        context.addIssue({
          code: 'custom', path: ['participants', index],
          message: 'released participants must use canonical order'
        });
      }
    }
  }
});

/**
 * The audited declassification record: exactly which display names this
 * release copied out of the classified intake store, one row per released
 * person. It is part of the immutable snapshot and surfaces verbatim in the
 * reviewed commit diff; a release whose participant names differ from this
 * record is invalid.
 */
export const releaseNameDeclassificationSchema = z.strictObject({
  personId: releaseIdSchema,
  displayName: canonicalText(300)
});

/**
 * Immutable program-data release. `publish_schedule` creates one; committed
 * changes create successors; rollback creates a restorative successor. The
 * digest chain (`predecessor` + own `digestSha256`) makes the successor links
 * tamper-evident.
 */
export const programReleaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: releaseScopeSchema,
  id: releaseIdSchema,
  number: releaseVersionSchema,
  origin: programReleaseOriginSchema,
  predecessor: releasePredecessorRefSchema.nullable(),
  pins: programReleaseEvidencePinsSchema,
  rooms: z.array(releasedRoomSchema).max(500),
  sessions: z.array(releasedSessionSchema).max(5_000),
  nameDeclassifications: z.array(releaseNameDeclassificationSchema).max(10_000),
  releasedByUserId: releaseIdSchema,
  releasedAt: canonicalInstantSchema,
  digestSha256: digestSchema
}).superRefine((release, context) => {
  if ((release.number === 1) !== (release.predecessor === null)) {
    context.addIssue({
      code: 'custom', path: ['predecessor'],
      message: 'exactly the first release has no predecessor'
    });
  }
  if (release.origin.kind === 'rollback' && release.origin.restoredFromReleaseId === release.id) {
    context.addIssue({
      code: 'custom', path: ['origin', 'restoredFromReleaseId'],
      message: 'a rollback release must restore a different release'
    });
  }
  for (const [index, room] of release.rooms.entries()) {
    if (index > 0 && release.rooms[index - 1]!.id >= room.id) {
      context.addIssue({
        code: 'custom', path: ['rooms', index],
        message: 'released rooms must use canonical id order'
      });
    }
  }
  const roomIds = new Set(release.rooms.map((room) => room.id));
  const sessionIds = new Set<string>();
  const releasedNames = new Map<string, string>();
  for (const [index, session] of release.sessions.entries()) {
    if (sessionIds.has(session.sessionId)) {
      context.addIssue({
        code: 'custom', path: ['sessions', index],
        message: 'released sessions must be unique'
      });
    }
    sessionIds.add(session.sessionId);
    if (index > 0 && release.sessions[index - 1]!.sessionId >= session.sessionId) {
      context.addIssue({
        code: 'custom', path: ['sessions', index],
        message: 'released sessions must use canonical id order'
      });
    }
    for (const [occurrenceIndex, occurrence] of session.occurrences.entries()) {
      if (!roomIds.has(occurrence.roomId)) {
        context.addIssue({
          code: 'custom', path: ['sessions', index, 'occurrences', occurrenceIndex, 'roomId'],
          message: 'released occurrences must reference released rooms'
        });
      }
    }
    for (const [participantIndex, participant] of session.participants.entries()) {
      const declared = releasedNames.get(participant.personId);
      if (declared !== undefined && declared !== participant.displayName) {
        context.addIssue({
          code: 'custom', path: ['sessions', index, 'participants', participantIndex],
          message: 'a released person carries one display name'
        });
      }
      releasedNames.set(participant.personId, participant.displayName);
    }
  }
  const declassified = new Map(
    release.nameDeclassifications.map((entry) => [entry.personId, entry.displayName])
  );
  const coherent = declassified.size === release.nameDeclassifications.length
    && declassified.size === releasedNames.size
    && [...releasedNames].every(([personId, name]) => declassified.get(personId) === name)
    && release.nameDeclassifications.every((entry, index) =>
      index === 0 || release.nameDeclassifications[index - 1]!.personId < entry.personId
    );
  if (!coherent) {
    context.addIssue({
      code: 'custom', path: ['nameDeclassifications'],
      message: 'name declassifications must record exactly the released display names'
    });
  }
});

/**
 * The compiled style-set recipe of the first slice: one typed default-shaped
 * ThemeRecipe. Free-form CSS, HTML, or selectors have no field here.
 */
export const styleSetRecipeSchema = z.strictObject({
  name: canonicalText(48),
  canvas: z.string().regex(/^#[0-9a-f]{6}$/),
  surface: z.string().regex(/^#[0-9a-f]{6}$/),
  text: z.string().regex(/^#[0-9a-f]{6}$/),
  action: z.string().regex(/^#[0-9a-f]{6}$/),
  radius: z.number().int().min(2).max(20),
  controlHeight: z.number().int().min(30).max(48)
});

/**
 * The documented public theme token vocabulary. The style-set compiler emits
 * exactly these tokens; an unknown token cannot be represented, so agent- or
 * organizer-authored styling can never smuggle arbitrary CSS into a release.
 */
export const publicThemeTokenNameSchema = z.enum([
  '--je-color-canvas',
  '--je-color-page',
  '--je-color-surface',
  '--je-color-surface-raised',
  '--je-color-surface-sunken',
  '--je-color-surface-selected',
  '--je-color-text',
  '--je-color-text-muted',
  '--je-color-border',
  '--je-color-border-strong',
  '--je-color-action',
  '--je-color-action-hover',
  '--je-color-action-active',
  '--je-color-action-contrast',
  '--je-color-action-soft',
  '--je-color-action-soft-hover',
  '--je-color-focus',
  '--je-color-link',
  '--je-radius-control',
  '--je-radius-surface',
  '--je-control-height',
  '--je-font-body',
  '--je-font-display'
]);

const themeTokenValueSchema = z.string().min(1).max(200)
  .refine((value) => !/[{};<>]/u.test(value) && value.trim() === value,
    'theme token values carry plain CSS values only');

/** Immutable compiled presentation release: recipe in, public tokens out. */
export const styleSetReleaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: releaseScopeSchema,
  id: releaseIdSchema,
  number: releaseVersionSchema,
  predecessor: releasePredecessorRefSchema.nullable(),
  recipe: styleSetRecipeSchema,
  tokens: z.record(publicThemeTokenNameSchema, themeTokenValueSchema),
  releasedByUserId: releaseIdSchema,
  releasedAt: canonicalInstantSchema,
  digestSha256: digestSchema
}).superRefine((release, context) => {
  if ((release.number === 1) !== (release.predecessor === null)) {
    context.addIssue({
      code: 'custom', path: ['predecessor'],
      message: 'exactly the first release has no predecessor'
    });
  }
});

/** Typed presentation manifest of the first slice; never free-form markup. */
export const surfaceManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  heading: canonicalText(300).nullable(),
  intro: canonicalText(2_000).nullable()
});

/** Exact form pin a submission-bearing surface release renders. */
export const surfaceFormRefSchema = z.strictObject({
  formId: releaseIdSchema,
  formVersionId: releaseIdSchema
});

const surfaceReleaseCommonFields = {
  schemaVersion: z.literal(1),
  scope: releaseScopeSchema,
  id: releaseIdSchema,
  number: releaseVersionSchema,
  predecessor: releasePredecessorRefSchema.nullable(),
  manifest: surfaceManifestSchema,
  styleSetReleaseId: releaseIdSchema,
  releasedByUserId: releaseIdSchema,
  releasedAt: canonicalInstantSchema,
  digestSha256: digestSchema
} as const;

function addSurfaceChainIssues(
  release: { readonly number: number; readonly predecessor: unknown },
  context: z.core.$RefinementCtx
): void {
  if ((release.number === 1) !== (release.predecessor === null)) {
    context.addIssue({
      code: 'custom', path: ['predecessor'],
      message: 'exactly the first release has no predecessor'
    });
  }
}

/**
 * Immutable presentation-surface release, discriminated by surface kind.
 * Read-only kinds (`schedule`, `speakers`) carry no data pins: their data
 * follows the newest program release under this stable presentation. The
 * submission-bearing `apply` kind additionally pins the exact form version it
 * renders; a form republish plans a successor surface release for surfaces
 * rendering that form.
 */
export const surfaceReleaseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('schedule'), ...surfaceReleaseCommonFields })
    .superRefine(addSurfaceChainIssues),
  z.strictObject({ kind: z.literal('speakers'), ...surfaceReleaseCommonFields })
    .superRefine(addSurfaceChainIssues),
  z.strictObject({
    kind: z.literal('apply'),
    ...surfaceReleaseCommonFields,
    formRef: surfaceFormRefSchema
  }).superRefine(addSurfaceChainIssues)
]);

export const EMBED_FRAME_ORIGIN_LIMIT = 50;
const EMBED_FRAME_ORIGIN_MAX_LENGTH = 255;

export type EmbedFrameOriginRefusalCode =
  | 'empty'
  | 'not_an_origin'
  | 'unsupported_scheme'
  | 'credentials_present'
  | 'path_present'
  | 'query_present'
  | 'fragment_present'
  | 'wildcard_host'
  | 'hostname_forbidden_characters'
  | 'hostname_unqualified';

export type EmbedFrameOriginNormalization =
  | { readonly kind: 'normalized'; readonly origin: string }
  | { readonly kind: 'refused'; readonly code: EmbedFrameOriginRefusalCode };

function refusedFrameOrigin(code: EmbedFrameOriginRefusalCode): EmbedFrameOriginNormalization {
  return Object.freeze({ kind: 'refused', code });
}

/**
 * The exact host shape a `frame-ancestors` host-source can carry: dot-separated
 * labels of lowercase ASCII letters, digits, and hyphens, with an optional
 * trailing dot (URL parsing has already lowercased and punycoded the host).
 * WHATWG `new URL()` accepts hosts a CSP header cannot serialize — `;` starts
 * a new directive, `,` splits the header into separate policies, code points
 * like `_` `&` `'` `!` make the source expression unparseable, and empty
 * labels or IPv6 brackets never match — so a parsed hostname outside this
 * shape is refused rather than stored as an entry whose served header would
 * enforce a different policy than the reviewed allowlist.
 */
const FRAME_ANCESTORS_HOST_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?$/;

/**
 * Normalizes one framing-allowlist entry to exactly a scheme+host origin
 * (lowercased, default port elided, `https` assumed when no scheme is given).
 * Anything an origin cannot carry — wildcards, credentials, a path, a query, a
 * fragment, a non-http(s) scheme — is refused in place rather than being
 * stripped into a stored value that never matches or matches too much. The
 * wildcard and host-shape guards re-run on the parsed hostname, after percent
 * decoding, so `%2A` cannot smuggle a wildcard past the raw check and no
 * accepted origin carries a character the framing header cannot serialize.
 */
export function normalizeEmbedFrameOrigin(value: string): EmbedFrameOriginNormalization {
  const trimmed = value.trim();
  if (trimmed.length === 0) return refusedFrameOrigin('empty');
  if (trimmed.length > EMBED_FRAME_ORIGIN_MAX_LENGTH) return refusedFrameOrigin('not_an_origin');
  if (trimmed.includes('*')) return refusedFrameOrigin('wildcard_host');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return refusedFrameOrigin('not_an_origin');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return refusedFrameOrigin('unsupported_scheme');
  }
  if (url.username !== '' || url.password !== '') return refusedFrameOrigin('credentials_present');
  if (url.search !== '') return refusedFrameOrigin('query_present');
  if (url.hash !== '') return refusedFrameOrigin('fragment_present');
  if (url.pathname !== '/') return refusedFrameOrigin('path_present');
  if (url.hostname.length === 0) return refusedFrameOrigin('not_an_origin');
  if (url.hostname.includes('*')) return refusedFrameOrigin('wildcard_host');
  if (!FRAME_ANCESTORS_HOST_PATTERN.test(url.hostname)) {
    return refusedFrameOrigin('hostname_forbidden_characters');
  }
  if (url.hostname !== 'localhost' && !url.hostname.includes('.')) {
    return refusedFrameOrigin('hostname_unqualified');
  }
  return Object.freeze({ kind: 'normalized', origin: url.origin });
}

/** A stored allowlist entry: exactly its own normalized scheme+host origin bytes. */
export const embedFrameOriginSchema = z.string().min(1).max(EMBED_FRAME_ORIGIN_MAX_LENGTH)
  .refine((value) => {
    const normalization = normalizeEmbedFrameOrigin(value);
    return normalization.kind === 'normalized' && normalization.origin === value;
  }, 'stored frame origins carry exactly the normalized scheme+host origin');

/** Wire form: normalizes trivial noise, refuses anything that is not an origin. */
export const embedFrameOriginInputSchema = z.string().min(1).max(EMBED_FRAME_ORIGIN_MAX_LENGTH)
  .refine((value) => normalizeEmbedFrameOrigin(value).kind === 'normalized',
    'frame origins normalize to scheme + host; anything else is refused in place')
  .overwrite((value) => {
    const normalization = normalizeEmbedFrameOrigin(value);
    return normalization.kind === 'normalized' ? normalization.origin : value;
  });

/**
 * The per-surface framing allowlist as the surface head stores it: canonical
 * unique ascending normalized origins. Every embed kind is allowlist-only —
 * an empty list means no page may frame the surface; there is no stored
 * broad-framing switch.
 */
export const surfaceFrameOriginAllowlistSchema = z.array(embedFrameOriginSchema)
  .max(EMBED_FRAME_ORIGIN_LIMIT)
  .superRefine((origins, context) => {
    for (const [index, origin] of origins.entries()) {
      if (index > 0 && origins[index - 1]! >= origin) {
        context.addIssue({
          code: 'custom', path: [index],
          message: 'frame origins must use canonical unique ascending order'
        });
      }
    }
  });

/** The canonical stored form of a set of accepted frame origins. */
export function canonicalFrameOriginAllowlist(origins: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(origins)].sort());
}

function sameFrameOriginList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin, index) => origin === right[index]);
}

/**
 * Mutable per-kind surface head: the active-release pointer. Publishing
 * validates the referenced releases and advances the pointer atomically;
 * rollback selects another immutable release. Absence means never published.
 * The framing allowlist rides the head as event configuration — publish and
 * rollback carry it forward unchanged; only an allowlist change replaces it.
 */
export const surfaceHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: releaseScopeSchema,
  kind: surfaceKindSchema,
  activeReleaseId: releaseIdSchema,
  version: releaseVersionSchema,
  /** Exact parent origins allowed to frame this surface's embeds; empty denies all. */
  allowedFrameOrigins: surfaceFrameOriginAllowlistSchema,
  updatedByUserId: releaseIdSchema,
  updatedAt: canonicalInstantSchema
});

/** Block-severity schedule conflict evidence; any entry refuses `publish_schedule`. */
export const releaseScheduleConflictSchema = z.strictObject({
  severity: z.literal('block'),
  roomId: releaseIdSchema,
  occurrences: z.array(z.strictObject({
    occurrenceId: releaseIdSchema,
    sessionId: releaseIdSchema,
    startAt: schedulePlacementInstantSchema,
    endAt: schedulePlacementInstantSchema
  })).min(2).max(100)
});

export const RELEASE_PLANNING_ERROR_CODES = [
  'wrong_scope',
  'stale_release_chain',
  'stale_surface_head',
  'schedule_conflicts_block',
  'release_missing',
  'style_set_release_missing',
  'surface_kind_mismatch',
  'form_version_unpinned',
  'participant_name_unavailable',
  'invalid_plan'
] as const;
export const releasePlanningErrorCodeSchema = z.enum(RELEASE_PLANNING_ERROR_CODES);

export const releaseActionSchema = z.enum([
  'publish_schedule',
  'program_rollback',
  'style_set_publish',
  'surface_publish',
  'surface_rollback',
  'surface_allowlist'
]);

const chainGuardFields = {
  /** Current program-release chain head number; null fences "no release yet". */
  expectedCurrentReleaseNumber: releaseVersionSchema.nullable()
} as const;

export const releasePublishScheduleInputSchema = z.strictObject({
  action: z.literal('publish_schedule'),
  ...chainGuardFields
});

export const releaseProgramRollbackInputSchema = z.strictObject({
  action: z.literal('program_rollback'),
  targetReleaseId: releaseIdInputSchema,
  expectedCurrentReleaseNumber: releaseVersionSchema
});

export const releaseStyleSetPublishInputSchema = z.strictObject({
  action: z.literal('style_set_publish'),
  recipe: styleSetRecipeSchema,
  expectedCurrentStyleSetNumber: releaseVersionSchema.nullable()
});

export const releaseSurfacePublishInputSchema = z.strictObject({
  action: z.literal('surface_publish'),
  kind: surfaceKindSchema,
  manifest: surfaceManifestSchema,
  styleSetReleaseId: releaseIdInputSchema,
  /** Required exactly for submission-bearing kinds. */
  formRef: surfaceFormRefSchema.nullable(),
  /** Current head version; null fences "never published". */
  expectedSurfaceHeadVersion: releaseVersionSchema.nullable()
}).superRefine((input, context) => {
  if ((input.kind === 'apply') !== (input.formRef !== null)) {
    context.addIssue({
      code: 'custom', path: ['formRef'],
      message: 'exactly a submission-bearing surface release pins its form version'
    });
  }
});

export const releaseSurfaceRollbackInputSchema = z.strictObject({
  action: z.literal('surface_rollback'),
  kind: surfaceKindSchema,
  targetReleaseId: releaseIdInputSchema,
  expectedSurfaceHeadVersion: releaseVersionSchema
});

/**
 * Replaces one surface's framing allowlist. Framing policy rides the
 * published surface head, so the head must already exist; entries arrive as
 * origins (normalized on parse) and are stored in canonical unique order.
 */
export const releaseSurfaceAllowlistInputSchema = z.strictObject({
  action: z.literal('surface_allowlist'),
  kind: surfaceKindSchema,
  allowedFrameOrigins: z.array(embedFrameOriginInputSchema).max(EMBED_FRAME_ORIGIN_LIMIT),
  expectedSurfaceHeadVersion: releaseVersionSchema
});

/** Operator wire surface for the release draft/mutate operations. */
export const releaseAuthorInputSchema = z.discriminatedUnion('action', [
  releasePublishScheduleInputSchema,
  releaseProgramRollbackInputSchema,
  releaseStyleSetPublishInputSchema,
  releaseSurfacePublishInputSchema,
  releaseSurfaceRollbackInputSchema,
  releaseSurfaceAllowlistInputSchema
]);

const releaseAttribution = {
  scope: releaseScopeSchema,
  actorUserId: releaseIdSchema,
  occurredAt: canonicalInstantSchema
} as const;

/** Server-enriched inputs frozen into plans; release ids are server-assigned. */
export const releasePlanningInputSchema = z.discriminatedUnion('action', [
  releasePublishScheduleInputSchema.extend({ ...releaseAttribution, releaseId: releaseIdSchema }),
  releaseProgramRollbackInputSchema.extend({ ...releaseAttribution, releaseId: releaseIdSchema }),
  releaseStyleSetPublishInputSchema.extend({ ...releaseAttribution, releaseId: releaseIdSchema }),
  releaseSurfacePublishInputSchema.extend({ ...releaseAttribution, releaseId: releaseIdSchema }),
  releaseSurfaceRollbackInputSchema.extend(releaseAttribution),
  releaseSurfaceAllowlistInputSchema.extend(releaseAttribution)
]);

const programChainImageSchema = z.strictObject({
  releaseId: releaseIdSchema,
  number: releaseVersionSchema,
  digestSha256: digestSchema
});

/**
 * One participant appearance a program rollback declines to restore because
 * the person no longer passes the confirmed-and-visible gate right now. The
 * record carries identifiers only — never the withheld display name.
 */
export const releaseRollbackSuppressionSchema = z.strictObject({
  sessionId: releaseIdSchema,
  personId: releaseIdSchema
});

export const releaseProgramPlanSchema = z.strictObject({
  input: z.discriminatedUnion('action', [
    releasePublishScheduleInputSchema.extend({ ...releaseAttribution, releaseId: releaseIdSchema }),
    releaseProgramRollbackInputSchema.extend({ ...releaseAttribution, releaseId: releaseIdSchema })
  ]),
  chainBefore: programChainImageSchema.nullable(),
  /**
   * Exactly the rollback arm re-applies the participant gate over the restored
   * content and records what it withheld; a publish plan carries null. An
   * empty array is the honest "everything restored" evidence.
   */
  rollbackSuppressions: z.array(releaseRollbackSuppressionSchema).max(10_000).nullable(),
  release: programReleaseSchema
}).superRefine((plan, context) => {
  if (plan.release.id !== plan.input.releaseId) {
    context.addIssue({ code: 'custom', message: 'plan release must match its planned identity' });
  }
  if ((plan.input.action === 'program_rollback') !== (plan.rollbackSuppressions !== null)) {
    context.addIssue({
      code: 'custom', path: ['rollbackSuppressions'],
      message: 'exactly a rollback plan records its participant suppressions'
    });
  }
  for (const [index, suppression] of (plan.rollbackSuppressions ?? []).entries()) {
    const previous = plan.rollbackSuppressions![index - 1];
    if (index > 0 && `${previous!.sessionId}:${previous!.personId}`
        >= `${suppression.sessionId}:${suppression.personId}`) {
      context.addIssue({
        code: 'custom', path: ['rollbackSuppressions', index],
        message: 'rollback suppressions must use canonical unique order'
      });
    }
  }
  const expectedNumber = (plan.chainBefore?.number ?? 0) + 1;
  if (plan.release.number !== expectedNumber) {
    context.addIssue({ code: 'custom', message: 'plan release must extend the fenced chain head' });
  }
  const predecessorCoherent = plan.chainBefore === null
    ? plan.release.predecessor === null
    : plan.release.predecessor !== null
      && plan.release.predecessor.releaseId === plan.chainBefore.releaseId
      && plan.release.predecessor.digestSha256 === plan.chainBefore.digestSha256;
  if (!predecessorCoherent) {
    context.addIssue({ code: 'custom', message: 'plan release must chain to the fenced head' });
  }
});

export const releaseStyleSetPlanSchema = z.strictObject({
  input: releaseStyleSetPublishInputSchema.extend({
    ...releaseAttribution,
    releaseId: releaseIdSchema
  }),
  chainBefore: programChainImageSchema.nullable(),
  release: styleSetReleaseSchema
}).superRefine((plan, context) => {
  if (plan.release.id !== plan.input.releaseId
      || plan.release.number !== (plan.chainBefore?.number ?? 0) + 1) {
    context.addIssue({ code: 'custom', message: 'plan release must extend the fenced chain head' });
  }
});

export const releaseSurfacePublishPlanSchema = z.strictObject({
  input: releaseSurfacePublishInputSchema.extend({
    ...releaseAttribution,
    releaseId: releaseIdSchema
  }),
  release: surfaceReleaseSchema,
  headBefore: surfaceHeadSchema.nullable(),
  headAfter: surfaceHeadSchema
}).superRefine((plan, context) => {
  if (plan.release.kind !== plan.input.kind
      || plan.headAfter.kind !== plan.input.kind
      || (plan.headBefore !== null && plan.headBefore.kind !== plan.input.kind)) {
    context.addIssue({ code: 'custom', message: 'plan images must share the surface kind' });
  }
  if (plan.headAfter.activeReleaseId !== plan.release.id
      || plan.headAfter.version !== (plan.headBefore?.version ?? 0) + 1) {
    context.addIssue({ code: 'custom', message: 'plan must advance the head to its release' });
  }
  if (!sameFrameOriginList(
    plan.headAfter.allowedFrameOrigins,
    plan.headBefore?.allowedFrameOrigins ?? []
  )) {
    context.addIssue({
      code: 'custom', path: ['headAfter', 'allowedFrameOrigins'],
      message: 'a publish must carry the framing allowlist forward unchanged'
    });
  }
});

export const releaseSurfaceRollbackPlanSchema = z.strictObject({
  input: releaseSurfaceRollbackInputSchema.extend(releaseAttribution),
  headBefore: surfaceHeadSchema,
  headAfter: surfaceHeadSchema
}).superRefine((plan, context) => {
  if (plan.headBefore.kind !== plan.input.kind || plan.headAfter.kind !== plan.input.kind) {
    context.addIssue({ code: 'custom', message: 'plan images must share the surface kind' });
  }
  if (plan.headAfter.activeReleaseId !== plan.input.targetReleaseId
      || plan.headAfter.version !== plan.headBefore.version + 1) {
    context.addIssue({ code: 'custom', message: 'plan must advance the head to its target release' });
  }
  if (plan.headBefore.activeReleaseId === plan.input.targetReleaseId) {
    context.addIssue({ code: 'custom', message: 'rollback must select a different release' });
  }
  if (!sameFrameOriginList(
    plan.headAfter.allowedFrameOrigins,
    plan.headBefore.allowedFrameOrigins
  )) {
    context.addIssue({
      code: 'custom', path: ['headAfter', 'allowedFrameOrigins'],
      message: 'a rollback must carry the framing allowlist forward unchanged'
    });
  }
});

/**
 * Framing-allowlist change: keeps the active release, advances the head by
 * one, and replaces exactly the allowlist. The before/after head images are
 * the reviewed diff — an approver sees every origin the change admits or
 * removes.
 */
export const releaseSurfaceAllowlistPlanSchema = z.strictObject({
  input: releaseSurfaceAllowlistInputSchema.extend(releaseAttribution),
  headBefore: surfaceHeadSchema,
  headAfter: surfaceHeadSchema
}).superRefine((plan, context) => {
  if (plan.headBefore.kind !== plan.input.kind || plan.headAfter.kind !== plan.input.kind) {
    context.addIssue({ code: 'custom', message: 'plan images must share the surface kind' });
  }
  if (plan.headAfter.activeReleaseId !== plan.headBefore.activeReleaseId
      || plan.headAfter.version !== plan.headBefore.version + 1) {
    context.addIssue({
      code: 'custom',
      message: 'an allowlist change must keep the active release and advance the head by one'
    });
  }
  const requested = canonicalFrameOriginAllowlist(plan.input.allowedFrameOrigins);
  if (!sameFrameOriginList(plan.headAfter.allowedFrameOrigins, requested)) {
    context.addIssue({
      code: 'custom', path: ['headAfter', 'allowedFrameOrigins'],
      message: 'plan must apply exactly the canonical requested origins'
    });
  }
  if (sameFrameOriginList(
    plan.headBefore.allowedFrameOrigins,
    plan.headAfter.allowedFrameOrigins
  )) {
    context.addIssue({ code: 'custom', message: 'an allowlist change must change the allowlist' });
  }
});

export const releaseMutationPlanSchema = z.union([
  releaseProgramPlanSchema,
  releaseStyleSetPlanSchema,
  releaseSurfacePublishPlanSchema,
  releaseSurfaceRollbackPlanSchema,
  releaseSurfaceAllowlistPlanSchema
]);

/**
 * Reviewed diff for one release operation. A program publish surfaces the
 * audited name declassifications explicitly: the reviewer sees exactly which
 * display names the commit copies into public state.
 */
export const releaseSafeDiffSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.enum(['publish_schedule', 'program_rollback']),
    before: programChainImageSchema.nullable(),
    after: programChainImageSchema,
    releasedSessionCount: z.number().int().nonnegative().safe(),
    releasedOccurrenceCount: z.number().int().nonnegative().safe(),
    nameDeclassifications: z.array(releaseNameDeclassificationSchema).max(10_000),
    /**
     * Rollback-only revocation evidence, surfaced beside the full name list so
     * an approver restoring a prior release sees exactly which appearances the
     * gate withheld because the person is hidden or unconfirmed today.
     */
    rollbackSuppressions: z.array(releaseRollbackSuppressionSchema).max(10_000).nullable()
  }),
  z.strictObject({
    action: z.literal('style_set_publish'),
    before: programChainImageSchema.nullable(),
    after: programChainImageSchema,
    recipe: styleSetRecipeSchema
  }),
  z.strictObject({
    action: z.literal('surface_publish'),
    kind: surfaceKindSchema,
    before: surfaceHeadSchema.nullable(),
    after: surfaceHeadSchema,
    styleSetReleaseId: releaseIdSchema,
    formRef: surfaceFormRefSchema.nullable()
  }),
  z.strictObject({
    action: z.literal('surface_rollback'),
    kind: surfaceKindSchema,
    before: surfaceHeadSchema,
    after: surfaceHeadSchema
  }),
  z.strictObject({
    action: z.literal('surface_allowlist'),
    kind: surfaceKindSchema,
    before: surfaceHeadSchema,
    after: surfaceHeadSchema
  })
]);

export const releaseMutationResultSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.enum(['publish_schedule', 'program_rollback']),
    release: programReleaseSchema
  }),
  z.strictObject({ action: z.literal('style_set_publish'), release: styleSetReleaseSchema }),
  z.strictObject({
    action: z.literal('surface_publish'),
    release: surfaceReleaseSchema,
    head: surfaceHeadSchema
  }),
  z.strictObject({ action: z.literal('surface_rollback'), head: surfaceHeadSchema }),
  z.strictObject({ action: z.literal('surface_allowlist'), head: surfaceHeadSchema })
]);

/**
 * Cross-domain successor collaboration: a form republish hosts, inside its own
 * reviewed changeset, successor surface releases for every submission-bearing
 * surface whose active release renders the republished form. Read-only
 * surfaces never appear here.
 */
export const releaseSurfaceSuccessorInputSchema = z.strictObject({
  scope: releaseScopeSchema,
  formId: releaseIdSchema,
  formVersionId: releaseIdSchema,
  actorUserId: releaseIdSchema,
  occurredAt: canonicalInstantSchema
});

export const releaseSurfaceSuccessorPlanSchema = z.strictObject({
  input: releaseSurfaceSuccessorInputSchema,
  successors: z.array(z.strictObject({
    release: surfaceReleaseSchema,
    headBefore: surfaceHeadSchema,
    headAfter: surfaceHeadSchema
  })).max(20)
}).superRefine((plan, context) => {
  for (const [index, successor] of plan.successors.entries()) {
    if (successor.release.kind !== 'apply'
        || successor.release.formRef.formId !== plan.input.formId
        || successor.release.formRef.formVersionId !== plan.input.formVersionId) {
      context.addIssue({
        code: 'custom', path: ['successors', index],
        message: 'successor releases pin exactly the republished form version'
      });
    }
    if (successor.headAfter.activeReleaseId !== successor.release.id
        || successor.headAfter.version !== successor.headBefore.version + 1) {
      context.addIssue({
        code: 'custom', path: ['successors', index],
        message: 'successor plans must advance their head to the successor release'
      });
    }
    if (!sameFrameOriginList(
      successor.headAfter.allowedFrameOrigins,
      successor.headBefore.allowedFrameOrigins
    )) {
      context.addIssue({
        code: 'custom', path: ['successors', index],
        message: 'successor plans must carry the framing allowlist forward unchanged'
      });
    }
  }
});

/** Current release state an operator reviews before drafting. */
export const releaseOverviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: releaseScopeSchema,
  currentProgramRelease: programReleaseSchema.nullable(),
  currentStyleSetRelease: styleSetReleaseSchema.nullable(),
  surfaceHeads: z.array(surfaceHeadSchema).max(3)
}).superRefine((overview, context) => {
  const kinds = new Set<string>();
  for (const [index, head] of overview.surfaceHeads.entries()) {
    if (kinds.has(head.kind)) {
      context.addIssue({
        code: 'custom', path: ['surfaceHeads', index],
        message: 'surface heads must be unique per kind'
      });
    }
    kinds.add(head.kind);
  }
});

/** Exact selector and inert plan an operator needs to review one release draft. */
export const releaseDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: releaseActionSchema,
  changesetId: releaseIdSchema,
  headVersion: releaseVersionSchema,
  status: z.literal('draft'),
  revision: z.strictObject({
    id: releaseIdSchema,
    number: releaseVersionSchema,
    digestSha256: digestSchema
  }),
  riskTier: z.literal('consequential'),
  approvalPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: digestSchema,
    requirement: z.enum(['none', 'distinct_current_human'])
  }),
  safeDiff: releaseSafeDiffSchema
}).superRefine((data, context) => {
  if (data.safeDiff.action !== data.action) {
    context.addIssue({
      code: 'custom', path: ['safeDiff', 'action'],
      message: 'Draft action and safe diff action must match.'
    });
  }
});

export const releaseOverviewReadInputSchema = z.strictObject({});
export const releaseOverviewReadResultSchema = createReadOperationResultSchema(releaseOverviewSchema);
export const releaseDraftOperationResultSchema =
  createEffectfulOperationResultSchema(releaseDraftDataSchema);

/**
 * Served public projections: named strict DTOs derived from an immutable
 * program release, never filtered internal rows. Everything below is
 * publishable by construction — a session or person that should not be public
 * was already excluded at materialization, display names are the release's own
 * audited copies, and no field can carry a person identifier, contact detail,
 * or organizer-only fact because none is representable.
 */

/** The open public read carries no parameters; anything else is refused. */
export const releasePublicReadInputSchema = z.strictObject({});

/**
 * One session as the public schedule serves it. Speakers appear as released
 * display names in released order — a public schedule names people, it never
 * keys them.
 */
export const servedPublicScheduleSessionSchema = z.strictObject({
  sessionId: releaseIdSchema,
  title: canonicalText(300),
  plannedDurationMinutes: sessionPlannedDurationMinutesSchema,
  format: programVocabularyNameSchema,
  track: z.strictObject({
    name: programVocabularyNameSchema,
    accent: programTrackAccentSchema
  }).nullable(),
  occurrences: z.array(releasedOccurrenceSchema).max(100),
  speakers: z.array(canonicalText(300)).max(500)
});

export const servedPublicScheduleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseNumber: releaseVersionSchema,
  rooms: z.array(releasedRoomSchema).max(500),
  sessions: z.array(servedPublicScheduleSessionSchema).max(5_000)
}).superRefine((schedule, context) => {
  for (const [index, room] of schedule.rooms.entries()) {
    if (index > 0 && schedule.rooms[index - 1]!.id >= room.id) {
      context.addIssue({
        code: 'custom', path: ['rooms', index],
        message: 'served rooms must use canonical id order'
      });
    }
  }
  const roomIds = new Set(schedule.rooms.map((room) => room.id));
  const usedRoomIds = new Set<string>();
  for (const [index, session] of schedule.sessions.entries()) {
    if (index > 0 && schedule.sessions[index - 1]!.sessionId >= session.sessionId) {
      context.addIssue({
        code: 'custom', path: ['sessions', index],
        message: 'served sessions must use canonical unique id order'
      });
    }
    for (const [occurrenceIndex, occurrence] of session.occurrences.entries()) {
      usedRoomIds.add(occurrence.roomId);
      if (!roomIds.has(occurrence.roomId)) {
        context.addIssue({
          code: 'custom', path: ['sessions', index, 'occurrences', occurrenceIndex, 'roomId'],
          message: 'served occurrences must reference served rooms'
        });
      }
      if (occurrenceIndex > 0) {
        const previous = session.occurrences[occurrenceIndex - 1]!;
        const previousKey = `${previous.startAt}:${previous.endAt}:${previous.occurrenceId}`;
        const key = `${occurrence.startAt}:${occurrence.endAt}:${occurrence.occurrenceId}`;
        if (previousKey >= key) {
          context.addIssue({
            code: 'custom', path: ['sessions', index, 'occurrences', occurrenceIndex],
            message: 'served occurrences must use canonical order'
          });
        }
      }
    }
  }
  if (usedRoomIds.size !== schedule.rooms.length) {
    context.addIssue({
      code: 'custom', path: ['rooms'],
      message: 'served rooms must be exactly the rooms served occurrences reference'
    });
  }
});

export const servedPublicSpeakerSessionSchema = z.strictObject({
  sessionId: releaseIdSchema,
  title: canonicalText(300)
});

/**
 * One person as the public roster shows them: the released display name and
 * the visible session appearances that put them there. A card exists only
 * through appearances, and it carries no person identifier at all — two cards
 * may even share a name.
 */
export const servedPublicSpeakerCardSchema = z.strictObject({
  name: canonicalText(300),
  sessions: z.array(servedPublicSpeakerSessionSchema).min(1).max(200)
});

/**
 * The public speakers page: the union of publicly visible session appearances
 * in one released program, ordered by display name.
 */
export const servedPublicRosterSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseNumber: releaseVersionSchema,
  speakers: z.array(servedPublicSpeakerCardSchema).max(10_000)
}).superRefine((roster, context) => {
  for (const [index, speaker] of roster.speakers.entries()) {
    if (index > 0 && roster.speakers[index - 1]!.name > speaker.name) {
      context.addIssue({
        code: 'custom', path: ['speakers', index],
        message: 'served speakers must use canonical name order'
      });
    }
    for (const [sessionIndex, session] of speaker.sessions.entries()) {
      if (sessionIndex > 0
          && speaker.sessions[sessionIndex - 1]!.sessionId >= session.sessionId) {
        context.addIssue({
          code: 'custom', path: ['speakers', index, 'sessions', sessionIndex],
          message: 'served speaker sessions must use canonical unique id order'
        });
      }
    }
  }
});

export const RELEASE_OPERATION_SCHEMA_REFS = Object.freeze({
  overviewRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.release.overview-read.input',
    inputSchema: releaseOverviewReadInputSchema,
    resultKey: 'schema.release.overview-read.operator-result',
    resultSchema: releaseOverviewReadResultSchema
  }),
  draft: createOperationSchemaManifestRefs({
    inputKey: 'schema.release.change-draft.input',
    inputSchema: releaseAuthorInputSchema,
    resultKey: 'schema.release.change-draft.operator-result',
    resultSchema: releaseDraftOperationResultSchema
  })
});

export type ReleaseScopeDto = z.infer<typeof releaseScopeSchema>;
export type SurfaceKind = z.infer<typeof surfaceKindSchema>;
export type ProgramReleaseOriginDto = z.infer<typeof programReleaseOriginSchema>;
export type ProgramReleaseEvidencePinsDto = z.infer<typeof programReleaseEvidencePinsSchema>;
export type ReleasedParticipantDto = z.infer<typeof releasedParticipantSchema>;
export type ReleasedOccurrenceDto = z.infer<typeof releasedOccurrenceSchema>;
export type ReleasedRoomDto = z.infer<typeof releasedRoomSchema>;
export type ReleasedSessionDto = z.infer<typeof releasedSessionSchema>;
export type ReleaseNameDeclassificationDto = z.infer<typeof releaseNameDeclassificationSchema>;
export type ProgramReleaseDto = z.infer<typeof programReleaseSchema>;
export type StyleSetRecipeDto = z.infer<typeof styleSetRecipeSchema>;
export type PublicThemeTokenName = z.infer<typeof publicThemeTokenNameSchema>;
export type StyleSetReleaseDto = z.infer<typeof styleSetReleaseSchema>;
export type SurfaceManifestDto = z.infer<typeof surfaceManifestSchema>;
export type SurfaceFormRefDto = z.infer<typeof surfaceFormRefSchema>;
export type SurfaceReleaseDto = z.infer<typeof surfaceReleaseSchema>;
export type SurfaceHeadDto = z.infer<typeof surfaceHeadSchema>;
export type ReleaseScheduleConflictDto = z.infer<typeof releaseScheduleConflictSchema>;
export type ReleaseRollbackSuppressionDto = z.infer<typeof releaseRollbackSuppressionSchema>;
export type ReleasePlanningErrorCode = z.infer<typeof releasePlanningErrorCodeSchema>;
export type ReleaseAction = z.infer<typeof releaseActionSchema>;
export type ReleaseAuthorInput = z.infer<typeof releaseAuthorInputSchema>;
export type ReleasePlanningInput = z.infer<typeof releasePlanningInputSchema>;
export type ReleaseProgramPlanDto = z.infer<typeof releaseProgramPlanSchema>;
export type ReleaseStyleSetPlanDto = z.infer<typeof releaseStyleSetPlanSchema>;
export type ReleaseSurfacePublishPlanDto = z.infer<typeof releaseSurfacePublishPlanSchema>;
export type ReleaseSurfaceRollbackPlanDto = z.infer<typeof releaseSurfaceRollbackPlanSchema>;
export type ReleaseSurfaceAllowlistPlanDto = z.infer<typeof releaseSurfaceAllowlistPlanSchema>;
export type ReleaseMutationPlanDto = z.infer<typeof releaseMutationPlanSchema>;
export type ReleaseSafeDiffDto = z.infer<typeof releaseSafeDiffSchema>;
export type ReleaseMutationResultDto = z.infer<typeof releaseMutationResultSchema>;
export type ReleaseSurfaceSuccessorInputDto = z.infer<typeof releaseSurfaceSuccessorInputSchema>;
export type ReleaseSurfaceSuccessorPlanDto = z.infer<typeof releaseSurfaceSuccessorPlanSchema>;
export type ReleaseOverviewDto = z.infer<typeof releaseOverviewSchema>;
export type ReleaseDraftData = z.infer<typeof releaseDraftDataSchema>;
export type ServedPublicScheduleSessionDto = z.infer<typeof servedPublicScheduleSessionSchema>;
export type ServedPublicScheduleDto = z.infer<typeof servedPublicScheduleSchema>;
export type ServedPublicSpeakerSessionDto = z.infer<typeof servedPublicSpeakerSessionSchema>;
export type ServedPublicSpeakerCardDto = z.infer<typeof servedPublicSpeakerCardSchema>;
export type ServedPublicRosterDto = z.infer<typeof servedPublicRosterSchema>;
