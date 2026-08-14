import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  versionedDefinitionRefSchema
} from './operations';
import { sessionRosterSourceRefSchema } from './sessions';

const APPLICATION_UUID_INPUT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLICATION_UUID_CANONICAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const canonicalInstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith('Z') && value.includes('.'),
  'instant must use canonical UTC millisecond form'
);
const canonicalText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ') === value);

/** One acceptance seeds at most one Session roster write, capped like the roster itself. */
export const ENGAGEMENT_SEED_PERSONS_MAX = 500;
export const ENGAGEMENT_SNAPSHOT_MAX = 10_000;

export const engagementIdInputSchema = z.string()
  .regex(APPLICATION_UUID_INPUT)
  .overwrite((value) => value.toLowerCase());
export const engagementIdSchema = z.string().regex(APPLICATION_UUID_CANONICAL);
export const engagementScopeSchema = z.strictObject({
  workspaceId: engagementIdSchema,
  eventId: engagementIdSchema
});
export const engagementVersionSchema = z.number().int().positive().safe();

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The seed provenance pin: the exact Decision head state — version and content
 * digest — whose committed acceptance seeded this engagement. It is the same
 * `(version, digestSha256)` identity the Decision layer itself fences head
 * writes on. Compensating an acceptance may remove only the rows pinned to
 * that acceptance's own written head, so rows a previous acceptance of the
 * same submission seeded — and a stays-standing compensation deliberately
 * preserved — are never destroyed by a later acceptance's revert.
 */
export const engagementSeedProvenanceSchema = z.strictObject({
  version: engagementVersionSchema,
  digestSha256: digestSchema
});

function sameSeedProvenance(
  left: { readonly version: number; readonly digestSha256: string } | null,
  right: { readonly version: number; readonly digestSha256: string } | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.version === right.version && left.digestSha256 === right.digestSha256;
}

/**
 * The four canonical engagement states. A pending cancellation is a stored
 * request sub-state (`cancellationRequest` beside a non-cancelled state), never
 * a fifth state value: surfaces project `cancel_requested` as
 * `state !== 'cancelled' && cancellationRequest !== null`.
 */
export const engagementStateSchema = z.enum(['invited', 'confirmed', 'declined', 'cancelled']);

/**
 * Who a confirmation is attributed to. `self` is the engaged person,
 * `co_speaker` is another person on the same Session acting for them, and
 * `organizer_recorded` is an organizer recording an out-of-band confirmation.
 * A confirmation is never anonymous.
 */
export const engagementConfirmationAttributionSchema = z.enum([
  'self', 'co_speaker', 'organizer_recorded'
]);

export const engagementCancellationRequestSchema = z.strictObject({
  requestedBy: z.enum(['speaker', 'organizer']),
  requestedAt: canonicalInstantSchema,
  note: canonicalText(500).nullable()
});

export const engagementConfirmationSchema = z.strictObject({
  attribution: engagementConfirmationAttributionSchema,
  /** The person whose act the confirmation records; the engaged person for `self`. */
  personId: engagementIdSchema,
  /** The recording workspace user, present exactly for `organizer_recorded`. */
  recordedByUserId: engagementIdSchema.nullable(),
  confirmedAt: canonicalInstantSchema
}).superRefine((confirmation, context) => {
  if ((confirmation.attribution === 'organizer_recorded')
      !== (confirmation.recordedByUserId !== null)) {
    context.addIssue({
      code: 'custom', path: ['recordedByUserId'],
      message: 'exactly an organizer-recorded confirmation carries the recording user'
    });
  }
});

/**
 * One person's engagement on one Session. Identity is the `(sessionId, personId)`
 * pair — `id` is its stable server identity — and `personId` is the only person
 * key; an email address never identifies an engagement. `source` carries the
 * provenance of the roster write that seeded the invitation (`submission` for
 * acceptance-seeded rows), `submissionId` links acceptance-seeded rows to
 * their submission, and `seededByDecision` pins exactly which acceptance
 * commit wrote the row. All three are immutable for the row's lifetime.
 */
