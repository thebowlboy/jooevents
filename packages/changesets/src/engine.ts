import {
  CANONICAL_JSON_PROFILE,
  canonicalJsonSha256,
  canonicalJsonValue,
  type CanonicalJson
} from './canonical-json';
import {
  issueCommittedChangesetSource,
  issueValidatedChangesetCommit,
  claimAppliedChangesetCommit,
  type CommittedChangesetSource,
  type ValidatedChangesetCommit
} from './commit-authorization';
import { parseOperationReceiptId, type OperationReceiptId } from '@jooevents/kernel';

export type {
  CommittedChangesetSource,
  ValidatedChangesetCommit
} from './commit-authorization';

export type ChangesetStatus = 'draft' | 'proposed' | 'committed' | 'discarded';
export type RiskTier = 'low' | 'normal' | 'consequential';
export type ChangesetOrigin = 'human_ui' | 'agent' | 'import' | 'integration' | 'system';

export interface VersionRef {
  readonly id: string;
  readonly version: number;
}

export interface GuardRef extends VersionRef {
  readonly digest: string;
}

export interface DependencyGroup {
  readonly key: string;
  readonly dependsOn: readonly string[];
}

export interface CompensationLineage {
  readonly sourceRevisionId: string;
  readonly sourceRevisionDigest: string;
  readonly sourceOperationIndex: number;
  readonly sourceOperationKind: string;
  readonly sourceOperationVersion: number;
  readonly sourceDependencyGroup: string;
}

export interface FrozenChangesetOperation {
  readonly kind: string;
  readonly version: number;
  readonly riskTier: RiskTier;
  readonly dependencyGroup: string;
  readonly planSchema: ChangesetSchemaRef;
  readonly diffSchema: ChangesetSchemaRef;
  readonly resultSchema: ChangesetSchemaRef;
  readonly aggregateRefs: readonly VersionRef[];
  readonly guardRefs: readonly GuardRef[];
  readonly plan: CanonicalJson;
  readonly safeDiff: CanonicalJson;
  readonly consequences: readonly string[];
  readonly compensationLineage?: CompensationLineage;
}

export interface ChangesetSchemaRef {
  readonly key: string;
  readonly version: number;
  readonly digestSha256: string;
}

export interface ChangesetRevision {
  readonly id: string;
  readonly number: number;
  readonly createdAt: string;
  readonly proposerPrincipalKey: string;
  readonly origin: ChangesetOrigin;
  /** Frozen provenance is part of the reviewed revision bytes, never transient draft-only metadata. */
  readonly originProvenance?: CanonicalJson;
  readonly operations: readonly FrozenChangesetOperation[];
  readonly dependencyGroups: readonly DependencyGroup[];
  readonly riskTier: RiskTier;
  readonly approvalPolicy: { readonly key: string; readonly version: number };
  readonly canonicalization: typeof CANONICAL_JSON_PROFILE;
  readonly digest: string;
}

export interface ChangesetHead {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId?: string;
  readonly version: number;
  readonly status: ChangesetStatus;
  readonly currentRevisionNumber: number;
  readonly revisions: readonly ChangesetRevision[];
}

