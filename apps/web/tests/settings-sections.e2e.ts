import { expect, test, type Page } from '@playwright/test';

const sections = [
	{ label: 'Event', href: '/app/settings/event', region: 'Event identity' },
	{ label: 'Program', href: '/app/settings/program', region: 'Program basics' },
	{ label: 'Team', href: '/app/settings/team', region: 'Team' },
	{ label: 'Email', href: '/app/settings/email', region: 'Email sender' },
	{ label: 'API keys', href: '/app/settings/api-keys', region: 'API keys' },
	{ label: 'About', href: '/app/settings/about', region: 'About JooEvents' }
];

const settingsNav = (page: Page) =>
	page.getByRole('navigation', { name: 'Workspace controls', exact: true });
const sectionTabs = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' });

/** The sidebar is static chrome at desktop width and a drawer on touch. */
async function reachNav(page: Page, projectName: string) {
	if (projectName !== 'mobile') return;
	await page.getByRole('button', { name: 'Open navigation' }).click();
	await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
}

/** The drawer is a true modal while open, so its dialog role is the probe. */
const openDrawer = (page: Page) => page.getByRole('dialog', { name: 'Navigation' });

async function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

test('the group address opens on the first section', async ({ page }) => {
	await page.goto('/app/settings');

	await expect(page).toHaveURL(/\/app\/settings\/event$/);
	await expect(page.getByRole('region', { name: 'Event identity' })).toBeVisible({
		timeout: 15000
	});
	// The area title is the area, not the section: the tabs say which section.
	await expect(page.getByRole('banner').getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test('every section is its own address, named in the surface tabs and marked once', async ({
	page
}, testInfo) => {
	for (const section of sections) {
		await page.goto(section.href);
		await expect(page.getByRole('region', { name: section.region })).toBeVisible({
			timeout: 15000
		});

		// The surface's own head carries every section; the one being read holds
		// the one current-page mark among them.
		const tabs = sectionTabs(page);
		for (const other of sections) {
			await expect(tabs.getByRole('link', { name: other.label, exact: true })).toBeVisible();
		}
		const tab = tabs.getByRole('link', { name: section.label, exact: true });
		await expect(tab).toHaveAttribute('aria-current', 'page');
		await expect(tabs.locator('a[aria-current="page"]')).toHaveCount(1);

		// The controls rail names Settings once, with no second Settings menu.
		// Approvals stays off the rail until the external agent lane activates
		// (navigation.ts gates it); its row returns here with that activation.
		await reachNav(page, testInfo.project.name);
		const railRow = settingsNav(page).getByRole('link', { name: 'Settings', exact: true });
		await expect(railRow).toHaveAttribute('aria-current', 'page');
		await expect(settingsNav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(1);
		if (testInfo.project.name === 'mobile') await page.keyboard.press('Escape');
	}
});

test('moving between sections is the surface tabs, and lands on the section chosen', async ({
	page
}) => {
	await page.goto('/app/settings/event');
	await expect(page.getByRole('region', { name: 'Event identity' })).toBeVisible({
		timeout: 15000
	});

	await sectionTabs(page).getByRole('link', { name: 'Program', exact: true }).click();
	await expect(page).toHaveURL(/\/app\/settings\/program$/);
	await expect(page.getByRole('region', { name: 'Program basics' })).toBeVisible({
		timeout: 15000
	});
	await expect(
		sectionTabs(page).getByRole('link', { name: 'Program', exact: true })
	).toHaveAttribute('aria-current', 'page');
	// One section menu on the page — the tabs — not a second copy in the rail.
	await expect(sectionTabs(page)).toHaveCount(1);
});

test('the touch drawer reaches Settings and closes behind it', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'drawer modality');

	await page.goto('/app/speakers');
	await reachNav(page, testInfo.project.name);
	await settingsNav(page).getByRole('link', { name: 'Settings', exact: true }).click();

	await expect(page).toHaveURL(/\/app\/settings\/event$/);
	await expect(openDrawer(page)).toHaveCount(0);
	// The sections are on the surface itself, so a phone reaches Team without
	// reopening the drawer.
	await sectionTabs(page).getByRole('link', { name: 'Team', exact: true }).click();
	await expect(page).toHaveURL(/\/app\/settings\/team$/);
	await expect(page.getByRole('region', { name: 'Team' })).toBeVisible({ timeout: 15000 });
	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});

test('the on-this-page rail marks the section in view and only where it has two', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'the rail exists only where there is width');

	await page.goto('/app/settings/program');
	const rail = page.getByRole('navigation', { name: 'On this page' });
	const entries = rail.getByRole('link');
	await expect(entries).toHaveCount(2);
	await expect(entries.first()).toHaveAttribute('aria-current', 'true');

	// The rail marks and jumps within a settled page; the second panel resolves
	// its own rows before it has a position to be jumped to.
	await expect(page.locator('#settings-speaker-fields .frow__label').first()).toBeVisible({
		timeout: 15000
	});
	await entries.nth(1).click();
	await expect(page).toHaveURL(/#settings-speaker-fields$/);
	await expect(entries.nth(1)).toHaveAttribute('aria-current', 'true');
	await expect(entries.first()).not.toHaveAttribute('aria-current', 'true');
	// The jump clears the sticky top bar rather than landing behind it.
	const panelTop = await page
		.locator('#settings-speaker-fields')
		.evaluate((element) => element.getBoundingClientRect().top);
	expect(panelTop).toBeGreaterThan(0);

	// A section with one panel would only repeat its own heading.
	await page.goto('/app/settings/team');
	await expect(page.getByRole('region', { name: 'Team' })).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('navigation', { name: 'On this page' })).toHaveCount(0);
});

test('no settings section overflows the document at compact desktop or touch width', async ({
	page
}, testInfo) => {
	// 1024 is the widest the rail is withheld at; 1200 is the narrowest it takes
	// a column, which is where the content beside it has the least room.
	const widths = testInfo.project.name === 'desktop' ? [1024, 1200] : [360];

	for (const width of widths) {
		await page.setViewportSize({ width, height: 720 });
		for (const section of sections) {
			await page.goto(section.href);
			await expect(page.getByRole('region', { name: section.region })).toBeVisible({
				timeout: 15000
			});
			// Let the sample transport resolve so the settled composition is measured.
			await page.waitForTimeout(600);
			expect(await documentOverflow(page), `${section.href} at ${width}px`).toBeLessThanOrEqual(1);
			const rail = page.getByRole('navigation', { name: 'On this page' });
			// Program and Email each hold two panels, so they alone earn the rail.
			await expect(rail).toHaveCount(
				width >= 1180 && (section.href.endsWith('/program') || section.href.endsWith('/email'))
					? 1
					: 0
			);
		}
	}
});
