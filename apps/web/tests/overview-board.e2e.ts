import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The Overview pipeline lanes: one lane per stage, metered only where the
 * scenario states a real denominator, paced only against the governing
 * deadline, and pressable as a single door that lands on the same address the
 * sidebar badge re-aims to.
 */

const CRUNCH = 'crunch';
const QUIET = 'quiet';
const OPENING = 'opening';

function pipeline(page: Page) {
	return page.getByRole('region', { name: 'Pipeline' });
}

function lane(page: Page, stage: string) {
	return pipeline(page).locator(`[data-stage="${stage}"]`);
}

test.describe('a steady mid-flight event', () => {
	// The default scenario: no cookie needed.

	test('attention leads the pipeline, meters only real denominators, and lanes stay calm on pace', async ({
		page
	}) => {
		await page.goto('/app');
		await expect(lane(page, 'review')).toBeVisible({ timeout: 15000 });

		// The attention queue is required reading, so it precedes the lane
		// panel in the DOM; the pipeline is orientation, never required reading.
		const attentionFirst = await page.evaluate(() => {
			const lanes = document.querySelector('[aria-label="Pipeline"]');
			const attention = document.querySelector('[aria-label="Needs attention"]');
			if (!lanes || !attention) return null;
			return Boolean(attention.compareDocumentPosition(lanes) & Node.DOCUMENT_POSITION_FOLLOWING);
		});
		expect(attentionFirst).toBe(true);

		// Review has a stated denominator, so it carries a meter whose digits
		// are absolute — and it is on pace, so no pace word appears anywhere.
		const review = lane(page, 'review');
		await expect(review).toContainText('224 of 360');
		await expect(review.locator('.lane__track')).toHaveCount(1);
		await expect(review.locator('.lane__pace')).toHaveCount(0);
		await expect(review).toHaveAccessibleName('Review: 224 of 360, due Aug 28 — open Review');

		// The words the lane always carried are still there beside the meter.
		await expect(review).toContainText('62%');
		await expect(review).toContainText('224 of 360 · due in 18 days');

		// Speakers states no roster target, so it keeps words and health only —
		// no meter — while its lateness still shows as the one pace chip allowed.
		const speakers = lane(page, 'speakers');
		await expect(speakers.locator('.lane__track')).toHaveCount(0);
		await expect(speakers.locator('.lane__pace')).toHaveText('behind');

		// The document itself never scrolls sideways.
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(1);
	});

	test('a lane is one door and lands where the nav badge re-aims', async ({ page }) => {
		await page.goto('/app');
		const schedule = lane(page, 'schedule');
		await expect(schedule).toBeVisible({ timeout: 15000 });

		// Behind pace shows as a chip beside the quiet deadline text.
		await expect(schedule.locator('.lane__pace')).toHaveText('behind');
		await expect(schedule).toContainText('publish target Sep 25');
		await expect(schedule).toHaveAccessibleName(
			'Schedule: 16 of 27, behind, publish target Sep 25 — open Schedule'
		);

		// A blocked schedule opens the conflicts panel, exactly like the
		// sidebar's danger count does.
		await schedule.click();
		await expect(page).toHaveURL(/\/app\/schedule\?panel=conflicts$/);
	});
});

test.describe('a crunch week', () => {
	test.beforeEach(async ({ context, baseURL }) => {
		await context.addCookies([
			{ name: 'je-scenario', value: CRUNCH, url: baseURL ?? 'http://127.0.0.1:4173' }
		]);
	});

	test('a nearly-full meter still says behind when the clock does', async ({ page }) => {
		await page.goto('/app');
		const review = lane(page, 'review');
		await expect(review).toBeVisible({ timeout: 15000 });

		// 97% reads calm; pace answers the deadline, so the chip contradicts
		// the fraction on purpose.
		await expect(review).toContainText('583 of 600');
		await expect(review.locator('.lane__fill')).toHaveAttribute('style', /97%/);
		await expect(review.locator('.lane__pace')).toHaveText('behind');
		await expect(review).toContainText('due tomorrow');
	});

	test('the decisions lane is behind and its door opens the unnotified slice', async ({
		page
	}) => {
		await page.goto('/app');
		const decide = lane(page, 'decide');
		await expect(decide).toBeVisible({ timeout: 15000 });

		await expect(decide.locator('.lane__pace')).toHaveText('behind');
		await expect(decide).toHaveAccessibleName(
			'Decide: 138 of 300, behind, notify by Aug 13 — open Decisions'
		);

		await decide.click();
		await expect(page).toHaveURL(/\/app\/decisions\?scope=unnotified$/);
	});
});

test.describe('a quiet, on-track event', () => {
	test.beforeEach(async ({ context, baseURL }) => {
		await context.addCookies([
			{ name: 'je-scenario', value: QUIET, url: baseURL ?? 'http://127.0.0.1:4173' }
		]);
	});

	test('full meters carry no pace chips: done on time is calm, not a party', async ({ page }) => {
		await page.goto('/app');
		await expect(lane(page, 'review')).toBeVisible({ timeout: 15000 });

		const lanes = pipeline(page);
		await expect(lanes.locator('.lane__track')).toHaveCount(4);
		await expect(lanes.locator('.lane__pace')).toHaveCount(0);

		// Closed work fills to the end; the one stage still in motion shows its
		// honest fraction — and stays chipless because it is on pace.
		for (const stage of ['review', 'decide', 'schedule']) {
			await expect(lane(page, stage).locator('.lane__fill')).toHaveAttribute('style', /100%/);
		}
		await expect(lane(page, 'speakers')).toContainText('134 of 140');
		await expect(lane(page, 'speakers').locator('.lane__fill')).toHaveAttribute('style', /96%/);
	});
});

test.describe('the first days of a CFP', () => {
	test.beforeEach(async ({ context, baseURL }) => {
		await context.addCookies([
			{ name: 'je-scenario', value: OPENING, url: baseURL ?? 'http://127.0.0.1:4173' }
		]);
	});

	test('no plan means no meter — absence of measurement is not 0%', async ({ page }) => {
		await page.goto('/app');
		const review = lane(page, 'review');
		await expect(review).toBeVisible({ timeout: 15000 });

		await expect(review.locator('.lane__track')).toHaveCount(0);
		await expect(review.locator('.lane__pace')).toHaveCount(0);
		await expect(review).toContainText('round not open yet');
	});
});
