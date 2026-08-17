import { canonicalJsonText, type CanonicalJson } from '@jooevents/kernel';
import type { FieldSyncMode } from './mapping';

export interface SyncFieldState {
  readonly fieldKey: string;
  readonly mode: FieldSyncMode;
  readonly base: CanonicalJson;
  readonly local: CanonicalJson;
  readonly remote: CanonicalJson;
  readonly lastOutbound?: CanonicalJson;
}

export type FieldComparisonDisposition =
  | 'unchanged'
  | 'outbound'
  | 'echo'
  | 'converged'
  | 'apply_inbound'
  | 'create_request'
  | 'restore'
  | 'forbidden'
  | 'conflict';

export interface FieldComparison {
  readonly fieldKey: string;
  readonly mode: FieldSyncMode;
  readonly localChanged: boolean;
  readonly remoteChanged: boolean;
  readonly disposition: FieldComparisonDisposition;
}

function equal(left: CanonicalJson, right: CanonicalJson): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

export function compareSyncField(field: SyncFieldState): FieldComparison {
  const localChanged = !equal(field.local, field.base);
  const remoteChanged = !equal(field.remote, field.base);
  let disposition: FieldComparisonDisposition;
  if (!localChanged && !remoteChanged) {
    disposition = 'unchanged';
  } else if (localChanged && !remoteChanged) {
    disposition = 'outbound';
  } else if (localChanged && remoteChanged && equal(field.local, field.remote)) {
    disposition = field.lastOutbound !== undefined && equal(field.remote, field.lastOutbound)
      ? 'echo'
      : 'converged';
  } else if (localChanged && remoteChanged) {
    disposition = 'conflict';
  } else if (field.mode === 'editable_in_airtable') {
    disposition = 'apply_inbound';
  } else if (field.mode === 'request_from_airtable') {
    disposition = 'create_request';
  } else if (field.mode === 'view_in_airtable') {
    disposition = 'restore';
  } else {
    disposition = 'forbidden';
  }
  return Object.freeze({
    fieldKey: field.fieldKey,
    mode: field.mode,
    localChanged,
    remoteChanged,
    disposition
  });
}

export interface RecordComparison {
  readonly fields: readonly FieldComparison[];
  readonly hasConflict: boolean;
  readonly needsOutbound: boolean;
  readonly needsInbound: boolean;
  readonly needsReview: boolean;
}

export function compareSyncRecord(fields: readonly SyncFieldState[]): RecordComparison {
  const seen = new Set<string>();
  const comparisons = fields.map((field) => {
    if (seen.has(field.fieldKey)) throw new TypeError('sync_field_duplicate');
    seen.add(field.fieldKey);
    return compareSyncField(field);
  }).sort((left, right) => left.fieldKey.localeCompare(right.fieldKey));
  return Object.freeze({
    fields: Object.freeze(comparisons),
    hasConflict: comparisons.some((field) => field.disposition === 'conflict'),
    needsOutbound: comparisons.some((field) =>
      field.disposition === 'outbound' || field.disposition === 'restore'
    ),
    needsInbound: comparisons.some((field) => field.disposition === 'apply_inbound'),
    needsReview: comparisons.some((field) => field.disposition === 'create_request')
  });
}
