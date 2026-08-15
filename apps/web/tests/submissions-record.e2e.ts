import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The submissions surface after the record foundation landed.
 *
 * Four measured defects are the subject, and each one is asserted where it was
 * measured rather than described:
 *
 * - at 390px, 58% of the table sat behind a sideways scroll with no affordance
 *   — every signal, every average, every decision, and the only control that
 *   opened the row;
 * - nine rows rendered a 16.38 x 21.59px empty capsule where a track should be,
 *   and four rendered "Name · · direct entry" around the empty slot beside it;
 * - the tray filters wrapped into a ragged two-and-two at 34px tall, below the
 *   touch row;
 * - opening a row at 390px scrolled the table 490px sideways, taking the
 *   abstract, both actions, and the record's own title off the screen.
 */

const PHONE = { width: 390, height: 844 };

/** Every badge and track chip on the page, with the text it actually renders. */
async function chipTexts(page: Page, selector: string): Promise<string[]> {
	return page
		.locator(selector)
		.evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()));
}

async function box(locator: Locator) {
	const found = await locator.boundingBox();
	expect(found).not.toBeNull();
	return found!;
}

test.describe('a submission row on a phone', () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'the viewport is pinned, so one run covers it');
		await page.setViewportSize(PHONE);
	});

	test('is a record: nothing leaves the screen and nothing scrolls sideways', async ({ page }) => {
		await page.goto('/app/submissions');
		const list = page.getByRole('region', { name: 'Submissions' });
		const row = list.locator('tr.row').first();
		await expect(row).toBeVisible({ timeout: 15000 });

		// The document never scrolls sideways — and neither does the table, which
		// is the half that used to be true only because the overflow was hidden
		// inside a wrapper nobody could tell was scrollable.
		const geometry = await page.evaluate(() => {
			const wrap = document.querySelector('.ui-table-wrap')!;
			return {
				documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				tableOverflow: wrap.scrollWidth - wrap.clientWidth,
				tableDisplay: getComputedStyle(wrap.querySelector('.ui-table')!).display
			};
		});
		expect(geometry.documentOverflow).toBeLessThanOrEqual(0);
		expect(geometry.tableOverflow).toBeLessThanOrEqual(0);
		// The row has re-composed rather than merely been squeezed.
		expect(geometry.tableDisplay).toBe('block');

		// Every cell that still renders sits inside the viewport.
		const cells = await row.locator('td:visible').evaluateAll((nodes) =>
			nodes.map((node) => {
				const rect = node.getBoundingClientRect();
				return { left: rect.left, right: rect.right };
			})
		);
		expect(cells.length).toBeGreaterThan(2);
		for (const cell of cells) {
			expect(cell.left).toBeGreaterThanOrEqual(-0.5);
			expect(cell.right).toBeLessThanOrEqual(PHONE.width + 0.5);
		}
	});

	test('carries the title, the submitter and the state without opening anything', async ({
		page
	}) => {
		await page.goto('/app/submissions');
		const list = page.getByRole('region', { name: 'Submissions' });
		const row = list.locator('tr.row').first();
		await expect(row).toBeVisible({ timeout: 15000 });

		const identity = row.locator('.ui-cell--lead');
		await expect(identity.locator('.ui-table__primary')).toBeVisible();
		// The submitter is a scan key on this surface and stays on the record.
		await expect(identity.locator('.scan')).toBeVisible();

		// Inside a station group only what varies row to row renders as state:
		// the first inbox row sits under a band that already says what it
		// needs, so its own state cell stays empty rather than repeating the
		// band down every row.
		await expect(row.locator('.ui-cell--state .ui-badge')).toHaveCount(0);

		// A decided row's verdict is the state that varies, and it sits on the
		// primary line beside the identity — the one answer the reader came for.
		const decided = list.locator('tr.row').filter({ hasText: 'Durable Agent Jobs' });
		const state = decided.locator('.ui-cell--state');
		await expect(state.locator('.ui-badge')).toBeVisible();
		const [identityBox, stateBox] = await Promise.all([
			box(decided.locator('.ui-cell--lead')),
			box(state)
		]);
		expect(Math.abs(identityBox.y - stateBox.y)).toBeLessThan(8);
		expect(stateBox.x + stateBox.width).toBeLessThanOrEqual(PHONE.width + 0.5);

		// A title with room to wrap is a title that can be read; the desktop
		// one-line ellipsis is a comparison device the record does not need.
		const wrapping = await identity
			.locator('.title-line__text')
			.evaluate((node: HTMLElement) => getComputedStyle(node).whiteSpace);
		expect(wrapping).toBe('normal');
	});

	test('keeps all four trays reachable, at touch height, in even rows', async ({ page }) => {
		await page.goto('/app/submissions');
		const trays = page.getByRole('radiogroup', { name: 'Submission trays' });
		await expect(trays.getByRole('radio')).toHaveCount(4);

		const chips = await trays.locator('.ui-scopes__scope').evaluateAll((nodes) =>
			nodes.map((node) => {
				const rect = node.getBoundingClientRect();
				return { top: Math.round(rect.top), height: rect.height, left: rect.left, right: rect.right };
			})
		);

		// Two even rows, not a ragged wrap, and nothing pushed off the edge.
		expect(new Set(chips.map((chip) => chip.top)).size).toBe(2);
		for (const chip of chips) {
			expect(chip.height).toBeGreaterThanOrEqual(44);
			expect(chip.left).toBeGreaterThanOrEqual(-0.5);
			expect(chip.right).toBeLessThanOrEqual(PHONE.width + 0.5);
		}

		// The counts are part of what is being chosen between, so they are part of
		// the name assistive technology hears.
		await expect(trays.getByRole('radio', { name: /^Inbox, \d+$/ })).toBeAttached();
	});

	test('opens into a sheet, labelled, and hands focus back on Escape', async ({ page }) => {
		await page.goto('/app/submissions');
		const list = page.getByRole('region', { name: 'Submissions' });
		const row = list.locator('tr.row').first();
		await expect(row).toBeVisible({ timeout: 15000 });

		const chevron = row.getByRole('button', { name: /^Details for/ });
		await chevron.click();
		await expect(chevron).toHaveAttribute('aria-expanded', 'true');

		const sheet = page.locator('dialog.ui-sheet');
		await expect(sheet).toBeVisible();
		// The screen, edge to edge — the measured alternative put the abstract at
		// x = -451 and both actions off the screen entirely.
		const sheetBox = await box(sheet);
		expect(sheetBox.width).toBe(PHONE.width);

		// The record says which record it is, because the list is no longer on
		// screen to say it, and every value carries the question it answers.
		await expect(sheet.getByRole('heading', { level: 2 })).not.toBeEmpty();
		for (const label of ['Track', 'Format', 'Received', 'Reviews', 'Decision', 'Abstract']) {
			await expect(sheet.getByText(label, { exact: true })).toBeVisible();
		}
		// Display punctuation separates the name from its address; copying still
		// targets the raw email through CopyValue's adjacent control.
		await expect(sheet.locator('.ui-detail__value--person .ui-copy__value').first()).toHaveText(
			/^<[^<>\s]+@[^<>\s]+>$/
		);

		// The abstract gets a real measure rather than the full width of the sheet.
		const measure = await sheet
			.locator('.ui-detail__value--prose')
			.evaluate((node: HTMLElement) => getComputedStyle(node).maxInlineSize);
		expect(measure).not.toBe('none');

		// The abstract is the record's principal evidence: full neutral ink and a
		// larger reading size, while its label remains the quiet locator.
		const abstract = sheet.locator('.ui-detail__value--primary');
		const [abstractStyle, ordinaryStyle] = await Promise.all([
			abstract.evaluate((node: HTMLElement) => {
				const style = getComputedStyle(node);
				return { color: style.color, size: Number.parseFloat(style.fontSize) };
			}),
			sheet.locator('.ui-detail__value').filter({ hasNot: page.locator('.ui-track') }).first()
				.evaluate((node: HTMLElement) => {
					const style = getComputedStyle(node);
					return { size: Number.parseFloat(style.fontSize) };
				})
		]);
		expect(abstractStyle.size).toBeGreaterThan(ordinaryStyle.size);

		// Materials completes the evidence section before the action consequence
		// note starts; the relationship is a section gap, not a tiny sibling gap.
		const materials = sheet.getByText('Materials', { exact: true }).locator('..');
		const footnote = sheet.locator('.ui-detail__footnote');
		const separation = await Promise.all([
			materials.evaluate((node: HTMLElement) => node.getBoundingClientRect().bottom),
			footnote.evaluate((node: HTMLElement) => node.getBoundingClientRect().top)
		]);
		expect(separation[1] - separation[0]).toBeGreaterThanOrEqual(28);

		// Dismissing the sheet closes the row behind it: a row left open under a
		// dismissed sheet is a state nobody can see and nobody can leave.
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
		await expect(chevron).toBeFocused();
	});
});

