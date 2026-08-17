export type BackgroundJobState = 'idle' | 'running' | 'succeeded' | 'failed';

export interface BackgroundJobSnapshot {
  readonly name: string;
  readonly state: BackgroundJobState;
  readonly runs: number;
  readonly consecutiveFailures: number;
  readonly lastStartedAt?: string;
  readonly lastFinishedAt?: string;
  readonly lastErrorCode?: string;
}

export interface BackgroundSupervisorSnapshot {
  readonly state: 'not_started' | 'running' | 'closed';
  readonly jobs: readonly BackgroundJobSnapshot[];
}

export interface BackgroundJobDefinition {
  readonly name: string;
  readonly intervalMs: number;
  readonly runOnStart?: boolean;
  run(): void | Promise<void>;
}

export interface BackgroundSupervisor {
  start(): Promise<void>;
  runNow(name: string): Promise<boolean>;
  snapshot(): BackgroundSupervisorSnapshot;
  close(): Promise<void>;
}

interface MutableJobState {
  state: BackgroundJobState;
  runs: number;
  consecutiveFailures: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastErrorCode?: string;
}

const SAFE_ERROR_CODE = /^[a-zA-Z0-9_.:-]{1,120}$/;

function errorCode(error: unknown): string {
  if (error instanceof Error && SAFE_ERROR_CODE.test(error.message)) return error.message;
  return 'background_job_failed';
}

/**
 * Owns finite, named runtime jobs. Jobs never overlap with themselves, faults
 * are retained as bounded codes, and close drains active work before returning.
 */
export function createBackgroundSupervisor(input: {
  readonly jobs: readonly BackgroundJobDefinition[];
  readonly now?: () => Date;
  readonly onError?: (jobName: string, error: unknown) => void;
}): BackgroundSupervisor {
  const now = input.now ?? (() => new Date());
  const definitions = new Map<string, BackgroundJobDefinition>();
  const states = new Map<string, MutableJobState>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const inFlight = new Map<string, Promise<void>>();
  let lifecycle: BackgroundSupervisorSnapshot['state'] = 'not_started';
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  for (const job of input.jobs) {
    if (!job.name || definitions.has(job.name)) {
      throw new TypeError(`background_job_name_invalid:${job.name}`);
    }
    if (!Number.isSafeInteger(job.intervalMs) || job.intervalMs <= 0) {
      throw new TypeError(`background_job_interval_invalid:${job.name}`);
    }
    definitions.set(job.name, job);
    states.set(job.name, { state: 'idle', runs: 0, consecutiveFailures: 0 });
  }

  const run = (name: string): Promise<boolean> => {
    if (lifecycle !== 'running') return Promise.resolve(false);
    const job = definitions.get(name);
    const state = states.get(name);
    if (!job || !state || inFlight.has(name)) return Promise.resolve(false);
    state.state = 'running';
    state.runs += 1;
    state.lastStartedAt = now().toISOString();
    const pass = Promise.resolve()
      .then(() => job.run())
      .then(() => {
        state.state = 'succeeded';
        state.consecutiveFailures = 0;
        delete state.lastErrorCode;
      })
      .catch((error) => {
        state.state = 'failed';
        state.consecutiveFailures += 1;
        state.lastErrorCode = errorCode(error);
        input.onError?.(name, error);
      })
      .finally(() => {
        state.lastFinishedAt = now().toISOString();
        if (inFlight.get(name) === pass) inFlight.delete(name);
      });
    inFlight.set(name, pass);
    return pass.then(() => true);
  };

  const start = (): Promise<void> => {
    if (startPromise) return startPromise;
    if (lifecycle === 'closed') return Promise.reject(new Error('background_supervisor_closed'));
    lifecycle = 'running';
    for (const job of definitions.values()) {
      const timer = setInterval(() => { void run(job.name); }, job.intervalMs);
      timer.unref?.();
      timers.set(job.name, timer);
    }
    startPromise = Promise.all(
      [...definitions.values()]
        .filter((job) => job.runOnStart === true)
        .map((job) => run(job.name))
    ).then(() => undefined);
    return startPromise;
  };

  const snapshot = (): BackgroundSupervisorSnapshot => Object.freeze({
    state: lifecycle,
    jobs: Object.freeze([...definitions.keys()].map((name) => {
      const state = states.get(name)!;
      return Object.freeze({ name, ...state });
    }))
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    lifecycle = 'closed';
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    closePromise = Promise.all([...inFlight.values()]).then(() => undefined);
    return closePromise;
  };

  return Object.freeze({ start, runNow: run, snapshot, close });
}
