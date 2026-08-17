import { canonicalJsonValue } from '@jooevents/kernel';
import type {
  AirtableDataPort,
  AirtableProviderPort,
  AirtableWebhookPort
} from './port';
import {
  AIRTABLE_OAUTH_SCOPES,
  parseAirtableBaseId,
  parseAirtableCursor,
  parseAirtableFieldId,
  parseAirtableRecordId,
  parseAirtableTableId,
  parseAirtableUserId,
  parseAirtableWebhookId,
  type AirtableBaseId,
  type AirtableBasePage,
  type AirtableBaseSchema,
  type AirtableBatchWriteResult,
  type AirtableCellValue,
  type AirtableFieldId,
  type AirtableFieldSchema,
  type AirtableFieldType,
  type AirtableGrantIdentity,
  type AirtableOAuthScope,
  type AirtableProviderResult,
  type AirtableRecord,
  type AirtableRecordPage,
  type AirtableTableSchema,
  type AirtableWebhookPayload,
  type AirtableWebhookPayloadPage,
  type AirtableWebhookSource,
  type AirtableWriteDisposition
} from './types';
import {
  failure,
  failureForStatus,
  isObject,
  readBoundedJson,
  success,
  timeoutLike,
  validSecretText,
  type AirtableAccessTokenLease,
  type AirtableFetch
} from './http-common';
import { createAirtableOAuthClient } from './oauth';

const API_ROOT = 'https://api.airtable.com/v0';
const READ_REQUEST_BUDGET_MS = 15_000;
const WRITE_REQUEST_BUDGET_MS = 30_000;
const oauthScopes = new Set<string>(AIRTABLE_OAUTH_SCOPES);

