import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createHmacRequestHashSealer,
  createOperationRegistry,
  createRegisteredAgentActionEligibilityCatalog
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
  EVENT_SETTINGS_UPDATE_OPERATION,
  EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE,
  createEventSettingsReadOperationModule,
  createEventSettingsUpdateOperationModule,
  eventSettingsDirectUpdateContributionSchema
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
  test('registers one current read and one direct audited update endpoint', async () => {
    const read = createEventSettingsReadOperationModule({
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
    const update = createEventSettingsUpdateOperationModule({
      workspaceId,
      managePolicy: EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority: authority,
      clock: { now: () => now },
      ids,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x33)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal(raw: string) {
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
    expect(update.source.effectOperations?.[0]).toMatchObject({
      ...EVENT_SETTINGS_UPDATE_OPERATION,
      effect: 'commit',
      execution: {
        kind: 'single_unit_of_work', profile: 'direct_audited',
        history: { summary: 'Updated event settings' }
      },
      bindings: [{ method: 'POST', path: '/api/events/current/settings', input: 'body' }]
    });
    const registry = await createOperationRegistry(update.source);
    const eligibility = createRegisteredAgentActionEligibilityCatalog(registry);
    expect(eligibility.entries).toEqual([{
      operationName: EVENT_SETTINGS_UPDATE_OPERATION.name,
      operationVersion: EVENT_SETTINGS_UPDATE_OPERATION.version,
      contractDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      displayLabel: 'Update event settings',
      consequences: ['The event name, dates, or timezone may change.'],
      externalEffect: 'none',
      maxRisk: 'low'
    }]);
    const entry = eligibility.resolve(
      EVENT_SETTINGS_UPDATE_OPERATION.name,
      EVENT_SETTINGS_UPDATE_OPERATION.version
    );
    const candidate = {
      expectedEventId: eventId,
      expectedEventSetVersion: 1,
      expectedEventVersion: 1,
      name: 'JSConf',
      timezone: 'Asia/Singapore',
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      location: 'Singapore',
      venueNote: '',
      dayStart: '09:00',
      dayEnd: '17:00',
      slotMinutes: 30
    };
    expect(entry?.validateInput(candidate)).toEqual(candidate);
    expect(eligibility.resolve('event.settings.unregistered', 1)).toBeUndefined();
  });

  test('direct contributions are compact and carry no universal evidence children', () => {
    const outcome = eventSettingsDirectUpdateContributionSchema.parse({
      result: {
        kind: 'outcome',
        outcome: {
          class: 'conflict', kind: 'event.settings.event_required', retryable: false,
          subjects: [], detail: null, detailSchemaVersion: 1
        }
      },
      domain: null,
      effectContributions: []
    });
    expect(outcome.effectContributions).toHaveLength(0);
  });
});
