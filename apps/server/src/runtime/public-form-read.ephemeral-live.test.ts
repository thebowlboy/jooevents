import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import {
  createReadOperationResultSchema,
  eventCreateDraftOperationResultSchema,
  fieldRegistrySnapshotReadResultSchema,
  releaseDraftOperationResultSchema,
  safeOperationManifestSchema,
  servedPublicFormSchema,
  templateArtifactListOperationResultSchema
} from '@jooevents/contracts';
import {
  changesetLifecycleOperationResultSchema
} from '@jooevents/changeset-operations';
import {
  intakeFormDraftOperationResultSchema
} from '@jooevents/intake-operations';
import { loadEphemeralLiveConfig } from '../config';
import { createEphemeralLiveRuntime, type EphemeralLiveRuntime } from './ephemeral-live';

const publicFormReadResultSchema = createReadOperationResultSchema(servedPublicFormSchema);
const runtimes: EphemeralLiveRuntime[] = [];
const config = loadEphemeralLiveConfig({
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
  JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
  JOOEVENTS_ADMISSION_MODE: 'pending',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'ignored-by-public-form-read-test.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/ignored-by-public-form-read-test'
});

interface BrowserSession {
  readonly authUserId: string;
  readonly cookie: string;
}

const FORM_NAME = 'Public-safe CFP';
const FORM_CONFIRMATION = 'Application received.';

function cleanupRetainedTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
      || !basename(path).startsWith('jooevents-ephemeral-runtime-')) {
    throw new Error(`unsafe_public_form_read_cleanup:${path}`);
  }
  if (dirname(path) !== realpathSync(dirname(path))) {
    throw new Error(`unsafe_public_form_read_parent:${path}`);
  }
  rmSync(path, { recursive: true });
}

afterEach(() => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    if (!runtime) continue;
    runtime.close();
    cleanupRetainedTree(runtime.database.directoryPath);
  }
});

