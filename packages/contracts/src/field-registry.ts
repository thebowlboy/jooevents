import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';

const FIELD_LABEL_LIMIT = 240;
const FIELD_HELP_LIMIT = 2_000;
const FIELD_OPTION_LABEL_LIMIT = 240;
const FIELD_REGISTRY_MAX_FIELDS = 500;
const FIELD_OPTIONS_MAX = 200;
const APPLICATION_UUID_INPUT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLICATION_UUID_CANONICAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STABLE_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;

function normalizeLine(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function canonicalLine(limit: number) {
  return z.string()
    .refine((value) => {
      const normalized = normalizeLine(value);
      return normalized.length > 0 && normalized.length <= limit;
    })
    .overwrite(normalizeLine);
}

function optionalCanonicalText(limit: number) {
  return z.string()
    .refine((value) => {
      const normalized = value.normalize('NFC').trim();
      return normalized.length > 0 && normalized.length <= limit;
    })
    .overwrite((value) => value.normalize('NFC').trim());
}

export const fieldRegistryIdInputSchema = z.string()
  .regex(APPLICATION_UUID_INPUT)
  .overwrite((value) => value.toLowerCase());
export const fieldRegistryIdSchema = z.string().regex(APPLICATION_UUID_CANONICAL);
export const fieldRegistryVersionSchema = z.number().int().positive().safe();
export const fieldRegistryDigestSchema = z.string().regex(DIGEST);
export const fieldRegistryStableKeySchema = z.string().regex(STABLE_KEY).max(160);
export const fieldRegistryLabelInputSchema = canonicalLine(FIELD_LABEL_LIMIT);
export const fieldRegistryLabelSchema = z.string()
  .min(1).max(FIELD_LABEL_LIMIT)
  .refine((value) => normalizeLine(value) === value);
export const fieldRegistryHelpInputSchema = optionalCanonicalText(FIELD_HELP_LIMIT);
export const fieldRegistryHelpSchema = z.string()
  .min(1).max(FIELD_HELP_LIMIT)
  .refine((value) => value.normalize('NFC').trim() === value);
export const fieldRegistryOptionLabelInputSchema = canonicalLine(FIELD_OPTION_LABEL_LIMIT);
export const fieldRegistryOptionLabelSchema = z.string()
  .min(1).max(FIELD_OPTION_LABEL_LIMIT)
  .refine((value) => normalizeLine(value) === value);

export const fieldRegistryScopeSchema = z.strictObject({
  workspaceId: fieldRegistryIdSchema,
  eventId: fieldRegistryIdSchema
});

export const fieldRegistryContextSchema = z.enum(['apply', 'onboard', 'profile']);
export const fieldRegistryKindSchema = z.enum([
  'text', 'textarea', 'email', 'url', 'phone', 'number', 'date', 'datetime',
  'select', 'multiselect', 'checkbox', 'file'
]);
export const fieldRegistryGroupSchema = z.enum([
  'identity', 'contact', 'presence', 'talk', 'logistics', 'materials', 'other', 'consent'
]);
export const fieldRegistryAnswerOwnerSchema = z.enum(['person', 'talk']);
export const fieldRegistryOptionSourceSchema = z.enum(['tracks', 'formats']);
export const fieldRegistryMapsToSchema = z.enum([
  'person.name',
  'person.email',
  'talk.title',
  'talk.abstract',
  'talk.track',
  'talk.format'
]);
export const fieldRegistryPurposeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ordinary') }),
  z.strictObject({
    kind: z.literal('consent'),
    key: fieldRegistryStableKeySchema
  })
]);

export const fieldRegistryContextPolicySchema = z.strictObject({
  visible: z.boolean(),
  required: z.boolean()
}).superRefine((policy, context) => {
  if (policy.required && !policy.visible) {
    context.addIssue({
      code: 'custom',
      path: ['required'],
      message: 'A hidden field cannot be required.'
    });
  }
});

