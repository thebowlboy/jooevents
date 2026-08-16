import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import {
  createReadOperationResultSchema,
  decisionDecideOperationResultSchema,
  engagementSnapshotReadResultSchema,
  fieldRegistrySnapshotReadResultSchema,
  organizerFormCatalogSchema,
  programVocabularySnapshotReadResultSchema,
  sessionCatalogReadResultSchema,
  submissionDirectEntryOperationResultSchema
} from '@jooevents/contracts';
import {
  organizerFileOverviewSchema,
  portalEngagementFilesSchema
} from '@jooevents/contracts/files';
import { deadlineChangeOperationResultSchema } from '@jooevents/contracts/deadlines';
import {
  eventCreateOperationResultSchema,
  intakeFormDirectOperationResultSchema,
  intakeFormVersionPublishOperationResultSchema,
  intakeFormVersionReviewDraftOperationResultSchema,
  programVocabularyDirectOperationResultSchema
} from '@jooevents/contracts';
import { loadEphemeralLiveConfig } from '../config';
import { createEphemeralLiveRuntime, type EphemeralLiveRuntime } from './ephemeral-live';

/**
 * THE files acceptance loop, joined end to end over the mounted operations:
 * an organizer shares a resource and creates a typed file request against a
 * confirmed engagement; the speaker sees the ask in the portal, streams a
 * real PDF through the two-phase upload (intent → bytes → confirm by hash),
 * attaches it, and fulfils the request; the organizer lists everything and
 * downloads the exact bytes with attachment-only inert headers. Cross-
 * engagement acts, oversize uploads, and disallowed types refuse structurally,
 * and the D7 orphan sweep collects exactly the never-attached asset after the
 * grace window while detach history keeps record AND bytes.
 */

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
  JOOEVENTS_DATABASE_PATH: 'ignored-by-files-joined-test.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/ignored-by-files-joined-test'
});

const organizerFileOverviewReadResultSchema =
  createReadOperationResultSchema(organizerFileOverviewSchema);
const portalEngagementFilesReadResultSchema =
  createReadOperationResultSchema(portalEngagementFilesSchema);
const organizerFormCatalogReadResultSchema =
  createReadOperationResultSchema(organizerFormCatalogSchema);

interface BrowserSession {
  readonly authUserId: string;
  readonly cookie: string;
}

function cleanupRetainedTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
      || !basename(path).startsWith('jooevents-ephemeral-runtime-')) {
    throw new Error(`unsafe_files_joined_cleanup:${path}`);
  }
  if (dirname(path) !== realpathSync(dirname(path))) {
    throw new Error(`unsafe_files_joined_parent:${path}`);
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
    ) VALUES (?, 'Files Owner', ?, 1, NULL, ?, ?)
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
  if (!secret) throw new Error('files_joined_auth_secret_missing');
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

async function operatorRead(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly session: BrowserSession;
  readonly path: string;
}): Promise<unknown> {
  const response = await input.runtime.app.request(input.path, {
    headers: {
      cookie: input.session.cookie,
      'x-correlation-id': crypto.randomUUID()
    }
  });
  expect(response.status).toBe(200);
  return response.json();
}

interface SeededSpeaker {
  readonly title: string;
  readonly name: string;
  readonly email: string;
  readonly submissionId: string;
  readonly engagementId: string;
}

/**
 * Seeds the shared world through the mounted operations only: one Event, one
 * format, one open format-targeted CFP, one committed direct entry per
 * speaker, and one accept-with-spawn decision commit, leaving each speaker
 * with an `invited` engagement.
 */
