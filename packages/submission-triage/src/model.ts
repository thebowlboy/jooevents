import { createHash } from 'node:crypto';
import {
  SUBMISSION_TRIAGE_LIST_MAX,
  submissionArrivalFactSchema,
  submissionTriageAttributionSchema,
  submissionTriageHeadSchema,
  submissionTriageListInputSchema,
  submissionTriageListSchema,
  submissionTriageProjectionSchema,
  submissionTriageQueryGuardSchema,
  submissionTriageReadSchema,
  submissionTriageSourceRowSchema,
  submissionTriageVisibleTraySchema,
  type SubmissionArrivalFactDto,
  type SubmissionTriageAction,
  type SubmissionTriageAttribution,
  type SubmissionTriageHeadDto,
  type SubmissionTriageListDto,
  type SubmissionTriageListInput,
  type SubmissionTriageProjectionDto,
  type SubmissionTriageQueryGuardDto,
  type SubmissionTriageReadDto,
  type SubmissionTriageSourceRowDto,
  type SubmissionTriageState,
  type SubmissionTriageVisibleTray
} from '@jooevents/contracts/submission-triage';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { matchSubmissionTriageProjection, parseSubmissionTriageSearch } from './search';

export type SubmissionTriageDomainErrorCode =
  | 'wrong_scope'
  | 'projection_incomplete'
  | 'source_changed'
  | 'submission_missing'
  | 'stale_query_set'
  | 'stale_submission'
  | 'invalid_transition'
  | 'invalid_plan';

export class SubmissionTriageDomainError extends Error {
  constructor(readonly code: SubmissionTriageDomainErrorCode) {
    super(code);
    this.name = 'SubmissionTriageDomainError';
  }
}

export interface SubmissionTriageScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

export interface SubmissionTriageEntry {
  readonly arrival: SubmissionArrivalFactDto;
  readonly head: SubmissionTriageHeadDto;
}

export interface SubmissionTriageStateSnapshot {
  readonly scope: SubmissionTriageScope;
  readonly queryGuard: SubmissionTriageQueryGuardDto;
  readonly entries: readonly SubmissionTriageEntry[];
}

export interface SubmissionTriageSourcePort {
  listSourceRows(scope: SubmissionTriageScope): readonly SubmissionTriageSourceRowDto[];
  readSourceRow(
    scope: SubmissionTriageScope,
    submissionId: string
  ): SubmissionTriageSourceRowDto | undefined;
}

export interface SubmissionTriageReadPort extends SubmissionTriageSourcePort {
  readTriageState(scope: SubmissionTriageScope): SubmissionTriageStateSnapshot | undefined;
}

export interface SubmissionTriageTransactionPort extends SubmissionTriageReadPort {
  applyTransitionPlan(plan: SubmissionTriageTransitionPlan): SubmissionTriageTransitionResult;
}

export interface SubmissionTriageInitialization {
  readonly arrival: SubmissionArrivalFactDto;
  readonly head: SubmissionTriageHeadDto;
}

export interface SubmissionTriageInitializationResult {
  readonly schemaVersion: 1;
  readonly submissionId: string;
  readonly queryGuard: SubmissionTriageQueryGuardDto;
  readonly replay: boolean;
}

/** Transaction-local persistence seam; source-specific submit code does not call this directly. */
export interface SubmissionTriageInitializationStore {
  initializeSubmissionTriage(
    initialization: SubmissionTriageInitialization
  ): SubmissionTriageInitializationResult;
}

/** The only new identity factory a submission source must add to its submit UOW. */
export interface SubmissionTriageInitializationIds {
  newArrivalId(): string;
}

export interface SubmissionTriageSubmitInitializationInput {
  readonly scope: SubmissionTriageScope;
  readonly submission: {
    readonly id: string;
    readonly formId: string;
    readonly formVersionId: string;
    readonly source: SubmissionTriageSourceRowDto['source'];
    readonly submittedAt: string;
  };
  readonly recordedAt: string;
  readonly closeEvidence: SubmissionArrivalFactDto['closeEvidence'];
}

/**
 * Small authenticated collaborator composed into a source submit unit of work.
 * Its store enforces that the call is inside the same database transaction.
 */
export interface SubmissionTriageInitializationPort {
  initializeWithinTransaction(
    input: SubmissionTriageSubmitInitializationInput
  ): SubmissionTriageInitializationResult;
}

