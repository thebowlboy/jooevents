import { expect, test, type Page } from '@playwright/test';

/**
 * The sidebar is static chrome at desktop width and a drawer on touch. Navigation
 * behaviour is the same contract on both, so the touch runs open the drawer first
 * rather than skipping the assertions.
 */
async function reachNav(page: Page, projectName: string) {
	if (projectName !== 'mobile') return;
	await page.getByRole('button', { name: 'Open navigation' }).click();
	await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
}


test('workspace overview renders the shell with sample data and no page overflow', async ({ page }) => {
	await page.goto('/design-system/dashboard');

	await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
	await expect(page.getByRole('img', { name: 'JooEvents' })).toBeVisible();
	await expect(page.getByText('Sample data')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Act now' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Pipeline' })).toBeVisible();

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('activity entries clamp long text and disclose only when cut off', async ({ page }) => {
	await page.goto('/design-system/dashboard');

	const activity = page.getByRole('region', { name: 'Activity' });
	const rows = activity.getByRole('listitem');
	await expect(rows).toHaveCount(5);

	// Rows take their natural height, but the avatar rail stays straight: every
	// mark shares one x-position and one offset from its row's top, because it
	// anchors to the first text line rather than a reserved block.
	const marks = await rows.evaluateAll((items) =>
		items.map((item) => {
			const mark = item.querySelector('.feed__avatar');
			const row = item.getBoundingClientRect();
			const border = parseFloat(getComputedStyle(item).borderTopWidth) || 0;
			const box = mark?.getBoundingClientRect();
			return box ? { x: Math.round(box.x), top: Math.round(box.y - row.y - border) } : null;
		})
	);
	expect(marks).not.toContain(null);
	expect(new Set(marks.map((mark) => mark?.x)).size).toBe(1);
	expect(new Set(marks.map((mark) => mark?.top)).size).toBe(1);

	// A one-line entry costs one line: no reserved blank line, no footer.
	const plain = rows.filter({ hasText: 'Jonas Weber' });
	await expect(plain.locator('.ui-clamp__footer')).toHaveCount(0);
	// Its timestamp ends the sentence inline instead of holding a line of its own.
	await expect(plain).toContainText('· 2 h ago');
	const plainHeight = (await plain.boundingBox())?.height ?? 0;
	const tallest = Math.max(
		...(await rows.evaluateAll((items) =>
			items.map((item) => item.getBoundingClientRect().height)
		))
	);
	expect(plainHeight).toBeLessThan(tallest);

	// Agent attribution survives without a badge repeating the robot mark.
	await expect(activity.getByRole('img', { name: 'Agent' })).toHaveCount(2);

	// The affordance appears only on entries that are actually truncated.
	const toggles = activity.getByRole('button', { name: /Show more/ });
	await expect(toggles).toHaveCount(1);

	const toggle = toggles.first();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	const clipped = rows.filter({ hasText: 'Schedule import' });
	const collapsedHeight = (await clipped.boundingBox())?.height ?? 0;

	await toggle.click();
	await expect(activity.getByRole('button', { name: /Show less/ })).toHaveAttribute(
		'aria-expanded',
		'true'
	);
	const expandedHeight = (await clipped.boundingBox())?.height ?? 0;
	expect(expandedHeight).toBeGreaterThan(collapsedHeight);
});

test('a touch anywhere on a clipped entry expands it', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'coarse-pointer hit area');

	await page.goto('/design-system/dashboard');
	const activity = page.getByRole('region', { name: 'Activity' });
	const clipped = activity.getByRole('listitem').filter({ hasText: 'Schedule import' });
	await clipped.scrollIntoViewIfNeeded();

	const collapsedHeight = (await clipped.boundingBox())?.height ?? 0;

	// Land the tap on the entry's name — far from the small toggle label.
	const name = await clipped.locator('strong').boundingBox();
	if (!name) throw new Error('activity entry name is not rendered');
	await page.touchscreen.tap(name.x + name.width / 2, name.y + name.height / 2);

	await expect(activity.getByRole('button', { name: /Show less/ })).toBeVisible();
	const expandedHeight = (await clipped.boundingBox())?.height ?? 0;
	expect(expandedHeight).toBeGreaterThan(collapsedHeight);

	// Entries with nothing to reveal keep no overlay, so they never swallow a tap.
	const plain = activity.getByRole('listitem').filter({ hasText: 'Jonas Weber' });
	await expect(plain.locator('.ui-clamp--surface')).toHaveCount(0);
});

test('the operator route serves the same overview shell', async ({ page }) => {
	await page.goto('/app');
	await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeAttached();
});

