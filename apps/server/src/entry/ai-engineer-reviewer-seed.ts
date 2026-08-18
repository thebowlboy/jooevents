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
  organizerCommunicationAuthoringPayloadOperationResultSchema,
  organizerCommunicationDraftMutationOperationResultSchema,
  organizerCommunicationPurposePageOperationResultSchema,
  organizerMessagePreviewRecipientPageOperationResultSchema,
  organizerPrepareMessagePreviewOperationResultSchema,
  organizerPreviewMessageBatchOperationResultSchema,
  programVocabularySnapshotReadResultSchema,
  releasePublishOperationResultSchema,
  releaseReviewDraftOperationResultSchema,
  schedulePlacementOperationResultSchema,
  speakerProfileApproveResultSchema,
  speakerProfileReviewPolicyUpdateResultSchema,
  speakerProfileUpdateResultSchema,
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
const OPERATOR_EMAIL = 'maya.chen@ai-engineer.example.test';
const REVIEWER_SPECS = Object.freeze([
  Object.freeze({ key: 'maya', name: 'Maya Chen', email: OPERATOR_EMAIL, operator: true }),
  Object.freeze({ key: 'leonie', name: 'Leonie Weber', email: 'leonie.weber@ai-engineer.example.test', operator: false }),
  Object.freeze({ key: 'samir', name: 'Samir Patel', email: 'samir.patel@ai-engineer.example.test', operator: false }),
  Object.freeze({ key: 'imani', name: 'Imani Brooks', email: 'imani.brooks@ai-engineer.example.test', operator: false }),
  Object.freeze({ key: 'diego', name: 'Diego Alvarez', email: 'diego.alvarez@ai-engineer.example.test', operator: false }),
  Object.freeze({ key: 'yuki', name: 'Yuki Tan', email: 'yuki.tan@ai-engineer.example.test', operator: false })
] as const);

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
  name: 'AI Engineer Summit 2027',
  timezone: 'America/Los_Angeles',
  startDate: '2027-10-12',
  endDate: '2027-10-14'
});

const EVENT_SETTINGS_TEXT = Object.freeze({
  location: 'Harbor Exchange, Oakland, California',
  venueNote: 'Registration opens in the Atrium at 08:00. Workshop labs open 30 minutes before their first session.'
});

/** Review round due date, inside the event window. */
const REVIEW_DUE_DATE = '2027-08-22';

/**
 * One monotone nine-week story. All offsets are relative to process start and
 * every write still enters through its registered HTTP operation; only the
 * server-stamped fixture time changes between calls.
 */
