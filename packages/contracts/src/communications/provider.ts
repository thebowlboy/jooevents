import { encodeCanonicalJson } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const providerMessageIdPattern = /^[\x21-\x7e]{1,512}$/;
const correlationIdPattern = /^corr1_[A-Za-z0-9_-]{8,160}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const callbackPathPattern = /^\/webhooks\/(?:[A-Za-z0-9._~-]+\/?)+$/;

export const providerContractVersionSchema = z.literal(1);
export const providerStableKeySchema = z.string().min(1).max(160).regex(stableKeyPattern);
export const providerOpaqueIdSchema = z.string().min(1).max(256).regex(opaqueIdPattern);
export const providerMessageIdSchema = z.string()
  .min(1)
  .max(512)
  .regex(providerMessageIdPattern);
export const providerCorrelationIdSchema = z.string()
  .min(14)
  .max(166)
  .regex(correlationIdPattern);
export const providerSha256Schema = z.string().regex(sha256Pattern);
export const providerPositiveVersionSchema = z.number().int().positive().safe();
export const providerTimestampSchema = z.number().int().nonnegative().safe();

export const registeredSafeEvidenceCodeSchema = providerStableKeySchema.brand<
  'RegisteredSafeEvidenceCode'
>();
export const registeredSafeEvidenceFactKeySchema = providerStableKeySchema.brand<
  'RegisteredSafeEvidenceFactKey'
>();
export const registeredSafeEvidenceEnumValueSchema = providerStableKeySchema.brand<
  'RegisteredSafeEvidenceEnumValue'
>();

const safeEvidenceFactBase = {
  factKey: registeredSafeEvidenceFactKeySchema,
  factSchemaVersion: providerPositiveVersionSchema
} as const;

export const registeredSafeEvidenceFactSchema = z.discriminatedUnion('valueKind', [
  z.strictObject({
    ...safeEvidenceFactBase,
    valueKind: z.literal('enum'),
    enumValue: registeredSafeEvidenceEnumValueSchema
  }),
  z.strictObject({
    ...safeEvidenceFactBase,
    valueKind: z.literal('integer'),
    integerValue: z.number().int().safe()
  }),
  z.strictObject({
    ...safeEvidenceFactBase,
    valueKind: z.literal('boolean'),
    booleanValue: z.boolean()
  })
]);

type SafeEvidenceDigestInput = Readonly<{
  contractVersion: 1;
  schemaKey: 'je.communication.provider-safe-evidence';
  schemaVersion: 1;
  registeredCode: z.infer<typeof registeredSafeEvidenceCodeSchema>;
  correlationId: string;
  registeredFacts: ReadonlyArray<z.infer<typeof registeredSafeEvidenceFactSchema>>;
}>;

function digestCanonicalValue(value: unknown): string {
  return bytesToHex(sha256(encodeCanonicalJson(value)));
}

/** Computes the canonical digest embedded in a provider-safe evidence envelope. */
export function computeSafeEvidenceDigestSha256(input: SafeEvidenceDigestInput): string {
  return digestCanonicalValue(input);
}

function addSafeEvidenceIssues(
  evidence: SafeEvidenceDigestInput & { readonly canonicalDigestSha256: string },
  context: z.core.$RefinementCtx
): void {
  for (const [index, fact] of evidence.registeredFacts.entries()) {
    const previous = evidence.registeredFacts[index - 1];
    if (previous !== undefined && previous.factKey >= fact.factKey) {
      context.addIssue({
        code: 'custom',
        path: ['registeredFacts', index, 'factKey'],
        message: 'safe evidence facts must use unique canonical fact-key order'
      });
    }
  }
  const { canonicalDigestSha256: _digest, ...digestInput } = evidence;
  if (computeSafeEvidenceDigestSha256(digestInput) !== evidence.canonicalDigestSha256) {
    context.addIssue({
      code: 'custom',
      path: ['canonicalDigestSha256'],
      message: 'safe evidence digest does not match its canonical content'
    });
  }
}

export const safeEvidenceSchema = z.strictObject({
  contractVersion: providerContractVersionSchema,
  schemaKey: z.literal('je.communication.provider-safe-evidence'),
  schemaVersion: z.literal(1),
  registeredCode: registeredSafeEvidenceCodeSchema,
  correlationId: providerCorrelationIdSchema,
  canonicalDigestSha256: providerSha256Schema,
  registeredFacts: z.array(registeredSafeEvidenceFactSchema).max(32)
}).superRefine(addSafeEvidenceIssues);

