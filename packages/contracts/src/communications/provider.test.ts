import { describe, expect, test } from 'bun:test';
import {
  computeSafeEvidenceDigestSha256,
  callbackDraftConfigurationSchema,
  emailDiagnosticLookupOutcomeSchema,
  finalizeEmailSetupManifest,
  finalizeVerifiedProviderCallback,
  normalizeProviderCallbackCapability,
  providerCapabilitiesSchema,
  providerSubmissionOutcomeSchema,
  safeEvidenceSchema,
  type EmailSetupManifestDraft
} from './provider';

function safeEvidence(code = 'provider.accepted') {
  const body = {
    contractVersion: 1 as const,
    schemaKey: 'je.communication.provider-safe-evidence' as const,
    schemaVersion: 1 as const,
    registeredCode: code as never,
    correlationId: 'corr1_abcdefgh12345678',
    registeredFacts: []
  };
  return {
    ...body,
    canonicalDigestSha256: computeSafeEvidenceDigestSha256(body)
  };
}

function setupManifestDraft(): EmailSetupManifestDraft {
  return {
    contractVersion: 1 as const,
    schemaKey: 'je.communication.email-setup-manifest' as const,
    schemaVersion: 1 as const,
    manifestKey: 'test.email.setup',
    manifestVersion: 1,
    adapterKey: 'test.email',
    adapterVersion: 'v1',
    capabilities: {
      idempotency: 'none' as const,
      reconciliation: 'lookup' as const,
      callbacks: ['delivered', 'suppression'],
      inboundReplies: false as const
    },
    capabilityStatus: {
      transactional_outbound: 'supported' as const,
      delivery_callbacks: 'supported' as const,
      suppression_callbacks: 'supported' as const,
      inbound_replies: 'not_enabled' as const
    },
    nonSecretFields: [],
    requiredSecretReferences: [{ key: 'api.token', label: 'API token', required: true }],
    officialLinks: [{
      key: 'provider.docs',
      label: 'Provider documentation',
      href: 'https://provider.example/docs'
    }],
    humanSteps: [{
      key: 'connect.account',
      title: 'Connect account',
      instruction: 'Complete provider configuration.',
      officialLinkKey: 'provider.docs'
    }],
    readinessChecks: [
      {
        key: 'callbacks.delivery',
        capability: 'delivery_callbacks' as const,
        externalCheckKey: 'check.delivery',
        observationSchemaVersion: 1,
        normalizerVersion: 1,
        maximumValidityMs: 60_000,
        observableClaimKeys: ['callback.ready']
      },
      {
        key: 'callbacks.suppression',
        capability: 'suppression_callbacks' as const,
        externalCheckKey: 'check.suppression',
        observationSchemaVersion: 1,
        normalizerVersion: 1,
        maximumValidityMs: 60_000,
        observableClaimKeys: ['suppression.ready']
      },
      {
        key: 'outbound.ready',
        capability: 'transactional_outbound' as const,
        externalCheckKey: 'check.outbound',
        observationSchemaVersion: 1,
        normalizerVersion: 1,
        maximumValidityMs: 60_000,
        observableClaimKeys: ['outbound.ready']
      }
    ],
    senderRequirements: {
      verifiedDomainRequired: true,
      verifiedFromAddressRequired: true,
      replyToMode: 'optional' as const,
      envelopeFromMode: 'adapter_managed' as const
    },
    callbacks: {
      kind: 'enabled' as const,
      callbackEndpointPath: '/webhooks/email/test',
      signatureSchemeKey: 'test.signature',
      verifierKey: 'test.verifier',
      verifierVersion: 'v1',
      verificationContractVersion: 1,
      keyIdMode: 'required' as const,
      obligationContract: {
        key: 'test.callback.obligation',
        version: 1,
        evidenceClasses: ['delivered', 'suppressed'],
        basis: 'attempt_started_database_time' as const,
        horizonMs: 60_000,
        acceptedA8MaximumMs: 120_000,
        correlationMode: 'provider_message_id_post_result_only' as const
      }
    },
    diagnostics: { kind: 'not_supported' as const }
  };
}

