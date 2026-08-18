import { UNCONFIGURED_MAIL_FROM_ADDRESS } from '@jooevents/contracts';
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
      zoneId: string;
      apiTokenSecret: Readonly<{ storeKey: string; reference: string }>;
      /** Explicit evaluator-only delivery boundary; absent in ordinary deployments. */
      reviewRecipientAllowlist?: readonly string[];
      callbacks: 'not_supported';
      inbound: 'not_enabled';
      readinessChecks: 'mounted';
      diagnosticTests: 'enabled';
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
 * The REST mode is the activated near-term transport: the server composition
 * mounts the readiness-check executor and the owner-gated diagnostic send for
 * it. The Workers mode stays inert until a production Worker composition
 * exists; callbacks and inbound remain structurally unsupported by this
 * provider integration.
 */
const restActivation = Object.freeze({
  callbacks: 'not_supported' as const,
  inbound: 'not_enabled' as const,
  readinessChecks: 'mounted' as const,
  diagnosticTests: 'enabled' as const
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
  const reviewMode = environment.JOOEVENTS_REVIEW_ENTRY_MODE ?? 'disabled';
  const configuredAllowlist = trimmedOrUndefined(environment.JOOEVENTS_REVIEW_EMAIL_RECIPIENT_ALLOWLIST);
  if (!mode.success) issues.push(
    'JOOEVENTS_EMAIL_PROVIDER_MODE must be disabled, cloudflare_workers, or cloudflare_rest'
  );
  if (environment.JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN !== undefined) {
    issues.push('JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN is not accepted; configure an opaque secret reference');
  }
  if (configuredAllowlist !== undefined && reviewMode !== 'organizer') {
    issues.push('JOOEVENTS_REVIEW_EMAIL_RECIPIENT_ALLOWLIST is accepted only with organizer review entry');
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
  const parsedZone = accountId.safeParse(environment.JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID);
  const parsedStore = boundedIdentity.safeParse(
    environment.JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE
  );
  const parsedReference = boundedIdentity.safeParse(
    environment.JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE
  );
  const reviewRecipientAllowlist = configuredAllowlist === undefined
    ? []
    : configuredAllowlist.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (reviewMode === 'organizer' && reviewRecipientAllowlist.length === 0) {
    issues.push('JOOEVENTS_REVIEW_EMAIL_RECIPIENT_ALLOWLIST is required for cloudflare_rest in organizer review mode');
  }
  if (reviewRecipientAllowlist.length > 32
      || reviewRecipientAllowlist.some((address) => !validMailAddress(address))) {
    issues.push('JOOEVENTS_REVIEW_EMAIL_RECIPIENT_ALLOWLIST must contain 1 to 32 comma-separated email addresses');
  }
  if (new Set(reviewRecipientAllowlist).size !== reviewRecipientAllowlist.length) {
    issues.push('JOOEVENTS_REVIEW_EMAIL_RECIPIENT_ALLOWLIST must not contain duplicate addresses');
  }
  if (!parsedAccount.success) issues.push(
    'JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID is required for cloudflare_rest'
  );
  if (!parsedZone.success) issues.push(
    'JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID is required for cloudflare_rest delivery observations'
  );
  if (!parsedStore.success) issues.push(
    'JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE is required for cloudflare_rest'
  );
  if (!parsedReference.success) issues.push(
    'JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE is required for cloudflare_rest'
  );
  if (issues.length > 0 || !parsedAccount.success || !parsedZone.success
      || !parsedStore.success || !parsedReference.success) {
    throw new CommunicationsProviderConfigurationError(issues);
  }
  return Object.freeze({
    mode: mode.data,
    accountId: parsedAccount.data,
    zoneId: parsedZone.data,
    apiTokenSecret: Object.freeze({
      storeKey: parsedStore.data,
      reference: parsedReference.data
    }),
    ...(reviewRecipientAllowlist.length === 0
      ? {}
      : { reviewRecipientAllowlist: Object.freeze(reviewRecipientAllowlist) }),
    ...restActivation
  });
}

export type MailSenderConfig =
  | Readonly<{ configured: false; fromAddress: typeof UNCONFIGURED_MAIL_FROM_ADDRESS }>
  | Readonly<{
      configured: true;
      fromAddress: string;
      fromDisplayName?: string;
      replyToAddress?: string;
    }>;

const UNCONFIGURED_MAIL_SENDER: MailSenderConfig = Object.freeze({
  configured: false,
  fromAddress: UNCONFIGURED_MAIL_FROM_ADDRESS
});

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function validMailAddress(value: string): boolean {
  if (value.length < 3 || value.length > 320 || /[\u0000-\u001f\u007f\s]/u.test(value)) {
    return false;
  }
  const separator = value.lastIndexOf('@');
  return separator >= 1 && separator < value.length - 1 && value.indexOf('@') === separator;
}

/**
 * Per-installation outbound sender identity (`JOOEVENTS_MAIL_FROM_ADDRESS`,
 * `JOOEVENTS_MAIL_FROM_NAME`, optional `JOOEVENTS_MAIL_REPLY_TO`). Unset
 * environments keep the explicit unconfigured `.invalid` profile, matching the
 * inert-provider posture; malformed values fail closed.
 */
export function loadMailSenderConfig(
  environment: Record<string, string | undefined>
): MailSenderConfig {
  const fromAddress = trimmedOrUndefined(environment.JOOEVENTS_MAIL_FROM_ADDRESS);
  const fromDisplayName = trimmedOrUndefined(environment.JOOEVENTS_MAIL_FROM_NAME);
  const replyToAddress = trimmedOrUndefined(environment.JOOEVENTS_MAIL_REPLY_TO);
  const issues: string[] = [];
  if (fromAddress === undefined) {
    if (fromDisplayName !== undefined || replyToAddress !== undefined) {
      issues.push('JOOEVENTS_MAIL_FROM_ADDRESS is required when any JOOEVENTS_MAIL_* value is set');
    }
    if (issues.length > 0) throw new CommunicationsProviderConfigurationError(issues);
    return UNCONFIGURED_MAIL_SENDER;
  }
  if (!validMailAddress(fromAddress)) {
    issues.push('JOOEVENTS_MAIL_FROM_ADDRESS must be one bounded email address');
  }
  if (
    fromDisplayName !== undefined
    && (fromDisplayName.length > 200 || /[\r\n\u0000]/u.test(fromDisplayName))
  ) {
    issues.push('JOOEVENTS_MAIL_FROM_NAME must be a bounded single-line display name');
  }
  if (replyToAddress !== undefined && !validMailAddress(replyToAddress)) {
    issues.push('JOOEVENTS_MAIL_REPLY_TO must be one bounded email address');
  }
  if (issues.length > 0) throw new CommunicationsProviderConfigurationError(issues);
  return Object.freeze({
    configured: true,
    fromAddress,
    ...(fromDisplayName === undefined ? {} : { fromDisplayName }),
    ...(replyToAddress === undefined ? {} : { replyToAddress })
  });
}
