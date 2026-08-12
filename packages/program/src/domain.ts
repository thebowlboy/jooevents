import { createHash } from 'node:crypto';
import type {
  ProgramVocabularyDraftInput,
  ProgramVocabularyKind,
  ProgramVocabularyMergeDraftInput,
  ProgramVocabularyScopeDto,
  ProgramVocabularyStatus
} from '@jooevents/contracts';
import {
  encodeCanonicalJson,
  parseAggregateVersion,
  type AggregateVersion
} from '@jooevents/kernel';
import {
  createProgramVocabularyState,
  nextAggregateVersion,
  normalizeProgramVocabularyName,
  parseProgramVocabularyId,
  parseRoomCapacity,
  programVocabularyItems,
  resolveProgramVocabularyItem,
  sameProgramVocabularyScope,
  type ProgramVocabularyItem,
  type ProgramVocabularyScope,
  type ProgramVocabularyState
} from './model';
import {
  programReferenceUsage,
  sameContributorGuard,
  validateProgramReferenceTargets,
  type CompleteProgramReferenceSnapshot,
  type ProgramReferenceContributorRef,
  type ProgramReferenceContributorRegistry,
  type ProgramReferenceContributorSnapshot,
  type ProgramReferenceSnapshotSource,
  type SafeProgramReferenceDestination
} from './references';

export type PlannedProgramVocabularyItem =
  | {
      readonly kind: 'room';
      readonly id: string;
      readonly name: string;
      readonly status: ProgramVocabularyStatus;
      readonly version: number;
      readonly capacity: number | null;
    }
  | {
      readonly kind: 'track';
      readonly id: string;
      readonly name: string;
      readonly status: ProgramVocabularyStatus;
      readonly version: number;
    }
  | {
      readonly kind: 'format';
      readonly id: string;
      readonly name: string;
      readonly status: ProgramVocabularyStatus;
      readonly version: number;
    };

export interface ProgramReferenceRepoint {
  readonly referenceKey: string;
  readonly expectedVersion: number;
  readonly from: { readonly kind: ProgramVocabularyKind; readonly id: string };
  readonly to: { readonly kind: ProgramVocabularyKind; readonly id: string };
  readonly destination: SafeProgramReferenceDestination;
}

export interface ProgramHistoricalPin {
  readonly referenceKey: string;
  readonly version: number;
  readonly item: { readonly kind: ProgramVocabularyKind; readonly id: string };
  readonly destination: SafeProgramReferenceDestination;
}

export interface ProgramReferenceContributionPlan {
  readonly contributor: ProgramReferenceContributorRef;
  readonly guard: { readonly id: string; readonly version: number; readonly digest: string };
  readonly liveRepoints: readonly ProgramReferenceRepoint[];
  readonly historicalPins: readonly ProgramHistoricalPin[];
}

interface PlanBase {
  readonly scope: ProgramVocabularyScopeDto;
  readonly expectedSetVersion: number;
  readonly setGuardDigest: string;
}

export interface ProgramCreatePlan extends PlanBase {
  readonly action: 'create';
  readonly after: PlannedProgramVocabularyItem;
}

export interface ProgramEditPlan extends PlanBase {
  readonly action: 'edit';
  readonly before: PlannedProgramVocabularyItem;
  readonly after: PlannedProgramVocabularyItem;
}

export interface ProgramRetirePlan extends PlanBase {
  readonly action: 'retire';
  readonly before: PlannedProgramVocabularyItem;
  readonly after: PlannedProgramVocabularyItem;
}

export interface ProgramRestorePlan extends PlanBase {
  readonly action: 'restore';
  readonly before: PlannedProgramVocabularyItem;
  readonly after: PlannedProgramVocabularyItem;
}

export interface ProgramDeletePlan extends PlanBase {
  readonly action: 'delete';
  readonly before: PlannedProgramVocabularyItem;
  readonly referenceRegistryDigest: string;
  readonly references: readonly ProgramReferenceContributionPlan[];
}

export interface ProgramMergePlan extends PlanBase {
  readonly action: 'merge';
  readonly sourceBefore: PlannedProgramVocabularyItem;
  readonly sourceAfter: PlannedProgramVocabularyItem;
  readonly target: PlannedProgramVocabularyItem;
  readonly referenceRegistryDigest: string;
  readonly references: readonly ProgramReferenceContributionPlan[];
}

