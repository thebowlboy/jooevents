import type { Database, SQLQueryBindings } from 'bun:sqlite';
import {
  parseAggregateVersion,
  parseCapabilityRevisionId,
  parseConsumerAttemptId,
  parseConsumerDeliveryId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type AggregateVersion,
  type ConsumerAttemptId,
  type ConsumerDeliveryId,
  type Clock,
  type DomainFactId,
  type EventScopeRef,
  type Instant
} from '@jooevents/kernel';
import {
  assertSafeCode,
  claimConsumerDelivery,
  completeConsumerDelivery,
  definitionRef,
  materializeConsumerDelivery,
  parseAttemptNumber,
  parseCanonicalSha256,
  parseDefinitionKey,
  parseLeaseFence,
  parseOpaqueSourceIdentity,
  parseOutboxPointerKey,
  planConsumerFanout,
  recordConsumerAttemptLostFence,
  type ConsumerDelivery,
  type ConsumerDeliveryAttemptFinished,
  type ConsumerDeliveryAttemptRunning,
  type ConsumerDeliveryCompletion,
  type ConsumerDeliveryDraft,
  type ConsumerDeliverySemanticKey,
  type ConsumerDefinition,
  type DefinitionRef,
  type OpaqueSourceIdentity,
  type OutboxPointerKey,
  type OutboxPointerRef,
  type SafeFailure
} from '@jooevents/reliability';

type TrialDeliveryState = ConsumerDelivery['state'];
type FailureCompletion = Extract<
  ConsumerDeliveryCompletion,
  { readonly kind: 'retry' | 'dead_lettered' }
>;

interface PointerRow {
  readonly pointer_key: string;
  readonly source_identity: string;
  readonly definition_key: string;
  readonly definition_version: number;
  readonly aggregate_version: number;
  readonly available_at_ms: number;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly semantic_key: string;
  readonly pointer_key: string;
  readonly consumer_key: string;
  readonly consumer_version: number;
  readonly definition_digest_sha256: string;
  readonly target_operation_key: string;
  readonly target_operation_version: number;
  readonly input_projection_key: string;
  readonly input_projection_version: number;
  readonly capability_revision_id: string;
  readonly authority_citation_key: string;
  readonly authority_citation_version: number;
  readonly maximum_attempts: number;
  readonly lease_duration_ms: number;
  readonly state: TrialDeliveryState;
  readonly version: number;
  readonly current_fence: number | null;
  readonly lease_owner_key: string | null;
  readonly lease_attempt_id: string | null;
  readonly lease_expires_at_ms: number | null;
  readonly next_action_at_ms: number | null;
}

interface AttemptRow {
  readonly delivery_id: string;
  readonly attempt_id: string;
  readonly attempt_number: number;
  readonly fence: number;
  readonly owner_key: string;
  readonly started_at_ms: number;
  readonly lease_expires_at_ms: number;
  readonly completion_state: ConsumerDeliveryAttemptFinished['state'] | null;
  readonly completed_at_ms: number | null;
  readonly failure_code: string | null;
  readonly failure_classification: SafeFailure['classification'] | null;
}

interface AttentionRow {
  readonly delivery_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly consumer_key: string;
  readonly consumer_version: number;
  readonly state: 'retry_wait' | 'dead_lettered';
  readonly next_action_at_ms: number | null;
  readonly failure_code: string;
  readonly failure_classification: SafeFailure['classification'];
}

export interface AppendFactBackedPointerInput {
  readonly factId: DomainFactId;
  readonly sourceIdentity: OpaqueSourceIdentity;
  readonly pointerKey: OutboxPointerKey;
  readonly fact: DefinitionRef<'domain_fact'>;
  readonly aggregateVersion: AggregateVersion;
  readonly scope: EventScopeRef;
  readonly occurredAt: Instant;
  readonly availableAt: Instant;
}

export interface ReliabilityConsumerTrialFaults {
  readonly afterFactInserted?: () => void;
  readonly afterDeliveryInserted?: (insertedCount: number) => void;
  readonly afterAttemptInserted?: () => void;
  readonly afterProjectionInserted?: () => void;
  readonly afterCompletionInserted?: () => void;
}

export interface FanoutReliabilityConsumerTrialInput {
  readonly pointerKey: OutboxPointerKey;
  readonly consumers: readonly ConsumerDefinition[];
  readonly deliveryIdFor: (
    draft: ConsumerDeliveryDraft,
    creationIndex: number
  ) => ConsumerDeliveryId;
  readonly faults?: ReliabilityConsumerTrialFaults;
}

