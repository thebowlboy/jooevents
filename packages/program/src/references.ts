import { createHash } from 'node:crypto';
import {
  programVocabularyIdSchema,
  programVocabularyKindSchema,
  programVocabularyScopeSchema,
  versionedDefinitionRefSchema,
  type ProgramVocabularyKind
} from '@jooevents/contracts';
import { encodeCanonicalJson, parseAggregateVersion, type AggregateVersion } from '@jooevents/kernel';
import { z } from 'zod';
import {
  resolveProgramVocabularyItem,
  sameProgramVocabularyScope,
  type ProgramVocabularyScope,
  type ProgramVocabularyState
} from './model';

const stableKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const digest = /^[a-f0-9]{64}$/;

export interface ProgramReferenceContributorRef {
  readonly key: string;
  readonly version: number;
}

export interface SafeProgramReferenceDestination {
  readonly kind: string;
  readonly id: string;
}

export interface ProgramReferenceRecord {
  readonly referenceKey: string;
  readonly version: AggregateVersion;
  readonly item: { readonly kind: ProgramVocabularyKind; readonly id: string };
  readonly mode: 'current' | 'historical';
  readonly destination: SafeProgramReferenceDestination;
}

export interface ProgramReferenceContributorSnapshot {
  readonly contributor: ProgramReferenceContributorRef;
  readonly scope: ProgramVocabularyScope;
  readonly guard: { readonly id: string; readonly version: AggregateVersion; readonly digest: string };
  readonly references: readonly ProgramReferenceRecord[];
}

export interface CompleteProgramReferenceSnapshot {
  readonly registryDigestSha256: string;
  readonly contributors: readonly ProgramReferenceContributorSnapshot[];
}

export interface ProgramReferenceContributorRegistry {
  readonly registryDigestSha256: string;
  readonly contributors: readonly ProgramReferenceContributorRef[];
  capture(
    scope: ProgramVocabularyScope,
    source: ProgramReferenceSnapshotSource
  ): CompleteProgramReferenceSnapshot;
}

export interface ProgramReferenceSnapshotSource {
  readContributor(
    contributor: ProgramReferenceContributorRef,
    scope: ProgramVocabularyScope
  ): unknown;
}

export interface ProgramReferenceRegistryIssue {
  readonly code: 'duplicate_expected' | 'duplicate_contributor' | 'missing_contributor' | 'unexpected_contributor' | 'wrong_version' | 'invalid_contributor';
  readonly key: string;
}

export class ProgramReferenceRegistryValidationError extends Error {
  readonly issues: readonly ProgramReferenceRegistryIssue[];

