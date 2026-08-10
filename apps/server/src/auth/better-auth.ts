import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { SQLiteDatabase } from '@jooevents/persistence';
import {
  authAccounts,
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications
} from '@jooevents/persistence';
import type { ServerConfig } from '../config';

/** The reviewed Better Auth composition. Domain admission remains outside this object. */
export function createAuth(config: ServerConfig, database: SQLiteDatabase) {
  return betterAuth({
    appName: 'JooEvents',
    baseURL: config.baseUrl,
    basePath: '/api/auth',
    secrets: [...config.authSecrets],
    trustedOrigins: [config.baseUrl, ...config.trustedOrigins],
    database: drizzleAdapter(database, {
      provider: 'sqlite',
      schema: {
        auth_users: authUsers,
        auth_accounts: authAccounts,
        auth_sessions: authSessions,
        auth_verifications: authVerifications,
        auth_rate_limits: authRateLimits
      },
      transaction: true
    }),
    user: {
      modelName: 'auth_users'
    },
    session: {
      modelName: 'auth_sessions',
      cookieCache: { enabled: false }
    },
    account: {
      modelName: 'auth_accounts',
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
      storeAccountCookie: false,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false
      }
    },
    verification: {
      modelName: 'auth_verifications'
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'auth_rate_limits'
    },
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        scope: ['openid', 'email', 'profile'],
        disableDefaultScope: true,
        accessType: 'online',
        ...(config.admissionMode === 'workspace_domain' && config.googleHostedDomain
          ? { hd: config.googleHostedDomain }
          : {})
      }
    },
    advanced: {
      disableCSRFCheck: false,
      disableOriginCheck: false,
      trustedProxyHeaders: false,
      useSecureCookies: new URL(config.baseUrl).protocol === 'https:',
      database: { generateId: () => crypto.randomUUID() }
    }
  });
}

export type JooEventsAuth = ReturnType<typeof createAuth>;
