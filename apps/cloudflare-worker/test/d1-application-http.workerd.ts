import { env } from 'cloudflare:workers';
import { makeSignature } from 'better-auth/crypto';
import {
  CLOUDFLARE_EMAIL_ADAPTER_VERSION,
  CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
  CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST
} from '@jooevents/cloudflare-email';
import { emailProviderConnectionProjectionSchema } from '@jooevents/contracts';
import { canonicalJsonText, parseWorkspaceId } from '@jooevents/kernel';
import { beforeAll, describe, expect, test } from 'vitest';
import { handleRequest, type CloudflareApplicationEnvironment } from '../src/index';
import { dispatchD1FilesCleanupWake } from '../src/d1-files-cleanup';

const uuid = (suffix: number): string =>
  `019c1df8-d4f0-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = uuid(701);
const userId = uuid(702);
const membershipId = uuid(703);
const authUserId = uuid(704);
const sessionId = uuid(705);
const rawSessionToken = 'd1-application-http-session-token';
const roleId = uuid(706);
const secret = 'd1-application-http-auth-secret-at-least-thirty-two-characters';
const baseUrl = 'https://application-http.jooevents.invalid';

const ring = (byte: number): string =>
  `1:${Buffer.alloc(32, byte).toString('base64url')}`;
const rotatedRing = (activeByte: number, retainedByte: number): string =>
  `2:${Buffer.alloc(32, activeByte).toString('base64url')},${ring(retainedByte)}`;

beforeAll(async () => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'D1 application workspace','active',?,?,1)`).bind(workspaceId, now, now),
    env.DB.prepare(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','D1 application owner',?,?,1)`).bind(userId, now, now),
    env.DB.prepare(`INSERT INTO event_spine_workspace_sets (workspace_id,version,current_event_id)
      VALUES (?,1,NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'D1 application owner','application-owner@example.invalid',1,NULL,?,?)`)
      .bind(authUserId, now, now),
    env.DB.prepare(`INSERT INTO auth_sessions
      (id,token,user_id,expires_at,ip_address,user_agent,created_at,updated_at)
      VALUES (?,?,?, ?,NULL,NULL,?,?)`)
      .bind(sessionId, rawSessionToken, authUserId, now + 86_400_000, now, now),
    env.DB.prepare(`INSERT INTO auth_user_links
      (auth_user_id,user_id,provisioning_state,last_error_code,attempts,created_at,updated_at)
      VALUES (?,?,'ready',NULL,0,?,?)`).bind(authUserId, userId, now, now),
    env.DB.prepare(`INSERT INTO workspace_memberships
      (id,workspace_id,user_id,status,approved_by_user_id,approved_at,decision_reason,
       created_at,updated_at,version)
      VALUES (?,?,?,'active',?,?,NULL,?,?,1)`)
      .bind(membershipId, workspaceId, userId, userId, now, now, now),
    env.DB.prepare(`INSERT INTO roles
      (id,workspace_id,name,description,source_preset_key,source_preset_version,
       archived_at,created_at,updated_at,version)
      VALUES (?,?,'D1 Event manager','D1 Event HTTP role',NULL,NULL,NULL,?,?,1)`)
      .bind(roleId, workspaceId, now, now),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'event.read'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'event.manage'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'submission.read'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'schedule.read'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'schedule.manage'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'program.vocabulary.manage'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'communication.provider.manage'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'communication.draft'),
    env.DB.prepare(`INSERT INTO role_assignments
      (id,user_id,role_id,workspace_id,scope_kind,event_id,assigned_by_user_id,
       assigned_at,expires_at,version)
      VALUES (?,?,?,?,'workspace',NULL,?,?,NULL,1)`)
      .bind(uuid(707), userId, roleId, workspaceId, userId, now)
  ]);
});

function environment(
  overrides: Partial<CloudflareApplicationEnvironment> = {}
): CloudflareApplicationEnvironment {
  return {
    DB: env.DB,
    FILES: env.FILES,
    EMAIL: env.EMAIL,
    JOBS: env.JOBS,
    ASSETS: env.ASSETS,
    JOOEVENTS_DEPLOYMENT_ENVIRONMENT: env.JOOEVENTS_DEPLOYMENT_ENVIRONMENT,
    JOOEVENTS_D1_RELEASE_FLOOR: env.JOOEVENTS_D1_RELEASE_FLOOR,
    JOOEVENTS_AUTH_RUNTIME_ENABLED: 'true',
    JOOEVENTS_APPLICATION_RUNTIME_ENABLED: 'true',
    JOOEVENTS_MAIL_FROM_ADDRESS: 'events@mail.jooevents.com',
    JOOEVENTS_MAIL_FROM_NAME: 'JooEvents',
    JOOEVENTS_BASE_URL: baseUrl,
    JOOEVENTS_AUTH_SECRETS: `1:${secret}`,
    JOOEVENTS_REQUEST_HASH_KEYS: ring(0x31),
    JOOEVENTS_IDEMPOTENCY_KEYS: ring(0x32),
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: ring(0x33),
    JOOEVENTS_PERSISTENT_HMAC_KEYS: ring(0x34),
    JOOEVENTS_GOOGLE_CLIENT_ID: 'application-http-google-client-id',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'application-http-google-client-secret',
    JOOEVENTS_ADMISSION_MODE: 'pending',
    JOOEVENTS_WORKSPACE_ID: workspaceId,
    ...overrides
  };
}

async function cookie(): Promise<string> {
  const signature = await makeSignature(rawSessionToken, secret);
  return `__Secure-better-auth.session_token=${rawSessionToken}.${signature}`;
}

