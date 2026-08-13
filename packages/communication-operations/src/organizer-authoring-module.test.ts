import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createHmacRequestHashSealer,
  createOperationRegistry,
  type EffectInvocationContext
} from '@jooevents/application';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS,
  ORGANIZER_COMMUNICATION_READ_OPERATIONS,
  composeOrganizerCommunicationAuthoringOperationModules,
  createOrganizerCommunicationMutationOperationModule,
  createOrganizerCommunicationReadOperationModule,
  organizerCommunicationMutationContributionSchema
} from './organizer-authoring-module';
import {
  createOrganizerCommunicationMutationHandler,
  sealOrganizerCommunicationMutationPreparation
} from './organizer-authoring-preparation';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('550e8400-e29b-41d4-a716-446655440001');
const userId = parseUserId('01890f47-9abc-7def-8123-456789abc001');
const membershipId = parseMembershipId('01890f47-9abc-7def-8123-456789abc002');
const now = parseInstant('2026-08-13T00:00:00.000Z');
const profile = { key: 'profile.communication.authoring-test', version: parseContractVersion(1) } as const;
let invocation = 0;
const ids = {
  newInvocationId: () => parseInvocationId(
    `018f7d5a-4b3c-7abc-8def-${(++invocation).toString().padStart(12, '0')}`
  )
};
const currentEvent = {
  resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.selection.current'] })
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
        grants: [{ kind: 'permission' as const, key: 'communication.draft' }],
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
    profile: { key: 'request-hash.communication.authoring-test', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x43)
  }),
  idempotencyCredentialProfile: profile,
  idempotencyCredentialSealer: {
    seal(raw: string) {
      return {
        verifierProfile: profile,
        verifierSha256: createHash('sha256').update(`communication:${raw}`).digest('hex')
      };
    }
  }
};

