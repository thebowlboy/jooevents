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
  OUTBOUND_EMAIL_DELIVERY_LEASE_MS,
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

/**
 * Ownership of a dispatch. A claim is taken by exactly one conditional update,
 * so "somebody else already owns this" is decided by the database rather than
 * by any process's memory, and survives both a second process and a crash.
 */
export type OutboundEmailDeliveryClaimOutcome =
  | Readonly<{
      contractVersion: 1;
      claimed: true;
      claimId: string;
      head: OutboundEmailDeliveryHead;
    }>
  | Readonly<{ contractVersion: 1; claimed: false; reason: 'not_found' }>
  /** Someone else holds a live lease. Ordinary contention, never a fault. */
  | Readonly<{
      contractVersion: 1;
      claimed: false;
      reason: 'lease_held';
      head: OutboundEmailDeliveryHead;
    }>
  /** The delivery is settled or quarantined: no lease could make it dispatchable. */
  | Readonly<{
      contractVersion: 1;
      claimed: false;
      reason: 'not_claimable';
      head: OutboundEmailDeliveryHead;
    }>;

/**
 * The result of persisting one attempt's completion. `fenced` means the writer's
 * lease had already lapsed and been taken by another worker: the provider answer
 * was preserved as append-only acceptance-unknown evidence, and effective
 * delivery state was left to whoever owns the delivery now.
 */
export type OutboundEmailAttemptCompletion = Readonly<{
  contractVersion: 1;
  fenced: boolean;
  head: OutboundEmailDeliveryHead;
}>;

type MaybePromise<Value> = Value | Promise<Value>;

export interface OutboundEmailDeliveryLedger {
  read(deliveryId: string): MaybePromise<OutboundEmailDeliveryHead | undefined>;
  /**
   * Takes the delivery's lease when it is claimable — `pending`, retryable, or
   * a `request_started` whose lease has actually lapsed — and refuses without
   * throwing when it is not.
   */
  claim(input: {
    readonly deliveryId: string;
    readonly claimId: string;
    readonly now: string;
    readonly leaseMs: number;
  }): MaybePromise<OutboundEmailDeliveryClaimOutcome>;
  /**
   * Gives a claim back before any attempt started, so a delivery abandoned for a
   * reason other than a crash is takeable immediately instead of after expiry.
   * A claim that is no longer held is a no-op, never an error.
   */
  releaseClaim(input: {
    readonly deliveryId: string;
    readonly claimId: string;
    readonly now: string;
  }): MaybePromise<void>;
  recordAttemptStarted(input: {
    readonly deliveryId: string;
    readonly expectedDeliveryVersion: number;
    /** The claim this attempt runs under; the lease is renewed from `startedAt`. */
    readonly claimId: string;
    readonly leaseMs: number;
    readonly attemptId: string;
    readonly attemptKind: OutboundEmailDeliveryAttemptKind;
    /** Present only after the explicit permanent-bounce correction ceremony. */
    readonly authorizedMarkedResend?: boolean;
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
  }): MaybePromise<OutboundEmailDeliveryAttempt>;
  recordProviderResolution(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    /** Fences the write: a lapsed-and-retaken claim may not overwrite state. */
    readonly claimId: string;
    readonly resolution: ProviderAttemptResolution;
    readonly completedAt: string;
  }): MaybePromise<OutboundEmailAttemptCompletion>;
  recordBoundaryAmbiguity(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly claimId: string;
    readonly code: 'worker_result_lost' | 'provider_boundary_failure';
    readonly completedAt: string;
  }): MaybePromise<OutboundEmailAttemptCompletion>;
}

export interface OutboundEmailEnvelopeResolver {
  resolve(input: {
    readonly deliveryId: string;
    readonly releaseId: string;
    readonly recipientRefId: string;
    readonly templateRevisionRefId: string;
    readonly contentRefId: string;
  }): ImmutableEmailEnvelope | Promise<ImmutableEmailEnvelope>;
  resolveMarkedResendRecipient?(input: {
    readonly deliveryId: string;
    readonly releaseId: string;
    readonly recipientRefId: string;
  }): MaybePromise<Readonly<{
    address: ImmutableEmailEnvelope['to']['address'];
    channelAddressId: string;
    channelAddressVersion: number;
    addressLookupFingerprintProfile: string;
    addressLookupFingerprintVersion: number;
    addressLookupFingerprintSha256: string;
  }> | undefined>;
}

