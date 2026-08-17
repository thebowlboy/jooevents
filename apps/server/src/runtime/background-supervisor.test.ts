import { describe, expect, test } from 'bun:test';
import { createBackgroundSupervisor } from './background-supervisor';

describe('background supervisor', () => {
  test('starts explicitly, prevents overlap, and records bounded health', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const supervisor = createBackgroundSupervisor({
      jobs: [{
        name: 'outbound_dispatch', intervalMs: 60_000, runOnStart: true,
        run: async () => { calls += 1; await blocked; }
      }]
    });

    expect(supervisor.snapshot().state).toBe('not_started');
    const starting = supervisor.start();
    await Promise.resolve();
    expect(await supervisor.runNow('outbound_dispatch')).toBe(false);
    expect(calls).toBe(1);
    expect(supervisor.snapshot().jobs[0]).toMatchObject({ state: 'running', runs: 1 });
    release();
    await starting;
    expect(supervisor.snapshot().jobs[0]).toMatchObject({
      state: 'succeeded', runs: 1, consecutiveFailures: 0
    });
    await supervisor.close();
  });

  test('drains active work and coalesces close', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const supervisor = createBackgroundSupervisor({
      jobs: [{ name: 'files_gc', intervalMs: 60_000, run: () => blocked }]
    });
    await supervisor.start();
    const running = supervisor.runNow('files_gc');
    await Promise.resolve();
    const first = supervisor.close();
    expect(supervisor.close()).toBe(first);
    let closed = false;
    void first.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect(await running).toBe(true);
    await first;
    expect(supervisor.snapshot().state).toBe('closed');
  });

  test('contains faults and permits a later successful pass', async () => {
    let fail = true;
    const errors: string[] = [];
    const supervisor = createBackgroundSupervisor({
      jobs: [{
        name: 'expiry', intervalMs: 60_000,
        run: () => { if (fail) throw new Error('expired_intent_sweep_failed'); }
      }],
      onError: (name) => { errors.push(name); }
    });
    await supervisor.start();
    expect(await supervisor.runNow('expiry')).toBe(true);
    expect(supervisor.snapshot().jobs[0]).toMatchObject({
      state: 'failed', consecutiveFailures: 1, lastErrorCode: 'expired_intent_sweep_failed'
    });
    fail = false;
    expect(await supervisor.runNow('expiry')).toBe(true);
    expect(supervisor.snapshot().jobs[0]).toMatchObject({
      state: 'succeeded', consecutiveFailures: 0
    });
    expect(errors).toEqual(['expiry']);
    await supervisor.close();
  });
});
