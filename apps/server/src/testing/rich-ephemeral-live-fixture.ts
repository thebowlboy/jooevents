import { createHash } from 'node:crypto';
import { makeSignature } from 'better-auth/crypto';
import {
  createReadOperationResultSchema,
  currentEventReadResultSchema,
  currentEventSettingsReadResultSchema,
  eventCreateDraftOperationResultSchema,
  eventSettingsUpdateDraftOperationResultSchema,
  fieldRegistrySnapshotReadResultSchema,
  formVersionSchema,
  organizerFormCatalogSchema,
  organizerFormDetailSchema,
  programVocabularySnapshotReadResultSchema,
  type FormDefinitionAuthorInput,
  type FormDefinitionCreateAuthorInput,
  type FormTarget,
  type FieldRegistryAnswerOwner,
  type FieldRegistryContexts,
  type FieldRegistryGroup,
  type FieldRegistryKind,
  type FieldRegistryMapsTo,
  type FieldRegistryPurpose,
  type FormTargetReferencePinDto
} from '@jooevents/contracts';
import {
  changesetLifecycleOperationResultSchema
} from '@jooevents/changeset-operations';
import {
  intakeFormDraftOperationResultSchema
} from '@jooevents/intake-operations';
import { encodeCanonicalJson } from '@jooevents/kernel';
import {
  programVocabularyDraftOperationResultSchema
} from '@jooevents/program-operations';
import {
  loadEphemeralLiveConfig,
  type ServerConfig
} from '../config';
import {
  createEphemeralLiveRuntime,
  type EphemeralLiveRuntime
} from '../runtime/ephemeral-live';

const organizerFormCatalogReadResultSchema = createReadOperationResultSchema(
  organizerFormCatalogSchema
);
const organizerFormDetailReadResultSchema = createReadOperationResultSchema(
  organizerFormDetailSchema
);

const DEFAULT_BASE_URL = 'http://localhost:4193';
const DEFAULT_OWNER_EMAIL = 'rich-fixture-owner@example.test';
const DEFAULT_AUTH_SECRET = 'rich-fixture-secret-that-is-at-least-thirty-two-bytes';

const vocabularySpecs = Object.freeze([
  Object.freeze({ key: 'grand_auditorium', kind: 'room', name: 'Grand Auditorium', capacity: 640 }),
  Object.freeze({ key: 'studio_a', kind: 'room', name: 'Studio A', capacity: 180 }),
  Object.freeze({ key: 'workshop_lab', kind: 'room', name: 'Workshop Lab', capacity: 72 }),
  Object.freeze({ key: 'community_lounge', kind: 'room', name: 'Community Lounge', capacity: null }),
  Object.freeze({ key: 'archive_hall', kind: 'room', name: 'Archive Hall', capacity: 90 }),
  Object.freeze({ key: 'agent_systems', kind: 'track', name: 'Agent Systems' }),
  Object.freeze({ key: 'evaluation_reliability', kind: 'track', name: 'Evaluation & Reliability' }),
  Object.freeze({ key: 'product_craft', kind: 'track', name: 'Product Craft' }),
  Object.freeze({ key: 'legacy_integrations', kind: 'track', name: 'Legacy Integrations' }),
  Object.freeze({ key: 'talk', kind: 'format', name: 'Talk' }),
  Object.freeze({ key: 'workshop', kind: 'format', name: 'Workshop' }),
  Object.freeze({ key: 'panel', kind: 'format', name: 'Panel' }),
  Object.freeze({ key: 'lightning_talk', kind: 'format', name: 'Lightning Talk' })
] as const);

const formSpecs = Object.freeze([
  Object.freeze({ key: 'working_draft', finalName: 'Future Community CFP', finalStatus: 'draft' }),
  Object.freeze({ key: 'main_open', finalName: 'Main Call for Sessions', finalStatus: 'open' }),
  Object.freeze({ key: 'main_closed', finalName: 'Early Call for Sessions', finalStatus: 'closed' }),
  Object.freeze({ key: 'track_open', finalName: 'Agent Systems Deep Dives', finalStatus: 'open' }),
  Object.freeze({ key: 'format_history', finalName: 'Featured Talk Applications', finalStatus: 'closed' })
] as const);

export type RichVocabularyKey = typeof vocabularySpecs[number]['key'];
export type RichFormKey = typeof formSpecs[number]['key'];
export type RichVocabularyKind = typeof vocabularySpecs[number]['kind'];

export type RichNormalizedFormTarget =
  | { readonly kind: 'general_pool' }
  | {
      readonly kind: 'category';
      readonly category: {
        readonly kind: 'track' | 'format';
        readonly key: RichVocabularyKey;
      };
    }
  | { readonly kind: 'session'; readonly sessionId: string };

interface RichNormalizedFormFieldBase {
  readonly key: string;
  readonly kind: Exclude<FieldRegistryKind, 'file'>;
  readonly mapsTo: FieldRegistryMapsTo | null;
  readonly purpose: FieldRegistryPurpose;
  readonly label: string;
  readonly required: boolean;
  readonly initiallyVisible: boolean;
}

export type RichNormalizedFormField = RichNormalizedFormFieldBase & {
  readonly options:
    | { readonly kind: 'none' }
    | { readonly kind: 'custom'; readonly choices: readonly string[] }
    | {
        readonly kind: 'program_vocabulary';
        readonly source: 'tracks' | 'formats';
        readonly resolved: readonly RichVocabularyKey[];
      };
};

export interface RichNormalizedFormRule {
  readonly key: string;
  readonly condition:
    | {
        readonly kind: 'selected_any';
        readonly sourceFieldKey: string;
        readonly choiceCount: number;
      }
    | {
        readonly kind: 'checked_is';
        readonly sourceFieldKey: string;
        readonly value: boolean;
      };
  readonly effect: {
    readonly kind: 'show' | 'hide' | 'require';
    readonly targetFieldKeys: readonly string[];
  };
}

