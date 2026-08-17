import type { SecretStore, SecretStoreAdapterRef } from '@jooevents/application';
import type {
  AirtableBaseId,
  AirtableFieldId,
  AirtableProviderFailure,
  AirtableTableId,
  AirtableWebhookId,
  AirtableWebhookPort
} from '@jooevents/airtable';
import {
  storeAirtableWebhookMacSecret,
  type StoredAirtableWebhookMacSecret
} from './grant-secrets';

export interface AirtableWebhookLifecycleRepository {
  saveCreated(input: Readonly<{
    connectionId: string;
    baseId: AirtableBaseId;
    webhookId: AirtableWebhookId;
    macSecret: StoredAirtableWebhookMacSecret;
    expiresAtMs: number;
    nowMs: number;
  }>): Promise<void>;
  saveRefreshed(input: Readonly<{
    connectionId: string;
    webhookId: AirtableWebhookId;
    expiresAtMs: number;
    nowMs: number;
  }>): Promise<boolean>;
  saveDeleted(input: Readonly<{
    connectionId: string;
    webhookId: AirtableWebhookId;
    nowMs: number;
  }>): Promise<boolean>;
}

export type AirtableWebhookLifecycleResult<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'retry'; readonly code: string; readonly retryAfterMs: number }
  | { readonly kind: 'attention'; readonly code: string };

function providerFailure(failure: AirtableProviderFailure): AirtableWebhookLifecycleResult<never> {
  if (failure.retry === 'after_delay') {
    return {
      kind: 'retry',
      code: failure.code,
      retryAfterMs: Math.max(1_000, Math.min(failure.retryAfterMs ?? 30_000, 86_400_000))
    };
  }
  return { kind: 'attention', code: failure.code };
}

function expiry(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function createManagedAirtableWebhook(input: Readonly<{
  connectionId: string;
  baseId: AirtableBaseId;
  notificationUrl: string;
  tableIds: readonly AirtableTableId[];
  watchedFieldIds: readonly AirtableFieldId[];
  webhooks: AirtableWebhookPort;
  secretStore: SecretStore;
  secretAdapter: SecretStoreAdapterRef;
  repository: AirtableWebhookLifecycleRepository;
  nowMs: number;
}>): Promise<AirtableWebhookLifecycleResult<Readonly<{
  webhookId: AirtableWebhookId;
  expiresAtMs: number;
}>>> {
  const notificationUrl = new URL(input.notificationUrl);
  if (notificationUrl.protocol !== 'https:' || notificationUrl.username || notificationUrl.password
    || notificationUrl.hash) {
    throw new TypeError('airtable_webhook_notification_url_invalid');
  }
  const created = await input.webhooks.createWebhook({
    baseId: input.baseId,
    notificationUrl: notificationUrl.toString(),
    tableIds: input.tableIds,
    watchedFieldIds: input.watchedFieldIds,
    includePreviousValues: false
  });
  if (created.kind === 'failure') return providerFailure(created.failure);
  const expiresAtMs = expiry(created.value.expiresAt);
  if (expiresAtMs === undefined) {
    await input.webhooks.deleteWebhook({
      baseId: input.baseId,
      webhookId: created.value.webhookId
    }).catch(() => undefined);
    return { kind: 'attention', code: 'webhook_expiry_invalid' };
  }
  let stored: StoredAirtableWebhookMacSecret | undefined;
  try {
    stored = await storeAirtableWebhookMacSecret({
      secretStore: input.secretStore,
      adapter: input.secretAdapter,
      connectionId: input.connectionId,
      macSecretBase64: created.value.macSecretBase64
    });
    await input.repository.saveCreated({
      connectionId: input.connectionId,
      baseId: input.baseId,
      webhookId: created.value.webhookId,
      macSecret: stored,
      expiresAtMs,
      nowMs: input.nowMs
    });
  } catch {
    await input.webhooks.deleteWebhook({
      baseId: input.baseId,
      webhookId: created.value.webhookId
    }).catch(() => undefined);
    if (stored) {
      await input.secretStore.revoke({
        reference: stored.secretReference,
        expectedVersion: stored.secretReference.version
      }).catch(() => undefined);
    }
    return { kind: 'attention', code: 'webhook_activation_not_durable' };
  }
  return {
    kind: 'completed',
    value: Object.freeze({ webhookId: created.value.webhookId, expiresAtMs })
  };
}

export async function refreshManagedAirtableWebhook(input: Readonly<{
  connectionId: string;
  baseId: AirtableBaseId;
  webhookId: AirtableWebhookId;
  webhooks: AirtableWebhookPort;
  repository: AirtableWebhookLifecycleRepository;
  nowMs: number;
}>): Promise<AirtableWebhookLifecycleResult<Readonly<{ expiresAtMs: number }>>> {
  const refreshed = await input.webhooks.refreshWebhook({
    baseId: input.baseId, webhookId: input.webhookId
  });
  if (refreshed.kind === 'failure') return providerFailure(refreshed.failure);
  const expiresAtMs = expiry(refreshed.value.expiresAt);
  if (expiresAtMs === undefined) return { kind: 'attention', code: 'webhook_expiry_invalid' };
  const saved = await input.repository.saveRefreshed({
    connectionId: input.connectionId,
    webhookId: input.webhookId,
    expiresAtMs,
    nowMs: input.nowMs
  });
  return saved
    ? { kind: 'completed', value: Object.freeze({ expiresAtMs }) }
    : { kind: 'attention', code: 'webhook_registration_stale' };
}

export async function deleteManagedAirtableWebhook(input: Readonly<{
  connectionId: string;
  baseId: AirtableBaseId;
  webhookId: AirtableWebhookId;
  webhooks: AirtableWebhookPort;
  repository: AirtableWebhookLifecycleRepository;
  nowMs: number;
}>): Promise<AirtableWebhookLifecycleResult<Readonly<{ deleted: true }>>> {
  const deleted = await input.webhooks.deleteWebhook({
    baseId: input.baseId, webhookId: input.webhookId
  });
  if (deleted.kind === 'failure' && deleted.failure.code !== 'not_found') {
    return providerFailure(deleted.failure);
  }
  const saved = await input.repository.saveDeleted({
    connectionId: input.connectionId,
    webhookId: input.webhookId,
    nowMs: input.nowMs
  });
  return saved
    ? { kind: 'completed', value: Object.freeze({ deleted: true }) }
    : { kind: 'attention', code: 'webhook_registration_stale' };
}