export interface ProgramMergeCompensationPlan extends PlanBase {
  readonly action: 'merge_compensation';
  readonly sourceBefore: PlannedProgramVocabularyItem;
  readonly sourceAfter: PlannedProgramVocabularyItem;
  readonly target: PlannedProgramVocabularyItem;
  readonly restoreSource: boolean;
  readonly referenceRegistryDigest: string;
  readonly references: readonly ProgramReferenceContributionPlan[];
}

export type ProgramVocabularyMutationPlan =
  | ProgramCreatePlan
  | ProgramEditPlan
  | ProgramRetirePlan
  | ProgramRestorePlan
  | ProgramDeletePlan
  | ProgramMergePlan
  | ProgramMergeCompensationPlan;

export interface ProgramMergeCompensationInput {
  readonly action: 'merge_compensation';
  readonly scope: ProgramVocabularyScopeDto;
  readonly kind: ProgramVocabularyKind;
  readonly sourceId: string;
  readonly targetId: string;
  readonly expectedSetVersion: number;
  readonly expectedSourceVersion: number;
  readonly expectedTargetVersion: number;
  readonly restoreSource: boolean;
  readonly references: readonly {
    readonly contributor: ProgramReferenceContributorRef;
    readonly referenceKeys: readonly string[];
  }[];
}

export type ProgramVocabularyAuthorInput = ProgramVocabularyDraftInput | ProgramMergeCompensationInput;

export type ProgramVocabularyPlanningErrorCode =
  | 'wrong_scope'
  | 'stale_set'
  | 'item_exists'
  | 'item_missing'
  | 'stale_item'
  | 'invalid_transition'
  | 'delete_referenced'
  | 'invalid_merge'
  | 'stale_reference';

export class ProgramVocabularyPlanningError extends Error {
  readonly code: ProgramVocabularyPlanningErrorCode;

