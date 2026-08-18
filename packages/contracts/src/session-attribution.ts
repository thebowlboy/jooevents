import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  structuredOutcomeSchema
} from './operations';
import { submissionSessionOriginSchema } from './decisions';
import {
  engagementRosterInvitePlanSchema,
  engagementSeedPlanSchema,
  engagementSeedReversalPlanSchema
} from './engagements';
import {
  sessionHeadSchema,
  sessionIdInputSchema,
  sessionMutationPlanSchema,
  sessionRosterSourceRefSchema,
  sessionScopeSchema,
  sessionRestorePlanSchema,
  sessionVersionSchema
} from './sessions';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const routeGuardFields = {
  expectedCatalogVersion: sessionVersionSchema,
  expectedCatalogDigestSha256: digestSchema,
  expectedSessionVersion: sessionVersionSchema,
  expectedSessionDigestSha256: digestSchema
} as const;

/**
 * One durable reason a person belongs on a Session roster. Submission support
 * follows the Submission's one current origin; editorial support preserves the
 * exact non-Submission source that an organizer-authored membership carries.
 */
export const sessionParticipantSupportSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    schemaVersion: z.literal(1),
    scope: sessionScopeSchema,
    sessionId: sessionIdInputSchema,
    personId: sessionIdInputSchema,
    kind: z.literal('submission'),
    submissionId: sessionIdInputSchema
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    scope: sessionScopeSchema,
    sessionId: sessionIdInputSchema,
    personId: sessionIdInputSchema,
    kind: z.literal('editorial'),
    source: sessionRosterSourceRefSchema.refine(
      (source) => source.kind !== 'submission',
      'editorial support cannot impersonate a Submission'
    )
  })
]);

export const sessionParticipantSupportChangePlanSchema = z.strictObject({
  remove: z.array(sessionParticipantSupportSchema).max(1_000),
  insert: z.array(sessionParticipantSupportSchema).max(1_000)
}).superRefine((plan, context) => {
  const key = (row: z.infer<typeof sessionParticipantSupportSchema>) => JSON.stringify(row);
  const removed = new Set<string>();
  const inserted = new Set<string>();
  for (const [index, row] of plan.remove.entries()) {
    const value = key(row);
    if (removed.has(value)) context.addIssue({ code: 'custom', path: ['remove', index], message: 'support removals must be unique' });
    removed.add(value);
  }
  for (const [index, row] of plan.insert.entries()) {
    const value = key(row);
    if (inserted.has(value)) context.addIssue({ code: 'custom', path: ['insert', index], message: 'support inserts must be unique' });
    if (removed.has(value)) context.addIssue({ code: 'custom', path: ['insert', index], message: 'one plan cannot remove and insert the same support' });
    inserted.add(value);
  }
});

/** Atomic Session + Engagement plan for adding one already-known person. */
export const sessionParticipantAddExistingPlanSchema = z.strictObject({
  sessionPlan: sessionMutationPlanSchema.refine(
    (plan) => plan.input.action === 'roster_append' && plan.input.participants.length === 1,
    'an existing-person addition carries one roster append'
  ),
  engagementInvite: engagementRosterInvitePlanSchema,
  support: sessionParticipantSupportSchema.refine(
    (support) => support.kind === 'editorial',
    'an existing-person addition carries editorial support'
  ),
  supportChanges: sessionParticipantSupportChangePlanSchema
}).superRefine((plan, context) => {
  const input = plan.sessionPlan.input;
  if (input.action !== 'roster_append') return;
  const participant = input.participants[0];
  if (!participant
      || input.scope.workspaceId !== plan.engagementInvite.input.scope.workspaceId
      || input.scope.eventId !== plan.engagementInvite.input.scope.eventId
      || input.sessionId !== plan.engagementInvite.input.sessionId
      || participant.personId !== plan.engagementInvite.input.personId
      || plan.support.kind !== 'editorial'
      || plan.support.scope.workspaceId !== input.scope.workspaceId
      || plan.support.scope.eventId !== input.scope.eventId
      || plan.support.sessionId !== input.sessionId
      || plan.support.personId !== participant.personId
      || plan.support.source.kind !== participant.source.kind
      || plan.support.source.id !== participant.source.id
      || plan.support.source.version !== participant.source.version
      || plan.supportChanges.remove.length !== 0
      || plan.supportChanges.insert.length > 1
      || (plan.supportChanges.insert.length === 1
        && JSON.stringify(plan.supportChanges.insert[0]) !== JSON.stringify(plan.support))) {
    context.addIssue({ code: 'custom', message: 'participant addition contributions must share scope, identity, and source' });
  }
});

