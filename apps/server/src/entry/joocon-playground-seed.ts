import { makeSignature } from 'better-auth/crypto';
import {
  accessContextSchema,
  createEffectfulOperationResultSchema,
  createReadOperationResultSchema,
  currentEventSettingsReadResultSchema,
  decisionDecideOperationResultSchema,
  engagementChangeOperationResultSchema,
  engagementSnapshotReadResultSchema,
  eventCreateOperationResultSchema,
  eventSettingsUpdateOperationResultSchema,
  fieldRegistrySnapshotReadResultSchema,
  fieldRegistryDirectOperationResultSchema,
  intakeFormDirectOperationResultSchema,
  intakeFormVersionPublishOperationResultSchema,
  intakeFormVersionReviewDraftOperationResultSchema,
  organizerFormCatalogSchema,
  organizerFormDetailSchema,
  programVocabularySnapshotReadResultSchema,
  releasePublishOperationResultSchema,
  releaseReviewDraftOperationResultSchema,
  schedulePlacementOperationResultSchema,
  submissionDirectEntryOperationResultSchema,
  taskMutationOperationResultSchema,
  templateArtifactListOperationResultSchema,
  type FormDefinitionCreateAuthorInput,
  type FormTarget
} from '@jooevents/contracts';
import { fileAttachmentSchema } from '@jooevents/contracts/files';
import {
  reviewerRosterDirectOperationResultSchema,
  reviewerRosterSnapshotReadResultSchema
} from '@jooevents/contracts/reviewer-roster';
import {
  reviewDirectOperationResultSchema,
  reviewDraftSaveOperationResultSchema,
  reviewSnapshotReadResultSchema
} from '@jooevents/contracts/reviews';
import {
  sessionCatalogReadResultSchema,
  sessionDirectOperationResultSchema
} from '@jooevents/contracts/sessions';
import {
  workspaceTeamMutationOperationResultSchema,
  workspaceTeamMembersReadResultSchema
} from '@jooevents/contracts/workspace-team';
import { normalizeEmail } from '@jooevents/identity-access';
import { programVocabularyDirectOperationResultSchema } from '@jooevents/contracts';
import { schedulePlacementSnapshotReadResultSchema } from '@jooevents/schedule-operations';
import type { ServerConfig } from '../config';
import type { DevFixtureClock } from '../runtime/dev-fixture-clock';
import type { EphemeralLiveRuntime } from '../runtime/ephemeral-live';
import { z } from 'zod';

const organizerFormCatalogReadResultSchema = createReadOperationResultSchema(
  organizerFormCatalogSchema
);
const organizerFormDetailReadResultSchema = createReadOperationResultSchema(
  organizerFormDetailSchema
);
const fileLinkAttachOperationResultSchema = createEffectfulOperationResultSchema(
  z.strictObject({
    action: z.literal('attachment.link'),
    attachment: fileAttachmentSchema,
    idempotent: z.boolean()
  })
);

/**
 * Seeded workspace principals. Neither address is the configured
 * `JOOEVENTS_BOOTSTRAP_OWNER_EMAIL`: each seeded principal opens and consumes
 * its OWN access reservation, so the bootstrap owner reservation minted by
 * `bootstrapEmptyInstall` stays `open` and the human owner's later Google
 * sign-in is still admitted into this very workspace as Workspace Admin.
 */
const OPERATOR_EMAIL = 'maya.chen@joocon.example.test';
const REVIEWER_EMAIL = 'leonie.weber@joocon.example.test';

/**
 * Reservation permission grants the ephemeral runtime attaches to the bootstrap
 * owner reservation. The seeded operator holds its own reservation, so the same
 * three bootstrap-only grants are attached to it verbatim; without
 * `publication.manage` no principal in this composition could publish.
 */
const OPERATOR_PERMISSION_GRANTS = Object.freeze([
  Object.freeze({
    permissionId: 'program.vocabulary.manage',
    reason: 'Seeded playground Program Vocabulary operator grant'
  }),
  Object.freeze({
    permissionId: 'communication.provider.manage',
    reason: 'Seeded playground email provider operator grant'
  }),
  Object.freeze({
    permissionId: 'publication.manage',
    reason: 'Seeded playground publication operator grant (bootstrap-only)'
  })
] as const);

const EVENT = Object.freeze({
  name: 'JooCon 2027',
  timezone: 'Europe/Berlin',
  startDate: '2027-09-15',
  endDate: '2027-09-17'
});

const EVENT_SETTINGS_TEXT = Object.freeze({
  location: 'Kulturbrauerei, Berlin',
  venueNote: 'Registration and badge pickup open in Kesselhaus foyer from 08:00.'
});

/** Review round due date, inside the event window. */
const REVIEW_DUE_DATE = '2027-09-16';

/**
 * One monotone nine-week story. All offsets are relative to process start and
 * every write still enters through its registered HTTP operation; only the
 * server-stamped fixture time changes between calls.
 */
const SEED_TIMELINE = Object.freeze({
  setupDaysBeforeAnchor: 70,
  arrivalDaysBeforeAnchor: Object.freeze([63, 60, 57, 54, 51, 48, 45, 42, 39]),
  reviewRoundDaysBeforeAnchor: 36,
  reviewDaysBeforeAnchor: Object.freeze([35, 31, 27, 23, 19, 15]),
  decisionDaysBeforeAnchor: Object.freeze([12, 10, 8, 6, 4, 2, 1])
});

const ROOMS = Object.freeze([
  Object.freeze({ key: 'main_stage', name: 'Kesselhaus Main Stage', capacity: 620 }),
  Object.freeze({ key: 'studio', name: 'Maschinenhaus Studio', capacity: 190 }),
  Object.freeze({ key: 'workshop_loft', name: 'Workshop Loft', capacity: 64 })
] as const);

const TRACKS = Object.freeze([
  Object.freeze({ key: 'agent_systems', name: 'Agent Systems' }),
  Object.freeze({ key: 'platform_reliability', name: 'Platform & Reliability' }),
  Object.freeze({ key: 'organizer_craft', name: 'Organizer Craft' })
] as const);

const FORMATS = Object.freeze([
  Object.freeze({ key: 'talk', name: 'Talk' }),
  Object.freeze({ key: 'workshop', name: 'Workshop' }),
  Object.freeze({ key: 'lightning_talk', name: 'Lightning Talk' }),
  Object.freeze({ key: 'panel', name: 'Panel' })
] as const);

type RoomKey = typeof ROOMS[number]['key'];
type TrackKey = typeof TRACKS[number]['key'];
type FormatKey = typeof FORMATS[number]['key'];
type VocabularyKey = RoomKey | TrackKey | FormatKey;

interface SubmissionSpec {
  readonly key: string;
  readonly name: string;
  readonly email: string;
  readonly title: string;
  readonly abstract: string;
  readonly trackKey?: TrackKey;
}

/**
 * Featured-talk applications. Their form pins the `Talk` format category, so
 * every one of them carries the format evidence an accept-with-spawn needs.
 */