export interface ClaimReliabilityConsumerTrialInput {
  readonly deliveryId: ConsumerDeliveryId;
  readonly attemptId: ConsumerAttemptId;
  readonly ownerKey: string;
  readonly faults?: ReliabilityConsumerTrialFaults;
}

export interface CompleteProjectionTrialInput {
  readonly deliveryId: ConsumerDeliveryId;
  readonly fence: ReturnType<typeof parseLeaseFence>;
  readonly projectionKey: string;
  readonly projectedValue: number;
  readonly faults?: ReliabilityConsumerTrialFaults;
}

export interface CompleteOperationTrialInput {
  readonly deliveryId: ConsumerDeliveryId;
  readonly fence: ReturnType<typeof parseLeaseFence>;
  readonly faults?: ReliabilityConsumerTrialFaults;
}

export interface CompleteFailureTrialInput {
  readonly deliveryId: ConsumerDeliveryId;
  readonly fence: ReturnType<typeof parseLeaseFence>;
  readonly completion: FailureCompletion;
  readonly faults?: ReliabilityConsumerTrialFaults;
}

export interface ReliabilityTrialAttemptEvidence {
  readonly deliveryId: ConsumerDeliveryId;
  readonly attemptId: ConsumerAttemptId;
  readonly number: ReturnType<typeof parseAttemptNumber>;
  readonly fence: ReturnType<typeof parseLeaseFence>;
  readonly ownerKey: string;
  readonly startedAt: Instant;
  readonly leaseExpiresAt: Instant;
  readonly completion:
    | {
        readonly state: ConsumerDeliveryAttemptFinished['state'];
        readonly completedAt: Instant;
        readonly failure: SafeFailure | null;
      }
    | null;
}

export interface ReliabilityTrialAttentionItem {
  readonly kind: 'consumer_delivery_attention';
  readonly anchorId: ConsumerDeliveryId;
  readonly scope: EventScopeRef;
  readonly consumer: DefinitionRef<'consumer'>;
  readonly state: 'retry_wait' | 'dead_lettered';
  readonly failure: SafeFailure;
  readonly nextActionAt: Instant | null;
  readonly availableAction: 'await_retry' | 'inspect_dead_letter';
}

export class SQLiteReliabilityTrialError extends Error {
  constructor(
    readonly code:
      | 'pointer_not_found'
      | 'delivery_not_found'
      | 'concurrent_transition'
      | 'invalid_projection',
    message: string
  ) {
    super(message);
    this.name = 'SQLiteReliabilityTrialError';
  }
}

function run(sqlite: Database, sql: string, ...bindings: SQLQueryBindings[]) {
  return sqlite.query(sql).run(...bindings);
}

function instantMilliseconds(value: Instant): number {
  return Date.parse(parseInstant(value));
}

function instantFromMilliseconds(value: number): Instant {
  if (!Number.isSafeInteger(value)) throw new TypeError('stored instant must be epoch milliseconds');
  return parseInstant(new Date(value).toISOString());
}

function leaseExpiry(now: Instant, durationMs: number): Instant {
  const expiresAtMs = Date.parse(now) + durationMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new TypeError('consumer lease expiry must be a safe epoch millisecond');
  }
  return parseInstant(new Date(expiresAtMs).toISOString());
}

function immutableTrigger(sqlite: Database, table: string): void {
  sqlite.exec(`
    CREATE TRIGGER ${table}_reject_update
    BEFORE UPDATE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${table}_immutable');
    END;

    CREATE TRIGGER ${table}_reject_delete
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${table}_immutable');
    END;
  `);
}

