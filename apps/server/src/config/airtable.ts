import type { AirtableClientSecretLease } from '@jooevents/airtable';

export interface AirtableProviderConfig {
  readonly clientId: string;
  readonly clientSecretLease: AirtableClientSecretLease;
  withSecretStoreKey<Result>(use: (keyBytes: Uint8Array) => Result): Result;
}

export class AirtableProviderConfigurationError extends Error {
  constructor(readonly code: 'partial_configuration' | 'client_id_invalid' | 'secret_invalid' | 'key_invalid') {
    super(code);
    this.name = 'AirtableProviderConfigurationError';
  }
}

/** Keeps Airtable OAuth and encryption key material callback-scoped and non-enumerable. */
export function loadAirtableProviderConfig(
  environment: Record<string, string | undefined>
): AirtableProviderConfig | undefined {
  const clientId = environment.JOOEVENTS_AIRTABLE_OAUTH_CLIENT_ID;
  const clientSecret = environment.JOOEVENTS_AIRTABLE_OAUTH_CLIENT_SECRET;
  const encodedKey = environment.JOOEVENTS_AIRTABLE_SECRET_STORE_KEY;
  const present = [clientId, clientSecret, encodedKey].filter((value) => value !== undefined).length;
  if (present === 0) return undefined;
  if (present !== 3) throw new AirtableProviderConfigurationError('partial_configuration');
  if (!/^[A-Za-z0-9._-]{3,256}$/u.test(clientId!)) {
    throw new AirtableProviderConfigurationError('client_id_invalid');
  }
  if (!clientSecret || clientSecret.length < 8 || clientSecret.length > 4_096
    || !/^[\x21-\x7e]+$/u.test(clientSecret)) {
    throw new AirtableProviderConfigurationError('secret_invalid');
  }
  if (!encodedKey || !/^[A-Za-z0-9_-]{43}$/u.test(encodedKey)) {
    throw new AirtableProviderConfigurationError('key_invalid');
  }
  const keyBytes = Uint8Array.from(Buffer.from(encodedKey, 'base64url'));
  if (keyBytes.byteLength !== 32 || Buffer.from(keyBytes).toString('base64url') !== encodedKey) {
    keyBytes.fill(0);
    throw new AirtableProviderConfigurationError('key_invalid');
  }
  const config: AirtableProviderConfig = {
    clientId: clientId!,
    clientSecretLease: Object.freeze({
      async withClientSecret<Result>(use: (secret: string) => Promise<Result>): Promise<Result> {
        return use(clientSecret!);
      }
    }),
    withSecretStoreKey<Result>(use: (bytes: Uint8Array) => Result): Result {
      const leased = keyBytes.slice();
      try { return use(leased); } finally { leased.fill(0); }
    }
  };
  return Object.freeze(config);
}
