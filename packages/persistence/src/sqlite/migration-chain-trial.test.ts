import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readVerifiedSQLiteArtifact, sha256Hex } from './migration-artifact';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';
import {
  compileSQLiteTrialMigrationManifest,
  runSQLiteTrialMigrationChain,
  sqliteTrialReceiptSetDigest,
  sqliteTrialVerifierRowsDigest,
  sqliteTrialVerifierSetDigest,
  type SQLiteTrialArtifactInput,
  type SQLiteTrialMigrationEntry,
  type SQLiteTrialMigrationManifestInput,
  type SQLiteTrialMigrationVerifierDefinition,
  type SQLiteTrialPredecessorLineage
} from './migration-chain-trial';
import { SQLiteFoundationError } from './foundation-errors';
import { captureSQLiteSchema, fingerprintSQLiteSchema } from './schema-snapshot';

const EPOCH_ONE = Object.freeze([
  Object.freeze({
    migrationId: 'e1_0001_trial_notes',
    sql: `
      CREATE TABLE trial_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      ) STRICT;
    `,
    verifierIds: Object.freeze([] as string[])
  }),
  Object.freeze({
    migrationId: 'e1_0002_trial_archive',
    sql: `
      ALTER TABLE trial_notes
        ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
    `,
    verifierIds: Object.freeze(['verify.archived'])
  })
]);

const EPOCH_TWO_BASELINE_SQL = `CREATE TABLE trial_notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'archived'))
) STRICT;
CREATE INDEX trial_notes_state_idx ON trial_notes (state, id);`;

const EPOCH_TWO = Object.freeze([
  Object.freeze({
    migrationId: 'e2_0001_trial_notes',
    sql: EPOCH_TWO_BASELINE_SQL,
    verifierIds: Object.freeze([] as string[])
  }),
  Object.freeze({
    migrationId: 'e2_0002_trial_versions',
    sql: `
      ALTER TABLE trial_notes
        ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
    `,
    verifierIds: Object.freeze(['verify.version'])
  })
]);

const BRIDGE_SQL = `ALTER TABLE trial_notes RENAME TO trial_notes_epoch_one;
${EPOCH_TWO_BASELINE_SQL}
  INSERT INTO trial_notes (id, title, state)
    SELECT id, title, CASE archived WHEN 1 THEN 'archived' ELSE 'active' END
      FROM trial_notes_epoch_one;
  DROP TABLE trial_notes_epoch_one;
`;

const VERIFIER_DEFINITIONS: Readonly<Record<string, SQLiteTrialMigrationVerifierDefinition>> = Object.freeze({
  'verify.archived': Object.freeze({
    id: 'verify.archived',
    selectSql: "select count(*) as count from pragma_table_xinfo('trial_notes') where name = 'archived'",
    expectedRowsDigestSha256: sqliteTrialVerifierRowsDigest([{ count: 1 }])
  }),
  'verify.bridge': Object.freeze({
    id: 'verify.bridge',
    selectSql: "select count(*) as count from trial_notes where state not in ('active', 'archived')",
    expectedRowsDigestSha256: sqliteTrialVerifierRowsDigest([{ count: 0 }])
  }),
  'verify.version': Object.freeze({
    id: 'verify.version',
    selectSql: "select count(*) as count from pragma_table_xinfo('trial_notes') where name = 'version'",
    expectedRowsDigestSha256: sqliteTrialVerifierRowsDigest([{ count: 1 }])
  })
});

const bootstrap = readVerifiedSQLiteArtifact(
  SQLITE_MIGRATION_MANIFEST.bootstrap.artifact,
  SQLITE_MIGRATION_MANIFEST.bootstrap.checksumSha256
);

function artifact(sql: string): SQLiteTrialArtifactInput {
  const bytes = Buffer.from(sql, 'utf8');
  return Object.freeze({ bytes, checksumSha256: sha256Hex(bytes) });
}