/**
 * Exact cross-owner plan for attaching one already-accepted, currently
 * unlinked Submission to a Session. The three contributions commit in one
 * caller-owned transaction; this plan is also the guarded recovery evidence
 * returned to the browser receipt.
 */
export const sessionSubmissionAttachPlanSchema = z.strictObject({
  sessionPlan: sessionMutationPlanSchema.refine(
    (plan) => plan.input.action === 'roster_append',
    'an attach route carries one roster append'
  ),
  origin: submissionSessionOriginSchema.refine(
    (origin) => origin.kind === 'attached',
    'an attach route carries attached lineage'
  ),
  engagementSeed: engagementSeedPlanSchema,
  supportInserts: z.array(sessionParticipantSupportSchema.refine(
    (support) => support.kind === 'submission',
    'an accepted attach carries Submission support'
  )).min(1).max(500)
}).superRefine((plan, context) => {
  const input = plan.sessionPlan.input;
  if (input.action !== 'roster_append') return;
  if (plan.origin.sessionId !== input.sessionId
      || plan.origin.submissionId !== plan.engagementSeed.input.submissionId
      || plan.origin.sessionId !== plan.engagementSeed.input.sessionId
      || plan.origin.scope.workspaceId !== input.scope.workspaceId
      || plan.origin.scope.eventId !== input.scope.eventId
      || plan.engagementSeed.input.scope.workspaceId !== input.scope.workspaceId
      || plan.engagementSeed.input.scope.eventId !== input.scope.eventId) {
    context.addIssue({ code: 'custom', message: 'attach contributions must share one scope and route' });
  }
  const participantIds = new Set(input.participants.map((participant) => participant.personId));
  const supportIds = new Set<string>();
  for (const support of plan.supportInserts) {
    if (support.kind !== 'submission'
        || support.scope.workspaceId !== input.scope.workspaceId
        || support.scope.eventId !== input.scope.eventId
        || support.sessionId !== input.sessionId
        || support.submissionId !== plan.origin.submissionId
        || !participantIds.has(support.personId)
        || supportIds.has(support.personId)) {
      context.addIssue({ code: 'custom', message: 'attach support must cover each participant exactly once' });
      return;
    }
    supportIds.add(support.personId);
  }
  if (supportIds.size !== participantIds.size) {
    context.addIssue({ code: 'custom', message: 'attach support must cover each participant exactly once' });
  }
});

export const sessionSubmissionAttachInputSchema = z.strictObject({
  action: z.literal('attach_unlinked'),
  ...routeGuardFields,
  targetSessionId: sessionIdInputSchema,
  submissionId: sessionIdInputSchema
});

export const sessionSubmissionMoveInputSchema = z.strictObject({
  action: z.literal('move'),
  expectedCatalogVersion: sessionVersionSchema,
  expectedCatalogDigestSha256: digestSchema,
  submissionId: sessionIdInputSchema,
  sourceSessionId: sessionIdInputSchema,
  expectedSourceSessionVersion: sessionVersionSchema,
  expectedSourceSessionDigestSha256: digestSchema,
  targetSessionId: sessionIdInputSchema,
  expectedTargetSessionVersion: sessionVersionSchema,
  expectedTargetSessionDigestSha256: digestSchema
}).refine(
  (input) => input.sourceSessionId !== input.targetSessionId,
  { path: ['targetSessionId'], message: 'a move requires a different target Session' }
);