/** Installs an isolated reliability schema into a caller-owned disposable database. */
export function installSQLiteReliabilityConsumerTrial(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(`
    CREATE TABLE reliability_domain_facts_trial (
      fact_id TEXT PRIMARY KEY,
      source_identity TEXT NOT NULL UNIQUE,
      definition_key TEXT NOT NULL,
      definition_version INTEGER NOT NULL CHECK (definition_version > 0),
      aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      UNIQUE (definition_key, definition_version, source_identity)
    ) STRICT;

    CREATE TABLE reliability_outbox_pointers_trial (
      pointer_key TEXT PRIMARY KEY,
      source_fact_id TEXT NOT NULL UNIQUE,
      available_at_ms INTEGER NOT NULL,
      FOREIGN KEY (source_fact_id)
        REFERENCES reliability_domain_facts_trial(fact_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE reliability_consumer_deliveries_trial (
      delivery_id TEXT PRIMARY KEY,
      semantic_key TEXT NOT NULL UNIQUE,
      pointer_key TEXT NOT NULL,
      consumer_key TEXT NOT NULL,
      consumer_version INTEGER NOT NULL CHECK (consumer_version > 0),
      definition_digest_sha256 TEXT NOT NULL
        CHECK (length(definition_digest_sha256) = 64
          AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      target_operation_key TEXT NOT NULL,
      target_operation_version INTEGER NOT NULL CHECK (target_operation_version > 0),
      input_projection_key TEXT NOT NULL,
      input_projection_version INTEGER NOT NULL CHECK (input_projection_version > 0),
      capability_revision_id TEXT NOT NULL,
      authority_citation_key TEXT NOT NULL,
      authority_citation_version INTEGER NOT NULL CHECK (authority_citation_version > 0),
      maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts > 0),
      lease_duration_ms INTEGER NOT NULL CHECK (lease_duration_ms > 0),
      state TEXT NOT NULL
        CHECK (state IN ('pending', 'leased', 'retry_wait', 'succeeded', 'dead_lettered', 'cancelled')),
      version INTEGER NOT NULL CHECK (version > 0),
      current_fence INTEGER CHECK (current_fence IS NULL OR current_fence > 0),
      lease_owner_key TEXT,
      lease_attempt_id TEXT,
      lease_expires_at_ms INTEGER,
      next_action_at_ms INTEGER,
      FOREIGN KEY (pointer_key)
        REFERENCES reliability_outbox_pointers_trial(pointer_key)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      UNIQUE (pointer_key, consumer_key, consumer_version),
      CHECK (
        (state = 'leased'
          AND current_fence IS NOT NULL
          AND lease_owner_key IS NOT NULL
          AND lease_attempt_id IS NOT NULL
          AND lease_expires_at_ms IS NOT NULL
          AND next_action_at_ms IS NULL)
        OR
        (state <> 'leased'
          AND lease_owner_key IS NULL
          AND lease_attempt_id IS NULL
          AND lease_expires_at_ms IS NULL)
      ),
      CHECK (
        (state IN ('pending', 'retry_wait') AND next_action_at_ms IS NOT NULL)
        OR
        (state IN ('leased', 'succeeded', 'dead_lettered', 'cancelled')
          AND next_action_at_ms IS NULL)
      )
    ) STRICT;

    CREATE TABLE reliability_consumer_attempts_trial (
      delivery_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      fence INTEGER NOT NULL CHECK (fence > 0),
      owner_key TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms > started_at_ms),
      PRIMARY KEY (delivery_id, attempt_id),
      UNIQUE (attempt_id),
      UNIQUE (delivery_id, attempt_number),
      UNIQUE (delivery_id, fence),
      FOREIGN KEY (delivery_id)
        REFERENCES reliability_consumer_deliveries_trial(delivery_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE reliability_consumer_attempt_completions_trial (
      delivery_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      completion_state TEXT NOT NULL
        CHECK (completion_state IN ('succeeded', 'retry_scheduled', 'dead_lettered', 'cancelled', 'lost_fence')),
      completed_at_ms INTEGER NOT NULL,
      failure_code TEXT,
      failure_classification TEXT
        CHECK (failure_classification IS NULL OR failure_classification IN ('transient', 'permanent', 'ambiguous')),
      PRIMARY KEY (delivery_id, attempt_id),
      FOREIGN KEY (delivery_id, attempt_id)
        REFERENCES reliability_consumer_attempts_trial(delivery_id, attempt_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      CHECK (
        (completion_state IN ('retry_scheduled', 'dead_lettered')
          AND failure_code IS NOT NULL AND failure_classification IS NOT NULL)
        OR
        (completion_state IN ('succeeded', 'cancelled', 'lost_fence')
          AND failure_code IS NULL AND failure_classification IS NULL)
      )
    ) STRICT;

    CREATE TABLE reliability_projection_results_trial (
      delivery_id TEXT PRIMARY KEY,
      projection_key TEXT NOT NULL,
      projected_value INTEGER NOT NULL,
      applied_at_ms INTEGER NOT NULL,
      FOREIGN KEY (delivery_id)
        REFERENCES reliability_consumer_deliveries_trial(delivery_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE INDEX reliability_deliveries_due_trial
      ON reliability_consumer_deliveries_trial(state, next_action_at_ms, delivery_id);
    CREATE INDEX reliability_deliveries_pointer_trial
      ON reliability_consumer_deliveries_trial(pointer_key, consumer_key, consumer_version);
    CREATE INDEX reliability_attempts_delivery_trial
      ON reliability_consumer_attempts_trial(delivery_id, attempt_number);
  `);

  for (const table of [
    'reliability_domain_facts_trial',
    'reliability_outbox_pointers_trial',
    'reliability_consumer_attempts_trial',
    'reliability_consumer_attempt_completions_trial',
    'reliability_projection_results_trial'
  ]) {
    immutableTrigger(sqlite, table);
  }
}

