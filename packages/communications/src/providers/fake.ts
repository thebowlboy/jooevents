import { canonicalJsonText } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  emailDiagnosticLookupOutcomeSchema,
  emailDiagnosticSubmissionOutcomeSchema,
  finalizeEmailSetupManifest,
  finalizeVerifiedProviderCallback,
  providerLookupOutcomeSchema,
  providerReadinessAdapterObservationSchema,
  providerReadinessInputSchema,
  providerSubmissionOutcomeSchema,
  type EmailDiagnosticLookupOutcome,
  type EmailDiagnosticLookupInput,
  type EmailDiagnosticSubmissionOutcome,
  type ProviderLookupInput,
  type ProviderLookupOutcome,
  type ProviderReadinessInput,
  type ProviderReadinessAdapterObservation,
  type ProviderSubmissionOutcome,
  type RegisteredSafeEvidenceFact,
  type SafeEvidence
} from '@jooevents/contracts';
import { createEmailCallbackVerifierRegistry } from './callback-verifier-registry';
import {
  computeReviewedEmailEnvelopeDigestSha256,
  createEmailDiagnosticSubmissionPreparer,
  createEmailSubmissionPreparer,
  validateEmailDiagnosticLookupInput,
  validateProviderLookupInput,
  validateRawProviderCallback,
  type CallbackVerifierCandidate,
  type EmailCallbackVerifier,
  type EmailCallbackVerifierRegistry,
  type EmailDeliveryAdapter,
  type EmailDiagnosticsAdapter,
  type EmailSetupAdapter,
  type ImmutableEmailDiagnosticSubmission,
  type ImmutableEmailEnvelope,
  type ImmutableEmailSubmission,
  type PreparedEmailDiagnosticSubmission,
  type PreparedEmailSubmission,
  type RawProviderCallback
} from './port';
import {
  createSafeEvidence,
  createSafeEvidenceCatalog,
  type SafeEvidenceCatalog
} from './outcomes';

export const FAKE_EMAIL_ADAPTER_KEY = 'fake.email';
export const FAKE_EMAIL_ADAPTER_VERSION = 'v1';
export const FAKE_EMAIL_MANIFEST_KEY = 'fake.email.setup';
export const FAKE_CALLBACK_VERIFIER_KEY = 'fake.callback';
export const FAKE_CALLBACK_VERIFIER_VERSION = 'v1';
export const FAKE_CALLBACK_VERIFICATION_CONTRACT_VERSION = 1;

export const FAKE_PROVIDER_SCENARIO_KEYS = Object.freeze({
  ordinary: Object.freeze({
    acceptedWithId: 'fake_delivery_accepted_with_id',
    acceptedWithoutId: 'fake_delivery_accepted_without_id',
    rejectedSafeRetryable: 'fake_delivery_rejected_safe_retryable',
    rejectedTerminal: 'fake_delivery_rejected_terminal',
    timeoutBeforeAcceptance: 'fake_delivery_timeout_before_acceptance',
    timeoutAfterAcceptance: 'fake_delivery_timeout_after_acceptance',
    connectionLostBeforeAcceptance: 'fake_delivery_connection_lost_before_acceptance',
    connectionLostAfterAcceptance: 'fake_delivery_connection_lost_after_acceptance',
    malformedResponse: 'fake_delivery_malformed_response',
    thrownBeforeCapture: 'fake_delivery_thrown_before_capture',
    thrownAfterCapture: 'fake_delivery_thrown_after_capture'
  }),
  lookup: Object.freeze({
    acceptedWithId: 'fake_lookup_accepted_with_id',
    acceptedWithoutId: 'fake_lookup_accepted_without_id',
    rejectedSafeRetryable: 'fake_lookup_rejected_safe_retryable',
    rejectedTerminal: 'fake_lookup_rejected_terminal',
    notFound: 'fake_lookup_not_found',
    timeout: 'fake_lookup_timeout',
    connectionLost: 'fake_lookup_connection_lost',
    malformedResponse: 'fake_lookup_malformed_response',
    conflictingEvidence: 'fake_lookup_conflicting_evidence'
  }),
  diagnostic: Object.freeze({
    acceptedWithId: 'fake_diagnostic_accepted_with_id',
    acceptedWithoutId: 'fake_diagnostic_accepted_without_id',
    acceptedWithCost: 'fake_diagnostic_accepted_with_cost',
    rejectedSafeRetryable: 'fake_diagnostic_rejected_safe_retryable',
    rejectedTerminal: 'fake_diagnostic_rejected_terminal',
    timeoutBeforeAcceptance: 'fake_diagnostic_timeout_before_acceptance',
    timeoutAfterAcceptance: 'fake_diagnostic_timeout_after_acceptance',
    connectionLostBeforeAcceptance: 'fake_diagnostic_connection_lost_before_acceptance',
    connectionLostAfterAcceptance: 'fake_diagnostic_connection_lost_after_acceptance',
    malformedResponse: 'fake_diagnostic_malformed_response',
    thrownBeforeCapture: 'fake_diagnostic_thrown_before_capture',
    thrownAfterCapture: 'fake_diagnostic_thrown_after_capture'
  }),
  diagnosticLookup: Object.freeze({
    acceptedWithId: 'fake_diagnostic_lookup_accepted_with_id',
    rejectedSafeRetryable: 'fake_diagnostic_lookup_rejected_safe_retryable',
    rejectedTerminal: 'fake_diagnostic_lookup_rejected_terminal',
    notFound: 'fake_diagnostic_lookup_not_found',
    timeout: 'fake_diagnostic_lookup_timeout',
    connectionLost: 'fake_diagnostic_lookup_connection_lost',
    malformedResponse: 'fake_diagnostic_lookup_malformed_response',
    conflictingEvidence: 'fake_diagnostic_lookup_conflicting_evidence'
  }),
  readiness: Object.freeze({
    ready: 'fake_readiness_ready',
    degraded: 'fake_readiness_degraded',
    knownFailed: 'fake_readiness_known_failed',
    timeout: 'fake_readiness_timeout',
    connectionLost: 'fake_readiness_connection_lost',
    malformedResponse: 'fake_readiness_malformed_response',
    thrown: 'fake_readiness_thrown'
  })
});

