import { describe, expect, test } from 'bun:test';
import { ConfigurationError, loadConfig, loadEphemeralLiveConfig } from './config';

const durableKey = (seed: number) => Buffer.alloc(32, seed).toString('base64url');

const valid = {
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: 'https://dev.example.test',
  JOOEVENTS_AUTH_SECRETS: `2:${'n'.repeat(32)},1:${'o'.repeat(32)}`,
  JOOEVENTS_REQUEST_HASH_KEYS: `2:${durableKey(1)},1:${durableKey(2)}`,
  JOOEVENTS_IDEMPOTENCY_KEYS: `2:${durableKey(3)},1:${durableKey(4)}`,
  JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: `2:${durableKey(5)},1:${durableKey(6)}`,
  JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
  JOOEVENTS_ADMISSION_MODE: 'pending',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'jooevents.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/jooevents-test'
};

describe('loadConfig', () => {
  test('returns versioned secrets and bounded linking policy', () => {
    const config = loadConfig(valid);
    expect(config.authSecrets.map((secret) => secret.version)).toEqual([2, 1]);
    expect(config.linkTokenTtlSeconds).toBe(900);
    expect(config.linkRequireAuthTime).toBe(false);
    expect(config.durableCryptoProfiles).toBeDefined();
    expect(JSON.stringify(config)).not.toContain(durableKey(1));
    expect(JSON.stringify(config)).not.toContain(durableKey(6));
  });

  test('reports all missing startup duties together', () => {
    try {
      loadConfig({});
      throw new Error('expected configuration error');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const message = String(error);
      expect(message).toContain('JOOEVENTS_BASE_URL');
      expect(message).toContain('JOOEVENTS_GOOGLE_CLIENT_ID');
      expect(message).toContain('JOOEVENTS_DATABASE_DRIVER');
    }
  });

  test('requires an hd claim setting for domain admission', () => {
    expect(() => loadConfig({ ...valid, JOOEVENTS_ADMISSION_MODE: 'workspace_domain' })).toThrow('JOOEVENTS_GOOGLE_HOSTED_DOMAIN');
  });

  test('fails configured startup for missing durable key duties without echoing material', () => {
    const { JOOEVENTS_REQUEST_HASH_KEYS: _missing, ...withoutRequestHashKeys } = valid;
    expect(() => loadConfig(withoutRequestHashKeys)).toThrow(
      'JOOEVENTS_REQUEST_HASH_KEYS: missing_key_ring'
    );
    const repeated = durableKey(3);
    expect(() => loadConfig({
      ...valid,
      JOOEVENTS_REQUEST_HASH_KEYS: `2:${repeated},1:${durableKey(2)}`
    })).toThrow('JOOEVENTS_IDEMPOTENCY_KEYS: duplicate_key_material');
    try {
      loadConfig({
        ...valid,
        JOOEVENTS_REQUEST_HASH_KEYS: `2:${repeated},1:${durableKey(2)}`
      });
    } catch (error) {
      expect(String(error)).not.toContain(repeated);
    }
  });
});

describe('loadEphemeralLiveConfig', () => {
  test('requires no caller database path and discards configured storage paths', () => {
    const environment = {
      ...valid,
      JOOEVENTS_DATABASE_PATH: '/must/not/be/used.sqlite',
      JOOEVENTS_DATABASE_URL: 'https://must.not.be.used.example/database',
      JOOEVENTS_DATA_DIRECTORY: '/must/not/be/used'
    };
    const config = loadEphemeralLiveConfig(environment);
    expect(config.databaseDriver).toBe('sqlite');
    expect(config.databasePath).toBeUndefined();
    expect(config.databaseUrl).toBeUndefined();
    expect(config.dataDirectory).toBeUndefined();
    expect(config.durableCryptoProfiles).toBeUndefined();

    const { JOOEVENTS_DATABASE_PATH: _databasePath, JOOEVENTS_DATABASE_URL: _databaseUrl,
      JOOEVENTS_DATA_DIRECTORY: _dataDirectory,
      JOOEVENTS_REQUEST_HASH_KEYS: _requestHashKeys,
      JOOEVENTS_IDEMPOTENCY_KEYS: _idempotencyKeys,
      JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: _classifiedPayloadKeys,
      ...withoutStoragePaths } = environment;
    expect(loadEphemeralLiveConfig(withoutStoragePaths).databaseDriver).toBe('sqlite');
  });

  test('refuses a non-SQLite ephemeral driver', () => {
    expect(() => loadEphemeralLiveConfig({
      ...valid,
      JOOEVENTS_DATABASE_DRIVER: 'postgres'
    })).toThrow('ephemeral server requires the SQLite database driver');
  });
});