test('a slow destination hands over whole, never as a torn frame', async ({ page }, testInfo) => {
	await page.goto('/app');
	await expect(page.locator('.side__link[href="/app"]')).toHaveAttribute('aria-current', 'page');
	await reachNav(page, testInfo.project.name);

	// Hold the destination's own work open so the handover window is observable.
	let releaseDestination = () => {};
	const destinationHeld = new Promise<void>((resolve) => (releaseDestination = resolve));
	await page.route(/\/src\/routes\/\(operator\)\/app\/speakers\/\+page\.svelte/, async (route) => {
		await destinationHeld;
		await route.continue();
	});

	// Sample the frame continuously and record any moment where the selected item,
	// the title, and the content describe different surfaces.
	await page.evaluate(() => {
		const seen: string[] = [];
		(window as unknown as { __frames: string[] }).__frames = seen;
		const sample = () => {
			const selected = document
				.querySelector('.side__link[aria-current="page"]')
				?.getAttribute('href');
			const title = document.querySelector('.top__title')?.textContent?.trim();
			// The overview surface counts as present in any of its own states —
			// its resolver is still the overview, not a foreign frame.
			const overviewContent =
				document.querySelector(
					'[aria-label="Needs attention"], [aria-label="Loading overview"], .welcome'
				) !== null;
			const waiting = document.querySelector('.content .waiting') !== null;
			seen.push(
				`${selected}|${title}|${waiting ? 'waiting' : overviewContent ? 'overview' : 'other'}`
			);
			requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	});

	await page.locator('.side__link[href="/app/speakers"]').click({ noWaitAfter: true });
	await expect(page.locator('.content .waiting')).toBeAttached();

	// Handed over: every view names the destination at once.
	await expect(page.locator('.side__link[href="/app/speakers"]')).toHaveAttribute(
		'aria-current',
		'page'
	);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Speakers');
	await expect(page.locator('[aria-label="Needs attention"]')).toHaveCount(0);

	releaseDestination();
	await expect(page.getByRole('heading', { level: 1, name: 'Speakers' })).toBeVisible();
	await expect(page.locator('.content .waiting')).toHaveCount(0);

	// No sampled frame may mix one surface's selection with another's content.
	const frames: string[] = await page.evaluate(
		() => (window as unknown as { __frames: string[] }).__frames
	);
	const torn = frames.filter((frame) => {
		const [selected, title, content] = frame.split('|');
		if (selected === '/app') return !(title === 'Overview' && content === 'overview');
		if (selected === '/app/speakers') return !(title === 'Speakers' && content !== 'overview');
		return true;
	});
	expect(torn).toEqual([]);
	expect(frames.length).toBeGreaterThan(5);
});

test('the sidebar survives navigation instead of being rebuilt', async ({ page }, testInfo) => {
	await page.goto('/app');
	await expect(page.locator('.side__event-name')).toBeAttached();
	await reachNav(page, testInfo.project.name);

	// Stamp the live element; a shell that is destroyed and recreated loses this.
	await page.locator('aside.side').evaluate((element) => {
		(element as HTMLElement).dataset.shellIdentity = 'first';
	});

	await page.locator('.side__link[href="/app/speakers"]').click();
	await expect(page).toHaveURL(/\/app\/speakers$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Speakers' })).toBeVisible();

	await expect(page.locator('aside.side')).toHaveAttribute('data-shell-identity', 'first');
	// Resolved chrome never reverts to a skeleton the person already passed.
	await expect(page.locator('.side__event--loading')).toHaveCount(0);
	await expect(page.locator('.side__event-name')).toBeAttached();
});

test('a fast destination shows no waiting treatment at all', async ({ page }, testInfo) => {
	await page.goto('/app');

	// Warm the destination so the navigation lands inside the grace tier.
	await reachNav(page, testInfo.project.name);
	await page.locator('.side__link[href="/app/speakers"]').click();
	await expect(page).toHaveURL(/\/app\/speakers$/);
	await reachNav(page, testInfo.project.name);
	await page.locator('.side__link[href="/app"]').click();
	await expect(page).toHaveURL(/\/app$/);
	await reachNav(page, testInfo.project.name);

	const treatmentSeen = page
		.locator('.top__arriving')
		.waitFor({ state: 'attached', timeout: 400 })
		.then(() => true)
		.catch(() => false);

	await page.locator('.side__link[href="/app/speakers"]').click();
	await expect(page).toHaveURL(/\/app\/speakers$/);

	expect(await treatmentSeen).toBe(false);
});

test('expanded mobile drawer owns its scroll and restores focus on close', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'touch-viewport drawer behavior');

	await page.goto('/design-system/dashboard');
	await page.getByRole('button', { name: 'Open navigation' }).click();

	const drawer = page.locator('aside');
	await expect(drawer).toBeInViewport();
	await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeFocused();

	// With the drawer open, the drawer scrolls its own content; the page behind
	// must not scroll instead.
	const drawerScroll = await drawer.evaluate((element) => {
		const styles = getComputedStyle(element);
		return { overflowY: styles.overflowY, overscroll: styles.overscrollBehaviorY };
	});
	expect(drawerScroll.overflowY).toBe('auto');
	expect(drawerScroll.overscroll).toBe('contain');
	await expect
		.poll(async () => page.evaluate(() => document.body.style.overflow))
		.toBe('hidden');

	// The open drawer is modal: the page behind is inert, so Tab cannot reach
	// obscured controls.
	await expect(page.locator('div.body[inert]')).toHaveCount(1);

	await page.keyboard.press('Escape');
	await expect(drawer).not.toBeInViewport();
	await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
	const bodyOverflow = await page.evaluate(() => document.body.style.overflow);
	expect(bodyOverflow).toBe('');

	// Widening past the drawer breakpoint releases a stranded open drawer.
	await page.getByRole('button', { name: 'Open navigation' }).click();
	await expect.poll(async () => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
	await page.setViewportSize({ width: 1200, height: 800 });
	await expect.poll(async () => page.evaluate(() => document.body.style.overflow)).toBe('');
});