const SEED_TIMELINE = Object.freeze({
  setupDaysBeforeAnchor: 70,
  arrivalDaysBeforeAnchor: Object.freeze(Array.from({ length: 20 }, (_, index) => 63 - index)),
  reviewRoundDaysBeforeAnchor: 36,
  reviewDaysBeforeAnchor: Object.freeze([34, 30, 26, 22, 18, 14]),
  decisionDaysBeforeAnchor: Object.freeze([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
});

const ROOMS = Object.freeze([
  Object.freeze({ key: 'main_stage', name: 'Foundation Stage', capacity: 700 }),
  Object.freeze({ key: 'studio', name: 'Reliability Theater', capacity: 240 }),
  Object.freeze({ key: 'product_room', name: 'Product Studio', capacity: 180 }),
  Object.freeze({ key: 'workshop_loft', name: 'Agent Lab', capacity: 72 })
] as const);

const TRACKS = Object.freeze([
  Object.freeze({ key: 'agent_systems', name: 'Agents & Applied AI' }),
  Object.freeze({ key: 'platform_reliability', name: 'Evals & Reliability' }),
  Object.freeze({ key: 'models_infrastructure', name: 'Models & Infrastructure' }),
  Object.freeze({ key: 'organizer_craft', name: 'AI Product & UX' })
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
  readonly formatKey?: FormatKey;
}

/**
 * Featured-talk applications. Their form pins the `Talk` format category, so
 * every one of them carries the format evidence an accept-with-spawn needs.
 */
const FEATURED_SUBMISSIONS: readonly SubmissionSpec[] = Object.freeze([
  Object.freeze({ key: 'rivera', name: 'Elena Rivera', email: 'elena.rivera@example.test', trackKey: 'agent_systems', formatKey: 'talk', title: 'The Agent That Knows When to Stop', abstract: 'A production account of bounded tool loops, explicit refusal states, and the operational signals that let an agent stop before a useful task becomes an expensive incident.' }),
  Object.freeze({ key: 'okafor', name: 'Chidi Okafor', email: 'chidi.okafor@example.test', trackKey: 'platform_reliability', formatKey: 'talk', title: 'Evals That Survive Contact With Production', abstract: 'Offline scores looked excellent until customer traffic arrived. This talk connects trace sampling, failure taxonomies, and small human review queues into an evaluation programme teams can operate every week.' }),
  Object.freeze({ key: 'sato', name: 'Mina Sato', email: 'mina.sato@example.test', trackKey: 'models_infrastructure', formatKey: 'workshop', title: 'Build a Latency Budget for a Compound AI System', abstract: 'Participants profile retrieval, routing, inference, and tool execution, then design a latency budget that remains useful when traffic and model providers change.' }),
  Object.freeze({ key: 'mensah', name: 'Kwame Mensah', email: 'kwame.mensah@example.test', trackKey: 'organizer_craft', formatKey: 'panel', title: 'When the Copilot Becomes the Product', abstract: 'A candid panel on where AI assistance belongs in a workflow, what users need to inspect, and how product teams avoid turning uncertainty into decorative confidence.' }),
  Object.freeze({ key: 'novak', name: 'Irena Novak', email: 'irena.novak@example.test', trackKey: 'agent_systems', formatKey: 'talk', title: 'Durable Workflows for Fallible Agents', abstract: 'Retries, checkpoints, resumable approvals, and forward recovery for agents that must finish important work without pretending every external effect is reversible.' }),
  Object.freeze({ key: 'hassan', name: 'Noor Hassan', email: 'noor.hassan@example.test', trackKey: 'platform_reliability', formatKey: 'lightning_talk', title: 'Seven Red-Team Prompts We Kept', abstract: 'Seven compact adversarial cases that found real authorization, retrieval, and instruction-boundary defects after larger benchmark suites had passed.' }),
  Object.freeze({ key: 'berg', name: 'Tomas Berg', email: 'tomas.berg@example.test', trackKey: 'models_infrastructure', formatKey: 'talk', title: 'Serving Small Models Where They Win', abstract: 'A measured account of routing narrow workloads to smaller models, including calibration, cache behaviour, observability, and the cases where the cheap path was false economy.' }),
  Object.freeze({ key: 'adebayo', name: 'Zuri Adebayo', email: 'zuri.adebayo@example.test', trackKey: 'organizer_craft', formatKey: 'workshop', title: 'Designing Honest Confidence', abstract: 'A hands-on clinic for uncertainty language, evidence views, and confirmation moments in AI products. Participants leave with a review of one real product flow.' }),
  Object.freeze({ key: 'cho', name: 'Daniel Cho', email: 'daniel.cho@example.test', trackKey: 'agent_systems', formatKey: 'panel', title: 'MCP in the Real World', abstract: 'Builders compare authority models, tool contracts, observability, and deployment lessons from shipping MCP-connected products beyond the first successful demo.' }),
  Object.freeze({ key: 'petrov', name: 'Anya Petrov', email: 'anya.petrov@example.test', trackKey: 'models_infrastructure', formatKey: 'talk', title: 'What We Learned Migrating a Vector Index Live', abstract: 'A no-downtime migration story covering dual reads, embedding drift, replayable backfills, relevance checks, and the exact rollback boundary the team trusted.' })
]);

const GENERAL_SUBMISSIONS: readonly SubmissionSpec[] = Object.freeze([
  Object.freeze({ key: 'ali', name: 'Farah Ali', email: 'farah.ali@example.test', title: 'Synthetic Users Are Not Your Users', abstract: 'A careful comparison of simulated user research and observed behavior, with a practical boundary for when generated feedback helps and when it merely agrees with the prompt.' }),
  Object.freeze({ key: 'morgan', name: 'Elliot Morgan', email: 'elliot.morgan@example.test', title: 'The Retrieval Checklist We Use Before Launch', abstract: 'A compact operating checklist for corpus ownership, chunking, freshness, access control, citations, evaluation, and the inevitable first incident.' }),
  Object.freeze({ key: 'silva', name: 'Camila Silva', email: 'camila.silva@example.test', title: 'A Field Guide to Model Fallbacks', abstract: 'How fallback trees fail under correlated outages, and how to test degraded behavior without turning every provider into an accidental single point of failure.' }),
  Object.freeze({ key: 'williams', name: 'Marcus Williams', email: 'marcus.williams@example.test', title: 'Prompt Review Is Code Review', abstract: 'A proposal for reviewing prompts with ownership, fixtures, versioned inputs, and rollback discipline while preserving the iteration speed that made prompts attractive.' }),
  Object.freeze({ key: 'nguyen', name: 'Linh Nguyen', email: 'linh.nguyen@example.test', title: 'From Prototype to Permission Model', abstract: 'The missing middle between a tool-calling demo and a product that can explain who was allowed to do what, to which data, and why.' }),
  Object.freeze({ key: 'davis', name: 'Avery Davis', email: 'avery.davis@example.test', title: 'Why Our AI Search Failed the Support Team', abstract: 'A frank postmortem of stale sources, hidden permissions, and unhelpful abstentions, plus the fixes that rebuilt trust with the people using search all day.' }),
  Object.freeze({ key: 'kowalski', name: 'Marta Kowalski', email: 'marta.kowalski@example.test', title: 'Token Counts Are Not Cost Controls', abstract: 'Budget enforcement across retries, tool calls, cached context, and human escalation, with examples of controls that remain legible to product owners.' }),
  Object.freeze({ key: 'johnson', name: 'Theo Johnson', email: 'theo.johnson@example.test', title: 'The Case Against One Giant Agent', abstract: 'A deliberately provocative argument for small operation-specific automations, evaluated against debuggability, permission scope, and user comprehension.' }),
  Object.freeze({ key: 'park', name: 'Jisoo Park', email: 'jisoo.park@example.test', title: 'Benchmark Archaeology', abstract: 'What old benchmark failures reveal about current model claims, and a reproducible method for deciding which historical tests still deserve attention.' }),
  Object.freeze({ key: 'rossi', name: 'Giulia Rossi', email: 'giulia.rossi@example.test', title: 'Accessibility for Generative Interfaces', abstract: 'Patterns for focus, streaming updates, correction, and alternate input in interfaces whose content and timing cannot be known in advance.' })
]);

const PLACEMENTS = Object.freeze([
  Object.freeze({
    submissionKey: 'rivera',
    roomKey: 'main_stage' as RoomKey,
    startAt: '2027-10-12T16:00:00.000Z',
    endAt: '2027-10-12T16:45:00.000Z'
  }),
  Object.freeze({
    submissionKey: 'okafor',
    roomKey: 'studio' as RoomKey,
    startAt: '2027-10-12T17:00:00.000Z',
    endAt: '2027-10-12T17:45:00.000Z'
  }),
  Object.freeze({
    submissionKey: 'sato', roomKey: 'workshop_loft' as RoomKey,
    startAt: '2027-10-12T18:00:00.000Z', endAt: '2027-10-12T19:30:00.000Z'
  }),
  Object.freeze({
    submissionKey: 'mensah', roomKey: 'main_stage' as RoomKey,
    startAt: '2027-10-13T16:00:00.000Z', endAt: '2027-10-13T17:00:00.000Z'
  }),
  Object.freeze({
    submissionKey: 'novak', roomKey: 'studio' as RoomKey,
    startAt: '2027-10-13T17:15:00.000Z', endAt: '2027-10-13T18:00:00.000Z'
  }),
  Object.freeze({
    submissionKey: 'hassan', roomKey: 'product_room' as RoomKey,
    startAt: '2027-10-13T18:15:00.000Z', endAt: '2027-10-13T18:35:00.000Z'
  }),
  Object.freeze({
    submissionKey: 'berg', roomKey: 'main_stage' as RoomKey,
    startAt: '2027-10-14T16:00:00.000Z', endAt: '2027-10-14T16:45:00.000Z'
  }),
  Object.freeze({
    submissionKey: 'adebayo', roomKey: 'workshop_loft' as RoomKey,
    startAt: '2027-10-14T17:00:00.000Z', endAt: '2027-10-14T18:30:00.000Z'
  })
] as const);

/** Speakers whose engagement the organizer records as confirmed. */
const CONFIRMED_SUBMISSION_KEYS: readonly string[] = Object.freeze([
  'rivera', 'okafor', 'sato', 'mensah', 'novak', 'hassan', 'berg'
]);

const CANONICAL_SESSION_DESCRIPTION =
  'A production account of bounded tool loops, explicit refusal states, and the operational signals that let an agent stop before a useful task becomes an expensive incident.';

const SESSION_FILE_LINKS = Object.freeze([
  Object.freeze({
    title: 'The Agent That Knows When to Stop',
    label: 'Bounded-agent checklist.pdf',
    url: 'https://assets.example.test/ai-engineer-summit/bounded-agent-checklist.pdf'
  }),
  Object.freeze({
    title: 'Build a Latency Budget for a Compound AI System',
    label: 'Workshop environment guide.pdf',
    url: 'https://assets.example.test/ai-engineer-summit/latency-workshop-guide.pdf'
  }),
  Object.freeze({
    title: 'Designing Honest Confidence',
    label: 'Product critique worksheet.pdf',
    url: 'https://assets.example.test/ai-engineer-summit/honest-confidence-worksheet.pdf'
  })
] as const);

const SPEAKER_TASKS = Object.freeze([
  Object.freeze({
    key: 'bio',
    name: 'Confirm speaker bio',
    description: 'Review the biography that will accompany the published speaker profile.',
    completionMode: 'acknowledge' as const,
    required: true,
    dueOn: '2027-08-18'
  }),
  Object.freeze({
    key: 'headshot',
    name: 'Upload headshot',
    description: 'Provide a high-resolution headshot for the event programme.',
    completionMode: 'file_upload' as const,
    required: true,
    dueOn: '2027-08-24'
  }),
  Object.freeze({
    key: 'slides',
    name: 'Upload slide draft',
    description: 'Send the first slide deck for the programme team to check.',
    completionMode: 'file_upload' as const,
    required: false,
    dueOn: '2027-09-30'
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

export interface AIEngineerReviewerSeedSummary {
  readonly eventId: string;
  readonly eventName: string;
  readonly anchor: string;
  readonly databaseId: string;
  readonly bootstrapOwnerReservationOpen: boolean;
  readonly vocabulary: { readonly rooms: number; readonly tracks: number; readonly formats: number };
  readonly forms: { readonly open: number; readonly closed: number };
  readonly submissions: number;
  readonly decisions: { readonly accepted: number; readonly waitlisted: number; readonly declined: number; readonly undecided: number };
  readonly reviewers: number;
  readonly reviewAssignments: number;
  readonly committedReviews: number;
  readonly reminderEligibleReviewers: number;
  readonly reminderExclusions: Readonly<Record<string, number>>;
  readonly spawnedSessions: number;
  readonly placements: number;
  readonly unplaced: readonly { readonly title: string; readonly safeOpening: { readonly room: string; readonly startAt: string; readonly endAt: string } }[];
  readonly confirmedEngagements: number;
  readonly speakerProfiles: number;
  readonly multiSpeakerSessions: number;
  readonly taskDefinitions: number;
  readonly taskAssignments: number;
  readonly conditionalRules: number;
  readonly sessionFiles: number;
  readonly releases: { readonly schedule: number; readonly speakers: number; readonly apply: number };
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
  throw new TypeError(`ai_engineer_reviewer_seed_${label}:${JSON.stringify(detail)}`);
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
  `).run(crypto.randomUUID(), `ai-engineer-playground-${crypto.randomUUID()}`, authUserId, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_sessions (
      id, token, user_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), rawToken, authUserId, now + 400 * 24 * 60 * 60 * 1000, now, now);

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
    key: 'ai-engineer-event-create',
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
    key: 'ai-engineer-event-settings-update',
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
      key: `ai-engineer-vocabulary-${spec.key}-create`,
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
      key: `ai-engineer-field-${spec.key}-add`,
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
  readonly closesAt?: string;
}): Promise<string> {
  const { context, key } = input;
  const catalog = await readFormCatalog(context);
  const created = requireSuccess(intakeFormDirectOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/forms/create',
    key: `ai-engineer-form-${key}-create`,
    body: {
      expectedCatalogVersion: catalog.catalogVersion,
      expectedRegistryVersion: catalog.registryPin.version,
      definition: input.definition
    },
    parse: (value) => value
  })), `form_${key}_create`);
  if (created.data.action !== 'create') fail(`form_${key}_create_action`, created.data.action);
  const formId = created.data.formId;

  if (input.closesAt !== undefined) {
    const current = await readFormDetail(context, formId);
    requireSuccess(intakeFormDirectOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/forms/closing',
      key: `ai-engineer-form-${key}-closing`,
      body: {
        formId,
        expectedDefinitionVersion: current.head.version,
        closesAt: input.closesAt
      },
      parse: (value) => value
    })), `form_${key}_closing`);
  }
  const detail = await readFormDetail(context, formId);
  const review = requireSuccess(intakeFormVersionReviewDraftOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/forms/publish/draft',
    key: `ai-engineer-form-${key}-publish-review`,
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
    key: `ai-engineer-form-${key}-publish`,
    body: {
      draftId: review.data.draftId,
      revisionId: review.data.revision.id,
      revisionDigestSha256: review.data.revision.digestSha256
    },
    parse: (value) => value
  })), `form_${key}_publish`);
  return formId;
}

async function closeForm(context: SeedContext, key: string, formId: string): Promise<void> {
  const detail = await readFormDetail(context, formId);
  requireSuccess(intakeFormDirectOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/forms/lifecycle',
    key: `ai-engineer-form-${key}-close`,
    body: {
      transition: 'close',
      formId,
      expectedDefinitionVersion: detail.head.version
    },
    parse: (value) => value
  })), `form_${key}_close`);
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
      key: `ai-engineer-entry-${spec.key}`,
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
    key: `ai-engineer-reviewer-role-change-${reviewerUserId}`,
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
    key: `ai-engineer-roster-${input.key}-register`,
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
    key: 'ai-engineer-review-open-round',
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
      key: `ai-engineer-review-${input.key}-${index}-save`,
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
      key: `ai-engineer-review-${input.key}-${index}-commit`,
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
      key: `ai-engineer-decision-${plan.key}`,
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
      key: `ai-engineer-placement-${placement.submissionKey}`,
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
    key: 'ai-engineer-session-agents-description',
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

async function addPanelCoSpeaker(input: {
  readonly context: SeedContext;
  readonly targetTitle: string;
  readonly sourceTitle: string;
}): Promise<number> {
  let catalog = await readSessionCatalog(input.context);
  const target = catalog.sessions.find((candidate) => candidate.title === input.targetTitle);
  const source = catalog.sessions.find((candidate) => candidate.title === input.sourceTitle);
  const participant = source?.roster.participants[0];
  if (!target || !source || !participant) {
    fail('panel_co_speaker_source_missing', {
      target: input.targetTitle,
      source: input.sourceTitle
    });
  }
  const changed = requireSuccess(sessionDirectOperationResultSchema.parse(await effect({
    context: input.context,
    path: '/api/events/current/sessions',
    key: 'ai-engineer-panel-co-speaker',
    body: {
      action: 'roster_add_existing',
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      sessionId: target.id,
      expectedSessionVersion: target.version,
      expectedSessionDigestSha256: target.digestSha256,
      expectedRosterVersion: target.roster.version,
      personId: participant.personId,
      role: 'panelist',
      publiclyVisible: true
    },
    parse: (value) => value
  })), 'panel_co_speaker');
  if (changed.data.action !== 'roster_add_existing') {
    fail('panel_co_speaker_action', changed.data.action);
  }

  catalog = await readSessionCatalog(input.context);
  const updated = catalog.sessions.find((candidate) => candidate.id === target.id);
  if (!updated || updated.roster.participants.length < 2) {
    fail('panel_co_speaker_roster_missing', target.id);
  }
  const engagements = await readEngagements(input.context);
  const engagement = engagements.engagements.find((candidate) =>
    candidate.sessionId === target.id && candidate.personId === participant.personId
  );
  if (!engagement) fail('panel_co_speaker_engagement_missing', participant.personId);
  requireSuccess(engagementChangeOperationResultSchema.parse(await effect({
    context: input.context,
    path: '/api/events/current/engagements',
    key: 'ai-engineer-panel-co-speaker-confirm',
    body: {
      action: 'record_confirmation',
      engagementId: engagement.id,
      expectedEngagementVersion: engagement.version,
      attribution: 'organizer_recorded'
    },
    parse: (value) => value
  })), 'panel_co_speaker_confirm');
  return 1;
}

async function curateSpeakerProfiles(input: {
  readonly context: SeedContext;
  readonly submissionIdByKey: ReadonlyMap<string, string>;
}): Promise<number> {
  const settings = requireSuccess(currentEventSettingsReadResultSchema.parse(await read(
    input.context, '/api/events/current/settings', (value) => value
  )), 'speaker_profile_settings').data;
  requireSuccess(speakerProfileReviewPolicyUpdateResultSchema.parse(await effect({
    context: input.context,
    path: '/api/events/current/speakers/profile-review-policy',
    key: 'ai-engineer-speaker-profile-review-policy',
    body: { expectedEventVersion: settings.eventVersion, reviewRequired: true },
    parse: (value) => value
  })), 'speaker_profile_review_policy');

  const engagements = await readEngagements(input.context);
  const locations = ['Oakland', 'Toronto', 'Singapore', 'Berlin', 'Lagos'];
  let count = 0;
  for (const [index, spec] of FEATURED_SUBMISSIONS.entries()) {
    const submissionId = input.submissionIdByKey.get(spec.key);
    const engagement = engagements.engagements.find((candidate) =>
      candidate.submissionId === submissionId
    );
    if (!submissionId || !engagement) fail('speaker_profile_engagement_missing', spec.key);
    const created = requireSuccess(speakerProfileUpdateResultSchema.parse(await effect({
      context: input.context,
      path: '/api/events/current/speakers/profile',
      key: `ai-engineer-speaker-profile-${spec.key}`,
      body: {
        personId: engagement.personId,
        expectedProfileVersion: null,
        patch: {
          headline: `${TRACKS.find((track) => track.key === spec.trackKey)?.name ?? 'AI engineering'} practitioner`,
          biography: `${spec.name} builds and operates AI systems, with a focus on the production lessons behind “${spec.title}”.`,
          location: locations[index % locations.length],
          links: [{
            kind: 'website',
            label: 'Speaker profile',
            href: `https://speakers.example.test/${spec.key}`
          }]
        }
      },
      parse: (value) => value
    })), `speaker_profile_${spec.key}`);
    requireSuccess(speakerProfileApproveResultSchema.parse(await effect({
      context: input.context,
      path: '/api/events/current/speakers/profile/approve',
      key: `ai-engineer-speaker-profile-${spec.key}-approve`,
      body: {
        personId: engagement.personId,
        expectedProfileVersion: created.data.profile?.version ?? 1,
        fields: ['headline', 'biography', 'location', 'links']
      },
      parse: (value) => value
    })), `speaker_profile_${spec.key}_approve`);
    count += 1;
  }
  return count;
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
      key: `ai-engineer-session-file-${index + 1}`,
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
      key: `ai-engineer-confirm-${key}`,
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
      key: `ai-engineer-task-${task.key}`,
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

