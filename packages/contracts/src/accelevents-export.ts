import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema
} from './operations';

export const acceleventsSessionTypeSchema = z.enum(['IN_PERSON', 'VIRTUAL', 'HYBRID']);
export const acceleventsRemoteFormatSchema = z.enum([
  'REGULAR_SESSION', 'MAIN_STAGE_SESSION', 'WORKSHOP', 'MEET_UP', 'BREAK', 'OTHER', 'EXPO'
]);

const idSchema = z.uuid();
const nameSchema = z.string().trim().min(1).max(300);

export const acceleventsFormatMappingSchema = z.strictObject({
  formatId: idSchema,
  remoteFormat: acceleventsRemoteFormatSchema
});
export const acceleventsSpeakerNameSchema = z.strictObject({
  personId: idSchema,
  firstName: z.string().trim().max(160),
  lastName: z.string().trim().max(160)
});
export const acceleventsRoomBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ roomId: idSchema, kind: z.literal('remote'), locationId: z.number().int().positive().safe() }),
  z.strictObject({ roomId: idSchema, kind: z.literal('no_location') })
]);
export const acceleventsPrimarySpeakerSchema = z.strictObject({
  occurrenceId: idSchema,
  personId: idSchema
});

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}

export const acceleventsExportConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: idSchema,
  version: z.number().int().nonnegative().safe(),
  selectedReleaseId: idSchema.nullable(),
  sessionType: acceleventsSessionTypeSchema.nullable(),
  formatMappings: z.array(acceleventsFormatMappingSchema).max(1000),
  speakerNames: z.array(acceleventsSpeakerNameSchema).max(10_000),
  roomBindings: z.array(acceleventsRoomBindingSchema).max(1000),
  primarySpeakers: z.array(acceleventsPrimarySpeakerSchema).max(10_000),
  updatedAt: z.iso.datetime({ offset: true }).nullable()
}).superRefine((value, context) => {
  const groups: readonly [readonly unknown[], (item: never) => string, string][] = [
    [value.formatMappings, (item: { formatId: string }) => item.formatId, 'formatMappings'],
    [value.speakerNames, (item: { personId: string }) => item.personId, 'speakerNames'],
    [value.roomBindings, (item: { roomId: string }) => item.roomId, 'roomBindings'],
    [value.primarySpeakers, (item: { occurrenceId: string }) => item.occurrenceId, 'primarySpeakers']
  ];
  for (const [items, key, path] of groups) {
    if (!uniqueBy(items as readonly never[], key)) {
      context.addIssue({ code: 'custom', path: [path], message: `${path} must be unique` });
    }
  }
});

export const acceleventsReleaseOptionSchema = z.strictObject({
  id: idSchema,
  number: z.number().int().positive().safe(),
  releasedAt: z.iso.datetime({ offset: true }),
  sessionCount: z.number().int().nonnegative().safe(),
  occurrenceCount: z.number().int().nonnegative().safe(),
  roomCount: z.number().int().nonnegative().safe(),
  speakerCount: z.number().int().nonnegative().safe()
});
export const acceleventsFormatRowSchema = z.strictObject({
  formatId: idSchema,
  name: nameSchema,
  sessionCount: z.number().int().positive().safe(),
  remoteFormat: acceleventsRemoteFormatSchema.nullable()
});
export const acceleventsSpeakerRowSchema = z.strictObject({
  personId: idSchema,
  displayName: nameSchema,
  sessionCount: z.number().int().positive().safe(),
  firstName: z.string().max(160),
  lastName: z.string().max(160),
  prefilled: z.boolean(),
  hasApprovedEmail: z.boolean()
});
export const acceleventsRoomRowSchema = z.strictObject({
  roomId: idSchema,
  name: nameSchema,
  occurrenceCount: z.number().int().positive().safe(),
  binding: z.union([
    z.strictObject({ kind: z.literal('remote'), locationId: z.number().int().positive().safe() }),
    z.strictObject({ kind: z.literal('no_location') }),
    z.null()
  ])
});
export const acceleventsPrimaryCandidateSchema = z.strictObject({
  personId: idSchema,
  displayName: nameSchema,
  roleLabel: z.string().min(1).max(200)
});
export const acceleventsPrimaryRowSchema = z.strictObject({
  occurrenceId: idSchema,
  sessionId: idSchema,
  sessionTitle: nameSchema,
  candidates: z.array(acceleventsPrimaryCandidateSchema).min(1).max(500),
  primaryPersonId: idSchema.nullable()
});

export const acceleventsPreflightItemSchema = z.strictObject({
  id: z.string().min(1).max(500),
  summary: z.string().min(1).max(2000),
  anchor: z.string().min(1).max(2048).optional()
});
export const acceleventsPreflightSchema = z.strictObject({
  blockers: z.array(acceleventsPreflightItemSchema).max(20_000),
  leftOut: z.array(acceleventsPreflightItemSchema).max(20_000),
  contains: z.strictObject({
    locations: z.number().int().nonnegative().safe(),
    speakers: z.number().int().nonnegative().safe(),
    sessionRows: z.number().int().nonnegative().safe(),
    personalFields: z.array(z.string().min(1).max(200)).max(20)
  }).nullable(),
  consequences: z.array(acceleventsPreflightItemSchema).max(20_000),
  ready: z.boolean()
});

