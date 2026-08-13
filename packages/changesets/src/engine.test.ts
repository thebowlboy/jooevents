import { describe, expect, test } from 'bun:test';
import { parseOperationReceiptId } from '@jooevents/kernel';
import {
  assertReplanSelection,
  canonicalJsonSha256,
  createChangeset,
  markChangesetCommitted,
  proposeChangeset,
  reviseChangeset,
  validateExactCommit,
  type ApprovalReceipt,
  type ChangesetHead,
  type RevisionDraft
} from '.';

const instant = '2026-08-11T00:00:00.000Z';
const receiptId = parseOperationReceiptId('00000000-0000-4000-8000-000000000001');

function draft(id: string, consequence = 'consequential:merge'): RevisionDraft {
  return {
    id,
    createdAt: instant,
    proposerPrincipalKey: 'principal:alice',
    origin: 'human_ui',
    originProvenance: { client: 'operator_web', flow: 'reviewed_diff' },
    approvalPolicy: { key: 'two_person', version: 1 },
    dependencyGroups: [
      { key: 'source', dependsOn: [] },
      { key: 'dependent', dependsOn: ['source'] },
      { key: 'independent', dependsOn: [] }
    ],
    operations: [
      {
        kind: 'program.merge',
        version: 1,
        riskTier: consequence ? 'consequential' : 'low',
        dependencyGroup: 'source',
        planSchema: { key: 'program.merge.plan', version: 1, digestSha256: '1'.repeat(64) },
        diffSchema: { key: 'program.merge.diff', version: 1, digestSha256: '2'.repeat(64) },
        resultSchema: { key: 'program.merge.result', version: 1, digestSha256: '3'.repeat(64) },
        aggregateRefs: [{ id: 'program:source', version: 3 }],
        guardRefs: [{ id: 'program:index', version: 8, digest: 'guard-a' }],
        plan: { target: 'program:target', source: 'program:source' },
        safeDiff: { after: { status: 'retired' }, before: { status: 'active' } },
        consequences: consequence ? [consequence] : []
      },
      {
        kind: 'program.repoint',
        version: 1,
        riskTier: 'low',
        dependencyGroup: 'dependent',
        planSchema: { key: 'program.repoint.plan', version: 1, digestSha256: '4'.repeat(64) },
        diffSchema: { key: 'program.repoint.diff', version: 1, digestSha256: '5'.repeat(64) },
        resultSchema: { key: 'program.repoint.result', version: 1, digestSha256: '6'.repeat(64) },
        aggregateRefs: [],
        guardRefs: [],
        plan: { references: ['session:1'] },
        safeDiff: { count: 1 },
        consequences: []
      }
    ]
  };
}

function approval(revisionId: string, digest: string): ApprovalReceipt {
  return {
    id: 'approval:1',
    revisionId,
    revisionDigest: digest,
    policy: { key: 'two_person', version: 1 },
    scopeKey: 'workspace:w/event:e',
    approverPrincipalKey: 'principal:bob',
    issuedAt: '2026-08-11T00:01:00.000Z',
    expiresAt: '2026-08-12T00:00:00.000Z'
  };
}

