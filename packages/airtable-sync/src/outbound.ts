import type {
  AirtableBaseId,
  AirtableCellValue,
  AirtableDataPort,
  AirtableFieldId,
  AirtableProviderFailure,
  AirtableRecord,
  AirtableRecordId,
  AirtableTableId,
  AirtableWriteRecord
} from '@jooevents/airtable';
import { canonicalJsonSha256, canonicalJsonValue } from '@jooevents/kernel';
import type {
  CurrentProjection,
  ProcessProjectionWorkResult,
  ProjectionWorkClaim,
  ProjectionWorkRepository,
  ProjectionWriteResult
} from './processor';

export interface AirtableProjectionTarget {
  readonly mappingRevision: number;
  readonly baseId: AirtableBaseId;
  readonly tableId: AirtableTableId;
  readonly stableIdFieldId: AirtableFieldId;
  readonly fieldIds: Readonly<Record<string, AirtableFieldId>>;
  readonly providerRecordId?: AirtableRecordId;
  readonly lastCommon?: Readonly<{
    readonly canonicalVersion: number;
    readonly baselineDigestSha256: string;
    readonly providerFingerprintSha256: string;
  }>;
}

export interface AirtableOutboundEntry {
  readonly claim: ProjectionWorkClaim;
  readonly projection: CurrentProjection;
  readonly target: AirtableProjectionTarget;
}

export interface AirtableProviderThrottle {
  beforeRequest(input: Readonly<{
    baseId: AirtableBaseId;
    nowMs: number;
  }>): Promise<{ readonly kind: 'ready' } | {
    readonly kind: 'delayed';
    readonly retryAfterMs: number;
  }>;
  observe(input: Readonly<{
    baseId: AirtableBaseId;
    nowMs: number;
    failure: AirtableProviderFailure;
  }>): Promise<void>;
}

export const noAirtableProviderThrottle: AirtableProviderThrottle = Object.freeze({
  async beforeRequest() { return { kind: 'ready' as const }; },
  async observe() {}
});

function providerFingerprint(record: AirtableRecord, fieldIds: readonly AirtableFieldId[]): string {
  const fields = Object.fromEntries(fieldIds.slice().sort().map((fieldId) => [
    fieldId,
    Object.hasOwn(record.fields, fieldId) ? record.fields[fieldId] : null
  ]));
  return canonicalJsonSha256(fields);
}

function expectedFields(entry: AirtableOutboundEntry): Readonly<Record<AirtableFieldId, AirtableCellValue>> {
  if (entry.target.mappingRevision !== entry.claim.mappingRevision) {
    throw new TypeError('airtable_outbound_stale_mapping');
  }
  const fields: Record<AirtableFieldId, AirtableCellValue> = {
    [entry.target.stableIdFieldId]: entry.claim.subjectId
  };
  for (const [fieldKey, value] of Object.entries(entry.projection.fields)) {
    const fieldId = entry.target.fieldIds[fieldKey];
    if (!fieldId) throw new TypeError('airtable_outbound_field_unmapped');
    fields[fieldId] = canonicalJsonValue(value);
  }
  return Object.freeze(fields);
}

function equivalentRecord(
  record: AirtableRecord,
  expected: Readonly<Record<AirtableFieldId, AirtableCellValue>>
): boolean {
  return Object.entries(expected).every(([fieldId, value]) =>
    canonicalJsonSha256(record.fields[fieldId as AirtableFieldId] ?? null)
      === canonicalJsonSha256(value)
  );
}

function safeRetryAfter(failure: AirtableProviderFailure): number {
  return Math.max(1_000, Math.min(failure.retryAfterMs ?? 30_000, 86_400_000));
}

function failureResult(failure: AirtableProviderFailure): ProjectionWriteResult {
  if (failure.retry === 'after_delay') {
    return { kind: 'retry', code: failure.code, retryAfterMs: safeRetryAfter(failure) };
  }
  if (failure.retry === 'reconcile_first') {
    return { kind: 'acceptance_unknown', code: failure.code };
  }
  return { kind: 'attention', code: failure.code };
}