export type RegisteredSafeEvidenceCode = z.infer<typeof registeredSafeEvidenceCodeSchema>;
export type RegisteredSafeEvidenceFactKey = z.infer<
  typeof registeredSafeEvidenceFactKeySchema
>;
export type RegisteredSafeEvidenceEnumValue = z.infer<
  typeof registeredSafeEvidenceEnumValueSchema
>;
export type RegisteredSafeEvidenceFact = z.infer<typeof registeredSafeEvidenceFactSchema>;
export type SafeEvidence = z.infer<typeof safeEvidenceSchema>;

export type ProviderOutcomeV1<Branch> = Readonly<{ contractVersion: 1 }> & Branch;

export const providerIdempotencyCapabilitySchema = z.enum([
  'native_key',
  'provider_lookup',
  'none'
]);
export const providerReconciliationCapabilitySchema = z.enum([
  'lookup',
  'callback_only',
  'none'
]);
export const providerCallbackWireCapabilitySchema = z.enum([
  'delivered',
  'delay',
  'bounce',
  'complaint',
  'suppression'
]);

const callbackCapabilityOrder = new Map(
  providerCallbackWireCapabilitySchema.options.map((value, index) => [value, index])
);

export const providerCapabilitiesSchema = z.strictObject({
  idempotency: providerIdempotencyCapabilitySchema,
  reconciliation: providerReconciliationCapabilitySchema,
  callbacks: z.array(providerCallbackWireCapabilitySchema).max(5).superRefine((values, context) => {
    for (const [index, value] of values.entries()) {
      const previous = values[index - 1];
      if (
        previous !== undefined
        && (callbackCapabilityOrder.get(previous) ?? -1) >= (callbackCapabilityOrder.get(value) ?? -1)
      ) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'callback capabilities must be unique and use canonical order'
        });
      }
    }
  }),
  inboundReplies: z.literal(false)
});

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const callbackEvidenceClassSchema = z.enum([
  'delivered',
  'delayed',
  'bounced',
  'complained',
  'suppressed'
]);
export const callbackCorrelationModeSchema = z.enum([
  'stable_external_key_required',
  'provider_message_id_with_lookup',
  'provider_message_id_post_result_only'
]);

export type CallbackEvidenceClass = z.infer<typeof callbackEvidenceClassSchema>;
export type CallbackCorrelationMode = z.infer<typeof callbackCorrelationModeSchema>;

export function normalizeProviderCallbackCapability(
  value: z.infer<typeof providerCallbackWireCapabilitySchema>
): CallbackEvidenceClass {
  switch (value) {
    case 'delivered': return 'delivered';
    case 'delay': return 'delayed';
    case 'bounce': return 'bounced';
    case 'complaint': return 'complained';
    case 'suppression': return 'suppressed';
  }
}

export const callbackObligationContractSchema = z.strictObject({
  key: providerStableKeySchema,
  version: providerPositiveVersionSchema,
  evidenceClasses: z.array(callbackEvidenceClassSchema).min(1).max(5).superRefine(
    (values, context) => {
      for (const [index, value] of values.entries()) {
        const previous = values[index - 1];
        if (previous !== undefined && previous >= value) {
          context.addIssue({
            code: 'custom',
            path: [index],
            message: 'callback evidence classes must be unique and lexically ordered'
          });
        }
      }
    }
  ),
  basis: z.literal('attempt_started_database_time'),
  horizonMs: z.number().int().positive().safe(),
  acceptedA8MaximumMs: z.number().int().positive().safe(),
  correlationMode: callbackCorrelationModeSchema
}).refine(
  (value) => value.horizonMs <= value.acceptedA8MaximumMs,
  { path: ['horizonMs'], message: 'callback horizon exceeds the accepted maximum' }
);

export type CallbackObligationContract = z.infer<typeof callbackObligationContractSchema>;

export const callbackProcessingContractSchema = z.strictObject({
  key: providerStableKeySchema,
  version: providerPositiveVersionSchema,
  backoffProfile: providerStableKeySchema,
  backoffVersion: providerPositiveVersionSchema,
  maxIdentityDependencyDefers: z.number().int().nonnegative().safe(),
  maxIdentityDependencyAgeMs: z.number().int().positive().safe()
});