export const fieldRegistryContextsSchema = z.strictObject({
  apply: fieldRegistryContextPolicySchema,
  onboard: fieldRegistryContextPolicySchema,
  profile: fieldRegistryContextPolicySchema
}).superRefine((contexts, context) => {
  if (!contexts.apply.visible && !contexts.onboard.visible && !contexts.profile.visible) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'A field must be visible in at least one collection context.'
    });
  }
});

export const fieldRegistryFieldScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('shared') }),
  z.strictObject({ kind: z.literal('form'), formId: fieldRegistryIdSchema })
]);

export const fieldRegistryChoiceSchema = z.strictObject({
  id: fieldRegistryIdSchema,
  key: fieldRegistryStableKeySchema,
  label: fieldRegistryOptionLabelSchema,
  position: z.number().int().nonnegative().safe()
});

export const fieldRegistryOptionConfigurationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('custom'),
    choices: z.array(fieldRegistryChoiceSchema).min(1).max(FIELD_OPTIONS_MAX)
  }),
  z.strictObject({
    kind: z.literal('program_vocabulary'),
    source: fieldRegistryOptionSourceSchema
  })
]);

export const fieldRegistryConstraintsSchema = z.strictObject({
  removal: z.enum(['allowed', 'forbidden']),
  applyVisibility: z.enum(['editable', 'required_visible'])
});

const fieldDefinitionShape = {
  id: fieldRegistryIdSchema,
  key: fieldRegistryStableKeySchema,
  version: fieldRegistryVersionSchema,
  kind: fieldRegistryKindSchema,
  label: fieldRegistryLabelSchema,
  help: fieldRegistryHelpSchema.nullable(),
  answerOwner: fieldRegistryAnswerOwnerSchema,
  mapsTo: fieldRegistryMapsToSchema.nullable(),
  purpose: fieldRegistryPurposeSchema,
  scope: fieldRegistryFieldScopeSchema,
  group: fieldRegistryGroupSchema,
  position: z.number().int().nonnegative().safe(),
  contexts: fieldRegistryContextsSchema,
  options: fieldRegistryOptionConfigurationSchema,
  constraints: fieldRegistryConstraintsSchema,
  fileUpload: z.enum(['not_applicable', 'disabled'])
} as const;

function addFieldDefinitionIssues(
  field: z.infer<z.ZodObject<typeof fieldDefinitionShape>>,
  context: z.core.$RefinementCtx
): void {
  const mappingCompatible = field.mapsTo === null
    || (field.mapsTo === 'person.name'
      && field.answerOwner === 'person' && field.kind === 'text')
    || (field.mapsTo === 'person.email'
      && field.answerOwner === 'person' && field.kind === 'email')
    || (field.mapsTo === 'talk.title'
      && field.answerOwner === 'talk' && field.kind === 'text')
    || (field.mapsTo === 'talk.abstract'
      && field.answerOwner === 'talk' && field.kind === 'textarea')
    || (field.mapsTo === 'talk.track'
      && field.answerOwner === 'talk' && field.kind === 'select'
      && field.options.kind === 'program_vocabulary' && field.options.source === 'tracks')
    || (field.mapsTo === 'talk.format'
      && field.answerOwner === 'talk' && field.kind === 'select'
      && field.options.kind === 'program_vocabulary' && field.options.source === 'formats');
  if (!mappingCompatible) {
    context.addIssue({
      code: 'custom', path: ['mapsTo'],
      message: 'A canonical mapping must match the field kind, answer owner, and option source.'
    });
  }
  if (field.purpose.kind === 'consent' && field.kind !== 'checkbox') {
    context.addIssue({
      code: 'custom', path: ['purpose'],
      message: 'Only checkbox fields may carry a consent purpose.'
    });
  }
  const choiceKind = field.kind === 'select' || field.kind === 'multiselect';
  if (choiceKind !== (field.options.kind !== 'none')) {
    context.addIssue({
      code: 'custom',
      path: ['options'],
      message: choiceKind
        ? 'Choice fields require custom or vocabulary-backed options.'
        : 'Only choice fields may carry options.'
    });
  }
  if (field.options.kind === 'custom') {
    const seenIds = new Set<string>();
    const seenKeys = new Set<string>();
    const seenLabels = new Set<string>();
    field.options.choices.forEach((choice, index) => {
      if (choice.position !== index) {
        context.addIssue({
          code: 'custom', path: ['options', 'choices', index, 'position'],
          message: 'Choice positions must be contiguous and match array order.'
        });
      }
      const folded = choice.label.toLocaleLowerCase('en-US');
      if (seenIds.has(choice.id) || seenKeys.has(choice.key) || seenLabels.has(folded)) {
        context.addIssue({
          code: 'custom', path: ['options', 'choices', index],
          message: 'Choice IDs, keys, and labels must be unique.'
        });
      }
      seenIds.add(choice.id);
      seenKeys.add(choice.key);
      seenLabels.add(folded);
    });
  }
  if (field.scope.kind === 'form'
      && (!field.contexts.apply.visible
        || field.contexts.onboard.visible
        || field.contexts.profile.visible)) {
    context.addIssue({
      code: 'custom',
      path: ['contexts'],
      message: 'Form-scoped fields are collected only by their application form.'
    });
  }
  if (field.constraints.applyVisibility === 'required_visible'
      && !field.contexts.apply.visible) {
    context.addIssue({
      code: 'custom', path: ['contexts', 'apply', 'visible'],
      message: 'This field must remain visible in the apply context.'
    });
  }
  if (field.kind === 'file' ? field.fileUpload !== 'disabled' : field.fileUpload !== 'not_applicable') {
    context.addIssue({
      code: 'custom', path: ['fileUpload'],
      message: 'File fields remain upload-disabled until media storage is active.'
    });
  }
}

