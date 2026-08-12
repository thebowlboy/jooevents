import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { canonicalJsonText, isApplicationId } from '@jooevents/kernel';
import {
  isSealedReliabilityContribution,
  type ReliabilityOutboxPointerPlan,
  type ReliabilityTimelinePlan,
  type SealedReliabilityContribution
} from '../../../reliability/src/contribution';

/** Test-only schema whose SQL objects are isolated under the `_trial` namespace. */
export const RELIABILITY_FACT_EFFECT_TRIAL_SQL = `
CREATE TABLE _trial_reliability_aggregates (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  aggregate_kind TEXT NOT NULL CHECK(length(aggregate_kind) BETWEEN 1 AND 160),
  aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 0),
  last_fact_sequence INTEGER NOT NULL CHECK(last_fact_sequence >= 0),
  PRIMARY KEY (workspace_id, event_id, aggregate_kind, aggregate_id)
) WITHOUT ROWID;

CREATE TABLE _trial_reliability_operation_receipts (
  receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) = 36),
  producer_kind TEXT NOT NULL CHECK(producer_kind IN ('operation', 'changeset_operation')),
  producer_key TEXT NOT NULL CHECK(length(producer_key) BETWEEN 1 AND 160),
  producer_version INTEGER NOT NULL CHECK(producer_version > 0),
  contribution_digest_sha256 TEXT NOT NULL CHECK(
    length(contribution_digest_sha256) = 64
    AND contribution_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  resulting_aggregate_version INTEGER NOT NULL CHECK(resulting_aggregate_version > 0),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0)
);

CREATE TABLE _trial_reliability_timeline (
  timeline_id TEXT PRIMARY KEY CHECK(length(timeline_id) = 36),
  receipt_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  subjects_json TEXT NOT NULL CHECK(json_valid(subjects_json)),
  causation_json TEXT NOT NULL CHECK(json_valid(causation_json)),
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'domain_fact', 'effect_specification', 'outbox_pointer'
  )),
  source_id TEXT NOT NULL CHECK(length(source_id) = 36),
  definition_kind TEXT NOT NULL CHECK(definition_kind IN (
    'domain_fact', 'effect', 'outbox_pointer'
  )),
  definition_key TEXT NOT NULL CHECK(length(definition_key) BETWEEN 1 AND 160),
  definition_version INTEGER NOT NULL CHECK(definition_version > 0),
  definition_digest_sha256 TEXT,
  CHECK(
    (source_kind = 'outbox_pointer' AND definition_kind = 'outbox_pointer'
      AND definition_digest_sha256 IS NULL)
    OR
    (source_kind = 'domain_fact' AND definition_kind = 'domain_fact'
      AND length(definition_digest_sha256) = 64
      AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*')
    OR
    (source_kind = 'effect_specification' AND definition_kind = 'effect'
      AND length(definition_digest_sha256) = 64
      AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  UNIQUE (timeline_id, receipt_id, source_kind, source_id),
  UNIQUE (receipt_id, source_kind, source_id),
  FOREIGN KEY (receipt_id)
    REFERENCES _trial_reliability_operation_receipts(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE _trial_reliability_domain_facts (
  fact_id TEXT PRIMARY KEY CHECK(length(fact_id) = 36),
  receipt_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL UNIQUE,
  timeline_source_kind TEXT NOT NULL DEFAULT 'domain_fact' CHECK(timeline_source_kind = 'domain_fact'),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  definition_key TEXT NOT NULL CHECK(length(definition_key) BETWEEN 1 AND 160),
  definition_version INTEGER NOT NULL CHECK(definition_version > 0),
  definition_digest_sha256 TEXT NOT NULL CHECK(
    length(definition_digest_sha256) = 64
    AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  producer_kind TEXT NOT NULL CHECK(producer_kind IN ('operation', 'changeset_operation')),
  producer_key TEXT NOT NULL CHECK(length(producer_key) BETWEEN 1 AND 160),
  producer_version INTEGER NOT NULL CHECK(producer_version > 0),
  metadata_schema_key TEXT NOT NULL CHECK(length(metadata_schema_key) BETWEEN 1 AND 160),
  metadata_schema_version INTEGER NOT NULL CHECK(metadata_schema_version > 0),
  metadata_schema_digest_sha256 TEXT NOT NULL CHECK(length(metadata_schema_digest_sha256) = 64),
  aggregate_kind TEXT NOT NULL CHECK(length(aggregate_kind) BETWEEN 1 AND 160),
  aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) = 36),
  aggregate_sequence INTEGER NOT NULL CHECK(aggregate_sequence > 0),
  resulting_aggregate_version INTEGER NOT NULL CHECK(resulting_aggregate_version > 0),
  safe_references_json TEXT NOT NULL CHECK(json_valid(safe_references_json)),
  classified_payload_refs_json TEXT NOT NULL CHECK(json_valid(classified_payload_refs_json)),
  UNIQUE (
    workspace_id, event_id, aggregate_kind, aggregate_id, aggregate_sequence
  ),
  UNIQUE (
    workspace_id, event_id, aggregate_kind, aggregate_id, resulting_aggregate_version
  ),
  FOREIGN KEY (receipt_id)
    REFERENCES _trial_reliability_operation_receipts(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (timeline_id, receipt_id, timeline_source_kind, fact_id)
    REFERENCES _trial_reliability_timeline(
      timeline_id, receipt_id, source_kind, source_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE _trial_reliability_effect_specifications (
  effect_specification_id TEXT PRIMARY KEY CHECK(length(effect_specification_id) = 36),
  receipt_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL UNIQUE,
  timeline_source_kind TEXT NOT NULL DEFAULT 'effect_specification'
    CHECK(timeline_source_kind = 'effect_specification'),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  definition_key TEXT NOT NULL CHECK(length(definition_key) BETWEEN 1 AND 160),
  definition_version INTEGER NOT NULL CHECK(definition_version > 0),
  definition_digest_sha256 TEXT NOT NULL CHECK(length(definition_digest_sha256) = 64),
  producer_kind TEXT NOT NULL CHECK(producer_kind IN ('operation', 'changeset_operation')),
  producer_key TEXT NOT NULL CHECK(length(producer_key) BETWEEN 1 AND 160),
  producer_version INTEGER NOT NULL CHECK(producer_version > 0),
  specification_schema_key TEXT NOT NULL CHECK(length(specification_schema_key) BETWEEN 1 AND 160),
  specification_schema_version INTEGER NOT NULL CHECK(specification_schema_version > 0),
  specification_schema_digest_sha256 TEXT NOT NULL CHECK(length(specification_schema_digest_sha256) = 64),
  target_job_key TEXT NOT NULL CHECK(length(target_job_key) BETWEEN 1 AND 160),
  target_job_version INTEGER NOT NULL CHECK(target_job_version > 0),
  target_job_digest_sha256 TEXT NOT NULL CHECK(length(target_job_digest_sha256) = 64),
  target_operation_key TEXT NOT NULL CHECK(length(target_operation_key) BETWEEN 1 AND 160),
  target_operation_version INTEGER NOT NULL CHECK(target_operation_version > 0),
  target_capability_revision_id TEXT NOT NULL CHECK(length(target_capability_revision_id) = 36),
  effect_authority_definition_key TEXT NOT NULL CHECK(length(effect_authority_definition_key) BETWEEN 1 AND 160),
  effect_authority_definition_version INTEGER NOT NULL CHECK(effect_authority_definition_version > 0),
  effect_authority_citation_id TEXT NOT NULL CHECK(length(effect_authority_citation_id) = 36),
  job_authority_definition_key TEXT NOT NULL CHECK(length(job_authority_definition_key) BETWEEN 1 AND 160),
  job_authority_definition_version INTEGER NOT NULL CHECK(job_authority_definition_version > 0),
  safe_references_json TEXT NOT NULL CHECK(json_valid(safe_references_json)),
  classified_payload_refs_json TEXT NOT NULL CHECK(json_valid(classified_payload_refs_json)),
  FOREIGN KEY (receipt_id)
    REFERENCES _trial_reliability_operation_receipts(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (timeline_id, receipt_id, timeline_source_kind, effect_specification_id)
    REFERENCES _trial_reliability_timeline(
      timeline_id, receipt_id, source_kind, source_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE _trial_reliability_outbox_pointers (
  pointer_id TEXT PRIMARY KEY CHECK(length(pointer_id) = 36),
  receipt_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL UNIQUE,
  timeline_source_kind TEXT NOT NULL DEFAULT 'outbox_pointer'
    CHECK(timeline_source_kind = 'outbox_pointer'),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('domain_fact', 'effect_specification')),
  source_id TEXT NOT NULL CHECK(length(source_id) = 36),
  target_job_key TEXT,
  target_job_version INTEGER,
  target_job_digest_sha256 TEXT,
  CHECK(
    (source_kind = 'domain_fact' AND target_job_key IS NULL
      AND target_job_version IS NULL AND target_job_digest_sha256 IS NULL)
    OR
    (source_kind = 'effect_specification'
      AND length(target_job_key) BETWEEN 1 AND 160
      AND target_job_version > 0
      AND length(target_job_digest_sha256) = 64)
  ),
  UNIQUE (receipt_id, source_kind, source_id),
  FOREIGN KEY (receipt_id)
    REFERENCES _trial_reliability_operation_receipts(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (timeline_id, receipt_id, timeline_source_kind, pointer_id)
    REFERENCES _trial_reliability_timeline(
      timeline_id, receipt_id, source_kind, source_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER _trial_reliability_aggregates_exact_advance
BEFORE UPDATE ON _trial_reliability_aggregates
WHEN NOT (
  NEW.workspace_id = OLD.workspace_id
  AND NEW.event_id = OLD.event_id
  AND NEW.aggregate_kind = OLD.aggregate_kind
  AND NEW.aggregate_id = OLD.aggregate_id
  AND NEW.version = OLD.version + 1
  AND NEW.last_fact_sequence = OLD.last_fact_sequence + 1
)
BEGIN
  SELECT RAISE(ABORT, 'trial aggregate requires one exact version and fact-sequence advance');
END;

CREATE TRIGGER _trial_reliability_aggregates_no_delete
BEFORE DELETE ON _trial_reliability_aggregates
BEGIN
  SELECT RAISE(ABORT, 'trial aggregates cannot be deleted');
END;

CREATE TRIGGER _trial_reliability_facts_require_exact_head_and_producer
BEFORE INSERT ON _trial_reliability_domain_facts
WHEN NOT EXISTS (
  SELECT 1 FROM _trial_reliability_aggregates
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id
     AND aggregate_kind = NEW.aggregate_kind AND aggregate_id = NEW.aggregate_id
     AND version = NEW.resulting_aggregate_version
     AND last_fact_sequence = NEW.aggregate_sequence
) OR NOT EXISTS (
  SELECT 1 FROM _trial_reliability_operation_receipts
   WHERE receipt_id = NEW.receipt_id
     AND producer_kind = NEW.producer_kind
     AND producer_key = NEW.producer_key
     AND producer_version = NEW.producer_version
     AND resulting_aggregate_version = NEW.resulting_aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'trial fact requires exact aggregate head, sequence, producer, and receipt');
END;

CREATE TRIGGER _trial_reliability_effects_require_exact_producer
BEFORE INSERT ON _trial_reliability_effect_specifications
WHEN NOT EXISTS (
  SELECT 1 FROM _trial_reliability_operation_receipts
   WHERE receipt_id = NEW.receipt_id
     AND producer_kind = NEW.producer_kind
     AND producer_key = NEW.producer_key
     AND producer_version = NEW.producer_version
)
BEGIN
  SELECT RAISE(ABORT, 'trial effect requires the exact receipt producer');
END;

CREATE TRIGGER _trial_reliability_pointers_require_fact
BEFORE INSERT ON _trial_reliability_outbox_pointers
WHEN NEW.source_kind = 'domain_fact' AND NOT EXISTS (
  SELECT 1 FROM _trial_reliability_domain_facts
   WHERE fact_id = NEW.source_id AND receipt_id = NEW.receipt_id
)
BEGIN
  SELECT RAISE(ABORT, 'trial fact pointer requires its exact committed fact');
END;

CREATE TRIGGER _trial_reliability_pointers_require_effect
BEFORE INSERT ON _trial_reliability_outbox_pointers
WHEN NEW.source_kind = 'effect_specification' AND NOT EXISTS (
  SELECT 1 FROM _trial_reliability_effect_specifications
   WHERE effect_specification_id = NEW.source_id
     AND receipt_id = NEW.receipt_id
     AND target_job_key = NEW.target_job_key
     AND target_job_version = NEW.target_job_version
     AND target_job_digest_sha256 = NEW.target_job_digest_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'trial effect pointer requires its exact authorized effect target');
END;

CREATE TRIGGER _trial_reliability_receipts_no_update
BEFORE UPDATE ON _trial_reliability_operation_receipts
BEGIN
  SELECT RAISE(ABORT, 'trial operation receipts are immutable');
END;
CREATE TRIGGER _trial_reliability_receipts_no_delete
BEFORE DELETE ON _trial_reliability_operation_receipts
BEGIN
  SELECT RAISE(ABORT, 'trial operation receipts are immutable');
END;

CREATE TRIGGER _trial_reliability_timeline_no_update
BEFORE UPDATE ON _trial_reliability_timeline
BEGIN
  SELECT RAISE(ABORT, 'trial timeline rows are immutable');
END;
CREATE TRIGGER _trial_reliability_timeline_no_delete
BEFORE DELETE ON _trial_reliability_timeline
BEGIN
  SELECT RAISE(ABORT, 'trial timeline rows are immutable');
END;

CREATE TRIGGER _trial_reliability_facts_no_update
BEFORE UPDATE ON _trial_reliability_domain_facts
BEGIN
  SELECT RAISE(ABORT, 'trial domain facts are immutable');
END;
CREATE TRIGGER _trial_reliability_facts_no_delete
BEFORE DELETE ON _trial_reliability_domain_facts
BEGIN
  SELECT RAISE(ABORT, 'trial domain facts are immutable');
END;

CREATE TRIGGER _trial_reliability_effects_no_update
BEFORE UPDATE ON _trial_reliability_effect_specifications
BEGIN
  SELECT RAISE(ABORT, 'trial effect specifications are immutable');
END;
CREATE TRIGGER _trial_reliability_effects_no_delete
BEFORE DELETE ON _trial_reliability_effect_specifications
BEGIN
  SELECT RAISE(ABORT, 'trial effect specifications are immutable');
END;

CREATE TRIGGER _trial_reliability_pointers_no_update
BEFORE UPDATE ON _trial_reliability_outbox_pointers
BEGIN
  SELECT RAISE(ABORT, 'trial outbox pointers are immutable');
END;
CREATE TRIGGER _trial_reliability_pointers_no_delete
BEFORE DELETE ON _trial_reliability_outbox_pointers
BEGIN
  SELECT RAISE(ABORT, 'trial outbox pointers are immutable');
END;
`;