export const callbackVerifierDraftChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ contractVersion: providerContractVersionSchema, kind: z.literal('disabled') }),
  z.strictObject({
    contractVersion: providerContractVersionSchema,
    kind: z.literal('reuse_exact_revision'),
    callbackVerifierRevisionId: providerOpaqueIdSchema,
    configDigestSha256: providerSha256Schema
  }),
  z.strictObject({
    contractVersion: providerContractVersionSchema,
    kind: z.literal('create'),
    verifierKey: providerStableKeySchema,
    verifierVersion: providerStableKeySchema,
    verificationContractVersion: providerPositiveVersionSchema,
    keyIdMode: z.enum(['required', 'optional', 'absent']),
    nonsecretConfigPayloadRefId: providerOpaqueIdSchema,
    secretStoreKey: providerStableKeySchema,
    secretBundleReference: providerOpaqueIdSchema,
    configDigestSha256: providerSha256Schema
  })
]);

export const callbackDraftConfigurationSchema = z.union([
  z.strictObject({
    contractVersion: providerContractVersionSchema,
    verifier: z.strictObject({
      contractVersion: providerContractVersionSchema,
      kind: z.literal('disabled')
    }),
    obligationContract: z.null()
  }),
  z.strictObject({
    contractVersion: providerContractVersionSchema,
    verifier: z.union([
      z.strictObject({
        contractVersion: providerContractVersionSchema,
        kind: z.literal('reuse_exact_revision'),
        callbackVerifierRevisionId: providerOpaqueIdSchema,
        configDigestSha256: providerSha256Schema
      }),
      z.strictObject({
        contractVersion: providerContractVersionSchema,
        kind: z.literal('create'),
        verifierKey: providerStableKeySchema,
        verifierVersion: providerStableKeySchema,
        verificationContractVersion: providerPositiveVersionSchema,
        keyIdMode: z.enum(['required', 'optional', 'absent']),
        nonsecretConfigPayloadRefId: providerOpaqueIdSchema,
        secretStoreKey: providerStableKeySchema,
        secretBundleReference: providerOpaqueIdSchema,
        configDigestSha256: providerSha256Schema
      })
    ]),
    obligationContract: z.strictObject({
      key: providerStableKeySchema,
      version: providerPositiveVersionSchema
    })
  })
]);

export type CallbackProcessingContract = z.infer<typeof callbackProcessingContractSchema>;
export type CallbackVerifierDraftChoice = z.infer<typeof callbackVerifierDraftChoiceSchema>;
export type CallbackDraftConfiguration = z.infer<typeof callbackDraftConfigurationSchema>;

const providerOutcomeBase = {
  contractVersion: providerContractVersionSchema
} as const;

function addOutcomeCodeIssue(
  value: { readonly code: RegisteredSafeEvidenceCode; readonly evidence: SafeEvidence },
  context: z.core.$RefinementCtx
): void {
  if (value.code !== value.evidence.registeredCode) {
    context.addIssue({
      code: 'custom',
      path: ['code'],
      message: 'outcome code must match the safe evidence code'
    });
  }
}

export const providerUnknownReasonSchema = z.enum([
  'timeout',
  'connection_lost',
  'malformed_response'
]);

export const providerReadinessCapabilitySchema = z.enum([
  'transactional_outbound',
  'delivery_callbacks',
  'suppression_callbacks',
  'inbound_replies'
]);

export const providerReadinessInputSchema = z.strictObject({
  contractVersion: providerContractVersionSchema,
  connectionId: providerOpaqueIdSchema,
  connectionRevisionId: providerOpaqueIdSchema,
  connectionConfigDigestSha256: providerSha256Schema,
  capability: providerReadinessCapabilitySchema,
  readinessCheckId: providerOpaqueIdSchema,
  checkKey: providerStableKeySchema,
  manifestKey: providerStableKeySchema,
  manifestVersion: providerPositiveVersionSchema,
  manifestDigestSha256: providerSha256Schema,
  adapterKey: providerStableKeySchema,
  adapterVersion: providerStableKeySchema,
  externalCheckKey: providerOpaqueIdSchema,
  requestDigestSha256: providerSha256Schema,
  requestedValidUntil: providerTimestampSchema,
  observationSchemaVersion: providerPositiveVersionSchema,
  normalizerVersion: providerPositiveVersionSchema
});