const FEATURED_SUBMISSIONS: readonly SubmissionSpec[] = Object.freeze([
  Object.freeze({
    key: 'okonkwo',
    name: 'Nadia Okonkwo',
    email: 'nadia.okonkwo@example.test',
    trackKey: 'platform_reliability',
    title: 'Guarded Operations All the Way Down',
    abstract: 'Every effective change in our platform passes through one typed, guarded operation. This talk covers the resulting authority, replay, and history guarantees after two years in production.'
  }),
  Object.freeze({
    key: 'lindqvist',
    name: 'Teodor Lindqvist',
    email: 'teodor.lindqvist@example.test',
    trackKey: 'organizer_craft',
    title: 'The Deadline That Kept Its Promise',
    abstract: 'Conference deadlines are timezone puzzles wearing a calendar costume. A practical tour of grace windows, display dates, and the moment a reviewer in Auckland and an organizer in Lisbon disagree about what "Friday" means.'
  }),
  Object.freeze({
    key: 'raghunathan',
    name: 'Priya Raghunathan',
    email: 'priya.raghunathan@example.test',
    trackKey: 'agent_systems',
    title: 'Agents That Ask Before They Act',
    abstract: 'We gave language models the whole organizer toolbox and then took away their ability to write anything directly. What is left is a drafting partner that proposes, explains, and waits. Includes the review surface that made it trustworthy.'
  }),
  Object.freeze({
    key: 'bevilacqua',
    name: 'Marcus Bevilacqua',
    email: 'marcus.bevilacqua@example.test',
    trackKey: 'platform_reliability',
    title: 'Schedule Physics for Stubborn Rooms',
    abstract: 'Rooms overlap, speakers clone themselves, and the catering slot moves. A field guide to constraint checking that refuses the impossible schedule loudly and early, instead of discovering it at 08:55 on day one.'
  }),
  Object.freeze({
    key: 'steinberg',
    name: 'Hana Steinberg',
    email: 'hana.steinberg@example.test',
    trackKey: 'organizer_craft',
    title: 'Reviewing 900 Talks Without Losing the Plot',
    abstract: 'Anonymized rounds, anti-anchoring, and the quiet statistics of a five-point scale. What we learned running a program committee of forty people through three review rounds in six weeks.'
  })
]);

/** General-pool applications: no pinned format, so none of them can spawn. */
const GENERAL_SUBMISSIONS: readonly SubmissionSpec[] = Object.freeze([
  Object.freeze({
    key: 'delacroix',
    name: 'Oscar Delacroix',
    email: 'oscar.delacroix@example.test',
    title: 'Why Our CFP Emails Went to Spam',
    abstract: 'A deliverability postmortem from an event that lost a third of its acceptance notices to a misconfigured sending domain, and the boring checklist that fixed it for good.'
  }),
  Object.freeze({
    key: 'tanabe',
    name: 'Aiko Tanabe',
    email: 'aiko.tanabe@example.test',
    title: 'Volunteer Rotas as a Constraint Problem',
    abstract: 'Sixty volunteers, four venues, and a spreadsheet that had stopped being a spreadsheet. How we modelled shift coverage properly and gave everyone their lunch break back.'
  }),
  Object.freeze({
    key: 'monteiro',
    name: 'Rafael Monteiro',
    email: 'rafael.monteiro@example.test',
    title: 'Ten Years of Hallway Track Data',
    abstract: 'We surveyed attendees about the sessions they skipped, every year, for a decade. The results changed how we lay out breaks, sponsor space, and the coffee queue.'
  }),
  Object.freeze({
    key: 'halvorsen',
    name: 'Ingrid Halvorsen',
    email: 'ingrid.halvorsen@example.test',
    title: 'Sponsor Booths Nobody Hates',
    abstract: 'Sponsorship pays for the event and can quietly ruin it. Layout patterns, expectation setting, and the contract language that keeps the exhibition floor part of the conference rather than a tax on it.'
  })
]);

const PLACEMENTS = Object.freeze([
  Object.freeze({
    submissionKey: 'okonkwo',
    roomKey: 'main_stage' as RoomKey,
    startAt: '2027-09-15T07:30:00.000Z',
    endAt: '2027-09-15T08:15:00.000Z'
  }),
  Object.freeze({
    submissionKey: 'lindqvist',
    roomKey: 'studio' as RoomKey,
    startAt: '2027-09-15T08:30:00.000Z',
    endAt: '2027-09-15T09:15:00.000Z'
  }),
  Object.freeze({
    submissionKey: 'raghunathan',
    roomKey: 'main_stage' as RoomKey,
    startAt: '2027-09-15T09:30:00.000Z',
    endAt: '2027-09-15T10:15:00.000Z'
  })
] as const);

/** Speakers whose engagement the organizer records as confirmed. */
const CONFIRMED_SUBMISSION_KEYS: readonly string[] = Object.freeze([
  'okonkwo', 'lindqvist', 'raghunathan'
]);

const CANONICAL_SESSION_DESCRIPTION =
  'A practical tour of approval-bound agents: typed operations, visible plans, and the refusal paths that keep effective state under human control.';

const SESSION_FILE_LINKS = Object.freeze([
  Object.freeze({
    title: 'Agents That Ask Before They Act',
    label: 'Agent approval runbook.pdf',
    url: 'https://assets.example.test/joocon/agent-approval-runbook.pdf'
  }),
  Object.freeze({
    title: 'The Deadline That Kept Its Promise',
    label: 'Timezone edge-case checklist.pdf',
    url: 'https://assets.example.test/joocon/timezone-edge-case-checklist.pdf'
  })
] as const);

const SPEAKER_TASKS = Object.freeze([
  Object.freeze({
    key: 'bio',
    name: 'Confirm speaker bio',
    description: 'Review the biography that will accompany the published speaker profile.',
    completionMode: 'acknowledge' as const,
    required: true,
    dueOn: '2027-08-15'
  }),
  Object.freeze({
    key: 'headshot',
    name: 'Upload headshot',
    description: 'Provide a high-resolution headshot for the event programme.',
    completionMode: 'file_upload' as const,
    required: true,
    dueOn: '2027-08-22'
  }),
  Object.freeze({
    key: 'slides',
    name: 'Upload slide draft',
    description: 'Send the first slide deck for the programme team to check.',
    completionMode: 'file_upload' as const,
    required: false,
    dueOn: '2027-09-08'
  })
] as const);

const EVALUATIONS = Object.freeze([
  Object.freeze({ score: 5, comment: 'Concrete, production-grounded, and the diff surface demo lands.' }),
  Object.freeze({ score: 4, comment: 'Strong material. Ask for one worked timezone example on stage.' }),
  Object.freeze({ score: 5, comment: 'Exactly the argument this track needs; the refusal cases are the best part.' }),
  Object.freeze({ score: 3, comment: 'Useful, slightly narrow. Would work better as a lightning talk.' }),
  Object.freeze({ score: 4, comment: 'Clear structure and honest numbers. Happy to see it programmed.' }),
  Object.freeze({ score: 4, comment: 'Good fit. Suggest trimming the tooling history at the front.' })
] as const);

export interface PlaygroundSeedSummary {
  readonly eventId: string;
  readonly eventName: string;
  readonly operatorEmail: string;
  readonly reviewerEmail: string;
  readonly bootstrapOwnerEmail: string;
  readonly bootstrapOwnerReservationOpen: boolean;
  readonly vocabulary: { readonly rooms: number; readonly tracks: number; readonly formats: number };
  readonly openForms: number;
  readonly submissions: number;
  readonly reviewers: number;
  readonly reviewAssignments: number;
  readonly committedReviews: number;
  readonly accepted: number;
  readonly waitlisted: number;
  readonly declined: number;
  readonly spawnedSessions: number;
  readonly placements: number;
  readonly confirmedEngagements: number;
  readonly taskDefinitions: number;
  readonly conditionalRules: number;
  readonly sessionFiles: number;
  readonly releaseNumber: number;
  readonly applyFormId: string;
}

interface SeedPrincipal {
  readonly authUserId: string;
  readonly userId: string;
  readonly cookie: string;
}

interface SeedContext {
  readonly runtime: EphemeralLiveRuntime;
  readonly config: ServerConfig;
  readonly cookie: string;
  readonly clock: DevFixtureClock;
}

interface DraftSelectorSource {
  readonly data: {
    readonly draftId: string;
    readonly revision: { readonly id: string; readonly digestSha256: string };
    readonly safeDiff: { readonly action: string };
  };
}

