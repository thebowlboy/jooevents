import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createHmacRequestHashSealer,
  createOperationRegistry
} from '@jooevents/application';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  createWorkspaceSenderIdentityOperationModule,
  workspaceSenderIdentityContributionSchema,
  WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY,
  WORKSPACE_SENDER_IDENTITY_PERMISSION_ID,
  WORKSPACE_SENDER_IDENTITY_READ_OPERATION,
  WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION
} from './workspace-sender-identity-module';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const userId = parseUserId('01890f47-9abc-7def-8123-456789abc001');
const membershipId = parseMembershipId('01890f47-9abc-7def-8123-456789abc002');
const now = parseInstant('2026-08-15T00:00:00.000Z');
const profile = {
  key: 'profile.communication.sender-identity-test', version: parseContractVersion(1)
} as const;
let invocation = 0;
const ids = {
  newInvocationId: () => parseInvocationId(
    `018f7d5a-4b3c-7abc-8def-${(++invocation).toString().padStart(12, '0')}`
  )
};
const authority = {
  resolve(resolution: any) {
    return {
      kind: 'authorized' as const,
      authority: {
        actor: { kind: 'workspace_user' as const, userId },
        principal: { kind: 'workspace_user' as const, userId, membershipId },
        lane: resolution.lane,
        scope: resolution.scope,
        grants: [{ kind: 'permission' as const, key: WORKSPACE_SENDER_IDENTITY_PERMISSION_ID }],
        evidenceIds: ['membership.current'],
        authorityCitationIds: [],
        evaluatedAt: resolution.evaluatedAt
      }
    };
  }
};
const crypto = {
  authorityPrincipalKeyProfile: profile,
  scopePartitionProfile: profile,
  requestCanonicalizationProfile: profile,
  requestHashSealer: createHmacRequestHashSealer({
    profile: { key: 'request-hash.communication.sender-identity-test', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x51)
  }),
  idempotencyCredentialProfile: profile,
  idempotencyCredentialSealer: {
    seal(raw: string) {
      return {
        verifierProfile: profile,
        verifierSha256: createHash('sha256').update(`sender-identity:${raw}`).digest('hex')
      };
    }
  }
};

const identity = Object.freeze({
  schemaVersion: 1 as const,
  workspaceId,
  headVersion: 1,
  displayName: null,
  replyToAddress: null,
  effective: Object.freeze({
    fromAddress: 'no-reply@mail.installation.example',
    fromDisplayName: 'JooEvents',
    replyToAddress: null,
    source: 'installation' as const
  }),
  updatedAt: null
});

function build() {
  return createWorkspaceSenderIdentityOperationModule({
    workspaceId,
    policy: WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY,
    currentAuthority: authority,
    read: { readSenderIdentity: () => identity },
    clock: { now: () => now },
    ids,
    crypto
  });
}

describe('workspace sender identity operation module', () => {
  test('registers one read and one commit, both on the provider-management policy', async () => {
    const module = build();
    expect(module.source.operations?.map((operation) => operation.name))
      .toEqual([WORKSPACE_SENDER_IDENTITY_READ_OPERATION.name]);
    expect(module.source.effectOperations?.map((operation) => operation.name))
      .toEqual([WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION.name]);
    for (const operation of [
      ...(module.source.operations ?? []), ...(module.source.effectOperations ?? [])
    ]) {
      expect(operation.accessLanes.every((lane) =>
        lane.policy.key === WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY.key
        && lane.policy.version === WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY.version
      )).toBe(true);
    }
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpBindings).toHaveLength(1);
    expect(registry.operatorHttpEffectBindings).toHaveLength(1);
  });

  test('the read reaches MCP; the commit does not, because commits are human-lane', () => {
    const module = build();
    expect(module.source.operations?.[0]?.bindings.map((binding) => binding.surface))
      .toEqual(['operator_http', 'external_mcp']);
    expect(module.source.effectOperations?.[0]?.bindings.map((binding) => binding.surface))
      .toEqual(['operator_http']);
  });

  test('a mismatched policy is refused at composition', () => {
    expect(() => createWorkspaceSenderIdentityOperationModule({
      workspaceId,
      policy: { key: 'policy.event.manage', version: parseContractVersion(1) },
      currentAuthority: authority,
      read: { readSenderIdentity: () => identity },
      clock: { now: () => now },
      ids,
      crypto
    })).toThrow('workspace_sender_identity_policy_catalog_mismatch');
  });

  test('the update declares both refusals with their typed details', () => {
    const outcomes = build().source.effectOperations?.[0]?.outcomes ?? [];
    expect(outcomes.some((outcome) =>
      outcome.class === 'policy_violation'
      && outcome.kind === 'communication.sender_identity_refused'
    )).toBe(true);
    expect(outcomes.some((outcome) =>
      outcome.class === 'stale_revision'
      && outcome.kind === 'communication.sender_identity_changed'
    )).toBe(true);
  });
});

