import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAuthorityCitationId,
  parseChangesetId,
  parseChangesetRevisionId,
  parseContractVersion,
  parseDomainFactId,
  parseEffectSpecificationId,
  parseEventId,
  parseInstant,
  parseOperationReceiptId,
  parseOutboxPointerId,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  composeReliabilityContribution,
  createDomainFactContributionPlanner,
  createEffectSpecificationContributionPlanner,
  sealReliabilityContributionContext,
  type ExactReliabilityDefinitionBinding,
  type SealedReliabilityContribution
} from '../../../reliability/src/contribution';
import {
  definitionRef,
  parseDefinitionKey,
  schemaRef,
  type DomainFactDefinition,
  type EffectDefinition,
  type JobDefinition,
  type ProducerRef
} from '../../../reliability/src/definitions';
import {
  buildReliabilityRegistry,
  sealReliabilityDefinition
} from '../../../reliability/src/registry';
import { jobDefinition } from '../../../reliability/src/test-fixtures';
import {
  SQLiteTrialReliabilityFactEffectPort,
  installReliabilityFactEffectTrialSchema,
  type ReliabilityFactEffectTrialFailurePoint
} from './reliability-fact-effect-trial';

const schemaDigest = 'a'.repeat(64);
const producer: ProducerRef = {
  kind: 'changeset_operation',
  operation: definitionRef('changeset_operation', 'event.commit', 1)
};
const authorityCitation = definitionRef(
  'authority_citation',
  'message.effect.authority',
  1
);
const trustedCitationId = parseAuthorityCitationId('01890f47-9abc-7def-8123-456789abc010');
const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('01890f47-9abc-7def-8123-456789abc001');
const userId = parseUserId('01890f47-9abc-7def-8123-456789abc002');
const aggregateId = '01890f47-9abc-7def-8123-456789abc003';

const sourceCanaries = [
  'raw-authority-evidence-canary',
  'classified-content-canary',
  'provider-request-text-canary',
  'provider-response-text-canary',
  'business-result-canary'
] as const;

function uuid(value: number): string {
  return `018f0f47-7a86-7d36-8a25-${value.toString(16).padStart(12, '0')}`;
}

async function factDefinition(): Promise<DomainFactDefinition> {
  return sealReliabilityDefinition({
    kind: 'domain_fact',
    key: parseDefinitionKey('event.changed'),
    version: parseContractVersion(1),
    metadataSchema: schemaRef('schema.event.changed', 1, schemaDigest),
    producers: [producer],
    aggregateKind: parseDefinitionKey('event'),
    subjectIdentity: definitionRef('subject_identity', 'event.subject', 1),
    scope: definitionRef('scope', 'event.scope', 1),
    causalParent: definitionRef('causal_parent', 'changeset.receipt', 1),
    consumerCompatibility: definitionRef('consumer_compatibility', 'exact.source', 1),
    classifiedPayloadPaths: ['/classifiedPayloadRefs'],
    redaction: definitionRef('redaction', 'event.fact', 1)
  });
}

async function effectDefinition(job: JobDefinition): Promise<EffectDefinition> {
  return sealReliabilityDefinition({
    kind: 'effect',
    key: parseDefinitionKey('message.requested'),
    version: parseContractVersion(1),
    specificationSchema: schemaRef('schema.message.effect', 1, schemaDigest),
    providerAttemptSchema: schemaRef('schema.message.attempt', 1, 'b'.repeat(64)),
    producers: [producer],
    targetJob: definitionRef('job', job.key, job.version),
    reducer: definitionRef('reducer', 'message.result', 1),
    authorityCitation,
    retry: definitionRef('retry', 'provider.anchor.inspect', 1),
    cancellation: definitionRef('cancellation', 'message.cancel', 1)
  });
}

function exact<Kind extends 'domain_fact' | 'effect' | 'job'>(
  definition: { readonly kind: Kind; readonly key: string; readonly version: number; readonly canonicalDigestSha256: string }
): ExactReliabilityDefinitionBinding<Kind> {
  return {
    reference: definitionRef(definition.kind, definition.key, definition.version),
    canonicalDigestSha256: definition.canonicalDigestSha256 as never
  };
}

