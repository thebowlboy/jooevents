import { describe, expect, test } from 'bun:test';
import {
  emailProviderConnectionDraftInputSchema,
  emailProviderConnectionProjectionSchema,
  emailProviderDiagnosticTestProjectionSchema,
  emailProviderReadinessCheckInputSchema,
  emailProviderReadinessCheckProjectionSchema,
  emailRoutingPolicyRevisionAppendInputSchema,
  emailSenderProfileRevisionAppendInputSchema
} from './provider-configuration';
import { finalizeEmailSetupManifest } from './provider';

const sha = 'a'.repeat(64);
const now = '2026-08-13T00:00:00.000Z';

function cloudflareManifest(transport: 'workers' | 'rest') {
  return finalizeEmailSetupManifest({
    contractVersion: 1,
    schemaKey: 'je.communication.email-setup-manifest',
    schemaVersion: 1,
    manifestKey: `cloudflare.email.${transport}.setup`,
    manifestVersion: 1,
    adapterKey: `cloudflare.email.${transport}`,
    adapterVersion: 'v1',
    capabilities: {
      idempotency: 'none', reconciliation: 'none', callbacks: [], inboundReplies: false
    },
    capabilityStatus: {
      transactional_outbound: 'supported',
      delivery_callbacks: 'not_supported',
      suppression_callbacks: 'not_supported',
      inbound_replies: 'not_enabled'
    },
    nonSecretFields: [],
    requiredSecretReferences: transport === 'rest'
      ? [{ key: 'cloudflare.api_token', label: 'API token', required: true }]
      : [],
    officialLinks: [],
    humanSteps: [],
    readinessChecks: [{
      key: 'cloudflare.transactional_outbound',
      capability: 'transactional_outbound',
      externalCheckKey: 'cloudflare.email.outbound_ready',
      observationSchemaVersion: 1,
      normalizerVersion: 1,
      maximumValidityMs: 300_000,
      observableClaimKeys: ['cloudflare.transport.configured']
    }],
    senderRequirements: {
      verifiedDomainRequired: true,
      verifiedFromAddressRequired: false,
      replyToMode: 'optional',
      envelopeFromMode: 'adapter_managed'
    },
    callbacks: { kind: 'disabled' },
    diagnostics: {
      kind: 'supported', fixtureKey: 'cloudflare.email.diagnostic', fixtureVersion: 1,
      maximumCostMinorUnits: 1, currency: 'USD'
    }
  });
}

const CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST = cloudflareManifest('workers');
const CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST = cloudflareManifest('rest');

function configRef() {
  return {
    payloadRefId: 'payload_provider_config_1',
    payloadRefVersion: 1,
    payloadKind: 'email_provider_configuration' as const,
    schemaKey: 'cloudflare.email.workers.configuration',
    schemaVersion: 1,
    classification: 'restricted' as const
  };
}

