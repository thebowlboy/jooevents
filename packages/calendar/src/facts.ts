import {
  calendarCommitmentFactSchema,
  calendarOperationFactBatchSchema,
  type CalendarCommitmentFact,
  type CalendarOperationFactBatch
} from '@jooevents/contracts/calendar';

export function materializeCalendarCommitmentFacts(input: {
  readonly operationLogId: string;
  readonly batch: CalendarOperationFactBatch;
}): readonly CalendarCommitmentFact[] {
  const batch = calendarOperationFactBatchSchema.parse(input.batch);
  return Object.freeze(batch.facts.map((fact, ordinal) => calendarCommitmentFactSchema.parse({
    schemaVersion: 1,
    source: { operationLogId: input.operationLogId, ordinal },
    scope: batch.scope,
    occurredAt: batch.occurredAt,
    fact
  })));
}
