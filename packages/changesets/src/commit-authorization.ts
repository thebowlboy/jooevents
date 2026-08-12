import type { ChangesetRevision } from './engine';
import type { OperationReceiptId } from '@jooevents/kernel';

const validatedCommitBrand: unique symbol = Symbol('ValidatedChangesetCommit');
const committedSourceBrand: unique symbol = Symbol('CommittedChangesetSource');

/** Opaque proof that one exact proposed revision passed every commit precondition. */
export interface ValidatedChangesetCommit {
  readonly changesetId: string;
  readonly headVersion: number;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly [validatedCommitBrand]: true;
}

export interface ValidatedChangesetCommitState {
  readonly changesetId: string;
  readonly headVersion: number;
  readonly revision: ChangesetRevision;
}

type ValidatedCommitPhase =
  | 'validated'
  | 'preparing'
  | 'prepared'
  | 'applying'
  | 'applied'
  | 'marked'
  | 'spent';

interface StoredValidatedChangesetCommit extends ValidatedChangesetCommitState {
  phase: ValidatedCommitPhase;
}

const validatedCommits = new WeakMap<object, StoredValidatedChangesetCommit>();

/**
 * Runtime capability for planning compensation from a source known to have
 * reached the committed state with a terminal operation receipt.
 */
export interface CommittedChangesetSource {
  readonly changesetId: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly commitReceiptId: OperationReceiptId;
  readonly [committedSourceBrand]: true;
}

export interface CommittedChangesetSourceState {
  readonly changesetId: string;
  readonly revision: ChangesetRevision;
  readonly commitReceiptId: OperationReceiptId;
}

const committedSources = new WeakMap<object, CommittedChangesetSourceState>();

export function issueValidatedChangesetCommit(
  state: ValidatedChangesetCommitState
): ValidatedChangesetCommit {
  const revision = freezeClone(state.revision);
  const authorization: ValidatedChangesetCommit = Object.freeze({
    changesetId: state.changesetId,
    headVersion: state.headVersion,
    revisionId: revision.id,
    revisionDigest: revision.digest,
    [validatedCommitBrand]: true as const
  });
  validatedCommits.set(authorization, {
    changesetId: state.changesetId,
    headVersion: state.headVersion,
    revision,
    phase: 'validated'
  });
  return authorization;
}

export function beginValidatedChangesetPreparation(
  authorization: ValidatedChangesetCommit
): ValidatedChangesetCommitState | undefined {
  const stored = validatedCommits.get(authorization);
  if (!stored || stored.phase !== 'validated') return undefined;
  stored.phase = 'preparing';
  return stored;
}

export function completeValidatedChangesetPreparation(
  authorization: ValidatedChangesetCommit
): boolean {
  const stored = validatedCommits.get(authorization);
  if (!stored || stored.phase !== 'preparing') return false;
  stored.phase = 'prepared';
  return true;
}

export function beginValidatedChangesetApply(
  authorization: ValidatedChangesetCommit
): boolean {
  const stored = validatedCommits.get(authorization);
  if (!stored || stored.phase !== 'prepared') return false;
  stored.phase = 'applying';
  return true;
}

export function completeValidatedChangesetApply(
  authorization: ValidatedChangesetCommit
): boolean {
  const stored = validatedCommits.get(authorization);
  if (!stored || stored.phase !== 'applying') return false;
  stored.phase = 'applied';
  return true;
}

export function spendValidatedChangesetCommit(
  authorization: ValidatedChangesetCommit
): void {
  const stored = validatedCommits.get(authorization);
  if (stored && stored.phase !== 'marked') stored.phase = 'spent';
}

export function claimAppliedChangesetCommit(
  authorization: ValidatedChangesetCommit
): ValidatedChangesetCommitState | undefined {
  const stored = validatedCommits.get(authorization);
  if (!stored || stored.phase !== 'applied') return undefined;
  stored.phase = 'marked';
  return stored;
}

export function issueCommittedChangesetSource(
  state: CommittedChangesetSourceState
): CommittedChangesetSource {
  const source: CommittedChangesetSource = Object.freeze({
    changesetId: state.changesetId,
    revisionId: state.revision.id,
    revisionDigest: state.revision.digest,
    commitReceiptId: state.commitReceiptId,
    [committedSourceBrand]: true as const
  });
  committedSources.set(source, state);
  return source;
}

export function resolveCommittedChangesetSource(
  source: CommittedChangesetSource
): CommittedChangesetSourceState | undefined {
  return committedSources.get(source);
}

function freezeClone<Value>(value: Value): Value {
  const clone = structuredClone(value);
  return deepFreeze(clone);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