describe('outbound provider configuration contracts', () => {
  test('accepts a callback-free Workers candidate and keeps secret values out', () => {
    const candidate = emailProviderConnectionDraftInputSchema.parse({
      connectionId: 'provider_connection_1',
      revisionId: 'provider_connection_revision_1',
      workspaceId: 'workspace_1',
      displayName: 'Cloudflare Email Sending',
      adapterKey: CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.adapterKey,
      adapterVersion: CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.adapterVersion,
      manifest: CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST,
      configSchemaVersion: 1,
      configRef: configRef(),
      secretReferences: [],
      configDigestSha256: sha,
      createdAt: now
    });
    expect(candidate.manifest.callbacks).toEqual({ kind: 'disabled' });
    expect(candidate.manifest.capabilityStatus.inbound_replies).toBe('not_enabled');
    expect(JSON.stringify(candidate)).not.toContain('apiToken');
  });

  test('requires only opaque references for every declared REST secret', () => {
    const base = {
      connectionId: 'provider_connection_1',
      revisionId: 'provider_connection_revision_1',
      workspaceId: 'workspace_1',
      displayName: 'Cloudflare Email Sending',
      adapterKey: CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST.adapterKey,
      adapterVersion: CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST.adapterVersion,
      manifest: CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST,
      configSchemaVersion: 1,
      configRef: configRef(),
      configDigestSha256: sha,
      createdAt: now
    };
    expect(() => emailProviderConnectionDraftInputSchema.parse({
      ...base,
      secretReferences: []
    })).toThrow('secret references');
    const parsed = emailProviderConnectionDraftInputSchema.parse({
      ...base,
      secretReferences: [{
        key: 'cloudflare.api_token',
        secretStoreKey: 'deployment.secrets',
        secretReference: 'secret_reference_cloudflare_email_1'
      }]
    });
    expect(parsed.secretReferences[0]).not.toHaveProperty('value');
  });

  test('does not accept a callback-enabled or inbound-capable manifest on this rail', () => {
    const unsafeManifest = {
      ...CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST,
      callbacks: {
        kind: 'enabled',
        callbackEndpointPath: '/webhooks/email/cloudflare',
        signatureSchemeKey: 'test.signature',
        verifierKey: 'test.verifier',
        verifierVersion: 'v1',
        verificationContractVersion: 1,
        keyIdMode: 'absent',
        obligationContract: {
          key: 'test.obligation', version: 1, evidenceClasses: ['delivered'],
          basis: 'attempt_started_database_time', horizonMs: 1,
          acceptedA8MaximumMs: 1, correlationMode: 'provider_message_id_post_result_only'
        }
      }
    };
    expect(() => emailProviderConnectionDraftInputSchema.parse({
      connectionId: 'provider_connection_1',
      revisionId: 'provider_connection_revision_1',
      workspaceId: 'workspace_1',
      displayName: 'Cloudflare Email Sending',
      adapterKey: unsafeManifest.adapterKey,
      adapterVersion: unsafeManifest.adapterVersion,
      manifest: unsafeManifest,
      configSchemaVersion: 1,
      configRef: configRef(),
      secretReferences: [],
      configDigestSha256: sha,
      createdAt: now
    })).toThrow();
  });

  test('binds a projected active pointer to one exact candidate revision', () => {
    const revision = {
      revisionId: 'provider_connection_revision_1',
      connectionId: 'provider_connection_1',
      revisionNumber: 1,
      adapterKey: 'cloudflare.email.workers',
      adapterVersion: 'v1',
      setupManifestKey: 'cloudflare.email.workers.setup',
      setupManifestVersion: 1,
      setupManifestDigestSha256: sha,
      configSchemaVersion: 1,
      configRef: configRef(),
      secretRequirements: [],
      configDigestSha256: sha,
      callbacks: { state: 'not_supported' as const },
      inbound: { state: 'not_enabled' as const },
      createdAt: now
    };
    expect(emailProviderConnectionProjectionSchema.parse({
      schemaVersion: 1,
      connectionId: 'provider_connection_1',
      workspaceId: 'workspace_1',
      displayName: 'Cloudflare Email Sending',
      adapterKey: 'cloudflare.email.workers',
      lifecycle: 'active_outbound',
      headVersion: 2,
      currentRevisionId: revision.revisionId,
      candidateRevisions: [revision],
      createdAt: now,
      updatedAt: now
    }).currentRevisionId).toBe(revision.revisionId);
    expect(() => emailProviderConnectionProjectionSchema.parse({
      schemaVersion: 1,
      connectionId: 'provider_connection_1',
      workspaceId: 'workspace_1',
      displayName: 'Cloudflare Email Sending',
      adapterKey: 'cloudflare.email.workers',
      lifecycle: 'active_outbound',
      headVersion: 2,
      currentRevisionId: 'another_revision',
      candidateRevisions: [revision],
      createdAt: now,
      updatedAt: now
    })).toThrow('current revision');
  });

  test('requires canonical time and the exact next sender/routing revision', () => {
    const senderRevision = {
      revisionId: 'sender_revision_2', senderProfileId: 'sender_profile_1', revisionNumber: 2,
      fromName: 'JooEvents', fromAddressRef: configRef(), replyModelKey: 'reply.optional',
      replyToRef: null, presentationContractKey: 'email.presentation',
      presentationContractVersion: 1, presentationDigestSha256: sha, createdAt: now
    };
    expect(emailSenderProfileRevisionAppendInputSchema.parse({
      senderProfileId: 'sender_profile_1', revision: senderRevision,
      workspaceId: 'workspace_1', profileKey: 'default.sender',
      expectedHeadVersion: 1, appendedAt: now
    }).revision.revisionNumber).toBe(2);
    expect(() => emailSenderProfileRevisionAppendInputSchema.parse({
      senderProfileId: 'sender_profile_1', revision: { ...senderRevision, revisionNumber: 3 },
      workspaceId: 'workspace_1', profileKey: 'default.sender',
      expectedHeadVersion: 1, appendedAt: now
    })).toThrow('next revision');

    const routingRevision = {
      revisionId: 'routing_revision_2', routingPolicyId: 'routing_policy_1', revisionNumber: 2,
      contractSchemaVersion: 1, digestSha256: sha, createdAt: now,
      rules: [{
        priority: 0, purposeKey: null, deliveryClassKey: null,
        providerConnectionRevisionId: 'provider_connection_revision_1',
        senderProfileRevisionId: 'sender_revision_2', noFallback: true, ruleDigestSha256: sha
      }]
    };
    expect(emailRoutingPolicyRevisionAppendInputSchema.parse({
      routingPolicyId: 'routing_policy_1', revision: routingRevision,
      workspaceId: 'workspace_1', policyKey: 'default.routing',
      expectedHeadVersion: 1, appendedAt: now
    }).revision.rules[0]?.noFallback).toBe(true);
    expect(() => emailRoutingPolicyRevisionAppendInputSchema.parse({
      routingPolicyId: 'routing_policy_1', revision: {
        ...routingRevision, createdAt: '2026-08-13T00:00:00+00:00'
      },
      workspaceId: 'workspace_1', policyKey: 'default.routing',
      expectedHeadVersion: 1, appendedAt: '2026-08-13T00:00:00+00:00'
    })).toThrow('canonical UTC');
  });
});

