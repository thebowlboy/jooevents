import type { ScoreStanding, StandingBand } from './types';

/**
 * Where one score stands inside its comparison slice.
 *
 * The claim is computed in one place because it is a claim: "higher than 78% of
 * 46 scored" is a sentence a chair will repeat to a speaker, so the number
 * behind it, the sentence, and the mark that draws it must come from the same
 * arithmetic rather than from whatever each surface rounded.
 */

/** Below this many scored submissions no percentile claim is honest. */
const FEW_BELOW = 8;

/** Past this many, a strip stops being countable and the slice ships as mass. */
const POINT_LIMIT = 120;

/** Bins over [1, scaleMax] for the high-count form. */
const BINS = 24;

/**
 * The value's step on the absolute good/bad ramp, 0 (lowest) to 4 (highest).
 * Cohort marks carry absolute meaning as well as relative position, so the ink
 * of a point is decided by its own value, not by where it sits in the pack.
 */
export function tintStep(value: number, scaleMax: number): number {
	const span = scaleMax - 1;
	const t = span > 0 ? (value - 1) / span : 0;
	if (t < 0.2) return 0;
	if (t < 0.4) return 1;
	if (t < 0.6) return 2;
	if (t < 0.8) return 3;
	return 4;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const raw = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	return Math.round(raw * 10) / 10;
}

function binCounts(values: number[], scaleMax: number): number[] {
	const counts = new Array<number>(BINS).fill(0);
	const span = scaleMax - 1;
	for (const value of values) {
		const t = span > 0 ? (value - 1) / span : 0;
		const index = Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)));
		counts[index] += 1;
	}
	return counts;
}

function bandOf(n: number, value: number, share: number, highest: number, lowest: number): StandingBand {
	// Size is answered before position: too small a slice makes every other
	// claim on this list unsayable, so it is not one of the alternatives.
	if (n < FEW_BELOW) return 'few';
	if (value > highest || share >= 0.9) return 'top';
	if (share >= 0.75) return 'upper';
	if (value < lowest || share <= 0.1) return 'bottom';
	if (share <= 0.25) return 'lower';
	return 'mid';
}

function phraseOf(n: number, value: number, share: number, highest: number, lowest: number): string {
	if (n < FEW_BELOW) return `Only ${n} scored so far — too few to rank`;
	if (value > highest) return `Highest of ${n} scored`;
	if (value < lowest) return `Lowest of ${n} scored`;
	return `Higher than ${Math.round(share * 100)}% of ${n} scored`;
}

/**
 * @param value    this submission's review average
 * @param scaleMax the review scale's top mark
 * @param others   every OTHER scored submission's average in the slice
 * @param reviews  committed reviews on this submission
 * @param slice    what the comparison is against, named for the reader
 */
export function computeStanding(
	value: number,
	scaleMax: number,
	others: number[],
	reviews: number,
	slice: { label: string; trackId?: string }
): ScoreStanding {
	const n = others.length + 1;

	// An exact tie counts as half: two identical averages cannot each be above
	// the other, and neither is above itself.
	let below = 0;
	let ties = 0;
	for (const other of others) {
		if (other < value) below += 1;
		else if (other === value) ties += 1;
	}
	const share = others.length > 0 ? (below + ties / 2) / others.length : 0;

	// The ends of the pack, the focus excluded, so "strictly highest" is a claim
	// about the others. An empty slice falls back to the focus: nothing is then
	// strictly above or below anything, which is what n = 1 means.
	const highest =
		others.length > 0 ? others.reduce((top, other) => (other > top ? other : top), others[0]) : value;
	const lowest =
		others.length > 0 ? others.reduce((low, other) => (other < low ? other : low), others[0]) : value;

	const standing: ScoreStanding = {
		value,
		scaleMax,
		reviews,
		n,
		median: median([...others, value]),
		band: bandOf(n, value, share, highest, lowest),
		phrase: phraseOf(n, value, share, highest, lowest),
		slice: slice.trackId ? { label: slice.label, trackId: slice.trackId } : { label: slice.label }
	};

	if (n <= POINT_LIMIT) {
		standing.points = [...others];
		standing.dotK = 1;
	} else {
		standing.bins = binCounts([...others, value], scaleMax);
		standing.dotK = Math.ceil(others.length / POINT_LIMIT);
	}
	return standing;
}
