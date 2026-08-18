import { parseInstant } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from '../operations';
import {
  providerOpaqueIdSchema,
  providerPositiveVersionSchema,
  providerSha256Schema,
  providerStableKeySchema
} from './provider';

export const ORGANIZER_COMMUNICATION_PAGE_LIMIT = 200;
export const ORGANIZER_COMMUNICATION_RECIPIENT_LIMIT = 200;
export const ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT = 10_000;
export const ORGANIZER_COMMUNICATION_TEMPLATE_BLOCK_LIMIT = 200;
export const ORGANIZER_COMMUNICATION_TIMELINE_LIMIT = 500;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const MULTILINE_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const RECIPIENT_RESOLUTION_ID = /^rr1_[A-Za-z0-9_-]{16,160}$/;
const OPAQUE_SUBJECT_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CURSOR = /^cur1_[A-Za-z0-9_-]{8,512}$/;

function normalizeSingleLine(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function normalizeMultiline(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
}

function canonicalSingleLine(maximum: number, allowEmpty = false): z.ZodType<string> {
  return z.string().max(maximum).refine((value) => {
    const normalized = normalizeSingleLine(value);
    return (allowEmpty || normalized.length > 0)
      && normalized === value
      && !CONTROL.test(value);
  }, { message: 'Expected canonical control-free single-line text.' });
}

function canonicalMultiline(maximum: number, allowEmpty = false): z.ZodType<string> {
  return z.string().max(maximum).refine((value) => {
    const normalized = normalizeMultiline(value);
    return (allowEmpty || normalized.length > 0)
      && normalized === value
      && !MULTILINE_CONTROL.test(value);
  }, { message: 'Expected canonical control-free multiline text.' });
}

function normalizedSingleLineInput(maximum: number, allowEmpty = false): z.ZodType<string> {
  return z.string().max(maximum).overwrite(normalizeSingleLine).refine((value) => {
    return (allowEmpty || value.length > 0) && !CONTROL.test(value);
  }, { message: 'Expected control-free single-line text.' });
}

function normalizedMultilineInput(maximum: number, allowEmpty = false): z.ZodType<string> {
  return z.string().max(maximum).overwrite(normalizeMultiline).refine((value) => {
    return (allowEmpty || value.length > 0) && !MULTILINE_CONTROL.test(value);
  }, { message: 'Expected control-free multiline text.' });
}

function addCanonicalOrderIssues(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[],
  message: string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      context.addIssue({ code: 'custom', path: [...path, index], message });
    }
  }
}

function canonicalResultSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('success'), data: dataSchema }),
    z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
  ]);
}

export const organizerCommunicationOpaqueIdSchema = providerOpaqueIdSchema;
export const organizerCommunicationVersionSchema = providerPositiveVersionSchema;
export const organizerCommunicationDigestSchema = providerSha256Schema;
export const organizerCommunicationStableKeySchema = providerStableKeySchema;
export const organizerCommunicationSubjectRefIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(OPAQUE_SUBJECT_REF);
export const organizerCommunicationRecipientResolutionIdSchema = z.string()
  .regex(RECIPIENT_RESOLUTION_ID);
export const organizerCommunicationCursorSchema = z.string().regex(CURSOR);
export const organizerCommunicationInstantSchema = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}, { message: 'Expected a canonical UTC instant.' });

export const organizerCommunicationPageRequestSchema = z.strictObject({
  cursor: organizerCommunicationCursorSchema.optional(),
  limit: z.number().int().positive().max(ORGANIZER_COMMUNICATION_PAGE_LIMIT).optional()
});

export const organizerCommunicationPageInfoSchema = z.discriminatedUnion('hasMore', [
  z.strictObject({ hasMore: z.literal(false) }),
  z.strictObject({ hasMore: z.literal(true), nextCursor: organizerCommunicationCursorSchema })
]);

export const organizerCommunicationDefinitionRefSchema = z.strictObject({
  reference: versionedDefinitionRefSchema,
  definitionDigestSha256: organizerCommunicationDigestSchema
});

export const organizerCommunicationPurposeRevisionRefSchema = z.strictObject({
  purposeId: organizerCommunicationOpaqueIdSchema,
  purposeKey: organizerCommunicationStableKeySchema,
  revisionId: organizerCommunicationOpaqueIdSchema,
  revisionNumber: organizerCommunicationVersionSchema,
  digestSha256: organizerCommunicationDigestSchema
});

export const organizerMessageTemplateRevisionRefSchema = z.strictObject({
  templateId: organizerCommunicationOpaqueIdSchema,
  templateRevisionId: organizerCommunicationOpaqueIdSchema,
  revisionNumber: organizerCommunicationVersionSchema,
  digestSha256: organizerCommunicationDigestSchema
});

export const organizerCommunicationRegisteredCountSchema = z.discriminatedUnion('knowledge', [
  z.strictObject({ knowledge: z.literal('known'), value: z.number().int().nonnegative().safe() }),
  z.strictObject({
    knowledge: z.literal('unknown'),
    reasonCode: organizerCommunicationStableKeySchema
  }),
  z.strictObject({ knowledge: z.literal('not_supported') })
]);

const paginationInputFields = {
  cursor: organizerCommunicationCursorSchema.optional(),
  limit: z.number().int().positive().max(ORGANIZER_COMMUNICATION_PAGE_LIMIT).optional()
} as const;

// Purpose and template reads expose policy identity, never classified policy payloads.
export const organizerCommunicationPurposeSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: organizerCommunicationPurposeRevisionRefSchema,
  label: canonicalSingleLine(160),
  channel: z.literal('email'),
  communicationClass: organizerCommunicationStableKeySchema,
  lifecycle: z.enum(['draft', 'active', 'archived']),
  policyDigestSha256: organizerCommunicationDigestSchema
});

export const organizerCommunicationPurposeDetailSchema = organizerCommunicationPurposeSummarySchema.extend({
  description: canonicalMultiline(2_000, true),
  allowedAudienceSources: z.array(organizerCommunicationDefinitionRefSchema).max(64)
}).superRefine((detail, context) => {
  addCanonicalOrderIssues(
    detail.allowedAudienceSources.map((source) => `${source.reference.key}@${source.reference.version}`),
    context,
    ['allowedAudienceSources'],
    'Audience source definitions must be unique and use canonical order.'
  );
});

export const organizerCommunicationPurposeListInputSchema = z.strictObject({
  channel: z.literal('email').optional(),
  lifecycle: z.enum(['draft', 'active', 'archived']).optional(),
  ...paginationInputFields
});

export const organizerCommunicationPurposeGetInputSchema = z.strictObject({
  purposeId: organizerCommunicationOpaqueIdSchema,
  revisionNumber: organizerCommunicationVersionSchema.optional()
});

export const organizerCommunicationPurposePageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rows: z.array(organizerCommunicationPurposeSummarySchema)
    .max(ORGANIZER_COMMUNICATION_PAGE_LIMIT),
  page: organizerCommunicationPageInfoSchema
});

export const organizerMessageInlineNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    value: canonicalSingleLine(4_000, true),
    emphasis: z.enum(['none', 'strong', 'emphasis']).optional()
  }),
  z.strictObject({
    kind: z.literal('merge_field'),
    fieldKey: organizerCommunicationStableKeySchema
  })
]);

const inlineNodesSchema = z.array(organizerMessageInlineNodeSchema).max(200);

export const organizerMessageComposedBlockSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('paragraph'), content: inlineNodesSchema }),
  z.strictObject({
    kind: z.literal('heading'),
    level: z.union([z.literal(2), z.literal(3)]),
    content: inlineNodesSchema
  }),
  z.strictObject({
    kind: z.literal('list'),
    style: z.enum(['ordered', 'unordered']),
    items: z.array(inlineNodesSchema).max(100)
  }),
  z.strictObject({
    kind: z.literal('action_link'),
    label: inlineNodesSchema,
    hrefFieldKey: organizerCommunicationStableKeySchema
  }),
  z.strictObject({
    kind: z.literal('detail_rows'),
    rows: z.array(z.strictObject({
      label: inlineNodesSchema,
      value: inlineNodesSchema
    })).max(100)
  })
]);

export const organizerMessageTemplateBodySchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('composed'),
    blocks: z.array(organizerMessageComposedBlockSchema)
      .max(ORGANIZER_COMMUNICATION_TEMPLATE_BLOCK_LIMIT)
  }),
  z.strictObject({
    mode: z.literal('open_canvas'),
    inertSource: canonicalMultiline(1_000_000, true),
    parameterKeys: z.array(organizerCommunicationStableKeySchema).max(500),
    complianceAnchors: z.array(organizerCommunicationStableKeySchema).max(32),
    sanitizerContract: organizerCommunicationDefinitionRefSchema
  }).superRefine((body, context) => {
    addCanonicalOrderIssues(body.parameterKeys, context, ['parameterKeys'],
      'Canvas parameter keys must be unique and use canonical order.');
    addCanonicalOrderIssues(body.complianceAnchors, context, ['complianceAnchors'],
      'Canvas compliance anchors must be unique and use canonical order.');
  })
]);

export const organizerEmailTemplateContentSchema = z.strictObject({
  kind: z.literal('email/v1'),
  subject: inlineNodesSchema,
  body: organizerMessageTemplateBodySchema,
  plainTextPolicy: z.enum(['derive_v1', 'explicit_v1']),
  explicitPlainText: inlineNodesSchema.optional(),
  attachmentSlotKeys: z.array(organizerCommunicationStableKeySchema).max(10)
}).superRefine((content, context) => {
  if ((content.plainTextPolicy === 'explicit_v1') !== (content.explicitPlainText !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['explicitPlainText'],
      message: 'Explicit plain text is present exactly for the explicit policy.'
    });
  }
  addCanonicalOrderIssues(content.attachmentSlotKeys, context, ['attachmentSlotKeys'],
    'Attachment slot keys must be unique and use canonical order.');
});

export const organizerMessageTemplateFieldBindingSchema = z.strictObject({
  fieldKey: organizerCommunicationStableKeySchema,
  requirement: z.enum(['required', 'optional']),
  fallback: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('payload_ref'),
      payloadRefId: organizerCommunicationOpaqueIdSchema,
      payloadRefVersion: organizerCommunicationVersionSchema
    })
  ])
});

export const organizerMessageTemplateSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: organizerMessageTemplateRevisionRefSchema,
  key: organizerCommunicationStableKeySchema,
  name: canonicalSingleLine(160),
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  channel: z.literal('email'),
  lifecycle: z.enum(['draft', 'active', 'archived']),
  bodyMode: z.enum(['composed', 'open_canvas']),
  subjectPreview: canonicalSingleLine(998, true)
});

export const organizerMessageTemplateDetailSchema = organizerMessageTemplateSummarySchema.extend({
  content: organizerEmailTemplateContentSchema,
  fieldBindings: z.array(organizerMessageTemplateFieldBindingSchema).max(500),
  renderer: organizerCommunicationDefinitionRefSchema,
  mergeRegistry: organizerCommunicationDefinitionRefSchema
}).superRefine((detail, context) => {
  if (detail.bodyMode !== detail.content.body.mode) {
    context.addIssue({ code: 'custom', path: ['bodyMode'], message: 'Body mode is incoherent.' });
  }
  addCanonicalOrderIssues(detail.fieldBindings.map((binding) => binding.fieldKey), context,
    ['fieldBindings'], 'Field bindings must be unique and use canonical order.');
});

export const organizerMessageTemplateListInputSchema = z.strictObject({
  purposeId: organizerCommunicationOpaqueIdSchema.optional(),
  lifecycle: z.enum(['draft', 'active', 'archived']).optional(),
  channel: z.literal('email').optional(),
  ...paginationInputFields
});

export const organizerMessageTemplateGetInputSchema = z.strictObject({
  templateId: organizerCommunicationOpaqueIdSchema,
  revisionNumber: organizerCommunicationVersionSchema.optional()
});

export const organizerMessageTemplatePageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rows: z.array(organizerMessageTemplateSummarySchema).max(ORGANIZER_COMMUNICATION_PAGE_LIMIT),
  page: organizerCommunicationPageInfoSchema
});

// Authoring values are inert. Effective templates/releases are produced only by trusted code.
export const organizerCommunicationAudienceAtomicSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('explicit_contacts'),
    contactRefIds: z.array(organizerCommunicationSubjectRefIdSchema)
      .min(1)
      .max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT)
  }).superRefine((source, context) => {
    addCanonicalOrderIssues(source.contactRefIds, context, ['contactRefIds'],
      'Contact references must be unique and use canonical order.');
  }),
  z.strictObject({
    kind: z.literal('registered_query'),
    recipeId: organizerCommunicationOpaqueIdSchema,
    recipeVersion: organizerCommunicationVersionSchema,
    recipeDigestSha256: organizerCommunicationDigestSchema,
    sourceDefinition: organizerCommunicationDefinitionRefSchema
  })
]);

/**
 * A server-resolved union of audience sources in organizer-selected order.
 * Labels are frozen with the source so the review can state which groups were
 * combined without trusting browser-authored prose at send time.
 */
export const organizerCommunicationAudienceSourceSchema = z.discriminatedUnion('kind', [
	...organizerCommunicationAudienceAtomicSourceSchema.options,
	z.strictObject({
		kind: z.literal('composite'),
		groups: z.array(z.strictObject({
			label: canonicalSingleLine(200),
			source: organizerCommunicationAudienceAtomicSourceSchema
		})).min(2).max(20)
	})
]);

export const organizerCommunicationAudienceDraftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: z.literal('current_snapshot'),
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  source: organizerCommunicationAudienceSourceSchema
});

export const organizerCommunicationAudienceOptionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  optionId: organizerCommunicationOpaqueIdSchema,
  optionVersion: organizerCommunicationVersionSchema,
  optionDigestSha256: organizerCommunicationDigestSchema,
  label: canonicalSingleLine(200),
  recipientEstimate: organizerCommunicationRegisteredCountSchema,
  audienceDraft: organizerCommunicationAudienceDraftSchema
});

export const organizerCommunicationAudienceOptionListInputSchema = z.strictObject({
  personRefId: organizerCommunicationSubjectRefIdSchema.optional(),
  purposeId: organizerCommunicationOpaqueIdSchema.optional(),
	selectionOptionIds: z.array(organizerCommunicationOpaqueIdSchema).min(1).max(20)
		.refine((values) => new Set(values).size === values.length, {
			message: 'Audience option references must be unique.'
		}).optional(),
  ...paginationInputFields
});

export const organizerCommunicationAudienceSelectionPreviewSchema = z.strictObject({
	schemaVersion: z.literal(1),
	optionIds: z.array(organizerCommunicationOpaqueIdSchema).min(1).max(20),
	label: canonicalSingleLine(4_000),
	reach: z.number().int().nonnegative().max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT),
	overlap: z.number().int().nonnegative().max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT),
	rows: z.array(z.strictObject({
		personRefId: organizerCommunicationSubjectRefIdSchema,
		safeLabel: canonicalSingleLine(240),
		state: z.enum(['included', 'excluded']),
		reasonCode: organizerCommunicationStableKeySchema.optional(),
		via: canonicalSingleLine(200).optional()
	})).max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT),
	audienceDraft: organizerCommunicationAudienceDraftSchema
});

export const organizerCommunicationAudienceOptionPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rows: z.array(organizerCommunicationAudienceOptionSchema)
    .max(ORGANIZER_COMMUNICATION_PAGE_LIMIT),
  page: organizerCommunicationPageInfoSchema,
	selectionPreview: organizerCommunicationAudienceSelectionPreviewSchema.optional()
});

export const organizerEmailMessageContentInputSchema = z.strictObject({
  kind: z.literal('email/v1'),
  subject: normalizedSingleLineInput(998),
  body: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('plain_text/v1'),
      text: normalizedMultilineInput(100_000, true)
    }),
    z.strictObject({
      kind: z.literal('template_revision/v1'),
      templateRevision: organizerMessageTemplateRevisionRefSchema
    })
  ])
});

