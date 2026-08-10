import { expect, test } from '@playwright/test';

const pending = {
  state: 'pending_review',
  user: { id: 'user_ada', displayName: 'Ada Lovelace', primaryEmail: 'ada@example.com' },
  membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 },
  workspace: { id: 'workspace_summit', name: 'Summit Operations' }
};

test('anonymous entry is neutral, secure, and usable without horizontal overflow', async ({ page }) => {
  let releaseContext!: () => void;
  const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
  await page.route('**/api/me/access-context', async (route) => {
    await contextGate;
    await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'x-correlation-id': 'corr_anonymous' },
    body: JSON.stringify({ state: 'anonymous' })
    });
  });
  const response = await page.goto('/');
  await expect(page.getByLabel('Checking access')).toBeVisible();
  const resolvingPanel = await page.locator('.entry-panel').boundingBox();
  releaseContext();
  await expect(page).toHaveURL('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  const brandImage = page.getByRole('link', { name: 'JooEvents home' }).locator('img');
  await expect(brandImage).toBeVisible();
  await expect(brandImage).toHaveAttribute('width', '512');
  await expect(brandImage).toHaveAttribute('height', '94');
  expect(await brandImage.evaluate((image: HTMLImageElement) => ({
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight
  }))).toEqual({ complete: true, naturalWidth: 512, naturalHeight: 94 });
  const resolvedPanel = await page.locator('.entry-panel').boundingBox();
  expect(resolvingPanel).not.toBeNull();
  expect(resolvedPanel).not.toBeNull();
  expect(Math.abs((resolvingPanel?.width ?? 0) - (resolvedPanel?.width ?? 0))).toBeLessThan(2);
  expect(Math.abs((resolvingPanel?.height ?? 0) - (resolvedPanel?.height ?? 0))).toBeLessThan(2);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByText("Events for people who don't want to manage events.")).toBeVisible();
  await expect(page.getByText('Entry is for those who know.')).toBeVisible();
  await expect(page.getByText(/checks your workspace access separately/)).toHaveCount(0);
  await expect(page.getByText('New here?', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  const asideFontSize = await page
    .getByText('Entry is for those who know.')
    .evaluate((aside) => getComputedStyle(aside).fontSize);
  expect(asideFontSize).toBe('13px');
  const alignment = await page.getByRole('heading', { name: 'Sign in', exact: true }).evaluate((heading) => {
    const panel = heading.closest('section');
    if (!panel) return { text: '', offset: Number.POSITIVE_INFINITY };
    const headingBox = heading.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    return {
      text: getComputedStyle(heading).textAlign,
      offset: Math.abs((headingBox.left + headingBox.right) / 2 - (panelBox.left + panelBox.right) / 2)
    };
  });
  expect(alignment.text).toBe('center');
  expect(alignment.offset).toBeLessThan(2);
  expect(response?.headers()['x-frame-options']).toBe('DENY');
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('a failed Google start shows reviewed copy beside the button and leaks no server text', async ({ page }) => {
  await page.route('**/api/me/access-context', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'anonymous' }) }));
  let attempts = 0;
  await page.route('**/api/entry/google/start', async (route) => {
    attempts += 1;
    if (attempts > 1) await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      headers: { 'x-correlation-id': 'corr_google_start' },
      body: JSON.stringify({ code: 'provider_unavailable', message: 'upstream gateway timeout at adapter', retryable: true })
    });
  });
  await page.goto('/');
  const googleButton = page.locator('.google-button');
  const beforeFailure = await googleButton.boundingBox();
  await googleButton.click();
  const failure = page.getByRole('alert');
  await expect(failure).toContainText("Couldn't open Google");
  await expect(failure).toContainText('Check your connection and try again.');
  const afterFailure = await googleButton.boundingBox();
  expect(Math.abs((beforeFailure?.y ?? 0) - (afterFailure?.y ?? 0))).toBeLessThan(2);
  await expect(page.getByText(/Support code/)).toHaveCount(0);
  await expect(page.getByText(/upstream|gateway|adapter|provider_unavailable|502/)).toHaveCount(0);
  const order = await page.evaluate(() => {
    const button = document.querySelector('.google-button');
    const error = document.querySelector('.entry-error');
    return button && error ? Boolean(button.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
  });
  expect(order).toBe(true);
  await googleButton.click();
  await expect(googleButton).toHaveAttribute('aria-busy', 'true');
  await expect(failure).toBeVisible();
  await expect(googleButton).not.toHaveAttribute('aria-busy', 'true');
  await expect(failure).toBeVisible();
  await expect(googleButton).toBeEnabled();
});

