import { canonicalJsonText, canonicalJsonValue } from '@jooevents/kernel';
import type {
  AirtableCreateFieldInput,
  AirtableCreateTableInput,
  AirtableDataPort,
  AirtableOAuthGrant,
  AirtableOAuthPort,
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
  parseAirtableWebhookId,
  parseAirtableWorkspaceId,
  parseAirtableUserId,
  type AirtableBaseId,
  type AirtableBasePage,
  type AirtableBaseSchema,
  type AirtableBatchWriteResult,
  type AirtableCellValue,
  type AirtableFailureCode,
  type AirtableFieldId,
  type AirtableFieldSchema,
  type AirtableGrantIdentity,
  type AirtableOAuthScope,
  type AirtableProviderFailure,
  type AirtableProviderResult,
  type AirtableRecord,
  type AirtableRecordId,
  type AirtableRecordPage,
  type AirtableTableId,
  type AirtableTableSchema,
  type AirtableWebhookId,
  type AirtableWebhookNotification,
  type AirtableWebhookPayload,
  type AirtableWebhookPayloadPage,
  type AirtableWorkspaceId,
  type AirtableWriteDisposition,
  type AirtableWriteRecord
} from './types';

type FakeOperation =
  | 'exchangeAuthorizationCode'
  | 'refreshGrant'
  | 'getGrantIdentity'
  | 'listBases'
  | 'createBase'
  | 'createTable'
  | 'createField'
  | 'getBaseSchema'
  | 'listRecords'
  | 'getRecord'
  | 'patchRecords'
  | 'findRecordsByField'
  | 'createWebhook'
  | 'refreshWebhook'
  | 'deleteWebhook'
  | 'listWebhookPayloads';

export type FakeAirtableFault =
  | {
      readonly operation: FakeOperation;
      readonly kind: 'failure';
      readonly code: Exclude<AirtableFailureCode, 'acceptance_unknown'>;
      readonly retry?: AirtableProviderFailure['retry'];
      readonly retryAfterMs?: number;
    }
  | {
      readonly operation: 'patchRecords';
      readonly kind: 'partial';
      readonly failedRequestIndexes: readonly number[];
      readonly code: Exclude<AirtableFailureCode, 'acceptance_unknown'>;
    }
  | {
      readonly operation: 'patchRecords';
      readonly kind: 'timeout_after_accept';
    };

interface MutableRecord {
  readonly id: AirtableRecordId;
  readonly createdTime: string;
  readonly fields: Map<AirtableFieldId, AirtableCellValue>;
}

interface MutableTable {
  schema: AirtableTableSchema;
  readonly records: Map<AirtableRecordId, MutableRecord>;
}

interface MutableBase {
  schema: AirtableBaseSchema;
  readonly tables: Map<AirtableTableId, MutableTable>;
}

interface MutableWebhook {
  readonly id: AirtableWebhookId;
  readonly baseId: AirtableBaseId;
  readonly tableIds: ReadonlySet<AirtableTableId>;
  readonly watchedFieldIds: ReadonlySet<AirtableFieldId>;
  readonly notificationUrl: string;
  readonly macSecretBase64: string;
  expiresAt: string;
  nextTransactionNumber: number;
  readonly payloads: AirtableWebhookPayload[];
}

export interface FakeAirtableClock {
  now(): string;
}

export interface FakeAirtableIdFactory {
  next(kind: 'base' | 'table' | 'field' | 'record' | 'webhook' | 'request'): string;
}

class SequentialIdFactory implements FakeAirtableIdFactory {
  readonly #counters = new Map<string, number>();

  next(kind: 'base' | 'table' | 'field' | 'record' | 'webhook' | 'request'): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    const prefix = {
      base: 'app',
      table: 'tbl',
      field: 'fld',
      record: 'rec',
      webhook: 'ach',
      request: 'req'
    }[kind];
    return `${prefix}${String(next).padStart(14, '0')}`;
  }
}

function success<Value>(value: Value): AirtableProviderResult<Value> {
  return { kind: 'success', value };
}