function buildManifestInput(
  schemaEpoch: number,
  definitions: readonly {
    readonly migrationId: string;
    readonly sql: string;
    readonly verifierIds: readonly string[];
  }[],
  lineages: readonly SQLiteTrialPredecessorLineage[] = []
): SQLiteTrialMigrationManifestInput {
  const database = new Database(':memory:', { create: true, strict: true });
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    const expectedEmptyApplicationFingerprint = fingerprintSQLiteSchema(
      captureSQLiteSchema(database, 'application')
    );
    database.exec(bootstrap.sql);
    const expectedRunnerFingerprint = fingerprintSQLiteSchema(captureSQLiteSchema(database, 'runner'));
    const migrations: SQLiteTrialMigrationEntry[] = [];
    definitions.forEach((definition, index) => {
      const expectedBeforeApplicationFingerprint = fingerprintSQLiteSchema(
        captureSQLiteSchema(database, 'application')
      );
      database.exec(definition.sql);
      const expectedAfterApplicationFingerprint = fingerprintSQLiteSchema(
        captureSQLiteSchema(database, 'application')
      );
      const prior = migrations[index - 1];
      migrations.push(Object.freeze({
        migrationId: definition.migrationId,
        schemaEpoch,
        sequence: index + 1,
        dialect: 'sqlite',
        artifact: artifact(definition.sql),
        atomicity: 'transactional',
        dependsOn: prior === undefined ? null : Object.freeze({
          migrationId: prior.migrationId,
          schemaEpoch: prior.schemaEpoch,
          sequence: prior.sequence
        }),
        expectedBeforeApplicationFingerprint,
        expectedAfterApplicationFingerprint,
        targetedVerifierIds: Object.freeze([...definition.verifierIds])
      }));
    });
    const terminal = migrations.at(-1);
    if (!terminal) throw new Error('Fixture requires at least one migration.');
    const verifierIds = [...new Set([
      ...migrations.flatMap((migration) => migration.targetedVerifierIds),
      ...lineages.flatMap((lineage) => lineage.targetedVerifierIds)
    ])].sort();
    const verifiers = verifierIds.map((id) => {
      const definition = VERIFIER_DEFINITIONS[id];
      if (!definition) throw new Error(`Missing verifier fixture ${id}.`);
      return definition;
    });
    return Object.freeze({
      formatVersion: 1,
      runnerVersion: 1,
      dialect: 'sqlite',
      bootstrap: Object.freeze({
        artifact: Object.freeze({
          bytes: Buffer.from(bootstrap.bytes),
          checksumSha256: bootstrap.checksumSha256
        }),
        expectedRunnerFingerprint
      }),
      migrations: Object.freeze(migrations),
      expectedEmptyApplicationFingerprint,
      expectedCurrentApplicationFingerprint: terminal.expectedAfterApplicationFingerprint,
      expectedCurrentFullFingerprint: fingerprintSQLiteSchema(captureSQLiteSchema(database, 'full')),
      verifiers: Object.freeze(verifiers),
      acceptedPredecessorLineages: Object.freeze([...lineages])
    });
  } finally {
    database.close();
  }
}

function expectFoundationError(
  work: () => unknown,
  code: SQLiteFoundationError['code']
): SQLiteFoundationError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SQLiteFoundationError);
    expect((error as SQLiteFoundationError).code).toBe(code);
    return error as SQLiteFoundationError;
  }
  throw new Error(`Expected ${code}`);
}

function sourceReceiptDigest(input: SQLiteTrialMigrationManifestInput): string {
  return sqliteTrialReceiptSetDigest(input.migrations.map((entry) => ({
    migrationId: entry.migrationId,
    schemaEpoch: entry.schemaEpoch,
    sequence: entry.sequence,
    dialect: 'sqlite' as const,
    checksumSha256: entry.artifact.checksumSha256,
    receiptKind: 'executed' as const
  })));
}

