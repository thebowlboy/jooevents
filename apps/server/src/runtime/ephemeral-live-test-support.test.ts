import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  eventCreateOperationResultSchema,
  operationHistoryListResultSchema,
  workspaceTeamMembersReadResultSchema
} from '@jooevents/contracts';
import { canonicalJsonSha256 } from '@jooevents/kernel';
import { loadEphemeralLiveConfig } from '../config';
import { createEphemeralLiveRuntime, type EphemeralLiveRuntime } from './ephemeral-live';

const config = loadEphemeralLiveConfig({
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
  JOOEVENTS_GOOGLE_CLIENT_ID: 'flow-test-google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'flow-test-google-secret',
  JOOEVENTS_ADMISSION_MODE: 'reservation_only',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'flow-owner@jooevents.example',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'ignored-flow-test.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/ignored-flow-test'
});
const runtimes: EphemeralLiveRuntime[] = [];

function cleanupRetainedTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
      || !basename(path).startsWith('jooevents-ephemeral-runtime-')
      || dirname(path) !== realpathSync(dirname(path))) {
    throw new Error(`unsafe_flow_test_cleanup:${path}`);
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

describe('ephemeral live flow test support', () => {
  test('is structurally absent without dev fixtures', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    expect(runtime.testSupport).toBeUndefined();
  });

  test('admits actors, invokes the registered executor, and reads safe history', async () => {
    const runtime = await createEphemeralLiveRuntime({ config, devFixtures: true });
    runtimes.push(runtime);
    const support = runtime.testSupport;
    if (!support) throw new Error('ephemeral test support missing');
    expect(support.publicEffectBindings()).toEqual([{
      operationName: 'application.public.mutate',
      operationVersion: 1,
      method: 'POST',
      path: '/api/public/forms/application/mutate'
    }]);
    const { organizer, reviewer, secondOrganizer } = await support.bootstrapActors();
    expect(new Set([organizer.userId, reviewer.userId, secondOrganizer.userId]).size).toBe(3);
    const admittedInvitations = runtime.database.sqlite.query<{
      readonly normalized_email: string;
      readonly status: string;
    }, []>(`
      SELECT normalized_email, status FROM access_reservations
       WHERE created_by_user_id IS NOT NULL ORDER BY created_at, id
    `).all();
    expect(admittedInvitations).toHaveLength(2);
    expect(admittedInvitations.every((row) =>
      /^[a-f0-9]{64}$/.test(row.normalized_email) && row.status === 'consumed'
    )).toBe(true);
    expect(JSON.stringify(admittedInvitations)).not.toContain('@jooevents.example');

    const team = workspaceTeamMembersReadResultSchema.parse(await support.invokeRead({
      actor: organizer,
      operationName: 'workspace_team.members.read'
    }));
    expect(team.kind).toBe('success');
    if (team.kind !== 'success') throw new Error('team read refused');
    expect(team.data.members.filter((member) => member.status === 'active')).toHaveLength(3);

    const key = 'flow-event-create-key';
    const created = eventCreateOperationResultSchema.parse(await support.invokeEffect({
      actor: secondOrganizer,
      operationName: 'event.create',
      businessInput: {
        expectedEventSetVersion: 1,
        name: 'Flow Harness Event',
        timezone: 'Asia/Singapore',
        startDate: '2027-06-10',
        endDate: '2027-06-12'
      },
      idempotencyKey: key
    }));
    expect(created.kind).toBe('success');
    const replay = eventCreateOperationResultSchema.parse(await support.invokeEffect({
      actor: secondOrganizer,
      operationName: 'event.create',
      businessInput: {
        expectedEventSetVersion: 1,
        name: 'Flow Harness Event',
        timezone: 'Asia/Singapore',
        startDate: '2027-06-10',
        endDate: '2027-06-12'
      },
      idempotencyKey: key
    }));
    expect(replay).toEqual(created);

    const denied = await support.invokeEffect({
      actor: reviewer,
      operationName: 'workspace_team.invite',
      businessInput: {
        email: 'not-invited@jooevents.example',
        roleKey: 'viewer',
        expectedTeamVersion: team.data.version,
        expectedTeamDigestSha256: team.data.digestSha256
      },
      idempotencyKey: 'reviewer-cannot-invite'
    });
    expect(denied.kind).toBe('outcome');
    if (denied.kind !== 'outcome') throw new Error('reviewer invite unexpectedly succeeded');
    expect(denied.outcome.class).toBe('access_denied');

    const workspaceHistory = operationHistoryListResultSchema.parse(await support.invokeRead({
      actor: organizer,
      operationName: 'operation.history.list',
      businessInput: { view: 'workspace', limit: 20 }
    }));
    expect(workspaceHistory.kind).toBe('success');
    if (workspaceHistory.kind !== 'success') throw new Error('history read refused');
    expect(workspaceHistory.data.entries[0]?.summary).toBe('Created an event');
    expect(workspaceHistory.data.entries.some((entry) => entry.summary === 'Invited a teammate'))
      .toBe(true);
    expect(workspaceHistory.data.entries[0]?.actor.kind).toBe('workspace_user');
    expect(workspaceHistory.data.entries[0]?.actor.kind === 'workspace_user'
      ? String(workspaceHistory.data.entries[0].actor.userId) : undefined)
      .toBe(secondOrganizer.userId);

    const eventHistory = operationHistoryListResultSchema.parse(await support.invokeRead({
      actor: organizer,
      operationName: 'operation.history.list',
      businessInput: { view: 'event', limit: 20 }
    }));
    expect(eventHistory.kind).toBe('success');
    if (eventHistory.kind !== 'success') throw new Error('event history read refused');
    expect(eventHistory.data.entries.map((entry) => entry.summary)).toEqual(['Created an event']);

    const http = await runtime.app.request('/api/workspace/history?view=workspace&limit=20', {
      headers: { cookie: organizer.cookie }
    });
    expect(http.status).toBe(200);
    const httpHistory = operationHistoryListResultSchema.parse(await http.json());
    expect(httpHistory.kind).toBe('success');
    if (httpHistory.kind !== 'success') throw new Error('HTTP history read refused');
    expect(httpHistory.data).toEqual(workspaceHistory.data);
  });

  test('submits, approves, crash-replays, and projects a real leased action run', async () => {
    const runtime = await createEphemeralLiveRuntime({ config, devFixtures: true });
    runtimes.push(runtime);
    const support = runtime.testSupport;
    if (!support) throw new Error('ephemeral test support missing');
    const { organizer } = await support.bootstrapActors();
    const catalog = support.agentActionPlanCatalog();
    const operation = catalog.operations.find((candidate) =>
      candidate.operationName === 'event.create' && candidate.operationVersion === 1
    );
    if (!operation) throw new Error('event.create action eligibility missing');
    const submittedAtMs = Date.now();
    const batchId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const businessInput = {
      expectedEventSetVersion: 1,
      name: 'Action-run Event',
      timezone: 'Asia/Singapore',
      startDate: '2027-06-10',
      endDate: '2027-06-12'
    };
    const submitted = support.submitAgentActionPlan({
      schemaVersion: 1,
      batchId,
      source: {
        surface: 'app_model',
        clientKey: 'test.action-run',
        runId: 'test-action-run-1',
        proposingPrincipalId: 'model-profile.test-action-run'
      },
      scope: {
        workspaceId: runtime.workspaceId,
        subjects: [{ type: 'workspace', id: runtime.workspaceId }]
      },
      intent: 'Create the approved event.',
      registryDigestSha256: catalog.registryDigestSha256,
      bounds: {
        maximumActions: 1,
        expiresAt: new Date(submittedAtMs + 10 * 60_000).toISOString(),
        allowedOperationIdentities: ['event.create@1']
      },
      steps: [{
        id: stepId,
        ordinal: 1,
        operationName: operation.operationName,
        operationVersion: operation.operationVersion,
        contractDigestSha256: operation.contractDigestSha256,
        input: businessInput,
        requestHashSha256: canonicalJsonSha256(businessInput),
        guards: [{ kind: 'event_set_version', expected: 1 }],
        subjects: [{ type: 'workspace', id: runtime.workspaceId }],
        displayLabel: operation.displayLabel,
        consequences: operation.consequences,
        externalEffect: operation.externalEffect
      }],
      submittedAt: new Date(submittedAtMs).toISOString()
    });
    expect(submitted.status).toBe('awaiting_approval');
    const approvedResponse = await runtime.app.request(`/api/agent-actions/${batchId}/approve`, {
      method: 'POST',
      headers: {
        cookie: organizer.cookie,
        origin: config.baseUrl,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        batchId,
        expectedVersion: submitted.version,
        expectedPlanDigestSha256: submitted.planDigestSha256
      })
    });
    expect(approvedResponse.status).toBe(200);

    const firstAdvanceAt = new Date(submittedAtMs + 1_000).toISOString();
    await expect(support.advanceAgentActionRun({
      batchId,
      workerId: 'worker-crash',
      at: firstAdvanceAt,
      crashAfterAtomicCommit: true
    })).rejects.toThrow('ephemeral_agent_action_crash_after_atomic_commit');
    const afterCrash = support.inspectAgentActionRun(batchId);
    expect(afterCrash?.steps[0]).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(runtime.database.sqlite.query<{ readonly count: number }, []>(
      'SELECT count(*) AS count FROM events'
    ).get()?.count).toBe(1);
    expect(runtime.database.sqlite.query<{
      readonly action_batch_id: string | null;
      readonly action_step_id: string | null;
    }, []>(`SELECT action_batch_id,action_step_id FROM operation_log
      WHERE action_batch_id IS NOT NULL OR action_step_id IS NOT NULL`).all()).toEqual([{
      action_batch_id: batchId,
      action_step_id: stepId
    }]);

    const recovered = await support.advanceAgentActionRun({
      batchId,
      workerId: 'worker-recovery',
      at: new Date(submittedAtMs + 62_000).toISOString()
    });
    expect(recovered.status).toBe('succeeded');
    expect(recovered.steps[0]?.attemptCount).toBe(1);
    expect(support.inspectAgentActionRun(batchId)).toEqual(recovered);
    expect(runtime.database.sqlite.query<{ readonly count: number }, []>(
      'SELECT count(*) AS count FROM operation_log'
    ).get()?.count).toBe(3); // two actor invitations plus one action-run operation
  });
});