export const fieldRegistryFieldDefinitionSchema = z.strictObject(fieldDefinitionShape)
  .superRefine(addFieldDefinitionIssues);

export const fieldRegistryResolvedOptionSchema = z.strictObject({
  id: fieldRegistryIdSchema,
  label: fieldRegistryOptionLabelSchema,
  version: fieldRegistryVersionSchema
});

export const fieldRegistryFieldViewSchema = z.strictObject({
  ...fieldDefinitionShape,
  resolvedOptions: z.array(fieldRegistryResolvedOptionSchema).max(FIELD_OPTIONS_MAX).nullable()
}).superRefine((field, context) => {
  addFieldDefinitionIssues(field, context);
  if ((field.options.kind === 'program_vocabulary') !== (field.resolvedOptions !== null)) {
    context.addIssue({
      code: 'custom', path: ['resolvedOptions'],
      message: 'Only vocabulary-backed fields resolve live options.'
    });
  }
});

function addSnapshotIssues(
  snapshot: { readonly fields: readonly z.infer<typeof fieldRegistryFieldViewSchema>[] },
  context: z.core.$RefinementCtx
): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const mappings = new Set<string>();
  snapshot.fields.forEach((field, index) => {
    if (field.position !== index) {
      context.addIssue({
        code: 'custom', path: ['fields', index, 'position'],
        message: 'Field positions must be contiguous and match array order.'
      });
    }
    if (ids.has(field.id) || keys.has(field.key)) {
      context.addIssue({
        code: 'custom', path: ['fields', index],
        message: 'Field IDs and stable keys must be unique.'
      });
    }
    ids.add(field.id);
    keys.add(field.key);
    if (field.mapsTo !== null) {
      if (mappings.has(field.mapsTo)) {
        context.addIssue({
          code: 'custom', path: ['fields', index, 'mapsTo'],
          message: 'Canonical mappings must be unique in the registry.'
        });
      }
      mappings.add(field.mapsTo);
    }
    if (field.options.kind === 'custom') {
      field.options.choices.forEach((choice, choiceIndex) => {
        if (ids.has(choice.id)) {
          context.addIssue({
            code: 'custom',
            path: ['fields', index, 'options', 'choices', choiceIndex, 'id'],
            message: 'Application IDs must be unique across the registry.'
          });
        }
        ids.add(choice.id);
      });
    }
  });
}