describe('canonical revision bytes', () => {
  test('object key order is irrelevant while array order remains meaningful', () => {
    expect(canonicalJsonSha256({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJsonSha256({ a: { c: 3, d: 4 }, b: 2 })
    );
    expect(canonicalJsonSha256([1, 2])).not.toBe(canonicalJsonSha256([2, 1]));
  });

  test('unsupported or ambiguous JavaScript values fail closed', () => {
    expect(() => canonicalJsonSha256({ value: undefined })).toThrow('Unsupported value');
    expect(() => canonicalJsonSha256(-0)).toThrow('Non-canonical number');
    expect(() => canonicalJsonSha256(Number.NaN)).toThrow('Non-canonical number');
  });
});

describe('changeset lifecycle', () => {
  test('revising a proposed head creates an immutable successor', () => {
    const created = createChangeset({ id: 'cs:1', workspaceId: 'w', eventId: 'e' }, draft('rev:1'));
    const proposed = proposeChangeset(created, created.version);
    const originalBytes = JSON.stringify(proposed.revisions[0]);
    const revised = reviseChangeset(proposed, { ...draft('rev:2'), createdAt: '2026-08-11T00:02:00.000Z' });

    expect(revised.status).toBe('draft');
    expect(revised.currentRevisionNumber).toBe(2);
    expect(JSON.stringify(revised.revisions[0])).toBe(originalBytes);
    expect(revised.revisions[0]?.digest).not.toBe(revised.revisions[1]?.digest);
    expect(Object.isFrozen(revised.revisions[0])).toBe(true);
  });

  test('exact commit refuses stale bases and guards before it can be marked committed', () => {
    const draftHead = createChangeset({ id: 'cs:1', workspaceId: 'w', eventId: 'e' }, draft('rev:1'));
    const head = proposeChangeset(draftHead, draftHead.version);
    const revision = head.revisions[0]!;
    const base = {
      expectedHeadVersion: head.version,
      expectedRevisionDigest: revision.digest,
      currentAggregateVersions: new Map([['program:source', 4]]),
      currentGuardVersions: new Map([['program:index', 8]]),
      currentGuardDigests: new Map([['program:index', 'guard-a']]),
      now: '2026-08-11T01:00:00.000Z',
      approvalRequirement: 'distinct_current_human',
      approval: approval(revision.id, revision.digest),
      approverCurrentlyAuthorized: true
    } as const;

    expect(validateExactCommit(head, base)).toEqual({
      kind: 'refused',
      refusal: { kind: 'base_version_changed', id: 'program:source', expected: 3, actual: 4 }
    });
    expect(validateExactCommit(head, {
      ...base,
      currentAggregateVersions: new Map([['program:source', 3]]),
      currentGuardVersions: new Map([['program:index', 9]])
    })).toEqual({ kind: 'refused', refusal: { kind: 'guard_changed', id: 'program:index' } });
    expect(validateExactCommit(head, {
      ...base,
      currentAggregateVersions: new Map([['program:source', 3]]),
      currentGuardDigests: new Map([['program:index', 'guard-b']])
    })).toEqual({ kind: 'refused', refusal: { kind: 'guard_changed', id: 'program:index' } });
  });

  test('consequential commit requires current digest-bound separate approval', () => {
    const draftHead = createChangeset({ id: 'cs:1', workspaceId: 'w', eventId: 'e' }, draft('rev:1'));
    const head = proposeChangeset(draftHead, draftHead.version);
    const revision = head.revisions[0]!;
    const valid = {
      expectedHeadVersion: head.version,
      expectedRevisionDigest: revision.digest,
      currentAggregateVersions: new Map([['program:source', 3]]),
      currentGuardVersions: new Map([['program:index', 8]]),
      currentGuardDigests: new Map([['program:index', 'guard-a']]),
      now: '2026-08-11T01:00:00.000Z',
      approvalRequirement: 'distinct_current_human',
      approval: approval(revision.id, revision.digest),
      approverCurrentlyAuthorized: true
    } as const;

    const { approval: _approval, ...withoutApproval } = valid;
    expect(validateExactCommit(head, withoutApproval)).toEqual({
      kind: 'refused',
      refusal: { kind: 'approval_missing' }
    });
    expect(validateExactCommit(head, {
      ...valid,
      approval: { ...valid.approval, approverPrincipalKey: 'principal:alice' }
    })).toEqual({ kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'separation' } });
    expect(validateExactCommit(head, {
      ...valid,
      approval: { ...valid.approval, scopeKey: 'workspace:other/event:e' }
    })).toEqual({ kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'scope' } });
    expect(validateExactCommit(head, {
      ...valid,
      approval: {
        ...valid.approval,
        issuedAt: '2026-08-11T02:00:00.000Z'
      }
    })).toEqual({ kind: 'refused', refusal: { kind: 'approval_invalid', reason: 'time' } });
    const validated = validateExactCommit(head, valid);
    expect(validated.kind).toBe('ready');
    if (validated.kind !== 'ready') throw new Error('expected ready commit');
    expect(() => markChangesetCommitted(
      head,
      validated.authorization,
      receiptId
    )).toThrow('invalid_validated_changeset_commit');
    expect(() => markChangesetCommitted(
      head,
      structuredClone(validated.authorization),
      receiptId
    )).toThrow('invalid_validated_changeset_commit');
  });

  test('the captured policy threshold is independent of calculated risk', () => {
    const consequential = proposeChangeset(
      createChangeset({ id: 'cs:policy-none', workspaceId: 'w', eventId: 'e' }, draft('rev:policy-none')),
      1
    );
    const consequentialRevision = consequential.revisions.at(-1)!;
    const common = {
      expectedHeadVersion: consequential.version,
      expectedRevisionDigest: consequentialRevision.digest,
      currentAggregateVersions: new Map([['program:source', 3]]),
      currentGuardVersions: new Map([['program:index', 8]]),
      currentGuardDigests: new Map([['program:index', 'guard-a']]),
      now: '2026-08-11T01:00:00.000Z'
    } as const;
    expect(validateExactCommit(consequential, {
      ...common,
      approvalRequirement: 'none'
    }).kind).toBe('ready');

    const normalDraft = draft('rev:policy-distinct', '');
    const normal = proposeChangeset(
      createChangeset({ id: 'cs:policy-distinct', workspaceId: 'w', eventId: 'e' }, normalDraft),
      1
    );
    const normalRevision = normal.revisions.at(-1)!;
    const strict = {
      ...common,
      expectedHeadVersion: normal.version,
      expectedRevisionDigest: normalRevision.digest,
      approvalRequirement: 'distinct_current_human' as const
    };
    expect(validateExactCommit(normal, strict)).toEqual({
      kind: 'refused',
      refusal: { kind: 'approval_missing' }
    });
    expect(validateExactCommit(normal, {
      ...strict,
      approval: approval(normalRevision.id, normalRevision.digest),
      approverCurrentlyAuthorized: true
    }).kind).toBe('ready');
  });

  test('rehydrated revision tampering is refused even when the stored digest is left unchanged', () => {
    const created = createChangeset({ id: 'cs:1', workspaceId: 'w', eventId: 'e' }, draft('rev:1'));
    const original = proposeChangeset(created, created.version);
    const revision = original.revisions[0]!;
    const base = {
      expectedHeadVersion: original.version,
      expectedRevisionDigest: revision.digest,
      currentAggregateVersions: new Map([['program:source', 3]]),
      currentGuardVersions: new Map([['program:index', 8]]),
      currentGuardDigests: new Map([['program:index', 'guard-a']]),
      now: '2026-08-11T01:00:00.000Z',
      approvalRequirement: 'distinct_current_human',
      approval: approval(revision.id, revision.digest),
      approverCurrentlyAuthorized: true
    } as const;

    const tamperedOperation = structuredClone(original) as ChangesetHead;
    (tamperedOperation.revisions[0]!.operations[0]!.plan as { target: string }).target = 'program:attacker';
    expect(validateExactCommit(tamperedOperation, base)).toEqual({
      kind: 'refused',
      refusal: { kind: 'digest_changed' }
    });

    const tamperedRisk = structuredClone(original) as ChangesetHead;
    (tamperedRisk.revisions[0] as { riskTier: string }).riskTier = 'low';
    expect(validateExactCommit(tamperedRisk, base)).toEqual({
      kind: 'refused',
      refusal: { kind: 'digest_changed' }
    });

    const tamperedProvenance = structuredClone(original) as ChangesetHead;
    (tamperedProvenance.revisions[0]!.originProvenance as { flow: string }).flow = 'bypassed';
    expect(validateExactCommit(tamperedProvenance, base)).toEqual({
      kind: 'refused',
      refusal: { kind: 'digest_changed' }
    });
    expect(revision.originProvenance).toEqual({ client: 'operator_web', flow: 'reviewed_diff' });
  });

  test('rehydrated heads verify the complete immutable revision chain', () => {
    const created = createChangeset({ id: 'cs:1', workspaceId: 'w', eventId: 'e' }, draft('rev:1'));
    const revised = reviseChangeset(created, {
      ...draft('rev:2'),
      createdAt: '2026-08-11T00:02:00.000Z'
    });
    const original = proposeChangeset(revised, revised.version);
    const revision = original.revisions.at(-1)!;
    const base = {
      expectedHeadVersion: original.version,
      expectedRevisionDigest: revision.digest,
      currentAggregateVersions: new Map([['program:source', 3]]),
      currentGuardVersions: new Map([['program:index', 8]]),
      currentGuardDigests: new Map([['program:index', 'guard-a']]),
      now: '2026-08-11T01:00:00.000Z',
      approvalRequirement: 'distinct_current_human',
      approval: approval(revision.id, revision.digest),
      approverCurrentlyAuthorized: true
    } as const;

    expect(validateExactCommit(original, base).kind).toBe('ready');

    const tamperedEarlierRevision = structuredClone(original) as ChangesetHead;
    (tamperedEarlierRevision.revisions[0] as { proposerPrincipalKey: string }).proposerPrincipalKey = 'principal:attacker';
    expect(validateExactCommit(tamperedEarlierRevision, base)).toEqual({
      kind: 'refused',
      refusal: { kind: 'digest_changed' }
    });

    const missingEarlierRevision = structuredClone(original) as ChangesetHead;
    (missingEarlierRevision as { revisions: ChangesetHead['revisions'] }).revisions = [
      missingEarlierRevision.revisions[1]!
    ];
    expect(validateExactCommit(missingEarlierRevision, base)).toEqual({
      kind: 'refused',
      refusal: { kind: 'digest_changed' }
    });
  });

  test('partial replan cannot retain a group that depends on replanned work', () => {
    const head = createChangeset({ id: 'cs:1', workspaceId: 'w' }, draft('rev:1'));
    const revision = head.revisions[0]!;
    expect(() => assertReplanSelection(revision, new Set(['source']))).toThrow(
      'Retained group dependent depends on replanned work'
    );
    expect(() => assertReplanSelection(revision, new Set(['independent']))).not.toThrow();
  });

  test('duplicate dependencies are rejected before a revision can be persisted', () => {
    expect(() => createChangeset({ id: 'cs:duplicate', workspaceId: 'w' }, {
      ...draft('rev:duplicate'),
      dependencyGroups: [
        { key: 'source', dependsOn: [] },
        { key: 'dependent', dependsOn: ['source', 'source'] },
        { key: 'independent', dependsOn: [] }
      ]
    })).toThrow('Duplicate dependency in group: dependent');
  });
});
