import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, frames, test, trackErrors } from './fixtures';

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
    timeout: 30_000,
  });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('mobile layout', () => {
  test('loads, renders and fits the screen', async ({ page }, info) => {
    const errors = trackErrors(page);
    await ready(page);
    const canvas = page.locator('#viewport-canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box!.width).toBeGreaterThan(300);
    expect(box!.height).toBeGreaterThan(200);
    await expect(page.getByRole('tablist', { name: 'Panels' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `test-results/mobile-${info.project.name}.png` });
    expect(errors).toEqual([]);
  });

  test('plane view controls fit a phone and are easy to tap', async ({ page }) => {
    const errors = trackErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await ready(page);
    await page.getByRole('button', { name: 'Plane' }).click();
    const card = page.locator('.hud__ride');
    await expect(card.getByText(/^Riding with /)).toBeVisible({ timeout: 10_000 });
    const fits = await card.evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(fits).toBe(true);
    const box = await card.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    for (const radio of await card.getByRole('radio').all()) {
      expect((await radio.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      (await card.getByRole('button', { name: 'Next aircraft' }).boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('underwater view renders on a phone without errors', async ({ page }) => {
    const errors = trackErrors(page);
    await ready(page);
    const underwater = page.getByRole('radio', { name: 'Underwater' });
    await underwater.click();
    await expect(underwater).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(/^Underwater · \d+\.\d m$/)).toBeVisible({ timeout: 10_000 });
    await frames(page, 6);
    await expectNoHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('switches panels and edits a vessel with touch', async ({ page }) => {
    await ready(page);
    const panels = page.getByRole('tablist', { name: 'Panels' });
    await panels.getByRole('tab', { name: 'Scene' }).tap();
    await page
      .getByRole('navigation', { name: 'Scene' })
      .getByRole('button', { name: /^MV Meridian/ })
      .tap();
    // Selecting reveals the inspector automatically.
    await expect(panels.getByRole('tab', { name: 'Inspector' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const speed = page.getByRole('textbox', { name: 'Speed' });
    await expect(speed).toBeVisible();
    await speed.fill('8');
    await speed.press('Enter');
    await expect(speed).toHaveValue('8.0');
    await panels.getByRole('tab', { name: 'Data' }).tap();
    await expect(page.getByRole('button', { name: /Pause|Play/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('offers every desktop action through the More menu', async ({ page }) => {
    await ready(page);
    await page.getByRole('button', { name: 'More actions' }).tap();
    const menu = page.getByRole('menu', { name: 'More actions' });
    for (const item of ['New experiment', 'Open…', 'Save', 'Share link', 'Settings…', 'Help']) {
      await expect(menu.getByRole('menuitem', { name: item })).toBeVisible();
    }
    await menu.getByRole('menuitem', { name: 'Settings…' }).tap();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  });

  test('has no detectable WCAG 2.2 A/AA violations', async ({ page }) => {
    await ready(page);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });

  test('works in landscape', async ({ page }, info) => {
    const vp = page.viewportSize()!;
    await page.setViewportSize({
      width: Math.max(vp.width, vp.height),
      height: Math.min(vp.width, vp.height),
    });
    await ready(page);
    await expect(page.locator('#viewport-canvas')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `test-results/mobile-landscape-${info.project.name}.png` });
  });
});
