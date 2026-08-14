import {
  computeReviewedEmailEnvelopeDigestSha256,
  type EmailDeliveryAdapter,
  type ImmutableEmailEnvelope,
  type ImmutableEmailSubmission
} from '../providers/port';
import {
  normalizeProviderSubmissionOutcome,
  outboundEmailFollowUp,
  requiredOutboundEmailAttemptKind,
  type OutboundEmailDeliveryAttempt,
  type OutboundEmailDeliveryAttemptKind,
  type OutboundEmailDeliveryHead,
  type OutboundEmailFollowUp,
  type ProviderAttemptResolution
} from './model';
import { deriveMarkedResendEmailEnvelope } from './resend';

export class OutboundEmailDeliveryWorkerError extends Error {
  public constructor(
    public readonly code:
      | 'delivery_not_found'
      | 'delivery_not_dispatchable'
      | 'reviewed_envelope_changed'
      | 'attempt_conflict',
    message = code
  ) {
    super(message);
    this.name = 'OutboundEmailDeliveryWorkerError';
  }
}

export interface OutboundEmailDeliveryLedger {
  read(deliveryId: string): OutboundEmailDeliveryHead | undefined;
  recordAttemptStarted(input: {
    readonly deliveryId: string;
    readonly expectedDeliveryVersion: number;
    readonly attemptId: string;
    readonly attemptKind: OutboundEmailDeliveryAttemptKind;
    /**
     * Digest of the derived marked-resend envelope actually being submitted.
     * Required for a `marked_resend` attempt and forbidden otherwise; the head's
     * reviewed envelope digest keeps pinning the unmodified reviewed original.
     */
    readonly resendEnvelopeDigestSha256?: string;
    readonly adapterKey: string;
    readonly adapterVersion: string;
    readonly capabilities: EmailDeliveryAdapter['capabilities'];
    readonly providerRequestDigestSha256: string;
    readonly startedAt: string;
  }): OutboundEmailDeliveryAttempt;
  recordProviderResolution(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly resolution: ProviderAttemptResolution;
    readonly completedAt: string;
  }): OutboundEmailDeliveryHead;
  recordBoundaryAmbiguity(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly code: 'worker_result_lost' | 'provider_boundary_failure';
    readonly completedAt: string;
  }): OutboundEmailDeliveryHead;
}

export interface OutboundEmailEnvelopeResolver {
  resolve(input: {
    readonly deliveryId: string;
    readonly releaseId: string;
    readonly recipientRefId: string;
    readonly templateRevisionRefId: string;
    readonly contentRefId: string;
  }): ImmutableEmailEnvelope | Promise<ImmutableEmailEnvelope>;
}

export interface OutboundEmailDeliveryWorkerIds {
  newAttemptId(): string;
}

export interface OutboundEmailDeliveryWorkerClock {
  now(): string;
}

export type OutboundEmailDispatchResult = Readonly<{
  contractVersion: 1;
  deliveryId: string;
  attemptId: string;
  state: Exclude<OutboundEmailDeliveryHead['state'], 'pending' | 'request_started'>;
  followUp: OutboundEmailFollowUp;
}>;

function immutableSubmission(
  head: OutboundEmailDeliveryHead,
  attemptId: string,
  envelope: ImmutableEmailEnvelope,
  reviewedEnvelopeDigestSha256: string
): ImmutableEmailSubmission {
  return Object.freeze({
    contractVersion: 1,
    deliveryAttemptId: attemptId,
    providerConnectionRevisionId: head.providerConnectionRevisionId,
    externalDeliveryKey: head.externalDeliveryKey,
    senderProfileRevisionId: head.senderProfileRevisionId,
    senderPresentationContractKey: head.senderPresentationContractKey,
    senderPresentationContractVersion: head.senderPresentationContractVersion,
    senderPresentationDigestSha256: head.senderPresentationDigestSha256,
    channelAddressId: head.channelAddressId,
    channelAddressVersion: head.channelAddressVersion,
    addressLookupFingerprintProfile: head.addressLookupFingerprintProfile,
    addressLookupFingerprintVersion: head.addressLookupFingerprintVersion,
    addressLookupFingerprintSha256: head.addressLookupFingerprintSha256,
    reviewedEnvelopeDigestSha256,
    envelope
  });
}

function dispatchable(head: OutboundEmailDeliveryHead): boolean {
  return head.state === 'pending'
    || head.state === 'known_rejected_safe_retryable'
    || (head.state === 'acceptance_unknown' && !head.markedResendExhausted);
}

/**
 * Runs provider I/O strictly between two ledger calls. Implementations of the
 * ledger keep each call in its own short transaction; no network promise is ever
 * awaited while a database unit of work is open.
 */
