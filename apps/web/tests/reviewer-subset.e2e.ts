import { expect, test, type Page } from '@playwright/test';

/**
 * `/app/review` rendered for someone who only reviews.
 *
 * There is no second reviewer app: the same review pass omits organizer setup
 * and gains the three things a reviewer arriving for one round has nowhere
 * else to learn: what they were asked to review, what this plan lets them see,
 * and how to hand back a review they have a conflict of interest with.
 *
 * Both renderings are asserted from the same dataset, switched by the viewer
 * cookie alone, so the organizer's screen is evidence that nothing was taken
 * from it. Pinned to the mid-flight scenario, whose reviewer projection
 * borrows Sofia Berg, a generalist with no scope rows.
 */

test.use({
	storageState: {
		cookies: [
			{
				name: 'je-scenario',
				value: 'flight',
				domain: '127.0.0.1',
				path: '/',
				expires: -1,
				httpOnly: false,
				secure: false,
				sameSite: 'Lax'
			}
		],
		origins: []
	}
});

const url = (baseURL: string | undefined) => baseURL ?? 'http://127.0.0.1:4173';

async function asReviewer(page: Page, baseURL: string | undefined) {
	await page.context().addCookies([{ name: 'je-viewer', value: 'reviewer', url: url(baseURL) }]);
}

async function asOrganizer(page: Page, baseURL: string | undefined) {
	await page.context().addCookies([{ name: 'je-viewer', value: 'organizer', url: url(baseURL) }]);
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });

