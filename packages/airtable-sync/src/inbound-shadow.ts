import type {
  AirtableBaseId,
  AirtableCursor,
  AirtableFieldId,
  AirtableProviderFailure,
  AirtableRecordId,
  AirtableTableId,
  AirtableWebhookActor,
  AirtableWebhookId,
  AirtableWebhookPayload,
  AirtableWebhookPort,
  AirtableWebhookSource
} from '@jooevents/airtable';
import type { CanonicalJson } from '@jooevents/kernel';
import {
  compareSyncRecord,
  type FieldComparisonDisposition
} from './comparison';
import type { FieldPolicy, FieldSyncMode } from './mapping';

export interface AirtableInboundCursorState {
  readonly connectionId: string;
  readonly mappingRevision: number;
  readonly baseId: AirtableBaseId;
  readonly webhookId: AirtableWebhookId;
  readonly cursor?: AirtableCursor;
  readonly lastTransactionNumber: number;
}

export interface AirtableSettleCandidate {
  readonly tableId: AirtableTableId;
  readonly recordId: AirtableRecordId;
  readonly transactionNumber: number;
  readonly kind: 'created' | 'updated' | 'destroyed';
  readonly changedFieldIds: readonly AirtableFieldId[];
  readonly source: AirtableWebhookSource;
  readonly actor?: AirtableWebhookActor;
  readonly observedAt: string;
}

export interface AirtableInboundCursorRepository {
  read(connectionId: string): Promise<AirtableInboundCursorState | undefined>;
  commitPage(input: Readonly<{
    state: AirtableInboundCursorState;
    nextCursor: AirtableCursor;
    nextTransactionNumber: number;
    candidates: readonly AirtableSettleCandidate[];
    settleNotBeforeMs: number;
    nowMs: number;
  }>): Promise<boolean>;
}

export type AirtableInboundCursorResult =
  | { readonly kind: 'processed'; readonly pages: number; readonly candidates: number }
  | { readonly kind: 'retention_recovery_required' }
  | { readonly kind: 'contended' }
  | { readonly kind: 'retry'; readonly code: string; readonly retryAfterMs: number }
  | { readonly kind: 'attention'; readonly code: string };

function failure(failure: AirtableProviderFailure): AirtableInboundCursorResult {
  if (failure.retry === 'after_delay') {
    return {
      kind: 'retry',
      code: failure.code,
      retryAfterMs: Math.max(1_000, Math.min(failure.retryAfterMs ?? 30_000, 86_400_000))
    };
  }
  return { kind: 'attention', code: failure.code };
}

function candidateKey(tableId: AirtableTableId, recordId: AirtableRecordId): string {
  return `${tableId}\u0000${recordId}`;
}

function candidatesAfter(
  payloads: readonly AirtableWebhookPayload[],
  lastTransactionNumber: number
): readonly AirtableSettleCandidate[] {
  const reduced = new Map<string, AirtableSettleCandidate>();
  for (const payload of [...payloads].sort((left, right) =>
    left.transactionNumber - right.transactionNumber || left.timestamp.localeCompare(right.timestamp)
  )) {
    if (payload.transactionNumber <= lastTransactionNumber) continue;
    for (const change of payload.changes) {
      const key = candidateKey(change.tableId, change.recordId);
      const current = reduced.get(key);
      if (current && current.transactionNumber === payload.transactionNumber) {
        reduced.set(key, Object.freeze({
          ...current,
          kind: change.kind,
          changedFieldIds: Object.freeze([...new Set([
            ...current.changedFieldIds,
            ...change.changedFieldIds
          ])].sort()),
          source: payload.source,
          ...(payload.actor ? { actor: payload.actor } : {}),
          observedAt: payload.timestamp
        }));
        continue;
      }
      reduced.set(key, Object.freeze({
        tableId: change.tableId,
        recordId: change.recordId,
        transactionNumber: payload.transactionNumber,
        kind: change.kind,
        changedFieldIds: Object.freeze([...new Set(change.changedFieldIds)].sort()),
        source: payload.source,
        ...(payload.actor ? { actor: payload.actor } : {}),
        observedAt: payload.timestamp
      }));
    }
  }
  return Object.freeze([...reduced.values()].sort((left, right) =>
    left.transactionNumber - right.transactionNumber
    || left.tableId.localeCompare(right.tableId)
    || left.recordId.localeCompare(right.recordId)
  ));
}

