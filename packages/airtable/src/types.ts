import type { Brand, CanonicalJson } from '@jooevents/kernel';

export type AirtableWorkspaceId = Brand<string, 'AirtableWorkspaceId'>;
export type AirtableBaseId = Brand<string, 'AirtableBaseId'>;
export type AirtableTableId = Brand<string, 'AirtableTableId'>;
export type AirtableFieldId = Brand<string, 'AirtableFieldId'>;
export type AirtableRecordId = Brand<string, 'AirtableRecordId'>;
export type AirtableWebhookId = Brand<string, 'AirtableWebhookId'>;
export type AirtableUserId = Brand<string, 'AirtableUserId'>;
export type AirtableCursor = Brand<string, 'AirtableCursor'>;

const PROVIDER_ID = /^[A-Za-z0-9_-]{3,128}$/;

function providerId<Name extends string>(value: unknown, name: Name): Brand<string, Name> {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) {
    throw new TypeError(`${name}_invalid`);
  }
  return value as Brand<string, Name>;
}

export const parseAirtableWorkspaceId = (value: unknown): AirtableWorkspaceId =>
  providerId(value, 'AirtableWorkspaceId');
export const parseAirtableBaseId = (value: unknown): AirtableBaseId =>
  providerId(value, 'AirtableBaseId');
export const parseAirtableTableId = (value: unknown): AirtableTableId =>
  providerId(value, 'AirtableTableId');
export const parseAirtableFieldId = (value: unknown): AirtableFieldId =>
  providerId(value, 'AirtableFieldId');
export const parseAirtableRecordId = (value: unknown): AirtableRecordId =>
  providerId(value, 'AirtableRecordId');
export const parseAirtableWebhookId = (value: unknown): AirtableWebhookId =>
  providerId(value, 'AirtableWebhookId');
export const parseAirtableUserId = (value: unknown): AirtableUserId =>
  providerId(value, 'AirtableUserId');
export const parseAirtableCursor = (value: unknown): AirtableCursor => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new TypeError('AirtableCursor_invalid');
  }
  return value as AirtableCursor;
};

export const AIRTABLE_OAUTH_SCOPES = [
  'data.records:read',
  'data.records:write',
  'schema.bases:read',
  'schema.bases:write',
  'webhook:manage',
  'user.email:read'
] as const;

export type AirtableOAuthScope = (typeof AIRTABLE_OAUTH_SCOPES)[number];
export type AirtableCellValue = CanonicalJson;

export type AirtableFieldType =
  | 'singleLineText'
  | 'multilineText'
  | 'email'
  | 'phoneNumber'
  | 'url'
  | 'checkbox'
  | 'number'
  | 'date'
  | 'dateTime'
  | 'singleSelect'
  | 'multipleSelects'
  | 'multipleRecordLinks'
  | 'formula'
  | 'lookup'
  | 'multipleLookupValues'
  | 'rollup'
  | 'count'
  | 'createdTime'
  | 'lastModifiedTime';

export interface AirtableSelectChoice {
  readonly name: string;
  readonly color?: string;
}

export interface AirtableFieldSchema {
  readonly id: AirtableFieldId;
  readonly name: string;
  /** Provider-observed type. It may be newer than the finite set JooEvents can create. */
  readonly type: string;
  readonly description?: string;
  readonly options?: Readonly<Record<string, CanonicalJson>>;
}

export interface AirtableTableSchema {
  readonly id: AirtableTableId;
  readonly name: string;
  readonly description?: string;
  readonly primaryFieldId: AirtableFieldId;
  readonly fields: readonly AirtableFieldSchema[];
  readonly views: readonly AirtableViewSchema[];
}

export interface AirtableViewSchema {
  readonly id: string;
  readonly name: string;
  readonly type: 'grid' | 'form' | 'calendar' | 'gallery' | 'kanban' | 'timeline' | 'block';
  readonly visibleFieldIds?: readonly AirtableFieldId[];
}

export interface AirtableBaseSchema {
  readonly id: AirtableBaseId;
  readonly name?: string;
  readonly workspaceId?: AirtableWorkspaceId;
  readonly tables: readonly AirtableTableSchema[];
}

export interface AirtableBaseSummary {
  readonly id: AirtableBaseId;
  readonly name: string;
  readonly permissionLevel: 'none' | 'read' | 'comment' | 'edit' | 'create';
}

export interface AirtableBasePage {
  readonly bases: readonly AirtableBaseSummary[];
  readonly offset?: string;
}

