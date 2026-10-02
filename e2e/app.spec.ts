import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** Collect console errors and uncaught exceptions for the whole test. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function waitForSimulation(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
    timeout: 30_000,
  });
}

test.describe('Wave Laboratory app', () => {
  test('boots, simulates and renders without errors', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await expect(page).toHaveTitle(/Wave Laboratory/);
    await waitForSimulation(page);
    // Simulation time advances while playing.
    const time = page.locator('.transport__time');
    const t0 = await time.textContent();
    await page.waitForTimeout(1500);
    expect(await time.textContent()).not.toBe(t0);
    await page.screenshot({ path: 'test-results/app-default.png' });
    expect(errors).toEqual([]);
  });

  test('has no detectable WCAG 2.2 A/AA violations', async ({ page }) => {
    await page.goto('/');
    await waitForSimulation(page);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });

  test('also passes accessibility checks in the light theme and with dialogs open', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await waitForSimulation(page);
    await page.getByRole('button', { name: 'Presets' }).click();
    await expect(page.getByRole('dialog', { name: 'Experiment presets' })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test('loads a preset and edits a vessel entirely from the keyboard', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);

    await page.getByRole('button', { name: 'Presets' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Experiment presets' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /North Sea winter storm/ }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await waitForSimulation(page);
    await expect(page.getByRole('textbox', { name: 'Experiment name' })).toHaveValue(
      'North Sea winter storm',
    );

    const vesselButton = page.getByRole('navigation', { name: 'Scene' }).getByRole('button', {
      name: /^FV Northern Star/,
    });
    await vesselButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Vessel', exact: true })).toBeVisible();

    const heading = page.getByRole('textbox', { name: 'Heading' });
    await heading.fill('200');
    await heading.press('Enter');
    await expect(heading).toHaveValue('200');

    // Space toggles play/pause when focus is not on a control.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

    // Undo restores the previous heading.
    await page.keyboard.press('Control+z');
    await expect(heading).not.toHaveValue('200');
    expect(errors).toEqual([]);
  });

  test('records data and shows statistics', async ({ page }) => {
    await page.goto('/');
    await waitForSimulation(page);
    await page.getByRole('combobox', { name: 'Simulation speed' }).selectOption('4');
    await page.waitForTimeout(4000);
    await page.getByRole('tab', { name: 'Statistics' }).click();
    const table = page.getByRole('table', { name: 'Wave gauges' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(2);
    await page.getByRole('tab', { name: 'Vessel motions' }).click();
    await expect(page.getByRole('figure').first()).toBeVisible();
  });

  test('rejects invalid input with an accessible message', async ({ page }) => {
    await page.goto('/');
    await waitForSimulation(page);
    await page
      .getByRole('navigation', { name: 'Scene' })
      .getByRole('button', { name: /^Wind sea/ })
      .click();
    const hs = page.getByRole('textbox', { name: 'Significant wave height Hs' });
    await hs.fill('abc');
    await hs.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'Enter a number' })).toBeVisible();
  });

  test('round-trips an experiment through a share link', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await waitForSimulation(page);
    await page.getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('button', { name: /Wave tank/ }).click();
    await waitForSimulation(page);
    await page.getByRole('button', { name: 'Share link' }).click();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toContain('#exp=');
    const page2 = await context.newPage();
    await page2.goto(url);
    await expect(page2.getByRole('textbox', { name: 'Experiment name' })).toHaveValue(
      'Wave tank: Wigley hull',
    );
  });

  test('runs the hurricane, edits the weather and keeps values when tabbing', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);
    await page.getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('button', { name: /Hurricane/ }).click();
    await waitForSimulation(page);

    const scene = page.getByRole('navigation', { name: 'Scene' });
    await scene.getByRole('button', { name: /^Weather/ }).click();
    const wind = page.getByRole('textbox', { name: 'Mean wind (10 m)' });
    await expect(wind).toHaveValue('42.0');
    // A typed value between slider steps must survive tabbing across the slider, which would
    // otherwise write back its step-snapped copy (42.5).
    await wind.fill('42.3');
    await wind.press('Enter');
    await waitForSimulation(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Tab');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    await expect(wind).toHaveValue('42.3');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await page
      .getByRole('group', { name: 'Weather presets' })
      .getByRole('button', { name: 'Gale' })
      .click();
    await waitForSimulation(page);
    await expect(wind).not.toHaveValue('42.3');
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  });

  test('easter eggs: Konami duck and the Draupner wave', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    for (const key of [
      'ArrowUp',
      'ArrowUp',
      'ArrowDown',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowLeft',
      'ArrowRight',
      'b',
      'a',
    ]) {
      await page.keyboard.press(key);
    }
    await expect(page.getByText(/Rubber duck mode/)).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'test-results/easter-duck.png' });
    await page.keyboard.type('draupner');
    await expect(page.getByRole('textbox', { name: 'Experiment name' })).toHaveValue(
      /Draupner, 1995/,
    );
    await waitForSimulation(page);
    expect(errors).toEqual([]);
  });

  test('rides a lost flight for a bird’s-eye view and lands again', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);
    const plane = page.getByRole('button', { name: 'Plane' });
    await plane.click();
    await expect(page.getByRole('button', { name: 'Land' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText(/^Riding with /)).toBeVisible({ timeout: 10_000 });
    // Let the flight condense, then look further down at the fleet.
    await page.waitForTimeout(3500);
    await page.screenshot({ path: 'test-results/plane-view.png' });
    const canvas = page.locator('#viewport-canvas');
    await canvas.focus();
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-results/plane-view-down.png' });
    await page.getByRole('button', { name: 'Land' }).click();
    await expect(page.getByRole('radio', { name: 'Orbit' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByText(/^Riding with /)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
