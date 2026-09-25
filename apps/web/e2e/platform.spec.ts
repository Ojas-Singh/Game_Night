import { test, expect } from '@playwright/test';

test('front door is a single non-scrolling view and opens a room with every game', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Take a seat\./ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Game Lab' })).toBeVisible();
  // The landing screen is a doorway, not a catalogue: it must never scroll.
  const metrics = await page.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  expect(metrics.scrollH).toBeLessThanOrEqual(metrics.innerH + 1);
  expect(metrics.scrollW).toBeLessThanOrEqual(metrics.innerW);
  await page.getByRole('button', { name: 'Deal me in' }).click();
  await expect(page).toHaveURL(/\/game\/[A-Z0-9]+/);
  await expect(page.getByRole('button', { name: /Seep/ }).first()).toBeVisible();
});

test('real gallery launch plays with AI and rematches retain the spec', async ({ page }) => {
  await page.goto('/gamelab');
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Kuhnish Duel' }) });
  await card.getByRole('button', { name: 'Play vs AI' }).click();
  await expect(page.locator('[data-spec-hash]')).toBeVisible();
  const hash = await page.locator('[data-spec-hash]').getAttribute('data-spec-hash');
  for (let i = 0; i < 12; i++) {
    if (await page.getByRole('button', { name: 'Play again', exact: true }).isVisible()) break;
    const action = page.locator('.rz-action').first();
    if (await action.isVisible()) await action.click();
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: 'Play again', exact: true }).click();
  await expect(page.locator('[data-spec-hash]')).toHaveAttribute('data-spec-hash', hash!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('compiler unavailable state is actionable and never creates a stub', async ({ page }) => {
  await page.route('**/api/lab/compile/jobs', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Compiler unavailable: test fixture' }),
  }));
  await page.goto('/gamelab');
  await page.getByLabel('Your game rules').fill('Two players each ante one token.');
  await page.getByRole('button', { name: 'Create game', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('Compiler unavailable');
  await expect(page.getByRole('button', { name: 'Accept rules' })).toHaveCount(0);
});