export function createOutboundEmailDeliveryWorker(input: {
  readonly ledger: OutboundEmailDeliveryLedger;
  readonly provider: EmailDeliveryAdapter;
  readonly envelopes: OutboundEmailEnvelopeResolver;
  readonly ids: OutboundEmailDeliveryWorkerIds;
  readonly clock: OutboundEmailDeliveryWorkerClock;
}) {
  async function recoverStarted(head: OutboundEmailDeliveryHead): Promise<OutboundEmailDispatchResult> {
    if (head.state !== 'request_started' || head.currentAttemptId === null) {
      throw new OutboundEmailDeliveryWorkerError('delivery_not_dispatchable');
    }
    const completed = input.ledger.recordBoundaryAmbiguity({
      deliveryId: head.deliveryId,
      attemptId: head.currentAttemptId,
      code: 'worker_result_lost',
      completedAt: input.clock.now()
    });
    return Object.freeze({
      contractVersion: 1,
      deliveryId: completed.deliveryId,
      attemptId: head.currentAttemptId,
      state: 'acceptance_unknown',
      followUp: outboundEmailFollowUp(
        { state: 'acceptance_unknown' },
        input.provider.capabilities,
        completed
      )
    });
  }

  return Object.freeze({
    async dispatch(inputDelivery: {
      readonly deliveryId: string;
      /** Test/process fault seam after the provider returned but before result persistence. */
      readonly afterProviderResult?: () => void;
    }): Promise<OutboundEmailDispatchResult> {
      const head = input.ledger.read(inputDelivery.deliveryId);
      if (!head) throw new OutboundEmailDeliveryWorkerError('delivery_not_found');
      if (head.state === 'request_started') return recoverStarted(head);
      if (!dispatchable(head)) {
        throw new OutboundEmailDeliveryWorkerError('delivery_not_dispatchable');
      }

      const attemptId = input.ids.newAttemptId();
      const attemptKind = requiredOutboundEmailAttemptKind(head, input.provider.capabilities);
      const reviewedEnvelope = await input.envelopes.resolve({
        deliveryId: head.deliveryId,
        releaseId: head.releaseId,
        recipientRefId: head.recipientRefId,
        templateRevisionRefId: head.templateRevisionRefId,
        contentRefId: head.contentRefId
      });
      if (
        computeReviewedEmailEnvelopeDigestSha256(reviewedEnvelope)
          !== head.reviewedEnvelopeDigestSha256
      ) {
        throw new OutboundEmailDeliveryWorkerError('reviewed_envelope_changed');
      }
      const envelope = attemptKind === 'marked_resend'
        ? deriveMarkedResendEmailEnvelope(reviewedEnvelope)
        : reviewedEnvelope;
      const submittedEnvelopeDigestSha256 = attemptKind === 'marked_resend'
        ? computeReviewedEmailEnvelopeDigestSha256(envelope)
        : head.reviewedEnvelopeDigestSha256;
      const prepared = input.provider.prepare(
        immutableSubmission(head, attemptId, envelope, submittedEnvelopeDigestSha256)
      );
      if (prepared.reviewedEnvelopeDigestSha256 !== submittedEnvelopeDigestSha256) {
        throw new OutboundEmailDeliveryWorkerError('reviewed_envelope_changed');
      }
      input.ledger.recordAttemptStarted({
        deliveryId: head.deliveryId,
        expectedDeliveryVersion: head.version,
        attemptId,
        attemptKind,
        ...(attemptKind === 'marked_resend'
          ? { resendEnvelopeDigestSha256: submittedEnvelopeDigestSha256 }
          : {}),
        adapterKey: input.provider.adapterKey,
        adapterVersion: input.provider.adapterVersion,
        capabilities: input.provider.capabilities,
        providerRequestDigestSha256: prepared.providerRequestDigestSha256,
        startedAt: input.clock.now()
      });

      let normalized: ProviderAttemptResolution;
      try {
        normalized = normalizeProviderSubmissionOutcome(await input.provider.submit(prepared));
      } catch {
        const completed = input.ledger.recordBoundaryAmbiguity({
          deliveryId: head.deliveryId,
          attemptId,
          code: 'provider_boundary_failure',
          completedAt: input.clock.now()
        });
        return Object.freeze({
          contractVersion: 1,
          deliveryId: completed.deliveryId,
          attemptId,
          state: 'acceptance_unknown',
          followUp: outboundEmailFollowUp(
            { state: 'acceptance_unknown' },
            input.provider.capabilities,
            completed
          )
        });
      }

      inputDelivery.afterProviderResult?.();
      const completed = input.ledger.recordProviderResolution({
        deliveryId: head.deliveryId,
        attemptId,
        resolution: normalized,
        completedAt: input.clock.now()
      });
      return Object.freeze({
        contractVersion: 1,
        deliveryId: completed.deliveryId,
        attemptId,
        state: normalized.state,
        followUp: outboundEmailFollowUp(normalized, input.provider.capabilities, completed)
      });
    }
  });
}

