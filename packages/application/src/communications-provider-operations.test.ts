import { describe, expect, test } from 'bun:test';
import { emailProviderConnectionProjectionSchema } from '@jooevents/contracts';
import {
  COMMUNICATION_PROVIDER_OPERATION_ACTIVATION,
  createCommunicationProviderReadOperations
} from './communications-provider-operations';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const otherWorkspaceId = '019c1df7-86b5-769b-bba4-5f7097bfa111';
const createdAt = '2026-08-13T09:00:00.000Z';

function connection(currentWorkspaceId = workspaceId) {
  return emailProviderConnectionProjectionSchema.parse({
    schemaVersion: 1,
    connectionId: 'connection-1',
    workspaceId: currentWorkspaceId,
    displayName: 'Cloudflare Email',
    adapterKey: 'cloudflare.email.workers',
    lifecycle: 'draft',
    headVersion: 1,
    currentRevisionId: null,
    candidateRevisions: [],
    createdAt,
    updatedAt: createdAt
  });
}

describe('communication provider application reads', () => {
  test('returns scope-bound safe provider and readiness projections', async () => {
    const operations = createCommunicationProviderReadOperations({
      workspaceId,
      configuration: { getConnection: () => connection() },
      readiness: { getReadiness: () => ({
        schemaVersion: 1,
        outbound: { state: 'unknown', nextStepCode: 'configure_email_provider' },
        callbacks: { state: 'not_supported' },
        inbound: { state: 'not_enabled' }
      }) }
    });

    expect((await operations.getConnection({ connectionId: 'connection-1' })).kind).toBe('success');
    const readiness = await operations.getReadiness({});
    expect(readiness.kind).toBe('success');
    if (readiness.kind === 'success') {
      expect(readiness.data.callbacks.state).toBe('not_supported');
      expect(readiness.data.inbound.state).toBe('not_enabled');
    }
  });

  test('does not reveal a connection from another workspace', async () => {
    const operations = createCommunicationProviderReadOperations({
      workspaceId,
      configuration: { getConnection: () => connection(otherWorkspaceId) },
      readiness: { getReadiness: () => ({
        schemaVersion: 1,
        outbound: { state: 'unknown', nextStepCode: 'configure_email_provider' },
        callbacks: { state: 'not_supported' }, inbound: { state: 'not_enabled' }
      }) }
    });

    const result = await operations.getConnection({ connectionId: 'connection-1' });
    expect(result.kind).toBe('outcome');
  });

  test('declares the mounted external-effect executor family beside the read leaves', () => {
    expect(COMMUNICATION_PROVIDER_OPERATION_ACTIVATION).toEqual({
      getConnection: 'read_leaf_ready',
      getReadiness: 'read_leaf_ready',
      runReadinessCheck: 'external_effect_executor_mounted',
      sendDiagnosticTest: 'external_effect_executor_mounted'
    });
  });
});
