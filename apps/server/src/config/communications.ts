import { z } from 'zod';

const boundedIdentity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const accountId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const workersBindingName = z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/);

export type CommunicationsProviderConfig =
  | Readonly<{
      mode: 'disabled';
      callbacks: 'not_supported';
      inbound: 'not_enabled';
      readinessChecks: 'unmounted';
      diagnosticTests: 'not_enabled';
    }>
  | Readonly<{
      mode: 'cloudflare_workers';
      bindingName: string;
      callbacks: 'not_supported';
      inbound: 'not_enabled';
      readinessChecks: 'unmounted';
      diagnosticTests: 'not_enabled';
    }>
  | Readonly<{
      mode: 'cloudflare_rest';
      accountId: string;
      apiTokenSecret: Readonly<{ storeKey: string; reference: string }>;
      callbacks: 'not_supported';
      inbound: 'not_enabled';
      readinessChecks: 'unmounted';
      diagnosticTests: 'not_enabled';
    }>;

export class CommunicationsProviderConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid communications provider configuration:\n${issues.map(
      (issue) => `- ${issue}`
    ).join('\n')}`);
    this.name = 'CommunicationsProviderConfigurationError';
  }
}

const inert = Object.freeze({
  callbacks: 'not_supported' as const,
  inbound: 'not_enabled' as const,
  readinessChecks: 'unmounted' as const,
  diagnosticTests: 'not_enabled' as const
});

/**
 * Parses only provider identity and opaque secret references. A raw API token is
 * deliberately rejected; secret material must be leased at the point of provider I/O.
 */
export function loadCommunicationsProviderConfig(
  environment: Record<string, string | undefined>
): CommunicationsProviderConfig {
  const mode = z.enum(['disabled', 'cloudflare_workers', 'cloudflare_rest'])
    .safeParse(environment.JOOEVENTS_EMAIL_PROVIDER_MODE ?? 'disabled');
  const issues: string[] = [];
  if (!mode.success) issues.push(
    'JOOEVENTS_EMAIL_PROVIDER_MODE must be disabled, cloudflare_workers, or cloudflare_rest'
  );
  if (environment.JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN !== undefined) {
    issues.push('JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN is not accepted; configure an opaque secret reference');
  }
  if (!mode.success) throw new CommunicationsProviderConfigurationError(issues);
  if (mode.data === 'disabled') {
    if (issues.length > 0) throw new CommunicationsProviderConfigurationError(issues);
    return Object.freeze({ mode: 'disabled', ...inert });
  }
  if (mode.data === 'cloudflare_workers') {
    const parsedBinding = workersBindingName.safeParse(
      environment.JOOEVENTS_CLOUDFLARE_EMAIL_BINDING_NAME
    );
    if (!parsedBinding.success) issues.push(
      'JOOEVENTS_CLOUDFLARE_EMAIL_BINDING_NAME must name an injected Workers binding'
    );
    if (issues.length > 0 || !parsedBinding.success) {
      throw new CommunicationsProviderConfigurationError(issues);
    }
    return Object.freeze({ mode: mode.data, bindingName: parsedBinding.data, ...inert });
  }

  const parsedAccount = accountId.safeParse(environment.JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID);
  const parsedStore = boundedIdentity.safeParse(
    environment.JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE
  );
  const parsedReference = boundedIdentity.safeParse(
    environment.JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE
  );
  if (!parsedAccount.success) issues.push(
    'JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID is required for cloudflare_rest'
  );
  if (!parsedStore.success) issues.push(
    'JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE is required for cloudflare_rest'
  );
  if (!parsedReference.success) issues.push(
    'JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE is required for cloudflare_rest'
  );
  if (issues.length > 0 || !parsedAccount.success || !parsedStore.success || !parsedReference.success) {
    throw new CommunicationsProviderConfigurationError(issues);
  }
  return Object.freeze({
    mode: mode.data,
    accountId: parsedAccount.data,
    apiTokenSecret: Object.freeze({
      storeKey: parsedStore.data,
      reference: parsedReference.data
    }),
    ...inert
  });
}
