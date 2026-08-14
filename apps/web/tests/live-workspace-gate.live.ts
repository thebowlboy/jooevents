import { expect, test, type Page } from '@playwright/test';

const active = {
  state: 'active',
  user: { id: 'user_ada', displayName: 'Ada Lovelace' },
  workspace: { id: 'workspace_summit', name: 'Summit Operations' }
};

const emptyManifest = {
  schemaVersion: 1,
  registryDigestSha256: 'a'.repeat(64),
  operations: []
};

async function routeAccess(page: Page, value: unknown = active) {
  await page.route('**/api/me/access-context', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(value)
  }));
}

async function routeManifest(page: Page, value: unknown = emptyManifest) {
  await page.route('**/api/operations/manifest', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(value)
  }));
}

test('pure live renders an honest unavailable workspace with no sample fallback', async ({ page }) => {
  await routeAccess(page);
  await routeManifest(page);

  await page.goto('/app/schedule');

  await expect(page.getByRole('heading', { name: 'Workspace tools aren’t available here yet' })).toBeVisible();
  await expect(page.getByText('Summit Operations', { exact: true })).toBeVisible();
  await expect(page.getByText(/signed in as Ada Lovelace/)).toBeVisible();
  await expect(page.getByText(/Mid-flight|Decision crunch|All clear/)).toHaveCount(0);
  await expect(page.locator('[data-je-scenario]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /scenario switcher|typeface switcher/i })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('direct operator navigation reuses the canonical access-entry flow', async ({ page }) => {
  await routeAccess(page, { state: 'anonymous' });

  await page.goto('/app/schedule?day=2');

  await expect(page).toHaveURL('/sign-in?returnTo=%2Fapp%2Fschedule%3Fday%3D2');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});

test('manifest failure is recoverable and exposes only the server correlation code', async ({ page }) => {
  await routeAccess(page);
  let attempts = 0;
  await page.route('**/api/operations/manifest', (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          headers: { 'x-correlation-id': 'corr_live_manifest' },
          body: JSON.stringify({
            kind: 'transport_error',
            code: 'internal_error',
            retryable: true,
            correlationId: 'corr_live_manifest'
          })
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(emptyManifest)
        });
  });

  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'We couldn’t load this workspace' })).toBeVisible();
  await expect(page.getByText(/corr_live_manifest/)).toBeVisible();
  await expect(page.getByText(/internal_error|500/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByRole('heading', { name: 'Workspace tools aren’t available here yet' })).toBeVisible();
});

test('live participant and public roots are honest unavailable surfaces without sample data', async ({ page }) => {
	// Both roots are live surfaces now. With no backend reachable, each states
	// its own failure and offers a retry instead of holding a skeleton or
	// leaking sample data.
	await page.goto('/portal');
	await expect(page.getByRole('heading', { name: 'We could not check your access' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
	await expect(page.getByText(/AI Engineer NYC 2026|Mid-flight|Decision crunch/)).toHaveCount(0);

	await page.goto('/s/apply');
	await expect(page.getByText('We couldn’t load this page.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
	await expect(page.getByText(/AI Engineer NYC 2026|Mid-flight|Decision crunch/)).toHaveCount(0);
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);

	expect(await page.evaluate(() => ({
		document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		body: document.body.scrollWidth > document.body.clientWidth
	}))).toEqual({ document: false, body: false });
});
