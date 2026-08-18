import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  ORGANIZER_COMMUNICATION_PAGE_LIMIT,
  ORGANIZER_COMMUNICATION_TIMELINE_LIMIT,
  organizerCommunicationAttentionItemSchema,
  organizerCommunicationAttentionListInputSchema,
  organizerCommunicationAttentionPageSchema,
  organizerCommunicationThreadEntrySchema,
  organizerCommunicationThreadGetInputSchema,
  organizerCommunicationThreadPageSchema,
  organizerCommunicationHistoryStateSchema,
  organizerCommunicationTimelineFactSchema,
  organizerCommunicationTimelineGetInputSchema,
  organizerCommunicationTimelinePageSchema,
  structuredOutcomeSchema,
  type StructuredOutcome
} from '@jooevents/contracts';
import {
  sendMessagesAuthorInputSchema,
  type OrganizerCommunicationCanonicalResult,
  type OrganizerCommunicationReadPort,
  type OrganizerCommunicationScope,
  type OrganizerAudiencePreviewReadPort,
  type OrganizerPreviewContactDisclosure
} from '@jooevents/communication-operations';
import type { EmailProviderReadinessReader } from '@jooevents/communications';
import {
  parseSubmissionConfirmationReleasePlan,
  type SubmissionConfirmationReleasePlan
} from '@jooevents/persistence/submission-confirmation-delivery';
import {
  SQLiteCommunicationDeliveryObservationRepository,
  type CommunicationDeliveryDisposition
} from '@jooevents/persistence/communication-delivery-observations';
import { parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import type { z } from 'zod';

type HeadState =
  | 'pending'
  | 'request_started'
  | 'accepted'
  | 'known_rejected_safe_retryable'
  | 'known_rejected_terminal'
  | 'acceptance_unknown';

type CanonicalResult = OrganizerCommunicationCanonicalResult;

function outcome(value: StructuredOutcome): CanonicalResult {
  return Object.freeze({ kind: 'outcome', outcome: structuredOutcomeSchema.parse(value) });
}

function invalidInput(): CanonicalResult {
  return outcome({
    class: 'policy_violation', kind: 'communication.preview_invalid', retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function notFound(): CanonicalResult {
  return outcome({
    class: 'conflict', kind: 'communication.not_found', retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function scope(value: OrganizerCommunicationScope) {
  return Object.freeze({
    workspaceId: parseWorkspaceId(value.workspaceId),
    eventId: parseEventId(value.eventId)
  });
}

function offsetCursor(offset: number): string {
  return `cur1_${offset.toString(36)}`;
}

function readOffset(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return 0;
  const match = /^cur1_([0-9a-z]+)$/u.exec(cursor);
  if (match === null) return undefined;
  const offset = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
}

function actorForPlan(
  plan: ReturnType<typeof sendMessagesAuthorInputSchema.parse> | SubmissionConfirmationReleasePlan
) {
  return 'kind' in plan && plan.kind === 'submission_confirmation'
    ? {
        kind: 'standing_policy',
        displayLabel: 'Submission confirmation policy',
        policyRevision: {
          reference: { key: plan.policy.key, version: plan.policy.version },
          definitionDigestSha256: plan.policy.digestSha256
        }
      }
    : { kind: 'human', displayLabel: 'Workspace operator' };
}

function parsePlan(value: string) {
  const parsed = JSON.parse(value) as unknown;
  const send = sendMessagesAuthorInputSchema.safeParse(parsed);
  if (send.success) return send.data;
  return parseSubmissionConfirmationReleasePlan(parsed);
}

function historyState(
  state: HeadState,
  disposition?: Pick<CommunicationDeliveryDisposition, 'kind'>
): z.infer<typeof organizerCommunicationHistoryStateSchema> {
  if (disposition?.kind === 'delivered') return 'delivered';
  if (disposition?.kind === 'permanent_bounce' || disposition?.kind === 'delivery_failed') {
    return 'known_failed';
  }
  switch (state) {
    case 'pending': return 'materialized';
    case 'request_started': return 'attempting';
    case 'accepted': return 'accepted';
    case 'acceptance_unknown': return 'acceptance_unknown';
    case 'known_rejected_safe_retryable':
    case 'known_rejected_terminal': return 'known_failed';
  }
}

function timelineKind(state: HeadState) {
  switch (state) {
    case 'pending': return 'materialized' as const;
    case 'request_started': return 'attempt_started' as const;
    case 'accepted': return 'provider_accepted' as const;
    case 'acceptance_unknown': return 'acceptance_unknown' as const;
    case 'known_rejected_safe_retryable':
    case 'known_rejected_terminal': return 'known_failed' as const;
  }
}

function summaryCode(state: HeadState): string {
  return `communication.outbound-email.${state.replaceAll('_', '-')}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function createSQLiteCommunicationAttentionSource(input: {
  readonly sqlite: Database;
  readonly authoring: Pick<OrganizerCommunicationReadPort, 'listDrafts'>;
  readonly readiness: EmailProviderReadinessReader;
  readonly history: {
    listDeliveryHistory(scope: OrganizerCommunicationScope, input: unknown): CanonicalResult;
  };
}) {
  const observations = new SQLiteCommunicationDeliveryObservationRepository(input.sqlite);
  return Object.freeze({
    async listAttentionItems(
      rawScope: OrganizerCommunicationScope,
      authorityPrincipalKey: string,
      rawInput: unknown
    ): Promise<CanonicalResult> {
      const selected = scope(rawScope);
      const parsed = organizerCommunicationAttentionListInputSchema.safeParse(rawInput ?? {});
      if (!parsed.success) return invalidInput();
      const offset = readOffset(parsed.data.cursor);
      if (offset === undefined) return invalidInput();
      const limit = Math.min(parsed.data.limit ?? ORGANIZER_COMMUNICATION_PAGE_LIMIT,
        ORGANIZER_COMMUNICATION_PAGE_LIMIT);
      const items: Array<ReturnType<typeof organizerCommunicationAttentionItemSchema.parse>> = [];

      const drafts = await input.authoring.listDrafts(selected, authorityPrincipalKey, {
        state: 'active', limit: ORGANIZER_COMMUNICATION_PAGE_LIMIT
      });
      if (drafts.kind === 'outcome') return drafts;
      const draftRows = (drafts.data as { readonly rows: readonly any[] }).rows;
      for (const draft of draftRows) {
        const estimate = draft.authoring.state === 'ready'
          ? draft.authoring.recipientEstimate
          : undefined;
        items.push(organizerCommunicationAttentionItemSchema.parse({
          schemaVersion: 1,
          visibility: 'organizer_non_security',
          attentionItemId: `attention.draft.${draft.draftId}`,
          severity: 'soon',
          reasonCode: 'draft_awaiting_review',
          summary: 'A message draft is waiting for review.',
          detail: draft.authoring.state === 'ready'
            ? `“${draft.authoring.subject}” has not been sent.`
            : 'The draft still needs content and an audience before it can be reviewed.',
          ...(estimate?.knowledge === 'known'
            ? { affectedCount: estimate }
            : {}),
          recommendedAction: { kind: 'review_draft', draftId: draft.draftId }
        }));
      }

      const readiness = await input.readiness.getReadiness({ workspaceId: selected.workspaceId });
      if (readiness.outbound.state !== 'ready') {
        items.push(organizerCommunicationAttentionItemSchema.parse({
          schemaVersion: 1,
          visibility: 'organizer_non_security',
          attentionItemId: 'attention.provider.outbound',
          severity: 'action',
          reasonCode: 'provider_action_required',
          summary: 'Email sending needs setup.',
          detail: 'Messages stay in JooEvents until an outbound email provider is ready.',
          recommendedAction: { kind: 'continue_provider_setup' }
        }));
      }

      const history = input.history.listDeliveryHistory(selected, {
        state: 'known_failed', limit: ORGANIZER_COMMUNICATION_PAGE_LIMIT
      });
      if (history.kind === 'outcome') return history;
      const historyRows = (history.data as { readonly rows: readonly any[] }).rows;
      for (const row of historyRows) {
        const observedFailure = input.sqlite.query<{ readonly total: number }, [string, string, string]>(`
          SELECT count(DISTINCT h.delivery_id) AS total
            FROM communication_outbound_delivery_heads h
            JOIN communication_message_releases r ON r.release_id=h.release_id
           WHERE h.workspace_id=? AND h.event_id=? AND r.batch_id=?
             AND (
               EXISTS (
                 SELECT 1 FROM communication_delivery_observations d
                  WHERE d.delivery_id=h.delivery_id
                    AND d.observation_kind IN ('permanent_bounce','delivery_failed')
               )
               OR EXISTS (
                 SELECT 1
                   FROM communication_outbound_delivery_attempts a,
                        json_each(a.safe_evidence_json, '$.registeredFacts') fact
                  WHERE a.delivery_id=h.delivery_id
                    AND json_extract(fact.value, '$.factKey')='cloudflare.observation'
                    AND json_extract(fact.value, '$.valueKind')='enum'
                    AND json_extract(fact.value, '$.enumValue')='accepted_permanent_bounce'
               )
             )
        `).get(selected.workspaceId, selected.eventId, row.messageRefId)?.total ?? 0;
        if (observedFailure > 0) continue;
        items.push(organizerCommunicationAttentionItemSchema.parse({
          schemaVersion: 1,
          visibility: 'organizer_non_security',
          attentionItemId: `attention.batch.${row.historyItemId}`,
          severity: 'action',
          reasonCode: 'batch_known_failed',
          summary: 'A message batch failed before provider acceptance.',
          detail: `“${row.subject}” has recorded failures in its delivery evidence.`,
          ...(row.counts.knownFailed.knowledge === 'known'
            ? { affectedCount: row.counts.knownFailed }
            : {}),
          recommendedAction: { kind: 'open_history', historyItemId: row.historyItemId }
        }));
      }

      const bounced = input.sqlite.query<{
        readonly delivery_id: string;
        readonly commit_id: string;
        readonly safe_label: string | null;
      }, [string, string]>(`
        SELECT DISTINCT h.delivery_id,l.commit_id,c.safe_label
          FROM communication_outbound_delivery_heads h
          JOIN communication_message_releases r ON r.release_id=h.release_id
          JOIN communication_release_commits l
            ON l.workspace_id=r.workspace_id AND l.event_id=r.event_id AND l.batch_id=r.batch_id
          LEFT JOIN communication_current_audience_contacts c
            ON c.workspace_id=r.workspace_id AND c.event_id=r.event_id
           AND c.person_ref_id=r.person_ref_id AND c.contact_ref_id=r.contact_ref_id
         WHERE h.workspace_id=? AND h.event_id=?
           AND (
             EXISTS (
               SELECT 1 FROM communication_delivery_observations d
                WHERE d.delivery_id=h.delivery_id AND d.observation_kind='permanent_bounce'
             )
             OR EXISTS (
               SELECT 1
                 FROM communication_outbound_delivery_attempts a,
                      json_each(a.safe_evidence_json, '$.registeredFacts') fact
                WHERE a.delivery_id=h.delivery_id
                  AND json_extract(fact.value, '$.factKey')='cloudflare.observation'
                  AND json_extract(fact.value, '$.valueKind')='enum'
                  AND json_extract(fact.value, '$.enumValue')='accepted_permanent_bounce'
             )
           )
         ORDER BY h.updated_at_ms DESC,h.delivery_id
      `).all(selected.workspaceId, selected.eventId);
      for (const row of bounced) {
        if (observations.currentDisposition(row.delivery_id)?.kind !== 'permanent_bounce') continue;
        items.push(organizerCommunicationAttentionItemSchema.parse({
          schemaVersion: 1,
          visibility: 'organizer_non_security',
          attentionItemId: `attention.bounce.${row.delivery_id}`,
          severity: 'action',
          reasonCode: 'recipient_permanent_bounce',
          summary: 'A recipient address permanently bounced.',
          detail: row.safe_label === null
            ? 'Correct the recipient address before deliberately resending this email.'
            : `${row.safe_label} needs a corrected email address before a deliberate resend.`,
          affectedCount: { knowledge: 'known', value: 1 },
          recommendedAction: { kind: 'open_history', historyItemId: row.commit_id }
        }));
      }

      const filtered = items.filter((item) =>
        (parsed.data.severity === undefined || item.severity === parsed.data.severity)
        && (parsed.data.reasonCode === undefined || item.reasonCode === parsed.data.reasonCode)
      );
      const rows = filtered.slice(offset, offset + limit);
      const hasMore = offset + rows.length < filtered.length;
      return Object.freeze({
        kind: 'success',
        data: organizerCommunicationAttentionPageSchema.parse({
          schemaVersion: 1,
          visibility: 'organizer_non_security',
          rows,
          page: hasMore
            ? { hasMore: true, nextCursor: offsetCursor(offset + rows.length) }
            : { hasMore: false }
        })
      });
    }
  });
}

interface ThreadRow {
  readonly release_id: string;
  readonly delivery_id: string;
  readonly commit_id: string;
  readonly plan_json: string;
  readonly occurred_at_ms: number;
  readonly state: HeadState;
  readonly safe_label: string | null;
  readonly recipient_ref_id: string;
  readonly actor_json: string | null;
  readonly actor_display_name: string | null;
}

export function createSQLiteCommunicationThreadSource(input: {
  readonly sqlite: Database;
  readonly previews: Pick<OrganizerAudiencePreviewReadPort, 'listMessagePreviewRecipients'>;
}) {
  const observations = new SQLiteCommunicationDeliveryObservationRepository(input.sqlite);
  return Object.freeze({
    async getPersonThread(
      rawScope: OrganizerCommunicationScope,
      authorityPrincipalKey: string,
      rawInput: unknown
    ): Promise<CanonicalResult> {
      const selected = scope(rawScope);
      const parsed = organizerCommunicationThreadGetInputSchema.safeParse(rawInput);
      if (!parsed.success) return invalidInput();
      const offset = readOffset(parsed.data.cursor);
      if (offset === undefined) return invalidInput();
      const limit = Math.min(parsed.data.limit ?? ORGANIZER_COMMUNICATION_PAGE_LIMIT,
        ORGANIZER_COMMUNICATION_PAGE_LIMIT);
      const knownPerson = input.sqlite.query<{ readonly safe_label: string }, [string, string, string]>(`
        SELECT safe_label FROM communication_current_audience_contacts
         WHERE workspace_id=? AND event_id=? AND person_ref_id=?
         ORDER BY subject_ref_id LIMIT 1
      `).get(selected.workspaceId, selected.eventId, parsed.data.personRefId);
      const rows = input.sqlite.query<ThreadRow, [string, string, string, number, number]>(`
        SELECT r.release_id,h.delivery_id,r.recipient_ref_id,l.commit_id,l.plan_json,l.occurred_at_ms,h.state,
               o.actor_json,u.display_name AS actor_display_name,
               (SELECT c.safe_label FROM communication_current_audience_contacts c
                 WHERE c.workspace_id=r.workspace_id AND c.event_id=r.event_id
                   AND c.person_ref_id=r.person_ref_id ORDER BY c.subject_ref_id LIMIT 1) AS safe_label
          FROM communication_message_releases r
          JOIN communication_release_commits l
            ON l.workspace_id=r.workspace_id AND l.event_id=r.event_id AND l.batch_id=r.batch_id
          JOIN communication_outbound_delivery_heads h
            ON h.workspace_id=r.workspace_id AND h.event_id=r.event_id AND h.release_id=r.release_id
          LEFT JOIN operation_log o
            ON o.operation_name='send_messages'
           AND json_extract(o.result_json,'$.data.releaseCommitId')=l.commit_id
          LEFT JOIN users u ON u.id=json_extract(o.actor_json,'$.userId')
         WHERE r.workspace_id=? AND r.event_id=? AND r.person_ref_id=?
         ORDER BY l.occurred_at_ms DESC,r.release_id ASC
         LIMIT ? OFFSET ?
      `).all(selected.workspaceId, selected.eventId, parsed.data.personRefId, limit + 1, offset);
      if (knownPerson === undefined && rows.length === 0) return notFound();
      let personLabel = knownPerson?.safe_label ?? rows[0]?.safe_label;
      if (personLabel === undefined || personLabel === null) {
        for (const row of rows) {
          const plan = parsePlan(row.plan_json);
          if ('preview' in plan) {
            const recipients = await input.previews.listMessagePreviewRecipients(
              selected,
              authorityPrincipalKey,
              plan.preview.identity,
              'masked'
            );
            if (recipients.kind === 'success') {
              const resolved = (recipients.data as { readonly rows: ReadonlyArray<{
                readonly recipientResolutionId: string; readonly safeLabel: string
              }> }).rows.find((entry) => entry.recipientResolutionId === row.recipient_ref_id);
              if (resolved) {
                personLabel = resolved.safeLabel;
                break;
              }
            }
          }
        }
      }
      if (personLabel === undefined || personLabel === null) {
        return notFound();
      }
      const chosen = rows.slice(0, limit);
      const entries = chosen.map((row) => {
        const plan = parsePlan(row.plan_json);
        const disposition = observations.currentDisposition(row.delivery_id);
        return organizerCommunicationThreadEntrySchema.parse({
          entryId: row.release_id,
          historyItemId: row.commit_id,
          occurredAt: new Date(row.occurred_at_ms).toISOString(),
          purposeRevision: plan.purposeRevision,
          subject: plan.subject,
          state: historyState(row.state, disposition),
          ...(disposition === undefined ? {} : { deliveryDisposition: disposition.kind }),
          actor: 'kind' in plan && plan.kind === 'submission_confirmation'
            ? actorForPlan(plan)
            : row.actor_json !== null && row.actor_display_name !== null
              ? { kind: 'human', displayLabel: row.actor_display_name }
              : actorForPlan(plan)
        });
      });
      return Object.freeze({
        kind: 'success',
        data: organizerCommunicationThreadPageSchema.parse({
          schemaVersion: 1,
          visibility: 'organizer_non_security',
          personRefId: parsed.data.personRefId,
          personLabel,
          rows: entries,
          page: rows.length > limit
            ? { hasMore: true, nextCursor: offsetCursor(offset + chosen.length) }
            : { hasMore: false }
        })
      });
    }
  });
}

interface TimelineRow {
  readonly delivery_id: string;
  readonly safe_label: string | null;
  readonly recipient_ref_id: string;
  readonly plan_json: string;
  readonly state: HeadState;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly attempt_id: string | null;
  readonly attempt_number: number | null;
  readonly attempt_kind: 'original' | 'marked_resend' | null;
  readonly attempt_state: Exclude<HeadState, 'pending'> | null;
  readonly provider_outcome_reason: string | null;
  readonly recovery_code: 'worker_result_lost' | 'provider_boundary_failure' | null;
  readonly started_at_ms: number | null;
  readonly completed_at_ms: number | null;
  readonly actor_json: string | null;
  readonly actor_display_name: string | null;
}

export function createSQLiteCommunicationTimelineSource(input: {
  readonly sqlite: Database;
  readonly previews: Pick<OrganizerAudiencePreviewReadPort, 'listMessagePreviewRecipients'>;
}) {
  const observations = new SQLiteCommunicationDeliveryObservationRepository(input.sqlite);
  return Object.freeze({
    async getDeliveryTimeline(
      rawScope: OrganizerCommunicationScope,
      authorityPrincipalKey: string,
      rawInput: unknown,
      _disclosure: OrganizerPreviewContactDisclosure
    ): Promise<CanonicalResult> {
      const selected = scope(rawScope);
      const parsed = organizerCommunicationTimelineGetInputSchema.safeParse(rawInput);
      if (!parsed.success) return invalidInput();
      const offset = readOffset(parsed.data.cursor);
      if (offset === undefined) return invalidInput();
      const limit = Math.min(parsed.data.limit ?? ORGANIZER_COMMUNICATION_TIMELINE_LIMIT,
        ORGANIZER_COMMUNICATION_TIMELINE_LIMIT);
      // `deliveryId` is the v1 contract's opaque key. On the page it carries the
      // history row's messageRefId (the release batch), so one expansion can
      // compare every recipient without exposing classified addresses.
      const rows = input.sqlite.query<TimelineRow, [string, string, string]>(`
        SELECT h.delivery_id,r.recipient_ref_id,l.plan_json,c.safe_label,h.state,h.created_at_ms,h.updated_at_ms,
               a.attempt_id,a.attempt_number,a.attempt_kind,a.state AS attempt_state,
               a.provider_outcome_reason,a.recovery_code,a.started_at_ms,a.completed_at_ms,
               o.actor_json,u.display_name AS actor_display_name
          FROM communication_message_releases r
          JOIN communication_outbound_delivery_heads h
            ON h.workspace_id=r.workspace_id AND h.event_id=r.event_id AND h.release_id=r.release_id
          JOIN communication_release_commits l
            ON l.workspace_id=r.workspace_id AND l.event_id=r.event_id AND l.batch_id=r.batch_id
          LEFT JOIN communication_current_audience_contacts c
            ON c.workspace_id=r.workspace_id AND c.event_id=r.event_id
           AND c.person_ref_id=r.person_ref_id AND c.contact_ref_id=r.contact_ref_id
          LEFT JOIN communication_outbound_delivery_attempts a ON a.delivery_id=h.delivery_id
          LEFT JOIN operation_log o
            ON o.operation_name='send_messages'
           AND json_extract(o.result_json,'$.data.releaseCommitId')=l.commit_id
          LEFT JOIN users u ON u.id=json_extract(o.actor_json,'$.userId')
         WHERE r.workspace_id=? AND r.event_id=? AND r.batch_id=?
         ORDER BY r.release_id ASC,a.attempt_number ASC
      `).all(selected.workspaceId, selected.eventId, parsed.data.deliveryId);
      if (rows.length === 0) return notFound();
      const safeLabels = new Map(rows.flatMap((row) => row.safe_label === null
        ? [] : [[row.recipient_ref_id, row.safe_label] as const]));
      if (safeLabels.size < new Set(rows.map((row) => row.recipient_ref_id)).size) {
        const plan = parsePlan(rows[0]!.plan_json);
        if ('preview' in plan) {
          const recipients = await input.previews.listMessagePreviewRecipients(
            selected,
            authorityPrincipalKey,
            plan.preview.identity,
            'masked'
          );
          if (recipients.kind === 'success') {
            for (const recipient of (recipients.data as { readonly rows: ReadonlyArray<{
              readonly recipientResolutionId: string; readonly safeLabel: string
            }> }).rows) {
              safeLabels.set(recipient.recipientResolutionId, recipient.safeLabel);
            }
          }
        }
      }
      if (rows.some((row) => !safeLabels.has(row.recipient_ref_id))) {
        return notFound();
      }
      const deliveryRows = [...new Map(rows.map((row) => [row.delivery_id, row])).values()];
      const dispositions = new Map(deliveryRows.map((row) => [
        row.delivery_id, observations.currentDisposition(row.delivery_id)
      ]));
      const states = new Set(deliveryRows.map((row) =>
        historyState(row.state, dispositions.get(row.delivery_id))
      ));
      const currentState: z.infer<typeof organizerCommunicationHistoryStateSchema> = states.has('attempting')
        ? 'attempting'
        : states.has('materialized')
          ? 'materialized'
          : states.has('acceptance_unknown')
            ? 'acceptance_unknown'
            : states.has('known_failed')
              ? 'known_failed'
              : states.size === 1 && states.has('delivered')
                ? 'delivered'
                : 'accepted';
      const attemptFacts = rows.map((row) => {
        const plan = parsePlan(row.plan_json);
        return {
          factId: row.attempt_id ?? `materialized.${row.delivery_id}`,
          occurredAt: new Date(row.started_at_ms ?? row.created_at_ms).toISOString(),
          kind: row.attempt_state === null ? timelineKind(row.state) : timelineKind(row.attempt_state),
          summaryCode: summaryCode(row.attempt_state ?? row.state),
          actor: 'kind' in plan && plan.kind === 'submission_confirmation'
            ? actorForPlan(plan)
            : row.actor_json !== null && row.actor_display_name !== null
              ? { kind: 'human', displayLabel: row.actor_display_name }
              : actorForPlan(plan),
          evidenceDigestSha256: digest({
            deliveryId: row.delivery_id,
            state: row.state,
            attemptId: row.attempt_id,
            attemptState: row.attempt_state,
            updatedAtMs: row.updated_at_ms
          }),
          recipient: {
            deliveryId: row.delivery_id,
            safeLabel: safeLabels.get(row.recipient_ref_id)!,
            state: row.state
          },
          ...(row.attempt_number === null ? {} : {
            attempt: {
              attemptNumber: row.attempt_number,
              attemptKind: row.attempt_kind!,
              state: row.attempt_state!,
              ...(row.provider_outcome_reason === null
                ? {}
                : { providerOutcomeReason: row.provider_outcome_reason }),
              ...(row.recovery_code === null ? {} : { recoveryCode: row.recovery_code }),
              startedAt: new Date(row.started_at_ms!).toISOString(),
              ...(row.completed_at_ms === null
                ? {}
                : { completedAt: new Date(row.completed_at_ms).toISOString() })
            }
          })
        };
      });
      const observationFacts = deliveryRows.flatMap((row) => {
        const plan = parsePlan(row.plan_json);
        const actor = 'kind' in plan && plan.kind === 'submission_confirmation'
          ? actorForPlan(plan)
          : row.actor_json !== null && row.actor_display_name !== null
            ? { kind: 'human' as const, displayLabel: row.actor_display_name }
            : actorForPlan(plan);
        return observations.list(row.delivery_id).map((observation) => ({
          factId: observation.observationId,
          occurredAt: observation.providerObservedAt ?? observation.ingestedAt,
          kind: observation.kind === 'delivered' ? 'delivery_confirmed' as const : 'known_failed' as const,
          summaryCode: `communication.delivery.${observation.kind.replaceAll('_', '-')}`,
          actor,
          evidenceDigestSha256: observation.providerEventDigestSha256,
          recipient: {
            deliveryId: row.delivery_id,
            safeLabel: safeLabels.get(row.recipient_ref_id)!,
            state: observation.kind
          }
        }));
      });
      const ordered = [...attemptFacts, ...observationFacts].sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) || left.factId.localeCompare(right.factId)
      );
      const chosen = ordered.slice(offset, offset + limit);
      const facts = chosen.map((fact, index) => organizerCommunicationTimelineFactSchema.parse({
        ...fact, sequence: offset + index + 1
      }));
      return Object.freeze({
        kind: 'success',
        data: organizerCommunicationTimelinePageSchema.parse({
          schemaVersion: 1,
          visibility: 'organizer_non_security',
          deliveryId: parsed.data.deliveryId,
          currentState,
          rows: facts,
          page: offset + chosen.length < ordered.length
            ? { hasMore: true, nextCursor: offsetCursor(offset + chosen.length) }
            : { hasMore: false }
        })
      });
    }
  });
}
