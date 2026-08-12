import type {
  ChangesetSchemaRef,
  ChangesetRevision,
  CommittedChangesetSource,
  CompensationLineage,
  DependencyGroup,
  FrozenChangesetOperation
} from './engine';
import { resolveCommittedChangesetSource } from './commit-authorization';
import {
  planChangesetOperation,
  type ChangesetDefinitionRegistry,
  type ChangesetPlanningSnapshot,
  type ChangesetReadPortKey,
  type CompensationDerivation
} from './definitions';

const stableKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface CompensationNote {
  readonly lineage: CompensationLineage;
  readonly noteKey: string;
}

export interface CompensationConflict {
  readonly lineage: CompensationLineage;
  readonly conflictKeys: readonly string[];
}

export interface CompensationBlocker {
  readonly lineage: CompensationLineage;
  readonly reasonKey: string;
}

export interface CompensationRemediation {
  readonly lineage: CompensationLineage;
  readonly remediationKey: string;
}

export interface CompensatingChangesetDraft {
  readonly source: {
    readonly changesetId: string;
    readonly id: string;
    readonly digest: string;
    readonly commitReceiptId: string;
  };
  readonly operations: readonly FrozenChangesetOperation[];
  /** Dependencies are reversed so dependents compensate before their prerequisites. */
  readonly dependencyGroups: readonly DependencyGroup[];
}

export type CompensationPlanningResult =
  | { readonly kind: 'exact'; readonly draft: CompensatingChangesetDraft }
  | {
      readonly kind: 'semantic';
      readonly draft: CompensatingChangesetDraft;
      readonly notes: readonly CompensationNote[];
    }
  | {
      readonly kind: 'partial';
      readonly draft: CompensatingChangesetDraft;
      readonly conflicts: readonly CompensationConflict[];
      readonly notes: readonly CompensationNote[];
    }
  | {
      readonly kind: 'blocked';
      readonly blockers: readonly CompensationBlocker[];
      readonly remediations: readonly CompensationRemediation[];
    }
  | {
      readonly kind: 'irreversible';
      readonly draft: CompensatingChangesetDraft | null;
      readonly remediations: readonly CompensationRemediation[];
      readonly conflicts: readonly CompensationConflict[];
      readonly notes: readonly CompensationNote[];
    };

interface OrderedSourceOperation {
  readonly index: number;
  readonly operation: FrozenChangesetOperation;
  readonly lineage: CompensationLineage;
}

interface DerivedSourceOperation extends OrderedSourceOperation {
  readonly derivation: CompensationDerivation<unknown>;
}

function portIdentity(port: { readonly key: string; readonly version: number }): string {
  return `${port.key}\u0000${port.version}`;
}

function sameSchemaReference(left: ChangesetSchemaRef, right: ChangesetSchemaRef): boolean {
  return left.key === right.key
    && left.version === right.version
    && left.digestSha256 === right.digestSha256;
}

function restrictSnapshot(
  definition: { readonly readPorts: readonly ChangesetReadPortKey<any>[] },
  snapshot: ChangesetPlanningSnapshot
): ChangesetPlanningSnapshot {
  const allowed = new Set(definition.readPorts.map(portIdentity));
  return Object.freeze({
    getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
      if (!allowed.has(portIdentity(key))) throw new TypeError('undeclared_changeset_read_port');
      return snapshot.getPort(key);
    }
  });
}

function assertStableDetailKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !stableKey.test(value)) {
    throw new TypeError(`${label} must be a stable key`);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError('invalid_compensation_derivation');
  }
}

function parseDerivation(value: unknown): CompensationDerivation<unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid_compensation_derivation');
  }
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case 'exact':
      assertExactKeys(candidate, ['kind', 'authorInput']);
      return { kind: 'exact', authorInput: candidate.authorInput };
    case 'semantic':
      assertExactKeys(candidate, ['kind', 'authorInput', 'noteKey']);
      assertStableDetailKey(candidate.noteKey, 'compensation note');
      return { kind: 'semantic', authorInput: candidate.authorInput, noteKey: candidate.noteKey };
    case 'partial': {
      assertExactKeys(candidate, ['kind', 'authorInput', 'conflicts']);
      if (!Array.isArray(candidate.conflicts) || candidate.conflicts.length === 0) {
        throw new TypeError('partial compensation requires explicit conflicts');
      }
      const conflicts = candidate.conflicts.map((conflict) => {
        assertStableDetailKey(conflict, 'compensation conflict');
        return conflict;
      });
      if (new Set(conflicts).size !== conflicts.length) {
        throw new TypeError('partial compensation conflicts must be unique');
      }
      return { kind: 'partial', authorInput: candidate.authorInput, conflicts };
    }
    case 'blocked':
      assertExactKeys(candidate, ['kind', 'reasonKey']);
      assertStableDetailKey(candidate.reasonKey, 'compensation blocker');
      return { kind: 'blocked', reasonKey: candidate.reasonKey };
    case 'irreversible': {
      const hasAuthorInput = Object.hasOwn(candidate, 'authorInput');
      assertExactKeys(
        candidate,
        hasAuthorInput ? ['kind', 'remediationKey', 'authorInput'] : ['kind', 'remediationKey']
      );
      assertStableDetailKey(candidate.remediationKey, 'compensation remediation');
      if (hasAuthorInput && candidate.authorInput === undefined) {
        throw new TypeError('irreversible compensation author input cannot be undefined');
      }
      return hasAuthorInput
        ? {
            kind: 'irreversible',
            remediationKey: candidate.remediationKey,
            authorInput: candidate.authorInput
          }
        : { kind: 'irreversible', remediationKey: candidate.remediationKey };
    }
    default:
      throw new TypeError('invalid_compensation_derivation');
  }
}

