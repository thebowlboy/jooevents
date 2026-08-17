import { describe, expect, test } from 'bun:test';
import { safeProviderDiagnostic, transitionConnection } from './state';

describe('connection state and safe diagnostics', () => {
  test('only declared lifecycle transitions are accepted', () => {
    expect(transitionConnection('draft', 'provisioning')).toEqual({
      kind: 'accepted',
      state: 'provisioning'
    });
    expect(transitionConnection('active', 'disconnected')).toEqual({
      kind: 'refused',
      code: 'transition_not_allowed'
    });
  });

  test('safe diagnostics reject provider prose and malformed correlation identity', () => {
    expect(safeProviderDiagnostic({
      code: 'rate_limited',
      correlationId: '018f0f64-4d6c-7b2f-8a1e-1234567890ab',
      providerRequestId: 'req_123',
      retryAfterMs: 30_000
    })).toEqual({
      code: 'rate_limited',
      correlationId: '018f0f64-4d6c-7b2f-8a1e-1234567890ab',
      providerRequestId: 'req_123',
      retryAfterMs: 30_000
    });
    expect(() => safeProviderDiagnostic({
      code: 'Airtable says token=secret',
      correlationId: '018f0f64-4d6c-7b2f-8a1e-1234567890ab'
    })).toThrow('diagnostic_code_invalid');
  });
});