export const RICH_EPHEMERAL_LIVE_SCENARIO = deepFreeze({
  schemaVersion: 1 as const,
  key: 'rich-ephemeral-live-v1',
  event: Object.freeze({
    name: 'JooEvents Test Summit 2027',
    timezone: 'Asia/Singapore',
    startDate: '2027-06-10',
    endDate: '2027-06-12'
  }),
  eventSettings: Object.freeze({
    location: 'Suntec Convention Centre',
    venueNote: 'Registration opens on Level 2 beside the Grand Auditorium.'
  }),
  expected: Object.freeze({
    events: 1,
    vocabulary: Object.freeze({
      total: 13,
      rooms: 5,
      tracks: 4,
      formats: 4,
      active: 9,
      retired: 4,
      setVersion: 21
    }),
    forms: Object.freeze({
      total: 5,
      draft: 1,
      open: 2,
      closed: 2,
      publishedVersions: 5,
      catalogVersion: 14
    }),
    fieldRegistry: Object.freeze({ version: 1, fields: 19 }),
    submissions: 0,
    changesets: 35,
    operationReceipts: 105,
    history: Object.freeze({
      draftTimelineEntries: 35,
      lifecycleTimelineEntries: 70,
      domainFacts: 35,
      outboxPointers: 35,
      commitLinks: 35
    })
  }),
  extensionSlots: Object.freeze({
    submissions: Object.freeze({
      status: 'not_mounted' as const,
      reason: 'The production-safe ephemeral composition does not mount a public Intake ceremony.'
    })
  })
});

export interface RichEphemeralLiveHandles {
  readonly eventId: string;
  readonly vocabulary: Readonly<Record<RichVocabularyKey, string>>;
  readonly forms: Readonly<Record<RichFormKey, string>>;
}

export interface RichEphemeralLiveBaseline {
  readonly schemaVersion: 1;
  readonly event: {
    readonly name: string;
    readonly timezone: string;
    readonly startDate: string;
    readonly endDate: string;
    readonly location: string;
    readonly venueNote: string;
    readonly version: number;
  };
  readonly vocabulary: {
    readonly setVersion: number;
    readonly items: readonly {
      readonly key: RichVocabularyKey;
      readonly kind: RichVocabularyKind;
      readonly name: string;
      readonly status: 'active' | 'retired';
      readonly version: number;
      readonly capacity?: number | null;
      readonly usage: { readonly current: number; readonly historicalPins: number };
    }[];
  };
  readonly forms: {
    readonly catalogVersion: number;
    readonly items: readonly {
      readonly key: RichFormKey;
      readonly name: string;
      readonly status: 'draft' | 'open' | 'closed';
      readonly version: number;
      readonly target: RichNormalizedFormTarget;
      readonly publishedVersionCount: number;
      readonly publishedVersions: readonly {
        readonly number: number;
        readonly sourceDefinitionVersion: number;
        readonly target: RichNormalizedFormTarget;
        readonly targetPin: RichNormalizedFormTargetPin | null;
      }[];
      readonly currentPublishedVersion: null | {
        readonly number: number;
        readonly sourceDefinitionVersion: number;
        readonly targetPin: RichNormalizedFormTargetPin | null;
      };
      readonly fields: readonly RichNormalizedFormField[];
      readonly rules: readonly RichNormalizedFormRule[];
    }[];
  };
  readonly fieldRegistry: {
    readonly version: number;
    readonly fields: readonly {
      readonly key: string;
      readonly version: number;
      readonly kind: FieldRegistryKind;
      readonly label: string;
      readonly answerOwner: FieldRegistryAnswerOwner;
      readonly group: FieldRegistryGroup;
      readonly position: number;
      readonly contexts: FieldRegistryContexts;
      readonly locked: boolean;
      readonly fileUpload: 'not_applicable' | 'disabled';
      readonly options:
        | { readonly kind: 'none' }
        | {
            readonly kind: 'custom';
            readonly choices: readonly { readonly key: string; readonly label: string }[];
          }
        | {
            readonly kind: 'program_vocabulary';
            readonly source: 'tracks' | 'formats';
            readonly resolved: readonly {
              readonly key: RichVocabularyKey;
              readonly label: string;
              readonly version: number;
            }[];
          };
    }[];
  };
  readonly durableCounts: {
    readonly eventHeads: number;
    readonly vocabularyItems: number;
    readonly formHeads: number;
    readonly formVersions: number;
    readonly fieldRegistries: number;
    readonly submissions: number;
    readonly changesets: number;
    readonly committedChangesets: number;
    readonly operationReceipts: number;
  };
  readonly historyCounts: {
    readonly draftTimelineEntries: number;
    readonly lifecycleTimelineEntries: number;
    readonly domainFacts: number;
    readonly outboxPointers: number;
    readonly commitLinks: number;
  };
  readonly extensionSlots: typeof RICH_EPHEMERAL_LIVE_SCENARIO.extensionSlots;
}

export type RichNormalizedFormTargetPin =
  | {
      readonly kind: 'category';
      readonly categoryKind: 'track' | 'format';
      readonly key: RichVocabularyKey;
      readonly name: string;
      readonly version: number;
    }
  | {
      readonly kind: 'session';
      readonly id: string;
      readonly title: string;
      readonly version: number;
      readonly lifecycle: 'collecting';
    };

export interface RichEphemeralLiveFixture {
  readonly runtime: EphemeralLiveRuntime;
  readonly databasePath: string;
  readonly directoryPath: string;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly ownerCookie: string;
  readonly handles: RichEphemeralLiveHandles;
  readonly baseline: RichEphemeralLiveBaseline;
  readonly baselineFingerprintSha256: string;
  close(): ReturnType<EphemeralLiveRuntime['close']>;
}

interface OwnerSession {
  readonly authUserId: string;
  readonly cookie: string;
}

