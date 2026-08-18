import { afterEach, describe, expect, test } from 'bun:test';
import {
  createReadOperationResultSchema,
  servedPublicFormSchema,
  servedPublicRosterSchema,
  servedPublicScheduleSchema
} from '@jooevents/contracts';
import { loadEphemeralLiveConfig } from '../config';
import { createDevFixtureClock } from '../runtime/dev-fixture-clock';
import { createEphemeralLiveRuntime, type EphemeralLiveRuntime } from '../runtime/ephemeral-live';
import { seedAIEngineerReviewer } from './ai-engineer-reviewer-seed';

const DAY_MS = 86_400_000;
const runtimes: EphemeralLiveRuntime[] = [];
const servedPublicFormReadResultSchema = createReadOperationResultSchema(servedPublicFormSchema);
const servedPublicRosterReadResultSchema = createReadOperationResultSchema(servedPublicRosterSchema);
const servedPublicScheduleReadResultSchema =
  createReadOperationResultSchema(servedPublicScheduleSchema);
const config = loadEphemeralLiveConfig({
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
  JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
  JOOEVENTS_ADMISSION_MODE: 'reservation_only',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'ignored-by-explicit-ephemeral-entry.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/ignored-by-explicit-ephemeral-entry'
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});

function times(runtime: EphemeralLiveRuntime, query: string): number[] {
  return runtime.database.sqlite.query<{ readonly at: number }, []>(query)
    .all().map((row) => row.at);
}

