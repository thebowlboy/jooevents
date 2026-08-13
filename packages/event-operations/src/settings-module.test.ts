import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence
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
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_READ_ACCESS_POLICY,
  EVENT_SETTINGS_CURRENT_READ_OPERATION,
  EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
  EVENT_SETTINGS_UPDATE_DRAFT_REQUEST_HASH_PROFILE,
  createEventSettingsReadOperationModule,
  createEventSettingsUpdateDraftOperationModule,
  eventSettingsUpdateDraftContributionSchema
} from '.';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = '019c1df7-86b5-769b-bba4-5f7097bfa111';
const userId = parseUserId('01890f47-9abc-7def-8123-456789abc001');
const membershipId = parseMembershipId('01890f47-9abc-7def-8123-456789abc002');
const now = parseInstant('2026-08-13T01:00:00.000Z');
const profile = { key: 'event-settings-test', version: parseContractVersion(1) } as const;
let invocation = 20;

const authority = {
  resolve(resolution: any) {
    return {
      kind: 'authorized' as const,
      authority: {
        actor: { kind: 'workspace_user' as const, userId },
        principal: { kind: 'workspace_user' as const, userId, membershipId },
        lane: resolution.lane,
        scope: resolution.scope,
        grants: [{
          kind: 'permission' as const,
          key: resolution.operation.effect === 'read' ? 'event.read' : 'event.manage'
        }],
        evidenceIds: ['membership.current'],
        authorityCitationIds: [],
        evaluatedAt: resolution.evaluatedAt
      }
    };
  }
};

const ids = {
  newInvocationId: () => parseInvocationId(
    `018f7d5a-4b3c-7abc-8def-${(++invocation).toString().padStart(12, '0')}`
  )
};

describe('Event settings operations', () => {
  test('registers the tuned current read and update-draft endpoints only', () => {
    const read = createEventSettingsReadOperationModule({
      workspaceId,
      readPolicy: EVENT_READ_ACCESS_POLICY,
      currentAuthority: authority,
      currentSettingsRead: {
        readCurrent: () => ({
          schemaVersion: 1,
          eventId,
          eventSetVersion: 2,
          eventVersion: 1,
          name: 'JooConf',
          timezone: 'Asia/Singapore',
          startDate: '2027-04-16',
          endDate: '2027-04-18',
          location: '',
          venueNote: ''
        })
      },
      clock: { now: () => now },
      ids,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile
    });
    const draft = createEventSettingsUpdateDraftOperationModule({
      workspaceId,
      managePolicy: EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority: authority,
      clock: { now: () => now },
      ids,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: EVENT_SETTINGS_UPDATE_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x33)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal(raw) {
          return {
            verifierProfile: profile,
            verifierSha256: createHash('sha256').update(`settings:${raw}`).digest('hex')
          };
        }
      }
    });
    expect(read.source.operations[0]).toMatchObject({
      ...EVENT_SETTINGS_CURRENT_READ_OPERATION,
      bindings: [{ method: 'GET', path: '/api/events/current/settings', input: 'query' }]
    });
    expect(draft.source.effectOperations?.[0]).toMatchObject({
      ...EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
      effect: 'draft',
      bindings: [{
        method: 'POST', path: '/api/events/current/settings/drafts/update', input: 'body'
      }]
    });
  });

  test('requires coherent selected-Event evidence in a draft contribution', () => {
    const base = {
      result: {
        kind: 'success' as const,
        data: {
          schemaVersion: 1 as const,
          action: 'update' as const,
          changesetId: '019c2582-aee8-7c51-8d2f-0d27f67dc112',
          headVersion: 1,
          status: 'draft' as const,
          revision: {
            id: '019c2582-aee8-7c51-8d2f-0d27f67dc113',
            number: 1,
            digestSha256: 'a'.repeat(64)
          },
          riskTier: 'low' as const,
          approvalPolicy: {
            reference: { key: 'event.settings.ordinary', version: 1 },
            definitionDigestSha256: 'b'.repeat(64),
            requirement: 'none' as const
          },
          safeDiff: {
            action: 'update' as const,
            before: {
              schemaVersion: 1 as const, eventId, eventSetVersion: 2, eventVersion: 1,
              name: 'JooConf', timezone: 'Asia/Singapore',
              startDate: '2027-04-16', endDate: '2027-04-18', location: '', venueNote: ''
            },
            after: {
              schemaVersion: 1 as const, eventId, eventSetVersion: 2, eventVersion: 2,
              name: 'JooConf Live', timezone: 'Asia/Singapore',
              startDate: '2027-04-16', endDate: '2027-04-18', location: '', venueNote: ''
            },
            selection: { eventId, eventSetVersion: 2 }
          }
        }
      },
      domain: {
        kind: 'event_settings_changeset_draft' as const,
        preparationHandle: '019c2582-aee8-7c51-8d2f-0d27f67dc114',
        action: 'update' as const,
        workspaceId,
        eventId,
        changesetId: '019c2582-aee8-7c51-8d2f-0d27f67dc112',
        revisionId: '019c2582-aee8-7c51-8d2f-0d27f67dc113',
        revisionDigestSha256: 'a'.repeat(64),
        recordDigestSha256: 'c'.repeat(64),
        occurredAt: now
      },
      receiptChildren: [{
        kind: 'timeline' as const,
        timelineId: '019c2582-aee8-7c51-8d2f-0d27f67dc115',
        sourceKind: 'changeset_revision' as const,
        workspaceId,
        eventId,
        changesetId: '019c2582-aee8-7c51-8d2f-0d27f67dc112',
        revisionId: '019c2582-aee8-7c51-8d2f-0d27f67dc113',
        occurredAt: now
      }]
    };
    expect(eventSettingsUpdateDraftContributionSchema.safeParse(base).success).toBe(true);
    expect(eventSettingsUpdateDraftContributionSchema.safeParse({
      ...base,
      domain: { ...base.domain, eventId: '019c2582-aee8-7c51-8d2f-0d27f67dc119' }
    }).success).toBe(false);
  });

  test('executes a typed no-Event read outcome instead of surfacing a handler failure', async () => {
    const module = createEventSettingsReadOperationModule({
      workspaceId,
      readPolicy: EVENT_READ_ACCESS_POLICY,
      currentAuthority: authority,
      currentSettingsRead: { readCurrent: () => undefined },
      clock: { now: () => now },
      ids,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile
    });
    const runtime = await createApplicationOperationRuntime({
      source: module.source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => now },
        newInvocationId: ids.newInvocationId
      },
      unitOfWork: {} as never,
      newReceiptId: () => '019c2582-aee8-7c51-8d2f-0d27f67dc120'
    });
    const evidence: InvocationEvidence = {
      kind: 'operator',
      surface: 'operator_http',
      client: { key: 'web.operator' },
      sessionHandle: 'verified-session-handle'
    };
    expect(await runtime.readExecutor.execute({
      operationName: EVENT_SETTINGS_CURRENT_READ_OPERATION.name,
      operationVersion: EVENT_SETTINGS_CURRENT_READ_OPERATION.version,
      surface: 'operator_http',
      correlationId: '019c2582-aee8-7c51-8d2f-0d27f67dc121',
      businessInput: {},
      verifiedEvidence: evidence
    })).toEqual({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'event.settings.event_required',
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      },
      correlationId: '019c2582-aee8-7c51-8d2f-0d27f67dc121'
    });
  });
});