export interface SubmissionTriagePlannedTransition {
  readonly submissionId: string;
  readonly arrivalDigestSha256: string;
  readonly arrivalClassification: SubmissionArrivalFactDto['classification'];
  readonly beforeVisibleTray: SubmissionTriageVisibleTray;
  readonly afterVisibleTray: SubmissionTriageVisibleTray;
  readonly before: SubmissionTriageHeadDto;
  readonly after: SubmissionTriageHeadDto;
}

export interface SubmissionTriageTransitionPlan {
  readonly schemaVersion: 1;
  readonly action: SubmissionTriageAction | 'restore_exact';
  readonly scope: SubmissionTriageScope;
  readonly attribution: SubmissionTriageAttribution;
  readonly queryGuard: {
    readonly before: SubmissionTriageQueryGuardDto;
    readonly after: SubmissionTriageQueryGuardDto;
  };
  readonly transitions: readonly SubmissionTriagePlannedTransition[];
}

export interface SubmissionTriageTransitionResult {
  readonly schemaVersion: 1;
  readonly action: SubmissionTriageTransitionPlan['action'];
  readonly queryGuard: SubmissionTriageQueryGuardDto;
  readonly submissionIds: readonly string[];
}

export interface SubmissionTriageExactRestoreTarget {
  readonly submissionId: string;
  readonly expectedCurrentVersion: number;
  readonly state: SubmissionTriageState;
  readonly setAsideAttribution: SubmissionTriageAttribution | null;
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function sameScope(left: SubmissionTriageScope, right: SubmissionTriageScope): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function parsedScope(scope: SubmissionTriageScope): SubmissionTriageScope {
  const parsed = submissionTriageQueryGuardSchema.shape.scope.parse(scope);
  return Object.freeze({ workspaceId: parsed.workspaceId, eventId: parsed.eventId });
}

export function submissionTriageArrivalDigest(arrival: SubmissionArrivalFactDto): string {
  return digest(submissionArrivalFactSchema.parse(arrival));
}

export function submissionTriageHeadDigest(head: SubmissionTriageHeadDto): string {
  return digest(submissionTriageHeadSchema.parse(head));
}

export function submissionTriageVisibleTray(input: {
  readonly head: Pick<SubmissionTriageHeadDto, 'state'>;
  readonly arrival: Pick<SubmissionArrivalFactDto, 'classification'>;
}): SubmissionTriageVisibleTray {
  return submissionTriageVisibleTraySchema.parse(
    input.head.state === 'discarded_recoverable'
      ? 'discarded'
      : input.head.state === 'set_aside'
        ? 'set_aside'
        : input.arrival.classification === 'late'
          ? 'late'
          : 'inbox'
  );
}

function canonicalEntries(entries: readonly SubmissionTriageEntry[]): readonly SubmissionTriageEntry[] {
  const parsed = entries.map((entry) => {
    const arrival = submissionArrivalFactSchema.parse(entry.arrival);
    const head = submissionTriageHeadSchema.parse(entry.head);
    if (!sameScope(arrival.scope, head.scope) || arrival.submissionId !== head.submissionId) {
      throw new SubmissionTriageDomainError('wrong_scope');
    }
    return deepFreeze({ arrival, head });
  }).sort((left, right) => compareCanonicalText(left.head.submissionId, right.head.submissionId));
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index - 1]!.head.submissionId === parsed[index]!.head.submissionId) {
      throw new SubmissionTriageDomainError('invalid_plan');
    }
  }
  return Object.freeze(parsed);
}

export function submissionTriageQueryDigest(input: {
  readonly scope: SubmissionTriageScope;
  readonly entries: readonly SubmissionTriageEntry[];
}): string {
  const scope = parsedScope(input.scope);
  const entries = canonicalEntries(input.entries);
  if (entries.some((entry) => !sameScope(entry.head.scope, scope))) {
    throw new SubmissionTriageDomainError('wrong_scope');
  }
  return digest({
    schemaVersion: 1,
    scope,
    entries: entries.map((entry) => ({
      submissionId: entry.head.submissionId,
      headVersion: entry.head.version,
      headDigestSha256: submissionTriageHeadDigest(entry.head),
      arrivalDigestSha256: submissionTriageArrivalDigest(entry.arrival)
    }))
  });
}