export const fieldRegistrySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: fieldRegistryScopeSchema,
  version: fieldRegistryVersionSchema,
  registryDigestSha256: fieldRegistryDigestSchema,
  fields: z.array(fieldRegistryFieldViewSchema).max(FIELD_REGISTRY_MAX_FIELDS)
}).superRefine(addSnapshotIssues);

export const fieldRegistrySnapshotReadInputSchema = z.strictObject({});
export const fieldRegistrySnapshotCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: fieldRegistrySnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const fieldRegistrySnapshotReadResultSchema =
  createReadOperationResultSchema(fieldRegistrySnapshotSchema);

const contextAuthorSchema = fieldRegistryContextsSchema;
const fieldScopeInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('shared') }),
  z.strictObject({ kind: z.literal('form'), formId: fieldRegistryIdInputSchema })
]);
const authoredOptionsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('custom'),
    labels: z.array(fieldRegistryOptionLabelInputSchema).min(1).max(FIELD_OPTIONS_MAX)
  }).superRefine((value, context) => {
    const folded = value.labels.map((label) => label.toLocaleLowerCase('en-US'));
    if (new Set(folded).size !== folded.length) {
      context.addIssue({ code: 'custom', path: ['labels'], message: 'Option labels must be unique.' });
    }
  }),
  z.strictObject({ kind: z.literal('program_vocabulary'), source: fieldRegistryOptionSourceSchema })
]);

export const fieldRegistryFieldAuthorSchema = z.strictObject({
  kind: fieldRegistryKindSchema,
  label: fieldRegistryLabelInputSchema,
  help: fieldRegistryHelpInputSchema.nullable().optional(),
  answerOwner: fieldRegistryAnswerOwnerSchema,
  scope: fieldScopeInputSchema,
  contexts: contextAuthorSchema,
  options: authoredOptionsSchema
}).superRefine((field, context) => {
  const choiceKind = field.kind === 'select' || field.kind === 'multiselect';
  if (choiceKind !== (field.options.kind !== 'none')) {
    context.addIssue({
      code: 'custom', path: ['options'],
      message: choiceKind
        ? 'Choice fields require custom or vocabulary-backed options.'
        : 'Only choice fields may carry options.'
    });
  }
  if (field.scope.kind === 'form'
      && (!field.contexts.apply.visible
        || field.contexts.onboard.visible
        || field.contexts.profile.visible)) {
    context.addIssue({
      code: 'custom', path: ['contexts'],
      message: 'Form-scoped fields are collected only by their application form.'
    });
  }
});

const expectedRegistryVersion = { expectedRegistryVersion: fieldRegistryVersionSchema } as const;
const guardedField = {
  fieldId: fieldRegistryIdInputSchema,
  expectedFieldVersion: fieldRegistryVersionSchema,
  ...expectedRegistryVersion
} as const;

export const fieldRegistryAddDraftRequestSchema = z.strictObject({
  ...expectedRegistryVersion,
  field: fieldRegistryFieldAuthorSchema
});

export const fieldRegistryEditDraftRequestSchema = z.strictObject({
  ...guardedField,
  changes: z.strictObject({
    label: fieldRegistryLabelInputSchema.optional(),
    help: fieldRegistryHelpInputSchema.nullable().optional(),
    contexts: contextAuthorSchema.optional(),
    customOptionLabels: z.array(fieldRegistryOptionLabelInputSchema)
      .min(1).max(FIELD_OPTIONS_MAX).optional()
  }).superRefine((changes, context) => {
    if (Object.values(changes).every((value) => value === undefined)) {
      context.addIssue({ code: 'custom', message: 'At least one field change is required.' });
    }
    if (changes.customOptionLabels) {
      const folded = changes.customOptionLabels.map((label) => label.toLocaleLowerCase('en-US'));
      if (new Set(folded).size !== folded.length) {
        context.addIssue({
          code: 'custom', path: ['customOptionLabels'], message: 'Option labels must be unique.'
        });
      }
    }
  })
});

