import { z } from 'zod';
import { styleSetRecipeSchema } from './releases';
import { changesetApplicationIdSchema } from './changeset-operations';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const canonicalInstant = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith('Z') && value.includes('.'),
  'instant must use canonical UTC millisecond form'
);
const id = z.string().regex(ID);
const text = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.normalize('NFC').trim() === value);
const optionalText = (maximum: number) => z.string().max(maximum)
  .refine((value) => value.normalize('NFC').trim() === value);

export const templateTextStyleSchema = z.strictObject({
  size: z.number().int().min(10).max(72).optional(),
  weight: z.enum(['regular', 'semibold']).optional(),
  align: z.enum(['start', 'center']).optional()
});

const suggestedVariables = z.array(text(160)).max(100);

export const messageTemplateBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('heading'), text: optionalText(20_000),
    style: templateTextStyleSchema.optional(), suggestedVars: suggestedVariables.optional()
  }),
  z.strictObject({
    type: z.literal('paragraph'), text: optionalText(40_000),
    style: templateTextStyleSchema.optional(), suggestedVars: suggestedVariables.optional()
  }),
  z.strictObject({
    type: z.literal('details'),
    rows: z.array(z.strictObject({ label: text(500), value: optionalText(4_000) })).max(100),
    suggestedVars: suggestedVariables.optional()
  }),
  z.strictObject({
    type: z.literal('button'), label: text(500),
    href: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/).max(160)
  }),
  z.strictObject({ type: z.literal('divider') })
]);

export const mergeFieldDefinitionSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/).max(160),
  label: text(300),
  sample: optionalText(2_000)
});

export const messageTemplateDocumentSchema = z.strictObject({
  kind: z.literal('message'),
  key: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(120),
  name: text(300),
  purpose: text(2_000),
  subject: optionalText(2_000),
  blocks: z.array(messageTemplateBlockSchema).max(500),
  mergeFields: z.array(mergeFieldDefinitionSchema).max(500),
  usedBy: z.array(text(300)).max(100)
}).superRefine((document, context) => {
  const keys = new Set(document.mergeFields.map((entry) => entry.key));
  if (keys.size !== document.mergeFields.length) {
    context.addIssue({ code: 'custom', path: ['mergeFields'], message: 'merge fields must be unique' });
  }
  for (const [index, block] of document.blocks.entries()) {
    if (!('suggestedVars' in block) || block.suggestedVars === undefined) continue;
    for (const variable of block.suggestedVars) {
      if (!keys.has(variable)) context.addIssue({
        code: 'custom', path: ['blocks', index, 'suggestedVars'],
        message: 'suggested variables must reference declared merge fields'
      });
    }
  }
});

export const templateFieldGroupSchema = z.enum([
  'identity', 'contact', 'presence', 'talk', 'logistics', 'materials', 'other', 'consent'
]);
export const surfaceTemplateKindSchema = z.enum([
  'schedule', 'application-form', 'speaker-roster'
]);

export const surfaceTemplateBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('hero'), title: optionalText(2_000), intro: optionalText(10_000),
    titleStyle: templateTextStyleSchema.optional(), introStyle: templateTextStyleSchema.optional()
  }),
  z.strictObject({
    type: z.literal('schedule-days'), grouping: z.enum(['day', 'track']),
    showRoom: z.boolean(), showTrack: z.boolean(), showSpeakers: z.boolean(),
    density: z.enum(['cozy', 'compact'])
  }),
  z.strictObject({
    type: z.literal('roster-list'), layout: z.enum(['grid', 'list', 'strip', 'profile']),
    grouping: z.enum(['none', 'category']), showHeadline: z.boolean(),
    showSessions: z.boolean(), showLinks: z.boolean(), density: z.enum(['cozy', 'compact'])
  }),
  z.strictObject({
    type: z.literal('form-section'), title: text(2_000), description: optionalText(10_000).optional(),
    groups: z.array(templateFieldGroupSchema).max(8).optional(),
    fieldRefs: z.array(id).max(500)
  }),
  z.strictObject({ type: z.literal('note'), text: optionalText(10_000), style: templateTextStyleSchema.optional() })
]);

