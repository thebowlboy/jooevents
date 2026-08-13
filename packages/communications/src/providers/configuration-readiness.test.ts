import { describe, expect, test } from 'bun:test';
import {
  computeEmailProviderConfigurationDigest,
  emailProviderConnectionProjectionSchema,
  finalizeEmailSetupManifest,
  type EmailProviderConnectionDraftInput,
  type EmailProviderConnectionProjection,
  type EmailRoutingPolicyProjection,
  type EmailSenderProfileProjection,
  type ProviderCapabilities
} from '@jooevents/contracts';
import type {
  EmailDeliveryAdapter,
  EmailDiagnosticsAdapter,
  EmailSetupAdapter
} from './port';
import {
  createEmailProviderConfigurationService,
  type EmailProviderConfigurationStore
} from './configuration';
import {
  createEmailProviderReadinessReader,
  prepareEmailProviderReadinessRequest
} from './readiness';
import { createOutboundEmailProviderRegistry } from './registry';

const digest = 'a'.repeat(64);
const createdAt = '2026-08-13T09:00:00.000Z';
const capabilities: ProviderCapabilities = {
  idempotency: 'none', reconciliation: 'none', callbacks: [], inboundReplies: false
};
const manifest = finalizeEmailSetupManifest({
  contractVersion: 1,
  schemaKey: 'je.communication.email-setup-manifest',
  schemaVersion: 1,
  manifestKey: 'example.email.setup',
  manifestVersion: 1,
  adapterKey: 'example.email',
  adapterVersion: 'v1',
  capabilities,
  capabilityStatus: {
    transactional_outbound: 'supported',
    delivery_callbacks: 'not_supported',
    suppression_callbacks: 'not_supported',
    inbound_replies: 'not_enabled'
  },
  nonSecretFields: [],
  requiredSecretReferences: [],
  officialLinks: [],
  humanSteps: [],
  readinessChecks: [{
    key: 'example.transactional_outbound',
    capability: 'transactional_outbound',
    externalCheckKey: 'example.external.outbound_ready',
    observationSchemaVersion: 3,
    normalizerVersion: 2,
    maximumValidityMs: 60_000,
    observableClaimKeys: ['example.configured']
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

const neverDelivery = {
  adapterKey: 'example.email', adapterVersion: 'v1', capabilities,
  prepare() { throw new Error('not called'); }, async submit() { throw new Error('not called'); }
} as EmailDeliveryAdapter;
const neverDiagnostics = {
  adapterKey: 'example.email', adapterVersion: 'v1',
  capabilities: { idempotency: 'none', reconciliation: 'none', callbacks: [] },
  prepare() { throw new Error('not called'); }, async submit() { throw new Error('not called'); }
} as EmailDiagnosticsAdapter;
const neverSetup: EmailSetupAdapter = {
  adapterKey: 'example.email', adapterVersion: 'v1', manifest,
  async checkReadiness() { throw new Error('not called'); }
};
const registry = createOutboundEmailProviderRegistry([{
  delivery: neverDelivery, diagnostics: neverDiagnostics, setup: neverSetup
}]);

const draft: EmailProviderConnectionDraftInput = {
  connectionId: 'connection-1',
  revisionId: 'connection-revision-1',
  workspaceId: 'workspace-1',
  displayName: 'Example Email',
  adapterKey: manifest.adapterKey,
  adapterVersion: manifest.adapterVersion,
  manifest,
  configSchemaVersion: 1,
  configRef: {
    payloadRefId: 'payload-ref-1', payloadRefVersion: 1,
    payloadKind: 'email_provider_configuration', schemaKey: 'example.email.configuration',
    schemaVersion: 1, classification: 'restricted'
  },
  secretReferences: [],
  configDigestSha256: digest,
  createdAt
};

function projection(lifecycle: EmailProviderConnectionProjection['lifecycle'] = 'draft') {
  return emailProviderConnectionProjectionSchema.parse({
    schemaVersion: 1,
    connectionId: draft.connectionId,
    workspaceId: draft.workspaceId,
    displayName: draft.displayName,
    adapterKey: draft.adapterKey,
    lifecycle,
    headVersion: 1,
    currentRevisionId: lifecycle === 'active_outbound' ? draft.revisionId : null,
    candidateRevisions: [{
      revisionId: draft.revisionId,
      connectionId: draft.connectionId,
      revisionNumber: 1,
      adapterKey: draft.adapterKey,
      adapterVersion: draft.adapterVersion,
      setupManifestKey: manifest.manifestKey,
      setupManifestVersion: manifest.manifestVersion,
      setupManifestDigestSha256: manifest.manifestDigestSha256,
      configSchemaVersion: draft.configSchemaVersion,
      configRef: draft.configRef,
      secretRequirements: [],
      configDigestSha256: draft.configDigestSha256,
      callbacks: { state: 'not_supported' },
      inbound: { state: 'not_enabled' },
      createdAt
    }],
    createdAt,
    updatedAt: createdAt
  });
}

function fakeStore(initial: EmailProviderConnectionProjection | null = null) {
  let connection = initial;
  const store: EmailProviderConfigurationStore = {
    createConnection() { connection = projection(); return connection; },
    appendConnectionRevision() { throw new Error('not needed'); },
    getConnection() { return connection; },
    listConnections() { return connection === null ? [] : [connection]; },
    createSenderProfile() { throw new Error('not needed'); },
    appendSenderProfileRevision() { throw new Error('not needed'); },
    getSenderProfile() { return null as EmailSenderProfileProjection | null; },
    createRoutingPolicy() { throw new Error('not needed'); },
    appendRoutingPolicyRevision() { throw new Error('not needed'); },
    getRoutingPolicy() { return null as EmailRoutingPolicyProjection | null; }
  };
  return store;
}

describe('provider configuration and readiness', () => {
  test('stages a registered immutable candidate without activating it', async () => {
    const service = createEmailProviderConfigurationService({ registry, store: fakeStore() });
    const result = await service.createConnection(draft);

    expect(result.lifecycle).toBe('draft');
    expect(result.currentRevisionId).toBeNull();
    expect(result.candidateRevisions[0]?.callbacks.state).toBe('not_supported');
    expect(result.candidateRevisions[0]?.inbound.state).toBe('not_enabled');
  });

  test('projects ready only from the exact active revision and unexpired evidence', async () => {
    const service = createEmailProviderConfigurationService({
      registry, store: fakeStore(projection('active_outbound'))
    });
    const reader = createEmailProviderReadinessReader({
      configuration: service,
      registry,
      nowEpochMs: () => Date.parse('2026-08-13T09:00:01.000Z'),
      store: { listLatestChecks: () => [{
        schemaVersion: 1,
        readinessCheckId: 'check-1',
        connectionId: draft.connectionId,
        connectionRevisionId: draft.revisionId,
        capability: 'transactional_outbound',
        checkKey: 'example.transactional_outbound',
        state: 'passed',
        readiness: 'ready',
        evidence: {
          evidenceId: 'evidence-1', registeredCode: 'readiness.ready', digestSha256: digest,
          observedAt: '2026-08-13T09:00:00.000Z'
        },
        validUntil: Date.parse('2026-08-13T09:01:00.000Z'),
        startedAt: '2026-08-13T09:00:00.000Z',
        completedAt: '2026-08-13T09:00:01.000Z'
      }] }
    });

    const result = await reader.getReadiness({ workspaceId: draft.workspaceId });
    expect(result.outbound.state).toBe('ready');
    expect(result.callbacks.state).toBe('not_supported');
    expect(result.inbound.state).toBe('not_enabled');
  });

  test('prepares the exact manifest check without performing provider I/O', () => {
    const preparedAtEpochMs = Date.parse(createdAt);
    const requestedValidUntil = preparedAtEpochMs + 30_000;
    const unsigned = {
      contractVersion: 1 as const,
      connectionId: draft.connectionId,
      connectionRevisionId: draft.revisionId,
      connectionConfigDigestSha256: draft.configDigestSha256,
      capability: 'transactional_outbound' as const,
      readinessCheckId: 'check-1',
      checkKey: 'example.transactional_outbound',
      manifestKey: manifest.manifestKey,
      manifestVersion: manifest.manifestVersion,
      manifestDigestSha256: manifest.manifestDigestSha256,
      adapterKey: manifest.adapterKey,
      adapterVersion: manifest.adapterVersion,
      externalCheckKey: 'example.external.outbound_ready',
      requestedValidUntil,
      observationSchemaVersion: 3,
      normalizerVersion: 2
    };
    const result = prepareEmailProviderReadinessRequest({
      check: {
        readinessCheckId: 'check-1',
        connectionId: draft.connectionId,
        connectionRevisionId: draft.revisionId,
        expectedConfigDigestSha256: draft.configDigestSha256,
        capability: 'transactional_outbound',
        checkKey: 'example.transactional_outbound',
        requestedValidUntil,
        requestDigestSha256: computeEmailProviderConfigurationDigest(unsigned)
      },
      connection: projection(),
      manifest,
      preparedAtEpochMs
    });

    expect(result.externalCheckKey).toBe('example.external.outbound_ready');
    expect(result.observationSchemaVersion).toBe(3);
  });
});