const providerReadinessBranches = [
  z.strictObject({
    ...providerOutcomeBase,
    kind: z.literal('passed'),
    readiness: z.enum(['ready', 'degraded']),
    validUntil: providerTimestampSchema,
    evidence: safeEvidenceSchema
  }),
  z.strictObject({
    ...providerOutcomeBase,
    kind: z.literal('known_failed'),
    code: registeredSafeEvidenceCodeSchema,
    evidence: safeEvidenceSchema
  }).superRefine(addOutcomeCodeIssue),
  z.strictObject({
    ...providerOutcomeBase,
    kind: z.literal('acceptance_unknown'),
    reason: providerUnknownReasonSchema,
    evidence: safeEvidenceSchema
  }),
  z.strictObject({
    ...providerOutcomeBase,
    kind: z.literal('not_submitted'),
    reason: z.enum(['policy_refused', 'control_changed', 'readiness_changed']),
    evidence: safeEvidenceSchema
  })
] as const;

export const providerReadinessObservationSchema = z.discriminatedUnion(
  'kind',
  providerReadinessBranches
);
export const providerReadinessAdapterObservationSchema = z.discriminatedUnion('kind', [
  providerReadinessBranches[0],
  providerReadinessBranches[1],
  providerReadinessBranches[2]
]);

export type ProviderReadinessInput = z.infer<typeof providerReadinessInputSchema>;
export type ProviderReadinessObservation = z.infer<typeof providerReadinessObservationSchema>;
export type ProviderReadinessAdapterObservation = z.infer<
  typeof providerReadinessAdapterObservationSchema
>;

const acceptedSubmissionSchema = z.strictObject({
  ...providerOutcomeBase,
  kind: z.literal('accepted'),
  providerMessageId: providerMessageIdSchema.optional(),
  evidence: safeEvidenceSchema
});
const knownRejectedSubmissionSchema = z.strictObject({
  ...providerOutcomeBase,
  kind: z.literal('known_rejected'),
  retryClass: z.enum(['safe_retryable', 'terminal']),
  code: registeredSafeEvidenceCodeSchema,
  evidence: safeEvidenceSchema
}).superRefine(addOutcomeCodeIssue);
const unknownSubmissionSchema = z.strictObject({
  ...providerOutcomeBase,
  kind: z.literal('acceptance_unknown'),
  reason: providerUnknownReasonSchema,
  evidence: safeEvidenceSchema
});

export const providerSubmissionOutcomeSchema = z.discriminatedUnion('kind', [
  acceptedSubmissionSchema,
  knownRejectedSubmissionSchema,
  unknownSubmissionSchema
]);

export const providerLookupInputSchema = z.strictObject({
  contractVersion: providerContractVersionSchema,
  deliveryAttemptId: providerOpaqueIdSchema,
  providerConnectionRevisionId: providerOpaqueIdSchema,
  adapterKey: providerStableKeySchema,
  adapterVersion: providerStableKeySchema,
  externalDeliveryKey: providerOpaqueIdSchema,
  lookupContractKey: providerStableKeySchema,
  lookupContractVersion: providerPositiveVersionSchema,
  providerRequestDigestSha256: providerSha256Schema,
  frozenCallbackCorrelationMode: callbackCorrelationModeSchema.nullable()
});

export const providerLookupOutcomeSchema = z.discriminatedUnion('kind', [
  acceptedSubmissionSchema,
  knownRejectedSubmissionSchema,
  z.strictObject({
    ...providerOutcomeBase,
    kind: z.literal('not_found'),
    evidence: safeEvidenceSchema
  }),
  z.strictObject({
    ...providerOutcomeBase,
    kind: z.literal('indeterminate'),
    reason: z.enum([
      'timeout',
      'connection_lost',
      'malformed_response',
      'conflicting_evidence'
    ]),
    evidence: safeEvidenceSchema
  })
]);

export type ProviderSubmissionOutcome = z.infer<typeof providerSubmissionOutcomeSchema>;
export type ProviderLookupInput = z.infer<typeof providerLookupInputSchema>;
export type ProviderLookupOutcome = z.infer<typeof providerLookupOutcomeSchema>;

