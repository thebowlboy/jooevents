import { describe, expect, test } from 'bun:test';
import { ConfigurationError, loadConfig } from './config';

const valid = {
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: 'https://dev.example.test',
  JOOEVENTS_AUTH_SECRETS: `2:${'n'.repeat(32)},1:${'o'.repeat(32)}`,
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
});
