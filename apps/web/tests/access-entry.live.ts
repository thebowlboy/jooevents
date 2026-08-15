import { expect, test } from '@playwright/test';

/* Served-state entry coverage: every one of these outcomes is something the
   server says, so they are exercised against the live composition with the
   API answering, not against sample fulfillment. */

const pending = {
  state: 'pending_review',
  user: { id: 'user_ada', displayName: 'Ada Lovelace', primaryEmail: 'ada@example.com' },
  membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 },
  workspace: { id: 'workspace_summit', name: 'Summit Operations' }
};

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

test('a refused magic-link request keeps the address and states the reason', async ({ page }) => {
  await page.route('**/api/me/access-context', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'anonymous' }) }));
  let attempts = 0;
  await page.route('**/api/entry/sign-in-link', (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'x-correlation-id': 'corr_link_rate' },
          body: JSON.stringify({ code: 'rate_limited', message: 'bucket exhausted for ada@example.com', retryable: true })
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ outcome: 'link_requested' })
        });
  });
  await page.goto('/sign-in');
  const emailField = page.getByLabel('Email address');
  const submit = page.getByRole('button', { name: 'Email me a magic link' });
  await emailField.fill('ada@example.com');
  await submit.click();
  await expect(page.getByRole('alert')).toContainText('Too many requests');
  await expect(page.getByText(/bucket|exhausted|429|rate_limited/)).toHaveCount(0);
  await expect(emailField).toHaveValue('ada@example.com');
  await submit.click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
});

test('provisioning is a compact box with a real support code, not a pre-reserved blank', async ({ page }, testInfo) => {
  // Owner direction 2026-08-14: no state pre-reserves height for the
  // error/retry block; the box is as tall as its content and grows downward
  // only when recovery content actually appears.
  await page.route('**/api/me/access-context', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ state: 'provisioning', retryAfterSeconds: 30, correlationId: 'corr_provisioning' })
  }));
  await page.goto('/');
  await expect(page).toHaveURL('/auth/complete');
  await expect(page.getByRole('heading', { name: 'Preparing your workspace' })).toBeVisible();
  await expect(page.getByText(/corr_provisioning/)).toBeVisible();
  const footprint = await page.locator('.entry-state').evaluate((state) => {
    const box = state.getBoundingClientRect();
    const lastChildBottom = [...state.children].reduce(
      (deepest, child) => Math.max(deepest, child.getBoundingClientRect().bottom),
      box.top
    );
    return {
      reserved: state.classList.contains('entry-state--reserved'),
      minBlockSize: getComputedStyle(state).minBlockSize,
      trailingBlank: box.bottom - lastChildBottom
    };
  });
  expect(footprint.reserved).toBe(false);
  expect(['0px', 'auto']).toContain(footprint.minBlockSize);
  // On a narrow viewport the panel is the page and the state stretches to
  // center its content; only the desktop card owns the compact-box geometry.
  if (testInfo.project.name === 'desktop') expect(footprint.trailingBlank).toBeLessThan(4);
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
  await expect(page.getByRole('link', { name: 'Get help' })).toHaveCount(0);
  const supportFontSize = await page
    .getByText(/corr_context_502/)
    .evaluate((support) => getComputedStyle(support).fontSize);
  expect(supportFontSize).toBe('13px');
  await expect(page.getByRole('button', { name: /with Google/ })).toHaveCount(0);
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
  await page.route('**/api/operations/manifest', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ schemaVersion: 1, registryDigestSha256: 'a'.repeat(64), operations: [] })
  }));
  await page.goto('/sign-in?returnTo=%2Fapp%2Fschedule');
  await expect(page).toHaveURL('/app/schedule');
  await page.goto('/sign-in?returnTo=https%3A%2F%2Fevil.example');
  await expect(page).toHaveURL('/app');
});