  constructor(code: ProgramVocabularyPlanningErrorCode) {
    super(code);
    this.name = 'ProgramVocabularyPlanningError';
    this.code = code;
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function scopeDto(scope: ProgramVocabularyScope): ProgramVocabularyScopeDto {
  return { workspaceId: scope.workspaceId, eventId: scope.eventId };
}

function sameScopeDto(scope: ProgramVocabularyScope, dto: ProgramVocabularyScopeDto): boolean {
  return scope.workspaceId === dto.workspaceId && scope.eventId === dto.eventId;
}

export function plannedProgramVocabularyItem(item: ProgramVocabularyItem): PlannedProgramVocabularyItem {
  if (item.kind === 'room') {
    return Object.freeze({
      kind: 'room', id: item.id, name: item.name, status: item.status,
      version: item.version, capacity: item.capacity
    });
  }
  if (item.kind === 'track') {
    return Object.freeze({
      kind: 'track', id: item.id, name: item.name, status: item.status, version: item.version
    });
  }
  return Object.freeze({
    kind: 'format', id: item.id, name: item.name, status: item.status, version: item.version
  });
}

function itemDigest(item: ProgramVocabularyItem | PlannedProgramVocabularyItem): string {
  return sha256('scope' in item ? plannedProgramVocabularyItem(item) : item);
}

export function programVocabularySetDigest(state: ProgramVocabularyState): string {
  return sha256({
    scope: scopeDto(state.scope),
    setVersion: state.setVersion,
    items: programVocabularyItems(state).map(plannedProgramVocabularyItem)
  });
}

export function programVocabularyAggregateId(item: Pick<PlannedProgramVocabularyItem, 'kind' | 'id'>): string {
  return `program_${item.kind}:${item.id}`;
}

export function programVocabularySetGuardId(eventId: string): string {
  return `program_vocabulary_set:${eventId}`;
}

function requireSetGuard(state: ProgramVocabularyState, scope: ProgramVocabularyScopeDto, expected: number): void {
  if (!sameScopeDto(state.scope, scope)) throw new ProgramVocabularyPlanningError('wrong_scope');
  if (state.setVersion !== expected) throw new ProgramVocabularyPlanningError('stale_set');
}

function requireItem(
  state: ProgramVocabularyState,
  kind: ProgramVocabularyKind,
  id: string,
  expectedVersion: number
): ProgramVocabularyItem {
  const item = resolveProgramVocabularyItem(state, kind, id);
  if (!item) throw new ProgramVocabularyPlanningError('item_missing');
  if (item.version !== expectedVersion) throw new ProgramVocabularyPlanningError('stale_item');
  return item;
}

function commonPlan(state: ProgramVocabularyState): Pick<PlanBase, 'scope' | 'expectedSetVersion' | 'setGuardDigest'> {
  return {
    scope: scopeDto(state.scope),
    expectedSetVersion: state.setVersion,
    setGuardDigest: programVocabularySetDigest(state)
  };
}

function contributorPlan(
  contributor: ProgramReferenceContributorSnapshot,
  source: { readonly kind: ProgramVocabularyKind; readonly id: string },
  target?: { readonly kind: ProgramVocabularyKind; readonly id: string },
  selectedKeys?: ReadonlySet<string>
): ProgramReferenceContributionPlan {
  const liveRepoints: ProgramReferenceRepoint[] = [];
  const historicalPins: ProgramHistoricalPin[] = [];
  for (const reference of contributor.references) {
    if (reference.item.kind !== source.kind || reference.item.id !== source.id) continue;
    if (reference.mode === 'historical') {
      historicalPins.push({
        referenceKey: reference.referenceKey,
        version: reference.version,
        item: { ...reference.item },
        destination: { ...reference.destination }
      });
    } else if (target && (selectedKeys === undefined || selectedKeys.has(reference.referenceKey))) {
      liveRepoints.push({
        referenceKey: reference.referenceKey,
        expectedVersion: reference.version,
        from: { ...reference.item },
        to: { kind: target.kind, id: target.id },
        destination: { ...reference.destination }
      });
    }
  }
  return deepFreeze({
    contributor: { ...contributor.contributor },
    guard: { ...contributor.guard },
    liveRepoints,
    historicalPins
  });
}

function captureReferences(
  state: ProgramVocabularyState,
  registry: ProgramReferenceContributorRegistry,
  source: ProgramReferenceSnapshotSource
): CompleteProgramReferenceSnapshot {
  const snapshot = registry.capture(state.scope, source);
  validateProgramReferenceTargets(state, snapshot);
  return snapshot;
}

function planCreate(
  input: Extract<ProgramVocabularyDraftInput, { readonly action: 'create' }>,
  state: ProgramVocabularyState
): ProgramCreatePlan {
  requireSetGuard(state, input.scope, input.expectedSetVersion);
  if (resolveProgramVocabularyItem(state, input.item.kind, input.item.id)) {
    throw new ProgramVocabularyPlanningError('item_exists');
  }
  const id = parseProgramVocabularyId(input.item.kind, input.item.id);
  const after: PlannedProgramVocabularyItem = input.item.kind === 'room'
    ? {
        kind: 'room', id, name: normalizeProgramVocabularyName(input.item.name),
        status: 'active', version: 1, capacity: parseRoomCapacity(input.item.capacity)
      }
    : input.item.kind === 'track'
      ? {
          kind: 'track', id, name: normalizeProgramVocabularyName(input.item.name),
          status: 'active', version: 1
        }
      : {
          kind: 'format', id, name: normalizeProgramVocabularyName(input.item.name),
          status: 'active', version: 1
        };
  return deepFreeze({ action: 'create', ...commonPlan(state), after });
}

function planEdit(
  input: Extract<ProgramVocabularyDraftInput, { readonly action: 'edit' }>,
  state: ProgramVocabularyState
): ProgramEditPlan {
  requireSetGuard(state, input.scope, input.expectedSetVersion);
  const item = requireItem(state, input.kind, input.id, input.expectedItemVersion);
  const before = plannedProgramVocabularyItem(item);
  const after: PlannedProgramVocabularyItem = {
    ...before,
    name: normalizeProgramVocabularyName(input.changes.name),
    version: nextAggregateVersion(item.version),
    ...(item.kind === 'room'
      ? { capacity: parseRoomCapacity((input.changes as { readonly capacity: number | null }).capacity) }
      : {})
  };
  return deepFreeze({ action: 'edit', ...commonPlan(state), before, after });
}

function planLifecycle(
  input: Extract<ProgramVocabularyDraftInput, { readonly action: 'retire' | 'restore' }>,
  state: ProgramVocabularyState
): ProgramRetirePlan | ProgramRestorePlan {
  requireSetGuard(state, input.scope, input.expectedSetVersion);
  const item = requireItem(state, input.kind, input.id, input.expectedItemVersion);
  const required = input.action === 'retire' ? 'active' : 'retired';
  if (item.status !== required) throw new ProgramVocabularyPlanningError('invalid_transition');
  const before = plannedProgramVocabularyItem(item);
  const after: PlannedProgramVocabularyItem = {
    ...before,
    status: input.action === 'retire' ? 'retired' : 'active',
    version: nextAggregateVersion(item.version)
  };
  return deepFreeze({ action: input.action, ...commonPlan(state), before, after }) as ProgramRetirePlan | ProgramRestorePlan;
}

function planDelete(
  input: Extract<ProgramVocabularyDraftInput, { readonly action: 'delete' }>,
  state: ProgramVocabularyState,
  registry: ProgramReferenceContributorRegistry,
  source: ProgramReferenceSnapshotSource
): ProgramDeletePlan {
  requireSetGuard(state, input.scope, input.expectedSetVersion);
  const item = requireItem(state, input.kind, input.id, input.expectedItemVersion);
  const references = captureReferences(state, registry, source);
  const usage = programReferenceUsage(references, item);
  if (usage.current !== 0 || usage.historicalPins !== 0) {
    throw new ProgramVocabularyPlanningError('delete_referenced');
  }
  return deepFreeze({
    action: 'delete',
    ...commonPlan(state),
    before: plannedProgramVocabularyItem(item),
    referenceRegistryDigest: references.registryDigestSha256,
    references: references.contributors.map((contributor) => contributorPlan(contributor, item))
  });
}

function planMerge(
  input: ProgramVocabularyMergeDraftInput,
  state: ProgramVocabularyState,
  registry: ProgramReferenceContributorRegistry,
  source: ProgramReferenceSnapshotSource
): ProgramMergePlan {
  requireSetGuard(state, input.scope, input.expectedSetVersion);
  if (input.sourceId === input.targetId) throw new ProgramVocabularyPlanningError('invalid_merge');
  const sourceItem = requireItem(state, input.kind, input.sourceId, input.expectedSourceVersion);
  const targetItem = requireItem(state, input.kind, input.targetId, input.expectedTargetVersion);
  if (targetItem.status !== 'active') throw new ProgramVocabularyPlanningError('invalid_merge');
  const references = captureReferences(state, registry, source);
  const sourceBefore = plannedProgramVocabularyItem(sourceItem);
  const sourceAfter: PlannedProgramVocabularyItem = {
    ...sourceBefore,
    status: 'retired',
    version: nextAggregateVersion(sourceItem.version)
  };
  return deepFreeze({
    action: 'merge',
    ...commonPlan(state),
    sourceBefore,
    sourceAfter,
    target: plannedProgramVocabularyItem(targetItem),
    referenceRegistryDigest: references.registryDigestSha256,
    references: references.contributors.map((contributor) => contributorPlan(
      contributor,
      sourceItem,
      targetItem
    ))
  });
}

function planMergeCompensation(
  input: ProgramMergeCompensationInput,
  state: ProgramVocabularyState,
  registry: ProgramReferenceContributorRegistry,
  source: ProgramReferenceSnapshotSource
): ProgramMergeCompensationPlan {
  requireSetGuard(state, input.scope, input.expectedSetVersion);
  const sourceItem = requireItem(state, input.kind, input.sourceId, input.expectedSourceVersion);
  const targetItem = requireItem(state, input.kind, input.targetId, input.expectedTargetVersion);
  const references = captureReferences(state, registry, source);
  const selected = new Map(input.references.map((entry) => [
    `${entry.contributor.key}@${entry.contributor.version}`,
    new Set(entry.referenceKeys)
  ]));
  const contributions = references.contributors.map((contributor) => {
    const selectedKeys = selected.get(`${contributor.contributor.key}@${contributor.contributor.version}`) ?? new Set<string>();
    const targetContribution = contributorPlan(contributor, targetItem, sourceItem, selectedKeys);
    const contribution: ProgramReferenceContributionPlan = {
      ...targetContribution,
      historicalPins: contributorPlan(contributor, sourceItem).historicalPins
    };
    if (contribution.liveRepoints.length !== selectedKeys.size) {
      throw new ProgramVocabularyPlanningError('stale_reference');
    }
    return contribution;
  });
  const sourceBefore = plannedProgramVocabularyItem(sourceItem);
  const sourceAfter: PlannedProgramVocabularyItem = input.restoreSource
    ? { ...sourceBefore, status: 'active', version: nextAggregateVersion(sourceItem.version) }
    : sourceBefore;
  return deepFreeze({
    action: 'merge_compensation',
    ...commonPlan(state),
    sourceBefore,
    sourceAfter,
    target: plannedProgramVocabularyItem(targetItem),
    restoreSource: input.restoreSource,
    referenceRegistryDigest: references.registryDigestSha256,
    references: contributions
  });
}

export function planProgramVocabularyMutation(input: {
  readonly authorInput: ProgramVocabularyAuthorInput;
  readonly state: ProgramVocabularyState;
  readonly referenceRegistry: ProgramReferenceContributorRegistry;
  readonly referenceSource: ProgramReferenceSnapshotSource;
}): ProgramVocabularyMutationPlan {
  switch (input.authorInput.action) {
    case 'create':
      return planCreate(input.authorInput, input.state);
    case 'edit':
      return planEdit(input.authorInput, input.state);
    case 'retire':
    case 'restore':
      return planLifecycle(input.authorInput, input.state);
    case 'delete':
      return planDelete(input.authorInput, input.state, input.referenceRegistry, input.referenceSource);
    case 'merge':
      return planMerge(input.authorInput, input.state, input.referenceRegistry, input.referenceSource);
    case 'merge_compensation':
      return planMergeCompensation(input.authorInput, input.state, input.referenceRegistry, input.referenceSource);
  }
}

function itemMatches(item: ProgramVocabularyItem | undefined, expected: PlannedProgramVocabularyItem): boolean {
  return item !== undefined && itemDigest(item) === itemDigest(expected);
}

export function validateProgramVocabularyPlan(
  state: ProgramVocabularyState,
  plan: ProgramVocabularyMutationPlan,
  registry: ProgramReferenceContributorRegistry,
  source: ProgramReferenceSnapshotSource
): ProgramVocabularyPlanningErrorCode | null {
  if (!sameScopeDto(state.scope, plan.scope)) return 'wrong_scope';
  if (state.setVersion !== plan.expectedSetVersion || programVocabularySetDigest(state) !== plan.setGuardDigest) {
    return 'stale_set';
  }
  if (plan.action === 'create') {
    return resolveProgramVocabularyItem(state, plan.after.kind, plan.after.id) ? 'item_exists' : null;
  }
  const expected = plan.action === 'merge' || plan.action === 'merge_compensation'
    ? plan.sourceBefore
    : plan.before;
  if (!itemMatches(resolveProgramVocabularyItem(state, expected.kind, expected.id), expected)) return 'stale_item';
  if (plan.action === 'merge' || plan.action === 'merge_compensation') {
    if (!itemMatches(resolveProgramVocabularyItem(state, plan.target.kind, plan.target.id), plan.target)) return 'stale_item';
  }
  if (plan.action === 'delete' || plan.action === 'merge' || plan.action === 'merge_compensation') {
    if (registry.registryDigestSha256 !== plan.referenceRegistryDigest) return 'stale_reference';
    let current: CompleteProgramReferenceSnapshot;
    try {
      current = captureReferences(state, registry, source);
    } catch {
      return 'stale_reference';
    }
    if (current.registryDigestSha256 !== plan.referenceRegistryDigest
        || current.contributors.length !== plan.references.length) return 'stale_reference';
    for (const expectedContributor of plan.references) {
      const actual = current.contributors.find((entry) =>
        entry.contributor.key === expectedContributor.contributor.key
        && entry.contributor.version === expectedContributor.contributor.version
      );
      if (!actual || !sameContributorGuard(actual, expectedContributor)) {
        return 'stale_reference';
      }
    }
  }
  return null;
}

function stateInputFrom(state: ProgramVocabularyState, items: readonly PlannedProgramVocabularyItem[]): Parameters<typeof createProgramVocabularyState>[0] {
  return {
    scope: scopeDto(state.scope),
    setVersion: state.setVersion + 1,
    rooms: items.filter((item): item is PlannedProgramVocabularyItem & { readonly kind: 'room' } => item.kind === 'room').map((item) => ({
      id: item.id,
      name: item.name,
      capacity: item.capacity ?? null,
      status: item.status,
      version: item.version
    })),
    tracks: items.filter((item): item is PlannedProgramVocabularyItem & { readonly kind: 'track' } => item.kind === 'track').map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      version: item.version
    })),
    formats: items.filter((item): item is PlannedProgramVocabularyItem & { readonly kind: 'format' } => item.kind === 'format').map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      version: item.version
    }))
  };
}

