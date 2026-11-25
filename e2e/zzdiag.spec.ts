import { expect, test } from './fixtures';
for (const [w, h] of [[1440, 900], [960, 540]]) {
  test(`diag fps ${w}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?perf');
    await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({ timeout: 100_000 });
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(5000);
      const r = await page.evaluate(() => {
        const w = window as any;
        return JSON.stringify({ g: w.__waveLab.governor(), s: w.__waveLab.stats() });
      });
      console.log(w, r.slice(0, 400));
    }
    console.log(w, await page.locator('.transport .field__hint[title*="GPU"]').first().textContent(), await page.locator('#viewport-canvas').boundingBox());
  });
}
