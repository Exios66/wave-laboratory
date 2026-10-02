import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

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