async function findManagedRecord(input: Readonly<{
  provider: AirtableDataPort;
  entry: AirtableOutboundEntry;
}>): Promise<{
  readonly kind: 'none';
} | {
  readonly kind: 'one';
  readonly recordId: AirtableRecordId;
} | {
  readonly kind: 'failure';
  readonly result: ProjectionWriteResult;
}> {
  if (input.entry.target.providerRecordId) {
    return { kind: 'one', recordId: input.entry.target.providerRecordId };
  }
  const found = await input.provider.findRecordsByField({
    baseId: input.entry.target.baseId,
    tableId: input.entry.target.tableId,
    fieldId: input.entry.target.stableIdFieldId,
    value: input.entry.claim.subjectId,
    limit: 2
  });
  if (found.kind === 'failure') return { kind: 'failure', result: failureResult(found.failure) };
  if (found.value.length > 1) {
    return { kind: 'failure', result: { kind: 'attention', code: 'multiple_matches' } };
  }
  return found.value[0]
    ? { kind: 'one', recordId: found.value[0] }
    : { kind: 'none' };
}

async function reconcileUnknown(input: Readonly<{
  provider: AirtableDataPort;
  entry: AirtableOutboundEntry;
  expected: Readonly<Record<AirtableFieldId, AirtableCellValue>>;
}>): Promise<ProjectionWriteResult> {
  const found = await input.provider.findRecordsByField({
    baseId: input.entry.target.baseId,
    tableId: input.entry.target.tableId,
    fieldId: input.entry.target.stableIdFieldId,
    value: input.entry.claim.subjectId,
    limit: 2
  });
  if (found.kind === 'failure' || found.value.length !== 1) {
    return {
      kind: found.kind === 'success' && found.value.length > 1 ? 'attention' : 'acceptance_unknown',
      code: found.kind === 'failure' ? found.failure.code : found.value.length > 1
        ? 'multiple_matches'
        : 'record_not_observed'
    };
  }
  const reread = await input.provider.getRecord({
    baseId: input.entry.target.baseId,
    tableId: input.entry.target.tableId,
    recordId: found.value[0]!
  });
  if (reread.kind === 'failure' || !equivalentRecord(reread.value, input.expected)) {
    return { kind: 'acceptance_unknown', code: 'accepted_state_not_confirmed' };
  }
  const fieldIds = Object.keys(input.expected) as AirtableFieldId[];
  return {
    kind: 'already_current',
    providerRecordId: reread.value.id,
    providerFingerprint: providerFingerprint(reread.value, fieldIds)
  };
}

async function recreateMissingManagedRecord(input: Readonly<{
  provider: AirtableDataPort;
  entry: AirtableOutboundEntry;
  expected: Readonly<Record<AirtableFieldId, AirtableCellValue>>;
  nowMs: number;
  throttle: AirtableProviderThrottle;
}>): Promise<ProjectionWriteResult> {
  const found = await input.provider.findRecordsByField({
    baseId: input.entry.target.baseId,
    tableId: input.entry.target.tableId,
    fieldId: input.entry.target.stableIdFieldId,
    value: input.entry.claim.subjectId,
    limit: 2
  });
  if (found.kind === 'failure') return failureResult(found.failure);
  if (found.value.length > 1) return { kind: 'attention', code: 'multiple_matches' };
  const recreated = await input.provider.patchRecords({
    baseId: input.entry.target.baseId,
    tableId: input.entry.target.tableId,
    records: Object.freeze([Object.freeze({
      ...(found.value[0] ? { recordId: found.value[0] } : {}),
      fields: input.expected
    })]),
    mergeOnFieldId: input.entry.target.stableIdFieldId
  });
  if (recreated.kind === 'failure') {
    await input.throttle.observe({
      baseId: input.entry.target.baseId,
      nowMs: input.nowMs,
      failure: recreated.failure
    });
    return failureResult(recreated.failure);
  }
  const disposition = recreated.value.records[0];
  if (!disposition) return { kind: 'acceptance_unknown', code: 'batch_result_missing' };
  if (disposition.kind === 'failed') return failureResult(disposition.failure);
  return {
    kind: 'applied',
    providerRecordId: disposition.record.id,
    providerFingerprint: providerFingerprint(
      disposition.record,
      Object.keys(input.expected) as AirtableFieldId[]
    )
  };
}

/**
 * Writes one provider batch. Every entry belongs to the same base/table and the
 * caller bounds the batch to Airtable's ten-record limit.
 */
