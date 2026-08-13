import { expect, test } from '@playwright/test';

const destinations = [
	{ path: '/app', title: 'Overview' },
	{ path: '/app/submissions', title: 'Submissions' },
	{ path: '/app/review', title: 'Review' },
	{ path: '/app/decisions', title: 'Decisions' },
	{ path: '/app/speakers', title: 'Speakers' },
	{ path: '/app/tasks', title: 'Tasks' },
	{ path: '/app/schedule', title: 'Schedule' },
	{ path: '/app/messages', title: 'Communications' },
	{ path: '/app/forms', title: 'Forms' },
	{ path: '/app/embeds', title: 'Embeds' },
	{ path: '/app/settings', title: 'Settings' }
];

for (const destination of destinations) {
	test(`${destination.title} renders inside the shell without page errors or overflow`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));

		await page.goto(destination.path);
		// The shell destination title is the cross-page invariant. A domain page
		// may also own a content heading with the same visible label.
		await expect(
			page.getByRole('banner').getByRole('heading', { level: 1, name: destination.title })
		).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeAttached();

		// Let the sample transport resolve so the settled composition is measured.
		await page.waitForTimeout(600);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(1);
		expect(errors).toEqual([]);
	});
}

test('the naughty list gathers every speaker who still owes tasks', async ({ page }) => {
	await page.goto('/app/speakers');

	const roster = page.getByRole('region', { name: 'Speaker roster' });
	await expect(roster).toContainText('Maya Lindqvist', { timeout: 15000 });

	// The playful label never travels alone: the chip carries a plain subtitle,
	// and because that subtitle is visible text inside the button, the functional
	// phrase is part of the chip's accessible name too.
	const chip = page.getByRole('button', { name: /The naughty list/ });
	await expect(chip).toBeVisible();
	await expect(chip).toContainText('The naughty list');
	await expect(chip).toContainText('tasks incomplete');
	await expect(chip).toHaveAccessibleName(/tasks incomplete/);

	// The filter is address state, so the press lands in the URL.
	await chip.click();
	await expect(page).toHaveURL(/\/app\/speakers\?filter=incomplete$/);
	await expect(chip).toHaveAttribute('aria-pressed', 'true');

	// Every row on the list still owes work: its own done/total fraction reads
	// short. One composition is laid out per width — the table at desktop, the
	// cards on touch — so the visible one is the subject.
	const rows = roster.locator('[data-speaker]').filter({ visible: true });
	const fractions = roster.locator('.tasks__count').filter({ visible: true });
	const rowCount = await rows.count();
	expect(rowCount).toBeGreaterThan(0);
	await expect(fractions).toHaveCount(rowCount);
	for (const fraction of await fractions.allInnerTexts()) {
		const [done, total] = fraction.split('/').map(Number);
		expect(done).toBeLessThan(total);
	}

	// The chip's count is a promise about the list it opens.
	await expect(chip.locator('.chips__count')).toHaveText(String(rowCount));
});
