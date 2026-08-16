import type { Database } from 'bun:sqlite';
import { structuredOutcomeSchema, type StructuredOutcome } from '@jooevents/contracts';
import {
  ORGANIZER_COMMUNICATION_PAGE_LIMIT,
  organizerCommunicationHistoryListInputSchema,
  organizerCommunicationHistoryPageSchema,
  organizerCommunicationStableKeySchema,
  type OrganizerCommunicationHistoryItem
} from '@jooevents/contracts/communications/organizer';
import { sendMessagesAuthorInputSchema } from '@jooevents/communication-operations';
import { parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';

/**
 * Live `get_delivery_history` projection over the committed send-wave
 * evidence: one row per committed release batch, its identity and labels read
 * from the batch's owner-native release commit, and its
 * per-recipient delivery-state counts recomputed from the outbound-delivery
 * ledger heads on every read. Nothing here is a fire-once flag — the counts
 * are always the ledger's current truth, so with no outbound provider
 * activated every batch honestly reports zero accepted and zero delivered,
 * and a failed batch's reason is the code the deciding provider attempt
 * itself recorded, never a composition assumption stated as evidence.
 */

export type SQLiteCommunicationDeliveryHistoryErrorCode = 'data_corrupt';

export class SQLiteCommunicationDeliveryHistoryError extends Error {
  constructor(readonly code: SQLiteCommunicationDeliveryHistoryErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteCommunicationDeliveryHistoryError';
  }
}

type CanonicalResult =
  | { readonly kind: 'success'; readonly data: unknown }
  | { readonly kind: 'outcome'; readonly outcome: StructuredOutcome };

interface CommitLinkRow {
  readonly receipt_id: string;
  readonly batch_id: string;
  readonly plan_json: string;
  readonly occurred_at_ms: number;
}

interface HeadStateRow {
  readonly state:
    | 'pending'
    | 'request_started'
    | 'accepted'
    | 'known_rejected_safe_retryable'
    | 'known_rejected_terminal'
    | 'acceptance_unknown';
  readonly total: number;
  readonly last_updated_at_ms: number;
}

const CURSOR_PREFIX = 'cur1_';

function encodeCursor(row: CommitLinkRow): string {
  return `${CURSOR_PREFIX}${Buffer.from(
    JSON.stringify({ occurredAtMs: row.occurred_at_ms, receiptId: row.receipt_id }),
    'utf8'
  ).toString('base64url')}`;
}

function decodeCursor(cursor: string): { occurredAtMs: number; receiptId: string } | undefined {
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const parsed = z.strictObject({
      occurredAtMs: z.number().int().nonnegative(),
      receiptId: z.string().min(1).max(256)
    }).parse(JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')
    ));
    return parsed;
  } catch {
    return undefined;
  }
}

function outcome(outcomeValue: StructuredOutcome): CanonicalResult {
  return Object.freeze({ kind: 'outcome', outcome: structuredOutcomeSchema.parse(outcomeValue) });
}

