import type { DirectOperationFeatureContributor } from '@jooevents/application';
import { taskMutationCanonicalResultSchema } from '@jooevents/contracts';
import { parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createProjectionImpactCatalog,
  type ProjectionImpact,
  type ProjectionImpactCatalog,
  type ProjectionImpactDescriptor
} from './projection-impact';
import { SYNC_AREA_KEYS } from './mapping';

export const AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR = Object.freeze({
  key: 'feature.airtable.projection-impact',
  version: 2
} as const);

export const AIRTABLE_SELECTED_OUTBOUND_OPERATION_INVENTORY = Object.freeze([
  Object.freeze({
    operationName: 'task.mutation',
    operationVersion: 1,
    areaKeys: Object.freeze(['tasks'] as const)
  })
] as const);

type AirtableRefreshAreaKey = (typeof SYNC_AREA_KEYS)[number];
const refreshAreas = (...values: AirtableRefreshAreaKey[]): readonly AirtableRefreshAreaKey[] =>
  Object.freeze(values);

const AREA_REFRESHES_BY_OPERATION: Readonly<Record<string, readonly (typeof SYNC_AREA_KEYS)[number][]>> = Object.freeze({
  'event.create@1': refreshAreas('events'),
  'event.settings.update@1': refreshAreas('events'),
  'session.change@1': refreshAreas('sessions', 'schedule', 'people'),
  'schedule.placement@1': refreshAreas('sessions', 'schedule'),
  'submission.direct_entry.create@1': refreshAreas('submissions'),
  'application.public.mutate@1': refreshAreas('submissions'),
  'decision.decide@1': refreshAreas('submissions'),
  'engagement.change@1': refreshAreas('people'),
  'program_vocabulary.create@1': refreshAreas('submissions', 'sessions', 'schedule'),
  'program_vocabulary.edit@1': refreshAreas('submissions', 'sessions', 'schedule'),
  'program_vocabulary.retire@1': refreshAreas('submissions', 'sessions', 'schedule'),
  'program_vocabulary.restore@1': refreshAreas('submissions', 'sessions', 'schedule'),
  'program_vocabulary.delete@1': refreshAreas('submissions', 'sessions', 'schedule')
});

const impactSchema = z.strictObject({
  areaKey: z.enum(SYNC_AREA_KEYS),
  subjectKind: z.string().min(1).max(80),
  subjectId: z.string().min(1).max(160),
  projectionVersion: z.number().int().positive().safe()
});

export const airtableProjectionFeatureContributionSchema = z.strictObject({
  schemaVersion: z.literal(2),
  catalogDigestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  workspaceId: z.string().transform((value, context) => {
    try {
      return parseWorkspaceId(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'workspace_id_invalid' });
      return z.NEVER;
    }
  }),
  eventId: z.string().nullable(),
  occurredAt: z.string().transform((value, context) => {
    try {
      return parseInstant(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'occurred_at_invalid' });
      return z.NEVER;
    }
  }),
  impacts: z.array(impactSchema).max(100),
  refreshAreas: z.array(z.enum(SYNC_AREA_KEYS)).max(SYNC_AREA_KEYS.length).optional(),
  inbound: z.strictObject({
    inboxReceiptId: z.string().min(1).max(160),
    observations: z.array(z.strictObject({
      connectionId: z.string().min(1).max(160),
      recordLinkId: z.string().min(1).max(160),
      fieldKey: z.string().min(1).max(160),
      kind: z.enum(['applied', 'request']),
      classification: z.enum(['ordinary', 'personal', 'sensitive']),
      before: z.json(),
      after: z.json(),
      providerActorId: z.string().min(1).max(160).optional(),
      providerActorEmail: z.string().min(3).max(320).optional(),
      providerActorDisplayName: z.string().min(1).max(320).optional(),
      observedAtMs: z.number().int().nonnegative().safe()
    })).min(1).max(10)
  }).optional()
}).superRefine((value, context) => {
  if (value.impacts.length === 0 && value.inbound === undefined
      && (value.refreshAreas?.length ?? 0) === 0) {
    context.addIssue({ code: 'custom', message: 'airtable_feature_contribution_empty' });
  }
});

export const airtableControlledInboundFeatureContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('airtable_controlled_inbound'),
  observations: airtableProjectionFeatureContributionSchema.shape.inbound
    .unwrap().shape.observations
});

export type AirtableControlledInboundFeatureContext = z.infer<
  typeof airtableControlledInboundFeatureContextSchema
>;

export type AirtableProjectionFeatureContribution = z.infer<
  typeof airtableProjectionFeatureContributionSchema
>;

export const taskMutationProjectionImpactDescriptor: ProjectionImpactDescriptor = Object.freeze({
  operationName: 'task.mutation',
  operationVersion: 1,
  resolve: ({ canonicalResult }: Parameters<ProjectionImpactDescriptor['resolve']>[0]): readonly ProjectionImpact[] => {
    const parsed = taskMutationCanonicalResultSchema.safeParse(canonicalResult);
    if (!parsed.success || parsed.data.kind !== 'success') return Object.freeze([]);
    const assignments = parsed.data.data.action === 'create_definition'
      ? parsed.data.data.assignments
      : [parsed.data.data.assignment];
    return Object.freeze(assignments.map((assignment) => Object.freeze({
      areaKey: 'tasks' as const,
      subjectKind: 'task_assignment',
      subjectId: assignment.id,
      projectionVersion: assignment.version
    })));
  }
});

export function createDefaultAirtableProjectionImpactCatalog(): ProjectionImpactCatalog {
  return createProjectionImpactCatalog([taskMutationProjectionImpactDescriptor]);
}

/**
 * The only executor-facing Airtable hook. It is pure and capability-free; active
 * mapping lookup and work coalescing remain transaction-adapter responsibilities.
 */
export function createAirtableDirectFeatureContributor(
  catalog: ProjectionImpactCatalog = createDefaultAirtableProjectionImpactCatalog()
): DirectOperationFeatureContributor {
  return Object.freeze({
    reference: AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR,
    contribute(input: Parameters<DirectOperationFeatureContributor['contribute']>[0]) {
      const impacts = catalog.resolve({
        operationName: input.operation.name,
        operationVersion: input.operation.version,
        businessInput: input.businessInput,
        canonicalResult: input.canonicalResult
      });
      const successful = typeof input.canonicalResult === 'object'
        && input.canonicalResult !== null
        && !Array.isArray(input.canonicalResult)
        && (input.canonicalResult as { readonly kind?: unknown }).kind === 'success';
      const controlled = input.featureContext === undefined
        ? undefined
        : airtableControlledInboundFeatureContextSchema.parse(input.featureContext);
      const inbound = controlled && successful && input.provenance?.kind === 'verified_inbox'
        ? Object.freeze({
            inboxReceiptId: input.provenance.inboxReceiptId,
            observations: controlled.observations
          })
        : undefined;
      if (controlled && !inbound) {
        throw new TypeError('airtable_controlled_inbound_context_untrusted');
      }
      const refreshAreas = successful
        ? AREA_REFRESHES_BY_OPERATION[`${input.operation.name}@${input.operation.version}`]
        : undefined;
      if (impacts.length === 0 && !inbound && !refreshAreas) return undefined;
      return airtableProjectionFeatureContributionSchema.parse({
        schemaVersion: 2,
        catalogDigestSha256: catalog.digestSha256,
        workspaceId: input.scope.workspaceId,
        eventId: input.scope.eventId ?? null,
        occurredAt: input.occurredAt,
        impacts,
        ...(refreshAreas ? { refreshAreas } : {}),
        ...(inbound ? { inbound } : {})
      });
    }
  });
}
