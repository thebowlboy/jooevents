import { createHash } from 'node:crypto';
import {
  deadlineCatalogSnapshotSchema,
  deadlineHeadSchema,
  deadlineReferencePinSchema,
  deadlineScopeSchema,
  type ActiveDeadlineHeadDto,
  type DeadlineCatalogSnapshotDto,
  type DeadlineHeadDto,
  type DeadlineReferencePinDto,
  type DeadlineScopeDto
} from '@jooevents/contracts/deadlines';
import { encodeCanonicalJson } from '@jooevents/kernel';

export type DeadlineScope = DeadlineScopeDto;
export type DeadlineHead = DeadlineHeadDto;
export type ActiveDeadlineHead = ActiveDeadlineHeadDto;
export type DeadlineCatalog = DeadlineCatalogSnapshotDto;

export function parseDeadlineScope(value: unknown): DeadlineScope {
  return deepFreeze(deadlineScopeSchema.parse(value));
}

export function deadlineHeadDigest(value: Omit<DeadlineHeadDto, 'digestSha256'>): string {
  return sha256(value);
}

export function parseDeadlineHead(value: unknown): DeadlineHead {
  const head = deadlineHeadSchema.parse(value);
  const { digestSha256, ...content } = head;
  if (deadlineHeadDigest(content) !== digestSha256) throw new TypeError('invalid_deadline_digest');
  return deepFreeze(head);
}

export function deadlineCatalogDigest(value: {
  readonly schemaVersion: 1;
  readonly scope: DeadlineScopeDto;
  readonly version: number;
  readonly deadlines: readonly DeadlineHeadDto[];
}): string {
  return sha256({
    schemaVersion: value.schemaVersion,
    scope: value.scope,
    version: value.version,
    deadlineHeads: value.deadlines.map((head) => ({ id: head.id, digestSha256: head.digestSha256 }))
  });
}

export function parseDeadlineCatalog(value: unknown): DeadlineCatalog {
  const catalog = deadlineCatalogSnapshotSchema.parse(value);
  const deadlines = catalog.deadlines.map(parseDeadlineHead);
  const expected = deadlineCatalogDigest({
    schemaVersion: 1, scope: catalog.scope, version: catalog.version, deadlines
  });
  if (expected !== catalog.digestSha256) throw new TypeError('invalid_deadline_catalog_digest');
  return deepFreeze({ ...catalog, deadlines });
}

export function createEmptyDeadlineCatalog(scope: DeadlineScopeDto): DeadlineCatalog {
  const parsedScope = parseDeadlineScope(scope);
  const value = { schemaVersion: 1 as const, scope: parsedScope, version: 1, deadlines: [] };
  return parseDeadlineCatalog({ ...value, digestSha256: deadlineCatalogDigest(value) });
}

export function deadlineReferencePin(head: DeadlineHeadDto): DeadlineReferencePinDto | undefined {
  const parsed = parseDeadlineHead(head);
  if (parsed.status !== 'active') return undefined;
  return deepFreeze(deadlineReferencePinSchema.parse({
    id: parsed.id,
    version: parsed.version,
    digestSha256: parsed.digestSha256,
    effectiveAt: parsed.effectiveAt,
    displayDate: parsed.displayDate,
    eventTimezone: parsed.boundary.eventTimezone,
    gracePolicy: parsed.gracePolicy
  }));
}

export function deadlineAggregateId(deadlineId: string): string {
  return `deadline:${deadlineId}`;
}

export function deadlineCatalogGuardId(eventId: string): string {
  return `deadline_catalog:${eventId}`;
}

export function deadlineEventAggregateId(eventId: string): string {
  return `event:${eventId}`;
}

export function sameDeadlineScope(left: DeadlineScopeDto, right: DeadlineScopeDto): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

export function compareDeadlineHeads(left: DeadlineHeadDto, right: DeadlineHeadDto): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

export function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