function pointerFromRow(row: PointerRow): OutboxPointerRef {
  return Object.freeze({
    key: parseOutboxPointerKey(row.pointer_key),
    source: definitionRef(
      'domain_fact',
      String(parseDefinitionKey(row.definition_key)),
      Number(parseContractVersion(row.definition_version))
    ),
    sourceIdentity: parseOpaqueSourceIdentity(row.source_identity),
    sourceVersion: parseAggregateVersion(row.aggregate_version),
    availableAt: instantFromMilliseconds(row.available_at_ms)
  });
}

function failureFromRow(row: AttemptRow): SafeFailure | null {
  if (row.failure_code === null || row.failure_classification === null) return null;
  assertSafeCode(row.failure_code, 'stored consumer failure code');
  return Object.freeze({
    code: row.failure_code,
    classification: row.failure_classification
  });
}

function attemptFromRow(
  row: AttemptRow
): ConsumerDeliveryAttemptRunning | ConsumerDeliveryAttemptFinished {
  const base = {
    id: parseConsumerAttemptId(row.attempt_id),
    number: parseAttemptNumber(row.attempt_number),
    fence: parseLeaseFence(row.fence),
    startedAt: instantFromMilliseconds(row.started_at_ms)
  };
  if (row.completion_state === null) {
    return Object.freeze({ ...base, state: 'running' });
  }
  if (row.completed_at_ms === null) {
    throw new TypeError('finished consumer attempt is missing completion time');
  }
  return Object.freeze({
    ...base,
    state: row.completion_state,
    completedAt: instantFromMilliseconds(row.completed_at_ms),
    failure: failureFromRow(row)
  });
}

function assertProjectionKey(value: string): void {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new SQLiteReliabilityTrialError(
      'invalid_projection',
      'projection key must be a bounded safe code'
    );
  }
}

export class SQLiteReliabilityConsumerTrial {
  private readonly readClock: () => Instant;

  constructor(
    private readonly sqlite: Database,
    clock: Clock
  ) {
    if (typeof clock?.now !== 'function') {
      throw new TypeError('reliability execution requires a clock');
    }
    this.readClock = clock.now.bind(clock);
  }

  private now(): Instant {
    return parseInstant(this.readClock());
  }

