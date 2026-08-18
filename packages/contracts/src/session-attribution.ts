import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  structuredOutcomeSchema
} from './operations';
import { submissionSessionOriginSchema } from './decisions';
import {
  engagementSeedPlanSchema,
  engagementSeedReversalPlanSchema
} from './engagements';
import {
  sessionHeadSchema,
  sessionIdInputSchema,
  sessionMutationPlanSchema,
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
  engagementSeed: engagementSeedPlanSchema
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
});

export const sessionSubmissionAttachInputSchema = z.strictObject({
  action: z.literal('attach_unlinked'),
  ...routeGuardFields,
  targetSessionId: sessionIdInputSchema,
  submissionId: sessionIdInputSchema
});

export const sessionSubmissionRestoreInputSchema = z.strictObject({
  action: z.literal('restore_route'),
  ...routeGuardFields,
  original: sessionSubmissionAttachPlanSchema
});

export const sessionSubmissionRouteInputSchema = z.discriminatedUnion('action', [
  sessionSubmissionAttachInputSchema,
  sessionSubmissionRestoreInputSchema
]);

export const sessionSubmissionRestorePlanBundleSchema = z.strictObject({
  sessionPlan: sessionRestorePlanSchema,
  origin: submissionSessionOriginSchema,
  engagementSeedReversal: engagementSeedReversalPlanSchema,
  original: sessionSubmissionAttachPlanSchema
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
export type SessionSubmissionRouteInput = z.infer<typeof sessionSubmissionRouteInputSchema>;
export type SessionSubmissionRestorePlanBundleDto = z.infer<typeof sessionSubmissionRestorePlanBundleSchema>;
export type SessionSubmissionRouteResultData = z.infer<typeof sessionSubmissionRouteResultDataSchema>;