async function seedAcceptedSpeakers(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly session: BrowserSession;
  readonly key: string;
  readonly speakers: readonly { readonly key: string; readonly title: string; readonly name: string; readonly email: string }[];
}): Promise<readonly SeededSpeaker[]> {
  const { runtime, session, key } = input;
  const eventCreated = eventCreateOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events',
    key: `${key}-event-create`,
    body: {
      expectedEventSetVersion: 1,
      name: 'Files Summit',
      timezone: 'Asia/Singapore',
      startDate: '2027-06-10',
      endDate: '2027-06-12'
    }
  }));
  if (eventCreated.kind !== 'success') throw new Error('Event create failed.');

  const formatDraft = programVocabularyDirectOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/program-vocabulary/create',
    key: `${key}-format-draft`,
    body: { kind: 'format', expectedSetVersion: 1, name: 'Talk' }
  }));
  if (formatDraft.kind !== 'success') throw new Error('Format draft failed.');
  const vocabulary = programVocabularySnapshotReadResultSchema.parse(
    await operatorRead({ runtime, session, path: '/api/events/current/program-vocabulary' })
  );
  if (vocabulary.kind !== 'success') throw new Error('Vocabulary read failed.');
  const format = vocabulary.data.formats.find((candidate) => candidate.name === 'Talk');
  if (!format) throw new Error('Committed format missing.');

  const registryResult = fieldRegistrySnapshotReadResultSchema.parse(
    await operatorRead({ runtime, session, path: '/api/events/current/field-registry' })
  );
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

  const formCreated = intakeFormDirectOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/forms/create',
    key: `${key}-form-create`,
    body: {
      expectedCatalogVersion: 1,
      expectedRegistryVersion: registry.version,
      definition: {
        kind: 'cfp',
        name: 'Speaker CFP',
        target: { kind: 'category', category: { kind: 'format', id: format.id } },
        availability: { kind: 'evergreen' },
        confirmation: 'Application received.',
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
      }
    }
  }));
  if (formCreated.kind !== 'success' || formCreated.data.action !== 'create') {
    throw new Error('Form create failed.');
  }
  const openReview = intakeFormVersionReviewDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/forms/publish/draft',
    key: `${key}-form-open-review`,
    body: {
      action: 'publish_and_open',
      formId: formCreated.data.formId,
      expectedDefinitionVersion: 1,
      expectedRegistryVersion: registry.version
    }
  }));
  if (openReview.kind !== 'success') throw new Error('Form open review failed.');
  const opened = intakeFormVersionPublishOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/forms/publish',
    key: `${key}-form-open-publish`,
    body: {
      draftId: openReview.data.draftId,
      revisionId: openReview.data.revision.id,
      revisionDigestSha256: openReview.data.revision.digestSha256
    }
  }));
  if (opened.kind !== 'success') throw new Error('Form open publish failed.');
  const catalog = organizerFormCatalogReadResultSchema.parse(
    await operatorRead({ runtime, session, path: '/api/events/current/forms' })
  );
  if (catalog.kind !== 'success') throw new Error('Form catalog read failed.');
  const openForm = catalog.data.forms.find((form) => form.status === 'open');
  if (!openForm) throw new Error('Open form missing.');

  const submissionIds: string[] = [];
  for (const speaker of input.speakers) {
    const entryResult = submissionDirectEntryOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/submissions/direct-entry',
      key: `${key}-entry-${speaker.key}`,
      body: {
        formId: openForm.id,
        expectedFormDefinitionVersion: openForm.version,
        answers: [
          { kind: 'text', fieldId: titleFieldId, value: speaker.title },
          { kind: 'text', fieldId: nameFieldId, value: speaker.name },
          { kind: 'email', fieldId: emailFieldId, value: speaker.email }
        ]
      }
    }));
    if (entryResult.kind !== 'success') throw new Error('Direct entry failed.');
    submissionIds.push(entryResult.data.submissionId);
  }

  const decideResult = decisionDecideOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/current/decisions',
    key: `${key}-decide`,
    body: {
      action: 'decide',
      decisions: submissionIds.map((submissionId) => ({
        submissionId,
        state: 'accepted',
        expectedDecisionVersion: null,
        expectedDecisionDigestSha256: null,
        graduation: { kind: 'spawn' }
      }))
    }
  }));
  if (decideResult.kind !== 'success') throw new Error('Decide failed.');

  const sessions = sessionCatalogReadResultSchema.parse(
    await operatorRead({ runtime, session, path: '/api/events/current/sessions' })
  );
  if (sessions.kind !== 'success') throw new Error('Session catalog read failed.');
  const engagements = engagementSnapshotReadResultSchema.parse(
    await operatorRead({ runtime, session, path: '/api/events/current/engagements' })
  );
  if (engagements.kind !== 'success') throw new Error('Engagement read failed.');

  return input.speakers.map((speaker, index) => {
    const submissionId = submissionIds[index];
    if (!submissionId) throw new Error('Submission id missing.');
    const engagement = engagements.data.engagements.find(
      (candidate) => candidate.submissionId === submissionId
    );
    if (!engagement) throw new Error('Seeded engagement missing.');
    return Object.freeze({
      title: speaker.title,
      name: speaker.name,
      email: speaker.email,
      submissionId,
      engagementId: engagement.id
    });
  });
}