const ALL_SCENARIOS = [
  ...Object.values(FAKE_PROVIDER_SCENARIO_KEYS.ordinary),
  ...Object.values(FAKE_PROVIDER_SCENARIO_KEYS.lookup),
  ...Object.values(FAKE_PROVIDER_SCENARIO_KEYS.diagnostic),
  ...Object.values(FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup),
  ...Object.values(FAKE_PROVIDER_SCENARIO_KEYS.readiness),
  'fake_inbound_not_enabled',
  'fake_unknown_scenario',
  'callback_verified',
  'callback_not_verified',
  'callback_no_candidate',
  'callback_verifier_unavailable',
  'callback_none_verified',
  'callback_multiple_verified'
] as const;

const ALL_EVIDENCE_CODES = [
  'delivery.accepted',
  'delivery.rejected_safe_retryable',
  'delivery.rejected_terminal',
  'delivery.acceptance_unknown',
  'lookup.accepted',
  'lookup.rejected_safe_retryable',
  'lookup.rejected_terminal',
  'lookup.not_found',
  'lookup.indeterminate',
  'diagnostic.accepted',
  'diagnostic.rejected_safe_retryable',
  'diagnostic.rejected_terminal',
  'diagnostic.acceptance_unknown',
  'diagnostic_lookup.accepted',
  'diagnostic_lookup.rejected_safe_retryable',
  'diagnostic_lookup.rejected_terminal',
  'diagnostic_lookup.not_found',
  'diagnostic_lookup.indeterminate',
  'readiness.ready',
  'readiness.degraded',
  'readiness.known_failed',
  'readiness.acceptance_unknown',
  'readiness.inbound_not_enabled',
  'callback.verified',
  'callback.not_verified',
  'callback.no_candidate',
  'callback.verifier_unavailable',
  'callback.none_verified',
  'callback.multiple_verified'
] as const;

export const FAKE_SAFE_EVIDENCE_CATALOG: SafeEvidenceCatalog = createSafeEvidenceCatalog({
  facts: [
    { key: 'fake.scenario', schemaVersion: 1, valueKind: 'enum', allowedValues: ALL_SCENARIOS },
    { key: 'fake.request_captured', schemaVersion: 1, valueKind: 'boolean' },
    {
      key: 'fake.acceptance_phase',
      schemaVersion: 1,
      valueKind: 'enum',
      allowedValues: ['before_acceptance', 'after_acceptance', 'unknown']
    },
    { key: 'fake.cost_minor_units', schemaVersion: 1, valueKind: 'integer', minimum: 0, maximum: 10_000 }
  ],
  codes: ALL_EVIDENCE_CODES.map((code) => ({
    code,
    allowedFactKeys: [
      'fake.acceptance_phase',
      'fake.cost_minor_units',
      'fake.request_captured',
      'fake.scenario'
    ]
  }))
});

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonText(value))));
}

function correlationId(key: string): string {
  return `corr1_${digest(key).slice(0, 24)}`;
}

function enumFact(key: string, value: string): RegisteredSafeEvidenceFact {
  return {
    factKey: key as RegisteredSafeEvidenceFact['factKey'],
    factSchemaVersion: 1,
    valueKind: 'enum',
    enumValue: value as Extract<RegisteredSafeEvidenceFact, { valueKind: 'enum' }>['enumValue']
  };
}

function booleanFact(key: string, value: boolean): RegisteredSafeEvidenceFact {
  return {
    factKey: key as RegisteredSafeEvidenceFact['factKey'],
    factSchemaVersion: 1,
    valueKind: 'boolean',
    booleanValue: value
  };
}

function integerFact(key: string, value: number): RegisteredSafeEvidenceFact {
  return {
    factKey: key as RegisteredSafeEvidenceFact['factKey'],
    factSchemaVersion: 1,
    valueKind: 'integer',
    integerValue: value
  };
}

function evidence(
  code: typeof ALL_EVIDENCE_CODES[number],
  scenario: string,
  facts: readonly RegisteredSafeEvidenceFact[] = []
): SafeEvidence {
  return createSafeEvidence(FAKE_SAFE_EVIDENCE_CATALOG, {
    code,
    correlationId: correlationId(`${code}:${scenario}`),
    facts: [enumFact('fake.scenario', scenario), ...facts]
  });
}

function providerMessageId(key: string): string {
  return `fake_msg_${digest(key).slice(0, 24)}`;
}

export type FakeCapturedRequest = Readonly<{
  attemptId: string;
  externalKey: string;
  providerRequestDigestSha256: string;
  reviewedEnvelopeDigestSha256: string;
}>;

type FakeOrdinaryPrepared = Readonly<{
  attemptId: string;
  externalKey: string;
  reviewedEnvelopeDigestSha256: string;
}>;

type FakeDiagnosticPrepared = Readonly<{
  attemptId: string;
  externalKey: string;
  fixtureKey: string;
  fixtureVersion: number;
  maximumCostMinorUnits: number;
  currency: string;
  reviewedEnvelopeDigestSha256: string;
}>;

class FakeProviderBoundaryFailure extends Error {
  public constructor(
    public readonly phase: 'before_capture' | 'after_capture'
  ) {
    super('fake provider boundary failure');
    this.name = 'FakeProviderBoundaryFailure';
  }
}

function unknownSubmission(
  scenario: string,
  reason: 'timeout' | 'connection_lost' | 'malformed_response',
  captured: boolean,
  phase: 'before_acceptance' | 'after_acceptance' | 'unknown'
): ProviderSubmissionOutcome {
  return providerSubmissionOutcomeSchema.parse({
    contractVersion: 1,
    kind: 'acceptance_unknown',
    reason,
    evidence: evidence('delivery.acceptance_unknown', scenario, [
      enumFact('fake.acceptance_phase', phase),
      booleanFact('fake.request_captured', captured)
    ])
  });
}

