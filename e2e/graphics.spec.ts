import { expect, test, type Page } from '@playwright/test';

/**
 * The device profile turns the heavier graphics off on a software renderer, so the rest of the
 * suite never compiles them. `?gfx=full` forces the full tier here: these tests fail on any
 * shader compile error or GPU self-check mismatch in the paths real GPUs take.
 */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function simulationSeconds(page: Page): Promise<number> {
  const label = await page.locator('.transport__time').getAttribute('aria-label');
  const m = /Simulation time ([\d.]+) seconds/.exec(label ?? '');
  return m ? Number(m[1]) : 0;
}

for (const quality of ['high', 'low'] as const) {
  test(`full graphics tier renders at ${quality} quality without errors`, async ({ page }) => {
    // Budget covers every wait below at its limit (2×60 s + 3×90 s + 3 s) plus navigation.
    test.setTimeout(420_000);
    const errors = trackErrors(page);
    await page.addInitScript((q) => {
      localStorage.setItem('wave-lab:performance', q);
      localStorage.setItem(
        'wave-lab:display',
        JSON.stringify({ bloom: 'on', grain: false, vignette: false }),
      );
    }, quality);
    await page.goto('/?gfx=full');
    await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
      timeout: 60_000,
    });
    const t0 = await simulationSeconds(page);
    await expect.poll(() => simulationSeconds(page), { timeout: 90_000 }).toBeGreaterThan(t0);
    // Storm weather exercises rain, streaks, squalls and the heaviest foam. The preset starts a
    // new simulation: wait for its clock to restart, then for the new run to advance, so a
    // late frame of the old run cannot pass the check.
    const before = await simulationSeconds(page);
    await page.getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('button', { name: /North Sea winter storm/ }).click();
    await expect.poll(() => simulationSeconds(page), { timeout: 90_000 }).toBeLessThan(before);
    await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
      timeout: 60_000,
    });
    const t1 = await simulationSeconds(page);
    await expect.poll(() => simulationSeconds(page), { timeout: 90_000 }).toBeGreaterThan(t1);
    await page.getByRole('radio', { name: 'Underwater' }).click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `test-results/graphics-${quality}.png` });
    expect(errors).toEqual([]);
  });
}
