import type { Database, SQLQueryBindings } from 'bun:sqlite';
import {
  createEffectInvocationBuilder,
  createEffectOperationExecutor,
  getCompiledRegisteredConsumerEffectOperation,
  listCompiledRegisteredConsumerEffectOperations,
  type OperationRegistry,
  type TerminalEffectReceipt
} from '@jooevents/application';
import type { EffectfulOperationResult } from '@jooevents/contracts';
import { canonicalJsonText, type ConsumerAttemptId, type ConsumerDeliveryId } from '@jooevents/kernel';
import {
  resolveReliabilityDefinition,
  type ConsumerDefinition,
  type ConsumerSourceRef,
  type DefinitionRef,
  type OutboxPointerRef,
  type ReliabilityRegistry,
  type SchemaRef
} from '@jooevents/reliability';
import {
  SQLiteTrialEffectUnitOfWorkPort,
  type SQLiteTrialEffectDomainAdapter
} from './foundation-trial-uow';
import {
  SQLiteReliabilityConsumerTrial
} from './reliability-consumer-trial';

interface SafeParser {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false };
}

export interface RegisteredConsumerSourceSchemaRegistration {
  readonly source: ConsumerSourceRef;
  readonly payloadSchema: SchemaRef;
  readonly schema: SafeParser;
}

export interface RegisteredConsumerInputProjectionRegistration {
  readonly reference: DefinitionRef<'input_projection'>;
  readonly acceptedSources: readonly ConsumerSourceRef[];
  readonly sourcePayloadSchema: SchemaRef;
  readonly projectedInputSchema: SchemaRef;
  project(input: {
    readonly pointer: OutboxPointerRef;
    readonly payload: unknown;
  }): unknown;
}

export interface RegisteredConsumerAuthorityRegistration {
  readonly consumer: DefinitionRef<'consumer'>;
  readonly capabilityRevisionId: ConsumerDefinition['capabilityRevisionId'];
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
}

export interface RegisteredConsumerOperationTrialFaults {
  readonly afterClaimed?: () => void;
  /** Runs after delivery completion but before the fresh receipt transaction commits. */
  readonly afterAtomicDeliveryCompletion?: () => void;
}

export interface RunRegisteredConsumerOperationTrialInput {
  readonly deliveryId: ConsumerDeliveryId;
  readonly faults?: RegisteredConsumerOperationTrialFaults;
}

export type RegisteredConsumerOperationTrialResult =
  | {
      readonly kind: 'terminal';
      readonly replay: boolean;
      readonly result: EffectfulOperationResult;
      readonly delivery: NonNullable<ReturnType<SQLiteReliabilityConsumerTrial['readDelivery']>>;
    }
  | {
      readonly kind: 'nonterminal';
      readonly result: EffectfulOperationResult;
      readonly delivery: NonNullable<ReturnType<SQLiteReliabilityConsumerTrial['readDelivery']>>;
    };

export class RegisteredConsumerOperationTrialError extends Error {
  constructor(
    readonly code:
      | 'composition_mismatch'
      | 'source_payload_missing'
      | 'source_payload_mismatch'
      | 'delivery_mismatch'
      | 'delivery_not_dispatchable'
      | 'lost_fence'
      | 'projection_failed'
      | 'nonterminal_result',
    message: string
  ) {
    super(message);
    this.name = 'RegisteredConsumerOperationTrialError';
  }
}

interface SourcePayloadRow {
  readonly pointer_key: string;
  readonly source_kind: ConsumerSourceRef['kind'];
  readonly source_key: string;
  readonly source_version: number;
  readonly source_identity: string;
  readonly aggregate_version: number;
  readonly payload_schema_key: string;
  readonly payload_schema_version: number;
  readonly payload_schema_digest_sha256: string;
  readonly payload_json: string;
}

function run(sqlite: Database, sql: string, ...bindings: SQLQueryBindings[]) {
  return sqlite.query(sql).run(...bindings);
}