export interface OutboundEmailDeliveryWorkerIds {
  newAttemptId(): string;
  /**
   * One fresh opaque token per claim attempt. It must be unique per claim, not
   * per delivery or per attempt: a recovery claim completes an attempt it did
   * not start, and two workers racing the same delivery must present tokens
   * that cannot be confused.
   */
  newClaimId(): string;
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

/**
 * A dispatch that did not happen because another worker owns the delivery.
 * Losing a claim is the expected outcome of two workers meeting on one
 * delivery, so it is a value the caller may ignore — not an exception, not a
 * logged error, and not a delivery failure.
 */
export type OutboundEmailDispatchSkipped = Readonly<{
  contractVersion: 1;
  skipped: 'lease_held';
  deliveryId: string;
}>;

export type OutboundEmailDispatchOutcome =
  | OutboundEmailDispatchResult
  | OutboundEmailDispatchSkipped;

export function isOutboundEmailDispatchSkipped(
  outcome: OutboundEmailDispatchOutcome
): outcome is OutboundEmailDispatchSkipped {
  return 'skipped' in outcome;
}

function immutableSubmission(
  head: OutboundEmailDeliveryHead,
  attemptId: string,
  envelope: ImmutableEmailEnvelope,
  reviewedEnvelopeDigestSha256: string,
  correctedRecipient?: Readonly<{
    channelAddressId: string;
    channelAddressVersion: number;
    addressLookupFingerprintProfile: string;
    addressLookupFingerprintVersion: number;
    addressLookupFingerprintSha256: string;
  }>
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
    channelAddressId: correctedRecipient?.channelAddressId ?? head.channelAddressId,
    channelAddressVersion: correctedRecipient?.channelAddressVersion ?? head.channelAddressVersion,
    addressLookupFingerprintProfile: correctedRecipient?.addressLookupFingerprintProfile
      ?? head.addressLookupFingerprintProfile,
    addressLookupFingerprintVersion: correctedRecipient?.addressLookupFingerprintVersion
      ?? head.addressLookupFingerprintVersion,
    addressLookupFingerprintSha256: correctedRecipient?.addressLookupFingerprintSha256
      ?? head.addressLookupFingerprintSha256,
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
  /**
   * A completion whose lease had already lapsed and been taken kept its provider
   * answer as evidence but did not settle the delivery. The honest result is
   * therefore acceptance-unknown regardless of what the provider said, derived
   * from the head as it now stands.
   */
  function completionResult(
    deliveryId: string,
    attemptId: string,
    completed: OutboundEmailAttemptCompletion,
    resolution: Pick<ProviderAttemptResolution, 'state'>
  ): OutboundEmailDispatchResult {
    const state = completed.fenced ? 'acceptance_unknown' : resolution.state;
    return Object.freeze({
      contractVersion: 1,
      deliveryId,
      attemptId,
      state,
      followUp: outboundEmailFollowUp({ state }, input.provider.capabilities, completed.head)
    });
  }

  /**
   * A delivery whose lease lapsed while an attempt was in flight. The attempt is
   * closed as acceptance-unknown and NOT resubmitted here: a reclaim is not a
   * fresh original, so any further send goes back through the ordinary
   * marked-resend and resend-exhausted rules on a later dispatch. The external
   * delivery key is carried on every request, but this provider family does not
   * promise to honour it, so a lapsed lease must never become a silent resend.
   */
  async function recoverStarted(
    head: OutboundEmailDeliveryHead,
    claimId: string
  ): Promise<OutboundEmailDispatchResult> {
    if (head.state !== 'request_started' || head.currentAttemptId === null) {
      throw new OutboundEmailDeliveryWorkerError('delivery_not_dispatchable');
    }
    const attemptId = head.currentAttemptId;
    const completed = await input.ledger.recordBoundaryAmbiguity({
      deliveryId: head.deliveryId,
      attemptId,
      claimId,
      code: 'worker_result_lost',
      completedAt: input.clock.now()
    });
    return completionResult(
      head.deliveryId,
      attemptId,
      completed,
      { state: 'acceptance_unknown' }
    );
  }

  return Object.freeze({
    async dispatch(inputDelivery: {
      readonly deliveryId: string;
      /** Test/process fault seam after the provider returned but before result persistence. */
      readonly afterProviderResult?: () => void;
    }): Promise<OutboundEmailDispatchOutcome> {
      const claimId = input.ids.newClaimId();
      const claim = await input.ledger.claim({
        deliveryId: inputDelivery.deliveryId,
        claimId,
        now: input.clock.now(),
        leaseMs: OUTBOUND_EMAIL_DELIVERY_LEASE_MS
      });
      if (!claim.claimed) {
        if (claim.reason === 'not_found') {
          throw new OutboundEmailDeliveryWorkerError('delivery_not_found');
        }
        // Contention is an expected outcome of a sweep meeting a kick. The
        // caller ignores it and sees the settled state on a later pass.
        if (claim.reason === 'lease_held') {
          return Object.freeze({
            contractVersion: 1,
            skipped: 'lease_held',
            deliveryId: inputDelivery.deliveryId
          });
        }
        /* Not claimable is a real refusal, not a skip: a quarantined delivery
           that has spent its single marked resend must say so to whoever asked.
           The AUTOMATIC callers — the sweep and the after-commit kick — treat it
           as ordinary, because for them it only ever means the other side got
           there first. A deliberate caller still hears the refusal. */
        throw new OutboundEmailDeliveryWorkerError('delivery_not_dispatchable');
      }
      const head = claim.head;
      if (head.state === 'request_started') return recoverStarted(head, claimId);
      if (!dispatchable(head)) {
        throw new OutboundEmailDeliveryWorkerError('delivery_not_dispatchable');
      }

      const attemptId = input.ids.newAttemptId();
      let attemptKind = requiredOutboundEmailAttemptKind(head, input.provider.capabilities);
      let authorizedMarkedResend = false;
      /* A lease can lapse between the claim and the attempt registration if this
         process stalled. The ledger refuses the write, and that refusal is the
         same contention as any other — a typed skip, not a raw persistence
         error escaping through a dispatch call. */
      const lostLease = (error: unknown): boolean =>
        error instanceof TypeError && error.message === 'outbound_delivery_attempt_conflict';
      let prepared: ReturnType<EmailDeliveryAdapter['prepare']>;
      try {
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
        const correctedRecipient = attemptKind === 'original'
            && head.state === 'known_rejected_safe_retryable'
            && input.envelopes.resolveMarkedResendRecipient !== undefined
          ? await input.envelopes.resolveMarkedResendRecipient({
              deliveryId: head.deliveryId,
              releaseId: head.releaseId,
              recipientRefId: head.recipientRefId
            })
          : undefined;
        if (correctedRecipient !== undefined) {
          attemptKind = 'marked_resend';
          authorizedMarkedResend = true;
        }
        const resendBase = correctedRecipient === undefined
          ? reviewedEnvelope
          : Object.freeze({
              ...reviewedEnvelope,
              to: Object.freeze({ address: correctedRecipient.address })
            });
        const envelope = attemptKind === 'marked_resend'
          ? deriveMarkedResendEmailEnvelope(resendBase)
          : reviewedEnvelope;
        const submittedEnvelopeDigestSha256 = attemptKind === 'marked_resend'
          ? computeReviewedEmailEnvelopeDigestSha256(envelope)
          : head.reviewedEnvelopeDigestSha256;
        prepared = input.provider.prepare(
          immutableSubmission(
            head, attemptId, envelope, submittedEnvelopeDigestSha256, correctedRecipient
          )
        );
        if (prepared.reviewedEnvelopeDigestSha256 !== submittedEnvelopeDigestSha256) {
          throw new OutboundEmailDeliveryWorkerError('reviewed_envelope_changed');
        }
        await input.ledger.recordAttemptStarted({
          deliveryId: head.deliveryId,
          expectedDeliveryVersion: head.version,
          claimId,
          leaseMs: OUTBOUND_EMAIL_DELIVERY_LEASE_MS,
          attemptId,
          attemptKind,
          ...(authorizedMarkedResend ? { authorizedMarkedResend: true } : {}),
          ...(attemptKind === 'marked_resend'
            ? { resendEnvelopeDigestSha256: submittedEnvelopeDigestSha256 }
            : {}),
          adapterKey: input.provider.adapterKey,
          adapterVersion: input.provider.adapterVersion,
          capabilities: input.provider.capabilities,
          providerRequestDigestSha256: prepared.providerRequestDigestSha256,
          startedAt: input.clock.now()
        });
      } catch (error) {
        if (lostLease(error)) {
          /* The lease lapsed and another worker took it; this one owns nothing
             to release and nothing to report. Its successor holds the delivery. */
          return Object.freeze({
            contractVersion: 1,
            skipped: 'lease_held',
            deliveryId: head.deliveryId
          });
        }
        // Nothing was submitted and no attempt is in flight, so holding the
        // lease until it expires would only delay an honest retry.
        await input.ledger.releaseClaim({
          deliveryId: head.deliveryId,
          claimId,
          now: input.clock.now()
        });
        throw error;
      }

      let normalized: ProviderAttemptResolution;
      try {
        normalized = normalizeProviderSubmissionOutcome(await input.provider.submit(prepared));
      } catch {
        const completed = await input.ledger.recordBoundaryAmbiguity({
          deliveryId: head.deliveryId,
          attemptId,
          claimId,
          code: 'provider_boundary_failure',
          completedAt: input.clock.now()
        });
        return completionResult(
          head.deliveryId,
          attemptId,
          completed,
          { state: 'acceptance_unknown' }
        );
      }

      inputDelivery.afterProviderResult?.();
      const completed = await input.ledger.recordProviderResolution({
        deliveryId: head.deliveryId,
        attemptId,
        claimId,
        resolution: normalized,
        completedAt: input.clock.now()
      });
      return completionResult(head.deliveryId, attemptId, completed, normalized);
    }
  });
}