function unknownDiagnostic(
  scenario: string,
  reason: 'timeout' | 'connection_lost' | 'malformed_response',
  captured: boolean,
  phase: 'before_acceptance' | 'after_acceptance' | 'unknown'
): EmailDiagnosticSubmissionOutcome {
  return emailDiagnosticSubmissionOutcomeSchema.parse({
    contractVersion: 1,
    kind: 'acceptance_unknown',
    reason,
    evidence: evidence('diagnostic.acceptance_unknown', scenario, [
      enumFact('fake.acceptance_phase', phase),
      booleanFact('fake.request_captured', captured)
    ])
  });
}

export interface DeterministicFakeEmailProvider {
  readonly delivery: EmailDeliveryAdapter<FakeOrdinaryPrepared>;
  readonly diagnostics: EmailDiagnosticsAdapter<FakeDiagnosticPrepared>;
  readonly setup: EmailSetupAdapter;
  readonly callbackVerifier: EmailCallbackVerifier<FakeCallbackVerifierContext>;
  readonly callbackRegistry: EmailCallbackVerifierRegistry<FakeCallbackVerifierContext>;
  capturedOrdinaryRequests(): readonly FakeCapturedRequest[];
  capturedDiagnosticRequests(): readonly FakeCapturedRequest[];
}

export type FakeCallbackVerifierContext = Readonly<{
  contractVersion: 1;
  authority: 'fake.callback.fixture.v1';
}>;

export const FAKE_CALLBACK_VERIFIER_CONTEXT: FakeCallbackVerifierContext = Object.freeze({
  contractVersion: 1,
  authority: 'fake.callback.fixture.v1'
});

export const FAKE_EMAIL_SETUP_MANIFEST = finalizeEmailSetupManifest({
  contractVersion: 1,
  schemaKey: 'je.communication.email-setup-manifest',
  schemaVersion: 1,
  manifestKey: FAKE_EMAIL_MANIFEST_KEY,
  manifestVersion: 1,
  adapterKey: FAKE_EMAIL_ADAPTER_KEY,
  adapterVersion: FAKE_EMAIL_ADAPTER_VERSION,
  capabilities: {
    idempotency: 'provider_lookup',
    reconciliation: 'lookup',
    callbacks: ['delivered', 'delay', 'bounce', 'complaint', 'suppression'],
    attachments: true,
    calendarMime: true,
    inboundReplies: false
  },
  capabilityStatus: {
    transactional_outbound: 'supported',
    attachments: 'supported',
    calendar_mime: 'supported',
    delivery_callbacks: 'supported',
    suppression_callbacks: 'supported',
    inbound_replies: 'not_enabled'
  },
  nonSecretFields: [],
  requiredSecretReferences: [],
  officialLinks: [{
    key: 'fake.documentation',
    label: 'Deterministic fake contract',
    href: 'https://example.invalid/jooevents/fake-email-provider'
  }],
  humanSteps: [],
  readinessChecks: [
    {
      key: 'fake.delivery_callbacks',
      capability: 'delivery_callbacks',
      externalCheckKey: FAKE_PROVIDER_SCENARIO_KEYS.readiness.ready,
      observationSchemaVersion: 1,
      normalizerVersion: 1,
      maximumValidityMs: 300_000,
      observableClaimKeys: ['fake.callback.fixture']
    },
    {
      key: 'fake.suppression_callbacks',
      capability: 'suppression_callbacks',
      externalCheckKey: FAKE_PROVIDER_SCENARIO_KEYS.readiness.ready,
      observationSchemaVersion: 1,
      normalizerVersion: 1,
      maximumValidityMs: 300_000,
      observableClaimKeys: ['fake.suppression.fixture']
    },
    {
      key: 'fake.transactional_outbound',
      capability: 'transactional_outbound',
      externalCheckKey: FAKE_PROVIDER_SCENARIO_KEYS.readiness.ready,
      observationSchemaVersion: 1,
      normalizerVersion: 1,
      maximumValidityMs: 300_000,
      observableClaimKeys: ['fake.outbound.fixture']
    }
  ],
  senderRequirements: {
    verifiedDomainRequired: false,
    verifiedFromAddressRequired: false,
    replyToMode: 'optional',
    envelopeFromMode: 'adapter_managed'
  },
  callbacks: {
    kind: 'enabled',
    callbackEndpointPath: '/webhooks/email/fake',
    signatureSchemeKey: 'fake.signature',
    verifierKey: FAKE_CALLBACK_VERIFIER_KEY,
    verifierVersion: FAKE_CALLBACK_VERIFIER_VERSION,
    verificationContractVersion: FAKE_CALLBACK_VERIFICATION_CONTRACT_VERSION,
    keyIdMode: 'absent',
    obligationContract: {
      key: 'fake.callback.obligation',
      version: 1,
      evidenceClasses: ['bounced', 'complained', 'delayed', 'delivered', 'suppressed'],
      basis: 'attempt_started_database_time',
      horizonMs: 86_400_000,
      acceptedA8MaximumMs: 604_800_000,
      correlationMode: 'provider_message_id_with_lookup'
    }
  },
  diagnostics: {
    kind: 'supported',
    fixtureKey: 'fake.diagnostic.fixture',
    fixtureVersion: 1,
    maximumCostMinorUnits: 100,
    currency: 'USD'
  }
});

