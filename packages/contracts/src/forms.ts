import { encodeCanonicalJson, parseInstant } from '@jooevents/kernel';
import { z } from 'zod';
import { deadlineReferencePinSchema } from './deadlines';
import {
  fieldRegistryAnswerOwnerSchema,
  fieldRegistryConstraintsSchema,
  fieldRegistryDigestSchema,
  fieldRegistryFieldViewSchema,
  fieldRegistryGroupSchema,
  fieldRegistryMapsToSchema,
  fieldRegistryOptionSourceSchema,
  fieldRegistryPurposeSchema,
  fieldRegistryVersionSchema
} from './field-registry';

export const INTAKE_REQUEST_MAX_CANONICAL_BYTES = 128 * 1024;
export const FORM_NAME_MAX_LENGTH = 120;
export const FORM_FIELD_LABEL_MAX_LENGTH = 240;
export const FORM_FIELD_HELP_MAX_LENGTH = 2_000;
export const FORM_CONFIRMATION_MAX_LENGTH = 2_000;
export const FORM_FIELDS_MAX = 500;
export const FORM_RULES_MAX = 128;
export const FORM_FIELD_OPTIONS_MAX = 200;
export const FORM_MULTISELECT_MAX_SELECTIONS = 20;
export const FORM_TEXT_MAX_LENGTH = 500;
export const FORM_LONG_TEXT_MAX_LENGTH = 10_000;
export const FORM_EMAIL_MAX_LENGTH = 320;
export const FORM_URL_MAX_LENGTH = 2_048;
export const FORM_PHONE_MAX_LENGTH = 64;

const APPLICATION_UUID_INPUT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLICATION_UUID_CANONICAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STABLE_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function normalizedSingleLine(value: string): string {
  return value.replace(/\r\n?/gu, '\n').normalize('NFC').trim().replace(/[ \t]+/gu, ' ');
}

function normalizedMultiline(value: string): string {
  return value.replace(/\r\n?/gu, '\n').normalize('NFC').trim();
}

function acceptedSingleLineInput(value: string, maximum: number): boolean {
  const normalized = normalizedSingleLine(value);
  return hasOnlyUnicodeScalars(value)
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    && normalized.length > 0
    && normalized.length <= maximum;
}

function acceptedMultilineInput(value: string, maximum: number, allowEmpty: boolean): boolean {
  const normalized = normalizedMultiline(value);
  return hasOnlyUnicodeScalars(value)
    && !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(normalized)
    && (allowEmpty || normalized.length > 0)
    && normalized.length <= maximum;
}

function singleLineInput(maximum: number) {
  return z.string().refine((value) => acceptedSingleLineInput(value, maximum))
    .overwrite(normalizedSingleLine);
}

function singleLineStored(maximum: number) {
  return z.string().refine((value) =>
    acceptedSingleLineInput(value, maximum) && normalizedSingleLine(value) === value
  );
}

function multilineInput(maximum: number, allowEmpty = true) {
  return z.string().refine((value) => acceptedMultilineInput(value, maximum, allowEmpty))
    .overwrite(normalizedMultiline);
}

function multilineStored(maximum: number, allowEmpty = true) {
  return z.string().refine((value) =>
    acceptedMultilineInput(value, maximum, allowEmpty) && normalizedMultiline(value) === value
  );
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalInstant(value: string): boolean {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}

function addOrderedPositionIssues(
  values: readonly { readonly position: number }[],
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[]
): void {
  values.forEach((value, index) => {
    if (value.position !== index) context.addIssue({
      code: 'custom', path: [...path, index, 'position'],
      message: 'Positions must be contiguous and match array order.'
    });
  });
}

function addUniqueIssues(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[],
  label: string
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) context.addIssue({
      code: 'custom', path: [...path, index], message: `${label} must be unique.`
    });
    seen.add(value);
  });
}

function addCanonicalOrderIssues(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[]
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCanonicalText(values[index - 1]!, values[index]!) >= 0) context.addIssue({
      code: 'custom', path: [...path, index],
      message: 'Identities must be unique and use canonical code-unit order.'
    });
  }
}

function addRecordLimitIssues(
  value: Record<string, unknown>,
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[]
): void {
  if (Object.keys(value).length > FORM_FIELDS_MAX) context.addIssue({
    code: 'custom', path: [...path], message: 'Composition contains too many field entries.'
  });
}

export const intakeIdInputSchema = z.string().regex(APPLICATION_UUID_INPUT)
  .overwrite((value) => value.toLowerCase());
export const intakeIdSchema = z.string().regex(APPLICATION_UUID_CANONICAL);
export const intakeVersionSchema = z.number().int().positive().safe();
export const intakeDigestSchema = z.string().regex(SHA256);
export const intakeStableKeySchema = z.string().min(1).max(160).regex(STABLE_KEY);
export const intakeInstantSchema = z.string().refine(canonicalInstant);
export const intakeScopeSchema = z.strictObject({
  workspaceId: intakeIdSchema,
  eventId: intakeIdSchema
});

