import {
  parseAggregateVersion,
  type AggregateVersion,
  type Instant,
  type InvocationId,
  type JobId,
  type PayloadRef
} from '@jooevents/kernel';
import type {
  CanonicalSha256,
  DefinitionRef,
  ExternalRetryPolicy,
  JobDefinition,
  JobSourceRef
} from './definitions';
import {
  ReliabilityTransitionError,
  assertAfter,
  assertNotBefore,
  assertSafeCode,
  assertWithinDuration,
  assertWorkerKey,
  canonicalInstant,
  nextAggregateVersion,
  nextAttemptNumber,
  nextFence,
  type AttemptNumber,
  type DeliveryAndJobState,
  type LeaseFence,
  type SafeFailure,
  type WorkLease
} from './work-state';
import type { OpaqueSourceIdentity } from './delivery';

export interface JobSource {
  readonly definition: JobSourceRef;
  readonly identity: OpaqueSourceIdentity;
  readonly version: AggregateVersion;
}

export interface JobAttemptRunning {
  readonly invocationId: InvocationId;
  readonly number: AttemptNumber;
  readonly fence: LeaseFence;
  readonly state: 'running';
  readonly startedAt: Instant;
}

export interface JobAttemptFinished {
  readonly invocationId: InvocationId;
  readonly number: AttemptNumber;
  readonly fence: LeaseFence;
  readonly state: 'succeeded' | 'retry_scheduled' | 'dead_lettered' | 'cancelled' | 'lost_fence';
  readonly startedAt: Instant;
  readonly completedAt: Instant;
  readonly resultRef: PayloadRef | null;
  readonly failure: SafeFailure | null;
}

export type JobAttempt = JobAttemptRunning | JobAttemptFinished;

export interface JobRecord {
  readonly id: JobId;
  readonly definition: DefinitionRef<'job'>;
  readonly definitionDigestSha256: CanonicalSha256;
  readonly registeredIdempotencyIdentity: string;
  readonly source: JobSource;
  readonly inputRef: PayloadRef;
  readonly inputProjection: DefinitionRef<'input_projection'>;
  readonly targetOperation: DefinitionRef<'operation'>;
  readonly capabilityRevisionId: JobDefinition['capabilityRevisionId'];
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
  readonly externalRetryPolicy: ExternalRetryPolicy;
  readonly maximumAttempts: number;
  readonly leaseDurationMs: number;
  readonly timeoutMs: number;
  readonly state: DeliveryAndJobState;
  readonly version: AggregateVersion;
  readonly currentFence: LeaseFence | null;
  readonly lease: WorkLease<InvocationId> | null;
  readonly nextActionAt: Instant | null;
  readonly attempts: readonly JobAttempt[];
}

export interface CreateJobInput {
  readonly id: JobId;
  readonly definition: JobDefinition;
  readonly registeredIdempotencyIdentity: string;
  readonly source: JobSource;
  readonly inputRef: PayloadRef;
  readonly availableAt: Instant;
}

export function createJob(input: CreateJobInput): JobRecord {
  if (
    input.registeredIdempotencyIdentity.length === 0 ||
    input.registeredIdempotencyIdentity.length > 240 ||
    input.registeredIdempotencyIdentity.trim() !== input.registeredIdempotencyIdentity
  ) {
    throw new TypeError('registered job idempotency identity must be bounded and non-empty');
  }
  const availableAt = canonicalInstant(input.availableAt);
  return Object.freeze({
    id: input.id,
    definition: Object.freeze({
      kind: 'job',
      key: input.definition.key,
      version: input.definition.version
    }),
    definitionDigestSha256: input.definition.canonicalDigestSha256,
    registeredIdempotencyIdentity: input.registeredIdempotencyIdentity,
    source: Object.freeze({ ...input.source, definition: Object.freeze({ ...input.source.definition }) }),
    inputRef: Object.freeze({ ...input.inputRef }),
    inputProjection: input.definition.inputProjection,
    targetOperation: input.definition.targetOperation,
    capabilityRevisionId: input.definition.capabilityRevisionId,
    authorityCitation: input.definition.authorityCitation,
    externalRetryPolicy: input.definition.externalRetryPolicy,
    maximumAttempts: input.definition.maximumAttempts,
    leaseDurationMs: input.definition.leaseDurationMs,
    timeoutMs: input.definition.timeoutMs,
    state: 'pending',
    version: parseAggregateVersion(1),
    currentFence: null,
    lease: null,
    nextActionAt: availableAt,
    attempts: Object.freeze([])
  });
}

export interface ClaimJobInput {
  readonly invocationId: InvocationId;
  readonly ownerKey: string;
  readonly now: Instant;
  readonly leaseExpiresAt: Instant;
}

function isTerminal(state: DeliveryAndJobState): boolean {
  return state === 'succeeded' || state === 'dead_lettered' || state === 'cancelled';
}