function failure(
  code: AirtableFailureCode,
  retry: AirtableProviderFailure['retry'],
  safeMessage: string,
  options: { readonly retryAfterMs?: number; readonly providerRequestId?: string } = {}
): AirtableProviderResult<never> {
  return {
    kind: 'failure',
    failure: {
      code,
      retry,
      safeMessage,
      ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
      ...(options.providerRequestId ? { providerRequestId: options.providerRequestId } : {})
    }
  };
}

function cloneRecord(record: MutableRecord): AirtableRecord {
  return Object.freeze({
    id: record.id,
    createdTime: record.createdTime,
    fields: Object.freeze(Object.fromEntries(
      [...record.fields.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fieldId, value]) => [fieldId, canonicalJsonValue(value)])
    ))
  });
}

function cloneSchema(base: MutableBase): AirtableBaseSchema {
  return Object.freeze({
    ...base.schema,
    tables: Object.freeze([...base.tables.values()].map((table) => table.schema))
  });
}

function retryFor(code: AirtableFailureCode): AirtableProviderFailure['retry'] {
  if (code === 'grant_revoked' || code === 'resource_forbidden') return 'reconnect';
  if (code === 'acceptance_unknown' || code === 'schema_mismatch') return 'reconcile_first';
  if (code === 'rate_limited' || code === 'temporary_unavailable') return 'after_delay';
  return 'never';
}

export class FakeAirtableProvider implements AirtableProviderPort {
  readonly oauth: AirtableOAuthPort;
  readonly data: AirtableDataPort;
  readonly webhooks: AirtableWebhookPort;

