import { expect, test, type Page } from '@playwright/test';

/**
 * Pulse: the descriptive register. The acceptance-shaped loop: an operator on
 * the Overview follows the Pulse rail row beside Overview, lands on
 * /app/pulse, reads the three heartbeat panels, opens a plot's weekly
 * breakdown, and reads the decision spread and per-track fill — with worded
 * absences instead of zero charts wherever a flow has not begun.
 *
 * Numbers asserted here are the scenario stories' own; weeks are pinned to
 * real event-local Mondays at read time, so assertions name shapes and
 * totals rather than particular dates.
 */

async function useScenario(page: Page, key: string) {
	await page.context().addCookies([
		{
			name: 'je-scenario',
			value: key,
			domain: '127.0.0.1',
			path: '/'
		}
	]);
}

async function expectNoDocumentOverflow(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
}

test('mid-flight: the rail row lands on Pulse, and every region tells the flight story', async ({
	page
}, testInfo) => {
	await useScenario(page, 'flight');
	await page.goto('/app');

	// The rail row beside Overview; on touch the drawer opens first.
	if (testInfo.project.name === 'mobile') {
		await page.getByRole('button', { name: 'Open navigation' }).click();
	}
	const row = page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Pulse' });
	await expect(row).toBeVisible({ timeout: 15000 });
	await row.click();
	await expect(page).toHaveURL(/\/app\/pulse$/);

	// The hero band: the vanity figures at display size, over the cumulative
	// funnel — received, decided, accepted on one axis.
	const hero = page.getByRole('region', { name: 'The event so far' });
	await expect(hero.getByText('Speakers')).toBeVisible({ timeout: 15000 });
	await expect(hero.getByText('9', { exact: true })).toBeVisible();
	await expect(hero.getByText('224', { exact: true })).toBeVisible();
	await hero.getByRole('button', { name: /The event so far: 14 received, 6 decided, 4 accepted/ }).click();
	await expect(page.getByRole('columnheader', { name: 'Received' })).toBeVisible();
	await page.keyboard.press('Escape');

	// The three heartbeats carry the rate; totals live above and in their tables.
	const beats = page.getByRole('region', { name: 'Week by week' });
	await expect(beats.getByText('Proposals received')).toBeVisible();
	await expect(beats.getByText('Reviews committed')).toBeVisible();
	await expect(beats.getByText('Decisions made')).toBeVisible();
	await expect(beats.getByText('119', { exact: true })).toBeVisible();

	// The plot is a figure that opens its own evidence: press, read the
	// weekly table, and find the current week named.
	await beats
		.getByRole('button', { name: /Reviews committed: 119 in the last 14 days/ })
		.click();
	await expect(page.getByRole('columnheader', { name: 'Week' })).toBeVisible();
	await expect(page.getByRole('rowheader', { name: 'This week' })).toBeVisible();
	await page.keyboard.press('Escape');

	// The decision spread sums the whole received population, states are
	// badged in the closed vocabulary, and custody is said once, in words.
	const spread = page.getByRole('region', { name: 'Where every proposal stands' });
	await expect(spread.getByText('Accepted')).toBeVisible();
	await expect(spread.getByText('Not decided')).toBeVisible();
	await expect(spread.getByText(/2 are set aside/)).toBeVisible();

	// Per-track fill: speaker-ratio bars on one shared scale, ranked so the
	// thin track reads off the bottom — honest counts, no invented target.
	const tracks = page.getByRole('region', { name: 'How the program is filling' });
	const trackRows = tracks.getByRole('listitem');
	await expect(trackRows.first()).toContainText('Agents & Tools');
	await expect(trackRows.first()).toContainText('4');
	await expect(trackRows.last()).toContainText('Models & Infrastructure');
	await expect(trackRows.first()).toContainText('2 of 6 accepted');
	await expect(tracks.getByText('9 speakers are on the roster.')).toBeVisible();

	await expectNoDocumentOverflow(page);
});

test('opening: flows that have not begun state why instead of charting zeros', async ({ page }) => {
	await useScenario(page, 'opening');
	await page.goto('/app/pulse');

	const beats = page.getByRole('region', { name: 'Week by week' });
	// Arrivals have begun and chart; reviews and decisions have not, and say so.
	await expect(beats.getByText('9', { exact: true })).toBeVisible({ timeout: 15000 });
	await expect(beats.getByText('Reviews chart here once a round opens', { exact: false })).toBeVisible();
	await expect(
		beats.getByText('No proposals have been decided', { exact: false })
	).toBeVisible();

	await expect(page.getByText('All 9 proposals are waiting for your answer.')).toBeVisible();
	await expect(
		page.getByText('Each track fills here as proposals are accepted.', { exact: false })
	).toBeVisible();

	await expectNoDocumentOverflow(page);
});

test('a workspace with no event states where the pulse starts', async ({ page }, testInfo) => {
	await useScenario(page, 'fresh');
	await page.goto('/app/pulse');

	await expect(
		page.getByRole('heading', { name: 'The pulse starts with your first event' })
	).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('link', { name: 'Back to overview' })).toBeVisible();

	// The rail row waits with its siblings: locked until an event exists.
	if (testInfo.project.name === 'mobile') {
		await page.getByRole('button', { name: 'Open navigation' }).click();
	}
	await expect(
		page.locator('.side__link--locked').filter({ hasText: 'Pulse' })
	).toHaveCount(1);
});
