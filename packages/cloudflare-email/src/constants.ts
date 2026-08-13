import {
  finalizeEmailSetupManifest,
  type ProviderCapabilities
} from '@jooevents/contracts';

export const CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY = 'cloudflare.email.workers';
export const CLOUDFLARE_REST_EMAIL_ADAPTER_KEY = 'cloudflare.email.rest';
export const CLOUDFLARE_EMAIL_ADAPTER_VERSION = 'v1';
export const CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_KEY = 'cloudflare.email.diagnostic';
export const CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_VERSION = 1;
export const CLOUDFLARE_EMAIL_READINESS_EXTERNAL_CHECK_KEY = 'cloudflare.email.outbound_ready';

export const CLOUDFLARE_EMAIL_CAPABILITIES: ProviderCapabilities = {
  idempotency: 'none',
  reconciliation: 'none',
  callbacks: [],
  inboundReplies: false
};
Object.freeze(CLOUDFLARE_EMAIL_CAPABILITIES.callbacks);
Object.freeze(CLOUDFLARE_EMAIL_CAPABILITIES);

const commonManifest = {
  contractVersion: 1 as const,
  schemaKey: 'je.communication.email-setup-manifest' as const,
  schemaVersion: 1 as const,
  manifestVersion: 1,
  capabilities: CLOUDFLARE_EMAIL_CAPABILITIES,
  capabilityStatus: {
    transactional_outbound: 'supported' as const,
    delivery_callbacks: 'not_supported' as const,
    suppression_callbacks: 'not_supported' as const,
    inbound_replies: 'not_enabled' as const
  },
  readinessChecks: [{
    key: 'cloudflare.transactional_outbound',
    capability: 'transactional_outbound' as const,
    externalCheckKey: CLOUDFLARE_EMAIL_READINESS_EXTERNAL_CHECK_KEY,
    observationSchemaVersion: 1,
    normalizerVersion: 1,
    maximumValidityMs: 300_000,
    observableClaimKeys: [
      'cloudflare.domain.enabled',
      'cloudflare.transport.configured'
    ]
  }],
  senderRequirements: {
    verifiedDomainRequired: true,
    verifiedFromAddressRequired: false,
    replyToMode: 'optional' as const,
    envelopeFromMode: 'adapter_managed' as const
  },
  callbacks: { kind: 'disabled' as const },
  diagnostics: {
    kind: 'supported' as const,
    fixtureKey: CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_KEY,
    fixtureVersion: CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_VERSION,
    maximumCostMinorUnits: 1,
    currency: 'USD'
  }
};

export const CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST = finalizeEmailSetupManifest({
  ...commonManifest,
  manifestKey: 'cloudflare.email.workers.setup',
  adapterKey: CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
  adapterVersion: CLOUDFLARE_EMAIL_ADAPTER_VERSION,
  nonSecretFields: [{
    key: 'cloudflare.binding_name',
    label: 'Workers send-email binding name',
    valueKind: 'text',
    required: true
  }],
  requiredSecretReferences: [],
  officialLinks: [
    {
      key: 'cloudflare.binding_configuration',
      label: 'Configure a Workers send-email binding',
      href: 'https://developers.cloudflare.com/email-service/configuration/send-bindings/'
    },
    {
      key: 'cloudflare.domain_setup',
      label: 'Configure an Email Sending domain',
      href: 'https://developers.cloudflare.com/email-service/configuration/domains/'
    },
    {
      key: 'cloudflare.workers_api',
      label: 'Cloudflare Email Sending Workers API',
      href: 'https://developers.cloudflare.com/email-service/api/send-emails/workers-api/'
    }
  ],
  humanSteps: [
    {
      key: 'cloudflare.step_01_onboard_domain',
      title: 'Onboard the sending domain',
      instruction: 'Onboard the exact sender domain in Cloudflare Email Sending and wait for Cloudflare to report it enabled.',
      officialLinkKey: 'cloudflare.domain_setup'
    },
    {
      key: 'cloudflare.step_02_configure_binding',
      title: 'Configure the Workers binding',
      instruction: 'Add a send_email binding and apply any required sender or destination restrictions in the Workers deployment configuration.',
      officialLinkKey: 'cloudflare.binding_configuration'
    },
    {
      key: 'cloudflare.step_03_verify_readiness',
      title: 'Run the readiness check',
      instruction: 'Use the configured readiness probe to verify the exact immutable connection revision before activation.'
    }
  ]
});

export const CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST = finalizeEmailSetupManifest({
  ...commonManifest,
  manifestKey: 'cloudflare.email.rest.setup',
  adapterKey: CLOUDFLARE_REST_EMAIL_ADAPTER_KEY,
  adapterVersion: CLOUDFLARE_EMAIL_ADAPTER_VERSION,
  nonSecretFields: [{
    key: 'cloudflare.account_id',
    label: 'Cloudflare account ID',
    valueKind: 'text',
    required: true
  }],
  requiredSecretReferences: [{
    key: 'cloudflare.api_token',
    label: 'Cloudflare API token with Email Sending permission',
    required: true
  }],
  officialLinks: [
    {
      key: 'cloudflare.domain_setup',
      label: 'Configure an Email Sending domain',
      href: 'https://developers.cloudflare.com/email-service/configuration/domains/'
    },
    {
      key: 'cloudflare.rest_api',
      label: 'Cloudflare Email Sending REST API',
      href: 'https://developers.cloudflare.com/email-service/api/send-emails/rest-api/'
    },
    {
      key: 'cloudflare.token_configuration',
      label: 'Create a Cloudflare API token',
      href: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/'
    }
  ],
  humanSteps: [
    {
      key: 'cloudflare.step_01_onboard_domain',
      title: 'Onboard the sending domain',
      instruction: 'Onboard the exact sender domain in Cloudflare Email Sending and wait for Cloudflare to report it enabled.',
      officialLinkKey: 'cloudflare.domain_setup'
    },
    {
      key: 'cloudflare.step_02_stage_token',
      title: 'Stage an API token',
      instruction: 'Create an API token with the minimum Email Sending permission and store it through the deployment secret system.',
      officialLinkKey: 'cloudflare.token_configuration'
    },
    {
      key: 'cloudflare.step_03_verify_readiness',
      title: 'Run the readiness check',
      instruction: 'Use the configured readiness probe to verify the exact immutable connection revision before activation.'
    }
  ]
});
