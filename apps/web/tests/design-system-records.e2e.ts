import { expect, test, type Page } from '@playwright/test';

/**
 * The UI foundation behind the 2026-08-15 owner review: badge integrity, the
 * status tone vocabulary, track accents, the phone record, the scope filter,
 * the two detail presentations, and quiet danger.
 *
 * Every assertion here is a regression assertion for a measured defect on the
 * live playground, so they are written as the measurement rather than as a
 * screenshot: an empty badge is a box with zero text, a hidden column is a
 * scrollWidth past a clientWidth, a missed touch target is a height under
 * 44px.
 */

const WIDTHS = [
	{ name: 'phone', width: 390, height: 844 },
	{ name: 'tablet', width: 834, height: 1112 },
	{ name: 'desktop', width: 1440, height: 1000 }
] as const;

async function documentOverflow(page: Page) {
	return page.evaluate(() => {
		const root = document.documentElement;
		return {
			scrollWidth: root.scrollWidth,
			clientWidth: root.clientWidth,
			bodyScrollWidth: document.body.scrollWidth
		};
	});
}

for (const viewport of WIDTHS) {
	test(`data-records reference holds its width at ${viewport.width}px`, async ({ page }) => {
		const browserErrors: string[] = [];
		page.on('pageerror', (error) => browserErrors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') browserErrors.push(message.text());
		});

		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await page.goto('/design-system/data-records');
		await expect(page.getByRole('heading', { level: 1, name: 'Data records' })).toBeVisible();

		// The invariant the whole record transformation exists to keep: dense
		// data may scroll inside its own wrapper, the document never may.
		const overflow = await documentOverflow(page);
		expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
		expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

		expect(browserErrors).toEqual([]);
	});
}

test('a badge never renders empty and never leaks its text', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/design-system/data-records');

	// Nine of these shipped down a Track column on the live playground: a
	// 16.38 x 21.59px capsule containing nothing at all. Measured as the reader
	// meets it — a box that takes space and says nothing.
	const empties = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('.ui-badge, .ui-track')]
			.filter((node) => (node.textContent ?? '').trim().length === 0)
			.filter((node) => node.getClientRects().length > 0).length
	);
	expect(empties).toBe(0);

	// The blank value leaves no trace at all — not a hidden box, not a gap.
	const blankLine = page.getByTestId('blank-badge-line');
	await expect(blankLine).toBeVisible();
	expect(await blankLine.locator('.ui-badge').count()).toBe(0);

	// And the net under the call sites the primitive has not reached yet.
	const raw = page.getByTestId('raw-empty');
	for (const selector of ['.ui-badge', '.ui-track']) {
		const display = await raw
			.locator(selector)
			.evaluate((node: HTMLElement) => getComputedStyle(node).display);
		expect(display).toBe('none');
	}

	// No badge anywhere is narrower than its own text.
	const leaking = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('.ui-badge')]
			.filter((node) => !node.classList.contains('ui-badge--truncate'))
			.filter((node) => node.scrollWidth > node.clientWidth + 1)
			.map((node) => node.textContent)
	);
	expect(leaking).toEqual([]);
});

test('the truncating badge clips with an ellipsis and keeps its full value', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/design-system/data-records');

	const badge = page.locator('.ui-badge--truncate').first();
	await expect(badge).toBeVisible();

	const measured = await badge.evaluate((node: HTMLElement) => ({
		text: node.textContent?.trim() ?? '',
		title: node.getAttribute('title') ?? '',
		clipped: node.querySelector('.ui-badge__label')!.scrollWidth > node.clientWidth,
		ellipsis: getComputedStyle(node.querySelector('.ui-badge__label')!).textOverflow
	}));

	expect(measured.clipped).toBe(true);
	expect(measured.ellipsis).toBe('ellipsis');
	// The complete value is still in the DOM, so assistive technology reads it.
	expect(measured.text).toContain('chair review');
	expect(measured.title).toBe(measured.text);
});

test('the track palette is large enough and legible', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/design-system/data-records');

	const chips = page.locator('#tracks .ui-track');
	await expect(chips).toHaveCount(8);

	// Eight distinct fills, and none of them a status pill: a category takes a
	// squared corner so hue is free to say "which" without also saying "how bad".
	const looks = await chips.evaluateAll((nodes) =>
		nodes.map((node) => {
			const style = getComputedStyle(node);
			return { fill: style.backgroundColor, radius: style.borderTopLeftRadius };
		})
	);
	expect(new Set(looks.map((entry) => entry.fill)).size).toBe(8);
	for (const entry of looks) expect(entry.radius).toBe('4px');
});

