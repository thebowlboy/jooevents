import { describe, expect, test } from 'bun:test';
import type { EffectInvocationBuilder, EffectOperationExecutor, SealedEffectInvocation } from '@jooevents/application';
import { RegisteredOperationAirtableInboundPort } from './registered-operation-port';

describe('registered operation Airtable inbound port', () => {
  test('provider values cannot select an operation or action outside the finite methods', async () => {
    const builds: Array<Record<string, unknown>> = [];
    const builder: EffectInvocationBuilder = {
      async build(input) { builds.push(input as unknown as Record<string, unknown>); return input as SealedEffectInvocation; },
      async buildRegisteredConsumer() { throw new Error('unused'); },
      async buildRegisteredJob() { throw new Error('unused'); }
    };
    const executor: EffectOperationExecutor = {
      async execute(invocation) {
        return {
          kind: 'success', data: {},
          receipt: { id: '018f0f64-4d6c-7b2f-8a1e-1234567890aa', operationName: invocation.operationName, operationVersion: invocation.operationVersion },
          correlationId: invocation.correlationId
        };
      }
    };
    const port = new RegisteredOperationAirtableInboundPort({
      builder, executor, verifiedInboxEvidence: { kind: 'verified_inbox' },
      deletionReview: { async request() { return { kind: 'applied' }; } },
      newCorrelationId: () => '018f0f64-4d6c-7b2f-8a1e-1234567890ab'
    });
    await port.setTaskAssignmentStatus({ assignmentId: 'assignment', expectedVersion: 2, status: 'complete', idempotencyKey: 'stable-task' });
    await port.setEngagementCancellationRequest({ engagementId: 'engagement', expectedVersion: 3, requested: false, idempotencyKey: 'stable-request' });
    expect(builds.map((entry) => [entry.operationName, entry.surface, entry.businessInput])).toEqual([
      ['task.mutation', 'provider_ingress', { action: 'accept_fulfillment', assignmentId: 'assignment', expectedVersion: 2 }],
      ['engagement.change', 'provider_ingress', { action: 'withdraw_cancellation', engagementId: 'engagement', expectedEngagementVersion: 3 }]
    ]);
  });
});
