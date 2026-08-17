import type {
  AirtableBaseId,
  AirtableDataPort,
  AirtableFieldId,
  AirtableTableId
} from '@jooevents/airtable';
import { canonicalJsonSha256, type CanonicalJson } from '@jooevents/kernel';

export interface ReconciliationLink {
  readonly recordLinkId: string;
  readonly subjectKey: string;
  readonly providerRecordId: string;
  readonly baseline: Readonly<Record<string, CanonicalJson>>;
}

export interface ReconciliationProviderRecord {
  readonly providerRecordId: string;
  readonly subjectKey?: string;
  readonly fields: Readonly<Record<string, CanonicalJson>>;
}

export type ReconciliationFinding =
  | { readonly kind: 'missing'; readonly subjectKey: string; readonly recordLinkId: string }
  | { readonly kind: 'duplicate'; readonly subjectKey: string; readonly providerRecordIds: readonly string[] }
  | { readonly kind: 'orphan'; readonly providerRecordId: string; readonly subjectKey?: string }
  | { readonly kind: 'record_id_changed'; readonly subjectKey: string; readonly expectedRecordId: string; readonly actualRecordId: string };

/** Stable-ID inventory comparison; it never infers identity from a display name. */
export function assessAirtableRecordInventory(input: Readonly<{
  links: readonly ReconciliationLink[];
  providerRecords: readonly ReconciliationProviderRecord[];
}>): readonly ReconciliationFinding[] {
  const links = new Map(input.links.map((link) => [link.subjectKey, link]));
  if (links.size !== input.links.length) throw new TypeError('airtable_reconciliation_link_duplicate');
  const providerBySubject = new Map<string, ReconciliationProviderRecord[]>();
  for (const record of input.providerRecords) {
    if (!record.subjectKey) continue;
    const rows = providerBySubject.get(record.subjectKey) ?? [];
    rows.push(record);
    providerBySubject.set(record.subjectKey, rows);
  }
  const findings: ReconciliationFinding[] = [];
  for (const link of input.links) {
    const records = providerBySubject.get(link.subjectKey) ?? [];
    if (records.length === 0) {
      findings.push({ kind: 'missing', subjectKey: link.subjectKey, recordLinkId: link.recordLinkId });
    } else if (records.length > 1) {
      findings.push({ kind: 'duplicate', subjectKey: link.subjectKey,
        providerRecordIds: Object.freeze(records.map((record) => record.providerRecordId).sort()) });
    } else if (records[0]!.providerRecordId !== link.providerRecordId) {
      findings.push({ kind: 'record_id_changed', subjectKey: link.subjectKey,
        expectedRecordId: link.providerRecordId, actualRecordId: records[0]!.providerRecordId });
    }
  }
  for (const record of input.providerRecords) {
    if (!record.subjectKey || !links.has(record.subjectKey)) {
      findings.push({ kind: 'orphan', providerRecordId: record.providerRecordId,
        ...(record.subjectKey ? { subjectKey: record.subjectKey } : {}) });
    }
  }
  return Object.freeze(findings.sort((left, right) => {
    const leftKey = 'subjectKey' in left ? left.subjectKey ?? '' : left.providerRecordId;
    const rightKey = 'subjectKey' in right ? right.subjectKey ?? '' : right.providerRecordId;
    return leftKey.localeCompare(rightKey) || left.kind.localeCompare(right.kind);
  }));
}

export interface AirtableSyncHealthInput {
  readonly state: 'active' | 'paused' | 'needs_reconnect' | 'disconnected';
  readonly nowMs: number;
  readonly lastOutboundAtMs?: number;
  readonly lastInboundAtMs?: number;
  readonly webhookExpiresAtMs?: number;
  readonly dueWork: number;
  readonly conflicts: number;
  readonly requests: number;
  readonly schemaDrift: number;
  readonly deadLetters: number;
}

export type AirtableSyncHealthState = 'current' | 'pending' | 'needs_review' | 'delayed' | 'paused' | 'needs_reconnect' | 'disconnected';

export function deriveAirtableSyncHealth(input: AirtableSyncHealthInput): Readonly<{
  state: AirtableSyncHealthState;
  attentionCount: number;
  nextAction: 'none' | 'wait' | 'review' | 'reconnect';
}> {
  if (input.state !== 'active') {
    return { state: input.state, attentionCount: 0,
      nextAction: input.state === 'needs_reconnect' ? 'reconnect' : 'none' };
  }
  const attentionCount = input.conflicts + input.requests + input.schemaDrift + input.deadLetters;
  if (attentionCount > 0) return { state: 'needs_review', attentionCount, nextAction: 'review' };
  const expired = input.webhookExpiresAtMs !== undefined && input.webhookExpiresAtMs <= input.nowMs;
  const lastActivity = Math.max(input.lastOutboundAtMs ?? 0, input.lastInboundAtMs ?? 0);
  if (expired || input.dueWork > 0 && input.nowMs - lastActivity > 15 * 60_000) {
    return { state: 'delayed', attentionCount: input.dueWork, nextAction: expired ? 'reconnect' : 'wait' };
  }
  if (input.dueWork > 0) return { state: 'pending', attentionCount: input.dueWork, nextAction: 'wait' };
  return { state: 'current', attentionCount: 0, nextAction: 'none' };
}