export const engagementHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: engagementIdSchema,
  scope: engagementScopeSchema,
  sessionId: engagementIdSchema,
  personId: engagementIdSchema,
  submissionId: engagementIdSchema.nullable(),
  seededByDecision: engagementSeedProvenanceSchema.nullable(),
  state: engagementStateSchema,
  invitedAt: canonicalInstantSchema,
  respondBy: canonicalInstantSchema.nullable(),
  confirmation: engagementConfirmationSchema.nullable(),
  cancellationRequest: engagementCancellationRequestSchema.nullable(),
  cancelledAt: canonicalInstantSchema.nullable(),
  source: sessionRosterSourceRefSchema,
  version: engagementVersionSchema
}).superRefine((head, context) => {
  if ((head.state === 'cancelled') !== (head.cancelledAt !== null)) {
    context.addIssue({
      code: 'custom', path: ['cancelledAt'],
      message: 'exactly a cancelled engagement carries its cancellation instant'
    });
  }
  if (head.state === 'confirmed' && head.confirmation === null) {
    context.addIssue({
      code: 'custom', path: ['confirmation'],
      message: 'a confirmed engagement records who confirmed'
    });
  }
  if ((head.state === 'invited' || head.state === 'declined') && head.confirmation !== null) {
    context.addIssue({
      code: 'custom', path: ['confirmation'],
      message: 'only a confirmed or cancelled engagement carries a confirmation'
    });
  }
  if (head.state === 'declined' && head.cancellationRequest !== null) {
    context.addIssue({
      code: 'custom', path: ['cancellationRequest'],
      message: 'a declined engagement has no cancellation flow'
    });
  }
  if (head.confirmation !== null) {
    if (head.confirmation.attribution === 'self' && head.confirmation.personId !== head.personId) {
      context.addIssue({
        code: 'custom', path: ['confirmation', 'personId'],
        message: 'a self confirmation is attributed to the engaged person'
      });
    }
    if (head.confirmation.attribution === 'co_speaker'
        && head.confirmation.personId === head.personId) {
      context.addIssue({
        code: 'custom', path: ['confirmation', 'personId'],
        message: 'a co-speaker confirmation is attributed to another person'
      });
    }
  }
  if (head.source.kind === 'submission' && head.submissionId !== head.source.id) {
    context.addIssue({
      code: 'custom', path: ['submissionId'],
      message: 'a submission-sourced engagement links exactly its source submission'
    });
  }
  if (head.submissionId !== null && head.source.kind !== 'submission') {
    context.addIssue({
      code: 'custom', path: ['submissionId'],
      message: 'only a submission-sourced engagement links a submission'
    });
  }
  if ((head.submissionId !== null) !== (head.seededByDecision !== null)) {
    context.addIssue({
      code: 'custom', path: ['seededByDecision'],
      message: 'exactly an acceptance-seeded engagement pins its seeding decision head'
    });
  }
});

export const engagementSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: engagementScopeSchema,
  engagements: z.array(engagementHeadSchema).max(ENGAGEMENT_SNAPSHOT_MAX)
}).superRefine((snapshot, context) => {
  for (const [index, head] of snapshot.engagements.entries()) {
    if (head.scope.workspaceId !== snapshot.scope.workspaceId
        || head.scope.eventId !== snapshot.scope.eventId) {
      context.addIssue({
        code: 'custom', path: ['engagements', index, 'scope'],
        message: 'engagement scope must match snapshot scope'
      });
    }
    if (index > 0) {
      const previous = snapshot.engagements[index - 1]!;
      const previousKey = `${previous.sessionId}:${previous.personId}`;
      const key = `${head.sessionId}:${head.personId}`;
      if (previousKey >= key) {
        context.addIssue({
          code: 'custom', path: ['engagements', index],
          message: 'engagements must be unique and canonically ordered by session and person'
        });
      }
    }
  }
});

