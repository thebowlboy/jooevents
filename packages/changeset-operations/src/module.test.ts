import { describe, expect, test } from 'bun:test';
import {
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createOperationRegistry
} from '@jooevents/application';
import { CHANGESET_OPERATION_SCHEMA_REFS } from '@jooevents/contracts';
import { parseContractVersion, parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  changesetLifecycleContributionSchema,
  changesetApplicationIdSchema,
  changesetCanonicalInstantSchema,
  commitChangesetInputSchema,
  createChangesetOperationModule,
  proposeChangesetInputSchema,
  type ChangesetLifecycleStore
} from '.';

const workspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678901');
const profile = Object.freeze({
  key: 'changeset-operation-test', version: parseContractVersion(1)
});

function emptyStore(): ChangesetLifecycleStore {
  return Object.freeze({
    read: () => undefined,
    insertDraft: () => 'inserted' as const,
    replaceHead: () => 'not_found' as const,
    readApprovals: () => Object.freeze([]),
    insertApproval: () => 'inserted' as const,
    readCommitLink: () => undefined,
    commit: () => 'not_found' as const,
    insertCorrection: () => 'inserted' as const,
    readCorrection: () => undefined,
    readCorrections: () => Object.freeze([])
  });
}

function operationModule(enableDistinctHumanApproval = false) {
  return createChangesetOperationModule({
    workspaceId,
    policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    currentAuthority: Object.freeze({
      resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'not_authorized' as const })
    }),
    lifecycleStore: emptyStore(),
    ownerResolution: Object.freeze({ resolveOwner: () => undefined }),
    enableDistinctHumanApproval,
    clock: Object.freeze({ now: () => parseInstant('2026-08-12T10:00:00.000Z') }),
    ids: Object.freeze({
      newInvocationId: () => '018f7d5a-4b3c-7abc-8def-012345678902' as never
    }),
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x41)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
      profile,
      keyBytes: new Uint8Array(32).fill(0x42)
    })
  });
}

