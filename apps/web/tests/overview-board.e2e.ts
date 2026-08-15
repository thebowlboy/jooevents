import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The Overview's three reading regions, in the order an operator meets them:
 * the key-numbers band (what is new, and how far along everything is), the
 * attention queue, and the pipeline lanes — metered only where the scenario
 * states a real denominator, paced only against the governing deadline, and
 * pressable as a single door that lands on the same address the sidebar badge
 * re-aims to.
 *
 * Dates here are authored relative to the day the workspace is opened, so the
 * assertions name shapes rather than particular days: a scenario pinned to
 * `Aug 28` starts lying the following week, which is the defect that moved
 * every deadline in this surface onto the shared date vocabulary.
 */

const CRUNCH = 'crunch';
const QUIET = 'quiet';
const OPENING = 'opening';
const FLIGHT = 'flight';

function pipeline(page: Page) {
	return page.getByRole('region', { name: 'Pipeline' });
}

function lane(page: Page, stage: string) {
	return pipeline(page).locator(`[data-stage="${stage}"]`);
}

function band(page: Page) {
	return page.getByRole('region', { name: 'Key numbers' });
}

test.describe('a steady mid-flight event', () => {
	test.beforeEach(async ({ context, baseURL }) => {
		await context.addCookies([
			{ name: 'je-scenario', value: FLIGHT, url: baseURL ?? 'http://127.0.0.1:4173' }
		]);
	});

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
		await expect(review.locator('.ui-meter')).toHaveCount(1);
		await expect(review.locator('.lane__pace')).toHaveCount(0);

		// Both halves of the deadline: which day, and how far away. Neither works
		// alone — a date with no distance is arithmetic homework, a countdown with
		// no date leaves nothing to diarise.
		await expect(review).toHaveAccessibleName(
			/^Review: 224 of 360, due \d{1,2}\s\w{3}, in \d+ weeks? — open Review$/
		);
		await expect(review).toContainText('62%');
		await expect(review.locator('.lane__deadline')).toContainText('due');

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

		// Behind pace shows as a badge beside the quiet deadline text. Sentence
		// case, because it sits in a row of badges rather than in a sentence.
		await expect(schedule.getByText('Behind', { exact: true })).toBeVisible();
		await expect(schedule).toContainText('publish target');
		await expect(schedule).toHaveAccessibleName(
			/^Schedule: 8 of 12, behind, publish target \d{1,2}\s\w{3}, in \d+ months? — open Schedule$/
		);

		// The lane is an orientation door and lands at the area root — the
		// conflicts fact keeps its own scoped door on the attention row and on
		// the schedule head's count (owner refinement, 2026-08-13).
		await schedule.click();
		await expect(page).toHaveURL(/\/app\/schedule$/);
	});

	test('the arrival tile counts today for someone who is here most days', async ({ page }) => {
		await page.goto('/app');
		await expect(band(page)).toBeVisible({ timeout: 15000 });

		// Five days of visits in the last week is a daily habit, so the diff worth
		// showing is today's — the window is chosen from the rotation, not fixed.
		await expect(band(page)).toContainText(/\+\d+ today/);
		// Thirteen held rows, not the fourteen collected: the discarded proposal
		// is recoverable, but it is not work the event has to get through.
		await expect(band(page).getByText('13', { exact: true })).toBeVisible();
	});

	test('the weekly breakdown opens on press, and says what it left out', async ({ page }) => {
		await page.goto('/app');
		await expect(band(page)).toBeVisible({ timeout: 15000 });

		const figure = band(page).locator('button[aria-expanded]').first();
		await expect(figure).toHaveAttribute('aria-expanded', 'false');
		// The plot is the control, and its name says what pressing it opens. The
		// visible scale label rides the same line where there is room for it and
		// is dropped on a phone column, so the assertion is the name rather than
		// the words — which differ by width on purpose.
		await expect(figure).toHaveAttribute('aria-label', /show the weekly breakdown$/);
		// It sits on the value's own line rather than a row of its own: a tile
		// 57px taller than its three neighbours left white space under all of them.
		const tiles = band(page).locator('article');
		const arrivals = await tiles.first().boundingBox();
		const neighbour = await tiles.nth(1).boundingBox();
		expect(Math.abs((arrivals?.height ?? 0) - (neighbour?.height ?? 0))).toBeLessThanOrEqual(1);

		await figure.click();
		await expect(figure).toHaveAttribute('aria-expanded', 'true');
		const panel = page.locator('.ui-popover__panel').first();
		await expect(panel).toContainText('This week');
		await expect(panel).toContainText('Held now');
		await expect(panel).toContainText('1 proposal marked as spam is not counted in that total.');

		// Escape closes it and returns focus to the figure that opened it.
		await page.keyboard.press('Escape');
		await expect(figure).toHaveAttribute('aria-expanded', 'false');
		await expect(figure).toBeFocused();
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

		// 97% reads calm; pace answers the deadline, so the badge contradicts
		// the fraction on purpose — and the bar is amber rather than green
		// because the fill answers the state, never the fraction.
		await expect(review).toContainText('583 of 600');
		await expect(review.locator('.ui-meter__fill')).toHaveAttribute('style', /97%/);
		await expect(review.locator('.ui-meter')).toHaveClass(/ui-meter--warning/);
		await expect(review.getByText('Behind', { exact: true })).toBeVisible();
		await expect(review.locator('.lane__deadline')).toContainText('tomorrow');
	});

	test('the decisions lane is behind and its door opens the unnotified slice', async ({
		page
	}) => {
		await page.goto('/app');
		const decide = lane(page, 'decide');
		await expect(decide).toBeVisible({ timeout: 15000 });

		await expect(decide.getByText('Behind', { exact: true })).toBeVisible();
		await expect(decide).toHaveAccessibleName(
			/^Decide: 6 of 16, behind, notify by \d{1,2}\s\w{3}, in \d+ days — open Decisions$/
		);

		await decide.click();
		await expect(page).toHaveURL(/\/app\/decisions\?scope=unnotified$/);
	});

	test('an absence widens the arrival window to cover it', async ({ page }) => {
		await page.goto('/app');
		await expect(band(page)).toBeVisible({ timeout: 15000 });

		// Last here nearly two weeks ago: neither today nor this week covers what
		// they missed, so the window becomes the absence itself and says so.
		await expect(band(page)).toContainText('since your last visit');

		await band(page).locator('button[aria-expanded]').first().click();
		await expect(page.locator('.ui-popover__panel').first()).toContainText(
			'Counted since your last visit'
		);
	});

	test('only act-now is solid; the rest of the queue stays on the soft rung', async ({ page }) => {
		await page.goto('/app');
		const attention = page.getByRole('region', { name: 'Needs attention' });
		await expect(attention).toBeVisible({ timeout: 15000 });

		// The one act-now item is the banner, so the list below it carries no
		// solid badge at all: a column of them spends the page's whole emphasis
		// budget on rows that are merely next.
		await expect(attention.locator('.ui-badge--solid')).toHaveCount(0);
		await expect(attention.locator('.ui-badge--warning').first()).toBeVisible();
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
		await expect(lanes.locator('.ui-meter')).toHaveCount(4);
		await expect(lanes.locator('.lane__pace')).toHaveCount(0);

		// Closed work fills to the end; the one stage still in motion shows its
		// honest fraction — and stays chipless because it is on pace.
		for (const stage of ['review', 'decide', 'schedule']) {
			await expect(lane(page, stage).locator('.ui-meter__fill')).toHaveAttribute('style', /100%/);
			// Healthy is green, which is the reading a person already arrives with.
			await expect(lane(page, stage).locator('.ui-meter')).toHaveClass(/ui-meter--success/);
		}
		await expect(lane(page, 'speakers')).toContainText('48 of 50');
		await expect(lane(page, 'speakers').locator('.ui-meter__fill')).toHaveAttribute('style', /96%/);
	});

	test('a settled deadline reads passed, not overdue, and steps back from the live rows', async ({
		page
	}) => {
		await page.goto('/app');
		const deadlines = page.getByRole('region', { name: 'Deadlines' });
		await expect(deadlines).toBeVisible({ timeout: 15000 });

		// The schedule went out a week ago. Its obligation is discharged, so it
		// carries `Passed` rather than shouting `Overdue` at someone with nothing
		// left to do — and it recedes to quiet ink beside the live rows.
		const published = deadlines.locator('li', { hasText: 'Schedule published' });
		await expect(published).toContainText('Passed');
		await expect(published).toHaveClass(/dates__row--quiet/);
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

		await expect(review.locator('.ui-meter')).toHaveCount(0);
		await expect(review.locator('.lane__pace')).toHaveCount(0);
		await expect(review).toContainText('round not open yet');
	});

	test('an occasional visitor is counted from Monday', async ({ page }) => {
		await page.goto('/app');
		await expect(band(page)).toBeVisible({ timeout: 15000 });

		await band(page).locator('button[aria-expanded]').first().click();
		await expect(page.locator('.ui-popover__panel').first()).toContainText('Counted from Monday');
	});
});
