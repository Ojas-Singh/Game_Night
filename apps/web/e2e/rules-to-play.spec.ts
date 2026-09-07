import { test, expect } from '@playwright/test';

// UI contract fixture; real endpoint quality is a separate, explicitly live gate.
test('clarifications and explicit rule acceptance gate publication', async ({ page }) => {
  const job: any = { id: 'a'.repeat(32), status: 'needs_clarification', report: { ambiguities: ['What happens on a tie?'], assumptions: [], unsupported_mechanics: [] } };
  await page.route('**/api/lab/compile/jobs', route => route.fulfill({ json: { job } }));
  await page.route('**/api/lab/compile/jobs/*/revise', route => { job.status = 'validated'; job.report = { ambiguities: [], assumptions: ['Seat zero goes first'], unsupported_mechanics: [] }; job.rulesSummary = 'Two players compare cards. Ties split the pot.'; job.validation = { episodes: 100, reached_terminal: 100, exhaustive: true }; return route.fulfill({ json: { job } }); });
  await page.route('**/api/lab/compile/jobs/*/accept', route => { job.status = 'ready'; return route.fulfill({ json: { job } }); });
  await page.goto('/gamelab');
  await page.getByLabel('Your game rules').fill('A card comparison game');
  await page.getByRole('button', { name: 'Create game', exact: true }).click();
  await page.getByLabel('What happens on a tie?').fill('Split the pot');
  await page.getByRole('button', { name: 'Update the rules' }).click();
  await expect(page.getByRole('button', { name: 'Accept rules' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'These rules and assumptions match the game I want.' }).check();
  await page.getByRole('button', { name: 'Accept rules' }).click();
  await expect(page.getByRole('button', { name: 'Play with friends', exact: true })).toBeVisible();
});