export const organizerEmailMessageContentSchema = z.strictObject({
  kind: z.literal('email/v1'),
  subject: canonicalSingleLine(998),
  body: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('plain_text/v1'), text: canonicalMultiline(100_000, true) }),
    z.strictObject({
      kind: z.literal('template_revision/v1'),
      templateRevision: organizerMessageTemplateRevisionRefSchema
    })
  ])
});

export const organizerTemplateFieldFallbackValueSchema = z.discriminatedUnion('valueType', [
  z.strictObject({ valueType: z.literal('text'), value: canonicalMultiline(20_000, true) }),
  z.strictObject({ valueType: z.literal('url'), value: canonicalSingleLine(8_000) }),
  z.strictObject({ valueType: z.literal('date'), value: z.iso.date() }),
  z.strictObject({ valueType: z.literal('instant'), value: organizerCommunicationInstantSchema }),
  z.strictObject({ valueType: z.literal('integer'), value: z.number().int().safe() })
]);

export const organizerCommunicationAuthoringPayloadInputSchema = z.discriminatedUnion('payloadKind', [
  z.strictObject({
    payloadKind: z.literal('template_content'),
    schemaVersion: z.literal(1),
    value: organizerEmailTemplateContentSchema
  }),
  z.strictObject({
    payloadKind: z.literal('template_field_bindings'),
    schemaVersion: z.literal(1),
    value: z.array(organizerMessageTemplateFieldBindingSchema).max(500)
  }).superRefine((payload, context) => {
    addCanonicalOrderIssues(payload.value.map((binding) => binding.fieldKey), context, ['value'],
      'Field bindings must be unique and use canonical order.');
  }),
  z.strictObject({
    payloadKind: z.literal('template_field_fallback'),
    schemaVersion: z.literal(1),
    fieldKey: organizerCommunicationStableKeySchema,
    value: organizerTemplateFieldFallbackValueSchema
  }),
  z.strictObject({
    payloadKind: z.literal('message_content'),
    schemaVersion: z.literal(1),
    value: organizerEmailMessageContentInputSchema
  }),
  z.strictObject({
    payloadKind: z.literal('message_audience_draft'),
    schemaVersion: z.literal(1),
    value: organizerCommunicationAudienceDraftSchema
  })
]);

export const organizerCommunicationAuthoringPayloadRefSchema = z.strictObject({
  payloadRefId: organizerCommunicationOpaqueIdSchema,
  payloadRefVersion: organizerCommunicationVersionSchema,
  payloadKind: z.enum([
    'template_content',
    'template_field_bindings',
    'template_field_fallback',
    'message_content',
    'message_audience_draft'
  ]),
  schemaKey: organizerCommunicationStableKeySchema,
  schemaVersion: organizerCommunicationVersionSchema,
  classification: organizerCommunicationStableKeySchema
});

export const organizerMessageContentPayloadRefSchema = organizerCommunicationAuthoringPayloadRefSchema
  .extend({ payloadKind: z.literal('message_content') });
export const organizerMessageAudiencePayloadRefSchema = organizerCommunicationAuthoringPayloadRefSchema
  .extend({ payloadKind: z.literal('message_audience_draft') });
export const organizerTemplateContentPayloadRefSchema = organizerCommunicationAuthoringPayloadRefSchema
  .extend({ payloadKind: z.literal('template_content') });
export const organizerTemplateFieldBindingsPayloadRefSchema = organizerCommunicationAuthoringPayloadRefSchema
  .extend({ payloadKind: z.literal('template_field_bindings') });

export const organizerStoreAuthoringPayloadInputSchema = z.strictObject({
  payload: organizerCommunicationAuthoringPayloadInputSchema
});

export const organizerCreateMessageTemplateInputSchema = z.strictObject({
	templateKey: organizerCommunicationStableKeySchema,
	templateName: normalizedSingleLineInput(160),
	purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
	contentPayload: organizerTemplateContentPayloadRefSchema,
	fieldBindingsPayload: organizerTemplateFieldBindingsPayloadRefSchema,
	renderer: organizerCommunicationDefinitionRefSchema,
	mergeRegistry: organizerCommunicationDefinitionRefSchema
});

export const organizerCommunicationDraftStateSchema = z.enum(['active', 'proposed', 'discarded']);
export const organizerCommunicationDraftProvenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human') }),
  z.strictObject({
    kind: z.literal('agent'),
    runRefId: organizerCommunicationOpaqueIdSchema,
    scaffold: organizerCommunicationDefinitionRefSchema,
    modelProfile: organizerCommunicationDefinitionRefSchema
  })
]);

export const ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID =
  'je.communication.message-draft.empty-content/v1' as const;
export const ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID =
  'je.communication.message-draft.empty-audience/v1' as const;

export const organizerCommunicationDraftUninitializedAuthoringSchema = z.strictObject({
  state: z.literal('uninitialized'),
  contentRefId: z.literal(ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID),
  audienceRefId: z.literal(ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID)
});

export const organizerCommunicationDraftReadyAuthoringSchema = z.strictObject({
  state: z.literal('ready'),
  subject: canonicalSingleLine(998),
  audienceLabel: canonicalSingleLine(200).optional(),
  recipientEstimate: organizerCommunicationRegisteredCountSchema,
  contentPayload: organizerMessageContentPayloadRefSchema,
  audiencePayload: organizerMessageAudiencePayloadRefSchema
});

export const organizerCommunicationDraftAuthoringSchema = z.discriminatedUnion('state', [
  organizerCommunicationDraftUninitializedAuthoringSchema,
  organizerCommunicationDraftReadyAuthoringSchema
]);

const organizerCommunicationDraftBaseFields = {
  schemaVersion: z.literal(1),
  draftId: organizerCommunicationOpaqueIdSchema,
  version: organizerCommunicationVersionSchema,
  state: organizerCommunicationDraftStateSchema,
  channel: z.literal('email'),
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  templateRevision: organizerMessageTemplateRevisionRefSchema.optional(),
  provenance: organizerCommunicationDraftProvenanceSchema,
  updatedAt: organizerCommunicationInstantSchema
} as const;

export const organizerCommunicationDraftSummarySchema = z.strictObject({
  ...organizerCommunicationDraftBaseFields,
  authoring: organizerCommunicationDraftAuthoringSchema
}).superRefine((draft, context) => {
  if (draft.authoring.state === 'uninitialized' && draft.state === 'proposed') {
    context.addIssue({
      code: 'custom',
      path: ['authoring', 'state'],
      message: 'An uninitialized draft cannot be proposed.'
    });
  }
});

export const organizerCommunicationDraftProjectionSchema = organizerCommunicationDraftSummarySchema.extend({
  content: organizerEmailMessageContentSchema.optional(),
  audience: organizerCommunicationAudienceDraftSchema.optional(),
  allowedNextActions: z.array(z.enum(['revise', 'preview', 'discard', 'propose'])).max(4)
}).superRefine((draft, context) => {
  if (draft.authoring.state === 'uninitialized') {
    if (draft.content !== undefined || draft.audience !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['authoring', 'state'],
        message: 'Uninitialized drafts omit parsed content and audience values.'
      });
    }
  } else if (draft.content === undefined || draft.audience === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['authoring', 'state'],
      message: 'Ready drafts include parsed content and audience values.'
    });
  } else if (draft.audience.purposeRevision.revisionId !== draft.purposeRevision.revisionId) {
    context.addIssue({
      code: 'custom',
      path: ['audience', 'purposeRevision'],
      message: 'Draft audience and draft purpose revisions must match.'
    });
  }
  const expectedActions = draft.state !== 'active'
    ? []
    : draft.authoring.state === 'uninitialized'
      ? ['revise', 'discard']
      : ['revise', 'preview', 'discard', 'propose'];
  if (draft.allowedNextActions.length !== expectedActions.length
    || draft.allowedNextActions.some((action, index) => action !== expectedActions[index])) {
    context.addIssue({
      code: 'custom',
      path: ['allowedNextActions'],
      message: 'Allowed next actions must be the canonical set for the draft state.'
    });
  }
});