function sourceLineage(
  revision: ChangesetRevision,
  operation: FrozenChangesetOperation,
  index: number
): CompensationLineage {
  return Object.freeze({
    sourceRevisionId: revision.id,
    sourceRevisionDigest: revision.digest,
    sourceOperationIndex: index,
    sourceOperationKind: operation.kind,
    sourceOperationVersion: operation.version,
    sourceDependencyGroup: operation.dependencyGroup
  });
}

function reverseCompensationOrder(revision: ChangesetRevision): {
  readonly operations: readonly OrderedSourceOperation[];
  readonly dependencyGroups: readonly DependencyGroup[];
} {
  const groups = new Map<string, {
    readonly group: DependencyGroup;
    readonly declarationIndex: number;
    readonly operationIndices: number[];
  }>();
  revision.dependencyGroups.forEach((group, declarationIndex) => {
    if (!group.key || groups.has(group.key)) throw new TypeError('invalid_compensation_dependency_groups');
    groups.set(group.key, { group, declarationIndex, operationIndices: [] });
  });
  revision.operations.forEach((operation, index) => {
    const group = groups.get(operation.dependencyGroup);
    if (group === undefined) throw new TypeError('invalid_compensation_dependency_group');
    group.operationIndices.push(index);
  });

  const compensationDependsOn = new Map<string, Set<string>>(
    [...groups.keys()].map((key) => [key, new Set<string>()])
  );
  const compensationDependents = new Map<string, Set<string>>(
    [...groups.keys()].map((key) => [key, new Set<string>()])
  );
  for (const { group } of groups.values()) {
    const sourceDependencies = new Set<string>();
    for (const dependency of group.dependsOn) {
      if (!groups.has(dependency) || dependency === group.key || sourceDependencies.has(dependency)) {
        throw new TypeError('invalid_compensation_dependency_groups');
      }
      sourceDependencies.add(dependency);
      // Source G depends on D, therefore compensating D depends on compensating G.
      compensationDependsOn.get(dependency)!.add(group.key);
      compensationDependents.get(group.key)!.add(dependency);
    }
  }

  const maximumOperationIndex = (key: string): number => {
    const indices = groups.get(key)!.operationIndices;
    return indices.length === 0 ? -1 : Math.max(...indices);
  };
  const compareReady = (left: string, right: string): number =>
    maximumOperationIndex(right) - maximumOperationIndex(left)
    || groups.get(right)!.declarationIndex - groups.get(left)!.declarationIndex
    || (left < right ? -1 : left > right ? 1 : 0);

  const ready = [...groups.keys()]
    .filter((key) => compensationDependsOn.get(key)!.size === 0)
    .sort(compareReady);
  const groupOrder: string[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    groupOrder.push(key);
    for (const dependent of compensationDependents.get(key)!) {
      const dependencies = compensationDependsOn.get(dependent)!;
      dependencies.delete(key);
      if (dependencies.size === 0) {
        ready.push(dependent);
        ready.sort(compareReady);
      }
    }
  }
  if (groupOrder.length !== groups.size) throw new TypeError('cyclic_compensation_dependency_groups');

  const orderIndex = new Map(groupOrder.map((key, index) => [key, index]));
  const dependencyGroups = groupOrder.map((key) => ({
    key,
    dependsOn: [...compensationDependsOnForSource(key, revision.dependencyGroups)]
      .sort((left, right) => orderIndex.get(left)! - orderIndex.get(right)!)
  }));
  const operations: OrderedSourceOperation[] = [];
  for (const key of groupOrder) {
    const indices = [...groups.get(key)!.operationIndices].sort((left, right) => right - left);
    for (const index of indices) {
      const operation = revision.operations[index]!;
      operations.push({ index, operation, lineage: sourceLineage(revision, operation, index) });
    }
  }
  return { operations, dependencyGroups };
}

