import { describe, expect, test } from 'bun:test';
import {
  createPayloadRef,
  parseAggregateVersion,
  parseConsumerAttemptId,
  parseConsumerDeliveryId,
  parseInstant,
  parseInvocationId,
  parseJobId,
  parsePayloadRefId
} from '@jooevents/kernel';
import { definitionRef } from './definitions';
import {
  claimConsumerDelivery,
  completeConsumerDelivery,
  materializeConsumerDelivery,
  parseOpaqueSourceIdentity,
  parseOutboxPointerKey,
  planConsumerFanout,
  recordConsumerAttemptLostFence,
  type OutboxPointerRef
} from './delivery';
import {
  claimJob,
  completeJob,
  createJob
} from './job';
import { consumerDefinition, jobDefinition } from './test-fixtures';

const instant = (value: string) => parseInstant(value);

const pointer: OutboxPointerRef = Object.freeze({
  key: parseOutboxPointerKey('ptr1_submission-created-0001'),
  source: definitionRef('domain_fact', 'submission.created', 1),
  sourceIdentity: parseOpaqueSourceIdentity('src1_submission-created-0001'),
  sourceVersion: parseAggregateVersion(7),
  availableAt: instant('2026-08-11T00:00:00Z')
});

describe('consumer delivery transitions', () => {
  test('fans out exact consumer snapshots whose attempts progress independently', async () => {
    const firstConsumer = await consumerDefinition('submission.activity');
    const secondConsumer = await consumerDefinition('submission.search');
    const plan = planConsumerFanout(pointer, [secondConsumer, firstConsumer], []);
    expect(plan.creations.map((draft) => String(draft.consumer.key))).toEqual([
      'submission.activity',
      'submission.search'
    ]);

    const first = materializeConsumerDelivery(
      plan.creations[0]!,
      parseConsumerDeliveryId('00000000-0000-4000-8000-000000000011')
    );
    const second = materializeConsumerDelivery(
      plan.creations[1]!,
      parseConsumerDeliveryId('00000000-0000-4000-8000-000000000012')
    );
    const claimedFirst = claimConsumerDelivery(first, {
      attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000021'),
      ownerKey: 'worker-a',
      now: instant('2026-08-11T00:00:01Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:21Z')
    });
    const retriedFirst = completeConsumerDelivery(
      claimedFirst,
      claimedFirst.currentFence!,
      instant('2026-08-11T00:00:02Z'),
      {
        kind: 'retry',
        retryAt: instant('2026-08-11T00:02:00Z'),
        failure: { code: 'temporary_dependency', classification: 'transient' }
      }
    );

    expect(retriedFirst.state).toBe('retry_wait');
    expect(second.state).toBe('pending');
    expect(second.attempts).toHaveLength(0);
    expect(planConsumerFanout(pointer, [firstConsumer, secondConsumer], [retriedFirst, second]).creations)
      .toHaveLength(0);
  });

  test('increments the fence on takeover and rejects the stale worker', async () => {
    const consumer = await consumerDefinition();
    const draft = planConsumerFanout(pointer, [consumer], []).creations[0]!;
    const initial = materializeConsumerDelivery(
      draft,
      parseConsumerDeliveryId('00000000-0000-4000-8000-000000000013')
    );
    const first = claimConsumerDelivery(initial, {
      attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000022'),
      ownerKey: 'worker-a',
      now: instant('2026-08-11T00:00:01Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:05Z')
    });
    const second = claimConsumerDelivery(first, {
      attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000023'),
      ownerKey: 'worker-b',
      now: instant('2026-08-11T00:00:06Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:20Z')
    });
    expect(Number(second.currentFence)).toBe(2);
    expect(() =>
      completeConsumerDelivery(second, first.currentFence!, instant('2026-08-11T00:00:07Z'), {
        kind: 'succeeded'
      })
    ).toThrow(/lost its lease fence/);

    const withLostFenceEvidence = recordConsumerAttemptLostFence(
      second,
      first.lease!.attemptId,
      instant('2026-08-11T00:00:08Z')
    );
    const completed = completeConsumerDelivery(
      withLostFenceEvidence,
      second.currentFence!,
      instant('2026-08-11T00:00:09Z'),
      { kind: 'succeeded' }
    );
    expect(completed.state).toBe('succeeded');
    expect(completed.attempts.map((attempt) => attempt.state)).toEqual([
      'lost_fence',
      'succeeded'
    ]);
  });

  test('recovers an expired crash at a one-attempt policy limit without charging lost-fence evidence', async () => {
    const consumer = await consumerDefinition(
      'submission.activity',
      1,
      definitionRef('domain_fact', 'submission.created', 1),
      1
    );
    const initial = materializeConsumerDelivery(
      planConsumerFanout(pointer, [consumer], []).creations[0]!,
      parseConsumerDeliveryId('00000000-0000-4000-8000-000000000014')
    );
    const crashed = claimConsumerDelivery(initial, {
      attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000024'),
      ownerKey: 'worker-before-crash',
      now: instant('2026-08-11T00:00:01Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:05Z')
    });
    const winner = claimConsumerDelivery(crashed, {
      attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000025'),
      ownerKey: 'worker-after-crash',
      now: instant('2026-08-11T00:00:06Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:20Z')
    });
    const recovered = recordConsumerAttemptLostFence(
      winner,
      crashed.lease!.attemptId,
      instant('2026-08-11T00:00:06Z')
    );

    expect(Number(recovered.currentFence)).toBe(2);
    expect(recovered.attempts.map((attempt) => attempt.state)).toEqual([
      'lost_fence',
      'running'
    ]);
    expect(() => completeConsumerDelivery(
      recovered,
      crashed.currentFence!,
      instant('2026-08-11T00:00:07Z'),
      { kind: 'succeeded' }
    )).toThrow(/lost its lease fence/);
    expect(completeConsumerDelivery(
      recovered,
      winner.currentFence!,
      instant('2026-08-11T00:00:08Z'),
      { kind: 'succeeded' }
    ).state).toBe('succeeded');
  });
});

