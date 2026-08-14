import {
  defineChangesetReadPort,
  defineChangesetTransactionPort,
  defineChangesetValidationPort
} from '@jooevents/changesets';
import {
  engagementSeedInputSchema,
  engagementSeedPlanSchema,
  engagementSeedProvenanceSchema,
  engagementSeedResultSchema,
  engagementSeedReversalPlanSchema,
  type EngagementSeedInputDto,
  type EngagementSeedPlanDto,
  type EngagementSeedProvenanceDto,
  type EngagementSeedResultDto,
  type EngagementSeedReversalPlanDto
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import {
  deterministicEngagementId,
  parseEngagementHead,
  parseEngagementScope,
  type EngagementReadPort
} from './model';

/**
 * One engagement contribution a hosting acceptance commit embeds so the roster
 * write it carries seeds `invited` engagements atomically with its own commit.
 * The grammar is total: any committed roster write from an acceptance-shaped
 * act seeds one `invited` engagement per person, skip-existing on the
 * `(sessionId, personId)` pair, and nothing else ever writes an engagement
 * outside that unit of work. Every seeded row is stamped with the hosting
 * acceptance's own written decision head (`seededByDecision`), so a later
 * compensation removes exactly the rows its own commit inserted. The seed
 * plans and applies inside the hosting transaction; its identity is
 * deterministic, so a replanned seed over unchanged state is byte-identical
 * and replay is idempotent.
 */
export type EngagementSeedContribution = EngagementSeedPlanDto;

export type EngagementSeedErrorCode =
  | 'wrong_scope'
  | 'seed_stale'
  | 'seed_row_missing'
  | 'engagement_advanced'
  | 'invalid_plan';

export class EngagementSeedError extends Error {
  constructor(
    readonly code: EngagementSeedErrorCode,
    readonly personId?: string
  ) {
    super(code);
    this.name = 'EngagementSeedError';
  }
}

export interface EngagementSeedChangeInput {
  readonly scope: EngagementSeedInputDto['scope'];
  readonly sessionId: string;
  readonly submissionId: string;
  /** The hosting acceptance's own written decision head, stamped on every seeded row. */
  readonly seededByDecision: EngagementSeedProvenanceDto;
  readonly source: EngagementSeedInputDto['source'];
  readonly personIds: readonly string[];
  readonly invitedAt: string;
  readonly respondBy: string | null;
}

export interface EngagementSeedReversalInput {
  readonly scope: EngagementSeedInputDto['scope'];
  readonly sessionId: string;
  readonly submissionId: string;
  /** The reverted acceptance's own written decision head; only its rows are selected. */
  readonly seededByDecision: EngagementSeedProvenanceDto;
}

export type EngagementSeedValidation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused'; readonly code: EngagementSeedErrorCode };

export interface EngagementSeedPlanningPort extends EngagementReadPort {
  planEngagementSeed(input: EngagementSeedChangeInput): EngagementSeedContribution;
  planEngagementSeedReversal(input: EngagementSeedReversalInput): EngagementSeedReversalPlanDto;
}

export interface EngagementSeedValidationPort extends EngagementReadPort {
  validateEngagementSeed(contribution: EngagementSeedContribution): EngagementSeedValidation;
  validateEngagementSeedReversal(plan: EngagementSeedReversalPlanDto): EngagementSeedValidation;
}

export interface EngagementSeedTransactionPort extends EngagementReadPort {
  applyEngagementSeed(contribution: EngagementSeedContribution): EngagementSeedResultDto;
  applyEngagementSeedReversal(plan: EngagementSeedReversalPlanDto): EngagementSeedResultDto;
}

export const engagementSeedPlanningPort = defineChangesetReadPort<EngagementSeedPlanningPort>(
  'engagement_seed.planning', 1
);
export const engagementSeedValidationPort =
  defineChangesetValidationPort<EngagementSeedValidationPort>(
    'engagement_seed.validation', 1
  );
export const engagementSeedTransactionPort =
  defineChangesetTransactionPort<EngagementSeedTransactionPort>(
    'engagement_seed.transaction', 1
  );

/**
 * Plans one seed over current state: every person without an engagement on the
 * target Session gains an exact `invited` version-one image; every existing
 * `(sessionId, personId)` pair is skipped untouched, whatever its state or
 * provenance. Person ids are deduplicated and canonically ordered here so the
 * plan is deterministic in its input order.
 */
export function planEngagementSeedFrom(
  port: EngagementReadPort,
  input: EngagementSeedChangeInput
): EngagementSeedContribution {
  const scope = parseEngagementScope(input.scope);
  const seedInput = engagementSeedInputSchema.parse({
    scope,
    sessionId: input.sessionId,
    submissionId: input.submissionId,
    seededByDecision: input.seededByDecision,
    source: input.source,
    personIds: [...new Set(input.personIds)].sort(),
    invitedAt: input.invitedAt,
    respondBy: input.respondBy
  });
  const rows = [];
  const skippedPersonIds = [];
  for (const personId of seedInput.personIds) {
    const existing = port.readSessionPersonEngagement(scope, seedInput.sessionId, personId);
    if (existing) {
      skippedPersonIds.push(personId);
      continue;
    }
    rows.push({
      personId,
      head: parseEngagementHead({
        schemaVersion: 1,
        id: deterministicEngagementId(scope, seedInput.sessionId, personId),
        scope,
        sessionId: seedInput.sessionId,
        personId,
        submissionId: seedInput.submissionId,
        seededByDecision: seedInput.seededByDecision,
        state: 'invited',
        invitedAt: seedInput.invitedAt,
        respondBy: seedInput.respondBy,
        confirmation: null,
        cancellationRequest: null,
        cancelledAt: null,
        source: seedInput.source,
        version: 1
      })
    });
  }
  return engagementSeedPlanSchema.parse({ input: seedInput, rows, skippedPersonIds });
}

export function validateEngagementSeedFrom(
  port: EngagementReadPort,
  contribution: EngagementSeedContribution
): EngagementSeedValidation {
  let rebuilt: EngagementSeedContribution;
  try {
    rebuilt = planEngagementSeedFrom(port, contribution.input);
  } catch (error) {
    return Object.freeze({
      kind: 'refused',
      code: error instanceof EngagementSeedError ? error.code : 'invalid_plan'
    });
  }
  return canonical(rebuilt) === canonical(contribution)
    ? Object.freeze({ kind: 'ready' })
    : Object.freeze({ kind: 'refused', code: 'seed_stale' });
}

export function applyEngagementSeedFrom(
  port: EngagementSeedTransactionPort,
  contribution: EngagementSeedContribution
): EngagementSeedResultDto {
  return port.applyEngagementSeed(engagementSeedPlanSchema.parse(contribution));
}

/**
 * Plans the compensating removal of exactly the rows one acceptance seeded:
 * current engagements on the Session whose `submissionId` cites the reverted
 * submission AND whose `seededByDecision` pin is the reverted acceptance's own
 * written decision head. Skipped pairs kept their original provenance, so they
 * never appear here — including rows a PREVIOUS acceptance of the same
 * submission seeded and a stays-standing compensation deliberately preserved;
 * those carry that acceptance's pin and are ignored whatever their state. Any
 * selected row that moved past its `invited` version-one image — a
 * confirmation, decline, cancellation request, or later cancellation —
 * refuses `engagement_advanced`, blocking the hosting compensation rather than
 * destroying a recorded human response.
 */
export function planEngagementSeedReversalFrom(
  port: EngagementReadPort,
  input: EngagementSeedReversalInput
): EngagementSeedReversalPlanDto {
  const scope = parseEngagementScope(input.scope);
  const pin = engagementSeedProvenanceSchema.parse(input.seededByDecision);
  const seeded = port.listSeededEngagements(scope, input.sessionId, input.submissionId);
  const rows = seeded
    .filter((head) => head.seededByDecision !== null
      && head.seededByDecision.version === pin.version
      && head.seededByDecision.digestSha256 === pin.digestSha256)
    .map((head) => {
      if (head.state !== 'invited' || head.version !== 1
          || head.confirmation !== null || head.cancellationRequest !== null) {
        throw new EngagementSeedError('engagement_advanced', head.personId);
      }
      return { personId: head.personId, expectedCurrent: head };
    });
  return engagementSeedReversalPlanSchema.parse({
    action: 'seed_reversal',
    scope,
    sessionId: input.sessionId,
    submissionId: input.submissionId,
    seededByDecision: pin,
    rows
  });
}

export function validateEngagementSeedReversalFrom(
  port: EngagementReadPort,
  plan: EngagementSeedReversalPlanDto
): EngagementSeedValidation {
  let rebuilt: EngagementSeedReversalPlanDto;
  try {
    rebuilt = planEngagementSeedReversalFrom(port, {
      scope: plan.scope,
      sessionId: plan.sessionId,
      submissionId: plan.submissionId,
      seededByDecision: plan.seededByDecision
    });
  } catch (error) {
    return Object.freeze({
      kind: 'refused',
      code: error instanceof EngagementSeedError ? error.code : 'invalid_plan'
    });
  }
  return canonical(rebuilt) === canonical(plan)
    ? Object.freeze({ kind: 'ready' })
    : Object.freeze({ kind: 'refused', code: 'seed_stale' });
}

export function applyEngagementSeedReversalFrom(
  port: EngagementSeedTransactionPort,
  plan: EngagementSeedReversalPlanDto
): EngagementSeedResultDto {
  return port.applyEngagementSeedReversal(engagementSeedReversalPlanSchema.parse(plan));
}

/** Deterministic result payload for one applied seed. */
export function engagementSeedResultFromPlan(
  contribution: EngagementSeedContribution
): EngagementSeedResultDto {
  return engagementSeedResultSchema.parse({
    action: 'seed',
    sessionId: contribution.input.sessionId,
    submissionId: contribution.input.submissionId,
    seeded: contribution.rows.map((row) => row.head),
    skippedPersonIds: contribution.skippedPersonIds,
    removedPersonIds: []
  });
}

export function engagementSeedResultFromReversal(
  plan: EngagementSeedReversalPlanDto
): EngagementSeedResultDto {
  return engagementSeedResultSchema.parse({
    action: 'seed_reversal',
    sessionId: plan.sessionId,
    submissionId: plan.submissionId,
    seeded: [],
    skippedPersonIds: [],
    removedPersonIds: plan.rows.map((row) => row.personId)
  });
}

function canonical(value: unknown): string {
  return Buffer.from(encodeCanonicalJson(value)).toString('utf8');
}
