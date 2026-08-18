import { afterEach, describe, expect, test } from 'bun:test';
import {
  createReadOperationResultSchema,
  servedPublicFormSchema,
  servedPublicScheduleSchema
} from '@jooevents/contracts';
import { loadEphemeralLiveConfig } from '../config';
import { createDevFixtureClock } from '../runtime/dev-fixture-clock';
import { createEphemeralLiveRuntime, type EphemeralLiveRuntime } from '../runtime/ephemeral-live';
import { seedJooConPlayground } from './joocon-playground-seed';

const DAY_MS = 86_400_000;
const runtimes: EphemeralLiveRuntime[] = [];
const servedPublicFormReadResultSchema = createReadOperationResultSchema(servedPublicFormSchema);
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

describe('JooCon playground seed timeline', () => {
  test('builds its real-operation corpus across nine weeks and restores wall time', async () => {
    const anchor = new Date('2026-08-17T12:00:00.000Z');
    const clock = createDevFixtureClock(anchor);
    const runtime = await createEphemeralLiveRuntime({ config, devFixtureClock: clock });
    runtimes.push(runtime);

    const summary = await seedJooConPlayground({ runtime, config, clock });
    expect(summary).toMatchObject({
      submissions: 9,
      committedReviews: 6,
      accepted: 5,
      waitlisted: 1,
      declined: 1,
      conditionalRules: 2,
      sessionFiles: 2
    });

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
      data: { formId: summary.applyFormId, formVersionNumber: 1 }
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
      (session) => session.title === 'Agents That Ask Before They Act'
    )?.description).toBe(
      'A practical tour of approval-bound agents: typed operations, visible plans, and the refusal paths that keep effective state under human control.'
    );

    const sessionFileLinks = runtime.database.sqlite.query<
      { readonly count: number; readonly engagement_count: number }, []
    >(`
      SELECT count(*) AS count,
             sum(CASE WHEN subject_kind = 'engagement' THEN 1 ELSE 0 END) AS engagement_count
        FROM file_attachments
       WHERE state = 'attached'
    `).get();
    expect(sessionFileLinks).toEqual({ count: 2, engagement_count: 2 });

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

    expect(arrivals).toHaveLength(9);
    expect(new Set(arrivals).size).toBe(9);
    expect(reviews).toHaveLength(6);
    expect(new Set(reviews).size).toBe(6);
    expect(decisions).toHaveLength(7);
    expect(new Set(decisions).size).toBe(7);

    const flow = [...arrivals, ...reviews, ...decisions];
    const spread = Math.max(...flow) - Math.min(...flow);
    expect(spread).toBeGreaterThanOrEqual(6 * 7 * DAY_MS);
    expect(spread).toBeLessThanOrEqual(10 * 7 * DAY_MS);
    expect(Math.max(...arrivals)).toBeLessThan(Math.min(...reviews));
    expect(Math.max(...reviews)).toBeLessThan(Math.min(...decisions));

    const beforeRead = Date.now();
    const restored = Date.parse(clock.now());
    expect(restored).toBeGreaterThanOrEqual(beforeRead);
    expect(restored).toBeLessThanOrEqual(Date.now());
  }, 30_000);
});