describe('job transitions', () => {
  test('names a verified inbox receipt as a distinct job source', async () => {
    const definition = await jobDefinition();
    const inboxSource = definitionRef('inbox_receipt', 'provider.event-received', 1);
    const initial = createJob({
      id: parseJobId('00000000-0000-4000-8000-000000000030'),
      definition,
      registeredIdempotencyIdentity: 'inbox-receipt:42',
      source: {
        definition: inboxSource,
        identity: parseOpaqueSourceIdentity('src1_inbox_receipt_42'),
        version: parseAggregateVersion(1)
      },
      inputRef: createPayloadRef(parsePayloadRefId('00000000-0000-4000-8000-000000000040')),
      availableAt: instant('2026-08-11T00:00:00Z')
    });

    expect(initial.source.definition).toEqual(inboxSource);
  });

  test('freezes the exact execution target and closes expired work pending reconciliation', async () => {
    const definition = await jobDefinition();
    const initial = createJob({
      id: parseJobId('00000000-0000-4000-8000-000000000031'),
      definition,
      registeredIdempotencyIdentity: 'message:submission:42',
      source: {
        definition: pointer.source,
        identity: pointer.sourceIdentity,
        version: pointer.sourceVersion
      },
      inputRef: createPayloadRef(parsePayloadRefId('00000000-0000-4000-8000-000000000041')),
      availableAt: instant('2026-08-11T00:00:00Z')
    });
    expect(initial.targetOperation).toEqual(definition.targetOperation);
    expect(initial.inputProjection).toEqual(definition.inputProjection);
    expect(initial.capabilityRevisionId).toBe(definition.capabilityRevisionId);
    expect(initial.authorityCitation).toEqual(definition.authorityCitation);

    const first = claimJob(initial, {
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000051'),
      ownerKey: 'job-worker-a',
      now: instant('2026-08-11T00:00:01Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:05Z')
    });
    expect(() => claimJob(first, {
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000052'),
      ownerKey: 'job-worker-b',
      now: instant('2026-08-11T00:00:06Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:20Z')
    })).toThrow(/anchor inspection/);
    expect(first.currentFence).toBe(first.lease!.fence);
    expect(first.attempts).toHaveLength(1);
  });

  test('rejects an ambiguous retry before reconciliation', async () => {
    const definition = await jobDefinition('message.dispatch', 1, 3);
    const initial = createJob({
      id: parseJobId('00000000-0000-4000-8000-000000000033'),
      definition,
      registeredIdempotencyIdentity: 'message:submission:44',
      source: {
        definition: pointer.source,
        identity: pointer.sourceIdentity,
        version: pointer.sourceVersion
      },
      inputRef: createPayloadRef(parsePayloadRefId('00000000-0000-4000-8000-000000000043')),
      availableAt: instant('2026-08-11T00:00:00Z')
    });
    const claimed = claimJob(initial, {
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000055'),
      ownerKey: 'external-job-worker-a',
      now: instant('2026-08-11T00:00:01Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:05Z')
    });

    expect(() => completeJob(
      claimed,
      claimed.currentFence!,
      instant('2026-08-11T00:00:02Z'),
      {
        kind: 'retry',
        retryAt: instant('2026-08-11T00:00:10Z'),
        failure: { code: 'provider_acceptance_unknown', classification: 'ambiguous' }
      }
    )).toThrow(/reconciliation/);
    expect(claimed.state).toBe('leased');
    expect(claimed.attempts[0]?.state).toBe('running');
  });

  test('does not turn a one-attempt external job crash into a blind retry', async () => {
    const definition = await jobDefinition('message.dispatch', 1, 1);
    const initial = createJob({
      id: parseJobId('00000000-0000-4000-8000-000000000032'),
      definition,
      registeredIdempotencyIdentity: 'message:submission:43',
      source: {
        definition: pointer.source,
        identity: pointer.sourceIdentity,
        version: pointer.sourceVersion
      },
      inputRef: createPayloadRef(parsePayloadRefId('00000000-0000-4000-8000-000000000042')),
      availableAt: instant('2026-08-11T00:00:00Z')
    });
    const crashed = claimJob(initial, {
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000053'),
      ownerKey: 'external-job-worker-a',
      now: instant('2026-08-11T00:00:01Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:05Z')
    });

    expect(() => claimJob(crashed, {
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000054'),
      ownerKey: 'external-job-worker-b',
      now: instant('2026-08-11T00:00:06Z'),
      leaseExpiresAt: instant('2026-08-11T00:00:20Z')
    })).toThrow(/anchor inspection/);
    expect(crashed.attempts).toHaveLength(1);
    expect(crashed.attempts[0]?.state).toBe('running');
  });
});