function portalPost(
  runtime: EphemeralLiveRuntime,
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>
) {
  return runtime.app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: config.baseUrl,
      'x-correlation-id': crypto.randomUUID(),
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
}

async function signInThroughIssuedLink(
  runtime: EphemeralLiveRuntime,
  email: string
): Promise<string> {
  const linkResponse = await portalPost(runtime, '/api/portal/entry/link', { email });
  expect(linkResponse.status).toBe(200);
  const issuedResponse = await portalPost(runtime, '/api/portal/entry/dev/issued-link', { email });
  expect(issuedResponse.status).toBe(200);
  const issued = await issuedResponse.json() as { kind: string; url?: string };
  if (issued.kind !== 'issued' || !issued.url) throw new Error('Issued link missing.');
  const token = new URL(`${config.baseUrl}${issued.url}`).searchParams.get('token');
  if (!token) throw new Error('Issued link token missing.');
  const completeResponse = await portalPost(runtime, '/api/portal/entry/complete', { token });
  expect(completeResponse.status).toBe(200);
  const cookieMatch = /__Host-je_portal_session=([^;]+)/.exec(
    completeResponse.headers.get('set-cookie') ?? ''
  );
  if (!cookieMatch) throw new Error('Portal session cookie missing.');
  return `__Host-je_portal_session=${cookieMatch[1]}`;
}

/** A real (minimal but well-formed) PDF byte stream. */
const PDF_BYTES = new TextEncoder().encode([
  '%PDF-1.4',
  '1 0 obj',
  '<< /Type /Catalog /Pages 2 0 R >>',
  'endobj',
  '2 0 obj',
  '<< /Type /Pages /Kids [] /Count 0 >>',
  'endobj',
  'trailer',
  '<< /Root 1 0 R >>',
  '%%EOF',
  ''
].join('\n'));
const PDF_SHA256 = createHash('sha256').update(PDF_BYTES).digest('hex');

