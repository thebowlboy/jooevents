import { describe, expect, test } from 'bun:test';
import { computeStanding, tintStep } from './standing';
import { api } from './workspace';
import { scenarios } from './sample/registry';

const slice = { label: 'Agents & Tools', trackId: 'trk-web' };

/** Twenty distinct values, 1.0 to 4.8, so a focus can be placed at an exact share. */
const grid = Array.from({ length: 20 }, (_, index) => Number((1 + index * 0.2).toFixed(1)));

function bandOf(focus: number, others: number[] = grid): string {
	return computeStanding(focus, 5, others, 3, slice).band;
}

function phraseOf(focus: number, others: number[] = grid): string {
	return computeStanding(focus, 5, others, 3, slice).phrase;
}

describe('standing bands', () => {
	test('each threshold is inclusive on the side the contract states', () => {
		// 20 others, so every share below is exact: below / 20.
		expect(bandOf(4.5)).toBe('top'); // 18 below → 0.90
		expect(bandOf(4.3)).toBe('upper'); // 17 below → 0.85
		expect(bandOf(3.9)).toBe('upper'); // 15 below → 0.75
		expect(bandOf(3.7)).toBe('mid'); // 14 below → 0.70
		expect(bandOf(2.1)).toBe('mid'); // 6 below → 0.30
		expect(bandOf(1.9)).toBe('lower'); // 5 below → 0.25
		expect(bandOf(1.5)).toBe('lower'); // 3 below → 0.15
		expect(bandOf(1.3)).toBe('bottom'); // 2 below → 0.10
	});

	test('a strict maximum is top and a strict minimum is bottom, whatever the share', () => {
		expect(bandOf(5)).toBe('top');
		expect(phraseOf(5)).toBe('Highest of 21 scored');

		// Eight tightly packed others: the focus clears none of them.
		const packed = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 4.8, 5.0];
		expect(bandOf(1.4, packed)).toBe('bottom');
		expect(phraseOf(1.4, packed)).toBe('Lowest of 9 scored');
	});

	test('an exact tie counts as half, never as cleared', () => {
		const others = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
		const standing = computeStanding(3, 5, others, 4, slice);
		// 4 below and 2 ties → (4 + 1) / 10, not 4/10 and not 6/10.
		expect(standing.phrase).toBe('Higher than 50% of 11 scored');
		expect(standing.band).toBe('mid');

		// Ties alone cannot lift a value above the pack it is tied with.
		const allTied = computeStanding(4, 5, [4, 4, 4, 4, 4, 4, 4], 2, slice);
		expect(allTied.phrase).toBe('Higher than 50% of 8 scored');
		expect(allTied.band).toBe('mid');
	});
});

describe('too few to rank', () => {
	test('the guard is answered before any other claim: n=7 refuses, n=8 ranks', () => {
		const seven = computeStanding(5, 5, [1, 2, 3, 3, 4, 4], 1, slice);
		expect(seven.n).toBe(7);
		expect(seven.band).toBe('few');
		// Even a strict maximum makes no claim while the slice is this small.
		expect(seven.phrase).toBe('Only 7 scored so far — too few to rank');

		const eight = computeStanding(5, 5, [1, 2, 3, 3, 4, 4, 4], 1, slice);
		expect(eight.n).toBe(8);
		expect(eight.band).toBe('top');
		expect(eight.phrase).toBe('Highest of 8 scored');
	});
});

describe('standing phrases', () => {
	test('say what the slice supports and nothing more', () => {
		expect(phraseOf(4.7)).toBe('Higher than 95% of 21 scored');
		expect(phraseOf(1.3)).toBe('Higher than 10% of 21 scored');
		expect(phraseOf(5)).toBe('Highest of 21 scored');
		expect(computeStanding(3, 5, [3, 3, 3], 1, slice).phrase).toBe(
			'Only 4 scored so far — too few to rank'
		);
	});

	test('the median covers the whole slice, focus included, at one decimal', () => {
		expect(computeStanding(5, 5, [1, 2, 3, 4, 4, 4, 5], 3, slice).median).toBe(4);
		// An even slice takes the midpoint of the two middle values.
		expect(computeStanding(4, 5, [1, 2, 3, 3, 4, 5, 5], 3, slice).median).toBe(3.5);
	});
});

