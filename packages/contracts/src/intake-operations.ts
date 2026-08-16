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

/**
 * One successor apply-surface release a reviewed Form-version publish plans in
 * the same atomic publish unit: the surface currently rendering the form is
 * re-released pinning the new version. Absent on pre-successor revisions.
 */
export const intakeFormSurfaceSuccessorDiffSchema = z.strictObject({
  surfaceReleaseId: intakeIdSchema,
  supersedesReleaseId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  headVersion: z.number().int().positive().safe()
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
    }),
    surfaceSuccessors: z.array(intakeFormSurfaceSuccessorDiffSchema).max(20).optional()
  }),
  z.strictObject({
    action: z.literal('lifecycle'),
    before: intakeFormSafeHeadSchema,
    after: intakeFormSafeHeadSchema,
    publishedVersion: z.strictObject({
      id: intakeIdSchema,
      number: z.number().int().positive().safe(),
      definitionDigestSha256: intakeDigestSchema
    }).nullable(),
    surfaceSuccessors: z.array(intakeFormSurfaceSuccessorDiffSchema).max(20).nullable().optional()
  }),
  z.strictObject({
    action: z.literal('closing'),
    before: intakeFormSafeHeadSchema,
    after: intakeFormSafeHeadSchema,
    deadline: deadlineSafeDiffSchema
  })
]);

export const intakeFormWriteActionSchema = z.enum([
  'create',
  'revise',
  'set_closing',
  'update_closing',
  'remove_closing',
  'close',
  'reopen',
  'publish',
  'publish_and_open'
]);

export const intakeFormDirectLifecycleInputSchema = z.discriminatedUnion('transition', [
  z.strictObject({
    transition: z.literal('close'),
    formId: intakeIdInputSchema,
    expectedDefinitionVersion: z.number().int().positive().safe()
  }),
  z.strictObject({
    transition: z.literal('reopen'),
    formId: intakeIdInputSchema,
    expectedDefinitionVersion: z.number().int().positive().safe()
  })
]);

export const intakeFormWriteDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: intakeFormWriteActionSchema,
  formId: intakeIdSchema,
  formDefinitionVersion: z.number().int().positive().safe(),
  catalogVersion: z.number().int().positive().safe(),
  publishedVersionId: intakeIdSchema.nullable()
});

export const intakeFormDirectCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: intakeFormWriteDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const intakeFormDirectOperationResultSchema =
  createEffectfulOperationResultSchema(intakeFormWriteDataSchema);

export const intakeFormVersionReviewActionSchema = z.enum(['publish', 'publish_and_open']);
export const intakeFormVersionReviewInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('publish'),
    formId: intakeIdInputSchema,
    expectedDefinitionVersion: z.number().int().positive().safe(),
    expectedRegistryVersion: z.number().int().positive().safe()
  }),
  z.strictObject({
    action: z.literal('publish_and_open'),
    formId: intakeIdInputSchema,
    expectedDefinitionVersion: z.number().int().positive().safe(),
    expectedRegistryVersion: z.number().int().positive().safe()
  })
]);

export const intakeFormVersionReviewSafeDiffSchema = z.strictObject({
  action: intakeFormVersionReviewActionSchema,
  before: intakeFormSafeHeadSchema,
  after: intakeFormSafeHeadSchema,
  publishedVersion: z.strictObject({
    id: intakeIdSchema,
    number: z.number().int().positive().safe(),
    definitionDigestSha256: intakeDigestSchema
  }),
  surfaceSuccessors: z.array(intakeFormSurfaceSuccessorDiffSchema).max(20)
});

export const intakeFormVersionReviewDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: intakeFormVersionReviewActionSchema,
  draftId: canonicalUuid,
  status: z.literal('draft'),
  revision: z.strictObject({
    id: canonicalUuid,
    number: z.literal(1),
    digestSha256: intakeDigestSchema
  }),
  safeDiff: intakeFormVersionReviewSafeDiffSchema
});
export const intakeFormVersionReviewDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: intakeFormVersionReviewDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const intakeFormVersionReviewDraftOperationResultSchema =
  createEffectfulOperationResultSchema(intakeFormVersionReviewDraftDataSchema);

export const intakeFormVersionPublishInputSchema = z.strictObject({
  draftId: canonicalUuid,
  revisionId: canonicalUuid,
  revisionDigestSha256: intakeDigestSchema
});
export const intakeFormVersionPublishCanonicalResultSchema = intakeFormDirectCanonicalResultSchema;
export const intakeFormVersionPublishOperationResultSchema = intakeFormDirectOperationResultSchema;

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
  formWrites: Object.freeze({
    create: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-create.input',
      inputSchema: formDefinitionCreateDraftInputSchema,
      resultKey: 'schema.intake.form-direct.operator-result',
      resultSchema: intakeFormDirectOperationResultSchema
    }),
    revise: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-revise.input',
      inputSchema: formDefinitionReviseDraftInputSchema,
      resultKey: 'schema.intake.form-direct.operator-result',
      resultSchema: intakeFormDirectOperationResultSchema
    }),
    closing: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-closing.input',
      inputSchema: formClosingChangeDraftInputSchema,
      resultKey: 'schema.intake.form-direct.operator-result',
      resultSchema: intakeFormDirectOperationResultSchema
    }),
    lifecycle: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-lifecycle.input',
      inputSchema: intakeFormDirectLifecycleInputSchema,
      resultKey: 'schema.intake.form-direct.operator-result',
      resultSchema: intakeFormDirectOperationResultSchema
    }),
    publishDraft: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-version-review.input',
      inputSchema: intakeFormVersionReviewInputSchema,
      resultKey: 'schema.intake.form-version-review.operator-result',
      resultSchema: intakeFormVersionReviewDraftOperationResultSchema
    }),
    publish: createOperationSchemaManifestRefs({
      inputKey: 'schema.intake.form-version-publish.input',
      inputSchema: intakeFormVersionPublishInputSchema,
      resultKey: 'schema.intake.form-version-publish.operator-result',
      resultSchema: intakeFormVersionPublishOperationResultSchema
    })
  })
});

export type IntakeFormDraftAction = z.infer<typeof intakeFormDraftActionSchema>;
export type IntakeFormSurfaceSuccessorDiff = z.infer<typeof intakeFormSurfaceSuccessorDiffSchema>;
export type IntakeFormSafeDiff = z.infer<typeof intakeFormSafeDiffSchema>;
export type IntakeFormWriteAction = z.infer<typeof intakeFormWriteActionSchema>;
export type IntakeFormWriteData = z.infer<typeof intakeFormWriteDataSchema>;
export type IntakeFormVersionReviewAction = z.infer<typeof intakeFormVersionReviewActionSchema>;
export type IntakeFormVersionReviewInput = z.infer<typeof intakeFormVersionReviewInputSchema>;
export type IntakeFormVersionReviewSafeDiff = z.infer<typeof intakeFormVersionReviewSafeDiffSchema>;
export type IntakeFormVersionPublishInput = z.infer<typeof intakeFormVersionPublishInputSchema>;
