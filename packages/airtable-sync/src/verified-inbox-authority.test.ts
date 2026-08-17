import { describe, expect, test } from 'bun:test';
import { parseContractVersion, parseEventId, parseInstant, parseIntegrationInboxReceiptId, parseSourceConnectionId, parseVerifierRevisionId, parseWorkspaceId } from '@jooevents/kernel';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import { createAirtableVerifiedInboxAuthorityResolver } from './verified-inbox-authority';

const inbox = parseIntegrationInboxReceiptId('018f0f64-4d6c-7b2f-8a1e-1234567890aa');
const workspaceId = parseWorkspaceId('018f0f64-4d6c-7b2f-8a1e-1234567890ab');
const eventId = parseEventId('018f0f64-4d6c-7b2f-8a1e-1234567890ac');
const policy = { key: 'authority.task.manage', version: parseContractVersion(1) };

describe('Airtable verified inbox authority', () => {
  test('authorizes only the finite operation inventory in the connection scope', async () => {
    const resolver = createAirtableVerifiedInboxAuthorityResolver({
      policies: [policy], source: { async resolve() { return {
        sourceConnectionId: parseSourceConnectionId('018f0f64-4d6c-7b2f-8a1e-1234567890ad'),
        verifierRevisionId: parseVerifierRevisionId('018f0f64-4d6c-7b2f-8a1e-1234567890ae'),
        workspaceId, eventId, state: 'active'
      }; } }
    });
    const base = {
      evidence: { kind: 'verified_inbox' as const, surface: 'provider_ingress' as const,
        client: { key: 'airtable.settle' }, inboxReceiptId: inbox },
      lane: parseOperationAccessLane({ kind: 'verified_inbox', surface: 'provider_ingress', policy }),
      scope: { workspaceId, eventId, subjects: [{ kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }], resolutionEvidenceIds: ['airtable.connection-scope'] },
      evaluatedAt: parseInstant('2026-08-17T00:00:00.000Z')
    };
    expect((await resolver.resolve({ ...base, operation: { name: 'task.mutation', version: 1, effect: 'commit' } })).kind).toBe('authorized');
    expect(await resolver.resolve({ ...base, operation: { name: 'decision.change', version: 1, effect: 'commit' } }))
      .toEqual({ kind: 'denied', reason: 'lane_mismatch' });
  });
});
