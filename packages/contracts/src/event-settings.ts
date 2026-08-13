import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';
import { changesetApplicationIdSchema } from './changeset-operations';
import {
  eventDateSchema,
  eventIdSchema,
  eventNameInputSchema,
  eventNameSchema,
  eventTimezoneInputSchema,
  eventTimezoneSchema,
  eventVersionSchema
} from './event';

const EVENT_LOCATION_LIMIT = 500;
const EVENT_VENUE_NOTE_LIMIT = 8_000;
const DIGEST = /^[a-f0-9]{64}$/;
const APPLICATION_UUID_CANONICAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalizeSingleLine(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function normalizeMultiline(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function acceptedText(
  value: string,
  limit: number,
  normalize: (value: string) => string,
  multiline: boolean
): boolean {
  if (!hasOnlyUnicodeScalars(value)) return false;
  const lineNormalized = value.replace(/\r\n?/gu, '\n').normalize('NFC');
  const forbidden = multiline
    ? /[\u0000-\u0009\u000b-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  return !forbidden.test(lineNormalized) && normalize(value).length <= limit;
}

function normalizedTextInput(
  limit: number,
  normalize: (value: string) => string,
  multiline: boolean
): z.ZodType<string> {
  return z.string()
    .refine((value) => acceptedText(value, limit, normalize, multiline))
    .overwrite(normalize);
}

function canonicalText(
  limit: number,
  normalize: (value: string) => string,
  multiline: boolean
): z.ZodType<string> {
  return z.string().max(limit).refine((value) =>
    acceptedText(value, limit, normalize, multiline) && normalize(value) === value
  );
}

export const eventSettingsLocationInputSchema = normalizedTextInput(
  EVENT_LOCATION_LIMIT,
  normalizeSingleLine,
  false
);
export const eventSettingsLocationSchema = canonicalText(
  EVENT_LOCATION_LIMIT,
  normalizeSingleLine,
  false
);
export const eventSettingsVenueNoteInputSchema = normalizedTextInput(
  EVENT_VENUE_NOTE_LIMIT,
  normalizeMultiline,
  true
);
export const eventSettingsVenueNoteSchema = canonicalText(
  EVENT_VENUE_NOTE_LIMIT,
  normalizeMultiline,
  true
);

/** Semantically named scope identities; both use the canonical application-ID wire format. */
export const eventSettingsWorkspaceIdSchema = z.string().regex(APPLICATION_UUID_CANONICAL);
export const eventSettingsEventIdSchema = z.string().regex(APPLICATION_UUID_CANONICAL);

export const eventSettingsScopeSchema = z.strictObject({
  workspaceId: eventSettingsWorkspaceIdSchema,
  eventId: eventSettingsEventIdSchema
});

const settingsValueFields = {
  name: eventNameSchema,
  timezone: eventTimezoneSchema,
  startDate: eventDateSchema,
  endDate: eventDateSchema,
  location: eventSettingsLocationSchema,
  venueNote: eventSettingsVenueNoteSchema
} as const;

export const eventSettingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: eventIdSchema,
  eventSetVersion: eventVersionSchema,
  eventVersion: eventVersionSchema,
  ...settingsValueFields
}).refine((settings) => settings.endDate >= settings.startDate, {
  path: ['endDate'],
  message: 'end date must not precede start date'
});

export const currentEventSettingsReadInputSchema = z.strictObject({});
export const eventSettingsEventRequiredOutcomeSchema = z.strictObject({
  class: z.literal('conflict'),
  kind: z.literal('event.settings.event_required'),
  retryable: z.literal(false),
  subjects: z.tuple([]),
  detail: z.null(),
  detailSchemaVersion: z.literal(1)
});
export const currentEventSettingsCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: eventSettingsSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const currentEventSettingsReadResultSchema =
  createReadOperationResultSchema(eventSettingsSchema);

export const eventSettingsUpdateDraftInputSchema = z.strictObject({
  expectedEventId: eventIdSchema,
  expectedEventSetVersion: eventVersionSchema,
  expectedEventVersion: eventVersionSchema,
  name: eventNameInputSchema,
  timezone: eventTimezoneInputSchema,
  startDate: eventDateSchema,
  endDate: eventDateSchema,
  location: eventSettingsLocationInputSchema,
  venueNote: eventSettingsVenueNoteInputSchema
}).refine((input) => input.endDate >= input.startDate, {
  path: ['endDate'],
  message: 'end date must not precede start date'
});

export const eventSettingsUpdateAuthorInputSchema = z.strictObject({
  scope: eventSettingsScopeSchema,
  request: eventSettingsUpdateDraftInputSchema
});

export const eventSettingsSafeDiffSchema = z.strictObject({
  action: z.literal('update'),
  before: eventSettingsSchema,
  after: eventSettingsSchema,
  selection: z.strictObject({
    eventId: eventIdSchema,
    eventSetVersion: eventVersionSchema
  })
}).superRefine((diff, context) => {
  if (diff.before.eventId !== diff.after.eventId
      || diff.before.eventId !== diff.selection.eventId
      || diff.before.eventSetVersion !== diff.after.eventSetVersion
      || diff.before.eventSetVersion !== diff.selection.eventSetVersion
      || diff.after.eventVersion !== diff.before.eventVersion + 1) {
    context.addIssue({ code: 'custom', message: 'Event settings diff versions are incoherent.' });
  }
});

export const eventSettingsUpdateResultSchema = eventSettingsSchema;

export const eventSettingsUpdateDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('update'),
  changesetId: changesetApplicationIdSchema,
  headVersion: eventVersionSchema,
  status: z.literal('draft'),
  revision: z.strictObject({
    id: changesetApplicationIdSchema,
    number: eventVersionSchema,
    digestSha256: z.string().regex(DIGEST)
  }),
  riskTier: z.enum(['low', 'normal', 'consequential']),
  approvalPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: z.string().regex(DIGEST),
    requirement: z.enum(['none', 'distinct_current_human'])
  }),
  safeDiff: eventSettingsSafeDiffSchema
});