export const formNameInputSchema = singleLineInput(FORM_NAME_MAX_LENGTH);
export const formNameSchema = singleLineStored(FORM_NAME_MAX_LENGTH);
export const formFieldLabelInputSchema = singleLineInput(FORM_FIELD_LABEL_MAX_LENGTH);
export const formFieldLabelSchema = singleLineStored(FORM_FIELD_LABEL_MAX_LENGTH);
export const formFieldHelpInputSchema = multilineInput(FORM_FIELD_HELP_MAX_LENGTH);
export const formFieldHelpSchema = multilineStored(FORM_FIELD_HELP_MAX_LENGTH);
export const formConfirmationInputSchema = multilineInput(FORM_CONFIRMATION_MAX_LENGTH);
export const formConfirmationSchema = multilineStored(FORM_CONFIRMATION_MAX_LENGTH);

export const formKindSchema = z.literal('cfp');
export const formAvailabilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('evergreen') }),
  z.strictObject({ kind: z.literal('deadline'), deadlineId: intakeIdSchema })
]);
export const formAvailabilityInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('evergreen') }),
  z.strictObject({ kind: z.literal('deadline'), deadlineId: intakeIdInputSchema })
]);
export const formCreateAvailabilityIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('evergreen') }),
  z.strictObject({ kind: z.literal('fixed_close_date'), displayDate: z.iso.date() })
]);
export const formStatusSchema = z.enum(['draft', 'open', 'closed']);
export const formFieldTypeSchema = z.enum([
  'text', 'textarea', 'email', 'url', 'phone', 'number', 'date', 'datetime',
  'select', 'multiselect', 'checkbox'
]);

export const formTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('general_pool') }),
  z.strictObject({
    kind: z.literal('category'),
    category: z.strictObject({ kind: z.enum(['track', 'format']), id: intakeIdSchema })
  }),
  z.strictObject({ kind: z.literal('session'), sessionId: intakeIdSchema })
]);

export const formTargetInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('general_pool') }),
  z.strictObject({
    kind: z.literal('category'),
    category: z.strictObject({ kind: z.enum(['track', 'format']), id: intakeIdInputSchema })
  }),
  z.strictObject({ kind: z.literal('session'), sessionId: intakeIdInputSchema })
]);

const canonicalIdListSchema = z.array(intakeIdSchema).max(FORM_FIELDS_MAX)
  .superRefine((values, context) => addCanonicalOrderIssues(values, context, []));
const canonicalChoiceIdListSchema = z.array(intakeIdSchema)
  .min(1).max(FORM_FIELD_OPTIONS_MAX)
  .superRefine((values, context) => addCanonicalOrderIssues(values, context, []));

export const formCompositionSchema = z.strictObject({
  excludedFieldIds: canonicalIdListSchema,
  requiredOverrides: z.record(intakeIdSchema, z.boolean()),
  optionExposure: z.record(intakeIdSchema, canonicalChoiceIdListSchema)
}).superRefine((composition, context) => {
  addRecordLimitIssues(composition.requiredOverrides, context, ['requiredOverrides']);
  addRecordLimitIssues(composition.optionExposure, context, ['optionExposure']);
});

export const formRuleConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('selected_any'),
    sourceFieldId: intakeIdSchema,
    choiceIds: canonicalChoiceIdListSchema
  }),
  z.strictObject({
    kind: z.literal('checked_is'),
    sourceFieldId: intakeIdSchema,
    value: z.boolean()
  })
]);

export const formRuleEffectSchema = z.strictObject({
  kind: z.enum(['show', 'hide', 'require']),
  targetFieldIds: z.array(intakeIdSchema).min(1).max(FORM_FIELDS_MAX)
    .superRefine((values, context) => addCanonicalOrderIssues(values, context, []))
});

export const formDefinitionRuleSchema = z.strictObject({
  id: intakeIdSchema,
  key: intakeStableKeySchema,
  position: z.number().int().nonnegative().max(FORM_RULES_MAX - 1),
  condition: formRuleConditionSchema,
  effect: formRuleEffectSchema
});

export const formDefinitionContentSchema = z.strictObject({
  kind: formKindSchema,
  name: formNameSchema,
  target: formTargetSchema,
  availability: formAvailabilitySchema,
  confirmation: formConfirmationSchema,
  composition: formCompositionSchema,
  rules: z.array(formDefinitionRuleSchema).max(FORM_RULES_MAX)
}).superRefine((definition, context) => {
  addOrderedPositionIssues(definition.rules, context, ['rules']);
  addUniqueIssues(definition.rules.map((rule) => rule.id), context, ['rules'], 'Rule IDs');
  addUniqueIssues(definition.rules.map((rule) => rule.key), context, ['rules'], 'Rule keys');
});

