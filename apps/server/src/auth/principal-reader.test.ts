import { afterEach, describe, expect, test } from 'bun:test';
import { createProvisioningService, type ProvisioningStore } from '@jooevents/application';
import { success } from '@jooevents/identity-access';
import { openSQLite } from '@jooevents/persistence';
import { loadConfig } from '../config';
import { createSQLiteAuthPrincipalReader } from './principal-reader';

const databases: ReturnType<typeof openSQLite>[] = [];
const observedAt = '2026-08-09T08:00:00.000Z';

function domainConfig(hostedDomain: string) {
  return loadConfig({
    JOOEVENTS_BASE_URL: 'http://localhost:5176',
    JOOEVENTS_TRUSTED_ORIGINS: '',
    JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
    JOOEVENTS_REQUEST_HASH_KEYS: `1:${Buffer.alloc(32, 1).toString('base64url')}`,
    JOOEVENTS_IDEMPOTENCY_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: `1:${Buffer.alloc(32, 3).toString('base64url')}`,
    JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
    JOOEVENTS_ADMISSION_MODE: 'workspace_domain',
    JOOEVENTS_GOOGLE_HOSTED_DOMAIN: hostedDomain,
    JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
    JOOEVENTS_DATABASE_DRIVER: 'sqlite',
    JOOEVENTS_DATABASE_PATH: 'test.sqlite',
    JOOEVENTS_BLOB_DRIVER: 'filesystem',
    JOOEVENTS_DATA_DIRECTORY: '/tmp/jooevents-principal-reader-test'
  });
}

function unprovisionedStore(onCommit: () => void): ProvisioningStore {
  return {
    findAuthUserLink: async () => undefined,
    loadSignInEvidence: async () => ({}),
    commitSignInPlan: async () => {
      onCommit();
      throw new Error('domain admission without retained evidence must not commit');
    },
    readCommittedAccess: async () => {
      throw new Error('there is no committed access state');
    },
    markProvisioningFailure: async () => {}
  };
}

afterEach(() => {
  while (databases.length) databases.pop()?.sqlite.close();
});

describe('SQLite auth principal evidence', () => {
  test('a domain configuration change cannot become provider evidence when no verified hd claim was retained', async () => {
    const opened = openSQLite(':memory:');
    databases.push(opened);
    const timestamp = Date.parse(observedAt);
    opened.sqlite.query(`insert into auth_users (id, name, email, email_verified, image, created_at, updated_at) values (?, ?, ?, 1, null, ?, ?)`)
      .run('auth_ada', 'Ada Lovelace', 'ada@example.com', timestamp, timestamp);
    opened.sqlite.query(`insert into auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at) values (?, ?, 'google', ?, ?, ?)`)
      .run('account_ada', 'google-subject-ada', 'auth_ada', timestamp, timestamp);

    const reader = createSQLiteAuthPrincipalReader(opened.sqlite);
    const principal = await reader.getVerifiedClaims('auth_ada');
    expect(principal.kind).toBe('success');
    if (principal.kind !== 'success') throw new TypeError('expected verified principal claims');
    expect(principal.data.hostedDomain).toBeUndefined();

    let commitCalls = 0;
    for (const config of [domainConfig('original.example'), domainConfig('replacement.example')]) {
      const service = createProvisioningService({
        principals: reader,
        store: unprovisionedStore(() => { commitCalls += 1; }),
        admission: {
          mode: config.admissionMode,
          ...(config.googleHostedDomain ? { hostedDomain: config.googleHostedDomain } : {})
        }
      });
      const result = await service.ensureAuthPrincipalProvisioned({
        authUserId: 'auth_ada',
        workspaceId: 'workspace_summit',
        correlationId: `correlation_${config.googleHostedDomain}`,
        now: observedAt
      });
      expect(result.kind).toBe('success');
      if (result.kind === 'success') expect(result.data).toEqual({ state: 'blocked', code: 'not_admitted' });
    }
    expect(commitCalls).toBe(0);
  });
});
