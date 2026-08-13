import {
  assertReplanSelection,
  canonicalJsonSha256,
  canonicalJsonValue,
  createChangeset,
  markChangesetCommittedHead,
  planChangesetCompensation,
  planChangesetCompensationSynchronous,
  planChangesetOperation,
  planChangesetOperationSynchronous,
  proposeChangeset,
  rehydrateCommittedChangesetSource,
  reviseChangeset,
  validateExactCommit,
  type ApprovalReceipt,
  type ChangesetDefinitionRegistry,
  type ChangesetPlanningSnapshot,
  type ChangesetRevision,
  type CommitRefusal,
  type CompensationPlanningResult,
  type DependencyGroup,
  type RevisionDraft,
  type ValidatedChangesetCommit
} from '@jooevents/changesets';
import {
  parseApprovalId,
  parseChangesetId,
  parseChangesetRevisionId,
  parseEventId,
  parseInstant,
  parseOperationReceiptId,
  parseOperationSurface,
  parseWorkspaceId,
  type OperationReceiptId
} from '@jooevents/kernel';
import {
  createStoredChangesetApproval,
  createStoredChangesetCommitLink,
  createStoredChangesetCorrectionLink,
  createStoredChangesetRebuildLink,
  createStoredChangesetRecord,
  createStoredChangesetRevisionRecord,
  changesetCommitTerminalReceiptDigest,
  parseChangesetCommitTerminalReceipt,
  parseStoredChangesetApproval,
  parseStoredChangesetCommitLink,
  parseStoredChangesetCorrectionLink,
  parseStoredChangesetRecord,
  parseStoredChangesetRebuildLink,
  projectStoredChangesetDiff,
  type CapturedChangesetApprovalPolicy,
  type ChangesetCommitTerminalReceipt,
  type StoredChangesetApproval,
  type StoredChangesetAuthorIntent,
  type StoredChangesetCommitLink,
  type StoredChangesetCorrectionLink,
  type StoredChangesetCorrectionEvidence,
  type StoredChangesetDiff,
  type StoredChangesetRebuildLink,
  type StoredChangesetRecord,
  type StoredChangesetRevisionRecord
} from './records';

export interface ChangesetLifecycleStore {
  read(changesetId: string): StoredChangesetRecord | undefined;
  insertDraft(record: StoredChangesetRecord): 'inserted' | 'exists';
  replaceHead(input: {
    readonly expectedHeadVersion: number;
    readonly record: StoredChangesetRecord;
    readonly appendedRevision?: StoredChangesetRevisionRecord;
    readonly rebuildLink?: StoredChangesetRebuildLink;
  }): 'advanced' | 'stale' | 'not_found';
  readApprovals(changesetId: string, revisionId: string): readonly StoredChangesetApproval[];
  insertApproval(record: StoredChangesetApproval): 'inserted' | 'exists';
  readCommitLink(changesetId: string): StoredChangesetCommitLink | undefined;
  commit(input: {
    readonly expectedHeadVersion: number;
    readonly record: StoredChangesetRecord;
    readonly link: StoredChangesetCommitLink;
  }): 'committed' | 'stale' | 'not_found';
  insertCorrection(input: {
    readonly link: StoredChangesetCorrectionLink;
    readonly target?: StoredChangesetRecord;
  }): 'inserted' | 'exists';
  readCorrection(correctionId: string): StoredChangesetCorrectionLink | undefined;
  readCorrections(sourceChangesetId: string): readonly StoredChangesetCorrectionLink[];
}

export interface TrustedChangesetActorContext {
  readonly workspaceId: string;
  readonly eventId?: string;
  readonly principalKey: string;
  /** Server-sealed authority identity used by the operation receipt. */
  readonly authorityPrincipalKey: string;
  readonly evaluatedAt: string;
}

export interface ChangesetCommitReceiptExpectation {
  readonly operation: { readonly name: string; readonly version: number };
  readonly surface: ChangesetCommitTerminalReceipt['identity']['surface'];
  readonly scopePartitionKey: string;
  readonly authorityPrincipalKey: string;
  readonly requestHashSha256: string;
}

export interface ChangesetLifecycleIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newApprovalId(): string;
  newCorrectionAttemptId(): string;
}

export interface ChangesetDraftOperationInput {
  readonly kind: string;
  readonly version: number;
  readonly dependencyGroup: string;
  readonly authorInput: unknown;
}

export type ChangesetLifecycleRefusal =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'scope_changed' }
  | { readonly kind: 'id_collision' }
  | { readonly kind: 'wrong_status'; readonly status: 'draft' | 'proposed' | 'committed' | 'discarded' }
  | { readonly kind: 'stale_head'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'revision_changed' }
  | { readonly kind: 'definition_changed'; readonly operationIndex: number }
  | { readonly kind: 'policy_changed' }
  | { readonly kind: 'invalid_rebuild_selection' }
  | { readonly kind: 'approval_not_required' }
  | { readonly kind: 'approval_separation_required' }
  | { readonly kind: 'approval_changed' }
  | { readonly kind: 'base_version_changed'; readonly id: string; readonly expected: number; readonly actual?: number }
  | { readonly kind: 'guard_changed'; readonly id: string }
  | { readonly kind: 'approval_missing' }
  | { readonly kind: 'approval_invalid'; readonly reason: 'digest' | 'policy' | 'scope' | 'time' | 'expired' | 'authority' | 'separation' };

type Refused = { readonly kind: 'refused'; readonly refusal: ChangesetLifecycleRefusal };

function refused(refusal: ChangesetLifecycleRefusal): Refused {
  return Object.freeze({ kind: 'refused' as const, refusal: Object.freeze(refusal) });
}

function parseContext(context: TrustedChangesetActorContext): TrustedChangesetActorContext {
  const workspaceId = parseWorkspaceId(context.workspaceId);
  const eventId = context.eventId === undefined ? undefined : parseEventId(context.eventId);
  const evaluatedAt = parseInstant(context.evaluatedAt);
  if (!context.principalKey.trim() || context.principalKey.length > 512) {
    throw new TypeError('invalid_changeset_principal_key');
  }
  if (!/^[a-f0-9]{64}$/.test(context.authorityPrincipalKey)) {
    throw new TypeError('invalid_changeset_authority_principal_key');
  }
  return Object.freeze({
    workspaceId,
    ...(eventId === undefined ? {} : { eventId }),
    principalKey: context.principalKey,
    authorityPrincipalKey: context.authorityPrincipalKey,
    evaluatedAt
  });
}

function parseReceiptExpectation(
  expectation: ChangesetCommitReceiptExpectation
): ChangesetCommitReceiptExpectation {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(expectation.operation.name)
    || !Number.isSafeInteger(expectation.operation.version)
    || expectation.operation.version <= 0) {
    throw new TypeError('invalid_changeset_commit_operation');
  }
  const sha256 = /^[a-f0-9]{64}$/;
  if (!sha256.test(expectation.scopePartitionKey)
    || !sha256.test(expectation.authorityPrincipalKey)
    || !sha256.test(expectation.requestHashSha256)) {
    throw new TypeError('invalid_changeset_commit_receipt_expectation');
  }
  return Object.freeze({
    operation: Object.freeze({ ...expectation.operation }),
    surface: parseOperationSurface(expectation.surface),
    scopePartitionKey: expectation.scopePartitionKey,
    authorityPrincipalKey: expectation.authorityPrincipalKey,
    requestHashSha256: expectation.requestHashSha256
  });
}

