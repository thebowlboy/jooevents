import type { Database } from 'bun:sqlite';
import {
  createOutboundEmailDeliveryWorker,
  type EmailDeliveryAdapter,
  type OutboundEmailDeliveryLedger,
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
export interface OutboundDispatchLoop {
  /** One enumeration pass; returns each dispatched delivery's terminal-attempt result. */
  runOnce(): Promise<readonly OutboundEmailDispatchResult[]>;
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
  readonly ids: { newAttemptId(): string };
  readonly clock: { now(): string };
}): OutboundDispatchLoop {
  const worker = createOutboundEmailDeliveryWorker({
    ledger: input.ledger,
    provider: input.provider,
    envelopes: input.envelopes,
    ids: input.ids,
    clock: input.clock
  });
  return Object.freeze({
    async runOnce(): Promise<readonly OutboundEmailDispatchResult[]> {
      if (input.sqlite.inTransaction) {
        throw new TypeError('outbound_dispatch_loop_requires_no_open_transaction');
      }
      const rows = input.sqlite.query<{ readonly delivery_id: string }, []>(`
        SELECT delivery_id
          FROM communication_outbound_delivery_heads
         WHERE state IN ('pending', 'request_started')
         ORDER BY created_at_ms, delivery_id
      `).all();
      const results: OutboundEmailDispatchResult[] = [];
      for (const row of rows) {
        results.push(await worker.dispatch({ deliveryId: row.delivery_id }));
      }
      return Object.freeze(results);
    }
  });
}