export const sessionSubmissionMovePlanSchema = z.strictObject({
  scope: sessionScopeSchema,
  submissionId: sessionIdInputSchema,
  sourceSession: z.strictObject({ before: sessionHeadSchema, after: sessionHeadSchema }),
  targetSession: z.strictObject({ before: sessionHeadSchema, after: sessionHeadSchema }),
  catalogVersion: z.strictObject({ before: sessionVersionSchema, after: sessionVersionSchema }),
  catalogDigestSha256: z.strictObject({ before: digestSchema, after: digestSchema }),
  sessionPlans: z.array(sessionMutationPlanSchema.refine(
    (plan) => plan.input.action === 'roster_reconcile',
    'a move carries only internal roster reconciliations'
  )).max(2),
  originBefore: submissionSessionOriginSchema,
  originAfter: submissionSessionOriginSchema.refine(
    (origin) => origin.kind === 'attached',
    'a moved route is attached to its destination'
  ),
  supportChanges: sessionParticipantSupportChangePlanSchema,
  engagementSeed: engagementSeedPlanSchema
}).superRefine((plan, context) => {
  const scopeMatches = (candidate: { readonly scope: { readonly workspaceId: string; readonly eventId: string } }) =>
    candidate.scope.workspaceId === plan.scope.workspaceId
    && candidate.scope.eventId === plan.scope.eventId;
  if (!scopeMatches(plan.sourceSession.before)
      || !scopeMatches(plan.sourceSession.after)
      || !scopeMatches(plan.targetSession.before)
      || !scopeMatches(plan.targetSession.after)
      || !scopeMatches(plan.originBefore)
      || !scopeMatches(plan.originAfter)
      || plan.sourceSession.before.id !== plan.sourceSession.after.id
      || plan.targetSession.before.id !== plan.targetSession.after.id
      || plan.sourceSession.before.id === plan.targetSession.before.id
      || plan.originBefore.sessionId !== plan.sourceSession.before.id
      || plan.originAfter.sessionId !== plan.targetSession.before.id
      || plan.originBefore.submissionId !== plan.submissionId
      || plan.originAfter.submissionId !== plan.submissionId
      || plan.engagementSeed.input.scope.workspaceId !== plan.scope.workspaceId
      || plan.engagementSeed.input.scope.eventId !== plan.scope.eventId
      || plan.engagementSeed.input.sessionId !== plan.targetSession.before.id
      || plan.engagementSeed.input.submissionId !== plan.submissionId) {
    context.addIssue({ code: 'custom', message: 'move contributions must share one scope, Submission, source, and target' });
  }
  let version = plan.catalogVersion.before;
  let digest = plan.catalogDigestSha256.before;
  for (const sessionPlan of plan.sessionPlans) {
    if (sessionPlan.catalogVersion.before !== version
        || sessionPlan.catalogDigestSha256.before !== digest
        || (sessionPlan.input.sessionId !== plan.sourceSession.before.id
          && sessionPlan.input.sessionId !== plan.targetSession.before.id)) {
      context.addIssue({ code: 'custom', message: 'move Session plans must form one guarded catalog chain' });
      break;
    }
    version = sessionPlan.catalogVersion.after;
    digest = sessionPlan.catalogDigestSha256.after;
  }
  if (version !== plan.catalogVersion.after || digest !== plan.catalogDigestSha256.after) {
    context.addIssue({ code: 'custom', message: 'move Session plans must end at the declared catalog head' });
  }
  const people = new Set(plan.engagementSeed.input.personIds);
  const removed = new Set<string>();
  const inserted = new Set<string>();
  for (const support of plan.supportChanges.remove) {
    if (support.kind !== 'submission'
        || support.submissionId !== plan.submissionId
        || support.sessionId !== plan.sourceSession.before.id
        || !scopeMatches(support)
        || !people.has(support.personId)) continue;
    removed.add(support.personId);
  }
  for (const support of plan.supportChanges.insert) {
    if (support.kind !== 'submission'
        || support.submissionId !== plan.submissionId
        || support.sessionId !== plan.targetSession.before.id
        || !scopeMatches(support)
        || !people.has(support.personId)) continue;
    inserted.add(support.personId);
  }
  if (removed.size !== people.size || inserted.size !== people.size
      || plan.supportChanges.remove.length !== people.size
      || plan.supportChanges.insert.length !== people.size) {
    context.addIssue({ code: 'custom', message: 'move support must transfer every Submission participant exactly once' });
  }
});

