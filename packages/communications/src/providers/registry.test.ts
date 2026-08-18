import { describe, expect, test } from 'bun:test';
import {
  finalizeEmailSetupManifest,
  type ProviderCapabilities
} from '@jooevents/contracts';
import type {
  EmailDeliveryAdapter,
  EmailDiagnosticsAdapter,
  EmailSetupAdapter
} from './port';
import {
  OutboundEmailProviderRegistryError,
  createOutboundEmailProviderRegistry,
  type OutboundEmailProviderRegistration
} from './registry';

const capabilities: ProviderCapabilities = {
  idempotency: 'none',
  reconciliation: 'none',
  callbacks: [],
  attachments: false,
  calendarMime: false,
  inboundReplies: false
};
Object.freeze(capabilities.callbacks);
Object.freeze(capabilities);

function registration(adapterKey = 'example.email'): OutboundEmailProviderRegistration {
  const manifest = finalizeEmailSetupManifest({
    contractVersion: 1,
    schemaKey: 'je.communication.email-setup-manifest',
    schemaVersion: 1,
    manifestKey: `${adapterKey}.setup`,
    manifestVersion: 1,
    adapterKey,
    adapterVersion: 'v1',
    capabilities,
    capabilityStatus: {
      transactional_outbound: 'supported',
      attachments: 'not_supported',
      calendar_mime: 'not_supported',
      delivery_callbacks: 'not_supported',
      suppression_callbacks: 'not_supported',
      inbound_replies: 'not_enabled'
    },
    nonSecretFields: [],
    requiredSecretReferences: [],
    officialLinks: [],
    humanSteps: [],
    readinessChecks: [{
      key: `${adapterKey}.outbound`,
      capability: 'transactional_outbound',
      externalCheckKey: `${adapterKey}.outbound-ready`,
      observationSchemaVersion: 1,
      normalizerVersion: 1,
      maximumValidityMs: 60_000,
      observableClaimKeys: [`${adapterKey}.configured`]
    }],
    senderRequirements: {
      verifiedDomainRequired: true,
      verifiedFromAddressRequired: false,
      replyToMode: 'optional',
      envelopeFromMode: 'adapter_managed'
    },
    callbacks: { kind: 'disabled' },
    diagnostics: { kind: 'not_supported' }
  });
  const delivery = {
    adapterKey,
    adapterVersion: 'v1',
    capabilities,
    prepare() { throw new Error('not invoked by registry'); },
    async submit() { throw new Error('not invoked by registry'); }
  } as EmailDeliveryAdapter;
  const diagnostics = {
    adapterKey,
    adapterVersion: 'v1',
    capabilities: {
      idempotency: capabilities.idempotency,
      reconciliation: capabilities.reconciliation,
      callbacks: capabilities.callbacks
    },
    prepare() { throw new Error('not invoked by registry'); },
    async submit() { throw new Error('not invoked by registry'); }
  } as EmailDiagnosticsAdapter;
  const setup: EmailSetupAdapter = {
    adapterKey,
    adapterVersion: 'v1',
    manifest,
    async checkReadiness() { throw new Error('not invoked by registry'); }
  };
  return { delivery, diagnostics, setup };
}

describe('outbound email provider registry', () => {
  test('resolves only the exact immutable adapter and manifest tuple', () => {
    const item = registration();
    const registry = createOutboundEmailProviderRegistry([item]);
    const manifest = item.setup.manifest;

    expect(registry.resolve({
      adapterKey: item.setup.adapterKey,
      adapterVersion: item.setup.adapterVersion,
      manifestKey: manifest.manifestKey,
      manifestVersion: manifest.manifestVersion,
      manifestDigestSha256: manifest.manifestDigestSha256
    })).toBe(item);
    expect(registry.listManifests()).toEqual([manifest]);
  });

  test('does not fall back across an unknown adapter or mismatched manifest', () => {
    const item = registration();
    const registry = createOutboundEmailProviderRegistry([item]);
    const manifest = item.setup.manifest;

    expect(() => registry.resolve({
      adapterKey: 'unknown.email',
      adapterVersion: 'v1',
      manifestKey: manifest.manifestKey,
      manifestVersion: manifest.manifestVersion,
      manifestDigestSha256: manifest.manifestDigestSha256
    })).toThrow(new OutboundEmailProviderRegistryError('unknown_adapter'));
    expect(() => registry.resolve({
      adapterKey: item.setup.adapterKey,
      adapterVersion: item.setup.adapterVersion,
      manifestKey: 'wrong.setup',
      manifestVersion: manifest.manifestVersion,
      manifestDigestSha256: manifest.manifestDigestSha256
    })).toThrow(new OutboundEmailProviderRegistryError('manifest_mismatch'));
  });

  test('rejects duplicates and incoherent sibling ports', () => {
    const item = registration();
    expect(() => createOutboundEmailProviderRegistry([item, item]))
      .toThrow(new OutboundEmailProviderRegistryError('duplicate_adapter'));

    const incoherent = registration();
    const setup = { ...incoherent.setup, adapterVersion: 'v2' };
    expect(() => createOutboundEmailProviderRegistry([{ ...incoherent, setup }]))
      .toThrow(new OutboundEmailProviderRegistryError('incoherent_registration'));
  });
});