export const organizerCommunicationDraftListInputSchema = z.strictObject({
  state: organizerCommunicationDraftStateSchema.optional(),
  ...paginationInputFields
});

export const organizerCommunicationDraftGetInputSchema = z.strictObject({
  draftId: organizerCommunicationOpaqueIdSchema,
  expectedVersion: organizerCommunicationVersionSchema.optional()
});

export const organizerCommunicationDraftPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rows: z.array(organizerCommunicationDraftSummarySchema).max(ORGANIZER_COMMUNICATION_PAGE_LIMIT),
  page: organizerCommunicationPageInfoSchema
});

export const organizerCommunicationInitialAuthoringSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('registered_empty_refs'),
    contentRefId: z.literal(ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID),
    audienceRefId: z.literal(ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID)
  }),
  z.strictObject({
    kind: z.literal('adopted_payload_refs'),
    contentPayload: organizerMessageContentPayloadRefSchema,
    audiencePayload: organizerMessageAudiencePayloadRefSchema
  })
]);

export const organizerCreateCommunicationDraftInputSchema = z.strictObject({
  channel: z.literal('email'),
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  templateRevision: organizerMessageTemplateRevisionRefSchema.optional(),
  initial: organizerCommunicationInitialAuthoringSchema
});

export const organizerReviseCommunicationDraftInputSchema = z.strictObject({
  draftId: organizerCommunicationOpaqueIdSchema,
  expectedVersion: organizerCommunicationVersionSchema,
  contentPayload: organizerMessageContentPayloadRefSchema,
  audiencePayload: organizerMessageAudiencePayloadRefSchema
});

export const organizerDiscardCommunicationDraftInputSchema = z.strictObject({
  draftId: organizerCommunicationOpaqueIdSchema,
  expectedVersion: organizerCommunicationVersionSchema,
  reasonCode: organizerCommunicationStableKeySchema
});

export const organizerCommunicationDraftMutationResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  draftId: organizerCommunicationOpaqueIdSchema,
  version: organizerCommunicationVersionSchema,
  state: organizerCommunicationDraftStateSchema,
  authoring: organizerCommunicationDraftAuthoringSchema,
  nextRead: z.strictObject({
    operationName: z.literal('get_message_draft'),
    draftId: organizerCommunicationOpaqueIdSchema,
    expectedVersion: organizerCommunicationVersionSchema
  })
}).superRefine((result, context) => {
  if (result.authoring.state === 'uninitialized' && result.state === 'proposed') {
    context.addIssue({
      code: 'custom',
      path: ['authoring', 'state'],
      message: 'An uninitialized draft cannot be proposed.'
    });
  }
  if (result.draftId !== result.nextRead.draftId || result.version !== result.nextRead.expectedVersion) {
    context.addIssue({ code: 'custom', path: ['nextRead'], message: 'Next read must target this result.' });
  }
});

// Preview identity is indivisible; no read is permitted to fall forward to a newer generation.
export const organizerMessagePreviewIdentitySchema = z.strictObject({
  audienceSpecId: organizerCommunicationOpaqueIdSchema,
  draftId: organizerCommunicationOpaqueIdSchema,
  draftVersion: organizerCommunicationVersionSchema,
  previewGeneration: organizerCommunicationVersionSchema,
  previewDigestProfile: organizerCommunicationStableKeySchema,
  previewDigestVersion: organizerCommunicationVersionSchema,
  previewDigestSha256: organizerCommunicationDigestSchema
});

export const organizerMessagePreviewCountsSchema = z.strictObject({
  visibleCandidateCount: z.number().int().nonnegative().max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT),
  includedCount: z.number().int().nonnegative().max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT),
  excludedCount: z.number().int().nonnegative().max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT),
  blockedCount: z.number().int().nonnegative().max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT)
}).superRefine((counts, context) => {
  if (counts.includedCount + counts.excludedCount + counts.blockedCount
    !== counts.visibleCandidateCount) {
    context.addIssue({ code: 'custom', message: 'Visible preview counts must add up exactly.' });
  }
});

export const organizerMessagePreviewSourceVersionSchema = z.strictObject({
  sourceKey: organizerCommunicationStableKeySchema,
  sourceVersion: organizerCommunicationVersionSchema,
  digestSha256: organizerCommunicationDigestSchema
});

export const organizerMessagePreviewSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: organizerMessagePreviewIdentitySchema,
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  templateRevision: organizerMessageTemplateRevisionRefSchema.optional(),
  counts: organizerMessagePreviewCountsSchema,
  membershipDigestSha256: organizerCommunicationDigestSchema,
  evidenceDigestSha256: organizerCommunicationDigestSchema,
  reasonCodes: z.array(organizerCommunicationStableKeySchema).max(100),
  sourceVersions: z.array(organizerMessagePreviewSourceVersionSchema).max(100),
  renderer: organizerCommunicationDefinitionRefSchema,
  mergeRegistry: organizerCommunicationDefinitionRefSchema
}).superRefine((summary, context) => {
  addCanonicalOrderIssues(summary.reasonCodes, context, ['reasonCodes'],
    'Preview reason codes must be unique and use canonical order.');
  addCanonicalOrderIssues(summary.sourceVersions.map((source) => source.sourceKey), context,
    ['sourceVersions'], 'Preview source versions must be unique and use canonical order.');
});

export const organizerPreviewMessageBatchInputSchema = z.strictObject({
  draftId: organizerCommunicationOpaqueIdSchema,
  expectedDraftVersion: organizerCommunicationVersionSchema
});

export const organizerPreviewMessageBatchResultSchema = organizerMessagePreviewSummarySchema;

/**
 * Step one of the two-step preview-adoption lane: the asynchronous,
 * compute-only audience resolution and per-recipient render run behind this
 * read and are parked server-side against the exact draft revision; the
 * `preview_message_batch` effect then adopts the parked preparation inside
 * its one unit-of-work transaction, re-verifying draft version and audience
 * guard state before anything is written. Nothing durable changes here, and
 * an unadopted preparation simply expires unused.
 */
export const organizerPrepareMessagePreviewResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  draftId: organizerCommunicationOpaqueIdSchema,
  draftVersion: organizerCommunicationVersionSchema,
  state: z.literal('prepared')
});

export const organizerMessageBatchPreviewGetInputSchema = organizerMessagePreviewIdentitySchema.extend({
  selectedRecipientResolutionId: organizerCommunicationRecipientResolutionIdSchema.optional()
});

export const organizerRecipientChannelProjectionSchema = z.discriminatedUnion('disclosure', [
  z.strictObject({
    disclosure: z.literal('masked'),
    maskedValue: canonicalSingleLine(320)
  }),
  z.strictObject({
    disclosure: z.literal('exact_authorized'),
    maskedValue: canonicalSingleLine(320),
    exactValue: z.email().max(320)
  }),
  z.strictObject({
    disclosure: z.literal('absent'),
    reasonCode: organizerCommunicationStableKeySchema
  })
]);

const recipientRowBase = {
  recipientResolutionId: organizerCommunicationRecipientResolutionIdSchema,
  safeLabel: canonicalSingleLine(240),
  channel: organizerRecipientChannelProjectionSchema,
  mergeFallbackFieldKeys: z.array(organizerCommunicationStableKeySchema).max(100)
} as const;

export const organizerMessagePreviewRecipientRowSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...recipientRowBase,
    state: z.literal('included'),
    releaseId: organizerCommunicationOpaqueIdSchema,
    releaseDigestSha256: organizerCommunicationDigestSchema
  }),
  z.strictObject({
    ...recipientRowBase,
    state: z.literal('excluded'),
    reasonCode: organizerCommunicationStableKeySchema
  }),
  z.strictObject({
    ...recipientRowBase,
    state: z.literal('blocked'),
    reasonCode: organizerCommunicationStableKeySchema
  })
]).superRefine((row, context) => {
  addCanonicalOrderIssues(row.mergeFallbackFieldKeys, context, ['mergeFallbackFieldKeys'],
    'Merge fallback field keys must be unique and use canonical order.');
});

