import {
  parseAggregateVersion,
  parseInstant,
  type AggregateVersion,
  type Brand,
  type Instant
} from '@jooevents/kernel';

export type LeaseFence = Brand<number, 'ReliabilityLeaseFence'>;
export type AttemptNumber = Brand<number, 'ReliabilityAttemptNumber'>;

export const DELIVERY_AND_JOB_STATES = [
  'pending',
  'leased',
  'retry_wait',
  'succeeded',
  'dead_lettered',
  'cancelled'
] as const;

export type DeliveryAndJobState = (typeof DELIVERY_AND_JOB_STATES)[number];

export interface SafeFailure {
  readonly code: string;
  readonly classification: 'transient' | 'permanent' | 'ambiguous';
}

export interface WorkLease<AttemptId extends string> {
  readonly fence: LeaseFence;
  readonly ownerKey: string;
  readonly attemptId: AttemptId;
  readonly expiresAt: Instant;
}

export class ReliabilityTransitionError extends Error {
  constructor(
    readonly code:
      | 'duplicate_identity'
      | 'not_ready'
      | 'lease_busy'
      | 'attempt_limit'
      | 'reconciliation_required'
      | 'external_retry_forbidden'
      | 'terminal'
      | 'lost_fence'
      | 'unknown_attempt'
      | 'binding_collision'
      | 'invalid_time',
    message: string
  ) {
    super(message);
    this.name = 'ReliabilityTransitionError';
  }
}

export function parseLeaseFence(value: unknown): LeaseFence {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('lease fence must be a positive safe integer');
  }
  return value as LeaseFence;
}

export function parseAttemptNumber(value: unknown): AttemptNumber {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('attempt number must be a positive safe integer');
  }
  return value as AttemptNumber;
}

export function nextFence(current: LeaseFence | null): LeaseFence {
  return parseLeaseFence((current ?? 0) + 1);
}

export function nextAttemptNumber(currentCount: number): AttemptNumber {
  return parseAttemptNumber(currentCount + 1);
}

export function nextAggregateVersion(current: AggregateVersion): AggregateVersion {
  return parseAggregateVersion(current + 1);
}

export function canonicalInstant(value: Instant): Instant {
  return parseInstant(value);
}

export function assertAfter(later: Instant, earlier: Instant, label: string): void {
  if (canonicalInstant(later) <= canonicalInstant(earlier)) {
    throw new ReliabilityTransitionError('invalid_time', `${label} must be after the current time`);
  }
}

export function assertNotBefore(later: Instant, earlier: Instant, label: string): void {
  if (canonicalInstant(later) < canonicalInstant(earlier)) {
    throw new ReliabilityTransitionError('invalid_time', `${label} cannot be before its start`);
  }
}

export function assertWithinDuration(
  later: Instant,
  earlier: Instant,
  maximumDurationMs: number,
  label: string
): void {
  if (Date.parse(later) - Date.parse(earlier) > maximumDurationMs) {
    throw new ReliabilityTransitionError('invalid_time', `${label} exceeds its registered duration`);
  }
}

export function assertSafeCode(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new TypeError(`${label} must be a bounded safe code`);
  }
}

export function assertWorkerKey(value: string): void {
  if (value.length === 0 || value.length > 160 || value.trim() !== value) {
    throw new TypeError('worker key must be a bounded non-empty identity');
  }
}