export const eventSettingsUpdateDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: eventSettingsUpdateDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const eventSettingsUpdateDraftOperationResultSchema =
  createEffectfulOperationResultSchema(eventSettingsUpdateDraftDataSchema);

export const EVENT_SETTINGS_OPERATION_SCHEMA_REFS = Object.freeze({
  currentRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.event_settings.current-read.input',
    inputSchema: currentEventSettingsReadInputSchema,
    resultKey: 'schema.event_settings.current-read.operator-result',
    resultSchema: currentEventSettingsReadResultSchema
  }),
  updateDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.event_settings.update-draft.input',
    inputSchema: eventSettingsUpdateDraftInputSchema,
    resultKey: 'schema.event_settings.update-draft.operator-result',
    resultSchema: eventSettingsUpdateDraftOperationResultSchema
  })
});

export type EventSettingsScope = z.infer<typeof eventSettingsScopeSchema>;
export type EventSettingsDto = z.infer<typeof eventSettingsSchema>;
export type CurrentEventSettingsReadInput = z.infer<typeof currentEventSettingsReadInputSchema>;
export type CurrentEventSettingsReadResult = z.infer<typeof currentEventSettingsReadResultSchema>;
export type EventSettingsUpdateDraftInput = z.infer<typeof eventSettingsUpdateDraftInputSchema>;
export type EventSettingsUpdateAuthorInput = z.infer<typeof eventSettingsUpdateAuthorInputSchema>;
export type EventSettingsSafeDiff = z.infer<typeof eventSettingsSafeDiffSchema>;
export type EventSettingsUpdateResult = z.infer<typeof eventSettingsUpdateResultSchema>;
export type EventSettingsUpdateDraftData = z.infer<typeof eventSettingsUpdateDraftDataSchema>;
export type EventSettingsUpdateDraftOperationResult = z.infer<
  typeof eventSettingsUpdateDraftOperationResultSchema
>;
