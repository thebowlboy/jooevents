export interface SQLiteMigrationReference {
  readonly migrationId: string;
  readonly schemaEpoch: number;
  readonly sequence: number;
}

export interface SQLiteMigrationManifestEntry extends SQLiteMigrationReference {
  readonly dialect: 'sqlite';
  readonly artifact: URL;
  readonly checksumSha256: string;
  readonly atomicity: 'transactional';
  readonly dependsOn: null;
  readonly expectedBeforeApplicationFingerprint: string;
  readonly expectedAfterApplicationFingerprint: string;
}

export interface SQLiteAcceptedPredecessorLineage {
  readonly transitionId: string;
  readonly lineageId: string;
  readonly dialect: 'sqlite';
  readonly sourceTerminal: SQLiteMigrationReference;
  readonly sourceReceiptKind: 'legacy_adoption';
  readonly sourceReceiptSetDigestSha256: string;
  readonly sourceApplicationFingerprint: string;
  readonly destinationBaseline: SQLiteMigrationReference;
  readonly bridgeArtifactId: string;
  readonly bridgeArtifact: URL;
  readonly bridgeChecksumSha256: string;
  readonly atomicity: 'transactional';
  readonly targetedVerifierIds: readonly [];
  readonly verifierSetDigestSha256: string;
  readonly minimumRunnerVersion: number;
}

export interface SQLiteMigrationManifest {
  readonly formatVersion: 1;
  readonly runnerVersion: 2;
  readonly dialect: 'sqlite';
  readonly bootstrap: {
    readonly artifact: URL;
    readonly checksumSha256: string;
    readonly expectedRunnerFingerprint: string;
  };
  readonly predecessor: {
    readonly artifact: URL;
    readonly checksumSha256: string;
    readonly expectedApplicationFingerprint: string;
  };
  readonly migrations: readonly [SQLiteMigrationManifestEntry];
  readonly expectedEmptyApplicationFingerprint: string;
  readonly expectedCurrentApplicationFingerprint: string;
  readonly expectedCurrentFullFingerprint: string;
  readonly dictionary: {
    readonly artifact: URL;
    readonly checksumSha256: string;
  };
  readonly acceptedPredecessorLineages: readonly [SQLiteAcceptedPredecessorLineage];
}

const destinationBaseline = Object.freeze({
  migrationId: 'e2_0001_jooevents_foundation',
  schemaEpoch: 2,
  sequence: 1
});

/** Exact public epoch-2 baseline plus the sole known retained epoch-1 lineage. */
export const SQLITE_MIGRATION_MANIFEST: SQLiteMigrationManifest = Object.freeze({
  formatVersion: 1,
  runnerVersion: 2,
  dialect: 'sqlite',
  bootstrap: Object.freeze({
    artifact: new URL('../../migrations/sqlite/schema_migrations.sql', import.meta.url),
    checksumSha256: '55548c37be3531717439c32b9ea00caa5eaa186c9ae3de54ad5ff7baa54f62e3',
    expectedRunnerFingerprint: '9792e3a7ea4c5705ec09f8f5f7b51e5d5bfeca700a30947dbe2e8c69b7cbeef5'
  }),
  predecessor: Object.freeze({
    artifact: new URL('../../migrations/sqlite/0001_identity_access.sql', import.meta.url),
    checksumSha256: '7bcc91ff77f3cb57b6d553dbf73546ec1d2972da24840d238d12323b7f50305c',
    expectedApplicationFingerprint: 'a5c5c8d6a0894112ba7061ed02f7e2d8f527042c512a408b305d0a86248dd5db'
  }),
  migrations: Object.freeze([Object.freeze({
    ...destinationBaseline,
    dialect: 'sqlite' as const,
    artifact: new URL('../../migrations/sqlite/e2_0001_jooevents_foundation.sql', import.meta.url),
    checksumSha256: '5ce9cfb08f06e8cd9a84296fe20d0850cf4876f283b479caafc128ad967bf6aa',
    atomicity: 'transactional' as const,
    dependsOn: null,
    expectedBeforeApplicationFingerprint: 'e3ded6858faee915d966f4bcaf5b768070aaaa4d5f1021ac04c713440106b89d',
    expectedAfterApplicationFingerprint: '8760a700ec1ff8cc84e8d030d2fbc4d19f09c432b88e327149d0070d24b47fab'
  })]) as readonly [SQLiteMigrationManifestEntry],
  expectedEmptyApplicationFingerprint: 'e3ded6858faee915d966f4bcaf5b768070aaaa4d5f1021ac04c713440106b89d',
  expectedCurrentApplicationFingerprint: '8760a700ec1ff8cc84e8d030d2fbc4d19f09c432b88e327149d0070d24b47fab',
  expectedCurrentFullFingerprint: '1a08edc1f996c5ab25a2f76e3bd6721f45fb1868c8afc0157f0ce946224ca81d',
  dictionary: Object.freeze({
    artifact: new URL('../../migrations/sqlite/checkpoints/e2_0001_jooevents_foundation.schema.json', import.meta.url),
    checksumSha256: 'ef195d4a735afdb949061f33eb46e7f00402c7bb37bc57475918f1547c247ef1'
  }),
  acceptedPredecessorLineages: Object.freeze([Object.freeze({
    transitionId: 'e1_identity_access_to_e2_foundation',
    lineageId: 'jooevents_identity_access_epoch_1',
    dialect: 'sqlite' as const,
    sourceTerminal: Object.freeze({
      migrationId: 'e1_0001_identity_access',
      schemaEpoch: 1,
      sequence: 1
    }),
    sourceReceiptKind: 'legacy_adoption' as const,
    sourceReceiptSetDigestSha256: 'f6e435d0771b916e565a76c53c9a3f959b01077d963f7e9cd35a1d5bfb542404',
    sourceApplicationFingerprint: 'a5c5c8d6a0894112ba7061ed02f7e2d8f527042c512a408b305d0a86248dd5db',
    destinationBaseline,
    bridgeArtifactId: 'e1_identity_access_to_e2_foundation.sql',
    bridgeArtifact: new URL('../../migrations/sqlite/e1_identity_access_to_e2_foundation.sql', import.meta.url),
    bridgeChecksumSha256: 'b298539f5bad46a9e6844c48cdaf063b29d7b7d0f994376e3a5f109508466c7e',
    atomicity: 'transactional' as const,
    targetedVerifierIds: Object.freeze([]),
    verifierSetDigestSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    minimumRunnerVersion: 2
  })]) as readonly [SQLiteAcceptedPredecessorLineage]
});
