import type { Database } from 'bun:sqlite';
import {
  createOutboundEmailDeliveryWorker,
  isOutboundEmailDispatchSkipped,
  type EmailDeliveryAdapter,
  type OutboundEmailDeliveryLedger,
  type OutboundEmailDispatchOutcome,
  type OutboundEmailDispatchResult,
  type OutboundEmailEnvelopeResolver
} from '@jooevents/communications';

/**
 * Drives the outbound email delivery worker over the durable ledger. Every
 * ledger write happens inside the worker's own short transactions; this loop
 * only enumerates work with plain reads and never opens a transaction of its
 * own, so provider I/O always runs strictly between two ledger transactions.
 *
 * Follow-up policy (recorder default BLOCKED-6): a delivery found in
 * `request_started` is recovered as `acceptance_unknown` with
 * `manual_resolution_required`; a `known_rejected_safe_retryable` delivery is
 * NOT re-dispatched automatically — retry stays a deliberate human act, so
 * one pass selects only `pending` and stranded `request_started` rows.
 */
/** A delivery that threw during a pass, kept so one bad row cannot silence the rest. */
export interface OutboundDispatchFault {
  readonly deliveryId: string;
  readonly error: unknown;
}

export interface OutboundDispatchLoop {
  /** Faults from the most recent `runOnce`, in queue order. */
  faults(): readonly OutboundDispatchFault[];
  /** One enumeration pass; returns each dispatched delivery's terminal-attempt result. */
  runOnce(): Promise<readonly OutboundEmailDispatchResult[]>;
  /**
   * Targeted dispatch of one just-registered delivery, for after-commit kicks
   * that move time-sensitive security mail without waiting for a sweep. The
   * same no-open-transaction guard applies: the caller's registering
   * transaction must have committed first.
   */
  dispatchOne(deliveryId: string): Promise<OutboundEmailDispatchOutcome>;
}

export function createOutboundDispatchLoop(input: {
  readonly sqlite: Database;
  readonly ledger: OutboundEmailDeliveryLedger;
  /**
   * The one configured provider adapter. The ephemeral runtime composes only
   * the deterministic fake here; per-connection provider selection becomes a
   * composition concern when an external provider is ever activated.
   */
  readonly provider: EmailDeliveryAdapter;
  readonly envelopes: OutboundEmailEnvelopeResolver;
  readonly ids: { newAttemptId(): string; newClaimId(): string };
  readonly clock: { now(): string };
}): OutboundDispatchLoop {
  const worker = createOutboundEmailDeliveryWorker({
    ledger: input.ledger,
    provider: input.provider,
    envelopes: input.envelopes,
    ids: input.ids,
    clock: input.clock
  });

  /**
   * The claimable set, and nothing else.
   *
   * The sweep selects `request_started` on purpose — a delivery stranded by a
   * crash has to be recoverable. But an attempt that is merely AWAITING THE
   * PROVIDER sits in that same state, so a sweep that selected the state alone
   * landed on live attempts, and with a kick firing on every sign-in link and a
   * pass every two seconds that was the ordinary case, not a rare race. The
   * lease is what separates the two: a live lease means a worker is still on it
   * and this pass may not see it at all; a lapsed lease means whoever held it is
   * gone and the delivery is recoverable again the moment it expires.
   *
   * This is a filter, not the decision. Claiming is still what grants
   * ownership, so a delivery claimed between this read and the claim is simply
   * skipped. A process-local in-flight set used to stand in for ownership here;
   * the lease subsumes it — it decides the same question durably, across
   * processes and across a crash — so it is gone.
   */
  function claimableDeliveryIds(nowMs: number): readonly string[] {
    return input.sqlite.query<{ readonly delivery_id: string }, [number]>(`
      SELECT delivery_id
        FROM communication_outbound_delivery_heads
       WHERE state IN ('pending', 'request_started')
         AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)
       ORDER BY created_at_ms, delivery_id
    `).all(nowMs).map((row) => row.delivery_id);
  }

  const notDispatchable = (error: unknown): boolean =>
    error instanceof Error && error.message === 'delivery_not_dispatchable';

  /** Per-delivery faults from the most recent pass, for the caller to report. */
  let lastFaults: readonly OutboundDispatchFault[] = Object.freeze([]);

  return Object.freeze({
    faults: () => lastFaults,
    async runOnce(): Promise<readonly OutboundEmailDispatchResult[]> {
      if (input.sqlite.inTransaction) {
        throw new TypeError('outbound_dispatch_loop_requires_no_open_transaction');
      }
      const nowMs = Date.parse(input.clock.now());
      if (!Number.isFinite(nowMs)) throw new TypeError('outbound_dispatch_loop_clock_invalid');
      const results: OutboundEmailDispatchResult[] = [];
      const faults: OutboundDispatchFault[] = [];
      for (const deliveryId of claimableDeliveryIds(nowMs)) {
        try {
          const outcome = await worker.dispatch({ deliveryId });
          // A delivery claimed by a kick between the read and the claim is not a
          // failure and not a dispatch; it is simply not this pass's work.
          if (!isOutboundEmailDispatchSkipped(outcome)) results.push(outcome);
        } catch (error) {
          /* For an automatic caller, "not dispatchable" only ever means the
             other side got there first — the row settled between this pass's
             read and its claim. A deliberate caller still hears that refusal;
             a sweep treats it as ordinary. */
          if (!notDispatchable(error)) {
            /* One delivery's fault is not the pass's fault. Letting it escape
               abandoned every delivery after it in the queue AND discarded the
               results of the ones already dispatched — so a single poisoned row
               could hold up every sign-in link behind it, indefinitely, because
               the next pass would meet the same row first. Faults are collected
               and reported; the queue keeps moving. */
            faults.push({ deliveryId, error });
          }
        }
      }
      lastFaults = Object.freeze(faults);
      return Object.freeze(results);
    },
    async dispatchOne(deliveryId: string): Promise<OutboundEmailDispatchOutcome> {
      if (input.sqlite.inTransaction) {
        throw new TypeError('outbound_dispatch_loop_requires_no_open_transaction');
      }
      return worker.dispatch({ deliveryId });
    }
  });
}
