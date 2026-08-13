import { isApplicationId, parseInstant } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema
} from './operations';

const positiveIntegerSchema = z.number().int().positive().safe();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const stableKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export const changesetApplicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Application IDs must be canonical lowercase UUIDv4 or UUIDv7 values.'
});

export const changesetCanonicalInstantSchema = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}, { message: 'Expected a canonical UTC instant.' });

export const changesetRevisionSelectorSchema = z.strictObject({
  changesetId: changesetApplicationIdSchema,
  revisionId: changesetApplicationIdSchema,
  revisionDigest: sha256Schema
});

export const changesetDiffInputSchema = changesetRevisionSelectorSchema;
export const proposeChangesetInputSchema = changesetRevisionSelectorSchema.extend({
  expectedHeadVersion: positiveIntegerSchema
});
export const approveChangesetRevisionInputSchema = proposeChangesetInputSchema;
export const commitChangesetInputSchema = proposeChangesetInputSchema;
export const rebuildChangesetInputSchema = z.strictObject({
  changesetId: changesetApplicationIdSchema,
  expectedHeadVersion: positiveIntegerSchema,
  sourceRevisionId: changesetApplicationIdSchema,
  sourceRevisionDigest: sha256Schema,
  groups: z.array(stableKeySchema).min(1).max(100)
}).superRefine((input, context) => {
  const canonical = [...new Set(input.groups)].sort();
  if (canonical.length !== input.groups.length
      || canonical.some((group, index) => group !== input.groups[index])) {
    context.addIssue({
      code: 'custom', path: ['groups'], message: 'Groups must be sorted and unique.'
    });
  }
});
export const draftChangesetCorrectionInputSchema = z.strictObject({
  sourceChangesetId: changesetApplicationIdSchema,
  sourceRevisionId: changesetApplicationIdSchema,
  sourceRevisionDigest: sha256Schema,
  sourceCommitReceiptId: changesetApplicationIdSchema
});

export const changesetApprovalPolicyViewSchema = z.strictObject({
  reference: z.strictObject({ key: stableKeySchema, version: positiveIntegerSchema }),
  definitionDigestSha256: sha256Schema,
  requirement: z.enum(['none', 'distinct_current_human'])
});

export const changesetDiffDataSchema = z.strictObject({
  changesetId: changesetApplicationIdSchema,
  headVersion: positiveIntegerSchema,
  status: z.enum(['draft', 'proposed', 'committed', 'discarded']),
  revisionId: changesetApplicationIdSchema,
  revisionNumber: positiveIntegerSchema,
  revisionDigest: sha256Schema,
  riskTier: z.enum(['low', 'normal', 'consequential']),
  approvalPolicy: changesetApprovalPolicyViewSchema,
  operations: z.array(z.strictObject({
    kind: z.string().trim().min(1).max(256),
    version: positiveIntegerSchema,
    riskTier: z.enum(['low', 'normal', 'consequential']),
    dependencyGroup: stableKeySchema,
    safeDiff: z.json(),
    consequences: z.array(z.string().trim().min(1).max(256))
  })).min(1).max(100)
});

export const proposedChangesetDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('propose'),
  diff: changesetDiffDataSchema
});
export const approvedChangesetDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('approve'),
  changesetId: changesetApplicationIdSchema,
  headVersion: positiveIntegerSchema,
  revisionId: changesetApplicationIdSchema,
  revisionDigest: sha256Schema,
  approvalId: changesetApplicationIdSchema,
  expiresAt: changesetCanonicalInstantSchema
});
export const rebuiltChangesetDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('rebuild'),
  sourceRevisionId: changesetApplicationIdSchema,
  sourceRevisionDigest: sha256Schema,
  diff: changesetDiffDataSchema
});
export const draftedChangesetCorrectionDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('correction'),
  sourceChangesetId: changesetApplicationIdSchema,
  sourceRevisionId: changesetApplicationIdSchema,
  sourceRevisionDigest: sha256Schema,
  resultKind: z.enum(['exact', 'semantic', 'partial', 'blocked', 'irreversible']),
  target: z.union([changesetDiffDataSchema, z.null()]),
  evidence: z.json()
});
export const committedChangesetDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('commit'),
  changesetId: changesetApplicationIdSchema,
  expectedHeadVersion: positiveIntegerSchema,
  committedHeadVersion: positiveIntegerSchema,
  revisionId: changesetApplicationIdSchema,
  revisionDigest: sha256Schema
}).superRefine((data, context) => {
  if (data.committedHeadVersion !== data.expectedHeadVersion + 1) {
    context.addIssue({
      code: 'custom', path: ['committedHeadVersion'], message: 'Commit must advance once.'
    });
  }
});

