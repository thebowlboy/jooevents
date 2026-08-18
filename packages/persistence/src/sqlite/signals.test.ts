import { afterEach, describe, expect, test } from 'bun:test';
import {
  applySignalHumanFlagPlan,
  planSignalHumanFlagChange,
  SignalHumanFlagPlanningError
} from '@jooevents/signals';
import { planEventCreation } from '@jooevents/event';
import { parseApplicationId } from '@jooevents/kernel';
import { openSQLite, type OpenSQLiteResult } from './database';
import { SQLiteEventSpineRepository } from './event-spine';
import { SQLiteSignalRepository } from './signals';

const id = (suffix: number) => parseApplicationId(
  'domain_fact',
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
);
type TestId = ReturnType<typeof id>;
const workspaceId = id(1);
const eventId = id(2);
const organizerId = id(3);
const reviewerUserId = id(4);
const reviewerId = id(5);
const reviewPlanId = id(6);
const scope = Object.freeze({ workspaceId, eventId });
const opened: OpenSQLiteResult[] = [];

function fixture(): { readonly database: OpenSQLiteResult; readonly signals: SQLiteSignalRepository } {
  const database = openSQLite(':memory:');
  opened.push(database);
  const now = Date.parse('2026-08-18T09:00:00.000Z');
  database.sqlite.query(`
    INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
    VALUES (?,?, 'active',?,?,1)
  `).run(workspaceId, 'Signals workspace', now, now);
  database.sqlite.query(`
    INSERT INTO users (id,status,display_name,created_at,updated_at,version)
    VALUES (?, 'active', ?,?,?,1), (?, 'active', ?,?,?,1)
  `).run(
    organizerId, 'Organizer', now, now,
    reviewerUserId, 'Reviewer', now, now
  );
  const spine = new SQLiteEventSpineRepository(database.sqlite);
  database.sqlite.transaction(() => {
    spine.bootstrapWorkspaceEventSet(workspaceId);
    spine.commitEventCreatePlan(planEventCreation({
      eventSet: spine.requireEventSet(workspaceId),
      authorInput: {
        expectedEventSetVersion: 1,
        name: 'Signals event',
        timezone: 'UTC',
        startDate: '2026-10-01',
        endDate: '2026-10-02'
      },
      server: {
        workspaceId,
        eventId,
        createdByUserId: organizerId,
        createdAt: '2026-08-18T09:00:00.000Z'
      }
    }));
  }).immediate();
  return { database, signals: new SQLiteSignalRepository(database.sqlite) };
}

function recordPlan(
  signals: SQLiteSignalRepository,
  subjectId: TestId,
  observationId: TestId,
  definitionKey = 'accolade.top_pick'
) {
  return planSignalHumanFlagChange({
    repository: signals,
    planningInput: {
      action: 'record_human_flag',
      scope,
      definitionKey,
      expectedDefinitionVersion: 1,
      subjectId,
      actorReviewerId: reviewerId,
      actorUserId: reviewerUserId,
      reviewPlanId,
      attributedAt: '2026-08-18T10:00:00.000Z',
      observationId
    }
  });
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
});

