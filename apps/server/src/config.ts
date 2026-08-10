import { z } from 'zod';

const environmentSchema = z.object({
  JOOEVENTS_BASE_URL: z.url(),
  JOOEVENTS_TRUSTED_ORIGINS: z.string().default(''),
  JOOEVENTS_AUTH_SECRETS: z.string().min(1),
  JOOEVENTS_GOOGLE_CLIENT_ID: z.string().min(1),
  JOOEVENTS_GOOGLE_CLIENT_SECRET: z.string().min(1),
  JOOEVENTS_ADMISSION_MODE: z.enum(['pending', 'workspace_domain', 'reservation_only']),
  JOOEVENTS_GOOGLE_HOSTED_DOMAIN: z.string().min(1).optional(),
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: z.email(),
  JOOEVENTS_DATABASE_DRIVER: z.enum(['sqlite', 'd1', 'postgres']),
  JOOEVENTS_DATABASE_PATH: z.string().min(1).optional(),
  JOOEVENTS_DATABASE_URL: z.url().optional(),
  JOOEVENTS_BLOB_DRIVER: z.enum(['filesystem', 'r2', 's3']),
  JOOEVENTS_DATA_DIRECTORY: z.string().min(1).optional(),
  JOOEVENTS_LINK_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(900),
  JOOEVENTS_LINK_REAUTH_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  JOOEVENTS_LINK_REQUIRE_AUTH_TIME: z.enum(['true', 'false']).default('false')
});

export interface AuthSecret {
  readonly version: number;
  readonly value: string;
}

export interface ServerConfig {
  readonly baseUrl: string;
  readonly trustedOrigins: readonly string[];
  readonly authSecrets: readonly AuthSecret[];
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  readonly admissionMode: 'pending' | 'workspace_domain' | 'reservation_only';
  readonly googleHostedDomain?: string;
  readonly bootstrapOwnerEmail: string;
  readonly databaseDriver: 'sqlite' | 'd1' | 'postgres';
  readonly databasePath?: string;
  readonly databaseUrl?: string;
  readonly blobDriver: 'filesystem' | 'r2' | 's3';
  readonly dataDirectory?: string;
  readonly linkTokenTtlSeconds: number;
  readonly linkReauthMaxAgeSeconds: number;
  readonly linkRequireAuthTime: boolean;
}

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid JooEvents configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ConfigurationError';
  }
}

function parseSecrets(value: string, issues: string[]): AuthSecret[] {
  const secrets: AuthSecret[] = [];
  for (const item of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = item.indexOf(':');
    const version = Number(item.slice(0, separator));
    const secret = item.slice(separator + 1);
    if (separator <= 0 || !Number.isInteger(version) || version < 1 || secret.length < 32) {
      issues.push('JOOEVENTS_AUTH_SECRETS must be newest-first version:secret entries with secrets of at least 32 characters');
      return [];
    }
    secrets.push({ version, value: secret });
  }
  if (new Set(secrets.map((secret) => secret.version)).size !== secrets.length) {
    issues.push('JOOEVENTS_AUTH_SECRETS versions must be unique');
  }
  if (secrets.some((secret, index) => index > 0 && secret.version >= (secrets[index - 1]?.version ?? 0))) {
    issues.push('JOOEVENTS_AUTH_SECRETS must list the newest version first');
  }
  return secrets;
}

function parseOrigins(value: string, issues: string[]): string[] {
  const origins: string[] = [];
  for (const item of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    if (item.includes('*')) {
      issues.push('JOOEVENTS_TRUSTED_ORIGINS cannot contain wildcards');
      continue;
    }
    try {
      const url = new URL(item);
      if (url.origin !== item || (url.protocol !== 'https:' && url.hostname !== 'localhost')) throw new Error();
      origins.push(item);
    } catch {
      issues.push(`JOOEVENTS_TRUSTED_ORIGINS contains an invalid exact origin: ${item}`);
    }
  }
  return origins;
}

