import { expect } from 'bun:test';
import { canonicalJsonSha256 } from '@jooevents/kernel';
import { runJ2Spine } from './j2-spine.flow';
import type { FlowWorld } from './flow-world';

type Eligibility = {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly contractDigestSha256: string;
  readonly displayLabel: string;
  readonly consequences: readonly string[];
  readonly externalEffect: 'none' | 'reconcilable';
};
type PlanCatalog = { readonly registryDigestSha256: string; readonly operations: readonly Eligibility[] };
type Settings = {
  readonly eventId: string;
  readonly eventSetVersion: number;
  readonly eventVersion: number;
  readonly name: string;
  readonly timezone: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly location: string | null;
  readonly venueNote: string | null;
  readonly dayStart: string | null;
  readonly dayEnd: string | null;
  readonly slotMinutes: number | null;
};
type Vocabulary = { readonly setVersion: number };
type ActionStep = {
  readonly id: string;
  readonly operationName: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly terminalLogId: string | null;
};
type ActionRun = {
  readonly plan: { readonly batchId: string };
  readonly planDigestSha256: string;
  readonly status: string;
  readonly version: number;
  readonly currentOrdinal: number;
  readonly pauseRequested: boolean;
  readonly cancelRequested: boolean;
  readonly steps: readonly ActionStep[];
};

function required<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`J9 missing ${label}`);
  return value;
}

