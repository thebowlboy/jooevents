import {
  providerSubmissionOutcomeSchema,
  type ProviderCapabilities,
  type ProviderSubmissionOutcome,
  type SafeEvidence
} from '@jooevents/contracts';

export type OutboundEmailDeliveryState =
  | 'pending'
  | 'request_started'
  | 'accepted'
  | 'known_rejected_safe_retryable'
  | 'known_rejected_terminal'
  | 'acceptance_unknown';

export interface OutboundEmailDeliveryHead {
  readonly contractVersion: 1;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly releaseId: string;
  readonly dispatchGeneration: number;
  readonly reviewedMessageDigestSha256: string;
  readonly reviewedEnvelopeDigestSha256: string;
  readonly recipientRefId: string;
  readonly templateRevisionRefId: string;
  readonly contentRefId: string;
  readonly providerConnectionRevisionId: string;
  readonly externalDeliveryKey: string;
  readonly senderProfileRevisionId: string;
  readonly senderPresentationContractKey: string;
  readonly senderPresentationContractVersion: number;
  readonly senderPresentationDigestSha256: string;
  readonly channelAddressId: string;
  readonly channelAddressVersion: number;
  readonly addressLookupFingerprintProfile: string;
  readonly addressLookupFingerprintVersion: number;
  readonly addressLookupFingerprintSha256: string;
  readonly state: OutboundEmailDeliveryState;
  readonly version: number;
  readonly attemptCount: number;
  readonly currentAttemptId: string | null;
}

export interface OutboundEmailDeliveryAttempt {
  readonly contractVersion: 1;
  readonly deliveryId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly state: Exclude<OutboundEmailDeliveryState, 'pending'>;
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly capabilities: ProviderCapabilities;
  readonly providerRequestDigestSha256: string;
  readonly reviewedMessageDigestSha256: string;
  readonly reviewedEnvelopeDigestSha256: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly providerMessageId: string | null;
  readonly providerOutcomeReason: string | null;
  readonly safeEvidence: SafeEvidence | null;
  readonly recoveryCode: 'worker_result_lost' | 'provider_boundary_failure' | null;
}

export type ProviderAttemptResolution = Readonly<{
  state:
    | 'accepted'
    | 'known_rejected_safe_retryable'
    | 'known_rejected_terminal'
    | 'acceptance_unknown';
  providerMessageId: string | null;
  providerOutcomeReason: string | null;
  safeEvidence: SafeEvidence;
}>;

export type OutboundEmailFollowUp =
  | 'complete'
  | 'safe_retry'
  | 'reconcile'
  | 'await_callback'
  | 'manual_resolution_required';

/** Maps the closed provider port outcome into the delivery ledger vocabulary. */
export function normalizeProviderSubmissionOutcome(
  candidate: unknown
): ProviderAttemptResolution {
  const outcome: ProviderSubmissionOutcome = providerSubmissionOutcomeSchema.parse(candidate);
  if (outcome.kind === 'accepted') {
    return Object.freeze({
      state: 'accepted',
      providerMessageId: outcome.providerMessageId ?? null,
      providerOutcomeReason: null,
      safeEvidence: outcome.evidence
    });
  }
  if (outcome.kind === 'known_rejected') {
    return Object.freeze({
      state: outcome.retryClass === 'safe_retryable'
        ? 'known_rejected_safe_retryable'
        : 'known_rejected_terminal',
      providerMessageId: null,
      providerOutcomeReason: outcome.code,
      safeEvidence: outcome.evidence
    });
  }
  return Object.freeze({
    state: 'acceptance_unknown',
    providerMessageId: null,
    providerOutcomeReason: outcome.reason,
    safeEvidence: outcome.evidence
  });
}

/**
 * Derives an honest next action from the frozen per-attempt provider capabilities.
 * In particular, an ambiguous provider with neither idempotency nor reconciliation
 * cannot be retried automatically.
 */
export function outboundEmailFollowUp(
  resolution: Pick<ProviderAttemptResolution, 'state'>,
  capabilities: ProviderCapabilities
): OutboundEmailFollowUp {
  if (resolution.state === 'accepted' || resolution.state === 'known_rejected_terminal') {
    return 'complete';
  }
  if (resolution.state === 'known_rejected_safe_retryable') return 'safe_retry';
  if (capabilities.idempotency === 'native_key') return 'safe_retry';
  if (capabilities.reconciliation === 'lookup') return 'reconcile';
  if (capabilities.reconciliation === 'callback_only') return 'await_callback';
  return 'manual_resolution_required';
}

