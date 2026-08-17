import {
  isSealedOperationAuditRecord,
  recheckEffectInvocationCurrentAuthorityInTransaction,
  type DirectAuditedUnitOfWork,
  type DirectOperationLogRecord,
  type EffectAuthorityRecheckSource,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type EffectUnitOfWork,
  type EffectUnitOfWorkPort,
  type SealedEffectAuthorityRecheckResult,
  type ShortOperationAuditRecord,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  effectfulOperationResultSchema,
  versionedDefinitionRefSchema,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import {
  runD1BufferedUnitOfWork,
  type D1BufferedUnitOfWork
} from './d1-atomic-batch';

interface ReceiptRow {
  readonly id: string;
  readonly scope_partition_key: string;
  readonly authority_principal_key: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: EffectOperationIdentity['surface'];
  readonly idempotency_verifier_profile_key: string;
  readonly idempotency_verifier_profile_version: number;
  readonly idempotency_key_verifier: string;
  readonly request_hash: string;
  readonly result_json: string;
}

const RECEIPT_SELECT = `SELECT id,scope_partition_key,authority_principal_key,
  operation_name,operation_version,surface,idempotency_verifier_profile_key,
  idempotency_verifier_profile_version,idempotency_key_verifier,request_hash,result_json
  FROM operation_log
  WHERE scope_partition_key = ? AND authority_principal_key = ?
    AND operation_name = ? AND operation_version = ? AND surface = ?
    AND idempotency_verifier_profile_key = ?
    AND idempotency_verifier_profile_version = ? AND idempotency_key_verifier = ?`;

const RECEIPT_ABSENT_PREDICATE = `NOT EXISTS (
  SELECT 1 FROM operation_log
  WHERE scope_partition_key = ? AND authority_principal_key = ?
    AND operation_name = ? AND operation_version = ? AND surface = ?
    AND idempotency_verifier_profile_key = ?
    AND idempotency_verifier_profile_version = ? AND idempotency_key_verifier = ?
)`;

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function capabilityKey(capability: VersionedDefinitionRef): string {
  return `${capability.key}\u0000${capability.version}`;
}

function identityValues(identity: EffectOperationIdentity): readonly unknown[] {
  return Object.freeze([
    identity.scopePartitionKey,
    identity.authorityPrincipalKey,
    identity.operationName,
    identity.operationVersion,
    identity.surface,
    identity.idempotencyVerifierProfile.key,
    identity.idempotencyVerifierProfile.version,
    identity.idempotencyKeyVerifier
  ]);
}

function receiptFromRow(row: ReceiptRow): TerminalEffectReceipt {
  const result = effectfulOperationResultSchema.parse(JSON.parse(row.result_json));
  return deepFreeze({
    ref: {
      id: row.id,
      operationName: row.operation_name,
      operationVersion: row.operation_version
    },
    identity: {
      scopePartitionKey: row.scope_partition_key,
      authorityPrincipalKey: row.authority_principal_key,
      operationName: row.operation_name,
      operationVersion: row.operation_version,
      surface: row.surface,
      idempotencyVerifierProfile: {
        key: row.idempotency_verifier_profile_key,
        version: row.idempotency_verifier_profile_version
      },
      idempotencyKeyVerifier: row.idempotency_key_verifier
    },
    requestHash: row.request_hash,
    result
  });
}

async function findReceipt(
  session: D1DatabaseSession,
  identity: EffectOperationIdentity
): Promise<TerminalEffectReceipt | undefined> {
  const row = await session.prepare(RECEIPT_SELECT)
    .bind(...identityValues(identity))
    .first<ReceiptRow>();
  return row ? receiptFromRow(row) : undefined;
}

export interface D1EffectDomainAdapter {
  openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot | Promise<EffectHandlerSnapshot>;
  applyDomainContribution(contribution: unknown): void | Promise<void>;
  afterOperationLogInserted?(receipt: TerminalEffectReceipt): void | Promise<void>;
  afterUnitOfWorkCommitted?(): void | Promise<void>;
  afterUnitOfWorkFinished?(outcome: { readonly committed: boolean }): void | Promise<void>;
}

export interface D1EffectDomainAdapterRegistration {
  readonly capability: VersionedDefinitionRef;
  create(unitOfWork: D1BufferedUnitOfWork): D1EffectDomainAdapter;
}

export interface D1EffectDomainAdapterRegistry {
  readonly capabilities: readonly VersionedDefinitionRef[];
}

const registeredDomains = new WeakMap<
  D1EffectDomainAdapterRegistry,
  ReadonlyMap<string, D1EffectDomainAdapterRegistration['create']>
>();

export function createD1EffectDomainAdapterRegistry(
  registrations: readonly D1EffectDomainAdapterRegistration[]
): D1EffectDomainAdapterRegistry {
  const domains = new Map<string, D1EffectDomainAdapterRegistration['create']>();
  const capabilities: VersionedDefinitionRef[] = [];
  for (const registration of registrations) {
    const parsed = versionedDefinitionRefSchema.safeParse(registration.capability);
    if (!parsed.success || typeof registration.create !== 'function') {
      throw new TypeError('d1_effect_domain_registration_invalid');
    }
    const capability = Object.freeze({ ...parsed.data });
    const key = capabilityKey(capability);
    if (domains.has(key)) throw new TypeError('d1_effect_domain_registration_duplicate');
    domains.set(key, registration.create.bind(registration));
    capabilities.push(capability);
  }
  const registry = Object.freeze({ capabilities: Object.freeze(capabilities) });
  registeredDomains.set(registry, domains);
  return registry;
}

function resolveDomain(
  registry: D1EffectDomainAdapterRegistry,
  capability: VersionedDefinitionRef,
  unitOfWork: D1BufferedUnitOfWork
): D1EffectDomainAdapter {
  const parsed = versionedDefinitionRefSchema.safeParse(capability);
  const domains = registeredDomains.get(registry);
  if (!parsed.success || !domains) throw new TypeError('d1_effect_domain_registry_invalid');
  const create = domains.get(capabilityKey(parsed.data));
  if (!create) throw new TypeError('d1_effect_domain_capability_unregistered');
  const adapter = create(unitOfWork);
  if (!adapter || typeof adapter.openHandlerSnapshot !== 'function'
      || typeof adapter.applyDomainContribution !== 'function') {
    throw new TypeError('d1_effect_domain_adapter_invalid');
  }
  return adapter;
}

export interface D1EffectUnitOfWorkOptions {
  readonly authorityRecheck: (
    unitOfWork: D1BufferedUnitOfWork
  ) => EffectAuthorityRecheckSource;
  readonly recordShortOperationAudit: (record: ShortOperationAuditRecord) => void | Promise<void>;
  readonly maximumAttempts?: number;
  readonly newBatchId?: () => string;
}

interface AttemptResult<Value> {
  readonly value: Value;
  readonly selectedDomain?: D1EffectDomainAdapter;
}

/**
 * D1 implementation of the application operation boundary. Reads use one
 * primary-consistent session. Every adapter records the predicates that made its
 * decision and buffers its writes; the operation log is committed in that same batch.
 */
export class D1EffectUnitOfWorkPort implements EffectUnitOfWorkPort {
  constructor(
    private readonly database: D1Database,
    private readonly registry: D1EffectDomainAdapterRegistry,
    private readonly options: D1EffectUnitOfWorkOptions
  ) {
    if (!registeredDomains.has(registry)) {
      throw new TypeError('d1_effect_domain_registry_unsealed');
    }
    if (typeof options.authorityRecheck !== 'function'
        || typeof options.recordShortOperationAudit !== 'function') {
      throw new TypeError('d1_effect_unit_of_work_options_invalid');
    }
  }

  async findTerminalReceipt(identity: EffectOperationIdentity): Promise<TerminalEffectReceipt | undefined> {
    return findReceipt(this.database.withSession('first-primary'), identity);
  }

  async findTerminalOperationLog(
    identity: EffectOperationIdentity
  ): Promise<TerminalEffectReceipt | undefined> {
    return this.findTerminalReceipt(identity);
  }

  async recordShortOperationAudit(record: ShortOperationAuditRecord): Promise<void> {
    if (!isSealedOperationAuditRecord(record)) {
      throw new TypeError('unsealed_d1_short_operation_audit');
    }
    await this.options.recordShortOperationAudit(record);
  }

  async #run<Value>(
    profile: 'ordinary' | 'direct',
    work: (unitOfWork: EffectUnitOfWork | DirectAuditedUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    let latestDomain: D1EffectDomainAdapter | undefined;
    let committed = false;
    try {
      const completed = await runD1BufferedUnitOfWork<AttemptResult<Value>>({
        database: this.database,
        ...(this.options.maximumAttempts === undefined
          ? {} : { maximumAttempts: this.options.maximumAttempts }),
        ...(this.options.newBatchId === undefined ? {} : { newBatchId: this.options.newBatchId }),
        work: async (buffered) => {
          let selected: {
            readonly capability: VersionedDefinitionRef;
            readonly adapter: D1EffectDomainAdapter;
          } | undefined;
          const select = (candidate: VersionedDefinitionRef): D1EffectDomainAdapter => {
            const parsed = versionedDefinitionRefSchema.safeParse(candidate);
            if (!parsed.success) throw new TypeError('d1_effect_domain_capability_invalid');
            if (selected) {
              if (capabilityKey(selected.capability) !== capabilityKey(parsed.data)) {
                throw new TypeError('d1_effect_domain_capability_changed_in_unit_of_work');
              }
              return selected.adapter;
            }
            const capability = Object.freeze({ ...parsed.data });
            const adapter = resolveDomain(this.registry, capability, buffered);
            selected = Object.freeze({ capability, adapter });
            latestDomain = adapter;
            return adapter;
          };
          const findInAttempt = async (identity: EffectOperationIdentity) => {
            const receipt = await findReceipt(buffered.readSession, identity);
            if (!receipt) buffered.assertCurrent(RECEIPT_ABSENT_PREDICATE, identityValues(identity));
            return receipt;
          };
          const base = {
            recheckCurrentAuthority: (context: EffectInvocationContext) =>
              recheckEffectInvocationCurrentAuthorityInTransaction(
                context,
                this.options.authorityRecheck(buffered)
              ),
            openHandlerSnapshot: (
              capability: VersionedDefinitionRef,
              context: EffectInvocationContext,
              authorityRecheck: SealedEffectAuthorityRecheckResult
            ) => select(capability).openHandlerSnapshot(capability, context, authorityRecheck),
            applyDomainContribution: (capability: VersionedDefinitionRef, contribution: unknown) =>
              select(capability).applyDomainContribution(contribution)
          };
          const insertOperationLog = async (record: DirectOperationLogRecord) => {
            const identity = record.receipt.identity;
            const occurredAtMs = Date.parse(record.occurredAt);
            if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
              throw new TypeError('operation_log_occurred_at_invalid');
            }
            buffered.write(`INSERT INTO operation_log (
              id,operation_name,operation_version,registry_digest_sha256,surface,
              actor_json,authority_principal_key,workspace_id,event_id,subjects_json,
              summary,occurred_at_ms,correlation_id,scope_partition_key,
              idempotency_verifier_profile_key,idempotency_verifier_profile_version,
              idempotency_key_verifier,request_hash,result_json,action_batch_id,action_step_id
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
              record.receipt.ref.id,
              identity.operationName,
              identity.operationVersion,
              record.registryDigestSha256,
              identity.surface,
              canonicalJsonText(record.actor),
              identity.authorityPrincipalKey,
              record.scope.workspaceId,
              record.scope.eventId ?? null,
              canonicalJsonText(record.scope.subjects),
              record.summary,
              occurredAtMs,
              record.correlationId,
              identity.scopePartitionKey,
              identity.idempotencyVerifierProfile.key,
              identity.idempotencyVerifierProfile.version,
              identity.idempotencyKeyVerifier,
              record.receipt.requestHash,
              canonicalJsonText(record.receipt.result),
              record.actionBatchId ?? null,
              record.actionStepId ?? null
            ]);
            await selected?.adapter.afterOperationLogInserted?.(record.receipt);
          };
          const invocationUnit = profile === 'direct'
            ? Object.freeze({
                ...base,
                findTerminalOperationLog: findInAttempt,
                insertOperationLog
              }) satisfies DirectAuditedUnitOfWork
            : Object.freeze({
                ...base,
                findTerminalReceipt: findInAttempt,
                insertOperationLog
              }) satisfies EffectUnitOfWork;
          const value = await work(invocationUnit);
          return Object.freeze({
            value,
            ...(selected ? { selectedDomain: selected.adapter } : {})
          });
        }
      });
      committed = true;
      await completed.selectedDomain?.afterUnitOfWorkCommitted?.();
      return completed.value;
    } finally {
      await latestDomain?.afterUnitOfWorkFinished?.({ committed });
    }
  }

  runInUnitOfWork<Value>(
    work: (unitOfWork: EffectUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    return this.#run('ordinary', work as (
      unitOfWork: EffectUnitOfWork | DirectAuditedUnitOfWork
    ) => Promise<Value>);
  }

  runInDirectUnitOfWork<Value>(
    work: (unitOfWork: DirectAuditedUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    return this.#run('direct', work as (
      unitOfWork: EffectUnitOfWork | DirectAuditedUnitOfWork
    ) => Promise<Value>);
  }
}
