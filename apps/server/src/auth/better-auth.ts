import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import type { SQLiteDatabase } from '@jooevents/persistence';
import {
  authAccounts,
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications
} from '@jooevents/persistence';
import type { ServerConfig } from '../config';

/** How long an issued workspace sign-in link stays valid, in seconds. */
export const WORKSPACE_SIGN_IN_LINK_EXPIRES_IN_SECONDS = 900;

export interface WorkspaceMagicLinkComposition {
  /**
   * Hands the built verification URL to the runtime's gated outbox delivery.
   * The gate lives behind this seam: an ineligible address must be dropped
   * silently so the HTTP surface stays byte-uniform. Tokens are stored hashed
   * by the plugin; the raw link exists only in the delivered mail.
   */
  deliver(input: {
    readonly email: string;
    readonly url: string;
  }): Promise<void>;
}

/** The reviewed Better Auth composition. Domain admission remains outside this object. */
export function createAuth(
  config: ServerConfig,
  database: SQLiteDatabase,
  options?: { readonly magicLink?: WorkspaceMagicLinkComposition }
) {
  const workspaceMagicLink = options?.magicLink;
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
    },
    plugins: workspaceMagicLink === undefined
      ? []
      : [
          magicLink({
            expiresIn: WORKSPACE_SIGN_IN_LINK_EXPIRES_IN_SECONDS,
            // Hash-only at rest; the token is consumed atomically on first
            // verification, so a link works once.
            storeToken: 'hashed',
            // Sign-up stays possible so a reservation-named address can
            // complete a FIRST sign-in (owner revision, 2026-08-14); the
            // gated deliver below is what keeps unreserved, unregistered
            // addresses from ever receiving a usable token.
            disableSignUp: false,
            sendMagicLink: async ({ email, url }) => {
              await workspaceMagicLink.deliver({ email, url });
            }
          })
        ]
  });
}

export type JooEventsAuth = ReturnType<typeof createAuth>;