export function airtableReconciliationCadence(input: Readonly<{
  nowMs: number; lastLightweightAtMs?: number; lastFullAtMs?: number; webhookExpiresAtMs?: number;
}>): Readonly<{ lightweightDue: boolean; fullDue: boolean; renewalDue: boolean }> {
  return Object.freeze({
    lightweightDue: input.lastLightweightAtMs === undefined || input.nowMs - input.lastLightweightAtMs >= 5 * 60_000,
    fullDue: input.lastFullAtMs === undefined || input.nowMs - input.lastFullAtMs >= 24 * 60 * 60_000,
    renewalDue: input.webhookExpiresAtMs !== undefined && input.webhookExpiresAtMs - input.nowMs <= 24 * 60 * 60_000
  });
}

export interface AirtableReconciliationClaim {
  readonly runId: string;
  readonly connectionId: string;
  readonly mappingRevision: number;
  readonly areaKey: string;
  readonly baseId: AirtableBaseId;
  readonly tableId: AirtableTableId;
  readonly stableIdFieldId: AirtableFieldId;
  readonly comparedFieldIds: readonly AirtableFieldId[];
  readonly providerOffset?: string;
  readonly workerId: string;
  readonly leaseVersion: number;
}

export interface AirtableReconciliationPageRecord {
  readonly providerRecordId: string;
  readonly subjectKey?: string;
  readonly providerFingerprintSha256: string;
}

export interface AirtableReconciliationRepository {
  claimNext(input: Readonly<{
    connectionId: string;
    workerId: string;
    nowMs: number;
    leaseMs: number;
  }>): Promise<AirtableReconciliationClaim | undefined>;
  commitProviderPage(input: Readonly<{
    claim: AirtableReconciliationClaim;
    records: readonly AirtableReconciliationPageRecord[];
    nextOffset?: string;
    nowMs: number;
  }>): Promise<'more' | 'ready_to_assess' | 'lost_fence'>;
  fail(input: Readonly<{
    claim: AirtableReconciliationClaim;
    code: string;
    retryAtMs?: number;
    nowMs: number;
  }>): Promise<boolean>;
}

export type AirtableReconciliationScanResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'page_recorded'; readonly runId: string; readonly records: number }
  | { readonly kind: 'ready_to_assess'; readonly runId: string; readonly records: number }
  | { readonly kind: 'retry_scheduled' | 'attention' | 'lost_fence'; readonly runId: string };

/**
 * Scans one bounded provider page into durable run inventory. Assessment and
 * repair happen only after the final page, so provider page order cannot hide
 * duplicates, orphans, or record-ID replacement.
 */
export async function scanOneAirtableReconciliationPage(input: Readonly<{
  connectionId: string;
  workerId: string;
  nowMs: number;
  repository: AirtableReconciliationRepository;
  provider: AirtableDataPort;
  pageSize?: number;
}>): Promise<AirtableReconciliationScanResult> {
  const pageSize = input.pageSize ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('airtable_reconciliation_page_size_invalid');
  }
  const claim = await input.repository.claimNext({
    connectionId: input.connectionId,
    workerId: input.workerId,
    nowMs: input.nowMs,
    leaseMs: 30_000
  });
  if (!claim) return { kind: 'idle' };
  const fieldIds = Object.freeze([...new Set([
    claim.stableIdFieldId,
    ...claim.comparedFieldIds
  ])].sort());
  const listed = await input.provider.listRecords({
    baseId: claim.baseId,
    tableId: claim.tableId,
    fieldIds,
    pageSize,
    ...(claim.providerOffset ? { offset: claim.providerOffset } : {})
  });
  if (listed.kind === 'failure') {
    const retryAtMs = listed.failure.retry === 'after_delay'
      ? input.nowMs + Math.max(1_000, Math.min(listed.failure.retryAfterMs ?? 30_000, 86_400_000))
      : undefined;
    const completed = await input.repository.fail({
      claim,
      code: listed.failure.code,
      ...(retryAtMs === undefined ? {} : { retryAtMs }),
      nowMs: input.nowMs
    });
    return {
      kind: completed
        ? retryAtMs === undefined ? 'attention' : 'retry_scheduled'
        : 'lost_fence',
      runId: claim.runId
    };
  }
  const records = Object.freeze(listed.value.records.map((record) => {
    const stable = record.fields[claim.stableIdFieldId];
    const subjectKey = typeof stable === 'string' && stable.length > 0 && stable.length <= 256
      ? stable.normalize('NFC')
      : undefined;
    const compared = Object.fromEntries(fieldIds.map((fieldId) => [
      fieldId,
      Object.hasOwn(record.fields, fieldId) ? record.fields[fieldId] : null
    ]));
    return Object.freeze({
      providerRecordId: record.id,
      ...(subjectKey ? { subjectKey } : {}),
      providerFingerprintSha256: canonicalJsonSha256(compared)
    });
  }));
  const committed = await input.repository.commitProviderPage({
    claim,
    records,
    ...(listed.value.offset ? { nextOffset: listed.value.offset } : {}),
    nowMs: input.nowMs
  });
  return committed === 'lost_fence'
    ? { kind: 'lost_fence', runId: claim.runId }
    : {
        kind: committed === 'more' ? 'page_recorded' : 'ready_to_assess',
        runId: claim.runId,
        records: records.length
      };
}