describe('files joined acceptance loop (ephemeral live)', () => {
  test('shares, asks, streams a PDF through the portal, fulfils, downloads inertly, refuses cross-engagement acts, and sweeps only never-attached orphans', async () => {
    const runtime = await createEphemeralLiveRuntime({ config, devFixtures: true });
    runtimes.push(runtime);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);
    // Before any event exists, the portal files registry has no lane to pin:
    // its manifest answers the same not_available as its sibling routes.
    const preEventManifest = await runtime.app.request('/api/portal/files/operations/manifest');
    expect(preEventManifest.status).toBe(404);
    const [petra, otto] = await seedAcceptedSpeakers({
      runtime,
      session,
      key: 'files-loop',
      speakers: [
        {
          key: 'petra',
          title: 'Streams for speakers',
          name: 'Petra Files',
          email: 'files.speaker@example.test'
        },
        {
          key: 'otto',
          title: 'A different talk entirely',
          name: 'Otto Files',
          email: 'other.files@example.test'
        }
      ]
    });
    // With the event live, the portal files registry publishes its own
    // browser-safe manifest — the operator manifest cannot carry these
    // operations, and this is where the portal client resolves its bindings.
    const portalManifest = await runtime.app.request('/api/portal/files/operations/manifest');
    expect(portalManifest.status).toBe(200);
    const manifestText = await portalManifest.text();
    expect(manifestText).toContain('file.upload.intent');
    expect(manifestText).toContain('participant_http');

    if (!petra || !otto) throw new Error('Seeded speakers missing.');
    const eventId = runtime.database.sqlite.query<{ readonly id: string }, []>(
      'SELECT id FROM events LIMIT 1'
    ).get()?.id;
    if (!eventId) throw new Error('Seeded event missing.');
    const scope = { workspaceId: runtime.workspaceId, eventId };

    // The speaker confirms their engagement through the portal first: the
    // ask loop targets a CONFIRMED engagement.
    const petraCookie = await signInThroughIssuedLink(runtime, petra.email);
    const respondResponse = await portalPost(
      runtime,
      '/api/portal/engagements/respond',
      { engagementId: petra.engagementId, response: 'confirm' },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-respond' }
    );
    expect(respondResponse.status).toBe(200);
    expect(await respondResponse.json()).toMatchObject({
      kind: 'success',
      data: { id: petra.engagementId, status: 'confirmed' }
    });

    // A committed deadline in the existing catalog is the "by when" the file
    // request references — file requests own no deadline physics.
    const deadlineChange = deadlineChangeOperationResultSchema.parse(await effect({
      runtime,
      session,
      path: '/api/events/current/deadlines',
      key: 'files-loop-deadline',
      body: { action: 'create', displayDate: '2027-05-01' }
    }));
    if (deadlineChange.kind !== 'success') throw new Error('Deadline creation failed.');
    const deadlineId = deadlineChange.data.deadline.id;

    // Organizer shares a resource with every confirmed speaker.
    const resourceShareId = crypto.randomUUID();
    const shareResult = await effect({
      runtime,
      session,
      path: '/api/events/current/files/shares/create',
      key: 'files-loop-share',
      body: {
        resourceShareId,
        title: 'Speaker kit',
        audience: { kind: 'all_confirmed' }
      }
    });
    expect(shareResult).toMatchObject({
      kind: 'success',
      data: {
        action: 'share.create',
        idempotent: false,
        share: { id: resourceShareId, state: 'active', version: 1 }
      }
    });

    // Organizer asks Petra for the final deck, pinned to the deadline.
    const requestId = crypto.randomUUID();
    const requestResult = await effect({
      runtime,
      session,
      path: '/api/events/current/files/requests/create',
      key: 'files-loop-request',
      body: {
        requestId,
        engagementId: petra.engagementId,
        what: 'Final deck (PDF)',
        instructions: 'Please upload the deck you will present.',
        deadlineId
      }
    });
    expect(requestResult).toMatchObject({
      kind: 'success',
      data: {
        action: 'request.create',
        idempotent: false,
        request: {
          id: requestId,
          engagementId: petra.engagementId,
          state: 'open',
          deadlineId
        },
        deadline: { id: deadlineId, displayDate: '2027-05-01' }
      }
    });
    // A second ask against Otto's engagement seeds the cross-engagement probe.
    const ottoRequestId = crypto.randomUUID();
    expect(await effect({
      runtime,
      session,
      path: '/api/events/current/files/requests/create',
      key: 'files-loop-request-otto',
      body: {
        requestId: ottoRequestId,
        engagementId: otto.engagementId,
        what: 'Bio photo',
        instructions: null,
        deadlineId: null
      }
    })).toMatchObject({ kind: 'success', data: { action: 'request.create' } });

    // The portal read serves the ask on Petra's own engagement...
    const portalFilesResponse = await runtime.app.request(
      `/api/portal/engagements/files?engagementId=${petra.engagementId}`,
      { headers: { cookie: petraCookie, 'x-correlation-id': crypto.randomUUID() } }
    );
    expect(portalFilesResponse.status).toBe(200);
    const portalFiles = portalEngagementFilesReadResultSchema.parse(
      await portalFilesResponse.json()
    );
    if (portalFiles.kind !== 'success') throw new Error('Portal files read failed.');
    expect(portalFiles.data.engagementId).toBe(petra.engagementId);
    expect(portalFiles.data.attachments).toEqual([]);
    expect(portalFiles.data.requests).toMatchObject([
      { id: requestId, state: 'open', what: 'Final deck (PDF)' }
    ]);
    // ...and refuses Otto's engagement for Petra without existence leakage.
    const foreignRead = await runtime.app.request(
      `/api/portal/engagements/files?engagementId=${otto.engagementId}`,
      { headers: { cookie: petraCookie, 'x-correlation-id': crypto.randomUUID() } }
    );
    expect(foreignRead.status).toBe(200);
    expect(await foreignRead.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'access_denied', kind: 'file.portal.not_related' }
    });

    // Two-phase upload from the portal: intent → raw byte stream → confirm.
    const intentId = crypto.randomUUID();
    const intentResponse = await portalPost(
      runtime,
      '/api/portal/files/uploads/intent',
      {
        intentId,
        purpose: 'request_fulfillment',
        displayFilename: 'Final Deck.pdf',
        contentType: 'application/pdf',
        declaredByteSize: PDF_BYTES.byteLength
      },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-intent' }
    );
    expect(intentResponse.status).toBe(200);
    expect(await intentResponse.json()).toMatchObject({
      kind: 'success',
      data: {
        action: 'upload.intent',
        idempotent: false,
        intent: {
          id: intentId,
          state: 'pending',
          contentType: 'application/pdf',
          uploader: { kind: 'participant' }
        }
      }
    });
    const bytesResponse = await runtime.app.request(
      `/api/portal/files/uploads/${intentId}/bytes`,
      {
        method: 'PUT',
        headers: {
          cookie: petraCookie,
          origin: config.baseUrl,
          'x-correlation-id': crypto.randomUUID()
        },
        body: PDF_BYTES
      }
    );
    expect(bytesResponse.status).toBe(200);
    const streamed = await bytesResponse.json() as {
      kind: string;
      intent: { byteSize: number; sha256: string };
    };
    // The inline digest and size of the exact streamed bytes are recorded.
    expect(streamed).toMatchObject({
      kind: 'stored',
      intent: { byteSize: PDF_BYTES.byteLength, sha256: PDF_SHA256 }
    });
    // Another participant cannot stream into Petra's intent.
    const ottoCookie = await signInThroughIssuedLink(runtime, otto.email);
    const foreignBytes = await runtime.app.request(
      `/api/portal/files/uploads/${intentId}/bytes`,
      {
        method: 'PUT',
        headers: {
          cookie: ottoCookie,
          origin: config.baseUrl,
          'x-correlation-id': crypto.randomUUID()
        },
        body: PDF_BYTES
      }
    );
    expect(foreignBytes.status).toBe(403);
    expect(await foreignBytes.json()).toEqual({ kind: 'refused', code: 'not_intent_owner' });

    const assetId = crypto.randomUUID();
    const confirmResponse = await portalPost(
      runtime,
      '/api/portal/files/uploads/confirm',
      { intentId, assetId, sha256: PDF_SHA256 },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-confirm' }
    );
    expect(confirmResponse.status).toBe(200);
    expect(await confirmResponse.json()).toMatchObject({
      kind: 'success',
      data: {
        action: 'upload.confirm',
        asset: {
          id: assetId,
          sha256: PDF_SHA256,
          byteSize: PDF_BYTES.byteLength,
          displayFilename: 'Final Deck.pdf',
          contentType: 'application/pdf',
          lifecycle: 'available',
          scan: { provider: 'none', verdict: 'released' },
          uploader: { kind: 'participant' }
        }
      }
    });

    // Attach on the OWN engagement, then fulfil the ask with that attachment.
    const attachmentId = crypto.randomUUID();
    expect(await (await portalPost(
      runtime,
      '/api/portal/files/attachments/attach',
      {
        attachmentId,
        subject: { kind: 'engagement', engagementId: petra.engagementId },
        assetId
      },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-attach' }
    )).json()).toMatchObject({
      kind: 'success',
      data: {
        action: 'attachment.attach',
        attachment: { id: attachmentId, state: 'attached', version: 1 }
      }
    });
    // Cross-engagement attach refuses before any adapter work.
    expect(await (await portalPost(
      runtime,
      '/api/portal/files/attachments/attach',
      {
        attachmentId: crypto.randomUUID(),
        subject: { kind: 'engagement', engagementId: otto.engagementId },
        assetId
      },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-attach-foreign' }
    )).json()).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'policy_violation',
        kind: 'file.command_refused',
        detail: { action: 'attachment.attach', code: 'portal_not_related' }
      }
    });
    // A speaker cannot touch another engagement's request either.
    expect(await (await portalPost(
      runtime,
      '/api/portal/files/requests/fulfill',
      { requestId: ottoRequestId, attachmentId, expectedVersion: 1 },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-fulfill-foreign' }
    )).json()).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'policy_violation',
        kind: 'file.command_refused',
        detail: { action: 'request.fulfill', code: 'portal_not_related' }
      }
    });
    expect(await (await portalPost(
      runtime,
      '/api/portal/files/requests/fulfill',
      { requestId, attachmentId, expectedVersion: 1 },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-fulfill' }
    )).json()).toMatchObject({
      kind: 'success',
      data: {
        action: 'request.fulfill',
        request: {
          id: requestId,
          state: 'fulfilled',
          fulfillingAttachmentId: attachmentId,
          version: 2
        }
      }
    });

    // The organizer overview joins attachment, asset, share, and both asks.
    const overview = organizerFileOverviewReadResultSchema.parse(
      await operatorRead({ runtime, session, path: '/api/events/current/files' })
    );
    if (overview.kind !== 'success') throw new Error('Organizer overview read failed.');
    expect(overview.data.shares).toMatchObject([
      { id: resourceShareId, title: 'Speaker kit', state: 'active' }
    ]);
    expect(overview.data.attachments).toMatchObject([
      {
        attachment: { id: attachmentId, state: 'attached' },
        asset: { id: assetId, sha256: PDF_SHA256 }
      }
    ]);
    const requestStates: { id: string; state: string }[] = overview.data.requests
      .map((request) => ({ id: request.id, state: request.state }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(requestStates).toEqual(([
      { id: requestId, state: 'fulfilled' },
      { id: ottoRequestId, state: 'open' }
    ] as { id: string; state: string }[])
      .sort((left, right) => left.id.localeCompare(right.id)));

    // Inert download, organizer lane: attachment-only, nosniff, recorded
    // content type, exact bytes.
    const operatorDownload = await runtime.app.request(
      `/api/events/current/files/download/${assetId}`,
      { headers: { cookie: session.cookie, 'x-correlation-id': crypto.randomUUID() } }
    );
    expect(operatorDownload.status).toBe(200);
    expect(operatorDownload.headers.get('content-type')).toBe('application/pdf');
    expect(operatorDownload.headers.get('content-disposition')).toBe(
      `attachment; filename="Final Deck.pdf"; filename*=UTF-8''Final%20Deck.pdf`
    );
    expect(operatorDownload.headers.get('x-content-type-options')).toBe('nosniff');
    expect(operatorDownload.headers.get('content-length'))
      .toBe(String(PDF_BYTES.byteLength));
    expect(new Uint8Array(await operatorDownload.arrayBuffer())).toEqual(PDF_BYTES);
    // The portal download reaches only material on the speaker's own
    // engagements: Petra streams her deck back; Otto gets an
    // undistinguishing not-found; anonymous gets an authentication refusal.
    const petraDownload = await runtime.app.request(
      `/api/portal/files/download/${assetId}`,
      { headers: { cookie: petraCookie, 'x-correlation-id': crypto.randomUUID() } }
    );
    expect(petraDownload.status).toBe(200);
    expect(petraDownload.headers.get('content-disposition')).toContain('attachment;');
    expect(new Uint8Array(await petraDownload.arrayBuffer())).toEqual(PDF_BYTES);
    const ottoDownload = await runtime.app.request(
      `/api/portal/files/download/${assetId}`,
      { headers: { cookie: ottoCookie, 'x-correlation-id': crypto.randomUUID() } }
    );
    expect(ottoDownload.status).toBe(404);
    expect(await ottoDownload.json()).toEqual({ kind: 'not_found' });
    const anonymousDownload = await runtime.app.request(
      `/api/events/current/files/download/${assetId}`
    );
    expect(anonymousDownload.status).toBe(401);
    expect(await anonymousDownload.json()).toEqual({
      kind: 'refused', code: 'unauthenticated'
    });

    // Oversize refuses structurally at intent admission (D4 default cap)...
    expect(await (await portalPost(
      runtime,
      '/api/portal/files/uploads/intent',
      {
        intentId: crypto.randomUUID(),
        purpose: 'engagement_material',
        displayFilename: 'huge.pdf',
        contentType: 'application/pdf',
        declaredByteSize: 200 * 1024 * 1024
      },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-oversize' }
    )).json()).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'policy_violation',
        kind: 'file.command_refused',
        detail: { action: 'upload.intent', code: 'file_too_large' }
      }
    });
    // ...and a type outside the closed D3 allowlist refuses at the schema
    // boundary before any state exists (video is link-attach only).
    const videoIntent = await portalPost(
      runtime,
      '/api/portal/files/uploads/intent',
      {
        intentId: crypto.randomUUID(),
        purpose: 'engagement_material',
        displayFilename: 'talk.mp4',
        contentType: 'video/mp4',
        declaredByteSize: 1024
      },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-video' }
    );
    expect(videoIntent.status).toBe(400);
    expect(await videoIntent.json()).toMatchObject({
      kind: 'transport_error', code: 'invalid_request'
    });
    const htmlIntent = await portalPost(
      runtime,
      '/api/portal/files/uploads/intent',
      {
        intentId: crypto.randomUUID(),
        purpose: 'engagement_material',
        displayFilename: 'page.html',
        contentType: 'text/html',
        declaredByteSize: 1024
      },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-html' }
    );
    expect(htmlIntent.status).toBe(400);

    // Detach (the compensation of attach) keeps record AND bytes: the D7
    // sweep collects only never-attached assets after the grace window.
    expect(await effect({
      runtime,
      session,
      path: '/api/events/current/files/attachments/detach',
      key: 'files-loop-detach',
      body: { attachmentId, expectedVersion: 1 }
    })).toMatchObject({
      kind: 'success',
      data: {
        action: 'attachment.detach',
        attachment: { id: attachmentId, state: 'detached', version: 2 }
      }
    });
    // A second confirmed asset is never attached — the honest orphan.
    const orphanIntentId = crypto.randomUUID();
    expect(await (await portalPost(
      runtime,
      '/api/portal/files/uploads/intent',
      {
        intentId: orphanIntentId,
        purpose: 'engagement_material',
        displayFilename: 'scratch.pdf',
        contentType: 'application/pdf',
        declaredByteSize: PDF_BYTES.byteLength
      },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-orphan-intent' }
    )).json()).toMatchObject({ kind: 'success' });
    expect((await runtime.app.request(
      `/api/portal/files/uploads/${orphanIntentId}/bytes`,
      {
        method: 'PUT',
        headers: {
          cookie: petraCookie,
          origin: config.baseUrl,
          'x-correlation-id': crypto.randomUUID()
        },
        body: PDF_BYTES
      }
    )).status).toBe(200);
    const orphanAssetId = crypto.randomUUID();
    expect(await (await portalPost(
      runtime,
      '/api/portal/files/uploads/confirm',
      { intentId: orphanIntentId, assetId: orphanAssetId, sha256: PDF_SHA256 },
      { cookie: petraCookie, 'idempotency-key': 'files-loop-orphan-confirm' }
    )).json()).toMatchObject({ kind: 'success' });

    // Inside the grace window nothing is collectable.
    expect(await runtime.files.sweepOrphanBlobs()).toEqual({ collected: [], skipped: [] });
    // Past the window, exactly the never-attached asset goes; the detach-
    // history asset keeps its record and its bytes so compensating re-attach
    // always succeeds.
    const afterGrace = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
    const swept = await runtime.files.sweepOrphanBlobs({ now: afterGrace });
    expect(swept.skipped).toEqual([]);
    expect(swept.collected).toMatchObject([{ assetId: orphanAssetId, blobDeleted: true }]);
    expect(runtime.files.repository.readAsset(scope, orphanAssetId)).toBeUndefined();
    expect(runtime.files.repository.readAsset(scope, assetId)).toMatchObject({
      id: assetId, sha256: PDF_SHA256
    });
    const survivingDownload = await runtime.app.request(
      `/api/events/current/files/download/${assetId}`,
      { headers: { cookie: session.cookie, 'x-correlation-id': crypto.randomUUID() } }
    );
    expect(survivingDownload.status).toBe(200);
    expect(new Uint8Array(await survivingDownload.arrayBuffer())).toEqual(PDF_BYTES);

    expect(runtime.database.sqlite.query<Record<string, unknown>, []>(
      'PRAGMA foreign_key_check'
    ).all()).toEqual([]);
  }, 120_000);

  test('enforces the configured per-file cap inline mid-stream and leaves the intent retryable', async () => {
    process.env.JOOEVENTS_FILES_MAX_UPLOAD_BYTES_SPEAKER = '4096';
    let runtime: EphemeralLiveRuntime;
    try {
      runtime = await createEphemeralLiveRuntime({ config, devFixtures: true });
    } finally {
      delete process.env.JOOEVENTS_FILES_MAX_UPLOAD_BYTES_SPEAKER;
    }
    runtimes.push(runtime);
    expect(runtime.files.limits.maxUploadBytesSpeaker).toBe(4096);
    const session = await createOwnerSession(runtime);
    await provisionOwner(runtime, session);
    const [speaker] = await seedAcceptedSpeakers({
      runtime,
      session,
      key: 'files-cap',
      speakers: [{
        key: 'capped',
        title: 'Small files only',
        name: 'Capped Speaker',
        email: 'capped.speaker@example.test'
      }]
    });
    if (!speaker) throw new Error('Seeded speaker missing.');
    const cookie = await signInThroughIssuedLink(runtime, speaker.email);
    const intentId = crypto.randomUUID();
    expect(await (await portalPost(
      runtime,
      '/api/portal/files/uploads/intent',
      {
        intentId,
        purpose: 'engagement_material',
        displayFilename: 'small.pdf',
        contentType: 'application/pdf',
        declaredByteSize: 2048
      },
      { cookie, 'idempotency-key': 'files-cap-intent' }
    )).json()).toMatchObject({
      kind: 'success',
      data: { intent: { maximumByteSize: 4096 } }
    });
    const putBytes = (bytes: Uint8Array<ArrayBuffer>) => runtime.app.request(
      `/api/portal/files/uploads/${intentId}/bytes`,
      {
        method: 'PUT',
        headers: {
          cookie,
          origin: config.baseUrl,
          'x-correlation-id': crypto.randomUUID()
        },
        body: bytes
      }
    );
    // The hard cap bites mid-stream — before the oversize body lands
    // anywhere — with a structured refusal, not a truncated store.
    const oversize = await putBytes(new Uint8Array(8192).fill(37));
    expect(oversize.status).toBe(413);
    expect(await oversize.json()).toEqual({ kind: 'refused', code: 'byte_cap_exceeded' });
    // An empty stream refuses too, and the intent stays pending.
    const empty = await putBytes(new Uint8Array(0));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ kind: 'refused', code: 'empty_stream' });
    // The refused intent remains retryable: an in-cap stream stores.
    const small = new Uint8Array(1024).fill(11);
    const stored = await putBytes(small);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      kind: 'stored',
      intent: {
        byteSize: 1024,
        sha256: createHash('sha256').update(small).digest('hex')
      }
    });
  }, 120_000);
});
