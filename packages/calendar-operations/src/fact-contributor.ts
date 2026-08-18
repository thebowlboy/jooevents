import type { DirectOperationFeatureContributor } from '@jooevents/application';
import type { CalendarCommitmentFactPayload, CalendarOperationFactBatch } from '@jooevents/contracts/calendar';
import {
  engagementChangeCanonicalResultSchema,
  decisionDecideCanonicalResultSchema,
  programVocabularyCreateDraftRequestSchema,
  programVocabularyDeleteDraftRequestSchema,
  programVocabularyDirectCanonicalResultSchema,
  programVocabularyEditDraftRequestSchema,
  programVocabularyMergePublishCanonicalResultSchema,
  programVocabularyRestoreDraftRequestSchema,
  programVocabularyRetireDraftRequestSchema,
  scheduleOccurrencePlacementResultSchema,
  schedulePlacementAuthorInputSchema,
  sessionDirectInputSchema
} from '@jooevents/contracts';
import { deadlineChangeCanonicalResultSchema } from '@jooevents/contracts/deadlines';
import { calendarOperationFactBatchSchema } from '@jooevents/contracts/calendar';
import { DECISION_DECIDE_OPERATION } from '@jooevents/decision-operations';
import { DEADLINE_CHANGE_OPERATION } from '@jooevents/deadline-operations';
import {
  ENGAGEMENT_CHANGE_OPERATION,
  PORTAL_ENGAGEMENT_RESPOND_OPERATION,
  participantEngagementRespondCanonicalResultSchema
} from '@jooevents/engagement-operations';
import {
  PROGRAM_VOCABULARY_CREATE_OPERATION,
  PROGRAM_VOCABULARY_DELETE_OPERATION,
  PROGRAM_VOCABULARY_EDIT_OPERATION,
  PROGRAM_VOCABULARY_MERGE_OPERATION,
  PROGRAM_VOCABULARY_RESTORE_OPERATION,
  PROGRAM_VOCABULARY_RETIRE_OPERATION
} from '@jooevents/program-operations';
import { SCHEDULE_PLACEMENT_OPERATION } from '@jooevents/schedule-operations';
import { SESSION_CHANGE_OPERATION, sessionDirectCanonicalResultSchema } from '@jooevents/session-operations';

export const CALENDAR_COMMITMENT_FACT_CONTRIBUTOR = Object.freeze({
  key: 'feature.calendar.commitment-facts',
  version: 1
});

function operationKey(operation: Readonly<{ name: string; version: number }>): string {
  return `${operation.name}@${operation.version}`;
}

function occurrenceFact(input: Parameters<DirectOperationFeatureContributor['contribute']>[0]): CalendarCommitmentFactPayload | undefined {
  const canonical = input.canonicalResult as { readonly kind?: unknown; readonly data?: unknown };
  if (canonical.kind !== 'success') return undefined;
  const parsedPlacement = scheduleOccurrencePlacementResultSchema.safeParse(canonical.data);
  if (!parsedPlacement.success) return undefined;
  const placement = parsedPlacement.data;
  const author = schedulePlacementAuthorInputSchema.parse(input.businessInput);
  if (author.action !== placement.action) throw new TypeError('calendar_schedule_action_mismatch');
  if (!('occurrenceId' in author) && placement.occurrence === null) {
    throw new TypeError('calendar_schedule_result_missing_occurrence');
  }
  return {
    kind: 'occurrence_changed', version: 1,
    data: {
      action: placement.action,
      occurrenceId: placement.occurrence?.id ?? ('occurrenceId' in author ? author.occurrenceId : ''),
      occurrence: placement.occurrence
    }
  };
}

function roomFact(input: Parameters<DirectOperationFeatureContributor['contribute']>[0]): CalendarCommitmentFactPayload | undefined {
  const key = operationKey(input.operation);
  if (key === operationKey(PROGRAM_VOCABULARY_MERGE_OPERATION)) {
    const result = programVocabularyMergePublishCanonicalResultSchema.parse(input.canonicalResult);
    if (result.kind !== 'success' || result.data.kind !== 'room') return undefined;
    if (result.data.action !== 'merge') throw new TypeError('calendar_room_action_mismatch');
    const [sourceRoomId, targetRoomId] = result.data.affectedIds;
    if (!sourceRoomId || !targetRoomId) throw new TypeError('calendar_room_merge_identity_missing');
    return { kind: 'room_changed', version: 1, data: { action: 'merge', sourceRoomId, targetRoomId } };
  }
  const result = programVocabularyDirectCanonicalResultSchema.parse(input.canonicalResult);
  if (result.kind !== 'success' || result.data.kind !== 'room') return undefined;
  const roomId = result.data.affectedIds[0];
  if (!roomId) throw new TypeError('calendar_room_identity_missing');
  if (key === operationKey(PROGRAM_VOCABULARY_CREATE_OPERATION)) {
    if (result.data.action !== 'create') throw new TypeError('calendar_room_action_mismatch');
    const request = programVocabularyCreateDraftRequestSchema.parse(input.businessInput);
    if (request.kind !== 'room') return undefined;
    return { kind: 'room_changed', version: 1, data: { action: 'create', roomId, name: request.name, version: 1 } };
  }
  if (key === operationKey(PROGRAM_VOCABULARY_EDIT_OPERATION)) {
    if (result.data.action !== 'edit') throw new TypeError('calendar_room_action_mismatch');
    const request = programVocabularyEditDraftRequestSchema.parse(input.businessInput);
    if (request.kind !== 'room') return undefined;
    return { kind: 'room_changed', version: 1, data: {
      action: 'edit', roomId, name: request.changes.name, version: request.expectedItemVersion + 1
    } };
  }
  if (key === operationKey(PROGRAM_VOCABULARY_RETIRE_OPERATION)) {
    if (result.data.action !== 'retire') throw new TypeError('calendar_room_action_mismatch');
    const request = programVocabularyRetireDraftRequestSchema.parse(input.businessInput);
    if (request.kind !== 'room') return undefined;
    return { kind: 'room_changed', version: 1, data: {
      action: 'retire', roomId, status: 'retired', version: request.expectedItemVersion + 1
    } };
  }
  if (key === operationKey(PROGRAM_VOCABULARY_RESTORE_OPERATION)) {
    if (result.data.action !== 'restore') throw new TypeError('calendar_room_action_mismatch');
    const request = programVocabularyRestoreDraftRequestSchema.parse(input.businessInput);
    if (request.kind !== 'room') return undefined;
    return { kind: 'room_changed', version: 1, data: {
      action: 'restore', roomId, status: 'active', version: request.expectedItemVersion + 1
    } };
  }
  if (key === operationKey(PROGRAM_VOCABULARY_DELETE_OPERATION)) {
    if (result.data.action !== 'delete') throw new TypeError('calendar_room_action_mismatch');
    const request = programVocabularyDeleteDraftRequestSchema.parse(input.businessInput);
    if (request.kind !== 'room') return undefined;
    return { kind: 'room_changed', version: 1, data: { action: 'delete', roomId } };
  }
  return undefined;
}