function transactionNumbers(payloads: readonly AirtableWebhookPayload[]): readonly number[] {
  return Object.freeze([...new Set(payloads.map((payload) => payload.transactionNumber))]
    .sort((left, right) => left - right));
}

/**
 * Fetches provider pages strictly from the durable cursor. Queue order is irrelevant;
 * each cursor advance and its coalesced settle candidates commit together.
 */
export async function processAirtableWebhookCursor(input: Readonly<{
  connectionId: string;
  repository: AirtableInboundCursorRepository;
  webhooks: AirtableWebhookPort;
  nowMs: number;
  settleDelayMs?: number;
  maximumPages?: number;
}>): Promise<AirtableInboundCursorResult> {
  const settleDelayMs = input.settleDelayMs ?? 3_000;
  const maximumPages = input.maximumPages ?? 5;
  if (!Number.isSafeInteger(settleDelayMs) || settleDelayMs < 1_000 || settleDelayMs > 60_000) {
    throw new TypeError('airtable_settle_delay_invalid');
  }
  if (!Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 20) {
    throw new TypeError('airtable_cursor_page_bound_invalid');
  }
  let state = await input.repository.read(input.connectionId);
  if (!state) return { kind: 'attention', code: 'webhook_registration_missing' };
  let pages = 0;
  let scheduled = 0;
  while (pages < maximumPages) {
    const listed = await input.webhooks.listWebhookPayloads({
      baseId: state.baseId,
      webhookId: state.webhookId,
      ...(state.cursor ? { cursor: state.cursor } : {})
    });
    if (listed.kind === 'failure') return failure(listed.failure);
    const numbers = transactionNumbers(listed.value.payloads);
    const newNumbers = numbers.filter((number) => number > state!.lastTransactionNumber);
    let expectedTransactionNumber = state.lastTransactionNumber + 1;
    for (const number of newNumbers) {
      if (number !== expectedTransactionNumber) {
        // The provider no longer retains every transaction after our cursor.
        // Advance past this incomplete page without accepting its partial change
        // set. The live worker must reconcile all managed records from their
        // durable last-common baselines before inbound apply resumes.
        const recovered = await input.repository.commitPage({
          state,
          nextCursor: listed.value.cursor,
          nextTransactionNumber: Math.max(state.lastTransactionNumber, ...numbers),
          candidates: Object.freeze([]),
          settleNotBeforeMs: input.nowMs + settleDelayMs,
          nowMs: input.nowMs
        });
        return recovered ? { kind: 'retention_recovery_required' } : { kind: 'contended' };
      }
      expectedTransactionNumber += 1;
    }
    const nextTransactionNumber = Math.max(
      state.lastTransactionNumber,
      ...numbers
    );
    const pageCandidates = candidatesAfter(listed.value.payloads, state.lastTransactionNumber);
    if (listed.value.mightHaveMore && listed.value.cursor === state.cursor) {
      return { kind: 'attention', code: 'webhook_cursor_stalled' };
    }
    const committed = await input.repository.commitPage({
      state,
      nextCursor: listed.value.cursor,
      nextTransactionNumber,
      candidates: pageCandidates,
      settleNotBeforeMs: input.nowMs + settleDelayMs,
      nowMs: input.nowMs
    });
    if (!committed) return { kind: 'contended' };
    pages += 1;
    scheduled += pageCandidates.length;
    state = Object.freeze({
      ...state,
      cursor: listed.value.cursor,
      lastTransactionNumber: nextTransactionNumber
    });
    if (!listed.value.mightHaveMore) {
      return { kind: 'processed', pages, candidates: scheduled };
    }
  }
  return { kind: 'retry', code: 'webhook_pages_remaining', retryAfterMs: 1_000 };
}