export function applyProgramVocabularyPlan(
  state: ProgramVocabularyState,
  plan: ProgramVocabularyMutationPlan
): ProgramVocabularyState {
  if (!sameScopeDto(state.scope, plan.scope) || state.setVersion !== plan.expectedSetVersion
      || programVocabularySetDigest(state) !== plan.setGuardDigest) {
    throw new ProgramVocabularyPlanningError('stale_set');
  }
  const items = programVocabularyItems(state).map(plannedProgramVocabularyItem);
  if (plan.action === 'create') {
    if (items.some((item) => item.id === plan.after.id)) throw new ProgramVocabularyPlanningError('item_exists');
    items.push(plan.after);
  } else {
    const before = plan.action === 'merge' || plan.action === 'merge_compensation'
      ? plan.sourceBefore
      : plan.before;
    const index = items.findIndex((item) => item.kind === before.kind && item.id === before.id);
    if (index < 0 || itemDigest(items[index]!) !== itemDigest(before)) {
      throw new ProgramVocabularyPlanningError('stale_item');
    }
    if (plan.action === 'delete') items.splice(index, 1);
    else if (plan.action === 'merge' || plan.action === 'merge_compensation') items[index] = plan.sourceAfter;
    else items[index] = plan.after;
  }
  return createProgramVocabularyState(stateInputFrom(state, items));
}