const respondActionGuards = {
  engagementId: engagementIdInputSchema,
  expectedEngagementVersion: engagementVersionSchema
} as const;

/**
 * Operator wire surface for the four engagement response acts. Each act
 * addresses one engagement and fences on its expected version; the server
 * supplies scope, actor, and time inside the sealed invocation.
 *
 * The operator surface may only assert acts its own authority performed, so
 * the sole admissible confirmation attribution here is `organizer_recorded` —
 * the head then names the recording user. `self` and `co_speaker` record a
 * participant's personal act and exist only for person-authenticated surfaces
 * that resolve their own planning input; accepting them on this wire would let
 * an organizer fabricate a participant confirmation whose head erases the
 * recorder.
 */
export const engagementRecordConfirmationInputSchema = z.strictObject({
  action: z.literal('record_confirmation'),
  ...respondActionGuards,
  attribution: z.literal('organizer_recorded')
});

export const engagementDeclineInputSchema = z.strictObject({
  action: z.literal('decline'),
  ...respondActionGuards
});

export const engagementRequestCancellationInputSchema = z.strictObject({
  action: z.literal('request_cancellation'),
  ...respondActionGuards,
  requestedBy: z.enum(['speaker', 'organizer']),
  note: canonicalText(500).optional()
});

export const engagementAcceptCancellationInputSchema = z.strictObject({
  action: z.literal('accept_cancellation'),
  ...respondActionGuards
});

export const engagementAuthorInputSchema = z.discriminatedUnion('action', [
  engagementRecordConfirmationInputSchema,
  engagementDeclineInputSchema,
  engagementRequestCancellationInputSchema,
  engagementAcceptCancellationInputSchema
]);

export const engagementResponseActionSchema = z.enum([
  'record_confirmation', 'decline', 'request_cancellation', 'accept_cancellation'
]);

const planningAttribution = {
  scope: engagementScopeSchema,
  actorUserId: engagementIdSchema,
  occurredAt: canonicalInstantSchema
} as const;

const planningGuards = {
  engagementId: engagementIdSchema,
  expectedEngagementVersion: engagementVersionSchema
} as const;

/**
 * Resolved deterministic planning input: wire input plus server attribution.
 * Unlike the operator wire, the confirmation arm admits the full attribution
 * union: `self` and `co_speaker` planning inputs may only be constructed by a
 * person-authenticated surface acting as that person, never resolved from the
 * operator wire.
 */
export const engagementMutationPlanningInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('record_confirmation'),
    ...planningAttribution,
    ...planningGuards,
    attribution: engagementConfirmationAttributionSchema,
    confirmingPersonId: engagementIdSchema.optional()
  }).superRefine((input, context) => {
    if ((input.attribution === 'co_speaker') !== (input.confirmingPersonId !== undefined)) {
      context.addIssue({
        code: 'custom', path: ['confirmingPersonId'],
        message: 'exactly a co-speaker confirmation names the confirming person'
      });
    }
  }),
  z.strictObject({
    action: z.literal('decline'),
    ...planningAttribution,
    ...planningGuards
  }),
  z.strictObject({
    action: z.literal('request_cancellation'),
    ...planningAttribution,
    ...planningGuards,
    requestedBy: z.enum(['speaker', 'organizer']),
    note: canonicalText(500).optional()
  }),
  z.strictObject({
    action: z.literal('accept_cancellation'),
    ...planningAttribution,
    ...planningGuards
  })
]);

