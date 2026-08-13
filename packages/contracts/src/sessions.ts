import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema
} from './operations';
import {
  programTrackAccentSchema,
  programVocabularyIdInputSchema,
  programVocabularyIdSchema,
  programVocabularyNameSchema,
  programVocabularyScopeSchema,
  programVocabularyVersionSchema
} from './program-vocabulary';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalInstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith('Z') && value.includes('.'),
  'instant must use canonical UTC millisecond form'
);
const canonicalText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ') === value);

export const sessionIdInputSchema = programVocabularyIdInputSchema;
export const sessionIdSchema = programVocabularyIdSchema;
export const sessionScopeSchema = programVocabularyScopeSchema;
export const sessionVersionSchema = programVocabularyVersionSchema;
export const sessionLifecycleSchema = z.enum(['draft', 'collecting', 'programmed']);
export const placeableSessionLifecycleSchema = z.enum(['collecting', 'programmed']);
export const sessionTitleInputSchema = z.string().refine((value) => {
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return normalized.length > 0 && normalized.length <= 300;
}).overwrite((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '));
export const sessionTitleSchema = canonicalText(300);
export const sessionPlannedDurationMinutesSchema = z.number().int().min(5).max(1_440)
  .refine((value) => value % 5 === 0, 'planned duration must use five-minute increments');

export const sessionFormatEvidenceSchema = z.strictObject({
  kind: z.literal('format'),
  id: programVocabularyIdSchema,
  name: programVocabularyNameSchema,
  status: z.literal('active'),
  version: programVocabularyVersionSchema
});

export const sessionTrackEvidenceSchema = z.strictObject({
  kind: z.literal('track'),
  id: programVocabularyIdSchema,
  name: programVocabularyNameSchema,
  accent: programTrackAccentSchema,
  status: z.literal('active'),
  version: programVocabularyVersionSchema
});

/** Exact current Program Vocabulary evidence retained when a Session head is authored. */
export const sessionProgramTargetEvidenceSchema = z.strictObject({
  setVersion: programVocabularyVersionSchema,
  setDigestSha256: digestSchema,
  format: sessionFormatEvidenceSchema,
  track: sessionTrackEvidenceSchema.nullable()
});

export const sessionRosterSourceRefSchema = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  id: canonicalText(300),
  version: sessionVersionSchema
});

export const sessionParticipantRoleSchema = z.enum(['speaker', 'moderator', 'host', 'panelist']);
export const sessionParticipantRefSchema = z.strictObject({
  personId: sessionIdSchema,
  role: sessionParticipantRoleSchema,
  position: z.number().int().nonnegative().safe(),
  publiclyVisible: z.boolean(),
  source: sessionRosterSourceRefSchema
});

/** Roster evidence contains typed references only; roster count is always projected. */
export const sessionRosterEvidenceSchema = z.strictObject({
  version: sessionVersionSchema,
  digestSha256: digestSchema,
  participants: z.array(sessionParticipantRefSchema).max(500)
}).superRefine((roster, context) => {
  const keys = new Set<string>();
  for (const [index, participant] of roster.participants.entries()) {
    const key = `${participant.personId}:${participant.role}`;
    if (keys.has(key)) {
      context.addIssue({ code: 'custom', path: ['participants', index], message: 'participant roles must be unique' });
    }
    keys.add(key);
    if (index > 0) {
      const previous = roster.participants[index - 1]!;
      const previousKey = `${previous.personId}:${previous.role}`;
      if (previous.position > participant.position
          || (previous.position === participant.position && previousKey >= key)) {
        context.addIssue({ code: 'custom', path: ['participants', index], message: 'participants must use canonical order' });
      }
    }
  }
});

export const sessionHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: sessionScopeSchema,
  id: sessionIdSchema,
  title: sessionTitleSchema,
  plannedDurationMinutes: sessionPlannedDurationMinutesSchema,
  lifecycle: sessionLifecycleSchema,
  programTarget: sessionProgramTargetEvidenceSchema,
  roster: sessionRosterEvidenceSchema,
  version: sessionVersionSchema,
  digestSha256: digestSchema,
  createdByUserId: sessionIdSchema,
  createdAt: canonicalInstantSchema,
  updatedByUserId: sessionIdSchema,
  updatedAt: canonicalInstantSchema
});

export const sessionCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: sessionScopeSchema,
  version: sessionVersionSchema,
  digestSha256: digestSchema,
  sessions: z.array(sessionHeadSchema).max(5_000)
}).superRefine((catalog, context) => {
  for (const [index, session] of catalog.sessions.entries()) {
    if (session.scope.workspaceId !== catalog.scope.workspaceId || session.scope.eventId !== catalog.scope.eventId) {
      context.addIssue({ code: 'custom', path: ['sessions', index, 'scope'], message: 'session scope must match catalog scope' });
    }
    if (index > 0 && catalog.sessions[index - 1]!.id >= session.id) {
      context.addIssue({ code: 'custom', path: ['sessions', index, 'id'], message: 'sessions must use canonical id order' });
    }
  }
});

const catalogGuardFields = {
  expectedCatalogVersion: sessionVersionSchema,
  expectedCatalogDigestSha256: digestSchema
} as const;

export const sessionCreateInputSchema = z.strictObject({
  action: z.literal('create'),
  ...catalogGuardFields,
  title: sessionTitleInputSchema,
  plannedDurationMinutes: sessionPlannedDurationMinutesSchema,
  lifecycle: sessionLifecycleSchema,
  formatId: sessionIdInputSchema,
  trackId: sessionIdInputSchema.nullable()
});