describe('provider-safe evidence', () => {
  test('binds registered fields to a canonical digest and rejects extras', () => {
    const evidence = safeEvidence();
    expect(safeEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(() => safeEvidenceSchema.parse({ ...evidence, registeredCode: 'provider.changed' }))
      .toThrow('digest');
    expect(() => safeEvidenceSchema.parse({ ...evidence, providerError: 'secret raw error' }))
      .toThrow();
  });

  test('requires unique canonical fact ordering', () => {
    const facts = [
      { factKey: 'z.fact', factSchemaVersion: 1, valueKind: 'boolean', booleanValue: true },
      { factKey: 'a.fact', factSchemaVersion: 1, valueKind: 'integer', integerValue: 1 }
    ] as const;
    const body = { ...safeEvidence(), registeredFacts: facts };
    const { canonicalDigestSha256: _digest, ...undigested } = body;
    expect(() => safeEvidenceSchema.parse({
      ...undigested,
      canonicalDigestSha256: computeSafeEvidenceDigestSha256(undigested as never)
    })).toThrow('canonical fact-key order');
  });
});

describe('email provider setup manifest', () => {
  test('freezes outbound capability truth while inbound remains explicitly not enabled', () => {
    const manifest = finalizeEmailSetupManifest(setupManifestDraft());
    expect(manifest.capabilities.inboundReplies).toBe(false);
    expect(manifest.capabilityStatus.inbound_replies).toBe('not_enabled');
    expect(manifest.manifestDigestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects secret defaults, insecure links, and readiness for undeclared capabilities', () => {
    const withDefault = setupManifestDraft();
    expect(() => finalizeEmailSetupManifest({
      ...withDefault,
      requiredSecretReferences: [{
        key: 'api.token',
        label: 'API token',
        required: true,
        defaultValue: 'must-never-appear'
      }]
    } as never)).toThrow();

    const insecure = setupManifestDraft();
    insecure.officialLinks[0]!.href = 'http://provider.example/docs';
    expect(() => finalizeEmailSetupManifest(insecure)).toThrow('HTTPS');

    const disabledCallbacks = setupManifestDraft();
    expect(() => finalizeEmailSetupManifest({
      ...disabledCallbacks,
      capabilities: { ...disabledCallbacks.capabilities, callbacks: [] },
      capabilityStatus: {
        ...disabledCallbacks.capabilityStatus,
        delivery_callbacks: 'not_supported',
        suppression_callbacks: 'not_supported'
      }
    } as never)).toThrow('undeclared capability');
  });

  test('requires callback capabilities and obligation evidence classes to agree exactly', () => {
    const draft = setupManifestDraft();
    const callbacks = draft.callbacks;
    if (callbacks.kind !== 'enabled') throw new TypeError('test fixture must enable callbacks');
    expect(() => finalizeEmailSetupManifest({
      ...draft,
      callbacks: {
        ...callbacks,
        obligationContract: {
          ...callbacks.obligationContract,
          evidenceClasses: ['delivered']
        }
      }
    } as never)).toThrow('exactly match');
  });

  test('requires lookup capability for provider-message-id lookup correlation', () => {
    const draft = setupManifestDraft();
    const callbacks = draft.callbacks;
    if (callbacks.kind !== 'enabled') throw new TypeError('test fixture must enable callbacks');
    expect(() => finalizeEmailSetupManifest({
      ...draft,
      capabilities: { ...draft.capabilities, reconciliation: 'none' },
      callbacks: {
        ...callbacks,
        obligationContract: {
          ...callbacks.obligationContract,
          correlationMode: 'provider_message_id_with_lookup'
        }
      }
    })).toThrow('requires lookup reconciliation');
  });

  test('pairs disabled verifier configuration only with a null obligation', () => {
    expect(callbackDraftConfigurationSchema.parse({
      contractVersion: 1,
      verifier: { contractVersion: 1, kind: 'disabled' },
      obligationContract: null
    })).toMatchObject({ verifier: { kind: 'disabled' } });
    expect(() => callbackDraftConfigurationSchema.parse({
      contractVersion: 1,
      verifier: { contractVersion: 1, kind: 'disabled' },
      obligationContract: { key: 'callback.obligation', version: 1 }
    })).toThrow();
    expect(() => callbackDraftConfigurationSchema.parse({
      contractVersion: 1,
      verifier: {
        contractVersion: 1,
        kind: 'create',
        verifierKey: 'test.verifier',
        verifierVersion: 'v1',
        verificationContractVersion: 1,
        keyIdMode: 'required',
        nonsecretConfigPayloadRefId: 'config_ref_1',
        secretStoreKey: 'secret.callback',
        secretBundleReference: 'bundle_ref_1',
        configDigestSha256: 'a'.repeat(64),
        rawSecret: 'must-never-cross-contract'
      },
      obligationContract: { key: 'callback.obligation', version: 1 }
    })).toThrow();
  });
});

describe('closed normalized outcomes and callback observations', () => {
  test('only accepted outcomes can carry a provider message id', () => {
    const accepted = providerSubmissionOutcomeSchema.parse({
      contractVersion: 1,
      kind: 'accepted',
      providerMessageId: 'provider-message-1',
      evidence: safeEvidence()
    });
    expect(accepted.kind).toBe('accepted');
    expect(() => providerSubmissionOutcomeSchema.parse({
      contractVersion: 1,
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: 'provider.rejected',
      providerMessageId: 'illegal',
      evidence: safeEvidence('provider.rejected')
    })).toThrow();
  });

  test('diagnostic lookup accepted requires a provider message id', () => {
    expect(() => emailDiagnosticLookupOutcomeSchema.parse({
      contractVersion: 1,
      kind: 'accepted',
      evidence: safeEvidence()
    })).toThrow();
  });

  test.each([
    ['delivered', 'delivered'],
    ['delay', 'delayed'],
    ['bounce', 'bounced'],
    ['complaint', 'complained'],
    ['suppression', 'suppressed']
  ] as const)('normalizes outbound callback wire %s to %s', (wire, normalized) => {
    expect(normalizeProviderCallbackCapability(wire)).toBe(normalized);
  });

  test('verified callbacks freeze one structural identity shape and canonical digest', () => {
    const callback = finalizeVerifiedProviderCallback({
      contractVersion: 1,
      schemaKey: 'je.communication.verified-provider-callback',
      schemaVersion: 1,
      normalizerKey: 'je.communication.provider-callback-normalizer',
      normalizerVersion: 1,
      providerConnectionId: 'connection_1',
      providerEventId: 'event_1',
      payloadDigestSha256: 'a'.repeat(64),
      normalizedEvidenceClass: 'delivered',
      signatureTimestamp: 100,
      replayWindowExpiresAt: 200,
      verifiedAt: 110,
      normalizedIdentityShape: 'provider_message_id_only',
      providerMessageId: 'provider-message-1'
    });
    expect(callback.canonicalDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => finalizeVerifiedProviderCallback({
      ...callback,
      normalizedIdentityShape: 'external_delivery_key_only',
      externalDeliveryKey: 'delivery_1'
    } as never)).toThrow();
  });

  test('capabilities cannot claim inbound replies', () => {
    expect(() => providerCapabilitiesSchema.parse({
      idempotency: 'none',
      reconciliation: 'none',
      callbacks: [],
      inboundReplies: true
    })).toThrow();
  });
});
