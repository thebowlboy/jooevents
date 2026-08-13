import { describe, expect, test } from 'bun:test';
import {
  createChangeset,
  rehydrateCommittedChangesetSource,
  type FrozenChangesetOperation
} from '@jooevents/changesets';
import { parseOperationReceiptId } from '@jooevents/kernel';
import {
  createStoredChangesetApproval,
  createStoredChangesetCorrectionLink,
  createStoredChangesetRecord,
  createStoredChangesetRevisionRecord,
  changesetRecordApplicationIdSchema,
  changesetRecordCanonicalInstantSchema,
  parseStoredChangesetRecord,
  storedChangesetCorrectionLinkSchema
} from './records';

const ids = {
  workspace: '018f1000-0000-7000-8000-000000000001',
  event: '018f1000-0000-7000-8000-000000000002',
  changeset: '018f1000-0000-7000-8000-000000000003',
  revision: '018f1000-0000-7000-8000-000000000004',
  approval: '018f1000-0000-7000-8000-000000000005',
  receipt: '018f1000-0000-7000-8000-000000000006',
  correction: '018f1000-0000-7000-8000-000000000007',
  targetChangeset: '018f1000-0000-7000-8000-000000000008',
  targetRevision: '018f1000-0000-7000-8000-000000000009'
} as const;

const schema = (key: string, digest: string) => ({
  key,
  version: 1,
  digestSha256: digest.repeat(64)
});

const operation: FrozenChangesetOperation = Object.freeze({
  kind: 'record.change',
  version: 1,
  riskTier: 'normal',
  dependencyGroup: 'record',
  planSchema: schema('record.change.plan', 'a'),
  diffSchema: schema('record.change.diff', 'b'),
  resultSchema: schema('record.change.result', 'c'),
  aggregateRefs: Object.freeze([{ id: 'record:one', version: 1 }]),
  guardRefs: Object.freeze([{ id: 'record_index:all', version: 1, digest: 'd'.repeat(64) }]),
  plan: Object.freeze({ before: 'Before', after: 'After' }),
  safeDiff: Object.freeze({ before: 'Before', after: 'After' }),
  consequences: Object.freeze(['record_changed'])
});

const approvalPolicy = Object.freeze({
  reference: Object.freeze({ key: 'approval.record.bounded', version: 1 }),
  definitionDigestSha256: 'e'.repeat(64),
  requirement: 'none' as const
});

function record() {
  const head = createChangeset({
    id: ids.changeset,
    workspaceId: ids.workspace,
    eventId: ids.event
  }, {
    id: ids.revision,
    createdAt: '2026-08-12T00:00:00.000Z',
    proposerPrincipalKey: 'principal:alice',
    origin: 'human_ui',
    operations: [operation],
    dependencyGroups: [{ key: 'record', dependsOn: [] }],
    approvalPolicy: approvalPolicy.reference
  });
  const revision = createStoredChangesetRevisionRecord({
    revision: head.revisions[0]!,
    authorIntents: [{
      operationIndex: 0,
      kind: operation.kind,
      version: operation.version,
      dependencyGroup: operation.dependencyGroup,
      authorInputSchema: schema('record.change.author', 'f'),
      authorInput: { value: 'After' }
    }],
    approvalPolicy
  });
  return createStoredChangesetRecord({ head, revisions: [revision] });
}