export interface ApprovalReceipt {
  readonly id: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly policy: { readonly key: string; readonly version: number };
  readonly scopeKey: string;
  readonly approverPrincipalKey: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface RevisionDraft {
  readonly id: string;
  readonly createdAt: string;
  readonly proposerPrincipalKey: string;
  readonly origin: ChangesetOrigin;
  readonly originProvenance?: CanonicalJson;
  readonly operations: readonly FrozenChangesetOperation[];
  readonly dependencyGroups: readonly DependencyGroup[];
  readonly approvalPolicy: { readonly key: string; readonly version: number };
}

export type CommitRefusal =
  | { readonly kind: 'wrong_status'; readonly status: ChangesetStatus }
  | { readonly kind: 'stale_head'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'digest_changed' }
  | { readonly kind: 'base_version_changed'; readonly id: string; readonly expected: number; readonly actual?: number }
  | { readonly kind: 'guard_changed'; readonly id: string }
  | { readonly kind: 'approval_missing' }
  | { readonly kind: 'approval_invalid'; readonly reason: 'digest' | 'policy' | 'scope' | 'time' | 'expired' | 'authority' | 'separation' };

export type CommitValidation =
  | {
      readonly kind: 'ready';
      readonly revision: ChangesetRevision;
      readonly authorization: ValidatedChangesetCommit;
    }
  | { readonly kind: 'refused'; readonly refusal: CommitRefusal };

export interface CommitValidationInput {
  readonly expectedHeadVersion: number;
  readonly expectedRevisionDigest: string;
  readonly currentAggregateVersions: ReadonlyMap<string, number>;
  readonly currentGuardVersions: ReadonlyMap<string, number>;
  readonly currentGuardDigests: ReadonlyMap<string, string>;
  readonly now: string;
  /** Frozen by the policy resolver for this exact revision. */
  readonly approvalRequirement: 'none' | 'distinct_current_human';
  readonly approval?: ApprovalReceipt;
  readonly approverCurrentlyAuthorized?: boolean;
}

function changesetScopeKey(head: ChangesetHead): string {
  return head.eventId === undefined
    ? `workspace:${head.workspaceId}`
    : `workspace:${head.workspaceId}/event:${head.eventId}`;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertInstant(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC instant`);
  }
}

function assertSchemaRef(reference: ChangesetSchemaRef, label: string): void {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(reference.key)) {
    throw new TypeError(`${label}.key must be a stable key`);
  }
  assertPositiveInteger(reference.version, `${label}.version`);
  if (!/^[a-f0-9]{64}$/.test(reference.digestSha256)) {
    throw new TypeError(`${label}.digestSha256 must be a lowercase SHA-256 digest`);
  }
}

function freezeOperation(operation: FrozenChangesetOperation): FrozenChangesetOperation {
  assertPositiveInteger(operation.version, 'operation.version');
  assertSchemaRef(operation.planSchema, 'operation.planSchema');
  assertSchemaRef(operation.diffSchema, 'operation.diffSchema');
  assertSchemaRef(operation.resultSchema, 'operation.resultSchema');
  if (operation.compensationLineage !== undefined) {
    const lineage = operation.compensationLineage;
    if (!lineage.sourceRevisionId || !/^[a-f0-9]{64}$/.test(lineage.sourceRevisionDigest)) {
      throw new TypeError('operation.compensationLineage must cite a source revision and digest');
    }
    if (!Number.isSafeInteger(lineage.sourceOperationIndex) || lineage.sourceOperationIndex < 0) {
      throw new TypeError('operation.compensationLineage.sourceOperationIndex must be nonnegative');
    }
    assertPositiveInteger(lineage.sourceOperationVersion, 'operation.compensationLineage.sourceOperationVersion');
    if (!lineage.sourceOperationKind || !lineage.sourceDependencyGroup) {
      throw new TypeError('operation.compensationLineage must cite the source operation and group');
    }
  }
  return deepFreeze({
    kind: operation.kind,
    version: operation.version,
    riskTier: operation.riskTier,
    dependencyGroup: operation.dependencyGroup,
    planSchema: { ...operation.planSchema },
    diffSchema: { ...operation.diffSchema },
    resultSchema: { ...operation.resultSchema },
    aggregateRefs: operation.aggregateRefs.map((ref) => ({ ...ref })),
    guardRefs: operation.guardRefs.map((ref) => ({ ...ref })),
    plan: canonicalJsonValue(operation.plan),
    safeDiff: canonicalJsonValue(operation.safeDiff),
    consequences: [...operation.consequences],
    ...(operation.compensationLineage === undefined
      ? {}
      : { compensationLineage: { ...operation.compensationLineage } })
  });
}

function validateGroups(groups: readonly DependencyGroup[], operations: readonly FrozenChangesetOperation[]): void {
  const keys = new Set<string>();
  for (const group of groups) {
    if (!group.key || keys.has(group.key)) throw new TypeError(`Duplicate or empty dependency group: ${group.key}`);
    keys.add(group.key);
  }
  for (const group of groups) {
    if (group.dependsOn.length !== new Set(group.dependsOn).size) {
      throw new TypeError(`Duplicate dependency in group: ${group.key}`);
    }
    for (const dependency of group.dependsOn) {
      if (!keys.has(dependency) || dependency === group.key) throw new TypeError(`Invalid dependency ${group.key} -> ${dependency}`);
    }
  }
  for (const operation of operations) {
    if (!keys.has(operation.dependencyGroup)) throw new TypeError(`Unknown operation dependency group: ${operation.dependencyGroup}`);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new TypeError(`Cyclic dependency group: ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key);
}

function riskOf(operations: readonly FrozenChangesetOperation[]): RiskTier {
  if (operations.some((operation) => operation.riskTier === 'consequential')) return 'consequential';
  if (operations.some((operation) => operation.riskTier === 'normal')) return 'normal';
  return 'low';
}

function revisionDigestInput(
  head: Pick<ChangesetHead, 'id' | 'workspaceId' | 'eventId'>,
  number: number,
  draft: RevisionDraft
): CanonicalJson {
  return canonicalJsonValue({
    changesetId: head.id,
    workspaceId: head.workspaceId,
    ...(head.eventId === undefined ? {} : { eventId: head.eventId }),
    revisionId: draft.id,
    revisionNumber: number,
    createdAt: draft.createdAt,
    proposerPrincipalKey: draft.proposerPrincipalKey,
    origin: draft.origin,
    ...(draft.originProvenance === undefined ? {} : { originProvenance: draft.originProvenance }),
    operations: draft.operations,
    dependencyGroups: draft.dependencyGroups,
    riskTier: riskOf(draft.operations),
    approvalPolicy: draft.approvalPolicy,
    canonicalization: CANONICAL_JSON_PROFILE
  });
}

function storedRevisionDigestInput(
  head: Pick<ChangesetHead, 'id' | 'workspaceId' | 'eventId'>,
  revision: ChangesetRevision
): CanonicalJson {
  return canonicalJsonValue({
    changesetId: head.id,
    workspaceId: head.workspaceId,
    ...(head.eventId === undefined ? {} : { eventId: head.eventId }),
    revisionId: revision.id,
    revisionNumber: revision.number,
    createdAt: revision.createdAt,
    proposerPrincipalKey: revision.proposerPrincipalKey,
    origin: revision.origin,
    ...(revision.originProvenance === undefined
      ? {}
      : { originProvenance: revision.originProvenance }),
    operations: revision.operations,
    dependencyGroups: revision.dependencyGroups,
    riskTier: revision.riskTier,
    approvalPolicy: revision.approvalPolicy,
    canonicalization: revision.canonicalization
  });
}

function revisionIntegrityMatches(
  head: Pick<ChangesetHead, 'id' | 'workspaceId' | 'eventId'>,
  revision: ChangesetRevision,
  expectedNumber: number
): boolean {
  try {
    if (
      revision.number !== expectedNumber
      || revision.riskTier !== riskOf(revision.operations)
      || revision.canonicalization.key !== CANONICAL_JSON_PROFILE.key
      || revision.canonicalization.version !== CANONICAL_JSON_PROFILE.version
    ) return false;
    assertInstant(revision.createdAt, `revision[${expectedNumber}].createdAt`);
    const operations = revision.operations.map(freezeOperation);
    validateGroups(revision.dependencyGroups, operations);
    return canonicalJsonSha256(storedRevisionDigestInput(head, revision)) === revision.digest;
  } catch {
    return false;
  }
}

function revisionChainIntegrityMatches(head: ChangesetHead): boolean {
  if (
    head.currentRevisionNumber !== head.revisions.length
    || head.currentRevisionNumber < 1
  ) return false;

  const revisionIds = new Set<string>();
  for (const [index, revision] of head.revisions.entries()) {
    if (
      !revision.id
      || revisionIds.has(revision.id)
      || !revisionIntegrityMatches(head, revision, index + 1)
    ) return false;
    revisionIds.add(revision.id);
  }
  return true;
}

/**
 * Verifies the complete immutable revision chain without minting commit authority.
 * Durable adapters use this after strict structural decoding and before treating
 * stored bytes as a canonical changeset.
 */
export function changesetHeadIntegrityMatches(head: ChangesetHead): boolean {
  return revisionChainIntegrityMatches(head);
}

export function createChangeset(
  scope: { readonly id: string; readonly workspaceId: string; readonly eventId?: string },
  draft: RevisionDraft
): ChangesetHead {
  const empty: ChangesetHead = {
    id: scope.id,
    workspaceId: scope.workspaceId,
    ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
    version: 0,
    status: 'draft',
    currentRevisionNumber: 0,
    revisions: []
  };
  return reviseChangeset(empty, draft);
}

export function reviseChangeset(head: ChangesetHead, draft: RevisionDraft): ChangesetHead {
  if (head.status === 'committed' || head.status === 'discarded') {
    throw new TypeError(`Cannot revise ${head.status} changeset`);
  }
  assertInstant(draft.createdAt, 'revision.createdAt');
  const operations = draft.operations.map(freezeOperation);
  validateGroups(draft.dependencyGroups, operations);
  const number = head.currentRevisionNumber + 1;
  const digest = canonicalJsonSha256(revisionDigestInput(head, number, { ...draft, operations }));
  const revision: ChangesetRevision = deepFreeze({
    id: draft.id,
    number,
    createdAt: draft.createdAt,
    proposerPrincipalKey: draft.proposerPrincipalKey,
    origin: draft.origin,
    ...(draft.originProvenance === undefined
      ? {}
      : { originProvenance: canonicalJsonValue(draft.originProvenance) }),
    operations,
    dependencyGroups: draft.dependencyGroups.map((group) => ({ key: group.key, dependsOn: [...group.dependsOn] })),
    riskTier: riskOf(operations),
    approvalPolicy: { ...draft.approvalPolicy },
    canonicalization: CANONICAL_JSON_PROFILE,
    digest
  });
  return deepFreeze({
    ...head,
    version: head.version + 1,
    status: 'draft',
    currentRevisionNumber: number,
    revisions: [...head.revisions, revision]
  });
}

export function proposeChangeset(head: ChangesetHead, expectedHeadVersion: number): ChangesetHead {
  if (head.status !== 'draft') throw new TypeError(`Cannot propose ${head.status} changeset`);
  if (head.version !== expectedHeadVersion) throw new TypeError('stale_head');
  return deepFreeze({ ...head, version: head.version + 1, status: 'proposed' });
}

export function discardChangeset(head: ChangesetHead, expectedHeadVersion: number): ChangesetHead {
  if (head.status !== 'draft' && head.status !== 'proposed') throw new TypeError(`Cannot discard ${head.status} changeset`);
  if (head.version !== expectedHeadVersion) throw new TypeError('stale_head');
  return deepFreeze({ ...head, version: head.version + 1, status: 'discarded' });
}

export function validateExactCommit(head: ChangesetHead, input: CommitValidationInput): CommitValidation {
  assertInstant(input.now, 'commit.now');
  if (head.status !== 'proposed') return { kind: 'refused', refusal: { kind: 'wrong_status', status: head.status } };
  if (head.version !== input.expectedHeadVersion) {
    return { kind: 'refused', refusal: { kind: 'stale_head', expected: input.expectedHeadVersion, actual: head.version } };
  }
  const revision = head.revisions.at(-1);
  if (
    !revision
    || revision.digest !== input.expectedRevisionDigest
    || !revisionChainIntegrityMatches(head)
  ) {
    return { kind: 'refused', refusal: { kind: 'digest_changed' } };
  }
  for (const operation of revision.operations) {
    for (const base of operation.aggregateRefs) {
      const actual = input.currentAggregateVersions.get(base.id);
      if (actual !== base.version) {
        return {
          kind: 'refused',
          refusal: actual === undefined
            ? { kind: 'base_version_changed', id: base.id, expected: base.version }
            : { kind: 'base_version_changed', id: base.id, expected: base.version, actual }
        };
      }
    }
    for (const guard of operation.guardRefs) {
      if (
        input.currentGuardVersions.get(guard.id) !== guard.version
        || input.currentGuardDigests.get(guard.id) !== guard.digest
      ) {
        return { kind: 'refused', refusal: { kind: 'guard_changed', id: guard.id } };
      }
    }
  }

  const approval = input.approval;
  const needsApproval = input.approvalRequirement === 'distinct_current_human';
  if (needsApproval && !approval) return { kind: 'refused', refusal: { kind: 'approval_missing' } };
  if (approval) {
    assertInstant(approval.issuedAt, 'approval.issuedAt');
    assertInstant(approval.expiresAt, 'approval.expiresAt');
    const issuedAt = Date.parse(approval.issuedAt);
    const expiresAt = Date.parse(approval.expiresAt);
    const now = Date.parse(input.now);
    if (approval.revisionId !== revision.id || approval.revisionDigest !== revision.digest) {
      return { kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'digest' } };
    }
    if (approval.policy.key !== revision.approvalPolicy.key || approval.policy.version !== revision.approvalPolicy.version) {
      return { kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'policy' } };
    }
    if (approval.scopeKey !== changesetScopeKey(head)) {
      return { kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'scope' } };
    }
    if (issuedAt > now || issuedAt >= expiresAt) {
      return { kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'time' } };
    }
    if (expiresAt <= now) {
      return { kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'expired' } };
    }
    if (input.approverCurrentlyAuthorized !== true) {
      return { kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'authority' } };
    }
    if (approval.approverPrincipalKey === revision.proposerPrincipalKey) {
      return { kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'separation' } };
    }
  }
  return {
    kind: 'ready',
    revision,
    authorization: issueValidatedChangesetCommit({
      changesetId: head.id,
      headVersion: head.version,
      revision
    })
  };
}

