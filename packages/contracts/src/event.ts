import { z } from 'zod';
import {
  createOperationSchemaManifestRefs,
  createEffectfulOperationResultSchema,
  createReadOperationResultSchema,
  structuredOutcomeSchema
} from './operations';
import { parseIanaTimezone } from '@jooevents/kernel';

const EVENT_NAME_INPUT_LIMIT = 200;
const EVENT_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealEventDate(value: string): boolean {
  const match = EVENT_DATE.exec(value);
  if (!match || match[1] === '0000') return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function canonicalTimezone(value: string): string | undefined {
  try {
    return parseIanaTimezone(value);
  } catch {
    return undefined;
  }
}

export const eventVersionSchema = z.number().int().positive();
export const eventIdSchema = z.uuid();
export const eventDateSchema = z.string().regex(EVENT_DATE).refine(isRealEventDate);
export const eventNameInputSchema = z.string().trim().min(1).max(EVENT_NAME_INPUT_LIMIT);
export const eventNameSchema = z.string().min(1).max(EVENT_NAME_INPUT_LIMIT).refine((value) =>
  value.normalize('NFC').trim().replace(/\s+/gu, ' ') === value
);
export const eventTimezoneInputSchema = z.string().trim().min(1).max(255).refine((value) =>
  canonicalTimezone(value) !== undefined
);
export const eventTimezoneSchema = z.string().min(1).max(255).refine((value) =>
  canonicalTimezone(value) === value
);

const eventFields = {
  id: eventIdSchema,
  name: eventNameSchema,
  timezone: eventTimezoneSchema,
  startDate: eventDateSchema,
  endDate: eventDateSchema,
  version: eventVersionSchema
} as const;

export const eventSchema = z.strictObject(eventFields).refine(
  (event) => event.endDate >= event.startDate,
  { path: ['endDate'], message: 'end date must not precede start date' }
);

export const currentEventProjectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('no_event'),
    eventSetVersion: eventVersionSchema
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('current_event'),
    eventSetVersion: eventVersionSchema,
    event: eventSchema
  })
]);

/** Current workspace and authority are resolved from verified invocation evidence. */
export const currentEventReadInputSchema = z.strictObject({});

export const currentEventCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('success'),
    data: currentEventProjectionSchema
  }),
  z.strictObject({
    kind: z.literal('outcome'),
    outcome: structuredOutcomeSchema
  })
]);

export const currentEventReadResultSchema =
  createReadOperationResultSchema(currentEventProjectionSchema);

export const eventCreateInputSchema = z.strictObject({
  expectedEventSetVersion: eventVersionSchema,
  name: eventNameInputSchema,
  timezone: eventTimezoneInputSchema,
  startDate: eventDateSchema,
  endDate: eventDateSchema
}).refine(
  (input) => input.endDate >= input.startDate,
  { path: ['endDate'], message: 'end date must not precede start date' }
);

/** Browser draft input; workspace, identity, and base selection resolve server-side. */
export const eventCreateDraftInputSchema = z.strictObject({
  name: eventNameInputSchema,
  timezone: eventTimezoneInputSchema,
  startDate: eventDateSchema,
  endDate: eventDateSchema
}).refine(
  (input) => input.endDate >= input.startDate,
  { path: ['endDate'], message: 'end date must not precede start date' }
);

export const eventCreateSafeDiffSchema = z.strictObject({
  action: z.literal('create'),
  before: z.null(),
  after: eventSchema,
  currentSelection: z.strictObject({
    before: z.null(),
    after: eventIdSchema
  }),
  eventSetVersion: z.strictObject({
    before: eventVersionSchema,
    after: eventVersionSchema
  })
});

export const eventCreateResultSchema = z.strictObject({
  eventSetVersion: eventVersionSchema,
  event: eventSchema
});

export const eventCreateOperationResultSchema =
  createEffectfulOperationResultSchema(eventCreateResultSchema);

/** Exact public schema identities projected into the operator operation manifest. */
export const EVENT_OPERATION_SCHEMA_REFS = Object.freeze({
  currentRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.event.current-read.input',
    inputSchema: currentEventReadInputSchema,
    resultKey: 'schema.event.current-read.operator-result',
    resultSchema: currentEventReadResultSchema
  }),
  create: createOperationSchemaManifestRefs({
    inputKey: 'schema.event.create.input',
    inputSchema: eventCreateInputSchema,
    resultKey: 'schema.event.create.operator-result',
    resultSchema: eventCreateOperationResultSchema
  })
});

export const eventCreationCompensationEligibilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('exact'),
    eventId: eventIdSchema,
    dependencyCount: z.literal(0)
  }),
  z.strictObject({
    kind: z.literal('blocked'),
    eventId: eventIdSchema,
    reason: z.enum([
      'event_set_changed',
      'event_not_selected',
      'event_missing',
      'event_changed',
      'dependencies_present',
      'dependency_evidence_unavailable'
    ]),
    dependencyCount: z.number().int().nonnegative().optional()
  })
]);

export type EventDto = z.infer<typeof eventSchema>;
export type CurrentEventProjection = z.infer<typeof currentEventProjectionSchema>;
export type CurrentEventReadInput = z.infer<typeof currentEventReadInputSchema>;
export type CurrentEventCanonicalResult = z.infer<typeof currentEventCanonicalResultSchema>;
export type CurrentEventReadResult = z.infer<typeof currentEventReadResultSchema>;
export type EventCreateInput = z.infer<typeof eventCreateInputSchema>;
export type EventCreateDraftInput = z.infer<typeof eventCreateDraftInputSchema>;
export type EventCreateSafeDiff = z.infer<typeof eventCreateSafeDiffSchema>;
export type EventCreateResult = z.infer<typeof eventCreateResultSchema>;
export type EventCreateOperationResult = z.infer<typeof eventCreateOperationResultSchema>;
export type EventCreationCompensationEligibility = z.infer<
  typeof eventCreationCompensationEligibilitySchema
>;
