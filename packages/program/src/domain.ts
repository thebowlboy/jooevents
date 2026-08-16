import { createHash } from 'node:crypto';
import type {
  ProgramVocabularyDraftInput,
  ProgramVocabularyKind,
  ProgramVocabularyMergeDraftInput,
  ProgramVocabularyScopeDto,
  ProgramVocabularyStatus
} from '@jooevents/contracts';
import {
  deriveProgramTrackAccent,
  programVocabularyIdSchema,
  programVocabularyKindSchema,
  programVocabularyNameSchema,
  programVocabularyScopeSchema,
  programVocabularyStatusSchema,
  programVocabularyVersionSchema,
  programTrackAccentSchema
} from '@jooevents/contracts';
import {
  encodeCanonicalJson,
  parseAggregateVersion,
  type AggregateVersion
} from '@jooevents/kernel';
import {
  createProgramVocabularyState,
  compareProgramVocabularyCanonicalText,
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
import { z } from 'zod';
import {
  assertCompleteProgramReferenceSnapshot,
  captureRegisteredProgramReferences,
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
import { registerIssuedProgramReferenceSnapshot } from './reference-auth';

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
      readonly accent: 'lavender' | 'sea' | 'neutral';
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
  | 'invalid_plan'
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

const canonicalBoundedText = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value.trim() === value);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const stableKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const plannedItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('room'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    status: programVocabularyStatusSchema,
    version: programVocabularyVersionSchema,
    capacity: z.number().int().positive().safe().nullable()
  }),
  z.strictObject({
    kind: z.literal('track'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    accent: programTrackAccentSchema,
    status: programVocabularyStatusSchema,
    version: programVocabularyVersionSchema
  }),
  z.strictObject({
    kind: z.literal('format'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    status: programVocabularyStatusSchema,
    version: programVocabularyVersionSchema
  })
]);
const referenceTargetSchema = z.strictObject({
  kind: programVocabularyKindSchema,
  id: programVocabularyIdSchema
});
const safeDestinationSchema = z.strictObject({
  kind: stableKeySchema,
  id: canonicalBoundedText(300)
});
const contributorSchema = z.strictObject({
  key: stableKeySchema,
  version: programVocabularyVersionSchema
});
const referenceContributionSchema = z.strictObject({
  contributor: contributorSchema,
  guard: z.strictObject({
    id: z.string().regex(/^program_reference:[A-Za-z0-9._~:-]+$/),
    version: programVocabularyVersionSchema,
    digest: digestSchema
  }),
  liveRepoints: z.array(z.strictObject({
    referenceKey: canonicalBoundedText(300),
    expectedVersion: programVocabularyVersionSchema,
    from: referenceTargetSchema,
    to: referenceTargetSchema,
    destination: safeDestinationSchema
  })),
  historicalPins: z.array(z.strictObject({
    referenceKey: canonicalBoundedText(300),
    version: programVocabularyVersionSchema,
    item: referenceTargetSchema,
    destination: safeDestinationSchema
  }))
});
const planBaseSchema = {
  scope: programVocabularyScopeSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  setGuardDigest: digestSchema
} as const;
const referencePlanSchema = {
  referenceRegistryDigest: digestSchema,
  references: z.array(referenceContributionSchema)
} as const;
const rawProgramVocabularyMutationPlanSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), ...planBaseSchema, after: plannedItemSchema }),
  z.strictObject({ action: z.literal('edit'), ...planBaseSchema, before: plannedItemSchema, after: plannedItemSchema }),
  z.strictObject({ action: z.literal('retire'), ...planBaseSchema, before: plannedItemSchema, after: plannedItemSchema }),
  z.strictObject({ action: z.literal('restore'), ...planBaseSchema, before: plannedItemSchema, after: plannedItemSchema }),
  z.strictObject({ action: z.literal('delete'), ...planBaseSchema, before: plannedItemSchema, ...referencePlanSchema }),
  z.strictObject({
    action: z.literal('merge'),
    ...planBaseSchema,
    sourceBefore: plannedItemSchema,
    sourceAfter: plannedItemSchema,
    target: plannedItemSchema,
    ...referencePlanSchema
  }),
  z.strictObject({
    action: z.literal('merge_compensation'),
    ...planBaseSchema,
    sourceBefore: plannedItemSchema,
    sourceAfter: plannedItemSchema,
    target: plannedItemSchema,
    restoreSource: z.boolean(),
    ...referencePlanSchema
  })
]);

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return sha256(left) === sha256(right);
}

