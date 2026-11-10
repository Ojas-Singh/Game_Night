import { test, expect } from '@playwright/test';

test('front door is a single non-scrolling view and opens a room with every game', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Take a seat\./ })).toBeVisible();
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
