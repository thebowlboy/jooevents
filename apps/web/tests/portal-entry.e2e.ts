import { expect, test, type Page } from '@playwright/test';

async function usePortalEntry(page: Page, baseURL: string | undefined, cookies: Record<string, string>) {
  await page.context().addCookies(
    Object.entries(cookies).map(([name, value]) => ({ name, value, url: baseURL ?? 'http://127.0.0.1:4173' }))
  );
}

async function panelGeometry(page: Page) {
  return page.locator('.entry-panel').evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    return { left: box.left + window.scrollX, top: box.top + window.scrollY, width: box.width };
  });
}

test('participant entry asks once, confirms plainly, and keeps the panel in place', async ({ page, baseURL }) => {
  await usePortalEntry(page, baseURL, { 'je-portal-auth': 'anonymous' });
  await page.goto('/portal/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /with Google/ })).toHaveCount(0);
  const restingPanel = await panelGeometry(page);
  const footprint = await page.locator('.entry-state').evaluate((state) => {
    const box = state.getBoundingClientRect();
    const lastChildBottom = [...state.children].reduce(
      (deepest, child) => Math.max(deepest, child.getBoundingClientRect().bottom),
      box.top
    );
    return {
      minBlockSize: getComputedStyle(state).minBlockSize,
      trailingBlank: box.bottom - lastChildBottom
    };
  });
  expect(['0px', 'auto']).toContain(footprint.minBlockSize);
  expect(footprint.trailingBlank).toBeLessThan(4);

  // The same titled method group the operator lane uses, carrying this lane's
  // own warm helper — the heading above it still names no method.
  await expect(page.getByRole('heading', { name: 'Magic link' })).toBeVisible();
  await expect(
    page.getByText('Enter the email address you use for your talks. New or returning, that is all you need.')
  ).toBeVisible();
  await expect(page.locator('#portal-entry-email')).toHaveAttribute('aria-describedby', /portal-method-help/);

  const emailField = page.getByLabel('Email address');
  await emailField.fill('amara@example');
  await page.getByRole('button', { name: 'Email me a magic link' }).click();
  await expect(page.getByText('Enter an email address like name@example.com')).toBeVisible();
  await expect(emailField).toBeFocused();

  await emailField.fill('amara@example.com');
  await page.getByRole('button', { name: 'Email me a magic link' }).click();
  const confirmation = page.getByRole('heading', { name: 'Check your email' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toBeFocused();
  // The move is for the announcement; a heading nobody can press stays unpainted.
  await expect(confirmation).toHaveCSS('box-shadow', 'none');
  await expect(confirmation.locator('.entry-glyph')).toHaveCount(1);
  await expect(
    page.getByText('We just emailed you a magic link. If the address is new here, it creates your access.')
  ).toBeVisible();
  await expect(page.getByText('amara@example.com')).toBeVisible();
  expect(await page.title()).toContain('Check your email');
  const confirmedPanel = await panelGeometry(page);
  expect(Math.abs(restingPanel.left - confirmedPanel.left)).toBeLessThan(2);
  expect(Math.abs(restingPanel.top - confirmedPanel.top)).toBeLessThan(2);
  expect(Math.abs(restingPanel.width - confirmedPanel.width)).toBeLessThan(2);

  await page.getByRole('button', { name: 'Try another address' }).click();
  await expect(emailField).toBeFocused();
  await expect(emailField).toHaveValue('amara@example.com');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('a spent participant link explains itself without judging the address', async ({ page, baseURL }) => {
  await usePortalEntry(page, baseURL, { 'je-portal-auth': 'anonymous', 'je-portal-link': 'link_expired' });
  await page.goto('/portal/auth/complete?token=sample');
  await expect(page.getByRole('heading', { name: 'That link has expired' })).toBeVisible();
  expect(page.url()).not.toContain('token');
  await expect(page.getByText(/sample|token/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page).toHaveURL('/portal/sign-in');
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('an expired participant session asks for the address again instead of failing', async ({ page, baseURL }) => {
  await usePortalEntry(page, baseURL, { 'je-portal-auth': 'expired' });
  await page.goto('/portal/sign-in');
  await expect(page.getByText('Your session ended')).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByRole('heading', { name: "We couldn't check your access" })).toHaveCount(0);
});

test('a valid participant link ends at the portal, not at an entry screen', async ({ page, baseURL }) => {
  await usePortalEntry(page, baseURL, { 'je-portal-auth': 'anonymous', 'je-portal-link': 'signed_in' });
  await page.goto('/portal/auth/complete?token=sample');
  await expect(page).toHaveURL('/portal');
});