export const formTargetReferencePinSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('category'),
    categoryKind: z.enum(['track', 'format']),
    id: intakeIdSchema,
    name: singleLineStored(200),
    version: intakeVersionSchema
  }),
  z.strictObject({
    kind: z.literal('session'),
    id: intakeIdSchema,
    title: singleLineStored(240),
    version: intakeVersionSchema,
    lifecycle: z.literal('collecting')
  })
]);

export const formDeadlineReferencePinSchema = deadlineReferencePinSchema;

export const formRegistryPinSchema = z.strictObject({
  version: fieldRegistryVersionSchema,
  digestSha256: fieldRegistryDigestSchema
});

export const formProgramVocabularyItemPinSchema = z.strictObject({
  source: fieldRegistryOptionSourceSchema,
  id: intakeIdSchema,
  version: intakeVersionSchema,
  label: singleLineStored(200)
});

export const formVersionChoiceSchema = z.strictObject({
  id: intakeIdSchema,
  key: intakeStableKeySchema,
  label: formFieldLabelSchema,
  position: z.number().int().nonnegative().max(FORM_FIELD_OPTIONS_MAX - 1)
});

const vocabularySubsetSchema = z.strictObject({
  kind: z.literal('subset'),
  items: z.array(formProgramVocabularyItemPinSchema).min(1).max(FORM_FIELD_OPTIONS_MAX)
}).superRefine((subset, context) => {
  addCanonicalOrderIssues(subset.items.map((item) => item.id), context, ['items']);
  const sources = new Set(subset.items.map((item) => item.source));
  if (sources.size > 1) context.addIssue({
    code: 'custom', path: ['items'], message: 'A vocabulary subset must use one source.'
  });
});

export const formVersionOptionConfigurationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('custom'),
    choices: z.array(formVersionChoiceSchema).min(1).max(FORM_FIELD_OPTIONS_MAX)
  }),
  z.strictObject({
    kind: z.literal('program_vocabulary'),
    source: fieldRegistryOptionSourceSchema,
    exposure: z.union([
      z.strictObject({ kind: z.literal('all_active') }),
      vocabularySubsetSchema
    ])
  }).superRefine((options, context) => {
    if (options.exposure.kind === 'subset'
        && options.exposure.items.some((item) => item.source !== options.source)) {
      context.addIssue({
        code: 'custom', path: ['exposure', 'items'],
        message: 'Vocabulary item pins must match their field source.'
      });
    }
  })
]);

const versionFieldBase = {
  id: intakeIdSchema,
  sourceFieldVersion: fieldRegistryVersionSchema,
  key: intakeStableKeySchema,
  mapsTo: fieldRegistryMapsToSchema.nullable(),
  purpose: fieldRegistryPurposeSchema,
  answerOwner: fieldRegistryAnswerOwnerSchema,
  group: fieldRegistryGroupSchema,
  constraints: fieldRegistryConstraintsSchema,
  label: formFieldLabelSchema,
  help: formFieldHelpSchema.nullable(),
  required: z.boolean(),
  initiallyVisible: z.boolean(),
  position: z.number().int().nonnegative().max(FORM_FIELDS_MAX - 1)
} as const;

