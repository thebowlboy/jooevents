import { z } from 'zod';
import { deadlineMutationPlanSchema, deadlineReferencePinSchema } from './deadlines';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const canonicalIdSchema = z.string().regex(UUID);
const canonicalInstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith('Z') && value.includes('.'),
  'instant must use canonical UTC millisecond form'
);
const canonicalText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ') === value);

export const TASK_DEFINITION_LIMIT = 100;
export const TASK_ASSIGNMENT_LIMIT = 20_000;

export const taskIdSchema = canonicalIdSchema;
export const taskVersionSchema = z.number().int().positive().safe();
export const taskDigestSchema = z.string().regex(SHA256);
export const taskScopeSchema = z.strictObject({
  workspaceId: canonicalIdSchema,
  eventId: canonicalIdSchema
});
export const taskSubjectKindSchema = z.enum(['engagement', 'session', 'group']);
export const taskCompletionModeSchema = z.enum([
  'acknowledge', 'file_upload', 'form', 'external_action'
]);
export const taskVisibilitySchema = z.literal('assigned_participants');
export const taskAssignmentRuleSchema = z.strictObject({
  kind: z.literal('all_confirmed_speakers'),
  version: z.literal(1)
});
export const taskAssignmentStateSchema = z.enum([
  'pending', 'received_pending_check', 'complete', 'waived', 'late_complete'
]);

export const taskDeadlinePinSchema = z.strictObject({
  kind: z.literal('task_due'),
  reference: deadlineReferencePinSchema
});

export const taskDefinitionRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: taskScopeSchema,
  taskDefinitionId: taskIdSchema,
  revisionId: taskIdSchema,
  number: taskVersionSchema,
  predecessorRevisionId: taskIdSchema.nullable(),
  predecessorDigestSha256: taskDigestSchema.nullable(),
  name: canonicalText(120),
  description: canonicalText(500).nullable(),
  subjectKind: taskSubjectKindSchema,
  completionMode: taskCompletionModeSchema,
  required: z.boolean(),
  visibility: taskVisibilitySchema,
  assignmentRule: taskAssignmentRuleSchema,
  deadline: taskDeadlinePinSchema,
  createdByUserId: taskIdSchema,
  createdAt: canonicalInstantSchema,
  digestSha256: taskDigestSchema
}).superRefine((revision, context) => {
  if ((revision.number === 1) !== (revision.predecessorRevisionId === null)) {
    context.addIssue({ code: 'custom', path: ['predecessorRevisionId'], message: 'predecessor coherence' });
  }
  if ((revision.predecessorRevisionId === null) !== (revision.predecessorDigestSha256 === null)) {
    context.addIssue({ code: 'custom', path: ['predecessorDigestSha256'], message: 'predecessor digest coherence' });
  }
});

export const taskDefinitionHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: taskScopeSchema,
  id: taskIdSchema,
  currentRevisionId: taskIdSchema,
  currentRevisionNumber: taskVersionSchema,
  version: taskVersionSchema
});

export const taskDefinitionSnapshotSchema = z.strictObject({
  head: taskDefinitionHeadSchema,
  current: taskDefinitionRevisionSchema
}).superRefine((snapshot, context) => {
  const { head, current } = snapshot;
  if (head.id !== current.taskDefinitionId
      || head.currentRevisionId !== current.revisionId
      || head.currentRevisionNumber !== current.number
      || head.version !== current.number
      || head.scope.workspaceId !== current.scope.workspaceId
      || head.scope.eventId !== current.scope.eventId) {
    context.addIssue({ code: 'custom', message: 'task definition head and revision mismatch' });
  }
});

export const taskDefinitionCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: taskScopeSchema,
  version: taskVersionSchema,
  digestSha256: taskDigestSchema,
  definitions: z.array(taskDefinitionSnapshotSchema).max(TASK_DEFINITION_LIMIT)
});

export const taskCompletionEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('acknowledged'), acknowledgedAt: canonicalInstantSchema }),
  z.strictObject({ kind: z.literal('file'), mediaAssetId: taskIdSchema, mediaAssetVersion: taskVersionSchema }),
  z.strictObject({ kind: z.literal('form'), submissionId: taskIdSchema }),
  z.strictObject({ kind: z.literal('external'), note: canonicalText(500) })
]);

export const taskAssignmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: taskScopeSchema,
  id: taskIdSchema,
  taskDefinitionId: taskIdSchema,
  taskDefinitionRevisionId: taskIdSchema,
  engagementId: taskIdSchema,
  personId: taskIdSchema,
  state: taskAssignmentStateSchema,
  deadline: taskDeadlinePinSchema,
  deadlineOverride: taskDeadlinePinSchema.nullable(),
  completionEvidence: taskCompletionEvidenceSchema.nullable(),
  assignedAt: canonicalInstantSchema,
  updatedAt: canonicalInstantSchema,
  version: taskVersionSchema
}).superRefine((assignment, context) => {
  if (assignment.state === 'received_pending_check' && assignment.completionEvidence === null) {
    context.addIssue({ code: 'custom', path: ['completionEvidence'], message: 'received work carries evidence' });
  }
  if ((assignment.state === 'complete' || assignment.state === 'late_complete')
      && assignment.completionEvidence === null) {
    context.addIssue({ code: 'custom', path: ['completionEvidence'], message: 'completed work carries evidence' });
  }
});