test('a malformed or failed context remains a recoverable connection problem', async ({ page }) => {
  await page.route('**/api/me/access-context', (route) => route.fulfill({
    status: 502,
    contentType: 'application/json',
    headers: { 'x-correlation-id': 'corr_context_502' },
    body: JSON.stringify({ code: 'upstream_failed', message: 'Unavailable', retryable: true })
  }));
  await page.goto('/access/pending');
  await expect(page.getByRole('heading', { name: "We couldn't check your access" })).toBeVisible();
  await expect(page.getByText('Your access has not changed.')).toBeVisible();
  await expect(page.getByText(/corr_context_502/)).toBeVisible();
  const supportFontSize = await page
    .getByText(/corr_context_502/)
    .evaluate((support) => getComputedStyle(support).fontSize);
  expect(supportFontSize).toBe('13px');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
});

test('pending review names the workspace and retains context when sign-out fails', async ({ page }) => {
  let contextRequests = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  await page.route('**/api/me/access-context', async (route) => {
    contextRequests += 1;
    if (contextRequests === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pending) });
      return;
    }
    await refreshGate;
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      headers: { 'x-correlation-id': 'corr_status' },
      body: JSON.stringify({ code: 'upstream_failed', message: 'Internal status adapter failed', retryable: true })
    });
  });
  await page.route('**/api/entry/sign-out', (route) => route.fulfill({
    status: 502,
    contentType: 'application/json',
    headers: { 'x-correlation-id': 'corr_signout' },
    body: JSON.stringify({ code: 'sign_out_failed', message: 'Unavailable', retryable: true })
  }));
  await page.goto('/');
  await expect(page).toHaveURL('/access/pending');
  await expect(page.getByRole('heading', { name: 'Your access request is under review' })).toBeVisible();
  await expect(page.getByText('Summit Operations')).toBeVisible();
  await expect(page.getByText('ada@example.com')).toBeVisible();
  await expect(page.getByText("We'll email this address when your access is approved.")).toBeVisible();
  await expect(page.locator('.ui-avatar')).toHaveCount(0);
  const panelBeforeRefresh = await page.locator('.entry-panel').boundingBox();
  const checkStatus = page.getByRole('button', { name: 'Check status' });
  await checkStatus.click();
  await expect(page.getByRole('heading', { name: 'Your access request is under review' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Checking status' })).toHaveAttribute('aria-busy', 'true');
  const panelDuringRefresh = await page.locator('.entry-panel').boundingBox();
  expect(Math.abs((panelBeforeRefresh?.height ?? 0) - (panelDuringRefresh?.height ?? 0))).toBeLessThan(2);
  releaseRefresh();
  await expect(checkStatus).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText("Couldn't check status");
  await expect(page.getByRole('alert')).toContainText('Your access has not changed.');
  await expect(page.getByText(/upstream|adapter|upstream_failed|502/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your access request is under review' })).toBeVisible();
  const pendingAlignment = await page.getByRole('heading', { name: 'Your access request is under review' }).evaluate((heading) => getComputedStyle(heading).textAlign);
  expect(pendingAlignment).toBe('center');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You are still signed in.')).toBeVisible();
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('active context replaces entry with a validated operator return path', async ({ page }) => {
  await page.route('**/api/me/access-context', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ state: 'active', user: { id: 'user_ada', displayName: 'Ada' }, workspace: { id: 'workspace_summit', name: 'Summit Operations' } })
  }));
  await page.goto('/sign-in?returnTo=%2Fapp%2Fschedule');
  await expect(page).toHaveURL('/app/schedule');
  await page.goto('/sign-in?returnTo=https%3A%2F%2Fevil.example');
  await expect(page).toHaveURL('/app');
});