test.describe('the untracked population', () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the scope contract');
	});

	test('renders no empty capsule, on either surface', async ({ page }) => {
		for (const path of ['/app/submissions', '/app/decisions']) {
			await page.goto(path);
			await expect(page.locator('tr.row').first()).toBeVisible({ timeout: 15000 });

			// A badge is a background drawn around a word. Without the word there is
			// nothing to draw, and the primitive refuses to draw it.
			const badges = await chipTexts(page, '.ui-badge');
			expect(badges.length).toBeGreaterThan(0);
			expect(badges.filter((text) => text.length === 0)).toEqual([]);
			expect((await chipTexts(page, '.ui-track')).filter((text) => text.length === 0)).toEqual([]);
		}
	});

	test('is a scope in the track filter, and the rows agree with it', async ({ page }) => {
		await page.goto('/app/submissions');
		const list = page.getByRole('region', { name: 'Submissions' });
		await expect(list.locator('tr.row').first()).toBeVisible({ timeout: 15000 });

		// An absence that matters is said in words on the quietest rung, and the
		// rows that say it are exactly the population the scope selects.
		const untracked = await list.locator('tr.row').filter({ hasText: 'No track' }).count();

		const filter = page.getByLabel('Filter by track');
		await expect(filter.getByRole('option', { name: 'No track' })).toBeAttached();
		await filter.selectOption('none');

		// The scope is the address, so it is shareable and survives a reload.
		await expect(page).toHaveURL(/trackId=none/);
		await expect(list.locator('tr.row')).toHaveCount(untracked);
		if (untracked === 0) {
			// Every submission in this tray carries a track — which is the fact the
			// operator came to check, so the surface names it rather than reporting
			// an absence it never established.
			await expect(list.locator('.empty')).toContainText('has a track');
		}

		await filter.selectOption('');
		await expect(page).not.toHaveURL(/trackId=/);
		expect(await list.locator('tr.row').count()).toBeGreaterThanOrEqual(untracked);
	});

	test('the metadata sentence never separates a fact that is not there', async ({ page }) => {
		await page.goto('/app/submissions');
		const list = page.getByRole('region', { name: 'Submissions' });
		await expect(list.locator('tr.row').first()).toBeVisible({ timeout: 15000 });

		// "Ingrid Halvorsen · · direct entry" was one blank slot between two
		// separators. Facts join the sentence only when there is a fact.
		const lines = await list
			.locator('tr.row .ui-table__secondary')
			.evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ')));
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(line).not.toMatch(/·\s*·/);
	});
});