  appendFactBackedPointer(
    input: AppendFactBackedPointerInput,
    faults: ReliabilityConsumerTrialFaults = {}
  ): OutboxPointerRef {
    const occurredAtMs = instantMilliseconds(input.occurredAt);
    const availableAtMs = instantMilliseconds(input.availableAt);
    if (availableAtMs < occurredAtMs) {
      throw new TypeError('outbox pointer cannot become available before its source fact');
    }
    return this.sqlite.transaction(() => {
      run(
        this.sqlite,
        `INSERT INTO reliability_domain_facts_trial
          (fact_id, source_identity, definition_key, definition_version, aggregate_version,
           workspace_id, event_id, occurred_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.factId,
        input.sourceIdentity,
        input.fact.key,
        input.fact.version,
        input.aggregateVersion,
        input.scope.workspaceId,
        input.scope.eventId,
        occurredAtMs
      );
      faults.afterFactInserted?.();
      run(
        this.sqlite,
        `INSERT INTO reliability_outbox_pointers_trial
          (pointer_key, source_fact_id, available_at_ms)
         VALUES (?, ?, ?)`,
        input.pointerKey,
        input.factId,
        availableAtMs
      );
      return this.requirePointer(input.pointerKey);
    })();
  }

  fanout(input: FanoutReliabilityConsumerTrialInput): readonly ConsumerDelivery[] {
    return this.sqlite.transaction(() => {
      const pointer = this.requirePointer(input.pointerKey);
      const existing = this.listDeliveriesForPointer(input.pointerKey);
      const plan = planConsumerFanout(pointer, input.consumers, existing);
      let insertedCount = 0;
      for (const [creationIndex, draft] of plan.creations.entries()) {
        const delivery = materializeConsumerDelivery(
          draft,
          input.deliveryIdFor(draft, creationIndex)
        );
        this.insertDelivery(delivery);
        insertedCount += 1;
        input.faults?.afterDeliveryInserted?.(insertedCount);
      }
      return this.listDeliveriesForPointer(input.pointerKey);
    })();
  }

  claim(input: ClaimReliabilityConsumerTrialInput): ConsumerDelivery {
    return this.sqlite.transaction(() => {
      const current = this.requireDelivery(input.deliveryId);
      const now = this.now();
      if (
        current.state === 'leased'
        && current.lease !== null
        && current.lease.ownerKey === input.ownerKey
        && current.lease.expiresAt > now
      ) {
        return current;
      }
      const claimed = claimConsumerDelivery(current, {
        attemptId: input.attemptId,
        ownerKey: input.ownerKey,
        now,
        leaseExpiresAt: leaseExpiry(now, current.leaseDurationMs)
      });
      const newAttempt = claimed.attempts.at(-1);
      if (newAttempt === undefined || newAttempt.state !== 'running' || claimed.lease === null) {
        throw new TypeError('consumer claim reducer did not append a running attempt');
      }
      run(
        this.sqlite,
        `INSERT INTO reliability_consumer_attempts_trial
          (delivery_id, attempt_id, attempt_number, fence, owner_key, started_at_ms,
           lease_expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        claimed.id,
        newAttempt.id,
        newAttempt.number,
        newAttempt.fence,
        input.ownerKey,
        instantMilliseconds(newAttempt.startedAt),
        instantMilliseconds(claimed.lease.expiresAt)
      );
      input.faults?.afterAttemptInserted?.();

      let next = claimed;
      if (current.state === 'leased' && current.lease !== null) {
        next = recordConsumerAttemptLostFence(claimed, current.lease.attemptId, now);
        const lostAttempt = next.attempts.find(
          (attempt) => attempt.id === current.lease?.attemptId
        );
        if (lostAttempt === undefined || lostAttempt.state !== 'lost_fence') {
          throw new TypeError('consumer takeover did not produce lost-fence evidence');
        }
        this.insertAttemptCompletion(next.id, lostAttempt);
        input.faults?.afterCompletionInserted?.();
      }
      this.updateDelivery(current, next);
      return next;
    })();
  }

  completeProjection(input: CompleteProjectionTrialInput): ConsumerDelivery {
    assertProjectionKey(input.projectionKey);
    if (!Number.isSafeInteger(input.projectedValue)) {
      throw new SQLiteReliabilityTrialError(
        'invalid_projection',
        'projected value must be a safe integer'
      );
    }
    return this.sqlite.transaction(() => {
      const current = this.requireDelivery(input.deliveryId);
      const completedAt = this.now();
      const next = completeConsumerDelivery(current, input.fence, completedAt, {
        kind: 'succeeded'
      });
      run(
        this.sqlite,
        `INSERT INTO reliability_projection_results_trial
          (delivery_id, projection_key, projected_value, applied_at_ms)
         VALUES (?, ?, ?, ?)`,
        current.id,
        input.projectionKey,
        input.projectedValue,
        instantMilliseconds(completedAt)
      );
      input.faults?.afterProjectionInserted?.();
      this.insertActiveAttemptCompletion(current, next);
      input.faults?.afterCompletionInserted?.();
      this.updateDelivery(current, next);
      return next;
    })();
  }

  /** Completes an application-operation consumer under its current fence. */
  completeOperation(input: CompleteOperationTrialInput): ConsumerDelivery {
    const transition = () => {
      const current = this.requireDelivery(input.deliveryId);
      const next = completeConsumerDelivery(current, input.fence, this.now(), {
        kind: 'succeeded'
      });
      this.insertActiveAttemptCompletion(current, next);
      input.faults?.afterCompletionInserted?.();
      this.updateDelivery(current, next);
      return next;
    };
    return this.sqlite.inTransaction
      ? transition()
      : this.sqlite.transaction(transition)();
  }

  completeFailure(input: CompleteFailureTrialInput): ConsumerDelivery {
    return this.sqlite.transaction(() => {
      const current = this.requireDelivery(input.deliveryId);
      const next = completeConsumerDelivery(
        current,
        input.fence,
        this.now(),
        input.completion
      );
      this.insertActiveAttemptCompletion(current, next);
      input.faults?.afterCompletionInserted?.();
      this.updateDelivery(current, next);
      return next;
    })();
  }

  readDelivery(deliveryId: ConsumerDeliveryId): ConsumerDelivery | null {
    const row = this.sqlite.query<DeliveryRow, [string]>(`
      SELECT * FROM reliability_consumer_deliveries_trial WHERE delivery_id = ?
    `).get(deliveryId);
    return row === null ? null : this.deliveryFromRow(row);
  }

  listDeliveries(pointerKey?: OutboxPointerKey): readonly ConsumerDelivery[] {
    if (pointerKey !== undefined) return this.listDeliveriesForPointer(pointerKey);
    const rows = this.sqlite.query<DeliveryRow, []>(`
      SELECT * FROM reliability_consumer_deliveries_trial
      ORDER BY pointer_key, consumer_key, consumer_version, delivery_id
    `).all();
    return Object.freeze(rows.map((row) => this.deliveryFromRow(row)));
  }

  listAttemptEvidence(deliveryId: ConsumerDeliveryId): readonly ReliabilityTrialAttemptEvidence[] {
    const rows = this.attemptRows(deliveryId);
    return Object.freeze(rows.map((row) => {
      const failure = failureFromRow(row);
      return Object.freeze({
        deliveryId: parseConsumerDeliveryId(row.delivery_id),
        attemptId: parseConsumerAttemptId(row.attempt_id),
        number: parseAttemptNumber(row.attempt_number),
        fence: parseLeaseFence(row.fence),
        ownerKey: row.owner_key,
        startedAt: instantFromMilliseconds(row.started_at_ms),
        leaseExpiresAt: instantFromMilliseconds(row.lease_expires_at_ms),
        completion: row.completion_state === null || row.completed_at_ms === null
          ? null
          : Object.freeze({
              state: row.completion_state,
              completedAt: instantFromMilliseconds(row.completed_at_ms),
              failure
            })
      });
    }));
  }

  readProjectionCount(projectionKey: string): number {
    assertProjectionKey(projectionKey);
    const row = this.sqlite.query<{ total: number }, [string]>(`
      SELECT coalesce(sum(projected_value), 0) AS total
      FROM reliability_projection_results_trial
      WHERE projection_key = ?
    `).get(projectionKey);
    return Number(row?.total ?? 0);
  }

  readAttention(input: {
    readonly viewerKey: string;
    readonly mayView: (viewerKey: string, scope: EventScopeRef) => boolean;
  }): readonly ReliabilityTrialAttentionItem[] {
    if (
      input.viewerKey.length === 0 ||
      input.viewerKey.length > 160 ||
      input.viewerKey.trim() !== input.viewerKey
    ) {
      throw new TypeError('attention viewer key must be bounded and non-empty');
    }
    const rows = this.sqlite.query<AttentionRow, []>(`
      SELECT d.delivery_id, f.workspace_id, f.event_id,
             d.consumer_key, d.consumer_version, d.state, d.next_action_at_ms,
             c.failure_code, c.failure_classification
      FROM reliability_consumer_deliveries_trial d
      JOIN reliability_outbox_pointers_trial p ON p.pointer_key = d.pointer_key
      JOIN reliability_domain_facts_trial f ON f.fact_id = p.source_fact_id
      JOIN reliability_consumer_attempts_trial a
        ON a.delivery_id = d.delivery_id
       AND a.attempt_number = (
         SELECT max(latest.attempt_number)
         FROM reliability_consumer_attempts_trial latest
         WHERE latest.delivery_id = d.delivery_id
       )
      JOIN reliability_consumer_attempt_completions_trial c
        ON c.delivery_id = a.delivery_id AND c.attempt_id = a.attempt_id
      WHERE d.state IN ('retry_wait', 'dead_lettered')
        AND c.failure_code IS NOT NULL
        AND c.failure_classification IS NOT NULL
      ORDER BY f.workspace_id, f.event_id, d.consumer_key, d.consumer_version, d.delivery_id
    `).all();

    const attention: ReliabilityTrialAttentionItem[] = [];
    for (const row of rows) {
      const scope: EventScopeRef = Object.freeze({
        kind: 'event',
        workspaceId: parseWorkspaceId(row.workspace_id),
        eventId: parseEventId(row.event_id)
      });
      if (!input.mayView(input.viewerKey, scope)) continue;
      assertSafeCode(row.failure_code, 'stored attention failure code');
      attention.push(Object.freeze({
        kind: 'consumer_delivery_attention',
        anchorId: parseConsumerDeliveryId(row.delivery_id),
        scope,
        consumer: definitionRef(
          'consumer',
          String(parseDefinitionKey(row.consumer_key)),
          Number(parseContractVersion(row.consumer_version))
        ),
        state: row.state,
        failure: Object.freeze({
          code: row.failure_code,
          classification: row.failure_classification
        }),
        nextActionAt: row.next_action_at_ms === null
          ? null
          : instantFromMilliseconds(row.next_action_at_ms),
        availableAction: row.state === 'retry_wait' ? 'await_retry' : 'inspect_dead_letter'
      }));
    }
    return Object.freeze(attention);
  }

  private requirePointer(pointerKey: OutboxPointerKey): OutboxPointerRef {
    const row = this.sqlite.query<PointerRow, [string]>(`
      SELECT p.pointer_key, f.source_identity, f.definition_key, f.definition_version,
             f.aggregate_version, p.available_at_ms
      FROM reliability_outbox_pointers_trial p
      JOIN reliability_domain_facts_trial f ON f.fact_id = p.source_fact_id
      WHERE p.pointer_key = ?
    `).get(pointerKey);
    if (row === null) {
      throw new SQLiteReliabilityTrialError('pointer_not_found', 'outbox pointer was not found');
    }
    return pointerFromRow(row);
  }

  private requireDelivery(deliveryId: ConsumerDeliveryId): ConsumerDelivery {
    const delivery = this.readDelivery(deliveryId);
    if (delivery === null) {
      throw new SQLiteReliabilityTrialError('delivery_not_found', 'consumer delivery was not found');
    }
    return delivery;
  }

  private listDeliveriesForPointer(pointerKey: OutboxPointerKey): readonly ConsumerDelivery[] {
    const rows = this.sqlite.query<DeliveryRow, [string]>(`
      SELECT * FROM reliability_consumer_deliveries_trial
      WHERE pointer_key = ?
      ORDER BY consumer_key, consumer_version, delivery_id
    `).all(pointerKey);
    return Object.freeze(rows.map((row) => this.deliveryFromRow(row)));
  }

  private attemptRows(deliveryId: ConsumerDeliveryId): readonly AttemptRow[] {
    return this.sqlite.query<AttemptRow, [string]>(`
      SELECT a.delivery_id, a.attempt_id, a.attempt_number, a.fence,
             a.owner_key, a.started_at_ms, a.lease_expires_at_ms,
             c.completion_state, c.completed_at_ms, c.failure_code,
             c.failure_classification
      FROM reliability_consumer_attempts_trial a
      LEFT JOIN reliability_consumer_attempt_completions_trial c
        ON c.delivery_id = a.delivery_id AND c.attempt_id = a.attempt_id
      WHERE a.delivery_id = ?
      ORDER BY a.attempt_number
    `).all(deliveryId);
  }

  private deliveryFromRow(row: DeliveryRow): ConsumerDelivery {
    const pointer = this.requirePointer(parseOutboxPointerKey(row.pointer_key));
    const currentFence = row.current_fence === null ? null : parseLeaseFence(row.current_fence);
    const lease = row.state === 'leased'
      ? Object.freeze({
          fence: parseLeaseFence(row.current_fence),
          ownerKey: String(row.lease_owner_key),
          attemptId: parseConsumerAttemptId(row.lease_attempt_id),
          expiresAt: instantFromMilliseconds(Number(row.lease_expires_at_ms))
        })
      : null;
    const attempts = Object.freeze(
      this.attemptRows(parseConsumerDeliveryId(row.delivery_id)).map(attemptFromRow)
    );
    return Object.freeze({
      id: parseConsumerDeliveryId(row.delivery_id),
      semanticKey: row.semantic_key as ConsumerDeliverySemanticKey,
      pointer,
      consumer: definitionRef(
        'consumer',
        String(parseDefinitionKey(row.consumer_key)),
        Number(parseContractVersion(row.consumer_version))
      ),
      definitionDigestSha256: parseCanonicalSha256(row.definition_digest_sha256),
      targetOperation: definitionRef(
        'operation',
        String(parseDefinitionKey(row.target_operation_key)),
        Number(parseContractVersion(row.target_operation_version))
      ),
      inputProjection: definitionRef(
        'input_projection',
        String(parseDefinitionKey(row.input_projection_key)),
        Number(parseContractVersion(row.input_projection_version))
      ),
      capabilityRevisionId: parseCapabilityRevisionId(row.capability_revision_id),
      authorityCitation: definitionRef(
        'authority_citation',
        String(parseDefinitionKey(row.authority_citation_key)),
        Number(parseContractVersion(row.authority_citation_version))
      ),
      maximumAttempts: row.maximum_attempts,
      leaseDurationMs: row.lease_duration_ms,
      state: row.state,
      version: parseAggregateVersion(row.version),
      currentFence,
      lease,
      nextActionAt: row.next_action_at_ms === null
        ? null
        : instantFromMilliseconds(row.next_action_at_ms),
      attempts
    });
  }

  private insertDelivery(delivery: ConsumerDelivery): void {
    run(
      this.sqlite,
      `INSERT INTO reliability_consumer_deliveries_trial
        (delivery_id, semantic_key, pointer_key, consumer_key, consumer_version,
         definition_digest_sha256, target_operation_key, target_operation_version,
         input_projection_key, input_projection_version, capability_revision_id,
         authority_citation_key, authority_citation_version, maximum_attempts,
         lease_duration_ms, state, version, current_fence, lease_owner_key,
         lease_attempt_id, lease_expires_at_ms, next_action_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      delivery.id,
      delivery.semanticKey,
      delivery.pointer.key,
      delivery.consumer.key,
      delivery.consumer.version,
      delivery.definitionDigestSha256,
      delivery.targetOperation.key,
      delivery.targetOperation.version,
      delivery.inputProjection.key,
      delivery.inputProjection.version,
      delivery.capabilityRevisionId,
      delivery.authorityCitation.key,
      delivery.authorityCitation.version,
      delivery.maximumAttempts,
      delivery.leaseDurationMs,
      delivery.state,
      delivery.version,
      delivery.currentFence,
      delivery.lease?.ownerKey ?? null,
      delivery.lease?.attemptId ?? null,
      delivery.lease === null ? null : instantMilliseconds(delivery.lease.expiresAt),
      delivery.nextActionAt === null ? null : instantMilliseconds(delivery.nextActionAt)
    );
  }

  private updateDelivery(previous: ConsumerDelivery, next: ConsumerDelivery): void {
    const result = run(
      this.sqlite,
      `UPDATE reliability_consumer_deliveries_trial
       SET state = ?, version = ?, current_fence = ?, lease_owner_key = ?,
           lease_attempt_id = ?, lease_expires_at_ms = ?, next_action_at_ms = ?
       WHERE delivery_id = ? AND version = ? AND state = ?
         AND current_fence IS ? AND lease_attempt_id IS ?`,
      next.state,
      next.version,
      next.currentFence,
      next.lease?.ownerKey ?? null,
      next.lease?.attemptId ?? null,
      next.lease === null ? null : instantMilliseconds(next.lease.expiresAt),
      next.nextActionAt === null ? null : instantMilliseconds(next.nextActionAt),
      previous.id,
      previous.version,
      previous.state,
      previous.currentFence,
      previous.lease?.attemptId ?? null
    );
    if (result.changes !== 1) {
      throw new SQLiteReliabilityTrialError(
        'concurrent_transition',
        'consumer delivery changed before the fenced transition could commit'
      );
    }
  }

  private insertActiveAttemptCompletion(
    previous: ConsumerDelivery,
    next: ConsumerDelivery
  ): void {
    if (previous.lease === null) {
      throw new TypeError('consumer completion requires an active lease');
    }
    const finished = next.attempts.find(
      (attempt) => attempt.id === previous.lease?.attemptId
    );
    if (finished === undefined || finished.state === 'running') {
      throw new TypeError('consumer completion reducer did not finish the active attempt');
    }
    this.insertAttemptCompletion(next.id, finished);
  }

  private insertAttemptCompletion(
    deliveryId: ConsumerDeliveryId,
    attempt: ConsumerDeliveryAttemptFinished
  ): void {
    run(
      this.sqlite,
      `INSERT INTO reliability_consumer_attempt_completions_trial
        (delivery_id, attempt_id, completion_state, completed_at_ms,
         failure_code, failure_classification)
       VALUES (?, ?, ?, ?, ?, ?)`,
      deliveryId,
      attempt.id,
      attempt.state,
      instantMilliseconds(attempt.completedAt),
      attempt.failure?.code ?? null,
      attempt.failure?.classification ?? null
    );
  }
}
