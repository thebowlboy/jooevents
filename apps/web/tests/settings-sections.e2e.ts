import { expect, test, type Page } from '@playwright/test';

const sections = [
	{ label: 'Event', href: '/app/settings/event', region: 'Event identity' },
	{ label: 'Program', href: '/app/settings/program', region: 'Program basics' },
	{ label: 'Team', href: '/app/settings/team', region: 'Team' },
	{ label: 'Email', href: '/app/settings/email', region: 'Email sender' },
	{ label: 'About', href: '/app/settings/about', region: 'About JooEvents' }
];

const settingsNav = (page: Page) => page.getByRole('navigation', { name: 'Settings' });
const disclosure = (page: Page) => settingsNav(page).getByRole('button');

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
	// The area title is the area, not the section: the rail says which section.
	await expect(page.getByRole('banner').getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test('every section is its own address, deep-linkable and marked in the rail', async ({
	page
}, testInfo) => {
	for (const section of sections) {
		await page.goto(section.href);
		await expect(page.getByRole('region', { name: section.region })).toBeVisible({
			timeout: 15000
		});
		await reachNav(page, testInfo.project.name);

		// Being inside the group is what opens it; the section holds the one
		// current-page mark and the group above it is only the location.
		await expect(disclosure(page)).toHaveAttribute('aria-expanded', 'true');
		const link = settingsNav(page).getByRole('link', { name: section.label, exact: true });
		await expect(link).toHaveAttribute('aria-current', 'page');
		await expect(settingsNav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
			'aria-current',
			'location'
		);
		await expect(settingsNav(page).locator('a[aria-current="page"]')).toHaveCount(1);
		if (testInfo.project.name === 'mobile') await page.keyboard.press('Escape');
	}
});

test('moving between sections keeps one column and lands on the section chosen', async ({
	page
}, testInfo) => {
	await page.goto('/app/settings/event');
	await expect(page.getByRole('region', { name: 'Event identity' })).toBeVisible({
		timeout: 15000
	});
	await reachNav(page, testInfo.project.name);

	await settingsNav(page).getByRole('link', { name: 'Program', exact: true }).click();
	await expect(page).toHaveURL(/\/app\/settings\/program$/);
	await expect(page.getByRole('region', { name: 'Program basics' })).toBeVisible({
		timeout: 15000
	});
	// The drawer is modal on touch and closes on arrival; at desktop the rail
	// stays exactly where it was, one column, with the new section marked.
	if (testInfo.project.name === 'mobile') {
		await expect(openDrawer(page)).toHaveCount(0);
		await reachNav(page, testInfo.project.name);
	}
	await expect(
		settingsNav(page).getByRole('link', { name: 'Program', exact: true })
	).toHaveAttribute('aria-current', 'page');
	await expect(settingsNav(page)).toHaveCount(1);
});

test('the group closes and opens from the keyboard, and moves between its sections', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'hardware-keyboard path');

	// Outside Settings the group is closed and its sections are out of reach.
	await page.goto('/app/speakers');
	const toggle = disclosure(page);
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(settingsNav(page).getByRole('link', { name: 'Program', exact: true })).toHaveCount(0);

	await toggle.focus();
	await page.keyboard.press('Enter');
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');

	await page.keyboard.press('ArrowDown');
	await expect(settingsNav(page).getByRole('link', { name: 'Event', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(settingsNav(page).getByRole('link', { name: 'Program', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(settingsNav(page).getByRole('link', { name: 'Event', exact: true })).toBeFocused();

	// Escape closes the group and hands focus back to the control that owns it.
	await page.keyboard.press('Escape');
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(toggle).toBeFocused();

	await page.keyboard.press(' ');
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await page.keyboard.press('End');
	await expect(settingsNav(page).getByRole('link', { name: 'About', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/\/app\/settings\/about$/);
	await expect(page.getByRole('region', { name: 'About JooEvents' })).toBeVisible();
});

test('the touch drawer reaches a section and closes behind it', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'drawer modality');

	await page.goto('/app/speakers');
	await reachNav(page, testInfo.project.name);
	await disclosure(page).click();
	await settingsNav(page).getByRole('link', { name: 'Team', exact: true }).click();

	await expect(page).toHaveURL(/\/app\/settings\/team$/);
	await expect(openDrawer(page)).toHaveCount(0);
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
			await expect(rail).toHaveCount(width >= 1180 && section.href.endsWith('/program') ? 1 : 0);
		}
	}
});