function sameItemIdentity(
  left: PlannedProgramVocabularyItem,
  right: PlannedProgramVocabularyItem
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function sameItemExcept(
  left: PlannedProgramVocabularyItem,
  right: PlannedProgramVocabularyItem,
  omitted: ReadonlySet<string>
): boolean {
  const strip = (item: PlannedProgramVocabularyItem) => Object.fromEntries(
    Object.entries(item).filter(([key]) => !omitted.has(key))
  );
  return sameCanonicalValue(strip(left), strip(right));
}

function areStrictlyOrderedBy<Value>(
  values: readonly Value[],
  identity: (value: Value) => string
): boolean {
  return values.every((value, index) => index === 0
    || compareProgramVocabularyCanonicalText(identity(values[index - 1]!), identity(value)) < 0);
}

function contributionIdentity(value: { readonly contributor: ProgramReferenceContributorRef }): string {
  return `${value.contributor.key}@${value.contributor.version}`;
}

function referencesAreCanonical(
  references: readonly ProgramReferenceContributionPlan[],
  source: Pick<PlannedProgramVocabularyItem, 'kind' | 'id'>,
  target: Pick<PlannedProgramVocabularyItem, 'kind' | 'id'> | undefined,
  direction: 'forward' | 'reverse' | 'none'
): boolean {
  if (!areStrictlyOrderedBy(references, contributionIdentity)) return false;
  const guardIds = new Set<string>();
  for (const contribution of references) {
    if (guardIds.has(contribution.guard.id)) return false;
    guardIds.add(contribution.guard.id);
    if (!areStrictlyOrderedBy(contribution.liveRepoints, (value) => value.referenceKey)
        || !areStrictlyOrderedBy(contribution.historicalPins, (value) => value.referenceKey)) return false;
    const keys = [
      ...contribution.liveRepoints.map((value) => value.referenceKey),
      ...contribution.historicalPins.map((value) => value.referenceKey)
    ];
    if (new Set(keys).size !== keys.length) return false;
    if (direction === 'none' && (contribution.liveRepoints.length !== 0 || contribution.historicalPins.length !== 0)) {
      return false;
    }
    for (const repoint of contribution.liveRepoints) {
      const from = direction === 'reverse' ? target : source;
      const to = direction === 'reverse' ? source : target;
      if (!from || !to
          || repoint.from.kind !== from.kind || repoint.from.id !== from.id
          || repoint.to.kind !== to.kind || repoint.to.id !== to.id) return false;
    }
    for (const pin of contribution.historicalPins) {
      if (pin.item.kind !== source.kind || pin.item.id !== source.id) return false;
    }
  }
  return true;
}

function mutationPlanIsCoherent(plan: ProgramVocabularyMutationPlan): boolean {
  const items = plan.action === 'create'
    ? [plan.after]
    : plan.action === 'edit' || plan.action === 'retire' || plan.action === 'restore'
      ? [plan.before, plan.after]
      : plan.action === 'delete'
        ? [plan.before]
        : [plan.sourceBefore, plan.sourceAfter, plan.target];
  if (items.some((item) => item.kind === 'track'
      && item.accent !== deriveProgramTrackAccent(item.id))) return false;
  if (plan.action === 'create') {
    return plan.after.status === 'active' && plan.after.version === 1;
  }
  if (plan.action === 'edit') {
    return sameItemIdentity(plan.before, plan.after)
      && plan.before.status === plan.after.status
      && plan.after.version === plan.before.version + 1;
  }
  if (plan.action === 'retire' || plan.action === 'restore') {
    const beforeStatus = plan.action === 'retire' ? 'active' : 'retired';
    const afterStatus = plan.action === 'retire' ? 'retired' : 'active';
    return sameItemIdentity(plan.before, plan.after)
      && plan.before.status === beforeStatus
      && plan.after.status === afterStatus
      && plan.after.version === plan.before.version + 1
      && sameItemExcept(plan.before, plan.after, new Set(['status', 'version']));
  }
  if (plan.action === 'delete') {
    return referencesAreCanonical(plan.references, plan.before, undefined, 'none');
  }
  const sameKind = plan.sourceBefore.kind === plan.sourceAfter.kind
    && plan.sourceBefore.kind === plan.target.kind;
  if (!sameKind || plan.sourceBefore.id === plan.target.id
      || !sameItemIdentity(plan.sourceBefore, plan.sourceAfter)) return false;
  if (plan.action === 'merge') {
    return plan.sourceAfter.status === 'retired'
      && plan.sourceAfter.version === plan.sourceBefore.version + 1
      && plan.target.status === 'active'
      && sameItemExcept(plan.sourceBefore, plan.sourceAfter, new Set(['status', 'version']))
      && referencesAreCanonical(plan.references, plan.sourceBefore, plan.target, 'forward');
  }
  const sourceTransition = plan.restoreSource
    ? plan.sourceAfter.status === 'active'
      && plan.sourceAfter.version === plan.sourceBefore.version + 1
      && sameItemExcept(plan.sourceBefore, plan.sourceAfter, new Set(['status', 'version']))
    : sameCanonicalValue(plan.sourceBefore, plan.sourceAfter);
  return sourceTransition
    && referencesAreCanonical(plan.references, plan.sourceBefore, plan.target, 'reverse');
}

/** Parses immutable mutation evidence without normalizing or repairing any field. */
export function parseProgramVocabularyMutationPlan(value: unknown): ProgramVocabularyMutationPlan {
  const parsed = rawProgramVocabularyMutationPlanSchema.safeParse(value);
  if (!parsed.success || !mutationPlanIsCoherent(parsed.data as ProgramVocabularyMutationPlan)) {
    throw new ProgramVocabularyPlanningError('invalid_plan');
  }
  return deepFreeze(parsed.data as ProgramVocabularyMutationPlan);
}

export function programVocabularyMutationPlanDigest(value: unknown): string {
  return sha256(parseProgramVocabularyMutationPlan(value));
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
      kind: 'track', id: item.id, name: item.name, accent: item.accent,
      status: item.status, version: item.version
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

/** User-readable owner-native diff for direct and reviewed merge operations. */
export function projectProgramVocabularySafeDiff(
  plan: ProgramVocabularyMutationPlan
): import('@jooevents/contracts').ProgramVocabularySafeDiff {
  if (plan.action === 'create') return { action: 'create', before: null, after: plan.after };
  if (plan.action === 'edit') return { action: 'edit', before: plan.before, after: plan.after };
  if (plan.action === 'retire') return { action: 'retire', before: plan.before, after: plan.after };
  if (plan.action === 'restore') return { action: 'restore', before: plan.before, after: plan.after };
  if (plan.action === 'delete') {
    return {
      action: 'delete', before: plan.before, after: null,
      usage: {
        current: plan.references.reduce((sum, contributor) =>
          sum + contributor.liveRepoints.length, 0),
        historicalPins: plan.references.reduce((sum, contributor) =>
          sum + contributor.historicalPins.length, 0)
      }
    };
  }
  const counts = mergeReferenceCounts(plan);
  return {
    action: plan.action,
    sourceBefore: plan.sourceBefore,
    sourceAfter: plan.sourceAfter,
    target: plan.target,
    liveRepoints: counts.liveRepoints,
    historicalPinsPreserved: counts.historicalPins
  };
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
  const snapshot = captureRegisteredProgramReferences({ registry, scope: state.scope, source });
  validateProgramReferenceTargets(state, snapshot);
  return snapshot;
}

function planCreate(
  input: Extract<ProgramVocabularyDraftInput, { readonly action: 'create' }>,
  state: ProgramVocabularyState
): ProgramCreatePlan {
  requireSetGuard(state, input.scope, input.expectedSetVersion);
  const id = parseProgramVocabularyId(input.item.kind, input.item.id);
  if (programVocabularyItems(state).some((item) => item.id === id)) {
    throw new ProgramVocabularyPlanningError('item_exists');
  }
  const after: PlannedProgramVocabularyItem = input.item.kind === 'room'
    ? {
        kind: 'room', id, name: normalizeProgramVocabularyName(input.item.name),
        status: 'active', version: 1, capacity: parseRoomCapacity(input.item.capacity)
      }
    : input.item.kind === 'track'
      ? {
          kind: 'track', id, name: normalizeProgramVocabularyName(input.item.name),
          accent: deriveProgramTrackAccent(id), status: 'active', version: 1
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

function referencePlansMatch(
  left: readonly ProgramReferenceContributionPlan[],
  right: readonly ProgramReferenceContributionPlan[]
): boolean {
  return sameCanonicalValue(left, right);
}

function expectedReferencePlans(
  plan: ProgramDeletePlan | ProgramMergePlan | ProgramMergeCompensationPlan,
  current: CompleteProgramReferenceSnapshot
): readonly ProgramReferenceContributionPlan[] | undefined {
  if (plan.action === 'delete') {
    if (programReferenceUsage(current, plan.before).current !== 0
        || programReferenceUsage(current, plan.before).historicalPins !== 0) return undefined;
    return current.contributors.map((contributor) => contributorPlan(contributor, plan.before));
  }
  if (plan.action === 'merge') {
    return current.contributors.map((contributor) => contributorPlan(
      contributor,
      plan.sourceBefore,
      plan.target
    ));
  }
  const plannedByContributor = new Map(plan.references.map((contribution) => [
    contributionIdentity(contribution),
    contribution
  ]));
  return current.contributors.map((contributor) => {
    const planned = plannedByContributor.get(contributionIdentity(contributor));
    if (!planned) return contributorPlan(contributor, plan.target, plan.sourceBefore, new Set());
    const selected = new Set(planned.liveRepoints.map((repoint) => repoint.referenceKey));
    const targetContribution = contributorPlan(
      contributor,
      plan.target,
      plan.sourceBefore,
      selected
    );
    return deepFreeze({
      ...targetContribution,
      historicalPins: contributorPlan(contributor, plan.sourceBefore).historicalPins
    });
  });
}

export function validateProgramVocabularyPlan(
  state: ProgramVocabularyState,
  plan: ProgramVocabularyMutationPlan,
  registry: ProgramReferenceContributorRegistry,
  source: ProgramReferenceSnapshotSource
): ProgramVocabularyPlanningErrorCode | null {
  let parsedPlan: ProgramVocabularyMutationPlan;
  try {
    parsedPlan = parseProgramVocabularyMutationPlan(plan);
  } catch {
    return 'invalid_plan';
  }
  if (!sameScopeDto(state.scope, parsedPlan.scope)) return 'wrong_scope';
  if (state.setVersion !== parsedPlan.expectedSetVersion
      || programVocabularySetDigest(state) !== parsedPlan.setGuardDigest) {
    return 'stale_set';
  }
  if (parsedPlan.action === 'create') {
    return programVocabularyItems(state).some((item) => item.id === parsedPlan.after.id) ? 'item_exists' : null;
  }
  const expected = parsedPlan.action === 'merge' || parsedPlan.action === 'merge_compensation'
    ? parsedPlan.sourceBefore
    : parsedPlan.before;
  if (!itemMatches(resolveProgramVocabularyItem(state, expected.kind, expected.id), expected)) return 'stale_item';
  if (parsedPlan.action === 'merge' || parsedPlan.action === 'merge_compensation') {
    if (!itemMatches(
      resolveProgramVocabularyItem(state, parsedPlan.target.kind, parsedPlan.target.id),
      parsedPlan.target
    )) return 'stale_item';
  }
  if (parsedPlan.action === 'delete'
      || parsedPlan.action === 'merge'
      || parsedPlan.action === 'merge_compensation') {
    if (registry.registryDigestSha256 !== parsedPlan.referenceRegistryDigest) return 'stale_reference';
    let current: CompleteProgramReferenceSnapshot;
    try {
      current = captureReferences(state, registry, source);
    } catch {
      return 'stale_reference';
    }
    if (current.registryDigestSha256 !== parsedPlan.referenceRegistryDigest) return 'stale_reference';
    const expectedReferences = expectedReferencePlans(parsedPlan, current);
    if (!expectedReferences || !referencePlansMatch(parsedPlan.references, expectedReferences)) {
      return 'stale_reference';
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
  const parsedPlan = parseProgramVocabularyMutationPlan(plan);
  if (!sameScopeDto(state.scope, parsedPlan.scope) || state.setVersion !== parsedPlan.expectedSetVersion
      || programVocabularySetDigest(state) !== parsedPlan.setGuardDigest) {
    throw new ProgramVocabularyPlanningError('stale_set');
  }
  const items = programVocabularyItems(state).map(plannedProgramVocabularyItem);
  if (parsedPlan.action === 'create') {
    if (items.some((item) => item.id === parsedPlan.after.id)) throw new ProgramVocabularyPlanningError('item_exists');
    items.push(parsedPlan.after);
  } else {
    const before = parsedPlan.action === 'merge' || parsedPlan.action === 'merge_compensation'
      ? parsedPlan.sourceBefore
      : parsedPlan.before;
    const index = items.findIndex((item) => item.kind === before.kind && item.id === before.id);
    if (index < 0 || itemDigest(items[index]!) !== itemDigest(before)) {
      throw new ProgramVocabularyPlanningError('stale_item');
    }
    if (parsedPlan.action === 'merge' || parsedPlan.action === 'merge_compensation') {
      const target = resolveProgramVocabularyItem(state, parsedPlan.target.kind, parsedPlan.target.id);
      if (!itemMatches(target, parsedPlan.target)) throw new ProgramVocabularyPlanningError('stale_item');
    }
    if (parsedPlan.action === 'delete') items.splice(index, 1);
    else if (parsedPlan.action === 'merge' || parsedPlan.action === 'merge_compensation') {
      items[index] = parsedPlan.sourceAfter;
    } else items[index] = parsedPlan.after;
  }
  return createProgramVocabularyState(stateInputFrom(state, items));
}

export function applyProgramReferenceRepoints(
  current: CompleteProgramReferenceSnapshot,
  plan: ProgramMergePlan | ProgramMergeCompensationPlan
): CompleteProgramReferenceSnapshot {
  assertCompleteProgramReferenceSnapshot(current);
  const parsedPlan = parseProgramVocabularyMutationPlan(plan);
  if (parsedPlan.action !== 'merge' && parsedPlan.action !== 'merge_compensation') {
    throw new ProgramVocabularyPlanningError('invalid_plan');
  }
  const expectedReferences = expectedReferencePlans(parsedPlan, current);
  if (current.registryDigestSha256 !== parsedPlan.referenceRegistryDigest
      || !expectedReferences || !referencePlansMatch(parsedPlan.references, expectedReferences)) {
    throw new ProgramVocabularyPlanningError('stale_reference');
  }
  const contributors = current.contributors.map((contributor) => {
    const expected = parsedPlan.references.find((entry) =>
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
  return registerIssuedProgramReferenceSnapshot(deepFreeze({ ...current, contributors }));
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