function refKey(reference: { readonly key: string; readonly version: number }): string {
  return `${reference.key}@${reference.version}`;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameSource(left: ConsumerSourceRef, right: ConsumerSourceRef): boolean {
  return left.kind === right.kind && sameRef(left, right);
}

function sameReliabilitySchema(left: SchemaRef, right: SchemaRef): boolean {
  return sameRef(left, right)
    && left.canonicalSchemaDigestSha256 === right.canonicalSchemaDigestSha256;
}

function sameApplicationSchema(
  reliability: SchemaRef,
  application: { readonly key: string; readonly version: number; readonly digestSha256: string }
): boolean {
  return sameRef(reliability, application)
    && reliability.canonicalSchemaDigestSha256 === application.digestSha256;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function immutableJson(value: unknown): unknown {
  return deepFreeze(JSON.parse(canonicalJsonText(value)) as unknown);
}

function isPromiseLike(value: unknown): boolean {
  return Boolean(
    value
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

/** Installs only disposable source-payload evidence for the registered-consumer proof. */
export function installSQLiteRegisteredConsumerOperationTrial(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(`
    CREATE TABLE registered_consumer_source_payloads_trial (
      pointer_key TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('domain_fact', 'effect', 'job')),
      source_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK(source_version > 0),
      source_identity TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
      payload_schema_key TEXT NOT NULL,
      payload_schema_version INTEGER NOT NULL CHECK(payload_schema_version > 0),
      payload_schema_digest_sha256 TEXT NOT NULL
        CHECK(length(payload_schema_digest_sha256) = 64
          AND payload_schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      FOREIGN KEY (pointer_key) REFERENCES reliability_outbox_pointers_trial(pointer_key)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TRIGGER registered_consumer_source_payloads_trial_reject_update
    BEFORE UPDATE ON registered_consumer_source_payloads_trial
    BEGIN
      SELECT RAISE(ABORT, 'registered_consumer_source_payload_immutable');
    END;

    CREATE TRIGGER registered_consumer_source_payloads_trial_reject_delete
    BEFORE DELETE ON registered_consumer_source_payloads_trial
    BEGIN
      SELECT RAISE(ABORT, 'registered_consumer_source_payload_immutable');
    END;
  `);
}

export class SQLiteRegisteredConsumerSourcePayloadTrial {
  private readonly sources: ReadonlyMap<string, RegisteredConsumerSourceSchemaRegistration>;

  constructor(
    private readonly sqlite: Database,
    registrations: readonly RegisteredConsumerSourceSchemaRegistration[]
  ) {
    const sources = new Map<string, RegisteredConsumerSourceSchemaRegistration>();
    for (const registration of registrations) {
      const key = `${registration.source.kind}:${refKey(registration.source)}`;
      if (sources.has(key) || typeof registration.schema?.safeParse !== 'function') {
        throw new RegisteredConsumerOperationTrialError(
          'composition_mismatch',
          'source payload schemas must be registered exactly once'
        );
      }
      const safeParse = registration.schema.safeParse.bind(registration.schema);
      sources.set(key, Object.freeze({
        source: Object.freeze({ ...registration.source }),
        payloadSchema: Object.freeze({ ...registration.payloadSchema }),
        schema: Object.freeze({ safeParse })
      }));
    }
    this.sources = sources;
  }

  append(input: { readonly pointer: OutboxPointerRef; readonly payload: unknown }): void {
    const registration = this.sources.get(`${input.pointer.source.kind}:${refKey(input.pointer.source)}`);
    if (!registration) {
      throw new RegisteredConsumerOperationTrialError(
        'composition_mismatch',
        'source payload schema is not registered'
      );
    }
    const parsed = registration.schema.safeParse(input.payload);
    if (!parsed.success) {
      throw new RegisteredConsumerOperationTrialError(
        'source_payload_mismatch',
        'source payload does not match its registered exact schema'
      );
    }
    run(
      this.sqlite,
      `INSERT INTO registered_consumer_source_payloads_trial (
        pointer_key, source_kind, source_key, source_version, source_identity,
        aggregate_version, payload_schema_key, payload_schema_version,
        payload_schema_digest_sha256, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.pointer.key,
      input.pointer.source.kind,
      input.pointer.source.key,
      input.pointer.source.version,
      input.pointer.sourceIdentity,
      input.pointer.sourceVersion,
      registration.payloadSchema.key,
      registration.payloadSchema.version,
      registration.payloadSchema.canonicalSchemaDigestSha256,
      canonicalJsonText(parsed.data)
    );
  }

  read(pointer: OutboxPointerRef): {
    readonly payload: unknown;
    readonly payloadSchema: SchemaRef;
  } {
    const row = this.sqlite.query<SourcePayloadRow, [string]>(`
      SELECT * FROM registered_consumer_source_payloads_trial WHERE pointer_key = ?
    `).get(pointer.key);
    if (!row) {
      throw new RegisteredConsumerOperationTrialError(
        'source_payload_missing',
        'consumer source payload is unavailable'
      );
    }
    if (
      row.source_kind !== pointer.source.kind
      || row.source_key !== pointer.source.key
      || row.source_version !== pointer.source.version
      || row.source_identity !== pointer.sourceIdentity
      || row.aggregate_version !== pointer.sourceVersion
    ) {
      throw new RegisteredConsumerOperationTrialError(
        'source_payload_mismatch',
        'consumer source payload does not match the immutable pointer'
      );
    }
    const registration = this.sources.get(`${row.source_kind}:${row.source_key}@${row.source_version}`);
    const payload = JSON.parse(row.payload_json) as unknown;
    const parsed = registration?.schema.safeParse(payload);
    if (!registration || !parsed?.success) {
      throw new RegisteredConsumerOperationTrialError(
        'source_payload_mismatch',
        'stored consumer source payload no longer matches its registration'
      );
    }
    const payloadSchema = Object.freeze({
      key: row.payload_schema_key,
      version: row.payload_schema_version,
      canonicalSchemaDigestSha256: row.payload_schema_digest_sha256
    }) as SchemaRef;
    if (!sameReliabilitySchema(payloadSchema, registration.payloadSchema)) {
      throw new RegisteredConsumerOperationTrialError(
        'source_payload_mismatch',
        'stored consumer source payload schema changed'
      );
    }
    return Object.freeze({ payload: immutableJson(parsed.data), payloadSchema });
  }
}

interface JoinedConsumer {
  readonly definition: ConsumerDefinition;
  readonly projector: RegisteredConsumerInputProjectionRegistration;
}

export function createSQLiteRegisteredConsumerOperationTrialRunner(input: {
  readonly sqlite: Database;
  readonly operationRegistry: OperationRegistry;
  readonly reliabilityRegistry: ReliabilityRegistry;
  readonly reliability: SQLiteReliabilityConsumerTrial;
  readonly sources: SQLiteRegisteredConsumerSourcePayloadTrial;
  readonly sourceSchemas: readonly RegisteredConsumerSourceSchemaRegistration[];
  readonly inputProjectors: readonly RegisteredConsumerInputProjectionRegistration[];
  readonly authority: readonly RegisteredConsumerAuthorityRegistration[];
  readonly domain: SQLiteTrialEffectDomainAdapter;
  readonly workerKey: string;
  readonly newAttemptId: (deliveryId: ConsumerDeliveryId) => ConsumerAttemptId;
  readonly newCorrelationId: (
    deliveryId: ConsumerDeliveryId,
    attemptId: ConsumerAttemptId
  ) => string;
  readonly newReceiptId?: () => string;
}) {
  const compositionFailure = (message: string): never => {
    throw new RegisteredConsumerOperationTrialError('composition_mismatch', message);
  };
  const consumers = new Map<string, ConsumerDefinition>();
  for (const definition of input.reliabilityRegistry.definitions) {
    if (definition.kind === 'consumer' && definition.outputKind === 'application_operation') {
      consumers.set(refKey(definition), definition);
    }
  }
  const projectors = new Map<string, RegisteredConsumerInputProjectionRegistration>();
  for (const projector of input.inputProjectors) {
    const key = refKey(projector.reference);
    if (projectors.has(key)) compositionFailure(`input projector ${key} is duplicated`);
    const project = projector.project.bind(projector);
    projectors.set(key, Object.freeze({
      reference: Object.freeze({ ...projector.reference }),
      acceptedSources: Object.freeze(
        projector.acceptedSources.map((source) => Object.freeze({ ...source }))
      ),
      sourcePayloadSchema: Object.freeze({ ...projector.sourcePayloadSchema }),
      projectedInputSchema: Object.freeze({ ...projector.projectedInputSchema }),
      project
    }));
  }
  const sourceSchemas = new Map<string, RegisteredConsumerSourceSchemaRegistration>();
  for (const source of input.sourceSchemas) {
    const key = `${source.source.kind}:${refKey(source.source)}`;
    if (sourceSchemas.has(key)) compositionFailure(`source schema ${key} is duplicated`);
    const safeParse = source.schema.safeParse.bind(source.schema);
    sourceSchemas.set(key, Object.freeze({
      source: Object.freeze({ ...source.source }),
      payloadSchema: Object.freeze({ ...source.payloadSchema }),
      schema: Object.freeze({ safeParse })
    }));
  }
  const authority = new Map<string, RegisteredConsumerAuthorityRegistration>();
  for (const registration of input.authority) {
    const key = refKey(registration.consumer);
    if (authority.has(key)) compositionFailure(`consumer authority ${key} is duplicated`);
    authority.set(key, Object.freeze({
      consumer: Object.freeze({ ...registration.consumer }),
      capabilityRevisionId: registration.capabilityRevisionId,
      authorityCitation: Object.freeze({ ...registration.authorityCitation })
    }));
  }

  const internalBindings = listCompiledRegisteredConsumerEffectOperations(input.operationRegistry);
  if (internalBindings.length !== consumers.size) {
    compositionFailure('application-operation consumers and internal operation bindings differ');
  }
  const joined = new Map<string, JoinedConsumer>();
  const requiredProjectors = new Set<string>();
  const requiredSourceSchemas = new Set<string>();
  for (const [consumerKey, definition] of consumers) {
    const resolved = getCompiledRegisteredConsumerEffectOperation(
      input.operationRegistry,
      definition.key,
      definition.version
    ) ?? compositionFailure(`consumer ${consumerKey} has no exact internal operation binding`);
    if (!sameRef(definition.targetOperation, {
      key: resolved.operation.definition.name,
      version: resolved.operation.definition.version
    })) {
      compositionFailure(`consumer ${consumerKey} targets another operation`);
    }
    if (!resolved.operation.definition.accessLanes.some(
      (lane) => lane.surface === 'application_job' && lane.kind === 'registered_consumer'
    )) {
      compositionFailure(`consumer ${consumerKey} has no registered-consumer application-job lane`);
    }
    if (!sameApplicationSchema(definition.inputSchema, resolved.operation.inputSchema.reference)) {
      compositionFailure(`consumer ${consumerKey} input schema differs from its operation`);
    }
    if (!sameApplicationSchema(definition.resultSchema, resolved.binding.projectedResultSchema.reference)) {
      compositionFailure(`consumer ${consumerKey} result schema differs from its lane projection`);
    }
    const projector = projectors.get(refKey(definition.inputProjection))
      ?? compositionFailure(`consumer ${consumerKey} input projector is missing`);
    requiredProjectors.add(refKey(definition.inputProjection));
    if (!sameReliabilitySchema(projector.projectedInputSchema, definition.inputSchema)) {
      compositionFailure(`consumer ${consumerKey} input projector is missing or schema-substituted`);
    }
    if (
      projector.acceptedSources.length !== definition.acceptedSources.length
      || projector.acceptedSources.some(
        (source) => !definition.acceptedSources.some((accepted) => sameSource(source, accepted))
      )
    ) {
      compositionFailure(`consumer ${consumerKey} projector source set is not exact`);
    }
    for (const accepted of definition.acceptedSources) {
      if (!projector.acceptedSources.some((source) => sameSource(source, accepted))) {
        compositionFailure(`consumer ${consumerKey} projector omits an accepted source`);
      }
      const sourceKey = `${accepted.kind}:${refKey(accepted)}`;
      requiredSourceSchemas.add(sourceKey);
      const source = sourceSchemas.get(sourceKey);
      if (!source || !sameReliabilitySchema(source.payloadSchema, projector.sourcePayloadSchema)) {
        compositionFailure(`consumer ${consumerKey} source payload schema is not exact`);
      }
    }
    const registeredAuthority = authority.get(consumerKey);
    if (
      !registeredAuthority
      || registeredAuthority.capabilityRevisionId !== definition.capabilityRevisionId
      || !sameRef(registeredAuthority.authorityCitation, definition.authorityCitation)
    ) {
      compositionFailure(`consumer ${consumerKey} capability or authority citation differs`);
    }
    joined.set(consumerKey, Object.freeze({ definition, projector }));
  }
  if (
    projectors.size !== requiredProjectors.size
    || [...projectors.keys()].some((key) => !requiredProjectors.has(key))
    || sourceSchemas.size !== requiredSourceSchemas.size
    || [...sourceSchemas.keys()].some((key) => !requiredSourceSchemas.has(key))
    || authority.size !== joined.size
  ) {
    compositionFailure('orphan projector, source schema, or consumer-authority registration exists');
  }

  const builder = createEffectInvocationBuilder(input.operationRegistry);

  const assertDelivery = (
    delivery: NonNullable<ReturnType<SQLiteReliabilityConsumerTrial['readDelivery']>>
  ): JoinedConsumer => {
    const definition = resolveReliabilityDefinition(input.reliabilityRegistry, delivery.consumer);
    const candidate = joined.get(refKey(delivery.consumer));
    if (
      !definition
      || definition.kind !== 'consumer'
      || !candidate
      || definition.canonicalDigestSha256 !== delivery.definitionDigestSha256
      || !sameRef(definition.targetOperation, delivery.targetOperation)
      || !sameRef(definition.inputProjection, delivery.inputProjection)
      || definition.capabilityRevisionId !== delivery.capabilityRevisionId
      || !sameRef(definition.authorityCitation, delivery.authorityCitation)
      || definition.maximumAttempts !== delivery.maximumAttempts
      || definition.leaseDurationMs !== delivery.leaseDurationMs
      || !definition.acceptedSources.some((source) => sameSource(source, delivery.pointer.source))
    ) {
      throw new RegisteredConsumerOperationTrialError(
        'delivery_mismatch',
        'durable delivery no longer matches its exact registered consumer definition'
      );
    }
    return candidate;
  };

  return Object.freeze({
    async run(runInput: RunRegisteredConsumerOperationTrialInput): Promise<RegisteredConsumerOperationTrialResult> {
      let delivery = input.reliability.readDelivery(runInput.deliveryId);
      if (!delivery) {
        throw new RegisteredConsumerOperationTrialError(
          'delivery_not_dispatchable',
          'consumer delivery does not exist'
        );
      }
      const joinedConsumer = assertDelivery(delivery);
      const terminalAttempt = delivery.state === 'succeeded'
        ? delivery.attempts.find((attempt) => attempt.state === 'succeeded')
        : undefined;
      const terminalReplay = terminalAttempt !== undefined;
      let attemptId = terminalAttempt?.id;
      if (!terminalReplay) {
        delivery = input.reliability.claim({
          deliveryId: runInput.deliveryId,
          attemptId: input.newAttemptId(delivery.id),
          ownerKey: input.workerKey
        });
        attemptId = delivery.lease?.attemptId;
        if (attemptId === undefined) {
          throw new RegisteredConsumerOperationTrialError(
            'delivery_not_dispatchable',
            'consumer acquisition did not produce or resume a durable attempt'
          );
        }
        runInput.faults?.afterClaimed?.();
      }
      if (attemptId === undefined) {
        throw new RegisteredConsumerOperationTrialError(
          'delivery_not_dispatchable',
          'consumer delivery has no terminal or active attempt'
        );
      }
      delivery = input.reliability.readDelivery(runInput.deliveryId);
      if (!delivery) throw new RegisteredConsumerOperationTrialError('delivery_not_dispatchable', 'consumer delivery disappeared');
      assertDelivery(delivery);
      if (!terminalReplay && (
        delivery.state !== 'leased'
        || delivery.lease?.attemptId !== attemptId
        || delivery.lease.ownerKey !== input.workerKey
      )) {
        throw new RegisteredConsumerOperationTrialError(
          'lost_fence',
          'consumer attempt lost its durable delivery fence before execution'
        );
      }
      const fence = delivery.attempts.find((attempt) => attempt.id === attemptId)?.fence;
      if (fence === undefined) {
        throw new RegisteredConsumerOperationTrialError(
          'delivery_not_dispatchable',
          'consumer attempt is not part of the durable delivery'
        );
      }

      const source = input.sources.read(delivery.pointer);
      if (!sameReliabilitySchema(source.payloadSchema, joinedConsumer.projector.sourcePayloadSchema)) {
        throw new RegisteredConsumerOperationTrialError(
          'source_payload_mismatch',
          'consumer projector source schema differs from the immutable payload'
        );
      }
      let projected: unknown;
      try {
        projected = joinedConsumer.projector.project(Object.freeze({
          pointer: deepFreeze({ ...delivery.pointer, source: { ...delivery.pointer.source } }),
          payload: source.payload
        }));
      } catch {
        throw new RegisteredConsumerOperationTrialError(
          'projection_failed',
          'registered consumer input projection failed'
        );
      }
      if (isPromiseLike(projected)) {
        throw new RegisteredConsumerOperationTrialError(
          'projection_failed',
          'registered consumer input projection must be synchronous'
        );
      }
      const resolved = getCompiledRegisteredConsumerEffectOperation(
        input.operationRegistry,
        delivery.consumer.key,
        delivery.consumer.version
      );
      const parsedProjected = resolved?.operation.inputSchema.schema.safeParse(projected);
      if (!resolved || !parsedProjected?.success) {
        throw new RegisteredConsumerOperationTrialError(
          'projection_failed',
          'registered consumer input projection returned another input schema'
        );
      }

      const invocation = await builder.buildRegisteredConsumer({
        consumer: { key: delivery.consumer.key, version: delivery.consumer.version },
        correlationId: input.newCorrelationId(delivery.id, attemptId),
        businessInput: parsedProjected.data,
        verifiedEvidence: {
          kind: 'registered_consumer',
          surface: 'application_job',
          client: { key: 'worker.registered-consumer' },
          consumerDeliveryId: delivery.id,
          consumerAttemptId: attemptId
        },
        rawIdempotencyKey: `consumer-delivery:${delivery.id}:attempt:${attemptId}`
      });

      const beforeExecute = input.reliability.readDelivery(delivery.id);
      if (
        !terminalReplay
        && (
          beforeExecute?.state !== 'leased'
          || beforeExecute.lease?.attemptId !== attemptId
          || beforeExecute.currentFence !== fence
        )
      ) {
        throw new RegisteredConsumerOperationTrialError(
          'lost_fence',
          'consumer attempt lost its durable delivery fence before the operation unit of work'
        );
      }

      let freshReceipt = false;
      const domain: SQLiteTrialEffectDomainAdapter = Object.freeze({
        openHandlerSnapshot: input.domain.openHandlerSnapshot.bind(input.domain),
        applyDomainContribution: input.domain.applyDomainContribution.bind(input.domain),
        async afterReceiptParentInserted(receipt: TerminalEffectReceipt) {
          await input.domain.afterReceiptParentInserted?.(receipt);
          input.reliability.completeOperation({
            deliveryId: delivery.id,
            fence
          });
          freshReceipt = true;
          runInput.faults?.afterAtomicDeliveryCompletion?.();
        },
        ...(input.domain.afterReceiptChildInserted
          ? { afterReceiptChildInserted: input.domain.afterReceiptChildInserted.bind(input.domain) }
          : {}),
        ...(input.domain.afterExecutionClaimReleased
          ? { afterExecutionClaimReleased: input.domain.afterExecutionClaimReleased.bind(input.domain) }
          : {}),
        ...(input.domain.afterUnitOfWorkCommitted
          ? { afterUnitOfWorkCommitted: input.domain.afterUnitOfWorkCommitted.bind(input.domain) }
          : {})
      });
      const executor = createEffectOperationExecutor({
        registry: input.operationRegistry,
        unitOfWork: new SQLiteTrialEffectUnitOfWorkPort(input.sqlite, domain),
        ...(input.newReceiptId ? { newReceiptId: input.newReceiptId } : {})
      });
      const result = await executor.execute(invocation);
      const terminal = result.kind === 'success'
        || (result.kind === 'outcome' && result.terminal === true);
      if (!terminal) {
        const current = input.reliability.readDelivery(delivery.id);
        if (!current) throw new RegisteredConsumerOperationTrialError('delivery_not_dispatchable', 'consumer delivery disappeared');
        return Object.freeze({ kind: 'nonterminal', result, delivery: current });
      }

      let completed = input.reliability.readDelivery(delivery.id);
      if (!completed) throw new RegisteredConsumerOperationTrialError('delivery_not_dispatchable', 'consumer delivery disappeared');
      if (!freshReceipt && completed.state !== 'succeeded') {
        if (
          completed.state !== 'leased'
          || completed.lease?.attemptId !== attemptId
          || completed.currentFence !== fence
        ) {
          throw new RegisteredConsumerOperationTrialError(
            'lost_fence',
            'existing terminal receipt replay lost its delivery fence'
          );
        }
        completed = input.reliability.completeOperation({
          deliveryId: completed.id,
          fence
        });
      }
      if (completed.state !== 'succeeded') {
        throw new RegisteredConsumerOperationTrialError(
          'nonterminal_result',
          'terminal operation receipt did not complete its consumer delivery'
        );
      }
      return Object.freeze({
        kind: 'terminal',
        replay: !freshReceipt,
        result,
        delivery: completed
      });
    }
  });
}