function fail(label: string, detail: unknown): never {
  throw new TypeError(`joocon_playground_seed_${label}:${JSON.stringify(detail)}`);
}

/**
 * Names the session cookie exactly as the composed Better Auth instance reads
 * it. That instance sets `advanced.useSecureCookies` from the configured base
 * URL's protocol, and Better Auth prefixes every cookie with `__Secure-` when
 * that flag is on — so an https deployment (the tailnet preview origin) reads
 * `__Secure-better-auth.session_token` while an http localhost origin reads the
 * bare name. Deriving the name from the loaded config keeps the seed correct on
 * both instead of assuming a development origin. Neither `advanced.cookiePrefix`
 * nor `advanced.cookies` is configured, so the suffix is Better Auth's default.
 */
function sessionCookieName(config: ServerConfig): string {
  const prefix = new URL(config.baseUrl).protocol === 'https:' ? '__Secure-' : '';
  return `${prefix}better-auth.session_token`;
}

function requireSuccess<Result extends { readonly kind: string }>(
  result: Result,
  label: string
): Extract<Result, { readonly kind: 'success' }> {
  if (result.kind !== 'success') fail(label, result);
  return result as Extract<Result, { readonly kind: 'success' }>;
}

async function read<Result>(
  context: SeedContext,
  path: string,
  parse: (value: unknown) => Result
): Promise<Result> {
  const response = await context.runtime.app.request(path, {
    headers: { cookie: context.cookie, 'x-correlation-id': crypto.randomUUID() }
  });
  if (response.status !== 200) {
    fail('read_failed', { path, status: response.status, body: await response.text() });
  }
  return parse(await response.json());
}

async function effect<Result>(input: {
  readonly context: SeedContext;
  readonly path: string;
  readonly key: string;
  readonly body: unknown;
  readonly parse: (value: unknown) => Result;
}): Promise<Result> {
  const response = await input.context.runtime.app.request(input.path, {
    method: 'POST',
    headers: {
      cookie: input.context.cookie,
      origin: input.context.config.baseUrl,
      'content-type': 'application/json',
      'idempotency-key': input.key,
      'x-correlation-id': crypto.randomUUID()
    },
    body: JSON.stringify(input.body)
  });
  if (response.status !== 200) {
    fail('effect_failed', { path: input.path, status: response.status, body: await response.text() });
  }
  return input.parse(await response.json());
}

async function publishRelease(
  context: SeedContext,
  key: string,
  draft: DraftSelectorSource
): Promise<void> {
  const published = requireSuccess(releasePublishOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/releases/publish',
    key: `${key}-publish`,
    body: {
      draftId: draft.data.draftId,
      revisionId: draft.data.revision.id,
      revisionDigestSha256: draft.data.revision.digestSha256
    },
    parse: (value) => value
  })), `${key}_publish`);
  if (published.data.action !== draft.data.safeDiff.action) {
    fail(`${key}_publish_action`, published.data.action);
  }
}

/**
 * Mints one workspace principal through the sanctioned admission seam: raw
 * Better Auth rows plus an OWN open access reservation that
 * `/api/me/access-context` consumes. No registered operation can admit a brand
 * new principal in this composition, and every JooEvents-domain write past
 * admission goes through operations.
 */
