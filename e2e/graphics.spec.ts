import type { Page } from '@playwright/test';
import { expect, test, trackErrors } from './fixtures';

async function simulationSeconds(page: Page): Promise<number> {
  const label = await page.locator('.transport__time').getAttribute('aria-label');
  const m = /Simulation time ([\d.]+) seconds/.exec(label ?? '');
  return m ? Number(m[1]) : 0;
}

// These tests look for compile errors and GPU self-check mismatches, not layout: a smaller
// canvas keeps the software renderer's per-frame cost (and the run time) down. Wider than
// 1280 px, where the top bar drops its button labels.
test.use({ viewport: { width: 1300, height: 650 } });

for (const quality of ['high', 'low'] as const) {
  test(`full graphics tier renders at ${quality} quality without errors`, async ({ page }) => {
    // Shader and page errors fail at once (fixtures.ts). The limit only bounds a hung run: it
    // covers every wait below at its own limit (5 × 60 s + 2 × 30 s) plus navigation.
    test.setTimeout(390_000);
    const errors = trackErrors(page);
    await page.addInitScript((q) => {
      localStorage.setItem('wave-lab:performance', q);
      localStorage.setItem(
        'wave-lab:display',
        JSON.stringify({ bloom: 'on', grain: false, vignette: false }),
      );
    }, quality);
    await page.goto('/?gfx=full');
    const running = page.getByRole('status').filter({ hasText: 'Simulation running' });
    await expect(running).toBeAttached({ timeout: 60_000 });
    const t0 = await simulationSeconds(page);
    await expect.poll(() => simulationSeconds(page), { timeout: 60_000 }).toBeGreaterThan(t0);
    // Storm weather exercises rain, streaks, squalls and the heaviest foam. The preset's own
    // wind (24 m/s) shows that the new experiment is loaded; then its clock must advance.
    await page.getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('button', { name: /North Sea winter storm/ }).click();
    await page
      .getByRole('navigation', { name: 'Scene' })
      .getByRole('button', { name: /^Weather/ })
      .click();
    await expect(page.getByRole('textbox', { name: 'Mean wind (10 m)' })).toHaveValue('24.0', {
      timeout: 30_000,
    });
    await expect(running).toBeAttached({ timeout: 60_000 });
    const t1 = await simulationSeconds(page);
    await expect.poll(() => simulationSeconds(page), { timeout: 60_000 }).toBeGreaterThan(t1);
    // Underwater: wait for the depth badge (the camera is under), then for a few more frames.
    await page.getByRole('radio', { name: 'Underwater' }).click();
    await expect(page.getByText(/^Underwater · \d+\.\d m$/)).toBeVisible({ timeout: 30_000 });
    const t2 = await simulationSeconds(page);
    await expect.poll(() => simulationSeconds(page), { timeout: 60_000 }).toBeGreaterThan(t2);
    await page.screenshot({ path: `test-results/graphics-${quality}.png` });
    expect(errors).toEqual([]);
  });
}