/** Validates all startup configuration in one pass so operators see every missing duty. */
export function loadConfig(environment: Record<string, string | undefined>): ServerConfig {
  const parsed = environmentSchema.safeParse(environment);
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`);
  if (!parsed.success) throw new ConfigurationError(issues);

  const env = parsed.data;
  const secrets = parseSecrets(env.JOOEVENTS_AUTH_SECRETS, issues);
  const trustedOrigins = parseOrigins(env.JOOEVENTS_TRUSTED_ORIGINS, issues);
  const baseUrl = new URL(env.JOOEVENTS_BASE_URL);
  if (baseUrl.origin !== env.JOOEVENTS_BASE_URL) issues.push('JOOEVENTS_BASE_URL must be a canonical origin without a path');
  if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost' && baseUrl.hostname !== '127.0.0.1') {
    issues.push('JOOEVENTS_BASE_URL must use HTTPS outside localhost-only development');
  }
  if (env.JOOEVENTS_ADMISSION_MODE === 'workspace_domain' && !env.JOOEVENTS_GOOGLE_HOSTED_DOMAIN) {
    issues.push('JOOEVENTS_GOOGLE_HOSTED_DOMAIN is required for workspace_domain admission');
  }
  if (env.JOOEVENTS_DATABASE_DRIVER === 'sqlite' && !env.JOOEVENTS_DATABASE_PATH) {
    issues.push('JOOEVENTS_DATABASE_PATH is required for the sqlite database driver');
  }
  if (env.JOOEVENTS_DATABASE_DRIVER === 'postgres' && !env.JOOEVENTS_DATABASE_URL) {
    issues.push('JOOEVENTS_DATABASE_URL is required for the postgres database driver');
  }
  if ((env.JOOEVENTS_DATABASE_DRIVER === 'sqlite' || env.JOOEVENTS_BLOB_DRIVER === 'filesystem') && !env.JOOEVENTS_DATA_DIRECTORY) {
    issues.push('JOOEVENTS_DATA_DIRECTORY is required for SQLite or filesystem blobs');
  }
  if (issues.length > 0) throw new ConfigurationError(issues);

  return {
    baseUrl: env.JOOEVENTS_BASE_URL,
    trustedOrigins,
    authSecrets: secrets,
    googleClientId: env.JOOEVENTS_GOOGLE_CLIENT_ID,
    googleClientSecret: env.JOOEVENTS_GOOGLE_CLIENT_SECRET,
    admissionMode: env.JOOEVENTS_ADMISSION_MODE,
    ...(env.JOOEVENTS_GOOGLE_HOSTED_DOMAIN ? { googleHostedDomain: env.JOOEVENTS_GOOGLE_HOSTED_DOMAIN } : {}),
    bootstrapOwnerEmail: env.JOOEVENTS_BOOTSTRAP_OWNER_EMAIL,
    databaseDriver: env.JOOEVENTS_DATABASE_DRIVER,
    ...(env.JOOEVENTS_DATABASE_PATH ? { databasePath: env.JOOEVENTS_DATABASE_PATH } : {}),
    ...(env.JOOEVENTS_DATABASE_URL ? { databaseUrl: env.JOOEVENTS_DATABASE_URL } : {}),
    blobDriver: env.JOOEVENTS_BLOB_DRIVER,
    ...(env.JOOEVENTS_DATA_DIRECTORY ? { dataDirectory: env.JOOEVENTS_DATA_DIRECTORY } : {}),
    linkTokenTtlSeconds: env.JOOEVENTS_LINK_TOKEN_TTL_SECONDS,
    linkReauthMaxAgeSeconds: env.JOOEVENTS_LINK_REAUTH_MAX_AGE_SECONDS,
    linkRequireAuthTime: env.JOOEVENTS_LINK_REQUIRE_AUTH_TIME === 'true'
  };
}