export interface AirtableShadowFieldMapping {
  readonly fieldKey: string;
  readonly fieldId: AirtableFieldId;
  readonly mode: FieldSyncMode;
  readonly dataClassification: FieldPolicy['dataClassification'];
}

export interface AirtableShadowFieldFinding {
  readonly fieldKey: string;
  readonly fieldId: AirtableFieldId;
  readonly mode: FieldSyncMode;
  readonly dataClassification: FieldPolicy['dataClassification'];
  readonly base: CanonicalJson;
  readonly local: CanonicalJson;
  readonly remote: CanonicalJson;
  readonly disposition: FieldComparisonDisposition;
}

export interface AirtableShadowEvaluation {
  readonly fields: readonly AirtableShadowFieldFinding[];
  readonly hasConflict: boolean;
  readonly needsOutbound: boolean;
  readonly wouldApplyInbound: boolean;
  readonly wouldCreateRequest: boolean;
}

/** Three-way result only. It has no operation or mutation port by design. */
export function evaluateAirtableShadowRecord(input: Readonly<{
  mappings: readonly AirtableShadowFieldMapping[];
  baseline: Readonly<Record<string, CanonicalJson>>;
  local: Readonly<Record<string, CanonicalJson>>;
  remote: Readonly<Record<AirtableFieldId, CanonicalJson>>;
  lastOutbound?: Readonly<Record<string, CanonicalJson>>;
}>): AirtableShadowEvaluation {
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const states = input.mappings.map((mapping) => {
    if (seenKeys.has(mapping.fieldKey) || seenIds.has(mapping.fieldId)) {
      throw new TypeError('airtable_shadow_mapping_duplicate');
    }
    seenKeys.add(mapping.fieldKey);
    seenIds.add(mapping.fieldId);
    return {
      fieldKey: mapping.fieldKey,
      mode: mapping.mode,
      base: input.baseline[mapping.fieldKey] ?? null,
      local: input.local[mapping.fieldKey] ?? null,
      remote: input.remote[mapping.fieldId] ?? null,
      ...(input.lastOutbound && Object.hasOwn(input.lastOutbound, mapping.fieldKey)
        ? { lastOutbound: input.lastOutbound[mapping.fieldKey]! }
        : {})
    };
  });
  const comparison = compareSyncRecord(states);
  const byKey = new Map(comparison.fields.map((field) => [field.fieldKey, field]));
  const findings = input.mappings.map((mapping) => Object.freeze({
    ...mapping,
    base: input.baseline[mapping.fieldKey] ?? null,
    local: input.local[mapping.fieldKey] ?? null,
    remote: input.remote[mapping.fieldId] ?? null,
    disposition: byKey.get(mapping.fieldKey)!.disposition
  })).sort((left, right) => left.fieldKey.localeCompare(right.fieldKey));
  return Object.freeze({
    fields: Object.freeze(findings),
    hasConflict: comparison.hasConflict,
    needsOutbound: comparison.needsOutbound,
    wouldApplyInbound: comparison.needsInbound,
    wouldCreateRequest: comparison.needsReview
  });
}

export interface AirtableShadowSettleClaim {
  readonly settleId: string;
  readonly connectionId: string;
  readonly mappingRevision: number;
  readonly providerTableId: AirtableTableId;
  readonly providerRecordId: AirtableRecordId;
  readonly transactionNumber: number;
  /** Durable settle-head revision; changes only when a newer wake supersedes it. */
  readonly settleRevision?: number;
  readonly changeKind: 'created' | 'updated' | 'destroyed';
  readonly providerSource?: string;
  readonly providerActor?: Readonly<{
    readonly id?: string;
    readonly email?: string;
    readonly displayName?: string;
  }>;
  readonly observedAtMs?: number;
  readonly workerId: string;
  readonly leaseVersion: number;
}