describe('organizer communication authoring operation modules', () => {
  test('registers exactly the six frozen C0 reads with HTTP, MCP, and model bindings', async () => {
    const module = createOrganizerCommunicationReadOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority: authority,
      currentEvent,
      read: {
        listPurposes: () => ({ kind: 'success', data: { schemaVersion: 1, rows: [], page: { hasMore: false } } }),
        getPurpose: () => ({ kind: 'outcome', outcome: { class: 'conflict', kind: 'communication.not_found', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } }),
        listTemplates: () => ({ kind: 'success', data: { schemaVersion: 1, rows: [], page: { hasMore: false } } }),
        getTemplate: () => ({ kind: 'outcome', outcome: { class: 'conflict', kind: 'communication.not_found', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } }),
        listDrafts: () => ({ kind: 'success', data: { schemaVersion: 1, rows: [], page: { hasMore: false } } }),
        getDraft: () => ({ kind: 'outcome', outcome: { class: 'conflict', kind: 'communication.not_found', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } })
      },
      clock: { now: () => now },
      ids,
      crypto
    });
    expect(module.source.operations.map((operation) => operation.name)).toEqual(
      Object.values(ORGANIZER_COMMUNICATION_READ_OPERATIONS).map((operation) => operation.name)
    );
    expect(module.source.operations.every((operation) =>
      operation.bindings.map((binding) => binding.surface).join(',') ===
        'operator_http,external_mcp,app_model'
    )).toBe(true);
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpBindings).toHaveLength(6);
    expect(registry.appModelReadBindings).toHaveLength(6);
    expect(registry.safeManifest.operations).toHaveLength(6);
  });

  test('registers only four inert draft mutations and no send/provider operation', async () => {
    const module = createOrganizerCommunicationMutationOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority: authority,
      currentEvent,
      clock: { now: () => now },
      ids,
      crypto
    });
    expect(module.source.effectOperations?.map((operation) => operation.name)).toEqual(
      Object.values(ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS).map((operation) => operation.name)
    );
    expect(module.source.effectOperations?.some((operation) =>
      operation.name.includes('send') || operation.name.includes('provider')
    )).toBe(false);
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpEffectBindings).toHaveLength(4);
    expect(registry.appModelEffectBindings).toHaveLength(4);
  });

  test('joins the read and mutation halves with one exact shared registration set', async () => {
    const read = createOrganizerCommunicationReadOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority: authority,
      currentEvent,
      read: {
        listPurposes: () => ({ kind: 'success', data: { schemaVersion: 1, rows: [], page: { hasMore: false } } }),
        getPurpose: () => ({ kind: 'outcome', outcome: { class: 'conflict', kind: 'communication.not_found', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } }),
        listTemplates: () => ({ kind: 'success', data: { schemaVersion: 1, rows: [], page: { hasMore: false } } }),
        getTemplate: () => ({ kind: 'outcome', outcome: { class: 'conflict', kind: 'communication.not_found', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } }),
        listDrafts: () => ({ kind: 'success', data: { schemaVersion: 1, rows: [], page: { hasMore: false } } }),
        getDraft: () => ({ kind: 'outcome', outcome: { class: 'conflict', kind: 'communication.not_found', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } })
      },
      clock: { now: () => now },
      ids,
      crypto
    });
    const mutation = createOrganizerCommunicationMutationOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority: authority,
      currentEvent,
      clock: { now: () => now },
      ids,
      crypto
    });
    const combined = composeOrganizerCommunicationAuthoringOperationModules({ read, mutation });
    const registry = await createOperationRegistry(combined.source);
    expect(registry.safeManifest.operations.map((operation) => operation.name)).toEqual([
      ...Object.values(ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS),
      ...Object.values(ORGANIZER_COMMUNICATION_READ_OPERATIONS)
    ].map((operation) => operation.name).sort());
    expect(combined.source.schemas?.filter((registered) =>
      registered.reference.key === 'schema.communication.organizer.authoring.null-detail'
    )).toHaveLength(1);
    expect(combined.source.operationAuditRecordProfiles).toHaveLength(1);
  });

  test('requires success evidence to match the exact safe mutation result', () => {
    const contribution = {
      result: {
        kind: 'success' as const,
        data: {
          schemaVersion: 1 as const,
          draftId: 'draft-1',
          version: 1,
          state: 'active' as const,
          authoring: {
            state: 'uninitialized' as const,
            contentRefId: 'je.communication.message-draft.empty-content/v1' as const,
            audienceRefId: 'je.communication.message-draft.empty-audience/v1' as const
          },
          nextRead: { operationName: 'get_message_draft' as const, draftId: 'draft-1', expectedVersion: 1 }
        }
      },
      domain: {
        kind: 'organizer_communication_authoring' as const,
        operationName: 'create_message_draft' as const,
        workspaceId,
        eventId,
        entityId: 'draft-1',
        entityVersion: 1,
        occurredAt: now
      },
      receiptChildren: [] as []
    };
    expect(organizerCommunicationMutationContributionSchema.parse(contribution)).toEqual(contribution);
    expect(() => organizerCommunicationMutationContributionSchema.parse({
      ...contribution,
      domain: { ...contribution.domain, entityVersion: 2 }
    })).toThrow();
  });

  test('sealed preparations are exact-operation, exact-context, and one-shot', () => {
    const context = Object.freeze({}) as EffectInvocationContext;
    const capability = { key: 'capability.communication.test', version: 1 };
    const canonical = { key: 'schema.communication.test.canonical', version: 1,
      digestSha256: 'a'.repeat(64) };
    const contribution = { key: 'schema.communication.test.contribution', version: 1,
      digestSha256: 'b'.repeat(64) };
    const handler = createOrganizerCommunicationMutationHandler({
      reference: { key: 'handler.communication.test', version: 1 },
      operationName: 'create_message_draft',
      handlerCapability: capability,
      contributionSchema: contribution,
      canonicalResultSchema: canonical
    });
    const snapshot = sealOrganizerCommunicationMutationPreparation({
      capability,
      context,
      operationName: 'create_message_draft',
      preparation: {
        prepare: () => ({ result: { kind: 'outcome', outcome: {
          class: 'conflict', kind: 'communication.not_found', retryable: false,
          subjects: [], detail: null, detailSchemaVersion: 1
        } }, domain: null, receiptChildren: [] })
      }
    });
    expect(handler.handle({ businessInput: {}, context, snapshot })).toEqual(expect.objectContaining({
      domain: null,
      receiptChildren: []
    }));
    expect(() => handler.handle({ businessInput: {}, context, snapshot })).toThrow();
  });
});