export const organizerRenderedAttachmentSchema = z.strictObject({
  slotKey: organizerCommunicationStableKeySchema,
  filename: canonicalSingleLine(512),
  mediaType: canonicalSingleLine(160),
  byteLength: z.number().int().nonnegative().safe(),
  contentSha256: organizerCommunicationDigestSchema,
  disposition: z.enum(['attachment', 'inline']),
  contentId: canonicalSingleLine(512).optional()
});

export const organizerServerRenderedEmailSchema = z.strictObject({
  recipientResolutionId: organizerCommunicationRecipientResolutionIdSchema,
  releaseId: organizerCommunicationOpaqueIdSchema,
  releaseDigestSha256: organizerCommunicationDigestSchema,
  outputDigestSha256: organizerCommunicationDigestSchema,
  resolvedInputDigestSha256: organizerCommunicationDigestSchema,
  attachmentManifestDigestSha256: organizerCommunicationDigestSchema,
  renderer: organizerCommunicationDefinitionRefSchema,
  mergeRegistry: organizerCommunicationDefinitionRefSchema,
  subject: canonicalSingleLine(998),
  sanitizedHtml: canonicalMultiline(1_000_000, true),
  plainText: canonicalMultiline(1_000_000, true),
  attachments: z.array(organizerRenderedAttachmentSchema).max(10),
  warningCodes: z.array(organizerCommunicationStableKeySchema).max(100)
}).superRefine((render, context) => {
  addCanonicalOrderIssues(render.attachments.map((attachment) => attachment.slotKey), context,
    ['attachments'], 'Rendered attachments must be unique and use canonical slot order.');
  addCanonicalOrderIssues(render.warningCodes, context, ['warningCodes'],
    'Render warning codes must be unique and use canonical order.');
});

export const organizerMessageBatchPreviewDetailSchema = z.strictObject({
  schemaVersion: z.literal(1),
  summary: organizerMessagePreviewSummarySchema,
  selected: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('rendered_email'), render: organizerServerRenderedEmailSchema })
  ])
});

export const organizerMessagePreviewRecipientListInputSchema = organizerMessagePreviewIdentitySchema.extend({
  state: z.enum(['included', 'excluded', 'blocked']).optional(),
  reasonCode: organizerCommunicationStableKeySchema.optional(),
  cursor: organizerCommunicationCursorSchema.optional(),
  limit: z.number().int().positive().max(ORGANIZER_COMMUNICATION_RECIPIENT_LIMIT).optional()
});

export const organizerMessagePreviewRecipientPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: organizerMessagePreviewIdentitySchema,
  rows: z.array(organizerMessagePreviewRecipientRowSchema)
    .max(ORGANIZER_COMMUNICATION_RECIPIENT_LIMIT),
  page: organizerCommunicationPageInfoSchema
}).superRefine((page, context) => {
  const ids = page.rows.map((row) => row.recipientResolutionId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['rows'], message: 'Recipient rows must be unique.' });
  }
});

// Provider readiness is capability-specific. This v1 deliberately has no callback or inbound path.
export const organizerCommunicationSafeEvidenceRefSchema = z.strictObject({
  evidenceId: organizerCommunicationOpaqueIdSchema,
  registeredCode: organizerCommunicationStableKeySchema,
  digestSha256: organizerCommunicationDigestSchema,
  observedAt: organizerCommunicationInstantSchema
});

export const organizerEmailOutboundReadinessSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('unknown'),
    nextStepCode: organizerCommunicationStableKeySchema
  }),
  z.strictObject({
    state: z.literal('action_required'),
    reasonCode: organizerCommunicationStableKeySchema,
    nextStepCode: organizerCommunicationStableKeySchema
  }),
  z.strictObject({
    state: z.literal('ready'),
    connectionRevisionId: organizerCommunicationOpaqueIdSchema,
    evidence: organizerCommunicationSafeEvidenceRefSchema,
    validUntil: organizerCommunicationInstantSchema
  })
]);

export const organizerEmailReadinessProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provider: z.strictObject({
    adapterKey: organizerCommunicationStableKeySchema,
    adapterVersion: canonicalSingleLine(160),
    displayName: canonicalSingleLine(160)
  }).optional(),
  outbound: organizerEmailOutboundReadinessSchema,
  callbacks: z.strictObject({ state: z.literal('not_supported') }),
  inbound: z.strictObject({ state: z.literal('not_enabled') })
}).superRefine((readiness, context) => {
  if (readiness.outbound.state === 'ready' && readiness.provider === undefined) {
    context.addIssue({ code: 'custom', path: ['provider'], message: 'Ready outbound requires provider identity.' });
  }
});

export const organizerEmailReadinessGetInputSchema = z.strictObject({});

// Organizer-visible history excludes security/auth mail by contract and contains only safe facts.
export const ORGANIZER_COMMUNICATION_HISTORY_STATES = [
  'authorized',
  'blocked_provider_not_ready',
  'deferred',
  'materialized',
  'attempting',
  'accepted',
  'delivered',
  'delayed',
  'known_failed',
  'acceptance_unknown',
  'abandoned',
  'dead_lettered',
  'cancelled_before_attempt',
  'cancelled',
  'cancelled_before_materialization',
  'expired',
  'stale',
  'revoked'
] as const;

export const organizerCommunicationHistoryStateSchema = z.enum(
  ORGANIZER_COMMUNICATION_HISTORY_STATES
);

export const organizerCommunicationActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), displayLabel: canonicalSingleLine(160) }),
  z.strictObject({ kind: z.literal('agent'), displayLabel: canonicalSingleLine(160) }),
  z.strictObject({
    kind: z.literal('standing_policy'),
    displayLabel: canonicalSingleLine(160),
    policyRevision: organizerCommunicationDefinitionRefSchema
  })
]);

export const organizerCommunicationCauseSchema = z.strictObject({
  summary: canonicalSingleLine(500),
  subjectKind: organizerCommunicationStableKeySchema.optional(),
  subjectRefId: organizerCommunicationSubjectRefIdSchema.optional(),
  subjectVersion: organizerCommunicationVersionSchema.optional()
}).superRefine((cause, context) => {
  const referenceParts = [cause.subjectKind, cause.subjectRefId, cause.subjectVersion];
  const present = referenceParts.filter((part) => part !== undefined).length;
  if (present !== 0 && present !== referenceParts.length) {
    context.addIssue({ code: 'custom', message: 'Cause reference fields are all present or all absent.' });
  }
});

export const organizerCommunicationDeliveryCountsSchema = z.strictObject({
  audience: organizerCommunicationRegisteredCountSchema,
  materialized: organizerCommunicationRegisteredCountSchema,
  accepted: organizerCommunicationRegisteredCountSchema,
  delivered: organizerCommunicationRegisteredCountSchema,
  acceptanceUnknown: organizerCommunicationRegisteredCountSchema,
  knownFailed: organizerCommunicationRegisteredCountSchema
});

export const organizerCommunicationHistoryActionSchema = z.enum([
  'review_draft',
  'continue_provider_setup',
  'wait_for_evidence',
  'open_timeline',
  'cancel_pending'
]);