test('record values use the closed recognition roles without colouring their labels', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/design-system/data-records');

	await page.getByRole('button', { name: /^Details for/ }).first().click();
	const detail = page.locator('.ui-detail').first();
	const colors = await detail.evaluate((node) => {
		const read = (selector: string) => getComputedStyle(node.querySelector(selector)!).color;
		return {
			label: read('.ui-detail__label'),
			ordinary: read('.ui-detail__value--default'),
			person: read('.ui-detail__value--person'),
			time: read('.ui-detail__value--time'),
			measure: read('.ui-detail__value--measure')
		};
	});

	expect(new Set([colors.person, colors.time, colors.ordinary]).size).toBe(3);
	expect(colors.label).not.toBe(colors.person);
	expect(colors.label).not.toBe(colors.time);
	// Measures compare through weight and alignment, not a fourth hue.
	expect(colors.measure).toBe(colors.ordinary);
});

test('a dense table becomes a record instead of scrolling sideways', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/design-system/data-records');

	const specimen = page.getByTestId('record-specimen');
	const wrap = specimen.locator('.ui-table-wrap');

	const geometry = await wrap.evaluate((node: HTMLElement) => {
		const table = node.querySelector<HTMLElement>('.ui-table')!;
		const firstRow = table.querySelector<HTMLElement>('tbody > tr')!;
		const cells = [...firstRow.children].map((cell) => {
			const box = cell.getBoundingClientRect();
			const wrapBox = node.getBoundingClientRect();
			return {
				classes: cell.className,
				label: cell.getAttribute('data-label'),
				hidden: box.width === 0 && box.height === 0,
				onScreen: box.right <= wrapBox.right + 1
			};
		});
		return {
			wrapScroll: node.scrollWidth,
			wrapClient: node.clientWidth,
			display: getComputedStyle(table).display,
			rowDisplay: getComputedStyle(firstRow).display,
			cells
		};
	});

	// The wrapper has nothing left to scroll: the record is the whole record.
	expect(geometry.wrapScroll).toBeLessThanOrEqual(geometry.wrapClient + 1);
	expect(geometry.display).toBe('block');
	expect(geometry.rowDisplay).toBe('grid');

	// Every visible cell is inside the wrapper — nothing parked off-screen.
	for (const cell of geometry.cells) {
		if (!cell.hidden) expect(cell.onScreen).toBe(true);
	}

	// The only cell that disappears is the one that declared it moves to the
	// detail; and the scan-key cell picked up its column's name.
	const hidden = geometry.cells.filter((cell) => cell.hidden);
	expect(hidden).toHaveLength(1);
	expect(hidden[0].classes).toContain('ui-cell--detail');
	expect(geometry.cells.some((cell) => cell.label === 'Signals')).toBe(true);

	// Table semantics survive the display change.
	await expect(specimen.getByRole('row').first()).toBeVisible();
});

test('record controls meet the touch row at 390 and at 834', async ({ page }) => {
	for (const width of [390, 834]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/design-system/data-records');

		const specimen = page.getByTestId('record-specimen');
		const trail = specimen.locator('.ui-cell--trail .ui-button').first();
		const box = await trail.boundingBox();
		expect(box).not.toBeNull();
		// The fixed-metrics touch row. 834 is the width that used to keep 26px
		// controls, because the token promotion is keyed to the viewport at 768.
		expect(box!.height).toBeGreaterThanOrEqual(40);

		const rail = specimen.locator('.ui-pick-cell').nth(1);
		const railBox = await rail.boundingBox();
		expect(railBox!.width).toBeGreaterThanOrEqual(44);
	}
});

test('a genuinely tabular grid keeps its columns and declares the scroll', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/design-system/data-records');

	const region = page.getByRole('region', { name: /task matrix/i });
	await expect(region).toBeVisible();

	const state = await region.evaluate((node: HTMLElement) => ({
		scrollable: node.scrollWidth > node.clientWidth,
		focusable: node.tabIndex >= 0,
		tableDisplay: getComputedStyle(node.querySelector('.ui-table')!).display,
		affordance: getComputedStyle(node).backgroundImage
	}));

	expect(state.scrollable).toBe(true);
	expect(state.focusable).toBe(true);
	expect(state.tableDisplay).toBe('table');
	// The scroll shadow is the visible affordance; it rides the scroll rather
	// than standing permanently.
	expect(state.affordance).toContain('gradient');
});