describe('neutral changeset operation module', () => {
  test('accepts exact workspace lifecycle evidence and rejects mixed event scope', () => {
    const base = {
      result: {
        kind: 'success',
        data: {
          schemaVersion: 1,
          action: 'propose',
          diff: {
            changesetId: '018f7d5a-4b3c-7abc-8def-012345678910',
            headVersion: 1,
            status: 'proposed',
            revisionId: '018f7d5a-4b3c-7abc-8def-012345678911',
            revisionNumber: 1,
            revisionDigest: 'a'.repeat(64),
            riskTier: 'consequential',
            approvalPolicy: {
              reference: { key: 'workspace_team.approval', version: 1 },
              definitionDigestSha256: 'b'.repeat(64),
              requirement: 'distinct_current_human'
            },
            operations: [{
              kind: 'workspace_team.mutate', version: 1, riskTier: 'consequential',
              dependencyGroup: 'workspace_team', safeDiff: { action: 'remove' },
              consequences: ['workspace_team_changed']
            }]
          }
        }
      },
      domain: {
        kind: 'changeset_lifecycle', action: 'propose',
        preparationHandle: '018f7d5a-4b3c-7abc-8def-012345678912',
        workspaceId,
        changesetId: '018f7d5a-4b3c-7abc-8def-012345678910',
        revisionId: '018f7d5a-4b3c-7abc-8def-012345678911',
        revisionDigest: 'a'.repeat(64),
        contributionDigestSha256: 'c'.repeat(64),
        occurredAt: '2026-08-12T10:00:00.000Z'
      },
      receiptChildren: [{
        kind: 'timeline',
        timelineId: '018f7d5a-4b3c-7abc-8def-012345678913',
        sourceKind: 'changeset_proposal', workspaceId,
        changesetId: '018f7d5a-4b3c-7abc-8def-012345678910',
        revisionId: '018f7d5a-4b3c-7abc-8def-012345678911',
        occurredAt: '2026-08-12T10:00:00.000Z'
      }]
    };
    expect(changesetLifecycleContributionSchema.safeParse(base).success).toBe(true);
    expect(changesetLifecycleContributionSchema.safeParse({
      ...base,
      receiptChildren: [{
        ...base.receiptChildren[0],
        eventId: '018f7d5a-4b3c-7abc-8def-012345678914'
      }]
    }).success).toBe(false);
  });

  test('requires exact event binding whenever the changeset owner is event scoped', () => {
    const eventId = '018f7d5a-4b3c-7abc-8def-012345678914';
    const workspaceContribution = {
      result: {
        kind: 'success',
        data: {
          schemaVersion: 1, action: 'propose',
          diff: {
            changesetId: '018f7d5a-4b3c-7abc-8def-012345678920', headVersion: 1,
            status: 'proposed', revisionId: '018f7d5a-4b3c-7abc-8def-012345678921',
            revisionNumber: 1, revisionDigest: 'd'.repeat(64), riskTier: 'low',
            approvalPolicy: {
              reference: { key: 'event.approval', version: 1 },
              definitionDigestSha256: 'e'.repeat(64), requirement: 'none'
            },
            operations: [{ kind: 'event.change', version: 1, riskTier: 'low',
              dependencyGroup: 'event', safeDiff: {}, consequences: ['event_changed'] }]
          }
        }
      },
      domain: {
        kind: 'changeset_lifecycle', action: 'propose',
        preparationHandle: '018f7d5a-4b3c-7abc-8def-012345678922', workspaceId,
        eventId, changesetId: '018f7d5a-4b3c-7abc-8def-012345678920',
        revisionId: '018f7d5a-4b3c-7abc-8def-012345678921', revisionDigest: 'd'.repeat(64),
        contributionDigestSha256: 'f'.repeat(64), occurredAt: '2026-08-12T10:00:00.000Z'
      },
      receiptChildren: [{
        kind: 'timeline', timelineId: '018f7d5a-4b3c-7abc-8def-012345678923',
        sourceKind: 'changeset_proposal', workspaceId, eventId,
        changesetId: '018f7d5a-4b3c-7abc-8def-012345678920',
        revisionId: '018f7d5a-4b3c-7abc-8def-012345678921',
        occurredAt: '2026-08-12T10:00:00.000Z'
      }]
    };
    expect(changesetLifecycleContributionSchema.safeParse(workspaceContribution).success).toBe(true);
    expect(changesetLifecycleContributionSchema.safeParse({
      ...workspaceContribution,
      receiptChildren: [{ ...workspaceContribution.receiptChildren[0], eventId: undefined }]
    }).success).toBe(false);
  });

  test('registers the exact neutral identities and paths without mounting approval by default', async () => {
    const registry = await createOperationRegistry(operationModule().source);
    expect(registry.safeManifest.operations.map((operation) => operation.name)).toEqual([
      'changeset.commit',
      'changeset.correction.draft',
      'changeset.diff.read',
      'changeset.propose',
      'changeset.rebuild'
    ]);
    expect(registry.operatorHttpBindings.map((binding) => binding.path)).toEqual([
      '/api/changesets/diff'
    ]);
    expect(registry.operatorHttpEffectBindings.map((binding) => binding.path).sort()).toEqual([
      '/api/changesets/commits',
      '/api/changesets/corrections',
      '/api/changesets/proposals',
      '/api/changesets/rebuilds'
    ]);
    const diff = registry.safeManifest.operations.find(
      (operation) => operation.name === 'changeset.diff.read'
    );
    const commit = registry.safeManifest.operations.find(
      (operation) => operation.name === 'changeset.commit'
    );
    expect(diff?.inputSchema).toEqual(CHANGESET_OPERATION_SCHEMA_REFS.diff.inputSchema);
    expect(diff?.enabledBindings[0]?.resultSchema)
      .toEqual(CHANGESET_OPERATION_SCHEMA_REFS.diff.resultSchema);
    expect(commit?.inputSchema).toEqual(CHANGESET_OPERATION_SCHEMA_REFS.commit.inputSchema);
    expect(commit?.enabledBindings[0]?.resultSchema)
      .toEqual(CHANGESET_OPERATION_SCHEMA_REFS.commit.resultSchema);
  });

  test('mounts approval only for an explicit distinct-human composition', async () => {
    const registry = await createOperationRegistry(operationModule(true).source);
    expect(registry.safeManifest.operations.map((operation) => operation.name))
      .toContain('changeset.approve');
    expect(registry.operatorHttpEffectBindings.map((binding) => binding.path))
      .toContain('/api/changesets/approvals');
  });

  test('keeps every browser input free of trusted scope, actor, time, and approval evidence', () => {
    const selector = {
      changesetId: '018f7d5a-4b3c-7abc-8def-012345678903',
      revisionId: '018f7d5a-4b3c-7abc-8def-012345678904',
      revisionDigest: 'a'.repeat(64),
      expectedHeadVersion: 1
    };
    expect(proposeChangesetInputSchema.safeParse(selector).success).toBe(true);
    for (const forbidden of [
      'workspaceId', 'eventId', 'actor', 'scope', 'approval', 'receiptId', 'evaluatedAt'
    ]) {
      expect(proposeChangesetInputSchema.safeParse({ ...selector, [forbidden]: 'forged' }).success)
        .toBe(false);
    }
    expect(commitChangesetInputSchema.safeParse(selector).success).toBe(true);
  });

  test('rejects UUIDv1 and non-canonical instants', () => {
    expect(changesetApplicationIdSchema.safeParse(
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
    ).success).toBe(false);
    expect(changesetCanonicalInstantSchema.safeParse(
      '2026-08-12T18:00:00.000+08:00'
    ).success).toBe(false);
    expect(changesetCanonicalInstantSchema.safeParse(
      '2026-08-12T10:00:00Z'
    ).success).toBe(false);
    expect(changesetCanonicalInstantSchema.safeParse(
      '2026-08-12T10:00:00.000Z'
    ).success).toBe(true);
  });
});