function invalidInputOutcome(): CanonicalResult {
  return outcome({
    class: 'policy_violation',
    kind: 'communication.preview_invalid',
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
}

function instant(ms: number): string {
  return new Date(ms).toISOString();
}

/** Clamps a canonical single line into a shorter canonical single line. */
function clampLabel(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1).trimEnd()}…`;
}

export function createSQLiteCommunicationDeliveryHistorySource(input: {
  readonly sqlite: Database;
}) {
  const { sqlite } = input;

  function batchDeliveryStates(scope: { workspaceId: string; eventId: string }, batchId: string) {
    return sqlite.query<HeadStateRow, [string, string, string]>(`
      SELECT h.state AS state, count(*) AS total, max(h.updated_at_ms) AS last_updated_at_ms
        FROM communication_outbound_delivery_heads h
        JOIN communication_message_releases r ON r.release_id = h.release_id
       WHERE h.workspace_id = ? AND h.event_id = ? AND r.batch_id = ?
       GROUP BY h.state
    `).all(scope.workspaceId, scope.eventId, batchId);
  }

  /**
   * The reason the ledger itself recorded for a batch that accepted nothing:
   * the provider outcome code its deciding attempts carry. It is reported
   * only when every rejected delivery in the batch agrees on one code, so a
   * batch that failed several ways — or whose failure carries no provider
   * code at all (a boundary fault records a recovery code instead) — states
   * no single reason rather than naming one the evidence cannot support.
   */
  function batchFailureReasonCode(
    scope: { workspaceId: string; eventId: string },
    batchId: string
  ): string | undefined {
    const reasons = sqlite.query<{ readonly reason: string | null }, [string, string, string]>(`
      SELECT DISTINCT a.provider_outcome_reason AS reason
        FROM communication_outbound_delivery_heads h
        JOIN communication_message_releases r ON r.release_id = h.release_id
        JOIN communication_outbound_delivery_attempts a ON a.attempt_id = h.current_attempt_id
       WHERE h.workspace_id = ? AND h.event_id = ? AND r.batch_id = ?
         AND h.state IN ('known_rejected_terminal', 'known_rejected_safe_retryable')
    `).all(scope.workspaceId, scope.eventId, batchId);
    if (reasons.length !== 1) return undefined;
    const parsed = organizerCommunicationStableKeySchema.safeParse(reasons[0]!.reason);
    return parsed.success ? parsed.data : undefined;
  }

  function historyItem(
    scope: { workspaceId: string; eventId: string },
    link: CommitLinkRow
  ): OrganizerCommunicationHistoryItem {
    let plan: ReturnType<typeof sendMessagesAuthorInputSchema.parse>;
    try {
      plan = sendMessagesAuthorInputSchema.parse(JSON.parse(link.plan_json));
    } catch (error) {
      throw new SQLiteCommunicationDeliveryHistoryError('data_corrupt', error);
    }
    if (plan.batchId !== link.batch_id
        || plan.scope.workspaceId !== scope.workspaceId
        || plan.scope.eventId !== scope.eventId) {
      throw new SQLiteCommunicationDeliveryHistoryError('data_corrupt');
    }

    const materialized = sqlite.query<{ readonly total: number }, [string, string, string]>(`
      SELECT count(*) AS total FROM communication_message_releases
       WHERE workspace_id = ? AND event_id = ? AND batch_id = ?
    `).get(scope.workspaceId, scope.eventId, link.batch_id)?.total ?? 0;

    const states = batchDeliveryStates(scope, link.batch_id);
    const byState = new Map(states.map((row) => [row.state, row.total]));
    const accepted = byState.get('accepted') ?? 0;
    const acceptanceUnknown = byState.get('acceptance_unknown') ?? 0;
    const knownFailed = (byState.get('known_rejected_terminal') ?? 0)
      + (byState.get('known_rejected_safe_retryable') ?? 0);
    const lastObservedAtMs = states.reduce(
      (latest, row) => Math.max(latest, row.last_updated_at_ms),
      0
    );

    // Deterministic batch state from the ledger heads. `delivered` is
    // deliberately unreachable in v1: acceptance is the strongest provider
    // evidence the ledger records, and no delivery-confirmation stream exists.
    const state = (byState.get('request_started') ?? 0) > 0
      ? 'attempting' as const
      : (byState.get('pending') ?? 0) > 0
        ? 'materialized' as const
        : acceptanceUnknown > 0
          ? 'acceptance_unknown' as const
          : accepted > 0
            ? 'accepted' as const
            : 'known_failed' as const;
    const stateReasonCode = state === 'known_failed'
      ? batchFailureReasonCode(scope, link.batch_id)
      : undefined;

    return {
      schemaVersion: 1,
      visibility: 'organizer_non_security',
      historyItemId: link.receipt_id,
      messageRefId: link.batch_id,
      purposeRevision: plan.purposeRevision,
      ...(plan.templateRevision === undefined
        ? {}
        : { templateRevision: plan.templateRevision }),
      subject: plan.subject,
      audienceLabel: clampLabel(plan.audienceLabel, 200),
      state,
      ...(stateReasonCode === undefined ? {} : { stateReasonCode }),
      // The commit ceremony records principal keys, not display identities;
      // the generic human label is the honest v1 projection of that evidence.
      actor: { kind: 'human', displayLabel: 'Workspace operator' },
      cause: {
        summary: 'Committed from an adopted, reviewed decision-notification preview.',
        subjectKind: 'communication_preview',
        subjectRefId: plan.preview.identity.audienceSpecId,
        subjectVersion: plan.preview.identity.previewGeneration
      },
      counts: {
        audience: { knowledge: 'known', value: plan.releases.length },
        materialized: { knowledge: 'known', value: materialized },
        accepted: { knowledge: 'known', value: accepted },
        // Provider acceptance is the strongest evidence the ledger records;
        // no delivery-confirmation stream exists, so a delivered count is
        // honestly not supported rather than a fabricated zero.
        delivered: { knowledge: 'not_supported' },
        acceptanceUnknown: { knowledge: 'known', value: acceptanceUnknown },
        knownFailed: { knowledge: 'known', value: knownFailed }
      },
      authorizedAt: instant(link.occurred_at_ms),
      ...(lastObservedAtMs > 0 ? { lastObservedAt: instant(lastObservedAtMs) } : {}),
      availableActions: state === 'known_failed' ? ['continue_provider_setup'] : []
    };
  }

  return Object.freeze({
    listDeliveryHistory(
      rawScope: { readonly workspaceId: string; readonly eventId: string },
      rawInput: unknown
    ): CanonicalResult {
      const scope = {
        workspaceId: parseWorkspaceId(rawScope.workspaceId) as string,
        eventId: parseEventId(rawScope.eventId) as string
      };
      const parsedInput = organizerCommunicationHistoryListInputSchema.safeParse(rawInput ?? {});
      if (!parsedInput.success) return invalidInputOutcome();
      const filters = parsedInput.data;
      const after = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor);
      if (filters.cursor !== undefined && after === undefined) return invalidInputOutcome();
      const limit = Math.min(
        filters.limit ?? ORGANIZER_COMMUNICATION_PAGE_LIMIT,
        ORGANIZER_COMMUNICATION_PAGE_LIMIT
      );

      const conditions = ['l.workspace_id = ?', 'l.event_id = ?'];
      const parameters: (string | number)[] = [scope.workspaceId, scope.eventId];
      if (filters.messageRefId !== undefined) {
        conditions.push('l.batch_id = ?');
        parameters.push(filters.messageRefId);
      }
      if (filters.personRefId !== undefined) {
        conditions.push(`EXISTS (
          SELECT 1 FROM communication_message_releases pr
           WHERE pr.workspace_id = l.workspace_id AND pr.event_id = l.event_id
             AND pr.batch_id = l.batch_id AND pr.person_ref_id = ?
        )`);
        parameters.push(filters.personRefId);
      }
      if (after !== undefined) {
        conditions.push('(l.occurred_at_ms < ? OR (l.occurred_at_ms = ? AND l.commit_id > ?))');
        parameters.push(after.occurredAtMs, after.occurredAtMs, after.receiptId);
      }

      const links = sqlite.query<CommitLinkRow, (string | number)[]>(`
        SELECT l.commit_id AS receipt_id, l.batch_id, l.plan_json, l.occurred_at_ms
          FROM communication_release_commits l
         WHERE ${conditions.join(' AND ')}
         ORDER BY l.occurred_at_ms DESC, l.commit_id ASC
         LIMIT ${limit + 1}
      `).all(...parameters);

      const rows: OrganizerCommunicationHistoryItem[] = [];
      for (const link of links.slice(0, limit)) {
        const item = historyItem(scope, link);
        if (filters.state !== undefined && item.state !== filters.state) continue;
        rows.push(item);
      }
      // A state filter narrows after derivation, so a page may under-fill; the
      // cursor still walks the full commit sequence and never skips a batch.
      const hasMore = links.length > limit;
      const page = hasMore
        ? { hasMore: true as const, nextCursor: encodeCursor(links[limit - 1]!) }
        : { hasMore: false as const };
      return Object.freeze({
        kind: 'success',
        data: organizerCommunicationHistoryPageSchema.parse({
          schemaVersion: 1,
          visibility: 'organizer_non_security',
          rows,
          page
        })
      });
    }
  });
}

export type SQLiteCommunicationDeliveryHistorySource =
  ReturnType<typeof createSQLiteCommunicationDeliveryHistorySource>;
