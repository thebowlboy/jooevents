import type { JooEventsAuthConfiguration } from '@jooevents/auth';

export interface CloudflareAuthBindings {
  readonly JOOEVENTS_AUTH_RUNTIME_ENABLED?: string;
  readonly JOOEVENTS_BASE_URL?: string;
  readonly JOOEVENTS_TRUSTED_ORIGINS?: string;
  readonly JOOEVENTS_AUTH_SECRETS?: string;
  readonly JOOEVENTS_GOOGLE_CLIENT_ID?: string;
  readonly JOOEVENTS_GOOGLE_CLIENT_SECRET?: string;
  readonly JOOEVENTS_ADMISSION_MODE?: string;
  readonly JOOEVENTS_GOOGLE_HOSTED_DOMAIN?: string;
  readonly JOOEVENTS_WORKSPACE_ID?: string;
}

export interface CloudflareAuthRuntimeConfiguration extends JooEventsAuthConfiguration {
  readonly workspaceId: string;
}

export class CloudflareAuthConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super('cloudflare_auth_configuration_invalid');
    this.name = 'CloudflareAuthConfigurationError';
  }
}

function exactHttpsOrigin(value: string, label: string, issues: string[]): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== 'https:') throw new Error('not_exact_https_origin');
    return value;
  } catch {
    issues.push(`${label}_invalid`);
    return undefined;
  }
}

function parseSecrets(value: string | undefined, issues: string[]) {
  if (!value) {
    issues.push('auth_secrets_missing');
    return [];
  }
  const secrets: Array<{ version: number; value: string }> = [];
  for (const item of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = item.indexOf(':');
    const version = Number(item.slice(0, separator));
    const secret = item.slice(separator + 1);
    if (separator <= 0 || !Number.isSafeInteger(version) || version < 1 || secret.length < 32) {
      issues.push('auth_secrets_invalid');
      return [];
    }
    secrets.push({ version, value: secret });
  }
  if (secrets.length === 0 || new Set(secrets.map((item) => item.version)).size !== secrets.length) {
    issues.push('auth_secrets_invalid');
  }
  if (secrets.some((item, index) =>
    index > 0 && item.version >= (secrets[index - 1]?.version ?? 0)
  )) {
    issues.push('auth_secrets_not_newest_first');
  }
  return secrets;
}

function required(value: string | undefined, issue: string, issues: string[]): string {
  const normalized = value?.trim();
  if (!normalized) issues.push(issue);
  return normalized ?? '';
}

export function cloudflareAuthRuntimeEnabled(bindings: CloudflareAuthBindings): boolean {
  return bindings.JOOEVENTS_AUTH_RUNTIME_ENABLED === 'true';
}

/** Validates every auth duty together before a Worker route can activate. */
export function loadCloudflareAuthRuntimeConfiguration(
  bindings: CloudflareAuthBindings
): CloudflareAuthRuntimeConfiguration {
  const issues: string[] = [];
  if (!cloudflareAuthRuntimeEnabled(bindings)) issues.push('auth_runtime_not_enabled');
  const baseUrl = exactHttpsOrigin(
    required(bindings.JOOEVENTS_BASE_URL, 'base_url_missing', issues),
    'base_url',
    issues
  ) ?? '';
  const trustedOrigins: string[] = [];
  for (const candidate of (bindings.JOOEVENTS_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (candidate.includes('*')) {
      issues.push('trusted_origin_wildcard_refused');
      continue;
    }
    const origin = exactHttpsOrigin(candidate, 'trusted_origin', issues);
    if (origin) trustedOrigins.push(origin);
  }
  const authSecrets = parseSecrets(bindings.JOOEVENTS_AUTH_SECRETS, issues);
  const googleClientId = required(
    bindings.JOOEVENTS_GOOGLE_CLIENT_ID,
    'google_client_id_missing',
    issues
  );
  const googleClientSecret = required(
    bindings.JOOEVENTS_GOOGLE_CLIENT_SECRET,
    'google_client_secret_missing',
    issues
  );
  const admissionMode = bindings.JOOEVENTS_ADMISSION_MODE;
  if (
    admissionMode !== 'pending'
    && admissionMode !== 'workspace_domain'
    && admissionMode !== 'reservation_only'
  ) {
    issues.push('admission_mode_invalid');
  }
  const googleHostedDomain = bindings.JOOEVENTS_GOOGLE_HOSTED_DOMAIN?.trim();
  if (admissionMode === 'workspace_domain' && !googleHostedDomain) {
    issues.push('google_hosted_domain_missing');
  }
  const workspaceId = required(bindings.JOOEVENTS_WORKSPACE_ID, 'workspace_id_missing', issues);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(workspaceId)) {
    issues.push('workspace_id_invalid');
  }
  if (issues.length > 0) throw new CloudflareAuthConfigurationError(Object.freeze(issues));
  return Object.freeze({
    baseUrl,
    trustedOrigins: Object.freeze(trustedOrigins),
    authSecrets: Object.freeze(authSecrets),
    googleClientId,
    googleClientSecret,
    admissionMode: admissionMode as CloudflareAuthRuntimeConfiguration['admissionMode'],
    ...(googleHostedDomain ? { googleHostedDomain } : {}),
    workspaceId
  });
}