export const formFieldDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), ...versionFieldBase, maximumLength: z.literal(FORM_TEXT_MAX_LENGTH), options: z.strictObject({ kind: z.literal('none') }) }),
  z.strictObject({ kind: z.literal('textarea'), ...versionFieldBase, maximumLength: z.literal(FORM_LONG_TEXT_MAX_LENGTH), options: z.strictObject({ kind: z.literal('none') }) }),
  z.strictObject({ kind: z.literal('email'), ...versionFieldBase, maximumLength: z.literal(FORM_EMAIL_MAX_LENGTH), options: z.strictObject({ kind: z.literal('none') }) }),
  z.strictObject({ kind: z.literal('url'), ...versionFieldBase, maximumLength: z.literal(FORM_URL_MAX_LENGTH), options: z.strictObject({ kind: z.literal('none') }) }),
  z.strictObject({ kind: z.literal('phone'), ...versionFieldBase, maximumLength: z.literal(FORM_PHONE_MAX_LENGTH), options: z.strictObject({ kind: z.literal('none') }) }),
  z.strictObject({
    kind: z.literal('number'), ...versionFieldBase,
    minimum: z.number().finite().nullable(), maximum: z.number().finite().nullable(),
    integerOnly: z.boolean(), options: z.strictObject({ kind: z.literal('none') })
  }),
  z.strictObject({ kind: z.literal('date'), ...versionFieldBase, options: z.strictObject({ kind: z.literal('none') }) }),
  z.strictObject({ kind: z.literal('datetime'), ...versionFieldBase, options: z.strictObject({ kind: z.literal('none') }) }),
  z.strictObject({
    kind: z.literal('select'), ...versionFieldBase,
    options: formVersionOptionConfigurationSchema.refine((options) => options.kind !== 'none')
  }),
  z.strictObject({
    kind: z.literal('multiselect'), ...versionFieldBase,
    options: formVersionOptionConfigurationSchema.refine((options) => options.kind !== 'none'),
    maximumSelections: z.literal(FORM_MULTISELECT_MAX_SELECTIONS)
  }),
  z.strictObject({ kind: z.literal('checkbox'), ...versionFieldBase, options: z.strictObject({ kind: z.literal('none') }) })
]).superRefine((field, context) => {
  if (field.purpose.kind === 'consent' && field.kind !== 'checkbox') context.addIssue({
    code: 'custom', path: ['purpose'], message: 'Only a checkbox can carry consent semantics.'
  });
  if (field.kind === 'number' && field.minimum !== null && field.maximum !== null
      && field.minimum > field.maximum) context.addIssue({
    code: 'custom', path: ['minimum'], message: 'Minimum cannot exceed maximum.'
  });
  if ((field.kind === 'select' || field.kind === 'multiselect')
      && field.options.kind === 'custom') {
    addOrderedPositionIssues(field.options.choices, context, ['options', 'choices']);
    addUniqueIssues(
      field.options.choices.map((choice) => choice.id), context, ['options', 'choices'], 'Choice IDs'
    );
    addUniqueIssues(
      field.options.choices.map((choice) => choice.key), context, ['options', 'choices'], 'Choice keys'
    );
  }
});

export const formVersionRuleConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('selected_any'),
    sourceFieldId: intakeIdSchema,
    choiceIds: canonicalChoiceIdListSchema,
    programVocabularyPins: z.array(formProgramVocabularyItemPinSchema)
      .max(FORM_FIELD_OPTIONS_MAX)
  }),
  z.strictObject({
    kind: z.literal('checked_is'),
    sourceFieldId: intakeIdSchema,
    value: z.boolean()
  })
]);

export const formVersionRuleSchema = z.strictObject({
  id: intakeIdSchema,
  key: intakeStableKeySchema,
  position: z.number().int().nonnegative().max(FORM_RULES_MAX - 1),
  condition: formVersionRuleConditionSchema,
  effect: formRuleEffectSchema
});

export const formVersionDefinitionContentSchema = z.strictObject({
  kind: formKindSchema,
  name: formNameSchema,
  target: formTargetSchema,
  availability: formAvailabilitySchema,
  confirmation: formConfirmationSchema,
  fields: z.array(formFieldDefinitionSchema).min(1).max(FORM_FIELDS_MAX),
  rules: z.array(formVersionRuleSchema).max(FORM_RULES_MAX)
}).superRefine((definition, context) => {
  addOrderedPositionIssues(definition.fields, context, ['fields']);
  addOrderedPositionIssues(definition.rules, context, ['rules']);
  addUniqueIssues(definition.fields.map((field) => field.id), context, ['fields'], 'Field IDs');
  addUniqueIssues(definition.fields.map((field) => field.key), context, ['fields'], 'Field keys');
  addUniqueIssues(definition.rules.map((rule) => rule.id), context, ['rules'], 'Rule IDs');
  addUniqueIssues(definition.rules.map((rule) => rule.key), context, ['rules'], 'Rule keys');
  addUniqueIssues(
    definition.fields.flatMap((field) => field.mapsTo === null ? [] : [field.mapsTo]),
    context, ['fields'], 'Canonical mappings'
  );

  const email = definition.fields.find((field) => field.mapsTo === 'person.email');
  if (!email || email.kind !== 'email'
      || email.constraints.applyVisibility !== 'required_visible') context.addIssue({
    code: 'custom', path: ['fields'],
    message: 'Every published form must include the structurally locked person email field.'
  });

  const byId = new Map(definition.fields.map((field) => [field.id, field]));
  definition.rules.forEach((rule, ruleIndex) => {
    const source = byId.get(rule.condition.sourceFieldId);
    if (!source) context.addIssue({
      code: 'custom', path: ['rules', ruleIndex, 'condition', 'sourceFieldId'],
      message: 'Rule source field must exist in the version.'
    });
    if (rule.condition.kind === 'selected_any') {
      if (!source || (source.kind !== 'select' && source.kind !== 'multiselect')) context.addIssue({
        code: 'custom', path: ['rules', ruleIndex, 'condition'],
        message: 'Selected-any rules require a choice field.'
      });
      if (source && (source.kind === 'select' || source.kind === 'multiselect')) {
        if (source.options.kind === 'custom') {
          const choices = new Set(source.options.choices.map((choice) => choice.id));
          if (rule.condition.choiceIds.some((id) => !choices.has(id))
              || rule.condition.programVocabularyPins.length !== 0) context.addIssue({
            code: 'custom', path: ['rules', ruleIndex, 'condition'],
            message: 'Custom-choice rules must reference copied choices and no vocabulary pins.'
          });
        } else if (source.options.kind === 'program_vocabulary') {
          const pins = rule.condition.programVocabularyPins;
          const optionSource = source.options.source;
          const choiceIds = rule.condition.choiceIds;
          if (pins.some((pin) => pin.source !== optionSource)
              || pins.length !== choiceIds.length
              || pins.some((pin, index) => pin.id !== choiceIds[index])) context.addIssue({
            code: 'custom', path: ['rules', ruleIndex, 'condition'],
            message: 'Vocabulary rule choices require exact ordered item pins.'
          });
        }
      }
    } else if (!source || source.kind !== 'checkbox') context.addIssue({
      code: 'custom', path: ['rules', ruleIndex, 'condition'],
      message: 'Checked-is rules require a checkbox field.'
    });
    rule.effect.targetFieldIds.forEach((id, targetIndex) => {
      if (!byId.has(id) || id === rule.condition.sourceFieldId) context.addIssue({
        code: 'custom', path: ['rules', ruleIndex, 'effect', 'targetFieldIds', targetIndex],
        message: 'Rule targets must exist and differ from their source.'
      });
    });
  });
});