export const sessionSubmissionRestoreInputSchema = z.strictObject({
  action: z.literal('restore_route'),
  ...routeGuardFields,
  original: sessionSubmissionAttachPlanSchema
});

export const sessionSubmissionMoveRestoreInputSchema = z.strictObject({
  action: z.literal('restore_move'),
  expectedCatalogVersion: sessionVersionSchema,
  expectedCatalogDigestSha256: digestSchema,
  expectedSourceSessionVersion: sessionVersionSchema,
  expectedSourceSessionDigestSha256: digestSchema,
  expectedTargetSessionVersion: sessionVersionSchema,
  expectedTargetSessionDigestSha256: digestSchema,
  original: sessionSubmissionMovePlanSchema
});

export const sessionSubmissionRouteInputSchema = z.discriminatedUnion('action', [
  sessionSubmissionAttachInputSchema,
  sessionSubmissionRestoreInputSchema,
  sessionSubmissionMoveInputSchema,
  sessionSubmissionMoveRestoreInputSchema
]);

export const sessionSubmissionRestorePlanBundleSchema = z.strictObject({
  sessionPlan: sessionRestorePlanSchema,
  origin: submissionSessionOriginSchema,
  engagementSeedReversal: engagementSeedReversalPlanSchema,
  supportRemovals: z.array(sessionParticipantSupportSchema).min(1).max(500),
  original: sessionSubmissionAttachPlanSchema
});

export const sessionSubmissionMoveRestorePlanSchema = z.strictObject({
  original: sessionSubmissionMovePlanSchema,
  sessionPlans: z.array(sessionMutationPlanSchema.refine(
    (plan) => plan.input.action === 'roster_reconcile',
    'a move restore carries only internal roster reconciliations'
  )).max(2),
  originBefore: submissionSessionOriginSchema,
  originAfter: submissionSessionOriginSchema,
  supportChanges: sessionParticipantSupportChangePlanSchema,
  engagementSeedReversal: engagementSeedReversalPlanSchema,
  catalogVersion: z.strictObject({ before: sessionVersionSchema, after: sessionVersionSchema }),
  catalogDigestSha256: z.strictObject({ before: digestSchema, after: digestSchema }),
  sourceSession: sessionHeadSchema,
  targetSession: sessionHeadSchema
});

