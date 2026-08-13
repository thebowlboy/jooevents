import { describe, expect, test } from 'bun:test';
import {
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  applyPreparedChangesetSynchronous,
  prepareChangesetCommitSynchronous,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type ChangesetPlanningSnapshot
} from '@jooevents/changesets';
import { z } from 'zod';
import {
  appendChangesetDraftSynchronous,
  approveStoredChangeset,
  assertCorrectionLink,
  commitStoredChangeset,
  createStoredChangesetCorrectionLink,
  draftChangesetCorrection,
  proposeStoredChangeset,
  readChangesetDiff,
  rebuildStoredChangeset,
  validateStoredChangesetCommit,
  type CapturedChangesetApprovalPolicy,
  type ChangesetCommitReceiptExpectation,
  type ChangesetCommitTerminalReceipt,
  type ChangesetLifecycleIds,
  type ChangesetLifecycleStore,
  type StoredChangesetApproval,
  type StoredChangesetCommitLink,
  type StoredChangesetCorrectionLink,
  type StoredChangesetRecord,
  type TrustedChangesetActorContext
} from '.';

type CompensationMode = 'exact' | 'blocked' | 'irreversible' | 'mixed';

interface RecordState {
  readonly label: string;
  readonly version: number;
  readonly compensationMode: CompensationMode;
}

interface RecordReadPort {
  read(): RecordState;
}

const recordReadPort = defineChangesetReadPort<RecordReadPort>('record.read', 1);
const authorSchema = defineChangesetSchema({
  key: 'record.change.author',
  version: 1,
  schema: z.strictObject({
    label: z.string().trim().min(1),
    risk: z.enum(['normal', 'consequential'])
  })
});
const planSchema = defineChangesetSchema({
  key: 'record.change.plan',
  version: 1,
  schema: z.strictObject({
    beforeLabel: z.string(),
    nextLabel: z.string(),
    expectedVersion: z.number().int().positive(),
    risk: z.enum(['normal', 'consequential'])
  })
});
const diffSchema = defineChangesetSchema({
  key: 'record.change.diff',
  version: 1,
  schema: z.strictObject({ before: z.string(), after: z.string() })
});
const resultSchema = defineChangesetSchema({
  key: 'record.change.result',
  version: 1,
  schema: z.strictObject({ label: z.string(), version: z.number().int().positive() })
});

type Author = z.infer<typeof authorSchema.schema>;
type Plan = z.infer<typeof planSchema.schema>;

