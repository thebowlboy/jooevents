import { expect, test } from '@playwright/test';

test('keeps the design reference interactive and agent-themeable', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  await page.goto('/design-system');

  await expect(page.getByRole('heading', { level: 1, name: /Operations, without/ })).toBeVisible();
  await expect(page.locator('input')).not.toHaveCount(0);
  // The workbench carries more than one table specimen; this asserts that table
  // rendering works at all, not that exactly one exists.
  await expect(page.getByRole('table').first()).toBeVisible();

  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  const themeStudio = page.getByRole('dialog', { name: 'Theme studio' });
  await expect(themeStudio).toBeVisible();
  await themeStudio.getByRole('button', { name: 'Harbor' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'harbor');
  await themeStudio.getByRole('button', { name: 'comfortable' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
  await themeStudio.getByRole('button', { name: 'Close theme studio' }).click();

  await page.keyboard.press('Control+k');
  const commandMenu = page.getByRole('dialog', { name: 'Jump to a component' });
  await expect(commandMenu).toBeVisible();
  await commandMenu.getByRole('textbox', { name: 'Search design system' }).fill('input');
  await commandMenu.getByRole('button', { name: /Input fields/ }).click();
  await expect(page.locator('#inputs')).toBeInViewport();

  await page.getByRole('button', { name: 'Open confirmation' }).click();
  await expect(page.getByRole('dialog', { name: 'Cancel this session?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep session' }).click();

  expect(browserErrors).toEqual([]);
});

test('shows the critical-halo reference among the attention surfaces', async ({ page }) => {
  await page.goto('/design-system');

  const halo = page.locator('.je-critical');
  await expect(halo).toBeVisible();
  await expect(halo).toContainText('Hard deadline in 6 hours');
  await expect(halo).toContainText('Critical halo — reserved tier, dormant by default');
});
