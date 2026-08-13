import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import {
  currentEventReadResultSchema,
  currentEventSettingsReadResultSchema,
  createReadOperationResultSchema,
  decisionDecideDraftOperationResultSchema,
  decisionStateReadResultSchema,
  emailProviderConfigurationReadOperationResultSchema,
  emailProviderReadinessReadOperationResultSchema,
  eventCreateDraftOperationResultSchema,
  eventSettingsUpdateDraftOperationResultSchema,
  fieldRegistrySnapshotReadResultSchema,
  organizerCommunicationAudienceOptionPageOperationResultSchema,
  organizerCommunicationAuthoringPayloadOperationResultSchema,
  organizerCommunicationDraftMutationOperationResultSchema,
  organizerCommunicationDraftPageOperationResultSchema,
  organizerCommunicationPurposePageOperationResultSchema,
  organizerMessageTemplatePageOperationResultSchema,
  organizerFormCatalogSchema,
  programVocabularySnapshotReadResultSchema,
  safeOperationManifestSchema,
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
import { sessionCatalogReadResultSchema } from '@jooevents/contracts/sessions';
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
import { loadEphemeralLiveConfig } from '../config';
import { createEphemeralLiveRuntime, type EphemeralLiveRuntime } from './ephemeral-live';

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

afterEach(() => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    if (!runtime) continue;
    runtime.close();
    cleanupRetainedTree(runtime.database.directoryPath);
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
        // it can draw a grid from day one (Wave-2 recorder defaults).
        dayStart: '09:00',
        dayEnd: '18:00',
        slotMinutes: 30
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
        // The update draft carried no geometry fields, so the seeded creation
        // defaults survive the settings update unchanged.
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
            'schedule.placement.draft',
            'schedule.placement.snapshot.read',
            'schedule.session.manage',
            'schedule.session.read'
          ],
          unavailableCapabilities: [
            'schedule.break.manage',
            'schedule.placement.unplace',
            'schedule.publish'
          ]
        }, {
          area: 'messages',
          status: 'partial',
          availableCapabilities: ['communication.email_readiness.read'],
          unavailableCapabilities: [
            'create_email_provider_connection_draft',
            'get_delivery_history',
            'preview_message_batch',
            'send_messages'
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

  test('mounts factual Communications catalogs and inert classified authoring without product defaults', async () => {
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
    const readPaths = Object.freeze([
      Object.freeze({
        path: '/api/events/current/communications/purposes',
        schema: organizerCommunicationPurposePageOperationResultSchema
      }),
      Object.freeze({
        path: '/api/events/current/communications/templates',
        schema: organizerMessageTemplatePageOperationResultSchema
      }),
      Object.freeze({
        path: '/api/events/current/communications/drafts',
        schema: organizerCommunicationDraftPageOperationResultSchema
      }),
      Object.freeze({
        path: '/api/events/current/communications/audiences/options',
        schema: organizerCommunicationAudienceOptionPageOperationResultSchema
      })
    ]);
    for (const { path, schema } of readPaths) {
      const result = schema.parse(await (
        await runtime.app.request(path, {
          headers: eventHeaders({ session, correlationId: crypto.randomUUID() })
        })
      ).json());
      expect(result).toMatchObject({
        kind: 'success', data: { schemaVersion: 1, rows: [], page: { hasMore: false } }
      });
    }

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
    expect(count(runtime, 'communication_authoring_payloads')).toBe(1);
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
    // The draft is inert: no Decision head, origin link, or Session yet.
    expect(count(runtime, 'decision_draft_receipt_links')).toBe(1);
    expect(count(runtime, 'decision_draft_timeline')).toBe(1);
    expect(count(runtime, 'decision_heads')).toBe(0);
    expect(count(runtime, 'submission_session_origins')).toBe(0);
    expect(count(runtime, 'sessions')).toBe(0);

    await commitDraft({ runtime, session, key: 'decision-loop-decide', draft: decideDraft });
    expect(count(runtime, 'decision_heads')).toBe(1);
    expect(count(runtime, 'submission_session_origins')).toBe(1);
    expect(count(runtime, 'sessions')).toBe(1);
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
});
