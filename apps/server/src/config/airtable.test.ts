import { describe, expect, test } from 'bun:test';
import {
  AirtableProviderConfigurationError,
  loadAirtableProviderConfig
} from './airtable';

describe('Airtable provider configuration', () => {
  test('is structurally disabled unless every OAuth and retained-secret duty is present', () => {
    expect(loadAirtableProviderConfig({})).toBeUndefined();
    expect(() => loadAirtableProviderConfig({
      JOOEVENTS_AIRTABLE_OAUTH_CLIENT_ID: 'client'
    })).toThrow(new AirtableProviderConfigurationError('partial_configuration'));
  });

  test('leases secrets without making them enumerable', async () => {
    const key = Buffer.alloc(32, 7).toString('base64url');
    const config = loadAirtableProviderConfig({
      JOOEVENTS_AIRTABLE_OAUTH_CLIENT_ID: 'client_jooevents',
      JOOEVENTS_AIRTABLE_OAUTH_CLIENT_SECRET: 'client-secret-value',
      JOOEVENTS_AIRTABLE_SECRET_STORE_KEY: key
    })!;
    expect(JSON.stringify(config)).toBe('{"clientId":"client_jooevents","clientSecretLease":{}}');
    expect(await config.clientSecretLease.withClientSecret(async (secret) => secret.length)).toBe(19);
    expect(config.withSecretStoreKey((bytes) => bytes.byteLength)).toBe(32);
  });
});