async function createSeededPrincipal(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly config: ServerConfig;
  readonly email: string;
  readonly displayName: string;
  readonly rolePresetKey: 'workspace_admin' | 'viewer';
  readonly permissionGrants?: readonly { readonly permissionId: string; readonly reason: string }[];
}): Promise<SeedPrincipal> {
  const { runtime, config } = input;
  const now = Date.now();
  const role = runtime.database.sqlite.query<{ readonly id: string }, [string, string]>(`
    SELECT id FROM roles
     WHERE workspace_id = ? AND source_preset_key = ? AND archived_at IS NULL
  `).get(runtime.workspaceId, input.rolePresetKey);
  if (!role) fail('role_preset_missing', input.rolePresetKey);

  const reservationId = crypto.randomUUID();
  // Reservations are matched against the normalized verified claim, so the row
  // is written through the same normalizer `bootstrapEmptyInstall` uses.
  runtime.database.sqlite.query(`
    INSERT INTO access_reservations (
      id, workspace_id, normalized_email, status, created_at, version
    ) VALUES (?, ?, ?, 'open', ?, 1)
  `).run(reservationId, runtime.workspaceId, normalizeEmail(input.email), now);
  runtime.database.sqlite.query(`
    INSERT INTO reservation_role_assignments (
      id, reservation_id, role_id, scope_kind, event_id
    ) VALUES (?, ?, ?, 'workspace', NULL)
  `).run(crypto.randomUUID(), reservationId, role.id);
  const grantInsert = runtime.database.sqlite.query(`
    INSERT INTO reservation_permission_overrides (
      id, reservation_id, permission_id, effect, scope_kind, event_id, reason
    ) VALUES (?, ?, ?, 'grant', 'workspace', NULL, ?)
  `);
  for (const grant of input.permissionGrants ?? []) {
    grantInsert.run(crypto.randomUUID(), reservationId, grant.permissionId, grant.reason);
  }

  const authUserId = crypto.randomUUID();
  const rawToken = crypto.randomUUID();
  runtime.database.sqlite.query(`
    INSERT INTO auth_users (
      id, name, email, email_verified, image, created_at, updated_at
    ) VALUES (?, ?, ?, 1, NULL, ?, ?)
  `).run(authUserId, input.displayName, input.email, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_accounts (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES (?, ?, 'google', ?, ?, ?)
  `).run(crypto.randomUUID(), `joocon-playground-${crypto.randomUUID()}`, authUserId, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_sessions (
      id, token, user_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), rawToken, authUserId, now + 30 * 24 * 60 * 60 * 1000, now, now);

  const secret = config.authSecrets[0]?.value;
  if (!secret) fail('auth_secret_missing', input.email);
  const signature = await makeSignature(rawToken, secret);
  const cookie = `${sessionCookieName(config)}=${rawToken}.${signature}`;
  const provisioned = await runtime.app.request('/api/me/access-context', {
    headers: { cookie, 'x-correlation-id': crypto.randomUUID() }
  });
  if (provisioned.status !== 200) {
    fail('principal_provisioning_failed', { email: input.email, status: provisioned.status });
  }
  // The route answers 200 for an unrecognized cookie (`anonymous`) and for a
  // refused admission (`blocked`) alike, so the served context — not the status
  // — is the evidence that this principal was admitted into THIS workspace.
  // `active` is also the proof its own reservation consumed, whatever
  // `JOOEVENTS_ADMISSION_MODE` is and whichever address the bootstrap owner uses.
  const context = accessContextSchema.parse(await provisioned.json());
  if (context.state !== 'active' || context.workspace.id !== runtime.workspaceId) {
    fail('principal_not_admitted', {
      email: input.email,
      cookieName: sessionCookieName(config),
      baseUrl: config.baseUrl,
      admissionMode: config.admissionMode,
      served: context
    });
  }
  const link = runtime.database.sqlite.query<{
    readonly user_id: string;
    readonly provisioning_state: string;
  }, [string]>(`
    SELECT user_id, provisioning_state FROM auth_user_links WHERE auth_user_id = ?
  `).get(authUserId);
  if (!link || link.provisioning_state !== 'ready') {
    fail('principal_link_missing', { email: input.email, link: link ?? null });
  }
  return Object.freeze({ authUserId, userId: link.user_id, cookie });
}

async function readVocabulary(context: SeedContext) {
  return requireSuccess(programVocabularySnapshotReadResultSchema.parse(await read(
    context, '/api/events/current/program-vocabulary', (value) => value
  )), 'vocabulary_read').data;
}

async function readFieldRegistry(context: SeedContext) {
  return requireSuccess(fieldRegistrySnapshotReadResultSchema.parse(await read(
    context, '/api/events/current/field-registry', (value) => value
  )), 'field_registry_read').data;
}

async function readFormCatalog(context: SeedContext) {
  return requireSuccess(organizerFormCatalogReadResultSchema.parse(await read(
    context, '/api/events/current/forms', (value) => value
  )), 'form_catalog_read').data;
}

async function readFormDetail(context: SeedContext, formId: string) {
  return requireSuccess(organizerFormDetailReadResultSchema.parse(await read(
    context, `/api/events/current/forms/detail?formId=${encodeURIComponent(formId)}`, (value) => value
  )), 'form_detail_read').data;
}

async function readSessionCatalog(context: SeedContext) {
  return requireSuccess(sessionCatalogReadResultSchema.parse(await read(
    context, '/api/events/current/sessions', (value) => value
  )), 'session_catalog_read').data;
}

async function readEngagements(context: SeedContext) {
  return requireSuccess(engagementSnapshotReadResultSchema.parse(await read(
    context, '/api/events/current/engagements', (value) => value
  )), 'engagement_read').data;
}

async function readReviewSnapshot(context: SeedContext) {
  return requireSuccess(reviewSnapshotReadResultSchema.parse(await read(
    context, '/api/events/current/review/snapshot', (value) => value
  )), 'review_snapshot_read').data;
}

async function readWorkspaceTeam(context: SeedContext) {
  return requireSuccess(workspaceTeamMembersReadResultSchema.parse(await read(
    context, '/api/workspace/team', (value) => value
  )), 'workspace_team_read').data;
}

async function readSchedule(context: SeedContext) {
  const range = new URLSearchParams({
    startAt: '2027-09-14T00:00:00.000Z',
    endAt: '2027-09-18T00:00:00.000Z',
    limit: '200'
  });
  return requireSuccess(schedulePlacementSnapshotReadResultSchema.parse(await read(
    context, `/api/events/current/schedule/placements?${range.toString()}`, (value) => value
  )), 'schedule_read').data;
}

async function createEvent(context: SeedContext): Promise<string> {
  const created = requireSuccess(eventCreateOperationResultSchema.parse(await effect({
    context,
    path: '/api/events',
    key: 'joocon-event-create',
    body: { expectedEventSetVersion: 1, ...EVENT },
    parse: (value) => value
  })), 'event_create');
  return created.data.event.id;
}

/**
 * Keeps every geometry value exactly as the creation defaults served it and
 * writes only the location and venue note the organizer would type.
 */
async function updateEventSettings(context: SeedContext): Promise<void> {
  const served = requireSuccess(currentEventSettingsReadResultSchema.parse(await read(
    context, '/api/events/current/settings', (value) => value
  )), 'event_settings_read').data;
  requireSuccess(eventSettingsUpdateOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/settings',
    key: 'joocon-event-settings-update',
    body: {
      expectedEventId: served.eventId,
      expectedEventSetVersion: served.eventSetVersion,
      expectedEventVersion: served.eventVersion,
      name: served.name,
      timezone: served.timezone,
      startDate: served.startDate,
      endDate: served.endDate,
      dayStart: served.dayStart,
      dayEnd: served.dayEnd,
      slotMinutes: served.slotMinutes,
      ...EVENT_SETTINGS_TEXT
    },
    parse: (value) => value
  })), 'event_settings_update');
}

async function createVocabulary(
  context: SeedContext
): Promise<Readonly<Record<VocabularyKey, string>>> {
  const handles: Record<string, string> = Object.create(null);
  const specs = [
    ...ROOMS.map((room) => ({ kind: 'room' as const, ...room })),
    ...TRACKS.map((track) => ({ kind: 'track' as const, ...track })),
    ...FORMATS.map((format) => ({ kind: 'format' as const, ...format }))
  ];
  for (const spec of specs) {
    const snapshot = await readVocabulary(context);
    const body = spec.kind === 'room'
      ? {
          kind: spec.kind,
          expectedSetVersion: snapshot.setVersion,
          name: spec.name,
          capacity: spec.capacity
        }
      : { kind: spec.kind, expectedSetVersion: snapshot.setVersion, name: spec.name };
    const mutation = requireSuccess(programVocabularyDirectOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/program-vocabulary/create',
      key: `joocon-vocabulary-${spec.key}-create`,
      body,
      parse: (value) => value
    })), `vocabulary_${spec.key}_create`);
    if (mutation.data.action !== 'create') fail(`vocabulary_${spec.key}_action`, mutation.data.action);
    const createdId = mutation.data.affectedIds[0];
    if (!createdId) fail(`vocabulary_${spec.key}_created_id`, null);
    handles[spec.key] = createdId;
  }
  return Object.freeze(handles) as Readonly<Record<VocabularyKey, string>>;
}

interface CfpFields {
  readonly nameFieldId: string;
  readonly emailFieldId: string;
  readonly titleFieldId: string;
  readonly abstractFieldId: string;
  readonly liveDemoFieldId: string;
  readonly demoPlanFieldId: string;
  readonly excludedFieldIds: readonly string[];
}

async function createConditionalCfpFields(context: SeedContext): Promise<{
  readonly liveDemoFieldId: string;
  readonly demoPlanFieldId: string;
}> {
  const specs = [
    {
      key: 'live-demo',
      field: {
        kind: 'checkbox' as const,
        label: 'Will your session include a live demo?',
        help: 'Choose this when attendees will see or try a working system.',
        answerOwner: 'talk' as const,
        scope: { kind: 'shared' as const },
        contexts: {
          apply: { visible: true, required: false },
          onboard: { visible: false, required: false },
          profile: { visible: false, required: false }
        },
        options: { kind: 'none' as const }
      }
    },
    {
      key: 'demo-plan',
      field: {
        kind: 'textarea' as const,
        label: 'What should attendees be able to try?',
        help: 'Describe the working path and any setup the room needs.',
        answerOwner: 'talk' as const,
        scope: { kind: 'shared' as const },
        contexts: {
          apply: { visible: true, required: false },
          onboard: { visible: false, required: false },
          profile: { visible: false, required: false }
        },
        options: { kind: 'none' as const }
      }
    }
  ] as const;
  const ids: string[] = [];
  for (const spec of specs) {
    const registry = await readFieldRegistry(context);
    const added = requireSuccess(fieldRegistryDirectOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/field-registry/add',
      key: `joocon-field-${spec.key}-add`,
      body: { expectedRegistryVersion: registry.version, field: spec.field },
      parse: (value) => value
    })), `field_${spec.key}_add`);
    ids.push(added.data.mutation.fieldId);
  }
  const [liveDemoFieldId, demoPlanFieldId] = ids;
  if (!liveDemoFieldId || !demoPlanFieldId) fail('conditional_field_ids_missing', ids);
  return Object.freeze({ liveDemoFieldId, demoPlanFieldId });
}

/**
 * Resolves the four registry fields every seeded application answers and the
 * exact shared apply-visible field ids the CFP composition excludes, so each
 * committed direct entry answers exactly the form it was authored against.
 */
async function resolveCfpFields(
  context: SeedContext,
  conditional: { readonly liveDemoFieldId: string; readonly demoPlanFieldId: string }
): Promise<CfpFields> {
  const registry = await readFieldRegistry(context);
  const fieldId = (mapsTo: string, kind: string): string => {
    const field = registry.fields.find(
      (candidate) => candidate.mapsTo === mapsTo && candidate.kind === kind
    );
    if (!field) fail('registry_field_missing', mapsTo);
    return field.id;
  };
  const nameFieldId = fieldId('person.name', 'text');
  const emailFieldId = fieldId('person.email', 'email');
  const titleFieldId = fieldId('talk.title', 'text');
  const abstractFieldId = fieldId('talk.abstract', 'textarea');
  const included = new Set([
    nameFieldId, emailFieldId, titleFieldId, abstractFieldId,
    conditional.liveDemoFieldId, conditional.demoPlanFieldId
  ]);
  return Object.freeze({
    nameFieldId,
    emailFieldId,
    titleFieldId,
    abstractFieldId,
    ...conditional,
    excludedFieldIds: Object.freeze(registry.fields
      .filter((field) => field.scope.kind === 'shared'
        && field.contexts.apply.visible
        && !included.has(field.id))
      .map((field) => field.id)
      .sort())
  });
}

function cfpDefinition(input: {
  readonly name: string;
  readonly target: FormTarget;
  readonly confirmation: string;
  readonly fields: CfpFields;
  readonly conditionalDemo?: boolean;
}): FormDefinitionCreateAuthorInput {
  const conditionalDemo = input.conditionalDemo === true;
  return {
    kind: 'cfp',
    name: input.name,
    target: input.target,
    availability: { kind: 'evergreen' },
    confirmation: input.confirmation,
    composition: {
      excludedFieldIds: [
        ...input.fields.excludedFieldIds,
        ...(conditionalDemo ? [] : [input.fields.liveDemoFieldId, input.fields.demoPlanFieldId])
      ].sort(),
      requiredOverrides: {},
      optionExposure: {}
    },
    rules: conditionalDemo ? [
      {
        key: 'show-demo-plan',
        condition: {
          kind: 'checked_is', sourceFieldId: input.fields.liveDemoFieldId, value: true
        },
        effect: { kind: 'show', targetFieldIds: [input.fields.demoPlanFieldId] }
      },
      {
        key: 'require-demo-plan',
        condition: {
          kind: 'checked_is', sourceFieldId: input.fields.liveDemoFieldId, value: true
        },
        effect: { kind: 'require', targetFieldIds: [input.fields.demoPlanFieldId] }
      }
    ] : []
  };
}

async function createOpenForm(input: {
  readonly context: SeedContext;
  readonly key: string;
  readonly definition: FormDefinitionCreateAuthorInput;
}): Promise<string> {
  const { context, key } = input;
  const catalog = await readFormCatalog(context);
  const created = requireSuccess(intakeFormDirectOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/forms/create',
    key: `joocon-form-${key}-create`,
    body: {
      expectedCatalogVersion: catalog.catalogVersion,
      expectedRegistryVersion: catalog.registryPin.version,
      definition: input.definition
    },
    parse: (value) => value
  })), `form_${key}_create`);
  if (created.data.action !== 'create') fail(`form_${key}_create_action`, created.data.action);
  const formId = created.data.formId;

  const detail = await readFormDetail(context, formId);
  const review = requireSuccess(intakeFormVersionReviewDraftOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/forms/publish/draft',
    key: `joocon-form-${key}-publish-review`,
    body: {
      action: 'publish_and_open',
      formId,
      expectedDefinitionVersion: detail.head.version,
      expectedRegistryVersion: detail.registryPin.version
    },
    parse: (value) => value
  })), `form_${key}_publish_review`);
  requireSuccess(intakeFormVersionPublishOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/forms/publish',
    key: `joocon-form-${key}-publish`,
    body: {
      draftId: review.data.draftId,
      revisionId: review.data.revision.id,
      revisionDigestSha256: review.data.revision.digestSha256
    },
    parse: (value) => value
  })), `form_${key}_publish`);
  return formId;
}

async function createDirectEntries(input: {
  readonly context: SeedContext;
  readonly formId: string;
  readonly fields: CfpFields;
  readonly specs: readonly SubmissionSpec[];
  readonly daysBeforeAnchor: readonly number[];
}): Promise<ReadonlyMap<string, string>> {
  const { context, fields } = input;
  if (input.daysBeforeAnchor.length !== input.specs.length) {
    fail('entry_timeline_length', {
      entries: input.specs.length,
      instants: input.daysBeforeAnchor.length
    });
  }
  const catalog = await readFormCatalog(context);
  const form = catalog.forms.find((candidate) => candidate.id === input.formId);
  if (!form) fail('open_form_missing', input.formId);
  const submissionIds = new Map<string, string>();
  for (const [index, spec] of input.specs.entries()) {
    const daysBeforeAnchor = input.daysBeforeAnchor[index];
    if (daysBeforeAnchor === undefined) fail('entry_timeline_missing', spec.key);
    context.clock.moveToDaysBeforeAnchor(daysBeforeAnchor);
    const result = requireSuccess(submissionDirectEntryOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/submissions/direct-entry',
      key: `joocon-entry-${spec.key}`,
      body: {
        formId: form.id,
        expectedFormDefinitionVersion: form.version,
        answers: [
          { kind: 'text', fieldId: fields.nameFieldId, value: spec.name },
          { kind: 'email', fieldId: fields.emailFieldId, value: spec.email },
          { kind: 'text', fieldId: fields.titleFieldId, value: spec.title },
          { kind: 'textarea', fieldId: fields.abstractFieldId, value: spec.abstract }
        ]
      },
      parse: (value) => value
    })), `entry_${spec.key}`);
    submissionIds.set(spec.key, result.data.submissionId);
  }
  return submissionIds;
}

/**
 * Widens an admission-time `viewer` principal to the `speaker_reviewer` preset
 * through the registered Workspace Team role-change operation.
 */
async function grantReviewerRole(context: SeedContext, reviewerUserId: string): Promise<void> {
  const team = await readWorkspaceTeam(context);
  const member = team.members.find(
    (candidate) => candidate.kind === 'member' && candidate.userId === reviewerUserId
  );
  if (!member || member.kind !== 'member') fail('reviewer_member_missing', reviewerUserId);
  requireSuccess(workspaceTeamMutationOperationResultSchema.parse(await effect({
    context,
    path: '/api/workspace/team/role-changes',
    key: 'joocon-reviewer-role-change',
    body: {
      subject: { kind: 'member', membershipId: member.id, version: member.version },
      roleKey: 'speaker_reviewer',
      expectedTeamVersion: team.version,
      expectedTeamDigestSha256: team.digestSha256
    },
    parse: (value) => value
  })), 'reviewer_role_change');
}

async function registerReviewer(input: {
  readonly context: SeedContext;
  readonly key: string;
  readonly userId: string;
}): Promise<string> {
  const { context } = input;
  const team = await readWorkspaceTeam(context);
  const member = team.members.find(
    (candidate) => candidate.kind === 'member' && candidate.userId === input.userId
  );
  if (!member || member.kind !== 'member') fail('roster_member_missing', input.userId);
  const roster = requireSuccess(reviewerRosterSnapshotReadResultSchema.parse(await read(
    context, '/api/events/current/reviewer-roster', (value) => value
  )), 'reviewer_roster_read').data;
  const reviewerId = crypto.randomUUID();
  const mutation = requireSuccess(reviewerRosterDirectOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/reviewer-roster/changes',
    key: `joocon-roster-${input.key}-register`,
    body: {
      action: 'register',
      reviewerId,
      accessSubject: {
        kind: 'workspace_membership',
        id: member.id,
        version: member.version
      },
      reviews: [],
      expectedRosterVersion: roster.rosterVersion,
      expectedRosterDigestSha256: roster.rosterDigestSha256
    },
    parse: (value) => value
  })), `roster_${input.key}_register`);
  if (mutation.data.action !== 'register') fail(`roster_${input.key}_action`, mutation.data.action);
  return reviewerId;
}

async function openReviewRound(context: SeedContext): Promise<number> {
  const mutation = requireSuccess(reviewDirectOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/review/rounds',
    key: 'joocon-review-open-round',
    body: { action: 'open_round', deadlineDate: REVIEW_DUE_DATE, anonymized: true },
    parse: (value) => value
  })), 'review_open_round');
  if (mutation.data.action !== 'open_round') fail('review_open_round_action', mutation.data.action);
  return mutation.data.assignmentCount;
}

/**
 * Saves and commits evaluations from one rostered reviewer's own queue. Each
 * pass re-reads the served snapshot so every guard (assignment version, draft
 * version, round criteria) comes from current truth rather than a stale plan.
 */
async function commitEvaluations(input: {
  readonly context: SeedContext;
  readonly key: string;
  readonly daysBeforeAnchor: readonly number[];
  readonly offset: number;
}): Promise<number> {
  const { context } = input;
  let committed = 0;
  for (const [index, daysBeforeAnchor] of input.daysBeforeAnchor.entries()) {
    context.clock.moveToDaysBeforeAnchor(daysBeforeAnchor);
    const snapshot = await readReviewSnapshot(context);
    if (snapshot.viewer.kind !== 'reviewer') fail('reviewer_viewer_missing', snapshot.viewer.kind);
    const item = (snapshot.queue ?? []).find((candidate) => !candidate.committed);
    if (!item) break;
    const plan = snapshot.plans.find((candidate) => candidate.id === item.roundId);
    const criterion = plan?.criteria[0];
    if (!criterion) fail('review_round_criterion_missing', item.roundId);
    const evaluation = EVALUATIONS[(input.offset + index) % EVALUATIONS.length];
    if (!evaluation) fail('review_evaluation_spec_missing', index);

    const saved = requireSuccess(reviewDraftSaveOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/review/evaluation-draft',
      key: `joocon-review-${input.key}-${index}-save`,
      body: {
        assignmentId: item.assignmentId,
        expectedDraftVersion: item.draft?.version ?? null,
        scores: [{ criterionId: criterion.id, score: evaluation.score }],
        comment: evaluation.comment
      },
      parse: (value) => value
    })), `review_${input.key}_${index}_save`);

    const mutation = requireSuccess(reviewDirectOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/review/evaluations',
      key: `joocon-review-${input.key}-${index}-commit`,
      body: {
        action: 'commit_review',
        assignmentId: item.assignmentId,
        expectedAssignmentVersion: item.assignmentVersion,
        expectedDraftVersion: saved.data.draft.version
      },
      parse: (value) => value
    })), `review_${input.key}_${index}_commit`);
    if (mutation.data.action !== 'commit_review') {
      fail(`review_${input.key}_${index}_action`, mutation.data.action);
    }
    committed += 1;
  }
  return committed;
}

interface DecisionPlan {
  readonly key: string;
  readonly submissionId: string;
  readonly state: 'accepted' | 'waitlisted' | 'declined';
  readonly spawn: boolean;
  readonly trackId?: string;
}

async function commitDecisions(
  context: SeedContext,
  plans: readonly DecisionPlan[],
  daysBeforeAnchor: readonly number[]
): Promise<void> {
  if (daysBeforeAnchor.length !== plans.length) {
    fail('decision_timeline_length', { decisions: plans.length, instants: daysBeforeAnchor.length });
  }
  for (const [index, plan] of plans.entries()) {
    const days = daysBeforeAnchor[index];
    if (days === undefined) fail('decision_timeline_missing', plan.key);
    context.clock.moveToDaysBeforeAnchor(days);
    requireSuccess(decisionDecideOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/decisions',
      key: `joocon-decision-${plan.key}`,
      body: {
        action: 'decide',
        decisions: [{
          submissionId: plan.submissionId,
          state: plan.state,
          expectedDecisionVersion: null,
          expectedDecisionDigestSha256: null,
          ...(plan.spawn
            ? { graduation: { kind: 'spawn', ...(plan.trackId ? { trackId: plan.trackId } : {}) } }
            : {})
        }]
      },
      parse: (value) => value
    })), `decision_${plan.key}`);
  }
}

async function placeSessions(input: {
  readonly context: SeedContext;
  readonly sessionIdByTitle: ReadonlyMap<string, string>;
  readonly vocabulary: Readonly<Record<VocabularyKey, string>>;
  readonly titleBySubmissionKey: ReadonlyMap<string, string>;
}): Promise<number> {
  const { context } = input;
  let placed = 0;
  for (const placement of PLACEMENTS) {
    const title = input.titleBySubmissionKey.get(placement.submissionKey);
    const sessionId = title === undefined ? undefined : input.sessionIdByTitle.get(title);
    if (!sessionId) fail('placement_session_missing', placement.submissionKey);
    const schedule = await readSchedule(context);
    requireSuccess(schedulePlacementOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/schedule/placements',
      key: `joocon-placement-${placement.submissionKey}`,
      body: {
        action: 'place',
        expectedScheduleVersion: schedule.scheduleVersion,
        sessionId,
        roomId: input.vocabulary[placement.roomKey],
        startAt: placement.startAt,
        endAt: placement.endAt
      },
      parse: (value) => value
    })), `placement_${placement.submissionKey}`);
    placed += 1;
  }
  return placed;
}

async function addCanonicalSessionDescription(input: {
  readonly context: SeedContext;
  readonly sessionId: string;
}): Promise<void> {
  const catalog = await readSessionCatalog(input.context);
  const session = catalog.sessions.find((candidate) => candidate.id === input.sessionId);
  if (!session) fail('description_session_missing', input.sessionId);
  const updated = requireSuccess(sessionDirectOperationResultSchema.parse(await effect({
    context: input.context,
    path: '/api/events/current/sessions',
    key: 'joocon-session-agents-description',
    body: {
      action: 'content_update',
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      sessionId: session.id,
      expectedSessionVersion: session.version,
      expectedSessionDigestSha256: session.digestSha256,
      description: CANONICAL_SESSION_DESCRIPTION
    },
    parse: (value) => value
  })), 'session_description');
  if (updated.data.action !== 'content_update') {
    fail('session_description_action', updated.data.action);
  }
}

async function createSessionFileLinks(input: {
  readonly context: SeedContext;
  readonly sessionIdByTitle: ReadonlyMap<string, string>;
}): Promise<number> {
  let created = 0;
  for (const [index, file] of SESSION_FILE_LINKS.entries()) {
    const sessionId = input.sessionIdByTitle.get(file.title);
    if (!sessionId) fail('file_session_missing', file.title);
    const result = requireSuccess(fileLinkAttachOperationResultSchema.parse(await effect({
      context: input.context,
      path: '/api/events/current/files/attachments/link',
      key: `joocon-session-file-${index + 1}`,
      body: {
        attachmentId: crypto.randomUUID(),
        subject: { kind: 'session', sessionId },
        link: { provider: 'url', label: file.label, url: file.url }
      },
      parse: (value) => value
    })), `session_file_${index + 1}`);
    if (result.data.action !== 'attachment.link') {
      fail(`session_file_${index + 1}_action`, result.data.action);
    }
    created += 1;
  }
  return created;
}

async function confirmEngagements(input: {
  readonly context: SeedContext;
  readonly submissionIdByKey: ReadonlyMap<string, string>;
}): Promise<number> {
  const { context } = input;
  let confirmed = 0;
  for (const key of CONFIRMED_SUBMISSION_KEYS) {
    const submissionId = input.submissionIdByKey.get(key);
    if (!submissionId) fail('confirmation_submission_missing', key);
    const engagements = await readEngagements(context);
    const engagement = engagements.engagements.find(
      (candidate) => candidate.submissionId === submissionId
    );
    if (!engagement) fail('confirmation_engagement_missing', key);
    if (engagement.state === 'confirmed') continue;
    requireSuccess(engagementChangeOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/engagements',
      key: `joocon-confirm-${key}`,
      body: {
        action: 'record_confirmation',
        engagementId: engagement.id,
        expectedEngagementVersion: engagement.version,
        attribution: 'organizer_recorded'
      },
      parse: (value) => value
    })), `confirm_${key}`);
    confirmed += 1;
  }
  return confirmed;
}

async function createSpeakerTasks(context: SeedContext): Promise<number> {
  for (const task of SPEAKER_TASKS) {
    requireSuccess(taskMutationOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/tasks',
      key: `joocon-task-${task.key}`,
      body: {
        action: 'create_definition',
        name: task.name,
        description: task.description,
        completionMode: task.completionMode,
        required: task.required,
        dueOn: task.dueOn
      },
      parse: (value) => value
    })), `task_${task.key}`);
  }
  return SPEAKER_TASKS.length;
}

async function publishSchedule(context: SeedContext): Promise<number> {
  const draft = requireSuccess(releaseReviewDraftOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/releases/drafts',
    key: 'joocon-publish-schedule-draft',
    body: { action: 'publish_schedule', expectedCurrentReleaseNumber: null },
    parse: (value) => value
  })), 'publish_schedule_draft');
  const diff = draft.data.safeDiff;
  if (diff.action !== 'publish_schedule') fail('publish_schedule_diff', diff.action);
  await publishRelease(context, 'joocon-publish-schedule', draft);
  return diff.after.number;
}

async function publishSurface(input: {
  readonly context: SeedContext;
  readonly key: 'schedule' | 'speakers' | 'apply';
  readonly sourceTemplateRevision: {
    readonly artifactId: string;
    readonly revisionId: string;
    readonly revisionNumber: number;
    readonly digestSha256: string;
  };
  readonly manifest: {
    readonly schemaVersion: 1;
    readonly heading: string | null;
    readonly intro: string | null;
  };
  readonly styleSetReleaseId: string;
  readonly formRef: null | { readonly formId: string; readonly formVersionId: string };
}): Promise<void> {
  const draft = requireSuccess(releaseReviewDraftOperationResultSchema.parse(await effect({
    context: input.context,
    path: '/api/events/current/releases/drafts',
    key: `joocon-release-surface-${input.key}-draft`,
    body: {
      action: 'surface_publish',
      kind: input.key,
      sourceTemplateRevision: input.sourceTemplateRevision,
      manifest: input.manifest,
      styleSetReleaseId: input.styleSetReleaseId,
      formRef: input.formRef,
      expectedSurfaceHeadVersion: null
    },
    parse: (value) => value
  })), `release_surface_${input.key}_draft`);
  if (draft.data.safeDiff.action !== 'surface_publish') {
    fail(`release_surface_${input.key}_diff`, draft.data.safeDiff.action);
  }
  await publishRelease(input.context, `joocon-release-surface-${input.key}`, draft);
}

/** Publishes the three stable public presentations through the Release lane. */
async function publishPublicPresentations(input: {
  readonly context: SeedContext;
  readonly applyFormId: string;
}): Promise<void> {
  const artifacts = requireSuccess(templateArtifactListOperationResultSchema.parse(await read(
    input.context,
    '/api/events/current/template-artifacts',
    (value) => value
  )), 'release_template_artifacts_read').data.artifacts;
  const theme = artifacts.find((artifact) => artifact.current.document.kind === 'theme');
  if (!theme || theme.current.document.kind !== 'theme') {
    fail('release_theme_template_missing', null);
  }
  const pin = (artifact: typeof theme) => ({
    artifactId: artifact.head.artifactId,
    revisionId: artifact.current.revisionId,
    revisionNumber: artifact.current.number,
    digestSha256: artifact.current.digestSha256
  });
  const surface = (kind: 'schedule' | 'speaker-roster' | 'application-form') => {
    const artifact = artifacts.find((candidate) =>
      candidate.current.document.kind === 'surface'
        && candidate.current.document.surfaceKind === kind
    );
    if (!artifact || artifact.current.document.kind !== 'surface') {
      fail('release_surface_template_missing', kind);
    }
    const hero = artifact.current.document.blocks.find((block) => block.type === 'hero');
    const normalize = (value: string) => {
      const text = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
      return text.length === 0 ? null : text;
    };
    return Object.freeze({
      pin: pin(artifact as typeof theme),
      manifest: Object.freeze({
        schemaVersion: 1 as const,
        heading: hero ? normalize(hero.title) : null,
        intro: hero ? normalize(hero.intro) : null
      })
    });
  };

  const style = requireSuccess(releaseReviewDraftOperationResultSchema.parse(await effect({
    context: input.context,
    path: '/api/events/current/releases/drafts',
    key: 'joocon-release-style-draft',
    body: {
      action: 'style_set_publish',
      sourceTemplateRevision: pin(theme),
      recipe: theme.current.document.recipe,
      expectedCurrentStyleSetNumber: null
    },
    parse: (value) => value
  })), 'release_style_draft');
  if (style.data.safeDiff.action !== 'style_set_publish') {
    fail('release_style_diff', style.data.safeDiff.action);
  }
  await publishRelease(input.context, 'joocon-release-style', style);
  const styleSetReleaseId = style.data.safeDiff.after.releaseId;

  const schedule = surface('schedule');
  const speakers = surface('speaker-roster');
  const apply = surface('application-form');
  await publishSurface({
    context: input.context,
    key: 'schedule',
    sourceTemplateRevision: schedule.pin,
    manifest: schedule.manifest,
    styleSetReleaseId,
    formRef: null
  });
  await publishSurface({
    context: input.context,
    key: 'speakers',
    sourceTemplateRevision: speakers.pin,
    manifest: speakers.manifest,
    styleSetReleaseId,
    formRef: null
  });
  const form = await readFormDetail(input.context, input.applyFormId);
  if (form.currentPublishedVersion === null) {
    fail('release_apply_form_version_missing', input.applyFormId);
  }
  await publishSurface({
    context: input.context,
    key: 'apply',
    sourceTemplateRevision: apply.pin,
    manifest: apply.manifest,
    styleSetReleaseId,
    formRef: {
      formId: input.applyFormId,
      formVersionId: form.currentPublishedVersion.id
    }
  });
}

/**
 * Fills a freshly booted ephemeral live runtime with one believable fictional
 * conference. Everything past the two admission seams is written through the
 * same registered operations the web UI and MCP agents call — draft, propose,
 * commit — so the seeded database is reachable state, never fabricated rows.
 */
export async function seedJooConPlayground(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly config: ServerConfig;
  /** Controller retained only by this fixture assembler; never exposed by the runtime. */
  readonly clock: DevFixtureClock;
  /**
   * Points one seeded speaker (Nadia Okonkwo) at a mailbox the operator owns,
   * so the participant portal's magic-link flow can be exercised end to end.
   * The committed roster stays fictional; a real address arrives only through
   * the ignored deployment environment.
   */
  readonly speakerEmailOverride?: string;
}): Promise<PlaygroundSeedSummary> {
  const { runtime, config } = input;
  // The seeded principals must never share the bootstrap owner's address:
  // that is what keeps the owner reservation unconsumed and the human's later
  // Google sign-in admissible into this same workspace.
  const bootstrapOwner = normalizeEmail(config.bootstrapOwnerEmail);
  if (bootstrapOwner === normalizeEmail(OPERATOR_EMAIL)
      || bootstrapOwner === normalizeEmail(REVIEWER_EMAIL)) {
    fail('bootstrap_owner_email_collides_with_seeded_principal', bootstrapOwner);
  }
  try {
    input.clock.moveToDaysBeforeAnchor(SEED_TIMELINE.setupDaysBeforeAnchor);
    const operator = await createSeededPrincipal({
      runtime,
      config,
      email: OPERATOR_EMAIL,
      displayName: 'Maya Chen',
      rolePresetKey: 'workspace_admin',
      permissionGrants: OPERATOR_PERMISSION_GRANTS
    });
    const reviewer = await createSeededPrincipal({
      runtime,
      config,
      email: REVIEWER_EMAIL,
      displayName: 'Leonie Weber',
      rolePresetKey: 'viewer'
    });
    const context: SeedContext = Object.freeze({
      runtime, config, cookie: operator.cookie, clock: input.clock
    });
    const reviewerContext: SeedContext = Object.freeze({
      runtime, config, cookie: reviewer.cookie, clock: input.clock
    });

    const eventId = await createEvent(context);
    await updateEventSettings(context);
    const vocabulary = await createVocabulary(context);

    const conditionalFields = await createConditionalCfpFields(context);
    const fields = await resolveCfpFields(context, conditionalFields);
    const generalFormId = await createOpenForm({
      context,
      key: 'general',
      definition: cfpDefinition({
        name: 'JooCon 2027 Call for Sessions',
        target: { kind: 'general_pool' },
        confirmation: 'Thanks — your proposal is in. The program team reviews everything in one batch after the deadline.',
        fields,
        conditionalDemo: true
      })
    });
    const featuredFormId = await createOpenForm({
      context,
      key: 'featured',
      definition: cfpDefinition({
        name: 'JooCon 2027 Featured Talks',
        target: {
          kind: 'category',
          category: { kind: 'format', id: vocabulary.talk }
        },
        confirmation: 'Received. Featured talk proposals get a first read within two weeks.',
        fields
      })
    });

    const speakerEmail = input.speakerEmailOverride?.trim();
    let featuredSpecs = FEATURED_SUBMISSIONS;
    if (speakerEmail) {
      if (!speakerEmail.includes('@')) fail('speaker_email_override_invalid', 'not_an_address');
      const normalized = normalizeEmail(speakerEmail);
      if (normalized === normalizeEmail(OPERATOR_EMAIL)
          || normalized === normalizeEmail(REVIEWER_EMAIL)) {
        fail('speaker_email_override_collides_with_seeded_principal', 'operator_or_reviewer');
      }
      featuredSpecs = FEATURED_SUBMISSIONS.map((spec) =>
        spec.key === 'okonkwo' ? Object.freeze({ ...spec, email: speakerEmail }) : spec
      );
    }
    const featuredIds = await createDirectEntries({
      context,
      formId: featuredFormId,
      fields,
      specs: featuredSpecs,
      daysBeforeAnchor: SEED_TIMELINE.arrivalDaysBeforeAnchor.slice(0, featuredSpecs.length)
    });
    const generalIds = await createDirectEntries({
      context,
      formId: generalFormId,
      fields,
      specs: GENERAL_SUBMISSIONS,
      daysBeforeAnchor: SEED_TIMELINE.arrivalDaysBeforeAnchor.slice(featuredSpecs.length)
    });
    const submissionIdByKey = new Map([...featuredIds, ...generalIds]);

    const openForms = (await readFormCatalog(context))
      .forms.filter((form) => form.status === 'open').length;

    await registerReviewer({ context, key: 'operator', userId: operator.userId });
    await grantReviewerRole(context, reviewer.userId);
    await registerReviewer({ context, key: 'reviewer', userId: reviewer.userId });

    input.clock.moveToDaysBeforeAnchor(SEED_TIMELINE.reviewRoundDaysBeforeAnchor);
    const reviewAssignments = await openReviewRound(context);
    const operatorReviews = await commitEvaluations({
      context,
      key: 'operator',
      daysBeforeAnchor: SEED_TIMELINE.reviewDaysBeforeAnchor.slice(0, 3),
      offset: 0
    });
    const reviewerReviews = await commitEvaluations({
      context: reviewerContext,
      key: 'reviewer',
      daysBeforeAnchor: SEED_TIMELINE.reviewDaysBeforeAnchor.slice(3),
      offset: 3
    });

    const decisions: DecisionPlan[] = [];
    for (const spec of FEATURED_SUBMISSIONS) {
      const submissionId = submissionIdByKey.get(spec.key);
      if (!submissionId) fail('decision_submission_missing', spec.key);
      if (!spec.trackKey) fail('decision_track_missing', spec.key);
      decisions.push({
        key: spec.key,
        submissionId,
        state: 'accepted',
        spawn: true,
        trackId: vocabulary[spec.trackKey]
      });
    }
    const waitlisted = submissionIdByKey.get('delacroix');
    const declined = submissionIdByKey.get('tanabe');
    if (!waitlisted || !declined) fail('decision_general_submission_missing', 'delacroix/tanabe');
    decisions.push({ key: 'delacroix', submissionId: waitlisted, state: 'waitlisted', spawn: false });
    decisions.push({ key: 'tanabe', submissionId: declined, state: 'declined', spawn: false });
    await commitDecisions(context, decisions, SEED_TIMELINE.decisionDaysBeforeAnchor);

    // The fixture chronology is complete. All subsequent startup and request
    // work uses wall-clock time, just like an ordinary runtime.
    input.clock.useSystemTime();

    const catalog = await readSessionCatalog(context);
    const sessionIdByTitle = new Map(catalog.sessions.map((session) => [session.title, session.id]));
    const titleBySubmissionKey = new Map(
      FEATURED_SUBMISSIONS.map((spec) => [spec.key, spec.title] as const)
    );
    const placements = await placeSessions({
      context, sessionIdByTitle, vocabulary, titleBySubmissionKey
    });
    const describedSessionId = sessionIdByTitle.get('Agents That Ask Before They Act');
    if (!describedSessionId) fail('described_session_missing', null);
    await addCanonicalSessionDescription({ context, sessionId: describedSessionId });
    const sessionFiles = await createSessionFileLinks({ context, sessionIdByTitle });
    const confirmedEngagements = await confirmEngagements({ context, submissionIdByKey });
    const taskDefinitions = await createSpeakerTasks(context);
    const releaseNumber = await publishSchedule(context);
    await publishPublicPresentations({ context, applyFormId: generalFormId });

    const bootstrapReservation = runtime.database.sqlite.query<
      { readonly status: string }, [string, string]
    >(`
      SELECT status FROM access_reservations
       WHERE workspace_id = ? AND normalized_email = ?
    `).get(runtime.workspaceId, normalizeEmail(config.bootstrapOwnerEmail));

    return Object.freeze({
      eventId,
      eventName: EVENT.name,
      operatorEmail: OPERATOR_EMAIL,
      reviewerEmail: REVIEWER_EMAIL,
      bootstrapOwnerEmail: config.bootstrapOwnerEmail,
      bootstrapOwnerReservationOpen: bootstrapReservation?.status === 'open',
      vocabulary: Object.freeze({
        rooms: ROOMS.length, tracks: TRACKS.length, formats: FORMATS.length
      }),
      openForms,
      submissions: submissionIdByKey.size,
      reviewers: 2,
      reviewAssignments,
      committedReviews: operatorReviews + reviewerReviews,
      accepted: FEATURED_SUBMISSIONS.length,
      waitlisted: 1,
      declined: 1,
      spawnedSessions: catalog.sessions.length,
      placements,
      confirmedEngagements,
      taskDefinitions,
      conditionalRules: 2,
      sessionFiles,
      releaseNumber,
      applyFormId: generalFormId
    });
  } finally {
    // Failed seeds also relinquish the process-local fixture clock before the
    // caller closes the runtime, preventing stale time from escaping assembly.
    input.clock.useSystemTime();
  }
}
