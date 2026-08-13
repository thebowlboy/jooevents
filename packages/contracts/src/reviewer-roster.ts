import { z } from 'zod';
import {
  reviewIdSchema,
  reviewInstantSchema,
  reviewScopeRefSchema,
  reviewScopeSchema,
  reviewSha256Schema,
  reviewVersionSchema
} from './reviews';
import {
  createEffectfulOperationResultSchema,
  createReadOperationResultSchema,
  structuredOutcomeSchema
} from './operations';

export const REVIEWER_CAPABILITY_IDS = Object.freeze([
  'event.read',
  'speaker.directory.read',
  'submission.read',
  'submission.score',
  'submission.comment',
  'schedule.read'
] as const);

export const reviewerCapabilityIdSchema = z.enum(REVIEWER_CAPABILITY_IDS);
export const reviewerRosterScopeSchema = reviewScopeSchema;
export const reviewerScopeRefSchema = reviewScopeRefSchema;

export const reviewerAuthoritySubjectRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('access_reservation'),
    id: reviewIdSchema,
    version: reviewVersionSchema
  }),
  z.strictObject({
    kind: z.literal('workspace_membership'),
    id: reviewIdSchema,
    version: reviewVersionSchema
  })
]);

const canonicalEvidenceIdsSchema = z.array(
  z.string().min(1).max(300).refine((value) => value.trim() === value)
).min(1).max(100).superRefine((values, context) => {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index - 1] as string) >= (values[index] as string)) {
      context.addIssue({
        code: 'custom',
        path: [index],
        message: 'Evidence ids must use unique canonical order.'
      });
    }
  }
});

const eligibleAuthorityFactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewerRosterScopeSchema,
  rosterSubject: reviewerAuthoritySubjectRefSchema,
  currentSubject: reviewerAuthoritySubjectRefSchema,
  state: z.enum(['reserved', 'active']),
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema,
  capabilityIds: z.tuple([
    z.literal('event.read'),
    z.literal('speaker.directory.read'),
    z.literal('submission.read'),
    z.literal('submission.score'),
    z.literal('submission.comment'),
    z.literal('schedule.read')
  ]),
  evidenceIds: canonicalEvidenceIdsSchema,
  displayName: z.string().trim().min(1).max(160).optional()
}).superRefine((fact, context) => {
  if (fact.state === 'reserved' && fact.rosterSubject.kind !== 'access_reservation') {
    context.addIssue({
      code: 'custom',
      path: ['rosterSubject'],
      message: 'Reserved reviewer authority must originate from an access reservation.'
    });
  }
  if (fact.state === 'reserved' && (
    fact.currentSubject.kind !== fact.rosterSubject.kind
    || fact.currentSubject.id !== fact.rosterSubject.id
  )) {
    context.addIssue({
      code: 'custom',
      path: ['currentSubject'],
      message: 'Reserved reviewer authority must still reference the originating reservation.'
    });
  }
  if (fact.state === 'active' && fact.currentSubject.kind !== 'workspace_membership') {
    context.addIssue({
      code: 'custom',
      path: ['currentSubject'],
      message: 'Active reviewer authority must resolve to a workspace membership.'
    });
  }
});

const unavailableAuthorityFactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewerRosterScopeSchema,
  rosterSubject: reviewerAuthoritySubjectRefSchema,
  currentSubject: reviewerAuthoritySubjectRefSchema.optional(),
  state: z.literal('unavailable'),
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema,
  capabilityIds: z.tuple([]),
  evidenceIds: canonicalEvidenceIdsSchema,
  displayName: z.string().trim().min(1).max(160).optional()
});

/**
 * Current, source-neutral proof that the exact access subject has the complete
 * reviewer capability set. Role names and email addresses are intentionally absent.
 */
export const reviewerEligibilityFactSchema = z.discriminatedUnion('state', [
  eligibleAuthorityFactSchema,
  unavailableAuthorityFactSchema
]);

