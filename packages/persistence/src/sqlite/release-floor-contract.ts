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

/** Supported predecessor floor retained for forward upgrade compatibility. */
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

/** Current terminal floor; sequence 6 remains the supported predecessor floor. */
export const SQLITE_E2_S7_RELEASE_FLOOR: SQLiteReleaseFloor = Object.freeze({
  releaseFloorId: 'sqlite-e2-s7',
  terminalMigration: Object.freeze({
    migrationId: 'e2_0007_accelevents_export',
    schemaEpoch: 2,
    sequence: 7
  }),
  expectedApplicationFingerprint: '3da16ed9902c541954117fcdfbd1f570d96d3d2887e2df933a3e9aee1d9919b6',
  expectedFullFingerprint: '1c344b308b041b9adafe36aa91e71ce4ea5966b97f31fdca23badce94c24fa27',
  minimumRunnerVersion: 2
});
