import { describe, expect, test } from 'bun:test';
import {
  CommunicationsProviderConfigurationError,
  loadCommunicationsProviderConfig
} from './communications';

describe('communications provider configuration', () => {
  test('is inert by default', () => {
    expect(loadCommunicationsProviderConfig({})).toEqual({
      mode: 'disabled', callbacks: 'not_supported', inbound: 'not_enabled',
      readinessChecks: 'unmounted', diagnosticTests: 'not_enabled'
    });
  });

  test('loads a Workers binding without enabling external operations', () => {
    expect(loadCommunicationsProviderConfig({
      JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_workers',
      JOOEVENTS_CLOUDFLARE_EMAIL_BINDING_NAME: 'EMAIL_SENDING'
    })).toMatchObject({
      mode: 'cloudflare_workers', bindingName: 'EMAIL_SENDING',
      readinessChecks: 'unmounted', diagnosticTests: 'not_enabled'
    });
  });

  test('loads REST configuration through an opaque secret reference', () => {
    expect(loadCommunicationsProviderConfig({
      JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_rest',
      JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account_123',
      JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID: 'zone_123',
      JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE: 'deployment.secret',
      JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE: 'cloudflare-email-token'
    })).toMatchObject({
      mode: 'cloudflare_rest', accountId: 'account_123', zoneId: 'zone_123',
      apiTokenSecret: {
        storeKey: 'deployment.secret', reference: 'cloudflare-email-token'
      }
    });
  });

  test('loads an explicit review-only recipient boundary', () => {
    expect(loadCommunicationsProviderConfig({
      JOOEVENTS_REVIEW_ENTRY_MODE: 'organizer',
      JOOEVENTS_REVIEW_EMAIL_RECIPIENT_ALLOWLIST: 'Reviewer@Example.Test, second@example.test',
      JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_rest',
      JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account_123',
      JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID: 'zone_123',
      JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE: 'deployment.secret',
      JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE: 'cloudflare-email-token'
    })).toMatchObject({
      mode: 'cloudflare_rest',
      reviewRecipientAllowlist: ['reviewer@example.test', 'second@example.test']
    });
  });

  test('never applies a review recipient boundary to an ordinary deployment', () => {
    expect(() => loadCommunicationsProviderConfig({
      JOOEVENTS_REVIEW_EMAIL_RECIPIENT_ALLOWLIST: 'reviewer@example.test'
    })).toThrow('accepted only with organizer review entry');
  });

  test('requires a nonempty boundary for live email in organizer review mode', () => {
    expect(() => loadCommunicationsProviderConfig({
      JOOEVENTS_REVIEW_ENTRY_MODE: 'organizer',
      JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_rest',
      JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account_123',
      JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID: 'zone_123',
      JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE: 'deployment.secret',
      JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE: 'cloudflare-email-token'
    })).toThrow('is required for cloudflare_rest in organizer review mode');
  });

  test('rejects raw token configuration', () => {
    expect(() => loadCommunicationsProviderConfig({
      JOOEVENTS_EMAIL_PROVIDER_MODE: 'disabled',
      JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN: 'must-not-be-read'
    })).toThrow(CommunicationsProviderConfigurationError);
  });
});
