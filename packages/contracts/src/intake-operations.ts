import { z } from 'zod';
import { deadlineSafeDiffSchema } from './deadlines';
import {
  formDefinitionContentSchema,
  intakeDigestSchema,
  intakeIdInputSchema,
  intakeIdSchema,
  organizerFormCatalogSchema,
  organizerFormDetailSchema,
  formClosingChangeDraftInputSchema,
  formDefinitionCreateDraftInputSchema,
  formDefinitionReviseDraftInputSchema,
  formLifecycleChangeDraftInputSchema,
  formVersionPublishDraftInputSchema
} from './forms';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';
import {
  organizerSubmissionContactSchema,
  organizerSubmissionDetailSchema,
  organizerSubmissionSummarySchema
} from './submissions';

const canonicalUuid = z.uuid().refine((value) => value === value.toLowerCase());

export const intakeFormDraftActionSchema = z.enum([
  'create', 'revise', 'publish', 'lifecycle', 'closing'
]);

const intakeFormSafeHeadSchema = z.strictObject({
  id: intakeIdSchema,
  version: z.number().int().positive().safe(),
  status: z.enum(['draft', 'open', 'closed']),
  currentPublishedVersionId: intakeIdSchema.nullable(),
  definition: formDefinitionContentSchema
});

export const intakeFormSafeDiffSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'), before: z.null(), after: intakeFormSafeHeadSchema
  }),
  z.strictObject({
    action: z.literal('revise'), before: intakeFormSafeHeadSchema, after: intakeFormSafeHeadSchema
  }),
  z.strictObject({
    action: z.literal('publish'),
    before: intakeFormSafeHeadSchema,
    after: intakeFormSafeHeadSchema,
    publishedVersion: z.strictObject({
      id: intakeIdSchema,
      number: z.number().int().positive().safe(),
      definitionDigestSha256: intakeDigestSchema
    })
  }),
  z.strictObject({
    action: z.literal('lifecycle'),
    before: intakeFormSafeHeadSchema,
    after: intakeFormSafeHeadSchema,
    publishedVersion: z.strictObject({
      id: intakeIdSchema,
      number: z.number().int().positive().safe(),
      definitionDigestSha256: intakeDigestSchema
    }).nullable()
  }),
  z.strictObject({
    action: z.literal('closing'),
    before: intakeFormSafeHeadSchema,
    after: intakeFormSafeHeadSchema,
    deadline: deadlineSafeDiffSchema
  })
]);

export const intakeFormDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: intakeFormDraftActionSchema,
  changesetId: canonicalUuid,
  headVersion: z.number().int().positive().safe(),
  status: z.literal('draft'),
  revision: z.strictObject({
    id: canonicalUuid,
    number: z.number().int().positive().safe(),
    digestSha256: intakeDigestSchema
  }),
  riskTier: z.enum(['low', 'normal', 'consequential']),
  approvalPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: intakeDigestSchema,
    requirement: z.enum(['none', 'distinct_current_human'])
  }),
  safeDiff: intakeFormSafeDiffSchema
}).superRefine((data, context) => {
  if (data.action !== data.safeDiff.action) {
    context.addIssue({ code: 'custom', path: ['safeDiff', 'action'], message: 'action mismatch' });
  }
});

export const intakeFormDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: intakeFormDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const intakeFormDraftOperationResultSchema =
  createEffectfulOperationResultSchema(intakeFormDraftDataSchema);

export const intakeEmptyReadInputSchema = z.strictObject({});
export const intakeFormReadInputSchema = z.strictObject({ formId: intakeIdInputSchema });
export const intakeSubmissionReadInputSchema = z.strictObject({
  submissionId: intakeIdInputSchema
});

export const organizerSubmissionListSchema = z.array(organizerSubmissionSummarySchema)
  .max(500)
  .superRefine((values, context) => {
    for (let index = 1; index < values.length; index += 1) {
      if (values[index - 1]!.id >= values[index]!.id) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'items must have unique IDs in canonical code-unit order'
        });
      }
    }
  });

export const organizerFormCatalogReadResultSchema =
  createReadOperationResultSchema(organizerFormCatalogSchema);
export const organizerFormDetailReadResultSchema =
  createReadOperationResultSchema(organizerFormDetailSchema);
export const organizerSubmissionListReadResultSchema =
  createReadOperationResultSchema(organizerSubmissionListSchema);
export const organizerSubmissionDetailReadResultSchema =
  createReadOperationResultSchema(organizerSubmissionDetailSchema);
export const organizerSubmissionContactReadResultSchema =
  createReadOperationResultSchema(organizerSubmissionContactSchema);

/** Exact public schema identities projected into Intake operator bindings. */
export const INTAKE_OPERATION_SCHEMA_REFS = Object.freeze({
  formList: createOperationSchemaManifestRefs({
    inputKey: 'schema.form.list.input',
    inputSchema: intakeEmptyReadInputSchema,
    resultKey: 'schema.form.list.projected-result',
    resultSchema: organizerFormCatalogReadResultSchema
  }),
  formRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.form.read.input',
    inputSchema: intakeFormReadInputSchema,
    resultKey: 'schema.form.read.projected-result',
    resultSchema: organizerFormDetailReadResultSchema
  }),
  submissionList: createOperationSchemaManifestRefs({
    inputKey: 'schema.submission.list.input',
    inputSchema: intakeEmptyReadInputSchema,
    resultKey: 'schema.submission.list.projected-result',
    resultSchema: organizerSubmissionListReadResultSchema
  }),
  submissionRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.submission.read.input',
    inputSchema: intakeSubmissionReadInputSchema,
    resultKey: 'schema.submission.read.projected-result',
    resultSchema: organizerSubmissionDetailReadResultSchema
  }),
  submissionContactRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.submission.contact-read.input',
    inputSchema: intakeSubmissionReadInputSchema,
    resultKey: 'schema.submission.contact-read.projected-result',
    resultSchema: organizerSubmissionContactReadResultSchema
  }),
  formDrafts: Object.freeze({
    create: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-create-draft.input',
      inputSchema: formDefinitionCreateDraftInputSchema,
      resultKey: 'schema.intake.form-draft.operator-result',
      resultSchema: intakeFormDraftOperationResultSchema
    }),
    revise: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-revise-draft.input',
      inputSchema: formDefinitionReviseDraftInputSchema,
      resultKey: 'schema.intake.form-draft.operator-result',
      resultSchema: intakeFormDraftOperationResultSchema
    }),
    publish: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-publish-draft.input',
      inputSchema: formVersionPublishDraftInputSchema,
      resultKey: 'schema.intake.form-draft.operator-result',
      resultSchema: intakeFormDraftOperationResultSchema
    }),
    lifecycle: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-lifecycle-draft.input',
      inputSchema: formLifecycleChangeDraftInputSchema,
      resultKey: 'schema.intake.form-draft.operator-result',
      resultSchema: intakeFormDraftOperationResultSchema
    }),
    closing: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-closing-draft.input',
      inputSchema: formClosingChangeDraftInputSchema,
      resultKey: 'schema.intake.form-draft.operator-result',
      resultSchema: intakeFormDraftOperationResultSchema
    })
  })
});

export type IntakeFormDraftAction = z.infer<typeof intakeFormDraftActionSchema>;
export type IntakeFormSafeDiff = z.infer<typeof intakeFormSafeDiffSchema>;
export type IntakeFormDraftData = z.infer<typeof intakeFormDraftDataSchema>;
