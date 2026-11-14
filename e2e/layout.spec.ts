import type { Page } from '@playwright/test';
import { expect, test, trackErrors } from './fixtures';

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
    timeout: 30_000,
  });
}

/** How many line boxes an element's text breaks into. */
function lineCount(page: Page, selector: string): Promise<number[]> {
  return page.$$eval(selector, (els) =>
    els.map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
      return tops.size;
    }),
  );
}

test.describe('medium width 960×540', () => {
  test.use({ viewport: { width: 960, height: 540 } });

  test('keeps every data tab label on one line', async ({ page }) => {
    const errors = trackErrors(page);
    await ready(page);
    const tabs = page.getByRole('tablist', { name: 'Data views' }).getByRole('tab');
    await expect(tabs).toHaveCount(4);
    const heights = await tabs.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    expect(new Set(heights).size).toBe(1);
    const lines = await lineCount(page, '[aria-label="Data views"] [role="tab"]');
    expect(lines).toEqual([1, 1, 1, 1]);
    // No label cut short, the row fits the dock, and the hide button shares it.
    const truncated = await tabs.evaluateAll(
      (els) => els.filter((el) => el.scrollWidth > el.clientWidth).length,
    );
    expect(truncated).toBe(0);
    const tablist = page.getByRole('tablist', { name: 'Data views' });
    expect(await tablist.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const row = await page.evaluate(() => {
      const t = document.querySelector('[aria-label="Data views"]')!.getBoundingClientRect();
      const b = document.querySelector('.app__dock .btn--hide-panel')!.getBoundingClientRect();
      const mid = (b.top + b.bottom) / 2;
      return mid > t.top && mid < t.bottom;
    });
    expect(row).toBe(true);
    expect(errors).toEqual([]);
  });

  test('fits the top bar without overflow', async ({ page }) => {
    await ready(page);
    for (const width of [960, 1100, 1180, 1290, 1401, 1440]) {
      await page.setViewportSize({ width, height: 540 });
      const over = await page.locator('header').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(over, `header overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
    // Graphics and theme stay reachable from Settings.
    await page.setViewportSize({ width: 960, height: 540 });
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog').getByLabel('Colour theme')).toBeVisible();
    await expect(page.getByRole('dialog').getByLabel('Graphics')).toBeVisible();
  });

  test('shows the playback readouts whole', async ({ page }) => {
    await ready(page);
    // Wait for the frame-rate readout to appear.
    await expect(page.locator('.transport .field__hint').last()).toHaveText(/fps/, {
      timeout: 30_000,
    });
    const lines = await lineCount(page, '.transport .field__hint');
    expect(lines.every((n) => n === 1)).toBe(true);
    const clipped = await page.$$eval(
      '.transport .field__hint',
      (els) => els.filter((el) => el.scrollWidth > el.clientWidth).length,
    );
    expect(clipped).toBe(0);
    // Inside the dock, not cut off at its edge.
    const outside = await page.$$eval('.transport .field__hint', (els) => {
      const dock = document.querySelector('.app__dock')!.getBoundingClientRect();
      return els
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.left < dock.left || r.right > dock.right).length;
    });
    expect(outside).toBe(0);
  });

  test('keeps every remove button inside the scene panel', async ({ page }) => {
    await ready(page);
    const scene = page.locator('.app__scene');
    const remove = scene.getByRole('button', { name: /^Remove / });
    expect(await remove.count()).toBeGreaterThan(0);
    const outside = await scene.evaluate((panel) => {
      const p = panel.getBoundingClientRect();
      return Array.from(panel.querySelectorAll('button[aria-label^="Remove "]'))
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.left < p.left || r.right > p.right).length;
    });
    expect(outside).toBe(0);
  });

  test('keeps a long vessel name from pushing its row past the remove button', async ({ page }) => {
    await ready(page);
    const scene = page.locator('.app__scene');
    await scene.locator('.tree__item:has(.tree__health) .tree__select').first().click();
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    await name.fill('Motor tanker Northern Lights of the Hebridean Coastal Trading Company');
    await name.press('Enter');
    await expect(scene.getByText(/^Motor tanker Northern Lights/)).toBeVisible();
    const spill = await scene.evaluate((panel) =>
      Array.from(panel.querySelectorAll('.tree__item')).flatMap((item) => {
        const select = item.querySelector('.tree__select')!.getBoundingClientRect();
        const remove = item.querySelector('button[aria-label^="Remove "]')?.getBoundingClientRect();
        return Array.from(item.querySelectorAll('.tree__select > *'))
          .map((el) => [el.className, el.getBoundingClientRect()] as const)
          .filter(
            ([, r]) => r.right > select.right + 0.5 || (remove && r.right > remove.left + 0.5),
          )
          .map(([cls]) => cls);
      }),
    );
    expect(spill).toEqual([]);
  });

  test('starts with the chart folded when the 3D view is narrow', async ({ page }) => {
    await ready(page);
    const width = await page.locator('.app__viewport').evaluate((el) => el.clientWidth);
    expect(width).toBeLessThan(700);
    await expect(page.getByRole('button', { name: 'Show chart' })).toBeVisible();
    await expect(page.locator('section.minimap')).toHaveCount(0);
  });
});

test('starts with the chart open when the 3D view is wide', async ({ page }) => {
  await ready(page);
  await expect(page.locator('section.minimap')).toBeVisible();
});

test('shows the scene rows in full at the default desktop width', async ({ page }) => {
  await ready(page);
  const cut = await page.$$eval('.app__scene .tree__label, .app__scene .tree__meta', (els) =>
    els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent),
  );
  expect(cut).toEqual([]);
});