describe('plotted form', () => {
	test('a countable slice ships its points; past 120 it ships binned mass', () => {
		const countable = computeStanding(3.5, 5, new Array(119).fill(3.5), 5, slice);
		expect(countable.n).toBe(120);
		expect(countable.points).toHaveLength(119);
		expect(countable.bins).toBeUndefined();
		expect(countable.dotK).toBe(1);

		const heavy = computeStanding(
			3.5,
			5,
			Array.from({ length: 260 }, (_, index) => Number((1 + (index % 41) * 0.1).toFixed(1))),
			5,
			slice
		);
		expect(heavy.n).toBe(261);
		expect(heavy.points).toBeUndefined();
		expect(heavy.bins).toHaveLength(24);
		// Every scored submission is in exactly one bin, the focus included.
		expect(heavy.bins?.reduce((sum, count) => sum + count, 0)).toBe(261);
		expect(heavy.dotK).toBe(3);
	});
});

describe('value tint', () => {
	test('steps on the absolute scale, independent of the pack', () => {
		expect(tintStep(1, 5)).toBe(0);
		expect(tintStep(1.2, 5)).toBe(0);
		expect(tintStep(2.2, 5)).toBe(1);
		expect(tintStep(3, 5)).toBe(2);
		expect(tintStep(3.8, 5)).toBe(3);
		expect(tintStep(4.6, 5)).toBe(4);
		expect(tintStep(5, 5)).toBe(4);
		// The same five steps stretch over any scale.
		expect(tintStep(1, 10)).toBe(0);
		expect(tintStep(5.5, 10)).toBe(2);
		expect(tintStep(10, 10)).toBe(4);
	});
});

describe('sample distributions', () => {
	test('every scored submission appears in its own track population', () => {
		for (const dataset of scenarios) {
			const distributions = dataset.reviewDistributions ?? {};
			for (const trackId of Object.keys(distributions)) {
				expect(dataset.tracks.some((track) => track.id === trackId)).toBe(true);
			}
			const scaleMax = dataset.reviewPlans[0]?.scaleMax ?? 5;
			for (const submission of dataset.submissions) {
				if (submission.reviewAverage === undefined) continue;
				const population = distributions[submission.trackId];
				expect(Array.isArray(population)).toBe(true);
				expect(population).toContain(submission.reviewAverage);
				expect(population.length).toBeGreaterThanOrEqual(
					dataset.submissions.filter(
						(row) => row.trackId === submission.trackId && row.reviewAverage !== undefined
					).length
				);
			}
			for (const values of Object.values(distributions)) {
				for (const value of values) {
					expect(value).toBeGreaterThanOrEqual(1);
					expect(value).toBeLessThanOrEqual(scaleMax);
				}
			}
		}
	});
});

/*
 * These run against the loaded scenario through the same facade a screen uses,
 * and they mutate its working copy in order: comparables is read before the
 * queue is committed, because "committed only" is exactly what it asserts.
 */
