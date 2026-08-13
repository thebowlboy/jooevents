import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  planEventCreation,
  planEventSettingsUpdate,
  type EventCreatePlan
} from '@jooevents/event';
import { installEventSpineSchema, SQLiteEventSpineRepository } from './event-spine';
import {
  createSQLiteEventSettingsInitializer,
  initializeCreatedEventSettings,
  installEventSettingsSchema,
  SQLiteEventSettingsError,
  SQLiteEventSettingsRepository
} from './event-settings';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = '019c1df7-86b5-769b-bba4-5f7097bfa111';
const otherEventId = '019c1df7-86b5-769b-bba4-5f7097bfa112';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa211';
const scope = { workspaceId, eventId } as const;

function openDatabase(): Database {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO workspaces VALUES (
      '${workspaceId}', 'Primary workspace', 'active', 1, 1, 1
    );
    INSERT INTO users VALUES (
      '${userId}', 'active', 'Event owner', 1, 1, 1
    );
  `);
  installEventSpineSchema(sqlite);
  installEventSettingsSchema(sqlite);
  const spine = new SQLiteEventSpineRepository(sqlite);
  sqlite.exec('BEGIN IMMEDIATE;');
  spine.bootstrapWorkspaceEventSet(workspaceId);
  sqlite.exec('COMMIT;');
  return sqlite;
}

function createPlan(spine: SQLiteEventSpineRepository): EventCreatePlan {
  return planEventCreation({
    eventSet: spine.requireEventSet(workspaceId),
    authorInput: {
      expectedEventSetVersion: 1,
      name: 'JooConf 2027',
      timezone: 'Asia/Singapore',
      startDate: '2027-04-16',
      endDate: '2027-04-18'
    },
    server: {
      workspaceId,
      eventId,
      createdByUserId: userId,
      createdAt: '2026-08-13T01:00:00.000Z'
    }
  });
}

function createRoot(sqlite: Database, initialize = false) {
  const spine = new SQLiteEventSpineRepository(sqlite);
  sqlite.exec('BEGIN IMMEDIATE;');
  spine.commitEventCreatePlan(createPlan(spine));
  if (initialize) initializeCreatedEventSettings({ sqlite, scope });
  sqlite.exec('COMMIT;');
  return { spine, settings: new SQLiteEventSettingsRepository(sqlite) };
}

describe('ephemeral SQLite Event settings', () => {
  test('represents an initialized workspace with no selected Event as absent settings', () => {
    const sqlite = openDatabase();
    try {
      const repository = new SQLiteEventSpineRepository(sqlite);
      sqlite.exec('BEGIN IMMEDIATE;');
      repository.bootstrapWorkspaceEventSet(workspaceId);
      sqlite.exec('COMMIT;');
      expect(new SQLiteEventSettingsRepository(sqlite).readCurrentEventSettings(workspaceId))
        .toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test('requires the companion and never lazily defaults a created Event on read', () => {
    const sqlite = openDatabase();
    try {
      const { settings } = createRoot(sqlite);
      expect(() => settings.readCurrentEventSettings(workspaceId))
        .toThrow(new SQLiteEventSettingsError('settings_companion_missing'));
      expect(sqlite.query('SELECT count(*) AS count FROM event_settings_companions').get())
        .toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  test('initializes only in a transaction and exactly replays the coherent empty baseline', () => {
    const sqlite = openDatabase();
    try {
      const { settings } = createRoot(sqlite);
      expect(() => settings.initializeCreatedEventSettings(scope))
        .toThrow(new SQLiteEventSettingsError('transaction_required'));
      const collaborator = createSQLiteEventSettingsInitializer({ sqlite });
      sqlite.exec('BEGIN IMMEDIATE;');
      const first = collaborator.initializeCreatedEventSettings(scope);
      const replay = collaborator.initializeCreatedEventSettings(scope);
      sqlite.exec('COMMIT;');
      expect(first.companion).toMatchObject({
        workspaceId, eventId, eventVersion: 1, location: '', venueNote: '',
        dayStart: '09:00', dayEnd: '18:00', slotMinutes: 30
      });
      expect(replay).toEqual(first);

      sqlite.exec(`UPDATE event_settings_companions SET location = 'unexpected'`);
      sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => collaborator.initializeCreatedEventSettings(scope))
        .toThrow(new SQLiteEventSettingsError('settings_companion_conflict'));
      sqlite.exec('ROLLBACK;');

      sqlite.exec(`UPDATE event_settings_companions SET location = '', day_start = '08:00'`);
      sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => collaborator.initializeCreatedEventSettings(scope))
        .toThrow(new SQLiteEventSettingsError('settings_companion_conflict'));
      sqlite.exec('ROLLBACK;');
    } finally {
      sqlite.close();
    }
  });

  test('rejects a valid but cross-selected Event identity instead of confusing scope roles', () => {
    const sqlite = openDatabase();
    try {
      const { settings } = createRoot(sqlite);
      expect(settings.readEventSettings({ workspaceId, eventId: otherEventId })).toBeUndefined();
      sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => settings.initializeCreatedEventSettings({
        workspaceId,
        eventId: otherEventId
      })).toThrow(new SQLiteEventSettingsError('selection_changed'));
      sqlite.exec('ROLLBACK;');
      expect(sqlite.query('SELECT count(*) AS count FROM event_settings_companions').get())
        .toEqual({ count: 0 });
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
      sqlite.close();
    }
  });

  test('updates the Event head and companion atomically under exact selection guards', () => {
    const sqlite = openDatabase();
    try {
      const { settings } = createRoot(sqlite, true);
      const current = settings.requireEventSettings(scope);
      const plan = planEventSettingsUpdate({
        state: current,
        authorInput: {
          scope,
          request: {
            expectedEventId: eventId,
            expectedEventSetVersion: 2,
            expectedEventVersion: 1,
            name: 'JooConf Live',
            timezone: 'Asia/Singapore',
            startDate: '2027-04-17',
            endDate: '2027-04-19',
            location: 'Suntec City',
            venueNote: 'Use level 3.',
            dayStart: '08:30',
            dayEnd: '17:30',
            slotMinutes: 20
          }
        }
      });
      expect(() => settings.applyEventSettingsUpdatePlan(plan))
        .toThrow(new SQLiteEventSettingsError('transaction_required'));
      sqlite.exec('BEGIN IMMEDIATE;');
      const applied = settings.applyEventSettingsUpdatePlan(plan);
      sqlite.exec('COMMIT;');
      expect(applied).toMatchObject({
        eventVersion: 2,
        name: 'JooConf Live',
        dayStart: '08:30',
        dayEnd: '17:30',
        slotMinutes: 20
      });
      expect(settings.readCurrentEventSettings(workspaceId)).toEqual(applied);

      sqlite.exec(`UPDATE event_settings_companions SET location = 'drifted'`);
      sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => settings.applyEventSettingsUpdatePlan(plan))
        .toThrow(new SQLiteEventSettingsError('stale_settings'));
      sqlite.exec('ROLLBACK;');
      expect(settings.readCurrentEventSettings(workspaceId)).toMatchObject({
        eventVersion: 2,
        name: 'JooConf Live',
        location: 'drifted'
      });
    } finally {
      sqlite.close();
    }
  });

  test('rolls the Event head back to its prior bytes when companion application fails late', () => {
    const sqlite = openDatabase();
    try {
      const { settings } = createRoot(sqlite, true);
      const before = settings.readCurrentEventSettings(workspaceId);
      const plan = planEventSettingsUpdate({
        state: settings.requireEventSettings(scope),
        authorInput: {
          scope,
          request: {
            expectedEventId: eventId,
            expectedEventSetVersion: 2,
            expectedEventVersion: 1,
            name: 'Must Roll Back',
            timezone: 'Asia/Singapore',
            startDate: '2027-04-16',
            endDate: '2027-04-18',
            location: 'Blocked',
            venueNote: '',
            dayStart: '09:00',
            dayEnd: '18:00',
            slotMinutes: 30
          }
        }
      });
      sqlite.exec(`
        CREATE TRIGGER inject_event_settings_update_failure
        BEFORE UPDATE ON event_settings_companions
        BEGIN SELECT RAISE(ABORT, 'injected settings update failure'); END;
      `);
      sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => settings.applyEventSettingsUpdatePlan(plan))
        .toThrow(new SQLiteEventSettingsError('stale_settings'));
      sqlite.exec('COMMIT;');
      expect(settings.readCurrentEventSettings(workspaceId)).toEqual(before);
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
      sqlite.close();
    }
  });

  test('clears the grid geometry to honest absence and guards the null before-image', () => {
    const sqlite = openDatabase();
    try {
      const { settings } = createRoot(sqlite, true);
      const clearPlan = planEventSettingsUpdate({
        state: settings.requireEventSettings(scope),
        authorInput: {
          scope,
          request: {
            expectedEventId: eventId,
            expectedEventSetVersion: 2,
            expectedEventVersion: 1,
            name: 'JooConf 2027',
            timezone: 'Asia/Singapore',
            startDate: '2027-04-16',
            endDate: '2027-04-18',
            location: '',
            venueNote: '',
            dayStart: null,
            dayEnd: null,
            slotMinutes: null
          }
        }
      });
      sqlite.exec('BEGIN IMMEDIATE;');
      const cleared = settings.applyEventSettingsUpdatePlan(clearPlan);
      sqlite.exec('COMMIT;');
      expect(cleared).toMatchObject({
        eventVersion: 2, dayStart: null, dayEnd: null, slotMinutes: null
      });
      expect(settings.readCurrentEventSettings(workspaceId)).toEqual(cleared);

      const restorePlan = planEventSettingsUpdate({
        state: settings.requireEventSettings(scope),
        authorInput: {
          scope,
          request: {
            expectedEventId: eventId,
            expectedEventSetVersion: 2,
            expectedEventVersion: 2,
            name: 'JooConf 2027',
            timezone: 'Asia/Singapore',
            startDate: '2027-04-16',
            endDate: '2027-04-18',
            location: '',
            venueNote: '',
            dayStart: '10:00',
            dayEnd: '16:00',
            slotMinutes: 60
          }
        }
      });
      sqlite.exec('BEGIN IMMEDIATE;');
      const restored = settings.applyEventSettingsUpdatePlan(restorePlan);
      sqlite.exec('COMMIT;');
      expect(restored).toMatchObject({
        eventVersion: 3, dayStart: '10:00', dayEnd: '16:00', slotMinutes: 60
      });
      expect(settings.readCurrentEventSettings(workspaceId)).toEqual(restored);
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
      sqlite.close();
    }
  });

  test('the table refuses a torn or incoherent geometry triple at the constraint layer', () => {
    const sqlite = openDatabase();
    try {
      createRoot(sqlite, true);
      for (const mutation of [
        `UPDATE event_settings_companions SET day_start = NULL`,
        `UPDATE event_settings_companions SET slot_minutes = 25`,
        `UPDATE event_settings_companions SET day_start = '19:00'`,
        `UPDATE event_settings_companions SET day_start = '9:00'`,
        `UPDATE event_settings_companions SET slot_minutes = 60, day_start = '09:30'`
      ]) {
        expect(() => sqlite.exec(mutation)).toThrow();
      }
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
      sqlite.close();
    }
  });

  test('a late initializer failure rolls Event creation back when centrally joined', () => {
    const sqlite = openDatabase();
    const spine = new SQLiteEventSpineRepository(sqlite);
    try {
      sqlite.exec(`
        CREATE TRIGGER inject_event_settings_initializer_failure
        BEFORE INSERT ON event_settings_companions
        BEGIN SELECT RAISE(ABORT, 'injected initializer failure'); END;
      `);
      sqlite.exec('BEGIN IMMEDIATE;');
      spine.commitEventCreatePlan(createPlan(spine));
      expect(() => initializeCreatedEventSettings({ sqlite, scope }))
        .toThrow(new SQLiteEventSettingsError('settings_companion_conflict'));
      sqlite.exec('ROLLBACK;');

      expect(spine.readEvent(workspaceId, eventId)).toBeUndefined();
      expect(spine.readCurrentEventProjection(workspaceId)).toEqual({
        schemaVersion: 1,
        kind: 'no_event',
        eventSetVersion: 1
      });
      expect(sqlite.query('SELECT count(*) AS count FROM event_settings_companions').get())
        .toEqual({ count: 0 });
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
      sqlite.close();
    }
  });
});