function definition(
  override: Partial<ChangesetOperationDefinition<Author, Plan, { before: string; after: string }, Plan, { label: string; version: number }>> = {}
): ChangesetOperationDefinition<Author, Plan, { before: string; after: string }, Plan, { label: string; version: number }> {
  return {
    kind: 'record.change',
    version: 1,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [recordReadPort],
    validationPorts: [],
    transactionPorts: [],
    allowedAggregateKinds: ['record'],
    allowedGuardKinds: [],
    allowedRisks: ['normal', 'consequential'],
    allowedConsequences: ['record_changed'],
    allowedOutcomes: [],
    allowedFacts: [],
    allowedEffects: [],
    plan(input, snapshot) {
      const current = snapshot.getPort(recordReadPort).read();
      return {
        plan: {
          beforeLabel: current.label,
          nextLabel: input.label,
          expectedVersion: current.version,
          risk: input.risk
        },
        aggregateRefs: [{ id: 'record:one', version: current.version }],
        guardRefs: [],
        riskTier: input.risk,
        consequences: ['record_changed']
      };
    },
    projectDiff(plan) {
      return {
        diff: { before: plan.beforeLabel, after: plan.nextLabel },
        representedConsequences: ['record_changed']
      };
    },
    validateWithin(plan) {
      return { kind: 'ready', validated: plan };
    },
    applyWithin(plan) {
      return {
        result: { label: plan.nextLabel, version: plan.expectedVersion + 1 },
        facts: [],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      const current = snapshot.getPort(recordReadPort).read();
      if (current.compensationMode === 'mixed') {
        const authorInput = { label: plan.beforeLabel, risk: 'normal' as const };
        if (plan.nextLabel === 'Semantic') {
          return { kind: 'semantic', authorInput, noteKey: 'record.semantic_match' };
        }
        if (plan.nextLabel === 'Partial') {
          return {
            kind: 'partial',
            authorInput,
            conflicts: ['record.later_work_preserved']
          };
        }
        return { kind: 'blocked', reasonKey: 'record.correction_requires_review' };
      }
      if (current.compensationMode === 'blocked') {
        return { kind: 'blocked', reasonKey: 'record.changed_after_source' };
      }
      const authorInput = { label: plan.beforeLabel, risk: 'normal' as const };
      return current.compensationMode === 'irreversible'
        ? { kind: 'irreversible', remediationKey: 'record.external_remediation', authorInput }
        : { kind: 'exact', authorInput };
    },
    ...override
  };
}

function registry(operation = definition()): ChangesetDefinitionRegistry {
  return createChangesetDefinitionRegistry({
    schemas: [authorSchema, planSchema, diffSchema, resultSchema],
    definitions: [operation]
  });
}

class Domain implements RecordReadPort {
  state: RecordState = { label: 'Before', version: 1, compensationMode: 'exact' };

  read(): RecordState {
    return this.state;
  }

  snapshot(): ChangesetPlanningSnapshot {
    return Object.freeze({
      getPort: <Port>(key: { readonly key: string; readonly version: number }): Port => {
        if (key !== recordReadPort) throw new TypeError('unknown_test_read_port');
        return this as unknown as Port;
      }
    });
  }
}

class MemoryStore implements ChangesetLifecycleStore {
  readonly records = new Map<string, StoredChangesetRecord>();
  readonly approvals = new Map<string, StoredChangesetApproval>();
  readonly commits = new Map<string, StoredChangesetCommitLink>();
  readonly corrections = new Map<string, StoredChangesetCorrectionLink>();

  read(changesetId: string): StoredChangesetRecord | undefined {
    return this.records.get(changesetId);
  }

  insertDraft(record: StoredChangesetRecord): 'inserted' | 'exists' {
    if (this.records.has(record.head.id)) return 'exists';
    this.records.set(record.head.id, record);
    return 'inserted';
  }

  replaceHead(input: {
    readonly expectedHeadVersion: number;
    readonly record: StoredChangesetRecord;
  }): 'advanced' | 'stale' | 'not_found' {
    const current = this.records.get(input.record.head.id);
    if (!current) return 'not_found';
    if (current.head.version !== input.expectedHeadVersion) return 'stale';
    this.records.set(input.record.head.id, input.record);
    return 'advanced';
  }

  readApprovals(changesetId: string, revisionId: string): readonly StoredChangesetApproval[] {
    return [...this.approvals.values()].filter((approval) =>
      approval.changesetId === changesetId && approval.receipt.revisionId === revisionId
    );
  }

  insertApproval(record: StoredChangesetApproval): 'inserted' | 'exists' {
    if (this.approvals.has(record.receipt.id)) return 'exists';
    this.approvals.set(record.receipt.id, record);
    return 'inserted';
  }

  readCommitLink(changesetId: string): StoredChangesetCommitLink | undefined {
    return this.commits.get(changesetId);
  }

  commit(input: {
    readonly expectedHeadVersion: number;
    readonly record: StoredChangesetRecord;
    readonly link: StoredChangesetCommitLink;
  }): 'committed' | 'stale' | 'not_found' {
    const current = this.records.get(input.record.head.id);
    if (!current) return 'not_found';
    if (current.head.version !== input.expectedHeadVersion) return 'stale';
    this.records.set(input.record.head.id, input.record);
    this.commits.set(input.record.head.id, input.link);
    return 'committed';
  }

  insertCorrection(input: {
    readonly link: StoredChangesetCorrectionLink;
    readonly target?: StoredChangesetRecord;
  }): 'inserted' | 'exists' {
    if (this.corrections.has(input.link.id)
      || (input.target !== undefined && this.records.has(input.target.head.id))) return 'exists';
    if (input.target !== undefined) this.records.set(input.target.head.id, input.target);
    this.corrections.set(input.link.id, input.link);
    return 'inserted';
  }

  readCorrection(correctionId: string): StoredChangesetCorrectionLink | undefined {
    return this.corrections.get(correctionId);
  }

  readCorrections(sourceChangesetId: string): readonly StoredChangesetCorrectionLink[] {
    return [...this.corrections.values()].filter((link) => link.sourceChangesetId === sourceChangesetId);
  }

  restart(): MemoryStore {
    const next = new MemoryStore();
    for (const [key, value] of this.records) next.records.set(key, structuredClone(value));
    for (const [key, value] of this.approvals) next.approvals.set(key, structuredClone(value));
    for (const [key, value] of this.commits) next.commits.set(key, structuredClone(value));
    for (const [key, value] of this.corrections) next.corrections.set(key, structuredClone(value));
    return next;
  }
}

const workspaceId = '018f3000-0000-7000-8000-000000000001';
const eventId = '018f3000-0000-7000-8000-000000000002';
const authorityPrincipalKey = '1'.repeat(64);
const expectation: ChangesetCommitReceiptExpectation = {
  operation: { name: 'changeset.commit', version: 1 },
  surface: 'operator_http',
  scopePartitionKey: '2'.repeat(64),
  authorityPrincipalKey,
  requestHashSha256: '3'.repeat(64)
};
const noApproval: CapturedChangesetApprovalPolicy = {
  reference: { key: 'approval.bounded', version: 1 },
  definitionDigestSha256: 'a'.repeat(64),
  requirement: 'none'
};
const distinctApproval: CapturedChangesetApprovalPolicy = {
  reference: { key: 'approval.distinct_human', version: 1 },
  definitionDigestSha256: 'b'.repeat(64),
  requirement: 'distinct_current_human'
};

function context(principalKey: string, evaluatedAt: string): TrustedChangesetActorContext {
  return { workspaceId, eventId, principalKey, authorityPrincipalKey, evaluatedAt };
}

function ids(): ChangesetLifecycleIds {
  return {
    newChangesetId: () => crypto.randomUUID(),
    newRevisionId: () => crypto.randomUUID(),
    newApprovalId: () => crypto.randomUUID(),
    newCorrectionAttemptId: () => crypto.randomUUID()
  };
}

function terminalReceipt(input: {
  readonly id: string;
  readonly changesetId: string;
  readonly expectedHeadVersion: number;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly requestHash?: string;
}): ChangesetCommitTerminalReceipt {
  const receipt = {
    id: input.id,
    operationName: expectation.operation.name,
    operationVersion: expectation.operation.version
  } as const;
  return {
    ref: receipt,
    identity: {
      scopePartitionKey: expectation.scopePartitionKey,
      authorityPrincipalKey: expectation.authorityPrincipalKey,
      operationName: expectation.operation.name,
      operationVersion: expectation.operation.version,
      surface: expectation.surface,
      idempotencyVerifierProfile: { key: 'changeset.commit.idempotency', version: 1 },
      idempotencyKeyVerifier: '4'.repeat(64)
    },
    requestHash: input.requestHash ?? expectation.requestHashSha256,
    result: {
      kind: 'success',
      data: {
        schemaVersion: 1,
        action: 'commit',
        changesetId: input.changesetId,
        expectedHeadVersion: input.expectedHeadVersion,
        committedHeadVersion: input.expectedHeadVersion + 1,
        revisionId: input.revisionId,
        revisionDigest: input.revisionDigest
      },
      receipt,
      correlationId: crypto.randomUUID()
    }
  };
}

function applyValidatedCommit(commit: ReturnType<typeof validateStoredChangesetCommit>): void {
  if (commit.kind !== 'ready') throw new Error('commit was not ready');
  const prepared = prepareChangesetCommitSynchronous({
    registry: registry(),
    authorization: commit.commit.authorization,
    transaction: Object.freeze({
      getPort(): never {
        throw new TypeError('unexpected_test_transaction_port');
      }
    })
  });
  if (prepared.kind !== 'ready') throw new Error('commit preparation refused');
  applyPreparedChangesetSynchronous(prepared.prepared);
}

describe('ordinary changeset lifecycle service', () => {
  test('traverses draft, diff, proposal, stale rebuild, exact receipt commit, restart, and correction outcomes', async () => {
    const store = new MemoryStore();
    const domain = new Domain();
    const catalog = registry();
    const created = appendChangesetDraftSynchronous({
      store,
      registry: catalog,
      snapshot: domain.snapshot(),
      ids: ids(),
      context: context('principal:alice', '2026-08-12T00:00:00.000Z'),
      operations: [{
        kind: 'record.change',
        version: 1,
        dependencyGroup: 'record',
        authorInput: { label: 'After', risk: 'consequential' }
      }],
      dependencyGroups: [{ key: 'record', dependsOn: [] }],
      approvalPolicy: noApproval,
      origin: 'human_ui'
    });
    expect(created.kind).toBe('success');
    if (created.kind !== 'success') throw new Error('draft refused');
    const sourceRevision = created.record.revisions[0]!.revision;
    expect(readChangesetDiff({
      store,
      context: context('principal:alice', '2026-08-12T00:00:01.000Z'),
      changesetId: created.record.head.id,
      revisionId: sourceRevision.id,
      revisionDigest: sourceRevision.digest
    })).toMatchObject({ kind: 'success', diff: { operations: [{ safeDiff: { before: 'Before', after: 'After' } }] } });
    expect(proposeStoredChangeset({
      store,
      context: context('principal:alice', '2026-08-12T00:00:02.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: sourceRevision.id,
      revisionDigest: sourceRevision.digest
    })).toEqual({ kind: 'refused', refusal: { kind: 'stale_head', expected: 2, actual: 1 } });
    const proposed = proposeStoredChangeset({
      store,
      context: context('principal:alice', '2026-08-12T00:00:02.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 1,
      revisionId: sourceRevision.id,
      revisionDigest: sourceRevision.digest
    });
    if (proposed.kind !== 'success') throw new Error('proposal refused');

    domain.state = { label: 'Outside', version: 2, compensationMode: 'exact' };
    expect(validateStoredChangesetCommit({
      store,
      context: context('principal:alice', '2026-08-12T00:00:03.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: sourceRevision.id,
      revisionDigest: sourceRevision.digest,
      currentApprovalPolicy: noApproval,
      currentAggregateVersions: new Map([['record:one', 2]]),
      currentGuardVersions: new Map(),
      currentGuardDigests: new Map(),
      approverCurrentlyAuthorized: () => false,
      receiptExpectation: expectation
    })).toEqual({
      kind: 'refused',
      refusal: { kind: 'base_version_changed', id: 'record:one', expected: 1, actual: 2 }
    });
    const rebuilt = await rebuildStoredChangeset({
      store,
      registry: catalog,
      snapshot: domain.snapshot(),
      ids: ids(),
      context: context('principal:alice', '2026-08-12T00:00:04.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      sourceRevisionId: sourceRevision.id,
      sourceRevisionDigest: sourceRevision.digest,
      groups: ['record'],
      approvalPolicy: noApproval
    });
    if (rebuilt.kind !== 'success') throw new Error('rebuild refused');
    expect(rebuilt.record.revisions[0]).toEqual(created.record.revisions[0]);
    expect(rebuilt.record.revisions).toHaveLength(2);
    const revision = rebuilt.record.revisions[1]!.revision;
    const reproposed = proposeStoredChangeset({
      store,
      context: context('principal:alice', '2026-08-12T00:00:05.000Z'),
      changesetId: rebuilt.record.head.id,
      expectedHeadVersion: 3,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    if (reproposed.kind !== 'success') throw new Error('reproposal refused');
    const validationInput = {
      store,
      context: context('principal:alice', '2026-08-12T00:00:06.000Z'),
      changesetId: rebuilt.record.head.id,
      expectedHeadVersion: 4,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: noApproval,
      currentAggregateVersions: new Map([['record:one', 2]]),
      currentGuardVersions: new Map<string, number>(),
      currentGuardDigests: new Map<string, string>(),
      approverCurrentlyAuthorized: () => false,
      receiptExpectation: expectation
    } as const;
    const firstValidation = validateStoredChangesetCommit(validationInput);
    if (firstValidation.kind !== 'ready') throw new Error('validation refused');
    applyValidatedCommit(firstValidation);
    const receiptId = crypto.randomUUID();
    const correctReceipt = terminalReceipt({
      id: receiptId,
      changesetId: rebuilt.record.head.id,
      expectedHeadVersion: 4,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    expect(() => commitStoredChangeset({
      store,
      commit: firstValidation.commit,
      terminalReceipt: { ...correctReceipt, requestHash: '9'.repeat(64) }
    })).toThrow('changeset_commit_terminal_receipt_mismatch');
    expect(() => commitStoredChangeset({
      store,
      commit: firstValidation.commit,
      terminalReceipt: correctReceipt
    })).toThrow('invalid_exact_stored_changeset_commit');

    const secondValidation = validateStoredChangesetCommit(validationInput);
    if (secondValidation.kind !== 'ready') throw new Error('second validation refused');
    applyValidatedCommit(secondValidation);
    const committed = commitStoredChangeset({
      store,
      commit: secondValidation.commit,
      terminalReceipt: correctReceipt
    });
    expect(committed.record.head.status).toBe('committed');

    domain.state = { label: 'After', version: 3, compensationMode: 'exact' };
    const restarted = store.restart();
    const correctionInput = {
      store: restarted,
      registry: catalog,
      snapshot: domain.snapshot(),
      ids: ids(),
      context: context('principal:alice', '2026-08-12T00:00:07.000Z'),
      sourceChangesetId: committed.record.head.id,
      sourceRevisionId: revision.id,
      sourceRevisionDigest: revision.digest,
      sourceCommitReceiptId: receiptId,
      approvalPolicy: noApproval
    } as const;
    const exact = await draftChangesetCorrection(correctionInput);
    expect(exact.kind).toBe('exact');
    if (exact.kind !== 'exact') throw new Error('exact correction missing');
    expect(restarted.readCorrection(exact.link.id)).toEqual(exact.link);

    domain.state = { ...domain.state, compensationMode: 'blocked' };
    const blocked = await draftChangesetCorrection({ ...correctionInput, ids: ids() });
    expect(blocked).toMatchObject({
      kind: 'blocked',
      record: null,
      link: { evidence: { kind: 'blocked', blockers: [{ reasonKey: 'record.changed_after_source' }] } }
    });

    domain.state = { ...domain.state, compensationMode: 'irreversible' };
    const irreversible = await draftChangesetCorrection({ ...correctionInput, ids: ids() });
    expect(irreversible).toMatchObject({
      kind: 'irreversible',
      link: { evidence: { kind: 'irreversible', remediations: [{ remediationKey: 'record.external_remediation' }] } }
    });
    if (irreversible.kind !== 'irreversible') throw new Error('irreversible correction missing');
    expect(irreversible.record).not.toBeNull();
    expect(restarted.readCorrections(committed.record.head.id)).toHaveLength(3);
  });

  test('enforces an explicit distinct-human policy independently of normal risk', () => {
    const store = new MemoryStore();
    const domain = new Domain();
    const created = appendChangesetDraftSynchronous({
      store,
      registry: registry(),
      snapshot: domain.snapshot(),
      ids: ids(),
      context: context('principal:alice', '2026-08-12T01:00:00.000Z'),
      operations: [{
        kind: 'record.change',
        version: 1,
        dependencyGroup: 'record',
        authorInput: { label: 'After', risk: 'normal' }
      }],
      dependencyGroups: [{ key: 'record', dependsOn: [] }],
      approvalPolicy: distinctApproval,
      origin: 'human_ui'
    });
    if (created.kind !== 'success') throw new Error('draft refused');
    const revision = created.record.revisions[0]!.revision;
    const proposed = proposeStoredChangeset({
      store,
      context: context('principal:alice', '2026-08-12T01:00:01.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 1,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    if (proposed.kind !== 'success') throw new Error('proposal refused');
    const validation = {
      store,
      context: context('principal:alice', '2026-08-12T01:00:05.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: distinctApproval,
      currentAggregateVersions: new Map([['record:one', 1]]),
      currentGuardVersions: new Map<string, number>(),
      currentGuardDigests: new Map<string, string>(),
      receiptExpectation: expectation
    } as const;
    expect(validateStoredChangesetCommit({
      ...validation,
      approverCurrentlyAuthorized: () => false
    })).toEqual({ kind: 'refused', refusal: { kind: 'approval_missing' } });
    expect(approveStoredChangeset({
      store,
      ids: ids(),
      context: context('principal:alice', '2026-08-12T01:00:03.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: distinctApproval,
      expiresAt: '2026-08-12T02:00:00.000Z'
    })).toEqual({ kind: 'refused', refusal: { kind: 'approval_separation_required' } });
    const approved = approveStoredChangeset({
      store,
      ids: ids(),
      context: context('principal:bob', '2026-08-12T01:00:04.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: distinctApproval,
      expiresAt: '2026-08-12T02:00:00.000Z'
    });
    expect(approved.kind).toBe('success');
    expect(validateStoredChangesetCommit({
      ...validation,
      approverCurrentlyAuthorized: (principal) => principal === 'principal:bob'
    }).kind).toBe('ready');
  });

  test('rehydrates every mixed correction finding after a process restart', async () => {
    const store = new MemoryStore();
    const domain = new Domain();
    const created = appendChangesetDraftSynchronous({
      store,
      registry: registry(),
      snapshot: domain.snapshot(),
      ids: ids(),
      context: context('principal:alice', '2026-08-12T03:00:00.000Z'),
      operations: ['Semantic', 'Partial', 'Blocked'].map((label, index) => ({
        kind: 'record.change',
        version: 1,
        dependencyGroup: `record_${index}`,
        authorInput: { label, risk: 'normal' as const }
      })),
      dependencyGroups: [0, 1, 2].map((index) => ({ key: `record_${index}`, dependsOn: [] })),
      approvalPolicy: noApproval,
      origin: 'human_ui'
    });
    if (created.kind !== 'success') throw new Error('mixed draft refused');
    const revision = created.record.revisions[0]!.revision;
    const proposed = proposeStoredChangeset({
      store,
      context: context('principal:alice', '2026-08-12T03:00:01.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 1,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    if (proposed.kind !== 'success') throw new Error('mixed proposal refused');
    const validation = validateStoredChangesetCommit({
      store,
      context: context('principal:alice', '2026-08-12T03:00:02.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: noApproval,
      currentAggregateVersions: new Map([['record:one', 1]]),
      currentGuardVersions: new Map(),
      currentGuardDigests: new Map(),
      approverCurrentlyAuthorized: () => false,
      receiptExpectation: expectation
    });
    if (validation.kind !== 'ready') throw new Error('mixed commit validation refused');
    applyValidatedCommit(validation);
    const receipt = terminalReceipt({
      id: crypto.randomUUID(),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    const committed = commitStoredChangeset({
      store,
      commit: validation.commit,
      terminalReceipt: receipt
    });

    domain.state = { ...domain.state, compensationMode: 'mixed' };
    const restarted = store.restart();
    const correction = await draftChangesetCorrection({
      store: restarted,
      registry: registry(),
      snapshot: domain.snapshot(),
      ids: ids(),
      context: context('principal:alice', '2026-08-12T03:00:03.000Z'),
      sourceChangesetId: committed.record.head.id,
      sourceRevisionId: revision.id,
      sourceRevisionDigest: revision.digest,
      sourceCommitReceiptId: receipt.ref.id,
      approvalPolicy: noApproval
    });
    expect(correction).toMatchObject({
      kind: 'blocked',
      link: {
        evidence: {
          kind: 'blocked',
          notes: [{ noteKey: 'record.semantic_match' }],
          conflicts: [{ conflictKeys: ['record.later_work_preserved'] }],
          blockers: [{ reasonKey: 'record.correction_requires_review' }],
          operations: [
            { kind: 'semantic', draftable: true, noteKey: 'record.semantic_match' },
            { kind: 'partial', draftable: true, conflictKeys: ['record.later_work_preserved'] },
            { kind: 'blocked', draftable: false, reasonKey: 'record.correction_requires_review' }
          ]
        }
      }
    });
    if (correction.kind !== 'blocked') throw new Error('mixed correction missing');
    const { schemaVersion: _schemaVersion, recordDigestSha256: _recordDigest, ...linkInput } = correction.link;
    const missingEvidence = createStoredChangesetCorrectionLink({
      ...linkInput,
      evidence: {
        ...correction.link.evidence,
        operations: correction.link.evidence.operations.slice(1)
      }
    });
    expect(() => assertCorrectionLink(
      committed.record,
      committed.link,
      undefined,
      missingEvidence
    )).toThrow('changeset_correction_evidence_coverage_mismatch');
    const reorderedEvidence = createStoredChangesetCorrectionLink({
      ...linkInput,
      evidence: {
        ...correction.link.evidence,
        operations: [...correction.link.evidence.operations].reverse()
      }
    });
    expect(() => assertCorrectionLink(
      committed.record,
      committed.link,
      undefined,
      reorderedEvidence
    )).toThrow('changeset_correction_evidence_order_mismatch');
    const afterSecondRestart = restarted.restart();
    expect(afterSecondRestart.readCorrection(correction.link.id)).toEqual(correction.link);
  });

  test('fails closed when a registered planner crosses an asynchronous boundary', () => {
    const asynchronous = definition({
      async plan(input, snapshot) {
        const current = snapshot.getPort(recordReadPort).read();
        return {
          plan: {
            beforeLabel: current.label,
            nextLabel: input.label,
            expectedVersion: current.version,
            risk: input.risk
          },
          aggregateRefs: [{ id: 'record:one', version: current.version }],
          guardRefs: [],
          riskTier: input.risk,
          consequences: ['record_changed']
        };
      }
    });
    const domain = new Domain();
    expect(() => appendChangesetDraftSynchronous({
      store: new MemoryStore(),
      registry: registry(asynchronous),
      snapshot: domain.snapshot(),
      ids: ids(),
      context: context('principal:alice', '2026-08-12T02:00:00.000Z'),
      operations: [{
        kind: 'record.change',
        version: 1,
        dependencyGroup: 'record',
        authorInput: { label: 'After', risk: 'normal' }
      }],
      dependencyGroups: [{ key: 'record', dependsOn: [] }],
      approvalPolicy: noApproval,
      origin: 'human_ui'
    })).toThrow('async_changeset_planning_forbidden_in_single_unit_of_work');
  });
});