function compensationDependsOnForSource(
  key: string,
  groups: readonly DependencyGroup[]
): ReadonlySet<string> {
  const dependencies = new Set<string>();
  for (const group of groups) {
    if (group.dependsOn.includes(key)) dependencies.add(group.key);
  }
  return dependencies;
}

function noteFor(entry: DerivedSourceOperation): CompensationNote | undefined {
  return entry.derivation.kind === 'semantic'
    ? { lineage: entry.lineage, noteKey: entry.derivation.noteKey }
    : undefined;
}

function conflictFor(entry: DerivedSourceOperation): CompensationConflict | undefined {
  return entry.derivation.kind === 'partial'
    ? { lineage: entry.lineage, conflictKeys: entry.derivation.conflicts }
    : undefined;
}

function remediationFor(entry: DerivedSourceOperation): CompensationRemediation | undefined {
  return entry.derivation.kind === 'irreversible'
    ? { lineage: entry.lineage, remediationKey: entry.derivation.remediationKey }
    : undefined;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Plans a new compensating draft. It never mutates the source revision or effective
 * state and never bypasses the registered author schema or normal planner.
 */
export async function planChangesetCompensation(input: {
  readonly registry: ChangesetDefinitionRegistry;
  readonly source: CommittedChangesetSource;
  readonly snapshot: ChangesetPlanningSnapshot;
}): Promise<CompensationPlanningResult> {
  const committedSource = resolveCommittedChangesetSource(input.source);
  if (!committedSource) throw new TypeError('invalid_committed_changeset_source');
  const sourceRevision = committedSource.revision;
  const ordered = reverseCompensationOrder(sourceRevision);
  const derived: DerivedSourceOperation[] = [];
  for (const source of ordered.operations) {
    const definition = input.registry.get(source.operation.kind, source.operation.version);
    if (definition === undefined) throw new TypeError('unknown_compensation_definition');
    if (!sameSchemaReference(definition.schemas.plan, source.operation.planSchema)
        || !sameSchemaReference(definition.schemas.diff, source.operation.diffSchema)
        || !sameSchemaReference(definition.schemas.result, source.operation.resultSchema)) {
      throw new TypeError('changeset_definition_changed');
    }
    const planSchema = input.registry.getSchema(source.operation.planSchema);
    if (planSchema === undefined) throw new TypeError('compensation_plan_schema_missing');
    const sourcePlan = planSchema.schema.parse(source.operation.plan);
    const derivation = parseDerivation(
      await definition.deriveCompensation(
        sourcePlan,
        restrictSnapshot(definition, input.snapshot)
      )
    );
    derived.push({ ...source, derivation });
  }

  const remediations = derived.map(remediationFor).filter((value): value is CompensationRemediation => value !== undefined);
  const blockers = derived
    .filter((entry) => entry.derivation.kind === 'blocked')
    .map((entry) => ({ lineage: entry.lineage, reasonKey: (entry.derivation as Extract<CompensationDerivation<unknown>, { kind: 'blocked' }>).reasonKey }));
  if (blockers.length > 0) {
    return deepFreeze({ kind: 'blocked', blockers, remediations });
  }

  const hasUnplannableIrreversible = derived.some(
    (entry) => entry.derivation.kind === 'irreversible' && entry.derivation.authorInput === undefined
  );
  const notes = derived.map(noteFor).filter((value): value is CompensationNote => value !== undefined);
  const conflicts = derived.map(conflictFor).filter((value): value is CompensationConflict => value !== undefined);
  if (hasUnplannableIrreversible) {
    return deepFreeze({ kind: 'irreversible', draft: null, remediations, conflicts, notes });
  }

  const operations: FrozenChangesetOperation[] = [];
  for (const entry of derived) {
    if (entry.derivation.kind === 'blocked') throw new TypeError('unreachable_blocked_compensation');
    const authorInput = entry.derivation.authorInput;
    operations.push(await planChangesetOperation({
      registry: input.registry,
      kind: entry.operation.kind,
      version: entry.operation.version,
      authorInput,
      dependencyGroup: entry.operation.dependencyGroup,
      snapshot: input.snapshot,
      compensationLineage: entry.lineage
    }));
  }
  const draft = deepFreeze({
    source: {
      changesetId: committedSource.changesetId,
      id: sourceRevision.id,
      digest: sourceRevision.digest,
      commitReceiptId: committedSource.commitReceiptId
    },
    operations,
    dependencyGroups: ordered.dependencyGroups
  });
  if (remediations.length > 0) {
    return deepFreeze({ kind: 'irreversible', draft, remediations, conflicts, notes });
  }
  if (conflicts.length > 0) {
    return deepFreeze({ kind: 'partial', draft, conflicts, notes });
  }
  if (notes.length > 0) return deepFreeze({ kind: 'semantic', draft, notes });
  return deepFreeze({ kind: 'exact', draft });
}
