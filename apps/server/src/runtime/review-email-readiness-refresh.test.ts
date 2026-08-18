import { describe, expect, test } from 'bun:test';
import { createReviewEmailReadinessRefreshJob } from './review-email-readiness-refresh';

describe('organizer review email readiness refresh', () => {
  test('is absent outside organizer review mode', () => {
    const activation = { runReadinessCheck: async () => ({}) as never };
    expect(createReviewEmailReadinessRefreshJob({
      reviewEntryMode: 'disabled', providerActivation: activation, maximumValidityMs: 300_000,
      serializeWork: async (work) => work()
    })).toBeUndefined();
    expect(createReviewEmailReadinessRefreshJob({
      reviewEntryMode: 'organizer', maximumValidityMs: 300_000,
      serializeWork: async (work) => work()
    })).toBeUndefined();
  });

  test('runs the existing executor on start and one minute before five-minute expiry', async () => {
    let calls = 0;
    const job = createReviewEmailReadinessRefreshJob({
      reviewEntryMode: 'organizer',
      providerActivation: {
        runReadinessCheck: async () => {
          calls += 1;
          return { state: 'failed', readiness: 'blocked' } as never;
        }
      },
      maximumValidityMs: 300_000,
      serializeWork: async (work) => work()
    });
    expect(job).toMatchObject({
      name: 'review_email_readiness_refresh', intervalMs: 240_000, runOnStart: true
    });
    await job!.run();
    expect(calls).toBe(1);
  });
});