test.describe('the same detail on a desktop', () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'the reference desktop viewport');
	});

	test('stays inline beside the list, labelled and grouped', async ({ page }) => {
		await page.goto('/app/submissions');
		const list = page.getByRole('region', { name: 'Submissions' });
		const row = list.locator('tr.row').first();
		await expect(row).toBeVisible({ timeout: 15000 });
		await row.getByRole('button', { name: /^Details for/ }).click();

		const detail = page.locator('.ui-detail');
		await expect(detail).toBeVisible();
		// A power user compares records without losing the list, so desktop never
		// becomes a modal.
		await expect(page.locator('dialog.ui-sheet')).toHaveCount(0);
		await expect(list.locator('tr.row').first()).toBeVisible();

		// Labels align down one track, declared once on the group.
		const lefts = await detail
			.locator('.ui-detail__label')
			.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
		expect(lefts.length).toBeGreaterThan(3);
		expect(new Set(lefts.slice(0, 4)).size).toBe(1);

		// The ink ladder still ranks the record, while the closed recognition
		// vocabulary lets a person and a time be found without reading every label.
		// The hues are deliberately quiet and distinct from each other and from
		// the ordinary value ink; labels remain neutral so key and value do not
		// collapse into one coloured phrase.
		const recognition = await detail.evaluate((node) => {
			const read = (selector: string) => getComputedStyle(node.querySelector(selector)!).color;
			return {
				label: read('.ui-detail__label'),
				ordinary: read('.ui-detail__value--default'),
				person: read('.ui-detail__value--person'),
				time: read('.ui-detail__value--time')
			};
		});
		expect(recognition.person).not.toBe(recognition.ordinary);
		expect(recognition.time).not.toBe(recognition.ordinary);
		expect(recognition.person).not.toBe(recognition.time);
		expect(recognition.label).not.toBe(recognition.person);
		expect(recognition.label).not.toBe(recognition.time);

		// The columns the record moved into the detail are genuinely here, which
		// is what makes hiding them at record width legitimate.
		for (const label of ['Reviews', 'Decision']) {
			await expect(detail.getByText(label, { exact: true })).toBeVisible();
		}
	});

	test('a decision state wears one loudness on both surfaces', async ({ page }) => {
		const read = async (path: string) => {
			await page.goto(path);
			await expect(page.locator('tr.row').first()).toBeVisible({ timeout: 15000 });
			return page.locator('.decision .ui-badge').evaluateAll((nodes) =>
				nodes
					.filter((node) => (node.textContent ?? '').trim() === 'Result not sent')
					.map((node) => ({
						solid: node.classList.contains('ui-badge--solid'),
						background: getComputedStyle(node).backgroundColor
					}))
			);
		};

		const queue = await read('/app/submissions');
		const board = await read('/app/decisions');
		expect(board.length).toBeGreaterThan(0);
		// Seven solid amber pills stacked in one column beside a solid primary
		// button was three accent-dominant elements in a region whose budget is
		// one. The state's tone is the state's; emphasis belongs to the region.
		for (const badge of [...queue, ...board]) expect(badge.solid).toBe(false);
		if (queue.length > 0) expect(board[0].background).toBe(queue[0].background);
	});
});
