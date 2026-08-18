import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema
} from './operations';

const APPLICATION_UUID_INPUT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLICATION_UUID_CANONICAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

const canonicalInstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith('Z') && value.includes('.'),
  'instant must use canonical UTC millisecond form'
);

function canonicalLine(maximum: number) {
  return z.string().max(maximum).transform((value) =>
    value.normalize('NFC').trim().replace(/\s+/gu, ' ')
  );
}

function canonicalLongText(maximum: number) {
  return z.string().max(maximum).transform((value) =>
    value.normalize('NFC').trim().replace(/\r\n?/gu, '\n')
  );
}

export const speakerProfileIdInputSchema = z.string()
  .regex(APPLICATION_UUID_INPUT)
  .overwrite((value) => value.toLowerCase());
export const speakerProfileIdSchema = z.string().regex(APPLICATION_UUID_CANONICAL);
export const speakerProfileVersionSchema = z.number().int().positive().safe();
export const speakerProfileDigestSchema = z.string().regex(DIGEST);
export const speakerProfileScopeSchema = z.strictObject({
  workspaceId: speakerProfileIdSchema,
  eventId: speakerProfileIdSchema
});
export const speakerProfileFieldKeySchema = z.enum([
  'headline', 'biography', 'location', 'links'
]);
export const speakerProfileReviewPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: speakerProfileIdSchema,
  eventId: speakerProfileIdSchema,
  eventVersion: speakerProfileVersionSchema,
  reviewRequired: z.boolean()
});
export const speakerProfileLinkKindSchema = z.enum([
  'x', 'linkedin', 'github', 'website', 'other'
]);
export const speakerProfileLinkSchema = z.strictObject({
  kind: speakerProfileLinkKindSchema,
  label: canonicalLine(120).pipe(z.string().min(1).max(120)),
  href: z.url().refine((value) => new URL(value).protocol === 'https:', 'profile links must use HTTPS')
});
export const speakerProfileLinksSchema = z.array(speakerProfileLinkSchema).max(12)
  .superRefine((links, context) => {
    const identities = new Set<string>();
    for (const [index, link] of links.entries()) {
      const identity = `${link.kind}:${link.href}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom', path: [index], message: 'profile links must be unique by kind and address'
        });
      }
      identities.add(identity);
    }
  });

const fieldBase = {
  revision: speakerProfileVersionSchema,
  digestSha256: speakerProfileDigestSchema
} as const;

export const speakerProfileTextFieldSchema = z.strictObject({
  ...fieldBase,
  value: z.string()
});
export const speakerProfileLinksFieldSchema = z.strictObject({
  ...fieldBase,
  value: speakerProfileLinksSchema
});

export const speakerProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: speakerProfileIdSchema,
  personId: speakerProfileIdSchema,
  version: speakerProfileVersionSchema,
  headline: speakerProfileTextFieldSchema,
  biography: speakerProfileTextFieldSchema,
  location: speakerProfileTextFieldSchema,
  links: speakerProfileLinksFieldSchema,
  updatedAt: canonicalInstantSchema
});

export const speakerProfileApprovalActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('user'),
    userId: speakerProfileIdSchema
  }),
  z.strictObject({
    kind: z.literal('policy'),
    policyKey: z.literal('profile_content_review'),
    policyVersion: z.literal(1),
    initiatedByUserId: speakerProfileIdSchema.nullable()
  })
]);

export const speakerProfileApprovalSchema = z.strictObject({
  id: speakerProfileIdSchema,
  workspaceId: speakerProfileIdSchema,
  eventId: speakerProfileIdSchema,
  personId: speakerProfileIdSchema,
  field: speakerProfileFieldKeySchema,
  fieldRevision: speakerProfileVersionSchema,
  fieldDigestSha256: speakerProfileDigestSchema,
  actor: speakerProfileApprovalActorSchema,
  approvedAt: canonicalInstantSchema
});

export const speakerProfileViewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: speakerProfileIdSchema,
  eventId: speakerProfileIdSchema,
  personId: speakerProfileIdSchema,
  reviewPolicy: speakerProfileReviewPolicySchema,
  profile: speakerProfileSchema.nullable(),
  approvals: z.array(speakerProfileApprovalSchema).max(4)
}).superRefine((view, context) => {
  if (view.reviewPolicy.workspaceId !== view.workspaceId
      || view.reviewPolicy.eventId !== view.eventId) {
    context.addIssue({
      code: 'custom', path: ['reviewPolicy'],
      message: 'profile review policy must match the view scope'
    });
  }
  const fields = new Set<string>();
  for (const [index, approval] of view.approvals.entries()) {
    if (approval.workspaceId !== view.workspaceId
        || approval.eventId !== view.eventId
        || approval.personId !== view.personId
        || fields.has(approval.field)) {
      context.addIssue({
        code: 'custom', path: ['approvals', index],
        message: 'current profile approvals must be unique and match the view scope'
      });
    }
    fields.add(approval.field);
  }
});

export const speakerProfileReadInputSchema = z.strictObject({
  personId: speakerProfileIdInputSchema
});

export const speakerProfileUpdateInputSchema = z.strictObject({
  personId: speakerProfileIdInputSchema,
  expectedProfileVersion: speakerProfileVersionSchema.nullable(),
  patch: z.strictObject({
    headline: canonicalLine(300).optional(),
    biography: canonicalLongText(8_000).optional(),
    location: canonicalLine(300).optional(),
    links: speakerProfileLinksSchema.optional()
  }).refine((patch) => Object.keys(patch).length > 0, 'profile update must name at least one field')
});

export const speakerProfileApproveInputSchema = z.strictObject({
  personId: speakerProfileIdInputSchema,
  expectedProfileVersion: speakerProfileVersionSchema,
  fields: z.array(speakerProfileFieldKeySchema).min(1).max(4)
    .refine((fields) => new Set(fields).size === fields.length, 'approval fields must be unique')
});

export const speakerProfileReviewPolicyUpdateInputSchema = z.strictObject({
  expectedEventVersion: speakerProfileVersionSchema,
  reviewRequired: z.boolean()
});

export const speakerProfilePolicyApprovalCandidateSchema = z.strictObject({
  personId: speakerProfileIdSchema,
  field: speakerProfileFieldKeySchema,
  fieldRevision: speakerProfileVersionSchema,
  fieldDigestSha256: speakerProfileDigestSchema
});

export const speakerProfileReviewQueueEntrySchema = z.strictObject({
	personId: speakerProfileIdSchema,
	profileVersion: speakerProfileVersionSchema,
	presentFields: z.array(speakerProfileFieldKeySchema).max(4)
		.refine((fields) => new Set(fields).size === fields.length, 'present fields must be unique'),
	approvedFields: z.array(speakerProfileFieldKeySchema).max(4)
		.refine((fields) => new Set(fields).size === fields.length, 'approved fields must be unique')
}).superRefine((entry, context) => {
	const present = new Set(entry.presentFields);
	for (const [index, field] of entry.approvedFields.entries()) {
		if (!present.has(field)) {
			context.addIssue({
				code: 'custom', path: ['approvedFields', index],
				message: 'approved fields must be present'
			});
		}
	}
});

export const speakerProfileReviewQueueSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policy: speakerProfileReviewPolicySchema,
  profiles: z.array(speakerProfileReviewQueueEntrySchema).max(10_000)
}).superRefine((queue, context) => {
  const people = new Set<string>();
  for (const [index, profile] of queue.profiles.entries()) {
    if (people.has(profile.personId)) {
      context.addIssue({
        code: 'custom', path: ['profiles', index],
        message: 'review queue profiles must name unique people'
      });
    }
    people.add(profile.personId);
  }
});

export const speakerProfileUpdatePlanningInputSchema = z.strictObject({
  scope: speakerProfileScopeSchema,
  actorUserId: speakerProfileIdSchema,
  occurredAt: canonicalInstantSchema,
  autoApprovalIds: z.tuple([
    speakerProfileIdSchema,
    speakerProfileIdSchema,
    speakerProfileIdSchema,
    speakerProfileIdSchema
  ]),
  authorInput: speakerProfileUpdateInputSchema
});
export const speakerProfileApprovePlanningInputSchema = z.strictObject({
  scope: speakerProfileScopeSchema,
  actorUserId: speakerProfileIdSchema,
  occurredAt: canonicalInstantSchema,
  approvalIds: z.array(speakerProfileIdSchema).min(1).max(4),
  authorInput: speakerProfileApproveInputSchema
}).superRefine((input, context) => {
  if (input.approvalIds.length !== input.authorInput.fields.length
      || new Set(input.approvalIds).size !== input.approvalIds.length) {
    context.addIssue({ code: 'custom', path: ['approvalIds'], message: 'approval ids map one-to-one to fields' });
  }
});
export const speakerProfileReviewPolicyUpdatePlanningInputSchema = z.strictObject({
  scope: speakerProfileScopeSchema,
  actorUserId: speakerProfileIdSchema,
  occurredAt: canonicalInstantSchema,
  approvalIds: z.array(speakerProfileIdSchema).max(40_000),
  authorInput: speakerProfileReviewPolicyUpdateInputSchema
});

export const speakerProfileUpdatePlanSchema = z.strictObject({
  input: speakerProfileUpdatePlanningInputSchema,
  before: speakerProfileViewSchema,
  after: speakerProfileViewSchema,
  changedFields: z.array(speakerProfileFieldKeySchema).min(1).max(4),
  insertedApprovals: z.array(speakerProfileApprovalSchema).max(4)
}).superRefine((plan, context) => {
  const expected = plan.input.authorInput.expectedProfileVersion;
  const beforeVersion = plan.before.profile?.version ?? null;
  if (plan.before.workspaceId !== plan.input.scope.workspaceId
      || plan.before.eventId !== plan.input.scope.eventId
      || plan.before.personId !== plan.input.authorInput.personId
      || plan.after.workspaceId !== plan.before.workspaceId
      || plan.after.eventId !== plan.before.eventId
      || plan.after.personId !== plan.before.personId
      || beforeVersion !== expected
      || plan.after.profile === null
      || plan.after.profile.version !== (beforeVersion ?? 0) + 1
      || new Set(plan.changedFields).size !== plan.changedFields.length
      || (plan.before.reviewPolicy.reviewRequired && plan.insertedApprovals.length !== 0)
      || (!plan.before.reviewPolicy.reviewRequired
        && plan.insertedApprovals.length !== plan.changedFields.length)) {
    context.addIssue({ code: 'custom', message: 'profile update plan scope and versions are inconsistent' });
  }
});

export const speakerProfileApprovePlanSchema = z.strictObject({
  input: speakerProfileApprovePlanningInputSchema,
  before: speakerProfileViewSchema,
  after: speakerProfileViewSchema,
  inserted: z.array(speakerProfileApprovalSchema).min(1).max(4)
}).superRefine((plan, context) => {
  if (plan.before.workspaceId !== plan.input.scope.workspaceId
      || plan.before.eventId !== plan.input.scope.eventId
      || plan.before.personId !== plan.input.authorInput.personId
      || plan.before.profile === null
      || plan.before.profile.version !== plan.input.authorInput.expectedProfileVersion
      || plan.after.profile?.version !== plan.before.profile.version
      || plan.inserted.length !== plan.input.authorInput.fields.length
      || plan.after.approvals.length < plan.inserted.length) {
    context.addIssue({ code: 'custom', message: 'profile approval plan scope and versions are inconsistent' });
  }
});

export const speakerProfileReviewPolicyUpdatePlanSchema = z.strictObject({
  input: speakerProfileReviewPolicyUpdatePlanningInputSchema,
  before: speakerProfileReviewPolicySchema,
  after: speakerProfileReviewPolicySchema,
  insertedApprovals: z.array(speakerProfileApprovalSchema).max(40_000)
}).superRefine((plan, context) => {
  if (plan.before.workspaceId !== plan.input.scope.workspaceId
      || plan.before.eventId !== plan.input.scope.eventId
      || plan.before.eventVersion !== plan.input.authorInput.expectedEventVersion
      || plan.after.workspaceId !== plan.before.workspaceId
      || plan.after.eventId !== plan.before.eventId
      || plan.after.eventVersion !== plan.before.eventVersion + 1
      || plan.after.reviewRequired !== plan.input.authorInput.reviewRequired
      || (plan.after.reviewRequired && plan.insertedApprovals.length !== 0)) {
    context.addIssue({
      code: 'custom',
      message: 'profile review policy plan scope, version, and evidence are inconsistent'
    });
  }
});

export const speakerProfileReadResultSchema = createReadOperationResultSchema(speakerProfileViewSchema);
export const speakerProfileReviewQueueReadInputSchema = z.strictObject({});
export const speakerProfileReviewQueueReadResultSchema =
  createReadOperationResultSchema(speakerProfileReviewQueueSchema);
export const speakerProfileUpdateResultSchema = createEffectfulOperationResultSchema(speakerProfileViewSchema);
export const speakerProfileApproveResultSchema = createEffectfulOperationResultSchema(speakerProfileViewSchema);
export const speakerProfileReviewPolicyUpdateResultSchema =
  createEffectfulOperationResultSchema(speakerProfileReviewPolicySchema);

export const SPEAKER_PROFILE_OPERATION_SCHEMA_REFS = Object.freeze({
  read: createOperationSchemaManifestRefs({
    inputKey: 'schema.speaker.profile-read.input',
    inputSchema: speakerProfileReadInputSchema,
    resultKey: 'schema.speaker.profile-read.operator-result',
    resultSchema: speakerProfileReadResultSchema
  }),
  reviewQueueRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.speaker.profile-review-queue-read.input',
    inputSchema: speakerProfileReviewQueueReadInputSchema,
    resultKey: 'schema.speaker.profile-review-queue-read.operator-result',
    resultSchema: speakerProfileReviewQueueReadResultSchema
  }),
  update: createOperationSchemaManifestRefs({
    inputKey: 'schema.speaker.profile-update.input',
    inputSchema: speakerProfileUpdateInputSchema,
    resultKey: 'schema.speaker.profile-update.operator-result',
    resultSchema: speakerProfileUpdateResultSchema
  }),
  approve: createOperationSchemaManifestRefs({
    inputKey: 'schema.speaker.profile-approve.input',
    inputSchema: speakerProfileApproveInputSchema,
    resultKey: 'schema.speaker.profile-approve.operator-result',
    resultSchema: speakerProfileApproveResultSchema
  }),
  reviewPolicyUpdate: createOperationSchemaManifestRefs({
    inputKey: 'schema.speaker.profile-review-policy-update.input',
    inputSchema: speakerProfileReviewPolicyUpdateInputSchema,
    resultKey: 'schema.speaker.profile-review-policy-update.operator-result',
    resultSchema: speakerProfileReviewPolicyUpdateResultSchema
  })
});

export type SpeakerProfileFieldKey = z.infer<typeof speakerProfileFieldKeySchema>;
export type SpeakerProfileLinkDto = z.infer<typeof speakerProfileLinkSchema>;
export type SpeakerProfileDto = z.infer<typeof speakerProfileSchema>;
export type SpeakerProfileApprovalDto = z.infer<typeof speakerProfileApprovalSchema>;
export type SpeakerProfileApprovalActorDto = z.infer<typeof speakerProfileApprovalActorSchema>;
export type SpeakerProfileReviewPolicyDto = z.infer<typeof speakerProfileReviewPolicySchema>;
export type SpeakerProfileReviewQueueEntryDto = z.infer<
  typeof speakerProfileReviewQueueEntrySchema
>;
export type SpeakerProfileReviewQueueDto = z.infer<typeof speakerProfileReviewQueueSchema>;
export type SpeakerProfileViewDto = z.infer<typeof speakerProfileViewSchema>;
export type SpeakerProfileReadInput = z.infer<typeof speakerProfileReadInputSchema>;
export type SpeakerProfileUpdateInput = z.infer<typeof speakerProfileUpdateInputSchema>;
export type SpeakerProfileApproveInput = z.infer<typeof speakerProfileApproveInputSchema>;
export type SpeakerProfileReviewPolicyUpdateInput = z.infer<
  typeof speakerProfileReviewPolicyUpdateInputSchema
>;
export type SpeakerProfilePolicyApprovalCandidateDto = z.infer<
  typeof speakerProfilePolicyApprovalCandidateSchema
>;
export type SpeakerProfileScopeDto = z.infer<typeof speakerProfileScopeSchema>;
export type SpeakerProfileUpdatePlanningInput = z.infer<typeof speakerProfileUpdatePlanningInputSchema>;
export type SpeakerProfileApprovePlanningInput = z.infer<typeof speakerProfileApprovePlanningInputSchema>;
export type SpeakerProfileReviewPolicyUpdatePlanningInput = z.infer<
  typeof speakerProfileReviewPolicyUpdatePlanningInputSchema
>;
export type SpeakerProfileUpdatePlanDto = z.infer<typeof speakerProfileUpdatePlanSchema>;
export type SpeakerProfileApprovePlanDto = z.infer<typeof speakerProfileApprovePlanSchema>;
export type SpeakerProfileReviewPolicyUpdatePlanDto = z.infer<
  typeof speakerProfileReviewPolicyUpdatePlanSchema
>;