export interface AirtableGrantIdentity {
  readonly userId: AirtableUserId;
  readonly email?: string;
  readonly scopes: readonly AirtableOAuthScope[];
}

export interface AirtableRecord {
  readonly id: AirtableRecordId;
  readonly createdTime: string;
  readonly fields: Readonly<Record<AirtableFieldId, AirtableCellValue>>;
}

export interface AirtableRecordPage {
  readonly records: readonly AirtableRecord[];
  readonly offset?: string;
}

export type AirtableFailureCode =
  | 'rate_limited'
  | 'grant_revoked'
  | 'resource_forbidden'
  | 'not_found'
  | 'schema_mismatch'
  | 'validation_failed'
  | 'multiple_matches'
  | 'webhook_invalid'
  | 'payload_retention_missed'
  | 'temporary_unavailable'
  | 'response_invalid'
  | 'acceptance_unknown';

export interface AirtableProviderFailure {
  readonly code: AirtableFailureCode;
  readonly retry: 'never' | 'after_delay' | 'reconcile_first' | 'reconnect';
  readonly safeMessage: string;
  readonly retryAfterMs?: number;
  readonly providerRequestId?: string;
}

export type AirtableProviderResult<Value> =
  | { readonly kind: 'success'; readonly value: Value }
  | { readonly kind: 'failure'; readonly failure: AirtableProviderFailure };

export interface AirtableWriteRecord {
  readonly recordId?: AirtableRecordId;
  readonly fields: Readonly<Record<AirtableFieldId, AirtableCellValue>>;
}

export type AirtableWriteDisposition =
  | {
      readonly kind: 'created' | 'updated';
      readonly requestIndex: number;
      readonly record: AirtableRecord;
    }
  | {
      readonly kind: 'failed';
      readonly requestIndex: number;
      readonly failure: AirtableProviderFailure;
    };

export interface AirtableBatchWriteResult {
  readonly records: readonly AirtableWriteDisposition[];
}

export type AirtableWebhookSource =
  | 'client'
  | 'publicApi'
  | 'formSubmission'
  | 'automation'
  | 'system'
  | 'sync'
  | 'unknown';

export interface AirtableWebhookActor {
  readonly id: AirtableUserId;
  readonly email?: string;
  readonly displayName?: string;
}

export interface AirtableWebhookRecordChange {
  readonly tableId: AirtableTableId;
  readonly recordId: AirtableRecordId;
  readonly changedFieldIds: readonly AirtableFieldId[];
  readonly kind: 'created' | 'updated' | 'destroyed';
}

export interface AirtableWebhookPayload {
  readonly transactionNumber: number;
  readonly timestamp: string;
  readonly source: AirtableWebhookSource;
  readonly actor?: AirtableWebhookActor;
  readonly changes: readonly AirtableWebhookRecordChange[];
}

export interface AirtableWebhookPayloadPage {
  readonly cursor: AirtableCursor;
  readonly mightHaveMore: boolean;
  readonly payloads: readonly AirtableWebhookPayload[];
}

export interface AirtableWebhookNotification {
  readonly baseId: AirtableBaseId;
  readonly webhookId: AirtableWebhookId;
  readonly timestamp: string;
}

/** Parse the workspace page a person copies from Airtable without asking for an ID. */
export function parseAirtableWorkspaceUrl(value: unknown): AirtableWorkspaceId {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new TypeError('AirtableWorkspaceUrl_invalid');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('AirtableWorkspaceUrl_invalid');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'airtable.com' || url.username || url.password) {
    throw new TypeError('AirtableWorkspaceUrl_invalid');
  }
  const match = /^\/workspaces\/(wsp[A-Za-z0-9_-]{3,125})\/?$/u.exec(url.pathname);
  if (!match?.[1]) throw new TypeError('AirtableWorkspaceUrl_invalid');
  return parseAirtableWorkspaceId(match[1]);
}

/** Parse a base page a person copies from Airtable without asking for an ID. */
export function parseAirtableBaseUrl(value: unknown): AirtableBaseId {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new TypeError('AirtableBaseUrl_invalid');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('AirtableBaseUrl_invalid');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'airtable.com' || url.username || url.password) {
    throw new TypeError('AirtableBaseUrl_invalid');
  }
  const match = /^\/(app[A-Za-z0-9_-]{3,125})(?:\/[^/]*)*\/?$/u.exec(url.pathname);
  if (!match?.[1]) throw new TypeError('AirtableBaseUrl_invalid');
  return parseAirtableBaseId(match[1]);
}
