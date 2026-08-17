import { describe, expect, test } from 'bun:test';
import {
  createSecretReference,
  createSecretStoreAdapterRef,
  type SecretReference,
  type SecretStore
} from '@jooevents/application';
import { FakeAirtableProvider } from '@jooevents/airtable';
import {
  createManagedAirtableWebhook,
  deleteManagedAirtableWebhook,
  refreshManagedAirtableWebhook,
  type AirtableWebhookLifecycleRepository
} from './webhook-lifecycle';

class MemorySecrets implements SecretStore {
  value: Uint8Array | undefined;
  failCreate = false;
  revoked = false;
  async create(input: Parameters<SecretStore['create']>[0]): Promise<SecretReference> {
    if (this.failCreate) throw new Error('secret unavailable');
    this.value = Uint8Array.from(input.secret);
    return createSecretReference({
      id: 'secret.airtable.webhook.lifecycle.1',
      version: 1,
      adapter: input.adapter,
      purpose: input.purpose,
      scopeBinding: input.scopeBinding
    });
  }
  async rotate(): Promise<SecretReference> { throw new Error('unused'); }
  async revoke() { this.revoked = true; this.value?.fill(0); }
  async withSecret<Value>(input: Parameters<SecretStore['withSecret']>[0]): Promise<Value> {
    if (!this.value) throw new Error('missing');
    return input.consume(Uint8Array.from(this.value)) as Promise<Value>;
  }
}

function repository() {
  const calls: string[] = [];
  const value: AirtableWebhookLifecycleRepository = {
    async saveCreated() { calls.push('created'); },
    async saveRefreshed() { calls.push('refreshed'); return true; },
    async saveDeleted() { calls.push('deleted'); return true; }
  };
  return { calls, value };
}

describe('managed Airtable webhook lifecycle', () => {
  test('stores the one-time MAC before recording create, then persists refresh and delete', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const base = await provider.data.createBase({
      workspaceId, name: 'JooEvents',
      tables: [{ name: 'Tasks', fields: [{ name: 'Task', type: 'singleLineText' }] }]
    });
    if (base.kind === 'failure') throw new Error(base.failure.code);
    const table = base.value.tables[0]!;
    const secrets = new MemorySecrets();
    const stored = repository();
    const created = await createManagedAirtableWebhook({
      connectionId: 'connection-1',
      baseId: base.value.id,
      notificationUrl: 'https://events.example.test/webhooks/airtable/opaque',
      tableIds: [table.id],
      watchedFieldIds: [table.fields[0]!.id],
      webhooks: provider.webhooks,
      secretStore: secrets,
      secretAdapter: createSecretStoreAdapterRef('secret.memory', 1),
      repository: stored.value,
      nowMs: 1_000
    });
    expect(created.kind).toBe('completed');
    expect(secrets.value?.byteLength).toBeGreaterThanOrEqual(16);
    expect(stored.calls).toEqual(['created']);
    if (created.kind !== 'completed') throw new Error('expected webhook');
    expect((await refreshManagedAirtableWebhook({
      connectionId: 'connection-1', baseId: base.value.id,
      webhookId: created.value.webhookId, webhooks: provider.webhooks,
      repository: stored.value, nowMs: 2_000
    })).kind).toBe('completed');
    expect((await deleteManagedAirtableWebhook({
      connectionId: 'connection-1', baseId: base.value.id,
      webhookId: created.value.webhookId, webhooks: provider.webhooks,
      repository: stored.value, nowMs: 3_000
    })).kind).toBe('completed');
    expect(stored.calls).toEqual(['created', 'refreshed', 'deleted']);
  });

  test('compensates provider creation when the MAC cannot be retained', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const base = await provider.data.createBase({
      workspaceId, name: 'JooEvents',
      tables: [{ name: 'Tasks', fields: [{ name: 'Task', type: 'singleLineText' }] }]
    });
    if (base.kind === 'failure') throw new Error(base.failure.code);
    const secrets = new MemorySecrets();
    secrets.failCreate = true;
    const stored = repository();
    expect(await createManagedAirtableWebhook({
      connectionId: 'connection-1', baseId: base.value.id,
      notificationUrl: 'https://events.example.test/webhooks/airtable/opaque',
      tableIds: [base.value.tables[0]!.id], watchedFieldIds: [],
      webhooks: provider.webhooks, secretStore: secrets,
      secretAdapter: createSecretStoreAdapterRef('secret.memory', 1),
      repository: stored.value, nowMs: 1_000
    })).toEqual({ kind: 'attention', code: 'webhook_activation_not_durable' });
    expect(stored.calls).toEqual([]);
  });
});
