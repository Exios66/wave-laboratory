import type { Page } from '@playwright/test';
import { expect, test, trackErrors } from './fixtures';

async function waitForSimulation(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
    timeout: 30_000,
  });
}

/**
 * The nonlinear wave path is a separate section of the ocean shader (`nonlinearSample`). A compile
 * or link error, or a GPU/CPU texel mismatch from the render-side verification, is a console error.
 */
const CASES = [
  {
    button: /Steep regular wave/,
    name: 'Steep regular wave · Stokes 5th order',
    note: /Stokes fifth/,
  },
  { button: /Shoaling swell/, name: 'Shoaling swell · cnoidal waves', note: /Cnoidal \(KdV\)/ },
  { button: /Solitary wave/, name: 'Solitary wave · shallow basin', note: /Solitary wave:/ },
];

for (const c of CASES) {
  test(`${c.name} preset draws and shows its theory in the inspector`, async ({ page }) => {
    test.slow();
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);
    await page.getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('button', { name: c.button }).click();
    await waitForSimulation(page);
    await expect(page.getByRole('textbox', { name: 'Experiment name' })).toHaveValue(c.name);
    await page
      .getByRole('navigation', { name: 'Scene' })
      .getByRole('button', { name: /^(Stokes 5 wave|Cnoidal swell|Solitary wave)/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Wave system', exact: true })).toBeVisible();
    await expect(page.getByText(c.note)).toBeVisible();
    expect(errors).toEqual([]);
  });
}
