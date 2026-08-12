import {
  canonicalJsonText,
  parseAggregateVersion,
  type AggregateVersion,
  type Brand,
  type CapabilityRevisionId,
  type ConsumerAttemptId,
  type ConsumerDeliveryId,
  type Instant
} from '@jooevents/kernel';
import type {
  CanonicalSha256,
  ConsumerDefinition,
  ConsumerSourceRef,
  DefinitionRef
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

export type OutboxPointerKey = Brand<string, 'OutboxPointerKey'>;
export type OpaqueSourceIdentity = Brand<string, 'OpaqueReliabilitySourceIdentity'>;
export type ConsumerDeliverySemanticKey = Brand<string, 'ConsumerDeliverySemanticKey'>;

export function parseOutboxPointerKey(value: unknown): OutboxPointerKey {
  if (typeof value !== 'string' || !/^ptr1_[A-Za-z0-9_-]{8,160}$/.test(value)) {
    throw new TypeError('outbox pointer key must be an opaque ptr1_ identity');
  }
  return value as OutboxPointerKey;
}

export function parseOpaqueSourceIdentity(value: unknown): OpaqueSourceIdentity {
  if (typeof value !== 'string' || !/^src1_[A-Za-z0-9_-]{8,200}$/.test(value)) {
    throw new TypeError('source identity must be an opaque src1_ identity');
  }
  return value as OpaqueSourceIdentity;
}

export interface OutboxPointerRef {
  readonly key: OutboxPointerKey;
  readonly source: ConsumerSourceRef;
  readonly sourceIdentity: OpaqueSourceIdentity;
  readonly sourceVersion: AggregateVersion;
  readonly availableAt: Instant;
}

export interface ConsumerDeliveryDraft {
  readonly semanticKey: ConsumerDeliverySemanticKey;
  readonly pointer: OutboxPointerRef;
  readonly consumer: DefinitionRef<'consumer'>;
  readonly definitionDigestSha256: CanonicalSha256;
  readonly targetOperation: DefinitionRef<'operation'>;
  readonly inputProjection: DefinitionRef<'input_projection'>;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
  readonly maximumAttempts: number;
  readonly leaseDurationMs: number;
}

export interface ConsumerDeliveryAttemptRunning {
  readonly id: ConsumerAttemptId;
  readonly number: AttemptNumber;
  readonly fence: LeaseFence;
  readonly state: 'running';
  readonly startedAt: Instant;
}

export interface ConsumerDeliveryAttemptFinished {
  readonly id: ConsumerAttemptId;
  readonly number: AttemptNumber;
  readonly fence: LeaseFence;
  readonly state: 'succeeded' | 'retry_scheduled' | 'dead_lettered' | 'cancelled' | 'lost_fence';
  readonly startedAt: Instant;
  readonly completedAt: Instant;
  readonly failure: SafeFailure | null;
}

export type ConsumerDeliveryAttempt =
  | ConsumerDeliveryAttemptRunning
  | ConsumerDeliveryAttemptFinished;

export interface ConsumerDelivery extends ConsumerDeliveryDraft {
  readonly id: ConsumerDeliveryId;
  readonly state: DeliveryAndJobState;
  readonly version: AggregateVersion;
  readonly currentFence: LeaseFence | null;
  readonly lease: WorkLease<ConsumerAttemptId> | null;
  readonly nextActionAt: Instant | null;
  readonly attempts: readonly ConsumerDeliveryAttempt[];
}

export interface ConsumerFanoutPlan {
  readonly existing: readonly ConsumerDelivery[];
  readonly creations: readonly ConsumerDeliveryDraft[];
}

function semanticKey(
  pointer: OutboxPointerRef,
  consumer: DefinitionRef<'consumer'>
): ConsumerDeliverySemanticKey {
  return canonicalJsonText({
    consumer: { key: consumer.key, version: consumer.version },
    pointer: pointer.key,
    source: {
      identity: pointer.sourceIdentity,
      key: pointer.source.key,
      kind: pointer.source.kind,
      version: pointer.source.version
    }
  }) as ConsumerDeliverySemanticKey;
}

function compareConsumers(left: ConsumerDefinition, right: ConsumerDefinition): number {
  const leftKey = `${left.key}\u0000${left.version}`;
  const rightKey = `${right.key}\u0000${right.version}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/** Plans one independently claimable delivery per exact compatible consumer version. */
export function planConsumerFanout(
  pointer: OutboxPointerRef,
  consumers: readonly ConsumerDefinition[],
  existing: readonly ConsumerDelivery[]
): ConsumerFanoutPlan {
  const pointerSnapshot: OutboxPointerRef = Object.freeze({
    key: pointer.key,
    source: Object.freeze({ ...pointer.source }),
    sourceIdentity: pointer.sourceIdentity,
    sourceVersion: pointer.sourceVersion,
    availableAt: canonicalInstant(pointer.availableAt)
  });
  const existingKeys = new Set<ConsumerDeliverySemanticKey>();
  for (const delivery of existing) {
    if (existingKeys.has(delivery.semanticKey)) {
      throw new ReliabilityTransitionError(
        'duplicate_identity',
        'existing consumer deliveries contain a duplicate semantic identity'
      );
    }
    existingKeys.add(delivery.semanticKey);
  }

  const consumerKeys = new Set<string>();
  const creations: ConsumerDeliveryDraft[] = [];
  for (const consumer of [...consumers].sort(compareConsumers)) {
    const exactConsumer = `${consumer.key}\u0000${consumer.version}`;
    if (consumerKeys.has(exactConsumer)) {
      throw new ReliabilityTransitionError(
        'duplicate_identity',
        'fanout contains the same consumer version more than once'
      );
    }
    consumerKeys.add(exactConsumer);
    const acceptsSource = consumer.acceptedSources.some(
      (accepted) =>
        accepted.kind === pointer.source.kind &&
        accepted.key === pointer.source.key &&
        accepted.version === pointer.source.version
    );
    if (!acceptsSource) continue;

    const consumerRef: DefinitionRef<'consumer'> = {
      kind: 'consumer',
      key: consumer.key,
      version: consumer.version
    };
    const key = semanticKey(pointerSnapshot, consumerRef);
    if (existingKeys.has(key)) continue;
    creations.push({
      semanticKey: key,
      pointer: pointerSnapshot,
      consumer: consumerRef,
      definitionDigestSha256: consumer.canonicalDigestSha256,
      targetOperation: consumer.targetOperation,
      inputProjection: consumer.inputProjection,
      capabilityRevisionId: consumer.capabilityRevisionId,
      authorityCitation: consumer.authorityCitation,
      maximumAttempts: consumer.maximumAttempts,
      leaseDurationMs: consumer.leaseDurationMs
    });
  }
  return Object.freeze({ existing, creations: Object.freeze(creations) });
}

export function materializeConsumerDelivery(
  draft: ConsumerDeliveryDraft,
  id: ConsumerDeliveryId
): ConsumerDelivery {
  return Object.freeze({
    ...draft,
    id,
    state: 'pending',
    version: parseAggregateVersion(1),
    currentFence: null,
    lease: null,
    nextActionAt: draft.pointer.availableAt,
    attempts: Object.freeze([])
  });
}

export interface ClaimConsumerDeliveryInput {
  readonly attemptId: ConsumerAttemptId;
  readonly ownerKey: string;
  readonly now: Instant;
  readonly leaseExpiresAt: Instant;
}

function isTerminal(state: DeliveryAndJobState): boolean {
  return state === 'succeeded' || state === 'dead_lettered' || state === 'cancelled';
}

function countConsumerPolicyAttempts(attempts: readonly ConsumerDeliveryAttempt[]): number {
  return attempts.reduce(
    (count, attempt) => count + (attempt.state === 'lost_fence' ? 0 : 1),
    0
  );
}

export function claimConsumerDelivery(
  delivery: ConsumerDelivery,
  input: ClaimConsumerDeliveryInput
): ConsumerDelivery {
  const now = canonicalInstant(input.now);
  const leaseExpiresAt = canonicalInstant(input.leaseExpiresAt);
  assertAfter(leaseExpiresAt, now, 'consumer delivery lease expiry');
  assertWithinDuration(
    leaseExpiresAt,
    now,
    delivery.leaseDurationMs,
    'consumer delivery lease expiry'
  );
  assertWorkerKey(input.ownerKey);
  if (isTerminal(delivery.state)) {
    throw new ReliabilityTransitionError('terminal', 'terminal consumer delivery cannot be claimed');
  }
  if (delivery.state === 'leased' && delivery.lease !== null && delivery.lease.expiresAt > now) {
    throw new ReliabilityTransitionError('lease_busy', 'consumer delivery lease has not expired');
  }
  if (
    delivery.state !== 'leased' &&
    delivery.nextActionAt !== null &&
    delivery.nextActionAt > now
  ) {
    throw new ReliabilityTransitionError('not_ready', 'consumer delivery is not due');
  }
  const expiredAttempt = delivery.state === 'leased' && delivery.lease !== null
    ? delivery.attempts.find(
        (attempt) => attempt.id === delivery.lease?.attemptId && attempt.state === 'running'
      )
    : undefined;
  const policyAttemptsBeforeClaim = countConsumerPolicyAttempts(delivery.attempts)
    - (expiredAttempt === undefined ? 0 : 1);
  if (policyAttemptsBeforeClaim >= delivery.maximumAttempts) {
    throw new ReliabilityTransitionError('attempt_limit', 'consumer delivery attempt limit reached');
  }
  if (delivery.attempts.some((attempt) => attempt.id === input.attemptId)) {
    throw new ReliabilityTransitionError('duplicate_identity', 'consumer attempt ID was already used');
  }

  const fence = nextFence(delivery.currentFence);
  const attempt: ConsumerDeliveryAttemptRunning = Object.freeze({
    id: input.attemptId,
    number: nextAttemptNumber(delivery.attempts.length),
    fence,
    state: 'running',
    startedAt: now
  });
  return Object.freeze({
    ...delivery,
    state: 'leased',
    version: nextAggregateVersion(delivery.version),
    currentFence: fence,
    lease: Object.freeze({
      fence,
      ownerKey: input.ownerKey,
      attemptId: input.attemptId,
      expiresAt: leaseExpiresAt
    }),
    nextActionAt: null,
    attempts: Object.freeze([...delivery.attempts, attempt])
  });
}

export type ConsumerDeliveryCompletion =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'retry'; readonly retryAt: Instant; readonly failure: SafeFailure }
  | { readonly kind: 'dead_lettered'; readonly failure: SafeFailure }
  | { readonly kind: 'cancelled'; readonly reasonCode: string };

export function completeConsumerDelivery(
  delivery: ConsumerDelivery,
  fence: LeaseFence,
  completedAtValue: Instant,
  completion: ConsumerDeliveryCompletion
): ConsumerDelivery {
  const completedAt = canonicalInstant(completedAtValue);
  if (
    delivery.state !== 'leased' ||
    delivery.lease === null ||
    delivery.currentFence !== fence ||
    delivery.lease.fence !== fence
  ) {
    throw new ReliabilityTransitionError('lost_fence', 'consumer delivery completion lost its lease fence');
  }
  const attemptIndex = delivery.attempts.findIndex(
    (attempt) => attempt.id === delivery.lease?.attemptId && attempt.state === 'running'
  );
  if (attemptIndex < 0) {
    throw new ReliabilityTransitionError('unknown_attempt', 'active consumer attempt is not running');
  }
  const running = delivery.attempts[attemptIndex] as ConsumerDeliveryAttemptRunning;
  assertNotBefore(completedAt, running.startedAt, 'consumer delivery completion time');

  let state: DeliveryAndJobState;
  let attemptState: ConsumerDeliveryAttemptFinished['state'];
  let nextActionAt: Instant | null = null;
  let failure: SafeFailure | null = null;
  if (completion.kind === 'succeeded') {
    state = 'succeeded';
    attemptState = 'succeeded';
  } else if (completion.kind === 'cancelled') {
    assertSafeCode(completion.reasonCode, 'consumer cancellation reason');
    state = 'cancelled';
    attemptState = 'cancelled';
  } else {
    assertSafeCode(completion.failure.code, 'consumer failure code');
    failure = completion.failure;
    if (
      completion.kind === 'retry'
      && countConsumerPolicyAttempts(delivery.attempts) < delivery.maximumAttempts
    ) {
      const retryAt = canonicalInstant(completion.retryAt);
      assertAfter(retryAt, completedAt, 'consumer retry time');
      state = 'retry_wait';
      attemptState = 'retry_scheduled';
      nextActionAt = retryAt;
    } else {
      state = 'dead_lettered';
      attemptState = 'dead_lettered';
    }
  }
  const finished: ConsumerDeliveryAttemptFinished = Object.freeze({
    id: running.id,
    number: running.number,
    fence: running.fence,
    state: attemptState,
    startedAt: running.startedAt,
    completedAt,
    failure
  });
  const attempts = [...delivery.attempts];
  attempts[attemptIndex] = finished;
  return Object.freeze({
    ...delivery,
    state,
    version: nextAggregateVersion(delivery.version),
    lease: null,
    nextActionAt,
    attempts: Object.freeze(attempts)
  });
}

export function recordConsumerAttemptLostFence(
  delivery: ConsumerDelivery,
  attemptId: ConsumerAttemptId,
  observedAtValue: Instant
): ConsumerDelivery {
  const observedAt = canonicalInstant(observedAtValue);
  const attemptIndex = delivery.attempts.findIndex(
    (attempt) => attempt.id === attemptId && attempt.state === 'running'
  );
  const attempt = delivery.attempts[attemptIndex];
  if (attemptIndex < 0 || attempt === undefined) {
    throw new ReliabilityTransitionError('unknown_attempt', 'consumer attempt is not running');
  }
  if (delivery.currentFence === null || attempt.fence >= delivery.currentFence) {
    throw new ReliabilityTransitionError('lost_fence', 'consumer attempt has not lost its fence');
  }
  assertNotBefore(observedAt, attempt.startedAt, 'lost-fence observation time');
  const attempts = [...delivery.attempts];
  attempts[attemptIndex] = Object.freeze({
    ...attempt,
    state: 'lost_fence',
    completedAt: observedAt,
    failure: null
  });
  return Object.freeze({
    ...delivery,
    version: nextAggregateVersion(delivery.version),
    attempts: Object.freeze(attempts)
  });
}