export const engagementMutationPlanSchema = z.strictObject({
  input: engagementMutationPlanningInputSchema,
  before: engagementHeadSchema,
  after: engagementHeadSchema
}).superRefine((plan, context) => {
  if (plan.before.id !== plan.input.engagementId || plan.after.id !== plan.input.engagementId) {
    context.addIssue({ code: 'custom', message: 'plan images must match the addressed engagement' });
  }
  if (plan.before.version !== plan.input.expectedEngagementVersion
      || plan.after.version !== plan.before.version + 1) {
    context.addIssue({
      code: 'custom', path: ['after', 'version'],
      message: 'a response advances the fenced engagement version by one'
    });
  }
  if (plan.before.sessionId !== plan.after.sessionId
      || plan.before.personId !== plan.after.personId) {
    context.addIssue({ code: 'custom', message: 'engagement identity is immutable' });
  }
  if (plan.before.submissionId !== plan.after.submissionId
      || !sameSeedProvenance(plan.before.seededByDecision, plan.after.seededByDecision)) {
    context.addIssue({
      code: 'custom', path: ['after', 'seededByDecision'],
      message: 'a response never rewrites an engagement\'s seed provenance'
    });
  }
});

/** Internal compensating image restore; it is never an ordinary authoring input. */
export const engagementRestorePlanSchema = z.strictObject({
  action: z.literal('restore'),
  scope: engagementScopeSchema,
  actorUserId: engagementIdSchema,
  occurredAt: canonicalInstantSchema,
  expectedCurrent: engagementHeadSchema,
  restore: engagementHeadSchema
}).superRefine((plan, context) => {
  if (plan.restore.id !== plan.expectedCurrent.id) {
    context.addIssue({ code: 'custom', message: 'restore images must address one engagement' });
  }
  if (plan.restore.version !== plan.expectedCurrent.version + 1) {
    context.addIssue({
      code: 'custom', path: ['restore', 'version'],
      message: 'a restore advances the current engagement version by one'
    });
  }
  if (plan.restore.submissionId !== plan.expectedCurrent.submissionId
      || !sameSeedProvenance(plan.restore.seededByDecision, plan.expectedCurrent.seededByDecision)) {
    context.addIssue({
      code: 'custom', path: ['restore', 'seededByDecision'],
      message: 'a restore never rewrites an engagement\'s seed provenance'
    });
  }
});

export const engagementSafeDiffSchema = z.strictObject({
  action: z.enum([...engagementResponseActionSchema.options, 'restore']),
  before: engagementHeadSchema.nullable(),
  after: engagementHeadSchema.nullable()
});

export const engagementMutationResultSchema = z.strictObject({
  action: z.enum([...engagementResponseActionSchema.options, 'restore']),
  engagement: engagementHeadSchema
});

/**
 * Deterministic planning input for one acceptance-shaped roster write: the
 * committed roster write seeds an `invited` engagement per person,
 * skip-existing on the `(sessionId, personId)` pair. Person ids are unique and
 * canonically ordered so a replanned seed compares byte-identically.
 */
export const engagementSeedInputSchema = z.strictObject({
  scope: engagementScopeSchema,
  sessionId: engagementIdSchema,
  submissionId: engagementIdSchema,
  /** The hosting acceptance's own written decision head; stamped on every seeded row. */
  seededByDecision: engagementSeedProvenanceSchema,
  source: sessionRosterSourceRefSchema,
  personIds: z.array(engagementIdSchema).min(1).max(ENGAGEMENT_SEED_PERSONS_MAX),
  invitedAt: canonicalInstantSchema,
  respondBy: canonicalInstantSchema.nullable()
}).superRefine((input, context) => {
  for (const [index, personId] of input.personIds.entries()) {
    if (index > 0 && input.personIds[index - 1]! >= personId) {
      context.addIssue({
        code: 'custom', path: ['personIds', index],
        message: 'person ids must be unique and canonically ordered'
      });
    }
  }
  if (input.source.kind === 'submission' && input.source.id !== input.submissionId) {
    context.addIssue({
      code: 'custom', path: ['source'],
      message: 'a submission-sourced seed cites exactly its submission'
    });
  }
});