export interface AirtableShadowSettleContext {
  readonly baseId: AirtableBaseId;
  readonly recordLinkId: string;
  readonly mappings: readonly AirtableShadowFieldMapping[];
  readonly baseline: Readonly<Record<string, CanonicalJson>>;
  readonly local: Readonly<Record<string, CanonicalJson>>;
  readonly lastOutbound?: Readonly<Record<string, CanonicalJson>>;
  readonly subject?: Readonly<{
    kind: 'task_assignment' | 'engagement';
    id: string;
    expectedVersion: number;
  }>;
}

export interface AirtableShadowSettleRepository {
  claimNext(input: Readonly<{
    connectionId: string;
    workerId: string;
    nowMs: number;
  }>): Promise<AirtableShadowSettleClaim | undefined>;
  resolveContext(claim: AirtableShadowSettleClaim): Promise<AirtableShadowSettleContext | undefined>;
  complete(input: Readonly<{
    claim: AirtableShadowSettleClaim;
    outcome:
      | { readonly kind: 'observed'; readonly evaluation: AirtableShadowEvaluation }
      | { readonly kind: 'retry'; readonly code: string; readonly notBeforeMs: number }
      | { readonly kind: 'attention'; readonly code: string };
    nowMs: number;
  }>): Promise<boolean>;
}

export type AirtableShadowSettleResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'observed' | 'retry_scheduled' | 'attention' | 'lost_fence'; readonly settleId: string };

/** Settles one record by re-reading Airtable, then persists shadow findings only. */
export async function processOneAirtableShadowSettle(input: Readonly<{
  connectionId: string;
  workerId: string;
  nowMs: number;
  repository: AirtableShadowSettleRepository;
  provider: import('@jooevents/airtable').AirtableDataPort;
}>): Promise<AirtableShadowSettleResult> {
  const claim = await input.repository.claimNext({
    connectionId: input.connectionId,
    workerId: input.workerId,
    nowMs: input.nowMs
  });
  if (!claim) return { kind: 'idle' };
  const context = await input.repository.resolveContext(claim);
  let outcome: Parameters<AirtableShadowSettleRepository['complete']>[0]['outcome'];
  if (!context || claim.mappingRevision < 1) {
    outcome = { kind: 'attention', code: 'mapping_or_record_link_stale' };
  } else {
    const reread = await input.provider.getRecord({
      baseId: context.baseId,
      tableId: claim.providerTableId,
      recordId: claim.providerRecordId
    });
    if (reread.kind === 'success') {
      outcome = {
        kind: 'observed',
        evaluation: evaluateAirtableShadowRecord({
          mappings: context.mappings,
          baseline: context.baseline,
          local: context.local,
          remote: reread.value.fields,
          ...(context.lastOutbound ? { lastOutbound: context.lastOutbound } : {})
        })
      };
    } else if (claim.changeKind === 'destroyed' && reread.failure.code === 'not_found') {
      outcome = {
        kind: 'observed',
        evaluation: evaluateAirtableShadowRecord({
          mappings: context.mappings,
          baseline: context.baseline,
          local: context.local,
          remote: Object.freeze({}),
          ...(context.lastOutbound ? { lastOutbound: context.lastOutbound } : {})
        })
      };
    } else if (reread.failure.retry === 'after_delay') {
      outcome = {
        kind: 'retry',
        code: reread.failure.code,
        notBeforeMs: input.nowMs + Math.max(
          1_000,
          Math.min(reread.failure.retryAfterMs ?? 30_000, 86_400_000)
        )
      };
    } else {
      outcome = { kind: 'attention', code: reread.failure.code };
    }
  }
  const completed = await input.repository.complete({ claim, outcome, nowMs: input.nowMs });
  if (!completed) return { kind: 'lost_fence', settleId: claim.settleId };
  return outcome.kind === 'observed'
    ? { kind: 'observed', settleId: claim.settleId }
    : outcome.kind === 'retry'
      ? { kind: 'retry_scheduled', settleId: claim.settleId }
      : { kind: 'attention', settleId: claim.settleId };
}
