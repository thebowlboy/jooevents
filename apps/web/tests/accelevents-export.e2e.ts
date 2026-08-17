import { expect, test, type Page } from '@playwright/test';

async function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

test('the Accelevents export names its blockers and refuses the package until they are resolved', async ({
	page
}) => {
	await page.goto('/app/integrations/accelevents');
	await expect(
		page.getByRole('heading', { level: 2, name: 'Export your program to Accelevents' })
	).toBeVisible({ timeout: 15_000 });

	// The boundary and the one-way promise are stated before anything is built.
	await expect(page.getByText(/JooEvents never contacts Accelevents/)).toBeVisible();
	await expect(page.getByText(/handle them as speaker contact data/)).toBeVisible();

	// Preflight opens with the sample's four blockers, each naming its records.
	const preflight = page.locator('#preflight');
	await expect(preflight.getByRole('heading', { name: /Blocking the package \(4\)/ })).toBeVisible();
	await expect(preflight.getByText(/no Accelevents format yet: Talk, Keynote/)).toBeVisible();
	await expect(preflight.getByText(/missing a first or last name: Ayodele, Mary Ann van der Berg/)).toBeVisible();

	// The build control refuses in place, stating the count that blocks it.
	const build = page.getByRole('button', { name: 'Build the import package' });
	await expect(build).toBeDisabled();
	await expect(page.locator('#package')).toContainText('4 items above still block the package.');

	// The disclosure names what each speaker row will carry.
	await expect(page.locator('#preflight')).toContainText(
		'name, email address, pronouns, headline, and links when they exist'
	);

	// Resolving the session type retires exactly that blocker.
	await page.getByRole('combobox', { name: 'Session type' }).click();
	await page.getByRole('option', { name: 'In person' }).click();
	await expect(preflight.getByRole('heading', { name: /Blocking the package \(3\)/ })).toBeVisible();

	// Left-out records stay visible instead of silently dropping.
	await expect(preflight.getByText(/“Lightning talks: open mic” is released but not scheduled/)).toBeVisible();
	await expect(preflight.getByText(/cannot carry images/)).toBeVisible();

	// The staged location flow offers the stage-one file up front.
	const locationsDownload = page.getByRole('link', { name: 'Download locations.csv' });
	await expect(locationsDownload).toBeVisible();
	await expect(locationsDownload).toHaveAttribute('href', /^data:text\/csv/);

	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});

test('resolving every blocker readies and builds the package with its consequences stated', async ({
	page
}) => {
	await page.goto('/app/integrations/accelevents');
	await expect(
		page.getByRole('heading', { level: 2, name: 'Export your program to Accelevents' })
	).toBeVisible({ timeout: 15_000 });

	await page.getByRole('combobox', { name: 'Session type' }).click();
	await page.getByRole('option', { name: 'In person' }).click();
	await page.getByRole('combobox', { name: 'Accelevents format for Talk' }).click();
	await page.getByRole('option', { name: 'Regular session' }).click();
	await page.getByRole('combobox', { name: 'Accelevents format for Keynote' }).click();
	await page.getByRole('option', { name: 'Main stage session' }).click();

	await page.getByLabel('First name for Ayodele').fill('Ayodele');
	await page.getByLabel('Last name for Ayodele').fill('Adeyemi');
	await page.getByLabel('Last name for Ayodele').blur();
	await page.getByLabel('First name for Mary Ann van der Berg').fill('Mary Ann');
	await page.getByLabel('Last name for Mary Ann van der Berg').fill('van der Berg');
	await page.getByLabel('Last name for Mary Ann van der Berg').blur();

	await page.getByLabel('Accelevents location ID for Main Hall').fill('118');
	await page.getByLabel('Accelevents location ID for Main Hall').blur();
	await page.getByLabel('Accelevents location ID for Room 4').fill('119');
	await page.getByLabel('Accelevents location ID for Room 4').blur();
	await page
		.locator('.room-grid__row', { hasText: 'Workshop Studio' })
		.getByRole('checkbox', { name: 'No location' })
		.check();

	const preflight = page.locator('#preflight');
	await expect(preflight.getByText('Nothing blocks the package')).toBeVisible();

	// A no-location room leaves the location count, not the session rows.
	await expect(preflight.locator('.contains')).toContainText('2');
	await expect(preflight.getByText(/Accelevents may email each imported speaker/)).toBeVisible();

	const build = page.getByRole('button', { name: 'Build the import package' });
	await expect(build).toBeEnabled();
	await build.click();
	await expect(page.getByText(/The package is ready — locations, speakers, and sessions from release 4/)).toBeVisible();

	// The repeat-import consequence appears only once a package exists.
	await expect(preflight.getByText(/Importing both creates duplicate speakers and sessions/)).toBeVisible();

	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});

test('the export preparation re-composes without document overflow on touch', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'touch-width composition');
	await page.goto('/app/integrations/accelevents');
	await expect(
		page.getByRole('heading', { level: 2, name: 'Export your program to Accelevents' })
	).toBeVisible({ timeout: 15_000 });

	// The stacked rows label their inputs visibly once the column headers are gone.
	await expect(page.getByLabel('First name for Maya Chen')).toBeVisible();
	await expect(
		page.locator('.name-grid__row', { hasText: 'Maya Chen' }).getByText('First name', { exact: true })
	).toBeVisible();

	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});
