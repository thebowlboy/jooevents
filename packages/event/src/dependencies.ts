import { createHash } from 'node:crypto';
import { versionedDefinitionRefSchema } from '@jooevents/contracts';
import {
  encodeCanonicalJson,
  parseAggregateVersion,
  parseEventId,
  parseWorkspaceId,
  type AggregateVersion,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

const stableKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const digest = /^[a-f0-9]{64}$/;
const completeEventDependencySnapshot: unique symbol = Symbol('CompleteEventDependencySnapshot');
const eventDependencyRegistries = new WeakSet<object>();

export interface EventDependencyScope {
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
}

export interface EventDependencyContributorRef {
  readonly key: string;
  readonly version: number;
}

export interface EventDependencyRecord {
  readonly referenceKey: string;
  readonly version: AggregateVersion;
  readonly destination: { readonly kind: string; readonly id: string };
}

export interface EventDependencyContributorSnapshot {
  readonly contributor: EventDependencyContributorRef;
  readonly scope: EventDependencyScope;
  readonly guard: { readonly id: string; readonly version: AggregateVersion; readonly digest: string };
  readonly dependencies: readonly EventDependencyRecord[];
}

export interface CompleteEventDependencySnapshot {
  readonly [completeEventDependencySnapshot]: true;
  readonly registryDigestSha256: string;
  readonly contributors: readonly EventDependencyContributorSnapshot[];
}

export interface EventDependencySnapshotSource {
  readContributor(
    contributor: EventDependencyContributorRef,
    scope: EventDependencyScope
  ): unknown;
}

export interface EventDependencyContributorRegistry {
  readonly registryDigestSha256: string;
  readonly contributors: readonly EventDependencyContributorRef[];
  capture(
    scope: EventDependencyScope,
    source: EventDependencySnapshotSource
  ): CompleteEventDependencySnapshot;
}

export interface EventDependencyRegistryIssue {
  readonly code:
    | 'duplicate_expected'
    | 'duplicate_contributor'
    | 'missing_contributor'
    | 'unexpected_contributor'
    | 'wrong_version'
    | 'invalid_contributor';
  readonly key: string;
}

export class EventDependencyRegistryValidationError extends Error {
  readonly issues: readonly EventDependencyRegistryIssue[];

  constructor(issues: readonly EventDependencyRegistryIssue[]) {
    super(`Event dependency registry failed with ${issues.length} issue(s).`);
    this.name = 'EventDependencyRegistryValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

export class EventDependencySnapshotError extends Error {
  readonly code:
    | 'missing_contributor'
    | 'invalid_snapshot'
    | 'wrong_contributor'
    | 'wrong_scope'
    | 'duplicate_reference'
    | 'duplicate_guard'
    | 'invalid_registry';

  constructor(code: EventDependencySnapshotError['code']) {
    super(code);
    this.name = 'EventDependencySnapshotError';
    this.code = code;
  }
}

const dependencySnapshotSchema = z.strictObject({
  contributor: versionedDefinitionRefSchema,
  scope: z.strictObject({ workspaceId: z.uuid(), eventId: z.uuid() }),
  guard: z.strictObject({
    id: z.string().regex(/^event_dependency:[A-Za-z0-9._~:-]+$/),
    version: z.number().int().positive(),
    digest: z.string().regex(digest)
  }),
  dependencies: z.array(z.strictObject({
    referenceKey: z.string().trim().min(1).max(300),
    version: z.number().int().positive(),
    destination: z.strictObject({
      kind: z.string().trim().min(1).max(160).regex(stableKey),
      id: z.string().trim().min(1).max(300)
    })
  }))
});

function identity(contributor: EventDependencyContributorRef): string {
  return `${contributor.key}@${contributor.version}`;
}

function parseContributor(
  value: EventDependencyContributorRef
): EventDependencyContributorRef | undefined {
  if (!stableKey.test(value.key) || !Number.isSafeInteger(value.version) || value.version <= 0) {
    return undefined;
  }
  return Object.freeze({ key: value.key, version: value.version });
}

function sha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function parseSnapshot(
  value: unknown,
  expected: EventDependencyContributorRef,
  scope: EventDependencyScope
): EventDependencyContributorSnapshot {
  if (value === undefined) throw new EventDependencySnapshotError('missing_contributor');
  const parsed = dependencySnapshotSchema.safeParse(value);
  if (!parsed.success) throw new EventDependencySnapshotError('invalid_snapshot');
  if (parsed.data.contributor.key !== expected.key || parsed.data.contributor.version !== expected.version) {
    throw new EventDependencySnapshotError('wrong_contributor');
  }
  if (parsed.data.scope.workspaceId !== scope.workspaceId || parsed.data.scope.eventId !== scope.eventId) {
    throw new EventDependencySnapshotError('wrong_scope');
  }
  const referenceKeys = parsed.data.dependencies.map((entry) => entry.referenceKey);
  if (new Set(referenceKeys).size !== referenceKeys.length) {
    throw new EventDependencySnapshotError('duplicate_reference');
  }
  return deepFreeze({
    contributor: { ...parsed.data.contributor },
    scope,
    guard: {
      id: parsed.data.guard.id,
      version: parseAggregateVersion(parsed.data.guard.version),
      digest: parsed.data.guard.digest
    },
    dependencies: parsed.data.dependencies
      .map((entry): EventDependencyRecord => ({
        referenceKey: entry.referenceKey,
        version: parseAggregateVersion(entry.version),
        destination: { ...entry.destination }
      }))
      .sort((left, right) => left.referenceKey.localeCompare(right.referenceKey))
  });
}

export function createEventDependencyContributorRegistry(input: {
  readonly expected: readonly EventDependencyContributorRef[];
  readonly contributors: readonly EventDependencyContributorRef[];
}): EventDependencyContributorRegistry {
  const issues: EventDependencyRegistryIssue[] = [];
  const expected = new Map<string, EventDependencyContributorRef>();
  const contributors = new Map<string, EventDependencyContributorRef>();
  for (const raw of input.expected) {
    const parsed = parseContributor(raw);
    if (!parsed) issues.push({ code: 'invalid_contributor', key: String(raw.key) });
    else if (expected.has(parsed.key)) issues.push({ code: 'duplicate_expected', key: parsed.key });
    else expected.set(parsed.key, parsed);
  }
  for (const raw of input.contributors) {
    const parsed = parseContributor(raw);
    if (!parsed) issues.push({ code: 'invalid_contributor', key: String(raw.key) });
    else if (contributors.has(parsed.key)) issues.push({ code: 'duplicate_contributor', key: parsed.key });
    else contributors.set(parsed.key, parsed);
  }
  for (const [key, expectedContributor] of expected) {
    const contributor = contributors.get(key);
    if (!contributor) issues.push({ code: 'missing_contributor', key });
    else if (contributor.version !== expectedContributor.version) issues.push({ code: 'wrong_version', key });
  }
  for (const key of contributors.keys()) {
    if (!expected.has(key)) issues.push({ code: 'unexpected_contributor', key });
  }
  if (issues.length > 0) throw new EventDependencyRegistryValidationError(issues);

  const ordered = [...contributors.values()]
    .sort((left, right) => identity(left).localeCompare(identity(right)));
  const registryDigestSha256 = sha256({ schemaVersion: 1, contributors: ordered });
  const registry: EventDependencyContributorRegistry = Object.freeze({
    registryDigestSha256,
    contributors: Object.freeze(ordered),
    capture(scope: EventDependencyScope, source: EventDependencySnapshotSource) {
      const canonicalScope = Object.freeze({
        workspaceId: parseWorkspaceId(scope.workspaceId),
        eventId: parseEventId(scope.eventId)
      });
      const snapshots = ordered.map((contributor) => {
        const value = source.readContributor(contributor, canonicalScope);
        if (value && typeof value === 'object'
            && typeof (value as { readonly then?: unknown }).then === 'function') {
          throw new EventDependencySnapshotError('invalid_snapshot');
        }
        return parseSnapshot(value, contributor, canonicalScope);
      });
      const guardIds = snapshots.map((snapshot) => snapshot.guard.id);
      if (new Set(guardIds).size !== guardIds.length) {
        throw new EventDependencySnapshotError('duplicate_guard');
      }
      return deepFreeze({
        [completeEventDependencySnapshot]: true as const,
        registryDigestSha256,
        contributors: snapshots
      });
    }
  });
  eventDependencyRegistries.add(registry);
  return registry;
}

/** Captures current dependency evidence only through a registry created by this module. */
export function captureRegisteredEventDependencies(input: {
  readonly registry: EventDependencyContributorRegistry;
  readonly scope: EventDependencyScope;
  readonly source: EventDependencySnapshotSource;
}): CompleteEventDependencySnapshot {
  if (!eventDependencyRegistries.has(input.registry)) {
    throw new EventDependencySnapshotError('invalid_registry');
  }
  return input.registry.capture(input.scope, input.source);
}

/** Rejects copied registries even when their visible catalog bytes are identical. */
export function assertEventDependencyContributorRegistry(
  candidate: EventDependencyContributorRegistry
): void {
  if (!eventDependencyRegistries.has(candidate)) {
    throw new EventDependencySnapshotError('invalid_registry');
  }
}

export function eventDependencyCount(snapshot: CompleteEventDependencySnapshot): number {
  return snapshot.contributors.reduce(
    (count, contributor) => count + contributor.dependencies.length,
    0
  );
}

export function isCompleteEventDependencySnapshot(
  value: CompleteEventDependencySnapshot | undefined
): value is CompleteEventDependencySnapshot {
  return value?.[completeEventDependencySnapshot] === true;
}


function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