export function markChangesetCommitted(
  head: ChangesetHead,
  authorization: ValidatedChangesetCommit,
  commitReceiptId: OperationReceiptId
): {
  readonly head: ChangesetHead;
  readonly source: CommittedChangesetSource;
} {
  const parsedReceiptId = parseOperationReceiptId(commitReceiptId);
  const committedHead = markChangesetCommittedHead(head, authorization);
  const revision = committedHead.revisions.at(-1);
  if (!revision) throw new TypeError('invalid_validated_changeset_commit');
  return Object.freeze({
    head: committedHead,
    source: issueCommittedChangesetSource({
      changesetId: head.id,
      revision,
      commitReceiptId: parsedReceiptId
    })
  });
}

/** Consumes exact commit authority without minting post-commit correction authority. */
export function markChangesetCommittedHead(
  head: ChangesetHead,
  authorization: ValidatedChangesetCommit
): ChangesetHead {
  if (head.status !== 'proposed') throw new TypeError(`Cannot commit ${head.status} changeset`);
  const revision = head.revisions.at(-1);
  if (
    authorization.changesetId !== head.id
    || authorization.headVersion !== head.version
    || !revision
    || authorization.revisionId !== revision.id
    || authorization.revisionDigest !== revision.digest
    || !revisionChainIntegrityMatches(head)
  ) {
    throw new TypeError('invalid_validated_changeset_commit');
  }
  const validated = claimAppliedChangesetCommit(authorization);
  if (
    !validated
    || validated.changesetId !== head.id
    || validated.headVersion !== head.version
    || validated.revision.id !== revision.id
    || validated.revision.digest !== revision.digest
  ) {
    throw new TypeError('invalid_validated_changeset_commit');
  }
  return deepFreeze({
    ...head,
    version: head.version + 1,
    status: 'committed' as const
  });
}