export function claimJob(job: JobRecord, input: ClaimJobInput): JobRecord {
  const now = canonicalInstant(input.now);
  const leaseExpiresAt = canonicalInstant(input.leaseExpiresAt);
  assertAfter(leaseExpiresAt, now, 'job lease expiry');
  assertWithinDuration(leaseExpiresAt, now, job.leaseDurationMs, 'job lease expiry');
  assertWorkerKey(input.ownerKey);
  if (isTerminal(job.state)) {
    throw new ReliabilityTransitionError('terminal', 'terminal job cannot be claimed');
  }
  if (job.state === 'leased' && job.lease !== null && job.lease.expiresAt > now) {
    throw new ReliabilityTransitionError('lease_busy', 'job lease has not expired');
  }
  if (job.state === 'leased' && job.lease !== null) {
    if (job.externalRetryPolicy === 'anchor_inspection_only') {
      throw new ReliabilityTransitionError(
        'reconciliation_required',
        'expired job work requires registered anchor inspection before another attempt'
      );
    }
    throw new ReliabilityTransitionError(
      'external_retry_forbidden',
      'expired job work cannot be retried under its registered external retry policy'
    );
  }
  if (job.state !== 'leased' && job.nextActionAt !== null && job.nextActionAt > now) {
    throw new ReliabilityTransitionError('not_ready', 'job is not due');
  }
  if (job.attempts.length >= job.maximumAttempts) {
    throw new ReliabilityTransitionError('attempt_limit', 'job attempt limit reached');
  }
  if (job.attempts.some((attempt) => attempt.invocationId === input.invocationId)) {
    throw new ReliabilityTransitionError('duplicate_identity', 'job invocation ID was already used');
  }
  const fence = nextFence(job.currentFence);
  const attempt: JobAttemptRunning = Object.freeze({
    invocationId: input.invocationId,
    number: nextAttemptNumber(job.attempts.length),
    fence,
    state: 'running',
    startedAt: now
  });
  return Object.freeze({
    ...job,
    state: 'leased',
    version: nextAggregateVersion(job.version),
    currentFence: fence,
    lease: Object.freeze({
      fence,
      ownerKey: input.ownerKey,
      attemptId: input.invocationId,
      expiresAt: leaseExpiresAt
    }),
    nextActionAt: null,
    attempts: Object.freeze([...job.attempts, attempt])
  });
}

export type JobCompletion =
  | { readonly kind: 'succeeded'; readonly resultRef: PayloadRef | null }
  | { readonly kind: 'retry'; readonly retryAt: Instant; readonly failure: SafeFailure }
  | { readonly kind: 'dead_lettered'; readonly failure: SafeFailure }
  | { readonly kind: 'cancelled'; readonly reasonCode: string };

export function completeJob(
  job: JobRecord,
  fence: LeaseFence,
  completedAtValue: Instant,
  completion: JobCompletion
): JobRecord {
  const completedAt = canonicalInstant(completedAtValue);
  if (
    job.state !== 'leased' ||
    job.lease === null ||
    job.currentFence !== fence ||
    job.lease.fence !== fence
  ) {
    throw new ReliabilityTransitionError('lost_fence', 'job completion lost its lease fence');
  }
  const attemptIndex = job.attempts.findIndex(
    (attempt) => attempt.invocationId === job.lease?.attemptId && attempt.state === 'running'
  );
  if (attemptIndex < 0) {
    throw new ReliabilityTransitionError('unknown_attempt', 'active job attempt is not running');
  }
  const running = job.attempts[attemptIndex] as JobAttemptRunning;
  assertNotBefore(completedAt, running.startedAt, 'job completion time');

  let state: DeliveryAndJobState;
  let attemptState: JobAttemptFinished['state'];
  let nextActionAt: Instant | null = null;
  let failure: SafeFailure | null = null;
  let resultRef: PayloadRef | null = null;
  if (completion.kind === 'succeeded') {
    state = 'succeeded';
    attemptState = 'succeeded';
    resultRef = completion.resultRef;
  } else if (completion.kind === 'cancelled') {
    assertSafeCode(completion.reasonCode, 'job cancellation reason');
    state = 'cancelled';
    attemptState = 'cancelled';
  } else {
    assertSafeCode(completion.failure.code, 'job failure code');
    if (completion.kind === 'retry' && completion.failure.classification === 'ambiguous') {
      throw new ReliabilityTransitionError(
        'reconciliation_required',
        'ambiguous job work requires registered reconciliation before retry'
      );
    }
    failure = completion.failure;
    if (completion.kind === 'retry' && job.attempts.length < job.maximumAttempts) {
      const retryAt = canonicalInstant(completion.retryAt);
      assertAfter(retryAt, completedAt, 'job retry time');
      state = 'retry_wait';
      attemptState = 'retry_scheduled';
      nextActionAt = retryAt;
    } else {
      state = 'dead_lettered';
      attemptState = 'dead_lettered';
    }
  }

  const finished: JobAttemptFinished = Object.freeze({
    invocationId: running.invocationId,
    number: running.number,
    fence: running.fence,
    state: attemptState,
    startedAt: running.startedAt,
    completedAt,
    resultRef,
    failure
  });
  const attempts = [...job.attempts];
  attempts[attemptIndex] = finished;
  return Object.freeze({
    ...job,
    state,
    version: nextAggregateVersion(job.version),
    lease: null,
    nextActionAt,
    attempts: Object.freeze(attempts)
  });
}

export function recordJobAttemptLostFence(
  job: JobRecord,
  invocationId: InvocationId,
  observedAtValue: Instant
): JobRecord {
  const observedAt = canonicalInstant(observedAtValue);
  const attemptIndex = job.attempts.findIndex(
    (attempt) => attempt.invocationId === invocationId && attempt.state === 'running'
  );
  const attempt = job.attempts[attemptIndex];
  if (attemptIndex < 0 || attempt === undefined) {
    throw new ReliabilityTransitionError('unknown_attempt', 'job attempt is not running');
  }
  if (job.currentFence === null || attempt.fence >= job.currentFence) {
    throw new ReliabilityTransitionError('lost_fence', 'job attempt has not lost its fence');
  }
  assertNotBefore(observedAt, attempt.startedAt, 'lost-fence observation time');
  const attempts = [...job.attempts];
  attempts[attemptIndex] = Object.freeze({
    ...attempt,
    state: 'lost_fence',
    completedAt: observedAt,
    resultRef: null,
    failure: null
  });
  return Object.freeze({
    ...job,
    version: nextAggregateVersion(job.version),
    attempts: Object.freeze(attempts)
  });
}