describe('retained SQLite Signals', () => {
  test('seeds the event-local accolade catalog for existing runtime event creation', () => {
    const { signals } = fixture();
    expect(signals.listDefinitions(scope).map((definition) => ({
      key: definition.key,
      position: definition.position,
      cap: definition.writeCaps?.perActorPerPlan
    }))).toEqual([
      { key: 'accolade.top_pick', position: 0, cap: 3 },
      { key: 'accolade.hidden_gem', position: 1, cap: 3 },
      { key: 'accolade.crowd_draw', position: 2, cap: undefined },
      { key: 'accolade.bold_bet', position: 3, cap: undefined }
    ]);
  });

  test('records, projects, and retracts a human observation without erasing evidence', () => {
    const { database, signals } = fixture();
    const submissionId = id(10);
    const observationId = id(20);
    const plan = recordPlan(signals, submissionId, observationId);
    database.sqlite.transaction(() => applySignalHumanFlagPlan(signals, plan)).immediate();
    expect(signals.readCurrentHumanFlag({
      scope,
      definitionKey: 'accolade.top_pick',
      subjectId: submissionId,
      actorReviewerId: reviewerId,
      reviewPlanId
    })?.id).toBe(observationId);
    expect(() => database.sqlite.query(`
      INSERT INTO signal_observations (
        id,workspace_id,event_id,subject_kind,subject_id,definition_key,
        definition_version,value_json,rationale,provenance_kind,
        actor_reviewer_id,actor_user_id,review_plan_id,computed_at_ms,
        supersedes_id,input_versions_json
      )
      SELECT ?,workspace_id,event_id,subject_kind,subject_id,definition_key,
             definition_version,value_json,rationale,'agent',
             actor_reviewer_id,actor_user_id,review_plan_id,computed_at_ms,
             NULL,input_versions_json
        FROM signal_observations
       WHERE workspace_id=? AND event_id=? AND id=?
    `).run(id(21), workspaceId, eventId, observationId)).toThrow('CHECK constraint failed');

    const retraction = planSignalHumanFlagChange({
      repository: signals,
      planningInput: {
        action: 'retract_human_flag',
        scope,
        definitionKey: 'accolade.top_pick',
        expectedDefinitionVersion: 1,
        subjectId: submissionId,
        actorReviewerId: reviewerId,
        actorUserId: reviewerUserId,
        reviewPlanId,
        attributedAt: '2026-08-18T11:00:00.000Z',
        expectedObservationId: observationId,
        reason: 'Reviewer removed the accolade.'
      }
    });
    database.sqlite.transaction(() => applySignalHumanFlagPlan(signals, retraction)).immediate();
    expect(signals.readCurrentHumanFlag({
      scope,
      definitionKey: 'accolade.top_pick',
      subjectId: submissionId,
      actorReviewerId: reviewerId,
      reviewPlanId
    })).toBeUndefined();
    expect(signals.readObservation(scope, observationId)?.id).toBe(observationId);
    expect(() => database.sqlite.query(`
      UPDATE signal_observations SET value_json='false'
       WHERE workspace_id=? AND event_id=? AND id=?
    `).run(workspaceId, eventId, observationId)).toThrow('signal observations are immutable');
  });

  test('enforces capped accolades per reviewer and review plan while uncapped flags remain available', () => {
    const { database, signals } = fixture();
    for (let index = 0; index < 3; index += 1) {
      const plan = recordPlan(signals, id(30 + index), id(40 + index));
      database.sqlite.transaction(() => applySignalHumanFlagPlan(signals, plan)).immediate();
    }
    expect(() => recordPlan(signals, id(33), id(43))).toThrow(
      new SignalHumanFlagPlanningError('write_cap_exceeded', {
        holderSubjectIds: [id(30), id(31), id(32)]
      })
    );
    const uncapped = recordPlan(signals, id(33), id(44), 'accolade.crowd_draw');
    database.sqlite.transaction(() => applySignalHumanFlagPlan(signals, uncapped)).immediate();
    expect(signals.listCurrentHumanFlags({
      scope,
      actorReviewerId: reviewerId,
      reviewPlanId
    })).toHaveLength(4);
  });

  test('refuses stale definition and stale unpin evidence', () => {
    const { database, signals } = fixture();
    expect(() => planSignalHumanFlagChange({
      repository: signals,
      planningInput: {
        action: 'record_human_flag', scope,
        definitionKey: 'accolade.top_pick', expectedDefinitionVersion: 2,
        subjectId: id(50), actorReviewerId: reviewerId, actorUserId: reviewerUserId,
        reviewPlanId, attributedAt: '2026-08-18T10:00:00.000Z', observationId: id(51)
      }
    })).toThrow(new SignalHumanFlagPlanningError('stale_definition'));

    const plan = recordPlan(signals, id(50), id(51));
    database.sqlite.transaction(() => applySignalHumanFlagPlan(signals, plan)).immediate();
    expect(() => planSignalHumanFlagChange({
      repository: signals,
      planningInput: {
        action: 'retract_human_flag', scope,
        definitionKey: 'accolade.top_pick', expectedDefinitionVersion: 1,
        subjectId: id(50), actorReviewerId: reviewerId, actorUserId: reviewerUserId,
        reviewPlanId, attributedAt: '2026-08-18T11:00:00.000Z',
        expectedObservationId: id(52), reason: 'Stale browser state.'
      }
    })).toThrow(new SignalHumanFlagPlanningError('stale_observation'));
  });
});
