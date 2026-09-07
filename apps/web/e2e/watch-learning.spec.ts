import { test, expect } from '@playwright/test';
test('learning UI distinguishes evaluated policies from an empty registry', async ({ page }) => {
  await page.route('**/api/lab/checkpoints', route => route.fulfill({ json: { checkpoints: [] } }));
  await page.goto('/gamelab');
  await expect(page.getByRole('heading', { name: 'Watch practice become progress' })).toBeVisible();
  await expect(page.getByText('No trained checkpoints yet.', { exact: false })).toBeVisible();
});
