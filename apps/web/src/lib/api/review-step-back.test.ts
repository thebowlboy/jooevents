import { describe, expect, test } from 'bun:test';
import { composeStepBackRefusal } from './reviewers';

/**
 * Stepping back over a conflict of interest, and what it is allowed to move.
 *
 * The arithmetic is the contract: an uncovered review stays inside the original
 * reviewer's `assigned`, so a plan's denominator never moves, and
 * `awaitingReassignment` never passes `steppedBack`.
 */

type Api = typeof import('./workspace').api;

const REVIEWER = 'mem-2';

/**
 * The sample dataset is module state, and other suites in this process commit
 * reviews out of the same queue. Each case loads its own instance of the api so
 * what it steps back from is its own subject rather than whatever ran first.
 */
let instance = 0;
async function freshApi(): Promise<Api> {
	const loaded = (await import(`./workspace?step-back=${(instance += 1)}`)) as { api: Api };
	return loaded.api;
}

/** Snapshotted: the sample api hands back its own records, not copies. */
async function rosterRow(api: Api, reviewerId: string) {
	const plan = (await api.review.plans())[0];
	const row = plan.reviewers.find((entry) => entry.id === reviewerId);
	if (!row) throw new Error(`no roster row for ${reviewerId}`);
	return { plan: { ...plan }, row: { ...row } };
}

describe('a reviewer stepping back', () => {
	test('the review leaves the queue, the denominators do not move', async () => {
		const api = await freshApi();
		const queueBefore = await api.review.myQueue();
		const open = queueBefore.find((item) => !item.committed);
		if (!open) throw new Error('the sample queue carries no open review');
		const { plan: planBefore, row: before } = await rosterRow(api, REVIEWER);

		const outcome = await api.review.stepBack(open.submissionId, REVIEWER);
		expect(outcome.ok).toBe(true);

		const queueAfter = await api.review.myQueue();
		expect(queueAfter.some((item) => item.submissionId === open.submissionId)).toBe(false);
		expect(queueAfter).toHaveLength(queueBefore.length - 1);

		const { plan: planAfter, row: after } = await rosterRow(api, REVIEWER);
		expect(after.steppedBack).toBe(before.steppedBack + 1);
		expect(after.awaitingReassignment).toBe(before.awaitingReassignment + 1);
		expect(after.awaitingReassignment).toBeLessThanOrEqual(after.steppedBack);
		// The work still exists; it is simply nobody's yet.
		expect(after.assigned).toBe(before.assigned);
		expect(after.done).toBe(before.done);
		expect(planAfter.total).toBe(planBefore.total);
		expect(planAfter.done).toBe(planBefore.done);
	});

	test('a committed review refuses, in the sentence the card shows first', async () => {
		const api = await freshApi();
		const committed = (await api.review.myQueue()).find((item) => item.committed);
		if (!committed) throw new Error('the sample queue carries no committed review');
		const { row: before } = await rosterRow(api, REVIEWER);

		const outcome = await api.review.stepBack(committed.submissionId, REVIEWER);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		const submission = await api.submissions.get(committed.submissionId);
		expect(outcome.reason).toBe(composeStepBackRefusal(submission!.title));

		// A refusal writes nothing.
		expect(
			(await api.review.myQueue()).some((item) => item.submissionId === committed.submissionId)
		).toBe(true);
		const { row: after } = await rosterRow(api, REVIEWER);
		expect(after.steppedBack).toBe(before.steppedBack);
		expect(after.awaitingReassignment).toBe(before.awaitingReassignment);
	});

	test('a review that is no longer in the queue refuses rather than counting twice', async () => {
		const api = await freshApi();
		const outcome = await api.review.stepBack('sub-does-not-exist', REVIEWER);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain('no longer in your queue');
	});
});

describe('the scope a reviewer is shown on arrival', () => {
	test('a generalist holds no refs at all — the absence is the answer', async () => {
		const api = await freshApi();
		expect(await api.review.myScope('mem-2')).toEqual([]);
	});

	test('a scoped reviewer gets their own refs, not the roster around them', async () => {
		const api = await freshApi();
		expect(await api.review.myScope('mem-3')).toEqual([{ kind: 'track', id: 'trk-infra' }]);
	});

	test('an id nobody holds resolves to the generalist shape rather than throwing', async () => {
		const api = await freshApi();
		expect(await api.review.myScope('mem-nobody')).toEqual([]);
	});
});