describe('configured D1 application HTTP slice', () => {
  test('serves the exact partial manifest and runs Event create/read/replay over authenticated HTTP', async () => {
    const headers = { cookie: await cookie() };
    const manifest = await handleRequest(
      new Request(`${baseUrl}/api/operations/manifest`, { headers }),
      environment()
    );
    expect(manifest.status).toBe(200);
    const manifestBody = await manifest.json<{
      readonly operations: readonly { readonly name: string }[];
    }>();
    expect(manifestBody.operations.map((operation) => operation.name).sort()).toEqual([
      'communication.email_readiness.read',
      'communication.provider_connection.read',
      'communication.sender_identity.read',
      'communication.sender_identity.update',
      'deadline.catalog.read',
      'deadline.change',
      'deadline.current.read',
      'event.create',
      'event.current.read',
      'event.list.read',
      'event.select',
      'event.settings.current.read',
      'event.settings.update',
      'field_registry.add',
      'field_registry.edit',
      'field_registry.move',
      'field_registry.remove',
      'field_registry.restore',
      'field_registry.snapshot.read',
      'file.attachment.attach',
      'file.attachment.detach',
      'file.attachment.link',
      'file.overview.read',
      'file.request.create',
      'file.request.fulfill',
      'file.request.withdraw',
      'file.share.create',
      'file.share.revoke',
      'file.upload.confirm',
      'file.upload.intent',
      'get_communication_purpose',
      'get_message_draft',
      'get_message_template',
      'list_audience_options',
      'list_communication_purposes',
      'list_message_drafts',
      'list_message_templates',
      'operation.history.list',
      'program_vocabulary.create',
      'program_vocabulary.delete',
      'program_vocabulary.edit',
      'program_vocabulary.merge',
      'program_vocabulary.merge.draft',
      'program_vocabulary.restore',
      'program_vocabulary.retire',
      'program_vocabulary.snapshot.read',
      'schedule.placement',
      'schedule.placement.snapshot.read',
      'session.catalog.read',
      'session.change',
      'store_communication_authoring_payload',
      'task.board.read',
      'task.mutation',
      'template.artifact.change',
      'template.artifact.change.draft',
      'template.artifact.get',
      'template.artifact.list',
      'workspace.api_key.create',
      'workspace.api_key.list',
      'workspace.api_key.revoke',
      'workspace.api_key.rotate',
      'workspace.overview.read',
      'workspace.shell.summary.read',
      'workspace_team.invite',
      'workspace_team.members.read',
      'workspace_team.remove',
      'workspace_team.role_change'
    ]);

    const initial = await handleRequest(
      new Request(`${baseUrl}/api/events/current`, { headers }),
      environment()
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      kind: 'success', data: { kind: 'no_event', eventSetVersion: 1 }
    });
    const initialFiles = await handleRequest(
      new Request(`${baseUrl}/api/events/current/files`, { headers }),
      environment()
    );
    expect(initialFiles.status, await initialFiles.clone().text()).toBe(200);
    expect(await initialFiles.json()).toMatchObject({
      kind: 'outcome', outcome: { class: 'conflict', kind: 'file.event_required' }
    });
    const initialVocabulary = await handleRequest(
      new Request(`${baseUrl}/api/events/current/program-vocabulary`, { headers }),
      environment()
    );
    expect(initialVocabulary.status, await initialVocabulary.clone().text()).toBe(200);
    expect(await initialVocabulary.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'conflict', kind: 'program_vocabulary.event_required' }
    });
    const initialSchedule = await handleRequest(
      new Request(`${baseUrl}/api/events/current/schedule/placements?startAt=2027-03-10T00%3A00%3A00.000Z&endAt=2027-03-13T00%3A00%3A00.000Z&limit=100`, { headers }),
      environment()
    );
    expect(initialSchedule.status, await initialSchedule.clone().text()).toBe(200);
    expect(await initialSchedule.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'conflict', kind: 'schedule.event_required' }
    });
    const initialSessions = await handleRequest(
      new Request(`${baseUrl}/api/events/current/sessions`, { headers }),
      environment()
    );
    expect(initialSessions.status, await initialSessions.clone().text()).toBe(200);
    expect(await initialSessions.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'conflict', kind: 'session.event_required' }
    });
    const initialPurposes = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/purposes`, { headers }),
      environment()
    );
    expect(initialPurposes.status, await initialPurposes.clone().text()).toBe(200);
    expect(await initialPurposes.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'conflict', kind: 'communication.event_required' }
    });
    const initialAuthoringPayload = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/authoring-payloads`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': 'd1-initial-authoring-payload'
        },
        body: JSON.stringify({
          payload: {
            payloadKind: 'message_content',
            schemaVersion: 1,
            value: {
              kind: 'email/v1', subject: 'No event',
              body: { kind: 'plain_text/v1', text: '' }
            }
          }
        })
      }),
      environment()
    );
    expect(initialAuthoringPayload.status, await initialAuthoringPayload.clone().text()).toBe(200);
    expect(await initialAuthoringPayload.json()).toMatchObject({
      kind: 'outcome', outcome: { class: 'conflict', kind: 'communication.event_required' }
    });
    const initialAudienceOptions = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/audiences/options`, { headers }),
      environment()
    );
    expect(initialAudienceOptions.status, await initialAudienceOptions.clone().text()).toBe(200);
    expect(await initialAudienceOptions.json()).toMatchObject({
      kind: 'outcome', outcome: { class: 'conflict', kind: 'communication.event_required' }
    });
    const initialDownload = await handleRequest(
      new Request(`${baseUrl}/api/events/current/files/download/${uuid(709)}`, { headers }),
      environment()
    );
    expect(initialDownload.status).toBe(409);
    expect(await initialDownload.json()).toMatchObject({
      kind: 'refused', code: 'event_required'
    });
    const initialShell = await handleRequest(
      new Request(`${baseUrl}/api/workspace/shell-summary`, { headers }),
      environment()
    );
    expect(initialShell.status, await initialShell.clone().text()).toBe(200);
    expect(await initialShell.json()).toMatchObject({
      kind: 'success',
      data: {
        workspace: { id: workspaceId, name: 'D1 application workspace' },
        event: null
      }
    });
    const initialOverview = await handleRequest(
      new Request(`${baseUrl}/api/workspace/overview`, { headers }),
      environment()
    );
    expect(initialOverview.status, await initialOverview.clone().text()).toBe(200);
    expect(await initialOverview.json()).toMatchObject({
      kind: 'success',
      data: {
        event: { kind: 'no_event' },
        areas: expect.arrayContaining([
          { area: 'submissions', status: 'unavailable', reason: 'not_composed' },
          { area: 'tasks', status: 'locked', reason: 'event_required' },
          { area: 'templates', status: 'locked', reason: 'event_required' }
        ]),
        metrics: { operations: { kind: 'unavailable', reason: 'event_required' } },
        history: { total: 0, truncated: false, threads: [] }
      }
    });

    const initialSender = await handleRequest(
      new Request(`${baseUrl}/api/communications/sender-identity`, { headers }),
      environment()
    );
    expect(initialSender.status, await initialSender.clone().text()).toBe(200);
    expect(await initialSender.json()).toMatchObject({
      kind: 'success',
      data: {
        workspaceId,
        headVersion: 1,
        displayName: null,
        replyToAddress: null,
        effective: {
          fromAddress: 'events@mail.jooevents.com',
          fromDisplayName: 'JooEvents',
          source: 'installation'
        }
      }
    });
    const initialEmailReadiness = await handleRequest(
      new Request(`${baseUrl}/api/communications/email-readiness`, { headers }),
      environment()
    );
    expect(initialEmailReadiness.status, await initialEmailReadiness.clone().text()).toBe(200);
    expect(await initialEmailReadiness.json()).toMatchObject({
      kind: 'success',
      data: {
        outbound: { state: 'unknown', nextStepCode: 'configure_email_provider' },
        callbacks: { state: 'not_supported' },
        inbound: { state: 'not_enabled' }
      }
    });
    const missingProvider = await handleRequest(
      new Request(`${baseUrl}/api/communications/provider-connection?connectionId=${uuid(799)}`, {
        headers
      }),
      environment()
    );
    expect(missingProvider.status, await missingProvider.clone().text()).toBe(200);
    expect(await missingProvider.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'conflict', kind: 'communication.provider_connection_unavailable' }
    });
    const providerConnectionId = uuid(790);
    const providerRevisionId = uuid(791);
    const providerCreatedAt = new Date().toISOString();
    const providerCandidate =
      emailProviderConnectionProjectionSchema.shape.candidateRevisions.element.parse({
        revisionId: providerRevisionId,
        connectionId: providerConnectionId,
        revisionNumber: 1,
        adapterKey: CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
        adapterVersion: CLOUDFLARE_EMAIL_ADAPTER_VERSION,
        setupManifestKey: CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.manifestKey,
        setupManifestVersion: CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.manifestVersion,
        setupManifestDigestSha256:
          CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.manifestDigestSha256,
        configSchemaVersion: 1,
        configRef: {
          payloadRefId: uuid(792),
          payloadRefVersion: 1,
          payloadKind: 'email_provider_configuration',
          schemaKey: 'cloudflare.email.workers.configuration',
          schemaVersion: 1,
          classification: 'restricted'
        },
        secretRequirements: [],
        configDigestSha256: 'a'.repeat(64),
        callbacks: { state: 'not_supported' },
        inbound: { state: 'not_enabled' },
        createdAt: providerCreatedAt
      });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO email_provider_connections (
        connection_id,workspace_id,display_name,adapter_key,lifecycle,head_version,
        current_revision_id,created_at,updated_at
      ) VALUES (?,?,?,?,'active_outbound',1,?,?,?)`).bind(
        providerConnectionId,
        workspaceId,
        'Cloudflare Email Sending',
        CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
        providerRevisionId,
        providerCreatedAt,
        providerCreatedAt
      ),
      env.DB.prepare(`INSERT INTO email_provider_connection_revisions (
        revision_id,connection_id,revision_number,adapter_key,adapter_version,
        manifest_key,manifest_version,manifest_digest_sha256,config_digest_sha256,
        revision_json,created_at
      ) VALUES (?,?,1,?,?,?,?,?,?,?,?)`).bind(
        providerRevisionId,
        providerConnectionId,
        CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
        CLOUDFLARE_EMAIL_ADAPTER_VERSION,
        CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.manifestKey,
        CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.manifestVersion,
        CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.manifestDigestSha256,
        providerCandidate.configDigestSha256,
        canonicalJsonText(providerCandidate),
        providerCreatedAt
      )
    ]);
    const configuredProvider = await handleRequest(
      new Request(`${baseUrl}/api/communications/provider-connection?connectionId=${providerConnectionId}`, {
        headers
      }),
      environment()
    );
    expect(configuredProvider.status, await configuredProvider.clone().text()).toBe(200);
    expect(await configuredProvider.json()).toMatchObject({
      kind: 'success',
      data: {
        connectionId: providerConnectionId,
        workspaceId,
        lifecycle: 'active_outbound',
        currentRevisionId: providerRevisionId,
        candidateRevisions: [{
          revisionId: providerRevisionId,
          adapterKey: CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
          callbacks: { state: 'not_supported' },
          inbound: { state: 'not_enabled' }
        }]
      }
    });
    const configuredReadiness = await handleRequest(
      new Request(`${baseUrl}/api/communications/email-readiness`, { headers }),
      environment()
    );
    expect(configuredReadiness.status, await configuredReadiness.clone().text()).toBe(200);
    expect(await configuredReadiness.json()).toMatchObject({
      kind: 'success',
      data: {
        provider: {
          adapterKey: CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
          displayName: 'Cloudflare Email Sending'
        },
        outbound: {
          state: 'action_required',
          reasonCode: 'email_provider_readiness_unknown',
          nextStepCode: 'run_email_provider_readiness_check'
        }
      }
    });

    const request = () => new Request(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: {
        cookie: headers.cookie,
        origin: baseUrl,
        'content-type': 'application/json',
        'idempotency-key': 'd1-application-create-event'
      },
      body: JSON.stringify({
        expectedEventSetVersion: 1,
        name: 'D1 Application Summit',
        timezone: 'Asia/Singapore',
        startDate: '2027-03-10',
        endDate: '2027-03-12'
      })
    });
    const first = await handleRequest(request(), environment());
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json<{
      readonly kind: string;
      readonly data: { readonly event: { readonly id: string } };
      readonly receipt: { readonly id: string };
    }>();
    expect(firstBody).toMatchObject({
      kind: 'success', data: { event: { name: 'D1 Application Summit' } }
    });
    const replay = await handleRequest(request(), environment());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const eventId = firstBody.data.event.id;
    const purposesResponse = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/purposes`, { headers }),
      environment()
    );
    expect(purposesResponse.status, await purposesResponse.clone().text()).toBe(200);
    const purposesBody = await purposesResponse.json<{
      readonly kind: string;
      readonly data: {
        readonly rows: readonly {
          readonly revision: { readonly purposeId: string; readonly purposeKey: string };
          readonly lifecycle: string;
        }[];
      };
    }>();
    expect(purposesBody.kind).toBe('success');
    const decisionPurpose = purposesBody.data.rows.find(
      (row) => row.revision.purposeKey === 'decision_notification'
    )!;
    expect(decisionPurpose).toMatchObject({
      revision: { purposeKey: 'decision_notification' },
      lifecycle: 'active'
    });
    const purposeDetail = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/purposes/detail?purposeId=${decisionPurpose.revision.purposeId}`, { headers }),
      environment()
    );
    expect(purposeDetail.status, await purposeDetail.clone().text()).toBe(200);
    expect(await purposeDetail.json()).toMatchObject({
      kind: 'success',
      data: {
        revision: { purposeKey: 'decision_notification' },
        allowedAudienceSources: expect.any(Array)
      }
    });
    const templatesResponse = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/templates`, { headers }),
      environment()
    );
    expect(templatesResponse.status, await templatesResponse.clone().text()).toBe(200);
    const templatesBody = await templatesResponse.json<{
      readonly kind: string;
      readonly data: {
        readonly rows: readonly {
          readonly revision: { readonly templateId: string };
          readonly key: string;
          readonly subjectPreview: string;
        }[];
      };
    }>();
    expect(templatesBody.kind).toBe('success');
    const acceptedTemplate = templatesBody.data.rows.find(
      (row) => row.key === 'decision.accepted'
    )!;
    expect(acceptedTemplate).toMatchObject({
      key: 'decision.accepted',
      subjectPreview: expect.any(String)
    });
    const communicationTemplateDetail = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/templates/detail?templateId=${acceptedTemplate.revision.templateId}`, { headers }),
      environment()
    );
    expect(
      communicationTemplateDetail.status,
      await communicationTemplateDetail.clone().text()
    ).toBe(200);
    expect(await communicationTemplateDetail.json()).toMatchObject({
      kind: 'success',
      data: {
        key: 'decision.accepted',
        content: { body: { mode: expect.any(String) } },
        fieldBindings: expect.any(Array)
      }
    });
    const draftsResponse = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/drafts`, { headers }),
      environment()
    );
    expect(draftsResponse.status, await draftsResponse.clone().text()).toBe(200);
    expect(await draftsResponse.json()).toMatchObject({
      kind: 'success', data: { rows: [], page: { hasMore: false } }
    });
    const missingDraft = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/drafts/detail?draftId=${uuid(798)}`, { headers }),
      environment()
    );
    expect(missingDraft.status, await missingDraft.clone().text()).toBe(200);
    expect(await missingDraft.json()).toMatchObject({
      kind: 'outcome', outcome: { class: 'conflict', kind: 'communication.not_found' }
    });
    const audienceOptions = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/audiences/options?limit=1`, {
        headers
      }),
      environment()
    );
    expect(audienceOptions.status, await audienceOptions.clone().text()).toBe(200);
    const audienceOptionsBody = await audienceOptions.json<{
      readonly kind: string;
      readonly data: {
        readonly rows: readonly { readonly optionId: string }[];
        readonly page: { readonly hasMore: boolean; readonly nextCursor?: string };
      };
    }>();
    expect(audienceOptionsBody).toMatchObject({
      kind: 'success', data: { rows: [expect.any(Object)], page: { hasMore: true } }
    });
    expect(audienceOptionsBody.data.page.nextCursor).toMatch(/^cur1_/);
    const audienceOptionsPageTwo = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/audiences/options?limit=1&cursor=${
        encodeURIComponent(audienceOptionsBody.data.page.nextCursor!)}`, { headers }),
      environment({
        JOOEVENTS_REQUEST_HASH_KEYS: rotatedRing(0x41, 0x31),
        JOOEVENTS_IDEMPOTENCY_KEYS: rotatedRing(0x42, 0x32),
        JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: rotatedRing(0x43, 0x33),
        JOOEVENTS_PERSISTENT_HMAC_KEYS: rotatedRing(0x44, 0x34)
      })
    );
    expect(audienceOptionsPageTwo.status, await audienceOptionsPageTwo.clone().text()).toBe(200);
    expect(await audienceOptionsPageTwo.json()).toMatchObject({
      kind: 'success', data: { rows: [expect.any(Object)], page: { hasMore: false } }
    });
    const reboundAudienceCursor = await handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/audiences/options?limit=1&purposeId=${
        uuid(797)}&cursor=${encodeURIComponent(audienceOptionsBody.data.page.nextCursor!)}`, {
        headers
      }),
      environment()
    );
    expect(await reboundAudienceCursor.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'policy_violation', kind: 'communication.preview_invalid' }
    });
    const authoringPayloadInput = {
      payload: {
        payloadKind: 'message_content',
        schemaVersion: 1,
        value: {
          kind: 'email/v1',
          subject: 'D1 authoring payload',
          body: { kind: 'plain_text/v1', text: 'PRIVATE-D1-AUTHORING-CANARY' }
        }
      }
    };
    const storeAuthoringPayload = (body: unknown) => handleRequest(
      new Request(`${baseUrl}/api/events/current/communications/authoring-payloads`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': 'd1-store-authoring-payload'
        },
        body: JSON.stringify(body)
      }),
      environment()
    );
    const storedAuthoringPayload = await storeAuthoringPayload(authoringPayloadInput);
    expect(
      storedAuthoringPayload.status,
      await storedAuthoringPayload.clone().text()
    ).toBe(200);
    const storedAuthoringPayloadBody = await storedAuthoringPayload.json<{
      readonly kind: string;
      readonly data: { readonly payloadRefId: string; readonly payloadKind: string };
    }>();
    expect(storedAuthoringPayloadBody).toMatchObject({
      kind: 'success', data: { payloadKind: 'message_content' }
    });
    const storedAuthoringPayloadReplay = await storeAuthoringPayload(authoringPayloadInput);
    expect(await storedAuthoringPayloadReplay.json()).toEqual(storedAuthoringPayloadBody);
    const changedAuthoringPayload = await storeAuthoringPayload({
      payload: {
        ...authoringPayloadInput.payload,
        value: { ...authoringPayloadInput.payload.value, subject: 'Changed payload' }
      }
    });
    expect(await changedAuthoringPayload.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });
    const authoringRows = await env.DB.batch([
      env.DB.prepare(`SELECT count(*) AS count FROM communication_authoring_payloads
        WHERE payload_ref_id=?`).bind(storedAuthoringPayloadBody.data.payloadRefId),
      env.DB.prepare(`SELECT count(*) AS count FROM organizer_communication_authoring_receipt_links
        WHERE payload_ref_id=?`).bind(storedAuthoringPayloadBody.data.payloadRefId),
      env.DB.prepare(`SELECT count(*) AS count FROM organizer_communication_authoring_timeline t
        JOIN organizer_communication_authoring_receipt_links l ON l.receipt_id=t.receipt_id
        WHERE l.payload_ref_id=?`).bind(storedAuthoringPayloadBody.data.payloadRefId),
      env.DB.prepare(`SELECT r.ciphertext FROM classified_payload_records r
        JOIN communication_authoring_payloads p ON p.payload_ref_id=r.payload_ref_id
        WHERE p.payload_ref_id=?`).bind(storedAuthoringPayloadBody.data.payloadRefId)
    ]);
    expect((authoringRows[0] as D1Result<{ count: number }>).results[0]?.count).toBe(1);
    expect((authoringRows[1] as D1Result<{ count: number }>).results[0]?.count).toBe(1);
    expect((authoringRows[2] as D1Result<{ count: number }>).results[0]?.count).toBe(1);
    const ciphertext = (authoringRows[3] as D1Result<{
      ciphertext: ArrayBuffer | readonly number[];
    }>).results[0]?.ciphertext;
    expect(ciphertext).toBeDefined();
    expect(new TextDecoder().decode(
      ciphertext instanceof ArrayBuffer ? new Uint8Array(ciphertext) : Uint8Array.from(ciphertext!)
    )).not.toContain('PRIVATE-D1-AUTHORING-CANARY');
    const recordedAtMs = Date.now();
    const recordedAt = new Date(recordedAtMs).toISOString();
    const shareId = uuid(708);
    const assetId = uuid(709);
    const assetAttachmentId = uuid(710);
    const linkAttachmentId = uuid(711);
    const scope = { workspaceId, eventId };
    const assetBytes = new TextEncoder().encode('speaker guide');
    const roomId = uuid(713);
    const trackId = uuid(714);
    const formatId = uuid(715);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO program_vocabulary_sets
        (workspace_id,event_id,set_version,created_by_user_id,created_at_ms,
         updated_by_user_id,updated_at_ms) VALUES (?,?,2,?,?,?,?)`)
        .bind(workspaceId, eventId, userId, recordedAtMs, userId, recordedAtMs),
      env.DB.prepare(`INSERT INTO program_vocabulary_rooms
        (workspace_id,event_id,id,name,capacity,status,version,created_by_user_id,
         created_at_ms,updated_by_user_id,updated_at_ms)
         VALUES (?,?,?,'Auditorium',450,'active',1,?,?,?,?)`)
        .bind(workspaceId, eventId, roomId, userId, recordedAtMs, userId, recordedAtMs),
      env.DB.prepare(`INSERT INTO program_vocabulary_tracks
        (workspace_id,event_id,id,name,status,version,created_by_user_id,created_at_ms,
         updated_by_user_id,updated_at_ms)
         VALUES (?,?,?,'Architecture','active',1,?,?,?,?)`)
        .bind(workspaceId, eventId, trackId, userId, recordedAtMs, userId, recordedAtMs),
      env.DB.prepare(`INSERT INTO program_vocabulary_formats
        (workspace_id,event_id,id,name,status,version,created_by_user_id,created_at_ms,
         updated_by_user_id,updated_at_ms)
         VALUES (?,?,?,'Talk','retired',1,?,?,?,?)`)
        .bind(workspaceId, eventId, formatId, userId, recordedAtMs, userId, recordedAtMs)
    ]);
    const vocabulary = await handleRequest(
      new Request(`${baseUrl}/api/events/current/program-vocabulary`, { headers }),
      environment()
    );
    expect(vocabulary.status, await vocabulary.clone().text()).toBe(200);
    expect(await vocabulary.json()).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        scope: { workspaceId, eventId },
        setVersion: 2,
        rooms: [{
          id: roomId,
          name: 'Auditorium',
          capacity: 450,
          status: 'active',
          usage: { current: 0, historicalPins: 0 },
          deleteEligibility: { kind: 'eligible' }
        }],
        tracks: [{
          id: trackId,
          name: 'Architecture',
          status: 'active',
          usage: { current: 0, historicalPins: 0 },
          deleteEligibility: { kind: 'eligible' }
        }],
        formats: [{
          id: formatId,
          name: 'Talk',
          status: 'retired',
          usage: { current: 0, historicalPins: 0 },
          deleteEligibility: { kind: 'eligible' }
        }]
      }
    });
    const mutateVocabulary = (path: string, key: string, body: unknown) => handleRequest(
      new Request(`${baseUrl}/api/events/current/program-vocabulary/${path}`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(body)
      }),
      environment()
    );
    const editTrackBody = {
      kind: 'track', id: trackId, expectedSetVersion: 2, expectedItemVersion: 1,
      changes: { name: 'Systems Architecture' }
    } as const;
    const editedTrack = await mutateVocabulary('edit', 'd1-vocabulary-edit', editTrackBody);
    expect(editedTrack.status, await editedTrack.clone().text()).toBe(200);
    const editedTrackBody = await editedTrack.json();
    expect(editedTrackBody).toMatchObject({
      kind: 'success',
      data: { action: 'edit', kind: 'track', affectedIds: [trackId], setVersion: 3 }
    });
    const editReplay = await mutateVocabulary('edit', 'd1-vocabulary-edit', editTrackBody);
    expect(await editReplay.json()).toEqual(editedTrackBody);
    const changedEdit = await mutateVocabulary('edit', 'd1-vocabulary-edit', {
      ...editTrackBody, changes: { name: 'Changed replay' }
    });
    expect(await changedEdit.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });
    const retiredRoom = await mutateVocabulary('retire', 'd1-vocabulary-retire', {
      kind: 'room', id: roomId, expectedSetVersion: 3, expectedItemVersion: 1
    });
    expect(await retiredRoom.json()).toMatchObject({
      kind: 'success', data: { action: 'retire', setVersion: 4 }
    });
    const restoredRoom = await mutateVocabulary('restore', 'd1-vocabulary-restore', {
      kind: 'room', id: roomId, expectedSetVersion: 4, expectedItemVersion: 2
    });
    expect(await restoredRoom.json()).toMatchObject({
      kind: 'success', data: { action: 'restore', setVersion: 5 }
    });
    const deletedFormat = await mutateVocabulary('delete', 'd1-vocabulary-delete', {
      kind: 'format', id: formatId, expectedSetVersion: 5, expectedItemVersion: 1
    });
    expect(await deletedFormat.json()).toMatchObject({
      kind: 'success', data: { action: 'delete', setVersion: 6 }
    });
    const createdFormat = await mutateVocabulary('create', 'd1-vocabulary-create', {
      kind: 'format', expectedSetVersion: 6, name: 'Workshop'
    });
    const createdFormatBody = await createdFormat.json<{
      readonly kind: string;
      readonly data: { readonly affectedIds: readonly string[] };
    }>();
    expect(createdFormatBody).toMatchObject({
      kind: 'success', data: { action: 'create', kind: 'format', setVersion: 7 }
    });
    const workshopFormatId = createdFormatBody.data.affectedIds[0]!;
    const mutatedVocabulary = await handleRequest(
      new Request(`${baseUrl}/api/events/current/program-vocabulary`, { headers }),
      environment()
    );
    expect(await mutatedVocabulary.json()).toMatchObject({
      kind: 'success', data: {
        setVersion: 7,
        rooms: [{ id: roomId, status: 'active', version: 3 }],
        tracks: [{ id: trackId, name: 'Systems Architecture', version: 2 }],
        formats: [{ name: 'Workshop', status: 'active', version: 1 }]
      }
    });
    const schedule = await handleRequest(
      new Request(`${baseUrl}/api/events/current/schedule/placements?startAt=2027-03-10T00%3A00%3A00.000Z&endAt=2027-03-13T00%3A00%3A00.000Z&limit=100`, { headers }),
      environment()
    );
    expect(schedule.status, await schedule.clone().text()).toBe(200);
    expect(await schedule.json()).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        scope: { workspaceId, eventId },
        scheduleVersion: 1,
        occurrences: []
      }
    });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO schedule_placement_sets
        (workspace_id,event_id,schedule_version,updated_by_user_id,updated_at_ms)
        VALUES (?,?,2,?,?)`)
        .bind(workspaceId, eventId, userId, recordedAtMs),
      env.DB.prepare(`INSERT INTO schedule_occurrences
        (workspace_id,event_id,id,session_id,room_id,start_at_ms,end_at_ms,version,
         updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(
          workspaceId, eventId, uuid(716), uuid(717), roomId,
          Date.parse('2027-03-10T09:00:00.000Z'),
          Date.parse('2027-03-10T10:00:00.000Z'),
          1, userId, recordedAtMs
        )
    ]);
    const referencedDelete = await mutateVocabulary('delete', 'd1-vocabulary-delete-referenced', {
      kind: 'room', id: roomId, expectedSetVersion: 7, expectedItemVersion: 3
    });
    expect(await referencedDelete.json()).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'policy_violation',
        kind: 'program_vocabulary.change_refused',
        detail: { code: 'delete_referenced', action: 'delete', kind: 'room', id: roomId }
      }
    });
    await env.DB.prepare(`DELETE FROM schedule_occurrences
      WHERE workspace_id = ? AND event_id = ? AND id = ?`)
      .bind(workspaceId, eventId, uuid(716)).run();
    const sessions = await handleRequest(
      new Request(`${baseUrl}/api/events/current/sessions`, { headers }),
      environment()
    );
    expect(sessions.status, await sessions.clone().text()).toBe(200);
    const sessionsBody = await sessions.json<{
      readonly kind: string;
      readonly data: {
        readonly version: number;
        readonly digestSha256: string;
        readonly sessions: readonly unknown[];
      };
    }>();
    expect(sessionsBody).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        scope: { workspaceId, eventId },
        version: 1,
        sessions: []
      }
    });
    const mutateSession = (key: string, body: unknown) => handleRequest(
      new Request(`${baseUrl}/api/events/current/sessions`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(body)
      }),
      environment()
    );
    const participantId = uuid(718);
    const createSessionBody = {
      action: 'create',
      expectedCatalogVersion: sessionsBody.data.version,
      expectedCatalogDigestSha256: sessionsBody.data.digestSha256,
      title: 'D1 Session lifecycle',
      plannedDurationMinutes: 45,
      lifecycle: 'draft',
      formatId: workshopFormatId,
      trackId,
      participants: [{
        personId: participantId,
        role: 'speaker',
        publiclyVisible: true,
        source: { kind: 'operator', id: 'd1-http-test', version: 1 }
      }]
    } as const;
    const createdSession = await mutateSession('d1-session-create', createSessionBody);
    expect(createdSession.status, await createdSession.clone().text()).toBe(200);
    const createdSessionBody = await createdSession.json<{
      readonly kind: string;
      readonly data: {
        readonly catalogVersion: number;
        readonly session: {
          readonly id: string;
          readonly version: number;
          readonly digestSha256: string;
        };
      };
    }>();
    expect(createdSessionBody).toMatchObject({
      kind: 'success',
      data: {
        action: 'create', catalogVersion: 2,
        session: { title: 'D1 Session lifecycle', lifecycle: 'draft', version: 1 }
      }
    });
    const sessionCreateReplay = await mutateSession('d1-session-create', createSessionBody);
    expect(await sessionCreateReplay.json()).toEqual(createdSessionBody);
    const changedSessionCreate = await mutateSession('d1-session-create', {
      ...createSessionBody, title: 'Changed replay'
    });
    expect(await changedSessionCreate.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });

    const catalogAfterCreate = await handleRequest(
      new Request(`${baseUrl}/api/events/current/sessions`, { headers }), environment()
    );
    const catalogAfterCreateBody = await catalogAfterCreate.json<{
      readonly data: {
        readonly version: number;
        readonly digestSha256: string;
        readonly sessions: readonly {
          readonly id: string;
          readonly version: number;
          readonly digestSha256: string;
        }[];
      };
    }>();
    const firstSession = catalogAfterCreateBody.data.sessions.find(
      (session) => session.id === createdSessionBody.data.session.id
    )!;
    const transitionedSession = await mutateSession('d1-session-transition', {
      action: 'transition',
      expectedCatalogVersion: catalogAfterCreateBody.data.version,
      expectedCatalogDigestSha256: catalogAfterCreateBody.data.digestSha256,
      sessionId: firstSession.id,
      expectedSessionVersion: firstSession.version,
      expectedSessionDigestSha256: firstSession.digestSha256,
      to: 'collecting'
    });
    const transitionedSessionBody = await transitionedSession.json<{
      readonly data: {
        readonly catalogVersion: number;
        readonly session: { readonly id: string; readonly version: number;
          readonly digestSha256: string };
      };
    }>();
    expect(transitionedSessionBody).toMatchObject({
      kind: 'success', data: { action: 'transition', catalogVersion: 3,
        session: { lifecycle: 'collecting', version: 2 } }
    });
    const catalogAfterTransition = await handleRequest(
      new Request(`${baseUrl}/api/events/current/sessions`, { headers }), environment()
    );
    const catalogAfterTransitionBody = await catalogAfterTransition.json<{
      readonly data: { readonly version: number; readonly digestSha256: string };
    }>();
    const hiddenParticipant = await mutateSession('d1-session-visibility', {
      action: 'roster_visibility',
      expectedCatalogVersion: catalogAfterTransitionBody.data.version,
      expectedCatalogDigestSha256: catalogAfterTransitionBody.data.digestSha256,
      sessionId: transitionedSessionBody.data.session.id,
      expectedSessionVersion: transitionedSessionBody.data.session.version,
      expectedSessionDigestSha256: transitionedSessionBody.data.session.digestSha256,
      personId: participantId,
      publiclyVisible: false
    });
    expect(await hiddenParticipant.json()).toMatchObject({
      kind: 'success', data: { action: 'roster_visibility', catalogVersion: 4,
        session: { version: 3, roster: { participants: [{ publiclyVisible: false }] } } }
    });

    const currentCatalog = async () => {
      const response = await handleRequest(
        new Request(`${baseUrl}/api/events/current/sessions`, { headers }), environment()
      );
      return response.json<{
        readonly data: {
          readonly version: number;
          readonly digestSha256: string;
          readonly sessions: readonly {
            readonly id: string;
            readonly version: number;
            readonly digestSha256: string;
          }[];
        };
      }>();
    };
    const removableCatalog = await currentCatalog();
    const removableCreate = await mutateSession('d1-session-removable-create', {
      action: 'create',
      expectedCatalogVersion: removableCatalog.data.version,
      expectedCatalogDigestSha256: removableCatalog.data.digestSha256,
      title: 'Removable Session',
      plannedDurationMinutes: 30,
      lifecycle: 'draft',
      formatId: workshopFormatId,
      trackId
    });
    const removableCreateBody = await removableCreate.json<{
      readonly data: { readonly session: { readonly id: string; readonly version: 1;
        readonly digestSha256: string } };
    }>();
    const catalogWithRemovable = await currentCatalog();
    const removedSession = await mutateSession('d1-session-remove', {
      action: 'remove_new_session',
      expectedCatalogVersion: catalogWithRemovable.data.version,
      expectedCatalogDigestSha256: catalogWithRemovable.data.digestSha256,
      sessionId: removableCreateBody.data.session.id,
      expectedSessionVersion: 1,
      expectedSessionDigestSha256: removableCreateBody.data.session.digestSha256
    });
    expect(await removedSession.json()).toMatchObject({
      kind: 'success', data: { action: 'remove_new_session', session: null }
    });

    const referencedCatalog = await currentCatalog();
    const referencedCreate = await mutateSession('d1-session-referenced-create', {
      action: 'create',
      expectedCatalogVersion: referencedCatalog.data.version,
      expectedCatalogDigestSha256: referencedCatalog.data.digestSha256,
      title: 'Referenced Session',
      plannedDurationMinutes: 30,
      lifecycle: 'draft',
      formatId: workshopFormatId,
      trackId
    });
    const referencedCreateBody = await referencedCreate.json<{
      readonly data: { readonly session: { readonly id: string;
        readonly digestSha256: string } };
    }>();
    await env.DB.prepare(`INSERT INTO schedule_occurrences
      (workspace_id,event_id,id,session_id,room_id,start_at_ms,end_at_ms,version,
       updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        workspaceId, eventId, uuid(719), referencedCreateBody.data.session.id, roomId,
        Date.parse('2027-03-11T09:00:00.000Z'), Date.parse('2027-03-11T09:30:00.000Z'),
        1, userId, recordedAtMs
      ).run();
    const catalogWithReference = await currentCatalog();
    const refusedRemoval = await mutateSession('d1-session-remove-referenced', {
      action: 'remove_new_session',
      expectedCatalogVersion: catalogWithReference.data.version,
      expectedCatalogDigestSha256: catalogWithReference.data.digestSha256,
      sessionId: referencedCreateBody.data.session.id,
      expectedSessionVersion: 1,
      expectedSessionDigestSha256: referencedCreateBody.data.session.digestSha256
    });
    expect(await refusedRemoval.json()).toMatchObject({
      kind: 'outcome', outcome: { class: 'stale_revision', kind: 'session.changed',
        detail: { code: 'stale_session', action: 'remove_new_session' } }
    });
    const sessionOperationCount = await env.DB.prepare(`SELECT count(*) AS count
      FROM operation_log WHERE workspace_id = ? AND operation_name = 'session.change'`)
      .bind(workspaceId).first<{ readonly count: number }>();
    expect(sessionOperationCount?.count).toBe(6);

    const mutatePlacement = (key: string, body: unknown) => handleRequest(
      new Request(`${baseUrl}/api/events/current/schedule/placements`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(body)
      }),
      environment()
    );
    const placeBody = {
      action: 'place',
      expectedScheduleVersion: 2,
      sessionId: transitionedSessionBody.data.session.id,
      roomId,
      startAt: '2027-03-10T11:00:00.000Z',
      endAt: '2027-03-10T12:00:00.000Z'
    } as const;
    const placed = await mutatePlacement('d1-schedule-place', placeBody);
    expect(placed.status, await placed.clone().text()).toBe(200);
    const placedBody = await placed.json<{
      readonly kind: string;
      readonly data: { readonly scheduleVersion: number; readonly occurrence: {
        readonly id: string; readonly version: number;
      } };
    }>();
    expect(placedBody.kind, JSON.stringify(placedBody)).toBe('success');
    expect(placedBody).toMatchObject({
      kind: 'success', data: { action: 'place', scheduleVersion: 3,
        occurrence: { sessionId: transitionedSessionBody.data.session.id,
          roomId, version: 1 } }
    });
    const placedReplay = await mutatePlacement('d1-schedule-place', placeBody);
    expect(await placedReplay.json()).toEqual(placedBody);
    const changedPlace = await mutatePlacement('d1-schedule-place', {
      ...placeBody, endAt: '2027-03-10T12:30:00.000Z'
    });
    expect(await changedPlace.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });
    const overlap = await mutatePlacement('d1-schedule-overlap', {
      ...placeBody,
      expectedScheduleVersion: 3,
      startAt: '2027-03-10T11:30:00.000Z',
      endAt: '2027-03-10T12:30:00.000Z'
    });
    expect(await overlap.json()).toMatchObject({
      kind: 'outcome', outcome: { class: 'conflict', kind: 'schedule_room_overlap',
        detail: { severity: 'block', roomId,
          conflicts: [{ occurrenceId: placedBody.data.occurrence.id }] } }
    });
    const movedPlacement = await mutatePlacement('d1-schedule-move', {
      action: 'move',
      expectedScheduleVersion: 3,
      occurrenceId: placedBody.data.occurrence.id,
      expectedOccurrenceVersion: 1,
      roomId,
      startAt: '2027-03-10T12:00:00.000Z',
      endAt: '2027-03-10T13:00:00.000Z'
    });
    const movedPlacementBody = await movedPlacement.json<{
      readonly data: { readonly occurrence: { readonly id: string;
        readonly version: number } };
    }>();
    expect(movedPlacementBody).toMatchObject({
      kind: 'success', data: { action: 'move', scheduleVersion: 4,
        occurrence: { id: placedBody.data.occurrence.id, version: 2,
          startAt: '2027-03-10T12:00:00.000Z' } }
    });
    const unplaced = await mutatePlacement('d1-schedule-unplace', {
      action: 'unplace',
      expectedScheduleVersion: 4,
      occurrenceId: movedPlacementBody.data.occurrence.id,
      expectedOccurrenceVersion: movedPlacementBody.data.occurrence.version
    });
    expect(await unplaced.json()).toMatchObject({
      kind: 'success', data: { action: 'unplace', scheduleVersion: 5, occurrence: null }
    });
    const finalSchedule = await handleRequest(
      new Request(`${baseUrl}/api/events/current/schedule/placements?startAt=2027-03-10T00%3A00%3A00.000Z&endAt=2027-03-13T00%3A00%3A00.000Z&limit=100`, { headers }),
      environment()
    );
    expect(await finalSchedule.json()).toMatchObject({
      kind: 'success', data: { scheduleVersion: 5,
        occurrences: [{ id: uuid(719), sessionId: referencedCreateBody.data.session.id }] }
    });
    const placementOperationCount = await env.DB.prepare(`SELECT count(*) AS count
      FROM operation_log WHERE workspace_id = ? AND operation_name = 'schedule.placement'`)
      .bind(workspaceId).first<{ readonly count: number }>();
    expect(placementOperationCount?.count).toBe(3);
    const asset = {
      schemaVersion: 1, id: assetId, scope,
      uploader: { kind: 'operator_user', userId },
      purpose: 'resource_share_material', displayFilename: 'Speaker guide.pdf',
      contentType: 'application/pdf', byteSize: assetBytes.byteLength, sha256: 'a'.repeat(64),
      storageProvider: 'cloudflare-r2',
      storageKey: `files/${workspaceId}/${eventId}/${assetId}`,
      lifecycle: 'available',
      scan: { provider: 'none', verdict: 'released', checkedAt: recordedAt },
      version: 1, createdAt: recordedAt, updatedAt: recordedAt
    };
    const share = {
      schemaVersion: 1, id: shareId, scope, title: 'Speaker resources',
      audience: { kind: 'all_confirmed' }, createdByUserId: userId,
      state: 'active', version: 1, createdAt: recordedAt, revokedAt: null
    };
    const assetAttachment = {
      schemaVersion: 1, id: assetAttachmentId, scope,
      subject: { kind: 'resource_share', resourceShareId: shareId },
      content: { kind: 'asset', assetId },
      attachedBy: { kind: 'operator_user', userId }, state: 'attached', version: 1,
      attachedAt: recordedAt, detachedAt: null
    };
    const linkAttachment = {
      schemaVersion: 1, id: linkAttachmentId, scope,
      subject: { kind: 'resource_share', resourceShareId: shareId },
      content: {
        kind: 'link',
        link: { provider: 'url', label: 'Venue map', url: 'https://example.invalid/map' }
      },
      attachedBy: { kind: 'operator_user', userId }, state: 'attached', version: 1,
      attachedAt: recordedAt, detachedAt: null
    };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO resource_shares
        (workspace_id,event_id,id,title,audience_kind,audience_id,created_by_user_id,
         state,version,head_json,created_at_ms,revoked_at_ms)
        VALUES (?,?,?,?,'all_confirmed',NULL,?,'active',1,?,?,NULL)`)
        .bind(workspaceId, eventId, shareId, share.title, userId, JSON.stringify(share), recordedAtMs),
      env.DB.prepare(`INSERT INTO file_assets
        (workspace_id,event_id,id,uploader_kind,uploader_id,purpose,display_filename,
         content_type,byte_size,sha256,storage_provider,storage_key,lifecycle,
         scan_provider,scan_verdict,scan_checked_at_ms,version,head_json,created_at_ms,updated_at_ms)
        VALUES (?,?,?,'operator_user',?,'resource_share_material',?,'application/pdf',
          ?,?,'cloudflare-r2',?,'available','none','released',?,1,?,?,?)`)
        .bind(
          workspaceId, eventId, assetId, userId, asset.displayFilename, asset.byteSize,
          asset.sha256, asset.storageKey, recordedAtMs, canonicalJsonText(asset), recordedAtMs,
          recordedAtMs
        ),
      env.DB.prepare(`INSERT INTO file_attachments
        (workspace_id,event_id,id,subject_kind,subject_id,content_kind,asset_id,
         link_provider,link_label,link_url,attached_by_kind,attached_by_id,state,
         version,head_json,attached_at_ms,detached_at_ms)
        VALUES (?,?,?,'resource_share',?,'asset',?,NULL,NULL,NULL,
          'operator_user',?,'attached',1,?,?,NULL)`)
        .bind(
          workspaceId, eventId, assetAttachmentId, shareId, assetId, userId,
          JSON.stringify(assetAttachment), recordedAtMs
        ),
      env.DB.prepare(`INSERT INTO file_attachments
        (workspace_id,event_id,id,subject_kind,subject_id,content_kind,asset_id,
         link_provider,link_label,link_url,attached_by_kind,attached_by_id,state,
         version,head_json,attached_at_ms,detached_at_ms)
        VALUES (?,?,?,'resource_share',?,'link',NULL,'url','Venue map',
          'https://example.invalid/map','operator_user',?,'attached',1,?,?,NULL)`)
        .bind(
          workspaceId, eventId, linkAttachmentId, shareId, userId,
          JSON.stringify(linkAttachment), recordedAtMs
        )
    ]);
    const files = await handleRequest(
      new Request(`${baseUrl}/api/events/current/files`, { headers }),
      environment()
    );
    expect(files.status, await files.clone().text()).toBe(200);
    expect(await files.json()).toMatchObject({
      kind: 'success',
      data: {
        schemaVersion: 1,
        scope,
        attachments: [
          { attachment: assetAttachment, asset },
          { attachment: linkAttachment, asset: null }
        ],
        shares: [share],
        requests: []
      }
    });
    await env.FILES.put(asset.storageKey, assetBytes);
    const anonymousDownload = await handleRequest(
      new Request(`${baseUrl}/api/events/current/files/download/${assetId}`),
      environment()
    );
    expect(anonymousDownload.status).toBe(401);
    expect(await anonymousDownload.json()).toMatchObject({
      kind: 'refused', code: 'unauthenticated'
    });
    const download = await handleRequest(
      new Request(`${baseUrl}/api/events/current/files/download/${assetId}`, { headers }),
      environment()
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toBe(
      `attachment; filename="Speaker guide.pdf"; filename*=UTF-8''Speaker%20guide.pdf`
    );
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('cache-control')).toBe('private, no-store');
    expect(download.headers.get('content-length')).toBe(String(assetBytes.byteLength));
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(assetBytes);
    const missingDownload = await handleRequest(
      new Request(`${baseUrl}/api/events/current/files/download/${uuid(712)}`, { headers }),
      environment()
    );
    expect(missingDownload.status).toBe(404);
    expect(await missingDownload.json()).toEqual({ kind: 'not_found' });

    const list = await handleRequest(
      new Request(`${baseUrl}/api/events`, { headers }),
      environment()
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      kind: 'success',
      data: {
        eventSetVersion: 2,
        currentEventId: firstBody.data.event.id,
        events: [{ id: firstBody.data.event.id, name: 'D1 Application Summit' }]
      }
    });
    const selectedShell = await handleRequest(
      new Request(`${baseUrl}/api/workspace/shell-summary`, { headers }),
      environment()
    );
    expect(await selectedShell.json()).toMatchObject({
      kind: 'success',
      data: {
        workspace: { id: workspaceId, name: 'D1 application workspace' },
        event: {
          id: firstBody.data.event.id,
          name: 'D1 Application Summit',
          timezone: 'Asia/Singapore',
          startDate: '2027-03-10',
          endDate: '2027-03-12'
        }
      }
    });
    const settings = await handleRequest(
      new Request(`${baseUrl}/api/events/current/settings`, { headers }),
      environment()
    );
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({
      kind: 'success',
      data: {
        eventId: firstBody.data.event.id,
        eventSetVersion: 2,
        eventVersion: 1,
        name: 'D1 Application Summit',
        location: '',
        dayStart: '09:00',
        dayEnd: '18:00',
        slotMinutes: 15
      }
    });
    const updateRequest = () => new Request(`${baseUrl}/api/events/current/settings`, {
      method: 'POST',
      headers: {
        cookie: headers.cookie,
        origin: baseUrl,
        'content-type': 'application/json',
        'idempotency-key': 'd1-application-update-event-settings'
      },
      body: JSON.stringify({
        expectedEventId: firstBody.data.event.id,
        expectedEventSetVersion: 2,
        expectedEventVersion: 1,
        name: 'D1 Application Summit',
        timezone: 'Asia/Singapore',
        startDate: '2027-03-10',
        endDate: '2027-03-12',
        location: 'Suntec Convention Centre',
        venueNote: 'Level three',
        dayStart: '09:00',
        dayEnd: '18:00',
        slotMinutes: 15
      })
    });
    const updated = await handleRequest(updateRequest(), environment());
    expect(updated.status, await updated.clone().text()).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody).toMatchObject({
      kind: 'success',
      data: {
        action: 'update',
        eventId: firstBody.data.event.id,
        eventSetVersion: 2,
        eventVersion: 2
      }
    });
    const updateReplay = await handleRequest(updateRequest(), environment());
    expect(updateReplay.status).toBe(200);
    expect(await updateReplay.json()).toEqual(updatedBody);
    const updatedSettings = await handleRequest(
      new Request(`${baseUrl}/api/events/current/settings`, { headers }),
      environment()
    );
    expect(await updatedSettings.json()).toMatchObject({
      kind: 'success',
      data: {
        eventVersion: 2,
        location: 'Suntec Convention Centre',
        venueNote: 'Level three'
      }
    });
    const stale = await handleRequest(new Request(`${baseUrl}/api/events/current/settings`, {
      method: 'POST',
      headers: {
        cookie: headers.cookie,
        origin: baseUrl,
        'content-type': 'application/json',
        'idempotency-key': 'd1-application-stale-event-settings'
      },
      body: JSON.stringify({
        expectedEventId: firstBody.data.event.id,
        expectedEventSetVersion: 2,
        expectedEventVersion: 1,
        name: 'Stale name',
        timezone: 'Asia/Singapore',
        startDate: '2027-03-10',
        endDate: '2027-03-12',
        location: '',
        venueNote: '',
        dayStart: '09:00',
        dayEnd: '18:00',
        slotMinutes: 15
      })
    }), environment());
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({
      kind: 'outcome',
      outcome: { kind: 'event.settings_changed', detail: { code: 'stale_event' } }
    });
    const settingsRows = await env.DB.prepare(`SELECT h.version AS event_version,
      c.event_version AS companion_version,c.location
      FROM event_spine_heads h JOIN event_settings_companions c
        ON c.workspace_id = h.workspace_id AND c.event_id = h.id
      WHERE h.workspace_id = ? AND h.id = ?`)
      .bind(workspaceId, firstBody.data.event.id)
      .first<{ event_version: number; companion_version: number; location: string }>();
    expect(settingsRows).toEqual({
      event_version: 2,
      companion_version: 2,
      location: 'Suntec Convention Centre'
    });
    const operationCount = await env.DB.prepare(
      'SELECT count(*) AS count FROM operation_log WHERE workspace_id = ?'
    ).bind(workspaceId).first<{ readonly count: number }>();
    expect(operationCount?.count).toBe(17);
    const logs = await env.DB.prepare('SELECT count(*) AS count FROM operation_log WHERE id = ?')
      .bind(firstBody.receipt.id).first<{ readonly count: number }>();
    expect(logs?.count).toBe(1);

    const senderUpdateRequest = () => new Request(
      `${baseUrl}/api/communications/sender-identity`,
      {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': 'd1-application-sender-identity-update'
        },
        body: JSON.stringify({
          expectedHeadVersion: 1,
          displayName: 'D1 Application Summit',
          replyToAddress: 'organizers@example.invalid'
        })
      }
    );
    const senderUpdate = await handleRequest(senderUpdateRequest(), environment());
    expect(senderUpdate.status, await senderUpdate.clone().text()).toBe(200);
    const senderUpdateBody = await senderUpdate.json();
    expect(senderUpdateBody).toMatchObject({
      kind: 'success',
      data: {
        headVersion: 2,
        displayName: 'D1 Application Summit',
        replyToAddress: 'organizers@example.invalid',
        effective: {
          fromAddress: 'events@mail.jooevents.com',
          fromDisplayName: 'D1 Application Summit',
          replyToAddress: 'organizers@example.invalid',
          source: 'workspace'
        }
      }
    });
    const senderReplay = await handleRequest(senderUpdateRequest(), environment());
    expect(senderReplay.status, await senderReplay.clone().text()).toBe(200);
    expect(await senderReplay.json()).toEqual(senderUpdateBody);

    const refusedSender = await handleRequest(new Request(
      `${baseUrl}/api/communications/sender-identity`,
      {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': 'd1-application-sender-identity-refused'
        },
        body: JSON.stringify({
          expectedHeadVersion: 2,
          displayName: 'Unsafe\nHeader',
          replyToAddress: null
        })
      }
    ), environment());
    expect(refusedSender.status, await refusedSender.clone().text()).toBe(200);
    expect(await refusedSender.json()).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'policy_violation',
        kind: 'communication.sender_identity_refused',
        detail: { field: 'display_name' }
      }
    });
    const staleSender = await handleRequest(new Request(
      `${baseUrl}/api/communications/sender-identity`,
      {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': 'd1-application-sender-identity-stale'
        },
        body: JSON.stringify({
          expectedHeadVersion: 1,
          displayName: 'Stale overwrite',
          replyToAddress: null
        })
      }
    ), environment());
    expect(staleSender.status, await staleSender.clone().text()).toBe(200);
    expect(await staleSender.json()).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'communication.sender_identity_changed',
        detail: { code: 'head_version_changed', headVersion: 2 }
      }
    });
    expect(await env.DB.prepare(`SELECT head_version,display_name,reply_to_address
      FROM workspace_mail_sender_identity WHERE workspace_id = ?`
    ).bind(workspaceId).first()).toEqual({
      head_version: 2,
      display_name: 'D1 Application Summit',
      reply_to_address: 'organizers@example.invalid'
    });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM operation_log
      WHERE workspace_id = ? AND operation_name = 'communication.sender_identity.update'`
    ).bind(workspaceId).first()).toEqual({ count: 1 });

    const initialRegistry = await handleRequest(
      new Request(`${baseUrl}/api/events/current/field-registry`, { headers }),
      environment()
    );
    expect(initialRegistry.status, await initialRegistry.clone().text()).toBe(200);
    expect(await initialRegistry.json()).toMatchObject({
      kind: 'success',
      data: {
        version: 1,
        fields: expect.arrayContaining([expect.objectContaining({ key: 'person.email' })])
      }
    });
    const addBody = {
      expectedRegistryVersion: 1,
      field: {
        kind: 'text',
        label: 'Employer',
        help: 'Where do you work?',
        answerOwner: 'person',
        scope: { kind: 'shared' },
        contexts: {
          apply: { visible: true, required: false },
          onboard: { visible: true, required: false },
          profile: { visible: true, required: false }
        },
        options: { kind: 'none' }
      }
    } as const;
    const fieldMutation = (action: string, key: string, body: unknown) => handleRequest(
      new Request(`${baseUrl}/api/events/current/field-registry/${action}`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(body)
      }),
      environment()
    );
    const added = await fieldMutation('add', 'd1-field-add', addBody);
    expect(added.status, await added.clone().text()).toBe(200);
    const addedBody = await added.json<{
      readonly kind: string;
      readonly data: { readonly mutation: { readonly fieldId: string } };
    }>();
    expect(addedBody).toMatchObject({
      kind: 'success',
      data: { action: 'add', mutation: { registryVersion: 2, fieldVersion: 1 } }
    });
    const fieldId = addedBody.data.mutation.fieldId;
    const addReplay = await fieldMutation('add', 'd1-field-add', addBody);
    expect(await addReplay.json()).toEqual(addedBody);
    const changedRequest = await fieldMutation('add', 'd1-field-add', {
      ...addBody,
      field: { ...addBody.field, label: 'Changed request' }
    });
    expect(await changedRequest.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });
    const edited = await fieldMutation('edit', 'd1-field-edit', {
      fieldId,
      expectedFieldVersion: 1,
      expectedRegistryVersion: 2,
      changes: { label: 'Organization' }
    });
    expect(await edited.json()).toMatchObject({
      kind: 'success',
      data: { action: 'edit', mutation: { fieldId, registryVersion: 3, fieldVersion: 2 } }
    });
    const moved = await fieldMutation('move', 'd1-field-move', {
      fieldId,
      expectedFieldVersion: 2,
      expectedRegistryVersion: 3,
      toIndex: 0
    });
    expect(await moved.json()).toMatchObject({
      kind: 'success',
      data: { action: 'move', mutation: { fieldId, registryVersion: 4, position: 0 } }
    });
    const removed = await fieldMutation('remove', 'd1-field-remove', {
      fieldId,
      expectedFieldVersion: 2,
      expectedRegistryVersion: 4
    });
    expect(await removed.json()).toMatchObject({
      kind: 'success',
      data: { action: 'remove', mutation: { fieldId, registryVersion: 5, position: null } }
    });
    const restored = await fieldMutation('restore', 'd1-field-restore', {
      fieldId,
      expectedFieldVersion: 2,
      expectedRegistryVersion: 5,
      toIndex: 0
    });
    expect(await restored.json()).toMatchObject({
      kind: 'success',
      data: {
        action: 'restore',
        mutation: { fieldId, registryVersion: 6, fieldVersion: 3, position: 0 }
      }
    });
    const staleField = await fieldMutation('edit', 'd1-field-stale', {
      fieldId,
      expectedFieldVersion: 2,
      expectedRegistryVersion: 5,
      changes: { label: 'Stale label' }
    });
    expect(await staleField.json()).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'field_registry.changed',
        detail: { code: 'stale_registry', action: 'edit', fieldId }
      }
    });
    const finalRegistry = await handleRequest(
      new Request(`${baseUrl}/api/events/current/field-registry`, { headers }),
      environment()
    );
    expect(await finalRegistry.json()).toMatchObject({
      kind: 'success',
      data: {
        version: 6,
        fields: expect.arrayContaining([expect.objectContaining({
          id: fieldId,
          version: 3,
          label: 'Organization',
          position: 0
        })])
      }
    });
    const registryRow = await env.DB.prepare(`SELECT registry_version,state_json,
      state_digest_sha256 FROM field_registry_aggregates
      WHERE workspace_id = ? AND event_id = ?`)
      .bind(workspaceId, firstBody.data.event.id)
      .first<{
        readonly registry_version: number;
        readonly state_json: string;
        readonly state_digest_sha256: string;
      }>();
    expect(registryRow?.registry_version).toBe(6);
    expect(JSON.parse(registryRow?.state_json ?? '{}')).toMatchObject({ version: 6 });
    expect(registryRow?.state_digest_sha256).toMatch(/^[a-f0-9]{64}$/);
    const fieldOperationCount = await env.DB.prepare(`SELECT count(*) AS count
      FROM operation_log WHERE workspace_id = ? AND operation_name LIKE 'field_registry.%'`)
      .bind(workspaceId).first<{ readonly count: number }>();
    expect(fieldOperationCount?.count).toBe(5);

    const initialDeadlines = await handleRequest(
      new Request(`${baseUrl}/api/events/current/deadlines`, { headers }),
      environment()
    );
    expect(initialDeadlines.status, await initialDeadlines.clone().text()).toBe(200);
    expect(await initialDeadlines.json()).toMatchObject({
      kind: 'success',
      data: { version: 1, deadlines: [] }
    });
    const deadlineMutation = (key: string, body: unknown) => handleRequest(
      new Request(`${baseUrl}/api/events/current/deadlines`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(body)
      }),
      environment()
    );
    const deadlineCreateBody = { action: 'create', displayDate: '2027-03-09' } as const;
    const createdDeadline = await deadlineMutation('d1-deadline-create', deadlineCreateBody);
    expect(createdDeadline.status, await createdDeadline.clone().text()).toBe(200);
    const createdDeadlineBody = await createdDeadline.json<{
      readonly kind: string;
      readonly data: { readonly deadline: { readonly id: string } };
    }>();
    expect(createdDeadlineBody).toMatchObject({
      kind: 'success',
      data: {
        action: 'create',
        catalogVersion: 2,
        deadline: { status: 'active', version: 1, displayDate: '2027-03-09' }
      }
    });
    const deadlineId = createdDeadlineBody.data.deadline.id;
    const deadlineReplay = await deadlineMutation('d1-deadline-create', deadlineCreateBody);
    expect(await deadlineReplay.json()).toEqual(createdDeadlineBody);
    const staleDeadline = await deadlineMutation('d1-deadline-stale', {
      action: 'update',
      deadlineId,
      expectedVersion: 9,
      displayDate: '2027-03-10'
    });
    expect(await staleDeadline.json()).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'deadline.canonical_changed',
        detail: { code: 'stale_deadline', action: 'update', deadlineId }
      }
    });
    const updatedDeadline = await deadlineMutation('d1-deadline-update', {
      action: 'update',
      deadlineId,
      expectedVersion: 1,
      displayDate: '2027-03-10'
    });
    expect(await updatedDeadline.json()).toMatchObject({
      kind: 'success',
      data: {
        action: 'update',
        catalogVersion: 3,
        deadline: { id: deadlineId, status: 'active', version: 2 }
      }
    });
    const currentDeadline = await handleRequest(
      new Request(`${baseUrl}/api/events/current/deadlines/current?deadlineId=${deadlineId}`, {
        headers
      }),
      environment()
    );
    expect(await currentDeadline.json()).toMatchObject({
      kind: 'success',
      data: { deadline: { id: deadlineId, version: 2, displayDate: '2027-03-10' } }
    });
    const clearedDeadline = await deadlineMutation('d1-deadline-clear', {
      action: 'clear',
      deadlineId,
      expectedVersion: 2
    });
    expect(await clearedDeadline.json()).toMatchObject({
      kind: 'success',
      data: {
        action: 'clear',
        catalogVersion: 4,
        deadline: { id: deadlineId, status: 'cleared', version: 3 },
        pin: null
      }
    });
    const finalDeadlines = await handleRequest(
      new Request(`${baseUrl}/api/events/current/deadlines`, { headers }),
      environment()
    );
    expect(await finalDeadlines.json()).toMatchObject({
      kind: 'success',
      data: {
        version: 4,
        deadlines: [{ id: deadlineId, status: 'cleared', version: 3 }]
      }
    });
    const deadlineOperationCount = await env.DB.prepare(`SELECT count(*) AS count
      FROM operation_log WHERE workspace_id = ? AND operation_name = 'deadline.change'`)
      .bind(workspaceId).first<{ readonly count: number }>();
    expect(deadlineOperationCount?.count).toBe(3);

    const initialTasks = await handleRequest(
      new Request(`${baseUrl}/api/events/current/tasks`, { headers }),
      environment()
    );
    expect(initialTasks.status, await initialTasks.clone().text()).toBe(200);
    expect(await initialTasks.json()).toMatchObject({
      kind: 'success',
      data: { catalogVersion: 1, definitions: [], assignments: [] }
    });
    const taskCreateBody = {
      action: 'create_definition',
      name: 'Confirm profile',
      description: 'Review your speaker profile.',
      completionMode: 'acknowledge',
      required: true,
      dueOn: '2027-03-11'
    } as const;
    const taskMutation = (key: string, body: unknown) => handleRequest(
      new Request(`${baseUrl}/api/events/current/tasks`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(body)
      }),
      environment()
    );
    const createdTask = await taskMutation('d1-task-create', taskCreateBody);
    expect(createdTask.status, await createdTask.clone().text()).toBe(200);
    const createdTaskBody = await createdTask.json<{
      readonly kind: string;
      readonly data: {
        readonly definition: {
          readonly head: { readonly id: string; readonly version: number };
          readonly current: {
            readonly deadline: {
              readonly kind: string;
              readonly reference: { readonly id: string; readonly displayDate: string };
            };
          };
        };
        readonly assignments: readonly unknown[];
      };
    }>();
    expect(createdTaskBody).toMatchObject({
      kind: 'success',
      data: {
        action: 'create_definition',
        definition: {
          head: { version: 1 },
          current: {
            name: 'Confirm profile',
            completionMode: 'acknowledge',
            required: true,
            deadline: { kind: 'task_due', reference: { displayDate: '2027-03-11' } }
          }
        },
        assignments: []
      }
    });
    const taskDefinitionId = createdTaskBody.data.definition.head.id;
    const taskDeadlineId = createdTaskBody.data.definition.current.deadline.reference.id;
    const taskReplay = await taskMutation('d1-task-create', taskCreateBody);
    expect(await taskReplay.json()).toEqual(createdTaskBody);
    const changedTaskRequest = await taskMutation('d1-task-create', {
      ...taskCreateBody,
      name: 'Changed task request'
    });
    expect(await changedTaskRequest.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });
    const finalTasks = await handleRequest(
      new Request(`${baseUrl}/api/events/current/tasks`, { headers }),
      environment()
    );
    expect(await finalTasks.json()).toMatchObject({
      kind: 'success',
      data: {
        catalogVersion: 2,
        definitions: [{
          head: { id: taskDefinitionId, version: 1 },
          current: {
            name: 'Confirm profile',
            deadline: { reference: { id: taskDeadlineId } }
          }
        }],
        assignments: []
      }
    });
    const embeddedDeadline = await env.DB.prepare(`SELECT status,version,display_date
      FROM deadlines WHERE workspace_id = ? AND event_id = ? AND id = ?`)
      .bind(workspaceId, firstBody.data.event.id, taskDeadlineId)
      .first<{ readonly status: string; readonly version: number; readonly display_date: string }>();
    expect(embeddedDeadline).toEqual({
      status: 'active', version: 1, display_date: '2027-03-11'
    });
    const taskOperationCount = await env.DB.prepare(`SELECT count(*) AS count
      FROM operation_log WHERE workspace_id = ? AND operation_name = 'task.mutation'`)
      .bind(workspaceId).first<{ readonly count: number }>();
    expect(taskOperationCount?.count).toBe(1);

    type TemplateArtifact = {
      readonly head: {
        readonly artifactId: string;
        readonly artifactKind: 'message' | 'surface' | 'theme';
        readonly currentRevisionNumber: number;
        readonly version: number;
      };
      readonly current: {
        readonly revisionId: string;
        readonly number: number;
        readonly document: Record<string, unknown> & { readonly kind: string };
      };
      readonly history: readonly { readonly number: number }[];
    };
    const initialTemplates = await handleRequest(
      new Request(`${baseUrl}/api/events/current/template-artifacts`, { headers }),
      environment()
    );
    expect(initialTemplates.status, await initialTemplates.clone().text()).toBe(200);
    const initialTemplatesBody = await initialTemplates.json<{
      readonly kind: string;
      readonly data: { readonly artifacts: readonly TemplateArtifact[] };
    }>();
    expect(initialTemplatesBody).toMatchObject({ kind: 'success' });
    expect(initialTemplatesBody.data.artifacts).toHaveLength(10);
    expect(initialTemplatesBody.data.artifacts.filter(
      (artifact) => artifact.head.artifactKind === 'message'
    )).toHaveLength(6);
    expect(initialTemplatesBody.data.artifacts.filter(
      (artifact) => artifact.head.artifactKind === 'surface'
    )).toHaveLength(3);
    expect(initialTemplatesBody.data.artifacts.filter(
      (artifact) => artifact.head.artifactKind === 'theme'
    )).toHaveLength(1);
    const messageTemplate = initialTemplatesBody.data.artifacts.find(
      (artifact) => artifact.head.artifactKind === 'message'
    );
    if (!messageTemplate || messageTemplate.current.document.kind !== 'message') {
      throw new Error('D1 seeded message Template missing.');
    }
    const templateDetail = await handleRequest(
      new Request(`${baseUrl}/api/events/current/template-artifacts/detail?artifactId=${messageTemplate.head.artifactId}`, {
        headers
      }),
      environment()
    );
    expect(await templateDetail.json()).toMatchObject({
      kind: 'success',
      data: { head: { artifactId: messageTemplate.head.artifactId, version: 1 } }
    });
    const originalSubject = messageTemplate.current.document.subject;
    if (typeof originalSubject !== 'string') throw new Error('D1 message subject missing.');
    const replacementDocument = {
      ...messageTemplate.current.document,
      subject: `${originalSubject} — updated`
    };
    const templateMutation = (path: string, key: string, body: unknown) => handleRequest(
      new Request(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(body)
      }),
      environment()
    );
    const draftedTemplate = await templateMutation(
      '/api/events/current/template-artifacts/drafts',
      'd1-template-draft',
      {
        action: 'replace',
        artifactId: messageTemplate.head.artifactId,
        expectedRevisionNumber: 1,
        document: replacementDocument,
        author: 'organizer',
        note: 'Clarify the subject line.'
      }
    );
    expect(draftedTemplate.status, await draftedTemplate.clone().text()).toBe(200);
    const draftedTemplateBody = await draftedTemplate.json<{
      readonly kind: string;
      readonly data: {
        readonly draftId: string;
        readonly revision: { readonly id: string; readonly digestSha256: string };
      };
    }>();
    expect(draftedTemplateBody).toMatchObject({
      kind: 'success',
      data: {
        action: 'replace',
        status: 'draft',
        safeDiff: {
          artifactId: messageTemplate.head.artifactId,
          before: { number: 1 },
          after: { number: 2, document: replacementDocument }
        }
      }
    });
    const beforeTemplatePublish = await env.DB.prepare(`SELECT version
      FROM template_artifact_heads
      WHERE workspace_id = ? AND event_id = ? AND artifact_id = ?`)
      .bind(workspaceId, firstBody.data.event.id, messageTemplate.head.artifactId)
      .first<{ readonly version: number }>();
    expect(beforeTemplatePublish?.version).toBe(1);
    const publishSelector = {
      draftId: draftedTemplateBody.data.draftId,
      revisionId: draftedTemplateBody.data.revision.id,
      revisionDigestSha256: draftedTemplateBody.data.revision.digestSha256
    };
    const publishedTemplate = await templateMutation(
      '/api/events/current/template-artifacts/publish',
      'd1-template-publish',
      publishSelector
    );
    expect(publishedTemplate.status, await publishedTemplate.clone().text()).toBe(200);
    const publishedTemplateBody = await publishedTemplate.json();
    expect(publishedTemplateBody).toMatchObject({
      kind: 'success',
      data: {
        action: 'replace',
        revision: { number: 2, document: replacementDocument }
      }
    });
    const templatePublishReplay = await templateMutation(
      '/api/events/current/template-artifacts/publish',
      'd1-template-publish',
      publishSelector
    );
    expect(await templatePublishReplay.json()).toEqual(publishedTemplateBody);
    const changedTemplatePublish = await templateMutation(
      '/api/events/current/template-artifacts/publish',
      'd1-template-publish',
      { ...publishSelector, revisionDigestSha256: '0'.repeat(64) }
    );
    expect(await changedTemplatePublish.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });
    const revertTemplateDraft = await templateMutation(
      '/api/events/current/template-artifacts/drafts',
      'd1-template-revert-draft',
      {
        action: 'revert',
        artifactId: messageTemplate.head.artifactId,
        expectedRevisionNumber: 2,
        targetRevisionNumber: 1
      }
    );
    expect(revertTemplateDraft.status, await revertTemplateDraft.clone().text()).toBe(200);
    const revertTemplateDraftBody = await revertTemplateDraft.json<{
      readonly kind: string;
      readonly data: {
        readonly draftId: string;
        readonly revision: { readonly id: string; readonly digestSha256: string };
      };
    }>();
    expect(revertTemplateDraftBody).toMatchObject({
      kind: 'success',
      data: {
        action: 'revert',
        safeDiff: {
          before: { number: 2 },
          after: { number: 3, document: messageTemplate.current.document },
          restoredFromRevisionNumber: 1
        }
      }
    });
    const revertedTemplate = await templateMutation(
      '/api/events/current/template-artifacts/publish',
      'd1-template-revert',
      {
        draftId: revertTemplateDraftBody.data.draftId,
        revisionId: revertTemplateDraftBody.data.revision.id,
        revisionDigestSha256: revertTemplateDraftBody.data.revision.digestSha256
      }
    );
    expect(revertedTemplate.status, await revertedTemplate.clone().text()).toBe(200);
    expect(await revertedTemplate.json()).toMatchObject({
      kind: 'success',
      data: {
        action: 'revert',
        revision: { number: 3, document: messageTemplate.current.document }
      }
    });
    const staleTemplateDraft = await templateMutation(
      '/api/events/current/template-artifacts/drafts',
      'd1-template-stale-draft',
      {
        action: 'replace',
        artifactId: messageTemplate.head.artifactId,
        expectedRevisionNumber: 1,
        document: replacementDocument,
        author: 'organizer',
        note: 'Stale draft.'
      }
    );
    expect(await staleTemplateDraft.json()).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'template.artifact_changed',
        detail: { code: 'stale_revision', action: 'replace' }
      }
    });
    const finalTemplateDetail = await handleRequest(
      new Request(`${baseUrl}/api/events/current/template-artifacts/detail?artifactId=${messageTemplate.head.artifactId}`, {
        headers
      }),
      environment()
    );
    expect(await finalTemplateDetail.json()).toMatchObject({
      kind: 'success',
      data: {
        head: { currentRevisionNumber: 3, version: 3 },
        current: { number: 3, document: messageTemplate.current.document },
        history: [{ number: 1 }, { number: 2 }, { number: 3 }]
      }
    });
    const templateDraftRow = await env.DB.prepare(`SELECT status,published_by_user_id
      FROM template_artifact_review_drafts
      WHERE workspace_id = ? AND event_id = ? AND id = ?`)
      .bind(workspaceId, firstBody.data.event.id, draftedTemplateBody.data.draftId)
      .first<{ readonly status: string; readonly published_by_user_id: string | null }>();
    expect(templateDraftRow).toEqual({ status: 'published', published_by_user_id: userId });
    const templateOperationCounts = await env.DB.prepare(`SELECT operation_name,
      count(*) AS count FROM operation_log
      WHERE workspace_id = ? AND operation_name LIKE 'template.artifact.%'
      GROUP BY operation_name ORDER BY operation_name`)
      .bind(workspaceId).all<{ readonly operation_name: string; readonly count: number }>();
    expect(templateOperationCounts.results).toEqual([
      { operation_name: 'template.artifact.change', count: 2 },
      { operation_name: 'template.artifact.change.draft', count: 2 }
    ]);

    const overview = await handleRequest(
      new Request(`${baseUrl}/api/workspace/overview`, { headers }),
      environment()
    );
    expect(overview.status, await overview.clone().text()).toBe(200);
    const overviewBody = await overview.json<{
      readonly kind: string;
      readonly data: {
        readonly event: { readonly kind: string; readonly event?: { readonly id: string } };
        readonly areas: readonly {
          readonly area: string;
          readonly status: string;
          readonly availableCapabilities?: readonly string[];
          readonly reason?: string;
        }[];
        readonly metrics: { readonly operations: { readonly kind: string; readonly total: number } };
        readonly history: { readonly total: number; readonly truncated: boolean };
      };
    }>();
    const finalOperationCount = await env.DB.prepare(`SELECT count(*) AS count
      FROM operation_log WHERE workspace_id = ? AND (
        event_id = ? OR (operation_name = 'event.create'
          AND json_extract(result_json,'$.data.event.id') = ?)
      )`).bind(workspaceId, firstBody.data.event.id, firstBody.data.event.id)
      .first<{ readonly count: number }>();
    expect(overviewBody.kind).toBe('success');
    expect(overviewBody.data.event).toMatchObject({
      kind: 'current_event', event: { id: firstBody.data.event.id }
    });
    expect(overviewBody.data.areas.find((area) => area.area === 'submissions')).toEqual({
      area: 'submissions', status: 'unavailable', reason: 'not_composed'
    });
    expect(overviewBody.data.areas.find((area) => area.area === 'templates')).toMatchObject({
      area: 'templates',
      status: 'partial',
      availableCapabilities: [
        'template.artifact.change',
        'template.artifact.change.draft',
        'template.artifact.get',
        'template.artifact.list'
      ]
    });
    expect(overviewBody.data.metrics.operations).toEqual({
      kind: 'exact', total: finalOperationCount?.count
    });
    expect(overviewBody.data.history).toMatchObject({
      total: finalOperationCount?.count, truncated: true
    });

    const eventHistory = await handleRequest(
      new Request(`${baseUrl}/api/workspace/history?view=event&limit=3`, { headers }),
      environment()
    );
    expect(eventHistory.status, await eventHistory.clone().text()).toBe(200);
    const eventHistoryBody = await eventHistory.json<{
      readonly kind: string;
      readonly data: {
        readonly scope: string;
        readonly entries: ReadonlyArray<{
          readonly id: string;
          readonly operation: { readonly name: string };
          readonly scope: { readonly eventId?: string };
        }>;
        readonly next: { readonly occurredAt: string; readonly id: string };
      };
    }>();
    expect(eventHistoryBody).toMatchObject({ kind: 'success', data: { scope: 'event' } });
    expect(eventHistoryBody.data.entries).toHaveLength(3);
    expect(eventHistoryBody.data.entries.every(
      (entry) => entry.scope.eventId === firstBody.data.event.id
    )).toBe(true);
    expect(eventHistoryBody.data.next).toBeDefined();
    const nextEventHistory = await handleRequest(
      new Request(`${baseUrl}/api/workspace/history?view=event&limit=100&beforeOccurredAt=${encodeURIComponent(eventHistoryBody.data.next.occurredAt)}&beforeId=${eventHistoryBody.data.next.id}`, { headers }),
      environment()
    );
    expect(nextEventHistory.status, await nextEventHistory.clone().text()).toBe(200);
    const nextEventHistoryBody = await nextEventHistory.json<{
      readonly kind: string;
      readonly data: { readonly entries: readonly { readonly operation: { readonly name: string } }[] };
    }>();
    expect(nextEventHistoryBody.data.entries.some(
      (entry) => entry.operation.name === 'event.create'
    )).toBe(true);
    const workspaceHistory = await handleRequest(
      new Request(`${baseUrl}/api/workspace/history?view=workspace&limit=100`, { headers }),
      environment()
    );
    expect(workspaceHistory.status, await workspaceHistory.clone().text()).toBe(200);
    expect(await workspaceHistory.json()).toMatchObject({
      kind: 'success', data: { scope: 'workspace' }
    });

    const freshEvent = await handleRequest(new Request(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: {
        cookie: headers.cookie,
        origin: baseUrl,
        'content-type': 'application/json',
        'idempotency-key': 'd1-application-create-fresh-vocabulary-event'
      },
      body: JSON.stringify({
        expectedEventSetVersion: 2,
        name: 'Fresh Vocabulary Summit',
        timezone: 'Asia/Singapore',
        startDate: '2027-04-10',
        endDate: '2027-04-11'
      })
    }), environment());
    expect(freshEvent.status, await freshEvent.clone().text()).toBe(200);
    const freshEventBody = await freshEvent.json<{
      readonly kind: string;
      readonly data: { readonly event: { readonly id: string } };
    }>();
    const firstVocabularyItem = await mutateVocabulary(
      'create',
      'd1-vocabulary-create-from-empty-set',
      { kind: 'room', expectedSetVersion: 1, name: 'Studio', capacity: 80 }
    );
    expect(firstVocabularyItem.status, await firstVocabularyItem.clone().text()).toBe(200);
    expect(await firstVocabularyItem.json()).toMatchObject({
      kind: 'success', data: { action: 'create', kind: 'room', setVersion: 2 }
    });
    const freshSet = await env.DB.prepare(`SELECT set_version
      FROM program_vocabulary_sets WHERE workspace_id = ? AND event_id = ?`)
      .bind(workspaceId, freshEventBody.data.event.id)
      .first<{ readonly set_version: number }>();
    expect(freshSet).toEqual({ set_version: 2 });
  }, 20_000);

  test('drafts, replays, and publishes a guarded Program Vocabulary merge over D1', async () => {
    const headers = { cookie: await cookie() };
    const current = await env.DB.prepare(`SELECT current_event_id FROM event_spine_workspace_sets
      WHERE workspace_id = ?`).bind(workspaceId)
      .first<{ readonly current_event_id: string }>();
    const eventId = current!.current_event_id;
    const source = await env.DB.prepare(`SELECT id,version FROM program_vocabulary_rooms
      WHERE workspace_id = ? AND event_id = ? AND name = 'Studio'`)
      .bind(workspaceId, eventId).first<{ readonly id: string; readonly version: number }>();
    const mutate = (path: string, key: string, body: unknown) => handleRequest(
      new Request(`${baseUrl}/api/events/current/program-vocabulary/${path}`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(body)
      }),
      environment()
    );
    const created = await mutate('create', 'd1-merge-target-create', {
      kind: 'room', expectedSetVersion: 2, name: 'Main Studio', capacity: 120
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json<{
      readonly data: { readonly affectedIds: readonly string[]; readonly setVersion: number };
    }>();
    const targetId = createdBody.data.affectedIds[0]!;
    const now = Date.now();
    const occurrenceId = uuid(799);
    const concurrentOccurrenceId = uuid(797);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO schedule_placement_sets
        (workspace_id,event_id,schedule_version,updated_by_user_id,updated_at_ms)
        VALUES (?,?,2,?,?)`).bind(workspaceId, eventId, userId, now),
      env.DB.prepare(`INSERT INTO schedule_occurrences
        (workspace_id,event_id,id,session_id,room_id,start_at_ms,end_at_ms,version,
         updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(workspaceId, eventId, occurrenceId, uuid(798), source!.id,
          Date.parse('2027-04-10T09:00:00.000Z'), Date.parse('2027-04-10T10:00:00.000Z'),
          1, userId, now),
      env.DB.prepare(`INSERT INTO schedule_occurrences
        (workspace_id,event_id,id,session_id,room_id,start_at_ms,end_at_ms,version,
         updated_by_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(workspaceId, eventId, concurrentOccurrenceId, uuid(796), source!.id,
          Date.parse('2027-04-10T10:00:00.000Z'), Date.parse('2027-04-10T11:00:00.000Z'),
          1, userId, now)
    ]);
    const draftInput = {
      kind: 'room', sourceId: source!.id, targetId,
      expectedSetVersion: createdBody.data.setVersion,
      expectedSourceVersion: source!.version,
      expectedTargetVersion: 1
    } as const;
    const draft = await mutate('merge/draft', 'd1-vocabulary-merge-draft', draftInput);
    expect(draft.status, await draft.clone().text()).toBe(200);
    const draftBody = await draft.json<{
      readonly kind: string;
      readonly data: {
        readonly draftId: string;
        readonly revision: { readonly id: string; readonly digestSha256: string };
        readonly safeDiff: { readonly liveRepoints: number };
      };
    }>();
    expect(draftBody).toMatchObject({
      kind: 'success',
      data: { status: 'draft', safeDiff: { liveRepoints: 2 } }
    });
    const draftReplay = await mutate('merge/draft', 'd1-vocabulary-merge-draft', draftInput);
    expect(await draftReplay.json()).toEqual(draftBody);
    const changedDraft = await mutate('merge/draft', 'd1-vocabulary-merge-draft', {
      ...draftInput, expectedTargetVersion: 2
    });
    expect(await changedDraft.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });

    const stalePublishInput = {
      draftId: draftBody.data.draftId,
      revisionId: draftBody.data.revision.id,
      revisionDigestSha256: draftBody.data.revision.digestSha256
    };
    await env.DB.batch([
      env.DB.prepare(`UPDATE schedule_occurrences SET room_id = ?,version = 2,
        updated_by_user_id = ?,updated_at_ms = ?
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND room_id = ? AND version = 1`)
        .bind(targetId, userId, now + 1, workspaceId, eventId, concurrentOccurrenceId, source!.id),
      env.DB.prepare(`UPDATE schedule_placement_sets SET schedule_version = 3,
        updated_by_user_id = ?,updated_at_ms = ?
        WHERE workspace_id = ? AND event_id = ? AND schedule_version = 2`)
        .bind(userId, now + 1, workspaceId, eventId)
    ]);
    const stalePublish = await mutate(
      'merge', 'd1-vocabulary-merge-stale-publish', stalePublishInput
    );
    expect(await stalePublish.json()).toMatchObject({
      kind: 'outcome', outcome: {
        class: 'stale_revision', kind: 'program_vocabulary.changed',
        detail: { code: 'stale_reference', action: 'merge', kind: 'room' }
      }
    });
    const sourceAfterStalePublish = await env.DB.prepare(`SELECT status,version
      FROM program_vocabulary_rooms WHERE workspace_id = ? AND event_id = ? AND id = ?`)
      .bind(workspaceId, eventId, source!.id).first();
    expect(sourceAfterStalePublish).toEqual({ status: 'active', version: 1 });

    const refreshedDraft = await mutate(
      'merge/draft', 'd1-vocabulary-merge-refreshed-draft', draftInput
    );
    expect(refreshedDraft.status, await refreshedDraft.clone().text()).toBe(200);
    const refreshedDraftBody = await refreshedDraft.json<typeof draftBody>();
    expect(refreshedDraftBody).toMatchObject({
      kind: 'success', data: { status: 'draft', safeDiff: { liveRepoints: 1 } }
    });
    const publishInput = {
      draftId: refreshedDraftBody.data.draftId,
      revisionId: refreshedDraftBody.data.revision.id,
      revisionDigestSha256: refreshedDraftBody.data.revision.digestSha256
    };
    const published = await mutate('merge', 'd1-vocabulary-merge-publish', publishInput);
    expect(published.status, await published.clone().text()).toBe(200);
    const publishedBody = await published.json();
    expect(publishedBody).toMatchObject({
      kind: 'success',
      data: { action: 'merge', kind: 'room', affectedIds: [source!.id, targetId],
        setVersion: 4, liveRepoints: 1 }
    });
    const publishReplay = await mutate('merge', 'd1-vocabulary-merge-publish', publishInput);
    expect(await publishReplay.json()).toEqual(publishedBody);
    const changedPublishedDraft = await mutate(
      'merge', 'd1-vocabulary-merge-published-draft-changed', publishInput
    );
    expect(await changedPublishedDraft.json()).toMatchObject({
      kind: 'outcome', outcome: {
        class: 'conflict', kind: 'program_vocabulary.merge_draft_changed'
      }
    });
    const rows = await env.DB.batch([
      env.DB.prepare(`SELECT status,version FROM program_vocabulary_rooms
        WHERE workspace_id = ? AND event_id = ? AND id = ?`).bind(workspaceId, eventId, source!.id),
      env.DB.prepare(`SELECT room_id,version FROM schedule_occurrences
        WHERE workspace_id = ? AND event_id = ? AND id = ?`).bind(workspaceId, eventId, occurrenceId),
      env.DB.prepare(`SELECT schedule_version FROM schedule_placement_sets
        WHERE workspace_id = ? AND event_id = ?`).bind(workspaceId, eventId),
      env.DB.prepare(`SELECT status FROM program_vocabulary_merge_drafts
        WHERE workspace_id = ? AND event_id = ? AND id = ?`)
        .bind(workspaceId, eventId, refreshedDraftBody.data.draftId),
      env.DB.prepare(`SELECT room_id,version FROM schedule_occurrences
        WHERE workspace_id = ? AND event_id = ? AND id = ?`)
        .bind(workspaceId, eventId, concurrentOccurrenceId),
      env.DB.prepare(`SELECT status FROM program_vocabulary_merge_drafts
        WHERE workspace_id = ? AND event_id = ? AND id = ?`)
        .bind(workspaceId, eventId, draftBody.data.draftId)
    ]);
    expect(rows[0]!.results[0]).toEqual({ status: 'retired', version: 2 });
    expect(rows[1]!.results[0]).toEqual({ room_id: targetId, version: 2 });
    expect(rows[2]!.results[0]).toEqual({ schedule_version: 4 });
    expect(rows[3]!.results[0]).toEqual({ status: 'published' });
    expect(rows[4]!.results[0]).toEqual({ room_id: targetId, version: 2 });
    expect(rows[5]!.results[0]).toEqual({ status: 'draft' });

    const createItem = async (key: string, body: unknown) => {
      const response = await mutate('create', key, body);
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json<{
        readonly data: { readonly affectedIds: readonly string[]; readonly setVersion: number };
      }>();
    };
    const format = await createItem('d1-merge-session-format', {
      kind: 'format', expectedSetVersion: 4, name: 'Roundtable'
    });
    const sourceTrack = await createItem('d1-merge-session-source-track', {
      kind: 'track', expectedSetVersion: 5, name: 'Foundations'
    });
    const targetTrack = await createItem('d1-merge-session-target-track', {
      kind: 'track', expectedSetVersion: 6, name: 'Platform'
    });
    const catalogResponse = await handleRequest(
      new Request(`${baseUrl}/api/events/current/sessions`, { headers }), environment()
    );
    const catalog = await catalogResponse.json<{
      readonly data: { readonly version: number; readonly digestSha256: string };
    }>();
    const sessionResponse = await handleRequest(
      new Request(`${baseUrl}/api/events/current/sessions`, {
        method: 'POST',
        headers: {
          cookie: headers.cookie, origin: baseUrl, 'content-type': 'application/json',
          'idempotency-key': 'd1-merge-session-create'
        },
        body: JSON.stringify({
          action: 'create', expectedCatalogVersion: catalog.data.version,
          expectedCatalogDigestSha256: catalog.data.digestSha256,
          title: 'Merge-linked Session', plannedDurationMinutes: 45, lifecycle: 'draft',
          formatId: format.data.affectedIds[0], trackId: sourceTrack.data.affectedIds[0]
        })
      }),
      environment()
    );
    expect(sessionResponse.status, await sessionResponse.clone().text()).toBe(200);
    const sessionBody = await sessionResponse.json<{
      readonly data: { readonly session: { readonly id: string } };
    }>();
    const trackDraftInput = {
      kind: 'track', sourceId: sourceTrack.data.affectedIds[0],
      targetId: targetTrack.data.affectedIds[0], expectedSetVersion: 7,
      expectedSourceVersion: 1, expectedTargetVersion: 1
    } as const;
    const trackDraftResponse = await mutate(
      'merge/draft', 'd1-vocabulary-session-merge-draft', trackDraftInput
    );
    expect(trackDraftResponse.status, await trackDraftResponse.clone().text()).toBe(200);
    const trackDraft = await trackDraftResponse.json<{
      readonly data: {
        readonly draftId: string;
        readonly revision: { readonly id: string; readonly digestSha256: string };
        readonly safeDiff: { readonly liveRepoints: number };
      };
    }>();
    expect(trackDraft.data.safeDiff.liveRepoints).toBe(1);
    const trackPublish = await mutate('merge', 'd1-vocabulary-session-merge-publish', {
      draftId: trackDraft.data.draftId,
      revisionId: trackDraft.data.revision.id,
      revisionDigestSha256: trackDraft.data.revision.digestSha256
    });
    expect(trackPublish.status, await trackPublish.clone().text()).toBe(200);
    expect(await trackPublish.json()).toMatchObject({
      kind: 'success', data: { action: 'merge', kind: 'track', setVersion: 8, liveRepoints: 1 }
    });
    const repointedSession = await env.DB.prepare(`SELECT track_id,version,head_json
      FROM sessions WHERE workspace_id = ? AND event_id = ? AND id = ?`)
      .bind(workspaceId, eventId, sessionBody.data.session.id)
      .first<{ readonly track_id: string; readonly version: number; readonly head_json: string }>();
    expect(repointedSession).toMatchObject({
      track_id: targetTrack.data.affectedIds[0], version: 2
    });
    expect(JSON.parse(repointedSession!.head_json)).toMatchObject({
      programTarget: { setVersion: 8, track: { id: targetTrack.data.affectedIds[0] } }
    });
    const repointedSessionSlot = await env.DB.prepare(`SELECT item_id,version
      FROM session_program_reference_slots
      WHERE workspace_id = ? AND event_id = ? AND session_id = ? AND slot_kind = 'track'`)
      .bind(workspaceId, eventId, sessionBody.data.session.id).first();
    expect(repointedSessionSlot).toEqual({ item_id: targetTrack.data.affectedIds[0], version: 2 });
  }, 20_000);

  test('runs all organizer Files commands and the R2 byte handoff over one current Event', async () => {
    const headers = { cookie: await cookie() };
    const current = await env.DB.prepare(`SELECT current_event_id FROM event_spine_workspace_sets
      WHERE workspace_id = ?`).bind(workspaceId)
      .first<{ readonly current_event_id: string }>();
    const eventId = current!.current_event_id;
    const session = await env.DB.prepare(`SELECT id FROM sessions
      WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY LIMIT 1`)
      .bind(workspaceId, eventId).first<{ readonly id: string }>();
    const engagementId = uuid(880);
    const engagementHead = canonicalJsonText({
      id: engagementId,
      sessionId: session!.id,
      personId: userId,
      submissionId: null,
      state: 'confirmed',
      version: 1,
      seededByDecision: null
    });
    await env.DB.prepare(`INSERT INTO engagement_heads (
      workspace_id,event_id,id,session_id,person_id,submission_id,state,version,
      head_json,invited_at_ms,cancelled_at_ms
    ) VALUES (?,?,?,?,?,NULL,'confirmed',1,?,?,NULL)`)
      .bind(workspaceId, eventId, engagementId, session!.id, userId,
        engagementHead, Date.now()).run();

    const mutate = async (path: string, key: string, body: unknown) => {
      const response = await handleRequest(new Request(
        `${baseUrl}/api/events/current/files/${path}`,
        {
          method: 'POST',
          headers: {
            cookie: headers.cookie,
            origin: baseUrl,
            'content-type': 'application/json',
            'idempotency-key': key
          },
          body: JSON.stringify(body)
        }
      ), environment());
      expect(response.status, await response.clone().text()).toBe(200);
      const result = await response.json<{ readonly kind: string; readonly data?: unknown }>();
      expect(result.kind).toBe('success');
      return result;
    };

    const shareId = uuid(881);
    await mutate('shares/create', 'd1-files-share-create', {
      resourceShareId: shareId,
      title: 'Speaker pack',
      audience: { kind: 'all_confirmed' }
    });
    const fulfillmentAttachmentId = uuid(882);
    await mutate('attachments/link', 'd1-files-link-attach', {
      attachmentId: fulfillmentAttachmentId,
      subject: { kind: 'engagement', engagementId },
      link: { provider: 'drive', label: 'Slides', url: 'https://drive.example.invalid/slides' }
    });
    const withdrawnRequestId = uuid(883);
    await mutate('requests/create', 'd1-files-request-create-withdraw', {
      requestId: withdrawnRequestId,
      engagementId,
      what: 'Backup slides',
      instructions: null,
      deadlineId: null
    });
    await mutate('requests/withdraw', 'd1-files-request-withdraw', {
      requestId: withdrawnRequestId,
      expectedVersion: 1
    });
    const fulfilledRequestId = uuid(884);
    await mutate('requests/create', 'd1-files-request-create-fulfill', {
      requestId: fulfilledRequestId,
      engagementId,
      what: 'Final slides',
      instructions: 'Use the approved deck.',
      deadlineId: null
    });
    await mutate('requests/fulfill', 'd1-files-request-fulfill', {
      requestId: fulfilledRequestId,
      attachmentId: fulfillmentAttachmentId,
      expectedVersion: 1
    });
    await mutate('shares/revoke', 'd1-files-share-revoke', {
      resourceShareId: shareId,
      expectedVersion: 1
    });

    const intentId = uuid(885);
    const assetId = uuid(886);
    const assetAttachmentId = uuid(887);
    const bytes = new TextEncoder().encode('%PDF-1.7\nJooEvents D1 R2 rehearsal\n%%EOF\n');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    await mutate('uploads/intent', 'd1-files-upload-intent', {
      intentId,
      purpose: 'session_material',
      displayFilename: 'speaker-notes.pdf',
      contentType: 'application/pdf',
      declaredByteSize: bytes.byteLength
    });
    const uploaded = await handleRequest(new Request(
      `${baseUrl}/api/events/current/files/uploads/${intentId}/bytes`,
      {
        method: 'PUT',
        headers: { cookie: headers.cookie, origin: baseUrl, 'content-type': 'application/pdf' },
        body: bytes
      }
    ), environment());
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    expect(await uploaded.json()).toMatchObject({
      kind: 'stored', intent: { id: intentId, byteSize: bytes.byteLength, sha256: digest }
    });
    await mutate('uploads/confirm', 'd1-files-upload-confirm', {
      intentId,
      assetId,
      sha256: digest
    });
    await mutate('attachments/attach', 'd1-files-asset-attach', {
      attachmentId: assetAttachmentId,
      subject: { kind: 'session', sessionId: session!.id },
      assetId
    });
    await mutate('attachments/detach', 'd1-files-asset-detach', {
      attachmentId: assetAttachmentId,
      expectedVersion: 1
    });

    const replay = await mutate('uploads/confirm', 'd1-files-upload-confirm', {
      intentId,
      assetId,
      sha256: digest
    });
    expect(replay.kind).toBe('success');
    const object = await env.FILES.get(`files/${workspaceId}/${eventId}/${intentId}`);
    expect(object?.size).toBe(bytes.byteLength);
    const rows = await env.DB.batch([
      env.DB.prepare(`SELECT state,stored_byte_size,stored_sha256 FROM file_upload_intents
        WHERE workspace_id = ? AND event_id = ? AND id = ?`).bind(workspaceId, eventId, intentId),
      env.DB.prepare(`SELECT lifecycle,sha256 FROM file_assets
        WHERE workspace_id = ? AND event_id = ? AND id = ?`).bind(workspaceId, eventId, assetId),
      env.DB.prepare(`SELECT state,version FROM file_attachments
        WHERE workspace_id = ? AND event_id = ? AND id = ?`)
        .bind(workspaceId, eventId, assetAttachmentId),
      env.DB.prepare(`SELECT state,version FROM file_requests
        WHERE workspace_id = ? AND event_id = ? AND id = ?`)
        .bind(workspaceId, eventId, fulfilledRequestId),
      env.DB.prepare(`SELECT count(*) AS count FROM operation_log
        WHERE workspace_id = ? AND event_id = ? AND operation_name LIKE 'file.%'`)
        .bind(workspaceId, eventId)
    ]);
    expect(rows[0]!.results[0]).toEqual({
      state: 'confirmed', stored_byte_size: bytes.byteLength, stored_sha256: digest
    });
    expect(rows[1]!.results[0]).toEqual({ lifecycle: 'available', sha256: digest });
    expect(rows[2]!.results[0]).toEqual({ state: 'detached', version: 2 });
    expect(rows[3]!.results[0]).toEqual({ state: 'fulfilled', version: 2 });
    expect(rows[4]!.results[0]).toEqual({ count: 11 });

    const racedIntentId = uuid(891);
    const racedBytes = [
      new TextEncoder().encode('%PDF-1.7\nRACE-A\n%%EOF\n'),
      new TextEncoder().encode('%PDF-1.7\nRACE-B\n%%EOF\n')
    ] as const;
    expect(racedBytes[0].byteLength).toBe(racedBytes[1].byteLength);
    await mutate('uploads/intent', 'd1-files-raced-upload-intent', {
      intentId: racedIntentId,
      purpose: 'session_material',
      displayFilename: 'raced.pdf',
      contentType: 'application/pdf',
      declaredByteSize: racedBytes[0].byteLength
    });
    const racedResponses = await Promise.all(racedBytes.map((body) => handleRequest(new Request(
      `${baseUrl}/api/events/current/files/uploads/${racedIntentId}/bytes`,
      {
        method: 'PUT',
        headers: { cookie: headers.cookie, origin: baseUrl, 'content-type': 'application/pdf' },
        body
      }
    ), environment())));
    expect(racedResponses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winnerIndex = racedResponses.findIndex((response) => response.status === 200);
    const loserIndex = racedResponses.findIndex((response) => response.status === 409);
    expect(await racedResponses[loserIndex]!.json()).toEqual({
      kind: 'refused', code: 'upload_in_progress'
    });
    const winnerBody = await racedResponses[winnerIndex]!.json<{
      readonly intent: { readonly sha256: string };
    }>();
    const racedObject = await env.FILES.get(`files/${workspaceId}/${eventId}/${racedIntentId}`);
    expect(racedObject).not.toBeNull();
    const racedObjectBytes = new Uint8Array(await racedObject!.arrayBuffer());
    const racedObjectDigest = [...new Uint8Array(
      await crypto.subtle.digest('SHA-256', racedObjectBytes)
    )].map((value) => value.toString(16).padStart(2, '0')).join('');
    expect(racedObjectDigest).toBe(winnerBody.intent.sha256);
    expect(racedObjectBytes).toEqual(racedBytes[winnerIndex]);
    const racedAttempts = await env.DB.prepare(`SELECT state,stored_sha256 FROM
      d1_file_upload_transfer_attempts
      WHERE workspace_id = ? AND event_id = ? AND intent_id = ?`)
      .bind(workspaceId, eventId, racedIntentId).all();
    expect(racedAttempts.results).toEqual([{
      state: 'stored', stored_sha256: winnerBody.intent.sha256
    }]);

    const retryIntentId = uuid(892);
    await mutate('uploads/intent', 'd1-files-retry-upload-intent', {
      intentId: retryIntentId,
      purpose: 'session_material',
      displayFilename: 'retry.pdf',
      contentType: 'application/pdf',
      declaredByteSize: bytes.byteLength
    });
    const oversized = new Uint8Array(bytes.byteLength + 1);
    oversized.set(bytes);
    oversized[oversized.length - 1] = 0x21;
    const refusedAttempt = await handleRequest(new Request(
      `${baseUrl}/api/events/current/files/uploads/${retryIntentId}/bytes`,
      {
        method: 'PUT',
        headers: { cookie: headers.cookie, origin: baseUrl, 'content-type': 'application/pdf' },
        body: oversized
      }
    ), environment());
    expect(refusedAttempt.status).toBe(413);
    expect(await refusedAttempt.json()).toEqual({ kind: 'refused', code: 'byte_cap_exceeded' });
    const retriedAttempt = await handleRequest(new Request(
      `${baseUrl}/api/events/current/files/uploads/${retryIntentId}/bytes`,
      {
        method: 'PUT',
        headers: { cookie: headers.cookie, origin: baseUrl, 'content-type': 'application/pdf' },
        body: bytes
      }
    ), environment());
    expect(retriedAttempt.status, await retriedAttempt.clone().text()).toBe(200);
    const retryAttempts = await env.DB.prepare(`SELECT state FROM
      d1_file_upload_transfer_attempts
      WHERE workspace_id = ? AND event_id = ? AND intent_id = ?
      ORDER BY started_at_ms,attempt_id`)
      .bind(workspaceId, eventId, retryIntentId).all();
    expect(retryAttempts.results.map((row) => row.state).sort()).toEqual([
      'safe_refusal', 'stored'
    ]);

    const cleanupNow = Date.now();
    const oldInstant = new Date(cleanupNow - 8 * 24 * 60 * 60 * 1_000).toISOString();
    const expiredInstant = new Date(cleanupNow - 1_000).toISOString();
    const cleanupIntentId = uuid(888);
    const cleanupIntentKey = `files/${workspaceId}/${eventId}/${cleanupIntentId}`;
    const cleanupIntent = {
      schemaVersion: 1,
      id: cleanupIntentId,
      scope: { workspaceId, eventId },
      uploader: { kind: 'operator_user', userId },
      purpose: 'session_material',
      displayFilename: 'abandoned.pdf',
      contentType: 'application/pdf',
      declaredByteSize: bytes.byteLength,
      maximumByteSize: 262_144_000,
      storageProvider: 'cloudflare-r2',
      storageKey: cleanupIntentKey,
      state: 'stored',
      storedByteSize: bytes.byteLength,
      storedSha256: digest,
      createdAt: oldInstant,
      expiresAt: expiredInstant
    } as const;
    const orphanAssetId = uuid(889);
    const orphanAssetKey = `files/${workspaceId}/${eventId}/${orphanAssetId}`;
    const orphanAsset = {
      schemaVersion: 1,
      id: orphanAssetId,
      scope: { workspaceId, eventId },
      uploader: { kind: 'operator_user', userId },
      purpose: 'session_material',
      displayFilename: 'orphan.pdf',
      contentType: 'application/pdf',
      byteSize: bytes.byteLength,
      sha256: digest,
      storageProvider: 'cloudflare-r2',
      storageKey: orphanAssetKey,
      lifecycle: 'available',
      scan: { provider: 'none', verdict: 'released', checkedAt: oldInstant },
      version: 1,
      createdAt: oldInstant,
      updatedAt: oldInstant
    } as const;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO file_upload_intents (
        workspace_id,event_id,id,uploader_kind,uploader_id,purpose,content_type,
        declared_byte_size,maximum_byte_size,storage_provider,storage_key,state,
        stored_byte_size,stored_sha256,head_json,created_at_ms,expires_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        workspaceId, eventId, cleanupIntentId, 'operator_user', userId,
        cleanupIntent.purpose, cleanupIntent.contentType, cleanupIntent.declaredByteSize,
        cleanupIntent.maximumByteSize, cleanupIntent.storageProvider, cleanupIntentKey,
        cleanupIntent.state, cleanupIntent.storedByteSize, digest,
        canonicalJsonText(cleanupIntent), Date.parse(oldInstant), Date.parse(expiredInstant)
      ),
      env.DB.prepare(`INSERT INTO file_assets (
        workspace_id,event_id,id,uploader_kind,uploader_id,purpose,display_filename,
        content_type,byte_size,sha256,storage_provider,storage_key,lifecycle,
        scan_provider,scan_verdict,scan_checked_at_ms,version,head_json,created_at_ms,updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        workspaceId, eventId, orphanAssetId, 'operator_user', userId,
        orphanAsset.purpose, orphanAsset.displayFilename, orphanAsset.contentType,
        orphanAsset.byteSize, digest, orphanAsset.storageProvider, orphanAssetKey,
        orphanAsset.lifecycle, orphanAsset.scan.provider, orphanAsset.scan.verdict,
        Date.parse(oldInstant), 1, canonicalJsonText(orphanAsset),
        Date.parse(oldInstant), Date.parse(oldInstant)
      )
    ]);
    const strandedKey = `files/${workspaceId}/${eventId}/${uuid(890)}`;
    await Promise.all([
      env.FILES.put(cleanupIntentKey, bytes),
      env.FILES.put(orphanAssetKey, bytes),
      env.FILES.put(strandedKey, bytes)
    ]);
    const cleanup = await dispatchD1FilesCleanupWake(environment(), {
      workspaceId: parseWorkspaceId(workspaceId),
      nowMs: cleanupNow
    });
    expect(cleanup).toMatchObject({
      expiredIntents: 1,
      orphanAssets: 1,
      reconciledObjects: 1,
      faults: []
    });
    const cleanedIntent = await env.DB.prepare(`SELECT state FROM file_upload_intents
      WHERE workspace_id = ? AND event_id = ? AND id = ?`)
      .bind(workspaceId, eventId, cleanupIntentId).first();
    const cleanedAsset = await env.DB.prepare(`SELECT id FROM file_assets
      WHERE workspace_id = ? AND event_id = ? AND id = ?`)
      .bind(workspaceId, eventId, orphanAssetId).first();
    expect(cleanedIntent).toEqual({ state: 'discarded' });
    expect(cleanedAsset).toBeNull();
    expect(await env.FILES.head(cleanupIntentKey)).toBeNull();
    expect(await env.FILES.head(orphanAssetKey)).toBeNull();
    expect(await env.FILES.head(strandedKey)).toBeNull();
  }, 30_000);

  test('keeps the application slice closed when activation or a durable key duty is incomplete', async () => {
    const headers = { cookie: await cookie() };
    const disabled = await handleRequest(
      new Request(`${baseUrl}/api/events/current`, { headers }),
      { ...environment(), JOOEVENTS_APPLICATION_RUNTIME_ENABLED: 'false' }
    );
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ code: 'cloudflare_application_runtime_not_ready' });

    const invalid = await handleRequest(
      new Request(`${baseUrl}/api/events/current`, { headers }),
      { ...environment(), JOOEVENTS_REQUEST_HASH_KEYS: 'invalid' }
    );
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toMatchObject({
      code: 'cloudflare_application_configuration_invalid'
    });
  });
});