describe('review facade', () => {
	test('comparables carry my other committed reviews, never the anchor', async () => {
		const fromOpen = await api.review.comparables('sub-105', 'all');
		expect(fromOpen.map((card) => card.item.submissionId)).toEqual(['sub-104']);
		expect(fromOpen[0].submission.id).toBe('sub-104');

		// The anchor is not a comparable of itself, and nothing uncommitted is.
		expect(await api.review.comparables('sub-104', 'all')).toEqual([]);
		// sub-104 is Infrastructure and sub-105 is Agents & Tools.
		expect(await api.review.comparables('sub-105', 'track')).toEqual([]);
	});

	test('a standing is null until the submission has an average and a population', async () => {
		const ranked = await api.review.standing('sub-101');
		expect(ranked?.band).toBe('top');
		expect(ranked?.slice.trackId).toBe('trk-web');
		expect(ranked?.reviews).toBe(3);
		// Its own average is not counted among the others it is compared to.
		expect(ranked?.n).toBe(46);
		expect(ranked?.points).toHaveLength(45);

		// Too few scored in this track for any percentile claim.
		expect((await api.review.standing('sub-103'))?.band).toBe('few');
		// No average yet.
		expect(await api.review.standing('sub-108')).toBeNull();

		const batch = await api.review.standings(['sub-101', 'sub-108']);
		expect(Object.keys(batch)).toEqual(['sub-101']);
	});

	test('an amendment keeps what it replaced, and reverting puts it back', async () => {
		const amended = await api.review.amend('sub-104', 5, 'Raised after reading the peer notes.');
		expect(amended?.myScore).toBe(5);
		expect(amended?.revisions).toEqual([
			{
				score: 4,
				comment: 'Strong war story; verify the outbox section fits 30 minutes.',
				at: 'just now',
				postUnlock: true
			}
		]);

		const reverted = await api.review.revertAmend('sub-104');
		expect(reverted?.myScore).toBe(4);
		expect(reverted?.myComment).toBe('Strong war story; verify the outbox section fits 30 minutes.');
		expect(reverted?.revisions).toBeUndefined();

		// An uncommitted review is not amendable at all.
		expect(await api.review.amend('sub-105', 4, 'Not committed yet.')).toBeNull();
	});

	test('a capped accolade refuses the fourth pin and names the three holding it', async () => {
		const defs = await api.review.accoladeDefs();
		expect(defs.find((def) => def.key === 'top_pick')).toEqual({
			key: 'top_pick',
			label: 'Top pick',
			cap: 3
		});
		expect(defs.find((def) => def.key === 'crowd_draw')?.cap).toBeUndefined();

		// Pinning is a mark on a committed review, so an open one refuses first.
		const tooEarly = await api.review.pinAccolade('sub-105', 'top_pick');
		expect(tooEarly).toEqual({
			ok: false,
			reason:
				'Commit your review of “Hands-on: AI Interface Audits That Stick” before pinning an accolade to it'
		});

		for (const id of ['sub-105', 'sub-106', 'sub-107']) {
			await api.review.saveReview(id, 4, 'Committed so the cap is reachable.');
			await api.review.commitReview(id);
		}

		for (const id of ['sub-104', 'sub-105', 'sub-106']) {
			expect(await api.review.pinAccolade(id, 'top_pick')).toEqual({ ok: true });
		}
		// Pinning what is already pinned changes nothing and refuses nothing.
		expect(await api.review.pinAccolade('sub-104', 'top_pick')).toEqual({ ok: true });

		const refused = await api.review.pinAccolade('sub-107', 'top_pick');
		expect(refused).toEqual({
			ok: false,
			reason:
				'Top pick is capped at 3 and already on “Durable Agent Jobs: A Queueing Confession”, “Hands-on: AI Interface Audits That Stick”, and “The Inference Bill Nobody Read” — unpin one first.'
		});

		// An uncapped key is never in the way of itself.
		expect(await api.review.pinAccolade('sub-107', 'crowd_draw')).toEqual({ ok: true });

		// Unpinning frees exactly one slot.
		expect(await api.review.unpinAccolade('sub-104', 'top_pick')).toEqual({ ok: true });
		expect(await api.review.pinAccolade('sub-107', 'top_pick')).toEqual({ ok: true });
		const queue = await api.review.myQueue();
		expect(queue.find((item) => item.submissionId === 'sub-107')?.accolades).toEqual([
			'crowd_draw',
			'top_pick'
		]);
		expect(queue.find((item) => item.submissionId === 'sub-104')?.accolades).toBeUndefined();
	});
});