  readonly #workspaces = new Map<AirtableWorkspaceId, Readonly<{
    id: AirtableWorkspaceId;
    name: string;
    permission: 'read' | 'edit' | 'create';
    plan?: 'free' | 'team' | 'business' | 'enterprise' | 'unknown';
  }>>();
  readonly #bases = new Map<AirtableBaseId, MutableBase>();
  readonly #webhooks = new Map<AirtableWebhookId, MutableWebhook>();
  readonly #faults: FakeAirtableFault[] = [];
  readonly #notifications: AirtableWebhookNotification[] = [];
  readonly #clock: FakeAirtableClock;
  readonly #ids: FakeAirtableIdFactory;
  #grantState: 'active' | 'revoked' = 'active';
  #recordRead = true;
  #recordWrite = true;
  #notificationMode: 'normal' | 'coalesce' | 'duplicate' = 'normal';
  #tokenRevision = 0;

  constructor(input: {
    readonly clock?: FakeAirtableClock;
    readonly ids?: FakeAirtableIdFactory;
  } = {}) {
    this.#clock = input.clock ?? { now: () => '2026-08-17T00:00:00.000Z' };
    this.#ids = input.ids ?? new SequentialIdFactory();
    this.oauth = Object.freeze({
      exchangeAuthorizationCode: this.exchangeAuthorizationCode.bind(this),
      refreshGrant: this.refreshGrant.bind(this)
    });
    this.data = Object.freeze({
      getGrantIdentity: this.getGrantIdentity.bind(this),
      listBases: this.listBases.bind(this),
      createBase: this.createBase.bind(this),
      createTable: this.createTableInBase.bind(this),
      createField: this.createFieldInTable.bind(this),
      getBaseSchema: this.getBaseSchema.bind(this),
      listRecords: this.listRecords.bind(this),
      getRecord: this.getRecord.bind(this),
      patchRecords: this.patchRecords.bind(this),
      findRecordsByField: this.findRecordsByField.bind(this)
    });
    this.webhooks = Object.freeze({
      createWebhook: this.createWebhook.bind(this),
      refreshWebhook: this.refreshWebhook.bind(this),
      deleteWebhook: this.deleteWebhook.bind(this),
      listWebhookPayloads: this.listWebhookPayloads.bind(this)
    });
  }

  seedWorkspace(input: {
    readonly id: string;
    readonly name: string;
    readonly permission?: 'read' | 'edit' | 'create';
    readonly plan?: 'free' | 'team' | 'business' | 'enterprise' | 'unknown';
  }): AirtableWorkspaceId {
    const id = parseAirtableWorkspaceId(input.id);
    this.#workspaces.set(id, Object.freeze({
      id,
      name: input.name,
      permission: input.permission ?? 'create',
      ...(input.plan ? { plan: input.plan } : {})
    }));
    return id;
  }

  enqueueFault(fault: FakeAirtableFault): void {
    this.#faults.push(Object.freeze({ ...fault }));
  }

  revokeGrant(): void {
    this.#grantState = 'revoked';
  }

  restoreGrant(): void {
    this.#grantState = 'active';
  }

  setRecordCapabilities(input: { readonly read: boolean; readonly write: boolean }): void {
    this.#recordRead = input.read;
    this.#recordWrite = input.write;
  }

  setNotificationMode(mode: 'normal' | 'coalesce' | 'duplicate'): void {
    this.#notificationMode = mode;
  }

  drainNotifications(input: { readonly reverse?: boolean } = {}): readonly AirtableWebhookNotification[] {
    const drained = this.#notifications.splice(0);
    if (input.reverse) drained.reverse();
    return Object.freeze(drained);
  }

  replaceFieldForSchemaDrift(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly fieldId: AirtableFieldId;
    readonly name?: string;
    readonly type?: AirtableFieldSchema['type'];
  }): AirtableFieldId {
    const table = this.requireTable(input.baseId, input.tableId);
    const fields = [...table.schema.fields];
    const index = fields.findIndex((field) => field.id === input.fieldId);
    if (index < 0) throw new TypeError('fake_airtable_field_not_found');
    const previous = fields[index]!;
    const replacementId = parseAirtableFieldId(this.#ids.next('field'));
    fields[index] = Object.freeze({
      ...previous,
      id: replacementId,
      name: input.name ?? previous.name,
      type: input.type ?? previous.type
    });
    table.schema = Object.freeze({ ...table.schema, fields: Object.freeze(fields) });
    for (const record of table.records.values()) {
      const value = record.fields.get(input.fieldId);
      record.fields.delete(input.fieldId);
      if (value !== undefined) record.fields.set(replacementId, value);
    }
    return replacementId;
  }

  seedRecord(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly fields: Readonly<Record<AirtableFieldId, AirtableCellValue>>;
  }): AirtableRecordId {
    const table = this.requireTable(input.baseId, input.tableId);
    const id = parseAirtableRecordId(this.#ids.next('record'));
    table.records.set(id, {
      id,
      createdTime: this.#clock.now(),
      fields: new Map(Object.entries(input.fields) as Array<[AirtableFieldId, AirtableCellValue]>)
    });
    return id;
  }

  private takeFault(operation: FakeOperation): FakeAirtableFault | undefined {
    const index = this.#faults.findIndex((fault) => fault.operation === operation);
    if (index < 0) return undefined;
    return this.#faults.splice(index, 1)[0];
  }

  private preflight<Value>(operation: FakeOperation): AirtableProviderResult<Value> | undefined {
    if (this.#grantState === 'revoked') {
      return failure('grant_revoked', 'reconnect', 'The Airtable connection is no longer authorized.');
    }
    const fault = this.takeFault(operation);
    if (!fault || fault.kind !== 'failure') {
      if (fault) this.#faults.unshift(fault);
      return undefined;
    }
    return failure(
      fault.code,
      fault.retry ?? retryFor(fault.code),
      `Airtable ${fault.code.replaceAll('_', ' ')}.`,
      {
        ...(fault.retryAfterMs !== undefined ? { retryAfterMs: fault.retryAfterMs } : {}),
        providerRequestId: this.#ids.next('request')
      }
    );
  }

  private requireTable(baseId: AirtableBaseId, tableId: AirtableTableId): MutableTable {
    const table = this.#bases.get(baseId)?.tables.get(tableId);
    if (!table) throw new TypeError('fake_airtable_table_not_found');
    return table;
  }

  private grant(scopes: readonly AirtableOAuthScope[]): AirtableOAuthGrant {
    this.#tokenRevision += 1;
    const now = Date.parse(this.#clock.now());
    return Object.freeze({
      accessToken: `fake-access-${this.#tokenRevision}`,
      refreshToken: `fake-refresh-${this.#tokenRevision}`,
      accessExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
      refreshExpiresAt: new Date(now + 60 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: Object.freeze([...scopes])
    });
  }

  private async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
    readonly expectedScopes: readonly AirtableOAuthScope[];
  }): Promise<AirtableProviderResult<AirtableOAuthGrant>> {
    const failed = this.preflight<AirtableOAuthGrant>('exchangeAuthorizationCode');
    if (failed) return failed;
    if (!input.code || !input.redirectUri.startsWith('https://') || input.codeVerifier.length < 43) {
      return failure('validation_failed', 'never', 'The Airtable authorization response is invalid.');
    }
    return success(this.grant(input.expectedScopes));
  }

  private async refreshGrant(input: {
    readonly refreshToken: string;
  }): Promise<AirtableProviderResult<AirtableOAuthGrant>> {
    const failed = this.preflight<AirtableOAuthGrant>('refreshGrant');
    if (failed) return failed;
    if (!input.refreshToken.startsWith('fake-refresh-')) {
      return failure('grant_revoked', 'reconnect', 'The Airtable connection must be authorized again.');
    }
    return success(this.grant([
      'data.records:read',
      'data.records:write',
      'schema.bases:read',
      'schema.bases:write',
      'webhook:manage',
      'user.email:read'
    ]));
  }

  private async getGrantIdentity(): Promise<AirtableProviderResult<AirtableGrantIdentity>> {
    const failed = this.preflight<AirtableGrantIdentity>('getGrantIdentity');
    if (failed) return failed;
    return success(Object.freeze({
      userId: parseAirtableUserId('usr00000000000001'),
      email: 'organizer@example.test',
      scopes: Object.freeze([...AIRTABLE_OAUTH_SCOPES])
    }));
  }

  private createField(input: AirtableCreateFieldInput): AirtableFieldSchema {
    return Object.freeze({
      id: parseAirtableFieldId(this.#ids.next('field')),
      name: input.name,
      type: input.type,
      ...(input.description ? { description: input.description } : {}),
      ...(input.options
        ? { options: canonicalJsonValue(input.options) as Readonly<Record<string, AirtableCellValue>> }
        : {})
    });
  }

  private createTable(input: AirtableCreateTableInput): MutableTable {
    if (input.fields.length < 1) throw new TypeError('fake_airtable_table_fields_required');
    const fields = Object.freeze(input.fields.map((field) => this.createField(field)));
    const id = parseAirtableTableId(this.#ids.next('table'));
    return {
      schema: Object.freeze({
        id,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        primaryFieldId: fields[0]!.id,
        fields,
        views: Object.freeze([{
          id: `viw${String(id).slice(3)}`,
          name: 'Grid view',
          type: 'grid' as const
        }])
      }),
      records: new Map()
    };
  }

  private async createBase(input: {
    readonly workspaceId: AirtableWorkspaceId;
    readonly name: string;
    readonly tables: readonly AirtableCreateTableInput[];
  }): Promise<AirtableProviderResult<AirtableBaseSchema>> {
    const failed = this.preflight<AirtableBaseSchema>('createBase');
    if (failed) return failed;
    const workspace = this.#workspaces.get(input.workspaceId);
    if (!workspace || workspace.permission !== 'create') {
      return failure('resource_forbidden', 'reconnect', 'The selected Airtable workspace cannot create a base.');
    }
    if (!input.name || input.tables.length < 1) {
      return failure('validation_failed', 'never', 'The managed Airtable base definition is invalid.');
    }
    const id = parseAirtableBaseId(this.#ids.next('base'));
    const tables = input.tables.map((table) => this.createTable(table));
    const base: MutableBase = {
      schema: Object.freeze({
        id,
        name: input.name,
        workspaceId: input.workspaceId,
        tables: Object.freeze(tables.map((table) => table.schema))
      }),
      tables: new Map(tables.map((table) => [table.schema.id, table]))
    };
    this.#bases.set(id, base);
    return success(cloneSchema(base));
  }

  private async listBases(input: {
    readonly offset?: string;
  } = {}): Promise<AirtableProviderResult<AirtableBasePage>> {
    const failed = this.preflight<AirtableBasePage>('listBases');
    if (failed) return failed;
    if (input.offset !== undefined) {
      return failure('validation_failed', 'never', 'The Airtable base-list offset is invalid.');
    }
    return success(Object.freeze({
      bases: Object.freeze([...this.#bases.values()].map((base) => Object.freeze({
        id: base.schema.id,
        name: base.schema.name ?? 'Untitled base',
        permissionLevel: 'create' as const
      })))
    }));
  }

  private async createTableInBase(input: {
    readonly baseId: AirtableBaseId;
    readonly table: AirtableCreateTableInput;
  }): Promise<AirtableProviderResult<AirtableTableSchema>> {
    const failed = this.preflight<AirtableTableSchema>('createTable');
    if (failed) return failed;
    const base = this.#bases.get(input.baseId);
    if (!base) return failure('not_found', 'never', 'The Airtable base was not found.');
    if (base.schema.tables.some((table) => table.name === input.table.name)) {
      return failure('validation_failed', 'never', 'An Airtable table already has that name.');
    }
    let table: MutableTable;
    try {
      table = this.createTable(input.table);
    } catch {
      return failure('validation_failed', 'never', 'The managed Airtable table definition is invalid.');
    }
    base.tables.set(table.schema.id, table);
    base.schema = Object.freeze({
      ...base.schema,
      tables: Object.freeze([...base.schema.tables, table.schema])
    });
    return success(table.schema);
  }

  private async createFieldInTable(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly field: AirtableCreateFieldInput;
  }): Promise<AirtableProviderResult<AirtableFieldSchema>> {
    const failed = this.preflight<AirtableFieldSchema>('createField');
    if (failed) return failed;
    const table = this.#bases.get(input.baseId)?.tables.get(input.tableId);
    if (!table) return failure('not_found', 'never', 'The Airtable table was not found.');
    if (table.schema.fields.some((field) => field.name === input.field.name)) {
      return failure('validation_failed', 'never', 'An Airtable field already has that name.');
    }
    let field: AirtableFieldSchema;
    try {
      field = this.createField(input.field);
    } catch {
      return failure('validation_failed', 'never', 'The managed Airtable field definition is invalid.');
    }
    table.schema = Object.freeze({
      ...table.schema,
      fields: Object.freeze([...table.schema.fields, field])
    });
    const base = this.#bases.get(input.baseId)!;
    base.schema = Object.freeze({
      ...base.schema,
      tables: Object.freeze([...base.tables.values()].map((candidate) => candidate.schema))
    });
    return success(field);
  }

  private async getBaseSchema(input: {
    readonly baseId: AirtableBaseId;
  }): Promise<AirtableProviderResult<AirtableBaseSchema>> {
    const failed = this.preflight<AirtableBaseSchema>('getBaseSchema');
    if (failed) return failed;
    const base = this.#bases.get(input.baseId);
    return base
      ? success(cloneSchema(base))
      : failure('not_found', 'never', 'The Airtable base was not found.');
  }

  private async listRecords(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly fieldIds: readonly AirtableFieldId[];
    readonly pageSize: number;
    readonly offset?: string;
  }): Promise<AirtableProviderResult<AirtableRecordPage>> {
    const failed = this.preflight<AirtableRecordPage>('listRecords');
    if (failed) return failed;
    if (!this.#recordRead) {
      return failure('resource_forbidden', 'reconnect', 'The Airtable grant cannot read records.');
    }
    if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
      return failure('validation_failed', 'never', 'The Airtable record page size is invalid.');
    }
    let table: MutableTable;
    try {
      table = this.requireTable(input.baseId, input.tableId);
    } catch {
      return failure('not_found', 'never', 'The Airtable table was not found.');
    }
    const offset = input.offset ? Number(input.offset) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      return failure('validation_failed', 'never', 'The Airtable record offset is invalid.');
    }
    const source = [...table.records.values()].sort((left, right) => left.id.localeCompare(right.id));
    const records = source.slice(offset, offset + input.pageSize).map((record) => {
      const selected = new Map(
        [...record.fields.entries()].filter(([fieldId]) => input.fieldIds.includes(fieldId))
      );
      return cloneRecord({ ...record, fields: selected });
    });
    const next = offset + records.length;
    return success(Object.freeze({
      records: Object.freeze(records),
      ...(next < source.length ? { offset: String(next) } : {})
    }));
  }

  private async getRecord(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly recordId: AirtableRecordId;
  }): Promise<AirtableProviderResult<AirtableRecord>> {
    const failed = this.preflight<AirtableRecord>('getRecord');
    if (failed) return failed;
    if (!this.#recordRead) {
      return failure('resource_forbidden', 'reconnect', 'The Airtable grant cannot read records.');
    }
    try {
      const record = this.requireTable(input.baseId, input.tableId).records.get(input.recordId);
      return record
        ? success(cloneRecord(record))
        : failure('not_found', 'never', 'The Airtable record was not found.');
    } catch {
      return failure('not_found', 'never', 'The Airtable table was not found.');
    }
  }

  private applyRecord(
    table: MutableTable,
    write: AirtableWriteRecord,
    mergeOnFieldId: AirtableFieldId | undefined
  ): { readonly kind: 'created' | 'updated'; readonly record: AirtableRecord } | {
    readonly kind: 'failure';
    readonly failure: AirtableProviderFailure;
  } {
    let target = write.recordId ? table.records.get(write.recordId) : undefined;
    if (!target && write.recordId) {
      return {
        kind: 'failure',
        failure: {
          code: 'not_found',
          retry: 'never',
          safeMessage: 'The Airtable record was not found.'
        }
      };
    }
    if (!target && mergeOnFieldId) {
      const mergeValue = write.fields[mergeOnFieldId];
      const matches = [...table.records.values()].filter((record) =>
        mergeValue !== undefined
        && record.fields.has(mergeOnFieldId)
        && canonicalJsonText(record.fields.get(mergeOnFieldId)) === canonicalJsonText(mergeValue)
      );
      if (matches.length > 1) {
        return {
          kind: 'failure',
          failure: {
            code: 'multiple_matches',
            retry: 'reconcile_first',
            safeMessage: 'More than one Airtable record has the managed identity.'
          }
        };
      }
      target = matches[0];
    }
    const created = target === undefined;
    if (!target) {
      const id = parseAirtableRecordId(this.#ids.next('record'));
      target = { id, createdTime: this.#clock.now(), fields: new Map() };
      table.records.set(id, target);
    }
    for (const [fieldId, value] of Object.entries(write.fields) as Array<
      [AirtableFieldId, AirtableCellValue]
    >) {
      target.fields.set(fieldId, canonicalJsonValue(value));
    }
    return { kind: created ? 'created' : 'updated', record: cloneRecord(target) };
  }

  private recordWebhookChanges(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly dispositions: readonly AirtableWriteDisposition[];
    readonly writes: readonly AirtableWriteRecord[];
  }): void {
    for (const webhook of this.#webhooks.values()) {
      if (webhook.baseId !== input.baseId || !webhook.tableIds.has(input.tableId)) continue;
      const changes = input.dispositions.flatMap((disposition) => {
        if (disposition.kind === 'failed') return [];
        const write = input.writes[disposition.requestIndex];
        if (!write) return [];
        const changedFieldIds = (Object.keys(write.fields) as AirtableFieldId[])
          .filter((fieldId) =>
            webhook.watchedFieldIds.size === 0 || webhook.watchedFieldIds.has(fieldId)
          );
        if (changedFieldIds.length === 0) return [];
        return [{
          tableId: input.tableId,
          recordId: disposition.record.id,
          changedFieldIds: Object.freeze(changedFieldIds.sort()),
          kind: disposition.kind === 'created' ? 'created' as const : 'updated' as const
        }];
      });
      if (changes.length === 0) continue;
      const transactionNumber = webhook.nextTransactionNumber;
      webhook.nextTransactionNumber += 1;
      webhook.payloads.push(Object.freeze({
        transactionNumber,
        timestamp: this.#clock.now(),
        source: 'publicApi',
        changes: Object.freeze(changes)
      }));
      const notification = Object.freeze({
        baseId: input.baseId,
        webhookId: webhook.id,
        timestamp: this.#clock.now()
      });
      if (this.#notificationMode === 'coalesce') {
        const existing = this.#notifications.findIndex((item) => item.webhookId === webhook.id);
        if (existing >= 0) this.#notifications.splice(existing, 1, notification);
        else this.#notifications.push(notification);
      } else {
        this.#notifications.push(notification);
        if (this.#notificationMode === 'duplicate') this.#notifications.push(notification);
      }
    }
  }

  private async patchRecords(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly records: readonly AirtableWriteRecord[];
    readonly mergeOnFieldId?: AirtableFieldId;
  }): Promise<AirtableProviderResult<AirtableBatchWriteResult>> {
    const failed = this.preflight<AirtableBatchWriteResult>('patchRecords');
    if (failed) return failed;
    if (!this.#recordWrite) {
      return failure('resource_forbidden', 'reconnect', 'The Airtable grant cannot write records.');
    }
    if (input.records.length < 1 || input.records.length > 10) {
      return failure('validation_failed', 'never', 'Airtable writes require one to ten records.');
    }
    let table: MutableTable;
    try {
      table = this.requireTable(input.baseId, input.tableId);
    } catch {
      return failure('not_found', 'never', 'The Airtable table was not found.');
    }
    const injected = this.takeFault('patchRecords');
    const partial = injected?.kind === 'partial' ? new Set(injected.failedRequestIndexes) : new Set<number>();
    const dispositions: AirtableWriteDisposition[] = [];
    input.records.forEach((record, requestIndex) => {
      if (partial.has(requestIndex)) {
        dispositions.push({
          kind: 'failed',
          requestIndex,
          failure: {
            code: injected?.kind === 'partial' ? injected.code : 'temporary_unavailable',
            retry: injected?.kind === 'partial' ? retryFor(injected.code) : 'after_delay',
            safeMessage: 'The Airtable record was not updated.'
          }
        });
        return;
      }
      const applied = this.applyRecord(table, record, input.mergeOnFieldId);
      dispositions.push(applied.kind === 'failure'
        ? { kind: 'failed', requestIndex, failure: applied.failure }
        : { kind: applied.kind, requestIndex, record: applied.record });
    });
    this.recordWebhookChanges({
      baseId: input.baseId,
      tableId: input.tableId,
      dispositions,
      writes: input.records
    });
    if (injected?.kind === 'timeout_after_accept') {
      return failure(
        'acceptance_unknown',
        'reconcile_first',
        'Airtable may have accepted the records.',
        { providerRequestId: this.#ids.next('request') }
      );
    }
    if (injected?.kind === 'failure') this.#faults.unshift(injected);
    return success({ records: Object.freeze(dispositions) });
  }

  private async findRecordsByField(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly fieldId: AirtableFieldId;
    readonly value: string;
    readonly limit: number;
  }): Promise<AirtableProviderResult<readonly AirtableRecordId[]>> {
    const failed = this.preflight<readonly AirtableRecordId[]>('findRecordsByField');
    if (failed) return failed;
    if (!this.#recordRead) {
      return failure('resource_forbidden', 'reconnect', 'The Airtable grant cannot read records.');
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      return failure('validation_failed', 'never', 'The Airtable record search limit is invalid.');
    }
    let table: MutableTable;
    try {
      table = this.requireTable(input.baseId, input.tableId);
    } catch {
      return failure('not_found', 'never', 'The Airtable table was not found.');
    }
    const matches = [...table.records.values()]
      .filter((record) => record.fields.get(input.fieldId) === input.value)
      .map((record) => record.id)
      .sort()
      .slice(0, input.limit);
    return success(Object.freeze(matches));
  }

  private async createWebhook(input: {
    readonly baseId: AirtableBaseId;
    readonly notificationUrl: string;
    readonly tableIds: readonly AirtableTableId[];
    readonly watchedFieldIds: readonly AirtableFieldId[];
    readonly includePreviousValues: boolean;
  }): Promise<AirtableProviderResult<{
    readonly webhookId: AirtableWebhookId;
    readonly macSecretBase64: string;
    readonly expiresAt: string;
  }>> {
    const failed = this.preflight<{
      readonly webhookId: AirtableWebhookId;
      readonly macSecretBase64: string;
      readonly expiresAt: string;
    }>('createWebhook');
    if (failed) return failed;
    if (!this.#bases.has(input.baseId) || !input.notificationUrl.startsWith('https://')) {
      return failure('validation_failed', 'never', 'The Airtable webhook definition is invalid.');
    }
    const existing = [...this.#webhooks.values()].filter((webhook) => webhook.baseId === input.baseId);
    if (existing.length >= 2) {
      return failure('validation_failed', 'never', 'The Airtable OAuth webhook limit is reached.');
    }
    const id = parseAirtableWebhookId(this.#ids.next('webhook'));
    const expiresAt = new Date(Date.parse(this.#clock.now()) + 7 * 24 * 60 * 60 * 1000).toISOString();
    const webhook: MutableWebhook = {
      id,
      baseId: input.baseId,
      tableIds: new Set(input.tableIds),
      watchedFieldIds: new Set(input.watchedFieldIds),
      notificationUrl: input.notificationUrl,
      macSecretBase64: btoa(`fake-mac-${id}`),
      expiresAt,
      nextTransactionNumber: 1,
      payloads: []
    };
    this.#webhooks.set(id, webhook);
    return success(Object.freeze({
      webhookId: id,
      macSecretBase64: webhook.macSecretBase64,
      expiresAt
    }));
  }

  private async refreshWebhook(input: {
    readonly baseId: AirtableBaseId;
    readonly webhookId: AirtableWebhookId;
  }): Promise<AirtableProviderResult<{ readonly expiresAt: string }>> {
    const failed = this.preflight<{ readonly expiresAt: string }>('refreshWebhook');
    if (failed) return failed;
    const webhook = this.#webhooks.get(input.webhookId);
    if (!webhook || webhook.baseId !== input.baseId) {
      return failure('not_found', 'never', 'The Airtable webhook was not found.');
    }
    webhook.expiresAt = new Date(
      Date.parse(this.#clock.now()) + 7 * 24 * 60 * 60 * 1000
    ).toISOString();
    return success({ expiresAt: webhook.expiresAt });
  }

  private async deleteWebhook(input: {
    readonly baseId: AirtableBaseId;
    readonly webhookId: AirtableWebhookId;
  }): Promise<AirtableProviderResult<{ readonly deleted: true }>> {
    const failed = this.preflight<{ readonly deleted: true }>('deleteWebhook');
    if (failed) return failed;
    const webhook = this.#webhooks.get(input.webhookId);
    if (!webhook || webhook.baseId !== input.baseId) {
      return failure('not_found', 'never', 'The Airtable webhook was not found.');
    }
    this.#webhooks.delete(input.webhookId);
    return success({ deleted: true });
  }

  private async listWebhookPayloads(input: {
    readonly baseId: AirtableBaseId;
    readonly webhookId: AirtableWebhookId;
    readonly cursor?: ReturnType<typeof parseAirtableCursor>;
  }): Promise<AirtableProviderResult<AirtableWebhookPayloadPage>> {
    const failed = this.preflight<AirtableWebhookPayloadPage>('listWebhookPayloads');
    if (failed) return failed;
    const webhook = this.#webhooks.get(input.webhookId);
    if (!webhook || webhook.baseId !== input.baseId) {
      return failure('not_found', 'never', 'The Airtable webhook was not found.');
    }
    const cursor = input.cursor ? Number(input.cursor) : 1;
    if (!Number.isInteger(cursor) || cursor < 1) {
      return failure('validation_failed', 'never', 'The Airtable webhook cursor is invalid.');
    }
    const remaining = webhook.payloads.filter((payload) => payload.transactionNumber >= cursor);
    const payloads = remaining.slice(0, 50);
    const next = payloads.length > 0
      ? payloads[payloads.length - 1]!.transactionNumber + 1
      : cursor;
    webhook.expiresAt = new Date(
      Date.parse(this.#clock.now()) + 7 * 24 * 60 * 60 * 1000
    ).toISOString();
    return success(Object.freeze({
      cursor: parseAirtableCursor(String(next)),
      mightHaveMore: remaining.length > payloads.length,
      payloads: Object.freeze(payloads)
    }));
  }
}