interface SeedContext {
  readonly runtime: EphemeralLiveRuntime;
  readonly config: ServerConfig;
  readonly session: OwnerSession;
  nextCorrelationId(): string;
}

interface DraftResult {
  readonly data: {
    readonly changesetId: string;
    readonly headVersion: number;
    readonly revision: { readonly id: string; readonly digestSha256: string };
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function fixtureUuid(sequence: number): string {
  return `01890f47-9abc-7def-8123-${sequence.toString(16).padStart(12, '0')}`;
}

function defaultConfig(): ServerConfig {
  return loadEphemeralLiveConfig({
    JOOEVENTS_BASE_URL: DEFAULT_BASE_URL,
    JOOEVENTS_TRUSTED_ORIGINS: '',
    JOOEVENTS_AUTH_SECRETS: `1:${DEFAULT_AUTH_SECRET}`,
    JOOEVENTS_GOOGLE_CLIENT_ID: 'rich-fixture-google-client',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'rich-fixture-google-secret',
    JOOEVENTS_ADMISSION_MODE: 'reservation_only',
    JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: DEFAULT_OWNER_EMAIL,
    JOOEVENTS_DATABASE_DRIVER: 'sqlite',
    JOOEVENTS_BLOB_DRIVER: 'filesystem'
  });
}

async function createOwnerSession(
  runtime: EphemeralLiveRuntime,
  config: ServerConfig
): Promise<{ readonly session: OwnerSession; readonly ownerUserId: string }> {
  const now = Date.now();
  const authUserId = fixtureUuid(1);
  const rawToken = 'rich-ephemeral-live-owner-session-token';
  runtime.database.sqlite.query(`
    INSERT INTO auth_users (
      id, name, email, email_verified, image, created_at, updated_at
    ) VALUES (?, 'Rich Fixture Owner', ?, 1, NULL, ?, ?)
  `).run(authUserId, config.bootstrapOwnerEmail, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_accounts (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES (?, 'rich-fixture-google-subject', 'google', ?, ?, ?)
  `).run(fixtureUuid(2), authUserId, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_sessions (
      id, token, user_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(fixtureUuid(3), rawToken, authUserId, now + 24 * 60 * 60 * 1000, now, now);

  const secret = config.authSecrets[0]?.value;
  if (!secret) throw new TypeError('rich_fixture_auth_secret_missing');
  const signature = await makeSignature(rawToken, secret);
  const session = Object.freeze({
    authUserId,
    cookie: `better-auth.session_token=${rawToken}.${signature}`
  });
  const provisioned = await runtime.app.request('/api/me/access-context', {
    headers: { cookie: session.cookie, 'x-correlation-id': fixtureUuid(4) }
  });
  if (provisioned.status !== 200) {
    throw new TypeError(`rich_fixture_owner_provisioning_failed:${provisioned.status}`);
  }
  const link = runtime.database.sqlite.query<{
    readonly user_id: string;
    readonly provisioning_state: string;
  }, [string]>(`
    SELECT user_id, provisioning_state
      FROM auth_user_links
     WHERE auth_user_id = ?
  `).get(authUserId);
  if (!link || link.provisioning_state !== 'ready') {
    throw new TypeError('rich_fixture_owner_link_missing');
  }
  return Object.freeze({ session, ownerUserId: link.user_id });
}

function requireSuccess<Result extends { readonly kind: string }>(
  result: Result,
  label: string
): Extract<Result, { readonly kind: 'success' }> {
  if (result.kind !== 'success') {
    throw new TypeError(`rich_fixture_${label}_failed:${JSON.stringify(result)}`);
  }
  return result as Extract<Result, { readonly kind: 'success' }>;
}

async function read<Result>(
  context: SeedContext,
  path: string,
  parse: (value: unknown) => Result
): Promise<Result> {
  const response = await context.runtime.app.request(path, {
    headers: {
      cookie: context.session.cookie,
      'x-correlation-id': context.nextCorrelationId()
    }
  });
  if (response.status !== 200) throw new TypeError(`rich_fixture_read_failed:${path}:${response.status}`);
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
      cookie: input.context.session.cookie,
      origin: input.context.config.baseUrl,
      'content-type': 'application/json',
      'idempotency-key': input.key,
      'x-correlation-id': input.context.nextCorrelationId()
    },
    body: JSON.stringify(input.body)
  });
  if (response.status !== 200) {
    throw new TypeError(`rich_fixture_effect_failed:${input.path}:${response.status}`);
  }
  return input.parse(await response.json());
}

async function commitDraft(context: SeedContext, key: string, draft: DraftResult): Promise<void> {
  const selector = Object.freeze({
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  });
  const proposal = requireSuccess(changesetLifecycleOperationResultSchema.parse(await effect({
    context,
    path: '/api/changesets/proposals',
    key: `${key}-propose`,
    body: { ...selector, expectedHeadVersion: draft.data.headVersion },
    parse: (value) => value
  })), `${key}_proposal`);
  if (proposal.data.action !== 'propose') throw new TypeError(`rich_fixture_${key}_proposal_invalid`);
  const committed = requireSuccess(changesetLifecycleOperationResultSchema.parse(await effect({
    context,
    path: '/api/changesets/commits',
    key: `${key}-commit`,
    body: { ...selector, expectedHeadVersion: proposal.data.diff.headVersion },
    parse: (value) => value
  })), `${key}_commit`);
  if (committed.data.action !== 'commit') throw new TypeError(`rich_fixture_${key}_commit_invalid`);
}

async function createEvent(context: SeedContext): Promise<string> {
  const draft = requireSuccess(eventCreateDraftOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/drafts/create',
    key: 'rich-v1-event-draft',
    body: RICH_EPHEMERAL_LIVE_SCENARIO.event,
    parse: (value) => value
  })), 'event_draft');
  await commitDraft(context, 'rich-v1-event', draft);
  return draft.data.safeDiff.after.id;
}

async function updateEventSettings(context: SeedContext, eventId: string): Promise<void> {
  const draft = requireSuccess(eventSettingsUpdateDraftOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/settings/drafts/update',
    key: 'rich-v1-event-settings-draft',
    body: {
      expectedEventId: eventId,
      expectedEventSetVersion: 2,
      expectedEventVersion: 1,
      ...RICH_EPHEMERAL_LIVE_SCENARIO.event,
      ...RICH_EPHEMERAL_LIVE_SCENARIO.eventSettings
    },
    parse: (value) => value
  })), 'event_settings_draft');
  await commitDraft(context, 'rich-v1-event-settings', draft);
}

async function readVocabulary(context: SeedContext) {
  return requireSuccess(programVocabularySnapshotReadResultSchema.parse(await read(
    context,
    '/api/events/current/program-vocabulary',
    (value) => value
  )), 'vocabulary_read').data;
}

async function readFieldRegistry(context: SeedContext) {
  return requireSuccess(fieldRegistrySnapshotReadResultSchema.parse(await read(
    context,
    '/api/events/current/field-registry',
    (value) => value
  )), 'field_registry_read').data;
}

async function createVocabulary(
  context: SeedContext
): Promise<Record<RichVocabularyKey, string>> {
  const handles = Object.create(null) as Record<RichVocabularyKey, string>;
  for (const spec of vocabularySpecs) {
    const snapshot = await readVocabulary(context);
    const body = spec.kind === 'room'
      ? {
          kind: spec.kind,
          expectedSetVersion: snapshot.setVersion,
          name: spec.name,
          capacity: spec.capacity
        }
      : { kind: spec.kind, expectedSetVersion: snapshot.setVersion, name: spec.name };
    const draft = requireSuccess(programVocabularyDraftOperationResultSchema.parse(await effect({
      context,
      path: '/api/events/current/program-vocabulary/drafts/create',
      key: `rich-v1-vocabulary-${spec.key}-draft`,
      body,
      parse: (value) => value
    })), `vocabulary_${spec.key}_draft`);
    if (draft.data.safeDiff.action !== 'create') {
      throw new TypeError(`rich_fixture_vocabulary_${spec.key}_diff_invalid`);
    }
    handles[spec.key] = draft.data.safeDiff.after.id;
    await commitDraft(context, `rich-v1-vocabulary-${spec.key}`, draft);
  }
  return handles;
}

async function mutateVocabulary(input: {
  readonly context: SeedContext;
  readonly handles: Readonly<Record<RichVocabularyKey, string>>;
  readonly key: RichVocabularyKey;
  readonly action: 'retire' | 'restore' | 'edit';
  readonly changes?: { readonly name: string; readonly capacity: number | null };
}): Promise<void> {
  const snapshot = await readVocabulary(input.context);
  const spec = vocabularySpecs.find((candidate) => candidate.key === input.key);
  if (!spec) throw new TypeError(`rich_fixture_vocabulary_spec_missing:${input.key}`);
  const item = [...snapshot.rooms, ...snapshot.tracks, ...snapshot.formats]
    .find((candidate) => candidate.id === input.handles[input.key]);
  if (!item || item.kind !== spec.kind) {
    throw new TypeError(`rich_fixture_vocabulary_item_missing:${input.key}`);
  }
  const path = `/api/events/current/program-vocabulary/drafts/${input.action}`;
  const body = input.action === 'edit'
    ? {
        kind: item.kind,
        id: item.id,
        expectedSetVersion: snapshot.setVersion,
        expectedItemVersion: item.version,
        changes: input.changes
      }
    : {
        kind: item.kind,
        id: item.id,
        expectedSetVersion: snapshot.setVersion,
        expectedItemVersion: item.version
      };
  const draft = requireSuccess(programVocabularyDraftOperationResultSchema.parse(await effect({
    context: input.context,
    path,
    key: `rich-v1-vocabulary-${input.key}-${input.action}-draft`,
    body,
    parse: (value) => value
  })), `vocabulary_${input.key}_${input.action}_draft`);
  await commitDraft(input.context, `rich-v1-vocabulary-${input.key}-${input.action}`, draft);
}

type RichRegistrySnapshot = Awaited<ReturnType<typeof readFieldRegistry>>;
type EvergreenFormDefinition = FormDefinitionAuthorInput & FormDefinitionCreateAuthorInput;

function registryFieldId(registry: RichRegistrySnapshot, key: string): string {
  const field = registry.fields.find((candidate) => candidate.key === key);
  if (!field) throw new TypeError(`rich_fixture_registry_field_missing:${key}`);
  return field.id;
}

function excludedApplyFieldIds(
  registry: RichRegistrySnapshot,
  includedKeys: ReadonlySet<string>
): string[] {
  return registry.fields
    .filter((field) => field.scope.kind === 'shared'
      && field.contexts.apply.visible
      && !includedKeys.has(field.key))
    .map((field) => field.id)
    .sort();
}

function richDefinition(
  name: string,
  target: FormTarget,
  registry: RichRegistrySnapshot,
  confirmation = 'Application received. You can expect an update after organizer review.'
): EvergreenFormDefinition {
  const recordingConsentId = registryFieldId(registry, 'person.recording_consent');
  const notesId = registryFieldId(registry, 'talk.notes');
  return {
    kind: 'cfp',
    name,
    target,
    availability: { kind: 'evergreen' },
    confirmation,
    composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
    rules: [
      {
        key: 'recording_exception',
        condition: { kind: 'checked_is', sourceFieldId: recordingConsentId, value: false },
        effect: { kind: 'require', targetFieldIds: [notesId] }
      }
    ]
  };
}

function leanDefinition(
  name: string,
  target: FormTarget,
  registry: RichRegistrySnapshot
): EvergreenFormDefinition {
  const includedKeys = new Set([
    'person.name', 'person.email', 'talk.title', 'talk.abstract'
  ]);
  return {
    kind: 'cfp',
    name,
    target,
    availability: { kind: 'evergreen' },
    confirmation: 'Application received.',
    composition: {
      excludedFieldIds: excludedApplyFieldIds(registry, includedKeys),
      requiredOverrides: {},
      optionExposure: {}
    },
    rules: []
  };
}

async function readFormCatalog(context: SeedContext) {
  return requireSuccess(organizerFormCatalogReadResultSchema.parse(await read(
    context,
    '/api/events/current/forms',
    (value) => value
  )), 'form_catalog_read').data;
}

async function readFormDetail(context: SeedContext, formId: string) {
  return requireSuccess(organizerFormDetailReadResultSchema.parse(await read(
    context,
    `/api/events/current/forms/detail?formId=${encodeURIComponent(formId)}`,
    (value) => value
  )), 'form_detail_read').data;
}

async function createForm(
  context: SeedContext,
  key: RichFormKey,
  definition: FormDefinitionCreateAuthorInput
): Promise<string> {
  const catalog = await readFormCatalog(context);
  const draft = requireSuccess(intakeFormDraftOperationResultSchema.parse(await effect({
    context,
    path: '/api/events/current/forms/drafts/create',
    key: `rich-v1-form-${key}-create-draft`,
    body: {
      expectedCatalogVersion: catalog.catalogVersion,
      expectedRegistryVersion: catalog.registryPin.version,
      definition
    },
    parse: (value) => value
  })), `form_${key}_create_draft`);
  if (draft.data.safeDiff.action !== 'create') {
    throw new TypeError(`rich_fixture_form_${key}_create_diff_invalid`);
  }
  await commitDraft(context, `rich-v1-form-${key}-create`, draft);
  return draft.data.safeDiff.after.id;
}

async function mutateForm(input: {
  readonly context: SeedContext;
  readonly key: RichFormKey;
  readonly formId: string;
  readonly action: 'publish' | 'publish_and_open' | 'close' | 'revise';
  readonly definition?: FormDefinitionAuthorInput;
  readonly occurrence?: number;
}): Promise<void> {
  const detail = await readFormDetail(input.context, input.formId);
  const routeAction = input.action === 'publish_and_open' || input.action === 'close'
    ? 'lifecycle'
    : input.action;
  const body = input.action === 'revise'
    ? {
        formId: input.formId,
        expectedDefinitionVersion: detail.head.version,
        expectedRegistryVersion: detail.registryPin.version,
        definition: input.definition
      }
    : input.action === 'publish'
      ? {
          formId: input.formId,
          expectedDefinitionVersion: detail.head.version,
          expectedRegistryVersion: detail.registryPin.version
        }
      : {
          transition: input.action,
          formId: input.formId,
          expectedDefinitionVersion: detail.head.version,
          ...(input.action === 'publish_and_open'
            ? { expectedRegistryVersion: detail.registryPin.version }
            : {})
        };
  const keySuffix = `${input.action}${input.occurrence ? `-${input.occurrence}` : ''}`;
  const draft = requireSuccess(intakeFormDraftOperationResultSchema.parse(await effect({
    context: input.context,
    path: `/api/events/current/forms/drafts/${routeAction}`,
    key: `rich-v1-form-${input.key}-${keySuffix}-draft`,
    body,
    parse: (value) => value
  })), `form_${input.key}_${input.action}_draft`);
  await commitDraft(input.context, `rich-v1-form-${input.key}-${keySuffix}`, draft);
}

async function createForms(
  context: SeedContext,
  vocabulary: Readonly<Record<RichVocabularyKey, string>>
): Promise<Record<RichFormKey, string>> {
  const handles = Object.create(null) as Record<RichFormKey, string>;
  const generalTarget = Object.freeze({ kind: 'general_pool' as const });
  const registry = await readFieldRegistry(context);

  handles.working_draft = await createForm(
    context,
    'working_draft',
    leanDefinition('Future Community CFP', generalTarget, registry)
  );

  handles.main_open = await createForm(
    context,
    'main_open',
    richDefinition('Main Call for Sessions', generalTarget, registry)
  );
  await mutateForm({
    context, key: 'main_open', formId: handles.main_open, action: 'publish_and_open'
  });

  handles.main_closed = await createForm(
    context,
    'main_closed',
    richDefinition(
      'Early Call for Sessions', generalTarget, registry, 'The early call is recorded.'
    )
  );
  await mutateForm({
    context, key: 'main_closed', formId: handles.main_closed, action: 'publish_and_open'
  });
  await mutateForm({ context, key: 'main_closed', formId: handles.main_closed, action: 'close' });

  const agentTrackTarget = Object.freeze({
    kind: 'category' as const,
    category: Object.freeze({ kind: 'track' as const, id: vocabulary.agent_systems })
  });
  handles.track_open = await createForm(
    context,
    'track_open',
    richDefinition('Agent Systems Deep Dives', agentTrackTarget, registry)
  );
  await mutateForm({
    context, key: 'track_open', formId: handles.track_open, action: 'publish_and_open'
  });

  const workshopTarget = Object.freeze({
    kind: 'category' as const,
    category: Object.freeze({ kind: 'format' as const, id: vocabulary.workshop })
  });
  handles.format_history = await createForm(
    context,
    'format_history',
    richDefinition('Workshop Lab Applications', workshopTarget, registry)
  );
  await mutateForm({
    context,
    key: 'format_history',
    formId: handles.format_history,
    action: 'publish_and_open',
    occurrence: 1
  });
  const talkTarget = Object.freeze({
    kind: 'category' as const,
    category: Object.freeze({ kind: 'format' as const, id: vocabulary.talk })
  });
  await mutateForm({
    context,
    key: 'format_history',
    formId: handles.format_history,
    action: 'revise',
    definition: richDefinition(
      'Featured Talk Applications',
      talkTarget,
      registry,
      'Featured talk application received.'
    )
  });
  await mutateForm({
    context, key: 'format_history', formId: handles.format_history, action: 'publish', occurrence: 2
  });
  await mutateForm({ context, key: 'format_history', formId: handles.format_history, action: 'close' });

  return handles;
}

function count(runtime: EphemeralLiveRuntime, table: string, where = ''): number {
  return runtime.database.sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table} ${where}`
  ).get()?.count ?? -1;
}

function vocabularyKeyForId(
  handles: Readonly<Record<RichVocabularyKey, string>>,
  id: string
): RichVocabularyKey {
  const entry = Object.entries(handles).find(([, candidate]) => candidate === id);
  if (!entry) throw new TypeError(`rich_fixture_vocabulary_handle_missing:${id}`);
  return entry[0] as RichVocabularyKey;
}

function normalizeTarget(
  target: FormTarget,
  handles: Readonly<Record<RichVocabularyKey, string>>
): RichNormalizedFormTarget {
  if (target.kind === 'general_pool') return Object.freeze({ kind: 'general_pool' as const });
  if (target.kind === 'session') {
    return Object.freeze({ kind: 'session' as const, sessionId: target.sessionId });
  }
  return Object.freeze({
    kind: 'category' as const,
    category: Object.freeze({
      kind: target.category.kind,
      key: vocabularyKeyForId(handles, target.category.id)
    })
  });
}

function normalizeTargetPin(
  pin: FormTargetReferencePinDto,
  handles: Readonly<Record<RichVocabularyKey, string>>
): RichNormalizedFormTargetPin {
  if (pin.kind === 'session') {
    return Object.freeze({
      kind: pin.kind,
      id: pin.id,
      title: pin.title,
      version: pin.version,
      lifecycle: pin.lifecycle
    });
  }
  return Object.freeze({
    kind: pin.kind,
    categoryKind: pin.categoryKind,
    key: vocabularyKeyForId(handles, pin.id),
    name: pin.name,
    version: pin.version
  });
}

function normalizeDefinition(
  detail: Awaited<ReturnType<typeof readFormDetail>>,
  handles: Readonly<Record<RichVocabularyKey, string>>
) {
  const fieldKeyById = new Map(detail.fields.map((row) => [row.field.id, row.field.key]));
  const fieldKey = (id: string): string => {
    const key = fieldKeyById.get(id);
    if (!key) throw new TypeError(`rich_fixture_form_field_key_missing:${id}`);
    return key;
  };
  const showTargets = new Set(detail.head.definition.rules
    .filter((rule) => rule.effect.kind === 'show')
    .flatMap((rule) => rule.effect.targetFieldIds));
  const fields: readonly RichNormalizedFormField[] = detail.fields.map((row) => {
    const field = row.field;
    if (field.kind === 'file') {
      throw new TypeError(`rich_fixture_included_file_field:${field.key}`);
    }
    const options: RichNormalizedFormField['options'] = field.options.kind === 'none'
      ? Object.freeze({ kind: 'none' as const })
      : field.options.kind === 'custom'
        ? Object.freeze({
            kind: 'custom' as const,
            choices: Object.freeze(field.options.choices.map((choice) => choice.key))
          })
        : Object.freeze({
            kind: 'program_vocabulary' as const,
            source: field.options.source,
            resolved: Object.freeze((row.options ?? [])
              .filter((option) => option.exposed)
              .map((option) => vocabularyKeyForId(handles, option.id))
              .sort())
          });
    return Object.freeze({
      key: field.key,
      kind: field.kind,
      mapsTo: field.mapsTo,
      purpose: field.purpose,
      label: field.label,
      required: row.required,
      initiallyVisible: !showTargets.has(field.id),
      options
    });
  });
  const rules: readonly RichNormalizedFormRule[] = detail.head.definition.rules.map((rule) => Object.freeze({
    key: rule.key,
    condition: rule.condition.kind === 'selected_any'
      ? Object.freeze({
          kind: rule.condition.kind,
          sourceFieldKey: fieldKey(rule.condition.sourceFieldId),
          choiceCount: rule.condition.choiceIds.length
        })
      : Object.freeze({
          kind: rule.condition.kind,
          sourceFieldKey: fieldKey(rule.condition.sourceFieldId),
          value: rule.condition.value
        }),
    effect: Object.freeze({
      kind: rule.effect.kind,
      targetFieldKeys: Object.freeze(rule.effect.targetFieldIds.map(fieldKey))
    })
  }));
  return Object.freeze({ fields: Object.freeze(fields), rules: Object.freeze(rules) });
}

async function captureBaseline(input: {
  readonly context: SeedContext;
  readonly handles: RichEphemeralLiveHandles;
}): Promise<RichEphemeralLiveBaseline> {
  const current = requireSuccess(currentEventReadResultSchema.parse(await read(
    input.context,
    '/api/events/current',
    (value) => value
  )), 'event_read').data;
  if (current.kind !== 'current_event') throw new TypeError('rich_fixture_current_event_missing');
  const settings = requireSuccess(currentEventSettingsReadResultSchema.parse(await read(
    input.context,
    '/api/events/current/settings',
    (value) => value
  )), 'event_settings_read').data;
  if (settings.eventId !== current.event.id
      || settings.eventSetVersion !== current.eventSetVersion
      || settings.eventVersion !== current.event.version) {
    throw new TypeError('rich_fixture_event_settings_binding_mismatch');
  }
  const vocabulary = await readVocabulary(input.context);
  const catalog = await readFormCatalog(input.context);
  const fieldRegistry = requireSuccess(fieldRegistrySnapshotReadResultSchema.parse(await read(
    input.context,
    '/api/events/current/field-registry',
    (value) => value
  )), 'field_registry_read').data;
  const items = vocabularySpecs.map((spec) => {
    const item = [...vocabulary.rooms, ...vocabulary.tracks, ...vocabulary.formats]
      .find((candidate) => candidate.id === input.handles.vocabulary[spec.key]);
    if (!item) throw new TypeError(`rich_fixture_baseline_vocabulary_missing:${spec.key}`);
    return Object.freeze({
      key: spec.key,
      kind: item.kind,
      name: item.name,
      status: item.status,
      version: item.version,
      ...(item.kind === 'room' ? { capacity: item.capacity } : {}),
      usage: Object.freeze({ ...item.usage })
    });
  });
  const forms = [] as Array<RichEphemeralLiveBaseline['forms']['items'][number]>;
  for (const spec of formSpecs) {
    const formId = input.handles.forms[spec.key];
    const detail = await readFormDetail(input.context, formId);
    const summary = catalog.forms.find((candidate) => candidate.id === formId);
    if (!summary) throw new TypeError(`rich_fixture_baseline_form_missing:${spec.key}`);
    const definition = normalizeDefinition(detail, input.handles.vocabulary);
    const publishedVersions = input.context.runtime.database.sqlite.query<{
      readonly version_json: string;
    }, [string]>(`
      SELECT version_json
        FROM intake_form_versions
       WHERE form_id = ?
       ORDER BY version_number, form_version_id COLLATE BINARY
    `).all(formId).map((row) => {
      const version = formVersionSchema.parse(JSON.parse(row.version_json));
      return Object.freeze({
        number: version.number,
        sourceDefinitionVersion: version.sourceDefinitionVersion,
        target: normalizeTarget(version.definition.target, input.handles.vocabulary),
        targetPin: version.targetPin
          ? normalizeTargetPin(version.targetPin, input.handles.vocabulary)
          : null
      });
    });
    forms.push(Object.freeze({
      key: spec.key,
      name: summary.name,
      status: summary.status,
      version: summary.version,
      target: normalizeTarget(summary.target, input.handles.vocabulary),
      publishedVersionCount: publishedVersions.length,
      publishedVersions: Object.freeze(publishedVersions),
      currentPublishedVersion: detail.currentPublishedVersion
        ? Object.freeze({
            number: detail.currentPublishedVersion.number,
            sourceDefinitionVersion: detail.currentPublishedVersion.sourceDefinitionVersion,
            targetPin: detail.currentPublishedVersion.targetPin
              ? normalizeTargetPin(
                  detail.currentPublishedVersion.targetPin,
                  input.handles.vocabulary
                )
              : null
          })
        : null,
      fields: definition.fields,
      rules: definition.rules
    }));
  }
  const registryFields = fieldRegistry.fields.map((field) => {
    if (field.scope.kind !== 'shared') {
      throw new TypeError(`rich_fixture_baseline_registry_scope_invalid:${field.key}`);
    }
    const options = field.options.kind === 'none'
      ? Object.freeze({ kind: 'none' as const })
      : field.options.kind === 'custom'
        ? Object.freeze({
            kind: 'custom' as const,
            choices: Object.freeze(field.options.choices.map((choice) => Object.freeze({
              key: choice.key,
              label: choice.label
            })))
          })
        : Object.freeze({
            kind: 'program_vocabulary' as const,
            source: field.options.source,
            resolved: Object.freeze((field.resolvedOptions ?? [])
              .map((option) => Object.freeze({
                key: vocabularyKeyForId(input.handles.vocabulary, option.id),
                label: option.label,
                version: option.version
              }))
              .sort((left, right) => left.key.localeCompare(right.key, 'en-US')))
          });
    return Object.freeze({
      key: field.key,
      version: field.version,
      kind: field.kind,
      label: field.label,
      answerOwner: field.answerOwner,
      group: field.group,
      position: field.position,
      contexts: field.contexts,
      locked: field.constraints.removal === 'forbidden',
      fileUpload: field.fileUpload,
      options
    });
  });
  return deepFreeze({
    schemaVersion: 1 as const,
    event: {
      name: current.event.name,
      timezone: current.event.timezone,
      startDate: current.event.startDate,
      endDate: current.event.endDate,
      location: settings.location,
      venueNote: settings.venueNote,
      version: current.event.version
    },
    vocabulary: { setVersion: vocabulary.setVersion, items },
    forms: { catalogVersion: catalog.catalogVersion, items: forms },
    fieldRegistry: { version: fieldRegistry.version, fields: registryFields },
    durableCounts: {
      eventHeads: count(input.context.runtime, 'event_spine_heads'),
      vocabularyItems:
        count(input.context.runtime, 'program_vocabulary_rooms')
        + count(input.context.runtime, 'program_vocabulary_tracks')
        + count(input.context.runtime, 'program_vocabulary_formats'),
      formHeads: count(input.context.runtime, 'intake_form_heads'),
      formVersions: count(input.context.runtime, 'intake_form_versions'),
      fieldRegistries: count(input.context.runtime, 'field_registry_aggregates'),
      submissions: count(input.context.runtime, 'intake_submission_heads'),
      changesets: count(input.context.runtime, 'changeset_heads'),
      committedChangesets: count(
        input.context.runtime,
        'changeset_heads',
        "WHERE status = 'committed'"
      ),
      operationReceipts: count(input.context.runtime, 'foundation_trial_operation_receipts')
    },
    historyCounts: {
      draftTimelineEntries:
        count(input.context.runtime, 'event_create_draft_timeline')
        + count(input.context.runtime, 'event_settings_update_draft_timeline')
        + count(input.context.runtime, 'program_vocabulary_draft_timeline')
        + count(input.context.runtime, 'intake_form_draft_timeline'),
      lifecycleTimelineEntries:
        count(input.context.runtime, 'event_creation_changeset_timeline')
        + count(input.context.runtime, 'event_settings_changeset_timeline')
        + count(input.context.runtime, 'changeset_lifecycle_timeline_projection')
        + count(input.context.runtime, 'intake_form_changeset_timeline'),
      domainFacts:
        count(input.context.runtime, 'event_creation_changeset_domain_facts')
        + count(input.context.runtime, 'event_settings_changeset_domain_facts')
        + count(input.context.runtime, 'changeset_lifecycle_domain_facts')
        + count(input.context.runtime, 'intake_form_changeset_domain_facts'),
      outboxPointers:
        count(input.context.runtime, 'event_creation_changeset_outbox_pointers')
        + count(input.context.runtime, 'event_settings_changeset_outbox_pointers')
        + count(input.context.runtime, 'changeset_lifecycle_outbox_pointers')
        + count(input.context.runtime, 'intake_form_changeset_outbox_pointers'),
      commitLinks: count(input.context.runtime, 'changeset_commit_links')
    },
    extensionSlots: RICH_EPHEMERAL_LIVE_SCENARIO.extensionSlots
  });
}

function assertExpectedBaseline(baseline: RichEphemeralLiveBaseline): void {
  const expected = RICH_EPHEMERAL_LIVE_SCENARIO.expected;
  const statuses = baseline.vocabulary.items.reduce(
    (counts, item) => ({ ...counts, [item.status]: counts[item.status] + 1 }),
    { active: 0, retired: 0 }
  );
  const formStatuses = baseline.forms.items.reduce(
    (counts, form) => ({ ...counts, [form.status]: counts[form.status] + 1 }),
    { draft: 0, open: 0, closed: 0 }
  );
  const actual = {
    eventHeads: baseline.durableCounts.eventHeads,
    vocabularyItems: baseline.durableCounts.vocabularyItems,
    vocabularySetVersion: baseline.vocabulary.setVersion,
    activeVocabulary: statuses.active,
    retiredVocabulary: statuses.retired,
    formHeads: baseline.durableCounts.formHeads,
    formVersions: baseline.durableCounts.formVersions,
    fieldRegistries: baseline.durableCounts.fieldRegistries,
    fieldRegistryVersion: baseline.fieldRegistry.version,
    fieldRegistryFields: baseline.fieldRegistry.fields.length,
    formCatalogVersion: baseline.forms.catalogVersion,
    draftForms: formStatuses.draft,
    openForms: formStatuses.open,
    closedForms: formStatuses.closed,
    submissions: baseline.durableCounts.submissions,
    changesets: baseline.durableCounts.changesets,
    committedChangesets: baseline.durableCounts.committedChangesets,
    operationReceipts: baseline.durableCounts.operationReceipts
  };
  const wanted = {
    eventHeads: expected.events,
    vocabularyItems: expected.vocabulary.total,
    vocabularySetVersion: expected.vocabulary.setVersion,
    activeVocabulary: expected.vocabulary.active,
    retiredVocabulary: expected.vocabulary.retired,
    formHeads: expected.forms.total,
    formVersions: expected.forms.publishedVersions,
    fieldRegistries: expected.events,
    fieldRegistryVersion: expected.fieldRegistry.version,
    fieldRegistryFields: expected.fieldRegistry.fields,
    formCatalogVersion: expected.forms.catalogVersion,
    draftForms: expected.forms.draft,
    openForms: expected.forms.open,
    closedForms: expected.forms.closed,
    submissions: expected.submissions,
    changesets: expected.changesets,
    committedChangesets: expected.changesets,
    operationReceipts: expected.operationReceipts
  };
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new TypeError(`rich_fixture_baseline_mismatch:${JSON.stringify(actual)}`);
  }
  if (JSON.stringify(baseline.historyCounts) !== JSON.stringify(expected.history)) {
    throw new TypeError(
      `rich_fixture_history_mismatch:${JSON.stringify(baseline.historyCounts)}`
    );
  }
}

/**
 * Creates a private temporary SQLite database and fills it only through the
 * same registered Event, Event Settings, Program Vocabulary, Form, and changeset operations
 * used by the live server. Every call owns a separate runtime and database.
 */
export async function createRichEphemeralLiveFixture(input: {
  readonly config?: ServerConfig;
} = {}): Promise<RichEphemeralLiveFixture> {
  const config = input.config ?? defaultConfig();
  const runtime = await createEphemeralLiveRuntime({ config });
  try {
    const owner = await createOwnerSession(runtime, config);
    let correlationSequence = 0x100;
    const context: SeedContext = Object.freeze({
      runtime,
      config,
      session: owner.session,
      nextCorrelationId: () => fixtureUuid(correlationSequence++)
    });
    const eventId = await createEvent(context);
    await updateEventSettings(context, eventId);
    const vocabulary = await createVocabulary(context);
    await mutateVocabulary({
      context,
      handles: vocabulary,
      key: 'workshop_lab',
      action: 'edit',
      changes: { name: 'Workshop Lab · Ground Floor', capacity: 84 }
    });
    await mutateVocabulary({ context, handles: vocabulary, key: 'archive_hall', action: 'retire' });
    await mutateVocabulary({ context, handles: vocabulary, key: 'legacy_integrations', action: 'retire' });
    await mutateVocabulary({ context, handles: vocabulary, key: 'lightning_talk', action: 'retire' });
    await mutateVocabulary({ context, handles: vocabulary, key: 'lightning_talk', action: 'restore' });

    const forms = await createForms(context, vocabulary);
    await mutateVocabulary({ context, handles: vocabulary, key: 'workshop', action: 'retire' });
    await mutateVocabulary({ context, handles: vocabulary, key: 'agent_systems', action: 'retire' });

    const handles = deepFreeze({ eventId, vocabulary, forms });
    const baseline = await captureBaseline({ context, handles });
    assertExpectedBaseline(baseline);
    const baselineFingerprintSha256 = createHash('sha256')
      .update(encodeCanonicalJson(baseline))
      .digest('hex');
    return Object.freeze({
      runtime,
      databasePath: runtime.database.databasePath,
      directoryPath: runtime.database.directoryPath,
      workspaceId: runtime.workspaceId,
      ownerUserId: owner.ownerUserId,
      ownerCookie: owner.session.cookie,
      handles,
      baseline,
      baselineFingerprintSha256,
      close: runtime.close
    });
  } catch (error) {
    runtime.close();
    throw error;
  }
}