/** Exact seed plan: the new `invited` rows beside the skipped existing pairs. */
export const engagementSeedPlanSchema = z.strictObject({
  input: engagementSeedInputSchema,
  rows: z.array(z.strictObject({
    personId: engagementIdSchema,
    head: engagementHeadSchema
  })).max(ENGAGEMENT_SEED_PERSONS_MAX),
  skippedPersonIds: z.array(engagementIdSchema).max(ENGAGEMENT_SEED_PERSONS_MAX)
}).superRefine((plan, context) => {
  const planned = [
    ...plan.rows.map((row) => row.personId),
    ...plan.skippedPersonIds
  ].sort();
  if (planned.length !== plan.input.personIds.length
      || planned.some((personId, index) => personId !== plan.input.personIds[index])) {
    context.addIssue({
      code: 'custom', path: ['rows'],
      message: 'seeded and skipped persons must partition the seed input exactly'
    });
  }
  for (const [index, row] of plan.rows.entries()) {
    const head = row.head;
    if (head.personId !== row.personId
        || head.state !== 'invited'
        || head.version !== 1
        || head.confirmation !== null
        || head.cancellationRequest !== null
        || head.cancelledAt !== null
        || head.sessionId !== plan.input.sessionId
        || head.submissionId !== plan.input.submissionId
        || !sameSeedProvenance(head.seededByDecision, plan.input.seededByDecision)
        || head.invitedAt !== plan.input.invitedAt
        || head.respondBy !== plan.input.respondBy
        || head.scope.workspaceId !== plan.input.scope.workspaceId
        || head.scope.eventId !== plan.input.scope.eventId) {
      context.addIssue({
        code: 'custom', path: ['rows', index],
        message: 'a seeded head is the exact invited version-one image of its seed input'
      });
    }
  }
});

/**
 * Compensating removal of exactly the rows one acceptance seeded: rows citing
 * the reverted submission AND pinned to that acceptance's own written decision
 * head. Rows a different acceptance of the same submission seeded carry a
 * different pin and never appear here. Each row pins the exact current head;
 * reversal planning refuses any selected engagement that moved past its seeded
 * `invited` version-one image.
 */
export const engagementSeedReversalPlanSchema = z.strictObject({
  action: z.literal('seed_reversal'),
  scope: engagementScopeSchema,
  sessionId: engagementIdSchema,
  submissionId: engagementIdSchema,
  /** The reverted acceptance's own written decision head; selects its rows. */
  seededByDecision: engagementSeedProvenanceSchema,
  rows: z.array(z.strictObject({
    personId: engagementIdSchema,
    expectedCurrent: engagementHeadSchema
  })).max(ENGAGEMENT_SEED_PERSONS_MAX)
}).superRefine((plan, context) => {
  for (const [index, row] of plan.rows.entries()) {
    if (row.expectedCurrent.personId !== row.personId
        || row.expectedCurrent.sessionId !== plan.sessionId
        || row.expectedCurrent.submissionId !== plan.submissionId
        || !sameSeedProvenance(row.expectedCurrent.seededByDecision, plan.seededByDecision)
        || row.expectedCurrent.state !== 'invited'
        || row.expectedCurrent.version !== 1) {
      context.addIssue({
        code: 'custom', path: ['rows', index],
        message: 'a seed reversal removes exactly seeded invited version-one rows'
      });
    }
    if (index > 0 && plan.rows[index - 1]!.personId >= row.personId) {
      context.addIssue({
        code: 'custom', path: ['rows', index],
        message: 'reversal rows must be unique and canonically ordered by person'
      });
    }
  }
});

export const engagementSeedResultSchema = z.strictObject({
  action: z.enum(['seed', 'seed_reversal']),
  sessionId: engagementIdSchema,
  submissionId: engagementIdSchema,
  seeded: z.array(engagementHeadSchema).max(ENGAGEMENT_SEED_PERSONS_MAX),
  skippedPersonIds: z.array(engagementIdSchema).max(ENGAGEMENT_SEED_PERSONS_MAX),
  removedPersonIds: z.array(engagementIdSchema).max(ENGAGEMENT_SEED_PERSONS_MAX)
});