function destinationManifest(
  source: SQLiteTrialMigrationManifestInput,
  overrides: Partial<SQLiteTrialPredecessorLineage> = {}
): SQLiteTrialMigrationManifestInput {
  const base = buildManifestInput(2, EPOCH_TWO);
  const baseline = base.migrations[0];
  const terminal = source.migrations.at(-1);
  if (!baseline || !terminal) throw new Error('Fixture manifest is incomplete.');
  const verifierIds = Object.freeze(['verify.bridge']);
  const lineage: SQLiteTrialPredecessorLineage = Object.freeze({
    transitionId: 'transition.e1-to-e2.trial',
    lineageId: 'lineage.epoch-one.trial',
    dialect: 'sqlite',
    sourceTerminal: Object.freeze({
      migrationId: terminal.migrationId,
      schemaEpoch: terminal.schemaEpoch,
      sequence: terminal.sequence
    }),
    sourceReceiptSetDigestSha256: sourceReceiptDigest(source),
    sourceApplicationFingerprint: source.expectedCurrentApplicationFingerprint,
    destinationBaseline: Object.freeze({
      migrationId: baseline.migrationId,
      schemaEpoch: baseline.schemaEpoch,
      sequence: baseline.sequence
    }),
    bridgeArtifactId: 'bridge.e1-to-e2.trial',
    bridgeArtifact: artifact(BRIDGE_SQL),
    atomicity: 'transactional',
    targetedVerifierIds: verifierIds,
    verifierSetDigestSha256: sqliteTrialVerifierSetDigest(verifierIds),
    minimumRunnerVersion: 1,
    ...overrides
  });
  return Object.freeze({
    ...base,
    verifiers: Object.freeze([
      VERIFIER_DEFINITIONS['verify.bridge']!,
      ...base.verifiers
    ].sort((left, right) => left.id.localeCompare(right.id))),
    acceptedPredecessorLineages: Object.freeze([lineage])
  });
}

function rowProjection(database: Database): readonly Record<string, unknown>[] {
  return database.query<Record<string, unknown>, []>(`
    select id, title, state, version from trial_notes order by id
  `).all();
}

