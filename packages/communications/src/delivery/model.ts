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

/**
 * `original` submits the exact reviewed envelope. `marked_resend` submits the
 * deterministically derived resend envelope — `[Resend]` subject prefix plus a
 * first body line noting the resend — used for the single automatic retry after
 * a delivery's acceptance became unknown, so a double delivery reads as intent.
 */
export type OutboundEmailDeliveryAttemptKind = 'original' | 'marked_resend';

/**
 * The bounded wall-clock budget one provider submission may occupy. The
 * configured adapter enforces it on its own request, so a submission either
 * resolves or reports a bounded acceptance-unknown timeout within this window.
 */
export const OUTBOUND_EMAIL_PROVIDER_REQUEST_BUDGET_MS = 20_000;

/**
 * The lease is derived from that budget, never guessed: it has to outlast a
 * full-budget request plus the two short ledger transactions bracketing it, and
 * it is renewed when the attempt actually starts, so an ordinary slow send can
 * never lapse mid-flight. Three budgets is the accepted margin.
 */
export const OUTBOUND_EMAIL_DELIVERY_LEASE_MARGIN_FACTOR = 3;

/**
 * How long a dispatch claim owns a delivery. Ownership is durable state on the
 * delivery head, so it survives a process death: a worker that dies mid-attempt
 * stops renewing, the lease lapses, and only then may another worker take it.
 */
export const OUTBOUND_EMAIL_DELIVERY_LEASE_MS =
  OUTBOUND_EMAIL_PROVIDER_REQUEST_BUDGET_MS * OUTBOUND_EMAIL_DELIVERY_LEASE_MARGIN_FACTOR;

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
  /** Completed attempts whose provider acceptance is unknown; monotonic. */
  readonly unknownAttemptCount: number;
  /**
   * True once the single automatic marked resend itself landed with unknown
   * acceptance. An `acceptance_unknown` head with this flag set is quarantined:
   * it is never dispatchable again and its follow-up is manual resolution.
   */
  readonly markedResendExhausted: boolean;
  readonly currentAttemptId: string | null;
  /**
   * The claim token of whoever owns dispatching this delivery right now, or
   * `null` when nobody does. This is the durable answer to "is a worker
   * actively doing this", which `state = 'request_started'` alone cannot give:
   * that state means the same thing for a live attempt and for one abandoned by
   * a dead process.
   */
  readonly leaseClaimId: string | null;
  /** When the current claim lapses. A lapsed lease is takeable; a live one is not. */
  readonly leaseExpiresAt: string | null;
}

export interface OutboundEmailDeliveryAttempt {
  readonly contractVersion: 1;
  readonly deliveryId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly attemptKind: OutboundEmailDeliveryAttemptKind;
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
  | 'marked_resend'
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
 * An ambiguous provider with neither idempotency nor reconciliation gets exactly
 * one automatic retry, submitted as a marked resend (`[Resend]` subject prefix
 * plus a first body line noting the resend) so a double delivery reads as intent;
 * once that marked resend also lands unknown — or when no resend availability is
 * supplied — the delivery requires manual resolution.
 */
export function outboundEmailFollowUp(
  resolution: Pick<ProviderAttemptResolution, 'state'>,
  capabilities: ProviderCapabilities,
  resend?: Pick<OutboundEmailDeliveryHead, 'markedResendExhausted'>
): OutboundEmailFollowUp {
  if (resolution.state === 'accepted' || resolution.state === 'known_rejected_terminal') {
    return 'complete';
  }
  if (resolution.state === 'known_rejected_safe_retryable') return 'safe_retry';
  if (capabilities.idempotency === 'native_key') return 'safe_retry';
  if (capabilities.reconciliation === 'lookup') return 'reconcile';
  if (capabilities.reconciliation === 'callback_only') return 'await_callback';
  if (resend !== undefined && !resend.markedResendExhausted) return 'marked_resend';
  return 'manual_resolution_required';
}

/**
 * The attempt kind the ledger requires for the next submission. Once acceptance
 * ambiguity exists, any further send through a provider that cannot deduplicate
 * natively must carry the marked-resend envelope — including a safe retry after
 * a rejected marked resend, because the first delivery is still unconfirmed.
 * A natively idempotent provider deduplicates on the external delivery key, so
 * its retry is not a visible second delivery and stays unmarked.
 */
export function requiredOutboundEmailAttemptKind(
  head: Pick<OutboundEmailDeliveryHead, 'unknownAttemptCount'>,
  capabilities: Pick<ProviderCapabilities, 'idempotency'>
): OutboundEmailDeliveryAttemptKind {
  return head.unknownAttemptCount > 0 && capabilities.idempotency !== 'native_key'
    ? 'marked_resend'
    : 'original';
}

