import { describe, expect, test } from 'bun:test';
import {
  createSecretReference,
  createSecretStoreAdapterRef,
  type SecretReference,
  type SecretStore
} from '@jooevents/application';
import { FakeAirtableProvider } from '@jooevents/airtable';
import type { AggregateVersion, CanonicalJson } from '@jooevents/kernel';
import { runAirtableActivationStep, type AirtableActivationRepository } from './activation';
import { AIRTABLE_INITIAL_FIELD_POLICIES } from './inbound-policy';
import { compileMapping } from './mapping';
import {
  bindManagedSchema,
  createDefaultManagedBaseManifest,
  toAirtableCreateTables
} from './manifest';
import { createManagedSelectedBaseProvisioningState } from './provisioning';

class MemorySecrets implements SecretStore {
  bytes?: Uint8Array;
  async create(input: Parameters<SecretStore['create']>[0]): Promise<SecretReference> {
    this.bytes = input.secret.slice();
    return createSecretReference({
      id: 'secret.airtable.activation.webhook', version: 1, adapter: input.adapter,
      purpose: input.purpose, scopeBinding: input.scopeBinding
    });
  }
  async rotate(): Promise<SecretReference> { throw new Error('unused'); }
  async revoke(_input: { reference: SecretReference; expectedVersion: AggregateVersion }) {}
  async withSecret<Value>(input: Parameters<SecretStore['withSecret']>[0]): Promise<Value> {
    if (!this.bytes) throw new Error('missing');
    return input.consume(this.bytes.slice()) as Promise<Value>;
  }
}

describe('Airtable activation worker', () => {
  test('resumes from a durable ready provisioning state, creates the webhook, then activates', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const manifest = createDefaultManagedBaseManifest({
      scope: 'all_events', includeSpeakerEmail: false, includeSpeakerPhone: false
    });
    const created = await provider.data.createBase({
      workspaceId, name: 'JooEvents', tables: toAirtableCreateTables(manifest)
    });
    if (created.kind === 'failure') throw new Error(created.failure.code);
    const bound = bindManagedSchema(manifest, created.value);
    if (bound.kind === 'drift') throw new Error(bound.code);
    const initial = createManagedSelectedBaseProvisioningState({
      connectionId: 'connection-activation', providerBaseId: created.value.id,
      baseName: 'JooEvents', manifest
    });
    const ready = Object.freeze({ ...initial, phase: 'ready' as const, binding: bound.binding, version: 8 });
    const compiled = compileMapping({
      draft: {
        manifestVersion: manifest.version, revision: 1,
        areas: [
          { areaKey: 'people', direction: 'work_from_airtable', fields: [
            { fieldKey: 'speaker.requested_status', userMode: 'request_from_airtable' },
            { fieldKey: 'speaker.cancellation_note', userMode: 'request_from_airtable' }
          ] },
          { areaKey: 'tasks', direction: 'work_from_airtable', fields: [
            { fieldKey: 'task.status', userMode: 'editable_in_airtable' }
          ] }
        ]
      },
      policies: AIRTABLE_INITIAL_FIELD_POLICIES,
      canReadRecords: true,
      canWriteRecords: true
    });
    if (compiled.kind === 'refused') throw new Error('mapping refused');
    let webhookActive = false;
    let activated = false;
    const repository: AirtableActivationRepository = {
      async readProvisioningActivation() {
        return {
          connectionVersion: 3,
          publicCallbackRef: 'callback-reference-with-enough-entropy-1234567890',
          provisioning: ready,
          mappingRevision: 1,
          mapping: compiled.mapping as unknown as CanonicalJson,
          webhookActive
        };
      },
      async claim() { return undefined; },
      async complete() { return false; },
      async saveCreated() { webhookActive = true; },
      async saveRefreshed() { return true; },
      async saveDeleted() { return true; },
      async finalizeProvisioningActivation() {
        if (!webhookActive) return false;
        activated = true;
        return true;
      }
    };
    const secrets = new MemorySecrets();
    const result = await runAirtableActivationStep({
      connectionId: 'connection-activation', workerId: 'worker-1', nowMs: 1_000,
      baseUrl: 'https://events.example.test', manifest, repository,
      provider: provider.data, webhooks: provider.webhooks,
      source: { async listPage() { throw new Error('ready state must not resnapshot'); } },
      secretStore: secrets,
      secretAdapter: createSecretStoreAdapterRef('secret.memory', 1)
    });
    expect(result).toEqual({ kind: 'activated' });
    expect(webhookActive).toBe(true);
    expect(activated).toBe(true);
    expect(secrets.bytes?.byteLength).toBeGreaterThanOrEqual(16);
  });
});
