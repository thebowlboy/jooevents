import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';
import {
  sessionMutationPlanSchema,
  sessionMutationResultSchema,
} from './sessions';

const APPLICATION_UUID_INPUT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLICATION_UUID_CANONICAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalInstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith('Z') && value.includes('.'),
  'instant must use canonical UTC millisecond form'
);
const canonicalText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ') === value);

export const DECISION_DECIDE_ROWS_MAX = 100;

export const decisionIdInputSchema = z.string()
  .regex(APPLICATION_UUID_INPUT)
  .overwrite((value) => value.toLowerCase());
export const decisionIdSchema = z.string().regex(APPLICATION_UUID_CANONICAL);
export const decisionScopeSchema = z.strictObject({
  workspaceId: decisionIdSchema,
  eventId: decisionIdSchema
});
export const decisionVersionSchema = z.number().int().positive().safe();

/** Undecided is the absence of a Decision head, never a fifth state value. */
export const decisionStateSchema = z.enum(['accepted', 'waitlisted', 'declined', 'withdrawn']);

/** States an organizer decide authors; `withdrawn` has no organizer authoring path. */
export const decisionOrganizerStateSchema = z.enum(['accepted', 'waitlisted', 'declined']);

export const decisionHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: decisionScopeSchema,
  submissionId: decisionIdSchema,
  state: decisionStateSchema,
  version: decisionVersionSchema,
  digestSha256: digestSchema,
  decidedByUserId: decisionIdSchema,
  decidedAt: canonicalInstantSchema
});

/** Immutable submission facts the decider decided over. */
export const decisionSubmissionPinSchema = z.strictObject({
  submissionId: decisionIdSchema,
  formVersionId: decisionIdSchema,
  candidateVersion: decisionVersionSchema
});

export const decisionStandingBandSchema = z.enum([
  'top', 'upper', 'mid', 'lower', 'bottom', 'few'
]);

/**
 * Aggregate review basis at decide time. It carries the round identity and the
 * aggregated standing only — never reviewer identities, per-reviewer scores, or
 * comments — so a stored Decision plan survives an anonymized-plan audit.
 */
export const decisionReviewPinSchema = z.strictObject({
  roundId: decisionIdSchema,
  roundVersion: decisionVersionSchema,
  standing: z.strictObject({
    value: z.number().min(1).max(5),
    n: z.number().int().positive().safe(),
    band: decisionStandingBandSchema
  }).nullable()
});

/** Exact collecting Session resolution an attach decided against. */
export const decisionTargetPinSchema = z.strictObject({
  kind: z.literal('session'),
  id: decisionIdSchema,
  title: canonicalText(300),
  version: decisionVersionSchema,
  lifecycle: z.literal('collecting')
});

export const decisionEvidenceSchema = z.strictObject({
  submission: decisionSubmissionPinSchema,
  review: decisionReviewPinSchema.nullable(),
  target: decisionTargetPinSchema.nullable()
});

/**
 * Fluid many-submissions-to-one-session lineage link written by an accept. A
 * submission holds at most one active origin; the link is removed by
 * compensation, never by a later waitlist/decline head write.
 */
export const submissionSessionOriginSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: decisionScopeSchema,
  submissionId: decisionIdSchema,
  sessionId: decisionIdSchema,
  kind: z.enum(['spawned', 'attached']),
  linkedByUserId: decisionIdSchema,
  linkedAt: canonicalInstantSchema
});

/**
 * Explicit graduation routing for an accept. When omitted on the wire, the
 * server routes by the submission's effective target: a resolvable collecting
 * target Session attaches, anything else spawns. `spawn` and `attach` are also
 * the two structured exits offered by a `decision.target_unavailable` refusal.
 */
export const decisionGraduationChoiceInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('spawn'),
    /** Explicit organizer classification when the submission carries none. */
    trackId: decisionIdInputSchema.optional()
  }),
  z.strictObject({
    kind: z.literal('attach'),
    sessionId: decisionIdInputSchema,
    graduateTo: z.literal('programmed').optional()
  })
]);

export const decisionDecideRowInputSchema = z.strictObject({
  submissionId: decisionIdInputSchema,
  state: decisionOrganizerStateSchema,
  expectedDecisionVersion: decisionVersionSchema.nullable(),
  expectedDecisionDigestSha256: digestSchema.nullable(),
  graduation: decisionGraduationChoiceInputSchema.optional()
}).superRefine((row, context) => {
  if ((row.expectedDecisionVersion === null) !== (row.expectedDecisionDigestSha256 === null)) {
    context.addIssue({
      code: 'custom', path: ['expectedDecisionDigestSha256'],
      message: 'decision guards must pin version and digest together'
    });
  }
  if (row.graduation !== undefined && row.state !== 'accepted') {
    context.addIssue({
      code: 'custom', path: ['graduation'],
      message: 'only an accept graduates a submission into a Session'
    });
  }
});

