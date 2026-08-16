import { describe, expect, test } from 'bun:test';
import {
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createOperationRegistry
} from '@jooevents/application';
import { parseContractVersion, parseInstant, parseInvocationId, parseWorkspaceId } from '@jooevents/kernel';
import {
  SESSION_CHANGE_OPERATION,
  SESSION_CHANGE_REQUEST_HASH_PROFILE,
  SESSION_CHANGED_DETAIL_SCHEMA_VERSION,
  SESSION_MANAGE_ACCESS_POLICY,
  createSessionDirectOperationModule,
  sessionChangedOutcome
} from '.';

const profile = Object.freeze({ key: 'session-direct-test', version: parseContractVersion(1) });

describe('Session direct operation module', () => {
  test('registers one direct audited POST with the frozen identity', async () => {
    const module = createSessionDirectOperationModule({
      workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
      managePolicy: SESSION_MANAGE_ACCESS_POLICY,
      currentAuthority: { resolve: () => ({ kind: 'denied', reason: 'missing' }) },
      currentEvent: { resolveCurrentEvent: () => ({ evidenceIds: ['event.none'] }) },
      clock: { now: () => parseInstant('2026-08-15T12:00:00.000Z') },
      ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
      authorityPrincipalKeyProfile: profile, scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: SESSION_CHANGE_REQUEST_HASH_PROFILE, keyBytes: new Uint8Array(32).fill(0x61)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile, keyBytes: new Uint8Array(32).fill(0x62)
      })
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpEffectBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method, path: binding.path
    }))).toEqual([{ operation: `${SESSION_CHANGE_OPERATION.name}@1`, method: 'POST',
      path: '/api/events/current/sessions' }]);
    expect(module.source.effectOperations?.[0]?.execution).toMatchObject({ profile: 'direct_audited' });
    const operation = module.source.effectOperations?.[0];
    const refusal = sessionChangedOutcome({
      code: 'stale_session',
      action: 'remove_new_session',
      sessionId: '018f7d5a-4b3c-7abc-8def-0123456789a1'
    });
    expect(refusal).toEqual({
      class: 'stale_revision',
      kind: 'session.changed',
      retryable: false,
      subjects: [],
      detail: {
        code: 'stale_session',
        action: 'remove_new_session',
        sessionId: '018f7d5a-4b3c-7abc-8def-0123456789a1'
      },
      detailSchemaVersion: SESSION_CHANGED_DETAIL_SCHEMA_VERSION
    });
    const declaration = operation?.outcomes.find(
      (candidate) => candidate.class === 'stale_revision' && candidate.kind === 'session.changed'
    );
    expect(declaration?.detailSchema.version).toBe(refusal.detailSchemaVersion);
    expect(module.source.schemas?.find(
      (candidate) => candidate.reference.key === declaration?.detailSchema.key
        && candidate.reference.version === declaration.detailSchema.version
    )?.schema.safeParse(refusal.detail).success).toBe(true);
  });
});
