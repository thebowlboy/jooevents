import { expect, test, type Page } from '@playwright/test';

/* Sample fulfillment drives the entry surfaces here: the composition, its
   geometry contract, and the non-enumerating link answer. Transport failures,
   provisioning, pending, and blocked states are served states and are covered
   against the live composition in access-entry.live.ts. */

async function useSampleEntry(page: Page, baseURL: string | undefined, cookies: Record<string, string> = {}) {
  await page.context().addCookies(
    Object.entries({ 'je-entry-auth': 'anonymous', ...cookies }).map(([name, value]) => ({
      name,
      value,
      url: baseURL ?? 'http://127.0.0.1:4173'
    }))
  );
}

async function panelGeometry(page: Page) {
  return page.locator('.entry-panel').evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    return { left: box.left + window.scrollX, top: box.top + window.scrollY, width: box.width };
  });
}

/* Whether the composition currently on screen fits the footprint the state
   reserves — the property the resolver-to-card transition depends on. */
async function reserve(page: Page) {
  return page.locator('.entry-state').evaluate((state) => {
    const top = state.getBoundingClientRect().top;
    const used = [...state.children].reduce(
      (deepest, child) => Math.max(deepest, child.getBoundingClientRect().bottom - top),
      0
    );
    return { fits: used <= parseFloat(getComputedStyle(state).minBlockSize) };
  });
}

function expectSamePlace(before: { left: number; top: number; width: number }, after: { left: number; top: number; width: number }) {
  expect(Math.abs(before.left - after.left)).toBeLessThan(2);
  expect(Math.abs(before.top - after.top)).toBeLessThan(2);
  expect(Math.abs(before.width - after.width)).toBeLessThan(2);
}