export const normalizedCostSchema = z.strictObject({
  minorUnits: z.number().int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/)
});

const diagnosticAcceptedSubmissionSchema = z.strictObject({
  ...providerOutcomeBase,
  kind: z.literal('accepted'),
  providerMessageId: providerMessageIdSchema.optional(),
  evidence: safeEvidenceSchema,
  cost: normalizedCostSchema.optional()
});
const diagnosticSafeRetryableSchema = z.strictObject({
  ...providerOutcomeBase,
  kind: z.literal('known_rejected_safe_retryable'),
  code: registeredSafeEvidenceCodeSchema,
  evidence: safeEvidenceSchema
}).superRefine(addOutcomeCodeIssue);
const diagnosticTerminalSchema = z.strictObject({
  ...providerOutcomeBase,
  kind: z.literal('known_rejected_terminal'),
  code: registeredSafeEvidenceCodeSchema,
  evidence: safeEvidenceSchema
}).superRefine(addOutcomeCodeIssue);

export const emailDiagnosticSubmissionOutcomeSchema = z.discriminatedUnion('kind', [
  diagnosticAcceptedSubmissionSchema,
  diagnosticSafeRetryableSchema,
  diagnosticTerminalSchema,
  unknownSubmissionSchema
]);

export const emailDiagnosticLookupInputSchema = z.strictObject({
  contractVersion: providerContractVersionSchema,
  diagnosticAttemptId: providerOpaqueIdSchema,
  providerConnectionRevisionId: providerOpaqueIdSchema,
  adapterKey: providerStableKeySchema,
  adapterVersion: providerStableKeySchema,
  externalDiagnosticKey: providerOpaqueIdSchema,
  lookupContractKey: providerStableKeySchema,
  lookupContractVersion: providerPositiveVersionSchema,
  providerRequestDigestSha256: providerSha256Schema,
  frozenCallbackCorrelationMode: callbackCorrelationModeSchema.nullable()
});

export const emailDiagnosticLookupOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...providerOutcomeBase,
    kind: z.literal('accepted'),
    providerMessageId: providerMessageIdSchema,
    evidence: safeEvidenceSchema
  }),
  diagnosticSafeRetryableSchema,
  diagnosticTerminalSchema,
  z.strictObject({
    ...providerOutcomeBase,
    kind: z.literal('not_found'),
    evidence: safeEvidenceSchema
  }),
  z.strictObject({
    ...providerOutcomeBase,
    kind: z.literal('indeterminate'),
    reason: z.enum([
      'timeout',
      'connection_lost',
      'malformed_response',
      'conflicting_evidence'
    ]),
    evidence: safeEvidenceSchema
  })
]);

export type NormalizedCost = z.infer<typeof normalizedCostSchema>;
export type EmailDiagnosticSubmissionOutcome = z.infer<
  typeof emailDiagnosticSubmissionOutcomeSchema
>;
export type EmailDiagnosticLookupInput = z.infer<typeof emailDiagnosticLookupInputSchema>;
export type EmailDiagnosticLookupOutcome = z.infer<typeof emailDiagnosticLookupOutcomeSchema>;
export type EmailDiagnosticAttemptOutcomeKey =
  | 'accepted'
  | 'known_rejected_safe_retryable'
  | 'known_rejected_terminal'
  | 'not_submitted_control_changed'
  | 'not_submitted_policy_refused'
  | 'acceptance_unknown';

const normalizedCallbackBase = {
  contractVersion: providerContractVersionSchema,
  schemaKey: z.literal('je.communication.verified-provider-callback'),
  schemaVersion: providerPositiveVersionSchema,
  normalizerKey: z.literal('je.communication.provider-callback-normalizer'),
  normalizerVersion: providerPositiveVersionSchema,
  providerConnectionId: providerOpaqueIdSchema,
  providerEventId: providerOpaqueIdSchema,
  payloadDigestSha256: providerSha256Schema,
  normalizedEvidenceClass: callbackEvidenceClassSchema,
  signatureTimestamp: providerTimestampSchema,
  replayWindowExpiresAt: providerTimestampSchema,
  verifiedAt: providerTimestampSchema,
  providerOccurredAt: providerTimestampSchema.optional()
} as const;

