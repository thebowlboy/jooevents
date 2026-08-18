import { isApplicationId, parseInstant } from '@jooevents/kernel';
import { z } from 'zod';

export const signalIdSchema = z.string().refine(isApplicationId, {
  message: 'Signal ids must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
export const signalKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .max(120);
export const signalVersionSchema = z.number().int().positive().safe();
export const signalInstantSchema = z.string().refine((value) => {
  try { return parseInstant(value) === value; } catch { return false; }
}, 'Expected a canonical UTC instant.');

export const signalSubjectKindSchema = z.enum(['submission', 'person', 'engagement']);
export const signalFamilySchema = z.enum(['quality', 'draw', 'integrity', 'logistics']);
export const signalValueKindSchema = z.enum([
  'unit_score', 'scale', 'count', 'label', 'flag', 'ref', 'json'
]);
export const signalDirectionSchema = z.enum([
  'higher_is_better', 'higher_is_worse', 'neutral'
]);
export const signalVisibilitySchema = z.enum(['organizer', 'chair', 'reviewer']);
export const signalProvenanceKindSchema = z.enum(['heuristic', 'agent', 'human', 'import']);

export const signalDisplaySchema = z.strictObject({
  format: z.string().trim().min(1).max(240),
  icon: z.string().trim().min(1).max(80).optional(),
  precision: z.number().int().min(0).max(12).optional(),
  bands: z.array(z.strictObject({
    minimum: z.number(),
    label: z.string().trim().min(1).max(80),
    tone: z.string().trim().min(1).max(80)
  })).max(100).optional()
});

export const signalWriteCapsSchema = z.strictObject({
  perActorPerPlan: z.number().int().positive().safe()
});

/** One immutable semantic revision of an event-local signal definition. */
export const signalDefinitionRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: signalIdSchema,
  eventId: signalIdSchema,
  key: signalKeySchema,
  version: signalVersionSchema,
  label: z.string().trim().min(1).max(120),
  shortLabel: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(500),
  subjects: z.array(signalSubjectKindSchema).min(1).max(3),
  family: signalFamilySchema,
  valueKind: signalValueKindSchema,
  direction: signalDirectionSchema,
  display: signalDisplaySchema,
  visibility: signalVisibilitySchema,
  allowedProvenance: z.array(signalProvenanceKindSchema).min(1).max(4),
  writeCaps: signalWriteCapsSchema.optional(),
  policyEligible: z.boolean(),
  createdBy: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('system_seed') }),
    z.strictObject({ kind: z.literal('workspace_user'), userId: signalIdSchema }),
    z.strictObject({ kind: z.literal('agent_action'), userId: signalIdSchema.optional() })
  ]),
  createdAt: signalInstantSchema
}).superRefine((definition, context) => {
  if (definition.direction !== 'neutral'
      && !['unit_score', 'scale', 'count'].includes(definition.valueKind)) {
    context.addIssue({
      code: 'custom', path: ['direction'],
      message: 'Only orderable signal values may declare a direction.'
    });
  }
  if (definition.family === 'draw' && definition.visibility !== 'organizer') {
    context.addIssue({
      code: 'custom', path: ['visibility'],
      message: 'Draw signals are organizer-only.'
    });
  }
});

/** Current lifecycle/display head joined to its immutable semantic revision. */
export const signalDefinitionSchema = signalDefinitionRevisionSchema.extend({
  status: z.enum(['active', 'retired']),
  shown: z.boolean(),
  position: z.number().int().nonnegative().safe()
});

export const signalObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: signalIdSchema,
  workspaceId: signalIdSchema,
  eventId: signalIdSchema,
  subject: z.strictObject({ kind: signalSubjectKindSchema, id: signalIdSchema }),
  definitionKey: signalKeySchema,
  definitionVersion: signalVersionSchema,
  value: z.unknown(),
  rationale: z.string().max(20_000).optional(),
  provenance: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('human'),
      actorReviewerId: signalIdSchema,
      actorUserId: signalIdSchema,
      reviewPlanId: signalIdSchema
    }),
    z.strictObject({ kind: z.literal('heuristic') }),
    z.strictObject({ kind: z.literal('agent') }),
    z.strictObject({ kind: z.literal('import') })
  ]),
  computedAt: signalInstantSchema,
  supersedesId: signalIdSchema.optional(),
  inputVersions: z.record(z.string().trim().min(1).max(120), z.union([
    z.string().trim().min(1).max(500), z.number().safe()
  ]))
});

export const signalObservationRetractionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: signalIdSchema,
  eventId: signalIdSchema,
  observationId: signalIdSchema,
  reason: z.string().trim().min(1).max(500),
  retractedByUserId: signalIdSchema,
  retractedAt: signalInstantSchema
});

export const signalScopeSchema = z.strictObject({
  workspaceId: signalIdSchema,
  eventId: signalIdSchema
});

const humanFlagContext = {
  scope: signalScopeSchema,
  definitionKey: signalKeySchema,
  expectedDefinitionVersion: signalVersionSchema,
  subjectId: signalIdSchema,
  actorReviewerId: signalIdSchema,
  actorUserId: signalIdSchema,
  reviewPlanId: signalIdSchema,
  attributedAt: signalInstantSchema
} as const;

export const signalRecordHumanFlagPlanningInputSchema = z.strictObject({
  action: z.literal('record_human_flag'),
  ...humanFlagContext,
  observationId: signalIdSchema
});

export const signalRetractHumanFlagPlanningInputSchema = z.strictObject({
  action: z.literal('retract_human_flag'),
  ...humanFlagContext,
  expectedObservationId: signalIdSchema,
  reason: z.string().trim().min(1).max(500)
});

export const signalHumanFlagPlanningInputSchema = z.discriminatedUnion('action', [
  signalRecordHumanFlagPlanningInputSchema,
  signalRetractHumanFlagPlanningInputSchema
]);

export const signalRecordHumanFlagPlanSchema = z.strictObject({
  action: z.literal('record_human_flag'),
  input: signalRecordHumanFlagPlanningInputSchema,
  definition: signalDefinitionSchema,
  observation: signalObservationSchema
});

export const signalRetractHumanFlagPlanSchema = z.strictObject({
  action: z.literal('retract_human_flag'),
  input: signalRetractHumanFlagPlanningInputSchema,
  definition: signalDefinitionSchema,
  observation: signalObservationSchema,
  retraction: signalObservationRetractionSchema
});

export const signalHumanFlagPlanSchema = z.discriminatedUnion('action', [
  signalRecordHumanFlagPlanSchema,
  signalRetractHumanFlagPlanSchema
]);

export const signalHumanFlagResultSchema = z.strictObject({
  definitionKey: signalKeySchema,
  definitionVersion: signalVersionSchema,
  subjectId: signalIdSchema,
  pinned: z.boolean(),
  observationId: signalIdSchema
});

export type SignalDefinitionRevisionDto = z.infer<typeof signalDefinitionRevisionSchema>;
export type SignalDefinitionDto = z.infer<typeof signalDefinitionSchema>;
export type SignalObservationDto = z.infer<typeof signalObservationSchema>;
export type SignalObservationRetractionDto = z.infer<typeof signalObservationRetractionSchema>;
export type SignalKey = z.infer<typeof signalKeySchema>;
export type SignalScopeDto = z.infer<typeof signalScopeSchema>;
export type SignalHumanFlagPlanningInput = z.infer<typeof signalHumanFlagPlanningInputSchema>;
export type SignalHumanFlagPlanDto = z.infer<typeof signalHumanFlagPlanSchema>;
export type SignalHumanFlagResult = z.infer<typeof signalHumanFlagResultSchema>;