export const formDefinitionHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  scope: intakeScopeSchema,
  version: intakeVersionSchema,
  status: formStatusSchema,
  currentPublishedVersionId: intakeIdSchema.nullable(),
  definition: formDefinitionContentSchema,
  createdByUserId: intakeIdSchema,
  createdAt: intakeInstantSchema,
  updatedByUserId: intakeIdSchema,
  updatedAt: intakeInstantSchema
}).superRefine((head, context) => {
  if (head.status !== 'draft' && head.currentPublishedVersionId === null) context.addIssue({
    code: 'custom', path: ['currentPublishedVersionId'],
    message: 'An open or closed form must identify a published version.'
  });
});

export const formVersionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  formId: intakeIdSchema,
  scope: intakeScopeSchema,
  number: intakeVersionSchema,
  sourceDefinitionVersion: intakeVersionSchema,
  sourceDefinitionDigestSha256: intakeDigestSchema,
  registryPin: formRegistryPinSchema,
  definitionDigestSha256: intakeDigestSchema,
  definition: formVersionDefinitionContentSchema,
  targetPin: formTargetReferencePinSchema.nullable(),
  deadlinePin: formDeadlineReferencePinSchema.nullable(),
  publishedByUserId: intakeIdSchema,
  publishedAt: intakeInstantSchema
}).superRefine((version, context) => {
  const target = version.definition.target;
  const coherent = target.kind === 'general_pool'
    ? version.targetPin === null
    : target.kind === 'category'
      ? version.targetPin?.kind === 'category'
        && version.targetPin.categoryKind === target.category.kind
        && version.targetPin.id === target.category.id
      : version.targetPin?.kind === 'session'
        && version.targetPin.id === target.sessionId;
  if (!coherent) context.addIssue({
    code: 'custom', path: ['targetPin'],
    message: 'Target pin must exactly match the published target.'
  });
  const deadlineCoherent = version.definition.availability.kind === 'evergreen'
    ? version.deadlinePin === null
    : version.deadlinePin?.id === version.definition.availability.deadlineId;
  if (!deadlineCoherent) context.addIssue({
    code: 'custom', path: ['deadlinePin'],
    message: 'Deadline pin must exactly match the published availability reference.'
  });
});

export const formConfigurationIssueCodeSchema = z.enum([
  'unknown_excluded_field',
  'scoped_field_excluded',
  'locked_email_excluded',
  'locked_email_missing',
  'unknown_required_override',
  'required_override_for_excluded_field',
  'unknown_option_exposure_field',
  'option_exposure_not_vocabulary',
  'option_exposure_item_missing',
  'rule_field_missing',
  'rule_field_excluded',
  'rule_choice_missing',
  'rule_visibility_conflict',
  'target_unavailable',
  'deadline_unavailable',
  'file_upload_disabled'
]);

export const formConfigurationIssueSchema = z.strictObject({
  code: formConfigurationIssueCodeSchema,
  fieldId: intakeIdSchema.nullable(),
  ruleId: intakeIdSchema.nullable()
});

export const organizerFormOptionSchema = z.strictObject({
  id: intakeIdSchema,
  name: formFieldLabelSchema,
  version: intakeVersionSchema,
  exposed: z.boolean()
});

export const organizerFormFieldRowSchema = z.strictObject({
  field: fieldRegistryFieldViewSchema,
  included: z.boolean(),
  required: z.boolean(),
  requiredOverridden: z.boolean(),
  options: z.array(organizerFormOptionSchema).max(FORM_FIELD_OPTIONS_MAX).nullable(),
  exposureAll: z.boolean()
});