export type ReliabilityFactEffectTrialFailurePoint =
  | 'after_domain'
  | 'after_receipt'
  | 'after_fact_timeline'
  | 'after_fact'
  | 'after_fact_pointer_timeline'
  | 'after_fact_pointer'
  | 'after_effect_timeline'
  | 'after_effect'
  | 'after_effect_pointer_timeline'
  | 'after_effect_pointer'
  | 'after_coverage'
  | 'after_commit_response_loss';

export interface ReliabilityFactEffectTrialControl {
  readonly failAt?: ReliabilityFactEffectTrialFailurePoint;
}

export type ReliabilityFactEffectTrialCommitResult =
  | { readonly kind: 'committed'; readonly receiptId: string; readonly resultingVersion: number }
  | { readonly kind: 'replay'; readonly receiptId: string; readonly resultingVersion: number };

export class ReliabilityFactEffectTrialError extends Error {
  constructor(
    readonly code:
      | 'unsealed_contribution'
      | 'unsupported_scope'
      | 'receipt_conflict'
      | 'stale_aggregate'
      | 'timeline_coverage'
      | 'injected_failure',
    message: string
  ) {
    super(message);
    this.name = 'ReliabilityFactEffectTrialError';
  }
}

interface ReceiptRow {
  readonly contribution_digest_sha256: string;
  readonly resulting_aggregate_version: number;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value)).digest('hex');
}