async function createOwnerSession(runtime: EphemeralLiveRuntime): Promise<BrowserSession> {
  const now = Date.now();
  const authUserId = crypto.randomUUID();
  const rawToken = crypto.randomUUID();
  runtime.database.sqlite.query(`
    INSERT INTO auth_users (
      id, name, email, email_verified, image, created_at, updated_at
    ) VALUES (?, 'Public read owner', ?, 1, NULL, ?, ?)
  `).run(authUserId, config.bootstrapOwnerEmail, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_accounts (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES (?, ?, 'google', ?, ?, ?)
  `).run(crypto.randomUUID(), `google-${crypto.randomUUID()}`, authUserId, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_sessions (
      id, token, user_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), rawToken, authUserId, now + 3_600_000, now, now);
  const secret = config.authSecrets[0]?.value;
  if (!secret) throw new Error('public_form_read_auth_secret_missing');
  const signature = await makeSignature(rawToken, secret);
  return Object.freeze({
    authUserId,
    cookie: `better-auth.session_token=${rawToken}.${signature}`
  });
}

async function provisionOwner(
  runtime: EphemeralLiveRuntime,
  session: BrowserSession
): Promise<void> {
  const response = await runtime.app.request('/api/me/access-context', {
    headers: { cookie: session.cookie, 'x-correlation-id': crypto.randomUUID() }
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: 'active',
    workspace: { id: runtime.workspaceId }
  });
}

function operatorHeaders(input: {
  readonly session: BrowserSession;
  readonly key?: string;
}): Headers {
  const headers = new Headers({
    cookie: input.session.cookie,
    origin: config.baseUrl,
    'content-type': 'application/json',
    'x-correlation-id': crypto.randomUUID()
  });
  if (input.key) headers.set('idempotency-key', input.key);
  return headers;
}

async function effect(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly session: BrowserSession;
  readonly path: string;
  readonly key: string;
  readonly body: unknown;
}): Promise<unknown> {
  const response = await input.runtime.app.request(input.path, {
    method: 'POST',
    headers: operatorHeaders({ session: input.session, key: input.key }),
    body: JSON.stringify(input.body)
  });
  expect(response.status).toBe(200);
  return response.json();
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
}): Promise<void> {
  const selector = Object.freeze({
    changesetId: input.draft.data.changesetId,
    revisionId: input.draft.data.revision.id,
    revisionDigest: input.draft.data.revision.digestSha256
  });
  const proposed = changesetLifecycleOperationResultSchema.parse(await effect({
    runtime: input.runtime,
    session: input.session,
    path: '/api/changesets/proposals',
    key: `${input.key}-propose`,
    body: { ...selector, expectedHeadVersion: 1 }
  }));
  expect(proposed).toMatchObject({ kind: 'success', data: { action: 'propose' } });
  const committed = changesetLifecycleOperationResultSchema.parse(await effect({
    runtime: input.runtime,
    session: input.session,
    path: '/api/changesets/commits',
    key: `${input.key}-commit`,
    body: { ...selector, expectedHeadVersion: 2 }
  }));
  expect(committed).toMatchObject({ kind: 'success', data: { action: 'commit' } });
}

async function createEvent(
  runtime: EphemeralLiveRuntime,
  session: BrowserSession
): Promise<void> {
  const draft = eventCreateDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/drafts/create',
    key: 'public-read-event-draft',
    body: {
      name: 'Public Read Event',
      timezone: 'Asia/Singapore',
      startDate: '2027-06-10',
      endDate: '2027-06-12'
    }
  }));
  if (draft.kind !== 'success') throw new Error('public_read_event_draft_failed');
  await commitDraft({ runtime, session, key: 'public-read-event', draft });
}

async function readFieldRegistry(
  runtime: EphemeralLiveRuntime,
  session: BrowserSession
) {
  const response = await runtime.app.request('/api/events/current/field-registry', {
    headers: operatorHeaders({ session })
  });
  expect(response.status).toBe(200);
  const result = fieldRegistrySnapshotReadResultSchema.parse(await response.json());
  if (result.kind !== 'success') throw new Error('public_read_field_registry_missing');
  return result.data;
}

async function createForm(
  runtime: EphemeralLiveRuntime,
  session: BrowserSession
): Promise<string> {
  const registry = await readFieldRegistry(runtime, session);
  const included = new Set(registry.fields
    .filter((field) => field.mapsTo === 'talk.title' || field.mapsTo === 'person.email')
    .map((field) => field.id));
  if (included.size !== 2) throw new Error('public_read_structural_fields_missing');
  const definition = {
    kind: 'cfp' as const,
    name: FORM_NAME,
    target: { kind: 'general_pool' as const },
    availability: { kind: 'evergreen' as const },
    confirmation: FORM_CONFIRMATION,
    composition: {
      excludedFieldIds: registry.fields
        .filter((field) => field.scope.kind === 'shared'
          && field.contexts.apply.visible
          && !included.has(field.id))
        .map((field) => field.id)
        .sort(),
      requiredOverrides: {},
      optionExposure: {}
    },
    rules: []
  };
  const draft = intakeFormDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/forms/drafts/create',
    key: 'public-read-form-create-draft',
    body: {
      expectedCatalogVersion: 1,
      expectedRegistryVersion: registry.version,
      definition
    }
  }));
  if (draft.kind !== 'success' || draft.data.safeDiff.action !== 'create') {
    throw new Error('public_read_form_create_failed');
  }
  await commitDraft({ runtime, session, key: 'public-read-form-create', draft });
  return draft.data.safeDiff.after.id;
}

async function changeForm(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly session: BrowserSession;
  readonly path: string;
  readonly key: string;
  readonly body: unknown;
}) {
  const draft = intakeFormDraftOperationResultSchema.parse(await effect(input));
  if (draft.kind !== 'success') throw new Error(`${input.key}_failed`);
  await commitDraft({
    runtime: input.runtime,
    session: input.session,
    key: input.key.replace(/-draft$/, ''),
    draft
  });
  return draft;
}

async function publicRead(
  runtime: EphemeralLiveRuntime,
  formId: string,
  cookie?: string
) {
  const response = await runtime.app.request(
    `/api/public/forms/current?formId=${encodeURIComponent(formId)}`,
    {
      headers: {
        'x-correlation-id': crypto.randomUUID(),
        ...(cookie ? { cookie } : {})
      }
    }
  );
  expect(response.status).toBe(200);
  return Object.freeze({
    result: publicFormReadResultSchema.parse(await response.json()),
    headers: response.headers
  });
}

async function expectFailedClosed(
  runtime: EphemeralLiveRuntime,
  formId: string
): Promise<void> {
  const response = await runtime.app.request(
    `/api/public/forms/current?formId=${encodeURIComponent(formId)}`,
    { headers: { 'x-correlation-id': crypto.randomUUID() } }
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    kind: 'transport_error', code: 'unauthenticated', retryable: false
  });
}

async function publishApplySurface(
  runtime: EphemeralLiveRuntime,
  session: BrowserSession,
  formRef: { readonly formId: string; readonly formVersionId: string }
): Promise<void> {
  const artifactResponse = await runtime.app.request('/api/events/current/template-artifacts', {
    headers: operatorHeaders({ session })
  });
  const artifacts = templateArtifactListOperationResultSchema.parse(await artifactResponse.json());
  if (artifacts.kind !== 'success') throw new Error('public_read_templates_missing');
  const theme = artifacts.data.artifacts.find((entry) => entry.current.document.kind === 'theme');
  const apply = artifacts.data.artifacts.find((entry) =>
    entry.current.document.kind === 'surface'
    && entry.current.document.surfaceKind === 'application-form'
  );
  if (!theme || theme.current.document.kind !== 'theme'
      || !apply || apply.current.document.kind !== 'surface') {
    throw new Error('public_read_presentation_templates_missing');
  }
  const pin = (entry: typeof theme) => ({
    artifactId: entry.head.artifactId,
    revisionId: entry.current.revisionId,
    revisionNumber: entry.current.number,
    digestSha256: entry.current.digestSha256
  });
  const hero = apply.current.document.blocks.find((block) => block.type === 'hero');
  const normalized = (value: string) => {
    const text = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
    return text.length === 0 ? null : text;
  };
  const styleDraft = releaseDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/releases/drafts',
    key: 'public-read-style-draft',
    body: {
      action: 'style_set_publish',
      sourceTemplateRevision: pin(theme),
      recipe: theme.current.document.recipe,
      expectedCurrentStyleSetNumber: null
    }
  }));
  if (styleDraft.kind !== 'success' || styleDraft.data.safeDiff.action !== 'style_set_publish') {
    throw new Error('public_read_style_set_draft_failed');
  }
  await commitDraft({ runtime, session, key: 'public-read-style', draft: styleDraft });
  const surfaceDraft = releaseDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/releases/drafts',
    key: 'public-read-surface-draft',
    body: {
      action: 'surface_publish',
      kind: 'apply',
      sourceTemplateRevision: pin(apply as typeof theme),
      manifest: {
        schemaVersion: 1,
        heading: hero ? normalized(hero.title) : null,
        intro: hero ? normalized(hero.intro) : null
      },
      styleSetReleaseId: styleDraft.data.safeDiff.after.releaseId,
      formRef,
      expectedSurfaceHeadVersion: null
    }
  }));
  if (surfaceDraft.kind !== 'success') throw new Error('public_read_surface_draft_failed');
  await commitDraft({ runtime, session, key: 'public-read-surface', draft: surfaceDraft });
}

describe('ephemeral live open public Form read', () => {
  test('serves only the current open safe DTO while every application path stays absent', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);
    await createEvent(runtime, session);

    const manifest = safeOperationManifestSchema.parse(await (
      await runtime.app.request('/api/operations/manifest')
    ).json());
    expect(manifest.operations.some((operation) =>
      operation.name === 'form.public.read'
      || operation.enabledBindings.some((binding) =>
        binding.protocol === 'http' && binding.path.startsWith('/api/public/')
      )
    )).toBe(false);
    expect((await runtime.app.request('/api/public/operations/manifest')).status).toBe(404);

    // Without a published apply surface release NOTHING serves: known,
    // unknown, and malformed requests alike answer the undistinguishing 401,
    // because evidence is gated before any input is even parsed.
    await expectFailedClosed(runtime, crypto.randomUUID());
    const preSurfaceMalformed = await runtime.app.request('/api/public/forms/current');
    expect(preSurfaceMalformed.status).toBe(401);

    const formId = await createForm(runtime, session);
    // A created — even an open — form alone publishes nothing.
    await expectFailedClosed(runtime, formId);

    const registry = await readFieldRegistry(runtime, session);
    const opened = await changeForm({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/lifecycle',
      key: 'public-read-form-publish-and-open-draft',
      body: {
        transition: 'publish_and_open',
        formId,
        expectedDefinitionVersion: 1,
        expectedRegistryVersion: registry.version
      }
    });
    if (opened.data.safeDiff.action !== 'lifecycle'
        || opened.data.safeDiff.publishedVersion === null) {
      throw new Error('public_read_form_publish_and_open_diff_missing');
    }
    const formVersionId = opened.data.safeDiff.publishedVersion.id;
    await expectFailedClosed(runtime, formId);

    // Publishing the apply surface release activates the read — and only
    // then do malformed requests earn a 400 instead of the closed 401.
    await publishApplySurface(runtime, session, { formId, formVersionId });
    for (const path of [
      '/api/public/forms/current',
      '/api/public/forms/current?formId=not-an-id',
      `/api/public/forms/current?formId=${formId}&formId=${formId}`,
      `/api/public/forms/current?formId=${formId}&workspaceId=${runtime.workspaceId}`
    ]) {
      const response = await runtime.app.request(path);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        kind: 'transport_error', code: 'invalid_request', retryable: false
      });
    }
    const anonymous = await publicRead(runtime, formId);
    expect(anonymous.result).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        formId,
        formVersionId,
        formVersionNumber: 1,
        name: FORM_NAME,
        confirmation: FORM_CONFIRMATION,
        target: { kind: 'general_pool' },
        availability: { kind: 'evergreen' },
        rules: []
      }
    });
    if (anonymous.result.kind !== 'success') {
      throw new Error('public_read_open_form_missing');
    }
    expect(Object.keys(anonymous.result.data).sort()).toEqual([
      'availability', 'confirmation', 'fields', 'formId', 'formVersionId',
      'formVersionNumber', 'name', 'rules', 'schemaVersion', 'target'
    ]);
    expect(anonymous.result.data.fields.map((field) => ({
      kind: field.kind,
      label: field.label,
      required: field.required,
      position: field.position
    }))).toEqual([
      { kind: 'email', label: 'Email', required: true, position: 0 },
      { kind: 'text', label: 'Talk title', required: true, position: 1 }
    ]);
    expect(anonymous.headers.get('cache-control')).toBe('no-store, max-age=0');
    const safeBytes = JSON.stringify(anonymous.result.data);
    for (const forbidden of [
      'workspaceId', 'eventId', 'publishedByUserId', 'updatedByUserId',
      'definitionDigestSha256', 'currentPublishedVersionId', 'participant_email'
    ]) {
      expect(safeBytes).not.toContain(forbidden);
    }

    // With the surface pinned, probing any OTHER well-formed formId answers
    // byte-for-byte like no surface at all: ids must not be an oracle for
    // which form is served. Same correlation id on both sides so the bodies
    // can be compared exactly.
    const probeCorrelation = crypto.randomUUID();
    const probe = async (probedFormId: string) => {
      const response = await runtime.app.request(
        `/api/public/forms/current?formId=${encodeURIComponent(probedFormId)}`,
        { headers: { 'x-correlation-id': probeCorrelation } }
      );
      expect(response.status).toBe(401);
      return response.text();
    };
    const unservedProbe = await probe(crypto.randomUUID());
    const uppercasedProbe = await probe(crypto.randomUUID().toUpperCase());
    expect(uppercasedProbe).toBe(unservedProbe);

    const withOrganizerSession = await publicRead(runtime, formId, session.cookie);
    expect(withOrganizerSession.result.kind).toBe('success');
    if (withOrganizerSession.result.kind !== 'success') {
      throw new Error('public_read_session_isolation_failed');
    }
    expect(withOrganizerSession.result.data).toEqual(anonymous.result.data);

    // Closing the form closes the whole gate: the surface release still pins
    // the form, but a closed form fails the resolution, so the read reverts
    // to the same undistinguishing 401 an unpublished surface answers.
    await changeForm({
      runtime,
      session,
      path: '/api/events/current/forms/drafts/lifecycle',
      key: 'public-read-form-close-draft',
      body: { transition: 'close', formId, expectedDefinitionVersion: 2 }
    });
    await expectFailedClosed(runtime, formId);
    // The gate-refused body and the wrong-id-while-pinned body are the same
    // bytes under the same correlation id: the two refusals are one refusal.
    expect(await probe(formId)).toBe(unservedProbe);

    // The application ceremony paths are mounted but sealed: requests
    // without the ceremony protocol are invalid, and the read binding
    // answers no method beyond its registered GET.
    for (const [path, init] of [
      ['/api/public/forms/application', undefined],
      ['/api/public/forms/application/continuations', { method: 'POST' }],
      ['/api/public/forms/application/mutate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      }]
    ] as const) {
      const response = await runtime.app.request(path, init);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        kind: 'transport_error', code: 'invalid_request'
      });
    }
    const wrongMethod = await runtime.app.request('/api/public/forms/current', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    expect(wrongMethod.status).toBe(404);
    expect(await wrongMethod.json()).toMatchObject({ code: 'route_not_found' });
  });
});
