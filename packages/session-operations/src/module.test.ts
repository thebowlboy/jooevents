import { describe, expect, test } from 'bun:test';
import { createOperationRegistry } from '@jooevents/application';
import { parseContractVersion, parseEventId, parseInstant, parseInvocationId, parseWorkspaceId } from '@jooevents/kernel';
import { createEmptySessionCatalog } from '@jooevents/session';
import {
  SESSION_CATALOG_READ_OPERATION,
  SESSION_READ_ACCESS_POLICY,
  createSessionOperationModule
} from '.';

const scope = Object.freeze({
  workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101')
});
const profile = Object.freeze({ key: 'session-operation-test', version: parseContractVersion(1) });

describe('Session operation module', () => {
  test('registers a current-event, current-authority catalog read', async () => {
    const module = createSessionOperationModule({
      workspaceId: scope.workspaceId,
      currentEvent: {
        resolveCurrentEvent: () => Object.freeze({
          eventId: scope.eventId,
          evidenceIds: Object.freeze(['event.current.selection'])
        })
      },
      readPolicy: SESSION_READ_ACCESS_POLICY,
      currentAuthority: {
        resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
      },
      clock: { now: () => parseInstant('2026-08-13T12:00:00.000Z') },
      ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      sessions: { readSessionCatalog: () => createEmptySessionCatalog(scope) }
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: `${SESSION_CATALOG_READ_OPERATION.name}@1`,
      method: 'GET',
      path: '/api/events/current/sessions'
    }]);
    expect(registry.safeManifest.operations[0]).toMatchObject({
      effect: 'read', maxRisk: 'low', consequenceTags: []
    });
  });
});
