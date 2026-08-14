import {
  createCloudflareRestEmailProvider,
  createCloudflareWorkersEmailProvider,
  type CloudflareApiTokenLease,
  type CloudflareEmailReadinessProbe,
  type CloudflareEmailSendingBinding,
  type CloudflareFetch
} from '@jooevents/cloudflare-email';
import {
  createOutboundEmailProviderRegistry,
  type OutboundEmailProviderRegistration,
  type OutboundEmailProviderRegistry,
  type OutboundEmailProviderSelector
} from '@jooevents/communications';
import type { CommunicationsProviderConfig } from '../config/communications';

export interface OpaqueSecretTextResolver {
  withSecretText<Result>(
    reference: Readonly<{ storeKey: string; reference: string }>,
    use: (value: string) => Promise<Result>
  ): Promise<Result>;
}

export class CommunicationsProviderRuntimeConfigurationError extends Error {
  constructor(readonly code:
    | 'workers_binding_unavailable'
    | 'rest_secret_resolver_unavailable'
    | 'rest_fetch_unavailable') {
    super(code);
    this.name = 'CommunicationsProviderRuntimeConfigurationError';
  }
}

function validSecretText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 4_096
    && /^[\x21-\x7e]+$/u.test(value);
}

/**
 * Adapts an opaque deployment-secret reference to the Cloudflare single-use lease.
 * Neither the reference nor leased value is exposed as an object property.
 */
export function createCloudflareApiTokenLease(input: Readonly<{
  reference: Readonly<{ storeKey: string; reference: string }>;
  resolver: OpaqueSecretTextResolver;
}>): CloudflareApiTokenLease {
  const reference = Object.freeze({ ...input.reference });
  return Object.freeze({
    async withApiToken<Result>(use: (apiToken: string) => Promise<Result>): Promise<Result> {
      let callbackOpen = true;
      let callbackUsed = false;
      try {
        const result = await input.resolver.withSecretText(reference, async (value) => {
          if (!callbackOpen || callbackUsed) throw new TypeError('secret lease callback is invalid');
          callbackUsed = true;
          if (!validSecretText(value)) throw new TypeError('secret lease value is unavailable');
          return use(value);
        });
        if (!callbackUsed) throw new TypeError('secret resolver did not lease a value');
        return result;
      } finally {
        callbackOpen = false;
      }
    }
  });
}

export type CommunicationsProviderRuntimeActivation = Readonly<{
  providerCalls: 'mounted' | 'not_mounted';
  readinessChecks: 'mounted' | 'unmounted';
  diagnosticTests: 'enabled' | 'not_enabled';
  callbacks: 'not_supported';
  inbound: 'not_enabled';
}>;

export type CommunicationsProviderRuntime = Readonly<{
  registry: OutboundEmailProviderRegistry;
  selected: OutboundEmailProviderSelector | null;
  registration: OutboundEmailProviderRegistration | null;
  activation: CommunicationsProviderRuntimeActivation;
}>;

const inertActivation: CommunicationsProviderRuntimeActivation = Object.freeze({
  providerCalls: 'not_mounted',
  readinessChecks: 'unmounted',
  diagnosticTests: 'not_enabled',
  callbacks: 'not_supported',
  inbound: 'not_enabled'
});

function selector(registration: OutboundEmailProviderRegistration): OutboundEmailProviderSelector {
  const manifest = registration.setup.manifest;
  return Object.freeze({
    adapterKey: registration.setup.adapterKey,
    adapterVersion: registration.setup.adapterVersion,
    manifestKey: manifest.manifestKey,
    manifestVersion: manifest.manifestVersion,
    manifestDigestSha256: manifest.manifestDigestSha256
  });
}

/**
 * Builds one source-neutral registry entry. Construction never calls the binding,
 * secret resolver, readiness probe, or fetch implementation, and mounts no operation.
 */
export function createCommunicationsProviderRuntime(input: Readonly<{
  config: CommunicationsProviderConfig;
  workersBindings?: Readonly<Record<string, CloudflareEmailSendingBinding>>;
  secretResolver?: OpaqueSecretTextResolver;
  fetch?: CloudflareFetch;
  readinessProbe?: CloudflareEmailReadinessProbe;
}>): CommunicationsProviderRuntime {
  if (input.config.mode === 'disabled') {
    return Object.freeze({
      registry: createOutboundEmailProviderRegistry([]),
      selected: null,
      registration: null,
      activation: inertActivation
    });
  }

  let registration: OutboundEmailProviderRegistration;
  if (input.config.mode === 'cloudflare_workers') {
    const binding = input.workersBindings?.[input.config.bindingName];
    if (binding === undefined) {
      throw new CommunicationsProviderRuntimeConfigurationError('workers_binding_unavailable');
    }
    registration = createCloudflareWorkersEmailProvider({
      binding,
      ...(input.readinessProbe === undefined ? {} : { readinessProbe: input.readinessProbe })
    });
  } else {
    if (input.secretResolver === undefined) {
      throw new CommunicationsProviderRuntimeConfigurationError('rest_secret_resolver_unavailable');
    }
    if (input.fetch === undefined) {
      throw new CommunicationsProviderRuntimeConfigurationError('rest_fetch_unavailable');
    }
    registration = createCloudflareRestEmailProvider({
      accountId: input.config.accountId,
      tokenLease: createCloudflareApiTokenLease({
        reference: input.config.apiTokenSecret,
        resolver: input.secretResolver
      }),
      fetch: input.fetch,
      ...(input.readinessProbe === undefined ? {} : { readinessProbe: input.readinessProbe })
    });
  }
  const registry = createOutboundEmailProviderRegistry([registration]);
  const selected = selector(registration);
  if (registry.resolve(selected) !== registration) {
    throw new TypeError('communications provider registry composition failed');
  }
  // A registered provider means the composition hands the dispatch worker this
  // registration's delivery adapter and mounts the diagnostic executor; the
  // readiness executor is mounted exactly when a concrete probe was composed.
  const activation: CommunicationsProviderRuntimeActivation = Object.freeze({
    providerCalls: 'mounted',
    readinessChecks: input.readinessProbe === undefined ? 'unmounted' : 'mounted',
    diagnosticTests: 'enabled',
    callbacks: 'not_supported',
    inbound: 'not_enabled'
  });
  return Object.freeze({ registry, selected, registration, activation });
}