test.describe('the reviewer subset', () => {
	test('the chair half of the screen is not rendered, and the rail is the reviewer’s world', async ({
		page,
		baseURL
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the gating contract');

		await asReviewer(page, baseURL);
		await page.goto('/app/review');
		await expect(page.getByRole('heading', { name: 'My queue' })).toBeVisible({ timeout: 15000 });

		// Oversight of other people is chair work: the column, the reminders, the
		// names that opened their records, and the way into managing them are
		// absent rather than disabled.
		await expect(page.getByRole('heading', { name: 'Reviewers' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Manage reviewers' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Remind' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: /open in Reviewers$/ })).toHaveCount(0);
		await expect(page.getByText('need another reviewer')).toHaveCount(0);

		// The rail carries the one area this person holds. Absent, not locked:
		// a locked row promises a door that opens later.
		await expect(rail(page).getByRole('link')).toHaveCount(1);
		await expect(rail(page).locator('a[href="/app/review"]')).toBeVisible();
		for (const href of ['/app', '/app/submissions', '/app/decisions', '/app/speakers', '/app/reviewers']) {
			await expect(rail(page).locator(`a[href="${href}"]`)).toHaveCount(0);
		}
		await expect(page.locator('.side__foot a[href="/app/settings"]')).toHaveCount(0);
		await expect(page.locator('.side__link--locked')).toHaveCount(0);
		// The wordmark stays a door to the viewer's own surface.
		await expect(page.locator('.side__brand')).toHaveAttribute('href', '/app/review');

		// Reviewer search is not introduced anywhere on a reviewer's surface.
		await expect(page.getByRole('searchbox')).toHaveCount(0);
		await expect(page.getByPlaceholder(/search/i)).toHaveCount(0);

		// No draw or external-intelligence chips reach this rendering.
		await expect(page.locator('.signals')).toHaveCount(0);
	});

	test('first arrival states the scope and what the plan lets this person see', async ({
		page,
		baseURL
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the copy contract');

		await asReviewer(page, baseURL);
		await page.goto('/app/review');

		// A generalist reviews everything, and the absence of scope says so in
		// words rather than in an invented chip.
		const brief = page.locator('.brief');
		await expect(brief).toContainText('You review everything', { timeout: 15000 });

		// The compact form of the policy: what is hidden, who reads what you
		// write, and what commit unlocks.
		await expect(brief).toContainText('You do not see who submitted');
		await expect(brief).toContainText('never to the speaker');
		await expect(brief).toContainText('until you commit your own');
		// The term of art arrives with its own definition, once.
		await expect(brief).toContainText('That is a conflict of interest');
		await expect(brief).not.toContainText('recused');

		// The badge's fuller statement stays one press away, unchanged.
		const badge = page.getByRole('button', { name: 'Anonymized — what this means' });
		await badge.click();
		const panel = page.locator(`#${await badge.getAttribute('aria-controls')}`);
		await expect(panel).toContainText('Reviewers do not see who submitted');
	});

	test('materials stand on the card, and a card with none says so', async ({
		page,
		baseURL
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the evidence contract');

		await asReviewer(page, baseURL);
		await page.goto('/app/review');

		// Judging evidence is on the surface: the attached items render without
		// any press, each with its own kind and qualifier.
		const withMaterials = page
			.getByRole('listitem')
			.filter({ hasText: 'Hands-on: AI Interface Audits That Stick' });
		await expect(withMaterials.getByText('workshop-outline-and-setup.pdf')).toBeVisible({
			timeout: 15000
		});
		await expect(withMaterials.getByText('audit-starter-kit (repository)')).toBeVisible();
		await expect(withMaterials.getByText(/^Submitted /)).toBeVisible();

		// Absence is a fact about the submission, stated in the same place —
		// a reviewer scoring without materials knows that is what is happening.
		const without = page
			.getByRole('listitem')
			.filter({ hasText: 'The Inference Bill Nobody Read' });
		await expect(without.getByText('No materials attached to this submission.')).toBeVisible();

		// The old disclosure is gone: nothing on a card promises hidden details.
		await expect(page.getByRole('button', { name: /Materials & details/ })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0);
	});

	test('stepping back takes the card out of the queue and answers with a receipt', async ({
		page,
		baseURL
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the mutation contract');

		await asReviewer(page, baseURL);
		await page.goto('/app/review');

		const card = page
			.getByRole('listitem')
			.filter({ hasText: 'The Inference Bill Nobody Read' });
		await expect(card).toBeVisible({ timeout: 15000 });

		// It arms in place, and the confirm is not where the trigger was.
		await card.getByRole('button', { name: /^Step back from “The Inference Bill/ }).click();
		const armed = card.getByRole('group', { name: /^Step back from “The Inference Bill/ });
		await expect(armed).toContainText('waits for another reviewer');
		const confirm = card.getByRole('button', { name: /— confirm$/ });
		await expect(confirm).toBeFocused();

		// Keeping it stands the question down without acting.
		await card.getByRole('button', { name: /^Keep “The Inference Bill/ }).click();
		await expect(armed).toHaveCount(0);
		await expect(card).toBeVisible();

		await card.getByRole('button', { name: /^Step back from “The Inference Bill/ }).click();
		await card.getByRole('button', { name: /— confirm$/ }).click();

		await expect(
			page.getByRole('listitem').filter({ hasText: 'The Inference Bill Nobody Read' })
		).toHaveCount(0, { timeout: 15000 });

		// The receipt names what left and why it cannot be taken back here.
		const receipt = page
			.getByRole('status')
			.filter({ hasText: 'Stepped back from “The Inference Bill Nobody Read”' });
		await expect(receipt).toBeVisible();
		await expect(receipt).toContainText('conflict of interest');
		await expect(receipt).toContainText('waiting for another reviewer');
		await expect(receipt.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	});

	test('a committed review keeps the control and says why it refuses', async ({
		page,
		baseURL
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the refusal contract');

		await asReviewer(page, baseURL);
		await page.goto('/app/review');

		const committed = page
			.getByRole('listitem')
			.filter({ hasText: 'Durable Agent Jobs: A Queueing Confession' });
		await expect(committed).toBeVisible({ timeout: 15000 });

		// Unavailable, not `disabled`: the keyboard still reaches the reason.
		const refused = committed.getByRole('button', { name: /^Step back from .* — why this is unavailable/ });
		await expect(refused).toHaveAttribute('aria-disabled', 'true');
		await refused.focus();
		await page.keyboard.press('Enter');
		const panel = page.locator(`#${await refused.getAttribute('aria-controls')}`);
		await expect(panel).toContainText('already committed your review');
	});

	test('the queue keeps its anti-anchoring contract on a phone, with nothing sideways', async ({
		page,
		baseURL
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'touch-viewport composition contract');

		await asReviewer(page, baseURL);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app/review');

		const open = page
			.getByRole('listitem')
			.filter({ hasText: 'Hands-on: AI Interface Audits That Stick' });
		await expect(open.getByText('Peer reviews unlock when you commit your own.')).toBeVisible({
			timeout: 15000
		});
		await expect(open.getByText('Standing in track')).toHaveCount(0);
		await expect(open.getByRole('button', { name: /^Step back from/ })).toBeVisible();

		const metrics = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth
		}));
		expect(metrics.scrollWidth).toBe(metrics.clientWidth);
	});
});

test.describe('the organizer rendering', () => {
	test('Review stays focused on unfinished work and hands reviewer oversight to Reviewers', async ({
		page,
		baseURL
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the composition contract');

		await asOrganizer(page, baseURL);
		await page.goto('/app/review');

		// Review has one job: the organizer's own reviews. People, load, coverage,
		// and reminder actions stay on the reviewer-management surface.
		await expect(page.getByRole('heading', { name: 'Reviewers' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Reviewer progress and reminders' })).toBeVisible({ timeout: 15000 });
		await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'To review' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Completed reviews' })).toBeVisible();

		// Unfinished work is above completed history, regardless of source order.
		const firstCard = page.locator('.queue .card').first();
		await expect(firstCard.locator('.ui-badge--success')).toHaveCount(0);
		const completedHeading = page.getByRole('heading', { name: 'Completed reviews' });
		const completedBox = await completedHeading.boundingBox();
		const firstCardBox = await firstCard.boundingBox();
		expect(completedBox && firstCardBox && completedBox.y > firstCardBox.y).toBe(true);

		// Nothing reviewer-scoped leaks into the chair's screen.
		await expect(page.locator('.brief')).toHaveCount(0);
		await expect(page.getByRole('button', { name: /^Step back from/ })).toHaveCount(0);

		// The rail is the whole workspace again.
		for (const href of ['/app', '/app/submissions', '/app/review', '/app/reviewers']) {
			await expect(rail(page).locator(`a[href="${href}"]`)).toBeVisible();
		}
		await expect(page.locator(`.side__foot a[href="/app/settings"]`)).toBeVisible();
		await expect(page.locator('.side__brand')).toHaveAttribute('href', '/app');

		// The contextual door lands on the owning surface, where the useful nudge
		// remains attached to the behind reviewer instead of disappearing.
		await page.getByRole('link', { name: 'Reviewer progress and reminders' }).click();
		await expect(page.getByRole('heading', { name: 'Reviewers' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Remind' }).first()).toBeVisible();
	});

	test('the focused queue holds a phone without anything sideways', async ({
		page,
		baseURL
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'touch-viewport composition contract');

		await asOrganizer(page, baseURL);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app/review');

		await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible({ timeout: 15000 });
		await expect(page.getByRole('heading', { name: 'Reviewers' })).toHaveCount(0);

		const metrics = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth
		}));
		expect(metrics.scrollWidth).toBe(metrics.clientWidth);
	});
});