test('every scope stays visible and reachable at 390px', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/design-system/data-records');

	const group = page.getByRole('radiogroup', { name: 'Submission trays, narrow' });
	const scopes = group.getByRole('radio');
	await expect(scopes).toHaveCount(4);

	const boxes = await group.locator('.ui-scopes__scope').evaluateAll((nodes) =>
		nodes.map((node) => {
			const box = node.getBoundingClientRect();
			return { top: box.top, height: box.height, left: box.left, right: box.right };
		})
	);

	// Two even rows, not a ragged wrap: exactly two distinct top edges for four
	// members, and every member inside the viewport.
	expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(2);
	for (const box of boxes) {
		expect(box.height).toBeGreaterThanOrEqual(44);
		expect(box.left).toBeGreaterThanOrEqual(0);
		expect(box.right).toBeLessThanOrEqual(390);
	}

	// The abbreviation is a face, never the name.
	await expect(group.getByRole('radio', { name: 'Set aside, 3' })).toBeAttached();
	await expect(group.locator('.ui-scopes__short').first()).toBeVisible();

	// Native radio keyboard semantics: one tab stop, arrows move and select.
	await group.getByRole('radio', { name: 'Set aside, 3' }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(group.getByRole('radio', { name: 'Late, 1' })).toBeChecked();
});

test('the detail promotes to a sheet on a phone and restores focus', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/design-system/data-records');

	const opener = page.getByRole('button', { name: 'Open as a sheet' });
	await opener.click();

	const sheet = page.locator('dialog.ui-sheet');
	await expect(sheet).toBeVisible();

	// The screen, edge to edge — not a dialog card inside a 390px column.
	const box = await sheet.boundingBox();
	expect(box!.width).toBe(390);

	// Every fact carries its question, and the record's identity is in the
	// header because the list it came from is no longer on screen.
	await expect(sheet.getByRole('heading', { level: 2 })).toContainText('call for papers');
	for (const label of ['Speaker', 'Track', 'Format', 'Decision', 'Abstract', 'Materials']) {
		await expect(sheet.getByText(label, { exact: true })).toBeVisible();
	}

	// Prose gets a real measure rather than the full width of the surface.
	const measure = await sheet
		.locator('.ui-detail__value--prose')
		.evaluate((node: HTMLElement) => getComputedStyle(node).maxInlineSize);
	expect(measure).not.toBe('none');
	await expect(sheet.locator('.ui-detail__value--primary')).not.toBeEmpty();

	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(opener).toBeFocused();
});

test('the same detail stays inline on desktop, labelled and grouped', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/design-system/data-records');

	await page.getByRole('button', { name: /Details for/ }).first().click();

	const detail = page.locator('.ui-detail').first();
	await expect(detail).toBeVisible();
	// No sheet, no lost list: the row above is still on screen.
	await expect(page.locator('dialog.ui-sheet')).toHaveCount(0);

	// Labels align down one track for every field, declared once on the group.
	const labelLefts = await detail
		.locator('.ui-detail__label')
		.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
	expect(labelLefts.length).toBeGreaterThan(3);
	expect(new Set(labelLefts.slice(0, 4)).size).toBe(1);
});

test('a destructive secondary action reads quiet, not filled', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/design-system/data-records');

	const quiet = page.locator('#quiet-danger .ui-button--danger-quiet');
	const filled = page.locator('#quiet-danger .ui-button--danger');

	const [quietStyle, filledStyle] = await Promise.all([
		quiet.evaluate((node: HTMLElement) => {
			const style = getComputedStyle(node);
			return { background: style.backgroundColor, color: style.color, border: style.borderTopColor };
		}),
		filled.evaluate((node: HTMLElement) => {
			const style = getComputedStyle(node);
			return { background: style.backgroundColor, color: style.color };
		})
	]);

	// Quiet danger is danger ink on the surface; filled danger is a red plate.
	expect(quietStyle.background).toBe('rgb(255, 255, 255)');
	expect(quietStyle.color).not.toBe(quietStyle.background);
	expect(quietStyle.border).not.toBe(quietStyle.background);
	expect(filledStyle.background).not.toBe('rgb(255, 255, 255)');
	expect(filledStyle.color).toBe('rgb(255, 255, 255)');
});