describe('durable changeset record codecs', () => {
  test('rejects UUIDv1 and non-canonical instants at the durable boundary', () => {
    expect(changesetRecordApplicationIdSchema.safeParse(
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
    ).success).toBe(false);
    expect(changesetRecordApplicationIdSchema.safeParse(ids.changeset).success).toBe(true);
    expect(changesetRecordCanonicalInstantSchema.safeParse(
      '2026-08-12T08:00:00.000+08:00'
    ).success).toBe(false);
    expect(changesetRecordCanonicalInstantSchema.safeParse(
      '2026-08-12T00:00:00Z'
    ).success).toBe(false);
    expect(changesetRecordCanonicalInstantSchema.safeParse(
      '2026-08-12T00:00:00.000Z'
    ).success).toBe(true);
  });

  test('binds the complete head chain, author intent, safe diff, and captured policy', () => {
    const stored = record();
    expect(parseStoredChangesetRecord(structuredClone(stored))).toEqual(stored);

    const changedPlan = structuredClone(stored);
    (changedPlan.head.revisions[0]!.operations[0]!.plan as { after: string }).after = 'Tampered';
    expect(() => parseStoredChangesetRecord(changedPlan)).toThrow();

    const changedIntent = structuredClone(stored);
    (changedIntent.revisions[0]!.authorIntents[0]! as { kind: string }).kind = 'record.other';
    expect(() => parseStoredChangesetRecord(changedIntent)).toThrow();

    const changedPolicy = structuredClone(stored);
    (changedPolicy.revisions[0]!.approvalPolicy as {
      reference: { key: string; version: number };
    }).reference = { key: 'approval.other', version: 1 };
    expect(() => parseStoredChangesetRecord(changedPolicy)).toThrow();
  });

  test('requires canonical approval intervals and a target only for draftable corrections', () => {
    const stored = record();
    expect(() => createStoredChangesetApproval({
      changesetId: stored.head.id,
      receipt: {
        id: ids.approval,
        revisionId: ids.revision,
        revisionDigest: stored.head.revisions[0]!.digest,
        policy: approvalPolicy.reference,
        scopeKey: `workspace:${ids.workspace}/event:${ids.event}`,
        approverPrincipalKey: 'principal:bob',
        issuedAt: '2026-08-12T00:01:00.000Z',
        expiresAt: '2026-08-12T00:01:00.000Z'
      }
    })).toThrow();

    const blocked = createStoredChangesetCorrectionLink({
      id: ids.correction,
      sourceChangesetId: ids.changeset,
      sourceRevisionId: ids.revision,
      sourceRevisionDigest: stored.head.revisions[0]!.digest,
      sourceCommitReceiptId: ids.receipt,
      resultKind: 'blocked',
      target: null,
      evidence: {
        kind: 'blocked',
        blockers: [{
          lineage: {
            sourceRevisionId: ids.revision,
            sourceRevisionDigest: stored.head.revisions[0]!.digest,
            sourceOperationIndex: 0,
            sourceOperationKind: operation.kind,
            sourceOperationVersion: operation.version,
            sourceDependencyGroup: operation.dependencyGroup
          },
          reasonKey: 'record.changed_after_source'
        }],
        remediations: [],
        conflicts: [],
        notes: [],
        operations: [{
          lineage: {
            sourceRevisionId: ids.revision,
            sourceRevisionDigest: stored.head.revisions[0]!.digest,
            sourceOperationIndex: 0,
            sourceOperationKind: operation.kind,
            sourceOperationVersion: operation.version,
            sourceDependencyGroup: operation.dependencyGroup
          },
          kind: 'blocked',
          draftable: false,
          reasonKey: 'record.changed_after_source'
        }]
      },
      draftedAt: '2026-08-12T00:02:00.000Z',
      draftedByPrincipalKey: 'principal:alice'
    });
    expect(blocked.target).toBeNull();
    expect(storedChangesetCorrectionLinkSchema.safeParse({
      ...blocked,
      target: {
        changesetId: ids.targetChangeset,
        revisionId: ids.targetRevision,
        revisionDigest: 'f'.repeat(64)
      }
    }).success).toBe(false);
  });

  test('rehydrates correction authority only from an exact committed durable head', () => {
    const draft = record();
    const committed = createStoredChangesetRecord({
      head: Object.freeze({ ...draft.head, version: 2, status: 'committed' as const }),
      revisions: draft.revisions
    });
    const source = rehydrateCommittedChangesetSource({
      head: committed.head,
      revisionId: ids.revision,
      revisionDigest: committed.head.revisions[0]!.digest,
      commitReceiptId: parseOperationReceiptId(ids.receipt)
    });
    expect(source).toMatchObject({
      changesetId: ids.changeset,
      revisionId: ids.revision,
      commitReceiptId: ids.receipt
    });
    expect(() => rehydrateCommittedChangesetSource({
      head: committed.head,
      revisionId: ids.revision,
      revisionDigest: '0'.repeat(64),
      commitReceiptId: parseOperationReceiptId(ids.receipt)
    })).toThrow('committed_changeset_revision_mismatch');
  });
});