interface BuildOptions {
  readonly base: number;
  readonly factOnly?: boolean;
  readonly receiptId?: string;
  readonly priorVersion?: number;
  readonly sequence?: number;
  readonly resultingVersion?: number;
}

async function buildContribution(options: BuildOptions): Promise<{
  readonly contribution: SealedReliabilityContribution;
  readonly job: JobDefinition;
  readonly payloadRefId: string;
}> {
  const job = await jobDefinition();
  const factDefinitionValue = await factDefinition();
  const effectDefinitionValue = await effectDefinition(job);
  const registry = await buildReliabilityRegistry([
    factDefinitionValue,
    effectDefinitionValue,
    job
  ]);
  const receiptId = parseOperationReceiptId(options.receiptId ?? uuid(options.base));
  const payloadRefId = parsePayloadRefId(uuid(options.base + 1));
  const classifiedPayloadBytes = new Map([[payloadRefId, sourceCanaries[1]]]);
  const authorityEvidence = new Map([[trustedCitationId, sourceCanaries[0]]]);
  const context = sealReliabilityContributionContext({
    producer,
    occurredAt: parseInstant('2026-08-11T00:00:00.000Z'),
    actor: { kind: 'workspace_user', userId },
    scope: { kind: 'event', workspaceId, eventId },
    subjects: [
      { kind: 'workspace', id: workspaceId },
      { kind: 'event', id: eventId },
      { kind: 'domain', domain: 'event', entity: 'event', id: aggregateId }
    ],
    causation: {
      kind: 'changeset_revision',
      receiptId,
      changesetId: parseChangesetId(uuid(options.base + 2)),
      revisionId: parseChangesetRevisionId(uuid(options.base + 3)),
      revisionDigestSha256: 'c'.repeat(64) as never
    }
  });
  const facts = await createDomainFactContributionPlanner({
    registry,
    definition: exact(factDefinitionValue),
    producer,
    newFactId: () => parseDomainFactId(uuid(options.base + 4))
  });
  const fact = facts.plan({
    context,
    aggregate: {
      id: aggregateId,
      priorVersion: options.priorVersion ?? 0,
      sequence: options.sequence ?? 1,
      resultingVersion: options.resultingVersion ?? 1
    },
    input: {
      safeReferences: [{
        kind: 'purpose',
        key: parseDefinitionKey('message.acceptance'),
        version: parseContractVersion(1),
        opaqueId: aggregateId
      }],
      classifiedPayloadRefs: [{ id: payloadRefId }]
    }
  });
  const identifiers = {
    factTimelineId: uuid(options.base + 6),
    factPointerId: parseOutboxPointerId(uuid(options.base + 7)),
    factPointerTimelineId: uuid(options.base + 8)
  };
  if (options.factOnly) {
    expect(classifiedPayloadBytes.get(payloadRefId)).toBe(sourceCanaries[1]);
    return {
      contribution: composeReliabilityContribution({ fact, identifiers }),
      job,
      payloadRefId
    };
  }
  const effects = await createEffectSpecificationContributionPlanner({
    registry,
    definition: exact(effectDefinitionValue),
    targetJob: exact(job),
    producer,
    authorityCitation,
    citationVerifier: {
      isTrusted: ({ citationId }) => authorityEvidence.get(citationId) === sourceCanaries[0]
    },
    newEffectSpecificationId: () => parseEffectSpecificationId(uuid(options.base + 5))
  });
  const authorization = await effects.authorize({
    context,
    authorityCitation,
    authorityCitationId: trustedCitationId
  });
  const effect = effects.plan({
    context,
    authorization,
    input: {
      safeReferences: [{
        kind: 'destination',
        key: parseDefinitionKey('message.acceptance.recipient'),
        version: parseContractVersion(1),
        opaqueId: aggregateId
      }],
      classifiedPayloadRefs: [{ id: payloadRefId }]
    }
  });
  expect(classifiedPayloadBytes.get(payloadRefId)).toBe(sourceCanaries[1]);
  return {
    contribution: composeReliabilityContribution({
      fact,
      effect,
      identifiers: {
        ...identifiers,
        effectTimelineId: uuid(options.base + 9),
        effectPointerId: parseOutboxPointerId(uuid(options.base + 10)),
        effectPointerTimelineId: uuid(options.base + 11)
      }
    }),
    job,
    payloadRefId
  };
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()?.count ?? -1;
}