const verifiedProviderCallbackUndigestedSchema = z.discriminatedUnion(
  'normalizedIdentityShape',
  [
    z.strictObject({
      ...normalizedCallbackBase,
      normalizedIdentityShape: z.literal('external_delivery_key_only'),
      externalDeliveryKey: providerOpaqueIdSchema
    }),
    z.strictObject({
      ...normalizedCallbackBase,
      normalizedIdentityShape: z.literal('provider_message_id_only'),
      providerMessageId: providerMessageIdSchema
    }),
    z.strictObject({
      ...normalizedCallbackBase,
      normalizedIdentityShape: z.literal('both'),
      providerMessageId: providerMessageIdSchema,
      externalDeliveryKey: providerOpaqueIdSchema
    })
  ]
);

export const verifiedProviderCallbackSchema = z.intersection(
  verifiedProviderCallbackUndigestedSchema,
  z.object({ canonicalDigestSha256: providerSha256Schema })
).superRefine((value, context) => {
  const { canonicalDigestSha256, ...body } = value;
  if (digestCanonicalValue(body) !== canonicalDigestSha256) {
    context.addIssue({
      code: 'custom',
      path: ['canonicalDigestSha256'],
      message: 'verified callback digest does not match its canonical content'
    });
  }
  if (value.replayWindowExpiresAt <= value.signatureTimestamp) {
    context.addIssue({
      code: 'custom',
      path: ['replayWindowExpiresAt'],
      message: 'callback replay window must end after its signature timestamp'
    });
  }
});

export type VerifiedProviderCallback = z.infer<typeof verifiedProviderCallbackSchema>;

/** Adds the canonical digest to a normalized callback and validates the closed shape. */
export function finalizeVerifiedProviderCallback(
  callback: z.input<typeof verifiedProviderCallbackUndigestedSchema>
): VerifiedProviderCallback {
  const parsed = verifiedProviderCallbackUndigestedSchema.parse(callback);
  return verifiedProviderCallbackSchema.parse({
    ...parsed,
    canonicalDigestSha256: digestCanonicalValue(parsed)
  });
}

export const setupCapabilityStateSchema = z.strictObject({
  transactional_outbound: z.literal('supported'),
  delivery_callbacks: z.enum(['supported', 'not_supported']),
  suppression_callbacks: z.enum(['supported', 'not_supported']),
  inbound_replies: z.literal('not_enabled')
});

const setupNonSecretFieldSchema = z.discriminatedUnion('valueKind', [
  z.strictObject({
    key: providerStableKeySchema,
    label: z.string().min(1).max(120),
    valueKind: z.enum(['text', 'email', 'url', 'boolean']),
    required: z.boolean()
  }),
  z.strictObject({
    key: providerStableKeySchema,
    label: z.string().min(1).max(120),
    valueKind: z.literal('enum'),
    required: z.boolean(),
    allowedValues: z.array(providerStableKeySchema).min(1).max(32)
  })
]);

const setupSecretReferenceSchema = z.strictObject({
  key: providerStableKeySchema,
  label: z.string().min(1).max(120),
  required: z.boolean()
});

const officialSetupLinkSchema = z.strictObject({
  key: providerStableKeySchema,
  label: z.string().min(1).max(120),
  href: z.url().refine((value) => new URL(value).protocol === 'https:', {
    message: 'provider setup links must use HTTPS'
  })
});

const setupHumanStepSchema = z.strictObject({
  key: providerStableKeySchema,
  title: z.string().min(1).max(160),
  instruction: z.string().min(1).max(800),
  officialLinkKey: providerStableKeySchema.optional()
});

const setupReadinessCheckSchema = z.strictObject({
  key: providerStableKeySchema,
  capability: z.enum([
    'transactional_outbound',
    'delivery_callbacks',
    'suppression_callbacks'
  ]),
  externalCheckKey: providerStableKeySchema,
  observationSchemaVersion: providerPositiveVersionSchema,
  normalizerVersion: providerPositiveVersionSchema,
  maximumValidityMs: z.number().int().positive().safe(),
  observableClaimKeys: z.array(providerStableKeySchema).min(1).max(16)
});