function fakeCallbackVerifier(): EmailCallbackVerifier<FakeCallbackVerifierContext> {
  return Object.freeze({
    verifierKey: FAKE_CALLBACK_VERIFIER_KEY,
    verifierVersion: FAKE_CALLBACK_VERIFIER_VERSION,
    verificationContractVersion: FAKE_CALLBACK_VERIFICATION_CONTRACT_VERSION,
    async verifyCandidate(
      input: RawProviderCallback,
      candidate: CallbackVerifierCandidate<FakeCallbackVerifierContext>
    ) {
      const callback = validateRawProviderCallback(input);
      const notVerified = () => Object.freeze({
        contractVersion: 1 as const,
        kind: 'not_verified' as const,
        evidence: evidence('callback.not_verified', 'callback_not_verified')
      });
      try {
        if (
          candidate.opaqueContext.contractVersion !== 1
          || candidate.opaqueContext.authority !== 'fake.callback.fixture.v1'
        ) return notVerified();
        const signature = JSON.parse(new TextDecoder().decode(callback.signatureEnvelopeBytes)) as {
          contractVersion?: unknown;
          acceptedVerifierRevisionIds?: unknown;
        };
        if (
          signature.contractVersion !== 1
          || !Array.isArray(signature.acceptedVerifierRevisionIds)
          || !signature.acceptedVerifierRevisionIds.every((value) => typeof value === 'string')
          || !signature.acceptedVerifierRevisionIds.includes(candidate.callbackVerifierRevisionId)
        ) return notVerified();
        const payload = JSON.parse(new TextDecoder().decode(callback.rawPayloadBytes)) as Record<string, unknown>;
        const verified = finalizeVerifiedProviderCallback({
          contractVersion: 1,
          schemaKey: 'je.communication.verified-provider-callback',
          schemaVersion: 1,
          normalizerKey: 'je.communication.provider-callback-normalizer',
          normalizerVersion: 1,
          providerConnectionId: callback.providerConnectionId,
          providerEventId: payload.providerEventId,
          payloadDigestSha256: callback.payloadDigestSha256,
          normalizedEvidenceClass: payload.normalizedEvidenceClass,
          signatureTimestamp: payload.signatureTimestamp,
          replayWindowExpiresAt: payload.replayWindowExpiresAt,
          verifiedAt: payload.verifiedAt,
          ...(payload.providerOccurredAt === undefined
            ? {}
            : { providerOccurredAt: payload.providerOccurredAt }),
          normalizedIdentityShape: payload.normalizedIdentityShape,
          ...(payload.providerMessageId === undefined
            ? {}
            : { providerMessageId: payload.providerMessageId }),
          ...(payload.externalDeliveryKey === undefined
            ? {}
            : { externalDeliveryKey: payload.externalDeliveryKey })
        } as never);
        return Object.freeze({
          contractVersion: 1,
          kind: 'verified',
          verified,
          evidence: evidence('callback.verified', 'callback_verified')
        });
      } catch {
        return notVerified();
      }
    }
  });
}