export function createSubmissionTriageState(input: {
  readonly scope: SubmissionTriageScope;
  readonly version: number;
  readonly entries: readonly SubmissionTriageEntry[];
}): SubmissionTriageStateSnapshot {
  const scope = parsedScope(input.scope);
  const entries = canonicalEntries(input.entries);
  if (entries.some((entry) => !sameScope(entry.head.scope, scope))) {
    throw new SubmissionTriageDomainError('wrong_scope');
  }
  const queryGuard = submissionTriageQueryGuardSchema.parse({
    schemaVersion: 1,
    scope,
    version: input.version,
    digestSha256: submissionTriageQueryDigest({ scope, entries })
  });
  return deepFreeze({ scope, queryGuard, entries });
}

export function parseSubmissionTriageState(
  value: SubmissionTriageStateSnapshot
): SubmissionTriageStateSnapshot {
  const parsed = createSubmissionTriageState({
    scope: value.scope,
    version: value.queryGuard.version,
    entries: value.entries
  });
  const guard = submissionTriageQueryGuardSchema.parse(value.queryGuard);
  if (!sameScope(parsed.scope, guard.scope) || parsed.queryGuard.digestSha256 !== guard.digestSha256) {
    throw new SubmissionTriageDomainError('source_changed');
  }
  return parsed;
}

export function createSubmissionTriageInitialization(input: {
  readonly scope: SubmissionTriageScope;
  readonly submission: {
    readonly id: string;
    readonly formId: string;
    readonly formVersionId: string;
    readonly source: SubmissionTriageSourceRowDto['source'];
    readonly submittedAt: string;
  };
  readonly arrivalId: string;
  readonly recordedAt: string;
  readonly closeEvidence: SubmissionArrivalFactDto['closeEvidence'];
}): SubmissionTriageInitialization {
  const scope = parsedScope(input.scope);
  const submission = {
    id: submissionTriageSourceRowSchema.shape.summary.shape.id.parse(input.submission.id),
    formId: submissionTriageSourceRowSchema.shape.summary.shape.formId.parse(input.submission.formId),
    formVersionId: submissionTriageSourceRowSchema.shape.summary.shape.formVersionId.parse(
      input.submission.formVersionId
    ),
    source: submissionTriageSourceRowSchema.shape.source.parse(input.submission.source),
    submittedAt: submissionTriageSourceRowSchema.shape.summary.shape.submittedAt.parse(
      input.submission.submittedAt
    )
  };
  const classification = input.closeEvidence
    && Date.parse(submission.submittedAt) > Date.parse(input.closeEvidence.closeAt)
    ? 'late'
    : 'on_time';
  const arrival = submissionArrivalFactSchema.parse({
    schemaVersion: 1,
    id: input.arrivalId,
    scope,
    submissionId: submission.id,
    formId: submission.formId,
    formVersionId: submission.formVersionId,
    source: submission.source,
    submittedAt: submission.submittedAt,
    classification,
    closeEvidence: input.closeEvidence,
    recordedAt: input.recordedAt
  });
  const head = submissionTriageHeadSchema.parse({
    schemaVersion: 1,
    scope,
    submissionId: submission.id,
    version: 1,
    state: 'inbox',
    setAsideAttribution: null,
    updatedAt: input.recordedAt
  });
  return deepFreeze({ arrival, head });
}

export function createSubmissionTriageSubmitInitializer(input: {
  readonly store: SubmissionTriageInitializationStore;
  readonly ids: SubmissionTriageInitializationIds;
}): SubmissionTriageInitializationPort {
  if (typeof input.store?.initializeSubmissionTriage !== 'function'
      || typeof input.ids?.newArrivalId !== 'function') {
    throw new TypeError('submission_triage_initialization_collaborator_invalid');
  }
  const initializeSubmissionTriage = input.store.initializeSubmissionTriage.bind(input.store);
  const newArrivalId = input.ids.newArrivalId.bind(input.ids);
  return Object.freeze({
    initializeWithinTransaction(candidate: SubmissionTriageSubmitInitializationInput) {
      const prepared = createSubmissionTriageInitialization({
        ...candidate,
        arrivalId: newArrivalId()
      });
      return initializeSubmissionTriage(prepared);
    }
  });
}