  constructor(issues: readonly ProgramReferenceRegistryIssue[]) {
    super(`Program reference registry failed with ${issues.length} issue(s).`);
    this.name = 'ProgramReferenceRegistryValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

export class ProgramReferenceSnapshotError extends Error {
  readonly code: 'missing_contributor' | 'invalid_snapshot' | 'wrong_contributor' | 'wrong_scope' | 'duplicate_reference' | 'duplicate_guard' | 'unknown_item';

  constructor(code: ProgramReferenceSnapshotError['code']) {
    super(code);
    this.name = 'ProgramReferenceSnapshotError';
    this.code = code;
  }
}

const referenceSchema = z.strictObject({
  referenceKey: z.string().trim().min(1).max(300),
  version: z.number().int().positive(),
  item: z.strictObject({
    kind: programVocabularyKindSchema,
    id: programVocabularyIdSchema
  }),
  mode: z.enum(['current', 'historical']),
  destination: z.strictObject({
    kind: z.string().trim().min(1).max(160).regex(stableKey),
    id: z.string().trim().min(1).max(300)
  })
});

const contributorSnapshotSchema = z.strictObject({
  contributor: versionedDefinitionRefSchema,
  scope: programVocabularyScopeSchema,
  guard: z.strictObject({
    id: z.string().regex(/^program_reference:[A-Za-z0-9._~:-]+$/),
    version: z.number().int().positive(),
    digest: z.string().regex(digest)
  }),
  references: z.array(referenceSchema)
});

function contributorIdentity(contributor: ProgramReferenceContributorRef): string {
  return `${contributor.key}@${contributor.version}`;
}

function parseContributor(value: ProgramReferenceContributorRef): ProgramReferenceContributorRef | undefined {
  if (!stableKey.test(value.key) || !Number.isSafeInteger(value.version) || value.version <= 0) return undefined;
  return Object.freeze({ key: value.key, version: value.version });
}

function sha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function parseSnapshot(
  value: unknown,
  expected: ProgramReferenceContributorRef,
  scope: ProgramVocabularyScope
): ProgramReferenceContributorSnapshot {
  if (value === undefined) throw new ProgramReferenceSnapshotError('missing_contributor');
  const parsed = contributorSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new ProgramReferenceSnapshotError('invalid_snapshot');
  if (parsed.data.contributor.key !== expected.key || parsed.data.contributor.version !== expected.version) {
    throw new ProgramReferenceSnapshotError('wrong_contributor');
  }
  if (parsed.data.scope.workspaceId !== scope.workspaceId || parsed.data.scope.eventId !== scope.eventId) {
    throw new ProgramReferenceSnapshotError('wrong_scope');
  }
  const keys = parsed.data.references.map((reference) => reference.referenceKey);
  if (new Set(keys).size !== keys.length) throw new ProgramReferenceSnapshotError('duplicate_reference');
  return deepFreeze({
    contributor: { ...parsed.data.contributor },
    scope,
    guard: {
      id: parsed.data.guard.id,
      version: parseAggregateVersion(parsed.data.guard.version),
      digest: parsed.data.guard.digest
    },
    references: parsed.data.references
      .map((reference): ProgramReferenceRecord => ({
        referenceKey: reference.referenceKey,
        version: parseAggregateVersion(reference.version),
        item: { ...reference.item },
        mode: reference.mode,
        destination: { ...reference.destination }
      }))
      .sort((left, right) => left.referenceKey.localeCompare(right.referenceKey))
  });
}

export function createProgramReferenceContributorRegistry(input: {
  readonly expected: readonly ProgramReferenceContributorRef[];
  readonly contributors: readonly ProgramReferenceContributorRef[];
}): ProgramReferenceContributorRegistry {
  const issues: ProgramReferenceRegistryIssue[] = [];
  const expected = new Map<string, ProgramReferenceContributorRef>();
  const contributors = new Map<string, ProgramReferenceContributorRef>();
  for (const raw of input.expected) {
    const parsed = parseContributor(raw);
    if (!parsed) {
      issues.push({ code: 'invalid_contributor', key: String(raw.key) });
      continue;
    }
    if (expected.has(parsed.key)) issues.push({ code: 'duplicate_expected', key: parsed.key });
    else expected.set(parsed.key, parsed);
  }
  for (const raw of input.contributors) {
    const parsed = parseContributor(raw);
    if (!parsed) {
      issues.push({ code: 'invalid_contributor', key: String(raw.key) });
      continue;
    }
    if (contributors.has(parsed.key)) issues.push({ code: 'duplicate_contributor', key: parsed.key });
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
  if (issues.length > 0) throw new ProgramReferenceRegistryValidationError(issues);

  const ordered = [...contributors.values()].sort((left, right) => contributorIdentity(left).localeCompare(contributorIdentity(right)));
  const registryDigestSha256 = sha256({ schemaVersion: 1, contributors: ordered });
  return Object.freeze({
    registryDigestSha256,
    contributors: Object.freeze(ordered),
    capture(scope: ProgramVocabularyScope, source: ProgramReferenceSnapshotSource) {
      const snapshots = ordered.map((contributor) => parseSnapshot(
        source.readContributor(contributor, scope),
        contributor,
        scope
      ));
      const guardIds = snapshots.map((snapshot) => snapshot.guard.id);
      if (new Set(guardIds).size !== guardIds.length) {
        throw new ProgramReferenceSnapshotError('duplicate_guard');
      }
      return deepFreeze({
        registryDigestSha256,
        contributors: snapshots
      });
    }
  });
}

export function validateProgramReferenceTargets(
  state: ProgramVocabularyState,
  snapshot: CompleteProgramReferenceSnapshot
): void {
  for (const contributor of snapshot.contributors) {
    if (!sameProgramVocabularyScope(state.scope, contributor.scope)) {
      throw new ProgramReferenceSnapshotError('wrong_scope');
    }
    for (const reference of contributor.references) {
      if (!resolveProgramVocabularyItem(state, reference.item.kind, reference.item.id)) {
        throw new ProgramReferenceSnapshotError('unknown_item');
      }
    }
  }
}

export function programReferenceUsage(
  snapshot: CompleteProgramReferenceSnapshot,
  item: { readonly kind: ProgramVocabularyKind; readonly id: string }
): { readonly current: number; readonly historicalPins: number } {
  let current = 0;
  let historicalPins = 0;
  for (const contributor of snapshot.contributors) {
    for (const reference of contributor.references) {
      if (reference.item.kind !== item.kind || reference.item.id !== item.id) continue;
      if (reference.mode === 'current') current += 1;
      else historicalPins += 1;
    }
  }
  return Object.freeze({ current, historicalPins });
}

export function sameContributorGuard(
  left: {
    readonly contributor: ProgramReferenceContributorRef;
    readonly guard: { readonly id: string; readonly version: number; readonly digest: string };
  },
  right: {
    readonly contributor: ProgramReferenceContributorRef;
    readonly guard: { readonly id: string; readonly version: number; readonly digest: string };
  }
): boolean {
  return left.contributor.key === right.contributor.key
    && left.contributor.version === right.contributor.version
    && left.guard.id === right.guard.id
    && left.guard.version === right.guard.version
    && left.guard.digest === right.guard.digest;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