function parseIso(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

const basePermissionLevels = new Set(['none', 'read', 'comment', 'edit', 'create']);

function parseField(value: unknown): AirtableFieldSchema | undefined {
  if (!isObject(value) || typeof value.name !== 'string'
    || typeof value.type !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(value.type)) {
    return undefined;
  }
  try {
    const options = value.options === undefined
      ? undefined
      : canonicalJsonValue(value.options) as Readonly<Record<string, AirtableCellValue>>;
    return Object.freeze({
      id: parseAirtableFieldId(value.id),
      name: value.name,
      type: value.type,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(options === undefined ? {} : { options })
    });
  } catch {
    return undefined;
  }
}

function parseTable(value: unknown): AirtableTableSchema | undefined {
  if (!isObject(value) || typeof value.name !== 'string' || !Array.isArray(value.fields)
    || !Array.isArray(value.views)) return undefined;
  try {
    const fields = value.fields.map(parseField);
    if (fields.some((field) => field === undefined)) return undefined;
    const views = value.views.map((candidate) => {
      if (!isObject(candidate) || typeof candidate.id !== 'string' || typeof candidate.name !== 'string'
        || !['grid', 'form', 'calendar', 'gallery', 'kanban', 'timeline', 'block'].includes(String(candidate.type))) {
        return undefined;
      }
      try {
        const visibleFieldIds = candidate.visibleFieldIds === undefined
          ? undefined
          : Array.isArray(candidate.visibleFieldIds)
            ? candidate.visibleFieldIds.map(parseAirtableFieldId)
            : undefined;
        if (candidate.visibleFieldIds !== undefined && visibleFieldIds === undefined) return undefined;
        return Object.freeze({
          id: candidate.id,
          name: candidate.name,
          type: candidate.type as AirtableTableSchema['views'][number]['type'],
          ...(visibleFieldIds === undefined ? {} : { visibleFieldIds: Object.freeze(visibleFieldIds) })
        });
      } catch {
        return undefined;
      }
    });
    if (views.some((view) => view === undefined)) return undefined;
    return Object.freeze({
      id: parseAirtableTableId(value.id),
      name: value.name,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      primaryFieldId: parseAirtableFieldId(value.primaryFieldId),
      fields: Object.freeze(fields as AirtableFieldSchema[]),
      views: Object.freeze(views as AirtableTableSchema['views'][number][])
    });
  } catch {
    return undefined;
  }
}

function parseSchema(value: unknown, baseId: AirtableBaseId, metadata?: {
  readonly name?: string;
  readonly workspaceId?: import('./types').AirtableWorkspaceId;
}): AirtableBaseSchema | undefined {
  if (!isObject(value) || !Array.isArray(value.tables)) return undefined;
  const tables = value.tables.map(parseTable);
  if (tables.some((table) => table === undefined)) return undefined;
  return Object.freeze({
    id: baseId,
    ...(metadata?.name === undefined ? {} : { name: metadata.name }),
    ...(metadata?.workspaceId === undefined ? {} : { workspaceId: metadata.workspaceId }),
    tables: Object.freeze(tables as AirtableTableSchema[])
  });
}

function parseRecord(value: unknown): AirtableRecord | undefined {
  if (!isObject(value) || !isObject(value.fields)) return undefined;
  const createdTime = parseIso(value.createdTime);
  if (createdTime === undefined) return undefined;
  try {
    const fields: Record<AirtableFieldId, AirtableCellValue> = {};
    for (const [fieldId, cell] of Object.entries(value.fields)) {
      fields[parseAirtableFieldId(fieldId)] = canonicalJsonValue(cell);
    }
    return Object.freeze({
      id: parseAirtableRecordId(value.id),
      createdTime,
      fields: Object.freeze(fields)
    });
  } catch {
    return undefined;
  }
}

function source(value: unknown): AirtableWebhookSource {
  return ['client', 'publicApi', 'formSubmission', 'automation', 'system', 'sync']
    .includes(String(value)) ? value as AirtableWebhookSource : 'unknown';
}

function recordChanges(tableIdValue: string, table: Record<string, unknown>) {
  const changes: Array<AirtableWebhookPayload['changes'][number]> = [];
  const tableId = parseAirtableTableId(tableIdValue);
  const created = isObject(table.createdRecordsById) ? table.createdRecordsById : {};
  for (const [recordIdValue, recordValue] of Object.entries(created)) {
    const cellValues = isObject(recordValue) && isObject(recordValue.cellValuesByFieldId)
      ? recordValue.cellValuesByFieldId : {};
    changes.push(Object.freeze({
      tableId,
      recordId: parseAirtableRecordId(recordIdValue),
      changedFieldIds: Object.freeze(Object.keys(cellValues).map(parseAirtableFieldId).sort()),
      kind: 'created' as const
    }));
  }
  const changed = isObject(table.changedRecordsById) ? table.changedRecordsById : {};
  for (const [recordIdValue, recordValue] of Object.entries(changed)) {
    const current = isObject(recordValue) && isObject(recordValue.current) ? recordValue.current : {};
    const cellValues = isObject(current.cellValuesByFieldId) ? current.cellValuesByFieldId : {};
    changes.push(Object.freeze({
      tableId,
      recordId: parseAirtableRecordId(recordIdValue),
      changedFieldIds: Object.freeze(Object.keys(cellValues).map(parseAirtableFieldId).sort()),
      kind: 'updated' as const
    }));
  }
  if (Array.isArray(table.destroyedRecordIds)) {
    for (const recordIdValue of table.destroyedRecordIds) {
      changes.push(Object.freeze({
        tableId,
        recordId: parseAirtableRecordId(recordIdValue),
        changedFieldIds: Object.freeze([]),
        kind: 'destroyed' as const
      }));
    }
  }
  return changes;
}

function parseWebhookPayload(value: unknown): AirtableWebhookPayload | undefined {
  if (!isObject(value) || !Number.isSafeInteger(value.baseTransactionNumber)) return undefined;
  const timestamp = parseIso(value.timestamp);
  if (timestamp === undefined || value.payloadFormat !== 'v0' || value.error === true) return undefined;
  try {
    const action = isObject(value.actionMetadata) ? value.actionMetadata : {};
    const metadata = isObject(action.sourceMetadata) ? action.sourceMetadata : {};
    const user = isObject(metadata.user) ? metadata.user : undefined;
    const actor = user === undefined ? undefined : Object.freeze({
      id: parseAirtableUserId(user.id),
      ...(typeof user.email === 'string' && user.email.length <= 320 ? { email: user.email } : {})
    });
    const tables = isObject(value.changedTablesById) ? value.changedTablesById : {};
    const changes = Object.entries(tables).flatMap(([tableId, table]) =>
      isObject(table) ? recordChanges(tableId, table) : []
    );
    return Object.freeze({
      transactionNumber: value.baseTransactionNumber as number,
      timestamp,
      source: source(action.source),
      ...(actor === undefined ? {} : { actor }),
      changes: Object.freeze(changes)
    });
  } catch {
    return undefined;
  }
}

function createAuthenticatedRequest(input: Readonly<{
  tokenLease: AirtableAccessTokenLease;
  fetch: AirtableFetch;
}>) {
  return async (request: Readonly<{
    endpoint: string;
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    kind: 'read' | 'write';
  }>): Promise<AirtableProviderResult<unknown>> => {
    let dispatched = false;
    try {
      const response = await input.tokenLease.withAccessToken(async (token) => {
        if (!validSecretText(token)) throw new TypeError('AirtableAccessToken_unavailable');
        dispatched = true;
        return input.fetch(request.endpoint, {
          method: request.method ?? 'GET',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: AbortSignal.timeout(
            request.kind === 'write' ? WRITE_REQUEST_BUDGET_MS : READ_REQUEST_BUDGET_MS
          )
        });
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* status is authoritative */ }
        return failureForStatus(response, request.kind);
      }
      if (request.method === 'DELETE' && response.body === null) return success({ deleted: true });
      const read = await readBoundedJson(response);
      if (read.kind === 'value') return success(read.value);
      return request.kind === 'write'
        ? failure('acceptance_unknown', 'reconcile_first', 'Airtable may have accepted the change.')
        : failure('response_invalid', 'never', 'Airtable returned an invalid response.');
    } catch (error) {
      if (!dispatched) {
        return failure('grant_revoked', 'reconnect', 'The Airtable connection secret is unavailable.');
      }
      if (request.kind === 'write') {
        return failure('acceptance_unknown', 'reconcile_first', 'Airtable may have accepted the change.');
      }
      return failure(
        'temporary_unavailable',
        'after_delay',
        timeoutLike(error) ? 'The Airtable request timed out.' : 'Airtable is temporarily unavailable.'
      );
    }
  };
}

function createDataPort(request: ReturnType<typeof createAuthenticatedRequest>): AirtableDataPort {
  const port: AirtableDataPort = {
    async getGrantIdentity() {
      const result = await request({ endpoint: `${API_ROOT}/meta/whoami`, kind: 'read' });
      if (result.kind === 'failure') return result;
      const value = result.value;
      if (!isObject(value)) return failure('response_invalid', 'never', 'Airtable returned an invalid identity response.');
      try {
        const scopes = Array.isArray(value.scopes)
          ? value.scopes.filter((item): item is AirtableOAuthScope => typeof item === 'string' && oauthScopes.has(item))
          : [];
        if (Array.isArray(value.scopes) && scopes.length !== value.scopes.length) throw new TypeError();
        const identity: AirtableGrantIdentity = Object.freeze({
          userId: parseAirtableUserId(value.id),
          ...(typeof value.email === 'string' && value.email.length <= 320 ? { email: value.email } : {}),
          scopes: Object.freeze(scopes.sort())
        });
        return success(identity);
      } catch {
        return failure('response_invalid', 'never', 'Airtable returned an invalid identity response.');
      }
    },
    async listBases(input = {}) {
      const url = new URL(`${API_ROOT}/meta/bases`);
      if (input.offset !== undefined) url.searchParams.set('offset', input.offset);
      const result = await request({ endpoint: url.toString(), kind: 'read' });
      if (result.kind === 'failure') return result;
      if (!isObject(result.value) || !Array.isArray(result.value.bases)) {
        return failure('response_invalid', 'never', 'Airtable returned an invalid base list.');
      }
      try {
        const bases = result.value.bases.map((candidate) => {
          if (!isObject(candidate) || typeof candidate.name !== 'string'
            || !basePermissionLevels.has(String(candidate.permissionLevel))) throw new TypeError();
          return Object.freeze({
            id: parseAirtableBaseId(candidate.id),
            name: candidate.name,
            permissionLevel: candidate.permissionLevel as AirtableBasePage['bases'][number]['permissionLevel']
          });
        });
        return success(Object.freeze({
          bases: Object.freeze(bases),
          ...(typeof result.value.offset === 'string' ? { offset: result.value.offset } : {})
        }));
      } catch {
        return failure('response_invalid', 'never', 'Airtable returned an invalid base list.');
      }
    },
    async createBase(input) {
      const result = await request({
        endpoint: `${API_ROOT}/meta/bases`,
        method: 'POST',
        kind: 'write',
        body: { name: input.name, workspaceId: input.workspaceId, tables: input.tables }
      });
      if (result.kind === 'failure') return result;
      if (!isObject(result.value)) return failure('acceptance_unknown', 'reconcile_first', 'Airtable may have created the base.');
      try {
        const baseId = parseAirtableBaseId(result.value.id);
        const schema = parseSchema(result.value, baseId, { name: input.name, workspaceId: input.workspaceId });
        return schema === undefined
          ? failure('acceptance_unknown', 'reconcile_first', 'Airtable may have created the base.')
          : success(schema);
      } catch {
        return failure('acceptance_unknown', 'reconcile_first', 'Airtable may have created the base.');
      }
    },
    async createTable(input) {
      const result = await request({
        endpoint: `${API_ROOT}/meta/bases/${input.baseId}/tables`,
        method: 'POST',
        kind: 'write',
        body: input.table
      });
      if (result.kind === 'failure') return result;
      const table = parseTable(result.value);
      return table === undefined
        ? failure('acceptance_unknown', 'reconcile_first', 'Airtable may have created the table.')
        : success(table);
    },
    async createField(input) {
      const result = await request({
        endpoint: `${API_ROOT}/meta/bases/${input.baseId}/tables/${input.tableId}/fields`,
        method: 'POST',
        kind: 'write',
        body: input.field
      });
      if (result.kind === 'failure') return result;
      const field = parseField(result.value);
      return field === undefined
        ? failure('acceptance_unknown', 'reconcile_first', 'Airtable may have created the field.')
        : success(field);
    },
    async getBaseSchema(input) {
      const result = await request({ endpoint: `${API_ROOT}/meta/bases/${input.baseId}/tables`, kind: 'read' });
      if (result.kind === 'failure') return result;
      const schema = parseSchema(result.value, input.baseId);
      return schema === undefined
        ? failure('response_invalid', 'never', 'Airtable returned an invalid schema response.')
        : success(schema);
    },
    async listRecords(input) {
      if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
        return failure('validation_failed', 'never', 'The Airtable record page size is invalid.');
      }
      const url = new URL(`${API_ROOT}/${input.baseId}/${input.tableId}`);
      url.searchParams.set('pageSize', String(input.pageSize));
      url.searchParams.set('returnFieldsByFieldId', 'true');
      for (const fieldId of input.fieldIds) url.searchParams.append('fields[]', fieldId);
      if (input.offset !== undefined) url.searchParams.set('offset', input.offset);
      const result = await request({ endpoint: url.toString(), kind: 'read' });
      if (result.kind === 'failure') return result;
      if (!isObject(result.value) || !Array.isArray(result.value.records)) {
        return failure('response_invalid', 'never', 'Airtable returned an invalid records response.');
      }
      const records = result.value.records.map(parseRecord);
      if (records.some((record) => record === undefined)) {
        return failure('response_invalid', 'never', 'Airtable returned an invalid records response.');
      }
      const page: AirtableRecordPage = Object.freeze({
        records: Object.freeze(records as AirtableRecord[]),
        ...(typeof result.value.offset === 'string' ? { offset: result.value.offset } : {})
      });
      return success(page);
    },
    async getRecord(input) {
      const url = new URL(`${API_ROOT}/${input.baseId}/${input.tableId}/${input.recordId}`);
      url.searchParams.set('returnFieldsByFieldId', 'true');
      const result = await request({ endpoint: url.toString(), kind: 'read' });
      if (result.kind === 'failure') return result;
      const record = parseRecord(result.value);
      return record === undefined
        ? failure('response_invalid', 'never', 'Airtable returned an invalid record response.')
        : success(record);
    },
    async patchRecords(input) {
      if (input.records.length < 1 || input.records.length > 10) {
        return failure('validation_failed', 'never', 'Airtable writes require one to ten records.');
      }
      const result = await request({
        endpoint: `${API_ROOT}/${input.baseId}/${input.tableId}`,
        method: 'PATCH',
        kind: 'write',
        body: {
          records: input.records.map((record) => ({
            ...(record.recordId === undefined ? {} : { id: record.recordId }),
            fields: record.fields
          })),
          returnFieldsByFieldId: true,
          ...(input.mergeOnFieldId === undefined ? {} : {
            performUpsert: { fieldsToMergeOn: [input.mergeOnFieldId] }
          })
        }
      });
      if (result.kind === 'failure') return result;
      if (!isObject(result.value) || !Array.isArray(result.value.records)) {
        return failure('acceptance_unknown', 'reconcile_first', 'Airtable may have accepted the records.');
      }
      const records = result.value.records.map(parseRecord);
      if (records.length !== input.records.length || records.some((record) => record === undefined)) {
        return failure('acceptance_unknown', 'reconcile_first', 'Airtable may have accepted the records.');
      }
      const createdIds = new Set(Array.isArray(result.value.createdRecords)
        ? result.value.createdRecords.filter((item): item is string => typeof item === 'string') : []);
      const dispositions: AirtableWriteDisposition[] = (records as AirtableRecord[]).map((record, requestIndex) => ({
        kind: createdIds.has(record.id) ? 'created' : 'updated',
        requestIndex,
        record
      }));
      const batch: AirtableBatchWriteResult = Object.freeze({ records: Object.freeze(dispositions) });
      return success(batch);
    },
    async findRecordsByField(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || input.value.length > 10_000) {
        return failure('validation_failed', 'never', 'The Airtable record search is invalid.');
      }
      const escaped = input.value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      const url = new URL(`${API_ROOT}/${input.baseId}/${input.tableId}`);
      url.searchParams.set('maxRecords', String(input.limit));
      url.searchParams.set('pageSize', String(input.limit));
      url.searchParams.set('returnFieldsByFieldId', 'true');
      url.searchParams.append('fields[]', input.fieldId);
      url.searchParams.set('filterByFormula', `{${input.fieldId}}="${escaped}"`);
      const result = await request({ endpoint: url.toString(), kind: 'read' });
      if (result.kind === 'failure') return result;
      if (!isObject(result.value) || !Array.isArray(result.value.records)) {
        return failure('response_invalid', 'never', 'Airtable returned an invalid records response.');
      }
      try {
        return success(Object.freeze(result.value.records.map((record) => {
          if (!isObject(record)) throw new TypeError();
          return parseAirtableRecordId(record.id);
        })));
      } catch {
        return failure('response_invalid', 'never', 'Airtable returned an invalid records response.');
      }
    }
  };
  return Object.freeze(port);
}

