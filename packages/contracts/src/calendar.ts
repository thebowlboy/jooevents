import { z } from 'zod';
import { engagementHeadSchema } from './engagements';
import { deadlineChangedFactPayloadSchema } from './deadlines';
import { schedulePlacementOccurrenceSchema } from './schedule-placement';
import { sessionHeadSchema } from './sessions';

const applicationIdSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  'application ids use canonical lowercase bytes'
);
const canonicalInstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith('Z') && value.includes('.'),
  'calendar facts use canonical UTC millisecond instants'
);
const canonicalText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ') === value);

export const calendarScopeSchema = z.strictObject({
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema
});

export const calendarOccurrenceChangedFactPayloadSchema = z.strictObject({
  action: z.enum(['place', 'move', 'unplace']),
  occurrenceId: applicationIdSchema,
  occurrence: schedulePlacementOccurrenceSchema.nullable()
}).superRefine((payload, context) => {
  if ((payload.action === 'unplace') !== (payload.occurrence === null)) {
    context.addIssue({
      code: 'custom',
      path: ['occurrence'],
      message: 'only an unplace fact omits the current occurrence image'
    });
  }
  if (payload.occurrence !== null && payload.occurrence.id !== payload.occurrenceId) {
    context.addIssue({
      code: 'custom',
      path: ['occurrence', 'id'],
      message: 'the occurrence image must match the fact identity'
    });
  }
});

export const calendarEngagementChangedFactPayloadSchema = z.strictObject({
  engagement: engagementHeadSchema
});

export const calendarSessionChangedFactPayloadSchema = z.strictObject({
  sessionId: applicationIdSchema,
  session: sessionHeadSchema.nullable()
}).superRefine((payload, context) => {
  if (payload.session !== null && payload.session.id !== payload.sessionId) {
    context.addIssue({
      code: 'custom',
      path: ['session', 'id'],
      message: 'the session image must match the fact identity'
    });
  }
});

export const calendarRoomChangedFactPayloadSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.enum(['create', 'edit']),
    roomId: applicationIdSchema,
    name: canonicalText(120),
    version: z.number().int().positive().safe()
  }),
  z.strictObject({
    action: z.enum(['retire', 'restore']),
    roomId: applicationIdSchema,
    status: z.enum(['active', 'retired']),
    version: z.number().int().positive().safe()
  }),
  z.strictObject({
    action: z.literal('delete'),
    roomId: applicationIdSchema
  }),
  z.strictObject({
    action: z.literal('merge'),
    sourceRoomId: applicationIdSchema,
    targetRoomId: applicationIdSchema
  })
]);

export const calendarCommitmentFactPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('occurrence_changed'),
    version: z.literal(1),
    data: calendarOccurrenceChangedFactPayloadSchema
  }),
  z.strictObject({
    kind: z.literal('engagement_changed'),
    version: z.literal(1),
    data: calendarEngagementChangedFactPayloadSchema
  }),
  z.strictObject({
    kind: z.literal('session_changed'),
    version: z.literal(1),
    data: calendarSessionChangedFactPayloadSchema
  }),
  z.strictObject({
    kind: z.literal('room_changed'),
    version: z.literal(1),
    data: calendarRoomChangedFactPayloadSchema
  }),
  z.strictObject({
    kind: z.literal('deadline_changed'),
    version: z.literal(1),
    data: deadlineChangedFactPayloadSchema
  })
]);

/** Pure operation-owned batch before the transaction adapter assigns source ordinals. */
export const calendarOperationFactBatchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: calendarScopeSchema,
  occurredAt: canonicalInstantSchema,
  facts: z.array(calendarCommitmentFactPayloadSchema).min(1).max(1_000)
}).superRefine((batch, context) => {
  for (const [index, fact] of batch.facts.entries()) {
    const sourceScope = fact.kind === 'engagement_changed'
      ? fact.data.engagement.scope
      : fact.kind === 'session_changed' && fact.data.session !== null
        ? fact.data.session.scope
        : undefined;
    if (sourceScope && (sourceScope.workspaceId !== batch.scope.workspaceId
        || sourceScope.eventId !== batch.scope.eventId)) {
      context.addIssue({
        code: 'custom', path: ['facts', index, 'data'],
        message: 'a complete source image must match the calendar fact batch scope'
      });
    }
  }
});

/** Immutable intake identity is the successful operation-log row plus a batch ordinal. */
export const calendarCommitmentFactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.strictObject({
    operationLogId: applicationIdSchema,
    ordinal: z.number().int().nonnegative().max(999)
  }),
  scope: calendarScopeSchema,
  occurredAt: canonicalInstantSchema,
  fact: calendarCommitmentFactPayloadSchema
}).superRefine((candidate, context) => {
  const sourceScope = candidate.fact.kind === 'engagement_changed'
    ? candidate.fact.data.engagement.scope
    : candidate.fact.kind === 'session_changed' && candidate.fact.data.session !== null
      ? candidate.fact.data.session.scope
      : undefined;
  if (sourceScope && (sourceScope.workspaceId !== candidate.scope.workspaceId
      || sourceScope.eventId !== candidate.scope.eventId)) {
    context.addIssue({
      code: 'custom', path: ['fact', 'data'],
      message: 'a complete source image must match the calendar fact scope'
    });
  }
});

export type CalendarScope = z.infer<typeof calendarScopeSchema>;
export type CalendarOccurrenceChangedFactPayload =
  z.infer<typeof calendarOccurrenceChangedFactPayloadSchema>;
export type CalendarEngagementChangedFactPayload =
  z.infer<typeof calendarEngagementChangedFactPayloadSchema>;
export type CalendarSessionChangedFactPayload =
  z.infer<typeof calendarSessionChangedFactPayloadSchema>;
export type CalendarRoomChangedFactPayload = z.infer<typeof calendarRoomChangedFactPayloadSchema>;
export type CalendarCommitmentFactPayload = z.infer<typeof calendarCommitmentFactPayloadSchema>;
export type CalendarOperationFactBatch = z.infer<typeof calendarOperationFactBatchSchema>;
export type CalendarCommitmentFact = z.infer<typeof calendarCommitmentFactSchema>;
