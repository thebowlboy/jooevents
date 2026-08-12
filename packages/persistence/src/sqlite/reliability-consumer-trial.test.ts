import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  parseAggregateVersion,
  parseCapabilityRevisionId,
  parseConsumerAttemptId,
  parseConsumerDeliveryId,
  parseContractVersion,
  parseDomainFactId,
  parseEventId,
  parseInstant,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  definitionRef,
  parseDefinitionKey,
  parseLeaseFence,
  parseOpaqueSourceIdentity,
  parseOutboxPointerKey,
  schemaRef,
  sealReliabilityDefinition,
  type ConsumerDefinition,
  type ConsumerDeliveryDraft
} from '@jooevents/reliability';
import {
  SQLiteReliabilityConsumerTrial,
  installSQLiteReliabilityConsumerTrial,
  type ReliabilityConsumerTrialFaults
} from './reliability-consumer-trial';

const SCHEMA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SCHEMA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const workspaceId = parseWorkspaceId('00000000-0000-4000-8000-000000000001');
const eventId = parseEventId('00000000-0000-4000-8000-000000000002');
const factId = parseDomainFactId('00000000-0000-4000-8000-000000000003');
const pointerKey = parseOutboxPointerKey('ptr1_program-vocabulary-change-0001');
const sourceIdentity = parseOpaqueSourceIdentity('src1_program-vocabulary-change-0001');
const factRef = definitionRef('domain_fact', 'program.vocabulary.changed', 1);

const instant = (value: string) => parseInstant(value);

class TrialClock {
  current = instant('2026-08-11T00:00:00Z');

  now = () => this.current;

  set(value: string): void {
    this.current = instant(value);
  }
}

async function consumer(
  key: string,
  maximumAttempts = 2
): Promise<ConsumerDefinition> {
  return sealReliabilityDefinition({
    kind: 'consumer',
    key: parseDefinitionKey(key),
    version: parseContractVersion(1),
    acceptedSources: [factRef],
    inputSchema: schemaRef('schema.program.vocabulary.consumer.input', 1, SCHEMA_A),
    resultSchema: schemaRef('schema.program.vocabulary.consumer.result', 1, SCHEMA_B),
    inputProjection: definitionRef('input_projection', `${key}.input`, 1),
    targetOperation: definitionRef('operation', `${key}.project`, 1),
    capabilityRevisionId: parseCapabilityRevisionId(
      '00000000-0000-4000-8000-000000000010'
    ),
    authorityCitation: definitionRef(
      'authority_citation',
      'program.vocabulary.projection.authority',
      1
    ),
    maximumAttempts,
    leaseDurationMs: 30_000,
    backoff: definitionRef('backoff', 'bounded.exponential', 1),
    outputKind: 'projection',
    replay: definitionRef('replay', 'idempotent.receipt', 1),
    removal: definitionRef('removal', 'drain.then.remove', 1)
  });
}

function harness() {
  const sqlite = new Database(':memory:', { strict: true });
  installSQLiteReliabilityConsumerTrial(sqlite);
  const clock = new TrialClock();
  return {
    sqlite,
    clock,
    trial: new SQLiteReliabilityConsumerTrial(sqlite, clock)
  };
}

function appendPointer(
  trial: SQLiteReliabilityConsumerTrial,
  faults: ReliabilityConsumerTrialFaults = {}
) {
  return trial.appendFactBackedPointer({
    factId,
    sourceIdentity,
    pointerKey,
    fact: factRef,
    aggregateVersion: parseAggregateVersion(4),
    scope: { kind: 'event', workspaceId, eventId },
    occurredAt: instant('2026-08-11T00:00:00Z'),
    availableAt: instant('2026-08-11T00:00:00Z')
  }, faults);
}

const deliveryIds = {
  'program.vocabulary.counts': parseConsumerDeliveryId(
    '00000000-0000-4000-8000-000000000021'
  ),
  'program.vocabulary.search': parseConsumerDeliveryId(
    '00000000-0000-4000-8000-000000000022'
  )
} as const;