export const organizerCommunicationHistoryItemSchema = z.strictObject({
  schemaVersion: z.literal(1),
  visibility: z.literal('organizer_non_security'),
  historyItemId: organizerCommunicationOpaqueIdSchema,
  messageRefId: organizerCommunicationOpaqueIdSchema,
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  templateRevision: organizerMessageTemplateRevisionRefSchema.optional(),
  subject: canonicalSingleLine(998),
  audienceLabel: canonicalSingleLine(200),
  state: organizerCommunicationHistoryStateSchema,
  stateReasonCode: organizerCommunicationStableKeySchema.optional(),
  actor: organizerCommunicationActorSchema,
  cause: organizerCommunicationCauseSchema,
  counts: organizerCommunicationDeliveryCountsSchema,
  authorizedAt: organizerCommunicationInstantSchema,
  requestedFor: organizerCommunicationInstantSchema.optional(),
  lastObservedAt: organizerCommunicationInstantSchema.optional(),
  availableActions: z.array(organizerCommunicationHistoryActionSchema).max(5)
}).superRefine((item, context) => {
  addCanonicalOrderIssues(item.availableActions, context, ['availableActions'],
    'History actions must be unique and use canonical order.');
});

export const organizerCommunicationHistoryListInputSchema = z.strictObject({
  state: organizerCommunicationHistoryStateSchema.optional(),
  messageRefId: organizerCommunicationOpaqueIdSchema.optional(),
  personRefId: organizerCommunicationSubjectRefIdSchema.optional(),
  ...paginationInputFields
});

export const organizerCommunicationHistoryPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  visibility: z.literal('organizer_non_security'),
  rows: z.array(organizerCommunicationHistoryItemSchema).max(ORGANIZER_COMMUNICATION_PAGE_LIMIT),
  page: organizerCommunicationPageInfoSchema
});

export const organizerCommunicationAttentionSeveritySchema = z.enum(['action', 'soon']);
export const organizerCommunicationAttentionActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('review_draft'), draftId: organizerCommunicationOpaqueIdSchema }),
  z.strictObject({ kind: z.literal('open_history'), historyItemId: organizerCommunicationOpaqueIdSchema }),
  z.strictObject({ kind: z.literal('continue_provider_setup') }),
  z.strictObject({ kind: z.literal('wait_for_evidence'), deliveryId: organizerCommunicationOpaqueIdSchema })
]);

export const organizerCommunicationAttentionItemSchema = z.strictObject({
  schemaVersion: z.literal(1),
  visibility: z.literal('organizer_non_security'),
  attentionItemId: organizerCommunicationOpaqueIdSchema,
  severity: organizerCommunicationAttentionSeveritySchema,
  reasonCode: organizerCommunicationStableKeySchema,
  summary: canonicalSingleLine(500),
  detail: canonicalMultiline(2_000),
  affectedCount: organizerCommunicationRegisteredCountSchema.optional(),
  dueAt: organizerCommunicationInstantSchema.optional(),
  expiresAt: organizerCommunicationInstantSchema.optional(),
  recommendedAction: organizerCommunicationAttentionActionSchema
});

export const organizerCommunicationAttentionListInputSchema = z.strictObject({
  severity: organizerCommunicationAttentionSeveritySchema.optional(),
  reasonCode: organizerCommunicationStableKeySchema.optional(),
  ...paginationInputFields
});

export const organizerCommunicationAttentionPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  visibility: z.literal('organizer_non_security'),
  rows: z.array(organizerCommunicationAttentionItemSchema).max(ORGANIZER_COMMUNICATION_PAGE_LIMIT),
  page: organizerCommunicationPageInfoSchema
});

export const organizerCommunicationThreadEntrySchema = z.strictObject({
  entryId: organizerCommunicationOpaqueIdSchema,
  historyItemId: organizerCommunicationOpaqueIdSchema.optional(),
  occurredAt: organizerCommunicationInstantSchema,
  purposeRevision: organizerCommunicationPurposeRevisionRefSchema,
  subject: canonicalSingleLine(998),
  state: organizerCommunicationHistoryStateSchema,
  actor: organizerCommunicationActorSchema
});

export const organizerCommunicationThreadGetInputSchema = z.strictObject({
  personRefId: organizerCommunicationSubjectRefIdSchema,
  ...paginationInputFields
});

export const organizerCommunicationThreadPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  visibility: z.literal('organizer_non_security'),
  personRefId: organizerCommunicationSubjectRefIdSchema,
  personLabel: canonicalSingleLine(240),
  rows: z.array(organizerCommunicationThreadEntrySchema).max(ORGANIZER_COMMUNICATION_PAGE_LIMIT),
  page: organizerCommunicationPageInfoSchema
});

export const organizerCommunicationTimelineFactSchema = z.strictObject({
  factId: organizerCommunicationOpaqueIdSchema,
  sequence: organizerCommunicationVersionSchema,
  occurredAt: organizerCommunicationInstantSchema,
  kind: z.enum([
    'authorized',
    'materialized',
    'attempt_started',
    'provider_accepted',
    'delivery_confirmed',
    'acceptance_unknown',
    'known_failed',
    'cancellation_recorded',
    'reconciled'
  ]),
  summaryCode: organizerCommunicationStableKeySchema,
  actor: organizerCommunicationActorSchema,
  evidenceDigestSha256: organizerCommunicationDigestSchema.optional(),
  /**
   * Present on the live batch timeline. The delivery id is opaque and the
   * label is the organizer-safe contact label; address bytes never ride this
   * projection. Kept optional so previously recorded generic timeline facts
   * remain valid while the read grows per-recipient evidence.
   */
  recipient: z.strictObject({
    deliveryId: organizerCommunicationOpaqueIdSchema,
    safeLabel: canonicalSingleLine(240),
    state: z.enum([
      'pending',
      'request_started',
      'accepted',
      'known_rejected_safe_retryable',
      'known_rejected_terminal',
      'acceptance_unknown'
    ])
  }).optional(),
  attempt: z.strictObject({
    attemptNumber: organizerCommunicationVersionSchema,
    attemptKind: z.enum(['original', 'marked_resend']),
    state: z.enum([
      'request_started',
      'accepted',
      'known_rejected_safe_retryable',
      'known_rejected_terminal',
      'acceptance_unknown'
    ]),
    providerOutcomeReason: canonicalSingleLine(500).optional(),
    recoveryCode: z.enum(['worker_result_lost', 'provider_boundary_failure']).optional(),
    startedAt: organizerCommunicationInstantSchema,
    completedAt: organizerCommunicationInstantSchema.optional()
  }).optional()
});

export const organizerCommunicationTimelineGetInputSchema = z.strictObject({
  deliveryId: organizerCommunicationOpaqueIdSchema,
  cursor: organizerCommunicationCursorSchema.optional(),
  limit: z.number().int().positive().max(ORGANIZER_COMMUNICATION_TIMELINE_LIMIT).optional()
});

export const organizerCommunicationTimelinePageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  visibility: z.literal('organizer_non_security'),
  deliveryId: organizerCommunicationOpaqueIdSchema,
  currentState: organizerCommunicationHistoryStateSchema,
  rows: z.array(organizerCommunicationTimelineFactSchema)
    .max(ORGANIZER_COMMUNICATION_TIMELINE_LIMIT),
  page: organizerCommunicationPageInfoSchema
}).superRefine((timeline, context) => {
  for (let index = 1; index < timeline.rows.length; index += 1) {
    if (timeline.rows[index - 1]!.sequence >= timeline.rows[index]!.sequence) {
      context.addIssue({ code: 'custom', path: ['rows', index, 'sequence'],
        message: 'Timeline facts must use strictly increasing sequence order.' });
    }
  }
});

/**
 * The consequential send wave over one adopted, reviewed preview. The wire
 * carries only the adopted preview's audience identity, the operator's batch
 * identity and labels — release materialization, the internal
 * draft → propose → commit ceremony, and the outbox registration happen
 * server-side in one transaction, and a preview whose evidence no longer
 * reproduces from current domain state refuses typed
 * (`stale_revision`/`communication.preview_changed`) instead of sending.
 */
export const organizerSendMessagesInputSchema = z.strictObject({
  audienceSpecId: organizerCommunicationOpaqueIdSchema,
  batchId: organizerCommunicationOpaqueIdSchema,
  subject: normalizedSingleLineInput(998),
  audienceLabel: normalizedSingleLineInput(200)
});