test('anonymous entry is neutral, secure, and usable without horizontal overflow', async ({ page, baseURL }, testInfo) => {
  await useSampleEntry(page, baseURL, { 'je-latency': '1200' });
  const response = await page.goto('/');
  await expect(page.getByLabel('Checking access')).toBeVisible();
  const resolvingPanel = await panelGeometry(page);
  const resolvingBox = await page.locator('.entry-panel').boundingBox();
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
  const resolvedPanel = await panelGeometry(page);
  const resolvedBox = await page.locator('.entry-panel').boundingBox();
  expectSamePlace(resolvingPanel, resolvedPanel);
  expect(Math.abs((resolvingBox?.height ?? 0) - (resolvedBox?.height ?? 0))).toBeLessThan(2);
  // On a desktop card the reserve is the mechanism: the resting composition
  // fits the footprint the resolver was already holding. A narrow viewport
  // gets its stillness from a panel that fills the screen instead.
  if (testInfo.project.name === 'desktop') expect(await reserve(page)).toEqual({ fits: true });
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByText("Events for people who don't want to manage events.")).toBeVisible();
  await expect(page.getByText('Entry is for those who know.')).toBeVisible();
  await expect(page.getByText(/checks your workspace access separately/)).toHaveCount(0);
  await expect(page.getByText('New here?', { exact: true })).toHaveCount(0);
  // The maker's byline is the one piece of chrome this page carries, and the
  // neutrality this test protects is about what it must not become: it stays a
  // single line outside the panel, and it opens no route back into a sign-up or
  // marketing path. Owner direction, 2026-08-12.
  const byline = page.getByRole('contentinfo');
  await expect(byline).toHaveCount(1);
  await expect(byline).toContainText('A Bowlboy project');
  await expect(byline).toContainText('© 2026 JooCorp');
  await expect(page.locator('.entry-panel').getByRole('contentinfo')).toHaveCount(0);
  const follow = byline.getByRole('link', { name: 'Bowlboy on X (@thebowlboy)' });
  await expect(follow).toHaveAttribute('href', 'https://x.com/thebowlboy');
  await expect(follow).toHaveAttribute('target', '_blank');
  await expect(follow).toHaveAttribute('rel', /noopener/);
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

test('the magic link stands first and equal, answers identically, and never moves the panel', async ({ page, baseURL }) => {
  await useSampleEntry(page, baseURL);
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  const anonymousPanel = await panelGeometry(page);

  // Both choices stand in the resting card; neither is behind a reveal.
  const emailField = page.getByLabel('Email address');
  await expect(emailField).toBeVisible();
  const submit = page.getByRole('button', { name: 'Email me a magic link' });
  await expect(submit).toBeVisible();
  await expect(submit).toHaveClass(/ui-button--primary/);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.locator('.entry-or')).toHaveText('or');

  // The group names the method, so the field can stay plain and the helper can
  // sell the method instead of instructing the typist.
  await expect(page.getByRole('heading', { name: 'Magic link' })).toBeVisible();
  await expect(
    page.getByText("We'll email you a link that signs you in — no password, nothing to remember.")
  ).toBeVisible();
  await expect(page.getByText('Use the address your workspace access is registered to.')).toHaveCount(0);
  await expect(page.locator('#entry-link-email')).toHaveAttribute(
    'aria-describedby',
    /entry-method-help/
  );

  // Composition order, in the document and on the screen: email above Google.
  const composition = await page.evaluate(() => {
    const field = document.querySelector('#entry-link-email');
    const action = document.querySelector('form.entry-link .ui-button');
    const provider = document.querySelector('.google-button');
    if (!field || !action || !provider) return null;
    return {
      fieldBeforeProvider: Boolean(field.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING),
      actionBeforeProvider: Boolean(action.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING),
      actionBottom: action.getBoundingClientRect().bottom,
      providerTop: provider.getBoundingClientRect().top
    };
  });
  expect(composition?.fieldBeforeProvider).toBe(true);
  expect(composition?.actionBeforeProvider).toBe(true);
  expect(composition!.actionBottom).toBeLessThanOrEqual(composition!.providerTop);

  // Entry glyphs are recognition support beside the words that carry the
  // meaning: hidden from the accessibility tree, inked by their text, still.
  const glyphs = await page.locator('.entry-glyph').evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return {
        hidden: node.getAttribute('aria-hidden'),
        inheritsInk: style.stroke === style.color,
        animated:
          style.animationName !== 'none' ||
          style.transitionDuration.split(',').some((duration) => parseFloat(duration) > 0)
      };
    })
  );
  expect(glyphs.length).toBeGreaterThan(0);
  for (const glyph of glyphs) {
    expect(glyph.hidden).toBe('true');
    expect(glyph.inheritsInk).toBe(true);
    expect(glyph.animated).toBe(false);
  }

  await emailField.fill('ada@');
  await submit.click();
  await expect(page.getByText('Enter an email address like name@example.com')).toBeVisible();
  await expect(emailField).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  const rejectedPanel = await panelGeometry(page);
  expectSamePlace(anonymousPanel, rejectedPanel);

  await emailField.fill('ada@example.com');
  await submit.click();
  const confirmation = page.getByRole('heading', { name: 'Check your email' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toBeFocused();
  // Focus moves so the new state is announced; it is not a control, so it must
  // not wear a control's focus ring.
  await expect(confirmation).toHaveCSS('box-shadow', 'none');
  // The envelope joins the heading without renaming it: the words stay the
  // accessible name, and the heading names no method so a code can share the
  // room later.
  await expect(confirmation.locator('.entry-glyph')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Magic link sent' })).toHaveCount(0);
  await expect(page.getByText('If an account exists for this address, a magic link is on its way.')).toBeVisible();
  await expect(page.getByText('ada@example.com')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  const confirmedPanel = await panelGeometry(page);
  expectSamePlace(anonymousPanel, confirmedPanel);
  expect(await page.title()).toContain('Check your email');
  const matched = (await page.locator('.entry-state').innerText()).replace('ada@example.com', '');

  await page.getByRole('button', { name: 'Use a different address' }).click();
  await expect(emailField).toBeFocused();
  await expect(emailField).toHaveValue('ada@example.com');
  await emailField.fill('nobody@example.invalid');
  await submit.click();
  await expect(confirmation).toBeVisible();
  const missed = (await page.locator('.entry-state').innerText()).replace('nobody@example.invalid', '');
  expect(missed).toBe(matched);
  await expect(page.getByText(/unknown|not found|no account|isn't registered/i)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('a spent sign-in link explains itself and offers a fresh request', async ({ page, baseURL }) => {
  await useSampleEntry(page, baseURL);
  for (const [notice, title] of [
    ['link_expired', 'That link has expired'],
    ['link_used', 'That link was already used'],
    ['link_invalid', "That link didn't work"]
  ] as const) {
    await page.goto(`/auth/complete?notice=${notice}`);
    await expect(page).toHaveURL('/sign-in');
    await expect(page.getByText(title)).toBeVisible();
    // The notice sits above the field it points at; both choices stay offered.
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a magic link' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByText(/token|expired at|jwt/i)).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
