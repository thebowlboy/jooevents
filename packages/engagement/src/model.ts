import {
  engagementHeadSchema,
  engagementScopeSchema,
  engagementSnapshotSchema,
  type EngagementHeadDto,
  type EngagementScopeDto,
  type EngagementSnapshotDto
} from '@jooevents/contracts';
import { canonicalJsonSha256 } from '@jooevents/changesets';

export type EngagementScope = EngagementScopeDto;
export type EngagementHead = EngagementHeadDto;
export type EngagementSnapshot = EngagementSnapshotDto;

export function parseEngagementScope(value: unknown): EngagementScope {
  return deepFreeze(engagementScopeSchema.parse(value));
}

export function parseEngagementHead(value: unknown): EngagementHead {
  return deepFreeze(engagementHeadSchema.parse(value));
}

export function parseEngagementSnapshot(value: unknown): EngagementSnapshot {
  return deepFreeze(engagementSnapshotSchema.parse(value));
}

export function engagementAggregateId(engagementId: string): string {
  return `engagement_head:${engagementId}`;
}

/**
 * Deterministic identity for the one engagement a `(sessionId, personId)` pair
 * can ever hold inside one event scope. Seeding happens inside a hosting
 * commit's apply phase where no id factory exists and replays must produce the
 * byte-identical plan, so the id is derived from the pair itself: the leading
 * 128 bits of the canonical-JSON SHA-256, carrying UUID version/variant nibbles
 * so it satisfies the canonical application-id shape. It is an opaque
 * content-derived identity — nothing may infer chronology or meaning from it.
 */
export function deterministicEngagementId(
  scope: EngagementScope,
  sessionId: string,
  personId: string
): string {
  const hex = canonicalJsonSha256({
    domain: 'engagement_head',
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    sessionId,
    personId
  });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}`
    + `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function sameEngagementScope(left: EngagementScope, right: EngagementScope): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

/**
 * The projected request sub-state: a stored cancellation request beside a
 * non-cancelled state. It is never a fifth canonical state value.
 */
export function isCancellationRequested(head: EngagementHead): boolean {
  return head.state !== 'cancelled' && head.cancellationRequest !== null;
}

export interface EngagementReadPort {
  readEngagementHead(scope: EngagementScope, engagementId: string): EngagementHead | undefined;
  readSessionPersonEngagement(
    scope: EngagementScope,
    sessionId: string,
    personId: string
  ): EngagementHead | undefined;
  /** Rows one submission's acceptance seeded onto one Session, ordered by person id. */
  listSeededEngagements(
    scope: EngagementScope,
    sessionId: string,
    submissionId: string
  ): readonly EngagementHead[];
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