const senderRequirementsSchema = z.strictObject({
  verifiedDomainRequired: z.boolean(),
  verifiedFromAddressRequired: z.boolean(),
  replyToMode: z.enum(['optional', 'required', 'not_supported']),
  envelopeFromMode: z.enum(['adapter_managed', 'configured', 'not_supported'])
});

const callbackSetupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('disabled') }),
  z.strictObject({
    kind: z.literal('enabled'),
    callbackEndpointPath: z.string().max(240).regex(callbackPathPattern),
    signatureSchemeKey: providerStableKeySchema,
    verifierKey: providerStableKeySchema,
    verifierVersion: providerStableKeySchema,
    verificationContractVersion: providerPositiveVersionSchema,
    keyIdMode: z.enum(['required', 'optional', 'absent']),
    obligationContract: callbackObligationContractSchema
  })
]);

const diagnosticSetupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not_supported') }),
  z.strictObject({
    kind: z.literal('supported'),
    fixtureKey: providerStableKeySchema,
    fixtureVersion: providerPositiveVersionSchema,
    maximumCostMinorUnits: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/)
  })
]);

const setupManifestWithoutDigestSchema = z.strictObject({
  contractVersion: providerContractVersionSchema,
  schemaKey: z.literal('je.communication.email-setup-manifest'),
  schemaVersion: z.literal(1),
  manifestKey: providerStableKeySchema,
  manifestVersion: providerPositiveVersionSchema,
  adapterKey: providerStableKeySchema,
  adapterVersion: providerStableKeySchema,
  capabilities: providerCapabilitiesSchema,
  capabilityStatus: setupCapabilityStateSchema,
  nonSecretFields: z.array(setupNonSecretFieldSchema).max(32),
  requiredSecretReferences: z.array(setupSecretReferenceSchema).max(16),
  officialLinks: z.array(officialSetupLinkSchema).max(16),
  humanSteps: z.array(setupHumanStepSchema).max(32),
  readinessChecks: z.array(setupReadinessCheckSchema).min(1).max(32),
  senderRequirements: senderRequirementsSchema,
  callbacks: callbackSetupSchema,
  diagnostics: diagnosticSetupSchema
});

function requireUniqueCanonicalKeys(
  values: readonly { readonly key: string }[],
  path: string,
  context: z.core.$RefinementCtx
): void {
  for (const [index, value] of values.entries()) {
    const previous = values[index - 1];
    if (previous !== undefined && previous.key >= value.key) {
      context.addIssue({
        code: 'custom',
        path: [path, index, 'key'],
        message: `${path} must use unique canonical key order`
      });
    }
  }
}

