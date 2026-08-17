import { env } from 'cloudflare:workers';
import { makeSignature } from 'better-auth/crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import { handleRequest, type CloudflareApplicationEnvironment } from '../src/index';

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
    env.DB.prepare(`INSERT INTO role_assignments
      (id,user_id,role_id,workspace_id,scope_kind,event_id,assigned_by_user_id,
       assigned_at,expires_at,version)
      VALUES (?,?,?,?,'workspace',NULL,?,?,NULL,1)`)
      .bind(uuid(707), userId, roleId, workspaceId, userId, now)
  ]);
});

function environment(): CloudflareApplicationEnvironment {
  return {
    DB: env.DB,
    FILES: env.FILES,
    JOBS: env.JOBS,
    ASSETS: env.ASSETS,
    JOOEVENTS_DEPLOYMENT_ENVIRONMENT: env.JOOEVENTS_DEPLOYMENT_ENVIRONMENT,
    JOOEVENTS_D1_RELEASE_FLOOR: env.JOOEVENTS_D1_RELEASE_FLOOR,
    JOOEVENTS_AUTH_RUNTIME_ENABLED: 'true',
    JOOEVENTS_APPLICATION_RUNTIME_ENABLED: 'true',
    JOOEVENTS_BASE_URL: baseUrl,
    JOOEVENTS_AUTH_SECRETS: `1:${secret}`,
    JOOEVENTS_REQUEST_HASH_KEYS: ring(0x31),
    JOOEVENTS_IDEMPOTENCY_KEYS: ring(0x32),
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: ring(0x33),
    JOOEVENTS_PERSISTENT_HMAC_KEYS: ring(0x34),
    JOOEVENTS_GOOGLE_CLIENT_ID: 'application-http-google-client-id',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'application-http-google-client-secret',
    JOOEVENTS_ADMISSION_MODE: 'pending',
    JOOEVENTS_WORKSPACE_ID: workspaceId
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
      'operation.history.list',
      'task.board.read',
      'task.mutation',
      'template.artifact.change',
      'template.artifact.change.draft',
      'template.artifact.get',
      'template.artifact.list',
      'workspace.api_key.list',
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
    expect(operationCount?.count).toBe(2);
    const logs = await env.DB.prepare('SELECT count(*) AS count FROM operation_log WHERE id = ?')
      .bind(firstBody.receipt.id).first<{ readonly count: number }>();
    expect(logs?.count).toBe(1);

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
      FROM operation_log WHERE workspace_id = ?`).bind(workspaceId)
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
      total: finalOperationCount?.count, truncated: false
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
  });

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