function exactSourceRows(input: {
  readonly state: SubmissionTriageStateSnapshot;
  readonly sourceRows: readonly SubmissionTriageSourceRowDto[];
}): readonly SubmissionTriageSourceRowDto[] {
  const state = parseSubmissionTriageState(input.state);
  const rows = input.sourceRows.map((row) => submissionTriageSourceRowSchema.parse(row));
  const ids = new Set(state.entries.map((entry) => entry.head.submissionId));
  const rowIds = rows.map((row) => row.summary.id);
  if (new Set(rowIds).size !== rowIds.length
      || rows.length !== ids.size || rows.some((row) =>
    row.scope.workspaceId !== state.scope.workspaceId
    || row.scope.eventId !== state.scope.eventId
    || !ids.has(row.summary.id)
  )) {
    throw new SubmissionTriageDomainError('projection_incomplete');
  }
  return Object.freeze(rows);
}

function projectedRows(input: {
  readonly state: SubmissionTriageStateSnapshot;
  readonly sourceRows: readonly SubmissionTriageSourceRowDto[];
}): readonly SubmissionTriageProjectionDto[] {
  const state = parseSubmissionTriageState(input.state);
  const rows = exactSourceRows({ state, sourceRows: input.sourceRows });
  const entries = new Map(state.entries.map((entry) => [entry.head.submissionId, entry]));
  return Object.freeze(rows.map((source) => {
    const entry = entries.get(source.summary.id);
    if (!entry) throw new SubmissionTriageDomainError('projection_incomplete');
    return submissionTriageProjectionSchema.parse({
      schemaVersion: 1,
      source,
      triage: entry.head,
      arrival: entry.arrival,
      visibleTray: submissionTriageVisibleTray(entry)
    });
  }));
}

export function projectSubmissionTriageList(input: {
  readonly state: SubmissionTriageStateSnapshot;
  readonly sourceRows: readonly SubmissionTriageSourceRowDto[];
  readonly query?: SubmissionTriageListInput;
}): SubmissionTriageListDto {
  const state = parseSubmissionTriageState(input.state);
  const query = submissionTriageListInputSchema.parse(input.query ?? {});
  const rows = projectedRows({ state, sourceRows: input.sourceRows });
  const trayTotals = {
    inbox: rows.filter((row) => row.visibleTray === 'inbox').length,
    set_aside: rows.filter((row) => row.visibleTray === 'set_aside').length,
    late: rows.filter((row) => row.visibleTray === 'late').length,
    discarded: rows.filter((row) => row.visibleTray === 'discarded').length
  };
  const scoped = rows.filter((row) =>
    (query.tray === undefined || row.visibleTray === query.tray)
    && (query.trackId === undefined || row.source.track?.id === query.trackId)
    && (query.formatId === undefined || row.source.format?.id === query.formatId)
  );
  const parsedSearch = parseSubmissionTriageSearch(query.search ?? '');
  const ranked = parsedSearch.terms.length === 0
    ? scoped.map((row) => ({ row, match: null }))
    : scoped.map((row) => ({ row, match: matchSubmissionTriageProjection(row, parsedSearch) }))
      .filter((entry) => entry.match !== null);
  const matched = (parsedSearch.terms.length === 0 ? ranked : ranked.sort((left, right) => {
    if (left.match && right.match && left.match.rank !== right.match.rank) {
      return left.match.rank - right.match.rank;
    }
    return compareCanonicalText(left.row.source.summary.id, right.row.source.summary.id);
  })).map((entry) => entry.row);
  const selected = matched.slice(0, SUBMISSION_TRIAGE_LIST_MAX);
  return submissionTriageListSchema.parse({
    schemaVersion: 1,
    queryGuard: state.queryGuard,
    rows: selected,
    trayTotals,
    search: parsedSearch.terms.length === 0
      ? null
      : { query: query.search ?? '', matched: matched.length, scanned: scoped.length }
  });
}

export function projectSubmissionTriageRead(input: {
  readonly state: SubmissionTriageStateSnapshot;
  readonly sourceRows: readonly SubmissionTriageSourceRowDto[];
  readonly submissionId: string;
}): SubmissionTriageReadDto | undefined {
  const state = parseSubmissionTriageState(input.state);
  const row = projectedRows({ state, sourceRows: input.sourceRows })
    .find((candidate) => candidate.source.summary.id === input.submissionId);
  return row
    ? submissionTriageReadSchema.parse({ schemaVersion: 1, queryGuard: state.queryGuard, row })
    : undefined;
}

