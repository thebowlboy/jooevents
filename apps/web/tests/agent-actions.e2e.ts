import { expect, test } from '@playwright/test';

test('approval directory shows frozen bounds, visible partial state, and safe controls', async ({ page }) => {
	await page.goto('/app/approvals');
	await expect(page.getByRole('heading', { name: 'Agent action runs' })).toBeVisible();
	await expect(page.getByText('2 of 5 completed · paused at step 3.')).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: 'Completed steps remain applied. Cancel stops the remaining steps.' })).toBeVisible();
	await expect(page.getByText('task.mutate@1').first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Resume remaining steps' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Cancel remaining steps' })).toBeVisible();
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('approval controls remain touch-sized and stacked at phone width', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'phone composition only');
	await page.goto('/app/approvals');
	const resume = page.getByRole('button', { name: 'Resume remaining steps' });
	const cancel = page.getByRole('button', { name: 'Cancel remaining steps' });
	await expect(resume).toBeVisible();
	const [resumeBox, cancelBox] = await Promise.all([resume.boundingBox(), cancel.boundingBox()]);
	expect(resumeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
	expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
	expect(Math.abs((resumeBox?.width ?? 0) - (cancelBox?.width ?? 0))).toBeLessThanOrEqual(1);
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBeLessThanOrEqual(1);
});
