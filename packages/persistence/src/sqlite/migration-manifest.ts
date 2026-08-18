import {
  SQLITE_E2_S6_RELEASE_FLOOR,
  SQLITE_E2_S7_RELEASE_FLOOR,
  SQLITE_E2_S8_RELEASE_FLOOR,
  SQLITE_E2_S9_RELEASE_FLOOR,
  type SQLiteMigrationReference,
  type SQLiteReleaseFloor
} from './release-floor-contract';

export type { SQLiteMigrationReference, SQLiteReleaseFloor } from './release-floor-contract';

export interface SQLiteMigrationManifestEntry extends SQLiteMigrationReference {
  readonly dialect: 'sqlite';
  readonly artifact: URL;
  readonly checksumSha256: string;
  readonly atomicity: 'transactional';
  readonly dependsOn: SQLiteMigrationReference | null;
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
  readonly migrations: readonly [SQLiteMigrationManifestEntry, ...SQLiteMigrationManifestEntry[]];
  readonly expectedEmptyApplicationFingerprint: string;
  readonly expectedCurrentApplicationFingerprint: string;
  readonly expectedCurrentFullFingerprint: string;
  readonly dictionary: {
    readonly artifact: URL;
    readonly checksumSha256: string;
  };
  readonly acceptedPredecessorLineages: readonly [SQLiteAcceptedPredecessorLineage];
  readonly releaseFloors: readonly [SQLiteReleaseFloor, ...SQLiteReleaseFloor[]];
}

const destinationBaseline = Object.freeze({
  migrationId: 'e2_0001_jooevents_foundation',
  schemaEpoch: 2,
  sequence: 1
});

const submissionTriageSpam = Object.freeze({
  migrationId: 'e2_0002_submission_triage_spam',
  schemaEpoch: 2,
  sequence: 2
});

const externalAgentApi = Object.freeze({
  migrationId: 'e2_0003_external_agent_api',
  schemaEpoch: 2,
  sequence: 3
});

const apiKeyPrefix = Object.freeze({
  migrationId: 'e2_0004_api_key_prefix',
  schemaEpoch: 2,
  sequence: 4
});

const apiKeyNeverExpire = Object.freeze({
  migrationId: 'e2_0005_api_key_never_expire',
  schemaEpoch: 2,
  sequence: 5
});

const airtableSync = Object.freeze({
  migrationId: 'e2_0006_airtable_sync',
  schemaEpoch: 2,
  sequence: 6
});

const acceleventsExport = Object.freeze({
  migrationId: 'e2_0007_accelevents_export',
  schemaEpoch: 2,
  sequence: 7
});

const sessionProgramReferences = Object.freeze({
  migrationId: 'e2_0008_session_program_references',
  schemaEpoch: 2,
  sequence: 8
});