export const reviewerAuthoritySetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewerRosterScopeSchema,
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema,
  facts: z.array(reviewerEligibilityFactSchema).max(10_000)
}).superRefine((set, context) => {
  for (const [index, fact] of set.facts.entries()) {
    if (!sameScope(set.scope, fact.scope)) {
      context.addIssue({
        code: 'custom',
        path: ['facts', index, 'scope'],
        message: 'Authority fact scope must match the authority set scope.'
      });
    }
    const previous = set.facts[index - 1];
    if (previous && compareAuthoritySubject(previous.rosterSubject, fact.rosterSubject) >= 0) {
      context.addIssue({
        code: 'custom',
        path: ['facts', index, 'rosterSubject'],
        message: 'Authority facts must use unique canonical roster-subject order.'
      });
    }
  }
});

export const reviewerScopeRefsSchema = z.array(reviewerScopeRefSchema).max(100)
  .superRefine((refs, context) => {
    for (let index = 1; index < refs.length; index += 1) {
      if (compareScopeRef(refs[index - 1]!, refs[index]!) >= 0) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Reviewer scope refs must use unique canonical kind/id order.'
        });
      }
    }
  });

const reviewerRecordBase = {
  schemaVersion: z.literal(1),
  scope: reviewerRosterScopeSchema,
  reviewerId: reviewIdSchema,
  version: reviewVersionSchema,
  accessSubject: reviewerAuthoritySubjectRefSchema,
  reviews: reviewerScopeRefsSchema,
  addedByUserId: reviewIdSchema,
  addedAt: reviewInstantSchema
} as const;

export const reviewerRosterRecordSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...reviewerRecordBase, state: z.literal('included') }),
  z.strictObject({
    ...reviewerRecordBase,
    state: z.literal('revoked'),
    revokedByUserId: reviewIdSchema,
    revokedAt: reviewInstantSchema
  })
]);

export const reviewerRosterStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewerRosterScopeSchema,
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema,
  reviewers: z.array(reviewerRosterRecordSchema).max(10_000)
}).superRefine((state, context) => {
  for (const [index, reviewer] of state.reviewers.entries()) {
    if (!sameScope(state.scope, reviewer.scope)) {
      context.addIssue({
        code: 'custom',
        path: ['reviewers', index, 'scope'],
        message: 'Reviewer scope must match the roster scope.'
      });
    }
    const previous = state.reviewers[index - 1];
    if (previous && previous.reviewerId >= reviewer.reviewerId) {
      context.addIssue({
        code: 'custom',
        path: ['reviewers', index, 'reviewerId'],
        message: 'Reviewers must use unique canonical id order.'
      });
    }
  }
});

export const reviewerScopeTargetFactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewerRosterScopeSchema,
  ref: reviewerScopeRefSchema,
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema,
  assignability: z.enum(['assignable', 'retained_only'])
});

export const reviewerScopeTargetSetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewerRosterScopeSchema,
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema,
  targets: z.array(reviewerScopeTargetFactSchema).max(50_000)
}).superRefine((set, context) => {
  for (const [index, target] of set.targets.entries()) {
    if (!sameScope(set.scope, target.scope)) {
      context.addIssue({
        code: 'custom',
        path: ['targets', index, 'scope'],
        message: 'Target scope must match the target set scope.'
      });
    }
    const previous = set.targets[index - 1];
    if (previous && compareScopeRef(previous.ref, target.ref) >= 0) {
      context.addIssue({
        code: 'custom',
        path: ['targets', index, 'ref'],
        message: 'Scope targets must use unique canonical ref order.'
      });
    }
  }
});

export const reviewerRosterMemberProjectionSchema = z.strictObject({
  reviewerId: reviewIdSchema,
  recordVersion: reviewVersionSchema,
  projectionVersion: reviewVersionSchema,
  status: z.enum(['invited', 'active', 'revoked']),
  accessSubject: reviewerAuthoritySubjectRefSchema,
  authority: reviewerEligibilityFactSchema,
  displayName: z.string().trim().min(1).max(160).optional(),
  reviews: reviewerScopeRefsSchema
});

