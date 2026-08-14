import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import {
  currentEventReadResultSchema,
  currentEventSettingsReadResultSchema,
  createReadOperationResultSchema,
  decisionDecideDraftOperationResultSchema,
  decisionStateReadResultSchema,
  emailProviderConfigurationReadOperationResultSchema,
  engagementChangeDraftOperationResultSchema,
  engagementSnapshotReadResultSchema,
  emailProviderReadinessReadOperationResultSchema,
  eventCreateDraftOperationResultSchema,
  eventSettingsUpdateDraftOperationResultSchema,
  fieldRegistrySnapshotReadResultSchema,
  organizerCommunicationAudienceOptionPageOperationResultSchema,
  organizerCommunicationAuthoringPayloadOperationResultSchema,
  organizerCommunicationDraftMutationOperationResultSchema,
  organizerCommunicationDraftPageOperationResultSchema,
  organizerCommunicationHistoryPageOperationResultSchema,
  organizerCommunicationPurposePageOperationResultSchema,
  organizerMessageTemplatePageOperationResultSchema,
  organizerPrepareMessagePreviewOperationResultSchema,
  organizerPreviewMessageBatchOperationResultSchema,
  organizerSendMessagesOperationResultSchema,
  organizerFormCatalogSchema,
  portalEngagementRespondResultSchema,
  portalSnapshotReadResultSchema,
  programVocabularySnapshotReadResultSchema,
  releaseDraftOperationResultSchema,
  safeOperationManifestSchema,
  servedPublicRosterSchema,
  servedPublicScheduleSchema,
  submissionDirectEntryDraftOperationResultSchema
} from '@jooevents/contracts';
import { workspaceOverviewReadResultSchema } from '@jooevents/contracts/workspace-overview';
import {
  workspaceTeamDraftOperationResultSchema,
  workspaceTeamMembersReadResultSchema
} from '@jooevents/contracts/workspace-team';
import {
  reviewChangeDraftOperationResultSchema,
  reviewSnapshotReadResultSchema
} from '@jooevents/contracts/reviews';
import {
  sessionCatalogReadResultSchema,
  sessionDraftOperationResultSchema
} from '@jooevents/contracts/sessions';
import {
  reviewerRosterChangeDraftOperationResultSchema,
  reviewerRosterSnapshotReadResultSchema
} from '@jooevents/contracts/reviewer-roster';
import {
  submissionTriageListOperationResultSchema
} from '@jooevents/contracts/submission-triage';
import {
  deadlineDraftOperationResultSchema,
  deadlineGetReadResultSchema,
  deadlineListReadResultSchema
} from '@jooevents/contracts/deadlines';
import { programVocabularyDraftOperationResultSchema } from '@jooevents/program-operations';
import {
  schedulePlacementDraftOperationResultSchema,
  schedulePlacementSnapshotReadResultSchema
} from '@jooevents/schedule-operations';
import { intakeFormDraftOperationResultSchema } from '@jooevents/intake-operations';
import {
  changesetDiffOperationResultSchema,
  changesetLifecycleOperationResultSchema
} from '@jooevents/changeset-operations';
import { DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG } from '@jooevents/workspace-operations';
import { loadEphemeralLiveConfig } from '../config';
import { createEphemeralLiveRuntime, type EphemeralLiveRuntime } from './ephemeral-live';
import { createProductionRequestHandler } from './request-handler';

const runtimes: EphemeralLiveRuntime[] = [];
const organizerFormCatalogReadResultSchema = createReadOperationResultSchema(
  organizerFormCatalogSchema
);

const config = loadEphemeralLiveConfig({
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
  JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
  JOOEVENTS_ADMISSION_MODE: 'pending',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'ignored-by-explicit-ephemeral-entry.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/ignored-by-explicit-ephemeral-entry'
});

interface BrowserSession {
  readonly authUserId: string;
  readonly sessionId: string;
  readonly cookie: string;
}

const eventInput = Object.freeze({
  expectedEventSetVersion: 1,
  name: 'JooEvents Summit',
  timezone: 'Asia/Singapore',
  startDate: '2027-06-10',
  endDate: '2027-06-12'
});

const formDefinitionInput = Object.freeze({
  kind: 'cfp' as const,
  name: 'Main CFP',
  target: Object.freeze({ kind: 'general_pool' as const }),
  availability: Object.freeze({ kind: 'evergreen' as const }),
  confirmation: 'Application received.',
  composition: Object.freeze({
    excludedFieldIds: Object.freeze([]),
    requiredOverrides: Object.freeze({}),
    optionExposure: Object.freeze({})
  }),
  rules: Object.freeze([])
});

function categoryFormDefinition(trackId: string) {
  return Object.freeze({
    ...formDefinitionInput,
    name: 'Track CFP',
    target: Object.freeze({
      kind: 'category' as const,
      category: Object.freeze({ kind: 'track' as const, id: trackId })
    })
  });
}

function cleanupRetainedTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || !basename(path).startsWith('jooevents-ephemeral-runtime-')
  ) {
    throw new Error(`unsafe_ephemeral_test_cleanup:${path}`);
  }
  const parent = realpathSync(dirname(path));
  if (dirname(path) !== parent) throw new Error(`unsafe_ephemeral_test_parent:${path}`);
  rmSync(path, { recursive: true });
}

async function createOwnerSession(runtime: EphemeralLiveRuntime): Promise<BrowserSession> {
  const now = Date.now();
  const authUserId = crypto.randomUUID();
  const accountId = `google-${crypto.randomUUID()}`;
  const sessionId = crypto.randomUUID();
  const rawToken = crypto.randomUUID();
  runtime.database.sqlite.query(`
    INSERT INTO auth_users (
      id, name, email, email_verified, image, created_at, updated_at
    ) VALUES (?, 'Ephemeral Owner', ?, 1, NULL, ?, ?)
  `).run(authUserId, config.bootstrapOwnerEmail, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_accounts (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES (?, ?, 'google', ?, ?, ?)
  `).run(crypto.randomUUID(), accountId, authUserId, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_sessions (
      id, token, user_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, rawToken, authUserId, now + 60 * 60 * 1000, now, now);

  const secret = config.authSecrets[0]?.value;
  if (!secret) throw new Error('test auth secret missing');
  const signature = await makeSignature(rawToken, secret);
  return Object.freeze({
    authUserId,
    sessionId,
    cookie: `better-auth.session_token=${rawToken}.${signature}`
  });
}

async function provisionOwner(
  runtime: EphemeralLiveRuntime,
  session: BrowserSession
): Promise<string> {
  const response = await runtime.app.request('/api/me/access-context', {
    headers: { cookie: session.cookie, 'x-correlation-id': crypto.randomUUID() }
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: 'active',
    workspace: { id: runtime.workspaceId }
  });
  const link = runtime.database.sqlite.query<{
    readonly user_id: string;
    readonly provisioning_state: string;
  }, [string]>(`
    SELECT user_id, provisioning_state
      FROM auth_user_links
     WHERE auth_user_id = ?
  `).get(session.authUserId);
  expect(link?.provisioning_state).toBe('ready');
  if (!link) throw new Error('owner provisioning link missing');
  return link.user_id;
}

function eventHeaders(input: {
  readonly session?: BrowserSession;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly origin?: string;
}): Headers {
  const headers = new Headers();
  if (input.session) headers.set('cookie', input.session.cookie);
  if (input.correlationId) headers.set('x-correlation-id', input.correlationId);
  if (input.idempotencyKey) headers.set('idempotency-key', input.idempotencyKey);
  if (input.origin) headers.set('origin', input.origin);
  headers.set('content-type', 'application/json');
  return headers;
}

function count(runtime: EphemeralLiveRuntime, table: string, where = ''): number {
  return runtime.database.sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table} ${where}`
  ).get()?.count ?? -1;
}

async function effect<Result>(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly session: BrowserSession;
  readonly path: string;
  readonly key: string;
  readonly body: unknown;
  readonly parse: (value: unknown) => Result;
}): Promise<Result> {
  const response = await input.runtime.app.request(input.path, {
    method: 'POST',
    headers: eventHeaders({
      session: input.session,
      correlationId: crypto.randomUUID(),
      idempotencyKey: input.key,
      origin: config.baseUrl
    }),
    body: JSON.stringify(input.body)
  });
  expect(response.status).toBe(200);
  return input.parse(await response.json());
}

async function commitDraft(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly session: BrowserSession;
  readonly key: string;
  readonly draft: {
    readonly data: {
      readonly changesetId: string;
      readonly revision: { readonly id: string; readonly digestSha256: string };
    };
  };
}) {
  const selector = {
    changesetId: input.draft.data.changesetId,
    revisionId: input.draft.data.revision.id,
    revisionDigest: input.draft.data.revision.digestSha256
  };
  const proposed = changesetLifecycleOperationResultSchema.parse(await effect({
    runtime: input.runtime,
    session: input.session,
    path: '/api/changesets/proposals',
    key: `${input.key}-propose`,
    body: { ...selector, expectedHeadVersion: 1 },
    parse: (value) => value
  }));
  expect(proposed).toMatchObject({ kind: 'success', data: { action: 'propose' } });
  const committed = changesetLifecycleOperationResultSchema.parse(await effect({
    runtime: input.runtime,
    session: input.session,
    path: '/api/changesets/commits',
    key: `${input.key}-commit`,
    body: { ...selector, expectedHeadVersion: 2 },
    parse: (value) => value
  }));
  expect(committed).toMatchObject({ kind: 'success', data: { action: 'commit' } });
  if (committed.kind !== 'success') throw new Error('Changeset commit failed.');
  return { selector, committed };
}

async function createEventThroughChangeset(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly session: BrowserSession;
  readonly key: string;
}) {
  const draft = eventCreateDraftOperationResultSchema.parse(await effect({
    runtime: input.runtime,
    session: input.session,
    path: '/api/events/drafts/create',
    key: `${input.key}-draft`,
    body: {
      name: eventInput.name,
      timezone: eventInput.timezone,
      startDate: eventInput.startDate,
      endDate: eventInput.endDate
    },
    parse: (value) => value
  }));
  expect(draft).toMatchObject({
    kind: 'success',
    data: { action: 'create', headVersion: 1, safeDiff: { action: 'create' } },
    receipt: { operationName: 'event.create.draft', operationVersion: 1 }
  });
  if (draft.kind !== 'success') throw new Error('Event draft failed.');
  const lifecycle = await commitDraft({
    runtime: input.runtime,
    session: input.session,
    key: input.key,
    draft
  });
  return Object.freeze({ draft, ...lifecycle });
}

const embedBuildDirectories: string[] = [];

interface SeededSpeakerInput {
  readonly key: string;
  readonly title: string;
  readonly name: string;
  readonly email: string;
}

interface SeededSpeaker extends SeededSpeakerInput {
  readonly submissionId: string;
  readonly personId: string;
  readonly sessionId: string;
  readonly engagementId: string;
}

/**
 * Seeds the shared publication/portal world through the mounted operations
 * only: a format-targeted CFP carrying title, name, and email, one committed
 * direct entry per speaker, and one accept-with-spawn decision commit — so
 * every speaker ends with a `programmed` Session, Intake participant
 * evidence, and one seeded `invited` engagement.
 */
async function seedAcceptedSpeakers(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly session: BrowserSession;
  readonly key: string;
  readonly speakers: readonly SeededSpeakerInput[];
}): Promise<readonly SeededSpeaker[]> {
  const { runtime, session, key } = input;
  await createEventThroughChangeset({ runtime, session, key: `${key}-event` });

  const formatDraft = programVocabularyDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/program-vocabulary/drafts/create',
    key: `${key}-format-draft`,
    body: { kind: 'format', expectedSetVersion: 1, name: 'Talk' },
    parse: (value) => value
  }));
  if (formatDraft.kind !== 'success') throw new Error('Format draft failed.');
  await commitDraft({ runtime, session, key: `${key}-format`, draft: formatDraft });
  const vocabulary = programVocabularySnapshotReadResultSchema.parse(await (
    await runtime.app.request('/api/events/current/program-vocabulary', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    })
  ).json());
  if (vocabulary.kind !== 'success') throw new Error('Vocabulary read failed.');
  const format = vocabulary.data.formats.find((candidate) => candidate.name === 'Talk');
  if (!format) throw new Error('Committed format missing.');

  const registryResult = fieldRegistrySnapshotReadResultSchema.parse(await (
    await runtime.app.request('/api/events/current/field-registry', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    })
  ).json());
  if (registryResult.kind !== 'success') throw new Error('Field registry read failed.');
  const registry = registryResult.data;
  const requireField = (mapsTo: string, kind: string): string => {
    const id = registry.fields.find(
      (field) => field.mapsTo === mapsTo && field.kind === kind
    )?.id;
    if (!id) throw new Error(`Registry field missing: ${mapsTo}`);
    return id;
  };
  const titleFieldId = requireField('talk.title', 'text');
  const nameFieldId = requireField('person.name', 'text');
  const emailFieldId = requireField('person.email', 'email');
  const included = new Set([titleFieldId, nameFieldId, emailFieldId]);

  const formCreateDraft = intakeFormDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/forms/drafts/create',
    key: `${key}-form-create-draft`,
    body: {
      expectedCatalogVersion: 1,
      expectedRegistryVersion: registry.version,
      definition: {
        ...formDefinitionInput,
        name: 'Speaker CFP',
        target: { kind: 'category', category: { kind: 'format', id: format.id } },
        composition: {
          excludedFieldIds: registry.fields
            .filter((field) => field.scope.kind === 'shared'
              && field.contexts.apply.visible
              && !included.has(field.id))
            .map((field) => field.id)
            .sort(),
          requiredOverrides: {},
          optionExposure: {}
        }
      }
    },
    parse: (value) => value
  }));
  if (formCreateDraft.kind !== 'success'
      || formCreateDraft.data.safeDiff.action !== 'create') {
    throw new Error('Form create draft failed.');
  }
  await commitDraft({ runtime, session, key: `${key}-form-create`, draft: formCreateDraft });
  const openDraft = intakeFormDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/forms/drafts/lifecycle',
    key: `${key}-form-open-draft`,
    body: {
      transition: 'publish_and_open',
      formId: formCreateDraft.data.safeDiff.after.id,
      expectedDefinitionVersion: 1,
      expectedRegistryVersion: registry.version
    },
    parse: (value) => value
  }));
  if (openDraft.kind !== 'success') throw new Error('Form open draft failed.');
  await commitDraft({ runtime, session, key: `${key}-form-open`, draft: openDraft });
  const catalog = organizerFormCatalogReadResultSchema.parse(await (
    await runtime.app.request('/api/events/current/forms', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    })
  ).json());
  if (catalog.kind !== 'success') throw new Error('Form catalog read failed.');
  const openForm = catalog.data.forms.find((form) => form.status === 'open');
  if (!openForm) throw new Error('Open form missing from the catalog.');

  const submissionIds: string[] = [];
  for (const speaker of input.speakers) {
    const entryDraft = submissionDirectEntryDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/submissions/direct-entry/drafts',
      key: `${key}-entry-${speaker.key}-draft`,
      body: {
        formId: openForm.id,
        expectedFormDefinitionVersion: openForm.version,
        answers: [
          { kind: 'text', fieldId: titleFieldId, value: speaker.title },
          { kind: 'text', fieldId: nameFieldId, value: speaker.name },
          { kind: 'email', fieldId: emailFieldId, value: speaker.email }
        ]
      },
      parse: (value) => value
    }));
    if (entryDraft.kind !== 'success') throw new Error('Direct entry draft failed.');
    submissionIds.push(entryDraft.data.safeDiff.submission.id);
    await commitDraft({
      runtime, session, key: `${key}-entry-${speaker.key}`, draft: entryDraft
    });
  }

  const decideDraft = decisionDecideDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/decisions/decide-drafts',
    key: `${key}-decide-draft`,
    body: {
      action: 'decide',
      decisions: submissionIds.map((submissionId) => ({
        submissionId,
        state: 'accepted',
        expectedDecisionVersion: null,
        expectedDecisionDigestSha256: null,
        graduation: { kind: 'spawn' }
      }))
    },
    parse: (value) => value
  }));
  if (decideDraft.kind !== 'success') throw new Error('Decide draft failed.');
  await commitDraft({ runtime, session, key: `${key}-decide`, draft: decideDraft });

  const sessions = sessionCatalogReadResultSchema.parse(await (
    await runtime.app.request('/api/events/current/sessions', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    })
  ).json());
  if (sessions.kind !== 'success') throw new Error('Session catalog read failed.');
  const engagements = engagementSnapshotReadResultSchema.parse(await (
    await runtime.app.request('/api/events/current/engagements', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    })
  ).json());
  if (engagements.kind !== 'success') throw new Error('Engagement read failed.');

  return input.speakers.map((speaker, index) => {
    const submissionId = submissionIds[index];
    if (!submissionId) throw new Error('Submission id missing.');
    const person = runtime.database.sqlite.query<{ readonly person_id: string }, [string]>(`
      SELECT person_id FROM intake_submission_participant_evidence
       WHERE submission_id = ?
    `).get(submissionId);
    if (!person) throw new Error('Participant evidence missing.');
    const spawned = sessions.data.sessions.find(
      (candidate) => candidate.title === speaker.title
    );
    if (!spawned) throw new Error('Spawned session missing.');
    const engagement = engagements.data.engagements.find(
      (candidate) => candidate.submissionId === submissionId
    );
    if (!engagement) throw new Error('Seeded engagement missing.');
    return Object.freeze({
      ...speaker,
      submissionId,
      personId: person.person_id,
      sessionId: spawned.id,
      engagementId: engagement.id
    });
  });
}