const speakerLineup = Object.freeze({
  migrationId: 'e2_0009_speaker_lineup',
  schemaEpoch: 2,
  sequence: 9
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
  migrations: Object.freeze([
    Object.freeze({
      ...destinationBaseline,
      dialect: 'sqlite' as const,
      artifact: new URL('../../migrations/sqlite/e2_0001_jooevents_foundation.sql', import.meta.url),
      checksumSha256: '5ce9cfb08f06e8cd9a84296fe20d0850cf4876f283b479caafc128ad967bf6aa',
      atomicity: 'transactional' as const,
      dependsOn: null,
      expectedBeforeApplicationFingerprint: 'e3ded6858faee915d966f4bcaf5b768070aaaa4d5f1021ac04c713440106b89d',
      expectedAfterApplicationFingerprint: '8760a700ec1ff8cc84e8d030d2fbc4d19f09c432b88e327149d0070d24b47fab'
    }),
    Object.freeze({
      ...submissionTriageSpam,
      dialect: 'sqlite' as const,
      artifact: new URL('../../migrations/sqlite/e2_0002_submission_triage_spam.sql', import.meta.url),
      checksumSha256: '8754ca57db09082b3fb2897ce89c8958a5af6f457cada1f0834dc3037201401e',
      atomicity: 'transactional' as const,
      dependsOn: destinationBaseline,
      expectedBeforeApplicationFingerprint: '8760a700ec1ff8cc84e8d030d2fbc4d19f09c432b88e327149d0070d24b47fab',
      expectedAfterApplicationFingerprint: '115bc77a2ad42509eca775d41ce25b5ce9dd000428ba8728de661b112bcd2153'
    }),
    Object.freeze({
      ...externalAgentApi,
      dialect: 'sqlite' as const,
      artifact: new URL('../../migrations/sqlite/e2_0003_external_agent_api.sql', import.meta.url),
      checksumSha256: '2acf6112c34fcdfcbb7f0f483c99617eab7f08445f94deb8cd3be4cb4948acc2',
      atomicity: 'transactional' as const,
      dependsOn: submissionTriageSpam,
      expectedBeforeApplicationFingerprint: '115bc77a2ad42509eca775d41ce25b5ce9dd000428ba8728de661b112bcd2153',
      expectedAfterApplicationFingerprint: '16ab3891073679c60cf4a9aa4578e5252c97558be3739c730d6b71c02237d33f'
    }),
    Object.freeze({
      ...apiKeyPrefix,
      dialect: 'sqlite' as const,
      artifact: new URL('../../migrations/sqlite/e2_0004_api_key_prefix.sql', import.meta.url),
      checksumSha256: '0e9d629d779c0ed22531eb1dea516e0419f504fef421116b7cacf2bf38b68ff7',
      atomicity: 'transactional' as const,
      dependsOn: externalAgentApi,
      expectedBeforeApplicationFingerprint: '16ab3891073679c60cf4a9aa4578e5252c97558be3739c730d6b71c02237d33f',
      expectedAfterApplicationFingerprint: '82bcf31c9b256cd059cdc44cbdb6ca8ae4de15d38f6aacd5856cf04438100dd0'
    }),
    Object.freeze({
      ...apiKeyNeverExpire,
      dialect: 'sqlite' as const,
      artifact: new URL('../../migrations/sqlite/e2_0005_api_key_never_expire.sql', import.meta.url),
      checksumSha256: '2f43f7a8d2bf7781c9fb104f9cd5664e9e7fee04374c3df6f054e15e764a2cdd',
      atomicity: 'transactional' as const,
      dependsOn: apiKeyPrefix,
      expectedBeforeApplicationFingerprint: '82bcf31c9b256cd059cdc44cbdb6ca8ae4de15d38f6aacd5856cf04438100dd0',
      expectedAfterApplicationFingerprint: '3ad3833b3b387f16ec2e04c72a611ba3ea27c1ca7b4c407697e369ef5d4d7830'
    }),
    Object.freeze({
      ...airtableSync,
      dialect: 'sqlite' as const,
      artifact: new URL('../../migrations/sqlite/e2_0006_airtable_sync.sql', import.meta.url),
      checksumSha256: '6c40cebf88f6577654234fd822ad608927d739502f8c0808546f4d76c2b11c65',
      atomicity: 'transactional' as const,
      dependsOn: apiKeyNeverExpire,
      expectedBeforeApplicationFingerprint: '3ad3833b3b387f16ec2e04c72a611ba3ea27c1ca7b4c407697e369ef5d4d7830',
      expectedAfterApplicationFingerprint: 'fc5d0a46bd51e3b4671172da707844af9e63039c6d1f829373d9d7881dedfa31'
    }),
    Object.freeze({
      ...acceleventsExport,
      dialect: 'sqlite' as const,
      artifact: new URL('../../migrations/sqlite/e2_0007_accelevents_export.sql', import.meta.url),
      checksumSha256: '789b91717715993d1680fc1cc34043fb0f27e95d3573a482ad622c2e0a0dfb1b',
      atomicity: 'transactional' as const,
      dependsOn: airtableSync,
      expectedBeforeApplicationFingerprint: 'fc5d0a46bd51e3b4671172da707844af9e63039c6d1f829373d9d7881dedfa31',
      expectedAfterApplicationFingerprint: '3da16ed9902c541954117fcdfbd1f570d96d3d2887e2df933a3e9aee1d9919b6'
    }),
    Object.freeze({
      ...sessionProgramReferences,
      dialect: 'sqlite' as const,
      artifact: new URL('../../migrations/sqlite/e2_0008_session_program_references.sql', import.meta.url),
      checksumSha256: '95d337a00dfd2b9d8e29320d14986862de4343f7c2eaef49cedf1bfac4650f30',
      atomicity: 'transactional' as const,
      dependsOn: acceleventsExport,
      expectedBeforeApplicationFingerprint: '3da16ed9902c541954117fcdfbd1f570d96d3d2887e2df933a3e9aee1d9919b6',
      expectedAfterApplicationFingerprint: '74b042329c6ed4a7fc401d93fc3761da56661a7deb9d591a193ccb91c505f43a'
    }),
    Object.freeze({
      ...speakerLineup,
      dialect: 'sqlite' as const,
      artifact: new URL('../../migrations/sqlite/e2_0009_speaker_lineup.sql', import.meta.url),
      checksumSha256: 'bf61ef212af411cce5fa0cf56aabe46cb9eb23879e3ab10ae1c49f08e67d96a7',
      atomicity: 'transactional' as const,
      dependsOn: sessionProgramReferences,
      expectedBeforeApplicationFingerprint: '74b042329c6ed4a7fc401d93fc3761da56661a7deb9d591a193ccb91c505f43a',
      expectedAfterApplicationFingerprint: '866f4e468642a40e13fa2b73ef2f5b71d83feb48fb432017ddfb45c703c5af8a'
    })
  ]) as readonly [SQLiteMigrationManifestEntry, ...SQLiteMigrationManifestEntry[]],
  expectedEmptyApplicationFingerprint: 'e3ded6858faee915d966f4bcaf5b768070aaaa4d5f1021ac04c713440106b89d',
  expectedCurrentApplicationFingerprint: '866f4e468642a40e13fa2b73ef2f5b71d83feb48fb432017ddfb45c703c5af8a',
  expectedCurrentFullFingerprint: 'ec41bf40bc0d6814bdc44985563125afce0929560d94a90388e9b20aaf33143b',
  dictionary: Object.freeze({
    artifact: new URL('../../migrations/sqlite/checkpoints/e2_0009_speaker_lineup.schema.json', import.meta.url),
    checksumSha256: '938f4ea9b96a557954b0c603c24686baad7c070081196e92bd13f6f07e82ba43'
  }),
  releaseFloors: Object.freeze([
    SQLITE_E2_S6_RELEASE_FLOOR,
    SQLITE_E2_S7_RELEASE_FLOOR,
    SQLITE_E2_S8_RELEASE_FLOOR,
    SQLITE_E2_S9_RELEASE_FLOOR
  ]) as readonly [SQLiteReleaseFloor, ...SQLiteReleaseFloor[]],
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