export const fieldRegistryMoveDraftRequestSchema = z.strictObject({
  ...guardedField,
  toIndex: z.number().int().nonnegative().safe()
});
export const fieldRegistryRemoveDraftRequestSchema = z.strictObject(guardedField);
export const fieldRegistryRestoreDraftRequestSchema = z.strictObject({
  ...guardedField,
  toIndex: z.number().int().nonnegative().safe()
});

export const fieldRegistryDraftActionSchema = z.enum(['add', 'edit', 'move', 'remove', 'restore']);
export const fieldRegistryDraftRequestSchema = z.union([
  z.strictObject({ action: z.literal('add'), request: fieldRegistryAddDraftRequestSchema }),
  z.strictObject({ action: z.literal('edit'), request: fieldRegistryEditDraftRequestSchema }),
  z.strictObject({ action: z.literal('move'), request: fieldRegistryMoveDraftRequestSchema }),
  z.strictObject({ action: z.literal('remove'), request: fieldRegistryRemoveDraftRequestSchema }),
  z.strictObject({ action: z.literal('restore'), request: fieldRegistryRestoreDraftRequestSchema })
]);

const placementSchema = z.strictObject({
  index: z.number().int().nonnegative().safe(),
  group: fieldRegistryGroupSchema,
  reasonKey: fieldRegistryStableKeySchema
});

const safeDiffBase = {
  registryVersionBefore: fieldRegistryVersionSchema,
  registryVersionAfter: fieldRegistryVersionSchema
} as const;

export const fieldRegistrySafeDiffSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('add'), ...safeDiffBase,
    before: z.null(), after: fieldRegistryFieldDefinitionSchema,
    placement: placementSchema
  }),
  z.strictObject({
    action: z.literal('edit'), ...safeDiffBase,
    before: fieldRegistryFieldDefinitionSchema,
    after: fieldRegistryFieldDefinitionSchema
  }),
  z.strictObject({
    action: z.literal('move'), ...safeDiffBase,
    fieldId: fieldRegistryIdSchema,
    fieldVersion: fieldRegistryVersionSchema,
    beforeIndex: z.number().int().nonnegative().safe(),
    afterIndex: z.number().int().nonnegative().safe()
  }),
  z.strictObject({
    action: z.literal('remove'), ...safeDiffBase,
    before: fieldRegistryFieldDefinitionSchema, after: z.null()
  }),
  z.strictObject({
    action: z.literal('restore'), ...safeDiffBase,
    before: z.null(), after: fieldRegistryFieldDefinitionSchema,
    placement: placementSchema
  })
]);

export const fieldRegistryChangeResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: fieldRegistryDraftActionSchema,
  fieldId: fieldRegistryIdSchema,
  registryVersion: fieldRegistryVersionSchema,
  fieldVersion: fieldRegistryVersionSchema,
  position: z.number().int().nonnegative().safe().nullable()
});

export const fieldRegistryDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: fieldRegistryDraftActionSchema,
  changesetId: fieldRegistryIdSchema,
  headVersion: fieldRegistryVersionSchema,
  status: z.literal('draft'),
  revision: z.strictObject({
    id: fieldRegistryIdSchema,
    number: fieldRegistryVersionSchema,
    digestSha256: fieldRegistryDigestSchema
  }),
  riskTier: z.enum(['low', 'normal', 'consequential']),
  approvalPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: fieldRegistryDigestSchema,
    requirement: z.enum(['none', 'distinct_current_human'])
  }),
  safeDiff: fieldRegistrySafeDiffSchema
}).superRefine((data, context) => {
  if (data.action !== data.safeDiff.action) {
    context.addIssue({ code: 'custom', path: ['safeDiff', 'action'], message: 'Action mismatch.' });
  }
});

export const fieldRegistryDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: fieldRegistryDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const fieldRegistryDraftOperationResultSchema =
  createEffectfulOperationResultSchema(fieldRegistryDraftDataSchema);

const draftRequestSchemas = Object.freeze({
  add: fieldRegistryAddDraftRequestSchema,
  edit: fieldRegistryEditDraftRequestSchema,
  move: fieldRegistryMoveDraftRequestSchema,
  remove: fieldRegistryRemoveDraftRequestSchema,
  restore: fieldRegistryRestoreDraftRequestSchema
});