async function prepareReviewerReminder(input: {
  readonly context: SeedContext;
  readonly reviewerIds: readonly string[];
}): Promise<{ readonly eligible: number; readonly exclusions: Readonly<Record<string, number>> }> {
  const purposes = requireSuccess(organizerCommunicationPurposePageOperationResultSchema.parse(
    await read(input.context,
      '/api/events/current/communications/purposes?channel=email&lifecycle=active',
      (value) => value)
  ), 'reminder_purposes_read').data.rows;
  const purpose = purposes.find((row) => row.revision.purposeKey === 'reviewer_reminder')?.revision;
  if (!purpose) fail('reminder_purpose_missing', null);
  const storePayload = async (key: string, payload: unknown) => requireSuccess(
    organizerCommunicationAuthoringPayloadOperationResultSchema.parse(await effect({
      context: input.context,
      path: '/api/events/current/communications/authoring-payloads',
      key: `ai-engineer-reminder-payload-${key}`,
      body: { payload },
      parse: (value) => value
    })), `reminder_payload_${key}`).data;
  const contentPayload = await storePayload('content', {
    payloadKind: 'message_content', schemaVersion: 1,
    value: {
      kind: 'email/v1',
      subject: 'A few Summit reviews still need your attention',
      body: { kind: 'plain_text/v1', text: 'Please finish your remaining AI Engineer Summit reviews by the review deadline.' }
    }
  });
  const audiencePayload = await storePayload('audience', {
    payloadKind: 'message_audience_draft', schemaVersion: 1,
    value: {
      schemaVersion: 1, binding: 'current_snapshot', purposeRevision: purpose,
      source: {
        kind: 'explicit_contacts',
        contactRefIds: input.reviewerIds.map((reviewerId) => `reviewer:${reviewerId}`).sort()
      }
    }
  });
  const draft = requireSuccess(organizerCommunicationDraftMutationOperationResultSchema.parse(
    await effect({
      context: input.context,
      path: '/api/events/current/communications/drafts/create',
      key: 'ai-engineer-reminder-draft',
      body: {
        channel: 'email', purposeRevision: purpose,
        initial: { kind: 'adopted_payload_refs', contentPayload, audiencePayload }
      },
      parse: (value) => value
    })
  ), 'reminder_draft');
  requireSuccess(organizerPrepareMessagePreviewOperationResultSchema.parse(await read(
    input.context,
    '/api/events/current/communications/previews/prepare'
      + `?draftId=${encodeURIComponent(draft.data.draftId)}`
      + `&expectedDraftVersion=${draft.data.version}`,
    (value) => value
  )), 'reminder_prepare');
  const adopted = requireSuccess(organizerPreviewMessageBatchOperationResultSchema.parse(await effect({
    context: input.context,
    path: '/api/events/current/communications/previews/adopt',
    key: 'ai-engineer-reminder-adopt',
    body: { draftId: draft.data.draftId, expectedDraftVersion: draft.data.version },
    parse: (value) => value
  })), 'reminder_adopt');
  const query = new URLSearchParams(Object.entries(adopted.data.identity)
    .map(([key, value]) => [key, String(value)]));
  const recipients = requireSuccess(organizerMessagePreviewRecipientPageOperationResultSchema.parse(
    await read(input.context,
      `/api/events/current/communications/previews/recipients?${query}`,
      (value) => value)
  ), 'reminder_recheck').data.rows;
  const exclusions: Record<string, number> = Object.create(null);
  for (const row of recipients) {
    if (row.state !== 'included') exclusions[row.reasonCode] = (exclusions[row.reasonCode] ?? 0) + 1;
  }
  const implicitlyExcluded = input.reviewerIds.length - recipients.length;
  if (implicitlyExcluded > 0) exclusions.no_unfinished_assignments = implicitlyExcluded;
  return Object.freeze({
    eligible: recipients.filter((row) => row.state === 'included').length,
    exclusions: Object.freeze(exclusions)
  });
}

