import { tintStep } from '$lib/api/standing';

/**
 * A score is inked by its own value on the absolute good/bad ramp, in the
 * badge tones the system already carries — so a row of weak scores looks weak
 * at a glance instead of reading as identical chips. The steps come from
 * `tintStep`, the same arithmetic the standing mark tints its points with, so
 * a score chip and the pack beside it cannot drift apart.
 */
const SCORE_TONES = [
	'ui-badge--danger',
	'ui-badge--warning',
	'ui-badge--neutral',
	'ui-badge--success',
	'ui-badge--success'
] as const;

/** The badge tone class for one score on the plan's scale. */
export function scoreTone(value: number, scaleMax: number): string {
	return SCORE_TONES[tintStep(value, scaleMax)];
}

/** True on the ramp's top step, where a chip may carry its strong treatment. */
export function isTopScore(value: number, scaleMax: number): boolean {
	return tintStep(value, scaleMax) === 4;
}