export const surfaceTemplateDocumentSchema = z.strictObject({
  kind: z.literal('surface'),
  surfaceKind: surfaceTemplateKindSchema,
  name: text(300),
  purpose: text(2_000),
  blocks: z.array(surfaceTemplateBlockSchema).max(500),
  submitLabel: text(500).optional(),
  usedBy: z.array(text(300)).max(100)
});

export const eventThemeDocumentSchema = z.strictObject({
  kind: z.literal('theme'),
  recipe: styleSetRecipeSchema,
  markText: z.string().max(3).refine((value) => value.normalize('NFC').trim() === value)
});

export const templateArtifactDocumentSchema = z.discriminatedUnion('kind', [
  messageTemplateDocumentSchema,
  surfaceTemplateDocumentSchema,
  eventThemeDocumentSchema
]);

export const templateArtifactScopeSchema = z.strictObject({ workspaceId: id, eventId: id });
export const templateArtifactRevisionAuthorSchema = z.enum(['organizer', 'agent', 'system']);
export const templateArtifactRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: templateArtifactScopeSchema,
  artifactId: id,
  revisionId: id,
  number: z.number().int().positive(),
  predecessor: z.strictObject({ revisionId: id, digestSha256: z.string().regex(DIGEST) }).nullable(),
  document: templateArtifactDocumentSchema,
  author: templateArtifactRevisionAuthorSchema,
  note: text(2_000),
  createdByUserId: id,
  createdAt: canonicalInstant,
  digestSha256: z.string().regex(DIGEST)
});

export const templateArtifactHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: templateArtifactScopeSchema,
  artifactId: id,
  artifactKind: z.enum(['message', 'surface', 'theme']),
  currentRevisionId: id,
  currentRevisionNumber: z.number().int().positive(),
  version: z.number().int().positive()
});

export const templateArtifactSnapshotSchema = z.strictObject({
  head: templateArtifactHeadSchema,
  current: templateArtifactRevisionSchema,
  history: z.array(templateArtifactRevisionSchema).min(1).max(10_000)
}).superRefine((snapshot, context) => {
  const current = snapshot.current;
  if (snapshot.head.artifactId !== current.artifactId
      || snapshot.head.artifactKind !== current.document.kind
      || snapshot.head.currentRevisionId !== current.revisionId
      || snapshot.head.currentRevisionNumber !== current.number
      || snapshot.history.at(-1)?.revisionId !== current.revisionId) {
    context.addIssue({ code: 'custom', message: 'artifact head and revision history are incoherent' });
  }
});

export const templateArtifactReplaceInputSchema = z.strictObject({
  action: z.literal('replace'),
  artifactId: id,
  expectedRevisionNumber: z.number().int().positive(),
  document: templateArtifactDocumentSchema,
  author: z.enum(['organizer', 'agent']),
  note: text(2_000)
});
export const templateArtifactRevertInputSchema = z.strictObject({
  action: z.literal('revert'),
  artifactId: id,
  expectedRevisionNumber: z.number().int().positive(),
  targetRevisionNumber: z.number().int().positive()
});
export const templateArtifactMutationInputSchema = z.discriminatedUnion('action', [
  templateArtifactReplaceInputSchema,
  templateArtifactRevertInputSchema
]);

export const templateArtifactAuthorInputSchema = z.strictObject({
  scope: templateArtifactScopeSchema,
  mutation: templateArtifactMutationInputSchema,
  revisionId: id,
  actorUserId: id,
  occurredAt: canonicalInstant
});

export const templateArtifactMutationPlanSchema = z.strictObject({
  action: z.enum(['replace', 'revert']),
  scope: templateArtifactScopeSchema,
  artifactId: id,
  expectedHeadVersion: z.number().int().positive(),
  before: templateArtifactRevisionSchema,
  after: templateArtifactRevisionSchema,
  restoredFromRevisionNumber: z.number().int().positive().nullable()
});