function changedExactlyOnce(result: { readonly changes: number }, code: string): void {
  if (result.changes !== 1) throw new ReliabilityFactEffectTrialError('stale_aggregate', code);
}

function inject(control: ReliabilityFactEffectTrialControl, point: ReliabilityFactEffectTrialFailurePoint): void {
  if (control.failAt === point) {
    throw new ReliabilityFactEffectTrialError('injected_failure', `injected:${point}`);
  }
}

function receiptId(contribution: SealedReliabilityContribution): string {
  return contribution.context.causation.receiptId;
}

function occurredAtMs(contribution: SealedReliabilityContribution): number {
  const value = Date.parse(contribution.context.occurredAt);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReliabilityFactEffectTrialError('unsupported_scope', 'Invalid contribution occurrence time.');
  }
  return value;
}

function eventScope(contribution: SealedReliabilityContribution) {
  const scope = contribution.context.scope;
  if (scope.kind !== 'event') {
    throw new ReliabilityFactEffectTrialError(
      'unsupported_scope',
      'The disposable fact/effect proof requires one event scope.'
    );
  }
  return scope;
}

export function installReliabilityFactEffectTrialSchema(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA busy_timeout = 1000;');
  sqlite.exec(RELIABILITY_FACT_EFFECT_TRIAL_SQL);
}