export const sessionSubmissionRouteContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({
      kind: z.literal('success'),
      data: z.strictObject({
        action: z.literal('attach_unlinked'),
        catalogVersion: sessionVersionSchema,
        session: sessionHeadSchema,
        origin: submissionSessionOriginSchema,
        recovery: sessionSubmissionAttachPlanSchema
      })
    }),
    domain: z.strictObject({
      kind: z.literal('session_submission_attach'),
      plan: sessionSubmissionAttachPlanSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({
      kind: z.literal('success'),
      data: z.strictObject({
        action: z.literal('move'),
        catalogVersion: sessionVersionSchema,
        sourceSession: sessionHeadSchema,
        targetSession: sessionHeadSchema,
        origin: submissionSessionOriginSchema,
        recovery: sessionSubmissionMovePlanSchema
      })
    }),
    domain: z.strictObject({
      kind: z.literal('session_submission_move'),
      plan: sessionSubmissionMovePlanSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({
      kind: z.literal('success'),
      data: z.strictObject({
        action: z.literal('restore_move'),
        catalogVersion: sessionVersionSchema,
        sourceSession: sessionHeadSchema,
        targetSession: sessionHeadSchema,
        origin: submissionSessionOriginSchema,
        recovery: z.null()
      })
    }),
    domain: z.strictObject({
      kind: z.literal('session_submission_move_restore'),
      plan: sessionSubmissionMoveRestorePlanSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({
      kind: z.literal('success'),
      data: z.strictObject({
        action: z.literal('restore_route'),
        catalogVersion: sessionVersionSchema,
        session: sessionHeadSchema,
        origin: z.null(),
        recovery: z.null()
      })
    }),
    domain: z.strictObject({
      kind: z.literal('session_submission_restore'),
      plan: sessionSubmissionRestorePlanBundleSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    effectContributions: z.tuple([])
  })
]);

export const sessionSubmissionRouteResultDataSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('attach_unlinked'),
    catalogVersion: sessionVersionSchema,
    session: sessionHeadSchema,
    origin: submissionSessionOriginSchema,
    recovery: sessionSubmissionAttachPlanSchema
  }),
  z.strictObject({
    action: z.literal('restore_route'),
    catalogVersion: sessionVersionSchema,
    session: sessionHeadSchema,
    origin: z.null(),
    recovery: z.null()
  }),
  z.strictObject({
    action: z.literal('move'),
    catalogVersion: sessionVersionSchema,
    sourceSession: sessionHeadSchema,
    targetSession: sessionHeadSchema,
    origin: submissionSessionOriginSchema,
    recovery: sessionSubmissionMovePlanSchema
  }),
  z.strictObject({
    action: z.literal('restore_move'),
    catalogVersion: sessionVersionSchema,
    sourceSession: sessionHeadSchema,
    targetSession: sessionHeadSchema,
    origin: submissionSessionOriginSchema,
    recovery: z.null()
  })
]);

export const sessionSubmissionRouteOperationResultSchema =
  createEffectfulOperationResultSchema(sessionSubmissionRouteResultDataSchema);

export const SESSION_SUBMISSION_ROUTE_SCHEMA_REFS = Object.freeze(
  createOperationSchemaManifestRefs({
    inputKey: 'schema.session.submission-route.input',
    inputSchema: sessionSubmissionRouteInputSchema,
    resultKey: 'schema.session.submission-route.operator-result',
    resultSchema: sessionSubmissionRouteOperationResultSchema,
    version: 1
  })
);

export type SessionSubmissionAttachPlanDto = z.infer<typeof sessionSubmissionAttachPlanSchema>;
export type SessionSubmissionMovePlanDto = z.infer<typeof sessionSubmissionMovePlanSchema>;
export type SessionSubmissionMoveRestorePlanDto = z.infer<typeof sessionSubmissionMoveRestorePlanSchema>;
export type SessionParticipantAddExistingPlanDto = z.infer<typeof sessionParticipantAddExistingPlanSchema>;
export type SessionParticipantSupportDto = z.infer<typeof sessionParticipantSupportSchema>;
export type SessionParticipantSupportChangePlanDto = z.infer<typeof sessionParticipantSupportChangePlanSchema>;
export type SessionSubmissionRouteInput = z.infer<typeof sessionSubmissionRouteInputSchema>;
export type SessionSubmissionRestorePlanBundleDto = z.infer<typeof sessionSubmissionRestorePlanBundleSchema>;
export type SessionSubmissionRouteResultData = z.infer<typeof sessionSubmissionRouteResultDataSchema>;