export const templateArtifactSafeDiffSchema = z.strictObject({
  action: z.enum(['replace', 'revert']),
  artifactId: id,
  artifactKind: z.enum(['message', 'surface', 'theme']),
  before: templateArtifactRevisionSchema,
  after: templateArtifactRevisionSchema,
  restoredFromRevisionNumber: z.number().int().positive().nullable()
}).superRefine((diff, context) => {
  if (diff.before.artifactId !== diff.artifactId
      || diff.after.artifactId !== diff.artifactId
      || diff.before.document.kind !== diff.artifactKind
      || diff.after.document.kind !== diff.artifactKind
      || diff.after.number !== diff.before.number + 1
      || diff.after.predecessor?.revisionId !== diff.before.revisionId
      || diff.after.predecessor.digestSha256 !== diff.before.digestSha256) {
    context.addIssue({ code: 'custom', message: 'template artifact diff is incoherent' });
  }
});

export const templateArtifactListInputSchema = z.strictObject({
  kind: z.enum(['message', 'surface', 'theme']).optional()
});
export const templateArtifactGetInputSchema = z.strictObject({ artifactId: id });
export const templateArtifactListDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  artifacts: z.array(templateArtifactSnapshotSchema).max(10_000)
});
export const templateArtifactListCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: templateArtifactListDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const templateArtifactGetCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: templateArtifactSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const templateArtifactListOperationResultSchema =
  createReadOperationResultSchema(templateArtifactListDataSchema);
export const templateArtifactGetOperationResultSchema =
  createReadOperationResultSchema(templateArtifactSnapshotSchema);

export const templateArtifactMutationDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(['replace', 'revert']),
  changesetId: changesetApplicationIdSchema,
  headVersion: z.number().int().positive(),
  status: z.literal('draft'),
  revision: z.strictObject({
    id: changesetApplicationIdSchema,
    number: z.number().int().positive(),
    digestSha256: z.string().regex(DIGEST)
  }),
  riskTier: z.enum(['low', 'normal', 'consequential']),
  approvalPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: z.string().regex(DIGEST),
    requirement: z.enum(['none', 'distinct_current_human'])
  }),
  safeDiff: templateArtifactSafeDiffSchema
});
export const templateArtifactMutationDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: templateArtifactMutationDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const templateArtifactMutationDraftOperationResultSchema =
  createEffectfulOperationResultSchema(templateArtifactMutationDraftDataSchema);

export const templateEditModelChoiceSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(120),
  label: text(300),
  sub: text(1_000).optional(),
  profile: versionedDefinitionRefSchema,
  profileDigestSha256: z.string().regex(DIGEST)
});
export const templateEditClassificationSchema = z.strictObject({
  scope: z.enum(['quick', 'comprehensive']),
  profileLabel: text(300),
  reason: text(1_000),
  chosenBy: z.enum(['auto', 'you']),
  profile: versionedDefinitionRefSchema,
  profileDigestSha256: z.string().regex(DIGEST)
});
export const templateEditModelChoicesDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  choices: z.array(templateEditModelChoiceSchema).min(2).max(20)
});
export const templateEditModelChoicesInputSchema = z.strictObject({});
export const templateEditModelChoicesCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: templateEditModelChoicesDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const templateEditModelChoicesOperationResultSchema =
  createReadOperationResultSchema(templateEditModelChoicesDataSchema);
export const templateEditRequestSchema = z.strictObject({
  artifactId: id,
  instruction: text(20_000),
  modelChoiceId: templateEditModelChoiceSchema.shape.id.default('auto')
});
export const templateEditClassifyDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  artifactId: id,
  classification: templateEditClassificationSchema
});
export const templateEditClassifyCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: templateEditClassifyDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const templateEditClassifyOperationResultSchema =
  createEffectfulOperationResultSchema(templateEditClassifyDataSchema);