/**
 * Reconstitutes the process-local compensation capability from an exact durable
 * committed head and its terminal receipt link. The caller remains responsible for
 * loading both records from one trusted persistence snapshot.
 */
export function rehydrateCommittedChangesetSource(input: {
  readonly head: ChangesetHead;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly commitReceiptId: OperationReceiptId;
}): CommittedChangesetSource {
  const head = input.head;
  if (head.status !== 'committed' || !revisionChainIntegrityMatches(head)) {
    throw new TypeError('invalid_committed_changeset_head');
  }
  const revision = head.revisions.at(-1);
  if (
    !revision
    || revision.id !== input.revisionId
    || revision.digest !== input.revisionDigest
  ) throw new TypeError('committed_changeset_revision_mismatch');
  return issueCommittedChangesetSource({
    changesetId: head.id,
    revision,
    commitReceiptId: parseOperationReceiptId(input.commitReceiptId)
  });
}

export function assertReplanSelection(
  revision: ChangesetRevision,
  groupsToReplan: ReadonlySet<string>
): void {
  const groups = new Map(revision.dependencyGroups.map((group) => [group.key, group]));
  for (const key of groupsToReplan) {
    if (!groups.has(key)) throw new TypeError(`Unknown dependency group: ${key}`);
  }
  for (const group of revision.dependencyGroups) {
    if (!groupsToReplan.has(group.key) && group.dependsOn.some((dependency) => groupsToReplan.has(dependency))) {
      throw new TypeError(`Retained group ${group.key} depends on replanned work`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