function historyCounts(sqlite: Database) {
  return {
    receipts: count(sqlite, '_trial_reliability_operation_receipts'),
    timeline: count(sqlite, '_trial_reliability_timeline'),
    facts: count(sqlite, '_trial_reliability_domain_facts'),
    effects: count(sqlite, '_trial_reliability_effect_specifications'),
    pointers: count(sqlite, '_trial_reliability_outbox_pointers')
  };
}

function aggregateState(sqlite: Database) {
  return sqlite.query<{
    readonly version: number;
    readonly last_fact_sequence: number;
  }, []>('SELECT version, last_fact_sequence FROM _trial_reliability_aggregates').get();
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function cellText(value: unknown): string {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value === null || value === undefined) return '';
  return String(value);
}

function everyTrialSqlCell(sqlite: Database): string {
  const schemaRows = sqlite.query<Record<string, unknown>, []>(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_schema
     WHERE name GLOB '_trial*'
     ORDER BY type, name
  `).all();
  const cells = schemaRows.flatMap((row) => Object.values(row).map(cellText));
  for (const schema of schemaRows) {
    if (schema.type !== 'table' || typeof schema.name !== 'string') continue;
    const columns = sqlite.query<{ readonly name: string }, []>(
      `PRAGMA table_info(${quotedIdentifier(schema.name)})`
    ).all().map((column) => column.name);
    const rows = sqlite.query<Record<string, unknown>, []>(
      `SELECT ${columns.map(quotedIdentifier).join(', ')} FROM ${quotedIdentifier(schema.name)}`
    ).all();
    cells.push(...rows.flatMap((row) => Object.values(row).map(cellText)));
  }
  return cells.join('\n');
}

function seed(port: SQLiteTrialReliabilityFactEffectPort): void {
  port.seedAggregate({
    workspaceId,
    eventId,
    aggregateKind: 'event',
    aggregateId
  });
}

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('disposable SQLite fact/effect authority proof', () => {
  test('atomically commits exact fact/effect/pointers with receipt parents and universal timeline coverage', async () => {
    const target = await buildContribution({ base: 100 });
    const sqlite = new Database(':memory:', { strict: true });
    try {
      installReliabilityFactEffectTrialSchema(sqlite);
      const port = new SQLiteTrialReliabilityFactEffectPort(sqlite);
      seed(port);
      expect(port.commit(target.contribution)).toEqual({
        kind: 'committed',
        receiptId: target.contribution.context.causation.receiptId,
        resultingVersion: 1
      });
      expect(aggregateState(sqlite)).toEqual({ version: 1, last_fact_sequence: 1 });
      expect(historyCounts(sqlite)).toEqual({
        receipts: 1, timeline: 4, facts: 1, effects: 1, pointers: 2
      });
      expect(sqlite.query<{
        readonly target_job_key: string;
        readonly target_job_version: number;
        readonly target_job_digest_sha256: string;
        readonly target_operation_key: string;
        readonly effect_authority_definition_key: string;
        readonly effect_authority_citation_id: string;
      }, []>(`
        SELECT target_job_key, target_job_version, target_job_digest_sha256,
               target_operation_key, effect_authority_definition_key,
               effect_authority_citation_id
          FROM _trial_reliability_effect_specifications
      `).get()).toEqual({
        target_job_key: target.job.key,
        target_job_version: target.job.version,
        target_job_digest_sha256: target.job.canonicalDigestSha256,
        target_operation_key: target.job.targetOperation.key,
        effect_authority_definition_key: authorityCitation.key,
        effect_authority_citation_id: trustedCitationId
      });
      expect(sqlite.query<{
        readonly source_kind: string;
        readonly target_job_key: string | null;
      }, []>(`
        SELECT source_kind, target_job_key
          FROM _trial_reliability_outbox_pointers
         ORDER BY source_kind
      `).all()).toEqual([
        { source_kind: 'domain_fact', target_job_key: null },
        { source_kind: 'effect_specification', target_job_key: target.job.key }
      ]);
      expect(sqlite.query<unknown, []>('PRAGMA foreign_key_check').all()).toEqual([]);
      for (const table of [
        '_trial_reliability_timeline',
        '_trial_reliability_domain_facts',
        '_trial_reliability_effect_specifications',
        '_trial_reliability_outbox_pointers'
      ]) {
        expect(sqlite.query<{ readonly table: string }, []>(
          `PRAGMA foreign_key_list(${quotedIdentifier(table)})`
        ).all().map((foreignKey) => foreignKey.table))
          .toContain('_trial_reliability_operation_receipts');
      }
      const coverage = sqlite.query<{ readonly source_kind: string; readonly count: number }, []>(`
        SELECT source_kind, count(*) AS count
          FROM _trial_reliability_timeline
         GROUP BY source_kind ORDER BY source_kind
      `).all();
      expect(coverage).toEqual([
        { source_kind: 'domain_fact', count: 1 },
        { source_kind: 'effect_specification', count: 1 },
        { source_kind: 'outbox_pointer', count: 2 }
      ]);

      const immutableTables = [
        { table: '_trial_reliability_operation_receipts', identity: 'receipt_id' },
        { table: '_trial_reliability_timeline', identity: 'timeline_id' },
        { table: '_trial_reliability_domain_facts', identity: 'fact_id' },
        {
          table: '_trial_reliability_effect_specifications',
          identity: 'effect_specification_id'
        },
        { table: '_trial_reliability_outbox_pointers', identity: 'pointer_id' }
      ] as const;
      for (const { table, identity } of immutableTables) {
        expect(() => sqlite.query(
          `UPDATE ${table} SET ${identity} = ${identity}`
        ).run()).toThrow('immutable');
        expect(() => sqlite.query(`DELETE FROM ${table}`).run()).toThrow('immutable');
      }

      const allCells = everyTrialSqlCell(sqlite);
      expect(allCells).toContain(target.payloadRefId);
      for (const canary of sourceCanaries) expect(allCells).not.toContain(canary);
    } finally {
      sqlite.close();
    }
  });

  test('rolls domain, receipt, fact, effect, pointers, and timeline back at every write boundary', async () => {
    const target = await buildContribution({ base: 200 });
    const failurePoints: readonly ReliabilityFactEffectTrialFailurePoint[] = [
      'after_domain',
      'after_receipt',
      'after_fact_timeline',
      'after_fact',
      'after_fact_pointer_timeline',
      'after_fact_pointer',
      'after_effect_timeline',
      'after_effect',
      'after_effect_pointer_timeline',
      'after_effect_pointer',
      'after_coverage'
    ];
    for (const failAt of failurePoints) {
      const sqlite = new Database(':memory:', { strict: true });
      try {
        installReliabilityFactEffectTrialSchema(sqlite);
        const port = new SQLiteTrialReliabilityFactEffectPort(sqlite);
        seed(port);
        expect(() => port.commit(target.contribution, { failAt }))
          .toThrow(`injected:${failAt}`);
        expect(aggregateState(sqlite)).toEqual({ version: 0, last_fact_sequence: 0 });
        expect(historyCounts(sqlite)).toEqual({
          receipts: 0, timeline: 0, facts: 0, effects: 0, pointers: 0
        });
      } finally {
        sqlite.close();
      }
    }
  });

  test('survives committed response loss, reopens, exact-replays, and conflicts on changed bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-fact-effect-trial-'));
    temporaryDirectories.add(directory);
    const path = join(directory, 'fact-effect.sqlite');
    const target = await buildContribution({ base: 300 });
    const conflicting = await buildContribution({
      base: 400,
      receiptId: target.contribution.context.causation.receiptId
    });
    let sqlite = new Database(path, { strict: true, create: true });
    try {
      installReliabilityFactEffectTrialSchema(sqlite);
      let port = new SQLiteTrialReliabilityFactEffectPort(sqlite);
      seed(port);
      expect(() => port.commit(target.contribution, { failAt: 'after_commit_response_loss' }))
        .toThrow('injected:after_commit_response_loss');
      expect(historyCounts(sqlite)).toEqual({
        receipts: 1, timeline: 4, facts: 1, effects: 1, pointers: 2
      });
      sqlite.close();

      sqlite = new Database(path, { strict: true });
      port = new SQLiteTrialReliabilityFactEffectPort(sqlite);
      expect(port.commit(target.contribution)).toMatchObject({ kind: 'replay' });
      expect(() => port.commit(conflicting.contribution)).toThrow(
        expect.objectContaining({ code: 'receipt_conflict' })
      );
      expect(historyCounts(sqlite)).toEqual({
        receipts: 1, timeline: 4, facts: 1, effects: 1, pointers: 2
      });
      expect(aggregateState(sqlite)).toEqual({ version: 1, last_fact_sequence: 1 });
    } finally {
      sqlite.close(false);
    }
  });

  test('allows exactly one aggregate sequence winner and refuses a sequence gap', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-fact-sequence-trial-'));
    temporaryDirectories.add(directory);
    const path = join(directory, 'sequence.sqlite');
    const first = await buildContribution({ base: 500 });
    const second = await buildContribution({ base: 600 });
    const gap = await buildContribution({
      base: 700,
      priorVersion: 1,
      sequence: 3,
      resultingVersion: 2
    });
    const firstSqlite = new Database(path, { strict: true, create: true });
    const secondSqlite = new Database(path, { strict: true });
    try {
      installReliabilityFactEffectTrialSchema(firstSqlite);
      const firstPort = new SQLiteTrialReliabilityFactEffectPort(firstSqlite);
      const secondPort = new SQLiteTrialReliabilityFactEffectPort(secondSqlite);
      seed(firstPort);
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => firstPort.commit(first.contribution)),
        Promise.resolve().then(() => secondPort.commit(second.contribution))
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
        reason: { code: 'stale_aggregate' }
      });
      expect(aggregateState(firstSqlite)).toEqual({ version: 1, last_fact_sequence: 1 });
      expect(historyCounts(firstSqlite)).toEqual({
        receipts: 1, timeline: 4, facts: 1, effects: 1, pointers: 2
      });
      expect(() => firstPort.commit(gap.contribution)).toThrow(
        expect.objectContaining({ code: 'stale_aggregate' })
      );
    } finally {
      secondSqlite.close();
      firstSqlite.close();
    }
  });

  test('a fact-only contribution creates no effect or external-work pointer', async () => {
    const target = await buildContribution({ base: 800, factOnly: true });
    const sqlite = new Database(':memory:', { strict: true });
    try {
      installReliabilityFactEffectTrialSchema(sqlite);
      const port = new SQLiteTrialReliabilityFactEffectPort(sqlite);
      seed(port);
      expect(port.commit(target.contribution)).toMatchObject({ kind: 'committed' });
      expect(historyCounts(sqlite)).toEqual({
        receipts: 1, timeline: 2, facts: 1, effects: 0, pointers: 1
      });
      expect(sqlite.query<{ readonly count: number }, []>(`
        SELECT count(*) AS count
          FROM _trial_reliability_outbox_pointers
         WHERE target_job_key IS NOT NULL
      `).get()?.count).toBe(0);
      expect(everyTrialSqlCell(sqlite)).not.toContain('message.dispatch.execute');
    } finally {
      sqlite.close();
    }
  });
});