export async function writeAirtableProjectionBatch(input: Readonly<{
  entries: readonly AirtableOutboundEntry[];
  provider: AirtableDataPort;
  throttle?: AirtableProviderThrottle;
  nowMs: number;
}>): Promise<readonly ProjectionWriteResult[]> {
  if (input.entries.length < 1 || input.entries.length > 10) {
    throw new TypeError('airtable_outbound_batch_invalid');
  }
  const first = input.entries[0]!;
  if (input.entries.some((entry) =>
    entry.target.baseId !== first.target.baseId || entry.target.tableId !== first.target.tableId
  )) {
    throw new TypeError('airtable_outbound_batch_target_mismatch');
  }
  const throttle = input.throttle ?? noAirtableProviderThrottle;
  const permission = await throttle.beforeRequest({ baseId: first.target.baseId, nowMs: input.nowMs });
  if (permission.kind === 'delayed') {
    return Object.freeze(input.entries.map(() => ({
      kind: 'retry' as const,
      code: 'provider_throttled',
      retryAfterMs: permission.retryAfterMs
    })));
  }

  const expected: Array<Readonly<Record<AirtableFieldId, AirtableCellValue>>> = [];
  const writes: AirtableWriteRecord[] = [];
  const early = new Map<number, ProjectionWriteResult>();
  for (const [index, entry] of input.entries.entries()) {
    let fields: Readonly<Record<AirtableFieldId, AirtableCellValue>>;
    try {
      fields = expectedFields(entry);
    } catch {
      early.set(index, { kind: 'attention', code: 'mapping_or_projection_invalid' });
      expected.push(Object.freeze({}));
      writes.push(Object.freeze({ fields: Object.freeze({}) }));
      continue;
    }
    expected.push(fields);
    if (
      entry.target.providerRecordId
      && entry.target.lastCommon
      && canonicalJsonSha256(entry.projection.fields)
        === entry.target.lastCommon.baselineDigestSha256
    ) {
      early.set(index, {
        kind: 'already_current',
        providerRecordId: entry.target.providerRecordId,
        providerFingerprint: entry.target.lastCommon.providerFingerprintSha256
      });
      writes.push(Object.freeze({ recordId: entry.target.providerRecordId, fields }));
      continue;
    }
    const record = await findManagedRecord({ provider: input.provider, entry });
    if (record.kind === 'failure') {
      early.set(index, record.result);
      writes.push(Object.freeze({ fields }));
      continue;
    }
    writes.push(Object.freeze({
      ...(record.kind === 'one' ? { recordId: record.recordId } : {}),
      fields
    }));
  }

  const writableIndexes = input.entries.map((_, index) => index).filter((index) => !early.has(index));
  if (writableIndexes.length === 0) {
    return Object.freeze(input.entries.map((_, index) => early.get(index)!));
  }
  const providerResult = await input.provider.patchRecords({
    baseId: first.target.baseId,
    tableId: first.target.tableId,
    records: Object.freeze(writableIndexes.map((index) => writes[index]!)),
    mergeOnFieldId: first.target.stableIdFieldId
  });
  if (providerResult.kind === 'failure') {
    await throttle.observe({
      baseId: first.target.baseId,
      nowMs: input.nowMs,
      failure: providerResult.failure
    });
    if (providerResult.failure.retry !== 'reconcile_first') {
      const result = failureResult(providerResult.failure);
      return Object.freeze(input.entries.map((_, index) => early.get(index) ?? result));
    }
    const reconciled = await Promise.all(writableIndexes.map((index) => reconcileUnknown({
      provider: input.provider,
      entry: input.entries[index]!,
      expected: expected[index]!
    })));
    const byIndex = new Map(writableIndexes.map((index, position) => [index, reconciled[position]!]));
    return Object.freeze(input.entries.map((_, index) => early.get(index) ?? byIndex.get(index)!));
  }

  const dispositions = new Map(providerResult.value.records.map((result) => [
    writableIndexes[result.requestIndex],
    result
  ]));
  const resolved = await Promise.all(input.entries.map(async (entry, index): Promise<ProjectionWriteResult> => {
    const existing = early.get(index);
    if (existing) return existing;
    const disposition = dispositions.get(index);
    if (!disposition) return { kind: 'acceptance_unknown', code: 'batch_result_missing' };
    if (disposition.kind === 'failed') {
      return disposition.failure.code === 'not_found'
        ? recreateMissingManagedRecord({
            provider: input.provider,
            entry,
            expected: expected[index]!,
            nowMs: input.nowMs,
            throttle
          })
        : failureResult(disposition.failure);
    }
    return {
      kind: 'applied',
      providerRecordId: disposition.record.id,
      providerFingerprint: providerFingerprint(
        disposition.record,
        Object.keys(expected[index]!) as AirtableFieldId[]
      )
    };
  }));
  return Object.freeze(resolved);
}

export interface AirtableConnectionLease {
  readonly connectionId: string;
  readonly workerId: string;
  readonly fence: number;
}

