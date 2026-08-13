import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendChangesetDraft,
  approveStoredChangeset,
  commitStoredChangeset,
  draftChangesetCorrection,
  proposeStoredChangeset,
  readChangesetDiff,
  rebuildStoredChangeset,
  validateStoredChangesetCommit,
  type CapturedChangesetApprovalPolicy,
  type ChangesetCommitReceiptExpectation,
  type ChangesetCommitTerminalReceipt,
  type ChangesetLifecycleIds,
  type TrustedChangesetActorContext
} from '@jooevents/changeset-operations';
import {
  applyPreparedChangesetSynchronous,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  prepareChangesetCommitSynchronous,
  type ChangesetCommitTransaction,
  type ChangesetOperationDefinition,
  type ChangesetPlanningSnapshot
} from '@jooevents/changesets';
import { parseOperationReceiptId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  SQLiteChangesetLifecycleStore,
  createSQLiteDraftOnlyChangesetLifecycleStore,
  installSQLiteChangesetLifecycleSchema
} from './changeset-lifecycle';

interface RecordState {
  readonly label: string;
  readonly version: number;
}

interface RecordReadPort {
  read(): RecordState;
}

interface RecordTransactionPort extends RecordReadPort {
  change(expectedVersion: number, label: string): RecordState;
}

const readPort = defineChangesetReadPort<RecordReadPort>('record.read', 1);
const validationPort = defineChangesetValidationPort<RecordReadPort>('record.validation', 1);
const transactionPort = defineChangesetTransactionPort<RecordTransactionPort>('record.transaction', 1);

