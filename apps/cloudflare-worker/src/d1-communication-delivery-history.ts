import type {
  CommunicationDeliveryHistoryReadPort,
  OrganizerCommunicationCanonicalResult
} from '@jooevents/communication-operations';
import { sendMessagesAuthorInputSchema } from '@jooevents/communication-operations';
import {
  ORGANIZER_COMMUNICATION_PAGE_LIMIT,
  organizerCommunicationHistoryListInputSchema,
  organizerCommunicationHistoryPageSchema,
  organizerCommunicationStableKeySchema,
  type OrganizerCommunicationHistoryItem
} from '@jooevents/contracts';
import {
  parseSubmissionConfirmationReleasePlan,
  type SubmissionConfirmationReleasePlan
} from '@jooevents/persistence/submission-confirmation-release-plan';
import { parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';

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

function outcome(): OrganizerCommunicationCanonicalResult {
  return Object.freeze({
    kind: 'outcome' as const,
    outcome: Object.freeze({
      class: 'policy_violation' as const,
      kind: 'communication.preview_invalid',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });
}

function encodeCursor(row: CommitLinkRow): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify({
    occurredAtMs: row.occurred_at_ms,
    receiptId: row.receipt_id
  }), 'utf8').toString('base64url')}`;
}

function decodeCursor(cursor: string): { readonly occurredAtMs: number; readonly receiptId: string }
  | undefined {
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    return z.strictObject({
      occurredAtMs: z.number().int().nonnegative(),
      receiptId: z.string().min(1).max(256)
    }).parse(JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')
    ));
  } catch {
    return undefined;
  }
}

function instant(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError('d1_communication_delivery_history_corrupt');
  }
  const value = new Date(milliseconds).toISOString();
  if (Date.parse(value) !== milliseconds) {
    throw new TypeError('d1_communication_delivery_history_corrupt');
  }
  return value;
}

function clampLabel(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;
}

/** Projects safe send history from the retained D1 release and delivery ledgers. */
export function createD1CommunicationDeliveryHistoryReadPort(input: {
  readonly database: D1Database;
  readonly workspaceId: string;
}): CommunicationDeliveryHistoryReadPort {
  const workspaceId = parseWorkspaceId(input.workspaceId);

  const historyItem = async (
    session: D1DatabaseSession,
    scope: { readonly workspaceId: string; readonly eventId: string },
    link: CommitLinkRow
  ): Promise<OrganizerCommunicationHistoryItem> => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(link.plan_json);
    } catch (error) {
      throw new TypeError('d1_communication_delivery_history_corrupt', { cause: error });
    }
    let plan: ReturnType<typeof sendMessagesAuthorInputSchema.parse>
      | SubmissionConfirmationReleasePlan;
    try {
      plan = sendMessagesAuthorInputSchema.parse(parsedJson);
    } catch (sendPlanError) {
      try {
        plan = parseSubmissionConfirmationReleasePlan(parsedJson);
      } catch {
        throw new TypeError('d1_communication_delivery_history_corrupt', {
          cause: sendPlanError
        });
      }
    }
    if (plan.batchId !== link.batch_id || plan.scope.workspaceId !== scope.workspaceId
        || plan.scope.eventId !== scope.eventId) {
      throw new TypeError('d1_communication_delivery_history_corrupt');
    }
    const submissionPlan = 'kind' in plan && plan.kind === 'submission_confirmation'
      ? plan
      : undefined;
    const sendPlan = submissionPlan === undefined
      ? plan as ReturnType<typeof sendMessagesAuthorInputSchema.parse>
      : undefined;
    const [materializedResult, stateResult, reasonResult] = await session.batch([
      session.prepare(`SELECT count(*) AS total FROM communication_message_releases
        WHERE workspace_id=? AND event_id=? AND batch_id=?`)
        .bind(scope.workspaceId, scope.eventId, link.batch_id),
      session.prepare(`SELECT h.state AS state,count(*) AS total,
          max(h.updated_at_ms) AS last_updated_at_ms
        FROM communication_outbound_delivery_heads h
        JOIN communication_message_releases r ON r.release_id=h.release_id
        WHERE h.workspace_id=? AND h.event_id=? AND r.batch_id=? GROUP BY h.state`)
        .bind(scope.workspaceId, scope.eventId, link.batch_id),
      session.prepare(`SELECT DISTINCT a.provider_outcome_reason AS reason
        FROM communication_outbound_delivery_heads h
        JOIN communication_message_releases r ON r.release_id=h.release_id
        JOIN communication_outbound_delivery_attempts a ON a.attempt_id=h.current_attempt_id
        WHERE h.workspace_id=? AND h.event_id=? AND r.batch_id=?
          AND h.state IN ('known_rejected_terminal','known_rejected_safe_retryable')`)
        .bind(scope.workspaceId, scope.eventId, link.batch_id)
    ]);
    const materializedRow = (materializedResult as D1Result<{ readonly total: number }>)
      .results[0];
    const materialized = materializedRow?.total ?? 0;
    if (!Number.isSafeInteger(materialized) || materialized < 0) {
      throw new TypeError('d1_communication_delivery_history_corrupt');
    }
    const states = (stateResult as D1Result<HeadStateRow>).results;
    const byState = new Map(states.map((row) => [row.state, row.total]));
    for (const row of states) {
      if (!Number.isSafeInteger(row.total) || row.total < 1
          || !Number.isSafeInteger(row.last_updated_at_ms) || row.last_updated_at_ms < 0) {
        throw new TypeError('d1_communication_delivery_history_corrupt');
      }
    }
    const accepted = byState.get('accepted') ?? 0;
    const acceptanceUnknown = byState.get('acceptance_unknown') ?? 0;
    const knownFailed = (byState.get('known_rejected_terminal') ?? 0)
      + (byState.get('known_rejected_safe_retryable') ?? 0);
    const lastObservedAtMs = states.reduce(
      (latest, row) => Math.max(latest, row.last_updated_at_ms), 0
    );
    const state = (byState.get('request_started') ?? 0) > 0
      ? 'attempting' as const
      : (byState.get('pending') ?? 0) > 0
        ? 'materialized' as const
        : acceptanceUnknown > 0
          ? 'acceptance_unknown' as const
          : accepted > 0
            ? 'accepted' as const
            : 'known_failed' as const;
    const reasons = (reasonResult as D1Result<{ readonly reason: string | null }>).results;
    const parsedReason = reasons.length === 1
      ? organizerCommunicationStableKeySchema.safeParse(reasons[0]!.reason)
      : undefined;
    const stateReasonCode = state === 'known_failed' && parsedReason?.success
      ? parsedReason.data
      : undefined;
    return {
      schemaVersion: 1,
      visibility: 'organizer_non_security',
      historyItemId: link.receipt_id,
      messageRefId: link.batch_id,
      purposeRevision: plan.purposeRevision,
      ...(sendPlan?.templateRevision === undefined
        ? {}
        : { templateRevision: sendPlan.templateRevision }),
      subject: plan.subject,
      audienceLabel: clampLabel(plan.audienceLabel, 200),
      state,
      ...(stateReasonCode === undefined ? {} : { stateReasonCode }),
      actor: submissionPlan === undefined
        ? { kind: 'human', displayLabel: 'Workspace operator' }
        : {
            kind: 'standing_policy',
            displayLabel: 'Submission confirmation policy',
            policyRevision: {
              reference: {
                key: submissionPlan.policy.key,
                version: submissionPlan.policy.version
              },
              definitionDigestSha256: submissionPlan.policy.digestSha256
            }
          },
      cause: submissionPlan === undefined
        ? {
            summary: 'Committed from an adopted, reviewed decision-notification preview.',
            subjectKind: 'communication_preview',
            subjectRefId: sendPlan!.preview.identity.audienceSpecId,
            subjectVersion: sendPlan!.preview.identity.previewGeneration
          }
        : {
            summary: 'Registered after the public application was received.',
            subjectKind: 'submission',
            subjectRefId: submissionPlan.submissionId,
            subjectVersion: 1
          },
      counts: {
        audience: {
          knowledge: 'known',
          value: submissionPlan === undefined ? sendPlan!.releases.length : 1
        },
        materialized: { knowledge: 'known', value: materialized },
        accepted: { knowledge: 'known', value: accepted },
        delivered: { knowledge: 'not_supported' },
        acceptanceUnknown: { knowledge: 'known', value: acceptanceUnknown },
        knownFailed: { knowledge: 'known', value: knownFailed }
      },
      authorizedAt: instant(link.occurred_at_ms),
      ...(lastObservedAtMs > 0 ? { lastObservedAt: instant(lastObservedAtMs) } : {}),
      availableActions: state === 'known_failed' ? ['continue_provider_setup'] : []
    };
  };

  return Object.freeze({
    async listDeliveryHistory(
      rawScope: { readonly workspaceId: string; readonly eventId: string },
      rawInput: unknown
    ) {
      if (rawScope.workspaceId !== workspaceId) {
        throw new TypeError('d1_communication_delivery_history_scope_mismatch');
      }
      const scope = Object.freeze({
        workspaceId,
        eventId: parseEventId(rawScope.eventId)
      });
      const session = input.database.withSession('first-primary');
      const parsedInput = organizerCommunicationHistoryListInputSchema.safeParse(rawInput ?? {});
      if (!parsedInput.success) return outcome();
      const filters = parsedInput.data;
      const after = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor);
      if (filters.cursor !== undefined && after === undefined) return outcome();
      const limit = Math.min(
        filters.limit ?? ORGANIZER_COMMUNICATION_PAGE_LIMIT,
        ORGANIZER_COMMUNICATION_PAGE_LIMIT
      );
      const conditions = ['l.workspace_id=?', 'l.event_id=?'];
      const bindings: Array<string | number> = [scope.workspaceId, scope.eventId];
      if (filters.messageRefId !== undefined) {
        conditions.push('l.batch_id=?');
        bindings.push(filters.messageRefId);
      }
      if (filters.personRefId !== undefined) {
        conditions.push(`EXISTS (SELECT 1 FROM communication_message_releases release
          WHERE release.workspace_id=l.workspace_id AND release.event_id=l.event_id
            AND release.batch_id=l.batch_id AND release.person_ref_id=?)`);
        bindings.push(filters.personRefId);
      }
      if (after !== undefined) {
        conditions.push('(l.occurred_at_ms<? OR (l.occurred_at_ms=? AND l.commit_id>?))');
        bindings.push(after.occurredAtMs, after.occurredAtMs, after.receiptId);
      }
      bindings.push(limit + 1);
      const links = (await session.prepare(`SELECT l.commit_id AS receipt_id,
          l.batch_id,l.plan_json,l.occurred_at_ms FROM communication_release_commits l
        WHERE ${conditions.join(' AND ')}
        ORDER BY l.occurred_at_ms DESC,l.commit_id ASC LIMIT ?`)
        .bind(...bindings).all<CommitLinkRow>()).results;
      const rows: OrganizerCommunicationHistoryItem[] = [];
      for (const link of links.slice(0, limit)) {
        const item = await historyItem(session, scope, link);
        if (filters.state === undefined || item.state === filters.state) rows.push(item);
      }
      const hasMore = links.length > limit;
      return Object.freeze({
        kind: 'success' as const,
        data: organizerCommunicationHistoryPageSchema.parse({
          schemaVersion: 1,
          visibility: 'organizer_non_security',
          rows,
          page: hasMore
            ? { hasMore: true, nextCursor: encodeCursor(links[limit - 1]!) }
            : { hasMore: false }
        })
      });
    }
  });
}