export interface AirtableOutboundJobRepository extends ProjectionWorkRepository {
  claimConnection(input: Readonly<{
    connectionId: string;
    workerId: string;
    nowMs: number;
  }>): Promise<AirtableConnectionLease | undefined>;
  releaseConnection(input: Readonly<{
    lease: AirtableConnectionLease;
    nowMs: number;
  }>): Promise<boolean>;
}

export interface AirtableOutboundProjectionSource {
  readCurrent(claim: ProjectionWorkClaim): Promise<CurrentProjection>;
  resolveTarget(claim: ProjectionWorkClaim): Promise<AirtableProjectionTarget | undefined>;
}

export type AirtableOutboundJobResult =
  | { readonly kind: 'contended' | 'idle' }
  | {
      readonly kind: 'processed';
      readonly results: readonly ProcessProjectionWorkResult[];
    };

/** Same registered application job used by Queue and Bun-loop wake adapters. */
export async function runAirtableOutboundJob(input: Readonly<{
  connectionId: string;
  workerId: string;
  nowMs: number;
  repository: AirtableOutboundJobRepository;
  source: AirtableOutboundProjectionSource;
  provider: AirtableDataPort;
  throttle?: AirtableProviderThrottle;
}>): Promise<AirtableOutboundJobResult> {
  const lease = await input.repository.claimConnection({
    connectionId: input.connectionId,
    workerId: input.workerId,
    nowMs: input.nowMs
  });
  if (!lease) return { kind: 'contended' };
  const results: ProcessProjectionWorkResult[] = [];
  try {
    const entries: AirtableOutboundEntry[] = [];
    for (let index = 0; index < 10; index += 1) {
      const claim = await input.repository.claimNext({
        connectionId: input.connectionId,
        workerId: input.workerId,
        nowMs: input.nowMs
      });
      if (!claim) break;
      const [projection, target] = await Promise.all([
        input.source.readCurrent(claim),
        input.source.resolveTarget(claim)
      ]);
      if (!target) {
        const completed = await input.repository.complete({
          claim,
          outcome: { kind: 'attention', code: 'mapping_revision_stale' },
          nowMs: input.nowMs
        });
        results.push(completed
          ? { kind: 'attention', workId: claim.workId }
          : { kind: 'lost_fence', workId: claim.workId });
        continue;
      }
      entries.push({ claim, projection, target });
    }
    if (entries.length === 0) return results.length === 0
      ? { kind: 'idle' }
      : { kind: 'processed', results: Object.freeze(results) };

    const grouped = new Map<string, AirtableOutboundEntry[]>();
    for (const entry of entries) {
      const key = `${entry.target.baseId}\u0000${entry.target.tableId}`;
      const group = grouped.get(key) ?? [];
      group.push(entry);
      grouped.set(key, group);
    }
    for (const group of grouped.values()) {
      const written = await writeAirtableProjectionBatch({
        entries: group,
        provider: input.provider,
        ...(input.throttle ? { throttle: input.throttle } : {}),
        nowMs: input.nowMs
      });
      for (const [index, entry] of group.entries()) {
        const result = written[index]!;
        const outcome = result.kind === 'applied' || result.kind === 'already_current'
          ? {
              kind: 'succeeded' as const,
              providerRecordId: result.providerRecordId,
              providerFingerprint: result.providerFingerprint,
              providerTableId: entry.target.tableId,
              projection: entry.projection
            }
          : result.kind === 'retry'
            ? {
                kind: 'retry' as const,
                code: result.code,
                notBeforeMs: input.nowMs + result.retryAfterMs
              }
            : result.kind === 'acceptance_unknown'
              ? { kind: 'reconcile_first' as const, code: result.code }
              : { kind: 'attention' as const, code: result.code };
        const completed = await input.repository.complete({
          claim: entry.claim,
          outcome,
          nowMs: input.nowMs
        });
        results.push(!completed
          ? { kind: 'lost_fence', workId: entry.claim.workId }
          : outcome.kind === 'succeeded'
            ? { kind: 'completed', workId: entry.claim.workId }
            : outcome.kind === 'retry'
              ? { kind: 'retry_scheduled', workId: entry.claim.workId }
              : outcome.kind === 'reconcile_first'
                ? { kind: 'reconciliation_required', workId: entry.claim.workId }
                : { kind: 'attention', workId: entry.claim.workId });
      }
    }
    return { kind: 'processed', results: Object.freeze(results) };
  } finally {
    await input.repository.releaseConnection({ lease, nowMs: input.nowMs });
  }
}
