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

/** Supported predecessor floor retained for forward upgrade compatibility. */
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

/** Supported predecessor floor retained for forward upgrade compatibility. */
export const SQLITE_E2_S8_RELEASE_FLOOR: SQLiteReleaseFloor = Object.freeze({
  releaseFloorId: 'sqlite-e2-s8',
  terminalMigration: Object.freeze({
    migrationId: 'e2_0008_session_program_references',
    schemaEpoch: 2,
    sequence: 8
  }),
  expectedApplicationFingerprint: '74b042329c6ed4a7fc401d93fc3761da56661a7deb9d591a193ccb91c505f43a',
  expectedFullFingerprint: 'bc09fb4de0633d690b493341e6933702e48ad5e67585e6e0f372d6da53f1393b',
  minimumRunnerVersion: 2
});

/** Supported predecessor floor retained for forward upgrade compatibility. */
export const SQLITE_E2_S9_RELEASE_FLOOR: SQLiteReleaseFloor = Object.freeze({
  releaseFloorId: 'sqlite-e2-s9',
  terminalMigration: Object.freeze({
    migrationId: 'e2_0009_speaker_lineup',
    schemaEpoch: 2,
    sequence: 9
  }),
  expectedApplicationFingerprint: '866f4e468642a40e13fa2b73ef2f5b71d83feb48fb432017ddfb45c703c5af8a',
  expectedFullFingerprint: 'ec41bf40bc0d6814bdc44985563125afce0929560d94a90388e9b20aaf33143b',
  minimumRunnerVersion: 2
});

/** Supported predecessor floor retained for forward upgrade compatibility. */
export const SQLITE_E2_S10_RELEASE_FLOOR: SQLiteReleaseFloor = Object.freeze({
  releaseFloorId: 'sqlite-e2-s10',
  terminalMigration: Object.freeze({
    migrationId: 'e2_0010_review_vacancy_resolutions',
    schemaEpoch: 2,
    sequence: 10
  }),
  expectedApplicationFingerprint: 'fa18abd29e76a519ddcbeb33e34bdd91586b1534d05131861c285d525c7923c0',
  expectedFullFingerprint: 'd6288f69cac32b0bbe4eaaa33fa8fb8fd8e521d5b25d0052c49e47c18b3aaf39',
  minimumRunnerVersion: 2
});

/** Supported predecessor floor retained for forward upgrade compatibility. */
export const SQLITE_E2_S11_RELEASE_FLOOR: SQLiteReleaseFloor = Object.freeze({
  releaseFloorId: 'sqlite-e2-s11',
  terminalMigration: Object.freeze({
    migrationId: 'e2_0011_signal_accolades',
    schemaEpoch: 2,
    sequence: 11
  }),
  expectedApplicationFingerprint: 'c888e739351adcd55676e0a57912c4598f9ea0c1b5b436c0831c7e8047346ee1',
  expectedFullFingerprint: '07dcc6d98d38a72971b71dc772574cfe34e1f1f22026b0881972f0578b18b30e',
  minimumRunnerVersion: 2
});

/** Current terminal floor; sequences 6 through 11 remain supported predecessors. */
export const SQLITE_E2_S12_RELEASE_FLOOR: SQLiteReleaseFloor = Object.freeze({
  releaseFloorId: 'sqlite-e2-s12',
  terminalMigration: Object.freeze({
    migrationId: 'e2_0012_schedule_breaks',
    schemaEpoch: 2,
    sequence: 12
  }),
  expectedApplicationFingerprint: '9b57c4471b0ac2bc8e665b4ad634a1646a1f93073665f76b3f03a479d266048b',
  expectedFullFingerprint: '1f7ab9821aca36773b5f6e84d13b2570b38681e32371c04f7fe461b6e4235364',
  minimumRunnerVersion: 2
});