function addSetupManifestIssues(
  manifest: z.infer<typeof setupManifestWithoutDigestSchema>,
  context: z.core.$RefinementCtx
): void {
  requireUniqueCanonicalKeys(manifest.nonSecretFields, 'nonSecretFields', context);
  requireUniqueCanonicalKeys(
    manifest.requiredSecretReferences,
    'requiredSecretReferences',
    context
  );
  requireUniqueCanonicalKeys(manifest.officialLinks, 'officialLinks', context);
  requireUniqueCanonicalKeys(manifest.humanSteps, 'humanSteps', context);
  requireUniqueCanonicalKeys(manifest.readinessChecks, 'readinessChecks', context);

  const officialLinkKeys = new Set(manifest.officialLinks.map((link) => link.key));
  for (const [index, field] of manifest.nonSecretFields.entries()) {
    if (field.valueKind !== 'enum') continue;
    for (const [valueIndex, value] of field.allowedValues.entries()) {
      const previous = field.allowedValues[valueIndex - 1];
      if (previous !== undefined && previous >= value) {
        context.addIssue({
          code: 'custom',
          path: ['nonSecretFields', index, 'allowedValues', valueIndex],
          message: 'enum field values must be unique and use canonical order'
        });
      }
    }
  }
  for (const [index, step] of manifest.humanSteps.entries()) {
    if (step.officialLinkKey !== undefined && !officialLinkKeys.has(step.officialLinkKey)) {
      context.addIssue({
        code: 'custom',
        path: ['humanSteps', index, 'officialLinkKey'],
        message: 'setup step references an undeclared official link'
      });
    }
  }
  for (const [index, check] of manifest.readinessChecks.entries()) {
    for (const [claimIndex, claim] of check.observableClaimKeys.entries()) {
      const previous = check.observableClaimKeys[claimIndex - 1];
      if (previous !== undefined && previous >= claim) {
        context.addIssue({
          code: 'custom',
          path: ['readinessChecks', index, 'observableClaimKeys', claimIndex],
          message: 'observable claims must be unique and use canonical order'
        });
      }
    }
    if (check.capability !== 'transactional_outbound') {
      const status = manifest.capabilityStatus[check.capability];
      if (status !== 'supported') {
        context.addIssue({
          code: 'custom',
          path: ['readinessChecks', index, 'capability'],
          message: 'readiness check targets an undeclared capability'
        });
      }
    }
  }

  const normalizedCallbackClasses = manifest.capabilities.callbacks.map(
    normalizeProviderCallbackCapability
  );
  if (manifest.callbacks.kind === 'disabled' && normalizedCallbackClasses.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['callbacks'],
      message: 'callback-capable adapters must declare their verifier contract'
    });
  }
  if (manifest.callbacks.kind === 'enabled') {
    const declared = new Set(normalizedCallbackClasses);
    const obligated = new Set(manifest.callbacks.obligationContract.evidenceClasses);
    if (
      declared.size !== obligated.size
      || [...declared].some((value) => !obligated.has(value))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['callbacks', 'obligationContract', 'evidenceClasses'],
        message: 'callback obligation classes must exactly match adapter capabilities'
      });
    }
    const correlationMode = manifest.callbacks.obligationContract.correlationMode;
    if (
      correlationMode === 'provider_message_id_with_lookup'
      && manifest.capabilities.reconciliation !== 'lookup'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['callbacks', 'obligationContract', 'correlationMode'],
        message: 'provider-message-id lookup correlation requires lookup reconciliation'
      });
    }
    if (
      correlationMode === 'provider_message_id_post_result_only'
      && manifest.capabilities.reconciliation === 'callback_only'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities', 'reconciliation'],
        message: 'post-result-only callback correlation is not callback-only recovery'
      });
    }
  } else if (manifest.capabilities.reconciliation === 'callback_only') {
    context.addIssue({
      code: 'custom',
      path: ['capabilities', 'reconciliation'],
      message: 'callback-only reconciliation requires enabled callbacks'
    });
  }
  const hasSuppression = manifest.capabilities.callbacks.includes('suppression');
  if (hasSuppression !== (manifest.capabilityStatus.suppression_callbacks === 'supported')) {
    context.addIssue({
      code: 'custom',
      path: ['capabilityStatus', 'suppression_callbacks'],
      message: 'suppression readiness must match callback capability support'
    });
  }
  const hasDeliveryCallback = manifest.capabilities.callbacks.some(
    (value) => value !== 'suppression'
  );
  if (hasDeliveryCallback !== (manifest.capabilityStatus.delivery_callbacks === 'supported')) {
    context.addIssue({
      code: 'custom',
      path: ['capabilityStatus', 'delivery_callbacks'],
      message: 'delivery callback readiness must match callback capability support'
    });
  }
}

const refinedSetupManifestWithoutDigestSchema = setupManifestWithoutDigestSchema.superRefine(
  addSetupManifestIssues
);

export const emailSetupManifestSchema = setupManifestWithoutDigestSchema.extend({
  manifestDigestSha256: providerSha256Schema
}).superRefine((manifest, context) => {
  addSetupManifestIssues(manifest, context);
  const { manifestDigestSha256, ...body } = manifest;
  if (digestCanonicalValue(body) !== manifestDigestSha256) {
    context.addIssue({
      code: 'custom',
      path: ['manifestDigestSha256'],
      message: 'setup manifest digest does not match its canonical content'
    });
  }
});

export type EmailSetupManifest = z.infer<typeof emailSetupManifestSchema>;
export type EmailSetupManifestDraft = z.input<typeof refinedSetupManifestWithoutDigestSchema>;

/** Finalizes the immutable, disclosure-safe setup manifest used by common setup UI. */
export function finalizeEmailSetupManifest(input: EmailSetupManifestDraft): EmailSetupManifest {
  const body = refinedSetupManifestWithoutDigestSchema.parse(input);
  return emailSetupManifestSchema.parse({
    ...body,
    manifestDigestSha256: digestCanonicalValue(body)
  });
}