export const decisionAuthorInputSchema = z.strictObject({
  action: z.literal('decide'),
  decisions: z.array(decisionDecideRowInputSchema).min(1).max(DECISION_DECIDE_ROWS_MAX)
}).superRefine((input, context) => {
  const submissionIds = new Set<string>();
  for (const [index, row] of input.decisions.entries()) {
    if (submissionIds.has(row.submissionId)) {
      context.addIssue({
        code: 'custom', path: ['decisions', index, 'submissionId'],
        message: 'each submission is decided at most once per operation'
      });
    }
    submissionIds.add(row.submissionId);
  }
});

/**
 * Resolved graduation routing embedded in planning input: every accepted row
 * carries its routing explicitly (spawn identity is server-minted), so a stored
 * plan revalidates deterministically from planning input alone.
 */
export const decisionPlanningGraduationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('spawn'),
    sessionId: decisionIdSchema,
    trackId: decisionIdSchema.nullable()
  }),
  z.strictObject({
    kind: z.literal('attach'),
    sessionId: decisionIdSchema,
    graduateTo: z.literal('programmed').optional()
  })
]);

export const decisionPlanningRowSchema = z.strictObject({
  submissionId: decisionIdSchema,
  state: decisionOrganizerStateSchema,
  expectedDecisionVersion: decisionVersionSchema.nullable(),
  expectedDecisionDigestSha256: digestSchema.nullable(),
  graduation: decisionPlanningGraduationSchema.nullable()
}).superRefine((row, context) => {
  if ((row.expectedDecisionVersion === null) !== (row.expectedDecisionDigestSha256 === null)) {
    context.addIssue({
      code: 'custom', path: ['expectedDecisionDigestSha256'],
      message: 'decision guards must pin version and digest together'
    });
  }
  if ((row.graduation !== null) !== (row.state === 'accepted')) {
    context.addIssue({
      code: 'custom', path: ['graduation'],
      message: 'exactly the accepted rows carry graduation routing'
    });
  }
});

export const decisionMutationPlanningInputSchema = z.strictObject({
  action: z.literal('decide'),
  scope: decisionScopeSchema,
  actorUserId: decisionIdSchema,
  occurredAt: canonicalInstantSchema,
  decisions: z.array(decisionPlanningRowSchema).min(1).max(DECISION_DECIDE_ROWS_MAX)
}).superRefine((input, context) => {
  const submissionIds = new Set<string>();
  for (const [index, row] of input.decisions.entries()) {
    if (submissionIds.has(row.submissionId)) {
      context.addIssue({
        code: 'custom', path: ['decisions', index, 'submissionId'],
        message: 'each submission is decided at most once per operation'
      });
    }
    submissionIds.add(row.submissionId);
  }
});

export const decisionRowPlanSchema = z.strictObject({
  submissionId: decisionIdSchema,
  before: decisionHeadSchema.nullable(),
  after: decisionHeadSchema,
  evidence: decisionEvidenceSchema,
  graduation: sessionMutationPlanSchema.nullable(),
  origin: submissionSessionOriginSchema.nullable()
}).superRefine((row, context) => {
  if (row.after.submissionId !== row.submissionId
      || (row.before !== null && row.before.submissionId !== row.submissionId)) {
    context.addIssue({ code: 'custom', message: 'plan images must match the row submission' });
  }
  if ((row.after.state === 'accepted') !== (row.graduation !== null)
      || (row.after.state === 'accepted') !== (row.origin !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'exactly the accepted rows carry a graduation contribution and origin link'
    });
  }
});

export const decisionMutationPlanSchema = z.strictObject({
  input: decisionMutationPlanningInputSchema,
  rows: z.array(decisionRowPlanSchema).min(1).max(DECISION_DECIDE_ROWS_MAX)
}).superRefine((plan, context) => {
  if (plan.rows.length !== plan.input.decisions.length) {
    context.addIssue({ code: 'custom', path: ['rows'], message: 'plan rows must align with planning input rows' });
    return;
  }
  for (const [index, row] of plan.rows.entries()) {
    const inputRow = plan.input.decisions[index]!;
    if (row.submissionId !== inputRow.submissionId || row.after.state !== inputRow.state) {
      context.addIssue({
        code: 'custom', path: ['rows', index],
        message: 'plan rows must align with planning input rows'
      });
    }
  }
});

export const decisionMutationResultSchema = z.strictObject({
  action: z.literal('decide'),
  rows: z.array(z.strictObject({
    submissionId: decisionIdSchema,
    head: decisionHeadSchema.nullable(),
    origin: submissionSessionOriginSchema.nullable()
  })).min(1).max(DECISION_DECIDE_ROWS_MAX),
  sessions: z.array(sessionMutationResultSchema).max(DECISION_DECIDE_ROWS_MAX)
});