export function createDeterministicFakeEmailProvider(): DeterministicFakeEmailProvider {
  const ordinaryPreparer = createEmailSubmissionPreparer<FakeOrdinaryPrepared>(
    FAKE_EMAIL_ADAPTER_KEY,
    FAKE_EMAIL_ADAPTER_VERSION
  );
  const diagnosticPreparer = createEmailDiagnosticSubmissionPreparer<FakeDiagnosticPrepared>(
    FAKE_EMAIL_ADAPTER_KEY,
    FAKE_EMAIL_ADAPTER_VERSION
  );
  const capturedOrdinary: FakeCapturedRequest[] = [];
  const capturedDiagnostic: FakeCapturedRequest[] = [];

  function capture(
    target: FakeCapturedRequest[],
    attemptId: string,
    externalKey: string,
    prepared: { providerRequestDigestSha256: string; reviewedEnvelopeDigestSha256: string }
  ): void {
    target.push(Object.freeze({
      attemptId,
      externalKey,
      providerRequestDigestSha256: prepared.providerRequestDigestSha256,
      reviewedEnvelopeDigestSha256: prepared.reviewedEnvelopeDigestSha256
    }));
  }

  const delivery: EmailDeliveryAdapter<FakeOrdinaryPrepared> = Object.freeze({
    adapterKey: FAKE_EMAIL_ADAPTER_KEY,
    adapterVersion: FAKE_EMAIL_ADAPTER_VERSION,
    capabilities: FAKE_EMAIL_SETUP_MANIFEST.capabilities,
    prepare(input: ImmutableEmailSubmission) {
      return ordinaryPreparer.prepare(input, (snapshot) => Object.freeze({
        attemptId: snapshot.deliveryAttemptId,
        externalKey: snapshot.externalDeliveryKey,
        reviewedEnvelopeDigestSha256: snapshot.reviewedEnvelopeDigestSha256
      }));
    },
    async submit(prepared: PreparedEmailSubmission<FakeOrdinaryPrepared>) {
      const opened = ordinaryPreparer.open(prepared);
      const scenario = opened.opaque.externalKey;
      let captured = false;
      const captureRequest = () => {
        if (!captured) {
          capture(capturedOrdinary, opened.opaque.attemptId, scenario, prepared);
          captured = true;
        }
      };
      try {
        if (scenario === FAKE_PROVIDER_SCENARIO_KEYS.ordinary.thrownBeforeCapture) {
          throw new FakeProviderBoundaryFailure('before_capture');
        }
        captureRequest();
        if (scenario === FAKE_PROVIDER_SCENARIO_KEYS.ordinary.thrownAfterCapture) {
          throw new FakeProviderBoundaryFailure('after_capture');
        }
        switch (scenario) {
          case FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId:
            return providerSubmissionOutcomeSchema.parse({
              contractVersion: 1,
              kind: 'accepted',
              providerMessageId: providerMessageId(scenario),
              evidence: evidence('delivery.accepted', scenario, [
                booleanFact('fake.request_captured', true)
              ])
            });
          case FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithoutId:
            return providerSubmissionOutcomeSchema.parse({
              contractVersion: 1,
              kind: 'accepted',
              evidence: evidence('delivery.accepted', scenario, [
                booleanFact('fake.request_captured', true)
              ])
            });
          case FAKE_PROVIDER_SCENARIO_KEYS.ordinary.rejectedSafeRetryable:
            return providerSubmissionOutcomeSchema.parse({
              contractVersion: 1,
              kind: 'known_rejected',
              retryClass: 'safe_retryable',
              code: 'delivery.rejected_safe_retryable',
              evidence: evidence('delivery.rejected_safe_retryable', scenario, [
                booleanFact('fake.request_captured', true)
              ])
            });
          case FAKE_PROVIDER_SCENARIO_KEYS.ordinary.rejectedTerminal:
            return providerSubmissionOutcomeSchema.parse({
              contractVersion: 1,
              kind: 'known_rejected',
              retryClass: 'terminal',
              code: 'delivery.rejected_terminal',
              evidence: evidence('delivery.rejected_terminal', scenario, [
                booleanFact('fake.request_captured', true)
              ])
            });
          case FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutBeforeAcceptance:
            return unknownSubmission(scenario, 'timeout', true, 'before_acceptance');
          case FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutAfterAcceptance:
            return unknownSubmission(scenario, 'timeout', true, 'after_acceptance');
          case FAKE_PROVIDER_SCENARIO_KEYS.ordinary.connectionLostBeforeAcceptance:
            return unknownSubmission(scenario, 'connection_lost', true, 'before_acceptance');
          case FAKE_PROVIDER_SCENARIO_KEYS.ordinary.connectionLostAfterAcceptance:
            return unknownSubmission(scenario, 'connection_lost', true, 'after_acceptance');
          case FAKE_PROVIDER_SCENARIO_KEYS.ordinary.malformedResponse:
            return unknownSubmission(scenario, 'malformed_response', true, 'unknown');
          default:
            return providerSubmissionOutcomeSchema.parse({
              contractVersion: 1,
              kind: 'known_rejected',
              retryClass: 'terminal',
              code: 'delivery.rejected_terminal',
              evidence: evidence('delivery.rejected_terminal', 'fake_unknown_scenario', [
                booleanFact('fake.request_captured', true)
              ])
            });
        }
      } catch (error) {
        if (!(error instanceof FakeProviderBoundaryFailure)) throw error;
        if (error.phase === 'before_capture') {
          return providerSubmissionOutcomeSchema.parse({
            contractVersion: 1,
            kind: 'known_rejected',
            retryClass: 'safe_retryable',
            code: 'delivery.rejected_safe_retryable',
            evidence: evidence('delivery.rejected_safe_retryable', scenario, [
              enumFact('fake.acceptance_phase', 'before_acceptance'),
              booleanFact('fake.request_captured', false)
            ])
          });
        }
        return unknownSubmission(scenario, 'connection_lost', true, 'unknown');
      }
    },
    async lookup(input: ProviderLookupInput): Promise<ProviderLookupOutcome> {
      const lookup = validateProviderLookupInput(input);
      if (lookup.adapterKey !== FAKE_EMAIL_ADAPTER_KEY || lookup.adapterVersion !== FAKE_EMAIL_ADAPTER_VERSION) {
        throw new TypeError('fake lookup adapter tuple does not match');
      }
      const scenario = lookup.externalDeliveryKey;
      const common = { contractVersion: 1 as const };
      switch (scenario) {
        case FAKE_PROVIDER_SCENARIO_KEYS.lookup.acceptedWithId:
          return providerLookupOutcomeSchema.parse({ ...common, kind: 'accepted', providerMessageId: providerMessageId(scenario), evidence: evidence('lookup.accepted', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.lookup.acceptedWithoutId:
          return providerLookupOutcomeSchema.parse({ ...common, kind: 'accepted', evidence: evidence('lookup.accepted', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.lookup.rejectedSafeRetryable:
          return providerLookupOutcomeSchema.parse({ ...common, kind: 'known_rejected', retryClass: 'safe_retryable', code: 'lookup.rejected_safe_retryable', evidence: evidence('lookup.rejected_safe_retryable', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.lookup.rejectedTerminal:
          return providerLookupOutcomeSchema.parse({ ...common, kind: 'known_rejected', retryClass: 'terminal', code: 'lookup.rejected_terminal', evidence: evidence('lookup.rejected_terminal', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.lookup.notFound:
          return providerLookupOutcomeSchema.parse({ ...common, kind: 'not_found', evidence: evidence('lookup.not_found', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.lookup.timeout:
          return providerLookupOutcomeSchema.parse({ ...common, kind: 'indeterminate', reason: 'timeout', evidence: evidence('lookup.indeterminate', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.lookup.connectionLost:
          return providerLookupOutcomeSchema.parse({ ...common, kind: 'indeterminate', reason: 'connection_lost', evidence: evidence('lookup.indeterminate', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.lookup.malformedResponse:
          return providerLookupOutcomeSchema.parse({ ...common, kind: 'indeterminate', reason: 'malformed_response', evidence: evidence('lookup.indeterminate', scenario) });
        default:
          return providerLookupOutcomeSchema.parse({ ...common, kind: 'indeterminate', reason: 'conflicting_evidence', evidence: evidence('lookup.indeterminate', scenario === FAKE_PROVIDER_SCENARIO_KEYS.lookup.conflictingEvidence ? scenario : 'fake_unknown_scenario') });
      }
    }
  });

  const diagnostics: EmailDiagnosticsAdapter<FakeDiagnosticPrepared> = Object.freeze({
    adapterKey: FAKE_EMAIL_ADAPTER_KEY,
    adapterVersion: FAKE_EMAIL_ADAPTER_VERSION,
    capabilities: {
      idempotency: FAKE_EMAIL_SETUP_MANIFEST.capabilities.idempotency,
      reconciliation: FAKE_EMAIL_SETUP_MANIFEST.capabilities.reconciliation,
      callbacks: FAKE_EMAIL_SETUP_MANIFEST.capabilities.callbacks
    },
    prepare(input: ImmutableEmailDiagnosticSubmission) {
      return diagnosticPreparer.prepare(input, (snapshot) => Object.freeze({
        attemptId: snapshot.diagnosticAttemptId,
        externalKey: snapshot.externalDiagnosticKey,
        fixtureKey: snapshot.fixtureKey,
        fixtureVersion: snapshot.fixtureVersion,
        maximumCostMinorUnits: snapshot.maximumCostMinorUnits,
        currency: snapshot.currency,
        reviewedEnvelopeDigestSha256: snapshot.reviewedEnvelopeDigestSha256
      }));
    },
    async submit(
      prepared: PreparedEmailDiagnosticSubmission<FakeDiagnosticPrepared>
    ) {
      const opened = diagnosticPreparer.open(prepared);
      const scenario = opened.opaque.externalKey;
      let captured = false;
      const captureRequest = () => {
        if (!captured) {
          capture(capturedDiagnostic, opened.opaque.attemptId, scenario, prepared);
          captured = true;
        }
      };
      try {
        if (scenario === FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.thrownBeforeCapture) {
          throw new FakeProviderBoundaryFailure('before_capture');
        }
        captureRequest();
        if (scenario === FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.thrownAfterCapture) {
          throw new FakeProviderBoundaryFailure('after_capture');
        }
        switch (scenario) {
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.acceptedWithId:
            return emailDiagnosticSubmissionOutcomeSchema.parse({ contractVersion: 1, kind: 'accepted', providerMessageId: providerMessageId(scenario), evidence: evidence('diagnostic.accepted', scenario, [booleanFact('fake.request_captured', true)]) });
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.acceptedWithoutId:
            return emailDiagnosticSubmissionOutcomeSchema.parse({ contractVersion: 1, kind: 'accepted', evidence: evidence('diagnostic.accepted', scenario, [booleanFact('fake.request_captured', true)]) });
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.acceptedWithCost: {
            const cost = Math.min(opened.opaque.maximumCostMinorUnits, 12);
            return emailDiagnosticSubmissionOutcomeSchema.parse({ contractVersion: 1, kind: 'accepted', providerMessageId: providerMessageId(scenario), cost: { minorUnits: cost, currency: opened.opaque.currency }, evidence: evidence('diagnostic.accepted', scenario, [booleanFact('fake.request_captured', true), integerFact('fake.cost_minor_units', cost)]) });
          }
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.rejectedSafeRetryable:
            return emailDiagnosticSubmissionOutcomeSchema.parse({ contractVersion: 1, kind: 'known_rejected_safe_retryable', code: 'diagnostic.rejected_safe_retryable', evidence: evidence('diagnostic.rejected_safe_retryable', scenario, [booleanFact('fake.request_captured', true)]) });
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.rejectedTerminal:
            return emailDiagnosticSubmissionOutcomeSchema.parse({ contractVersion: 1, kind: 'known_rejected_terminal', code: 'diagnostic.rejected_terminal', evidence: evidence('diagnostic.rejected_terminal', scenario, [booleanFact('fake.request_captured', true)]) });
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.timeoutBeforeAcceptance:
            return unknownDiagnostic(scenario, 'timeout', true, 'before_acceptance');
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.timeoutAfterAcceptance:
            return unknownDiagnostic(scenario, 'timeout', true, 'after_acceptance');
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.connectionLostBeforeAcceptance:
            return unknownDiagnostic(scenario, 'connection_lost', true, 'before_acceptance');
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.connectionLostAfterAcceptance:
            return unknownDiagnostic(scenario, 'connection_lost', true, 'after_acceptance');
          case FAKE_PROVIDER_SCENARIO_KEYS.diagnostic.malformedResponse:
            return unknownDiagnostic(scenario, 'malformed_response', true, 'unknown');
          default:
            return emailDiagnosticSubmissionOutcomeSchema.parse({ contractVersion: 1, kind: 'known_rejected_terminal', code: 'diagnostic.rejected_terminal', evidence: evidence('diagnostic.rejected_terminal', 'fake_unknown_scenario', [booleanFact('fake.request_captured', true)]) });
        }
      } catch (error) {
        if (!(error instanceof FakeProviderBoundaryFailure)) throw error;
        if (error.phase === 'before_capture') {
          return emailDiagnosticSubmissionOutcomeSchema.parse({ contractVersion: 1, kind: 'known_rejected_safe_retryable', code: 'diagnostic.rejected_safe_retryable', evidence: evidence('diagnostic.rejected_safe_retryable', scenario, [enumFact('fake.acceptance_phase', 'before_acceptance'), booleanFact('fake.request_captured', false)]) });
        }
        return unknownDiagnostic(scenario, 'connection_lost', true, 'unknown');
      }
    },
    async lookup(input: EmailDiagnosticLookupInput): Promise<EmailDiagnosticLookupOutcome> {
      const lookup = validateEmailDiagnosticLookupInput(input);
      if (lookup.adapterKey !== FAKE_EMAIL_ADAPTER_KEY || lookup.adapterVersion !== FAKE_EMAIL_ADAPTER_VERSION) throw new TypeError('fake diagnostic lookup adapter tuple does not match');
      const scenario = lookup.externalDiagnosticKey;
      const common = { contractVersion: 1 as const };
      switch (scenario) {
        case FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.acceptedWithId:
          return emailDiagnosticLookupOutcomeSchema.parse({ ...common, kind: 'accepted', providerMessageId: providerMessageId(scenario), evidence: evidence('diagnostic_lookup.accepted', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.rejectedSafeRetryable:
          return emailDiagnosticLookupOutcomeSchema.parse({ ...common, kind: 'known_rejected_safe_retryable', code: 'diagnostic_lookup.rejected_safe_retryable', evidence: evidence('diagnostic_lookup.rejected_safe_retryable', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.rejectedTerminal:
          return emailDiagnosticLookupOutcomeSchema.parse({ ...common, kind: 'known_rejected_terminal', code: 'diagnostic_lookup.rejected_terminal', evidence: evidence('diagnostic_lookup.rejected_terminal', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.notFound:
          return emailDiagnosticLookupOutcomeSchema.parse({ ...common, kind: 'not_found', evidence: evidence('diagnostic_lookup.not_found', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.timeout:
          return emailDiagnosticLookupOutcomeSchema.parse({ ...common, kind: 'indeterminate', reason: 'timeout', evidence: evidence('diagnostic_lookup.indeterminate', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.connectionLost:
          return emailDiagnosticLookupOutcomeSchema.parse({ ...common, kind: 'indeterminate', reason: 'connection_lost', evidence: evidence('diagnostic_lookup.indeterminate', scenario) });
        case FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.malformedResponse:
          return emailDiagnosticLookupOutcomeSchema.parse({ ...common, kind: 'indeterminate', reason: 'malformed_response', evidence: evidence('diagnostic_lookup.indeterminate', scenario) });
        default:
          return emailDiagnosticLookupOutcomeSchema.parse({ ...common, kind: 'indeterminate', reason: 'conflicting_evidence', evidence: evidence('diagnostic_lookup.indeterminate', scenario === FAKE_PROVIDER_SCENARIO_KEYS.diagnosticLookup.conflictingEvidence ? scenario : 'fake_unknown_scenario') });
      }
    }
  });

  const setup: EmailSetupAdapter = Object.freeze({
    adapterKey: FAKE_EMAIL_ADAPTER_KEY,
    adapterVersion: FAKE_EMAIL_ADAPTER_VERSION,
    manifest: FAKE_EMAIL_SETUP_MANIFEST,
    async checkReadiness(raw: ProviderReadinessInput): Promise<ProviderReadinessAdapterObservation> {
      const input = providerReadinessInputSchema.parse(raw);
      if (
        input.adapterKey !== FAKE_EMAIL_ADAPTER_KEY
        || input.adapterVersion !== FAKE_EMAIL_ADAPTER_VERSION
        || input.manifestKey !== FAKE_EMAIL_SETUP_MANIFEST.manifestKey
        || input.manifestVersion !== FAKE_EMAIL_SETUP_MANIFEST.manifestVersion
        || input.manifestDigestSha256 !== FAKE_EMAIL_SETUP_MANIFEST.manifestDigestSha256
      ) throw new TypeError('fake readiness input does not cite the exact adapter manifest');
      if (input.capability === 'inbound_replies') {
        return providerReadinessAdapterObservationSchema.parse({
          contractVersion: 1,
          kind: 'known_failed',
          code: 'readiness.inbound_not_enabled',
          evidence: evidence('readiness.inbound_not_enabled', 'fake_inbound_not_enabled')
        });
      }
      const scenario = input.externalCheckKey;
      try {
        if (scenario === FAKE_PROVIDER_SCENARIO_KEYS.readiness.thrown) {
          throw new FakeProviderBoundaryFailure('after_capture');
        }
        switch (scenario) {
          case FAKE_PROVIDER_SCENARIO_KEYS.readiness.ready:
            return providerReadinessAdapterObservationSchema.parse({ contractVersion: 1, kind: 'passed', readiness: 'ready', validUntil: input.requestedValidUntil, evidence: evidence('readiness.ready', scenario) });
          case FAKE_PROVIDER_SCENARIO_KEYS.readiness.degraded:
            return providerReadinessAdapterObservationSchema.parse({ contractVersion: 1, kind: 'passed', readiness: 'degraded', validUntil: input.requestedValidUntil, evidence: evidence('readiness.degraded', scenario) });
          case FAKE_PROVIDER_SCENARIO_KEYS.readiness.knownFailed:
            return providerReadinessAdapterObservationSchema.parse({ contractVersion: 1, kind: 'known_failed', code: 'readiness.known_failed', evidence: evidence('readiness.known_failed', scenario) });
          case FAKE_PROVIDER_SCENARIO_KEYS.readiness.timeout:
            return providerReadinessAdapterObservationSchema.parse({ contractVersion: 1, kind: 'acceptance_unknown', reason: 'timeout', evidence: evidence('readiness.acceptance_unknown', scenario) });
          case FAKE_PROVIDER_SCENARIO_KEYS.readiness.connectionLost:
            return providerReadinessAdapterObservationSchema.parse({ contractVersion: 1, kind: 'acceptance_unknown', reason: 'connection_lost', evidence: evidence('readiness.acceptance_unknown', scenario) });
          default:
            return providerReadinessAdapterObservationSchema.parse({ contractVersion: 1, kind: 'acceptance_unknown', reason: 'malformed_response', evidence: evidence('readiness.acceptance_unknown', scenario === FAKE_PROVIDER_SCENARIO_KEYS.readiness.malformedResponse ? scenario : 'fake_unknown_scenario') });
        }
      } catch (error) {
        if (!(error instanceof FakeProviderBoundaryFailure)) throw error;
        return providerReadinessAdapterObservationSchema.parse({ contractVersion: 1, kind: 'acceptance_unknown', reason: 'connection_lost', evidence: evidence('readiness.acceptance_unknown', scenario) });
      }
    }
  });

  const callbackVerifier = fakeCallbackVerifier();
  const callbackRegistry = createEmailCallbackVerifierRegistry({
    implementations: [callbackVerifier],
    evidence: (code, ingressCorrelationId) => createSafeEvidence(
      FAKE_SAFE_EVIDENCE_CATALOG,
      {
        code,
        correlationId: ingressCorrelationId,
        facts: [enumFact('fake.scenario', code.replaceAll('.', '_'))]
      }
    )
  });

  return Object.freeze({
    delivery,
    diagnostics,
    setup,
    callbackVerifier,
    callbackRegistry,
    capturedOrdinaryRequests: () => Object.freeze([...capturedOrdinary]),
    capturedDiagnosticRequests: () => Object.freeze([...capturedDiagnostic])
  });
}

export type FakeCallbackFixtureInput = Readonly<{
  providerConnectionId: string;
  ingressCorrelationId: string;
  providerEventId: string;
  normalizedEvidenceClass: 'delivered' | 'delayed' | 'bounced' | 'complained' | 'suppressed';
  signatureTimestamp: number;
  replayWindowExpiresAt: number;
  verifiedAt: number;
  providerOccurredAt?: number;
  identity:
    | Readonly<{ kind: 'external_delivery_key_only'; externalDeliveryKey: string }>
    | Readonly<{ kind: 'provider_message_id_only'; providerMessageId: string }>
    | Readonly<{ kind: 'both'; providerMessageId: string; externalDeliveryKey: string }>;
  acceptedVerifierRevisionIds: readonly string[];
}>;

/** Produces a bounded fake signature fixture; it is delivery evidence, never inbound mail. */
export function createFakeProviderCallbackFixture(
  input: FakeCallbackFixtureInput
): RawProviderCallback {
  const payload = {
    providerEventId: input.providerEventId,
    normalizedEvidenceClass: input.normalizedEvidenceClass,
    signatureTimestamp: input.signatureTimestamp,
    replayWindowExpiresAt: input.replayWindowExpiresAt,
    verifiedAt: input.verifiedAt,
    ...(input.providerOccurredAt === undefined ? {} : { providerOccurredAt: input.providerOccurredAt }),
    normalizedIdentityShape: input.identity.kind,
    ...(input.identity.kind === 'external_delivery_key_only'
      ? { externalDeliveryKey: input.identity.externalDeliveryKey }
      : input.identity.kind === 'provider_message_id_only'
        ? { providerMessageId: input.identity.providerMessageId }
        : {
            providerMessageId: input.identity.providerMessageId,
            externalDeliveryKey: input.identity.externalDeliveryKey
          })
  };
  const rawPayloadBytes = new TextEncoder().encode(canonicalJsonText(payload));
  const acceptedVerifierRevisionIds = [...input.acceptedVerifierRevisionIds].sort();
  if (new Set(acceptedVerifierRevisionIds).size !== acceptedVerifierRevisionIds.length) {
    throw new TypeError('fake callback verifier revision IDs must be unique');
  }
  const signatureEnvelopeBytes = new TextEncoder().encode(canonicalJsonText({
    contractVersion: 1,
    acceptedVerifierRevisionIds
  }));
  return validateRawProviderCallback(Object.freeze({
    contractVersion: 1,
    providerConnectionId: input.providerConnectionId,
    ingressCorrelationId: input.ingressCorrelationId,
    payloadDigestSha256: bytesToHex(sha256(rawPayloadBytes)),
    payloadByteLength: rawPayloadBytes.byteLength,
    rawPayloadBytes,
    signatureEnvelopeBytes
  }));
}

export function createFakeEmailEnvelope(input: Readonly<{
  from: string;
  to: string;
  subject?: string;
  textBody?: string;
}>): ImmutableEmailEnvelope {
  const envelope = Object.freeze({
    contractVersion: 1 as const,
    from: Object.freeze({ address: input.from as ImmutableEmailEnvelope['from']['address'] }),
    to: Object.freeze({ address: input.to as ImmutableEmailEnvelope['to']['address'] }),
    subject: input.subject ?? 'JooEvents provider contract fixture',
    textBody: input.textBody ?? 'Deterministic provider contract fixture.',
    headers: Object.freeze([])
  });
  computeReviewedEmailEnvelopeDigestSha256(envelope);
  return envelope;
}

export function createFakeOrdinarySubmission(input: Readonly<{
  scenario: string;
  envelope: ImmutableEmailEnvelope;
}>): ImmutableEmailSubmission {
  return Object.freeze({
    contractVersion: 1,
    deliveryAttemptId: `attempt_${digest(input.scenario).slice(0, 16)}`,
    providerConnectionRevisionId: 'connection_revision_fake_v1',
    externalDeliveryKey: input.scenario,
    senderProfileRevisionId: 'sender_revision_fake_v1',
    senderPresentationContractKey: 'fake.sender.presentation',
    senderPresentationContractVersion: 1,
    senderPresentationDigestSha256: digest({ sender: 'fake' }),
    channelAddressId: 'channel_address_fake_v1',
    channelAddressVersion: 1,
    addressLookupFingerprintProfile: 'fake.address.fingerprint',
    addressLookupFingerprintVersion: 1,
    addressLookupFingerprintSha256: digest({ address: input.envelope.to.address }),
    reviewedEnvelopeDigestSha256: computeReviewedEmailEnvelopeDigestSha256(input.envelope),
    envelope: input.envelope
  });
}

export function createFakeDiagnosticSubmission(input: Readonly<{
  scenario: string;
  envelope: ImmutableEmailEnvelope;
}>): ImmutableEmailDiagnosticSubmission {
  return Object.freeze({
    contractVersion: 1,
    diagnosticAttemptId: `diagnostic_${digest(input.scenario).slice(0, 16)}`,
    providerConnectionRevisionId: 'connection_revision_fake_v1',
    externalDiagnosticKey: input.scenario,
    fixtureKey: 'fake.diagnostic.fixture',
    fixtureVersion: 1,
    senderProfileRevisionId: 'sender_revision_fake_v1',
    senderPresentationContractKey: 'fake.sender.presentation',
    senderPresentationContractVersion: 1,
    senderPresentationDigestSha256: digest({ sender: 'fake' }),
    recipientFingerprintProfile: 'fake.diagnostic.recipient',
    recipientFingerprintVersion: 1,
    recipientFingerprintSha256: digest({ address: input.envelope.to.address }),
    reviewedEnvelopeDigestSha256: computeReviewedEmailEnvelopeDigestSha256(input.envelope),
    validUntil: 1_900_000_000_000,
    maximumCostMinorUnits: 100,
    currency: 'USD',
    envelope: input.envelope
  });
}