afterEach(() => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    if (!runtime) continue;
    runtime.close();
    cleanupRetainedTree(runtime.database.directoryPath);
  }
  while (embedBuildDirectories.length > 0) {
    const directory = embedBuildDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('ephemeral live Foundation server composition', () => {
  test('serves only registered organizer operations over the joined ephemeral schema', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const manifestResponse = await runtime.app.request('/api/operations/manifest');
    expect(manifestResponse.status).toBe(200);
    const manifest = safeOperationManifestSchema.parse(await manifestResponse.json());
    expect(manifest.operations.map((operation) => ({
      name: operation.name,
      version: operation.version,
      effect: operation.effect,
      bindings: operation.enabledBindings.flatMap((binding) =>
        binding.protocol === 'http' ? [`${binding.method} ${binding.path}`] : []
      )
    }))).toEqual([
      {
        name: 'changeset.commit', version: 1, effect: 'commit',
        bindings: ['POST /api/changesets/commits']
      },
      {
        name: 'changeset.correction.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/changesets/corrections']
      },
      {
        name: 'changeset.diff.read', version: 1, effect: 'read',
        bindings: ['GET /api/changesets/diff']
      },
      {
        name: 'changeset.propose', version: 1, effect: 'draft',
        bindings: ['POST /api/changesets/proposals']
      },
      {
        name: 'changeset.rebuild', version: 1, effect: 'draft',
        bindings: ['POST /api/changesets/rebuilds']
      },
      {
        name: 'communication.email_readiness.read', version: 1, effect: 'read',
        bindings: ['GET /api/communications/email-readiness']
      },
      {
        name: 'communication.provider_connection.read', version: 1, effect: 'read',
        bindings: ['GET /api/communications/provider-connection']
      },
      {
        name: 'create_message_draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/communications/drafts/create']
      },
      {
        name: 'deadline.catalog.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/deadlines']
      },
      {
        name: 'deadline.change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/deadlines/drafts']
      },
      {
        name: 'deadline.current.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/deadlines/current']
      },
      {
        name: 'decision.decide.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/decisions/decide-drafts']
      },
      {
        name: 'decision.state.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/decisions']
      },
      {
        name: 'discard_message_draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/communications/drafts/discard']
      },
      {
        name: 'engagement.change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/engagements/drafts']
      },
      {
        name: 'engagement.snapshot.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/engagements']
      },
      {
        name: 'event.create.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/drafts/create']
      },
      { name: 'event.current.read', version: 1, effect: 'read', bindings: ['GET /api/events/current'] },
      {
        name: 'event.settings.current.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/settings']
      },
      {
        name: 'event.settings.update.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/settings/drafts/update']
      },
      {
        name: 'field_registry.add.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/field-registry/drafts/add']
      },
      {
        name: 'field_registry.edit.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/field-registry/drafts/edit']
      },
      {
        name: 'field_registry.move.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/field-registry/drafts/move']
      },
      {
        name: 'field_registry.remove.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/field-registry/drafts/remove']
      },
      {
        name: 'field_registry.restore.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/field-registry/drafts/restore']
      },
      {
        name: 'field_registry.snapshot.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/field-registry']
      },
      {
        name: 'form.closing.change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/forms/drafts/closing']
      },
      {
        name: 'form.definition.create.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/forms/drafts/create']
      },
      {
        name: 'form.definition.revise.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/forms/drafts/revise']
      },
      {
        name: 'form.lifecycle.change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/forms/drafts/lifecycle']
      },
      {
        name: 'form.list', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/forms']
      },
      {
        name: 'form.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/forms/detail']
      },
      {
        name: 'form.version.publish.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/forms/drafts/publish']
      },
      {
        name: 'get_communication_purpose', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/purposes/detail']
      },
      {
        name: 'get_delivery_history', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/deliveries/history']
      },
      {
        name: 'get_message_batch_preview', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/previews/detail']
      },
      {
        name: 'get_message_draft', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/drafts/detail']
      },
      {
        name: 'get_message_template', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/templates/detail']
      },
      {
        name: 'list_audience_options', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/audiences/options']
      },
      {
        name: 'list_communication_purposes', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/purposes']
      },
      {
        name: 'list_message_drafts', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/drafts']
      },
      {
        name: 'list_message_preview_recipients', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/previews/recipients']
      },
      {
        name: 'list_message_templates', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/templates']
      },
      {
        name: 'portal.engagement.respond', version: 1, effect: 'commit',
        bindings: ['POST /api/portal/engagements/respond']
      },
      {
        name: 'portal.snapshot.read', version: 1, effect: 'read',
        bindings: ['GET /api/portal/snapshot']
      },
      {
        name: 'prepare_message_batch_preview', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/communications/previews/prepare']
      },
      {
        name: 'preview_message_batch', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/communications/previews/adopt']
      },
      {
        name: 'program_vocabulary.create.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/program-vocabulary/drafts/create']
      },
      {
        name: 'program_vocabulary.delete.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/program-vocabulary/drafts/delete']
      },
      {
        name: 'program_vocabulary.edit.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/program-vocabulary/drafts/edit']
      },
      {
        name: 'program_vocabulary.merge.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/program-vocabulary/drafts/merge']
      },
      {
        name: 'program_vocabulary.restore.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/program-vocabulary/drafts/restore']
      },
      {
        name: 'program_vocabulary.retire.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/program-vocabulary/drafts/retire']
      },
      {
        name: 'program_vocabulary.snapshot.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/program-vocabulary']
      },
      {
        name: 'release.change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/releases/drafts']
      },
      {
        name: 'review.assignment.step-back.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/review/step-back-drafts']
      },
      {
        name: 'review.evaluation.change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/review/evaluation-drafts']
      },
      {
        name: 'review.evaluation.draft.save', version: 1, effect: 'commit',
        bindings: ['POST /api/events/current/review/evaluation-draft']
      },
      {
        name: 'review.round.change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/review/round-drafts']
      },
      {
        name: 'review.round.setup.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/review/round-setup']
      },
      {
        name: 'review.snapshot.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/review/snapshot']
      },
      {
        name: 'reviewer_roster.change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/reviewer-roster/drafts']
      },
      {
        name: 'reviewer_roster.snapshot.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/reviewer-roster']
      },
      {
        name: 'revise_message_batch', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/communications/drafts/revise']
      },
      {
        name: 'schedule.placement.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/schedule/placements/drafts']
      },
      {
        name: 'schedule.placement.snapshot.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/schedule/placements']
      },
      {
        name: 'send_messages', version: 1, effect: 'commit',
        bindings: ['POST /api/events/current/communications/messages/send']
      },
      {
        name: 'session.catalog.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/sessions']
      },
      {
        name: 'session.change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/sessions/drafts']
      },
      {
        name: 'store_communication_authoring_payload', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/communications/authoring-payloads']
      },
      {
        name: 'submission.contact.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/submissions/contact']
      },
      {
        name: 'submission.direct_entry.create.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/submissions/direct-entry/drafts']
      },
      {
        name: 'submission.list', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/submissions']
      },
      {
        name: 'submission.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/submissions/detail']
      },
      {
        name: 'submission.triage.list', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/submissions/triage']
      },
      {
        name: 'submission.triage.read', version: 1, effect: 'read',
        bindings: ['GET /api/events/current/submissions/triage/detail']
      },
      {
        name: 'submission.triage.transition.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/events/current/submissions/triage/drafts']
      },
      {
        name: 'workspace_team.invite.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/workspace/team/invitations/drafts']
      },
      {
        name: 'workspace_team.members.read', version: 1, effect: 'read',
        bindings: ['GET /api/workspace/team']
      },
      {
        name: 'workspace_team.removal.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/workspace/team/removals/drafts']
      },
      {
        name: 'workspace_team.role_change.draft', version: 1, effect: 'draft',
        bindings: ['POST /api/workspace/team/role-changes/drafts']
      },
      {
        name: 'workspace.overview.read', version: 1, effect: 'read',
        bindings: ['GET /api/workspace/overview']
      }
    ]);
    expect(runtime.database.installedSchemaArtifacts.map((artifact) => artifact.id))
      .toContain('event-spine');
    expect(runtime.database.installedSchemaArtifacts.map((artifact) => artifact.id))
      .toEqual(expect.arrayContaining([
        'changeset-lifecycle',
        'event-create-draft-effect',
        'event-creation-changeset-effect',
        'event-settings-domain',
        'event-settings-draft-effect',
        'event-settings-changeset-effect',
        'deadline-domain',
        'deadline-draft-effect',
        'deadline-changeset-effect',
        'program-vocabulary-domain',
        'program-vocabulary-draft-effect',
        'program-vocabulary-changeset-effect',
        'schedule-placement-domain',
        'schedule-placement-draft-effect',
        'schedule-placement-changeset-effect',
        'classified-payload-store',
        'communication-organizer-authoring',
        'communication-organizer-authoring-effect',
        'communication-organizer-audience-preview',
        'communication-email-provider-configuration',
        'intake-domain',
        'intake-form-draft-effect',
        'intake-form-changeset-effect',
        'field-registry-domain',
        'field-registry-draft-effect',
        'field-registry-changeset-effect',
        'submission-triage-domain',
        'submission-triage-draft-effect',
        'submission-triage-changeset-effect',
        'intake-direct-entry-effect',
        'workspace-team-domain',
        'workspace-team-draft-effect',
        'workspace-team-changeset-effect',
        'decision-domain',
        'decision-draft-effect',
        'decision-changeset-effect'
      ]));
    expect(runtime.database.runtimeSchemaFingerprint)
      .not.toBe(runtime.database.retainedBaseline.schemaFingerprint);
    expect((await runtime.app.request('/api/program-vocabulary')).status).toBe(404);
    expect((await runtime.app.request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: config.baseUrl },
      body: '{}'
    })).status).toBe(404);
    expect((await runtime.app.request('/api/public/forms/current')).status).toBe(400);
    // The unified public registry admits exactly three GET reads; before an
    // event exists each refuses as an invalid request rather than serving.
    expect((await runtime.app.request('/api/public/schedule/current')).status).toBe(400);
    expect((await runtime.app.request('/api/public/speakers/current')).status).toBe(400);
    expect((await runtime.app.request('/api/public/schedule')).status).toBe(404);
    expect((await runtime.app.request('/api/public/speakers')).status).toBe(404);
    // The participant lane refuses without a lane-separate session; the entry
    // acknowledgement stays non-enumerating even before an event exists.
    expect((await runtime.app.request('/api/portal/snapshot')).status).toBe(401);
    expect((await runtime.app.request('/api/portal/engagements/respond', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: config.baseUrl,
        'idempotency-key': 'portal-census-probe'
      },
      body: '{}'
    })).status).toBe(401);
    expect(await (await runtime.app.request('/api/me/participant-context')).json())
      .toEqual({ state: 'anonymous' });
    const preEventLink = await runtime.app.request('/api/portal/entry/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: config.baseUrl },
      body: JSON.stringify({ email: 'someone@example.test' })
    });
    expect(preEventLink.status).toBe(200);
    expect(await preEventLink.json()).toEqual({ outcome: 'link_requested' });
    expect((await runtime.app.request('/api/public/forms/application')).status).toBe(404);
    expect((await runtime.app.request('/api/public/forms/application/mutate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })).status).toBe(404);
    expect((await runtime.app.request('/api/changesets/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: config.baseUrl },
      body: '{}'
    })).status).toBe(404);
    expect((await runtime.app.request('/api/test/program-vocabulary/reviewed-http-commits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: config.baseUrl },
      body: '{}'
    })).status).toBe(404);
  });

  test('states the messages area by operations this composition actually serves', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const manifest = safeOperationManifestSchema.parse(
      await (await runtime.app.request('/api/operations/manifest')).json()
    );
    const mounted = new Set(manifest.operations.map((operation) => operation.name));
    const messages = DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG
      .find((entry) => entry.area === 'messages');
    if (messages?.status !== 'partial') throw new Error('The messages area is not partial.');
    // The area names communication operations exactly: every advertised
    // capability is served by this registry, and the one it calls unavailable
    // is genuinely not mounted. An area claim is evidence, not a label.
    expect(messages.availableCapabilities.filter((name) => !mounted.has(name))).toEqual([]);
    expect(messages.unavailableCapabilities.filter((name) => mounted.has(name))).toEqual([]);
  });

  test('owns an independent database per runtime and closes idempotently', async () => {
    const first = await createEphemeralLiveRuntime({ config });
    const second = await createEphemeralLiveRuntime({ config });
    runtimes.push(first, second);
    expect(first.database.databasePath).not.toBe(second.database.databasePath);
    expect(first.database.retainedBaseline.databaseId)
      .not.toBe(second.database.retainedBaseline.databaseId);
    expect(first.workspaceId).not.toBe(second.workspaceId);
    const result = first.close();
    expect(first.close()).toBe(result);
    expect(result.kind).toBe('closed_private_tree_retained');
  });

  test('joins owner admission and classified Team invitations to the shared lifecycle', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    const ownerUserId = await provisionOwner(runtime, session);

    const beforeResponse = await runtime.app.request('/api/workspace/team', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(beforeResponse.status).toBe(200);
    const before = workspaceTeamMembersReadResultSchema.parse(await beforeResponse.json());
    expect(before).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        version: 2,
        members: [{
          kind: 'member', userId: ownerUserId, status: 'active',
          role: { key: 'workspace_admin' }
        }]
      }
    });
    if (before.kind !== 'success') throw new Error('Workspace Team read failed.');

    const rejected = await runtime.app.request('/api/workspace/team/invitations/drafts', {
      method: 'POST',
      headers: eventHeaders({
        session, correlationId: crypto.randomUUID(), idempotencyKey: 'team-forged-scope',
        origin: config.baseUrl
      }),
      body: JSON.stringify({
        email: 'invitee@example.test', roleKey: 'viewer',
        expectedTeamVersion: before.data.version,
        expectedTeamDigestSha256: before.data.digestSha256,
        workspaceId: runtime.workspaceId,
        createdByUserId: ownerUserId
      })
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      kind: 'transport_error', code: 'invalid_request', retryable: false
    });

    const draft = workspaceTeamDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/workspace/team/invitations/drafts',
      key: 'team-invite-draft',
      body: {
        email: 'invitee@example.test', roleKey: 'viewer',
        expectedTeamVersion: before.data.version,
        expectedTeamDigestSha256: before.data.digestSha256
      },
      parse: (value) => value
    }));
    expect(draft).toMatchObject({
      kind: 'success',
      data: {
        action: 'invite', headVersion: 1, status: 'draft',
        safeDiff: {
          action: 'invite', role: { key: 'viewer' },
          invitationStatus: 'recorded', delivery: 'awaiting_activation'
        }
      },
      receipt: { operationName: 'workspace_team.invite.draft', operationVersion: 1 }
    });
    if (draft.kind !== 'success') throw new Error('Workspace Team draft failed.');
    expect(Buffer.from(runtime.database.sqlite.serialize()).includes(
      Buffer.from('invitee@example.test')
    )).toBe(false);

    const unchangedResponse = await runtime.app.request('/api/workspace/team', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    const unchanged = workspaceTeamMembersReadResultSchema.parse(
      await unchangedResponse.json()
    );
    expect(unchanged).toMatchObject({ kind: 'success', data: { version: 2 } });
    if (unchanged.kind === 'success') expect(unchanged.data.members).toHaveLength(1);

    await commitDraft({ runtime, session, key: 'team-invite', draft });
    const afterResponse = await runtime.app.request('/api/workspace/team', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    const after = workspaceTeamMembersReadResultSchema.parse(await afterResponse.json());
    expect(after).toMatchObject({ kind: 'success', data: { version: 3 } });
    if (after.kind !== 'success') throw new Error('Workspace Team re-read failed.');
    expect(after.data.members.find((member) => member.kind === 'invitation')).toMatchObject({
      kind: 'invitation', email: 'invitee@example.test', status: 'invited',
      role: { key: 'viewer' }, delivery: 'awaiting_activation'
    });
    expect(Buffer.from(runtime.database.sqlite.serialize()).includes(
      Buffer.from('invitee@example.test')
    )).toBe(false);
    expect(count(runtime, 'workspace_team_changeset_domain_facts')).toBe(1);
    expect(count(runtime, 'workspace_team_changeset_outbox_pointers')).toBe(1);
    const overviewResponse = await runtime.app.request('/api/workspace/overview', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(overviewResponse.status).toBe(200);
    const overview = workspaceOverviewReadResultSchema.parse(await overviewResponse.json());
    expect(overview).toMatchObject({
      kind: 'success', data: {
        event: { kind: 'no_event' },
        history: { total: 1, threads: [{ domain: 'workspace_team' }] }
      }
    });
  });

  test('provisions the owner and commits the first Event through one typed changeset', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    const appUserId = await provisionOwner(runtime, session);

    const noEventCorrelation = crypto.randomUUID();
    const noEventResponse = await runtime.app.request('/api/events/current', {
      headers: eventHeaders({ session, correlationId: noEventCorrelation })
    });
    expect(noEventResponse.status).toBe(200);
    expect(currentEventReadResultSchema.parse(await noEventResponse.json())).toEqual({
      kind: 'success',
      data: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 },
      correlationId: noEventCorrelation
    });

    const noEventOverviewCorrelation = crypto.randomUUID();
    const noEventOverviewResponse = await runtime.app.request('/api/workspace/overview', {
      headers: eventHeaders({ session, correlationId: noEventOverviewCorrelation })
    });
    expect(noEventOverviewResponse.status).toBe(200);
    expect(workspaceOverviewReadResultSchema.parse(
      await noEventOverviewResponse.json()
    )).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        event: { kind: 'no_event', eventSetVersion: 1 },
        metrics: {
          forms: { kind: 'unavailable', reason: 'event_required' },
          submissions: { kind: 'unavailable', reason: 'event_required' },
          programVocabulary: { kind: 'unavailable', reason: 'event_required' },
          changesets: { kind: 'unavailable', reason: 'event_required' }
        }
      },
      correlationId: noEventOverviewCorrelation
    });

    const noEventTriageCorrelation = crypto.randomUUID();
    const noEventTriageResponse = await runtime.app.request(
      '/api/events/current/submissions/triage',
      { headers: eventHeaders({ session, correlationId: noEventTriageCorrelation }) }
    );
    expect(noEventTriageResponse.status).toBe(200);
    expect(submissionTriageListOperationResultSchema.parse(
      await noEventTriageResponse.json()
    )).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'submission_triage.event_required',
        retryable: false
      },
      correlationId: noEventTriageCorrelation
    });

    const callerAuthorityResponse = await runtime.app.request('/api/events/drafts/create', {
      method: 'POST',
      headers: eventHeaders({
        session,
        correlationId: crypto.randomUUID(),
        idempotencyKey: 'caller-authority-rejection',
        origin: config.baseUrl
      }),
      body: JSON.stringify({
        name: eventInput.name,
        timezone: eventInput.timezone,
        startDate: eventInput.startDate,
        endDate: eventInput.endDate,
        workspaceId: runtime.workspaceId,
        createdByUserId: appUserId,
        authority: 'event.manage'
      })
    });
    expect(callerAuthorityResponse.status).toBe(400);
    expect(await callerAuthorityResponse.json()).toMatchObject({
      kind: 'transport_error', code: 'invalid_request', retryable: false
    });
    expect(count(runtime, 'foundation_trial_operation_receipts')).toBe(0);
    expect(count(runtime, 'event_spine_heads')).toBe(0);

    const draftKey = 'create-first-event-from-browser-draft';
    const draftCorrelation = crypto.randomUUID();
    const draftBody = {
      name: eventInput.name,
      timezone: eventInput.timezone,
      startDate: eventInput.startDate,
      endDate: eventInput.endDate
    };
    const draftResponse = await runtime.app.request('/api/events/drafts/create', {
      method: 'POST',
      headers: eventHeaders({
        session, correlationId: draftCorrelation,
        idempotencyKey: draftKey, origin: config.baseUrl
      }),
      body: JSON.stringify(draftBody)
    });
    expect(draftResponse.status).toBe(200);
    const drafted = eventCreateDraftOperationResultSchema.parse(await draftResponse.json());
    expect(drafted).toMatchObject({
      kind: 'success',
      data: {
        action: 'create', headVersion: 1,
        safeDiff: {
          before: null,
          after: {
            name: eventInput.name,
            timezone: eventInput.timezone,
            startDate: eventInput.startDate,
            endDate: eventInput.endDate,
            version: 1
          },
          eventSetVersion: { before: 1, after: 2 }
        }
      },
      correlationId: draftCorrelation,
      receipt: { operationName: 'event.create.draft', operationVersion: 1 }
    });
    if (drafted.kind !== 'success') throw new Error('Event draft failed.');
    expect(count(runtime, 'event_spine_heads')).toBe(0);
    expect(count(runtime, 'changeset_heads')).toBe(1);
    expect(count(runtime, 'event_create_draft_receipt_links')).toBe(1);
    expect(count(runtime, 'event_create_draft_timeline')).toBe(1);

    const replayResponse = await runtime.app.request('/api/events/drafts/create', {
      method: 'POST',
      headers: eventHeaders({
        session, correlationId: crypto.randomUUID(),
        idempotencyKey: draftKey, origin: config.baseUrl
      }),
      body: JSON.stringify(draftBody)
    });
    expect(replayResponse.status).toBe(200);
    expect(eventCreateDraftOperationResultSchema.parse(await replayResponse.json())).toEqual(drafted);

    const conflictCorrelation = crypto.randomUUID();
    const conflictResponse = await runtime.app.request('/api/events/drafts/create', {
      method: 'POST',
      headers: eventHeaders({
        session, correlationId: conflictCorrelation,
        idempotencyKey: draftKey, origin: config.baseUrl
      }),
      body: JSON.stringify({ ...draftBody, name: 'Changed request under the same key' })
    });
    expect(conflictResponse.status).toBe(200);
    expect(eventCreateDraftOperationResultSchema.parse(await conflictResponse.json())).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' },
      correlationId: conflictCorrelation
    });

    const selector = {
      changesetId: drafted.data.changesetId,
      revisionId: drafted.data.revision.id,
      revisionDigest: drafted.data.revision.digestSha256
    };
    const diffResponse = await runtime.app.request(
      `/api/changesets/diff?${new URLSearchParams(selector).toString()}`,
      { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
    );
    expect(changesetDiffOperationResultSchema.parse(await diffResponse.json())).toMatchObject({
      kind: 'success',
      data: {
        changesetId: selector.changesetId,
        headVersion: 1,
        status: 'draft',
        operations: [{ kind: 'event.creation' }]
      }
    });

    const lifecycle = await commitDraft({
      runtime, session, key: 'create-first-event-from-browser', draft: drafted
    });
    expect(lifecycle.committed).toMatchObject({
      kind: 'success', data: { action: 'commit', committedHeadVersion: 3 },
      receipt: { operationName: 'changeset.commit', operationVersion: 1 }
    });

    const currentCorrelation = crypto.randomUUID();
    const currentResponse = await runtime.app.request('/api/events/current', {
      headers: eventHeaders({ session, correlationId: currentCorrelation })
    });
    expect(currentEventReadResultSchema.parse(await currentResponse.json())).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1, kind: 'current_event', eventSetVersion: 2,
        event: drafted.data.safeDiff.after
      },
      correlationId: currentCorrelation
    });

    const fieldRegistryResponse = await runtime.app.request(
      '/api/events/current/field-registry',
      { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
    );
    expect(fieldRegistryResponse.status).toBe(200);
    const fieldRegistrySnapshot = fieldRegistrySnapshotReadResultSchema.parse(
      await fieldRegistryResponse.json()
    );
    expect(fieldRegistrySnapshot).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        version: 1
      }
    });
    if (fieldRegistrySnapshot.kind !== 'success') {
      throw new TypeError('field_registry_baseline_missing');
    }
    expect(fieldRegistrySnapshot.data.fields).toHaveLength(19);
    expect(fieldRegistrySnapshot.data.fields.find((field) => field.key === 'person.email'))
      .toMatchObject({
        kind: 'email',
        constraints: { applyVisibility: 'required_visible', removal: 'forbidden' }
      });

    const emptyTriageCorrelation = crypto.randomUUID();
    const emptyTriageResponse = await runtime.app.request(
      '/api/events/current/submissions/triage',
      { headers: eventHeaders({ session, correlationId: emptyTriageCorrelation }) }
    );
    expect(emptyTriageResponse.status).toBe(200);
    expect(submissionTriageListOperationResultSchema.parse(
      await emptyTriageResponse.json()
    )).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'submission_triage.not_initialized',
        retryable: false
      },
      correlationId: emptyTriageCorrelation
    });

    const currentOverviewCorrelation = crypto.randomUUID();
    const currentOverviewResponse = await runtime.app.request('/api/workspace/overview', {
      headers: eventHeaders({ session, correlationId: currentOverviewCorrelation })
    });
    expect(currentOverviewResponse.status).toBe(200);
    expect(workspaceOverviewReadResultSchema.parse(
      await currentOverviewResponse.json()
    )).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        event: { kind: 'current_event', eventSetVersion: 2 },
        metrics: {
          forms: { kind: 'exact', total: 0, draft: 0, open: 0, closed: 0 },
          submissions: { kind: 'exact', total: 0 },
          programVocabulary: {
            kind: 'exact',
            rooms: { total: 0, active: 0, retired: 0 },
            tracks: { total: 0, active: 0, retired: 0 },
            formats: { total: 0, active: 0, retired: 0 }
          },
          changesets: {
            kind: 'exact', total: 0, draft: 0, proposed: 0, committed: 0, discarded: 0
          }
        },
        history: {
          total: 1,
          truncated: false,
          threads: [{
            domain: 'event',
            root: {
              kind: 'changeset',
              changesetId: selector.changesetId,
              status: 'committed'
            }
          }]
        }
      },
      correlationId: currentOverviewCorrelation
    });

    expect(count(runtime, 'event_spine_heads')).toBe(1);
    expect(count(runtime, 'event_spine_create_links')).toBe(0);
    expect(count(runtime, 'event_spine_create_plans')).toBe(0);
    expect(count(runtime, 'event_creation_changeset_receipt_links')).toBe(2);
    expect(count(runtime, 'event_creation_changeset_domain_facts')).toBe(1);
    expect(count(runtime, 'event_creation_changeset_outbox_pointers')).toBe(1);
    expect(count(runtime, 'event_creation_changeset_timeline')).toBe(2);
    expect(count(runtime, 'changeset_commit_links')).toBe(1);

    const beforeReplayReceipts = count(runtime, 'foundation_trial_operation_receipts');
    const replayCommit = await effect({
      runtime,
      session,
      path: '/api/changesets/commits',
      key: 'create-first-event-from-browser-commit',
      body: { ...selector, expectedHeadVersion: 2 },
      parse: changesetLifecycleOperationResultSchema.parse
    });
    expect(replayCommit).toEqual(lifecycle.committed);
    expect(count(runtime, 'foundation_trial_operation_receipts')).toBe(beforeReplayReceipts);

    runtime.database.sqlite.query(`
      UPDATE workspace_memberships
         SET status = 'suspended', version = version + 1, updated_at = ?
       WHERE workspace_id = ? AND user_id = ?
    `).run(Date.now(), runtime.workspaceId, appUserId);
    const revoked = await effect({
      runtime,
      session,
      path: '/api/changesets/commits',
      key: 'create-first-event-from-browser-commit',
      body: { ...selector, expectedHeadVersion: 2 },
      parse: changesetLifecycleOperationResultSchema.parse
    });
    expect(revoked).toMatchObject({
      kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
    });
    expect(count(runtime, 'event_spine_heads')).toBe(1);
  });

  test('serves the empty reviewer roster and the organizer Review snapshot to the owner because durable event.manage evidence resolves the organizer viewer', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);
    await createEventThroughChangeset({ runtime, session, key: 'review-join-event' });

    const rosterResponse = await runtime.app.request('/api/events/current/reviewer-roster', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(rosterResponse.status).toBe(200);
    expect(
      reviewerRosterSnapshotReadResultSchema.parse(await rosterResponse.json())
    ).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        scope: { workspaceId: runtime.workspaceId },
        reviewers: []
      }
    });

    // The roster is empty, so the reviewer match (which always wins) cannot
    // apply; the owner still reaches the organizer view only because the
    // workspace-admin grant carries real event.manage evidence at this event
    // scope. The snapshot lane's event.read+submission.read authority alone
    // must never produce the organizer whole-population view.
    const snapshotResponse = await runtime.app.request('/api/events/current/review/snapshot', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(snapshotResponse.status).toBe(200);
    expect(reviewSnapshotReadResultSchema.parse(await snapshotResponse.json())).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        viewer: { kind: 'organizer' },
        plans: [],
        roundSetup: {
          activeReviewers: 0,
          invitedReviewers: 0,
          submissions: 0,
          expectedReviews: 0,
          perReviewer: []
        },
        standings: {}
      }
    });
  });

  test('keeps a rostered reviewer on the reviewer view even though the same principal holds event.manage', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    const appUserId = await provisionOwner(runtime, session);
    await createEventThroughChangeset({ runtime, session, key: 'roster-wins-event' });

    const membership = runtime.database.sqlite.query<
      { readonly id: string; readonly version: number },
      [string, string]
    >(`
      SELECT id, version FROM workspace_memberships
       WHERE workspace_id = ? AND user_id = ? AND status = 'active'
    `).get(runtime.workspaceId, appUserId);
    if (!membership) throw new Error('owner membership missing');

    const roster = reviewerRosterSnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/reviewer-roster', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (roster.kind !== 'success') throw new Error('roster snapshot unavailable');

    const draft = reviewerRosterChangeDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/reviewer-roster/drafts',
      key: 'roster-wins-register',
      body: {
        action: 'register',
        reviewerId: crypto.randomUUID(),
        accessSubject: {
          kind: 'workspace_membership',
          id: membership.id,
          version: membership.version
        },
        reviews: [],
        expectedRosterVersion: roster.data.rosterVersion,
        expectedRosterDigestSha256: roster.data.rosterDigestSha256
      },
      parse: (value) => value
    }));
    expect(draft).toMatchObject({ kind: 'success', data: { action: 'register' } });
    if (draft.kind !== 'success') throw new Error('roster draft failed');
    await commitDraft({ runtime, session, key: 'roster-wins', draft });

    // The owner still holds workspace-admin event.manage, which resolved the
    // organizer view before registration. The roster match must win now: a
    // rostered reviewer keeps the blind-round reviewer view no matter what
    // additional grants the same principal carries.
    const snapshot = reviewSnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/review/snapshot', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(snapshot).toMatchObject({
      kind: 'success',
      data: { viewer: { kind: 'reviewer', reviewerId: draft.data.reviewerId } }
    });

    // The duplicate-subject guard refuses a second registration typed instead
    // of dying on the retained-records unique constraint: the double roster
    // row would make acting-reviewer resolution ambiguous and hand the
    // organizer view back to a reviewer holding event.manage.
    const refreshed = reviewerRosterSnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/reviewer-roster', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (refreshed.kind !== 'success') throw new Error('roster snapshot unavailable');
    const duplicate = reviewerRosterChangeDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/reviewer-roster/drafts',
      key: 'roster-wins-duplicate',
      body: {
        action: 'register',
        reviewerId: crypto.randomUUID(),
        accessSubject: {
          kind: 'workspace_membership',
          id: membership.id,
          version: membership.version
        },
        reviews: [],
        expectedRosterVersion: refreshed.data.rosterVersion,
        expectedRosterDigestSha256: refreshed.data.rosterDigestSha256
      },
      parse: (value) => value
    }));
    expect(duplicate).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'stale_revision', detail: { code: 'reviewer_exists' } }
    });
  });

  test('creates, updates, and clears the current Event deadline through the shared lifecycle', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);

    const noEventResponse = await runtime.app.request('/api/events/current/deadlines', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(noEventResponse.status).toBe(200);
    expect(deadlineListReadResultSchema.parse(await noEventResponse.json())).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'conflict', kind: 'deadline.event_required', retryable: false }
    });

    await createEventThroughChangeset({ runtime, session, key: 'deadline-event' });

    const initialCatalogResponse = await runtime.app.request('/api/events/current/deadlines', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(initialCatalogResponse.status).toBe(200);
    expect(deadlineListReadResultSchema.parse(await initialCatalogResponse.json())).toMatchObject({
      kind: 'success', data: { schemaVersion: 1, version: 1, deadlines: [] }
    });

    const createDraft = deadlineDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/deadlines/drafts',
      key: 'deadline-create-draft',
      body: { action: 'create', displayDate: '2027-02-01' },
      parse: (value) => value
    }));
    expect(createDraft).toMatchObject({
      kind: 'success',
      data: {
        action: 'create', headVersion: 1,
        safeDiff: {
          action: 'create', before: null,
          after: { status: 'active', version: 1, displayDate: '2027-02-01' },
          representedConsequences: ['deadline_changed']
        }
      },
      receipt: { operationName: 'deadline.change.draft', operationVersion: 1 }
    });
    if (createDraft.kind !== 'success') throw new Error('Deadline create draft failed.');
    const deadlineId = createDraft.data.safeDiff.after.id;
    expect(count(runtime, 'deadlines')).toBe(0);
    await commitDraft({ runtime, session, key: 'deadline-create', draft: createDraft });

    const currentAfterCreateResponse = await runtime.app.request(
      `/api/events/current/deadlines/current?${new URLSearchParams({ deadlineId }).toString()}`,
      { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
    );
    expect(currentAfterCreateResponse.status).toBe(200);
    expect(deadlineGetReadResultSchema.parse(await currentAfterCreateResponse.json())).toMatchObject({
      kind: 'success',
      data: { deadline: { id: deadlineId, status: 'active', version: 1, displayDate: '2027-02-01' } }
    });

    const updateDraft = deadlineDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/deadlines/drafts',
      key: 'deadline-update-draft',
      body: { action: 'update', deadlineId, expectedVersion: 1, displayDate: '2027-02-02' },
      parse: (value) => value
    }));
    expect(updateDraft).toMatchObject({
      kind: 'success',
      data: {
        action: 'update',
        safeDiff: {
          before: { id: deadlineId, status: 'active', version: 1, displayDate: '2027-02-01' },
          after: { id: deadlineId, status: 'active', version: 2, displayDate: '2027-02-02' }
        }
      }
    });
    if (updateDraft.kind !== 'success') throw new Error('Deadline update draft failed.');
    await commitDraft({ runtime, session, key: 'deadline-update', draft: updateDraft });

    const clearDraft = deadlineDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/deadlines/drafts',
      key: 'deadline-clear-draft',
      body: { action: 'clear', deadlineId, expectedVersion: 2 },
      parse: (value) => value
    }));
    expect(clearDraft).toMatchObject({
      kind: 'success',
      data: {
        action: 'clear',
        safeDiff: {
          before: { id: deadlineId, status: 'active', version: 2, displayDate: '2027-02-02' },
          after: { id: deadlineId, status: 'cleared', version: 3, displayDate: null }
        }
      }
    });
    if (clearDraft.kind !== 'success') throw new Error('Deadline clear draft failed.');
    await commitDraft({ runtime, session, key: 'deadline-clear', draft: clearDraft });

    const finalCatalogResponse = await runtime.app.request('/api/events/current/deadlines', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(finalCatalogResponse.status).toBe(200);
    expect(deadlineListReadResultSchema.parse(await finalCatalogResponse.json())).toMatchObject({
      kind: 'success',
      data: {
        version: 4,
        deadlines: [{ id: deadlineId, status: 'cleared', version: 3, displayDate: null }]
      }
    });
    const currentAfterClearResponse = await runtime.app.request(
      `/api/events/current/deadlines/current?${new URLSearchParams({ deadlineId }).toString()}`,
      { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
    );
    expect(deadlineGetReadResultSchema.parse(await currentAfterClearResponse.json())).toMatchObject({
      kind: 'success', data: { deadline: null }
    });
    expect(count(runtime, 'deadlines')).toBe(1);
    expect(count(runtime, 'deadline_draft_receipt_links')).toBe(3);
    expect(count(runtime, 'deadline_changeset_domain_facts')).toBe(3);
    expect(count(runtime, 'deadline_changeset_outbox_pointers')).toBe(3);
  });

  test('initializes and updates current Event settings through the shared changeset lifecycle', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);

    const noEventCorrelation = crypto.randomUUID();
    const noEventResponse = await runtime.app.request('/api/events/current/settings', {
      headers: eventHeaders({ session, correlationId: noEventCorrelation })
    });
    expect(noEventResponse.status).toBe(200);
    expect(currentEventSettingsReadResultSchema.parse(
      await noEventResponse.json()
    )).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'event.settings.event_required',
        retryable: false
      },
      correlationId: noEventCorrelation
    });

    const event = await createEventThroughChangeset({
      runtime, session, key: 'event-settings-event'
    });
    const eventId = event.draft.data.safeDiff.after.id;

    const initialCorrelation = crypto.randomUUID();
    const initialResponse = await runtime.app.request('/api/events/current/settings', {
      headers: eventHeaders({ session, correlationId: initialCorrelation })
    });
    expect(initialResponse.status).toBe(200);
    expect(currentEventSettingsReadResultSchema.parse(
      await initialResponse.json()
    )).toEqual({
      kind: 'success',
      data: {
        schemaVersion: 1,
        eventId,
        eventSetVersion: 2,
        eventVersion: 1,
        name: eventInput.name,
        timezone: eventInput.timezone,
        startDate: eventInput.startDate,
        endDate: eventInput.endDate,
        location: '',
        venueNote: '',
        // A newly created Event seeds the schedule-grid geometry defaults, so
        // it can draw a grid from day one (owner-amended 2026-08-14: 15-minute
        // slots, matching the moving UI's rhythm).
        dayStart: '09:00',
        dayEnd: '18:00',
        slotMinutes: 15
      },
      correlationId: initialCorrelation
    });

    const updateBody = Object.freeze({
      expectedEventId: eventId,
      expectedEventSetVersion: 2,
      expectedEventVersion: 1,
      name: 'JooEvents Summit 2027',
      timezone: eventInput.timezone,
      startDate: eventInput.startDate,
      endDate: eventInput.endDate,
      location: 'Suntec Convention Centre',
      venueNote: 'Registration opens on Level 2.',
      dayStart: '09:00',
      dayEnd: '18:00',
      slotMinutes: 30
    });
    const drafted = eventSettingsUpdateDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/settings/drafts/update',
      key: 'event-settings-update-draft',
      body: updateBody,
      parse: (value) => value
    }));
    expect(drafted).toMatchObject({
      kind: 'success',
      data: {
        action: 'update',
        headVersion: 1,
        safeDiff: {
          action: 'update',
          before: { eventId, eventSetVersion: 2, eventVersion: 1 },
          after: {
            eventId, eventSetVersion: 2, eventVersion: 2,
            name: updateBody.name,
            location: updateBody.location,
            venueNote: updateBody.venueNote
          }
        }
      },
      receipt: { operationName: 'event.settings.update.draft', operationVersion: 1 }
    });
    if (drafted.kind !== 'success') throw new Error('Event settings draft failed.');
    expect(count(runtime, 'event_settings_update_draft_receipt_links')).toBe(1);

    await commitDraft({
      runtime, session, key: 'event-settings-update', draft: drafted
    });

    const updatedCorrelation = crypto.randomUUID();
    const updatedResponse = await runtime.app.request('/api/events/current/settings', {
      headers: eventHeaders({ session, correlationId: updatedCorrelation })
    });
    expect(updatedResponse.status).toBe(200);
    expect(currentEventSettingsReadResultSchema.parse(
      await updatedResponse.json()
    )).toEqual({
      kind: 'success',
      data: {
        schemaVersion: 1,
        eventId,
        eventSetVersion: 2,
        eventVersion: 2,
        name: updateBody.name,
        timezone: updateBody.timezone,
        startDate: updateBody.startDate,
        endDate: updateBody.endDate,
        location: updateBody.location,
        venueNote: updateBody.venueNote,
        // The update deliberately widened the slot size from the seeded 15 to
        // 30, proving geometry rides the ordinary settings update path.
        dayStart: '09:00',
        dayEnd: '18:00',
        slotMinutes: 30
      },
      correlationId: updatedCorrelation
    });

    const currentEvent = currentEventReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(currentEvent).toMatchObject({
      kind: 'success',
      data: {
        kind: 'current_event',
        eventSetVersion: 2,
        event: { id: eventId, version: 2, name: updateBody.name }
      }
    });

    const stale = eventSettingsUpdateDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/settings/drafts/update',
      key: 'event-settings-stale-draft',
      body: updateBody,
      parse: (value) => value
    }));
    expect(stale).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'event.settings_changed',
        retryable: false
      }
    });
    expect(count(runtime, 'event_settings_changeset_domain_facts')).toBe(1);
    expect(count(runtime, 'event_settings_changeset_outbox_pointers')).toBe(1);
    expect(count(runtime, 'event_settings_changeset_receipt_links')).toBe(2);
  });

  test('joins current Event scope to inert Program Vocabulary drafts and keeps read/manage authority distinct', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    const appUserId = await provisionOwner(runtime, session);

    const noEventCorrelation = crypto.randomUUID();
    const noEvent = await runtime.app.request('/api/events/current/program-vocabulary', {
      headers: eventHeaders({ session, correlationId: noEventCorrelation })
    });
    expect(noEvent.status).toBe(200);
    expect(programVocabularySnapshotReadResultSchema.parse(await noEvent.json())).toEqual({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'program_vocabulary.event_required',
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      },
      correlationId: noEventCorrelation
    });

    const event = await createEventThroughChangeset({
      runtime, session, key: 'program-vocabulary-event'
    });

    const readCorrelation = crypto.randomUUID();
    const emptyRead = await runtime.app.request('/api/events/current/program-vocabulary', {
      headers: eventHeaders({ session, correlationId: readCorrelation })
    });
    expect(emptyRead.status).toBe(200);
    expect(programVocabularySnapshotReadResultSchema.parse(await emptyRead.json())).toEqual({
      kind: 'success',
      data: {
        schemaVersion: 1,
        scope: { workspaceId: runtime.workspaceId, eventId: event.draft.data.safeDiff.after.id },
        setVersion: 1,
        rooms: [],
        tracks: [],
        formats: []
      },
      correlationId: readCorrelation
    });

    const draftCorrelation = crypto.randomUUID();
    const draftResponse = await runtime.app.request(
      '/api/events/current/program-vocabulary/drafts/create',
      {
        method: 'POST',
        headers: eventHeaders({
          session,
          correlationId: draftCorrelation,
          idempotencyKey: 'program-vocabulary-room-draft',
          origin: config.baseUrl
        }),
        body: JSON.stringify({
          kind: 'room', expectedSetVersion: 1, name: 'Main Hall', capacity: 250
        })
      }
    );
    expect(draftResponse.status).toBe(200);
    const drafted = programVocabularyDraftOperationResultSchema.parse(await draftResponse.json());
    expect(drafted).toMatchObject({
        kind: 'success',
        data: { action: 'create', status: 'draft', safeDiff: { action: 'create' } },
        correlationId: draftCorrelation,
        receipt: {
          operationName: 'program_vocabulary.create.draft',
          operationVersion: 1
        }
      });
    if (drafted.kind !== 'success') throw new Error('Program Vocabulary draft failed.');
    expect(count(runtime, 'program_vocabulary_sets')).toBe(0);
    expect(count(runtime, 'program_vocabulary_rooms')).toBe(0);
    expect(count(runtime, 'changeset_heads')).toBe(2);
    expect(count(runtime, 'changeset_revisions')).toBe(2);
    expect(count(runtime, 'program_vocabulary_draft_receipt_links')).toBe(1);
    expect(count(runtime, 'program_vocabulary_draft_timeline')).toBe(1);

    const selector = Object.freeze({
      changesetId: drafted.data.changesetId,
      revisionId: drafted.data.revision.id,
      revisionDigest: drafted.data.revision.digestSha256
    });
    const diffCorrelation = crypto.randomUUID();
    const diffQuery = new URLSearchParams(selector).toString();
    const diffResponse = await runtime.app.request(`/api/changesets/diff?${diffQuery}`, {
      headers: eventHeaders({ session, correlationId: diffCorrelation })
    });
    expect(diffResponse.status).toBe(200);
    expect(changesetDiffOperationResultSchema.parse(await diffResponse.json())).toMatchObject({
      kind: 'success',
      data: {
        changesetId: selector.changesetId,
        headVersion: 1,
        status: 'draft',
        revisionId: selector.revisionId,
        revisionDigest: selector.revisionDigest,
        operations: [{ kind: 'program.vocabulary.mutate' }]
      },
      correlationId: diffCorrelation
    });

    const proposeResponse = await runtime.app.request('/api/changesets/proposals', {
      method: 'POST',
      headers: eventHeaders({
        session,
        correlationId: crypto.randomUUID(),
        idempotencyKey: 'program-vocabulary-room-propose',
        origin: config.baseUrl
      }),
      body: JSON.stringify({ ...selector, expectedHeadVersion: 1 })
    });
    expect(proposeResponse.status).toBe(200);
    expect(changesetLifecycleOperationResultSchema.parse(await proposeResponse.json()))
      .toMatchObject({
        kind: 'success',
        data: { action: 'propose', diff: { headVersion: 2, status: 'proposed' } },
        receipt: { operationName: 'changeset.propose', operationVersion: 1 }
      });
    expect(count(runtime, 'program_vocabulary_sets')).toBe(0);
    expect(count(runtime, 'program_vocabulary_rooms')).toBe(0);

    const commitCorrelation = crypto.randomUUID();
    const commitInput = Object.freeze({ ...selector, expectedHeadVersion: 2 });
    const commitResponse = await runtime.app.request('/api/changesets/commits', {
      method: 'POST',
      headers: eventHeaders({
        session,
        correlationId: commitCorrelation,
        idempotencyKey: 'program-vocabulary-room-commit',
        origin: config.baseUrl
      }),
      body: JSON.stringify(commitInput)
    });
    expect(commitResponse.status).toBe(200);
    const committed = changesetLifecycleOperationResultSchema.parse(await commitResponse.json());
    expect(committed).toMatchObject({
      kind: 'success',
      data: { action: 'commit', expectedHeadVersion: 2, committedHeadVersion: 3 },
      correlationId: commitCorrelation,
      receipt: { operationName: 'changeset.commit', operationVersion: 1 }
    });
    if (committed.kind !== 'success') throw new Error('Program Vocabulary commit failed.');
    expect(count(runtime, 'program_vocabulary_sets')).toBe(1);
    expect(count(runtime, 'program_vocabulary_rooms')).toBe(1);
    expect(count(runtime, 'changeset_lifecycle_domain_facts')).toBe(1);
    expect(count(runtime, 'changeset_lifecycle_outbox_pointers')).toBe(1);
    expect(count(runtime, 'changeset_lifecycle_effect_receipt_links')).toBe(2);

    const committedRead = programVocabularySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/program-vocabulary', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(committedRead).toMatchObject({
      kind: 'success',
      data: {
        setVersion: 2,
        rooms: [{ name: 'Main Hall', capacity: 250, status: 'active', version: 1 }]
      }
    });

    const replayCorrelation = crypto.randomUUID();
    const replayResponse = await runtime.app.request('/api/changesets/commits', {
      method: 'POST',
      headers: eventHeaders({
        session,
        correlationId: replayCorrelation,
        idempotencyKey: 'program-vocabulary-room-commit',
        origin: config.baseUrl
      }),
      body: JSON.stringify(commitInput)
    });
    expect(replayResponse.headers.get('x-correlation-id')).toBe(replayCorrelation);
    expect(changesetLifecycleOperationResultSchema.parse(await replayResponse.json()))
      .toEqual(committed);

    const correctionResponse = await runtime.app.request('/api/changesets/corrections', {
      method: 'POST',
      headers: eventHeaders({
        session,
        correlationId: crypto.randomUUID(),
        idempotencyKey: 'program-vocabulary-room-correction',
        origin: config.baseUrl
      }),
      body: JSON.stringify({
        sourceChangesetId: selector.changesetId,
        sourceRevisionId: selector.revisionId,
        sourceRevisionDigest: selector.revisionDigest,
        sourceCommitReceiptId: committed.receipt.id
      })
    });
    expect(correctionResponse.status).toBe(200);
    const correction = changesetLifecycleOperationResultSchema.parse(
      await correctionResponse.json()
    );
    expect(correction).toMatchObject({
      kind: 'success',
      data: { action: 'correction', resultKind: 'exact', target: { status: 'draft' } },
      receipt: { operationName: 'changeset.correction.draft', operationVersion: 1 }
    });
    if (correction.kind !== 'success'
        || correction.data.action !== 'correction'
        || correction.data.target === null) {
      throw new Error('Program Vocabulary correction draft failed.');
    }
    const correctionSelector = Object.freeze({
      changesetId: correction.data.target.changesetId,
      revisionId: correction.data.target.revisionId,
      revisionDigest: correction.data.target.revisionDigest
    });
    const correctionProposal = changesetLifecycleOperationResultSchema.parse(await (
      await runtime.app.request('/api/changesets/proposals', {
        method: 'POST',
        headers: eventHeaders({
          session,
          correlationId: crypto.randomUUID(),
          idempotencyKey: 'program-vocabulary-room-correction-propose',
          origin: config.baseUrl
        }),
        body: JSON.stringify({
          ...correctionSelector,
          expectedHeadVersion: correction.data.target.headVersion
        })
      })
    ).json());
    expect(correctionProposal).toMatchObject({
      kind: 'success',
      data: { action: 'propose', diff: { status: 'proposed' } }
    });
    if (correctionProposal.kind !== 'success'
        || correctionProposal.data.action !== 'propose') {
      throw new Error('Program Vocabulary correction proposal failed.');
    }
    const correctionCommit = changesetLifecycleOperationResultSchema.parse(await (
      await runtime.app.request('/api/changesets/commits', {
        method: 'POST',
        headers: eventHeaders({
          session,
          correlationId: crypto.randomUUID(),
          idempotencyKey: 'program-vocabulary-room-correction-commit',
          origin: config.baseUrl
        }),
        body: JSON.stringify({
          ...correctionSelector,
          expectedHeadVersion: correctionProposal.data.diff.headVersion
        })
      })
    ).json());
    expect(correctionCommit).toMatchObject({
      kind: 'success',
      data: { action: 'commit' },
      receipt: { operationName: 'changeset.commit', operationVersion: 1 }
    });
    expect(programVocabularySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/program-vocabulary', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json())).toMatchObject({
      kind: 'success',
      data: { setVersion: 3, rooms: [] }
    });
    expect(count(runtime, 'changeset_correction_links')).toBe(1);
    expect(count(runtime, 'changeset_lifecycle_domain_facts')).toBe(2);
    expect(count(runtime, 'changeset_lifecycle_outbox_pointers')).toBe(2);

    expect(runtime.database.sqlite.query<{ readonly count: number }, []>(`
      SELECT count(*) AS count
        FROM roles AS roles
        JOIN role_permissions AS permissions ON permissions.role_id = roles.id
       WHERE roles.source_preset_key = 'workspace_admin'
         AND permissions.permission_id = 'program.vocabulary.manage'
    `).get()?.count).toBe(0);
    expect(runtime.database.sqlite.query<{ readonly count: number }, [string]>(`
      SELECT count(*) AS count FROM permission_overrides
       WHERE user_id = ? AND permission_id = 'program.vocabulary.manage'
         AND effect = 'grant' AND scope_kind = 'workspace' AND event_id IS NULL
    `).get(appUserId)?.count).toBe(1);
    expect(runtime.database.sqlite.query<{ readonly count: number }, []>(`
      SELECT count(*) AS count
        FROM roles AS roles
        JOIN role_permissions AS permissions ON permissions.role_id = roles.id
       WHERE roles.source_preset_key = 'workspace_admin'
         AND permissions.permission_id = 'communication.provider.manage'
    `).get()?.count).toBe(0);
    expect(runtime.database.sqlite.query<{ readonly count: number }, [string]>(`
      SELECT count(*) AS count FROM permission_overrides
       WHERE user_id = ? AND permission_id = 'communication.provider.manage'
         AND effect = 'grant' AND scope_kind = 'workspace' AND event_id IS NULL
    `).get(appUserId)?.count).toBe(1);

    const readerRoleId = crypto.randomUUID();
    const now = Date.now();
    runtime.database.sqlite.query(`
      INSERT INTO roles (
        id, workspace_id, name, description, created_at, updated_at, version
      ) VALUES (?, ?, 'Foundation Reader', 'Read-only joined runtime proof', ?, ?, 1)
    `).run(readerRoleId, runtime.workspaceId, now, now);
    runtime.database.sqlite.query(`
      INSERT INTO role_permissions (role_id, permission_id) VALUES (?, 'event.read')
    `).run(readerRoleId);
    runtime.database.sqlite.query(`
      DELETE FROM role_assignments WHERE workspace_id = ? AND user_id = ?
    `).run(runtime.workspaceId, appUserId);
    runtime.database.sqlite.query(`
      INSERT INTO role_assignments (
        id, user_id, role_id, workspace_id, scope_kind, event_id, assigned_at, version
      ) VALUES (?, ?, ?, ?, 'workspace', NULL, ?, 1)
    `).run(crypto.randomUUID(), appUserId, readerRoleId, runtime.workspaceId, now);
    runtime.database.sqlite.query(`
      DELETE FROM permission_overrides
       WHERE workspace_id = ? AND user_id = ?
         AND permission_id IN ('program.vocabulary.manage', 'communication.provider.manage')
    `).run(runtime.workspaceId, appUserId);

    const readerProgramRead = await runtime.app.request('/api/events/current/program-vocabulary', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(programVocabularySnapshotReadResultSchema.parse(await readerProgramRead.json()).kind)
      .toBe('success');
    const readerFormRead = await runtime.app.request('/api/events/current/forms', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(await readerFormRead.json()).toMatchObject({
      kind: 'success',
      data: { schemaVersion: 1, catalogVersion: 1, forms: [] }
    });
    const deniedProviderRead = emailProviderReadinessReadOperationResultSchema.parse(await (
      await runtime.app.request('/api/communications/email-readiness', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(deniedProviderRead).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'access_denied', kind: 'authority.not_authorized' }
    });

    const deniedEvent = eventCreateDraftOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/drafts/create', {
        method: 'POST',
        headers: eventHeaders({
          session,
          correlationId: crypto.randomUUID(),
          idempotencyKey: 'reader-cannot-manage-event',
          origin: config.baseUrl
        }),
        body: JSON.stringify({
          name: eventInput.name,
          timezone: eventInput.timezone,
          startDate: eventInput.startDate,
          endDate: eventInput.endDate
        })
      })
    ).json());
    expect(deniedEvent).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'access_denied', kind: 'authority.not_authorized' }
    });

    const deniedDraft = programVocabularyDraftOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/program-vocabulary/drafts/create', {
        method: 'POST',
        headers: eventHeaders({
          session,
          correlationId: crypto.randomUUID(),
          idempotencyKey: 'reader-cannot-manage-vocabulary',
          origin: config.baseUrl
        }),
        body: JSON.stringify({
          kind: 'room', expectedSetVersion: 1, name: 'Reader Hall', capacity: null
        })
      })
    ).json());
    expect(deniedDraft).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'access_denied', kind: 'authority.not_authorized' }
    });
    const deniedFormDraft = intakeFormDraftOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/forms/drafts/create', {
        method: 'POST',
        headers: eventHeaders({
          session,
          correlationId: crypto.randomUUID(),
          idempotencyKey: 'reader-cannot-manage-form',
          origin: config.baseUrl
        }),
        body: JSON.stringify({
          expectedCatalogVersion: 1,
          expectedRegistryVersion: 1,
          definition: formDefinitionInput
        })
      })
    ).json());
    expect(deniedFormDraft).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'access_denied', kind: 'authority.not_authorized' }
    });
    expect(count(runtime, 'changeset_heads')).toBe(3);
    expect(count(runtime, 'program_vocabulary_rooms')).toBe(0);
  });

  test('mounts Schedule placement truth without inventing a canonical Session owner', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    const appUserId = await provisionOwner(runtime, session);
    const range = '?startAt=2027-06-10T08%3A00%3A00.000Z'
      + '&endAt=2027-06-10T18%3A00%3A00.000Z&limit=20';

    const noEventCorrelation = crypto.randomUUID();
    const noEventResponse = await runtime.app.request(
      `/api/events/current/schedule/placements${range}`,
      { headers: eventHeaders({ session, correlationId: noEventCorrelation }) }
    );
    expect(noEventResponse.status).toBe(200);
    expect(schedulePlacementSnapshotReadResultSchema.parse(
      await noEventResponse.json()
    )).toEqual({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'schedule.event_required',
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      },
      correlationId: noEventCorrelation
    });

    const event = await createEventThroughChangeset({
      runtime,
      session,
      key: 'schedule-placement-event'
    });
    const eventId = event.draft.data.safeDiff.after.id;
    const emptyCorrelation = crypto.randomUUID();
    const emptyResponse = await runtime.app.request(
      `/api/events/current/schedule/placements${range}`,
      { headers: eventHeaders({ session, correlationId: emptyCorrelation }) }
    );
    expect(emptyResponse.status).toBe(200);
    expect(schedulePlacementSnapshotReadResultSchema.parse(
      await emptyResponse.json()
    )).toEqual({
      kind: 'success',
      data: {
        schemaVersion: 1,
        scope: { workspaceId: runtime.workspaceId, eventId },
        scheduleVersion: 1,
        occurrences: []
      },
      correlationId: emptyCorrelation
    });
    const overview = workspaceOverviewReadResultSchema.parse(await (
      await runtime.app.request('/api/workspace/overview', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(overview).toMatchObject({
      kind: 'success',
      data: {
        areas: expect.arrayContaining([{
          area: 'schedule',
          status: 'partial',
          availableCapabilities: [
            'release.change.draft',
            'schedule.placement.draft',
            'schedule.placement.snapshot.read',
            'schedule.session.manage',
            'schedule.session.read'
          ],
          unavailableCapabilities: [
            'schedule.break.manage',
            'schedule.placement.unplace'
          ]
        }, {
          area: 'messages',
          status: 'partial',
          availableCapabilities: [
            'communication.email_readiness.read',
            'create_message_draft',
            'discard_message_draft',
            'get_communication_purpose',
            'get_delivery_history',
            'get_message_batch_preview',
            'get_message_draft',
            'get_message_template',
            'list_audience_options',
            'list_communication_purposes',
            'list_message_drafts',
            'list_message_preview_recipients',
            'list_message_templates',
            'prepare_message_batch_preview',
            'preview_message_batch',
            'revise_message_batch',
            'send_messages',
            'store_communication_authoring_payload'
          ],
          unavailableCapabilities: [
            'create_email_provider_connection_draft'
          ]
        }])
      }
    });

    const beforeMissingSession = Object.freeze({
      changesets: count(runtime, 'changeset_heads'),
      draftLinks: count(runtime, 'schedule_placement_draft_receipt_links'),
      receipts: count(runtime, 'foundation_trial_operation_receipts'),
      sets: count(runtime, 'schedule_placement_sets'),
      occurrences: count(runtime, 'schedule_occurrences')
    });
    const missingSession = schedulePlacementDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/schedule/placements/drafts',
      key: 'schedule-placement-session-missing',
      body: {
        action: 'place',
        expectedScheduleVersion: 1,
        sessionId: crypto.randomUUID(),
        roomId: crypto.randomUUID(),
        startAt: '2027-06-10T09:00:00.000Z',
        endAt: '2027-06-10T10:00:00.000Z'
      },
      parse: (value) => value
    }));
    expect(missingSession).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'schedule_placement_changed',
        retryable: false,
        detail: { code: 'session_missing', action: 'place' }
      }
    });
    expect({
      changesets: count(runtime, 'changeset_heads'),
      draftLinks: count(runtime, 'schedule_placement_draft_receipt_links'),
      receipts: count(runtime, 'foundation_trial_operation_receipts'),
      sets: count(runtime, 'schedule_placement_sets'),
      occurrences: count(runtime, 'schedule_occurrences')
    }).toEqual(beforeMissingSession);

    const readerRoleId = crypto.randomUUID();
    const assignedAt = Date.now();
    runtime.database.sqlite.query(`
      INSERT INTO roles (
        id, workspace_id, name, description, created_at, updated_at, version
      ) VALUES (?, ?, 'Schedule Reader', 'Read-only Schedule proof', ?, ?, 1)
    `).run(readerRoleId, runtime.workspaceId, assignedAt, assignedAt);
    runtime.database.sqlite.query(`
      INSERT INTO role_permissions (role_id, permission_id)
      VALUES (?, 'event.read'), (?, 'schedule.read')
    `).run(readerRoleId, readerRoleId);
    runtime.database.sqlite.query(`
      DELETE FROM role_assignments WHERE workspace_id = ? AND user_id = ?
    `).run(runtime.workspaceId, appUserId);
    runtime.database.sqlite.query(`
      INSERT INTO role_assignments (
        id, user_id, role_id, workspace_id, scope_kind, event_id, assigned_at, version
      ) VALUES (?, ?, ?, ?, 'workspace', NULL, ?, 1)
    `).run(crypto.randomUUID(), appUserId, readerRoleId, runtime.workspaceId, assignedAt);

    const readerRead = schedulePlacementSnapshotReadResultSchema.parse(await (
      await runtime.app.request(`/api/events/current/schedule/placements${range}`, {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(readerRead).toMatchObject({
      kind: 'success', data: { scheduleVersion: 1, occurrences: [] }
    });
    const deniedManage = schedulePlacementDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/schedule/placements/drafts',
      key: 'schedule-reader-cannot-place',
      body: {
        action: 'place',
        expectedScheduleVersion: 1,
        sessionId: crypto.randomUUID(),
        roomId: crypto.randomUUID(),
        startAt: '2027-06-10T10:00:00.000Z',
        endAt: '2027-06-10T11:00:00.000Z'
      },
      parse: (value) => value
    }));
    expect(deniedManage).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'access_denied', kind: 'authority.not_authorized' }
    });
    expect(count(runtime, 'schedule_placement_draft_receipt_links')).toBe(0);

    runtime.database.sqlite.query(`
      UPDATE workspace_memberships
         SET status = 'suspended', version = version + 1, updated_at = ?
       WHERE workspace_id = ? AND user_id = ?
    `).run(Date.now(), runtime.workspaceId, appUserId);
    const revokedRead = schedulePlacementSnapshotReadResultSchema.parse(await (
      await runtime.app.request(`/api/events/current/schedule/placements${range}`, {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(revokedRead).toMatchObject({
      kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
    });
    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  });

  test('mounts factual Communications catalogs with the seeded decision-notification defaults and inert classified authoring', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);

    const readinessCorrelation = crypto.randomUUID();
    const readiness = emailProviderReadinessReadOperationResultSchema.parse(await (
      await runtime.app.request('/api/communications/email-readiness', {
        headers: eventHeaders({ session, correlationId: readinessCorrelation })
      })
    ).json());
    expect(readiness).toEqual({
      kind: 'success',
      data: {
        schemaVersion: 1,
        outbound: { state: 'unknown', nextStepCode: 'configure_email_provider' },
        callbacks: { state: 'not_supported' },
        inbound: { state: 'not_enabled' }
      },
      correlationId: readinessCorrelation
    });

    const missingConnectionId = crypto.randomUUID();
    const connectionCorrelation = crypto.randomUUID();
    const missingConnection = emailProviderConfigurationReadOperationResultSchema.parse(await (
      await runtime.app.request(
        `/api/communications/provider-connection?connectionId=${missingConnectionId}`,
        { headers: eventHeaders({ session, correlationId: connectionCorrelation }) }
      )
    ).json());
    expect(missingConnection).toEqual({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'communication.provider_connection_unavailable',
        retryable: false,
        subjects: [{ type: 'communication.provider_connection', id: missingConnectionId }],
        detail: null,
        detailSchemaVersion: 1
      },
      correlationId: connectionCorrelation
    });

    const noEventCorrelation = crypto.randomUUID();
    const noEvent = organizerCommunicationPurposePageOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/communications/purposes', {
        headers: eventHeaders({ session, correlationId: noEventCorrelation })
      })
    ).json());
    expect(noEvent).toEqual({
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'communication.event_required', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      },
      correlationId: noEventCorrelation
    });

    await createEventThroughChangeset({
      runtime, session, key: 'organizer-communication-event'
    });
    // Created events are seeded with the recorded decision-notification
    // defaults (BLOCKED-4/BLOCKED-5/BLOCKED-12): one transactional purpose,
    // two active templates, and the two immutable decision-set audience
    // recipes. Drafts remain empty — nothing authors messages by default.
    const read = async <Value>(path: string, schema: { parse(value: unknown): Value }) =>
      schema.parse(await (
        await runtime.app.request(path, {
          headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
        })
      ).json());
    const purposes = await read(
      '/api/events/current/communications/purposes',
      organizerCommunicationPurposePageOperationResultSchema
    );
    expect(purposes).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        rows: [{
          communicationClass: 'transactional',
          lifecycle: 'active',
          revision: { purposeKey: 'decision_notification', revisionNumber: 1 }
        }],
        page: { hasMore: false }
      }
    });
    const templates = await read(
      '/api/events/current/communications/templates',
      organizerMessageTemplatePageOperationResultSchema
    );
    expect(templates).toMatchObject({
      kind: 'success',
      data: { schemaVersion: 1, page: { hasMore: false } }
    });
    if (templates.kind !== 'success') throw new Error('templates_read_failed');
    expect(templates.data.rows.map((row: { readonly key: string }) => row.key).sort())
      .toEqual(['decision.accepted', 'decision.declined']);
    const drafts = await read(
      '/api/events/current/communications/drafts',
      organizerCommunicationDraftPageOperationResultSchema
    );
    expect(drafts).toMatchObject({
      kind: 'success', data: { schemaVersion: 1, rows: [], page: { hasMore: false } }
    });
    const audienceOptions = await read(
      '/api/events/current/communications/audiences/options',
      organizerCommunicationAudienceOptionPageOperationResultSchema
    );
    expect(audienceOptions).toMatchObject({
      kind: 'success',
      data: { schemaVersion: 1, page: { hasMore: false } }
    });
    if (audienceOptions.kind !== 'success') throw new Error('audience_options_read_failed');
    expect(audienceOptions.data.rows).toHaveLength(2);
    expect(audienceOptions.data.rows.map((row) => {
      const source = row.audienceDraft.source;
      return source.kind === 'registered_query' ? source.recipeId : source.kind;
    }).sort()).toEqual([
      'recipe.communication.decision-set.accepted',
      'recipe.communication.decision-set.declined'
    ]);

    const payloadBody = Object.freeze({
      payload: Object.freeze({
        payloadKind: 'message_content' as const,
        schemaVersion: 1 as const,
        value: Object.freeze({
          kind: 'email/v1' as const,
          subject: 'A factual inert draft payload',
          body: Object.freeze({
            kind: 'plain_text/v1' as const,
            text: 'PRIVATE-COMMUNICATION-RUNTIME-CANARY'
          })
        })
      })
    });
    const payload = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/communications/authoring-payloads',
      key: 'communication-authoring-payload',
      body: payloadBody,
      parse: (value) => value
    }));
    expect(payload).toMatchObject({
      kind: 'success',
      data: { payloadRefVersion: 1, payloadKind: 'message_content' },
      receipt: {
        operationName: 'store_communication_authoring_payload', operationVersion: 1
      }
    });
    const replay = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/communications/authoring-payloads',
      key: 'communication-authoring-payload',
      body: payloadBody,
      parse: (value) => value
    }));
    expect(replay).toEqual(payload);
    // 4 seeded template payload rows (content + bindings for the two
    // decision-notification templates) plus the one stored above.
    expect(count(runtime, 'communication_authoring_payloads')).toBe(5);
    expect(count(runtime, 'organizer_communication_authoring_receipt_links')).toBe(1);
    expect(count(runtime, 'organizer_communication_authoring_timeline')).toBe(1);
    expect(Buffer.from(runtime.database.sqlite.serialize()).includes(
      Buffer.from('PRIVATE-COMMUNICATION-RUNTIME-CANARY')
    )).toBe(false);

    const refused = organizerCommunicationDraftMutationOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/communications/drafts/create',
      key: 'communication-draft-without-purpose',
      body: {
        channel: 'email',
        purposeRevision: {
          purposeId: '019c3400-0000-7000-8000-000000000005',
          purposeKey: 'speaker.update',
          revisionId: '019c3400-0000-7000-8000-000000000006',
          revisionNumber: 1,
          digestSha256: 'a'.repeat(64)
        },
        initial: {
          kind: 'registered_empty_refs',
          contentRefId: 'je.communication.message-draft.empty-content/v1',
          audienceRefId: 'je.communication.message-draft.empty-audience/v1'
        }
      },
      parse: (value) => value
    }));
    expect(refused).toMatchObject({
      kind: 'outcome', terminal: false,
      outcome: {
        class: 'policy_violation', kind: 'communication.authoring_invalid', retryable: false
      }
    });
    expect(count(runtime, 'communication_drafts')).toBe(0);
    expect(count(runtime, 'organizer_communication_authoring_receipt_links')).toBe(1);
  });

  test('joins organizer Form drafts to the shared changeset lifecycle before exposing effective state', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);

    const noEventCorrelation = crypto.randomUUID();
    const noEvent = await runtime.app.request('/api/events/current/forms', {
      headers: eventHeaders({ session, correlationId: noEventCorrelation })
    });
    expect(noEvent.status).toBe(200);
    expect(await noEvent.json()).toEqual({
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'intake.event_required', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      },
      correlationId: noEventCorrelation
    });

    await createEventThroughChangeset({ runtime, session, key: 'intake-form-event' });

    const emptyForms = await runtime.app.request('/api/events/current/forms', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(emptyForms.status).toBe(200);
    const listedEmptyForms = organizerFormCatalogReadResultSchema.parse(
      await emptyForms.json()
    );
    expect(listedEmptyForms).toMatchObject({
      kind: 'success',
      data: { schemaVersion: 1, catalogVersion: 1, forms: [] }
    });
    if (listedEmptyForms.kind !== 'success') {
      throw new Error('Expected an empty Form catalog.');
    }

    const draftResponse = await runtime.app.request('/api/events/current/forms/drafts/create', {
      method: 'POST',
      headers: eventHeaders({
        session,
        correlationId: crypto.randomUUID(),
        idempotencyKey: 'intake-form-create-draft',
        origin: config.baseUrl
      }),
      body: JSON.stringify({
        expectedCatalogVersion: listedEmptyForms.data.catalogVersion,
        expectedRegistryVersion: listedEmptyForms.data.registryPin.version,
        definition: formDefinitionInput
      })
    });
    expect(draftResponse.status).toBe(200);
    const drafted = intakeFormDraftOperationResultSchema.parse(await draftResponse.json());
    expect(drafted).toMatchObject({
      kind: 'success',
      data: { action: 'create', status: 'draft', safeDiff: { action: 'create' } },
      receipt: { operationName: 'form.definition.create.draft', operationVersion: 1 }
    });
    if (drafted.kind !== 'success') throw new Error('Form draft did not succeed.');
    const formId = drafted.data.safeDiff.after.id;
    expect(count(runtime, 'intake_form_heads')).toBe(0);
    expect(count(runtime, 'intake_form_draft_receipt_links')).toBe(1);
    expect(count(runtime, 'intake_form_draft_timeline')).toBe(1);
    expect(await (await runtime.app.request('/api/events/current/forms', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    })).json()).toMatchObject({
      kind: 'success', data: { schemaVersion: 1, catalogVersion: 1, forms: [] }
    });

    const selector = Object.freeze({
      changesetId: drafted.data.changesetId,
      revisionId: drafted.data.revision.id,
      revisionDigest: drafted.data.revision.digestSha256
    });
    const propose = await runtime.app.request('/api/changesets/proposals', {
      method: 'POST',
      headers: eventHeaders({
        session,
        correlationId: crypto.randomUUID(),
        idempotencyKey: 'intake-form-create-propose',
        origin: config.baseUrl
      }),
      body: JSON.stringify({ ...selector, expectedHeadVersion: 1 })
    });
    expect(changesetLifecycleOperationResultSchema.parse(await propose.json())).toMatchObject({
      kind: 'success', data: { action: 'propose', diff: { status: 'proposed' } }
    });
    expect(count(runtime, 'intake_form_heads')).toBe(0);

    const commit = await runtime.app.request('/api/changesets/commits', {
      method: 'POST',
      headers: eventHeaders({
        session,
        correlationId: crypto.randomUUID(),
        idempotencyKey: 'intake-form-create-commit',
        origin: config.baseUrl
      }),
      body: JSON.stringify({ ...selector, expectedHeadVersion: 2 })
    });
    expect(changesetLifecycleOperationResultSchema.parse(await commit.json())).toMatchObject({
      kind: 'success', data: { action: 'commit', committedHeadVersion: 3 }
    });
    expect(count(runtime, 'intake_form_heads')).toBe(1);
    expect(count(runtime, 'intake_form_versions')).toBe(0);
    expect(count(runtime, 'intake_form_changeset_receipt_links')).toBe(2);
    expect(count(runtime, 'intake_form_changeset_timeline')).toBe(2);

    const forms = await runtime.app.request('/api/events/current/forms', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(await forms.json()).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        catalogVersion: 2,
        forms: [{ id: formId, name: 'Main CFP', status: 'draft', submissionCount: 0 }]
      }
    });
    const detail = await runtime.app.request(
      `/api/events/current/forms/detail?formId=${encodeURIComponent(formId)}`,
      { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
    );
    expect(await detail.json()).toMatchObject({
      kind: 'success',
      data: { head: { id: formId, definition: { name: 'Main CFP' } }, currentPublishedVersion: null }
    });
    const submissions = await runtime.app.request('/api/events/current/submissions', {
      headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
    });
    expect(await submissions.json()).toMatchObject({ kind: 'success', data: [] });
    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  });

  test('commits an organizer direct entry through the shared lifecycle into triage and the Review basis', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);
    await createEventThroughChangeset({ runtime, session, key: 'direct-entry-event' });

    const registryResult = fieldRegistrySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/field-registry', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (registryResult.kind !== 'success') throw new Error('Field registry read failed.');
    const registry = registryResult.data;
    const titleFieldId = registry.fields.find((field) =>
      field.mapsTo === 'talk.title' && field.kind === 'text'
    )?.id;
    const emailFieldId = registry.fields.find((field) =>
      field.mapsTo === 'person.email' && field.kind === 'email'
    )?.id;
    if (!titleFieldId || !emailFieldId) throw new Error('Identity fields missing.');
    const included = new Set([titleFieldId, emailFieldId]);
    const createDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/create',
      key: 'direct-entry-form-create-draft',
      body: {
        expectedCatalogVersion: 1,
        expectedRegistryVersion: registry.version,
        definition: {
          ...formDefinitionInput,
          name: 'Direct Entry CFP',
          composition: {
            excludedFieldIds: registry.fields
              .filter((field) => field.scope.kind === 'shared'
                && field.contexts.apply.visible
                && !included.has(field.id))
              .map((field) => field.id)
              .sort(),
            requiredOverrides: {},
            optionExposure: {}
          }
        }
      },
      parse: (value) => value
    }));
    expect(createDraft).toMatchObject({ kind: 'success', data: { action: 'create' } });
    if (createDraft.kind !== 'success' || createDraft.data.safeDiff.action !== 'create') {
      throw new Error('Form create draft failed.');
    }
    await commitDraft({
      runtime, session, key: 'direct-entry-form-create', draft: createDraft
    });
    const openDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/lifecycle',
      key: 'direct-entry-form-open-draft',
      body: {
        transition: 'publish_and_open',
        formId: createDraft.data.safeDiff.after.id,
        expectedDefinitionVersion: 1,
        expectedRegistryVersion: registry.version
      },
      parse: (value) => value
    }));
    expect(openDraft).toMatchObject({ kind: 'success', data: { action: 'lifecycle' } });
    if (openDraft.kind !== 'success') throw new Error('Form open draft failed.');
    await commitDraft({ runtime, session, key: 'direct-entry-form-open', draft: openDraft });

    // The wire input pins the form identity and definition version the
    // organizer actually read, not draft outputs.
    const catalog = organizerFormCatalogReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/forms', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (catalog.kind !== 'success') throw new Error('Form catalog read failed.');
    const openForm = catalog.data.forms.find((form) => form.status === 'open');
    if (!openForm) throw new Error('Open form missing from the catalog.');

    const entryDraft = submissionDirectEntryDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/submissions/direct-entry/drafts',
      key: 'direct-entry-submission-draft',
      body: {
        formId: openForm.id,
        expectedFormDefinitionVersion: openForm.version,
        answers: [
          { kind: 'text', fieldId: titleFieldId, value: 'Keyed-in keynote' },
          { kind: 'email', fieldId: emailFieldId, value: 'direct.speaker@example.test' }
        ]
      },
      parse: (value) => value
    }));
    expect(entryDraft).toMatchObject({
      kind: 'success',
      data: {
        action: 'create',
        headVersion: 1,
        status: 'draft',
        safeDiff: {
          action: 'create',
          submission: { formId: openForm.id, source: 'direct_entry' }
        }
      },
      receipt: {
        operationName: 'submission.direct_entry.create.draft',
        operationVersion: 1
      }
    });
    if (entryDraft.kind !== 'success') throw new Error('Direct entry draft failed.');
    const submissionId = entryDraft.data.safeDiff.submission.id;
    expect(count(runtime, 'intake_direct_entry_draft_receipt_links')).toBe(1);
    expect(count(runtime, 'intake_direct_entry_draft_timeline')).toBe(1);
    expect(count(runtime, 'intake_submission_heads')).toBe(0);
    expect(count(runtime, 'submission_triage_heads')).toBe(0);
    const beforeCommit = submissionTriageListOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/submissions/triage', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(beforeCommit).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'conflict', kind: 'submission_triage.not_initialized' }
    });

    await commitDraft({
      runtime, session, key: 'direct-entry-submission', draft: entryDraft
    });
    expect(count(runtime, 'intake_submission_heads')).toBe(1);
    expect(count(runtime, 'submission_arrival_facts')).toBe(1);
    expect(count(runtime, 'submission_triage_heads')).toBe(1);
    expect(count(runtime, 'intake_direct_entry_changeset_receipt_links')).toBe(2);
    expect(count(runtime, 'intake_direct_entry_changeset_domain_facts')).toBe(1);
    expect(count(runtime, 'intake_direct_entry_changeset_outbox_pointers')).toBe(1);
    expect(count(runtime, 'intake_direct_entry_changeset_timeline')).toBe(2);

    const triage = submissionTriageListOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/submissions/triage', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(triage).toMatchObject({
      kind: 'success',
      data: {
        rows: [{
          source: {
            source: 'direct_entry',
            summary: {
              id: submissionId,
              formId: openForm.id,
              title: 'Keyed-in keynote'
            }
          },
          triage: { submissionId, state: 'inbox', version: 1 },
          arrival: { submissionId, source: 'direct_entry', classification: 'on_time' },
          visibleTray: 'inbox'
        }]
      }
    });

    const snapshot = reviewSnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/review/snapshot', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(snapshot).toMatchObject({
      kind: 'success',
      data: {
        viewer: { kind: 'organizer' },
        roundSetup: { submissions: 1 }
      }
    });

    // Governed answer values live only in the classified store: the committed
    // record and its whole database never disclose the entered email.
    expect(JSON.stringify(runtime.database.sqlite
      .query('SELECT * FROM changeset_revisions').all()
    )).not.toContain('direct.speaker@example.test');
    expect(Buffer.from(runtime.database.sqlite.serialize()).includes(
      Buffer.from('direct.speaker@example.test')
    )).toBe(false);
    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  });

  test('commits the full Decision loop: direct entry, roster, open round with review_due deadline, and accept-with-spawn', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    const appUserId = await provisionOwner(runtime, session);
    await createEventThroughChangeset({ runtime, session, key: 'decision-loop-event' });

    // A spawnable candidate needs a format: pin the CFP to a format category.
    const formatDraft = programVocabularyDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/program-vocabulary/drafts/create',
      key: 'decision-loop-format-draft',
      body: { kind: 'format', expectedSetVersion: 1, name: 'Talk' },
      parse: (value) => value
    }));
    if (formatDraft.kind !== 'success') throw new Error('Format draft failed.');
    await commitDraft({ runtime, session, key: 'decision-loop-format', draft: formatDraft });
    const vocabulary = programVocabularySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/program-vocabulary', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (vocabulary.kind !== 'success') throw new Error('Vocabulary read failed.');
    const format = vocabulary.data.formats.find((candidate) => candidate.name === 'Talk');
    if (!format) throw new Error('Committed format missing.');

    const registryResult = fieldRegistrySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/field-registry', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (registryResult.kind !== 'success') throw new Error('Field registry read failed.');
    const registry = registryResult.data;
    const titleFieldId = registry.fields.find((field) =>
      field.mapsTo === 'talk.title' && field.kind === 'text'
    )?.id;
    const emailFieldId = registry.fields.find((field) =>
      field.mapsTo === 'person.email' && field.kind === 'email'
    )?.id;
    if (!titleFieldId || !emailFieldId) throw new Error('Identity fields missing.');
    const included = new Set([titleFieldId, emailFieldId]);
    const formCreateDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/create',
      key: 'decision-loop-form-create-draft',
      body: {
        expectedCatalogVersion: 1,
        expectedRegistryVersion: registry.version,
        definition: {
          ...formDefinitionInput,
          name: 'Talks CFP',
          target: {
            kind: 'category',
            category: { kind: 'format', id: format.id }
          },
          composition: {
            excludedFieldIds: registry.fields
              .filter((field) => field.scope.kind === 'shared'
                && field.contexts.apply.visible
                && !included.has(field.id))
              .map((field) => field.id)
              .sort(),
            requiredOverrides: {},
            optionExposure: {}
          }
        }
      },
      parse: (value) => value
    }));
    if (formCreateDraft.kind !== 'success'
        || formCreateDraft.data.safeDiff.action !== 'create') {
      throw new Error('Form create draft failed.');
    }
    await commitDraft({
      runtime, session, key: 'decision-loop-form-create', draft: formCreateDraft
    });
    const openDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/lifecycle',
      key: 'decision-loop-form-open-draft',
      body: {
        transition: 'publish_and_open',
        formId: formCreateDraft.data.safeDiff.after.id,
        expectedDefinitionVersion: 1,
        expectedRegistryVersion: registry.version
      },
      parse: (value) => value
    }));
    if (openDraft.kind !== 'success') throw new Error('Form open draft failed.');
    await commitDraft({ runtime, session, key: 'decision-loop-form-open', draft: openDraft });
    const catalog = organizerFormCatalogReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/forms', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (catalog.kind !== 'success') throw new Error('Form catalog read failed.');
    const openForm = catalog.data.forms.find((form) => form.status === 'open');
    if (!openForm) throw new Error('Open form missing from the catalog.');

    const entryDraft = submissionDirectEntryDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/submissions/direct-entry/drafts',
      key: 'decision-loop-entry-draft',
      body: {
        formId: openForm.id,
        expectedFormDefinitionVersion: openForm.version,
        answers: [
          { kind: 'text', fieldId: titleFieldId, value: 'Decided keynote' },
          { kind: 'email', fieldId: emailFieldId, value: 'decided.speaker@example.test' }
        ]
      },
      parse: (value) => value
    }));
    if (entryDraft.kind !== 'success') throw new Error('Direct entry draft failed.');
    const submissionId = entryDraft.data.safeDiff.submission.id;
    await commitDraft({ runtime, session, key: 'decision-loop-entry', draft: entryDraft });

    const membership = runtime.database.sqlite.query<
      { readonly id: string; readonly version: number },
      [string, string]
    >(`
      SELECT id, version FROM workspace_memberships
       WHERE workspace_id = ? AND user_id = ? AND status = 'active'
    `).get(runtime.workspaceId, appUserId);
    if (!membership) throw new Error('owner membership missing');
    const roster = reviewerRosterSnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/reviewer-roster', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (roster.kind !== 'success') throw new Error('roster snapshot unavailable');
    const registerDraft = reviewerRosterChangeDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/reviewer-roster/drafts',
      key: 'decision-loop-register-draft',
      body: {
        action: 'register',
        reviewerId: crypto.randomUUID(),
        accessSubject: {
          kind: 'workspace_membership',
          id: membership.id,
          version: membership.version
        },
        reviews: [],
        expectedRosterVersion: roster.data.rosterVersion,
        expectedRosterDigestSha256: roster.data.rosterDigestSha256
      },
      parse: (value) => value
    }));
    expect(registerDraft).toMatchObject({ kind: 'success', data: { action: 'register' } });
    if (registerDraft.kind !== 'success') throw new Error('roster draft failed');
    await commitDraft({ runtime, session, key: 'decision-loop-register', draft: registerDraft });

    // With a reviewable candidate and an active reviewer the open now
    // succeeds where the empty composition pins the no_assignments refusal.
    expect(count(runtime, 'review_rounds')).toBe(0);
    expect(count(runtime, 'deadlines', "WHERE kind = 'review_due'")).toBe(0);
    const roundDraft = reviewChangeDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/review/round-drafts',
      key: 'decision-loop-open-round-draft',
      body: { action: 'open_round', deadlineDate: '2027-06-11', anonymized: true },
      parse: (value) => value
    }));
    expect(roundDraft).toMatchObject({
      kind: 'success',
      data: {
        action: 'open_round',
        headVersion: 1,
        status: 'draft',
        safeDiff: { action: 'open_round', assignmentCount: 1 }
      },
      receipt: { operationName: 'review.round.change.draft', operationVersion: 1 }
    });
    if (roundDraft.kind !== 'success') throw new Error('Open round draft failed.');
    expect(count(runtime, 'review_rounds')).toBe(0);
    expect(count(runtime, 'deadlines', "WHERE kind = 'review_due'")).toBe(0);
    await commitDraft({ runtime, session, key: 'decision-loop-open-round', draft: roundDraft });
    // One changeset commit lands the round, its assignment, and the
    // collaborating review_due Deadline atomically.
    expect(count(runtime, 'review_rounds')).toBe(1);
    expect(count(runtime, 'review_assignments')).toBe(1);
    expect(count(runtime, 'deadlines', "WHERE kind = 'review_due'")).toBe(1);
    const deadlines = deadlineListReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/deadlines', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (deadlines.kind !== 'success') throw new Error('Deadline catalog read failed.');
    expect(deadlines.data.deadlines).toEqual([expect.objectContaining({
      kind: 'review_due', status: 'active', displayDate: '2027-06-11'
    })]);

    const triageBefore = submissionTriageListOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/submissions/triage', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (triageBefore.kind !== 'success') throw new Error('Triage read failed.');
    expect(triageBefore.data.rows).toMatchObject([{
      triage: { submissionId, state: 'inbox', version: 1 },
      visibleTray: 'inbox'
    }]);

    const undecided = decisionStateReadResultSchema.parse(await (
      await runtime.app.request(
        `/api/events/current/decisions?${new URLSearchParams({ submissionIds: submissionId }).toString()}`,
        { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
      )
    ).json());
    expect(undecided).toMatchObject({
      kind: 'success',
      data: { schemaVersion: 1, rows: [{ submissionId, head: null, origin: null }] }
    });

    const decideDraft = decisionDecideDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/decisions/decide-drafts',
      key: 'decision-loop-decide-draft',
      body: {
        action: 'decide',
        decisions: [{
          submissionId,
          state: 'accepted',
          expectedDecisionVersion: null,
          expectedDecisionDigestSha256: null,
          graduation: { kind: 'spawn' }
        }]
      },
      parse: (value) => value
    }));
    expect(decideDraft).toMatchObject({
      kind: 'success',
      data: {
        action: 'decide',
        headVersion: 1,
        status: 'draft',
        safeDiff: {
          action: 'decide',
          rows: [{
            submissionId,
            before: null,
            after: { submissionId, state: 'accepted', version: 1 }
          }]
        }
      },
      receipt: { operationName: 'decision.decide.draft', operationVersion: 1 }
    });
    if (decideDraft.kind !== 'success') throw new Error('Decide draft failed.');
    // The draft is inert: no Decision head, origin link, Session, or seeded
    // engagement yet.
    expect(count(runtime, 'decision_draft_receipt_links')).toBe(1);
    expect(count(runtime, 'decision_draft_timeline')).toBe(1);
    expect(count(runtime, 'decision_heads')).toBe(0);
    expect(count(runtime, 'submission_session_origins')).toBe(0);
    expect(count(runtime, 'sessions')).toBe(0);
    expect(count(runtime, 'engagement_heads')).toBe(0);

    await commitDraft({ runtime, session, key: 'decision-loop-decide', draft: decideDraft });
    expect(count(runtime, 'decision_heads')).toBe(1);
    expect(count(runtime, 'submission_session_origins')).toBe(1);
    expect(count(runtime, 'sessions')).toBe(1);
    expect(count(runtime, 'engagement_heads')).toBe(1);
    expect(count(runtime, 'decision_changeset_receipt_links')).toBe(2);
    expect(count(runtime, 'decision_changeset_domain_facts')).toBe(1);
    expect(count(runtime, 'decision_changeset_outbox_pointers')).toBe(1);
    expect(count(runtime, 'decision_changeset_timeline')).toBe(2);

    const decided = decisionStateReadResultSchema.parse(await (
      await runtime.app.request(
        `/api/events/current/decisions?${new URLSearchParams({ submissionIds: submissionId }).toString()}`,
        { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
      )
    ).json());
    expect(decided).toMatchObject({
      kind: 'success',
      data: {
        rows: [{
          submissionId,
          head: { submissionId, state: 'accepted', version: 1, decidedByUserId: appUserId },
          origin: { submissionId, kind: 'spawned', linkedByUserId: appUserId }
        }]
      }
    });
    if (decided.kind !== 'success') throw new Error('Decision state read failed.');
    const origin = decided.data.rows[0]?.origin;
    if (!origin) throw new Error('Origin link missing.');

    // The spawn minted a NEW canonical Session carrying the submission's
    // title and the participant person seeded from the Intake evidence.
    const participant = runtime.database.sqlite.query<
      { readonly person_id: string }, [string]
    >(`
      SELECT person_id FROM intake_submission_participant_evidence
       WHERE submission_id = ?
    `).get(submissionId);
    if (!participant) throw new Error('Participant evidence missing.');
    const sessions = sessionCatalogReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/sessions', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(sessions).toMatchObject({
      kind: 'success',
      data: {
        sessions: [{
          id: origin.sessionId,
          title: 'Decided keynote',
          lifecycle: 'programmed',
          roster: {
            participants: [{ personId: participant.person_id, role: 'speaker' }]
          }
        }]
      }
    });

    // Decisions never touch triage: the whole served row set — source and
    // arrival projections included — reads back identical, not just the
    // triage sub-objects.
    const triageAfter = submissionTriageListOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/submissions/triage', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (triageAfter.kind !== 'success') throw new Error('Triage re-read failed.');
    expect(triageAfter.data.rows).toEqual(triageBefore.data.rows);
    expect(triageAfter.data.rows[0]).toMatchObject({
      triage: { submissionId, state: 'inbox', version: 1 },
      visibleTray: 'inbox'
    });

    // The acceptance commit seeded one `invited` engagement for the spawned
    // Session's participant inside the same unit of work, keyed by personId
    // and stamped with the acceptance's own written decision head.
    const decidedHead = decided.data.rows[0]?.head;
    if (!decidedHead) throw new Error('Decided head missing.');
    const engagements = engagementSnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/engagements', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(engagements).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        engagements: [{
          sessionId: origin.sessionId,
          personId: participant.person_id,
          submissionId,
          state: 'invited',
          version: 1,
          seededByDecision: {
            version: decidedHead.version,
            digestSha256: decidedHead.digestSha256
          },
          source: { kind: 'submission', id: submissionId }
        }]
      }
    });
    if (engagements.kind !== 'success') throw new Error('Engagement read failed.');
    const seededEngagement = engagements.data.engagements[0];
    if (!seededEngagement) throw new Error('Seeded engagement missing.');
    // The seed pin above is what keeps this row safe from another
    // acceptance's compensation: a reversal selects only rows carrying its
    // own decision-head pin. The multi-acceptance dance itself is pinned at
    // the persistence join (decision.test.ts "compensating a re-acceptance
    // leaves rows an earlier acceptance seeded standing"; engagement.test.ts
    // "reversal selects only the reverted acceptance's own rows by their
    // decision pin") — replaying it here would need a collecting attach
    // target plus staged post-commit drift, which this loop does not stage.

    // The organizer records the speaker's confirmation through the mounted
    // response draft; the draft is inert until its lifecycle commit.
    const confirmDraft = engagementChangeDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/engagements/drafts',
      key: 'decision-loop-confirm-draft',
      body: {
        action: 'record_confirmation',
        engagementId: seededEngagement.id,
        expectedEngagementVersion: 1,
        attribution: 'organizer_recorded'
      },
      parse: (value) => value
    }));
    expect(confirmDraft).toMatchObject({
      kind: 'success',
      data: {
        action: 'record_confirmation',
        headVersion: 1,
        status: 'draft',
        safeDiff: {
          action: 'record_confirmation',
          before: { id: seededEngagement.id, state: 'invited', version: 1 },
          after: { id: seededEngagement.id, state: 'confirmed', version: 2 }
        }
      },
      receipt: { operationName: 'engagement.change.draft', operationVersion: 1 }
    });
    if (confirmDraft.kind !== 'success') throw new Error('Confirmation draft failed.');
    expect(count(runtime, 'engagement_draft_receipt_links')).toBe(1);
    expect(count(runtime, 'engagement_draft_timeline')).toBe(1);
    expect(count(runtime, 'engagement_heads', "WHERE state = 'invited'")).toBe(1);

    await commitDraft({ runtime, session, key: 'decision-loop-confirm', draft: confirmDraft });
    expect(count(runtime, 'engagement_changeset_receipt_links')).toBe(2);
    expect(count(runtime, 'engagement_changeset_domain_facts')).toBe(1);
    expect(count(runtime, 'engagement_changeset_outbox_pointers')).toBe(1);
    expect(count(runtime, 'engagement_changeset_timeline')).toBe(2);
    const confirmed = engagementSnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/engagements', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(confirmed).toMatchObject({
      kind: 'success',
      data: {
        engagements: [{
          id: seededEngagement.id,
          state: 'confirmed',
          version: 2,
          confirmation: {
            attribution: 'organizer_recorded',
            personId: participant.person_id,
            recordedByUserId: appUserId
          },
          seededByDecision: {
            version: decidedHead.version,
            digestSha256: decidedHead.digestSha256
          }
        }]
      }
    });
    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  });

  test('commits the decision-notification send wave inertly: audience, preview, send ceremony, dispatch to terminal not-delivered, and currency refusal', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    const appUserId = await provisionOwner(runtime, session);
    await createEventThroughChangeset({ runtime, session, key: 'send-wave-event' });

    const formatDraft = programVocabularyDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/program-vocabulary/drafts/create',
      key: 'send-wave-format-draft',
      body: { kind: 'format', expectedSetVersion: 1, name: 'Talk' },
      parse: (value) => value
    }));
    if (formatDraft.kind !== 'success') throw new Error('Format draft failed.');
    await commitDraft({ runtime, session, key: 'send-wave-format', draft: formatDraft });
    const vocabulary = programVocabularySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/program-vocabulary', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (vocabulary.kind !== 'success') throw new Error('Vocabulary read failed.');
    const format = vocabulary.data.formats.find((candidate) => candidate.name === 'Talk');
    if (!format) throw new Error('Committed format missing.');

    const registryResult = fieldRegistrySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/field-registry', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (registryResult.kind !== 'success') throw new Error('Field registry read failed.');
    const registry = registryResult.data;
    const titleFieldId = registry.fields.find((field) =>
      field.mapsTo === 'talk.title' && field.kind === 'text'
    )?.id;
    const emailFieldId = registry.fields.find((field) =>
      field.mapsTo === 'person.email' && field.kind === 'email'
    )?.id;
    if (!titleFieldId || !emailFieldId) throw new Error('Identity fields missing.');
    const included = new Set([titleFieldId, emailFieldId]);
    const formCreateDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/create',
      key: 'send-wave-form-create-draft',
      body: {
        expectedCatalogVersion: 1,
        expectedRegistryVersion: registry.version,
        definition: {
          ...formDefinitionInput,
          name: 'Send wave CFP',
          target: {
            kind: 'category',
            category: { kind: 'format', id: format.id }
          },
          composition: {
            excludedFieldIds: registry.fields
              .filter((field) => field.scope.kind === 'shared'
                && field.contexts.apply.visible
                && !included.has(field.id))
              .map((field) => field.id)
              .sort(),
            requiredOverrides: {},
            optionExposure: {}
          }
        }
      },
      parse: (value) => value
    }));
    if (formCreateDraft.kind !== 'success'
        || formCreateDraft.data.safeDiff.action !== 'create') {
      throw new Error('Form create draft failed.');
    }
    await commitDraft({
      runtime, session, key: 'send-wave-form-create', draft: formCreateDraft
    });
    const openDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/lifecycle',
      key: 'send-wave-form-open-draft',
      body: {
        transition: 'publish_and_open',
        formId: formCreateDraft.data.safeDiff.after.id,
        expectedDefinitionVersion: 1,
        expectedRegistryVersion: registry.version
      },
      parse: (value) => value
    }));
    if (openDraft.kind !== 'success') throw new Error('Form open draft failed.');
    await commitDraft({ runtime, session, key: 'send-wave-form-open', draft: openDraft });
    const catalog = organizerFormCatalogReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/forms', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (catalog.kind !== 'success') throw new Error('Form catalog read failed.');
    const openForm = catalog.data.forms.find((form) => form.status === 'open');
    if (!openForm) throw new Error('Open form missing from the catalog.');

    const enterSubmission = async (label: string, email: string) => {
      const entryDraft = submissionDirectEntryDraftOperationResultSchema.parse(await effect({
        runtime,
        session,
        path: '/api/events/current/submissions/direct-entry/drafts',
        key: `send-wave-entry-${label}-draft`,
        body: {
          formId: openForm.id,
          expectedFormDefinitionVersion: openForm.version,
          answers: [
            { kind: 'text', fieldId: titleFieldId, value: `Send wave ${label}` },
            { kind: 'email', fieldId: emailFieldId, value: email }
          ]
        },
        parse: (value) => value
      }));
      if (entryDraft.kind !== 'success') throw new Error(`Direct entry ${label} failed.`);
      await commitDraft({
        runtime, session, key: `send-wave-entry-${label}`, draft: entryDraft
      });
      return entryDraft.data.safeDiff.submission.id;
    };
    const decide = async (label: string, submissionId: string) => {
      const decideDraft = decisionDecideDraftOperationResultSchema.parse(await effect({
        runtime,
        session,
        path: '/api/events/current/decisions/decide-drafts',
        key: `send-wave-decide-${label}-draft`,
        body: {
          action: 'decide',
          decisions: [{
            submissionId,
            state: 'accepted',
            expectedDecisionVersion: null,
            expectedDecisionDigestSha256: null,
            graduation: { kind: 'spawn' }
          }]
        },
        parse: (value) => value
      }));
      if (decideDraft.kind !== 'success') throw new Error(`Decide ${label} draft failed.`);
      await commitDraft({
        runtime, session, key: `send-wave-decide-${label}`, draft: decideDraft
      });
    };
    const firstEmail = 'send.wave.one@example.test';
    const submissionA = await enterSubmission('one', firstEmail);
    const submissionB = await enterSubmission('two', 'send.wave.two@example.test');
    await decide('one', submissionA);

    // The seeded decision-set recipes serve as live audience options.
    const options = organizerCommunicationAudienceOptionPageOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/communications/audiences/options', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (options.kind !== 'success') throw new Error('Audience options read failed.');
    const acceptedOption = options.data.rows.find((row) => {
      const source = row.audienceDraft.source;
      return source.kind === 'registered_query'
        && source.recipeId === 'recipe.communication.decision-set.accepted';
    });
    if (!acceptedOption) throw new Error('Accepted decision-set option missing.');

    const storePayload = async (label: string, payload: unknown) => {
      const stored = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
        await effect({
          runtime,
          session,
          path: '/api/events/current/communications/authoring-payloads',
          key: `send-wave-payload-${label}`,
          body: { payload },
          parse: (value) => value
        })
      );
      if (stored.kind !== 'success') throw new Error(`Payload ${label} store failed.`);
      return stored.data;
    };
    const createReadyDraft = async (label: string) => {
      const contentPayload = await storePayload(`content-${label}`, {
        payloadKind: 'message_content',
        schemaVersion: 1,
        value: {
          kind: 'email/v1',
          subject: 'Your submission decision',
          body: {
            kind: 'plain_text/v1',
            text: `Good news — your submission was accepted. (${label})`
          }
        }
      });
      const audiencePayload = await storePayload(`audience-${label}`, {
        payloadKind: 'message_audience_draft',
        schemaVersion: 1,
        value: acceptedOption.audienceDraft
      });
      const created = organizerCommunicationDraftMutationOperationResultSchema.parse(
        await effect({
          runtime,
          session,
          path: '/api/events/current/communications/drafts/create',
          key: `send-wave-draft-${label}`,
          body: {
            channel: 'email',
            purposeRevision: acceptedOption.audienceDraft.purposeRevision,
            initial: {
              kind: 'adopted_payload_refs',
              contentPayload,
              audiencePayload
            }
          },
          parse: (value) => value
        })
      );
      if (created.kind !== 'success') throw new Error(`Draft ${label} create failed.`);
      return created.data;
    };

    const draftOne = await createReadyDraft('one');
    const adoptedOne = await runtime.communications.adoptDecisionPreview({
      draftId: draftOne.draftId,
      expectedDraftVersion: draftOne.version
    });
    if (adoptedOne.kind !== 'adopted') {
      throw new Error(`Preview adoption refused: ${JSON.stringify(adoptedOne)}`);
    }
    expect(adoptedOne.summary.counts).toMatchObject({ includedCount: 1 });
    expect(adoptedOne.summary.sourceVersions).toEqual([
      expect.objectContaining({ sourceKey: 'decision-set.accepted' })
    ]);

    const attributionRow = runtime.database.sqlite.query<{
      readonly scope_partition_key: string;
      readonly authority_principal_key: string;
    }, []>(`
      SELECT scope_partition_key, authority_principal_key
        FROM foundation_trial_operation_receipts
       WHERE operation_name = 'changeset.commit' LIMIT 1
    `).get();
    if (!attributionRow) throw new Error('No operator commit receipt to attribute.');
    const attribution = Object.freeze({
      scopePartitionKey: attributionRow.scope_partition_key,
      authorityPrincipalKey: attributionRow.authority_principal_key,
      principalKey: `workspace_user:${appUserId}`
    });

    const sent = runtime.communications.sendDecisionMessages({
      audienceSpecId: adoptedOne.summary.identity.audienceSpecId,
      batchId: 'batch.decision-notification.send-wave',
      subject: 'Your submission decision',
      audienceLabel: 'Accepted submissions',
      attribution
    });
    if (sent.kind !== 'committed') {
      throw new Error(`Send refused: ${JSON.stringify(sent)}`);
    }
    expect(sent.result).toMatchObject({
      batchId: 'batch.decision-notification.send-wave',
      dispatchGeneration: 1,
      releaseCount: 1
    });
    // The reused changeset ceremony: drafted -> proposed -> committed inside
    // the one send transaction (BLOCKED-3), with the commit receipt linked.
    expect(runtime.database.sqlite.query<{
      readonly status: string;
      readonly head_version: number;
    }, [string]>(`
      SELECT status, head_version FROM changeset_heads WHERE changeset_id = ?
    `).get(sent.changesetId)).toEqual({ status: 'committed', head_version: 3 });
    expect(count(runtime, 'communication_release_receipt_links', "WHERE action = 'commit'"))
      .toBe(1);
    expect(count(runtime, 'communication_message_releases')).toBe(1);
    expect(count(runtime, 'communication_release_effect_specs')).toBe(1);
    expect(count(runtime, 'communication_outbound_delivery_heads', "WHERE state = 'pending'"))
      .toBe(1);

    // One dispatch pass over the ledger. Only the deterministic fake provider
    // is composed and the send lane's external delivery key names no fake
    // scenario, so the attempt resolves as a terminal known rejection: the
    // delivery is honestly not delivered and no follow-up is owed.
    const dispatched = await runtime.outboundDispatch.runOnce();
    expect(dispatched).toEqual([expect.objectContaining({
      contractVersion: 1,
      state: 'known_rejected_terminal',
      followUp: 'complete'
    })]);
    expect(count(runtime, 'communication_outbound_delivery_heads',
      "WHERE state = 'known_rejected_terminal'")).toBe(1);
    expect(runtime.database.sqlite.query<{
      readonly adapter_key: string;
      readonly state: string;
      readonly provider_outcome_reason: string | null;
    }, []>(`
      SELECT adapter_key, state, provider_outcome_reason
        FROM communication_outbound_delivery_attempts
    `).all()).toEqual([{
      adapter_key: 'fake.email',
      state: 'known_rejected_terminal',
      provider_outcome_reason: 'delivery.rejected_terminal'
    }]);
    expect(count(runtime, 'communication_outbound_delivery_facts')).toBe(2);
    expect(count(runtime, 'communication_outbound_delivery_outbox')).toBe(2);
    expect(count(runtime, 'communication_outbound_delivery_history')).toBe(2);
    // A second pass finds nothing dispatchable: terminal rejections are never
    // auto-retried (recorder default BLOCKED-6).
    expect(await runtime.outboundDispatch.runOnce()).toEqual([]);

    // The recipient address lives only in classified ciphertext: intake
    // answers, the adopted preview snapshot, and the release envelope are all
    // encrypted, and no ledger or release row carries an address column.
    expect(Buffer.from(runtime.database.sqlite.serialize()).includes(
      Buffer.from(firstEmail)
    )).toBe(false);

    // Currency: adopt a second preview of the accepted decision set, then
    // commit a further decision. The held preview's source versions no longer
    // reproduce from current decision heads, so the send refuses typed and
    // writes nothing.
    const draftTwo = await createReadyDraft('two');
    const adoptedTwo = await runtime.communications.adoptDecisionPreview({
      draftId: draftTwo.draftId,
      expectedDraftVersion: draftTwo.version
    });
    if (adoptedTwo.kind !== 'adopted') {
      throw new Error(`Second adoption refused: ${JSON.stringify(adoptedTwo)}`);
    }
    await decide('two', submissionB);
    const refused = runtime.communications.sendDecisionMessages({
      audienceSpecId: adoptedTwo.summary.identity.audienceSpecId,
      batchId: 'batch.decision-notification.stale',
      subject: 'Your submission decision',
      audienceLabel: 'Accepted submissions',
      attribution
    });
    expect(refused).toMatchObject({
      kind: 'refused',
      refusal: {
        class: 'stale_revision',
        kind: 'communication.preview_changed',
        retryable: false,
        detailSchemaVersion: 1,
        detail: { includedCount: 1, irreversibleExternalEffectCount: 1 }
      }
    });
    // The refused ceremony rolled back whole: no release, delivery, receipt
    // link, or changeset row survives it.
    expect(count(runtime, 'communication_message_releases')).toBe(1);
    expect(count(runtime, 'communication_release_effect_specs')).toBe(1);
    expect(count(runtime, 'communication_release_receipt_links')).toBe(1);
    expect(count(runtime, 'communication_outbound_delivery_heads')).toBe(1);
    expect(runtime.database.sqlite.query<{ readonly total: number }, [string]>(`
      SELECT count(*) AS total FROM changeset_heads WHERE changeset_id = ?
    `).get(sent.changesetId)?.total).toBe(1);
    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  });

  test('serves the send lane over operator HTTP: prepare, adopt, send with auto-dispatch, delivery history, replay, and wire currency refusal', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);
    await createEventThroughChangeset({ runtime, session, key: 'http-send-event' });

    const formatDraft = programVocabularyDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/program-vocabulary/drafts/create',
      key: 'http-send-format-draft',
      body: { kind: 'format', expectedSetVersion: 1, name: 'Talk' },
      parse: (value) => value
    }));
    if (formatDraft.kind !== 'success') throw new Error('Format draft failed.');
    await commitDraft({ runtime, session, key: 'http-send-format', draft: formatDraft });
    const vocabulary = programVocabularySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/program-vocabulary', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (vocabulary.kind !== 'success') throw new Error('Vocabulary read failed.');
    const format = vocabulary.data.formats.find((candidate) => candidate.name === 'Talk');
    if (!format) throw new Error('Committed format missing.');

    const registryResult = fieldRegistrySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/field-registry', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (registryResult.kind !== 'success') throw new Error('Field registry read failed.');
    const registry = registryResult.data;
    const titleFieldId = registry.fields.find((field) =>
      field.mapsTo === 'talk.title' && field.kind === 'text'
    )?.id;
    const emailFieldId = registry.fields.find((field) =>
      field.mapsTo === 'person.email' && field.kind === 'email'
    )?.id;
    if (!titleFieldId || !emailFieldId) throw new Error('Identity fields missing.');
    const included = new Set([titleFieldId, emailFieldId]);
    const formCreateDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/create',
      key: 'http-send-form-create-draft',
      body: {
        expectedCatalogVersion: 1,
        expectedRegistryVersion: registry.version,
        definition: {
          ...formDefinitionInput,
          name: 'HTTP send CFP',
          target: { kind: 'category', category: { kind: 'format', id: format.id } },
          composition: {
            excludedFieldIds: registry.fields
              .filter((field) => field.scope.kind === 'shared'
                && field.contexts.apply.visible
                && !included.has(field.id))
              .map((field) => field.id)
              .sort(),
            requiredOverrides: {},
            optionExposure: {}
          }
        }
      },
      parse: (value) => value
    }));
    if (formCreateDraft.kind !== 'success'
        || formCreateDraft.data.safeDiff.action !== 'create') {
      throw new Error('Form create draft failed.');
    }
    await commitDraft({
      runtime, session, key: 'http-send-form-create', draft: formCreateDraft
    });
    const openDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/lifecycle',
      key: 'http-send-form-open-draft',
      body: {
        transition: 'publish_and_open',
        formId: formCreateDraft.data.safeDiff.after.id,
        expectedDefinitionVersion: 1,
        expectedRegistryVersion: registry.version
      },
      parse: (value) => value
    }));
    if (openDraft.kind !== 'success') throw new Error('Form open draft failed.');
    await commitDraft({ runtime, session, key: 'http-send-form-open', draft: openDraft });
    const catalog = organizerFormCatalogReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/forms', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (catalog.kind !== 'success') throw new Error('Form catalog read failed.');
    const openForm = catalog.data.forms.find((form) => form.status === 'open');
    if (!openForm) throw new Error('Open form missing from the catalog.');

    const enterSubmission = async (label: string, email: string) => {
      const entryDraft = submissionDirectEntryDraftOperationResultSchema.parse(await effect({
        runtime,
        session,
        path: '/api/events/current/submissions/direct-entry/drafts',
        key: `http-send-entry-${label}-draft`,
        body: {
          formId: openForm.id,
          expectedFormDefinitionVersion: openForm.version,
          answers: [
            { kind: 'text', fieldId: titleFieldId, value: `HTTP send ${label}` },
            { kind: 'email', fieldId: emailFieldId, value: email }
          ]
        },
        parse: (value) => value
      }));
      if (entryDraft.kind !== 'success') throw new Error(`Direct entry ${label} failed.`);
      await commitDraft({
        runtime, session, key: `http-send-entry-${label}`, draft: entryDraft
      });
      return entryDraft.data.safeDiff.submission.id;
    };
    const decide = async (label: string, submissionId: string) => {
      const decideDraft = decisionDecideDraftOperationResultSchema.parse(await effect({
        runtime,
        session,
        path: '/api/events/current/decisions/decide-drafts',
        key: `http-send-decide-${label}-draft`,
        body: {
          action: 'decide',
          decisions: [{
            submissionId,
            state: 'accepted',
            expectedDecisionVersion: null,
            expectedDecisionDigestSha256: null,
            graduation: { kind: 'spawn' }
          }]
        },
        parse: (value) => value
      }));
      if (decideDraft.kind !== 'success') throw new Error(`Decide ${label} draft failed.`);
      await commitDraft({
        runtime, session, key: `http-send-decide-${label}`, draft: decideDraft
      });
    };
    const submissionA = await enterSubmission('one', 'http.send.one@example.test');
    const submissionB = await enterSubmission('two', 'http.send.two@example.test');
    await decide('one', submissionA);

    // The seeded acceptance template and the minted decision-set option are
    // the wire truth this lane composes from.
    const templates = organizerMessageTemplatePageOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/communications/templates', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (templates.kind !== 'success') throw new Error('Template list read failed.');
    const acceptedTemplate = templates.data.rows.find((row) => row.key === 'decision.accepted');
    if (!acceptedTemplate) throw new Error('Seeded acceptance template missing.');
    const options = organizerCommunicationAudienceOptionPageOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/communications/audiences/options', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (options.kind !== 'success') throw new Error('Audience options read failed.');
    const acceptedOption = options.data.rows.find((row) => {
      const source = row.audienceDraft.source;
      return source.kind === 'registered_query'
        && source.recipeId === 'recipe.communication.decision-set.accepted';
    });
    if (!acceptedOption) throw new Error('Accepted decision-set option missing.');

    const storePayload = async (label: string, payload: unknown) => {
      const stored = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
        await effect({
          runtime,
          session,
          path: '/api/events/current/communications/authoring-payloads',
          key: `http-send-payload-${label}`,
          body: { payload },
          parse: (value) => value
        })
      );
      if (stored.kind !== 'success') throw new Error(`Payload ${label} store failed.`);
      return stored.data;
    };
    const createReadyDraft = async (label: string) => {
      const contentPayload = await storePayload(`content-${label}`, {
        payloadKind: 'message_content',
        schemaVersion: 1,
        value: {
          kind: 'email/v1',
          subject: 'Your submission decision',
          body: { kind: 'template_revision/v1', templateRevision: acceptedTemplate.revision }
        }
      });
      const audiencePayload = await storePayload(`audience-${label}`, {
        payloadKind: 'message_audience_draft',
        schemaVersion: 1,
        value: acceptedOption.audienceDraft
      });
      const created = organizerCommunicationDraftMutationOperationResultSchema.parse(
        await effect({
          runtime,
          session,
          path: '/api/events/current/communications/drafts/create',
          key: `http-send-draft-${label}`,
          body: {
            channel: 'email',
            purposeRevision: acceptedOption.audienceDraft.purposeRevision,
            templateRevision: acceptedTemplate.revision,
            initial: { kind: 'adopted_payload_refs', contentPayload, audiencePayload }
          },
          parse: (value) => value
        })
      );
      if (created.kind !== 'success') throw new Error(`Draft ${label} create failed.`);
      return created.data;
    };

    // Two-step adoption lane on the wire: the compute-only prepare read runs
    // the asynchronous audience resolution, then the effect adopts the parked
    // preparation inside its one unit of work.
    const prepareAndAdopt = async (label: string, draft: {
      readonly draftId: string;
      readonly version: number;
    }) => {
      const prepared = organizerPrepareMessagePreviewOperationResultSchema.parse(await (
        await runtime.app.request(
          '/api/events/current/communications/previews/prepare'
            + `?draftId=${encodeURIComponent(draft.draftId)}`
            + `&expectedDraftVersion=${draft.version}`,
          { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
        )
      ).json());
      expect(prepared).toMatchObject({
        kind: 'success',
        data: {
          schemaVersion: 1,
          draftId: draft.draftId,
          draftVersion: draft.version,
          state: 'prepared'
        }
      });
      const adopted = organizerPreviewMessageBatchOperationResultSchema.parse(await effect({
        runtime,
        session,
        path: '/api/events/current/communications/previews/adopt',
        key: `http-send-adopt-${label}`,
        body: { draftId: draft.draftId, expectedDraftVersion: draft.version },
        parse: (value) => value
      }));
      if (adopted.kind !== 'success') {
        throw new Error(`Adoption ${label} refused: ${JSON.stringify(adopted)}`);
      }
      expect(adopted.receipt).toMatchObject({
        operationName: 'preview_message_batch',
        operationVersion: 1
      });
      return adopted.data;
    };

    const draftOne = await createReadyDraft('one');
    const summaryOne = await prepareAndAdopt('one', draftOne);
    expect(summaryOne.counts).toMatchObject({ includedCount: 1 });

    // An adopt for a draft revision with no live preparation refuses typed
    // instead of guessing: the lane requires its prepare step.
    const unprepared = organizerPreviewMessageBatchOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/communications/previews/adopt',
      key: 'http-send-adopt-unprepared',
      body: { draftId: draftOne.draftId, expectedDraftVersion: draftOne.version },
      parse: (value) => value
    }));
    expect(unprepared).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: { class: 'stale_revision', kind: 'communication.revision_changed' }
    });

    const sendBody = Object.freeze({
      audienceSpecId: summaryOne.identity.audienceSpecId,
      batchId: 'batch.http.decision-notification',
      subject: 'Your submission decision',
      audienceLabel: 'Accepted submissions'
    });
    const sent = organizerSendMessagesOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/communications/messages/send',
      key: 'http-send-commit',
      body: sendBody,
      parse: (value) => value
    }));
    if (sent.kind !== 'success') throw new Error(`Send refused: ${JSON.stringify(sent)}`);
    expect(sent.receipt).toMatchObject({ operationName: 'send_messages', operationVersion: 1 });
    expect(sent.data).toMatchObject({
      schemaVersion: 1,
      batchId: sendBody.batchId,
      dispatchGeneration: 1,
      releaseCount: 1,
      deliveryCount: 1
    });

    // The dispatch pass ran automatically after the commit landed (provider
    // I/O strictly outside the unit of work); only the deterministic fake is
    // composed and no fake scenario key is named, so the one delivery is
    // honestly, terminally not-delivered (BLOCKED-2, BLOCKED-6).
    expect(count(runtime, 'communication_outbound_delivery_heads',
      "WHERE state = 'known_rejected_terminal'")).toBe(1);
    expect(count(runtime, 'communication_outbound_delivery_heads')).toBe(1);
    expect(count(runtime, 'communication_outbound_delivery_attempts',
      "WHERE adapter_key = 'fake.email'")).toBe(1);

    const history = organizerCommunicationHistoryPageOperationResultSchema.parse(await (
      await runtime.app.request('/api/events/current/communications/deliveries/history', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (history.kind !== 'success') throw new Error('Delivery history read failed.');
    expect(history.data.rows).toEqual([expect.objectContaining({
      schemaVersion: 1,
      visibility: 'organizer_non_security',
      messageRefId: sendBody.batchId,
      subject: sendBody.subject,
      audienceLabel: sendBody.audienceLabel,
      state: 'known_failed',
      // The reason is the code the deciding provider attempt itself recorded,
      // not an assumption about the composition: the fake resolves a
      // non-scenario external key as a terminal known rejection.
      stateReasonCode: 'delivery.rejected_terminal',
      actor: { kind: 'human', displayLabel: 'Workspace operator' },
      cause: expect.objectContaining({
        subjectKind: 'communication_preview',
        subjectRefId: summaryOne.identity.audienceSpecId
      }),
      counts: {
        audience: { knowledge: 'known', value: 1 },
        materialized: { knowledge: 'known', value: 1 },
        accepted: { knowledge: 'known', value: 0 },
        delivered: { knowledge: 'not_supported' },
        acceptanceUnknown: { knowledge: 'known', value: 0 },
        knownFailed: { knowledge: 'known', value: 1 }
      },
      availableActions: ['continue_provider_setup']
    })]);
    expect(history.data.page).toEqual({ hasMore: false });
    // Derived, not assumed: the projected reason is exactly the outcome code
    // the deciding attempt recorded in the ledger.
    expect(history.data.rows[0]!.stateReasonCode).toBe(
      runtime.database.sqlite.query<{ readonly provider_outcome_reason: string | null }, []>(`
        SELECT provider_outcome_reason FROM communication_outbound_delivery_attempts
      `).all()[0]!.provider_outcome_reason as string
    );

    // An identical retry replays the terminal receipt instead of re-sending.
    const replayed = organizerSendMessagesOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/communications/messages/send',
      key: 'http-send-commit',
      body: sendBody,
      parse: (value) => value
    }));
    if (replayed.kind !== 'success') throw new Error('Send replay failed.');
    expect(replayed.receipt).toEqual(sent.receipt);
    expect(count(runtime, 'communication_message_releases')).toBe(1);
    expect(count(runtime, 'communication_outbound_delivery_heads')).toBe(1);

    // Wire currency refusal: adopt a second preview, commit a further
    // decision, and the held preview's evidence no longer reproduces — the
    // send refuses typed with the reviewed safe diff and writes nothing.
    const draftTwo = await createReadyDraft('two');
    const summaryTwo = await prepareAndAdopt('two', draftTwo);
    await decide('two', submissionB);
    const refused = organizerSendMessagesOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/communications/messages/send',
      key: 'http-send-stale',
      body: {
        audienceSpecId: summaryTwo.identity.audienceSpecId,
        batchId: 'batch.http.stale',
        subject: 'Your submission decision',
        audienceLabel: 'Accepted submissions'
      },
      parse: (value) => value
    }));
    expect(refused).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: {
        class: 'stale_revision',
        kind: 'communication.preview_changed',
        retryable: false,
        detailSchemaVersion: 1,
        detail: expect.objectContaining({
          includedCount: 1,
          irreversibleExternalEffectCount: 1
        })
      }
    });
    expect(count(runtime, 'communication_message_releases')).toBe(1);
    expect(count(runtime, 'communication_release_effect_specs')).toBe(1);
    expect(count(runtime, 'communication_release_receipt_links')).toBe(1);
    expect(count(runtime, 'communication_outbound_delivery_heads')).toBe(1);
    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  });

  test('joins effective category-target Forms to Vocabulary delete, merge, and compensation', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);

    await createEventThroughChangeset({
      runtime, session, key: 'category-reference-event'
    });

    const createTrack = async (name: string, expectedSetVersion: number, key: string) => {
      const draft = programVocabularyDraftOperationResultSchema.parse(await effect({
        runtime,
        session,
        path: '/api/events/current/program-vocabulary/drafts/create',
        key: `${key}-draft`,
        body: { kind: 'track', expectedSetVersion, name },
        parse: (value) => value
      }));
      if (draft.kind !== 'success') throw new Error('Track draft failed.');
      await commitDraft({ runtime, session, key, draft });
      const snapshot = programVocabularySnapshotReadResultSchema.parse(await (
        await runtime.app.request('/api/events/current/program-vocabulary', {
          headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
        })
      ).json());
      if (snapshot.kind !== 'success') throw new Error('Vocabulary read failed.');
      const track = snapshot.data.tracks.find((candidate) => candidate.name === name);
      if (!track) throw new Error('Committed track missing.');
      return track;
    };
    const source = await createTrack('Source Track', 1, 'category-source');
    const target = await createTrack('Target Track', 2, 'category-target');

    const formDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/create',
      key: 'category-form-create-draft',
      body: {
        expectedCatalogVersion: 1,
        expectedRegistryVersion: 1,
        definition: categoryFormDefinition(source.id)
      },
      parse: (value) => value
    }));
    if (formDraft.kind !== 'success') throw new Error('Category Form draft failed.');
    const formId = formDraft.data.safeDiff.after.id;
    await commitDraft({ runtime, session, key: 'category-form-create', draft: formDraft });

    const publishDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/publish',
      key: 'category-form-publish-draft',
      body: { formId, expectedDefinitionVersion: 1, expectedRegistryVersion: 1 },
      parse: (value) => value
    }));
    if (publishDraft.kind !== 'success') throw new Error('Category Form publish draft failed.');
    await commitDraft({ runtime, session, key: 'category-form-publish', draft: publishDraft });
    const publishedVersionId = publishDraft.data.safeDiff.action === 'publish'
      ? publishDraft.data.safeDiff.publishedVersion.id
      : (() => { throw new Error('Expected publish diff.'); })();
    const immutableVersion = runtime.database.sqlite.query<{
      readonly version_json: string;
      readonly version_digest_sha256: string;
    }, [string]>(`
      SELECT version_json, version_digest_sha256 FROM intake_form_versions
       WHERE form_version_id = ?
    `).get(publishedVersionId);

    const staleFormDraft = intakeFormDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/revise',
      key: 'category-form-stale-revise-draft',
      body: {
        formId,
        expectedDefinitionVersion: 2,
        expectedRegistryVersion: 1,
        definition: { ...categoryFormDefinition(source.id), name: 'Track CFP future edit' }
      },
      parse: (value) => value
    }));
    if (staleFormDraft.kind !== 'success') throw new Error('Stale Form fixture draft failed.');
    const staleFormSelector = {
      changesetId: staleFormDraft.data.changesetId,
      revisionId: staleFormDraft.data.revision.id,
      revisionDigest: staleFormDraft.data.revision.digestSha256
    };
    expect(changesetLifecycleOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/changesets/proposals',
      key: 'category-form-stale-revise-propose',
      body: { ...staleFormSelector, expectedHeadVersion: 1 },
      parse: (value) => value
    }))).toMatchObject({ kind: 'success', data: { action: 'propose' } });

    const vocabularyWithUsage = programVocabularySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/program-vocabulary', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(vocabularyWithUsage).toMatchObject({ kind: 'success', data: { setVersion: 3 } });
    if (vocabularyWithUsage.kind !== 'success') throw new Error('Vocabulary usage read failed.');
    expect(vocabularyWithUsage.data.tracks.find((track) => track.id === source.id))
      .toMatchObject({
        usage: { current: 1, historicalPins: 1 },
        deleteEligibility: { kind: 'blocked', currentReferences: 1, historicalPins: 1 }
      });
    expect(vocabularyWithUsage.data.tracks.find((track) => track.id === target.id))
      .toMatchObject({ usage: { current: 0, historicalPins: 0 } });

    const deleteDraft = programVocabularyDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/program-vocabulary/drafts/delete',
      key: 'category-source-delete-blocked',
      body: {
        kind: 'track', id: source.id,
        expectedSetVersion: 3, expectedItemVersion: source.version
      },
      parse: (value) => value
    }));
    expect(deleteDraft).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'policy_violation',
        kind: 'program_vocabulary.change_refused',
        detail: { code: 'delete_referenced', action: 'delete', kind: 'track', ids: [source.id] }
      }
    });
    expect(count(runtime, 'program_vocabulary_draft_receipt_links')).toBe(2);

    const mergeDraft = programVocabularyDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/program-vocabulary/drafts/merge',
      key: 'category-track-merge-draft',
      body: {
        kind: 'track', sourceId: source.id, targetId: target.id,
        expectedSetVersion: 3,
        expectedSourceVersion: source.version,
        expectedTargetVersion: target.version
      },
      parse: (value) => value
    }));
    expect(mergeDraft).toMatchObject({
      kind: 'success',
      data: {
        safeDiff: { action: 'merge', liveRepoints: 1, historicalPinsPreserved: 1 }
      }
    });
    if (mergeDraft.kind !== 'success') throw new Error('Track merge draft failed.');
    const mergeCommit = await commitDraft({
      runtime, session, key: 'category-track-merge', draft: mergeDraft
    });

    const detailAfterMerge = await runtime.app.request(
      `/api/events/current/forms/detail?formId=${encodeURIComponent(formId)}`,
      { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
    );
    expect(await detailAfterMerge.json()).toMatchObject({
      kind: 'success',
      data: {
        head: {
          version: 3,
          definition: { target: { category: { kind: 'track', id: target.id } } }
        },
        currentPublishedVersion: {
          id: publishedVersionId,
          definition: { target: { category: { kind: 'track', id: source.id } } },
          targetPin: {
            kind: 'category', categoryKind: 'track', id: source.id,
            name: 'Source Track', version: 1
          }
        }
      }
    });
    expect(runtime.database.sqlite.query(`
      SELECT version_json, version_digest_sha256 FROM intake_form_versions
       WHERE form_version_id = ?
    `).get(publishedVersionId)).toEqual(immutableVersion);
    expect(organizerFormCatalogReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/forms', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json())).toMatchObject({
      kind: 'success', data: { catalogVersion: 4, forms: [{ id: formId, version: 3 }] }
    });

    const staleFormCommit = changesetLifecycleOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/changesets/commits',
      key: 'category-form-stale-revise-commit',
      body: { ...staleFormSelector, expectedHeadVersion: 2 },
      parse: (value) => value
    }));
    expect(staleFormCommit).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: {
        class: 'stale_revision',
        kind: 'changeset.lifecycle_refused',
        detail: {
          code: 'base_version_changed',
          subjectId: `intake_form:${formId}`,
          expected: 2,
          actual: 3
        }
      }
    });
    expect(await (await runtime.app.request(
      `/api/events/current/forms/detail?formId=${encodeURIComponent(formId)}`,
      { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
    )).json()).toMatchObject({
      kind: 'success',
      data: {
        head: {
          version: 3,
          definition: { name: 'Track CFP', target: { category: { id: target.id } } }
        }
      }
    });

    const correction = changesetLifecycleOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/changesets/corrections',
      key: 'category-track-merge-correction',
      body: {
        sourceChangesetId: mergeCommit.selector.changesetId,
        sourceRevisionId: mergeCommit.selector.revisionId,
        sourceRevisionDigest: mergeCommit.selector.revisionDigest,
        sourceCommitReceiptId: mergeCommit.committed.receipt.id
      },
      parse: (value) => value
    }));
    expect(correction).toMatchObject({
      kind: 'success',
      data: { action: 'correction', resultKind: 'exact', target: { status: 'draft' } }
    });
    if (correction.kind !== 'success'
        || correction.data.action !== 'correction'
        || correction.data.target === null) {
      throw new Error('Track merge compensation draft failed.');
    }
    const correctionDraft = {
      data: {
        changesetId: correction.data.target.changesetId,
        revision: {
          id: correction.data.target.revisionId,
          digestSha256: correction.data.target.revisionDigest
        }
      }
    };
    await commitDraft({
      runtime, session, key: 'category-track-merge-compensation', draft: correctionDraft
    });

    const detailAfterCompensation = await runtime.app.request(
      `/api/events/current/forms/detail?formId=${encodeURIComponent(formId)}`,
      { headers: eventHeaders({ session, correlationId: crypto.randomUUID() }) }
    );
    expect(await detailAfterCompensation.json()).toMatchObject({
      kind: 'success',
      data: {
        head: {
          version: 4,
          definition: { target: { category: { kind: 'track', id: source.id } } }
        },
        currentPublishedVersion: { id: publishedVersionId, targetPin: { id: source.id } }
      }
    });
    expect(runtime.database.sqlite.query(`
      SELECT version_json, version_digest_sha256 FROM intake_form_versions
       WHERE form_version_id = ?
    `).get(publishedVersionId)).toEqual(immutableVersion);
    expect(organizerFormCatalogReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/forms', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json())).toMatchObject({
      kind: 'success', data: { catalogVersion: 5, forms: [{ id: formId, version: 4 }] }
    });
    const compensatedVocabulary = programVocabularySnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/program-vocabulary', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    expect(compensatedVocabulary).toMatchObject({ kind: 'success', data: { setVersion: 5 } });
    if (compensatedVocabulary.kind !== 'success') {
      throw new Error('Compensated Vocabulary read failed.');
    }
    expect(compensatedVocabulary.data.tracks.find((track) => track.id === source.id))
      .toMatchObject({ status: 'active', usage: { current: 1, historicalPins: 1 } });
    expect(compensatedVocabulary.data.tracks.find((track) => track.id === target.id))
      .toMatchObject({ status: 'active', usage: { current: 0, historicalPins: 0 } });
    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  });

  test('rejects missing sessions and fails closed on absent or untrusted mutation origins', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);

    const anonymousRead = await runtime.app.request('/api/events/current');
    expect(anonymousRead.status).toBe(401);
    expect(await anonymousRead.json()).toMatchObject({
      kind: 'transport_error',
      code: 'unauthenticated',
      retryable: false
    });

    const session = await createOwnerSession(runtime);
    const appUserId = await provisionOwner(runtime, session);
    runtime.database.sqlite.query(`
      DELETE FROM role_assignments
       WHERE workspace_id = ? AND user_id = ?
    `).run(runtime.workspaceId, appUserId);
    const unauthorizedCorrelation = crypto.randomUUID();
    const unauthorizedRead = await runtime.app.request('/api/events/current', {
      headers: eventHeaders({ session, correlationId: unauthorizedCorrelation })
    });
    expect(unauthorizedRead.status).toBe(200);
    expect(currentEventReadResultSchema.parse(await unauthorizedRead.json())).toEqual({
      kind: 'outcome',
      outcome: {
        class: 'access_denied',
        kind: 'authority.not_authorized',
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      },
      correlationId: unauthorizedCorrelation
    });
    for (const origin of [undefined, 'https://attacker.example']) {
      const response = await runtime.app.request('/api/events/drafts/create', {
        method: 'POST',
        headers: eventHeaders({
          session,
          correlationId: crypto.randomUUID(),
          idempotencyKey: 'origin-rejection',
          ...(origin ? { origin } : {})
        }),
        body: JSON.stringify({
          name: eventInput.name,
          timezone: eventInput.timezone,
          startDate: eventInput.startDate,
          endDate: eventInput.endDate
        })
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        kind: 'transport_error',
        code: 'forbidden',
        retryable: false
      });
    }

    const anonymousMutation = await runtime.app.request('/api/events/drafts/create', {
      method: 'POST',
      headers: eventHeaders({
        correlationId: crypto.randomUUID(),
        idempotencyKey: 'anonymous-rejection',
        origin: config.baseUrl
      }),
      body: JSON.stringify({
        name: eventInput.name,
        timezone: eventInput.timezone,
        startDate: eventInput.startDate,
        endDate: eventInput.endDate
      })
    });
    expect(anonymousMutation.status).toBe(401);
    expect(await anonymousMutation.json()).toMatchObject({
      kind: 'transport_error',
      code: 'unauthenticated',
      retryable: false
    });
    expect(count(runtime, 'foundation_trial_operation_receipts')).toBe(0);
    expect(count(runtime, 'event_spine_heads')).toBe(0);
  });

  test('publishes confirmed-and-visible program data to the public reads, re-gates rollback, and frames embeds from the surface allowlist', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);
    const [ada, bram, cleo] = await seedAcceptedSpeakers({
      runtime,
      session,
      key: 'publication-loop',
      speakers: [
        {
          key: 'ada',
          title: 'Typed changesets in production',
          name: 'Ada Alpha',
          email: 'ada.alpha@example.test'
        },
        {
          key: 'bram',
          title: 'Schedule physics for humans',
          name: 'Bram Beta',
          email: 'bram.beta@example.test'
        },
        {
          key: 'cleo',
          title: 'Signals without ceremony',
          name: 'Cleo Gamma',
          email: 'cleo.gamma@example.test'
        }
      ]
    });
    if (!ada || !bram || !cleo) throw new Error('Seeded speakers missing.');

    const servedScheduleResultSchema = createReadOperationResultSchema(servedPublicScheduleSchema);
    const servedRosterResultSchema = createReadOperationResultSchema(servedPublicRosterSchema);
    const readPublic = async (path: string) => {
      const response = await runtime.app.request(path);
      expect(response.status).toBe(200);
      const text = await response.text();
      return Object.freeze({ text, body: JSON.parse(text) as unknown });
    };

    // Nothing published yet: both public reads answer the typed absence —
    // never an empty world pretending to be a published one.
    for (const path of ['/api/public/schedule/current', '/api/public/speakers/current']) {
      const { body } = await readPublic(path);
      expect(body).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'conflict', kind: 'release.not_published', retryable: false }
      });
    }

    // Ada and Bram confirm; Cleo stays invited-but-unconfirmed.
    for (const [index, speaker] of [ada, bram].entries()) {
      const confirmDraft = engagementChangeDraftOperationResultSchema.parse(await effect({
        runtime,
        session,
        path: '/api/events/current/engagements/drafts',
        key: `publication-loop-confirm-${index}-draft`,
        body: {
          action: 'record_confirmation',
          engagementId: speaker.engagementId,
          expectedEngagementVersion: 1,
          attribution: 'organizer_recorded'
        },
        parse: (value) => value
      }));
      if (confirmDraft.kind !== 'success') throw new Error('Confirmation draft failed.');
      await commitDraft({
        runtime, session, key: `publication-loop-confirm-${index}`, draft: confirmDraft
      });
    }

    // Non-programmed catalog content that must never enter a release: one
    // collecting Session (placeable, still never public) and one draft.
    const catalogForCreate = sessionCatalogReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/sessions', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (catalogForCreate.kind !== 'success') throw new Error('Session catalog read failed.');
    const seededFormatId = catalogForCreate.data.sessions[0]?.programTarget.format.id;
    if (!seededFormatId) throw new Error('Seeded session format missing.');
    let catalogGuard = Object.freeze({
      version: catalogForCreate.data.version,
      digestSha256: catalogForCreate.data.digestSha256
    });
    for (const nonPublic of [
      { key: 'collecting', title: 'Hallway lightning pod', lifecycle: 'collecting' as const },
      { key: 'draft', title: 'Working notes placeholder', lifecycle: 'draft' as const }
    ]) {
      const createDraft = sessionDraftOperationResultSchema.parse(await effect({
        runtime,
        session,
        path: '/api/events/current/sessions/drafts',
        key: `publication-loop-${nonPublic.key}-draft`,
        body: {
          action: 'create',
          expectedCatalogVersion: catalogGuard.version,
          expectedCatalogDigestSha256: catalogGuard.digestSha256,
          title: nonPublic.title,
          plannedDurationMinutes: 30,
          lifecycle: nonPublic.lifecycle,
          formatId: seededFormatId,
          trackId: null
        },
        parse: (value) => value
      }));
      if (createDraft.kind !== 'success') throw new Error('Session create draft failed.');
      await commitDraft({
        runtime, session, key: `publication-loop-${nonPublic.key}`, draft: createDraft
      });
      const refreshed = sessionCatalogReadResultSchema.parse(await (
        await runtime.app.request('/api/events/current/sessions', {
          headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
        })
      ).json());
      if (refreshed.kind !== 'success') throw new Error('Session catalog re-read failed.');
      catalogGuard = Object.freeze({
        version: refreshed.data.version,
        digestSha256: refreshed.data.digestSha256
      });
    }

    // Release 1: both confirmed speakers visible. The reviewed diff carries
    // the audited name declassifications the commit copies into public state.
    const publishOne = releaseDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/releases/drafts',
      key: 'publication-loop-publish-1-draft',
      body: { action: 'publish_schedule', expectedCurrentReleaseNumber: null },
      parse: (value) => value
    }));
    if (publishOne.kind !== 'success') throw new Error('First publish draft failed.');
    const diffOne = publishOne.data.safeDiff;
    if (diffOne.action !== 'publish_schedule') throw new Error('First publish diff wrong arm.');
    expect(diffOne.before).toBeNull();
    expect(diffOne.after.number).toBe(1);
    expect(diffOne.releasedSessionCount).toBe(3);
    expect(diffOne.releasedOccurrenceCount).toBe(0);
    expect(diffOne.rollbackSuppressions).toBeNull();
    expect(diffOne.nameDeclassifications.map((entry) => entry.displayName).sort())
      .toEqual(['Ada Alpha', 'Bram Beta']);
    const releaseOneId = diffOne.after.releaseId;
    await commitDraft({ runtime, session, key: 'publication-loop-publish-1', draft: publishOne });

    const scheduleOne = await readPublic('/api/public/schedule/current');
    const scheduleOneResult = servedScheduleResultSchema.parse(scheduleOne.body);
    if (scheduleOneResult.kind !== 'success') throw new Error('Published schedule read failed.');
    expect(scheduleOneResult.data.releaseNumber).toBe(1);
    expect(scheduleOneResult.data.rooms).toEqual([]);
    expect(scheduleOneResult.data.sessions.map((entry) => entry.title).sort())
      .toEqual([ada.title, bram.title, cleo.title].sort());
    const speakersOne = new Map(scheduleOneResult.data.sessions.map(
      (entry) => [entry.sessionId, entry.speakers]
    ));
    expect(speakersOne.get(ada.sessionId)).toEqual(['Ada Alpha']);
    expect(speakersOne.get(bram.sessionId)).toEqual(['Bram Beta']);
    expect(speakersOne.get(cleo.sessionId)).toEqual([]);
    const rosterOne = await readPublic('/api/public/speakers/current');
    const rosterOneResult = servedRosterResultSchema.parse(rosterOne.body);
    if (rosterOneResult.kind !== 'success') throw new Error('Published roster read failed.');
    expect(rosterOneResult.data.speakers).toEqual([
      { name: 'Ada Alpha', sessions: [{ sessionId: ada.sessionId, title: ada.title }] },
      { name: 'Bram Beta', sessions: [{ sessionId: bram.sessionId, title: bram.title }] }
    ]);
    for (const text of [scheduleOne.text, rosterOne.text]) {
      // Response bytes: no unconfirmed name, no non-programmed content, no
      // contact data, no person key, no workspace scope.
      expect(text).not.toContain('Cleo Gamma');
      expect(text).not.toContain('Hallway lightning pod');
      expect(text).not.toContain('Working notes placeholder');
      expect(text).not.toContain('@example.test');
      expect(text).not.toContain(ada.personId);
      expect(text).not.toContain(bram.personId);
      expect(text).not.toContain(runtime.workspaceId);
    }

    // The organizer turns Bram's public visibility off through the mounted
    // roster_visibility session draft, then publishes the successor.
    const catalogBeforeHide = sessionCatalogReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/sessions', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (catalogBeforeHide.kind !== 'success') throw new Error('Session catalog read failed.');
    const bramSession = catalogBeforeHide.data.sessions.find(
      (candidate) => candidate.id === bram.sessionId
    );
    if (!bramSession) throw new Error('Bram session missing from the catalog.');
    const hideDraft = sessionDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/sessions/drafts',
      key: 'publication-loop-hide-draft',
      body: {
        action: 'roster_visibility',
        expectedCatalogVersion: catalogBeforeHide.data.version,
        expectedCatalogDigestSha256: catalogBeforeHide.data.digestSha256,
        sessionId: bram.sessionId,
        expectedSessionVersion: bramSession.version,
        expectedSessionDigestSha256: bramSession.digestSha256,
        personId: bram.personId,
        publiclyVisible: false
      },
      parse: (value) => value
    }));
    if (hideDraft.kind !== 'success') throw new Error('Roster visibility draft failed.');
    await commitDraft({ runtime, session, key: 'publication-loop-hide', draft: hideDraft });

    const publishTwo = releaseDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/releases/drafts',
      key: 'publication-loop-publish-2-draft',
      body: { action: 'publish_schedule', expectedCurrentReleaseNumber: 1 },
      parse: (value) => value
    }));
    if (publishTwo.kind !== 'success') throw new Error('Second publish draft failed.');
    const diffTwo = publishTwo.data.safeDiff;
    if (diffTwo.action !== 'publish_schedule') throw new Error('Second publish diff wrong arm.');
    expect(diffTwo.after.number).toBe(2);
    expect(diffTwo.nameDeclassifications.map((entry) => entry.displayName))
      .toEqual(['Ada Alpha']);
    await commitDraft({ runtime, session, key: 'publication-loop-publish-2', draft: publishTwo });

    const scheduleTwo = await readPublic('/api/public/schedule/current');
    const scheduleTwoResult = servedScheduleResultSchema.parse(scheduleTwo.body);
    if (scheduleTwoResult.kind !== 'success') throw new Error('Successor schedule read failed.');
    expect(scheduleTwoResult.data.releaseNumber).toBe(2);
    const speakersTwo = new Map(scheduleTwoResult.data.sessions.map(
      (entry) => [entry.sessionId, entry.speakers]
    ));
    expect(speakersTwo.get(ada.sessionId)).toEqual(['Ada Alpha']);
    expect(speakersTwo.get(bram.sessionId)).toEqual([]);
    const rosterTwo = await readPublic('/api/public/speakers/current');
    const rosterTwoResult = servedRosterResultSchema.parse(rosterTwo.body);
    if (rosterTwoResult.kind !== 'success') throw new Error('Successor roster read failed.');
    expect(rosterTwoResult.data.speakers.map((entry) => entry.name)).toEqual(['Ada Alpha']);
    expect(scheduleTwo.text).not.toContain('Bram Beta');
    expect(rosterTwo.text).not.toContain('Bram Beta');

    // Rolling back to release 1 restores the program but re-gates against
    // CURRENT state: Bram is still hidden, so the restorative successor
    // withholds the appearance and the reviewed diff says exactly which one.
    const rollback = releaseDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/releases/drafts',
      key: 'publication-loop-rollback-draft',
      body: {
        action: 'program_rollback',
        targetReleaseId: releaseOneId,
        expectedCurrentReleaseNumber: 2
      },
      parse: (value) => value
    }));
    if (rollback.kind !== 'success') throw new Error('Rollback draft failed.');
    const diffRollback = rollback.data.safeDiff;
    if (diffRollback.action !== 'program_rollback') throw new Error('Rollback diff wrong arm.');
    expect(diffRollback.after.number).toBe(3);
    expect(diffRollback.rollbackSuppressions).toEqual([
      { sessionId: bram.sessionId, personId: bram.personId }
    ]);
    expect(diffRollback.nameDeclassifications.map((entry) => entry.displayName))
      .toEqual(['Ada Alpha']);
    await commitDraft({ runtime, session, key: 'publication-loop-rollback', draft: rollback });

    const scheduleThree = await readPublic('/api/public/schedule/current');
    const scheduleThreeResult = servedScheduleResultSchema.parse(scheduleThree.body);
    if (scheduleThreeResult.kind !== 'success') throw new Error('Rollback schedule read failed.');
    expect(scheduleThreeResult.data.releaseNumber).toBe(3);
    const speakersThree = new Map(scheduleThreeResult.data.sessions.map(
      (entry) => [entry.sessionId, entry.speakers]
    ));
    expect(speakersThree.get(ada.sessionId)).toEqual(['Ada Alpha']);
    expect(speakersThree.get(bram.sessionId)).toEqual([]);
    expect(scheduleThree.text).not.toContain('Bram Beta');
    expect(scheduleThree.text).not.toContain('Cleo Gamma');

    // Embed delivery: the Bun request handler serves `/embed/<kind>` HTML
    // with exactly the surface head's stored allowlist and everything else
    // with the deny-all pair — through the runtime's own framing source.
    const embedDirectory = mkdtempSync(join(tmpdir(), 'jooevents-embed-join-'));
    embedBuildDirectories.push(embedDirectory);
    const buildRoot = join(embedDirectory, 'build');
    mkdirSync(buildRoot, { recursive: true });
    writeFileSync(join(buildRoot, 'index.html'), '<!doctype html><title>JooEvents shell</title>');
    const handler = createProductionRequestHandler({
      backend: (request) => runtime.app.fetch(request),
      buildDirectory: buildRoot,
      embedFraming: runtime.embedFraming
    });
    const navigate = (path: string) => handler(new Request(`http://localhost:5176${path}`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' }
    }));
    const expectDenyAll = async (path: string) => {
      const response = await navigate(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    };

    // Never-published surface: deny-all.
    await expectDenyAll('/embed/schedule');

    const styleDraft = releaseDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/releases/drafts',
      key: 'publication-loop-style-draft',
      body: {
        action: 'style_set_publish',
        recipe: {
          name: 'Default',
          canvas: '#ffffff',
          surface: '#f5f5f4',
          text: '#1c1917',
          action: '#0f766e',
          radius: 8,
          controlHeight: 36
        },
        expectedCurrentStyleSetNumber: null
      },
      parse: (value) => value
    }));
    if (styleDraft.kind !== 'success') throw new Error('Style set draft failed.');
    const styleDiff = styleDraft.data.safeDiff;
    if (styleDiff.action !== 'style_set_publish') throw new Error('Style diff wrong arm.');
    const styleSetReleaseId = styleDiff.after.releaseId;
    await commitDraft({ runtime, session, key: 'publication-loop-style', draft: styleDraft });

    const surfaceDraft = releaseDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/releases/drafts',
      key: 'publication-loop-surface-draft',
      body: {
        action: 'surface_publish',
        kind: 'schedule',
        manifest: { schemaVersion: 1, heading: 'Programme', intro: null },
        styleSetReleaseId,
        formRef: null,
        expectedSurfaceHeadVersion: null
      },
      parse: (value) => value
    }));
    if (surfaceDraft.kind !== 'success') throw new Error('Surface publish draft failed.');
    const surfaceDiff = surfaceDraft.data.safeDiff;
    if (surfaceDiff.action !== 'surface_publish') throw new Error('Surface diff wrong arm.');
    expect(surfaceDiff.after.allowedFrameOrigins).toEqual([]);
    await commitDraft({ runtime, session, key: 'publication-loop-surface', draft: surfaceDraft });

    // Published surface, empty allowlist: still deny-all.
    await expectDenyAll('/embed/schedule');

    const allowDraft = releaseDraftOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/releases/drafts',
      key: 'publication-loop-allowlist-draft',
      body: {
        action: 'surface_allowlist',
        kind: 'schedule',
        allowedFrameOrigins: ['https://partner.example.com'],
        expectedSurfaceHeadVersion: 1
      },
      parse: (value) => value
    }));
    if (allowDraft.kind !== 'success') throw new Error('Allowlist draft failed.');
    const allowDiff = allowDraft.data.safeDiff;
    if (allowDiff.action !== 'surface_allowlist') throw new Error('Allowlist diff wrong arm.');
    expect(allowDiff.before.allowedFrameOrigins).toEqual([]);
    expect(allowDiff.after.allowedFrameOrigins).toEqual(['https://partner.example.com']);
    await commitDraft({ runtime, session, key: 'publication-loop-allowlist', draft: allowDraft });

    const embedAllowed = await navigate('/embed/schedule');
    expect(embedAllowed.status).toBe(200);
    expect(embedAllowed.headers.get('content-security-policy'))
      .toBe('frame-ancestors https://partner.example.com');
    expect(embedAllowed.headers.get('x-frame-options')).toBeNull();
    expect(await embedAllowed.text()).toContain('JooEvents shell');

    // The allowlist frames exactly its own surface kind: the speakers embed,
    // an unknown embed segment, and the operator app all stay deny-all.
    await expectDenyAll('/embed/speakers');
    await expectDenyAll('/embed/unknown');
    await expectDenyAll('/app/schedule');

    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  }, 120_000);

  test('runs the portal loop: non-enumerating link request, attributed-identity resume, own-data snapshot, self-attributed confirmation, and lane isolation', async () => {
    // The portal loop drives the dev-only issued-link fixture, which is now
    // structurally gated: an ungated runtime deliberately omits that route.
    const runtime = await createEphemeralLiveRuntime({ config, devFixtures: true });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);
    const [petra, otto] = await seedAcceptedSpeakers({
      runtime,
      session,
      key: 'portal-loop',
      speakers: [
        {
          key: 'petra',
          title: 'Lanes for participants',
          name: 'Petra Portal',
          email: 'portal.speaker@example.test'
        },
        {
          key: 'otto',
          title: 'An entirely separate keynote',
          name: 'Otto Other',
          email: 'other.speaker@example.test'
        }
      ]
    });
    if (!petra || !otto) throw new Error('Seeded speakers missing.');

    const portalPost = (path: string, body: unknown, extraHeaders?: Record<string, string>) =>
      runtime.app.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: config.baseUrl,
          'x-correlation-id': crypto.randomUUID(),
          ...extraHeaders
        },
        body: JSON.stringify(body)
      });
    const signInThroughIssuedLink = async (email: string): Promise<string> => {
      const linkResponse = await portalPost('/api/portal/entry/link', { email });
      expect(linkResponse.status).toBe(200);
      expect(await linkResponse.json()).toEqual({ outcome: 'link_requested' });
      const issuedResponse = await portalPost('/api/portal/entry/dev/issued-link', { email });
      expect(issuedResponse.status).toBe(200);
      const issued = await issuedResponse.json() as { kind: string; url?: string };
      expect(issued.kind).toBe('issued');
      if (issued.kind !== 'issued' || !issued.url) throw new Error('Issued link missing.');
      const token = new URL(`${config.baseUrl}${issued.url}`).searchParams.get('token');
      if (!token) throw new Error('Issued link token missing.');
      const completeResponse = await portalPost('/api/portal/entry/complete', { token });
      expect(completeResponse.status).toBe(200);
      expect(await completeResponse.json()).toEqual({ outcome: 'signed_in' });
      const cookieMatch = /__Host-je_portal_session=([^;]+)/.exec(
        completeResponse.headers.get('set-cookie') ?? ''
      );
      if (!cookieMatch) throw new Error('Portal session cookie missing.');
      return `__Host-je_portal_session=${cookieMatch[1]}`;
    };

    // Non-enumeration: an unknown address receives the byte-identical frozen
    // acknowledgement a seeded speaker's address receives.
    const knownResponse = await portalPost('/api/portal/entry/link', { email: petra.email });
    expect(knownResponse.status).toBe(200);
    const knownBody = await knownResponse.json();
    const unknownResponse = await portalPost('/api/portal/entry/link', {
      email: 'unknown.person@example.test'
    });
    expect(unknownResponse.status).toBe(200);
    expect(await unknownResponse.json()).toEqual(knownBody);
    expect(knownBody).toEqual({ outcome: 'link_requested' });

    const petraCookie = await signInThroughIssuedLink(petra.email);

    // The repaired ceremony semantics: completion RESUMED the intake-attributed
    // identity — the family row carries the same person the Intake ceremony
    // attributed, adopted (never a parallel portal-minted pair).
    const familyRow = runtime.database.sqlite.query<{
      readonly person_id: string;
      readonly origin: string;
    }, [string]>(`
      SELECT person_id, origin FROM participant_identity_family
       WHERE normalized_email = ?
    `).get('portal.speaker@example.test');
    expect(familyRow).toEqual({ person_id: petra.personId, origin: 'adopted_attribution' });

    // The snapshot serves the signed-in participant's own world and nothing
    // of anyone else's — byte-checked, not just shape-checked.
    const snapshotResponse = await runtime.app.request('/api/portal/snapshot', {
      headers: { cookie: petraCookie, 'x-correlation-id': crypto.randomUUID() }
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshotText = await snapshotResponse.text();
    const snapshot = portalSnapshotReadResultSchema.parse(JSON.parse(snapshotText));
    if (snapshot.kind !== 'success') throw new Error('Portal snapshot read failed.');
    // The adopted identity's display name is the address local part: the
    // attribution source proves the pair identity only and deliberately
    // reads no classified name projection.
    expect(snapshot.data.participant).toMatchObject({
      displayName: 'portal.speaker',
      email: petra.email
    });
    expect(snapshot.data.submissions).toHaveLength(1);
    expect(snapshot.data.submissions[0]).toMatchObject({
      id: petra.submissionId,
      title: petra.title,
      status: 'submitted',
      statusNotifiedAt: null,
      speakers: [{ displayName: 'portal.speaker' }]
    });
    expect(snapshot.data.engagements).toHaveLength(1);
    expect(snapshot.data.engagements[0]).toMatchObject({
      id: petra.engagementId,
      sessionId: petra.sessionId,
      submissionId: petra.submissionId,
      status: 'invited',
      confirmation: null
    });
    expect(snapshot.data.tasks).toEqual([]);
    expect(snapshot.data.files).toEqual([]);
    for (const foreign of [
      otto.title, 'Otto Other', otto.email, otto.personId, otto.submissionId, otto.engagementId
    ]) {
      expect(snapshotText).not.toContain(foreign);
    }

    // A second person's snapshot is unreachable: the read takes no addressing
    // parameter at all, and without the lane cookie there is no snapshot.
    const anonymous = await runtime.app.request('/api/portal/snapshot');
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      kind: 'transport_error', code: 'unauthenticated', retryable: false
    });
    const addressed = await runtime.app.request(
      `/api/portal/snapshot?personId=${otto.personId}`,
      { headers: { cookie: petraCookie, 'x-correlation-id': crypto.randomUUID() } }
    );
    expect(addressed.status).toBe(400);
    expect(await addressed.json()).toMatchObject({
      kind: 'transport_error', code: 'invalid_request', retryable: false
    });

    // Confirming as self through the participant lane: no attribution claim
    // crosses the wire — the server derives it from the authenticated person.
    const respondResponse = await portalPost(
      '/api/portal/engagements/respond',
      { engagementId: petra.engagementId, response: 'confirm' },
      { cookie: petraCookie, 'idempotency-key': 'portal-loop-respond' }
    );
    expect(respondResponse.status).toBe(200);
    const responded = portalEngagementRespondResultSchema.parse(await respondResponse.json());
    if (responded.kind !== 'success') throw new Error('Portal respond failed.');
    expect(responded.data).toMatchObject({
      id: petra.engagementId,
      status: 'confirmed',
      confirmation: { by: 'you' }
    });

    // The operator engagement read shows the self attribution — the engaged
    // person's own act, no recording workspace user.
    const operatorRead = engagementSnapshotReadResultSchema.parse(await (
      await runtime.app.request('/api/events/current/engagements', {
        headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
      })
    ).json());
    if (operatorRead.kind !== 'success') throw new Error('Operator engagement read failed.');
    const petraEngagement = operatorRead.data.engagements.find(
      (candidate) => candidate.id === petra.engagementId
    );
    expect(petraEngagement).toMatchObject({
      state: 'confirmed',
      version: 2,
      confirmation: {
        attribution: 'self',
        personId: petra.personId,
        recordedByUserId: null
      }
    });
    const ottoEngagement = operatorRead.data.engagements.find(
      (candidate) => candidate.id === otto.engagementId
    );
    expect(ottoEngagement).toMatchObject({ state: 'invited', version: 1 });

    // Lane isolation both ways: Otto signs in and sees only Otto's world,
    // with Petra's act invisible to an unrelated participant.
    const ottoCookie = await signInThroughIssuedLink(otto.email);
    const ottoSnapshotResponse = await runtime.app.request('/api/portal/snapshot', {
      headers: { cookie: ottoCookie, 'x-correlation-id': crypto.randomUUID() }
    });
    expect(ottoSnapshotResponse.status).toBe(200);
    const ottoSnapshotText = await ottoSnapshotResponse.text();
    const ottoSnapshot = portalSnapshotReadResultSchema.parse(JSON.parse(ottoSnapshotText));
    if (ottoSnapshot.kind !== 'success') throw new Error('Second portal snapshot failed.');
    expect(ottoSnapshot.data.participant).toMatchObject({
      displayName: 'other.speaker',
      email: otto.email
    });
    expect(ottoSnapshot.data.submissions.map((entry) => entry.id)).toEqual([otto.submissionId]);
    expect(ottoSnapshot.data.engagements).toHaveLength(1);
    expect(ottoSnapshot.data.engagements[0]).toMatchObject({
      id: otto.engagementId,
      status: 'invited'
    });
    for (const foreign of [
      petra.title, 'Petra Portal', petra.email, petra.personId,
      petra.submissionId, petra.engagementId
    ]) {
      expect(ottoSnapshotText).not.toContain(foreign);
    }

    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  }, 120_000);

  test('the dev issued-link token oracle is structurally absent unless devFixtures is set', async () => {
    // The gate is structure, not convention: the default (ungated) composition
    // — which is what the beyond-loopback entry uses in production posture —
    // never mounts the route, so a remote peer cannot mint a magic-link token.
    // A caller must opt in explicitly for it to exist.
    const ungated = await createEphemeralLiveRuntime({ config });
    runtimes.push(ungated);
    const ungatedResponse = await ungated.app.request('/api/portal/entry/dev/issued-link', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: config.baseUrl,
        'x-correlation-id': crypto.randomUUID()
      },
      body: JSON.stringify({ email: 'anyone@example.test' })
    });
    expect(ungatedResponse.status).toBe(404);

    const gated = await createEphemeralLiveRuntime({ config, devFixtures: true });
    runtimes.push(gated);
    const gatedResponse = await gated.app.request('/api/portal/entry/dev/issued-link', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: config.baseUrl,
        'x-correlation-id': crypto.randomUUID()
      },
      body: JSON.stringify({ email: 'anyone@example.test' })
    });
    // Mounted and reachable; with no issued challenge it honestly answers none.
    expect(gatedResponse.status).toBe(200);
    expect(await gatedResponse.json()).toEqual({ kind: 'none' });
  }, 120_000);
});