export const changesetLifecycleDataSchema = z.discriminatedUnion('action', [
  proposedChangesetDataSchema,
  approvedChangesetDataSchema,
  rebuiltChangesetDataSchema,
  draftedChangesetCorrectionDataSchema,
  committedChangesetDataSchema
]);

export const changesetDiffCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: changesetDiffDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const changesetLifecycleCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: changesetLifecycleDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const changesetDiffOperationResultSchema =
  createReadOperationResultSchema(changesetDiffDataSchema);
export const proposedChangesetOperationResultSchema =
  createEffectfulOperationResultSchema(proposedChangesetDataSchema);
export const approvedChangesetOperationResultSchema =
  createEffectfulOperationResultSchema(approvedChangesetDataSchema);
export const rebuiltChangesetOperationResultSchema =
  createEffectfulOperationResultSchema(rebuiltChangesetDataSchema);
export const draftedChangesetCorrectionOperationResultSchema =
  createEffectfulOperationResultSchema(draftedChangesetCorrectionDataSchema);
export const committedChangesetOperationResultSchema =
  createEffectfulOperationResultSchema(committedChangesetDataSchema);
export const changesetLifecycleOperationResultSchema =
  createEffectfulOperationResultSchema(changesetLifecycleDataSchema);

/** Exact public schema identities projected into the operator operation manifest. */
export const CHANGESET_OPERATION_SCHEMA_REFS = Object.freeze({
  diff: createOperationSchemaManifestRefs({
    inputKey: 'schema.changeset.diff-read.input',
    inputSchema: changesetDiffInputSchema,
    resultKey: 'schema.changeset.diff-read.operator-result',
    resultSchema: changesetDiffOperationResultSchema
  }),
  propose: createOperationSchemaManifestRefs({
    inputKey: 'schema.changeset.propose.input',
    inputSchema: proposeChangesetInputSchema,
    resultKey: 'schema.changeset.lifecycle.operator-result',
    resultSchema: changesetLifecycleOperationResultSchema
  }),
  approve: createOperationSchemaManifestRefs({
    inputKey: 'schema.changeset.approve.input',
    inputSchema: approveChangesetRevisionInputSchema,
    resultKey: 'schema.changeset.lifecycle.operator-result',
    resultSchema: changesetLifecycleOperationResultSchema
  }),
  rebuild: createOperationSchemaManifestRefs({
    inputKey: 'schema.changeset.rebuild.input',
    inputSchema: rebuildChangesetInputSchema,
    resultKey: 'schema.changeset.lifecycle.operator-result',
    resultSchema: changesetLifecycleOperationResultSchema
  }),
  correction: createOperationSchemaManifestRefs({
    inputKey: 'schema.changeset.correction-draft.input',
    inputSchema: draftChangesetCorrectionInputSchema,
    resultKey: 'schema.changeset.lifecycle.operator-result',
    resultSchema: changesetLifecycleOperationResultSchema
  }),
  commit: createOperationSchemaManifestRefs({
    inputKey: 'schema.changeset.commit.input',
    inputSchema: commitChangesetInputSchema,
    resultKey: 'schema.changeset.lifecycle.operator-result',
    resultSchema: changesetLifecycleOperationResultSchema
  })
});

export type ChangesetRevisionSelector = z.infer<typeof changesetRevisionSelectorSchema>;
export type ChangesetDiffData = z.infer<typeof changesetDiffDataSchema>;
export type ChangesetLifecycleData = z.infer<typeof changesetLifecycleDataSchema>;