function nextHead(input: {
  readonly action: SubmissionTriageAction;
  readonly before: SubmissionTriageHeadDto;
  readonly attribution: SubmissionTriageAttribution;
  readonly changedAt: string;
}): SubmissionTriageHeadDto {
  const { action, before } = input;
  const state = action === 'set_aside'
    ? 'set_aside'
    : action === 'discard_recoverable'
      ? 'discarded_recoverable'
      : 'inbox';
  const allowed = action === 'set_aside'
    ? before.state === 'inbox'
    : action === 'return_to_inbox'
      ? before.state === 'set_aside'
      : action === 'discard_recoverable'
        ? before.state !== 'discarded_recoverable'
        : before.state === 'discarded_recoverable';
  if (!allowed) throw new SubmissionTriageDomainError('invalid_transition');
  return submissionTriageHeadSchema.parse({
    ...before,
    version: before.version + 1,
    state,
    setAsideAttribution: state === 'set_aside' ? input.attribution : null,
    updatedAt: input.changedAt
  });
}

function planWithTargets(input: {
  readonly state: SubmissionTriageStateSnapshot;
  readonly action: SubmissionTriageTransitionPlan['action'];
  readonly attribution: SubmissionTriageAttribution;
  readonly changedAt: string;
  readonly targets: readonly {
    readonly submissionId: string;
    readonly expectedCurrentVersion: number;
    readonly restore?: Pick<SubmissionTriageHeadDto, 'state' | 'setAsideAttribution'>;
  }[];
}): SubmissionTriageTransitionPlan {
  const state = parseSubmissionTriageState(input.state);
  const attribution = submissionTriageAttributionSchema.parse(input.attribution);
  const targets = [...input.targets].sort((left, right) =>
    compareCanonicalText(left.submissionId, right.submissionId)
  );
  if (targets.length === 0 || targets.some((target, index) =>
    index > 0 && targets[index - 1]!.submissionId === target.submissionId
  )) throw new SubmissionTriageDomainError('invalid_plan');
  const current = new Map(state.entries.map((entry) => [entry.head.submissionId, entry]));
  const afterById = new Map<string, SubmissionTriageHeadDto>();
  const transitions = targets.map((target) => {
    const entry = current.get(target.submissionId);
    if (!entry) throw new SubmissionTriageDomainError('submission_missing');
    if (entry.head.version !== target.expectedCurrentVersion) {
      throw new SubmissionTriageDomainError('stale_submission');
    }
    const after = input.action === 'restore_exact'
      ? submissionTriageHeadSchema.parse({
          ...entry.head,
          version: entry.head.version + 1,
          state: target.restore?.state,
          setAsideAttribution: target.restore?.setAsideAttribution,
          updatedAt: input.changedAt
        })
      : nextHead({
          action: input.action,
          before: entry.head,
          attribution,
          changedAt: input.changedAt
        });
    afterById.set(target.submissionId, after);
    return deepFreeze({
      submissionId: target.submissionId,
      arrivalDigestSha256: submissionTriageArrivalDigest(entry.arrival),
      arrivalClassification: entry.arrival.classification,
      beforeVisibleTray: submissionTriageVisibleTray(entry),
      afterVisibleTray: submissionTriageVisibleTray({ head: after, arrival: entry.arrival }),
      before: entry.head,
      after
    });
  });
  const afterEntries = state.entries.map((entry) => ({
    arrival: entry.arrival,
    head: afterById.get(entry.head.submissionId) ?? entry.head
  }));
  const afterGuard = submissionTriageQueryGuardSchema.parse({
    schemaVersion: 1,
    scope: state.scope,
    version: state.queryGuard.version + 1,
    digestSha256: submissionTriageQueryDigest({ scope: state.scope, entries: afterEntries })
  });
  return deepFreeze({
    schemaVersion: 1,
    action: input.action,
    scope: state.scope,
    attribution,
    queryGuard: { before: state.queryGuard, after: afterGuard },
    transitions
  });
}

export function planSubmissionTriageTransition(input: {
  readonly state: SubmissionTriageStateSnapshot;
  readonly action: SubmissionTriageAction;
  readonly submissionIds: readonly string[];
  readonly expectedHeads: readonly { readonly submissionId: string; readonly version: number }[];
  readonly expectedQueryGuard: { readonly version: number; readonly digestSha256: string };
  readonly attribution: SubmissionTriageAttribution;
  readonly changedAt: string;
}): SubmissionTriageTransitionPlan {
  const state = parseSubmissionTriageState(input.state);
  if (state.queryGuard.version !== input.expectedQueryGuard.version
      || state.queryGuard.digestSha256 !== input.expectedQueryGuard.digestSha256) {
    throw new SubmissionTriageDomainError('stale_query_set');
  }
  const ids = [...input.submissionIds].sort(compareCanonicalText);
  const heads = [...input.expectedHeads].sort((left, right) =>
    compareCanonicalText(left.submissionId, right.submissionId)
  );
  if (ids.length !== heads.length || ids.some((id, index) => id !== heads[index]?.submissionId)) {
    throw new SubmissionTriageDomainError('invalid_plan');
  }
  return planWithTargets({
    state,
    action: input.action,
    attribution: input.attribution,
    changedAt: input.changedAt,
    targets: heads.map((head) => ({ submissionId: head.submissionId, expectedCurrentVersion: head.version }))
  });
}