async function publishSchedule(context: SeedContext): Promise<number> {
  const draft = requireSuccess(releaseReviewDraftOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/releases/drafts',
    key: 'ai-engineer-publish-schedule-draft',
    body: { action: 'publish_schedule', expectedCurrentReleaseNumber: null },
    parse: (value) => value
  })), 'publish_schedule_draft');
  const diff = draft.data.safeDiff;
  if (diff.action !== 'publish_schedule') fail('publish_schedule_diff', diff.action);
  await publishRelease(context, 'ai-engineer-publish-schedule', draft);
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
    key: `ai-engineer-release-surface-${input.key}-draft`,
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
  await publishRelease(input.context, `ai-engineer-release-surface-${input.key}`, draft);
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
    key: 'ai-engineer-release-style-draft',
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
  await publishRelease(input.context, 'ai-engineer-release-style', style);
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
export async function seedAIEngineerReviewer(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly config: ServerConfig;
  /** Controller retained only by this fixture assembler; never exposed by the runtime. */
  readonly clock: DevFixtureClock;
  /** Explicit controlled story anchor; must be the anchor used to construct `clock`. */
  readonly anchor: string;
  /**
   * Points one seeded speaker (Nadia Okonkwo) at a mailbox the operator owns,
   * so the participant portal's magic-link flow can be exercised end to end.
   * The committed roster stays fictional; a real address arrives only through
   * the ignored deployment environment.
   */
  readonly speakerEmailOverride?: string;
}): Promise<AIEngineerReviewerSeedSummary> {
  const { runtime, config } = input;
  const existingEventCount = runtime.database.sqlite.query<{ readonly count: number }, []>(
    'SELECT count(*) AS count FROM event_spine_heads'
  ).get()?.count ?? 0;
  if (existingEventCount !== 0) {
    fail('target_not_fresh', { existingEventCount });
  }
  // The seeded principals must never share the bootstrap owner's address:
  // that is what keeps the owner reservation unconsumed and the human's later
  // Google sign-in admissible into this same workspace.
  const bootstrapOwner = normalizeEmail(config.bootstrapOwnerEmail);
  if (REVIEWER_SPECS.some((spec) => bootstrapOwner === normalizeEmail(spec.email))) {
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
    const additionalReviewers: SeedPrincipal[] = [];
    for (const spec of REVIEWER_SPECS.filter((candidate) => !candidate.operator)) {
      additionalReviewers.push(await createSeededPrincipal({
        runtime, config, email: spec.email, displayName: spec.name, rolePresetKey: 'viewer'
      }));
    }
    const context: SeedContext = Object.freeze({
      runtime, config, cookie: operator.cookie, clock: input.clock
    });
    const reviewerContexts = [operator, ...additionalReviewers].map((principal) => Object.freeze({
      runtime, config, cookie: principal.cookie, clock: input.clock
    }));

    const eventId = await createEvent(context);
    await updateEventSettings(context);
    const vocabulary = await createVocabulary(context);

    const conditionalFields = await createConditionalCfpFields(context);
    const fields = await resolveCfpFields(context, conditionalFields);
    const generalFormId = await createOpenForm({
      context,
      key: 'general',
      closesAt: '2027-09-01',
      definition: cfpDefinition({
        name: 'AI Engineer Summit 2027 Late-breaking Demos',
        target: { kind: 'general_pool' },
        confirmation: 'Thanks — your proposal is in. The program team reviews everything in one batch after the deadline.',
        fields,
        conditionalDemo: true
      })
    });
    const formByFormat = new Map<FormatKey, string>();
    for (const format of FORMATS) {
      formByFormat.set(format.key, await createOpenForm({
        context,
        key: `main-${format.key}`,
        definition: cfpDefinition({
          name: `AI Engineer Summit 2027 ${format.name} CFP`,
          target: { kind: 'category', category: { kind: 'format', id: vocabulary[format.key] } },
          confirmation: 'Received. The programme committee will share a decision after review.',
          fields
        })
      }));
    }

    const speakerEmail = input.speakerEmailOverride?.trim();
    let featuredSpecs = FEATURED_SUBMISSIONS;
    if (speakerEmail) {
      if (!speakerEmail.includes('@')) fail('speaker_email_override_invalid', 'not_an_address');
      const normalized = normalizeEmail(speakerEmail);
      if (REVIEWER_SPECS.some((spec) => normalized === normalizeEmail(spec.email))) {
        fail('speaker_email_override_collides_with_seeded_principal', 'operator_or_reviewer');
      }
      featuredSpecs = FEATURED_SUBMISSIONS.map((spec) =>
        spec.key === 'rivera' ? Object.freeze({ ...spec, email: speakerEmail }) : spec
      );
    }
    const featuredIds = new Map<string, string>();
    for (const [index, spec] of featuredSpecs.entries()) {
      if (spec.key === 'rivera') continue;
      if (!spec.formatKey) fail('entry_format_missing', spec.key);
      const formId = formByFormat.get(spec.formatKey);
      if (!formId) fail('entry_form_missing', spec.formatKey);
      const created = await createDirectEntries({
        context, formId, fields, specs: [spec],
        daysBeforeAnchor: [SEED_TIMELINE.arrivalDaysBeforeAnchor[index]!]
      });
      featuredIds.set(spec.key, created.get(spec.key)!);
    }
    const generalIds = await createDirectEntries({
      context,
      formId: generalFormId,
      fields,
      specs: GENERAL_SUBMISSIONS,
      daysBeforeAnchor: SEED_TIMELINE.arrivalDaysBeforeAnchor.slice(featuredSpecs.length)
    });
    const submissionIdByKey = new Map([...featuredIds, ...generalIds]);

    const reviewerIds: string[] = [];
    const principals = [operator, ...additionalReviewers];
    for (const [index, principal] of principals.entries()) {
      if (index > 0) await grantReviewerRole(context, principal.userId);
      reviewerIds.push(await registerReviewer({
        context, key: REVIEWER_SPECS[index]!.key, userId: principal.userId
      }));
    }

    input.clock.moveToDaysBeforeAnchor(SEED_TIMELINE.reviewRoundDaysBeforeAnchor);
    const reviewAssignments = await openReviewRound(context);
    const rivera = featuredSpecs.find((spec) => spec.key === 'rivera');
    if (!rivera) fail('late_entry_spec_missing', 'rivera');
    const lateEntry = await createDirectEntries({
      context,
      formId: formByFormat.get('talk')!,
      fields,
      specs: [rivera],
      daysBeforeAnchor: [35]
    });
    const earlySubmissionId = lateEntry.get('rivera');
    if (!earlySubmissionId) fail('early_decision_submission_missing', 'rivera');
    submissionIdByKey.set('rivera', earlySubmissionId);
    for (const format of FORMATS) {
      await closeForm(context, `main-${format.key}`, formByFormat.get(format.key)!);
    }
    const forms = (await readFormCatalog(context)).forms;
    await commitDecisions(context, [{
      key: 'rivera', submissionId: earlySubmissionId, state: 'accepted', spawn: true,
      trackId: vocabulary.agent_systems
    }], [35]);
    let committedReviews = 0;
    for (const [index, reviewerContext] of reviewerContexts.entries()) {
      const count = index < 3 ? 17 : 19;
      committedReviews += await commitEvaluations({
        context: reviewerContext,
        key: REVIEWER_SPECS[index]!.key,
        daysBeforeAnchor: Array(count).fill(SEED_TIMELINE.reviewDaysBeforeAnchor[index]!),
        offset: index * 3
      });
    }

    const decisions: DecisionPlan[] = [];
    for (const spec of FEATURED_SUBMISSIONS.slice(1)) {
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
    for (const key of ['ali', 'morgan']) {
      const submissionId = submissionIdByKey.get(key);
      if (!submissionId) fail('waitlist_submission_missing', key);
      decisions.push({ key, submissionId, state: 'waitlisted', spawn: false });
    }
    for (const key of ['silva', 'williams']) {
      const submissionId = submissionIdByKey.get(key);
      if (!submissionId) fail('decline_submission_missing', key);
      decisions.push({ key, submissionId, state: 'declined', spawn: false });
    }
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
    const multiSpeakerSessions = await addPanelCoSpeaker({
      context,
      targetTitle: 'When the Copilot Becomes the Product',
      sourceTitle: 'MCP in the Real World'
    });
    const describedSessionId = sessionIdByTitle.get('The Agent That Knows When to Stop');
    if (!describedSessionId) fail('described_session_missing', null);
    await addCanonicalSessionDescription({ context, sessionId: describedSessionId });
    const sessionFiles = await createSessionFileLinks({ context, sessionIdByTitle });
    const confirmedEngagements = multiSpeakerSessions
      + await confirmEngagements({ context, submissionIdByKey });
    const speakerProfiles = await curateSpeakerProfiles({ context, submissionIdByKey });
    const taskDefinitions = await createSpeakerTasks(context);
    const releaseNumber = await publishSchedule(context);
    await publishPublicPresentations({ context, applyFormId: generalFormId });
    const reminder = await prepareReviewerReminder({ context, reviewerIds });

    const bootstrapReservation = runtime.database.sqlite.query<
      { readonly status: string }, [string, string]
    >(`
      SELECT status FROM access_reservations
       WHERE workspace_id = ? AND normalized_email = ?
    `).get(runtime.workspaceId, normalizeEmail(config.bootstrapOwnerEmail));
    const databaseId = runtime.database.sqlite.query<{ readonly database_id: string }, []>(
      'SELECT database_id FROM database_instance_metadata WHERE singleton_key = 1'
    ).get()?.database_id;
    if (!databaseId) fail('database_id_missing', null);
    const taskAssignments = runtime.database.sqlite.query<{ readonly count: number }, []>(
      'SELECT count(*) AS count FROM task_assignments'
    ).get()?.count ?? 0;

    return Object.freeze({
      eventId,
      eventName: EVENT.name,
      anchor: input.anchor,
      databaseId,
      bootstrapOwnerReservationOpen: bootstrapReservation?.status === 'open',
      vocabulary: Object.freeze({
        rooms: ROOMS.length, tracks: TRACKS.length, formats: FORMATS.length
      }),
      forms: Object.freeze({
        open: forms.filter((form) => form.status === 'open').length,
        closed: forms.filter((form) => form.status === 'closed').length
      }),
      submissions: submissionIdByKey.size,
      decisions: Object.freeze({ accepted: 10, waitlisted: 2, declined: 2, undecided: 6 }),
      reviewers: reviewerIds.length,
      reviewAssignments,
      committedReviews,
      reminderEligibleReviewers: reminder.eligible,
      reminderExclusions: reminder.exclusions,
      spawnedSessions: catalog.sessions.length,
      placements,
      unplaced: Object.freeze([
        Object.freeze({
          title: 'MCP in the Real World',
          safeOpening: Object.freeze({
            room: 'Foundation Stage',
            startAt: '2027-10-14T19:00:00.000Z',
            endAt: '2027-10-14T20:00:00.000Z'
          })
        }),
        Object.freeze({
          title: 'What We Learned Migrating a Vector Index Live',
          safeOpening: Object.freeze({
            room: 'Reliability Theater',
            startAt: '2027-10-14T19:00:00.000Z',
            endAt: '2027-10-14T19:45:00.000Z'
          })
        })
      ]),
      confirmedEngagements,
      speakerProfiles,
      multiSpeakerSessions,
      taskDefinitions,
      taskAssignments,
      conditionalRules: 2,
      sessionFiles,
      releases: Object.freeze({ schedule: releaseNumber, speakers: 1, apply: 1 }),
      applyFormId: generalFormId
    });
  } finally {
    // Failed seeds also relinquish the process-local fixture clock before the
    // caller closes the runtime, preventing stale time from escaping assembly.
    input.clock.useSystemTime();
  }
}