describe('AI Engineer reviewer seed', () => {
  test('builds its real-operation corpus across nine weeks and restores wall time', async () => {
    const anchor = new Date('2027-08-20T12:00:00.000Z');
    const clock = createDevFixtureClock(anchor);
    const runtime = await createEphemeralLiveRuntime({ config, devFixtureClock: clock });
    runtimes.push(runtime);

    const summary = await seedAIEngineerReviewer({ runtime, config, clock, anchor: anchor.toISOString() });
    expect(summary).toMatchObject({
      submissions: 20,
      forms: { open: 1, closed: 4 },
      committedReviews: 108,
      decisions: { accepted: 10, waitlisted: 2, declined: 2, undecided: 6 },
      reviewers: 6,
      reminderEligibleReviewers: 3,
      spawnedSessions: 10,
      placements: 8,
      speakerProfiles: 10,
      multiSpeakerSessions: 1,
      confirmedEngagements: 8,
      taskDefinitions: 3,
      taskAssignments: 24,
      conditionalRules: 2,
      sessionFiles: 3
    });
    const operationCountBeforeRerun = runtime.database.sqlite.query<
      { readonly count: number }, []
    >('SELECT count(*) AS count FROM operation_log').get()?.count ?? 0;
    await expect(seedAIEngineerReviewer({
      runtime, config, clock, anchor: anchor.toISOString()
    })).rejects.toThrow('target_not_fresh');
    expect(runtime.database.sqlite.query<{ readonly count: number }, []>(
      'SELECT count(*) AS count FROM operation_log'
    ).get()?.count ?? 0).toBe(operationCountBeforeRerun);
    expect(Object.values(summary.reminderExclusions).reduce((sum, count) => sum + count, 0))
      .toBe(3);
    const acceptedWithoutAssignedReview = runtime.database.sqlite.query<
      { readonly count: number }, []
    >(`
      SELECT count(*) AS count
        FROM decision_heads AS decision
       WHERE decision.state = 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM review_assignments AS assignment
            WHERE assignment.submission_id = decision.submission_id
         )
    `).get()?.count ?? 0;
    expect(acceptedWithoutAssignedReview).toBe(1);
    const outboundDeliveries = runtime.database.sqlite.query<
      { readonly count: number }, []
    >('SELECT count(*) AS count FROM communication_outbound_delivery_heads').get()?.count ?? 0;
    // The fixture authors, prepares, adopts, and rechecks the reminder preview;
    // seeding itself never crosses the separately configured send boundary.
    expect(outboundDeliveries).toBe(0);

    for (const kind of ['schedule', 'speakers', 'forms'] as const) {
      const presentation = await runtime.app.request(`/api/public/${kind}/presentation`);
      expect(presentation.status).toBe(200);
      expect(await presentation.json()).toMatchObject({
        kind: 'success',
        data: { schemaVersion: 1, surfaceReleaseNumber: 1, styleSetReleaseNumber: 1 }
      });
    }
    const publicForm = await runtime.app.request(
      `/api/public/forms/current?formId=${encodeURIComponent(summary.applyFormId)}`
    );
    expect(publicForm.status).toBe(200);
    const servedForm = servedPublicFormReadResultSchema.parse(await publicForm.json());
    expect(servedForm).toMatchObject({
      kind: 'success',
      data: {
        formId: summary.applyFormId,
        formVersionNumber: 1,
        availability: {
          kind: 'closes',
          eventTimezone: 'America/Los_Angeles',
          gracePolicy: 'soft'
        }
      }
    });
    if (servedForm.kind !== 'success') throw new Error('Public form was not served.');
    expect(servedForm.data.rules).toHaveLength(2);
    expect(servedForm.data.rules.map((rule) => rule.effect.kind).sort())
      .toEqual(['require', 'show']);
    expect(servedForm.data.rules.every((rule) => rule.condition.kind === 'checked_is'))
      .toBe(true);

    const publicSchedule = servedPublicScheduleReadResultSchema.parse(await (
      await runtime.app.request('/api/public/schedule/current')
    ).json());
    if (publicSchedule.kind !== 'success') throw new Error('Public schedule was not served.');
    expect(publicSchedule.data.sessions.find(
      (session) => session.title === 'The Agent That Knows When to Stop'
    )?.description).toBe(
      'A production account of bounded tool loops, explicit refusal states, and the operational signals that let an agent stop before a useful task becomes an expensive incident.'
    );

    const publicRoster = servedPublicRosterReadResultSchema.parse(await (
      await runtime.app.request('/api/public/speakers/current')
    ).json());
    if (publicRoster.kind !== 'success') throw new Error('Public speaker roster was not served.');
    expect(publicRoster.data.speakers).toHaveLength(8);
    expect(publicRoster.data.speakers.every((speaker) =>
      speaker.headline && speaker.biography && speaker.location && speaker.links?.length === 1
    )).toBe(true);
    expect(publicRoster.data.speakers.filter((speaker) =>
      speaker.sessions.some((session) => session.title === 'When the Copilot Becomes the Product')
    )).toHaveLength(2);

    const sessionFileLinks = runtime.database.sqlite.query<
      { readonly count: number }, []
    >(`
      SELECT count(*) AS count FROM operation_log
       WHERE operation_name = 'file.attachment.link'
    `).get()?.count ?? 0;
    expect(sessionFileLinks).toBe(3);

    const arrivals = times(runtime, `
      SELECT submitted_at_ms AS at FROM submission_arrival_facts ORDER BY submitted_at_ms
    `);
    const reviews = times(runtime, `
      SELECT occurred_at_ms AS at FROM operation_log
       WHERE operation_name = 'review.evaluation.change'
         AND summary = 'Submitted a review'
       ORDER BY occurred_at_ms
    `);
    const decisions = times(runtime, `
      SELECT decided_at_ms AS at FROM decision_heads ORDER BY decided_at_ms
    `);

    expect(arrivals).toHaveLength(20);
    expect(new Set(arrivals).size).toBe(20);
    expect(reviews).toHaveLength(108);
    expect(new Set(reviews).size).toBe(6);
    expect(decisions).toHaveLength(14);
    expect(new Set(decisions).size).toBe(14);

    const flow = [...arrivals, ...reviews, ...decisions];
    const spread = Math.max(...flow) - Math.min(...flow);
    expect(spread).toBeGreaterThanOrEqual(6 * 7 * DAY_MS);
    expect(spread).toBeLessThanOrEqual(10 * 7 * DAY_MS);
    expect(Math.max(...arrivals)).toBeLessThan(Math.min(...reviews));
    expect(Math.max(...arrivals)).toBeLessThanOrEqual(Math.min(...decisions));

    const beforeRead = Date.now();
    const restored = Date.parse(clock.now());
    expect(restored).toBeGreaterThanOrEqual(beforeRead);
    expect(restored).toBeLessThanOrEqual(Date.now());
  }, 120_000);
});