/** Exact selector and inert plan an operator needs to review, propose, and commit one response draft. */
export const engagementChangeDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: engagementResponseActionSchema,
  changesetId: engagementIdSchema,
  headVersion: engagementVersionSchema,
  status: z.literal('draft'),
  revision: z.strictObject({
    id: engagementIdSchema,
    number: engagementVersionSchema,
    digestSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  riskTier: z.literal('consequential'),
  approvalPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    requirement: z.literal('none')
  }),
  safeDiff: engagementSafeDiffSchema
}).superRefine((data, context) => {
  if (data.safeDiff.action !== data.action) {
    context.addIssue({
      code: 'custom', path: ['safeDiff', 'action'],
      message: 'Draft action and safe diff action must match.'
    });
  }
});

export const engagementSnapshotReadInputSchema = z.strictObject({});
export const engagementSnapshotReadResultSchema =
  createReadOperationResultSchema(engagementSnapshotSchema);
export const engagementChangeDraftOperationResultSchema =
  createEffectfulOperationResultSchema(engagementChangeDraftDataSchema);

export const ENGAGEMENT_OPERATION_SCHEMA_REFS = Object.freeze({
  snapshotRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.engagement.snapshot-read.input',
    inputSchema: engagementSnapshotReadInputSchema,
    resultKey: 'schema.engagement.snapshot-read.operator-result',
    resultSchema: engagementSnapshotReadResultSchema
  }),
  changeDraft: createOperationSchemaManifestRefs({
    inputKey: 'schema.engagement.change-draft.input',
    inputSchema: engagementAuthorInputSchema,
    resultKey: 'schema.engagement.change-draft.operator-result',
    resultSchema: engagementChangeDraftOperationResultSchema
  })
});

export type EngagementScopeDto = z.infer<typeof engagementScopeSchema>;
export type EngagementState = z.infer<typeof engagementStateSchema>;
export type EngagementConfirmationAttribution =
  z.infer<typeof engagementConfirmationAttributionSchema>;
export type EngagementSeedProvenanceDto = z.infer<typeof engagementSeedProvenanceSchema>;
export type EngagementCancellationRequestDto = z.infer<typeof engagementCancellationRequestSchema>;
export type EngagementConfirmationDto = z.infer<typeof engagementConfirmationSchema>;
export type EngagementHeadDto = z.infer<typeof engagementHeadSchema>;
export type EngagementSnapshotDto = z.infer<typeof engagementSnapshotSchema>;
export type EngagementAuthorInput = z.infer<typeof engagementAuthorInputSchema>;
export type EngagementResponseAction = z.infer<typeof engagementResponseActionSchema>;
export type EngagementMutationPlanningInput =
  z.infer<typeof engagementMutationPlanningInputSchema>;
export type EngagementMutationPlanDto = z.infer<typeof engagementMutationPlanSchema>;
export type EngagementRestorePlanDto = z.infer<typeof engagementRestorePlanSchema>;
export type EngagementSafeDiffDto = z.infer<typeof engagementSafeDiffSchema>;
export type EngagementMutationResult = z.infer<typeof engagementMutationResultSchema>;
export type EngagementSeedInputDto = z.infer<typeof engagementSeedInputSchema>;
export type EngagementSeedPlanDto = z.infer<typeof engagementSeedPlanSchema>;
export type EngagementSeedReversalPlanDto = z.infer<typeof engagementSeedReversalPlanSchema>;
export type EngagementSeedResultDto = z.infer<typeof engagementSeedResultSchema>;
export type EngagementChangeDraftData = z.infer<typeof engagementChangeDraftDataSchema>;