async function operatorControl(world: FlowWorld, path: string, body: unknown): Promise<ActionRun> {
  const response = await world.runtime.app.request(path, {
    method: 'POST',
    headers: {
      cookie: world.as('organizer').actor.cookie,
      origin: 'http://localhost:5176',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  expect(response.status, world.trace()).toBe(200);
  return await response.json() as ActionRun;
}

/** J9 — an approved frozen plan drives the same executor and leaves per-step receipts. */
export async function runJ9AgentActionRuns(world: FlowWorld): Promise<void> {
  const organizer = world.as('organizer');
  await runJ2Spine(world);
  let settings!: Settings;
  await organizer.expectRead('event.settings.current.read', (projection) => {
    settings = projection as Settings;
    return settings.eventId.length > 0;
  });
  let vocabulary!: Vocabulary;
  await organizer.expectRead('program_vocabulary.snapshot.read', (projection) => {
    vocabulary = projection as Vocabulary;
    return vocabulary.setVersion > 0;
  });
  const historyBefore = await world.history(organizer.actor);
  const support = world.support();
  const catalog = support.agentActionPlanCatalog() as PlanCatalog;
  const operation = (name: string) => required(
    catalog.operations.find((candidate) => candidate.operationName === name && candidate.operationVersion === 1), name
  );
  const subject = { type: 'event', id: settings.eventId };
  const step = (ordinal: number, action: Eligibility, input: unknown, guards: readonly unknown[]) => ({
    id: crypto.randomUUID(), ordinal, operationName: action.operationName, operationVersion: action.operationVersion,
    contractDigestSha256: action.contractDigestSha256, input, requestHashSha256: canonicalJsonSha256(input),
    guards, subjects: [subject], displayLabel: action.displayLabel,
    consequences: action.consequences, externalEffect: action.externalEffect
  });
  const vocabularyCreate = operation('program_vocabulary.create');
  const settingsUpdate = operation('event.settings.update');
  const programVersion = vocabulary.setVersion;
  const settingsInput = {
    expectedEventId: settings.eventId, expectedEventSetVersion: settings.eventSetVersion,
    expectedEventVersion: settings.eventVersion, name: settings.name, timezone: settings.timezone,
    startDate: settings.startDate, endDate: settings.endDate, location: settings.location,
    venueNote: 'Approved through an action run.', dayStart: settings.dayStart,
    dayEnd: settings.dayEnd, slotMinutes: settings.slotMinutes
  };
  const submittedAt = Date.now();
  const batchId = crypto.randomUUID();
  const submitted = support.submitAgentActionPlan({
    schemaVersion: 1, batchId,
    source: {
      surface: 'app_model', clientKey: 'test.flow-harness.j9', runId: 'j9-lease-run',
      proposingPrincipalId: 'model-profile.flow-harness'
    },
    scope: { workspaceId: world.runtime.workspaceId, eventId: settings.eventId, subjects: [subject] },
    intent: 'Add two program items and record an approved venue note.',
    registryDigestSha256: catalog.registryDigestSha256,
    bounds: {
      maximumActions: 4, expiresAt: new Date(submittedAt + 10 * 60_000).toISOString(),
      allowedOperationIdentities: ['program_vocabulary.create@1', 'event.settings.update@1']
    },
    steps: [
      step(1, vocabularyCreate, { kind: 'format', expectedSetVersion: programVersion, name: 'Agent format' }, [
        { kind: 'program_vocabulary_set_version', expected: programVersion }
      ]),
      step(2, settingsUpdate, settingsInput, [{ kind: 'event_version', expected: settings.eventVersion }]),
      step(3, vocabularyCreate, { kind: 'room', expectedSetVersion: programVersion + 1, name: 'Agent room', capacity: 120 }, [
        { kind: 'program_vocabulary_set_version', expected: programVersion + 1 }
      ]),
      step(4, vocabularyCreate, { kind: 'track', expectedSetVersion: programVersion + 2, name: 'Agent track' }, [
        { kind: 'program_vocabulary_set_version', expected: programVersion + 2 }
      ])
    ],
    submittedAt: new Date(submittedAt).toISOString()
  }) as ActionRun;
  expect(submitted.status).toBe('awaiting_approval');
  expect(submitted.planDigestSha256).toBe(canonicalJsonSha256((submitted as unknown as { readonly plan: unknown }).plan));
  expect(submitted.steps.map((entry) => entry.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
  expect(support.inspectAgentActionRun(batchId) as unknown as ActionRun).toEqual(submitted);

  const approved = await operatorControl(world, `/api/agent-actions/${batchId}/approve`, {
    batchId, expectedVersion: submitted.version, expectedPlanDigestSha256: submitted.planDigestSha256
  });
  expect(approved.status).toBe('queued');
  expect(approved.steps).toHaveLength(4);

  const firstAt = new Date(submittedAt + 1_000).toISOString();
  await expect(support.advanceAgentActionRun({
    batchId, workerId: 'j9-crash-worker', at: firstAt, crashAfterAtomicCommit: true
  })).rejects.toThrow('ephemeral_agent_action_crash_after_atomic_commit');
  const afterCrash = required(support.inspectAgentActionRun(batchId), 'crash projection') as unknown as ActionRun;
  const firstLogId = required(afterCrash.steps[0]?.terminalLogId, 'first terminal log');
  expect(afterCrash.steps[0]).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  expect(afterCrash.steps[1]).toMatchObject({ status: 'pending', attemptCount: 0 });

  const afterRecovery = await support.advanceAgentActionRun({
    batchId, workerId: 'j9-recovery-worker', at: new Date(submittedAt + 62_000).toISOString()
  }) as unknown as ActionRun;
  expect(afterRecovery.steps[0]).toMatchObject({ status: 'succeeded', attemptCount: 1, terminalLogId: firstLogId });
  expect(afterRecovery.steps[1]).toMatchObject({ status: 'succeeded', attemptCount: 1 });

  const pause = await operatorControl(world, `/api/agent-actions/${batchId}/pause`, {
    batchId, expectedVersion: afterRecovery.version
  });
  expect(pause.pauseRequested).toBe(true);
  const paused = await support.advanceAgentActionRun({
    batchId, workerId: 'j9-pause-worker', at: new Date(submittedAt + 124_000).toISOString()
  }) as unknown as ActionRun;
  expect(paused.status).toBe('paused');
  expect(paused.steps[2]).toMatchObject({ status: 'pending', attemptCount: 0 });

  const resumed = await operatorControl(world, `/api/agent-actions/${batchId}/resume`, {
    batchId, expectedVersion: paused.version
  });
  expect(resumed.status).toBe('queued');
  const afterResume = await support.advanceAgentActionRun({
    batchId, workerId: 'j9-resume-worker', at: new Date(submittedAt + 186_000).toISOString()
  }) as unknown as ActionRun;
  expect(afterResume.steps[2]).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  expect(afterResume.steps[3]).toMatchObject({ status: 'pending', attemptCount: 0 });

  const cancelled = await operatorControl(world, `/api/agent-actions/${batchId}/cancel`, {
    batchId, expectedVersion: afterResume.version
  });
  expect(cancelled.cancelRequested).toBe(true);
  const settled = await support.advanceAgentActionRun({
    batchId, workerId: 'j9-cancel-worker', at: new Date(submittedAt + 248_000).toISOString()
  }) as unknown as ActionRun;
  expect(settled.status).toBe('cancelled');
  expect(settled.steps[3]).toMatchObject({ status: 'cancelled', attemptCount: 0, terminalLogId: null });
  expect(support.inspectAgentActionRun(batchId) as unknown as ActionRun).toEqual(settled);

  const terminalIds = settled.steps.slice(0, 3).map((entry) => required(entry.terminalLogId, 'terminal step log'));
  expect(new Set(terminalIds).size).toBe(3);
  const historyAfter = await world.history(organizer.actor);
  expect(historyAfter.entries.filter((entry) => !historyBefore.entries.some((before) => before.id === entry.id))
    .filter((entry) => terminalIds.includes(String(entry.id))).map((entry) => String(entry.id)).sort()).toEqual([...terminalIds].sort());
  const summaries = new Map(historyAfter.entries.map((entry) => [String(entry.id), entry.summary]));
  expect(terminalIds.map((id) => summaries.get(id))).toEqual([
    'Created a format', 'Updated event settings', 'Created a room'
  ]);
}