export function applyProgramReferenceRepoints(
  current: CompleteProgramReferenceSnapshot,
  plan: Pick<ProgramMergePlan | ProgramMergeCompensationPlan, 'referenceRegistryDigest' | 'references'>
): CompleteProgramReferenceSnapshot {
  if (current.registryDigestSha256 !== plan.referenceRegistryDigest) {
    throw new ProgramVocabularyPlanningError('stale_reference');
  }
  const contributors = current.contributors.map((contributor) => {
    const expected = plan.references.find((entry) =>
      entry.contributor.key === contributor.contributor.key
      && entry.contributor.version === contributor.contributor.version
    );
    if (!expected || !sameContributorGuard(contributor, expected)) {
      throw new ProgramVocabularyPlanningError('stale_reference');
    }
    const repoints = new Map(expected.liveRepoints.map((repoint) => [repoint.referenceKey, repoint]));
    if (repoints.size === 0) return contributor;
    const references = contributor.references.map((reference) => {
      const repoint = repoints.get(reference.referenceKey);
      if (!repoint) return reference;
      if (reference.mode !== 'current' || reference.version !== repoint.expectedVersion
          || reference.item.kind !== repoint.from.kind || reference.item.id !== repoint.from.id) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
      repoints.delete(reference.referenceKey);
      return {
        ...reference,
        version: parseAggregateVersion(reference.version + 1),
        item: { ...repoint.to }
      };
    });
    if (repoints.size !== 0) throw new ProgramVocabularyPlanningError('stale_reference');
    const guardVersion = parseAggregateVersion(contributor.guard.version + 1);
    return deepFreeze({
      ...contributor,
      guard: {
        ...contributor.guard,
        version: guardVersion,
        digest: sha256({ contributor: contributor.contributor, guardVersion, references })
      },
      references
    });
  });
  return deepFreeze({ registryDigestSha256: current.registryDigestSha256, contributors });
}

export function mutationAffectedItems(plan: ProgramVocabularyMutationPlan): readonly PlannedProgramVocabularyItem[] {
  if (plan.action === 'create') return [plan.after];
  if (plan.action === 'merge' || plan.action === 'merge_compensation') return [plan.sourceAfter, plan.target];
  if (plan.action === 'delete') return [plan.before];
  return [plan.after];
}

export function mergeReferenceCounts(plan: ProgramMergePlan | ProgramMergeCompensationPlan): {
  readonly liveRepoints: number;
  readonly historicalPins: number;
} {
  return Object.freeze({
    liveRepoints: plan.references.reduce((sum, contributor) => sum + contributor.liveRepoints.length, 0),
    historicalPins: plan.references.reduce((sum, contributor) => sum + contributor.historicalPins.length, 0)
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