function deliveryIdFor(draft: ConsumerDeliveryDraft) {
  const id = deliveryIds[String(draft.consumer.key) as keyof typeof deliveryIds];
  if (id === undefined) throw new Error('unexpected consumer in trial fanout');
  return id;
}

function tableCount(sqlite: Database, table: string): number {
  return Number(
    sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? 0
  );
}

describe('disposable SQLite reliability consumer proof', () => {
  test('fans one fact pointer to exact consumer versions once and isolates success from failure/retry', async () => {
    const test = harness();
    const successful = await consumer('program.vocabulary.counts');
    const failing = await consumer('program.vocabulary.search');
    try {
      appendPointer(test.trial);
      const deliveries = test.trial.fanout({
        pointerKey,
        consumers: [failing, successful],
        deliveryIdFor
      });
      expect(deliveries.map((delivery) => `${delivery.consumer.key}@${delivery.consumer.version}`))
        .toEqual([
          'program.vocabulary.counts@1',
          'program.vocabulary.search@1'
        ]);
      expect(test.trial.fanout({
        pointerKey,
        consumers: [successful, failing],
        deliveryIdFor
      })).toHaveLength(2);
      expect(tableCount(test.sqlite, 'reliability_consumer_deliveries_trial')).toBe(2);

      test.clock.set('2026-08-11T00:00:01Z');
      const claimedSuccessful = test.trial.claim({
        deliveryId: deliveryIds['program.vocabulary.counts'],
        attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000031'),
        ownerKey: 'projection-worker-a'
      });
      test.clock.set('2026-08-11T00:00:02Z');
      const projected = test.trial.completeProjection({
        deliveryId: claimedSuccessful.id,
        fence: claimedSuccessful.currentFence!,
        projectionKey: 'program.vocabulary.count',
        projectedValue: 1
      });
      expect(projected.state).toBe('succeeded');
      expect(test.trial.readProjectionCount('program.vocabulary.count')).toBe(1);
      expect(test.trial.readDelivery(deliveryIds['program.vocabulary.search'])?.state).toBe(
        'pending'
      );

      test.clock.set('2026-08-11T00:00:03Z');
      const firstFailureClaim = test.trial.claim({
        deliveryId: deliveryIds['program.vocabulary.search'],
        attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000032'),
        ownerKey: 'projection-worker-b'
      });
      test.clock.set('2026-08-11T00:00:04Z');
      const retrying = test.trial.completeFailure({
        deliveryId: firstFailureClaim.id,
        fence: firstFailureClaim.currentFence!,
        completion: {
          kind: 'retry',
          retryAt: instant('2026-08-11T00:00:10Z'),
          failure: { code: 'projection_dependency_unavailable', classification: 'transient' }
        }
      });
      expect(retrying.state).toBe('retry_wait');
      expect(test.trial.readProjectionCount('program.vocabulary.count')).toBe(1);
      expect(test.trial.readDelivery(projected.id)).toEqual(projected);

      const restarted = new SQLiteReliabilityConsumerTrial(test.sqlite, test.clock);
      expect(restarted.fanout({
        pointerKey,
        consumers: [failing, successful],
        deliveryIdFor
      })).toHaveLength(2);
      expect(tableCount(test.sqlite, 'reliability_consumer_deliveries_trial')).toBe(2);

      test.clock.set('2026-08-11T00:00:11Z');
      const secondFailureClaim = restarted.claim({
        deliveryId: retrying.id,
        attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000033'),
        ownerKey: 'projection-worker-c'
      });
      test.clock.set('2026-08-11T00:00:12Z');
      const deadLettered = restarted.completeFailure({
        deliveryId: secondFailureClaim.id,
        fence: secondFailureClaim.currentFence!,
        completion: {
          kind: 'retry',
          retryAt: instant('2026-08-11T00:01:00Z'),
          failure: { code: 'projection_dependency_unavailable', classification: 'transient' }
        }
      });
      expect(deadLettered.state).toBe('dead_lettered');
      expect(restarted.readProjectionCount('program.vocabulary.count')).toBe(1);
      expect(restarted.listAttemptEvidence(projected.id)).toHaveLength(1);
      expect(restarted.listAttemptEvidence(deadLettered.id).map((attempt) =>
        attempt.completion?.state
      )).toEqual(['retry_scheduled', 'dead_lettered']);

      expect(restarted.readAttention({
        viewerKey: 'unrelated-viewer',
        mayView: () => false
      })).toEqual([]);
      const attention = restarted.readAttention({
        viewerKey: 'event-organizer',
        mayView: (_viewer, scope) => scope.eventId === eventId
      });
      expect(attention).toEqual([{
        kind: 'consumer_delivery_attention',
        anchorId: deadLettered.id,
        scope: { kind: 'event', workspaceId, eventId },
        consumer: definitionRef('consumer', 'program.vocabulary.search', 1),
        state: 'dead_lettered',
        failure: {
          code: 'projection_dependency_unavailable',
          classification: 'transient'
        },
        nextActionAt: null,
        availableAction: 'inspect_dead_letter'
      }]);
      const attentionText = JSON.stringify(attention);
      expect(attentionText).not.toContain('authority');
      expect(attentionText).not.toContain('capability');
      expect(attentionText).not.toContain('fence');
      expect(attentionText).not.toContain(sourceIdentity);

      expect(() => restarted.claim({
        deliveryId: projected.id,
        attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000034'),
        ownerKey: 'redelivery-worker'
      })).toThrow(/terminal consumer delivery/);
      expect(restarted.readProjectionCount('program.vocabulary.count')).toBe(1);
    } finally {
      test.sqlite.close();
    }
  });

  test('recovers an expired crash at maximumAttempts=1, fences takeover, and refuses stale completion', async () => {
    const test = harness();
    const definition = await consumer('program.vocabulary.counts', 1);
    try {
      appendPointer(test.trial);
      const delivery = test.trial.fanout({
        pointerKey,
        consumers: [definition],
        deliveryIdFor
      })[0]!;
      test.clock.set('2026-08-11T00:00:01Z');
      const first = test.trial.claim({
        deliveryId: delivery.id,
        attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000041'),
        ownerKey: 'worker-before-expiry'
      });
      test.clock.set('2026-08-11T00:00:32Z');
      const takeover = test.trial.claim({
        deliveryId: delivery.id,
        attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000042'),
        ownerKey: 'worker-after-expiry'
      });
      expect(Number(first.currentFence)).toBe(1);
      expect(Number(takeover.currentFence)).toBe(2);
      expect(test.trial.listAttemptEvidence(delivery.id).map((attempt) => ({
        fence: Number(attempt.fence),
        state: attempt.completion?.state ?? 'running'
      }))).toEqual([
        { fence: 1, state: 'lost_fence' },
        { fence: 2, state: 'running' }
      ]);

      expect(() => test.trial.completeProjection({
        deliveryId: delivery.id,
        fence: first.currentFence!,
        projectionKey: 'program.vocabulary.count',
        projectedValue: 1
      })).toThrow(/lost its lease fence/);
      expect(test.trial.readProjectionCount('program.vocabulary.count')).toBe(0);
      expect(Number(test.trial.readDelivery(delivery.id)?.currentFence)).toBe(2);

      test.clock.set('2026-08-11T00:00:33Z');
      const completed = test.trial.completeProjection({
        deliveryId: delivery.id,
        fence: takeover.currentFence!,
        projectionKey: 'program.vocabulary.count',
        projectedValue: 1
      });
      expect(completed.state).toBe('succeeded');
      expect(test.trial.listAttemptEvidence(delivery.id).map((attempt) =>
        attempt.completion?.state
      )).toEqual(['lost_fence', 'succeeded']);

      expect(() => test.sqlite.query(`
        UPDATE reliability_consumer_attempts_trial SET owner_key = 'rewritten'
        WHERE attempt_id = ?
      `).run('00000000-0000-4000-8000-000000000041')).toThrow(/immutable/);
      expect(() => test.sqlite.query(`
        DELETE FROM reliability_consumer_attempt_completions_trial
        WHERE attempt_id = ?
      `).run('00000000-0000-4000-8000-000000000041')).toThrow(/immutable/);
    } finally {
      test.sqlite.close();
    }
  });

  test('uses only its injected clock for claims, lease expiry, completion, and same-owner resume', async () => {
    const test = harness();
    const definition = await consumer('program.vocabulary.counts');
    try {
      appendPointer(test.trial);
      const delivery = test.trial.fanout({
        pointerKey,
        consumers: [definition],
        deliveryIdFor
      })[0]!;
      test.clock.set('2026-08-11T00:00:01Z');
      const forgedClaim = {
        deliveryId: delivery.id,
        attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000043'),
        ownerKey: 'clock-owned-worker',
        now: instant('2099-01-01T00:00:00Z'),
        leaseExpiresAt: instant('2099-01-02T00:00:00Z')
      };
      const claimed = test.trial.claim(forgedClaim);
      expect(claimed.lease).toMatchObject({
        attemptId: forgedClaim.attemptId,
        ownerKey: 'clock-owned-worker',
        expiresAt: instant('2026-08-11T00:00:31Z')
      });
      expect(claimed.attempts[0]?.startedAt).toBe(instant('2026-08-11T00:00:01Z'));

      const forgedResume = {
        deliveryId: delivery.id,
        attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000044'),
        ownerKey: 'clock-owned-worker',
        now: instant('2099-01-01T00:00:00Z'),
        leaseExpiresAt: instant('2099-01-02T00:00:00Z')
      };
      const resumed = test.trial.claim(forgedResume);
      expect(resumed).toEqual(claimed);
      expect(resumed.attempts).toHaveLength(1);

      test.clock.set('2026-08-11T00:00:02Z');
      const forgedCompletion = {
        deliveryId: delivery.id,
        fence: claimed.currentFence!,
        completedAt: instant('2099-01-03T00:00:00Z'),
        projectionKey: 'program.vocabulary.count',
        projectedValue: 1
      };
      const completed = test.trial.completeProjection(forgedCompletion);
      expect(completed.attempts[0]).toMatchObject({
        state: 'succeeded',
        completedAt: instant('2026-08-11T00:00:02Z')
      });
      expect(test.trial.listAttemptEvidence(delivery.id)[0]).toMatchObject({
        startedAt: instant('2026-08-11T00:00:01Z'),
        leaseExpiresAt: instant('2026-08-11T00:00:31Z'),
        completion: { completedAt: instant('2026-08-11T00:00:02Z') }
      });
    } finally {
      test.sqlite.close();
    }
  });

  test('rolls back injected crashes and converges after adapter restart without duplicate work', async () => {
    const test = harness();
    const successful = await consumer('program.vocabulary.counts');
    const failing = await consumer('program.vocabulary.search');
    try {
      expect(() => appendPointer(test.trial, {
        afterFactInserted() {
          throw new Error('injected:fact');
        }
      })).toThrow('injected:fact');
      expect(tableCount(test.sqlite, 'reliability_domain_facts_trial')).toBe(0);
      expect(tableCount(test.sqlite, 'reliability_outbox_pointers_trial')).toBe(0);

      appendPointer(test.trial);
      expect(() => test.trial.fanout({
        pointerKey,
        consumers: [successful, failing],
        deliveryIdFor,
        faults: {
          afterDeliveryInserted(count) {
            if (count === 1) throw new Error('injected:fanout');
          }
        }
      })).toThrow('injected:fanout');
      expect(tableCount(test.sqlite, 'reliability_consumer_deliveries_trial')).toBe(0);

      const restarted = new SQLiteReliabilityConsumerTrial(test.sqlite, test.clock);
      expect(restarted.fanout({
        pointerKey,
        consumers: [successful, failing],
        deliveryIdFor
      })).toHaveLength(2);

      const attemptId = parseConsumerAttemptId('00000000-0000-4000-8000-000000000051');
      test.clock.set('2026-08-11T00:00:01Z');
      expect(() => restarted.claim({
        deliveryId: deliveryIds['program.vocabulary.counts'],
        attemptId,
        ownerKey: 'crashing-claim-worker',
        faults: {
          afterAttemptInserted() {
            throw new Error('injected:claim');
          }
        }
      })).toThrow('injected:claim');
      expect(restarted.readDelivery(deliveryIds['program.vocabulary.counts'])?.state).toBe(
        'pending'
      );
      expect(restarted.listAttemptEvidence(deliveryIds['program.vocabulary.counts']))
        .toHaveLength(0);

      const claimed = restarted.claim({
        deliveryId: deliveryIds['program.vocabulary.counts'],
        attemptId,
        ownerKey: 'restarted-claim-worker'
      });
      test.clock.set('2026-08-11T00:00:02Z');
      expect(() => restarted.completeProjection({
        deliveryId: claimed.id,
        fence: claimed.currentFence!,
        projectionKey: 'program.vocabulary.count',
        projectedValue: 1,
        faults: {
          afterProjectionInserted() {
            throw new Error('injected:projection');
          }
        }
      })).toThrow('injected:projection');
      expect(restarted.readDelivery(claimed.id)?.state).toBe('leased');
      expect(restarted.readProjectionCount('program.vocabulary.count')).toBe(0);
      expect(tableCount(test.sqlite, 'reliability_consumer_attempt_completions_trial')).toBe(0);

      const afterSecondRestart = new SQLiteReliabilityConsumerTrial(test.sqlite, test.clock);
      const converged = afterSecondRestart.completeProjection({
        deliveryId: claimed.id,
        fence: claimed.currentFence!,
        projectionKey: 'program.vocabulary.count',
        projectedValue: 1
      });
      expect(converged.state).toBe('succeeded');
      expect(afterSecondRestart.readProjectionCount('program.vocabulary.count')).toBe(1);
      expect(afterSecondRestart.fanout({
        pointerKey,
        consumers: [successful, failing],
        deliveryIdFor
      })).toHaveLength(2);
      expect(tableCount(test.sqlite, 'reliability_consumer_deliveries_trial')).toBe(2);

      expect(() => test.sqlite.query(`
        INSERT INTO reliability_outbox_pointers_trial
          (pointer_key, source_fact_id, available_at_ms)
        VALUES (?, ?, ?)
      `).run('ptr1_orphan-source-0001', '00000000-0000-4000-8000-000000000099', 0))
        .toThrow(/foreign key/i);
      expect(() => test.sqlite.query(`
        UPDATE reliability_domain_facts_trial SET aggregate_version = 9
        WHERE fact_id = ?
      `).run(factId)).toThrow(/immutable/);
    } finally {
      test.sqlite.close();
    }
  });

  test('rejects malformed projection keys and stale caller-supplied fences before writes', async () => {
    const test = harness();
    const definition = await consumer('program.vocabulary.counts');
    try {
      appendPointer(test.trial);
      const delivery = test.trial.fanout({
        pointerKey,
        consumers: [definition],
        deliveryIdFor
      })[0]!;
      test.clock.set('2026-08-11T00:00:01Z');
      const claimed = test.trial.claim({
        deliveryId: delivery.id,
        attemptId: parseConsumerAttemptId('00000000-0000-4000-8000-000000000061'),
        ownerKey: 'projection-worker'
      });
      test.clock.set('2026-08-11T00:00:02Z');
      expect(() => test.trial.completeProjection({
        deliveryId: delivery.id,
        fence: parseLeaseFence(99),
        projectionKey: 'not safe',
        projectedValue: 1
      })).toThrow(/projection key/);
      expect(() => test.trial.completeProjection({
        deliveryId: delivery.id,
        fence: parseLeaseFence(99),
        projectionKey: 'program.vocabulary.count',
        projectedValue: 1
      })).toThrow(/lost its lease fence/);
      expect(test.trial.readProjectionCount('program.vocabulary.count')).toBe(0);
      expect(test.trial.readDelivery(delivery.id)).toEqual(claimed);
    } finally {
      test.sqlite.close();
    }
  });
});