describe('manifest-driven SQLite migration chain trial', () => {
  test('validates exact dependency order and rejects forged compiled manifests', () => {
    const input = buildManifestInput(1, EPOCH_ONE);
    const compiled = compileSQLiteTrialMigrationManifest(input);
    expect(compiled.currentCoordinate).toEqual({ schemaEpoch: 1, sequence: 2 });

    const second = input.migrations[1];
    if (!second) throw new Error('Missing second migration.');
    const wrongDependency: SQLiteTrialMigrationManifestInput = {
      ...input,
      migrations: Object.freeze([
        input.migrations[0]!,
        Object.freeze({
          ...second,
          dependsOn: Object.freeze({ migrationId: 'e1_0000_wrong', schemaEpoch: 1, sequence: 1 })
        })
      ])
    };
    expectFoundationError(
      () => compileSQLiteTrialMigrationManifest(wrongDependency),
      'invalid_migration_options'
    );

    const first = input.migrations[0];
    if (!first) throw new Error('Missing baseline migration.');
    expectFoundationError(() => compileSQLiteTrialMigrationManifest({
      ...input,
      migrations: Object.freeze([
        Object.freeze({ ...first, artifact: artifact(`${EPOCH_ONE[0]!.sql}\nCOMMIT;`) }),
        second
      ])
    }), 'invalid_migration_options');
    expectFoundationError(() => compileSQLiteTrialMigrationManifest({
      ...input,
      migrations: Object.freeze([
        Object.freeze({ ...first, artifact: artifact(`${EPOCH_ONE[0]!.sql}\nPRAGMA user_version = 2;`) }),
        second
      ])
    }), 'invalid_migration_options');
    expectFoundationError(() => compileSQLiteTrialMigrationManifest({
      ...input,
      migrations: Object.freeze([
        Object.freeze({
          ...first,
          artifact: artifact(`${EPOCH_ONE[0]!.sql}\nATTACH DATABASE ':memory:' AS escaped;`)
        }),
        second
      ])
    }), 'invalid_migration_options');
    expectFoundationError(() => compileSQLiteTrialMigrationManifest({
      ...input,
      migrations: Object.freeze([
        Object.freeze({
          ...first,
          artifact: artifact(`${EPOCH_ONE[0]!.sql}\nCREATE TEMP TABLE 'schema_migrations' (id TEXT);`)
        }),
        second
      ])
    }), 'database_class_mismatch');

    const database = new Database(':memory:', { create: true, strict: true });
    try {
      const forged = Object.freeze({ ...compiled });
      expectFoundationError(
        () => runSQLiteTrialMigrationChain({ database, manifest: forged }),
        'invalid_migration_options'
      );
      expect(database.query<{ count: number }, []>(
        "select count(*) as count from sqlite_schema where name = 'schema_migrations'"
      ).get()?.count).toBe(0);

      database.exec('BEGIN IMMEDIATE;');
      expectFoundationError(
        () => runSQLiteTrialMigrationChain({
          database,
          manifest: compiled
        }),
        'invalid_migration_options'
      );
      database.exec('ROLLBACK;');
      database.exec("ATTACH DATABASE ':memory:' AS attached_trial;");
      expectFoundationError(
        () => runSQLiteTrialMigrationChain({ database, manifest: compiled }),
        'database_class_mismatch'
      );
      database.exec('DETACH DATABASE attached_trial;');
      database.exec("CREATE TEMP TABLE 'schema_migrations' (id TEXT);");
      expectFoundationError(
        () => runSQLiteTrialMigrationChain({ database, manifest: compiled }),
        'database_class_mismatch'
      );
      database.exec('DROP TABLE temp.schema_migrations;');
    } finally {
      database.close();
    }
  });

  test('applies an injected multi-entry chain once and validates targeted invariants', () => {
    const input = buildManifestInput(1, EPOCH_ONE);
    const compiled = compileSQLiteTrialMigrationManifest(input);
    const database = new Database(':memory:', { create: true, strict: true });
    try {
      const applied = runSQLiteTrialMigrationChain({ database, manifest: compiled });
      expect(applied).toMatchObject({
        status: 'applied',
        coordinate: { schemaEpoch: 1, sequence: 2 },
        migrationId: 'e1_0002_trial_archive',
        databaseClass: 'ephemeral',
        receiptCount: 2
      });
      expect(database.query<{ migration_id: string }, []>(`
        select migration_id from schema_migrations order by schema_epoch, sequence
      `).all().map((row) => row.migration_id)).toEqual([
        'e1_0001_trial_notes',
        'e1_0002_trial_archive'
      ]);

      const replay = runSQLiteTrialMigrationChain({ database, manifest: compiled });
      expect(replay.status).toBe('current');
      expect(replay.databaseId).toBe(applied.databaseId);
      expect(database.query<{ count: number }, []>('select count(*) as count from schema_migrations').get()?.count).toBe(2);
    } finally {
      database.close();
    }
  });

  test('rolls back an interrupted migration and resumes from the exact receipt prefix', () => {
    const input = buildManifestInput(1, EPOCH_ONE);
    const compiled = compileSQLiteTrialMigrationManifest(input);
    const database = new Database(':memory:', { create: true, strict: true });
    try {
      expectFoundationError(() => runSQLiteTrialMigrationChain({
        database,
        manifest: compiled,
        fault(point, migration) {
          if (point === 'after_migration_schema_before_receipt' && migration.sequence === 2) {
            throw new Error('simulated process death');
          }
        }
      }), 'migration_transaction_failed');
      expect(database.query<{ count: number }, []>('select count(*) as count from schema_migrations').get()?.count).toBe(1);
      expect(database.query<{ count: number }, []>(`
        select count(*) as count from pragma_table_xinfo('trial_notes') where name = 'archived'
      `).get()?.count).toBe(0);

      const recovered = runSQLiteTrialMigrationChain({ database, manifest: compiled });
      expect(recovered.status).toBe('applied');
      expect(recovered.receiptCount).toBe(2);
      expect(database.query<{ count: number }, []>(`
        select count(*) as count from pragma_table_xinfo('trial_notes') where name = 'archived'
      `).get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test('rolls back application SQL that attempts to poison runner-owned rows', () => {
    const hex = '0'.repeat(64);
    const poisonSql = `${EPOCH_ONE[0]!.sql}
      insert into 'schema_migrations'
        (migration_id, schema_epoch, sequence, dialect, checksum_sha256, receipt_kind,
         source_fingerprint, result_fingerprint, transition_id, runner_version,
         build_identity, applied_at, duration_ms)
      values ('e1_0099_poison', 1, 99, 'sqlite', '${hex}', 'executed', '${hex}', '${hex}',
              null, 1, 'poison-attempt', 0, 0);`;
    const input = buildManifestInput(1, [{
      migrationId: 'e1_0001_trial_poison_guard',
      sql: poisonSql,
      verifierIds: Object.freeze([])
    }]);
    expectFoundationError(
      () => compileSQLiteTrialMigrationManifest(input),
      'receipt_chain_malformed'
    );
  });

  test('survives close/reopen at receipt rollback and post-commit response-loss boundaries', () => {
    const input = buildManifestInput(1, EPOCH_ONE);
    const compiled = compileSQLiteTrialMigrationManifest(input);
    let beforeCommit = new Database(':memory:', { create: true, strict: true });
    let afterCommit = new Database(':memory:', { create: true, strict: true });
    try {
      expectFoundationError(() => runSQLiteTrialMigrationChain({
        database: beforeCommit,
        manifest: compiled,
        fault(point, migration) {
          if (point === 'after_migration_receipt_before_commit' && migration.sequence === 2) {
            throw new Error('receipt boundary crash');
          }
        }
      }), 'migration_transaction_failed');
      const rollbackBytes = beforeCommit.serialize();
      beforeCommit.close();
      beforeCommit = Database.deserialize(rollbackBytes, { strict: true });
      expect(runSQLiteTrialMigrationChain({ database: beforeCommit, manifest: compiled })).toMatchObject({
        status: 'applied',
        receiptCount: 2
      });

      expect(() => runSQLiteTrialMigrationChain({
        database: afterCommit,
        manifest: compiled,
        fault(point, migration) {
          if (point === 'after_commit_before_return' && migration.sequence === 2) {
            throw new Error('response lost after commit');
          }
        }
      })).toThrow('response lost after commit');
      const committedBytes = afterCommit.serialize();
      afterCommit.close();
      afterCommit = Database.deserialize(committedBytes, { strict: true });
      expect(runSQLiteTrialMigrationChain({ database: afterCommit, manifest: compiled })).toMatchObject({
        status: 'current',
        receiptCount: 2
      });
    } finally {
      beforeCommit.close();
      afterCommit.close();
    }
  });

  test('concurrent fresh and bridge runners reclassify under the write lock and converge', () => {
    const sourceInput = buildManifestInput(1, EPOCH_ONE);
    const sourceManifest = compileSQLiteTrialMigrationManifest(sourceInput);
    const destination = compileSQLiteTrialMigrationManifest(destinationManifest(sourceInput));
    const bootstrapUri = 'file:migration_chain_bootstrap_convergence?mode=memory&cache=shared';
    const bootstrapFirst = new Database(bootstrapUri, { create: true, strict: true });
    const bootstrapSecond = new Database(bootstrapUri, { create: true, strict: true });
    const freshUri = 'file:migration_chain_fresh_convergence?mode=memory&cache=shared';
    const freshFirst = new Database(freshUri, { create: true, strict: true });
    const freshSecond = new Database(freshUri, { create: true, strict: true });
    const bridgeUri = 'file:migration_chain_bridge_convergence?mode=memory&cache=shared';
    const bridgeFirst = new Database(bridgeUri, { create: true, strict: true });
    const bridgeSecond = new Database(bridgeUri, { create: true, strict: true });
    try {
      let secondBootstrapState: ReturnType<typeof runSQLiteTrialMigrationChain> | undefined;
      let bootstrapRaced = false;
      const firstBootstrapState = runSQLiteTrialMigrationChain({
        database: bootstrapFirst,
        manifest: sourceManifest,
        fault(point) {
          if (point === 'before_runner_lock' && !bootstrapRaced) {
            bootstrapRaced = true;
            secondBootstrapState = runSQLiteTrialMigrationChain({
              database: bootstrapSecond,
              manifest: sourceManifest
            });
          }
        }
      });
      expect(bootstrapRaced).toBe(true);
      if (!secondBootstrapState) throw new Error('The competing bootstrap runner did not execute.');
      expect(secondBootstrapState.status).toBe('applied');
      expect(firstBootstrapState.status).toBe('current');
      expect(firstBootstrapState.databaseId).toBe(secondBootstrapState.databaseId);
      expect(bootstrapFirst.query<{ count: number }, []>(
        'select count(*) as count from main.schema_migrations'
      ).get()?.count).toBe(2);

      let secondFreshState: ReturnType<typeof runSQLiteTrialMigrationChain> | undefined;
      let freshRaced = false;
      const firstFreshState = runSQLiteTrialMigrationChain({
        database: freshFirst,
        manifest: sourceManifest,
        fault(point) {
          if (point === 'before_migration_lock' && !freshRaced) {
            freshRaced = true;
            secondFreshState = runSQLiteTrialMigrationChain({
              database: freshSecond,
              manifest: sourceManifest
            });
          }
        }
      });
      expect(freshRaced).toBe(true);
      if (!secondFreshState) throw new Error('The competing fresh runner did not execute.');
      expect(secondFreshState.status).toBe('applied');
      expect(firstFreshState.receiptCount).toBe(2);
      expect(firstFreshState.databaseId).toBe(secondFreshState.databaseId);
      expect(freshFirst.query<{ count: number }, []>(
        'select count(*) as count from main.schema_migrations'
      ).get()?.count).toBe(2);

      runSQLiteTrialMigrationChain({ database: bridgeFirst, manifest: sourceManifest });
      let secondBridgeState: ReturnType<typeof runSQLiteTrialMigrationChain> | undefined;
      let bridgeRaced = false;
      const firstBridgeState = runSQLiteTrialMigrationChain({
        database: bridgeFirst,
        manifest: destination,
        fault(point) {
          if (point === 'before_bridge_lock' && !bridgeRaced) {
            bridgeRaced = true;
            secondBridgeState = runSQLiteTrialMigrationChain({
              database: bridgeSecond,
              manifest: destination
            });
          }
        }
      });
      expect(bridgeRaced).toBe(true);
      if (!secondBridgeState) throw new Error('The competing bridge runner did not execute.');
      expect(secondBridgeState.status).toBe('bridged');
      expect(firstBridgeState.status).toBe('current');
      expect(firstBridgeState.databaseId).toBe(secondBridgeState.databaseId);
      expect(bridgeFirst.query<{ count: number }, []>(
        'select count(*) as count from main.schema_epoch_transitions'
      ).get()?.count).toBe(1);
      expect(bridgeFirst.query<{ count: number }, []>(
        'select count(*) as count from main.schema_migrations'
      ).get()?.count).toBe(4);
    } finally {
      bootstrapFirst.close();
      bootstrapSecond.close();
      freshFirst.close();
      freshSecond.close();
      bridgeFirst.close();
      bridgeSecond.close();
    }
  });

  test('bridges an exact predecessor and converges with a fresh newer-epoch build', () => {
    const sourceInput = buildManifestInput(1, EPOCH_ONE);
    const sourceManifest = compileSQLiteTrialMigrationManifest(sourceInput);
    const destinationInput = destinationManifest(sourceInput);
    const destination = compileSQLiteTrialMigrationManifest(destinationInput);
    const bridgedDatabase = new Database(':memory:', { create: true, strict: true });
    const freshDatabase = new Database(':memory:', { create: true, strict: true });
    try {
      runSQLiteTrialMigrationChain({
        database: bridgedDatabase,
        manifest: sourceManifest
      });
      bridgedDatabase.query('insert into trial_notes (id, title, archived) values (?, ?, ?)')
        .run('note_a', 'Active', 0);
      bridgedDatabase.query('insert into trial_notes (id, title, archived) values (?, ?, ?)')
        .run('note_b', 'Archived', 1);

      const bridged = runSQLiteTrialMigrationChain({
        database: bridgedDatabase,
        manifest: destination
      });
      expect(bridged).toMatchObject({
        status: 'bridged',
        coordinate: { schemaEpoch: 2, sequence: 2 },
        receiptCount: 4
      });
      expect(bridgedDatabase.query<{ receipt_kind: string }, []>(`
        select receipt_kind from schema_migrations where migration_id = 'e2_0001_trial_notes'
      `).get()?.receipt_kind).toBe('epoch_bridge');
      expect(bridgedDatabase.query<{ count: number }, []>(
        'select count(*) as count from schema_epoch_transitions'
      ).get()?.count).toBe(1);

      const fresh = runSQLiteTrialMigrationChain({
        database: freshDatabase,
        manifest: destination
      });
      expect(fresh.status).toBe('applied');
      freshDatabase.query('insert into trial_notes (id, title, state) values (?, ?, ?)')
        .run('note_a', 'Active', 'active');
      freshDatabase.query('insert into trial_notes (id, title, state) values (?, ?, ?)')
        .run('note_b', 'Archived', 'archived');

      expect(bridged.applicationFingerprint).toBe(fresh.applicationFingerprint);
      expect(bridged.fullFingerprint).toBe(fresh.fullFingerprint);
      expect(rowProjection(bridgedDatabase)).toEqual(rowProjection(freshDatabase));
      expect(runSQLiteTrialMigrationChain({
        database: bridgedDatabase,
        manifest: destination
      }).status).toBe('current');
    } finally {
      bridgedDatabase.close();
      freshDatabase.close();
    }
  });

  test('rolls back a bridge transition and refuses an unrecognized predecessor set', () => {
    const sourceInput = buildManifestInput(1, EPOCH_ONE);
    const sourceManifest = compileSQLiteTrialMigrationManifest(sourceInput);
    const destination = compileSQLiteTrialMigrationManifest(destinationManifest(sourceInput));
    const interrupted = new Database(':memory:', { create: true, strict: true });
    const malformed = new Database(':memory:', { create: true, strict: true });
    const verifierRejected = new Database(':memory:', { create: true, strict: true });
    try {
      runSQLiteTrialMigrationChain({ database: interrupted, manifest: sourceManifest });
      expectFoundationError(() => runSQLiteTrialMigrationChain({
        database: interrupted,
        manifest: destination,
        fault(point) {
          if (point === 'after_bridge_transition_before_receipt') throw new Error('bridge crash');
        }
      }), 'migration_transaction_failed');
      expect(interrupted.query<{ count: number }, []>(
        'select count(*) as count from schema_epoch_transitions'
      ).get()?.count).toBe(0);
      expect(interrupted.query<{ count: number }, []>(`
        select count(*) as count from sqlite_schema where type = 'table' and name = 'trial_notes_epoch_one'
      `).get()?.count).toBe(0);
      expect(interrupted.query<{ count: number }, []>(`
        select count(*) as count from pragma_table_xinfo('trial_notes') where name = 'archived'
      `).get()?.count).toBe(1);
      expect(runSQLiteTrialMigrationChain({
        database: interrupted,
        manifest: destination
      }).status).toBe('bridged');

      runSQLiteTrialMigrationChain({ database: malformed, manifest: sourceManifest });
      malformed.query(`
        insert into schema_migrations
          (migration_id, schema_epoch, sequence, dialect, checksum_sha256, receipt_kind,
           source_fingerprint, result_fingerprint, transition_id, runner_version,
           build_identity, applied_at, duration_ms)
        values ('e1_0004_unknown', 1, 4, 'sqlite', ?, 'executed', ?, ?, null, 1,
                'adversarial-test', 0, 0)
      `).run(
        '0'.repeat(64),
        sourceInput.expectedCurrentApplicationFingerprint,
        sourceInput.expectedCurrentApplicationFingerprint
      );
      expectFoundationError(
        () => runSQLiteTrialMigrationChain({ database: malformed, manifest: destination }),
        'receipt_chain_malformed'
      );
      expect(malformed.query<{ count: number }, []>(
        'select count(*) as count from schema_epoch_transitions'
      ).get()?.count).toBe(0);

      const wrongVerifierInput = destinationManifest(sourceInput);
      const wrongVerifierDestination = compileSQLiteTrialMigrationManifest({
        ...wrongVerifierInput,
        verifiers: Object.freeze(wrongVerifierInput.verifiers.map((definition) =>
          definition.id === 'verify.bridge'
            ? Object.freeze({
                ...definition,
                expectedRowsDigestSha256: sqliteTrialVerifierRowsDigest([{ count: 1 }])
              })
            : definition
        ))
      });
      runSQLiteTrialMigrationChain({ database: verifierRejected, manifest: sourceManifest });
      expectFoundationError(
        () => runSQLiteTrialMigrationChain({
          database: verifierRejected,
          manifest: wrongVerifierDestination
        }),
        'schema_drift'
      );
      expect(verifierRejected.query<{ count: number }, []>(
        'select count(*) as count from schema_epoch_transitions'
      ).get()?.count).toBe(0);
      expect(verifierRejected.query<{ count: number }, []>(`
        select count(*) as count from pragma_table_xinfo('trial_notes') where name = 'archived'
      `).get()?.count).toBe(1);
    } finally {
      interrupted.close();
      malformed.close();
      verifierRejected.close();
    }
  });

  test('requires every targeted verifier before changing schema', () => {
    const input = buildManifestInput(1, EPOCH_ONE);
    expectFoundationError(
      () => compileSQLiteTrialMigrationManifest({ ...input, verifiers: Object.freeze([]) }),
      'invalid_migration_options'
    );

    const wrongVerifier = input.verifiers.map((definition) =>
      definition.id === 'verify.archived'
        ? Object.freeze({ ...definition, expectedRowsDigestSha256: '0'.repeat(64) })
        : definition
    );
    expectFoundationError(
      () => compileSQLiteTrialMigrationManifest({ ...input, verifiers: Object.freeze(wrongVerifier) }),
      'schema_drift'
    );

    expect(sqliteTrialVerifierRowsDigest([{ value: 1 }, { value: 2 }])).toBe(
      sqliteTrialVerifierRowsDigest([{ value: 2 }, { value: 1 }])
    );
  });

  test('refuses deferred FK violations before compile and corruption on current replay', () => {
    const schemaSql = `
      create table trial_parent (id text primary key) strict;
      create table trial_child (
        id text primary key,
        parent_id text not null references trial_parent(id) deferrable initially deferred
      ) strict;
    `;
    const base = buildManifestInput(1, [{
      migrationId: 'e1_0001_trial_fk',
      sql: schemaSql,
      verifierIds: Object.freeze([])
    }]);
    const entry = base.migrations[0];
    if (!entry) throw new Error('Missing FK migration fixture.');
    const invalidArtifact: SQLiteTrialMigrationManifestInput = {
      ...base,
      migrations: Object.freeze([
        Object.freeze({
          ...entry,
          artifact: artifact(`${schemaSql}\ninsert into trial_child (id, parent_id) values ('child_bad', 'missing');`)
        })
      ])
    };
    expectFoundationError(
      () => compileSQLiteTrialMigrationManifest(invalidArtifact),
      'schema_drift'
    );

    const compiled = compileSQLiteTrialMigrationManifest(base);
    const database = new Database(':memory:', { create: true, strict: true });
    try {
      runSQLiteTrialMigrationChain({ database, manifest: compiled });
      database.exec('PRAGMA foreign_keys = OFF;');
      database.query('insert into trial_child (id, parent_id) values (?, ?)').run('child_corrupt', 'missing');
      database.exec('PRAGMA foreign_keys = ON;');
      expectFoundationError(
        () => runSQLiteTrialMigrationChain({ database, manifest: compiled }),
        'schema_drift'
      );
    } finally {
      database.close();
    }
  });
});