describe('workspace sender identity contribution', () => {
  const success = {
    result: {
      kind: 'success',
      data: {
        ...identity,
        headVersion: 2,
        displayName: 'Nordic Product Days',
        updatedAt: '2026-08-15T00:00:00.000Z',
        effective: { ...identity.effective, fromDisplayName: 'Nordic Product Days', source: 'workspace' }
      }
    },
    domain: {
      kind: 'workspace_sender_identity_update',
      preparationHandle: '018f7d5a-4b3c-7abc-8def-000000000101',
      workspaceId,
      headVersion: 2,
      occurredAt: '2026-08-15T00:00:00.000Z'
    },
    receiptChildren: [{
      kind: 'domain_fact',
      factId: '018f7d5a-4b3c-7abc-8def-000000000102',
      factKind: 'workspace_sender_identity_changed',
      payload: { headVersion: 2, displayNameSet: true, replyToAddressSet: false },
      occurredAt: '2026-08-15T00:00:00.000Z'
    }]
  } as const;

  test('accepts coherent success evidence', () => {
    expect(workspaceSenderIdentityContributionSchema.safeParse(success).success).toBe(true);
  });

  test('rejects evidence whose fact disagrees with the projected head', () => {
    expect(workspaceSenderIdentityContributionSchema.safeParse({
      ...success,
      receiptChildren: [{ ...success.receiptChildren[0], payload: {
        headVersion: 3, displayNameSet: true, replyToAddressSet: false
      } }]
    }).success).toBe(false);
    expect(workspaceSenderIdentityContributionSchema.safeParse({
      ...success,
      receiptChildren: [{ ...success.receiptChildren[0], payload: {
        headVersion: 2, displayNameSet: false, replyToAddressSet: false
      } }]
    }).success).toBe(false);
  });

  test('accepts only the two declared refusals, with their exact details', () => {
    const refusal = (outcome: unknown) => workspaceSenderIdentityContributionSchema.safeParse({
      result: { kind: 'outcome', outcome }, domain: null, receiptChildren: []
    }).success;
    expect(refusal({
      class: 'policy_violation',
      kind: 'communication.sender_identity_refused',
      retryable: false,
      subjects: [],
      detail: { field: 'display_name', code: 'display_name_control_character' },
      detailSchemaVersion: 1
    })).toBe(true);
    expect(refusal({
      class: 'stale_revision',
      kind: 'communication.sender_identity_changed',
      retryable: false,
      subjects: [],
      detail: { code: 'head_version_changed', headVersion: 2 },
      detailSchemaVersion: 1
    })).toBe(true);
    // A refusal code that names the other field, and an undeclared outcome.
    expect(refusal({
      class: 'policy_violation',
      kind: 'communication.sender_identity_refused',
      retryable: false,
      subjects: [],
      detail: { field: 'display_name', code: 'reply_to_multiple_addresses' },
      detailSchemaVersion: 1
    })).toBe(false);
    expect(refusal({
      class: 'conflict',
      kind: 'communication.not_found',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })).toBe(false);
  });
});