export const taskEventKindSchema = z.enum([
  'assigned', 'fulfillment_received', 'fulfillment_accepted', 'waived', 'restored',
  'extended', 'reminded'
]);
export const taskEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: taskScopeSchema,
  id: taskIdSchema,
  assignmentId: taskIdSchema,
  kind: taskEventKindSchema,
  fromState: taskAssignmentStateSchema.nullable(),
  toState: taskAssignmentStateSchema,
  actorUserId: taskIdSchema,
  occurredAt: canonicalInstantSchema,
  assignmentVersion: taskVersionSchema
});

export const taskBoardSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: taskScopeSchema,
  catalogVersion: taskVersionSchema,
  catalogDigestSha256: taskDigestSchema,
  definitions: z.array(taskDefinitionSnapshotSchema).max(TASK_DEFINITION_LIMIT),
  assignments: z.array(taskAssignmentSchema).max(TASK_ASSIGNMENT_LIMIT)
});

const catalogPlanImageSchema = z.strictObject({
  beforeVersion: taskVersionSchema,
  beforeDigestSha256: taskDigestSchema,
  afterVersion: taskVersionSchema,
  afterDigestSha256: taskDigestSchema
});
export const taskEngagementEvidenceSchema = z.strictObject({
  engagementId: taskIdSchema,
  personId: taskIdSchema,
  version: taskVersionSchema,
  state: z.literal('confirmed')
});
export const taskMembershipGuardSchema = z.strictObject({
  id: canonicalText(512),
  version: taskVersionSchema,
  digestSha256: taskDigestSchema
});

export const taskDefinitionCreatePlanningInputSchema = z.strictObject({
  action: z.literal('create_definition'),
  scope: taskScopeSchema,
  taskDefinitionId: taskIdSchema,
  revisionId: taskIdSchema,
  deadlineId: taskIdSchema,
  name: canonicalText(120),
  description: canonicalText(500).nullable(),
  completionMode: taskCompletionModeSchema,
  required: z.boolean(),
  dueOn: z.iso.date(),
  actorUserId: taskIdSchema,
  occurredAt: canonicalInstantSchema
});
export const taskAssignmentTransitionPlanningInputSchema = z.strictObject({
  action: z.enum(['waive_assignment', 'accept_fulfillment']),
  scope: taskScopeSchema,
  assignmentId: taskIdSchema,
  expectedVersion: taskVersionSchema,
  actorUserId: taskIdSchema,
  occurredAt: canonicalInstantSchema
});
export const taskAuthorInputSchema = z.discriminatedUnion('action', [
  taskDefinitionCreatePlanningInputSchema,
  taskAssignmentTransitionPlanningInputSchema
]);

export const taskDefinitionCreatePlanSchema = z.strictObject({
  action: z.literal('create_definition'),
  input: taskDefinitionCreatePlanningInputSchema,
  catalog: catalogPlanImageSchema,
  membershipGuard: taskMembershipGuardSchema,
  engagementEvidence: z.array(taskEngagementEvidenceSchema).max(TASK_ASSIGNMENT_LIMIT),
  deadlineContribution: deadlineMutationPlanSchema,
  definition: taskDefinitionSnapshotSchema,
  assignments: z.array(taskAssignmentSchema).max(TASK_ASSIGNMENT_LIMIT),
  events: z.array(taskEventSchema).max(TASK_ASSIGNMENT_LIMIT)
}).superRefine((plan, context) => {
  if (plan.catalog.afterVersion !== plan.catalog.beforeVersion + 1) {
    context.addIssue({ code: 'custom', path: ['catalog'], message: 'catalog advances once' });
  }
  if (plan.assignments.length !== plan.engagementEvidence.length
      || plan.events.length !== plan.assignments.length) {
    context.addIssue({ code: 'custom', path: ['assignments'], message: 'materialization cardinality mismatch' });
  }
});

export const taskAssignmentTransitionPlanSchema = z.strictObject({
  action: z.enum(['waive_assignment', 'accept_fulfillment']),
  input: taskAssignmentTransitionPlanningInputSchema,
  before: taskAssignmentSchema,
  after: taskAssignmentSchema,
  event: taskEventSchema
});
export const taskMutationPlanSchema = z.discriminatedUnion('action', [
  taskDefinitionCreatePlanSchema,
  taskAssignmentTransitionPlanSchema
]);

export const taskAssignmentRestorePlanSchema = z.strictObject({
  action: z.literal('restore_assignment'),
  scope: taskScopeSchema,
  expectedCurrent: taskAssignmentSchema,
  restore: taskAssignmentSchema,
  event: taskEventSchema,
  actorUserId: taskIdSchema,
  occurredAt: canonicalInstantSchema
});

