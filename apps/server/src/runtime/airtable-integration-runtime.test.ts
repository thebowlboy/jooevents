import { describe, expect, test } from 'bun:test';
import {
  createSecretReference,
  createSecretStoreAdapterRef,
  type SecretStore
} from '@jooevents/application';
import {
  parseAirtableBaseId,
  parseAirtableUserId,
  type AirtableDataPort,
  type AirtableOAuthPort
} from '@jooevents/airtable';
import type { CanonicalJson } from '@jooevents/kernel';
import {
  createAirtableIntegrationRuntime,
  type AirtableIntegrationRuntimeRepository,
  type AirtableRuntimeConnection
} from './airtable-integration-runtime';

const connectionId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const secretAdapter = createSecretStoreAdapterRef('secret.memory', 1);
const storedGrant = Object.freeze({
  secretReference: createSecretReference({
    id: 'secret.airtable.grant.1', version: 1, adapter: secretAdapter,
    purpose: 'airtable.oauth.grant', scopeBinding: connectionId
  }),
  accessExpiresAt: '2026-08-17T02:00:00.000Z',
  refreshExpiresAt: '2026-10-17T02:00:00.000Z',
  scopes: Object.freeze([
    'data.records:read', 'data.records:write', 'schema.bases:read',
    'schema.bases:write', 'webhook:manage', 'user.email:read'
  ] as const)
});

class RuntimeRepository implements AirtableIntegrationRuntimeRepository {
  connection: AirtableRuntimeConnection | undefined = Object.freeze({
    id: connectionId, workspaceId, state: 'draft', version: 2,
    providerAccountId: 'usrOwner123', grant: storedGrant
  });
  activated?: { provisioning: unknown; mapping: CanonicalJson };
  async readWorkspaceConnection() { return this.connection; }
  async retireDraftConnection() {}
  async createOAuthConnectionAttempt(
    _input: Parameters<AirtableIntegrationRuntimeRepository['createOAuthConnectionAttempt']>[0]
  ) { throw new Error('not used'); }
  async claimOAuthAttempt() { return undefined; }
  async completeOAuthConnection() { return false; }
  async finishOAuthAttempt() { return false; }
  async activateSelectedBase(input: { provisioning: unknown; mapping: CanonicalJson }) {
    this.activated = input;
    this.connection = Object.freeze({
      ...this.connection!, state: 'provisioning', version: 3,
      provisioning: input.provisioning as NonNullable<AirtableRuntimeConnection['provisioning']>,
      mapping: { revision: 1, value: input.mapping }
    });
    return true;
  }
}

const oauth: AirtableOAuthPort = Object.freeze({
  async exchangeAuthorizationCode() { throw new Error('not used'); },
  async refreshGrant() { throw new Error('not used'); }
});

function unusedDataPort(): AirtableDataPort {
  const fail = async () => ({ kind: 'failure' as const, failure: {
    code: 'not_found' as const, retry: 'never' as const, safeMessage: 'missing'
  } });
  return {
    async getGrantIdentity() { return fail(); },
    async listBases() { return { kind: 'success', value: { bases: Object.freeze([
      { id: parseAirtableBaseId('appReadOnly'), name: 'Read only', permissionLevel: 'read' as const },
      { id: parseAirtableBaseId('appEventOps'), name: 'Event operations', permissionLevel: 'edit' as const }
    ]) } }; },
    createBase: fail, createTable: fail, createField: fail, getBaseSchema: fail,
    listRecords: fail, getRecord: fail, patchRecords: fail, findRecordsByField: fail
  } as AirtableDataPort;
}

const secrets: SecretStore = {
  async create() { throw new Error('not used'); },
  async rotate() { throw new Error('not used'); },
  async revoke() {},
  async withSecret() { throw new Error('not used'); }
};