function sameScope(record: StoredChangesetRecord, context: TrustedChangesetActorContext): boolean {
  return record.head.workspaceId === context.workspaceId && record.head.eventId === context.eventId;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function samePolicy(left: CapturedChangesetApprovalPolicy, right: CapturedChangesetApprovalPolicy): boolean {
  return sameRef(left.reference, right.reference)
    && left.definitionDigestSha256 === right.definitionDigestSha256
    && left.requirement === right.requirement;
}

function scopeKey(record: StoredChangesetRecord): string {
  return record.head.eventId === undefined
    ? `workspace:${record.head.workspaceId}`
    : `workspace:${record.head.workspaceId}/event:${record.head.eventId}`;
}

function currentRevision(record: StoredChangesetRecord): StoredChangesetRevisionRecord {
  const revision = record.revisions.at(-1);
  if (!revision) throw new TypeError('stored_changeset_revision_missing');
  return revision;
}

function exactRevision(
  record: StoredChangesetRecord,
  input: { readonly revisionId: string; readonly revisionDigest: string }
): StoredChangesetRevisionRecord | undefined {
  const revision = currentRevision(record);
  return revision.revision.id === input.revisionId && revision.revision.digest === input.revisionDigest
    ? revision
    : undefined;
}

function intentFor(
  registry: ChangesetDefinitionRegistry,
  operation: ChangesetDraftOperationInput,
  operationIndex: number
): StoredChangesetAuthorIntent {
  const definition = registry.get(operation.kind, operation.version);
  if (!definition) throw new TypeError('unknown_changeset_operation');
  const schema = registry.getSchema(definition.schemas.authorInput);
  if (!schema) throw new TypeError('changeset_author_schema_missing');
  return Object.freeze({
    operationIndex,
    kind: definition.kind,
    version: definition.version,
    dependencyGroup: operation.dependencyGroup,
    authorInputSchema: Object.freeze({ ...definition.schemas.authorInput }),
    authorInput: canonicalJsonValue(schema.schema.parse(operation.authorInput))
  });
}

async function plannedRevision(input: {
  readonly registry: ChangesetDefinitionRegistry;
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly operations: readonly ChangesetDraftOperationInput[];
  readonly dependencyGroups: readonly DependencyGroup[];
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
  readonly context: TrustedChangesetActorContext;
  readonly revisionId: string;
  readonly origin: RevisionDraft['origin'];
  readonly originProvenance?: RevisionDraft['originProvenance'];
}): Promise<{ readonly draft: RevisionDraft; readonly intents: readonly StoredChangesetAuthorIntent[] }> {
  if (input.operations.length === 0) throw new TypeError('changeset_requires_operation');
  const intents: StoredChangesetAuthorIntent[] = [];
  const operations = [];
  for (const [index, operation] of input.operations.entries()) {
    const intent = intentFor(input.registry, operation, index);
    intents.push(intent);
    operations.push(await planChangesetOperation({
      registry: input.registry,
      kind: operation.kind,
      version: operation.version,
      authorInput: intent.authorInput,
      dependencyGroup: operation.dependencyGroup,
      snapshot: input.snapshot
    }));
  }
  return Object.freeze({
    draft: Object.freeze({
      id: parseChangesetRevisionId(input.revisionId),
      createdAt: input.context.evaluatedAt,
      proposerPrincipalKey: input.context.principalKey,
      origin: input.origin,
      ...(input.originProvenance === undefined
        ? {}
        : { originProvenance: canonicalJsonValue(input.originProvenance) }),
      operations: Object.freeze(operations),
      dependencyGroups: Object.freeze(input.dependencyGroups.map((group) => Object.freeze({
        key: group.key,
        dependsOn: Object.freeze([...group.dependsOn])
      }))),
      approvalPolicy: Object.freeze({ ...input.approvalPolicy.reference })
    }),
    intents: Object.freeze(intents)
  });
}

function plannedRevisionSynchronous(input: {
  readonly registry: ChangesetDefinitionRegistry;
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly operations: readonly ChangesetDraftOperationInput[];
  readonly dependencyGroups: readonly DependencyGroup[];
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
  readonly context: TrustedChangesetActorContext;
  readonly revisionId: string;
  readonly origin: RevisionDraft['origin'];
  readonly originProvenance?: RevisionDraft['originProvenance'];
}): { readonly draft: RevisionDraft; readonly intents: readonly StoredChangesetAuthorIntent[] } {
  if (input.operations.length === 0) throw new TypeError('changeset_requires_operation');
  const intents: StoredChangesetAuthorIntent[] = [];
  const operations = input.operations.map((operation, index) => {
    const intent = intentFor(input.registry, operation, index);
    intents.push(intent);
    return planChangesetOperationSynchronous({
      registry: input.registry,
      kind: operation.kind,
      version: operation.version,
      authorInput: intent.authorInput,
      dependencyGroup: operation.dependencyGroup,
      snapshot: input.snapshot
    });
  });
  return Object.freeze({
    draft: Object.freeze({
      id: parseChangesetRevisionId(input.revisionId),
      createdAt: input.context.evaluatedAt,
      proposerPrincipalKey: input.context.principalKey,
      origin: input.origin,
      ...(input.originProvenance === undefined
        ? {}
        : { originProvenance: canonicalJsonValue(input.originProvenance) }),
      operations: Object.freeze(operations),
      dependencyGroups: Object.freeze(input.dependencyGroups.map((group) => Object.freeze({
        key: group.key,
        dependsOn: Object.freeze([...group.dependsOn])
      }))),
      approvalPolicy: Object.freeze({ ...input.approvalPolicy.reference })
    }),
    intents: Object.freeze(intents)
  });
}

function persistInitialDraft(input: {
  readonly store: ChangesetLifecycleStore;
  readonly context: TrustedChangesetActorContext;
  readonly changesetId: string;
  readonly planned: { readonly draft: RevisionDraft; readonly intents: readonly StoredChangesetAuthorIntent[] };
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
}): { readonly kind: 'success'; readonly record: StoredChangesetRecord } | Refused {
  const head = createChangeset({
    id: input.changesetId,
    workspaceId: input.context.workspaceId,
    ...(input.context.eventId === undefined ? {} : { eventId: input.context.eventId })
  }, input.planned.draft);
  const revision = head.revisions[0]!;
  const revisionRecord = createStoredChangesetRevisionRecord({
    revision,
    authorIntents: input.planned.intents,
    approvalPolicy: input.approvalPolicy
  });
  const record = createStoredChangesetRecord({ head, revisions: [revisionRecord] });
  if (input.store.insertDraft(record) !== 'inserted') return refused({ kind: 'id_collision' });
  return Object.freeze({ kind: 'success' as const, record });
}

export async function appendChangesetDraft(input: {
  readonly store: ChangesetLifecycleStore;
  readonly registry: ChangesetDefinitionRegistry;
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly ids: ChangesetLifecycleIds;
  readonly context: TrustedChangesetActorContext;
  readonly operations: readonly ChangesetDraftOperationInput[];
  readonly dependencyGroups: readonly DependencyGroup[];
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
  readonly origin: RevisionDraft['origin'];
  readonly originProvenance?: RevisionDraft['originProvenance'];
}): Promise<{ readonly kind: 'success'; readonly record: StoredChangesetRecord } | Refused> {
  const context = parseContext(input.context);
  const changesetId = parseChangesetId(input.ids.newChangesetId());
  const planned = await plannedRevision({
    registry: input.registry,
    snapshot: input.snapshot,
    operations: input.operations,
    dependencyGroups: input.dependencyGroups,
    approvalPolicy: input.approvalPolicy,
    context,
    revisionId: input.ids.newRevisionId(),
    origin: input.origin,
    ...(input.originProvenance === undefined ? {} : { originProvenance: input.originProvenance })
  });
  return persistInitialDraft({
    store: input.store,
    context,
    changesetId,
    planned,
    approvalPolicy: input.approvalPolicy
  });
}

/** Synchronous draft creation for a transaction-local effect handler. */
export function appendChangesetDraftSynchronous(input: {
  readonly store: ChangesetLifecycleStore;
  readonly registry: ChangesetDefinitionRegistry;
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly ids: ChangesetLifecycleIds;
  readonly context: TrustedChangesetActorContext;
  readonly operations: readonly ChangesetDraftOperationInput[];
  readonly dependencyGroups: readonly DependencyGroup[];
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
  readonly origin: RevisionDraft['origin'];
  readonly originProvenance?: RevisionDraft['originProvenance'];
}): { readonly kind: 'success'; readonly record: StoredChangesetRecord } | Refused {
  const context = parseContext(input.context);
  const changesetId = parseChangesetId(input.ids.newChangesetId());
  const planned = plannedRevisionSynchronous({
    registry: input.registry,
    snapshot: input.snapshot,
    operations: input.operations,
    dependencyGroups: input.dependencyGroups,
    approvalPolicy: input.approvalPolicy,
    context,
    revisionId: input.ids.newRevisionId(),
    origin: input.origin,
    ...(input.originProvenance === undefined ? {} : { originProvenance: input.originProvenance })
  });
  return persistInitialDraft({
    store: input.store,
    context,
    changesetId,
    planned,
    approvalPolicy: input.approvalPolicy
  });
}

export function readChangesetDiff(input: {
  readonly store: ChangesetLifecycleStore;
  readonly context: TrustedChangesetActorContext;
  readonly changesetId: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
}): { readonly kind: 'success'; readonly diff: StoredChangesetDiff } | Refused {
  const context = parseContext(input.context);
  const record = input.store.read(parseChangesetId(input.changesetId));
  if (!record) return refused({ kind: 'not_found' });
  if (!sameScope(record, context)) return refused({ kind: 'scope_changed' });
  const diff = projectStoredChangesetDiff(
    record,
    parseChangesetRevisionId(input.revisionId),
    input.revisionDigest
  );
  return diff
    ? Object.freeze({ kind: 'success' as const, diff })
    : refused({ kind: 'revision_changed' });
}

export function proposeStoredChangeset(input: {
  readonly store: ChangesetLifecycleStore;
  readonly context: TrustedChangesetActorContext;
  readonly changesetId: string;
  readonly expectedHeadVersion: number;
  readonly revisionId: string;
  readonly revisionDigest: string;
}): { readonly kind: 'success'; readonly record: StoredChangesetRecord } | Refused {
  const context = parseContext(input.context);
  const record = input.store.read(parseChangesetId(input.changesetId));
  if (!record) return refused({ kind: 'not_found' });
  if (!sameScope(record, context)) return refused({ kind: 'scope_changed' });
  if (record.head.version !== input.expectedHeadVersion) {
    return refused({ kind: 'stale_head', expected: input.expectedHeadVersion, actual: record.head.version });
  }
  if (!exactRevision(record, input)) return refused({ kind: 'revision_changed' });
  if (record.head.status !== 'draft') return refused({ kind: 'wrong_status', status: record.head.status });
  const next = createStoredChangesetRecord({
    head: proposeChangeset(record.head, input.expectedHeadVersion),
    revisions: record.revisions
  });
  const advanced = input.store.replaceHead({ expectedHeadVersion: input.expectedHeadVersion, record: next });
  if (advanced !== 'advanced') {
    return advanced === 'not_found'
      ? refused({ kind: 'not_found' })
      : refused({ kind: 'stale_head', expected: input.expectedHeadVersion, actual: record.head.version });
  }
  return Object.freeze({ kind: 'success' as const, record: next });
}

export async function rebuildStoredChangeset(input: {
  readonly store: ChangesetLifecycleStore;
  readonly registry: ChangesetDefinitionRegistry;
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly ids: ChangesetLifecycleIds;
  readonly context: TrustedChangesetActorContext;
  readonly changesetId: string;
  readonly expectedHeadVersion: number;
  readonly sourceRevisionId: string;
  readonly sourceRevisionDigest: string;
  readonly groups: readonly string[];
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
}): Promise<{ readonly kind: 'success'; readonly record: StoredChangesetRecord; readonly link: StoredChangesetRebuildLink } | Refused> {
  const context = parseContext(input.context);
  const record = input.store.read(parseChangesetId(input.changesetId));
  if (!record) return refused({ kind: 'not_found' });
  if (!sameScope(record, context)) return refused({ kind: 'scope_changed' });
  if (record.head.version !== input.expectedHeadVersion) {
    return refused({ kind: 'stale_head', expected: input.expectedHeadVersion, actual: record.head.version });
  }
  const source = exactRevision(record, {
    revisionId: parseChangesetRevisionId(input.sourceRevisionId),
    revisionDigest: input.sourceRevisionDigest
  });
  if (!source) return refused({ kind: 'revision_changed' });
  if (record.head.status !== 'proposed' && record.head.status !== 'draft') {
    return refused({ kind: 'wrong_status', status: record.head.status });
  }
  const groups = [...new Set(input.groups)].sort();
  if (groups.length === 0 || groups.length !== input.groups.length) {
    return refused({ kind: 'invalid_rebuild_selection' });
  }
  try {
    assertReplanSelection(source.revision, new Set(groups));
  } catch {
    return refused({ kind: 'invalid_rebuild_selection' });
  }

  const operations = [];
  const intents: StoredChangesetAuthorIntent[] = [];
  for (const [index, operation] of source.revision.operations.entries()) {
    const intent = source.authorIntents[index];
    if (!intent) return refused({ kind: 'definition_changed', operationIndex: index });
    if (groups.includes(operation.dependencyGroup)) {
      const definition = input.registry.get(operation.kind, operation.version);
      if (!definition || !sameRef(definition.schemas.authorInput, intent.authorInputSchema)) {
        return refused({ kind: 'definition_changed', operationIndex: index });
      }
      const authorSchema = input.registry.getSchema(intent.authorInputSchema);
      if (!authorSchema) return refused({ kind: 'definition_changed', operationIndex: index });
      const authorInput = canonicalJsonValue(authorSchema.schema.parse(intent.authorInput));
      operations.push(await planChangesetOperation({
        registry: input.registry,
        kind: operation.kind,
        version: operation.version,
        authorInput,
        dependencyGroup: operation.dependencyGroup,
        snapshot: input.snapshot,
        ...(operation.compensationLineage === undefined
          ? {}
          : { compensationLineage: operation.compensationLineage })
      }));
      intents.push(Object.freeze({ ...intent, authorInput }));
    } else {
      operations.push(operation);
      intents.push(intent);
    }
  }
  const revisionId = parseChangesetRevisionId(input.ids.newRevisionId());
  const head = reviseChangeset(record.head, {
    id: revisionId,
    createdAt: context.evaluatedAt,
    proposerPrincipalKey: context.principalKey,
    origin: 'human_ui',
    originProvenance: canonicalJsonValue({
      kind: 'changeset_rebuild',
      sourceRevisionId: source.revision.id,
      sourceRevisionDigest: source.revision.digest,
      replannedGroups: groups
    }),
    operations,
    dependencyGroups: source.revision.dependencyGroups,
    approvalPolicy: input.approvalPolicy.reference
  });
  const revision = head.revisions.at(-1)!;
  const revisionRecord = createStoredChangesetRevisionRecord({
    revision,
    authorIntents: intents,
    approvalPolicy: input.approvalPolicy
  });
  const next = createStoredChangesetRecord({
    head,
    revisions: [...record.revisions, revisionRecord]
  });
  const link = createStoredChangesetRebuildLink({
    changesetId: record.head.id,
    sourceRevisionId: source.revision.id,
    sourceRevisionDigest: source.revision.digest,
    targetRevisionId: revision.id,
    targetRevisionDigest: revision.digest,
    replannedGroups: groups,
    rebuiltAt: context.evaluatedAt,
    rebuiltByPrincipalKey: context.principalKey
  });
  const advanced = input.store.replaceHead({
    expectedHeadVersion: input.expectedHeadVersion,
    record: next,
    appendedRevision: revisionRecord,
    rebuildLink: link
  });
  if (advanced !== 'advanced') {
    return advanced === 'not_found'
      ? refused({ kind: 'not_found' })
      : refused({ kind: 'stale_head', expected: input.expectedHeadVersion, actual: record.head.version });
  }
  return Object.freeze({ kind: 'success' as const, record: next, link });
}

/** Synchronous rebuild for a transaction-local single-unit-of-work handler. */
export function rebuildStoredChangesetSynchronous(input: {
  readonly store: ChangesetLifecycleStore;
  readonly registry: ChangesetDefinitionRegistry;
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly ids: ChangesetLifecycleIds;
  readonly context: TrustedChangesetActorContext;
  readonly changesetId: string;
  readonly expectedHeadVersion: number;
  readonly sourceRevisionId: string;
  readonly sourceRevisionDigest: string;
  readonly groups: readonly string[];
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
}): { readonly kind: 'success'; readonly record: StoredChangesetRecord; readonly link: StoredChangesetRebuildLink } | Refused {
  const context = parseContext(input.context);
  const record = input.store.read(parseChangesetId(input.changesetId));
  if (!record) return refused({ kind: 'not_found' });
  if (!sameScope(record, context)) return refused({ kind: 'scope_changed' });
  if (record.head.version !== input.expectedHeadVersion) {
    return refused({
      kind: 'stale_head', expected: input.expectedHeadVersion, actual: record.head.version
    });
  }
  const source = exactRevision(record, {
    revisionId: parseChangesetRevisionId(input.sourceRevisionId),
    revisionDigest: input.sourceRevisionDigest
  });
  if (!source) return refused({ kind: 'revision_changed' });
  if (record.head.status !== 'proposed' && record.head.status !== 'draft') {
    return refused({ kind: 'wrong_status', status: record.head.status });
  }
  const groups = [...new Set(input.groups)].sort();
  if (groups.length === 0 || groups.length !== input.groups.length) {
    return refused({ kind: 'invalid_rebuild_selection' });
  }
  try {
    assertReplanSelection(source.revision, new Set(groups));
  } catch {
    return refused({ kind: 'invalid_rebuild_selection' });
  }

  const operations = [];
  const intents: StoredChangesetAuthorIntent[] = [];
  for (const [index, operation] of source.revision.operations.entries()) {
    const intent = source.authorIntents[index];
    if (!intent) return refused({ kind: 'definition_changed', operationIndex: index });
    if (groups.includes(operation.dependencyGroup)) {
      const definition = input.registry.get(operation.kind, operation.version);
      if (!definition || !sameRef(definition.schemas.authorInput, intent.authorInputSchema)) {
        return refused({ kind: 'definition_changed', operationIndex: index });
      }
      const authorSchema = input.registry.getSchema(intent.authorInputSchema);
      if (!authorSchema) return refused({ kind: 'definition_changed', operationIndex: index });
      const authorInput = canonicalJsonValue(authorSchema.schema.parse(intent.authorInput));
      operations.push(planChangesetOperationSynchronous({
        registry: input.registry,
        kind: operation.kind,
        version: operation.version,
        authorInput,
        dependencyGroup: operation.dependencyGroup,
        snapshot: input.snapshot,
        ...(operation.compensationLineage === undefined
          ? {}
          : { compensationLineage: operation.compensationLineage })
      }));
      intents.push(Object.freeze({ ...intent, authorInput }));
    } else {
      operations.push(operation);
      intents.push(intent);
    }
  }
  const revisionId = parseChangesetRevisionId(input.ids.newRevisionId());
  const head = reviseChangeset(record.head, {
    id: revisionId,
    createdAt: context.evaluatedAt,
    proposerPrincipalKey: context.principalKey,
    origin: 'human_ui',
    originProvenance: canonicalJsonValue({
      kind: 'changeset_rebuild',
      sourceRevisionId: source.revision.id,
      sourceRevisionDigest: source.revision.digest,
      replannedGroups: groups
    }),
    operations,
    dependencyGroups: source.revision.dependencyGroups,
    approvalPolicy: input.approvalPolicy.reference
  });
  const revision = head.revisions.at(-1)!;
  const revisionRecord = createStoredChangesetRevisionRecord({
    revision,
    authorIntents: intents,
    approvalPolicy: input.approvalPolicy
  });
  const next = createStoredChangesetRecord({
    head,
    revisions: [...record.revisions, revisionRecord]
  });
  const link = createStoredChangesetRebuildLink({
    changesetId: record.head.id,
    sourceRevisionId: source.revision.id,
    sourceRevisionDigest: source.revision.digest,
    targetRevisionId: revision.id,
    targetRevisionDigest: revision.digest,
    replannedGroups: groups,
    rebuiltAt: context.evaluatedAt,
    rebuiltByPrincipalKey: context.principalKey
  });
  const advanced = input.store.replaceHead({
    expectedHeadVersion: input.expectedHeadVersion,
    record: next,
    appendedRevision: revisionRecord,
    rebuildLink: link
  });
  if (advanced !== 'advanced') {
    return advanced === 'not_found'
      ? refused({ kind: 'not_found' })
      : refused({
          kind: 'stale_head', expected: input.expectedHeadVersion, actual: record.head.version
        });
  }
  return Object.freeze({ kind: 'success' as const, record: next, link });
}

export function approveStoredChangeset(input: {
  readonly store: ChangesetLifecycleStore;
  readonly ids: ChangesetLifecycleIds;
  readonly context: TrustedChangesetActorContext;
  readonly changesetId: string;
  readonly expectedHeadVersion: number;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly currentApprovalPolicy: CapturedChangesetApprovalPolicy;
  readonly expiresAt: string;
}): { readonly kind: 'success'; readonly approval: StoredChangesetApproval } | Refused {
  const context = parseContext(input.context);
  const expiresAt = parseInstant(input.expiresAt);
  const record = input.store.read(parseChangesetId(input.changesetId));
  if (!record) return refused({ kind: 'not_found' });
  if (!sameScope(record, context)) return refused({ kind: 'scope_changed' });
  if (record.head.version !== input.expectedHeadVersion) {
    return refused({ kind: 'stale_head', expected: input.expectedHeadVersion, actual: record.head.version });
  }
  const revision = exactRevision(record, input);
  if (!revision) return refused({ kind: 'revision_changed' });
  if (record.head.status !== 'proposed') return refused({ kind: 'wrong_status', status: record.head.status });
  if (!samePolicy(revision.approvalPolicy, input.currentApprovalPolicy)) return refused({ kind: 'policy_changed' });
  if (revision.approvalPolicy.requirement !== 'distinct_current_human') {
    return refused({ kind: 'approval_not_required' });
  }
  if (revision.revision.proposerPrincipalKey === context.principalKey) {
    return refused({ kind: 'approval_separation_required' });
  }
  if (Date.parse(context.evaluatedAt) >= Date.parse(expiresAt)) return refused({ kind: 'approval_changed' });
  const receipt: ApprovalReceipt = Object.freeze({
    id: parseApprovalId(input.ids.newApprovalId()),
    revisionId: revision.revision.id,
    revisionDigest: revision.revision.digest,
    policy: Object.freeze({ ...revision.revision.approvalPolicy }),
    scopeKey: scopeKey(record),
    approverPrincipalKey: context.principalKey,
    issuedAt: context.evaluatedAt,
    expiresAt
  });
  const approval = createStoredChangesetApproval({ changesetId: record.head.id, receipt });
  if (input.store.insertApproval(approval) !== 'inserted') return refused({ kind: 'id_collision' });
  return Object.freeze({ kind: 'success' as const, approval });
}

const exactCommitBrand: unique symbol = Symbol('ExactStoredChangesetCommit');

export interface ExactStoredChangesetCommit {
  readonly changesetId: string;
  readonly headVersion: number;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly authorization: ValidatedChangesetCommit;
  readonly [exactCommitBrand]: true;
}

interface ExactCommitState {
  readonly record: StoredChangesetRecord;
  readonly context: TrustedChangesetActorContext;
  readonly receiptExpectation: ChangesetCommitReceiptExpectation;
  readonly approvalId?: string;
  phase: 'ready' | 'spent';
}

const exactCommits = new WeakMap<object, ExactCommitState>();

function assertTerminalReceiptExpectation(
  state: ExactCommitState,
  receipt: ChangesetCommitTerminalReceipt
): void {
  const expected = state.receiptExpectation;
  const result = receipt.result.data;
  const revision = currentRevision(state.record).revision;
  if (receipt.ref.operationName !== expected.operation.name
    || receipt.ref.operationVersion !== expected.operation.version
    || receipt.identity.surface !== expected.surface
    || receipt.identity.scopePartitionKey !== expected.scopePartitionKey
    || receipt.identity.authorityPrincipalKey !== expected.authorityPrincipalKey
    || receipt.requestHash !== expected.requestHashSha256
    || result.changesetId !== state.record.head.id
    || result.expectedHeadVersion !== state.record.head.version
    || result.committedHeadVersion !== state.record.head.version + 1
    || result.revisionId !== revision.id
    || result.revisionDigest !== revision.digest) {
    throw new TypeError('changeset_commit_terminal_receipt_mismatch');
  }
}

function commitRefusal(refusal: CommitRefusal): ChangesetLifecycleRefusal {
  switch (refusal.kind) {
    case 'wrong_status': return { kind: 'wrong_status', status: refusal.status };
    case 'stale_head': return refusal;
    case 'digest_changed': return { kind: 'revision_changed' };
    case 'base_version_changed': return refusal;
    case 'guard_changed': return refusal;
    case 'approval_missing': return refusal;
    case 'approval_invalid': return refusal;
  }
}

export function validateStoredChangesetCommit(input: {
  readonly store: ChangesetLifecycleStore;
  readonly context: TrustedChangesetActorContext;
  readonly changesetId: string;
  readonly expectedHeadVersion: number;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly currentApprovalPolicy: CapturedChangesetApprovalPolicy;
  readonly currentAggregateVersions: ReadonlyMap<string, number>;
  readonly currentGuardVersions: ReadonlyMap<string, number>;
  readonly currentGuardDigests: ReadonlyMap<string, string>;
  readonly approverCurrentlyAuthorized: (principalKey: string) => boolean;
  readonly receiptExpectation: ChangesetCommitReceiptExpectation;
}): { readonly kind: 'ready'; readonly commit: ExactStoredChangesetCommit } | Refused {
  const context = parseContext(input.context);
  const receiptExpectation = parseReceiptExpectation(input.receiptExpectation);
  if (receiptExpectation.authorityPrincipalKey !== context.authorityPrincipalKey) {
    throw new TypeError('changeset_commit_authority_identity_mismatch');
  }
  const record = input.store.read(parseChangesetId(input.changesetId));
  if (!record) return refused({ kind: 'not_found' });
  if (!sameScope(record, context)) return refused({ kind: 'scope_changed' });
  const revision = exactRevision(record, input);
  if (!revision) return refused({ kind: 'revision_changed' });
  if (!samePolicy(revision.approvalPolicy, input.currentApprovalPolicy)) return refused({ kind: 'policy_changed' });

  const needsApproval = revision.approvalPolicy.requirement === 'distinct_current_human';
  const approvals = needsApproval
    ? input.store.readApprovals(record.head.id, revision.revision.id)
    : [];
  let approval: StoredChangesetApproval | undefined;
  let approvalRefusal: CommitRefusal | undefined;
  for (const candidate of approvals) {
    const check = validateExactCommit(record.head, {
      expectedHeadVersion: input.expectedHeadVersion,
      expectedRevisionDigest: input.revisionDigest,
      currentAggregateVersions: input.currentAggregateVersions,
      currentGuardVersions: input.currentGuardVersions,
      currentGuardDigests: input.currentGuardDigests,
      now: context.evaluatedAt,
      approvalRequirement: revision.approvalPolicy.requirement,
      approval: candidate.receipt,
      approverCurrentlyAuthorized: input.approverCurrentlyAuthorized(candidate.receipt.approverPrincipalKey)
    });
    if (check.kind === 'ready') {
      approval = candidate;
      break;
    }
    approvalRefusal ??= check.refusal;
  }
  if (needsApproval && !approval && approvalRefusal) {
    return refused(commitRefusal(approvalRefusal));
  }
  if (needsApproval && !approval) return refused({ kind: 'approval_missing' });
  const validation = validateExactCommit(record.head, {
    expectedHeadVersion: input.expectedHeadVersion,
    expectedRevisionDigest: input.revisionDigest,
    currentAggregateVersions: input.currentAggregateVersions,
    currentGuardVersions: input.currentGuardVersions,
    currentGuardDigests: input.currentGuardDigests,
    now: context.evaluatedAt,
    approvalRequirement: revision.approvalPolicy.requirement,
    ...(approval === undefined ? {} : {
      approval: approval.receipt,
      approverCurrentlyAuthorized: input.approverCurrentlyAuthorized(approval.receipt.approverPrincipalKey)
    })
  });
  if (validation.kind === 'refused') return refused(commitRefusal(validation.refusal));
  const commit: ExactStoredChangesetCommit = Object.freeze({
    changesetId: record.head.id,
    headVersion: record.head.version,
    revisionId: revision.revision.id,
    revisionDigest: revision.revision.digest,
    authorization: validation.authorization,
    [exactCommitBrand]: true as const
  });
  exactCommits.set(commit, {
    record,
    context,
    receiptExpectation,
    ...(approval === undefined ? {} : { approvalId: approval.receipt.id }),
    phase: 'ready'
  });
  return Object.freeze({ kind: 'ready' as const, commit });
}

export function commitStoredChangeset(input: {
  readonly store: ChangesetLifecycleStore;
  readonly commit: ExactStoredChangesetCommit;
  readonly terminalReceipt: ChangesetCommitTerminalReceipt;
}): {
  readonly record: StoredChangesetRecord;
  readonly link: StoredChangesetCommitLink;
} {
  const state = exactCommits.get(input.commit);
  if (!state || state.phase !== 'ready' || input.commit[exactCommitBrand] !== true) {
    throw new TypeError('invalid_exact_stored_changeset_commit');
  }
  state.phase = 'spent';
  const receipt = parseChangesetCommitTerminalReceipt(input.terminalReceipt);
  assertTerminalReceiptExpectation(state, receipt);
  const receiptId = parseOperationReceiptId(receipt.ref.id);
  const committedHead = markChangesetCommittedHead(state.record.head, input.commit.authorization);
  const record = createStoredChangesetRecord({ head: committedHead, revisions: state.record.revisions });
  const revision = currentRevision(record).revision;
  const link = createStoredChangesetCommitLink({
    changesetId: record.head.id,
    committedHeadVersion: record.head.version,
    revisionId: revision.id,
    revisionDigest: revision.digest,
    commitReceiptId: receiptId,
    terminalReceiptBinding: {
      operation: {
        name: receipt.ref.operationName,
        version: receipt.ref.operationVersion
      },
      surface: receipt.identity.surface,
      scopePartitionKey: receipt.identity.scopePartitionKey,
      authorityPrincipalKey: receipt.identity.authorityPrincipalKey,
      requestHashSha256: receipt.requestHash,
      terminalReceiptDigestSha256: changesetCommitTerminalReceiptDigest(receipt)
    },
    committedAt: state.context.evaluatedAt,
    committerPrincipalKey: state.context.principalKey,
    ...(state.approvalId === undefined ? {} : { approvalId: state.approvalId })
  });
  assertCommitLink(record, link);
  if (input.store.commit({
    expectedHeadVersion: state.record.head.version,
    record,
    link
  }) !== 'committed') throw new TypeError('stale_changeset_commit_finalize');
  return Object.freeze({ record, link });
}

export function assertCommitLink(record: StoredChangesetRecord, link: StoredChangesetCommitLink): void {
  const parsedRecord = parseStoredChangesetRecord(record);
  const parsedLink = parseStoredChangesetCommitLink(link);
  const revision = currentRevision(parsedRecord).revision;
  if (parsedRecord.head.status !== 'committed'
    || parsedLink.changesetId !== parsedRecord.head.id
    || parsedLink.committedHeadVersion !== parsedRecord.head.version
    || parsedLink.revisionId !== revision.id
    || parsedLink.revisionDigest !== revision.digest) {
    throw new TypeError('changeset_commit_link_mismatch');
  }
}

export async function draftChangesetCorrection(input: {
  readonly store: ChangesetLifecycleStore;
  readonly registry: ChangesetDefinitionRegistry;
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly ids: ChangesetLifecycleIds;
  readonly context: TrustedChangesetActorContext;
  readonly sourceChangesetId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevisionDigest: string;
  readonly sourceCommitReceiptId: string;
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
}): Promise<
  | { readonly kind: 'exact' | 'semantic' | 'partial'; readonly record: StoredChangesetRecord; readonly link: StoredChangesetCorrectionLink }
  | { readonly kind: 'blocked'; readonly record: null; readonly link: StoredChangesetCorrectionLink }
  | { readonly kind: 'irreversible'; readonly record: StoredChangesetRecord | null; readonly link: StoredChangesetCorrectionLink }
  | Refused
> {
  const context = parseContext(input.context);
  const sourceRecord = input.store.read(parseChangesetId(input.sourceChangesetId));
  if (!sourceRecord) return refused({ kind: 'not_found' });
  if (!sameScope(sourceRecord, context)) return refused({ kind: 'scope_changed' });
  const sourceRevision = exactRevision(sourceRecord, {
    revisionId: parseChangesetRevisionId(input.sourceRevisionId),
    revisionDigest: input.sourceRevisionDigest
  });
  if (!sourceRevision) return refused({ kind: 'revision_changed' });
  if (sourceRecord.head.status !== 'committed') {
    return refused({ kind: 'wrong_status', status: sourceRecord.head.status });
  }
  const commitLink = input.store.readCommitLink(sourceRecord.head.id);
  if (!commitLink || commitLink.commitReceiptId !== parseOperationReceiptId(input.sourceCommitReceiptId)) {
    return refused({ kind: 'revision_changed' });
  }
  assertCommitLink(sourceRecord, commitLink);
  const committedSource = rehydrateCommittedChangesetSource({
    head: sourceRecord.head,
    revisionId: sourceRevision.revision.id,
    revisionDigest: sourceRevision.revision.digest,
    commitReceiptId: commitLink.commitReceiptId as OperationReceiptId
  });
  const correction = await planChangesetCompensation({
    registry: input.registry,
    source: committedSource,
    snapshot: input.snapshot
  });
  const evidence = correctionEvidence(correction);
  const correctionAttemptId = parseChangesetRevisionId(input.ids.newCorrectionAttemptId());
  if (correction.kind === 'blocked') {
    const link = createStoredChangesetCorrectionLink({
      id: correctionAttemptId,
      sourceChangesetId: sourceRecord.head.id,
      sourceRevisionId: sourceRevision.revision.id,
      sourceRevisionDigest: sourceRevision.revision.digest,
      sourceCommitReceiptId: commitLink.commitReceiptId,
      resultKind: correction.kind,
      target: null,
      evidence,
      draftedAt: context.evaluatedAt,
      draftedByPrincipalKey: context.principalKey
    });
    if (input.store.insertCorrection({ link }) !== 'inserted') return refused({ kind: 'id_collision' });
    return Object.freeze({ kind: 'blocked' as const, record: null, link });
  }
  if (correction.kind === 'irreversible' && correction.draft === null) {
    const link = createStoredChangesetCorrectionLink({
      id: correctionAttemptId,
      sourceChangesetId: sourceRecord.head.id,
      sourceRevisionId: sourceRevision.revision.id,
      sourceRevisionDigest: sourceRevision.revision.digest,
      sourceCommitReceiptId: commitLink.commitReceiptId,
      resultKind: 'irreversible',
      target: null,
      evidence,
      draftedAt: context.evaluatedAt,
      draftedByPrincipalKey: context.principalKey
    });
    if (input.store.insertCorrection({ link }) !== 'inserted') return refused({ kind: 'id_collision' });
    return Object.freeze({ kind: 'irreversible' as const, record: null, link });
  }
  const correctionDraft = correction.draft;
  if (correctionDraft === null) throw new TypeError('correction_draft_missing');
  const changesetId = parseChangesetId(input.ids.newChangesetId());
  const revisionId = parseChangesetRevisionId(input.ids.newRevisionId());
  const head = createChangeset({
    id: changesetId,
    workspaceId: context.workspaceId,
    ...(context.eventId === undefined ? {} : { eventId: context.eventId })
  }, {
    id: revisionId,
    createdAt: context.evaluatedAt,
    proposerPrincipalKey: context.principalKey,
    origin: 'human_ui',
    originProvenance: canonicalJsonValue({
      kind: 'changeset_correction',
      sourceChangesetId: sourceRecord.head.id,
      sourceRevisionId: sourceRevision.revision.id,
      sourceRevisionDigest: sourceRevision.revision.digest,
      sourceCommitReceiptId: commitLink.commitReceiptId,
      resultKind: correction.kind
    }),
    operations: correctionDraft.operations,
    dependencyGroups: correctionDraft.dependencyGroups,
    approvalPolicy: input.approvalPolicy.reference
  });
  const revision = head.revisions[0]!;
  const intents = revision.operations.map((operation, index): StoredChangesetAuthorIntent => {
    const definition = input.registry.get(operation.kind, operation.version);
    if (!definition) throw new TypeError('unknown_compensation_definition');
    const authorSchema = input.registry.getSchema(definition.schemas.authorInput);
    if (!authorSchema) throw new TypeError('compensation_author_schema_missing');
    return Object.freeze({
      operationIndex: index,
      kind: operation.kind,
      version: operation.version,
      dependencyGroup: operation.dependencyGroup,
      authorInputSchema: Object.freeze({ ...definition.schemas.authorInput }),
      authorInput: canonicalJsonValue(authorSchema.schema.parse(correctionDraft.authorInputs[index]))
    });
  });
  const revisionRecord = createStoredChangesetRevisionRecord({
    revision,
    authorIntents: intents,
    approvalPolicy: input.approvalPolicy
  });
  const record = createStoredChangesetRecord({ head, revisions: [revisionRecord] });
  const link = createStoredChangesetCorrectionLink({
    id: correctionAttemptId,
    sourceChangesetId: sourceRecord.head.id,
    sourceRevisionId: sourceRevision.revision.id,
    sourceRevisionDigest: sourceRevision.revision.digest,
    sourceCommitReceiptId: commitLink.commitReceiptId,
    resultKind: correction.kind,
    target: {
      changesetId: record.head.id,
      revisionId: revision.id,
      revisionDigest: revision.digest
    },
    evidence,
    draftedAt: context.evaluatedAt,
    draftedByPrincipalKey: context.principalKey
  });
  assertCorrectionLink(sourceRecord, commitLink, record, link);
  if (input.store.insertCorrection({ link, target: record }) !== 'inserted') {
    return refused({ kind: 'id_collision' });
  }
  return correction.kind === 'irreversible'
    ? Object.freeze({ kind: 'irreversible' as const, record, link })
    : Object.freeze({ kind: correction.kind, record, link });
}

/** Synchronous correction draft for a transaction-local single-unit-of-work handler. */
export function draftChangesetCorrectionSynchronous(input: {
  readonly store: ChangesetLifecycleStore;
  readonly registry: ChangesetDefinitionRegistry;
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly ids: ChangesetLifecycleIds;
  readonly context: TrustedChangesetActorContext;
  readonly sourceChangesetId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevisionDigest: string;
  readonly sourceCommitReceiptId: string;
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
}):
  | { readonly kind: 'exact' | 'semantic' | 'partial'; readonly record: StoredChangesetRecord; readonly link: StoredChangesetCorrectionLink }
  | { readonly kind: 'blocked'; readonly record: null; readonly link: StoredChangesetCorrectionLink }
  | { readonly kind: 'irreversible'; readonly record: StoredChangesetRecord | null; readonly link: StoredChangesetCorrectionLink }
  | Refused {
  const context = parseContext(input.context);
  const sourceRecord = input.store.read(parseChangesetId(input.sourceChangesetId));
  if (!sourceRecord) return refused({ kind: 'not_found' });
  if (!sameScope(sourceRecord, context)) return refused({ kind: 'scope_changed' });
  const sourceRevision = exactRevision(sourceRecord, {
    revisionId: parseChangesetRevisionId(input.sourceRevisionId),
    revisionDigest: input.sourceRevisionDigest
  });
  if (!sourceRevision) return refused({ kind: 'revision_changed' });
  if (sourceRecord.head.status !== 'committed') {
    return refused({ kind: 'wrong_status', status: sourceRecord.head.status });
  }
  const commitLink = input.store.readCommitLink(sourceRecord.head.id);
  if (!commitLink
      || commitLink.commitReceiptId !== parseOperationReceiptId(input.sourceCommitReceiptId)) {
    return refused({ kind: 'revision_changed' });
  }
  assertCommitLink(sourceRecord, commitLink);
  const committedSource = rehydrateCommittedChangesetSource({
    head: sourceRecord.head,
    revisionId: sourceRevision.revision.id,
    revisionDigest: sourceRevision.revision.digest,
    commitReceiptId: commitLink.commitReceiptId as OperationReceiptId
  });
  const correction = planChangesetCompensationSynchronous({
    registry: input.registry,
    source: committedSource,
    snapshot: input.snapshot
  });
  const evidence = correctionEvidence(correction);
  const correctionAttemptId = parseChangesetRevisionId(input.ids.newCorrectionAttemptId());
  if (correction.kind === 'blocked') {
    const link = createStoredChangesetCorrectionLink({
      id: correctionAttemptId,
      sourceChangesetId: sourceRecord.head.id,
      sourceRevisionId: sourceRevision.revision.id,
      sourceRevisionDigest: sourceRevision.revision.digest,
      sourceCommitReceiptId: commitLink.commitReceiptId,
      resultKind: correction.kind,
      target: null,
      evidence,
      draftedAt: context.evaluatedAt,
      draftedByPrincipalKey: context.principalKey
    });
    if (input.store.insertCorrection({ link }) !== 'inserted') {
      return refused({ kind: 'id_collision' });
    }
    return Object.freeze({ kind: 'blocked' as const, record: null, link });
  }
  if (correction.kind === 'irreversible' && correction.draft === null) {
    const link = createStoredChangesetCorrectionLink({
      id: correctionAttemptId,
      sourceChangesetId: sourceRecord.head.id,
      sourceRevisionId: sourceRevision.revision.id,
      sourceRevisionDigest: sourceRevision.revision.digest,
      sourceCommitReceiptId: commitLink.commitReceiptId,
      resultKind: 'irreversible',
      target: null,
      evidence,
      draftedAt: context.evaluatedAt,
      draftedByPrincipalKey: context.principalKey
    });
    if (input.store.insertCorrection({ link }) !== 'inserted') {
      return refused({ kind: 'id_collision' });
    }
    return Object.freeze({ kind: 'irreversible' as const, record: null, link });
  }
  const correctionDraft = correction.draft;
  if (correctionDraft === null) throw new TypeError('correction_draft_missing');
  const changesetId = parseChangesetId(input.ids.newChangesetId());
  const revisionId = parseChangesetRevisionId(input.ids.newRevisionId());
  const head = createChangeset({
    id: changesetId,
    workspaceId: context.workspaceId,
    ...(context.eventId === undefined ? {} : { eventId: context.eventId })
  }, {
    id: revisionId,
    createdAt: context.evaluatedAt,
    proposerPrincipalKey: context.principalKey,
    origin: 'human_ui',
    originProvenance: canonicalJsonValue({
      kind: 'changeset_correction',
      sourceChangesetId: sourceRecord.head.id,
      sourceRevisionId: sourceRevision.revision.id,
      sourceRevisionDigest: sourceRevision.revision.digest,
      sourceCommitReceiptId: commitLink.commitReceiptId,
      resultKind: correction.kind
    }),
    operations: correctionDraft.operations,
    dependencyGroups: correctionDraft.dependencyGroups,
    approvalPolicy: input.approvalPolicy.reference
  });
  const revision = head.revisions[0]!;
  const intents = revision.operations.map((operation, index): StoredChangesetAuthorIntent => {
    const definition = input.registry.get(operation.kind, operation.version);
    if (!definition) throw new TypeError('unknown_compensation_definition');
    const authorSchema = input.registry.getSchema(definition.schemas.authorInput);
    if (!authorSchema) throw new TypeError('compensation_author_schema_missing');
    return Object.freeze({
      operationIndex: index,
      kind: operation.kind,
      version: operation.version,
      dependencyGroup: operation.dependencyGroup,
      authorInputSchema: Object.freeze({ ...definition.schemas.authorInput }),
      authorInput: canonicalJsonValue(authorSchema.schema.parse(correctionDraft.authorInputs[index]))
    });
  });
  const revisionRecord = createStoredChangesetRevisionRecord({
    revision,
    authorIntents: intents,
    approvalPolicy: input.approvalPolicy
  });
  const record = createStoredChangesetRecord({ head, revisions: [revisionRecord] });
  const link = createStoredChangesetCorrectionLink({
    id: correctionAttemptId,
    sourceChangesetId: sourceRecord.head.id,
    sourceRevisionId: sourceRevision.revision.id,
    sourceRevisionDigest: sourceRevision.revision.digest,
    sourceCommitReceiptId: commitLink.commitReceiptId,
    resultKind: correction.kind,
    target: {
      changesetId: record.head.id,
      revisionId: revision.id,
      revisionDigest: revision.digest
    },
    evidence,
    draftedAt: context.evaluatedAt,
    draftedByPrincipalKey: context.principalKey
  });
  assertCorrectionLink(sourceRecord, commitLink, record, link);
  if (input.store.insertCorrection({ link, target: record }) !== 'inserted') {
    return refused({ kind: 'id_collision' });
  }
  return correction.kind === 'irreversible'
    ? Object.freeze({ kind: 'irreversible' as const, record, link })
    : Object.freeze({ kind: correction.kind, record, link });
}

function correctionEvidence(
  result: CompensationPlanningResult
): StoredChangesetCorrectionEvidence {
  const operations = result.operationEvidence.map((entry) => ({
    ...entry,
    lineage: { ...entry.lineage },
    ...('conflictKeys' in entry ? { conflictKeys: [...entry.conflictKeys].sort() } : {})
  }));
  const notes = 'notes' in result
    ? result.notes.map((note) => ({ lineage: { ...note.lineage }, noteKey: note.noteKey }))
    : [];
  const conflicts = 'conflicts' in result
    ? result.conflicts.map((conflict) => ({
        lineage: { ...conflict.lineage },
        conflictKeys: [...conflict.conflictKeys].sort()
      }))
    : [];
  switch (result.kind) {
    case 'exact': return Object.freeze({ kind: 'exact', operations: Object.freeze(operations) });
    case 'semantic': return Object.freeze({
      kind: 'semantic',
      notes: Object.freeze(notes),
      operations: Object.freeze(operations)
    });
    case 'partial': return Object.freeze({
      kind: 'partial',
      conflicts: Object.freeze(conflicts),
      notes: Object.freeze(notes),
      operations: Object.freeze(operations)
    });
    case 'blocked': return Object.freeze({
      kind: 'blocked',
      blockers: Object.freeze(result.blockers.map((blocker) => ({
        lineage: { ...blocker.lineage },
        reasonKey: blocker.reasonKey
      }))),
      remediations: Object.freeze(result.remediations.map((remediation) => ({
        lineage: { ...remediation.lineage },
        remediationKey: remediation.remediationKey
      }))),
      conflicts: Object.freeze(conflicts),
      notes: Object.freeze(notes),
      operations: Object.freeze(operations)
    });
    case 'irreversible': return Object.freeze({
      kind: 'irreversible',
      remediations: Object.freeze(result.remediations.map((remediation) => ({
        lineage: { ...remediation.lineage },
        remediationKey: remediation.remediationKey
      }))),
      conflicts: Object.freeze(conflicts),
      notes: Object.freeze(notes),
      operations: Object.freeze(operations)
    });
  }
}

export function assertRebuildLink(
  record: StoredChangesetRecord,
  link: StoredChangesetRebuildLink
): void {
  const parsedRecord = parseStoredChangesetRecord(record);
  const parsedLink = parseStoredChangesetRebuildLink(link);
  const targetRecord = parsedRecord.revisions.at(-1);
  const sourceRecord = parsedRecord.revisions.at(-2);
  const target = targetRecord?.revision;
  const source = sourceRecord?.revision;
  if (!sourceRecord || !targetRecord || !source || !target
    || parsedLink.changesetId !== parsedRecord.head.id
    || parsedLink.sourceRevisionId !== source.id
    || parsedLink.sourceRevisionDigest !== source.digest
    || parsedLink.targetRevisionId !== target.id
    || parsedLink.targetRevisionDigest !== target.digest) {
    throw new TypeError('changeset_rebuild_link_mismatch');
  }
  if (source.operations.length !== target.operations.length
    || sourceRecord.authorIntents.length !== targetRecord.authorIntents.length
    || source.operations.length !== sourceRecord.authorIntents.length
    || canonicalJsonSha256(source.dependencyGroups) !== canonicalJsonSha256(target.dependencyGroups)) {
    throw new TypeError('changeset_rebuild_shape_mismatch');
  }
  const provenance = target.originProvenance;
  const provenanceRecord = provenance as Readonly<Record<string, unknown>> | undefined;
  if (!provenanceRecord || Array.isArray(provenance)
    || provenanceRecord.kind !== 'changeset_rebuild'
    || provenanceRecord.sourceRevisionId !== source.id
    || provenanceRecord.sourceRevisionDigest !== source.digest
    || canonicalJsonSha256(provenanceRecord.replannedGroups) !== canonicalJsonSha256(parsedLink.replannedGroups)) {
    throw new TypeError('changeset_rebuild_provenance_mismatch');
  }
  if (parsedLink.rebuiltAt !== target.createdAt
    || parsedLink.rebuiltByPrincipalKey !== target.proposerPrincipalKey) {
    throw new TypeError('changeset_rebuild_actor_time_mismatch');
  }
  assertReplanSelection(source, new Set(parsedLink.replannedGroups));
  for (const [index, operation] of target.operations.entries()) {
    const sourceOperation = source.operations[index];
    const sourceIntent = sourceRecord.authorIntents[index];
    const targetIntent = targetRecord.authorIntents[index];
    if (!sourceOperation || !sourceIntent || !targetIntent
      || operation.kind !== sourceOperation.kind
      || operation.version !== sourceOperation.version
      || operation.dependencyGroup !== sourceOperation.dependencyGroup
      || canonicalJsonSha256(operation.compensationLineage ?? null)
        !== canonicalJsonSha256(sourceOperation.compensationLineage ?? null)
      || canonicalJsonSha256(targetIntent) !== canonicalJsonSha256(sourceIntent)) {
      throw new TypeError('changeset_rebuild_operation_mismatch');
    }
    if (!parsedLink.replannedGroups.includes(sourceOperation.dependencyGroup)
      && canonicalJsonSha256(operation) !== canonicalJsonSha256(sourceOperation)) {
      throw new TypeError('changeset_rebuild_retained_operation_changed');
    }
  }
}

export function assertCorrectionLink(
  source: StoredChangesetRecord,
  commitLink: StoredChangesetCommitLink,
  target: StoredChangesetRecord | undefined,
  link: StoredChangesetCorrectionLink
): void {
  const parsedSource = parseStoredChangesetRecord(source);
  const parsedCommit = parseStoredChangesetCommitLink(commitLink);
  const parsedLink = parseStoredChangesetCorrectionLink(link);
  const sourceRevision = currentRevision(parsedSource).revision;
  if (parsedLink.sourceChangesetId !== parsedSource.head.id
    || parsedLink.sourceRevisionId !== sourceRevision.id
    || parsedLink.sourceRevisionDigest !== sourceRevision.digest
    || parsedLink.sourceCommitReceiptId !== parsedCommit.commitReceiptId) {
    throw new TypeError('changeset_correction_source_mismatch');
  }
  const evidenceLineages = parsedLink.evidence.kind === 'exact'
    ? parsedLink.evidence.operations.map((entry) => entry.lineage)
    : parsedLink.evidence.kind === 'semantic'
      ? [
          ...parsedLink.evidence.notes.map((entry) => entry.lineage),
          ...parsedLink.evidence.operations.map((entry) => entry.lineage)
        ]
      : parsedLink.evidence.kind === 'partial'
        ? [
            ...parsedLink.evidence.conflicts.map((entry) => entry.lineage),
            ...parsedLink.evidence.notes.map((entry) => entry.lineage),
            ...parsedLink.evidence.operations.map((entry) => entry.lineage)
          ]
        : parsedLink.evidence.kind === 'blocked'
          ? [
              ...parsedLink.evidence.blockers.map((entry) => entry.lineage),
              ...parsedLink.evidence.remediations.map((entry) => entry.lineage),
              ...parsedLink.evidence.operations.map((entry) => entry.lineage)
            ]
          : [
              ...parsedLink.evidence.remediations.map((entry) => entry.lineage),
              ...parsedLink.evidence.conflicts.map((entry) => entry.lineage),
              ...parsedLink.evidence.notes.map((entry) => entry.lineage),
              ...parsedLink.evidence.operations.map((entry) => entry.lineage)
            ];
  for (const lineage of evidenceLineages) {
    assertCorrectionLineage(sourceRevision, lineage);
  }
  assertCompleteCorrectionEvidence(sourceRevision, parsedLink.evidence);
  const shouldHaveTarget = parsedLink.evidence.kind !== 'blocked'
    && parsedLink.evidence.operations.every((entry) => entry.draftable);
  if ((parsedLink.target !== null) !== shouldHaveTarget) {
    throw new TypeError('changeset_correction_evidence_target_mismatch');
  }
  if (parsedLink.target === null) {
    if (target !== undefined) throw new TypeError('changeset_correction_target_mismatch');
    return;
  }
  if (!target) throw new TypeError('changeset_correction_target_mismatch');
  const parsedTarget = parseStoredChangesetRecord(target);
  const targetRevision = currentRevision(parsedTarget).revision;
  if (parsedLink.target.changesetId !== parsedTarget.head.id
    || parsedLink.target.revisionId !== targetRevision.id
    || parsedLink.target.revisionDigest !== targetRevision.digest
    || parsedTarget.head.workspaceId !== parsedSource.head.workspaceId
    || parsedTarget.head.eventId !== parsedSource.head.eventId) {
    throw new TypeError('changeset_correction_target_mismatch');
  }
  if (parsedLink.draftedAt !== targetRevision.createdAt
    || parsedLink.draftedByPrincipalKey !== targetRevision.proposerPrincipalKey) {
    throw new TypeError('changeset_correction_actor_time_mismatch');
  }
  const provenance = targetRevision.originProvenance;
  const provenanceRecord = provenance as Readonly<Record<string, unknown>> | undefined;
  if (!provenanceRecord || Array.isArray(provenance)
    || provenanceRecord.kind !== 'changeset_correction'
    || provenanceRecord.sourceChangesetId !== parsedSource.head.id
    || provenanceRecord.sourceRevisionId !== sourceRevision.id
    || provenanceRecord.sourceRevisionDigest !== sourceRevision.digest
    || provenanceRecord.sourceCommitReceiptId !== parsedCommit.commitReceiptId
    || provenanceRecord.resultKind !== parsedLink.resultKind) {
    throw new TypeError('changeset_correction_provenance_mismatch');
  }
  if (targetRevision.operations.length !== sourceRevision.operations.length
    || targetRevision.dependencyGroups.length !== sourceRevision.dependencyGroups.length
    || canonicalJsonSha256([...targetRevision.dependencyGroups.map((group) => group.key)].sort())
      !== canonicalJsonSha256([...sourceRevision.dependencyGroups.map((group) => group.key)].sort())) {
    throw new TypeError('changeset_correction_lineage_coverage_mismatch');
  }
  const lineageIndices = new Set<number>();
  for (const [index, operation] of targetRevision.operations.entries()) {
    const lineage = operation.compensationLineage;
    if (!lineage) {
      throw new TypeError(`changeset_correction_lineage_mismatch:${index}`);
    }
    assertCorrectionLineage(sourceRevision, lineage, index);
    if (lineageIndices.has(lineage.sourceOperationIndex)) {
      throw new TypeError('changeset_correction_lineage_duplicate');
    }
    lineageIndices.add(lineage.sourceOperationIndex);
    if (operation.kind !== lineage.sourceOperationKind
      || operation.version !== lineage.sourceOperationVersion
      || operation.dependencyGroup !== lineage.sourceDependencyGroup) {
      throw new TypeError(`changeset_correction_operation_identity_mismatch:${index}`);
    }
  }
  if (lineageIndices.size !== sourceRevision.operations.length) {
    throw new TypeError('changeset_correction_lineage_coverage_mismatch');
  }
  const targetOrder = new Map(
    targetRevision.dependencyGroups.map((group, index) => [group.key, index])
  );
  for (const targetGroup of targetRevision.dependencyGroups) {
    const expectedDependencies = sourceRevision.dependencyGroups
      .filter((sourceGroup) => sourceGroup.dependsOn.includes(targetGroup.key))
      .map((sourceGroup) => sourceGroup.key)
      .sort((left, right) => targetOrder.get(left)! - targetOrder.get(right)!);
    if (canonicalJsonSha256(targetGroup.dependsOn) !== canonicalJsonSha256(expectedDependencies)) {
      throw new TypeError('changeset_correction_dependency_graph_mismatch');
    }
  }
}

function assertCompleteCorrectionEvidence(
  sourceRevision: ChangesetRevision,
  evidence: StoredChangesetCorrectionEvidence
): void {
  if (evidence.operations.length !== sourceRevision.operations.length) {
    throw new TypeError('changeset_correction_evidence_coverage_mismatch');
  }
  for (const [index, entry] of evidence.operations.entries()) {
    if (entry.lineage.sourceOperationIndex !== index) {
      throw new TypeError('changeset_correction_evidence_order_mismatch');
    }
    assertCorrectionLineage(sourceRevision, entry.lineage);
  }

  const derivedKind = evidence.operations.some((entry) => entry.kind === 'blocked')
    ? 'blocked'
    : evidence.operations.some((entry) => entry.kind === 'irreversible')
      ? 'irreversible'
      : evidence.operations.some((entry) => entry.kind === 'partial')
        ? 'partial'
        : evidence.operations.some((entry) => entry.kind === 'semantic')
          ? 'semantic'
          : 'exact';
  if (derivedKind !== evidence.kind) {
    throw new TypeError('changeset_correction_evidence_result_mismatch');
  }

  const notes = evidence.operations
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'semantic' }> => entry.kind === 'semantic')
    .map((entry) => ({ lineage: entry.lineage, noteKey: entry.noteKey }));
  const conflicts = evidence.operations
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'partial' }> => entry.kind === 'partial')
    .map((entry) => ({ lineage: entry.lineage, conflictKeys: entry.conflictKeys }));
  const blockers = evidence.operations
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'blocked' }> => entry.kind === 'blocked')
    .map((entry) => ({ lineage: entry.lineage, reasonKey: entry.reasonKey }));
  const remediations = evidence.operations
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'irreversible' }> => entry.kind === 'irreversible')
    .map((entry) => ({ lineage: entry.lineage, remediationKey: entry.remediationKey }));
  const summaries = {
    notes: 'notes' in evidence ? evidence.notes : [],
    conflicts: 'conflicts' in evidence ? evidence.conflicts : [],
    blockers: 'blockers' in evidence ? evidence.blockers : [],
    remediations: 'remediations' in evidence ? evidence.remediations : []
  };
  if (canonicalJsonSha256(summaries.notes) !== canonicalJsonSha256(notes)
    || canonicalJsonSha256(summaries.conflicts) !== canonicalJsonSha256(conflicts)
    || canonicalJsonSha256(summaries.blockers) !== canonicalJsonSha256(blockers)
    || canonicalJsonSha256(summaries.remediations) !== canonicalJsonSha256(remediations)) {
    throw new TypeError('changeset_correction_evidence_summary_mismatch');
  }
}

