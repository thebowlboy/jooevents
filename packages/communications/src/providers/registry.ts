import {
  emailSetupManifestSchema,
  type EmailSetupManifest
} from '@jooevents/contracts';
import type {
  EmailDeliveryAdapter,
  EmailDiagnosticsAdapter,
  EmailSetupAdapter
} from './port';

export type OutboundEmailProviderRegistration = Readonly<{
  delivery: EmailDeliveryAdapter;
  diagnostics: EmailDiagnosticsAdapter;
  setup: EmailSetupAdapter;
}>;

export type OutboundEmailProviderSelector = Readonly<{
  adapterKey: string;
  adapterVersion: string;
  manifestKey: string;
  manifestVersion: number;
  manifestDigestSha256: string;
}>;

export interface OutboundEmailProviderRegistry {
  listManifests(): readonly EmailSetupManifest[];
  resolve(selector: OutboundEmailProviderSelector): OutboundEmailProviderRegistration;
}

export class OutboundEmailProviderRegistryError extends Error {
  constructor(
    readonly code:
      | 'duplicate_adapter'
      | 'incoherent_registration'
      | 'unsupported_capability'
      | 'unknown_adapter'
      | 'manifest_mismatch'
  ) {
    super(code);
    this.name = 'OutboundEmailProviderRegistryError';
  }
}

function adapterIdentity(value: { readonly adapterKey: string; readonly adapterVersion: string }) {
  return `${value.adapterKey}\u0000${value.adapterVersion}`;
}

function assertOutboundOnly(registration: OutboundEmailProviderRegistration): EmailSetupManifest {
  const manifest = emailSetupManifestSchema.parse(registration.setup.manifest);
  const identities = [registration.delivery, registration.diagnostics, registration.setup]
    .map(adapterIdentity);
  if (new Set(identities).size !== 1) {
    throw new OutboundEmailProviderRegistryError('incoherent_registration');
  }
  if (
    manifest.adapterKey !== registration.setup.adapterKey
    || manifest.adapterVersion !== registration.setup.adapterVersion
  ) throw new OutboundEmailProviderRegistryError('incoherent_registration');
  if (
    registration.delivery.capabilities !== manifest.capabilities
    && JSON.stringify(registration.delivery.capabilities) !== JSON.stringify(manifest.capabilities)
  ) throw new OutboundEmailProviderRegistryError('incoherent_registration');
  if (
    manifest.capabilityStatus.transactional_outbound !== 'supported'
    || manifest.capabilityStatus.delivery_callbacks !== 'not_supported'
    || manifest.capabilityStatus.suppression_callbacks !== 'not_supported'
    || manifest.capabilityStatus.inbound_replies !== 'not_enabled'
    || manifest.callbacks.kind !== 'disabled'
    || manifest.capabilities.callbacks.length !== 0
    || manifest.capabilities.inboundReplies !== false
    || manifest.capabilities.reconciliation !== 'none'
  ) throw new OutboundEmailProviderRegistryError('unsupported_capability');
  if (manifest.readinessChecks.filter(
    (check) => check.capability === 'transactional_outbound'
  ).length !== 1) throw new OutboundEmailProviderRegistryError('unsupported_capability');
  return manifest;
}

/**
 * Creates an exact-tuple provider registry. It deliberately has no default provider:
 * routing/configuration must cite the immutable adapter and manifest tuple.
 */
export function createOutboundEmailProviderRegistry(
  registrations: readonly OutboundEmailProviderRegistration[]
): OutboundEmailProviderRegistry {
  const byAdapter = new Map<string, Readonly<{
    registration: OutboundEmailProviderRegistration;
    manifest: EmailSetupManifest;
  }>>();
  for (const registration of registrations) {
    const manifest = assertOutboundOnly(registration);
    const key = adapterIdentity(registration.setup);
    if (byAdapter.has(key)) throw new OutboundEmailProviderRegistryError('duplicate_adapter');
    byAdapter.set(key, Object.freeze({ registration, manifest }));
  }

  const ordered = Object.freeze([...byAdapter.values()].sort((left, right) => {
    const leftKey = adapterIdentity(left.registration.setup);
    const rightKey = adapterIdentity(right.registration.setup);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }));

  return Object.freeze({
    listManifests(): readonly EmailSetupManifest[] {
      return Object.freeze(ordered.map((entry) => entry.manifest));
    },
    resolve(selector: OutboundEmailProviderSelector): OutboundEmailProviderRegistration {
      const entry = byAdapter.get(adapterIdentity(selector));
      if (entry === undefined) throw new OutboundEmailProviderRegistryError('unknown_adapter');
      if (
        entry.manifest.manifestKey !== selector.manifestKey
        || entry.manifest.manifestVersion !== selector.manifestVersion
        || entry.manifest.manifestDigestSha256 !== selector.manifestDigestSha256
      ) throw new OutboundEmailProviderRegistryError('manifest_mismatch');
      return entry.registration;
    }
  });
}