export const acceleventsExportViewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: idSchema,
  configurationVersion: z.number().int().nonnegative().safe(),
  timezone: z.string().min(1).max(100),
  releases: z.array(acceleventsReleaseOptionSchema).max(10_000),
  selectedReleaseId: idSchema.nullable(),
  sessionType: acceleventsSessionTypeSchema.nullable(),
  formats: z.array(acceleventsFormatRowSchema).max(1000),
  speakers: z.array(acceleventsSpeakerRowSchema).max(10_000),
  rooms: z.array(acceleventsRoomRowSchema).max(1000),
  primaries: z.array(acceleventsPrimaryRowSchema).max(10_000),
  unplacedSessions: z.array(z.strictObject({ sessionId: idSchema, title: nameSchema })).max(10_000),
  preflight: acceleventsPreflightSchema,
  lastGenerated: z.strictObject({
    at: z.iso.datetime({ offset: true }),
    releaseNumber: z.number().int().positive().safe()
  }).nullable(),
  locationsCsvPath: z.string().startsWith('/api/').max(2048).nullable(),
  packagePath: z.string().startsWith('/api/').max(2048).nullable()
});

export const acceleventsExportViewReadInputSchema = z.strictObject({});
export const acceleventsExportConfigSaveInputSchema = z.strictObject({
  eventId: idSchema,
  expectedVersion: z.number().int().nonnegative().safe(),
  selectedReleaseId: idSchema.nullable(),
  sessionType: acceleventsSessionTypeSchema.nullable(),
  formatMappings: z.array(acceleventsFormatMappingSchema).max(1000),
  speakerNames: z.array(acceleventsSpeakerNameSchema).max(10_000),
  roomBindings: z.array(acceleventsRoomBindingSchema).max(1000),
  primarySpeakers: z.array(acceleventsPrimarySpeakerSchema).max(10_000)
}).superRefine((value, context) => {
  const groups: readonly [readonly unknown[], (item: never) => string, string][] = [
    [value.formatMappings, (item: { formatId: string }) => item.formatId, 'formatMappings'],
    [value.speakerNames, (item: { personId: string }) => item.personId, 'speakerNames'],
    [value.roomBindings, (item: { roomId: string }) => item.roomId, 'roomBindings'],
    [value.primarySpeakers, (item: { occurrenceId: string }) => item.occurrenceId, 'primarySpeakers']
  ];
  for (const [items, key, path] of groups) {
    if (!uniqueBy(items as readonly never[], key)) {
      context.addIssue({ code: 'custom', path: [path], message: `${path} must be unique` });
    }
  }
});
export const acceleventsExportArtifactReadInputSchema = z.strictObject({ releaseId: idSchema });

export const acceleventsExportViewReadResultSchema = createReadOperationResultSchema(acceleventsExportViewSchema);
export const acceleventsExportConfigSaveResultSchema = createEffectfulOperationResultSchema(acceleventsExportViewSchema);
export const acceleventsExportArtifactDescriptorSchema = z.strictObject({
  releaseId: idSchema,
  releaseNumber: z.number().int().positive().safe(),
  filename: z.string().min(1).max(300),
  byteSize: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  generatedAt: z.iso.datetime({ offset: true })
});
export const acceleventsExportArtifactReadResultSchema = createReadOperationResultSchema(
  acceleventsExportArtifactDescriptorSchema
);

export const ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS = Object.freeze({
  viewRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.program.export.accelevents.view-read.input',
    inputSchema: acceleventsExportViewReadInputSchema,
    resultKey: 'schema.program.export.accelevents.view-read.operator-result',
    resultSchema: acceleventsExportViewReadResultSchema
  }),
  configSave: createOperationSchemaManifestRefs({
    inputKey: 'schema.program.export.accelevents.config-save.input',
    inputSchema: acceleventsExportConfigSaveInputSchema,
    resultKey: 'schema.program.export.accelevents.config-save.operator-result',
    resultSchema: acceleventsExportConfigSaveResultSchema
  }),
  locationsRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.program.export.accelevents.locations-read.input',
    inputSchema: acceleventsExportArtifactReadInputSchema,
    resultKey: 'schema.program.export.accelevents.locations-read.operator-result',
    resultSchema: acceleventsExportArtifactReadResultSchema
  }),
  packageRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.program.export.accelevents.package-read.input',
    inputSchema: acceleventsExportArtifactReadInputSchema,
    resultKey: 'schema.program.export.accelevents.package-read.operator-result',
    resultSchema: acceleventsExportArtifactReadResultSchema
  })
});

export type AcceleventsSessionType = z.infer<typeof acceleventsSessionTypeSchema>;
export type AcceleventsRemoteFormat = z.infer<typeof acceleventsRemoteFormatSchema>;
export type AcceleventsExportConfiguration = z.infer<typeof acceleventsExportConfigurationSchema>;
export type AcceleventsExportConfigSaveInput = z.infer<typeof acceleventsExportConfigSaveInputSchema>;
export type AcceleventsExportView = z.infer<typeof acceleventsExportViewSchema>;
export type AcceleventsPreflight = z.infer<typeof acceleventsPreflightSchema>;
export type AcceleventsExportArtifactDescriptor = z.infer<typeof acceleventsExportArtifactDescriptorSchema>;