describe('provider readiness and diagnostic contracts', () => {
  test('checks only outbound readiness and makes the terminal evidence shape exact', () => {
    expect(emailProviderReadinessCheckInputSchema.parse({
      readinessCheckId: 'readiness_check_1',
      connectionId: 'provider_connection_1',
      connectionRevisionId: 'provider_connection_revision_1',
      expectedConfigDigestSha256: sha,
      capability: 'transactional_outbound',
      checkKey: 'cloudflare.transactional_outbound',
      requestedValidUntil: 1_900_000_000_000,
      requestDigestSha256: sha
    }).capability).toBe('transactional_outbound');
    expect(() => emailProviderReadinessCheckInputSchema.parse({
      readinessCheckId: 'readiness_check_1',
      connectionId: 'provider_connection_1',
      connectionRevisionId: 'provider_connection_revision_1',
      expectedConfigDigestSha256: sha,
      capability: 'inbound_replies',
      checkKey: 'cloudflare.inbound',
      requestedValidUntil: 1_900_000_000_000,
      requestDigestSha256: sha
    })).toThrow('outbound readiness');

    expect(() => emailProviderReadinessCheckProjectionSchema.parse({
      schemaVersion: 1,
      readinessCheckId: 'readiness_check_1',
      connectionId: 'provider_connection_1',
      connectionRevisionId: 'provider_connection_revision_1',
      capability: 'transactional_outbound',
      checkKey: 'cloudflare.transactional_outbound',
      state: 'failed',
      readiness: 'ready',
      evidence: null,
      validUntil: 1_900_000_000_000,
      startedAt: now,
      completedAt: now
    })).toThrow();
  });

  test('cannot report provider acceptance or cost from a disabled diagnostic', () => {
    expect(emailProviderDiagnosticTestProjectionSchema.parse({
      schemaVersion: 1,
      diagnosticAttemptId: 'diagnostic_attempt_1',
      connectionRevisionId: 'provider_connection_revision_1',
      state: 'not_enabled',
      outcomeCode: 'diagnostic.not_enabled',
      evidence: null,
      providerMessageRecorded: false,
      cost: null,
      observedAt: now
    }).state).toBe('not_enabled');
    expect(() => emailProviderDiagnosticTestProjectionSchema.parse({
      schemaVersion: 1,
      diagnosticAttemptId: 'diagnostic_attempt_1',
      connectionRevisionId: 'provider_connection_revision_1',
      state: 'not_enabled',
      outcomeCode: 'diagnostic.not_enabled',
      evidence: null,
      providerMessageRecorded: true,
      cost: { minorUnits: 1, currency: 'USD' },
      observedAt: now
    })).toThrow();
  });
});