/**
 * Structured refusal payload for `decision.target_unavailable`: the addressed
 * target Session cannot take this attach, and the caller is offered exactly the
 * two decided exits — re-target another collecting Session or spawn a new one.
 */
export const decisionTargetUnavailableDetailSchema = z.strictObject({
  reason: z.enum(['target_graduated', 'target_closed', 'target_missing']),
  exits: z.tuple([z.literal('retarget'), z.literal('spawn')])
});

export const decisionStateReadInputSchema = z.strictObject({
  submissionIds: z.array(decisionIdInputSchema).min(1).max(DECISION_DECIDE_ROWS_MAX)
}).superRefine((input, context) => {
  const submissionIds = new Set<string>();
  for (const [index, submissionId] of input.submissionIds.entries()) {
    if (submissionIds.has(submissionId)) {
      context.addIssue({
        code: 'custom', path: ['submissionIds', index],
        message: 'submission ids must be unique'
      });
    }
    submissionIds.add(submissionId);
  }
});

export const decisionStateRowSchema = z.strictObject({
  submissionId: decisionIdSchema,
  head: decisionHeadSchema.nullable(),
  origin: submissionSessionOriginSchema.nullable()
});

export const decisionStateSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rows: z.array(decisionStateRowSchema).max(DECISION_DECIDE_ROWS_MAX)
});

/** Exact selector and inert plan an operator needs to review, propose, and commit one decide draft. */
export const decisionDecideDataSchema = decisionMutationResultSchema.extend({
  action: z.literal('decide')
});

export const decisionStateReadResultSchema = createReadOperationResultSchema(decisionStateSnapshotSchema);
export const decisionDecideCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: decisionDecideDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const decisionDecideOperationResultSchema =
  createEffectfulOperationResultSchema(decisionDecideDataSchema);

export const DECISION_OPERATION_SCHEMA_REFS = Object.freeze({
  stateRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.decision.state-read.input',
    inputSchema: decisionStateReadInputSchema,
    resultKey: 'schema.decision.state-read.operator-result',
    resultSchema: decisionStateReadResultSchema
  }),
  decide: createOperationSchemaManifestRefs({
    inputKey: 'schema.decision.decide.input',
    inputSchema: decisionAuthorInputSchema,
    resultKey: 'schema.decision.decide.operator-result',
    resultSchema: decisionDecideOperationResultSchema,
    version: 2
  })
});

export type DecisionScopeDto = z.infer<typeof decisionScopeSchema>;
export type DecisionState = z.infer<typeof decisionStateSchema>;
export type DecisionOrganizerState = z.infer<typeof decisionOrganizerStateSchema>;
export type DecisionHeadDto = z.infer<typeof decisionHeadSchema>;
export type DecisionSubmissionPinDto = z.infer<typeof decisionSubmissionPinSchema>;
export type DecisionReviewPinDto = z.infer<typeof decisionReviewPinSchema>;
export type DecisionTargetPinDto = z.infer<typeof decisionTargetPinSchema>;
export type DecisionEvidenceDto = z.infer<typeof decisionEvidenceSchema>;
export type SubmissionSessionOriginDto = z.infer<typeof submissionSessionOriginSchema>;
export type DecisionGraduationChoiceInput = z.infer<typeof decisionGraduationChoiceInputSchema>;
export type DecisionDecideRowInput = z.infer<typeof decisionDecideRowInputSchema>;
export type DecisionAuthorInput = z.infer<typeof decisionAuthorInputSchema>;
export type DecisionPlanningGraduation = z.infer<typeof decisionPlanningGraduationSchema>;
export type DecisionPlanningRow = z.infer<typeof decisionPlanningRowSchema>;
export type DecisionMutationPlanningInput = z.infer<typeof decisionMutationPlanningInputSchema>;
export type DecisionRowPlanDto = z.infer<typeof decisionRowPlanSchema>;
export type DecisionMutationPlanDto = z.infer<typeof decisionMutationPlanSchema>;
export type DecisionMutationResult = z.infer<typeof decisionMutationResultSchema>;
export type DecisionTargetUnavailableDetail = z.infer<typeof decisionTargetUnavailableDetailSchema>;
export type DecisionStateReadInput = z.infer<typeof decisionStateReadInputSchema>;
export type DecisionStateRowDto = z.infer<typeof decisionStateRowSchema>;
export type DecisionStateSnapshotDto = z.infer<typeof decisionStateSnapshotSchema>;
export type DecisionDecideData = z.infer<typeof decisionDecideDataSchema>;