describe('Airtable owner integration runtime', () => {
  test('shows post-OAuth base selection and activates only the server-owned mapping ceiling', async () => {
    const repository = new RuntimeRepository();
    const runtime = createAirtableIntegrationRuntime({
      workspaceId, baseUrl: 'https://events.example.test', clientId: 'client_jooevents',
      oauth, repository, secretStore: secrets, secretAdapter,
      providerForGrant: unusedDataPort,
      async inspectGrant() { return { kind: 'success', value: {
        userId: parseAirtableUserId('usrOwner123'), scopes: storedGrant.scopes
      } }; },
      async authorize() { return 'authorized'; },
      controls: {
        async setSharing() {}, async syncNow() {}, async setPaused() {},
        async revertHistory() {}, async disconnect() {}
      },
      newId: () => '33333333-3333-4333-8333-333333333333', now: () => 1_000
    });
    expect(await runtime.read()).toMatchObject({
      state: 'provisioning', setupStage: 'choose_base', accountLabel: 'Airtable account'
    });
    expect((await runtime.listBases()).map((base) => base.name)).toEqual(['Event operations', 'Read only']);
    const activated = await runtime.activate({
      baseId: 'appEventOps',
      directions: [
        { areaKey: 'tasks', direction: 'work_from_airtable' },
        { areaKey: 'schedule', direction: 'keep_airtable_updated' }
      ]
    });
    expect(activated).toMatchObject({
      state: 'provisioning', setupStage: 'adding_tables', baseName: 'Event operations'
    });
    expect(repository.activated?.mapping).toMatchObject({
      revision: 1,
      areas: expect.arrayContaining([
        { areaKey: 'tasks', direction: 'work_from_airtable' },
        { areaKey: 'schedule', direction: 'keep_airtable_updated' }
      ]),
      fields: expect.arrayContaining([
        expect.objectContaining({ fieldKey: 'task.status', mode: 'editable_in_airtable' })
      ])
    });
  });

  test('refuses a base whose scoped grant is read-only', async () => {
    const runtime = createAirtableIntegrationRuntime({
      workspaceId, baseUrl: 'https://events.example.test', clientId: 'client_jooevents',
      oauth, repository: new RuntimeRepository(), secretStore: secrets, secretAdapter,
      providerForGrant: unusedDataPort,
      async inspectGrant() { throw new Error('not used'); },
      async authorize() { return 'authorized'; },
      controls: {
        async setSharing() {}, async syncNow() {}, async setPaused() {},
        async revertHistory() {}, async disconnect() {}
      }
    });
    await expect(runtime.activate({
      baseId: 'appReadOnly', directions: [{ areaKey: 'tasks', direction: 'work_from_airtable' }]
    })).rejects.toThrow('base_not_writable');
  });

  test('reconnect keeps the managed base anchor and replaces only the OAuth grant', async () => {
    const repository = new RuntimeRepository();
    repository.connection = Object.freeze({
      ...repository.connection!,
      state: 'needs_reconnect',
      publicCallbackRef: 'callback-reference-with-enough-entropy-1234567890'
    });
    let attempt: Parameters<AirtableIntegrationRuntimeRepository['createOAuthConnectionAttempt']>[0] | undefined;
    repository.createOAuthConnectionAttempt = async (value) => { attempt = value; };
    const revoked: string[] = [];
    const reconnectSecrets: SecretStore = {
      async create(value) {
        return createSecretReference({
          id: 'secret.airtable.reconnect.attempt', version: 1,
          adapter: value.adapter, purpose: value.purpose, scopeBinding: value.scopeBinding
        });
      },
      async rotate() { throw new Error('not used'); },
      async revoke(value) { revoked.push(value.reference.id); },
      async withSecret() { throw new Error('not used'); }
    };
    const runtime = createAirtableIntegrationRuntime({
      workspaceId, baseUrl: 'https://events.example.test', clientId: 'client_jooevents',
      oauth, repository, secretStore: reconnectSecrets, secretAdapter,
      providerForGrant: unusedDataPort,
      async inspectGrant() { throw new Error('not used'); },
      async authorize() { return 'authorized'; },
      controls: {
        async setSharing() {}, async syncNow() {}, async setPaused() {},
        async revertHistory() {}, async disconnect() {}
      },
      newId: () => '33333333-3333-4333-8333-333333333333', now: () => 1_000
    });
    const started = await runtime.startOAuth();
    expect(new URL(started.authorizationUrl).hostname).toBe('airtable.com');
    expect(revoked).toEqual([storedGrant.secretReference.id]);
    expect(attempt).toMatchObject({
      connectionId,
      workspaceId,
      publicCallbackRef: 'callback-reference-with-enough-entropy-1234567890'
    });
  });
});