/** Receipt-safe send result: counts and identity only, never an address. */
export const organizerSendMessagesResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batchId: organizerCommunicationOpaqueIdSchema,
  releaseCommitId: organizerCommunicationOpaqueIdSchema,
  dispatchGeneration: z.literal(1),
  releaseCount: z.number().int().positive()
    .max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT),
  deliveryCount: z.number().int().positive()
    .max(ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT)
}).superRefine((result, context) => {
  if (result.deliveryCount !== result.releaseCount) {
    context.addIssue({
      code: 'custom',
      path: ['deliveryCount'],
      message: 'Every committed release registers exactly one delivery.'
    });
  }
});

// Canonical handler results (without transport execution metadata).
export const organizerCommunicationPurposePageCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationPurposePageSchema);
export const organizerCommunicationPurposeDetailCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationPurposeDetailSchema);
export const organizerMessageTemplatePageCanonicalResultSchema =
  canonicalResultSchema(organizerMessageTemplatePageSchema);
export const organizerMessageTemplateDetailCanonicalResultSchema =
  canonicalResultSchema(organizerMessageTemplateDetailSchema);
export const organizerCommunicationAudienceOptionPageCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationAudienceOptionPageSchema);
export const organizerCommunicationDraftPageCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationDraftPageSchema);
export const organizerCommunicationDraftCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationDraftProjectionSchema);
export const organizerCommunicationAuthoringPayloadCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationAuthoringPayloadRefSchema);
export const organizerMessageTemplateMutationCanonicalResultSchema =
	canonicalResultSchema(organizerMessageTemplateSummarySchema);
export const organizerCommunicationDraftMutationCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationDraftMutationResultSchema);
export const organizerMessagePreviewCanonicalResultSchema =
  canonicalResultSchema(organizerPreviewMessageBatchResultSchema);
export const organizerMessageBatchPreviewDetailCanonicalResultSchema =
  canonicalResultSchema(organizerMessageBatchPreviewDetailSchema);
export const organizerMessagePreviewRecipientPageCanonicalResultSchema =
  canonicalResultSchema(organizerMessagePreviewRecipientPageSchema);
export const organizerCommunicationHistoryPageCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationHistoryPageSchema);
export const organizerCommunicationAttentionPageCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationAttentionPageSchema);
export const organizerCommunicationThreadPageCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationThreadPageSchema);
export const organizerCommunicationTimelinePageCanonicalResultSchema =
  canonicalResultSchema(organizerCommunicationTimelinePageSchema);
export const organizerEmailReadinessCanonicalResultSchema =
  canonicalResultSchema(organizerEmailReadinessProjectionSchema);
export const organizerSendMessagesCanonicalResultSchema =
  canonicalResultSchema(organizerSendMessagesResultSchema);
export const organizerPrepareMessagePreviewCanonicalResultSchema =
  canonicalResultSchema(organizerPrepareMessagePreviewResultSchema);

// Wire results (with correlation/receipt metadata) used by operator bindings.
export const organizerCommunicationPurposePageOperationResultSchema =
  createReadOperationResultSchema(organizerCommunicationPurposePageSchema);
export const organizerCommunicationPurposeDetailOperationResultSchema =
  createReadOperationResultSchema(organizerCommunicationPurposeDetailSchema);
export const organizerMessageTemplatePageOperationResultSchema =
  createReadOperationResultSchema(organizerMessageTemplatePageSchema);
export const organizerMessageTemplateDetailOperationResultSchema =
  createReadOperationResultSchema(organizerMessageTemplateDetailSchema);
export const organizerCommunicationAudienceOptionPageOperationResultSchema =
  createReadOperationResultSchema(organizerCommunicationAudienceOptionPageSchema);
export const organizerCommunicationDraftPageOperationResultSchema =
  createReadOperationResultSchema(organizerCommunicationDraftPageSchema);
export const organizerCommunicationDraftOperationResultSchema =
  createReadOperationResultSchema(organizerCommunicationDraftProjectionSchema);
export const organizerCommunicationAuthoringPayloadOperationResultSchema =
  createEffectfulOperationResultSchema(organizerCommunicationAuthoringPayloadRefSchema);
export const organizerMessageTemplateMutationOperationResultSchema =
	createEffectfulOperationResultSchema(organizerMessageTemplateSummarySchema);
export const organizerCommunicationDraftMutationOperationResultSchema =
  createEffectfulOperationResultSchema(organizerCommunicationDraftMutationResultSchema);
export const organizerPreviewMessageBatchOperationResultSchema =
  createEffectfulOperationResultSchema(organizerPreviewMessageBatchResultSchema);
export const organizerMessageBatchPreviewDetailOperationResultSchema =
  createReadOperationResultSchema(organizerMessageBatchPreviewDetailSchema);
export const organizerMessagePreviewRecipientPageOperationResultSchema =
  createReadOperationResultSchema(organizerMessagePreviewRecipientPageSchema);
export const organizerCommunicationHistoryPageOperationResultSchema =
  createReadOperationResultSchema(organizerCommunicationHistoryPageSchema);
export const organizerCommunicationAttentionPageOperationResultSchema =
  createReadOperationResultSchema(organizerCommunicationAttentionPageSchema);
export const organizerCommunicationThreadPageOperationResultSchema =
  createReadOperationResultSchema(organizerCommunicationThreadPageSchema);
export const organizerCommunicationTimelinePageOperationResultSchema =
  createReadOperationResultSchema(organizerCommunicationTimelinePageSchema);
export const organizerEmailReadinessOperationResultSchema =
  createReadOperationResultSchema(organizerEmailReadinessProjectionSchema);
export const organizerSendMessagesOperationResultSchema =
  createEffectfulOperationResultSchema(organizerSendMessagesResultSchema);
export const organizerPrepareMessagePreviewOperationResultSchema =
  createReadOperationResultSchema(organizerPrepareMessagePreviewResultSchema);