export class SQLiteTrialReliabilityFactEffectPort {
  constructor(private readonly sqlite: Database) {
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    this.sqlite.exec('PRAGMA busy_timeout = 1000;');
  }

  seedAggregate(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly aggregateKind: string;
    readonly aggregateId: string;
    readonly version?: number;
    readonly lastFactSequence?: number;
  }): void {
    if (!isApplicationId(input.workspaceId) || !isApplicationId(input.eventId)
      || !isApplicationId(input.aggregateId)) {
      throw new TypeError('invalid_trial_aggregate_identity');
    }
    this.sqlite.query<never, [string, string, string, string, number, number]>(`
      INSERT INTO _trial_reliability_aggregates (
        workspace_id, event_id, aggregate_kind, aggregate_id, version, last_fact_sequence
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.workspaceId,
      input.eventId,
      input.aggregateKind,
      input.aggregateId,
      input.version ?? 0,
      input.lastFactSequence ?? 0
    );
  }

  commit(
    contribution: SealedReliabilityContribution,
    control: ReliabilityFactEffectTrialControl = {}
  ): ReliabilityFactEffectTrialCommitResult {
    if (!isSealedReliabilityContribution(contribution)) {
      throw new ReliabilityFactEffectTrialError(
        'unsealed_contribution',
        'The SQLite trial accepts only a sealed reliability contribution.'
      );
    }
    const scope = eventScope(contribution);
    const id = receiptId(contribution);
    const contributionDigest = digest(contribution);
    const resultingVersion = contribution.fact.aggregate.resultingVersion;
    let ownsTransaction = false;
    let committed = false;
    try {
      this.sqlite.exec('BEGIN IMMEDIATE;');
      ownsTransaction = true;
      const existing = this.sqlite.query<ReceiptRow, [string]>(`
        SELECT contribution_digest_sha256, resulting_aggregate_version
          FROM _trial_reliability_operation_receipts
         WHERE receipt_id = ?
      `).get(id);
      if (existing) {
        if (existing.contribution_digest_sha256 !== contributionDigest
          || existing.resulting_aggregate_version !== resultingVersion) {
          throw new ReliabilityFactEffectTrialError(
            'receipt_conflict',
            'The receipt identity already owns different canonical contribution bytes.'
          );
        }
        this.sqlite.exec('COMMIT;');
        ownsTransaction = false;
        return { kind: 'replay', receiptId: id, resultingVersion };
      }

      changedExactlyOnce(this.sqlite.query<never, [number, number, string, string, string, string, number, number]>(`
        UPDATE _trial_reliability_aggregates
           SET version = ?, last_fact_sequence = ?
         WHERE workspace_id = ? AND event_id = ?
           AND aggregate_kind = ? AND aggregate_id = ?
           AND version = ? AND last_fact_sequence = ?
      `).run(
        resultingVersion,
        contribution.fact.aggregate.sequence,
        scope.workspaceId,
        scope.eventId,
        contribution.fact.aggregate.kind,
        contribution.fact.aggregate.id,
        contribution.fact.aggregate.priorVersion,
        contribution.fact.aggregate.sequence - 1
      ), 'The aggregate version or fact sequence is stale.');
      inject(control, 'after_domain');

      this.sqlite.query<never, [string, string, string, number, string, number, number]>(`
        INSERT INTO _trial_reliability_operation_receipts (
          receipt_id, producer_kind, producer_key, producer_version,
          contribution_digest_sha256, resulting_aggregate_version, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        contribution.context.producer.kind,
        contribution.context.producer.operation.key,
        contribution.context.producer.operation.version,
        contributionDigest,
        resultingVersion,
        occurredAtMs(contribution)
      );
      inject(control, 'after_receipt');

      const factTimeline = this.timelineFor(contribution, 'domain_fact', contribution.fact.id);
      this.insertTimeline(id, factTimeline);
      inject(control, 'after_fact_timeline');
      this.sqlite.query<never, [
        string, string, string, string, string, string, number, string, string, string,
        number, string, number, string, string, string, number, number, string, string
      ]>(`
        INSERT INTO _trial_reliability_domain_facts (
          fact_id, receipt_id, timeline_id, workspace_id, event_id,
          definition_key, definition_version, definition_digest_sha256,
          producer_kind, producer_key, producer_version,
          metadata_schema_key, metadata_schema_version, metadata_schema_digest_sha256,
          aggregate_kind, aggregate_id, aggregate_sequence, resulting_aggregate_version,
          safe_references_json, classified_payload_refs_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        contribution.fact.id,
        id,
        factTimeline.id,
        scope.workspaceId,
        scope.eventId,
        contribution.fact.definition.reference.key,
        contribution.fact.definition.reference.version,
        contribution.fact.definition.canonicalDigestSha256,
        contribution.context.producer.kind,
        contribution.context.producer.operation.key,
        contribution.context.producer.operation.version,
        contribution.fact.metadataSchema.key,
        contribution.fact.metadataSchema.version,
        contribution.fact.metadataSchema.canonicalSchemaDigestSha256,
        contribution.fact.aggregate.kind,
        contribution.fact.aggregate.id,
        contribution.fact.aggregate.sequence,
        resultingVersion,
        canonicalJsonText(contribution.fact.input.safeReferences),
        canonicalJsonText(contribution.fact.input.classifiedPayloadRefs)
      );
      inject(control, 'after_fact');

      const factPointer = this.pointerFor(contribution, 'domain_fact', contribution.fact.id);
      const factPointerTimeline = this.timelineFor(contribution, 'outbox_pointer', factPointer.id);
      this.insertTimeline(id, factPointerTimeline);
      inject(control, 'after_fact_pointer_timeline');
      this.insertPointer(id, factPointer, factPointerTimeline.id);
      inject(control, 'after_fact_pointer');

      if (contribution.effect) {
        const effectTimeline = this.timelineFor(
          contribution,
          'effect_specification',
          contribution.effect.id
        );
        this.insertTimeline(id, effectTimeline);
        inject(control, 'after_effect_timeline');
        this.sqlite.query<never, [
          string, string, string, string, string, string, number, string, string, string,
          number, string, number, string, string, number, string, string, number, string,
          string, number, string, string, number, string, string
        ]>(`
          INSERT INTO _trial_reliability_effect_specifications (
            effect_specification_id, receipt_id, timeline_id, workspace_id, event_id,
            definition_key, definition_version, definition_digest_sha256,
            producer_kind, producer_key, producer_version,
            specification_schema_key, specification_schema_version,
            specification_schema_digest_sha256,
            target_job_key, target_job_version, target_job_digest_sha256,
            target_operation_key, target_operation_version, target_capability_revision_id,
            effect_authority_definition_key, effect_authority_definition_version,
            effect_authority_citation_id,
            job_authority_definition_key, job_authority_definition_version,
            safe_references_json, classified_payload_refs_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          contribution.effect.id,
          id,
          effectTimeline.id,
          scope.workspaceId,
          scope.eventId,
          contribution.effect.definition.reference.key,
          contribution.effect.definition.reference.version,
          contribution.effect.definition.canonicalDigestSha256,
          contribution.context.producer.kind,
          contribution.context.producer.operation.key,
          contribution.context.producer.operation.version,
          contribution.effect.specificationSchema.key,
          contribution.effect.specificationSchema.version,
          contribution.effect.specificationSchema.canonicalSchemaDigestSha256,
          contribution.effect.targetJob.reference.key,
          contribution.effect.targetJob.reference.version,
          contribution.effect.targetJob.canonicalDigestSha256,
          contribution.effect.targetJob.targetOperation.key,
          contribution.effect.targetJob.targetOperation.version,
          contribution.effect.targetJob.capabilityRevisionId,
          contribution.effect.authorization.definition.key,
          contribution.effect.authorization.definition.version,
          contribution.effect.authorization.id,
          contribution.effect.targetJob.authorityCitation.key,
          contribution.effect.targetJob.authorityCitation.version,
          canonicalJsonText(contribution.effect.input.safeReferences),
          canonicalJsonText(contribution.effect.input.classifiedPayloadRefs)
        );
        inject(control, 'after_effect');

        const effectPointer = this.pointerFor(
          contribution,
          'effect_specification',
          contribution.effect.id
        );
        const effectPointerTimeline = this.timelineFor(
          contribution,
          'outbox_pointer',
          effectPointer.id
        );
        this.insertTimeline(id, effectPointerTimeline);
        inject(control, 'after_effect_pointer_timeline');
        this.insertPointer(id, effectPointer, effectPointerTimeline.id);
        inject(control, 'after_effect_pointer');
      }

      this.assertTimelineCoverage(id, contribution.timeline.length);
      inject(control, 'after_coverage');
      this.sqlite.exec('COMMIT;');
      ownsTransaction = false;
      committed = true;
    } catch (error) {
      if (ownsTransaction && this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK;');
      throw error;
    }
    if (committed) inject(control, 'after_commit_response_loss');
    return { kind: 'committed', receiptId: id, resultingVersion };
  }

  private timelineFor(
    contribution: SealedReliabilityContribution,
    sourceKind: ReliabilityTimelinePlan['source']['kind'],
    sourceId: string
  ): ReliabilityTimelinePlan {
    const matches = contribution.timeline.filter(
      (entry) => entry.source.kind === sourceKind && entry.source.id === sourceId
    );
    if (matches.length !== 1) {
      throw new ReliabilityFactEffectTrialError(
        'timeline_coverage',
        'Each source requires exactly one sealed timeline entry.'
      );
    }
    return matches[0] as ReliabilityTimelinePlan;
  }

  private pointerFor(
    contribution: SealedReliabilityContribution,
    sourceKind: ReliabilityOutboxPointerPlan['source']['kind'],
    sourceId: string
  ): ReliabilityOutboxPointerPlan {
    const matches = contribution.pointers.filter(
      (pointer) => pointer.source.kind === sourceKind && pointer.source.id === sourceId
    );
    if (matches.length !== 1) {
      throw new ReliabilityFactEffectTrialError(
        'timeline_coverage',
        'Each fact/effect source requires exactly one sealed outbox pointer.'
      );
    }
    return matches[0] as ReliabilityOutboxPointerPlan;
  }

  private insertTimeline(receiptId: string, timeline: ReliabilityTimelinePlan): void {
    const scope = timeline.context.scope;
    if (scope.kind !== 'event') {
      throw new ReliabilityFactEffectTrialError('unsupported_scope', 'Timeline scope must be event-scoped.');
    }
    this.sqlite.query<never, [
      string, string, number, string, string, string, string, string,
      string, string, string, string, number, string | null
    ]>(`
      INSERT INTO _trial_reliability_timeline (
        timeline_id, receipt_id, occurred_at_ms, workspace_id, event_id,
        actor_json, subjects_json, causation_json,
        source_kind, source_id, definition_kind, definition_key,
        definition_version, definition_digest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      timeline.id,
      receiptId,
      Date.parse(timeline.context.occurredAt),
      scope.workspaceId,
      scope.eventId,
      canonicalJsonText(timeline.context.actor),
      canonicalJsonText(timeline.context.subjects),
      canonicalJsonText(timeline.context.causation),
      timeline.source.kind,
      timeline.source.id,
      timeline.kind.kind,
      timeline.kind.key,
      timeline.kind.version,
      timeline.definitionDigestSha256 ?? null
    );
  }

  private insertPointer(
    receiptId: string,
    pointer: ReliabilityOutboxPointerPlan,
    timelineId: string
  ): void {
    this.sqlite.query<never, [
      string, string, string, string, string, string | null, number | null, string | null
    ]>(`
      INSERT INTO _trial_reliability_outbox_pointers (
        pointer_id, receipt_id, timeline_id, source_kind, source_id,
        target_job_key, target_job_version, target_job_digest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pointer.id,
      receiptId,
      timelineId,
      pointer.source.kind,
      pointer.source.id,
      pointer.targetJob?.reference.key ?? null,
      pointer.targetJob?.reference.version ?? null,
      pointer.targetJob?.canonicalDigestSha256 ?? null
    );
  }

  private assertTimelineCoverage(receiptId: string, expected: number): void {
    const row = this.sqlite.query<{
      readonly timeline_count: number;
      readonly orphan_count: number;
      readonly family_count: number;
    }, [string, string, string, string, string]>(`
      SELECT
        (SELECT count(*) FROM _trial_reliability_timeline WHERE receipt_id = ?) AS timeline_count,
        (SELECT count(*)
           FROM _trial_reliability_timeline AS timeline
          WHERE timeline.receipt_id = ? AND NOT (
            (timeline.source_kind = 'domain_fact' AND EXISTS (
              SELECT 1 FROM _trial_reliability_domain_facts AS fact
               WHERE fact.timeline_id = timeline.timeline_id
                 AND fact.receipt_id = timeline.receipt_id
                 AND fact.fact_id = timeline.source_id
            )) OR
            (timeline.source_kind = 'effect_specification' AND EXISTS (
              SELECT 1 FROM _trial_reliability_effect_specifications AS effect
               WHERE effect.timeline_id = timeline.timeline_id
                 AND effect.receipt_id = timeline.receipt_id
                 AND effect.effect_specification_id = timeline.source_id
            )) OR
            (timeline.source_kind = 'outbox_pointer' AND EXISTS (
              SELECT 1 FROM _trial_reliability_outbox_pointers AS pointer
               WHERE pointer.timeline_id = timeline.timeline_id
                 AND pointer.receipt_id = timeline.receipt_id
                 AND pointer.pointer_id = timeline.source_id
            ))
          )) AS orphan_count,
        ((SELECT count(*) FROM _trial_reliability_domain_facts WHERE receipt_id = ?)
          + (SELECT count(*) FROM _trial_reliability_effect_specifications WHERE receipt_id = ?)
          + (SELECT count(*) FROM _trial_reliability_outbox_pointers WHERE receipt_id = ?)
        ) AS family_count
    `).get(receiptId, receiptId, receiptId, receiptId, receiptId);
    if (!row || row.timeline_count !== expected || row.family_count !== expected || row.orphan_count !== 0) {
      throw new ReliabilityFactEffectTrialError(
        'timeline_coverage',
        'Every immutable family row requires exactly one same-transaction timeline row.'
      );
    }
  }
}
