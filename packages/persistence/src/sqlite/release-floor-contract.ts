export interface SQLiteMigrationReference {
  readonly migrationId: string;
  readonly schemaEpoch: number;
  readonly sequence: number;
}

export interface SQLiteReleaseFloor {
  readonly releaseFloorId: string;
  readonly terminalMigration: SQLiteMigrationReference;
  readonly expectedApplicationFingerprint: string;
  readonly expectedFullFingerprint: string;
  readonly minimumRunnerVersion: number;
}

/** Pure cross-runtime contract for the currently supported retained data floor. */
export const SQLITE_E2_S6_RELEASE_FLOOR: SQLiteReleaseFloor = Object.freeze({
  releaseFloorId: 'sqlite-e2-s6',
  terminalMigration: Object.freeze({
    migrationId: 'e2_0006_airtable_sync',
    schemaEpoch: 2,
    sequence: 6
  }),
  expectedApplicationFingerprint: 'fc5d0a46bd51e3b4671172da707844af9e63039c6d1f829373d9d7881dedfa31',
  expectedFullFingerprint: '93c2bd560351a6e8607d4c07ae926376b6959c879c8908903011efd8348bb03f',
  minimumRunnerVersion: 2
});