export const FIELD_REGISTRY_OPERATION_SCHEMA_REFS = Object.freeze({
  snapshotRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.field_registry.snapshot-read.input',
    inputSchema: fieldRegistrySnapshotReadInputSchema,
    resultKey: 'schema.field_registry.snapshot-read.operator-result',
    resultSchema: fieldRegistrySnapshotReadResultSchema
  }),
  drafts: Object.freeze(Object.fromEntries(
    Object.entries(draftRequestSchemas).map(([action, inputSchema]) => [
      action,
      createOperationSchemaManifestRefs({
        inputKey: `schema.field_registry.${action}-draft.input`,
        inputSchema,
        resultKey: 'schema.field_registry.changeset-draft.operator-result',
        resultSchema: fieldRegistryDraftOperationResultSchema
      })
    ])
  ) as {
    readonly [Action in keyof typeof draftRequestSchemas]:
      ReturnType<typeof createOperationSchemaManifestRefs>;
  })
});

export type FieldRegistryScopeDto = z.infer<typeof fieldRegistryScopeSchema>;
export type FieldRegistryContext = z.infer<typeof fieldRegistryContextSchema>;
export type FieldRegistryKind = z.infer<typeof fieldRegistryKindSchema>;
export type FieldRegistryGroup = z.infer<typeof fieldRegistryGroupSchema>;
export type FieldRegistryAnswerOwner = z.infer<typeof fieldRegistryAnswerOwnerSchema>;
export type FieldRegistryOptionSource = z.infer<typeof fieldRegistryOptionSourceSchema>;
export type FieldRegistryMapsTo = z.infer<typeof fieldRegistryMapsToSchema>;
export type FieldRegistryPurpose = z.infer<typeof fieldRegistryPurposeSchema>;
export type FieldRegistryContextPolicy = z.infer<typeof fieldRegistryContextPolicySchema>;
export type FieldRegistryContexts = z.infer<typeof fieldRegistryContextsSchema>;
export type FieldRegistryFieldScope = z.infer<typeof fieldRegistryFieldScopeSchema>;
export type FieldRegistryChoiceDto = z.infer<typeof fieldRegistryChoiceSchema>;
export type FieldRegistryOptionConfiguration = z.infer<typeof fieldRegistryOptionConfigurationSchema>;
export type FieldRegistryFieldDefinitionDto = z.infer<typeof fieldRegistryFieldDefinitionSchema>;
export type FieldRegistryFieldViewDto = z.infer<typeof fieldRegistryFieldViewSchema>;
export type FieldRegistrySnapshotDto = z.infer<typeof fieldRegistrySnapshotSchema>;
export type FieldRegistryFieldAuthor = z.infer<typeof fieldRegistryFieldAuthorSchema>;
export type FieldRegistryAddDraftRequest = z.infer<typeof fieldRegistryAddDraftRequestSchema>;
export type FieldRegistryEditDraftRequest = z.infer<typeof fieldRegistryEditDraftRequestSchema>;
export type FieldRegistryMoveDraftRequest = z.infer<typeof fieldRegistryMoveDraftRequestSchema>;
export type FieldRegistryRemoveDraftRequest = z.infer<typeof fieldRegistryRemoveDraftRequestSchema>;
export type FieldRegistryRestoreDraftRequest = z.infer<typeof fieldRegistryRestoreDraftRequestSchema>;
export type FieldRegistryDraftAction = z.infer<typeof fieldRegistryDraftActionSchema>;
export type FieldRegistryDraftRequest = z.infer<typeof fieldRegistryDraftRequestSchema>;
export type FieldRegistrySafeDiff = z.infer<typeof fieldRegistrySafeDiffSchema>;
export type FieldRegistryChangeResult = z.infer<typeof fieldRegistryChangeResultSchema>;
export type FieldRegistryDraftData = z.infer<typeof fieldRegistryDraftDataSchema>;