const authorSchema = defineChangesetSchema({
  key: 'record.change.author',
  version: 1,
  schema: z.strictObject({
    label: z.string().trim().min(1).max(100),
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
const staleSchema = defineChangesetSchema({
  key: 'record.change.stale',
  version: 1,
  schema: z.strictObject({ expectedVersion: z.number().int().positive() })
});

const definition: ChangesetOperationDefinition<
  z.infer<typeof authorSchema.schema>,
  z.infer<typeof planSchema.schema>,
  z.infer<typeof diffSchema.schema>,
  z.infer<typeof planSchema.schema>,
  z.infer<typeof resultSchema.schema>
> = {
  kind: 'record.change',
  version: 1,
  schemas: {
    authorInput: authorSchema.reference,
    plan: planSchema.reference,
    diff: diffSchema.reference,
    result: resultSchema.reference
  },
  readPorts: [readPort],
  validationPorts: [validationPort],
  transactionPorts: [transactionPort],
  allowedAggregateKinds: ['record'],
  allowedGuardKinds: [],
  allowedRisks: ['normal', 'consequential'],
  allowedConsequences: ['record_changed'],
  allowedOutcomes: [{
    class: 'stale_revision',
    kind: 'record.changed',
    retryable: false,
    detailSchema: staleSchema.reference
  }],
  allowedFacts: [{ kind: 'record_changed', version: 1 }],
  allowedEffects: [],
  plan(input, snapshot) {
    const current = snapshot.getPort(readPort).read();
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
  validateWithin(plan, validation) {
    if (validation.getPort(validationPort).read().version !== plan.expectedVersion) {
      return {
        kind: 'outcome',
        outcome: {
          class: 'stale_revision',
          kind: 'record.changed',
          retryable: false,
          subjects: [{ type: 'record', id: 'one' }],
          detail: { expectedVersion: plan.expectedVersion },
          detailSchemaVersion: 1
        }
      };
    }
    return { kind: 'ready', validated: plan };
  },
  applyWithin(plan, transaction) {
    const changed = transaction.getPort(transactionPort).change(plan.expectedVersion, plan.nextLabel);
    return {
      result: changed,
      facts: [{
        kind: 'record_changed',
        version: 1,
        payload: { label: changed.label, version: changed.version }
      }],
      effects: []
    };
  },
  deriveCompensation(plan, snapshot) {
    const current = snapshot.getPort(readPort).read();
    const authorInput = { label: plan.beforeLabel, risk: 'normal' as const };
    return current.version === plan.expectedVersion + 1
      ? { kind: 'exact', authorInput }
      : { kind: 'blocked', reasonKey: 'record.changed_after_source' };
  }
};

const registry = createChangesetDefinitionRegistry({
  schemas: [authorSchema, planSchema, diffSchema, resultSchema, staleSchema],
  definitions: [definition]
});

function mixedCorrectionDefinition(
  kind: string,
  deriveCompensation: ChangesetOperationDefinition<
    z.infer<typeof authorSchema.schema>,
    z.infer<typeof planSchema.schema>,
    z.infer<typeof diffSchema.schema>,
    z.infer<typeof planSchema.schema>,
    z.infer<typeof resultSchema.schema>
  >['deriveCompensation']
): typeof definition {
  return {
    ...definition,
    kind,
    allowedFacts: [],
    applyWithin(plan) {
      return {
        result: { label: plan.nextLabel, version: plan.expectedVersion + 1 },
        facts: [],
        effects: []
      };
    },
    deriveCompensation
  };
}

const mixedSemanticDefinition = mixedCorrectionDefinition('record.mixed_semantic', (plan) => ({
  kind: 'semantic',
  authorInput: { label: plan.beforeLabel, risk: 'normal' },
  noteKey: 'record.semantic_match'
}));
const mixedPartialDefinition = mixedCorrectionDefinition('record.mixed_partial', (plan) => ({
  kind: 'partial',
  authorInput: { label: plan.beforeLabel, risk: 'normal' },
  conflicts: ['record.later_work_preserved']
}));
const mixedBlockedDefinition = mixedCorrectionDefinition('record.mixed_blocked', () => ({
  kind: 'blocked',
  reasonKey: 'record.correction_requires_review'
}));
const mixedRegistry = createChangesetDefinitionRegistry({
  schemas: [authorSchema, planSchema, diffSchema, resultSchema, staleSchema],
  definitions: [mixedSemanticDefinition, mixedPartialDefinition, mixedBlockedDefinition]
});

class RecordStore implements RecordTransactionPort {
  state: RecordState = { label: 'Before', version: 1 };

  read(): RecordState {
    return this.state;
  }

  change(expectedVersion: number, label: string): RecordState {
    if (this.state.version !== expectedVersion) throw new TypeError('record_apply_stale');
    this.state = { label, version: expectedVersion + 1 };
    return this.state;
  }
}

function capabilities(store: RecordStore): {
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly transaction: ChangesetCommitTransaction;
} {
  const readView: RecordReadPort = Object.freeze({ read: () => store.read() });
  return {
    snapshot: Object.freeze({
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        if (key !== readPort) throw new TypeError('unknown_record_read_port');
        return readView as Port;
      }
    }),
    transaction: Object.freeze({
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        if (key === validationPort) return readView as Port;
        if (key === transactionPort) return store as Port;
        throw new TypeError('unknown_record_transaction_port');
      }
    })
  };
}

function ids(overrides: Partial<ChangesetLifecycleIds> = {}): ChangesetLifecycleIds {
  return {
    newChangesetId: () => crypto.randomUUID(),
    newRevisionId: () => crypto.randomUUID(),
    newApprovalId: () => crypto.randomUUID(),
    newCorrectionAttemptId: () => crypto.randomUUID(),
    ...overrides
  };
}

const workspaceId = '018f2000-0000-7000-8000-000000000001';
const eventId = '018f2000-0000-7000-8000-000000000002';
const authorityPrincipalKey = '1'.repeat(64);
const receiptExpectation: ChangesetCommitReceiptExpectation = Object.freeze({
  operation: Object.freeze({ name: 'changeset.commit', version: 1 }),
  surface: 'operator_http',
  scopePartitionKey: '2'.repeat(64),
  authorityPrincipalKey,
  requestHashSha256: '3'.repeat(64)
});
const normalPolicy: CapturedChangesetApprovalPolicy = Object.freeze({
  reference: Object.freeze({ key: 'approval.record.bounded', version: 1 }),
  definitionDigestSha256: 'a'.repeat(64),
  requirement: 'none'
});
const strictPolicy: CapturedChangesetApprovalPolicy = Object.freeze({
  reference: Object.freeze({ key: 'approval.record.distinct_human', version: 1 }),
  definitionDigestSha256: 'b'.repeat(64),
  requirement: 'distinct_current_human'
});

function context(principalKey: string, evaluatedAt: string): TrustedChangesetActorContext {
  return { workspaceId, eventId, principalKey, authorityPrincipalKey, evaluatedAt };
}

function terminalReceipt(input: {
  readonly receiptId: string;
  readonly changesetId: string;
  readonly expectedHeadVersion: number;
  readonly revisionId: string;
  readonly revisionDigest: string;
}): ChangesetCommitTerminalReceipt {
  const receipt = {
    id: input.receiptId,
    operationName: receiptExpectation.operation.name,
    operationVersion: receiptExpectation.operation.version
  } as const;
  return {
    ref: receipt,
    identity: {
      scopePartitionKey: receiptExpectation.scopePartitionKey,
      authorityPrincipalKey: receiptExpectation.authorityPrincipalKey,
      operationName: receiptExpectation.operation.name,
      operationVersion: receiptExpectation.operation.version,
      surface: receiptExpectation.surface,
      idempotencyVerifierProfile: { key: 'changeset.commit.idempotency', version: 1 },
      idempotencyKeyVerifier: '4'.repeat(64)
    },
    requestHash: receiptExpectation.requestHashSha256,
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

function sqliteTarget(path = ':memory:') {
  const sqlite = new Database(path, { strict: true });
  installSQLiteChangesetLifecycleSchema(sqlite);
  const terminalReceipts = new Map<string, ChangesetCommitTerminalReceipt>();
  const receiptSource = {
    commitOperations: [receiptExpectation.operation],
    readTerminalReceipt: (receiptId: string) => terminalReceipts.get(receiptId)
  };
  return {
    sqlite,
    terminalReceipts,
    receiptSource,
    lifecycle: new SQLiteChangesetLifecycleStore(sqlite, receiptSource)
  };
}

describe('SQLite changeset lifecycle', () => {
  test('keeps an explicit draft-only store usable for drafts and closed to commit links', async () => {
    const target = sqliteTarget();
    expect(() => new SQLiteChangesetLifecycleStore(target.sqlite, {
      commitOperations: [],
      readTerminalReceipt: () => undefined
    })).toThrow('changeset_lifecycle_commit_operation_registry_invalid');
    const draftOnly = createSQLiteDraftOnlyChangesetLifecycleStore(target.sqlite);
    const domain = new RecordStore();
    const ports = capabilities(domain);
    try {
      const created = await appendChangesetDraft({
        store: draftOnly,
        registry,
        snapshot: ports.snapshot,
        ids: ids(),
        context: context('principal:alice', '2026-08-12T00:00:00.000Z'),
        operations: [{
          kind: 'record.change',
          version: 1,
          dependencyGroup: 'record',
          authorInput: { label: 'Draft only', risk: 'normal' }
        }],
        dependencyGroups: [{ key: 'record', dependsOn: [] }],
        approvalPolicy: normalPolicy,
        origin: 'human_ui'
      });
      expect(created.kind).toBe('success');
      if (created.kind !== 'success') throw new Error('draft refused');
      expect(draftOnly.read(created.record.head.id)).toEqual(created.record);

      const revision = created.record.revisions[0]!.revision;
      const proposed = proposeStoredChangeset({
        store: draftOnly,
        context: context('principal:alice', '2026-08-12T00:00:01.000Z'),
        changesetId: created.record.head.id,
        expectedHeadVersion: 1,
        revisionId: revision.id,
        revisionDigest: revision.digest
      });
      expect(proposed.kind).toBe('success');
      if (proposed.kind !== 'success') throw new Error('proposal refused');

      const validate = () => validateStoredChangesetCommit({
        store: draftOnly,
        context: context('principal:alice', '2026-08-12T00:00:02.000Z'),
        changesetId: created.record.head.id,
        expectedHeadVersion: 2,
        revisionId: revision.id,
        revisionDigest: revision.digest,
        currentApprovalPolicy: normalPolicy,
        currentAggregateVersions: new Map([['record:one', 1]]),
        currentGuardVersions: new Map<string, number>(),
        currentGuardDigests: new Map<string, string>(),
        receiptExpectation,
        approverCurrentlyAuthorized: () => false
      });
      const draftOnlyValidation = validate();
      expect(draftOnlyValidation.kind).toBe('ready');
      if (draftOnlyValidation.kind !== 'ready') throw new Error('commit validation refused');
      const draftOnlyPrepared = prepareChangesetCommitSynchronous({
        registry,
        authorization: draftOnlyValidation.commit.authorization,
        transaction: ports.transaction
      });
      expect(draftOnlyPrepared.kind).toBe('ready');
      if (draftOnlyPrepared.kind !== 'ready') throw new Error('domain validation refused');
      applyPreparedChangesetSynchronous(draftOnlyPrepared.prepared);

      const receiptId = parseOperationReceiptId(crypto.randomUUID());
      const receipt = terminalReceipt({
        receiptId,
        changesetId: created.record.head.id,
        expectedHeadVersion: 2,
        revisionId: revision.id,
        revisionDigest: revision.digest
      });
      expect(() => target.sqlite.transaction(() => commitStoredChangeset({
        store: draftOnly,
        commit: draftOnlyValidation.commit,
        terminalReceipt: receipt
      })).immediate()).toThrow('changeset_commit_operation_unregistered');
      expect(draftOnly.read(created.record.head.id)?.head.status).toBe('proposed');
      expect(draftOnly.readCommitLink(created.record.head.id)).toBeUndefined();

      domain.state = { label: 'Before', version: 1 };
      const ordinaryValidation = validateStoredChangesetCommit({
        store: target.lifecycle,
        context: context('principal:alice', '2026-08-12T00:00:03.000Z'),
        changesetId: created.record.head.id,
        expectedHeadVersion: 2,
        revisionId: revision.id,
        revisionDigest: revision.digest,
        currentApprovalPolicy: normalPolicy,
        currentAggregateVersions: new Map([['record:one', 1]]),
        currentGuardVersions: new Map<string, number>(),
        currentGuardDigests: new Map<string, string>(),
        receiptExpectation,
        approverCurrentlyAuthorized: () => false
      });
      expect(ordinaryValidation.kind).toBe('ready');
      if (ordinaryValidation.kind !== 'ready') throw new Error('ordinary validation refused');
      const ordinaryPrepared = prepareChangesetCommitSynchronous({
        registry,
        authorization: ordinaryValidation.commit.authorization,
        transaction: ports.transaction
      });
      expect(ordinaryPrepared.kind).toBe('ready');
      if (ordinaryPrepared.kind !== 'ready') throw new Error('ordinary domain validation refused');
      applyPreparedChangesetSynchronous(ordinaryPrepared.prepared);
      target.terminalReceipts.set(receiptId, receipt);
      const committed = target.sqlite.transaction(() => commitStoredChangeset({
        store: target.lifecycle,
        commit: ordinaryValidation.commit,
        terminalReceipt: receipt
      })).immediate();
      expect(target.lifecycle.readCommitLink(created.record.head.id)).toEqual(committed.link);
      expect(() => draftOnly.readCommitLink(created.record.head.id))
        .toThrow('changeset_commit_operation_unregistered');
    } finally {
      target.sqlite.close();
    }
  });

  test('persists immutable N, requires explicit N+1 after stale, commits, then rehydrates a correction draft', async () => {
    const target = sqliteTarget();
    const domain = new RecordStore();
    const ports = capabilities(domain);
    const created = await appendChangesetDraft({
      store: target.lifecycle,
      registry,
      snapshot: ports.snapshot,
      ids: ids(),
      context: context('principal:alice', '2026-08-12T00:00:00.000Z'),
      operations: [{
        kind: 'record.change',
        version: 1,
        dependencyGroup: 'record',
        authorInput: { label: 'After', risk: 'normal' }
      }],
      dependencyGroups: [{ key: 'record', dependsOn: [] }],
      approvalPolicy: normalPolicy,
      origin: 'human_ui'
    });
    expect(created.kind).toBe('success');
    if (created.kind !== 'success') throw new Error('draft refused');
    const originalRevision = structuredClone(created.record.revisions[0]);

    expect(readChangesetDiff({
      store: target.lifecycle,
      context: context('principal:alice', '2026-08-12T00:00:01.000Z'),
      changesetId: created.record.head.id,
      revisionId: originalRevision!.revision.id,
      revisionDigest: originalRevision!.revision.digest
    })).toMatchObject({
      kind: 'success',
      diff: { operations: [{ safeDiff: { before: 'Before', after: 'After' } }] }
    });
    expect(readChangesetDiff({
      store: target.lifecycle,
      context: {
        ...context('principal:alice', '2026-08-12T00:00:01.000Z'),
        eventId: '018f2000-0000-7000-8000-000000000099'
      },
      changesetId: created.record.head.id,
      revisionId: originalRevision!.revision.id,
      revisionDigest: originalRevision!.revision.digest
    })).toEqual({ kind: 'refused', refusal: { kind: 'scope_changed' } });

    const proposed = proposeStoredChangeset({
      store: target.lifecycle,
      context: context('principal:alice', '2026-08-12T00:00:02.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 1,
      revisionId: originalRevision!.revision.id,
      revisionDigest: originalRevision!.revision.digest
    });
    expect(proposed.kind).toBe('success');
    if (proposed.kind !== 'success') throw new Error('proposal refused');

    domain.state = { label: 'Outside', version: 2 };
    expect(validateStoredChangesetCommit({
      store: target.lifecycle,
      context: context('principal:alice', '2026-08-12T00:00:03.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: originalRevision!.revision.id,
      revisionDigest: originalRevision!.revision.digest,
      currentApprovalPolicy: normalPolicy,
      currentAggregateVersions: new Map([['record:one', 2]]),
      currentGuardVersions: new Map(),
      currentGuardDigests: new Map(),
      receiptExpectation,
      approverCurrentlyAuthorized: () => false
    })).toEqual({
      kind: 'refused',
      refusal: { kind: 'base_version_changed', id: 'record:one', expected: 1, actual: 2 }
    });

    const rebuilt = await rebuildStoredChangeset({
      store: target.lifecycle,
      registry,
      snapshot: ports.snapshot,
      ids: ids(),
      context: context('principal:alice', '2026-08-12T00:00:04.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      sourceRevisionId: originalRevision!.revision.id,
      sourceRevisionDigest: originalRevision!.revision.digest,
      groups: ['record'],
      approvalPolicy: normalPolicy
    });
    expect(rebuilt.kind).toBe('success');
    if (rebuilt.kind !== 'success') throw new Error('rebuild refused');
    expect(rebuilt.record.revisions[0]).toEqual(originalRevision);
    expect(rebuilt.record.revisions[1]?.revision.digest).not.toBe(originalRevision!.revision.digest);
    expect(rebuilt.record.revisions[1]?.revision.operations[0]?.plan).toMatchObject({
      beforeLabel: 'Outside',
      expectedVersion: 2
    });

    const revision = rebuilt.record.revisions[1]!.revision;
    const proposedAgain = proposeStoredChangeset({
      store: target.lifecycle,
      context: context('principal:alice', '2026-08-12T00:00:05.000Z'),
      changesetId: rebuilt.record.head.id,
      expectedHeadVersion: 3,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    expect(proposedAgain.kind).toBe('success');
    if (proposedAgain.kind !== 'success') throw new Error('second proposal refused');

    const validation = validateStoredChangesetCommit({
      store: target.lifecycle,
      context: context('principal:alice', '2026-08-12T00:00:06.000Z'),
      changesetId: rebuilt.record.head.id,
      expectedHeadVersion: 4,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: normalPolicy,
      currentAggregateVersions: new Map([['record:one', 2]]),
      currentGuardVersions: new Map(),
      currentGuardDigests: new Map(),
      receiptExpectation,
      approverCurrentlyAuthorized: () => false
    });
    expect(validation.kind).toBe('ready');
    if (validation.kind !== 'ready') throw new Error('commit validation refused');
    const prepared = prepareChangesetCommitSynchronous({
      registry,
      authorization: validation.commit.authorization,
      transaction: ports.transaction
    });
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('domain validation refused');
    expect(applyPreparedChangesetSynchronous(prepared.prepared)).toHaveLength(1);
    expect(domain.state).toEqual({ label: 'After', version: 3 });

    const receiptId = parseOperationReceiptId(crypto.randomUUID());
    const receipt = terminalReceipt({
      receiptId,
      changesetId: rebuilt.record.head.id,
      expectedHeadVersion: 4,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    target.terminalReceipts.set(receiptId, receipt);
    const committed = target.sqlite.transaction(() => commitStoredChangeset({
      store: target.lifecycle,
      commit: validation.commit,
      terminalReceipt: receipt
    })).immediate();
    expect(committed.record.head.status).toBe('committed');
    expect(committed.link.commitReceiptId).toBe(receiptId);

    const afterRestart = new SQLiteChangesetLifecycleStore(target.sqlite, target.receiptSource);
    expect(afterRestart.read(committed.record.head.id)).toEqual(committed.record);
    expect(afterRestart.readCommitLink(committed.record.head.id)).toEqual(committed.link);

    const correction = await draftChangesetCorrection({
      store: afterRestart,
      registry,
      snapshot: ports.snapshot,
      ids: ids(),
      context: context('principal:alice', '2026-08-12T00:00:08.000Z'),
      sourceChangesetId: committed.record.head.id,
      sourceRevisionId: revision.id,
      sourceRevisionDigest: revision.digest,
      sourceCommitReceiptId: receiptId,
      approvalPolicy: normalPolicy
    });
    expect(correction.kind).toBe('exact');
    if (correction.kind !== 'exact') throw new Error('correction unavailable');
    expect(correction.record.revisions[0]?.revision.operations[0]?.plan).toMatchObject({
      beforeLabel: 'After',
      nextLabel: 'Outside',
      expectedVersion: 3
    });
    expect(afterRestart.read(correction.record.head.id)).toEqual(correction.record);

    const conflictingTargetId = crypto.randomUUID();
    const refused = await draftChangesetCorrection({
      store: afterRestart,
      registry,
      snapshot: ports.snapshot,
      ids: ids({
        newChangesetId: () => conflictingTargetId,
        newCorrectionAttemptId: () => correction.link.id
      }),
      context: context('principal:alice', '2026-08-12T00:00:09.000Z'),
      sourceChangesetId: committed.record.head.id,
      sourceRevisionId: revision.id,
      sourceRevisionDigest: revision.digest,
      sourceCommitReceiptId: receiptId,
      approvalPolicy: normalPolicy
    });
    expect(refused).toEqual({ kind: 'refused', refusal: { kind: 'id_collision' } });
    expect(afterRestart.read(conflictingTargetId)).toBeUndefined();

    domain.state = { label: 'Later work', version: 4 };
    const blocked = await draftChangesetCorrection({
      store: afterRestart,
      registry,
      snapshot: ports.snapshot,
      ids: ids(),
      context: context('principal:alice', '2026-08-12T00:00:10.000Z'),
      sourceChangesetId: committed.record.head.id,
      sourceRevisionId: revision.id,
      sourceRevisionDigest: revision.digest,
      sourceCommitReceiptId: receiptId,
      approvalPolicy: normalPolicy
    });
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') expect(blocked.link.target).toBeNull();

    expect(() => target.sqlite.query(`
      UPDATE changeset_revisions SET record_digest_sha256 = ? WHERE revision_id = ?
    `).run('0'.repeat(64), revision.id)).toThrow('changeset_revision_immutable');
    target.sqlite.close();
  });

  test('binds consequential approval to a distinct current human and current policy', async () => {
    const target = sqliteTarget();
    const domain = new RecordStore();
    const ports = capabilities(domain);
    const created = await appendChangesetDraft({
      store: target.lifecycle,
      registry,
      snapshot: ports.snapshot,
      ids: ids(),
      context: context('principal:alice', '2026-08-12T01:00:00.000Z'),
      operations: [{
        kind: 'record.change',
        version: 1,
        dependencyGroup: 'record',
        authorInput: { label: 'High consequence', risk: 'consequential' }
      }],
      dependencyGroups: [{ key: 'record', dependsOn: [] }],
      approvalPolicy: strictPolicy,
      origin: 'human_ui'
    });
    if (created.kind !== 'success') throw new Error('draft refused');
    const revision = created.record.revisions[0]!.revision;
    const proposed = proposeStoredChangeset({
      store: target.lifecycle,
      context: context('principal:alice', '2026-08-12T01:00:01.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 1,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    if (proposed.kind !== 'success') throw new Error('proposal refused');

    expect(approveStoredChangeset({
      store: target.lifecycle,
      ids: ids(),
      context: context('principal:alice', '2026-08-12T01:00:02.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: strictPolicy,
      expiresAt: '2026-08-12T02:00:00.000Z'
    })).toEqual({ kind: 'refused', refusal: { kind: 'approval_separation_required' } });

    const approved = approveStoredChangeset({
      store: target.lifecycle,
      ids: ids(),
      context: context('principal:bob', '2026-08-12T01:00:03.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: strictPolicy,
      expiresAt: '2026-08-12T02:00:00.000Z'
    });
    expect(approved.kind).toBe('success');

    const validationInput = {
      store: target.lifecycle,
      context: context('principal:alice', '2026-08-12T01:00:04.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: strictPolicy,
      currentAggregateVersions: new Map([['record:one', 1]]),
      currentGuardVersions: new Map<string, number>(),
      currentGuardDigests: new Map<string, string>(),
      receiptExpectation
    } as const;
    expect(validateStoredChangesetCommit({
      ...validationInput,
      approverCurrentlyAuthorized: () => false
    })).toEqual({
      kind: 'refused',
      refusal: { kind: 'approval_invalid', reason: 'authority' }
    });
    expect(validateStoredChangesetCommit({
      ...validationInput,
      currentApprovalPolicy: { ...strictPolicy, definitionDigestSha256: 'c'.repeat(64) },
      approverCurrentlyAuthorized: () => true
    })).toEqual({ kind: 'refused', refusal: { kind: 'policy_changed' } });
    expect(validateStoredChangesetCommit({
      ...validationInput,
      approverCurrentlyAuthorized: (principal) => principal === 'principal:bob'
    }).kind).toBe('ready');
    target.sqlite.close();
  });

  test('preserves mixed per-operation correction evidence across a SQLite reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-changeset-correction-'));
    const databasePath = join(directory, 'lifecycle.sqlite');
    const target = sqliteTarget(databasePath);
    let activeSQLite: Database | undefined = target.sqlite;
    const domain = new RecordStore();
    const ports = capabilities(domain);
    try {
    const created = await appendChangesetDraft({
      store: target.lifecycle,
      registry: mixedRegistry,
      snapshot: ports.snapshot,
      ids: ids(),
      context: context('principal:alice', '2026-08-12T04:00:00.000Z'),
      operations: [
        [mixedSemanticDefinition.kind, 'Semantic'],
        [mixedPartialDefinition.kind, 'Partial'],
        [mixedBlockedDefinition.kind, 'Blocked']
      ].map(([kind, label], index) => ({
        kind: kind!,
        version: 1,
        dependencyGroup: `record_${index}`,
        authorInput: { label, risk: 'normal' as const }
      })),
      dependencyGroups: [0, 1, 2].map((index) => ({ key: `record_${index}`, dependsOn: [] })),
      approvalPolicy: normalPolicy,
      origin: 'human_ui'
    });
    if (created.kind !== 'success') throw new Error('mixed draft refused');
    const revision = created.record.revisions[0]!.revision;
    const proposed = proposeStoredChangeset({
      store: target.lifecycle,
      context: context('principal:alice', '2026-08-12T04:00:01.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 1,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    if (proposed.kind !== 'success') throw new Error('mixed proposal refused');
    const validation = validateStoredChangesetCommit({
      store: target.lifecycle,
      context: context('principal:alice', '2026-08-12T04:00:02.000Z'),
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      currentApprovalPolicy: normalPolicy,
      currentAggregateVersions: new Map([['record:one', 1]]),
      currentGuardVersions: new Map(),
      currentGuardDigests: new Map(),
      approverCurrentlyAuthorized: () => false,
      receiptExpectation
    });
    if (validation.kind !== 'ready') throw new Error('mixed commit validation refused');
    const prepared = prepareChangesetCommitSynchronous({
      registry: mixedRegistry,
      authorization: validation.commit.authorization,
      transaction: ports.transaction
    });
    if (prepared.kind !== 'ready') throw new Error('mixed domain validation refused');
    applyPreparedChangesetSynchronous(prepared.prepared);
    const receiptId = parseOperationReceiptId(crypto.randomUUID());
    const receipt = terminalReceipt({
      receiptId,
      changesetId: created.record.head.id,
      expectedHeadVersion: 2,
      revisionId: revision.id,
      revisionDigest: revision.digest
    });
    target.terminalReceipts.set(receiptId, receipt);
    const committed = target.sqlite.transaction(() => commitStoredChangeset({
      store: target.lifecycle,
      commit: validation.commit,
      terminalReceipt: receipt
    })).immediate();

    const correction = await draftChangesetCorrection({
      store: target.lifecycle,
      registry: mixedRegistry,
      snapshot: ports.snapshot,
      ids: ids(),
      context: context('principal:alice', '2026-08-12T04:00:03.000Z'),
      sourceChangesetId: committed.record.head.id,
      sourceRevisionId: revision.id,
      sourceRevisionDigest: revision.digest,
      sourceCommitReceiptId: receiptId,
      approvalPolicy: normalPolicy
    });
    expect(correction).toMatchObject({
      kind: 'blocked',
      link: {
        evidence: {
          notes: [{ noteKey: 'record.semantic_match' }],
          conflicts: [{ conflictKeys: ['record.later_work_preserved'] }],
          blockers: [{ reasonKey: 'record.correction_requires_review' }],
          operations: [
            { kind: 'semantic', draftable: true },
            { kind: 'partial', draftable: true },
            { kind: 'blocked', draftable: false }
          ]
        }
      }
    });
    if (correction.kind !== 'blocked') throw new Error('mixed correction missing');

    activeSQLite.close();
    activeSQLite = undefined;
    const reopenedSQLite = new Database(databasePath, { strict: true });
    activeSQLite = reopenedSQLite;
    reopenedSQLite.exec('PRAGMA foreign_keys = ON');
    const reopened = new SQLiteChangesetLifecycleStore(reopenedSQLite, target.receiptSource);
    expect(reopened.readCorrection(correction.link.id)).toEqual(correction.link);
    } finally {
      activeSQLite?.close();
      rmSync(directory, { recursive: true });
    }
  });
});