export function planSubmissionTriageExactRestore(input: {
  readonly state: SubmissionTriageStateSnapshot;
  readonly targets: readonly SubmissionTriageExactRestoreTarget[];
  readonly attribution: SubmissionTriageAttribution;
  readonly changedAt: string;
}): SubmissionTriageTransitionPlan {
  return planWithTargets({
    state: input.state,
    action: 'restore_exact',
    attribution: input.attribution,
    changedAt: input.changedAt,
    targets: input.targets.map((target) => ({
      submissionId: target.submissionId,
      expectedCurrentVersion: target.expectedCurrentVersion,
      restore: {
        state: target.state,
        setAsideAttribution: target.setAsideAttribution
      }
    }))
  });
}

export function submissionTriagePlanDigest(plan: SubmissionTriageTransitionPlan): string {
  return digest(plan);
}

export function submissionTriageSafeDiff(plan: SubmissionTriageTransitionPlan) {
  return deepFreeze({
    schemaVersion: 1 as const,
    action: plan.action,
    queryGuard: plan.queryGuard,
    transitions: plan.transitions.map((transition) => ({
      submissionId: transition.submissionId,
      arrivalClassification: transition.arrivalClassification,
      beforeVisibleTray: transition.beforeVisibleTray,
      afterVisibleTray: transition.afterVisibleTray,
      before: {
        submissionId: transition.before.submissionId,
        version: transition.before.version,
        state: transition.before.state,
        setAsideAttribution: transition.before.setAsideAttribution,
        updatedAt: transition.before.updatedAt
      },
      after: {
        submissionId: transition.after.submissionId,
        version: transition.after.version,
        state: transition.after.state,
        setAsideAttribution: transition.after.setAsideAttribution,
        updatedAt: transition.after.updatedAt
      }
    }))
  });
}

export function validateSubmissionTriagePlan(
  plan: SubmissionTriageTransitionPlan,
  stateInput: SubmissionTriageStateSnapshot
): SubmissionTriageDomainErrorCode | undefined {
  let state: SubmissionTriageStateSnapshot;
  try { state = parseSubmissionTriageState(stateInput); } catch {
    return 'source_changed';
  }
  if (!sameScope(plan.scope, state.scope)) return 'wrong_scope';
  if (plan.queryGuard.before.version !== state.queryGuard.version
      || plan.queryGuard.before.digestSha256 !== state.queryGuard.digestSha256) {
    return 'stale_query_set';
  }
  const current = new Map(state.entries.map((entry) => [entry.head.submissionId, entry]));
  for (const transition of plan.transitions) {
    const entry = current.get(transition.submissionId);
    if (!entry) return 'submission_missing';
    if (submissionTriageHeadDigest(entry.head) !== submissionTriageHeadDigest(transition.before)
        || submissionTriageArrivalDigest(entry.arrival) !== transition.arrivalDigestSha256) {
      return 'stale_submission';
    }
  }
  const afterById = new Map(plan.transitions.map((transition) => [transition.submissionId, transition.after]));
  const afterEntries = state.entries.map((entry) => ({
    arrival: entry.arrival,
    head: afterById.get(entry.head.submissionId) ?? entry.head
  }));
  if (plan.queryGuard.after.version !== state.queryGuard.version + 1
      || plan.queryGuard.after.digestSha256 !== submissionTriageQueryDigest({
        scope: state.scope,
        entries: afterEntries
      })) return 'invalid_plan';
  return undefined;
}

export function submissionTriageTransitionResult(
  plan: SubmissionTriageTransitionPlan
): SubmissionTriageTransitionResult {
  return deepFreeze({
    schemaVersion: 1,
    action: plan.action,
    queryGuard: plan.queryGuard.after,
    submissionIds: plan.transitions.map((transition) => transition.submissionId)
  });
}