const taskDefinitionDiffSchema = z.strictObject({
  action: z.literal('create_definition'),
  definition: z.strictObject({
    id: taskIdSchema,
    name: canonicalText(120),
    completionMode: taskCompletionModeSchema,
    required: z.boolean(),
    dueOn: z.iso.date(),
    assignmentRule: taskAssignmentRuleSchema
  }),
  assignments: z.array(z.strictObject({
    assignmentId: taskIdSchema,
    engagementId: taskIdSchema
  })).max(TASK_ASSIGNMENT_LIMIT),
  representedConsequences: z.tuple([
    z.literal('deadline_changed'),
    z.literal('task_definition_created'),
    z.literal('task_assignments_materialized')
  ])
});
const taskAssignmentDiffSchema = z.strictObject({
  action: z.enum(['waive_assignment', 'accept_fulfillment', 'restore_assignment']),
  assignmentId: taskIdSchema,
  taskDefinitionId: taskIdSchema,
  engagementId: taskIdSchema,
  beforeState: taskAssignmentStateSchema,
  afterState: taskAssignmentStateSchema,
  representedConsequences: z.tuple([z.literal('task_assignment_changed')])
});
export const taskSafeDiffSchema = z.discriminatedUnion('action', [
  taskDefinitionDiffSchema,
  taskAssignmentDiffSchema
]);

export const taskMutationResultSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create_definition'),
    definition: taskDefinitionSnapshotSchema,
    assignments: z.array(taskAssignmentSchema).max(TASK_ASSIGNMENT_LIMIT)
  }),
  z.strictObject({
    action: z.enum(['waive_assignment', 'accept_fulfillment', 'restore_assignment']),
    assignment: taskAssignmentSchema
  })
]);

export const taskBoardReadInputSchema = z.strictObject({});
export const taskBoardReadResultSchema = createReadOperationResultSchema(taskBoardSnapshotSchema);
export const taskMutationDraftInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create_definition'),
    name: canonicalText(120),
    description: canonicalText(500).nullable().default(null),
    completionMode: taskCompletionModeSchema,
    required: z.boolean(),
    dueOn: z.iso.date()
  }),
  z.strictObject({
    action: z.enum(['waive_assignment', 'accept_fulfillment']),
    assignmentId: taskIdSchema,
    expectedVersion: taskVersionSchema
  })
]);
export const taskDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(['create_definition', 'waive_assignment', 'accept_fulfillment']),
  changesetId: taskIdSchema,
  headVersion: taskVersionSchema,
  status: z.literal('draft'),
  revision: z.strictObject({
    id: taskIdSchema,
    number: taskVersionSchema,
    digestSha256: taskDigestSchema
  }),
  riskTier: z.enum(['normal', 'consequential']),
  approvalPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: taskDigestSchema,
    requirement: z.literal('none')
  }),
  safeDiff: taskSafeDiffSchema
});
export const taskDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: taskDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const taskDraftOperationResultSchema = createEffectfulOperationResultSchema(taskDraftDataSchema);

export const TASK_OPERATION_SCHEMA_REFS = Object.freeze({
  boardRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.task.board-read.input', inputSchema: taskBoardReadInputSchema,
    resultKey: 'schema.task.board-read.operator-result', resultSchema: taskBoardReadResultSchema
  }),
  mutationDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.task.mutation-draft.input', inputSchema: taskMutationDraftInputSchema,
    resultKey: 'schema.task.mutation-draft.operator-result', resultSchema: taskDraftOperationResultSchema
  })
});

export type TaskScopeDto = z.infer<typeof taskScopeSchema>;
export type TaskDefinitionRevisionDto = z.infer<typeof taskDefinitionRevisionSchema>;
export type TaskDefinitionSnapshotDto = z.infer<typeof taskDefinitionSnapshotSchema>;
export type TaskDefinitionCatalogDto = z.infer<typeof taskDefinitionCatalogSchema>;
export type TaskAssignmentDto = z.infer<typeof taskAssignmentSchema>;
export type TaskEventDto = z.infer<typeof taskEventSchema>;
export type TaskBoardSnapshotDto = z.infer<typeof taskBoardSnapshotSchema>;
export type TaskDefinitionCreatePlanningInput = z.infer<typeof taskDefinitionCreatePlanningInputSchema>;
export type TaskAssignmentTransitionPlanningInput = z.infer<typeof taskAssignmentTransitionPlanningInputSchema>;
export type TaskAuthorInput = z.infer<typeof taskAuthorInputSchema>;
export type TaskMutationPlanDto = z.infer<typeof taskMutationPlanSchema>;
export type TaskAssignmentRestorePlanDto = z.infer<typeof taskAssignmentRestorePlanSchema>;
export type TaskSafeDiffDto = z.infer<typeof taskSafeDiffSchema>;
export type TaskMutationResultDto = z.infer<typeof taskMutationResultSchema>;
export type TaskMutationDraftInput = z.input<typeof taskMutationDraftInputSchema>;
export type TaskDraftData = z.infer<typeof taskDraftDataSchema>;