export const templateEditReviseDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  artifactId: id,
  baseRevisionNumber: z.number().int().positive(),
  document: templateArtifactDocumentSchema,
  note: text(2_000),
  classification: templateEditClassificationSchema,
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative()
  }),
  scaffold: versionedDefinitionRefSchema,
  scaffoldDigestSha256: z.string().regex(DIGEST)
});
export const templateEditReviseCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: templateEditReviseDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const templateEditReviseOperationResultSchema =
  createEffectfulOperationResultSchema(templateEditReviseDataSchema);

export const TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS = Object.freeze({
  list: createOperationSchemaManifestRefs({
    inputKey: 'schema.template_artifact.list.input',
    inputSchema: templateArtifactListInputSchema,
    resultKey: 'schema.template_artifact.list.operator-result',
    resultSchema: templateArtifactListOperationResultSchema
  }),
  get: createOperationSchemaManifestRefs({
    inputKey: 'schema.template_artifact.get.input',
    inputSchema: templateArtifactGetInputSchema,
    resultKey: 'schema.template_artifact.get.operator-result',
    resultSchema: templateArtifactGetOperationResultSchema
  }),
  mutationDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.template_artifact.mutation-draft.input',
    inputSchema: templateArtifactMutationInputSchema,
    resultKey: 'schema.template_artifact.mutation-draft.operator-result',
    resultSchema: templateArtifactMutationDraftOperationResultSchema
  }),
  modelChoices: createOperationSchemaManifestRefs({
    inputKey: 'schema.template_edit.model_choices.input',
    inputSchema: templateEditModelChoicesInputSchema,
    resultKey: 'schema.template_edit.model_choices.operator-result',
    resultSchema: templateEditModelChoicesOperationResultSchema
  }),
  classify: createOperationSchemaManifestRefs({
    inputKey: 'schema.template_edit.classify.input',
    inputSchema: templateEditRequestSchema,
    resultKey: 'schema.template_edit.classify.operator-result',
    resultSchema: templateEditClassifyOperationResultSchema
  }),
  revise: createOperationSchemaManifestRefs({
    inputKey: 'schema.template_edit.revise.input',
    inputSchema: templateEditRequestSchema,
    resultKey: 'schema.template_edit.revise.operator-result',
    resultSchema: templateEditReviseOperationResultSchema
  })
});

export type MessageTemplateDocumentDto = z.infer<typeof messageTemplateDocumentSchema>;
export type SurfaceTemplateDocumentDto = z.infer<typeof surfaceTemplateDocumentSchema>;
export type EventThemeDocumentDto = z.infer<typeof eventThemeDocumentSchema>;
export type TemplateArtifactDocumentDto = z.infer<typeof templateArtifactDocumentSchema>;
export type TemplateArtifactScopeDto = z.infer<typeof templateArtifactScopeSchema>;
export type TemplateArtifactRevisionDto = z.infer<typeof templateArtifactRevisionSchema>;
export type TemplateArtifactHeadDto = z.infer<typeof templateArtifactHeadSchema>;
export type TemplateArtifactSnapshotDto = z.infer<typeof templateArtifactSnapshotSchema>;
export type TemplateArtifactMutationInputDto = z.infer<typeof templateArtifactMutationInputSchema>;
export type TemplateArtifactAuthorInputDto = z.infer<typeof templateArtifactAuthorInputSchema>;
export type TemplateArtifactMutationPlanDto = z.infer<typeof templateArtifactMutationPlanSchema>;
export type TemplateArtifactSafeDiffDto = z.infer<typeof templateArtifactSafeDiffSchema>;
export type TemplateEditModelChoiceDto = z.infer<typeof templateEditModelChoiceSchema>;
export type TemplateEditClassificationDto = z.infer<typeof templateEditClassificationSchema>;
export type TemplateEditRequestDto = z.infer<typeof templateEditRequestSchema>;
export type TemplateEditReviseDataDto = z.infer<typeof templateEditReviseDataSchema>;
