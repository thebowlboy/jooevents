import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { BETTER_AUTH_SCHEMA } from '@jooevents/persistence/better-auth-schema-definition';

/** How long an issued workspace sign-in link stays valid, in seconds. */
export const WORKSPACE_SIGN_IN_LINK_EXPIRES_IN_SECONDS = 900;

export interface AuthSecret {
  readonly version: number;
  readonly value: string;
}

export interface JooEventsAuthConfiguration {
  readonly baseUrl: string;
  readonly trustedOrigins: readonly string[];
  readonly authSecrets: readonly AuthSecret[];
  readonly googleClientId?: string;
  readonly googleClientSecret?: string;
  readonly admissionMode: 'pending' | 'workspace_domain' | 'reservation_only';
  readonly googleHostedDomain?: string;
}

export interface WorkspaceMagicLinkComposition {
  /** Receives the raw value only at the classified delivery boundary. */
  deliver(input: {
    readonly email: string;
    readonly url: string;
    readonly token: string;
  }): Promise<void>;
}

/** Reviewed runtime-neutral Better Auth composition. Admission remains separate. */
export function createJooEventsAuth(
  config: JooEventsAuthConfiguration,
  database: Parameters<typeof drizzleAdapter>[0],
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
      schema: BETTER_AUTH_SCHEMA,
      transaction: true
    }),
    user: { modelName: 'auth_users' },
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
    verification: { modelName: 'auth_verifications' },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'auth_rate_limits'
    },
    socialProviders: config.googleClientId && config.googleClientSecret ? {
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
    } : {},
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
            storeToken: 'hashed',
            disableSignUp: false,
            generateToken: () => {
              const bytes = new Uint8Array(16);
              crypto.getRandomValues(bytes);
              return Buffer.from(bytes).toString('base64url');
            },
            sendMagicLink: async ({ email, url, token }) => {
              await workspaceMagicLink.deliver({ email, url, token });
            }
          })
        ]
  });
}

export type JooEventsAuth = ReturnType<typeof createJooEventsAuth>;