export const ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS = Object.freeze({
  listPurposes: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.list-purposes.input',
    inputSchema: organizerCommunicationPurposeListInputSchema,
    resultKey: 'schema.communication.organizer.purpose-page.operator-result',
    resultSchema: organizerCommunicationPurposePageOperationResultSchema
  }),
  getPurpose: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.get-purpose.input',
    inputSchema: organizerCommunicationPurposeGetInputSchema,
    resultKey: 'schema.communication.organizer.purpose-detail.operator-result',
    resultSchema: organizerCommunicationPurposeDetailOperationResultSchema
  }),
  listTemplates: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.list-message-templates.input',
    inputSchema: organizerMessageTemplateListInputSchema,
    resultKey: 'schema.communication.organizer.message-template-page.operator-result',
    resultSchema: organizerMessageTemplatePageOperationResultSchema
  }),
  getTemplate: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.get-message-template.input',
    inputSchema: organizerMessageTemplateGetInputSchema,
    resultKey: 'schema.communication.organizer.message-template-detail.operator-result',
    resultSchema: organizerMessageTemplateDetailOperationResultSchema
  }),
  listAudienceOptions: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.list-audience-options.input',
    inputSchema: organizerCommunicationAudienceOptionListInputSchema,
    resultKey: 'schema.communication.organizer.audience-option-page.operator-result',
    resultSchema: organizerCommunicationAudienceOptionPageOperationResultSchema
  }),
  listDrafts: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.list-message-drafts.input',
    inputSchema: organizerCommunicationDraftListInputSchema,
    resultKey: 'schema.communication.organizer.message-draft-page.operator-result',
    resultSchema: organizerCommunicationDraftPageOperationResultSchema
  }),
  getDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.get-message-draft.input',
    inputSchema: organizerCommunicationDraftGetInputSchema,
    resultKey: 'schema.communication.organizer.message-draft.operator-result',
    resultSchema: organizerCommunicationDraftOperationResultSchema
  }),
  storeAuthoringPayload: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.store-authoring-payload.input',
    inputSchema: organizerStoreAuthoringPayloadInputSchema,
    resultKey: 'schema.communication.organizer.authoring-payload.operator-result',
    resultSchema: organizerCommunicationAuthoringPayloadOperationResultSchema
  }),
  createDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.create-message-draft.input',
    inputSchema: organizerCreateCommunicationDraftInputSchema,
    resultKey: 'schema.communication.organizer.message-draft-mutation.operator-result',
    resultSchema: organizerCommunicationDraftMutationOperationResultSchema
  }),
	createTemplate: createOperationSchemaManifestRefs({
		inputKey: 'schema.communication.organizer.create-message-template.input',
		inputSchema: organizerCreateMessageTemplateInputSchema,
		resultKey: 'schema.communication.organizer.message-template-mutation.operator-result',
		resultSchema: organizerMessageTemplateMutationOperationResultSchema
	}),
  reviseDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.revise-message-batch.input',
    inputSchema: organizerReviseCommunicationDraftInputSchema,
    resultKey: 'schema.communication.organizer.message-draft-mutation.operator-result',
    resultSchema: organizerCommunicationDraftMutationOperationResultSchema
  }),
  discardDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.discard-message-draft.input',
    inputSchema: organizerDiscardCommunicationDraftInputSchema,
    resultKey: 'schema.communication.organizer.message-draft-mutation.operator-result',
    resultSchema: organizerCommunicationDraftMutationOperationResultSchema
  }),
  previewBatch: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.preview-message-batch.input',
    inputSchema: organizerPreviewMessageBatchInputSchema,
    resultKey: 'schema.communication.organizer.message-preview-mutation.operator-result',
    resultSchema: organizerPreviewMessageBatchOperationResultSchema
  }),
  sendMessages: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.send-messages.input',
    inputSchema: organizerSendMessagesInputSchema,
    resultKey: 'schema.communication.organizer.send-messages.operator-result',
    resultSchema: organizerSendMessagesOperationResultSchema
  }),
  prepareBatchPreview: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.prepare-message-preview.input',
    inputSchema: organizerPreviewMessageBatchInputSchema,
    resultKey: 'schema.communication.organizer.prepare-message-preview.operator-result',
    resultSchema: organizerPrepareMessagePreviewOperationResultSchema
  }),
  getPreview: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.get-message-batch-preview.input',
    inputSchema: organizerMessageBatchPreviewGetInputSchema,
    resultKey: 'schema.communication.organizer.message-batch-preview-detail.operator-result',
    resultSchema: organizerMessageBatchPreviewDetailOperationResultSchema
  }),
  listPreviewRecipients: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.list-message-preview-recipients.input',
    inputSchema: organizerMessagePreviewRecipientListInputSchema,
    resultKey: 'schema.communication.organizer.message-preview-recipient-page.operator-result',
    resultSchema: organizerMessagePreviewRecipientPageOperationResultSchema
  }),
  getHistory: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.get-delivery-history.input',
    inputSchema: organizerCommunicationHistoryListInputSchema,
    resultKey: 'schema.communication.organizer.delivery-history-page.operator-result',
    resultSchema: organizerCommunicationHistoryPageOperationResultSchema
  }),
  listAttention: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.list-message-attention-items.input',
    inputSchema: organizerCommunicationAttentionListInputSchema,
    resultKey: 'schema.communication.organizer.message-attention-page.operator-result',
    resultSchema: organizerCommunicationAttentionPageOperationResultSchema
  }),
  getThread: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.get-person-thread.input',
    inputSchema: organizerCommunicationThreadGetInputSchema,
    resultKey: 'schema.communication.organizer.person-thread-page.operator-result',
    resultSchema: organizerCommunicationThreadPageOperationResultSchema
  }),
  getTimeline: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.get-delivery-timeline.input',
    inputSchema: organizerCommunicationTimelineGetInputSchema,
    resultKey: 'schema.communication.organizer.delivery-timeline-page.operator-result',
    resultSchema: organizerCommunicationTimelinePageOperationResultSchema
  }),
  getReadiness: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.organizer.get-email-readiness.input',
    inputSchema: organizerEmailReadinessGetInputSchema,
    resultKey: 'schema.communication.organizer.email-readiness.operator-result',
    resultSchema: organizerEmailReadinessOperationResultSchema
  })
});

export type OrganizerCommunicationPurposeRevisionRef = z.infer<
  typeof organizerCommunicationPurposeRevisionRefSchema
>;
export type OrganizerMessageTemplateRevisionRef = z.infer<
  typeof organizerMessageTemplateRevisionRefSchema
>;
export type OrganizerCommunicationPurposeSummary = z.infer<
  typeof organizerCommunicationPurposeSummarySchema
>;
export type OrganizerCommunicationPurposeDetail = z.infer<
  typeof organizerCommunicationPurposeDetailSchema
>;
export type OrganizerMessageTemplateSummary = z.infer<typeof organizerMessageTemplateSummarySchema>;
export type OrganizerMessageTemplateDetail = z.infer<typeof organizerMessageTemplateDetailSchema>;
export type OrganizerCommunicationAudienceDraft = z.infer<
  typeof organizerCommunicationAudienceDraftSchema
>;
export type OrganizerCommunicationAudienceOption = z.infer<
  typeof organizerCommunicationAudienceOptionSchema
>;
export type OrganizerEmailMessageContent = z.infer<typeof organizerEmailMessageContentSchema>;
export type OrganizerCommunicationAuthoringPayloadInput = z.infer<
  typeof organizerCommunicationAuthoringPayloadInputSchema
>;
export type OrganizerCommunicationAuthoringPayloadRef = z.infer<
  typeof organizerCommunicationAuthoringPayloadRefSchema
>;
export type OrganizerCommunicationDraftUninitializedAuthoring = z.infer<
  typeof organizerCommunicationDraftUninitializedAuthoringSchema
>;
export type OrganizerCommunicationDraftReadyAuthoring = z.infer<
  typeof organizerCommunicationDraftReadyAuthoringSchema
>;
export type OrganizerCommunicationDraftAuthoring = z.infer<
  typeof organizerCommunicationDraftAuthoringSchema
>;
export type OrganizerCommunicationDraftProvenance = z.infer<
  typeof organizerCommunicationDraftProvenanceSchema
>;
export type OrganizerCommunicationDraftSummary = z.infer<
  typeof organizerCommunicationDraftSummarySchema
>;
export type OrganizerCommunicationDraftProjection = z.infer<
  typeof organizerCommunicationDraftProjectionSchema
>;
export type OrganizerCommunicationDraftMutationResult = z.infer<
  typeof organizerCommunicationDraftMutationResultSchema
>;
export type OrganizerMessagePreviewIdentity = z.infer<typeof organizerMessagePreviewIdentitySchema>;
export type OrganizerMessagePreviewSummary = z.infer<typeof organizerMessagePreviewSummarySchema>;
export type OrganizerMessagePreviewRecipientRow = z.infer<
  typeof organizerMessagePreviewRecipientRowSchema
>;
export type OrganizerMessageBatchPreviewDetail = z.infer<
  typeof organizerMessageBatchPreviewDetailSchema
>;
export type OrganizerEmailReadinessProjection = z.infer<
  typeof organizerEmailReadinessProjectionSchema
>;
export type OrganizerCommunicationHistoryItem = z.infer<
  typeof organizerCommunicationHistoryItemSchema
>;
export type OrganizerCommunicationAttentionItem = z.infer<
  typeof organizerCommunicationAttentionItemSchema
>;
export type OrganizerCommunicationThreadPage = z.infer<
  typeof organizerCommunicationThreadPageSchema
>;
export type OrganizerCommunicationTimelinePage = z.infer<
  typeof organizerCommunicationTimelinePageSchema
>;
export type OrganizerCommunicationHistoryPage = z.infer<
  typeof organizerCommunicationHistoryPageSchema
>;
export type OrganizerSendMessagesInput = z.infer<typeof organizerSendMessagesInputSchema>;
export type OrganizerSendMessagesResult = z.infer<typeof organizerSendMessagesResultSchema>;
export type OrganizerPrepareMessagePreviewResult = z.infer<
  typeof organizerPrepareMessagePreviewResultSchema
>;
