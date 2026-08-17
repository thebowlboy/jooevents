import { describe, expect, test } from 'bun:test';
import {
  CloudflareAuthConfigurationError,
  loadCloudflareAuthRuntimeConfiguration
} from './auth-config';

const valid = {
  JOOEVENTS_AUTH_RUNTIME_ENABLED: 'true',
  JOOEVENTS_BASE_URL: 'https://events.example.com',
  JOOEVENTS_TRUSTED_ORIGINS: 'https://admin.example.com',
  JOOEVENTS_AUTH_SECRETS: '2:newest-secret-value-at-least-thirty-two-characters,1:previous-secret-value-at-least-thirty-two-characters',
  JOOEVENTS_PERSISTENT_HMAC_KEYS: `1:${Buffer.alloc(32, 7).toString('base64url')}`,
  JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client-id',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-client-secret',
  JOOEVENTS_ADMISSION_MODE: 'reservation_only',
  JOOEVENTS_WORKSPACE_ID: '019c1df8-c9e8-7abc-8def-000000000301'
} as const;

describe('Cloudflare auth configuration', () => {
  test('returns the closed reviewed configuration only when every duty is valid', () => {
    const config = loadCloudflareAuthRuntimeConfiguration(valid);
    expect(config).toMatchObject({
      baseUrl: 'https://events.example.com',
      trustedOrigins: ['https://admin.example.com'],
      authSecrets: [
        { version: 2, value: 'newest-secret-value-at-least-thirty-two-characters' },
        { version: 1, value: 'previous-secret-value-at-least-thirty-two-characters' }
      ],
      googleClientId: 'google-client-id',
      googleClientSecret: 'google-client-secret',
      admissionMode: 'reservation_only',
      workspaceId: '019c1df8-c9e8-7abc-8def-000000000301'
    });
    expect(JSON.stringify(config.keys)).toBe('{}');
  });

  test('reports all missing activation duties without embedding secret values', () => {
    try {
      loadCloudflareAuthRuntimeConfiguration({ JOOEVENTS_AUTH_RUNTIME_ENABLED: 'true' });
      throw new Error('expected configuration refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareAuthConfigurationError);
      const issues = (error as CloudflareAuthConfigurationError).issues;
      expect(issues).toContain('base_url_missing');
      expect(issues).toContain('auth_secrets_missing');
      expect(issues).toContain('persistent_hmac_keys_missing');
      expect(issues).toContain('google_client_id_missing');
      expect(issues).toContain('google_client_secret_missing');
      expect(issues).toContain('admission_mode_invalid');
      expect(issues).toContain('workspace_id_missing');
      expect(JSON.stringify(issues)).not.toContain('secret-value');
    }
  });

  test('refuses wildcard origins, unordered secrets, and domain mode without hd', () => {
    expect(() => loadCloudflareAuthRuntimeConfiguration({
      ...valid,
      JOOEVENTS_TRUSTED_ORIGINS: 'https://*.example.com',
      JOOEVENTS_AUTH_SECRETS: '1:first-secret-value-at-least-thirty-two-characters,2:second-secret-value-at-least-thirty-two-characters',
      JOOEVENTS_ADMISSION_MODE: 'workspace_domain'
    })).toThrow(CloudflareAuthConfigurationError);
    try {
      loadCloudflareAuthRuntimeConfiguration({
        ...valid,
        JOOEVENTS_TRUSTED_ORIGINS: 'https://*.example.com',
        JOOEVENTS_AUTH_SECRETS: '1:first-secret-value-at-least-thirty-two-characters,2:second-secret-value-at-least-thirty-two-characters',
        JOOEVENTS_ADMISSION_MODE: 'workspace_domain'
      });
    } catch (error) {
      expect((error as CloudflareAuthConfigurationError).issues).toEqual(expect.arrayContaining([
        'trusted_origin_wildcard_refused',
        'auth_secrets_not_newest_first',
        'google_hosted_domain_missing'
      ]));
    }
  });

  test('refuses duplicate persistent HMAC material even under different versions', () => {
    const duplicate = Buffer.alloc(32, 9).toString('base64url');
    try {
      loadCloudflareAuthRuntimeConfiguration({
        ...valid,
        JOOEVENTS_PERSISTENT_HMAC_KEYS: `2:${duplicate},1:${duplicate}`
      });
      throw new Error('expected configuration refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareAuthConfigurationError);
      expect((error as CloudflareAuthConfigurationError).issues).toContain(
        'persistent_hmac_keys_duplicate_material'
      );
    }
  });
});
