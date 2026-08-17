import type {
  AirtableBaseId,
  AirtableBasePage,
  AirtableBaseSchema,
  AirtableBatchWriteResult,
  AirtableCursor,
  AirtableFieldId,
  AirtableFieldSchema,
  AirtableFieldType,
  AirtableGrantIdentity,
  AirtableOAuthScope,
  AirtableProviderResult,
  AirtableRecordId,
  AirtableRecord,
  AirtableRecordPage,
  AirtableTableSchema,
  AirtableTableId,
  AirtableWebhookId,
  AirtableWebhookPayloadPage,
  AirtableWorkspaceId,
  AirtableWriteRecord
} from './types';

export interface AirtableOAuthGrant {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
  readonly scopes: readonly AirtableOAuthScope[];
}

export interface AirtableOAuthPort {
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
    readonly expectedScopes: readonly AirtableOAuthScope[];
  }): Promise<AirtableProviderResult<AirtableOAuthGrant>>;
  refreshGrant(input: {
    readonly refreshToken: string;
  }): Promise<AirtableProviderResult<AirtableOAuthGrant>>;
}

export interface AirtableCreateFieldInput {
  readonly name: string;
  readonly type: AirtableFieldType;
  readonly description?: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface AirtableCreateTableInput {
  readonly name: string;
  readonly description?: string;
  readonly fields: readonly AirtableCreateFieldInput[];
}

export interface AirtableDataPort {
  getGrantIdentity(): Promise<AirtableProviderResult<AirtableGrantIdentity>>;
  listBases(input?: {
    readonly offset?: string;
  }): Promise<AirtableProviderResult<AirtableBasePage>>;
  createBase(input: {
    readonly workspaceId: AirtableWorkspaceId;
    readonly name: string;
    readonly tables: readonly AirtableCreateTableInput[];
  }): Promise<AirtableProviderResult<AirtableBaseSchema>>;
  createTable(input: {
    readonly baseId: AirtableBaseId;
    readonly table: AirtableCreateTableInput;
  }): Promise<AirtableProviderResult<AirtableTableSchema>>;
  createField(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly field: AirtableCreateFieldInput;
  }): Promise<AirtableProviderResult<AirtableFieldSchema>>;
  getBaseSchema(input: {
    readonly baseId: AirtableBaseId;
  }): Promise<AirtableProviderResult<AirtableBaseSchema>>;
  listRecords(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly fieldIds: readonly AirtableFieldId[];
    readonly pageSize: number;
    readonly offset?: string;
  }): Promise<AirtableProviderResult<AirtableRecordPage>>;
  getRecord(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly recordId: AirtableRecordId;
  }): Promise<AirtableProviderResult<AirtableRecord>>;
  patchRecords(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly records: readonly AirtableWriteRecord[];
    readonly mergeOnFieldId?: AirtableFieldId;
  }): Promise<AirtableProviderResult<AirtableBatchWriteResult>>;
  findRecordsByField(input: {
    readonly baseId: AirtableBaseId;
    readonly tableId: AirtableTableId;
    readonly fieldId: AirtableFieldId;
    readonly value: string;
    readonly limit: number;
  }): Promise<AirtableProviderResult<readonly AirtableRecordId[]>>;
}

export interface AirtableWebhookPort {
  createWebhook(input: {
    readonly baseId: AirtableBaseId;
    readonly notificationUrl: string;
    readonly tableIds: readonly AirtableTableId[];
    readonly watchedFieldIds: readonly AirtableFieldId[];
    readonly includePreviousValues: boolean;
  }): Promise<AirtableProviderResult<{
    readonly webhookId: AirtableWebhookId;
    readonly macSecretBase64: string;
    readonly expiresAt: string;
  }>>;
  refreshWebhook(input: {
    readonly baseId: AirtableBaseId;
    readonly webhookId: AirtableWebhookId;
  }): Promise<AirtableProviderResult<{ readonly expiresAt: string }>>;
  deleteWebhook(input: {
    readonly baseId: AirtableBaseId;
    readonly webhookId: AirtableWebhookId;
  }): Promise<AirtableProviderResult<{ readonly deleted: true }>>;
  listWebhookPayloads(input: {
    readonly baseId: AirtableBaseId;
    readonly webhookId: AirtableWebhookId;
    readonly cursor?: AirtableCursor;
  }): Promise<AirtableProviderResult<AirtableWebhookPayloadPage>>;
}

export interface AirtableProviderPort {
  readonly oauth: AirtableOAuthPort;
  readonly data: AirtableDataPort;
  readonly webhooks: AirtableWebhookPort;
}