export const organizerFormSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  name: formNameSchema,
  target: formTargetSchema,
  availability: formAvailabilitySchema,
  status: formStatusSchema,
  version: intakeVersionSchema,
  currentPublishedVersionId: intakeIdSchema.nullable(),
  composition: formCompositionSchema,
  registryPin: formRegistryPinSchema,
  closesAt: z.iso.date().nullable(),
  fieldCount: z.number().int().nonnegative().max(FORM_FIELDS_MAX),
  configurationIssues: z.array(formConfigurationIssueSchema).max(FORM_FIELDS_MAX + FORM_RULES_MAX),
  submissionCount: z.number().int().nonnegative().safe(),
  updatedAt: intakeInstantSchema
});

export const organizerFormCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  catalogVersion: intakeVersionSchema,
  registryPin: formRegistryPinSchema,
  forms: z.array(organizerFormSummarySchema).max(500)
}).superRefine((catalog, context) => {
  for (let index = 1; index < catalog.forms.length; index += 1) {
    if (catalog.forms[index - 1]!.id >= catalog.forms[index]!.id) context.addIssue({
      code: 'custom', path: ['forms', index, 'id'],
      message: 'Forms must have unique IDs in canonical code-unit order.'
    });
  }
});

export const organizerFormDetailSchema = z.strictObject({
  schemaVersion: z.literal(1),
  head: formDefinitionHeadSchema,
  registryPin: formRegistryPinSchema,
  fields: z.array(organizerFormFieldRowSchema).max(FORM_FIELDS_MAX),
  configurationIssues: z.array(formConfigurationIssueSchema).max(FORM_FIELDS_MAX + FORM_RULES_MAX),
  currentPublishedVersion: formVersionSchema.nullable()
}).superRefine((detail, context) => {
  if (detail.head.currentPublishedVersionId !== detail.currentPublishedVersion?.id
      && !(detail.head.currentPublishedVersionId === null && detail.currentPublishedVersion === null)) {
    context.addIssue({
      code: 'custom', path: ['currentPublishedVersion'],
      message: 'Published version detail must match the head pointer.'
    });
  }
});

const servedFieldBase = {
  id: intakeIdSchema,
  label: formFieldLabelSchema,
  help: formFieldHelpSchema.nullable(),
  required: z.boolean(),
  initiallyVisible: z.boolean(),
  position: z.number().int().nonnegative().max(FORM_FIELDS_MAX - 1)
} as const;

const servedOptionSchema = z.strictObject({
  id: intakeIdSchema,
  label: formFieldLabelSchema,
  position: z.number().int().nonnegative().max(FORM_FIELD_OPTIONS_MAX - 1)
});

export const servedPublicFormTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('general_pool') }),
  z.strictObject({
    kind: z.literal('category'),
    category: z.strictObject({
      kind: z.enum(['track', 'format']), id: intakeIdSchema, name: singleLineStored(200)
    })
  }),
  z.strictObject({
    kind: z.literal('session'), sessionId: intakeIdSchema, title: singleLineStored(240)
  })
]);

export const servedPublicFormAvailabilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('evergreen') }),
  z.strictObject({
    kind: z.literal('closes'),
    effectiveAt: intakeInstantSchema,
    gracePolicy: z.literal('soft')
  })
]);

export const servedPublicFormFieldSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), ...servedFieldBase, maximumLength: z.literal(FORM_TEXT_MAX_LENGTH) }),
  z.strictObject({ kind: z.literal('textarea'), ...servedFieldBase, maximumLength: z.literal(FORM_LONG_TEXT_MAX_LENGTH) }),
  z.strictObject({ kind: z.literal('email'), ...servedFieldBase, maximumLength: z.literal(FORM_EMAIL_MAX_LENGTH) }),
  z.strictObject({ kind: z.literal('url'), ...servedFieldBase, maximumLength: z.literal(FORM_URL_MAX_LENGTH) }),
  z.strictObject({ kind: z.literal('phone'), ...servedFieldBase, maximumLength: z.literal(FORM_PHONE_MAX_LENGTH) }),
  z.strictObject({ kind: z.literal('number'), ...servedFieldBase, minimum: z.number().finite().nullable(), maximum: z.number().finite().nullable(), integerOnly: z.boolean() }),
  z.strictObject({ kind: z.literal('date'), ...servedFieldBase }),
  z.strictObject({ kind: z.literal('datetime'), ...servedFieldBase }),
  z.strictObject({ kind: z.literal('select'), ...servedFieldBase, options: z.array(servedOptionSchema).max(FORM_FIELD_OPTIONS_MAX) }),
  z.strictObject({ kind: z.literal('multiselect'), ...servedFieldBase, options: z.array(servedOptionSchema).max(FORM_FIELD_OPTIONS_MAX), maximumSelections: z.literal(FORM_MULTISELECT_MAX_SELECTIONS) }),
  z.strictObject({ kind: z.literal('checkbox'), ...servedFieldBase })
]);