function createWebhookPort(request: ReturnType<typeof createAuthenticatedRequest>): AirtableWebhookPort {
  const port: AirtableWebhookPort = {
    async createWebhook(input) {
      const filters: Record<string, unknown> = {
        dataTypes: ['tableData'],
        ...(input.tableIds.length === 1 ? { recordChangeScope: input.tableIds[0] } : {}),
        ...(input.watchedFieldIds.length === 0 ? {} : { watchDataInFieldIds: input.watchedFieldIds })
      };
      const result = await request({
        endpoint: `${API_ROOT}/bases/${input.baseId}/webhooks`,
        method: 'POST',
        kind: 'write',
        body: {
          notificationUrl: input.notificationUrl,
          specification: {
            options: {
              filters,
              includes: { includePreviousCellValues: input.includePreviousValues }
            }
          }
        }
      });
      if (result.kind === 'failure') return result;
      if (!isObject(result.value) || typeof result.value.macSecretBase64 !== 'string') {
        return failure('acceptance_unknown', 'reconcile_first', 'Airtable may have created the webhook.');
      }
      const expiresAt = parseIso(result.value.expirationTime);
      try {
        return expiresAt === undefined
          ? failure('response_invalid', 'never', 'Airtable returned an invalid webhook lifetime.')
          : success(Object.freeze({
            webhookId: parseAirtableWebhookId(result.value.id),
            macSecretBase64: result.value.macSecretBase64,
            expiresAt
          }));
      } catch {
        return failure('acceptance_unknown', 'reconcile_first', 'Airtable may have created the webhook.');
      }
    },
    async refreshWebhook(input) {
      const result = await request({
        endpoint: `${API_ROOT}/bases/${input.baseId}/webhooks/${input.webhookId}/refresh`,
        method: 'POST',
        kind: 'write'
      });
      if (result.kind === 'failure') return result;
      const expiresAt = isObject(result.value) ? parseIso(result.value.expirationTime) : undefined;
      return expiresAt === undefined
        ? failure('acceptance_unknown', 'reconcile_first', 'Airtable may have refreshed the webhook.')
        : success(Object.freeze({ expiresAt }));
    },
    async deleteWebhook(input) {
      const result = await request({
        endpoint: `${API_ROOT}/bases/${input.baseId}/webhooks/${input.webhookId}`,
        method: 'DELETE',
        kind: 'write'
      });
      if (result.kind === 'failure') return result;
      return success(Object.freeze({ deleted: true as const }));
    },
    async listWebhookPayloads(input) {
      const url = new URL(`${API_ROOT}/bases/${input.baseId}/webhooks/${input.webhookId}/payloads`);
      if (input.cursor !== undefined) url.searchParams.set('cursor', input.cursor);
      url.searchParams.set('limit', '50');
      const result = await request({ endpoint: url.toString(), kind: 'read' });
      if (result.kind === 'failure') return result;
      if (!isObject(result.value) || !Number.isSafeInteger(result.value.cursor)
        || typeof result.value.mightHaveMore !== 'boolean' || !Array.isArray(result.value.payloads)) {
        return failure('response_invalid', 'never', 'Airtable returned an invalid webhook response.');
      }
      const payloads = result.value.payloads.map(parseWebhookPayload);
      if (payloads.some((payload) => payload === undefined)) {
        return failure('webhook_invalid', 'reconcile_first', 'The Airtable webhook must be repaired.');
      }
      const page: AirtableWebhookPayloadPage = Object.freeze({
        cursor: parseAirtableCursor(String(result.value.cursor)),
        mightHaveMore: result.value.mightHaveMore,
        payloads: Object.freeze(payloads as AirtableWebhookPayload[])
      });
      return success(page);
    }
  };
  return Object.freeze(port);
}

export function createAirtableHttpProvider(input: Readonly<{
  clientId: string;
  clientSecretLease?: import('./http-common').AirtableClientSecretLease;
  accessTokenLease: AirtableAccessTokenLease;
  fetch: AirtableFetch;
  now?: () => number;
}>): AirtableProviderPort {
  const request = createAuthenticatedRequest({ tokenLease: input.accessTokenLease, fetch: input.fetch });
  return Object.freeze({
    oauth: createAirtableOAuthClient({
      clientId: input.clientId,
      ...(input.clientSecretLease === undefined ? {} : { clientSecretLease: input.clientSecretLease }),
      fetch: input.fetch,
      ...(input.now === undefined ? {} : { now: input.now })
    }),
    data: createDataPort(request),
    webhooks: createWebhookPort(request)
  });
}