export const sessionTransitionInputSchema = z.strictObject({
  action: z.literal('transition'),
  ...catalogGuardFields,
  sessionId: sessionIdInputSchema,
  expectedSessionVersion: sessionVersionSchema,
  expectedSessionDigestSha256: digestSchema,
  to: placeableSessionLifecycleSchema
});

export const sessionAuthorInputSchema = z.discriminatedUnion('action', [
  sessionCreateInputSchema,
  sessionTransitionInputSchema
]);

const planningAttribution = {
  scope: sessionScopeSchema,
  actorUserId: sessionIdSchema,
  occurredAt: canonicalInstantSchema
} as const;

export const sessionPlanningInputSchema = z.discriminatedUnion('action', [
  sessionCreateInputSchema.extend({ ...planningAttribution, sessionId: sessionIdSchema }),
  sessionTransitionInputSchema.extend(planningAttribution)
]);

export const sessionMutationPlanSchema = z.strictObject({
  input: sessionPlanningInputSchema,
  before: sessionHeadSchema.nullable(),
  after: sessionHeadSchema,
  catalogVersion: z.strictObject({ before: sessionVersionSchema, after: sessionVersionSchema }),
  catalogDigestSha256: z.strictObject({ before: digestSchema, after: digestSchema })
}).superRefine((plan, context) => {
  if ((plan.input.action === 'create') !== (plan.before === null)) {
    context.addIssue({ code: 'custom', path: ['before'], message: 'plan images must match its action' });
  }
  if (plan.after.id !== plan.input.sessionId || (plan.before && plan.before.id !== plan.input.sessionId)) {
    context.addIssue({ code: 'custom', message: 'plan images must match its session identity' });
  }
});

/** Internal compensating image restore; it is never an ordinary authoring input. */
export const sessionRestorePlanSchema = z.strictObject({
  action: z.literal('restore'),
  scope: sessionScopeSchema,
  expectedCatalogVersion: sessionVersionSchema,
  expectedCatalogDigestSha256: digestSchema,
  expectedCurrent: sessionHeadSchema,
  restore: sessionHeadSchema.nullable(),
  catalogVersion: z.strictObject({ before: sessionVersionSchema, after: sessionVersionSchema }),
  catalogDigestSha256: z.strictObject({ before: digestSchema, after: digestSchema }),
  actorUserId: sessionIdSchema,
  occurredAt: canonicalInstantSchema
});

export const sessionSafeDiffSchema = z.strictObject({
  action: z.enum(['create', 'transition', 'restore']),
  before: sessionHeadSchema.nullable(),
  after: sessionHeadSchema.nullable()
});

export const sessionMutationResultSchema = z.strictObject({
  action: z.enum(['create', 'transition', 'restore']),
  catalogVersion: sessionVersionSchema,
  session: sessionHeadSchema.nullable()
});

export const sessionCatalogReadInputSchema = z.strictObject({});
export const sessionCatalogReadResultSchema = createReadOperationResultSchema(sessionCatalogSchema);
export const sessionDraftOperationResultSchema = createEffectfulOperationResultSchema(sessionSafeDiffSchema);
export const sessionMutationOperationResultSchema = createEffectfulOperationResultSchema(sessionMutationResultSchema);

export const SESSION_OPERATION_SCHEMA_REFS = Object.freeze({
  catalogRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.session.catalog-read.input',
    inputSchema: sessionCatalogReadInputSchema,
    resultKey: 'schema.session.catalog-read.operator-result',
    resultSchema: sessionCatalogReadResultSchema
  }),
  draft: createOperationSchemaManifestRefs({
    inputKey: 'schema.session.changeset-draft.input',
    inputSchema: sessionAuthorInputSchema,
    resultKey: 'schema.session.changeset-draft.operator-result',
    resultSchema: sessionDraftOperationResultSchema
  }),
  mutate: createOperationSchemaManifestRefs({
    inputKey: 'schema.session.changeset-mutate.input',
    inputSchema: sessionAuthorInputSchema,
    resultKey: 'schema.session.changeset-mutate.operator-result',
    resultSchema: sessionMutationOperationResultSchema
  })
});

export type SessionScopeDto = z.infer<typeof sessionScopeSchema>;
export type SessionLifecycle = z.infer<typeof sessionLifecycleSchema>;
export type PlaceableSessionLifecycle = z.infer<typeof placeableSessionLifecycleSchema>;
export type SessionProgramTargetEvidenceDto = z.infer<typeof sessionProgramTargetEvidenceSchema>;
export type SessionParticipantRefDto = z.infer<typeof sessionParticipantRefSchema>;
export type SessionRosterEvidenceDto = z.infer<typeof sessionRosterEvidenceSchema>;
export type SessionHeadDto = z.infer<typeof sessionHeadSchema>;
export type SessionCatalogDto = z.infer<typeof sessionCatalogSchema>;
export type SessionAuthorInput = z.infer<typeof sessionAuthorInputSchema>;
export type SessionPlanningInput = z.infer<typeof sessionPlanningInputSchema>;
export type SessionMutationPlanDto = z.infer<typeof sessionMutationPlanSchema>;
export type SessionRestorePlanDto = z.infer<typeof sessionRestorePlanSchema>;
export type SessionSafeDiffDto = z.infer<typeof sessionSafeDiffSchema>;
export type SessionMutationResult = z.infer<typeof sessionMutationResultSchema>;