export const servedPublicFormRuleSchema = z.strictObject({
  id: intakeIdSchema,
  position: z.number().int().nonnegative().max(FORM_RULES_MAX - 1),
  condition: formRuleConditionSchema,
  effect: formRuleEffectSchema
});

export const servedPublicFormSchema = z.strictObject({
  schemaVersion: z.literal(1),
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  formVersionNumber: intakeVersionSchema,
  name: formNameSchema,
  confirmation: formConfirmationSchema,
  target: servedPublicFormTargetSchema,
  availability: servedPublicFormAvailabilitySchema,
  fields: z.array(servedPublicFormFieldSchema).min(1).max(FORM_FIELDS_MAX),
  rules: z.array(servedPublicFormRuleSchema).max(FORM_RULES_MAX)
}).superRefine((form, context) => {
  addOrderedPositionIssues(form.fields, context, ['fields']);
  addOrderedPositionIssues(form.rules, context, ['rules']);
  addUniqueIssues(form.fields.map((field) => field.id), context, ['fields'], 'Field IDs');
  addUniqueIssues(form.rules.map((rule) => rule.id), context, ['rules'], 'Rule IDs');
});

export const formRuleAuthorInputSchema = z.strictObject({
  key: intakeStableKeySchema,
  condition: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('selected_any'), sourceFieldId: intakeIdInputSchema, choiceIds: z.array(intakeIdInputSchema).min(1).max(FORM_FIELD_OPTIONS_MAX) }),
    z.strictObject({ kind: z.literal('checked_is'), sourceFieldId: intakeIdInputSchema, value: z.boolean() })
  ]),
  effect: z.strictObject({
    kind: z.enum(['show', 'hide', 'require']),
    targetFieldIds: z.array(intakeIdInputSchema).min(1).max(FORM_FIELDS_MAX)
  })
});

export const formDefinitionAuthorInputSchema = z.strictObject({
  kind: formKindSchema,
  name: formNameInputSchema,
  target: formTargetInputSchema,
  availability: formAvailabilityInputSchema,
  confirmation: formConfirmationInputSchema,
  composition: formCompositionSchema,
  rules: z.array(formRuleAuthorInputSchema).max(FORM_RULES_MAX)
}).superRefine((definition, context) => {
  addUniqueIssues(definition.rules.map((rule) => rule.key), context, ['rules'], 'Rule keys');
  try {
    if (encodeCanonicalJson(definition).byteLength > INTAKE_REQUEST_MAX_CANONICAL_BYTES) context.addIssue({
      code: 'custom', path: [], message: 'Form definition exceeds the request byte limit.'
    });
  } catch {
    context.addIssue({ code: 'custom', path: [], message: 'Form definition is not canonicalizable.' });
  }
});

/**
 * Creation accepts organizer intent, not a client-authored Deadline identity.
 * The Form changeset allocates and creates that Deadline in the same unit of work.
 */
export const formDefinitionCreateAuthorInputSchema = z.strictObject({
  kind: formKindSchema,
  name: formNameInputSchema,
  target: formTargetInputSchema,
  availability: formCreateAvailabilityIntentSchema,
  confirmation: formConfirmationInputSchema,
  composition: formCompositionSchema,
  rules: z.array(formRuleAuthorInputSchema).max(FORM_RULES_MAX)
}).superRefine((definition, context) => {
  addUniqueIssues(definition.rules.map((rule) => rule.key), context, ['rules'], 'Rule keys');
  try {
    if (encodeCanonicalJson(definition).byteLength > INTAKE_REQUEST_MAX_CANONICAL_BYTES) context.addIssue({
      code: 'custom', path: [], message: 'Form definition exceeds the request byte limit.'
    });
  } catch {
    context.addIssue({ code: 'custom', path: [], message: 'Form definition is not canonicalizable.' });
  }
});

export const formDefinitionCreateDraftInputSchema = z.strictObject({
  expectedCatalogVersion: intakeVersionSchema,
  expectedRegistryVersion: fieldRegistryVersionSchema,
  definition: formDefinitionCreateAuthorInputSchema
});

export const formDefinitionReviseDraftInputSchema = z.strictObject({
  formId: intakeIdInputSchema,
  expectedDefinitionVersion: intakeVersionSchema,
  expectedRegistryVersion: fieldRegistryVersionSchema,
  definition: formDefinitionAuthorInputSchema
});

export const formVersionPublishDraftInputSchema = z.strictObject({
  formId: intakeIdInputSchema,
  expectedDefinitionVersion: intakeVersionSchema,
  expectedRegistryVersion: fieldRegistryVersionSchema
});