function assertCorrectionLineage(
  sourceRevision: ChangesetRevision,
  lineage: {
    readonly sourceRevisionId: string;
    readonly sourceRevisionDigest: string;
    readonly sourceOperationIndex: number;
    readonly sourceOperationKind: string;
    readonly sourceOperationVersion: number;
    readonly sourceDependencyGroup: string;
  },
  targetOperationIndex?: number
): void {
  const sourceOperation = sourceRevision.operations[lineage.sourceOperationIndex];
  if (lineage.sourceRevisionId !== sourceRevision.id
    || lineage.sourceRevisionDigest !== sourceRevision.digest
    || lineage.sourceOperationIndex < 0
    || !sourceOperation
    || lineage.sourceOperationKind !== sourceOperation.kind
    || lineage.sourceOperationVersion !== sourceOperation.version
    || lineage.sourceDependencyGroup !== sourceOperation.dependencyGroup) {
    throw new TypeError(targetOperationIndex === undefined
      ? 'changeset_correction_evidence_lineage_mismatch'
      : `changeset_correction_lineage_mismatch:${targetOperationIndex}`);
  }
}

export function storedApprovalCanonicalIdentity(approval: StoredChangesetApproval): string {
  const parsed = parseStoredChangesetApproval(approval);
  return canonicalJsonSha256({
    changesetId: parsed.changesetId,
    approvalId: parsed.receipt.id,
    revisionId: parsed.receipt.revisionId,
    revisionDigest: parsed.receipt.revisionDigest
  });
}