export const reviewerRosterSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewerRosterScopeSchema,
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema,
  rosterVersion: reviewVersionSchema,
  rosterDigestSha256: reviewSha256Schema,
  authorityVersion: reviewVersionSchema,
  authorityDigestSha256: reviewSha256Schema,
  reviewers: z.array(reviewerRosterMemberProjectionSchema).max(10_000)
});

const expectedRosterFields = {
  expectedRosterVersion: reviewVersionSchema,
  expectedRosterDigestSha256: reviewSha256Schema
} as const;

export const reviewerRosterMutationInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('register'),
    scope: reviewerRosterScopeSchema,
    reviewerId: reviewIdSchema,
    accessSubject: reviewerAuthoritySubjectRefSchema,
    reviews: reviewerScopeRefsSchema,
    ...expectedRosterFields
  }),
  z.strictObject({
    action: z.literal('set_scope'),
    scope: reviewerRosterScopeSchema,
    reviewerId: reviewIdSchema,
    expectedReviewerVersion: reviewVersionSchema,
    reviews: reviewerScopeRefsSchema,
    ...expectedRosterFields
  }),
  z.strictObject({
    action: z.literal('revoke'),
    scope: reviewerRosterScopeSchema,
    reviewerId: reviewIdSchema,
    expectedReviewerVersion: reviewVersionSchema,
    ...expectedRosterFields
  }),
  z.strictObject({
    action: z.literal('restore'),
    scope: reviewerRosterScopeSchema,
    reviewerId: reviewIdSchema,
    expectedReviewerVersion: reviewVersionSchema,
    ...expectedRosterFields
  })
]);

export const reviewerRosterGuardSchema = z.strictObject({
  id: z.string().min(1).max(512).refine((value) => value.trim() === value),
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema
});

export const reviewerRosterMutationPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(['register', 'set_scope', 'revoke', 'restore']),
  input: reviewerRosterMutationInputSchema,
  roster: z.strictObject({
    beforeVersion: reviewVersionSchema,
    beforeDigestSha256: reviewSha256Schema,
    afterVersion: reviewVersionSchema,
    afterDigestSha256: reviewSha256Schema
  }),
  authoritySetGuard: reviewerRosterGuardSchema,
  authorityFactGuard: reviewerRosterGuardSchema,
  targetSetGuard: reviewerRosterGuardSchema,
  targetGuards: z.array(reviewerRosterGuardSchema).max(200),
  before: reviewerRosterRecordSchema.nullable(),
  after: reviewerRosterRecordSchema
}).superRefine((plan, context) => {
  if (plan.action !== plan.input.action) {
    context.addIssue({ code: 'custom', path: ['input', 'action'], message: 'Plan action mismatch.' });
  }
  if (!sameScope(plan.input.scope, plan.after.scope)
      || (plan.before !== null && !sameScope(plan.input.scope, plan.before.scope))) {
    context.addIssue({ code: 'custom', message: 'Plan record scope must match the input scope.' });
  }
  if (plan.input.reviewerId !== plan.after.reviewerId
      || (plan.before !== null && plan.input.reviewerId !== plan.before.reviewerId)) {
    context.addIssue({ code: 'custom', message: 'Plan reviewer ids must agree.' });
  }
});

const safeRecordSchema = z.strictObject({
  reviewerId: reviewIdSchema,
  status: z.enum(['included', 'revoked']),
  reviews: reviewerScopeRefsSchema,
  accessSubjectKind: z.enum(['access_reservation', 'workspace_membership'])
});

export const reviewerRosterSafeDiffSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(['register', 'set_scope', 'revoke', 'restore']),
  reviewerId: reviewIdSchema,
  before: safeRecordSchema.nullable(),
  after: safeRecordSchema
});

export const reviewerRosterMutationResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(['register', 'set_scope', 'revoke', 'restore']),
  rosterVersion: reviewVersionSchema,
  rosterDigestSha256: reviewSha256Schema,
  reviewer: reviewerRosterRecordSchema
});

export const reviewerRosterSnapshotReadInputSchema = z.strictObject({});
export const reviewerRosterSnapshotCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: reviewerRosterSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const reviewerRosterSnapshotReadResultSchema =
  createReadOperationResultSchema(reviewerRosterSnapshotSchema);

export const reviewerRosterChangeDraftInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('register'), reviewerId: reviewIdSchema,
    accessSubject: reviewerAuthoritySubjectRefSchema, reviews: reviewerScopeRefsSchema,
    ...expectedRosterFields
  }),
  z.strictObject({
    action: z.literal('set_scope'), reviewerId: reviewIdSchema,
    expectedReviewerVersion: reviewVersionSchema, reviews: reviewerScopeRefsSchema,
    ...expectedRosterFields
  }),
  z.strictObject({
    action: z.literal('revoke'), reviewerId: reviewIdSchema,
    expectedReviewerVersion: reviewVersionSchema,
    ...expectedRosterFields
  }),
  z.strictObject({
    action: z.literal('restore'), reviewerId: reviewIdSchema,
    expectedReviewerVersion: reviewVersionSchema,
    ...expectedRosterFields
  })
]);
export const reviewerRosterChangeDraftDataSchema = z.strictObject({
  changesetId: reviewIdSchema,
  revision: z.strictObject({ id: reviewIdSchema, digestSha256: reviewSha256Schema }),
  action: z.enum(['register', 'set_scope', 'revoke', 'restore']),
  reviewerId: reviewIdSchema
});
export const reviewerRosterChangeDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: reviewerRosterChangeDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const reviewerRosterChangeDraftOperationResultSchema =
  createEffectfulOperationResultSchema(reviewerRosterChangeDraftDataSchema);

export type ReviewerCapabilityId = z.infer<typeof reviewerCapabilityIdSchema>;
export type ReviewerRosterScopeDto = z.infer<typeof reviewerRosterScopeSchema>;
export type ReviewerScopeRefDto = z.infer<typeof reviewerScopeRefSchema>;
export type ReviewerAuthoritySubjectRefDto = z.infer<typeof reviewerAuthoritySubjectRefSchema>;
export type ReviewerEligibilityFactDto = z.infer<typeof reviewerEligibilityFactSchema>;
export type ReviewerAuthoritySetDto = z.infer<typeof reviewerAuthoritySetSchema>;
export type ReviewerRosterRecordDto = z.infer<typeof reviewerRosterRecordSchema>;
export type ReviewerRosterStateDto = z.infer<typeof reviewerRosterStateSchema>;
export type ReviewerScopeTargetFactDto = z.infer<typeof reviewerScopeTargetFactSchema>;
export type ReviewerScopeTargetSetDto = z.infer<typeof reviewerScopeTargetSetSchema>;
export type ReviewerRosterMemberProjectionDto = z.infer<typeof reviewerRosterMemberProjectionSchema>;
export type ReviewerRosterSnapshotDto = z.infer<typeof reviewerRosterSnapshotSchema>;
export type ReviewerRosterMutationInput = z.infer<typeof reviewerRosterMutationInputSchema>;
export type ReviewerRosterGuardDto = z.infer<typeof reviewerRosterGuardSchema>;
export type ReviewerRosterMutationPlanDto = z.infer<typeof reviewerRosterMutationPlanSchema>;
export type ReviewerRosterSafeDiff = z.infer<typeof reviewerRosterSafeDiffSchema>;
export type ReviewerRosterMutationResult = z.infer<typeof reviewerRosterMutationResultSchema>;
export type ReviewerRosterChangeDraftData = z.infer<typeof reviewerRosterChangeDraftDataSchema>;

export function compareScopeRef(
  left: ReviewerScopeRefDto,
  right: ReviewerScopeRefDto
): number {
  const order = { track: 0, format: 1, session: 2 } as const;
  if (order[left.kind] !== order[right.kind]) return order[left.kind] - order[right.kind];
  return compareText(left.id, right.id);
}

export function compareAuthoritySubject(
  left: ReviewerAuthoritySubjectRefDto,
  right: ReviewerAuthoritySubjectRefDto
): number {
  if (left.kind !== right.kind) return compareText(left.kind, right.kind);
  return compareText(left.id, right.id);
}

function sameScope(
  left: ReviewerRosterScopeDto,
  right: ReviewerRosterScopeDto
): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