const formLifecycleGuardInput = {
  formId: intakeIdInputSchema,
  expectedDefinitionVersion: intakeVersionSchema
} as const;
export const formLifecycleChangeDraftInputSchema = z.discriminatedUnion('transition', [
  z.strictObject({
    transition: z.literal('publish_and_open'),
    ...formLifecycleGuardInput,
    expectedRegistryVersion: fieldRegistryVersionSchema
  }),
  z.strictObject({ transition: z.literal('reopen'), ...formLifecycleGuardInput }),
  z.strictObject({ transition: z.literal('close'), ...formLifecycleGuardInput })
]);

export const formClosingChangeDraftInputSchema = z.strictObject({
  formId: intakeIdInputSchema,
  expectedDefinitionVersion: intakeVersionSchema,
  closesAt: z.iso.date().nullable()
});

export type IntakeScopeDto = z.infer<typeof intakeScopeSchema>;
export type FormKind = z.infer<typeof formKindSchema>;
export type FormAvailability = z.infer<typeof formAvailabilitySchema>;
export type FormCreateAvailabilityIntent = z.infer<typeof formCreateAvailabilityIntentSchema>;
export type FormStatus = z.infer<typeof formStatusSchema>;
export type FormFieldType = z.infer<typeof formFieldTypeSchema>;
export type FormTarget = z.infer<typeof formTargetSchema>;
export type FormCompositionDto = z.infer<typeof formCompositionSchema>;
export type FormDefinitionRuleDto = z.infer<typeof formDefinitionRuleSchema>;
export type FormRuleConditionDto = z.infer<typeof formRuleConditionSchema>;
export type FormRuleEffectDto = z.infer<typeof formRuleEffectSchema>;
export type FormDefinitionContentDto = z.infer<typeof formDefinitionContentSchema>;
export type FormTargetReferencePinDto = z.infer<typeof formTargetReferencePinSchema>;
export type FormDeadlineReferencePinDto = z.infer<typeof formDeadlineReferencePinSchema>;
export type FormRegistryPinDto = z.infer<typeof formRegistryPinSchema>;
export type FormProgramVocabularyItemPinDto = z.infer<typeof formProgramVocabularyItemPinSchema>;
export type FormVersionChoiceDto = z.infer<typeof formVersionChoiceSchema>;
export type FormVersionOptionConfiguration = z.infer<typeof formVersionOptionConfigurationSchema>;
export type FormFieldDefinitionDto = z.infer<typeof formFieldDefinitionSchema>;
export type FormVersionRuleDto = z.infer<typeof formVersionRuleSchema>;
export type FormVersionDefinitionContentDto = z.infer<typeof formVersionDefinitionContentSchema>;
export type FormDefinitionHeadDto = z.infer<typeof formDefinitionHeadSchema>;
export type FormVersionDto = z.infer<typeof formVersionSchema>;
export type FormConfigurationIssueCode = z.infer<typeof formConfigurationIssueCodeSchema>;
export type FormConfigurationIssueDto = z.infer<typeof formConfigurationIssueSchema>;
export type OrganizerFormFieldRowDto = z.infer<typeof organizerFormFieldRowSchema>;
export type OrganizerFormSummaryDto = z.infer<typeof organizerFormSummarySchema>;
export type OrganizerFormCatalogDto = z.infer<typeof organizerFormCatalogSchema>;
export type OrganizerFormDetailDto = z.infer<typeof organizerFormDetailSchema>;
export type ServedPublicFormFieldDto = z.infer<typeof servedPublicFormFieldSchema>;
export type ServedPublicFormTargetDto = z.infer<typeof servedPublicFormTargetSchema>;
export type ServedPublicFormAvailabilityDto = z.infer<typeof servedPublicFormAvailabilitySchema>;
export type ServedPublicFormRuleDto = z.infer<typeof servedPublicFormRuleSchema>;
export type ServedPublicFormDto = z.infer<typeof servedPublicFormSchema>;
export type FormRuleAuthorInput = z.infer<typeof formRuleAuthorInputSchema>;
export type FormDefinitionAuthorInput = z.infer<typeof formDefinitionAuthorInputSchema>;
export type FormDefinitionCreateAuthorInput = z.infer<typeof formDefinitionCreateAuthorInputSchema>;
export type FormDefinitionCreateDraftInput = z.infer<typeof formDefinitionCreateDraftInputSchema>;
export type FormDefinitionReviseDraftInput = z.infer<typeof formDefinitionReviseDraftInputSchema>;
export type FormVersionPublishDraftInput = z.infer<typeof formVersionPublishDraftInputSchema>;
export type FormLifecycleChangeDraftInput = z.infer<typeof formLifecycleChangeDraftInputSchema>;
export type FormClosingChangeDraftInput = z.infer<typeof formClosingChangeDraftInputSchema>;