export function createCalendarCommitmentFactContributor(): DirectOperationFeatureContributor {
  const supportedRoomOperations = new Set([
    PROGRAM_VOCABULARY_CREATE_OPERATION,
    PROGRAM_VOCABULARY_EDIT_OPERATION,
    PROGRAM_VOCABULARY_RETIRE_OPERATION,
    PROGRAM_VOCABULARY_RESTORE_OPERATION,
    PROGRAM_VOCABULARY_DELETE_OPERATION,
    PROGRAM_VOCABULARY_MERGE_OPERATION
  ].map(operationKey));
  return Object.freeze({
    reference: CALENDAR_COMMITMENT_FACT_CONTRIBUTOR,
    contribute(input: Parameters<DirectOperationFeatureContributor['contribute']>[0]): CalendarOperationFactBatch | undefined {
      let facts: readonly CalendarCommitmentFactPayload[] = [];
      const key = operationKey(input.operation);
      if (key === operationKey(SCHEDULE_PLACEMENT_OPERATION)) {
        const fact = occurrenceFact(input);
        if (fact) facts = [fact];
      } else if (key === operationKey(ENGAGEMENT_CHANGE_OPERATION)) {
        const result = engagementChangeCanonicalResultSchema.parse(input.canonicalResult);
        if (result.kind === 'success') {
          facts = [{ kind: 'engagement_changed', version: 1, data: { engagement: result.data.engagement } }];
        }
      } else if (key === operationKey(PORTAL_ENGAGEMENT_RESPOND_OPERATION)) {
        const result = participantEngagementRespondCanonicalResultSchema.parse(input.canonicalResult);
        if (result.kind === 'success') {
          facts = result.data.changedEngagements.map((engagement) => ({
            kind: 'engagement_changed' as const,
            version: 1 as const,
            data: { engagement }
          }));
        }
      } else if (key === operationKey(DECISION_DECIDE_OPERATION)) {
        const result = decisionDecideCanonicalResultSchema.parse(input.canonicalResult);
        if (result.kind === 'success') {
          facts = result.data.sessions.map((change) => {
            const sessionId = change.session?.id;
            if (!sessionId) throw new TypeError('calendar_decision_session_identity_missing');
            return {
              kind: 'session_changed' as const,
              version: 1 as const,
              data: { sessionId, session: change.session }
            };
          });
        }
      } else if (key === operationKey(SESSION_CHANGE_OPERATION)) {
        const result = sessionDirectCanonicalResultSchema.parse(input.canonicalResult);
        if (result.kind === 'success') {
          const sessionId = result.data.session?.id;
          if (!sessionId) {
            const business = sessionDirectInputSchema.parse(input.businessInput);
            if (!('sessionId' in business)) throw new TypeError('calendar_session_identity_missing');
            facts = [{ kind: 'session_changed', version: 1, data: { sessionId: business.sessionId, session: null } }];
          } else {
            facts = [{ kind: 'session_changed', version: 1, data: { sessionId, session: result.data.session } }];
          }
        }
      } else if (key === operationKey(DEADLINE_CHANGE_OPERATION)) {
        const result = deadlineChangeCanonicalResultSchema.parse(input.canonicalResult);
        if (result.kind === 'success') {
          const deadline = result.data.deadline;
          facts = [{
            kind: 'deadline_changed', version: 1, data: {
              action: result.data.action,
              deadlineId: deadline.id,
              version: deadline.version,
              status: deadline.status,
              displayDate: deadline.displayDate,
              effectiveAt: deadline.effectiveAt
            }
          }];
        }
      } else if (supportedRoomOperations.has(key)) {
        const fact = roomFact(input);
        if (fact) facts = [fact];
      }
      if (facts.length === 0) return undefined;
      if (!input.scope.eventId) throw new TypeError('calendar_fact_event_scope_required');
      return calendarOperationFactBatchSchema.parse({
        schemaVersion: 1,
        scope: { workspaceId: input.scope.workspaceId, eventId: input.scope.eventId },
        occurredAt: input.occurredAt,
        facts
      });
    }
  });
}
