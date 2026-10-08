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

/** Elapsed simulation time from the playback strip (`aria-label="Simulation time 12.3 seconds"`). */
async function simulationSeconds(time: ReturnType<Page['locator']>): Promise<number> {
  const label = await time.getAttribute('aria-label');
  const m = /Simulation time ([\d.]+) seconds/.exec(label ?? '');
  expect(m, `expected a simulation-time label, got ${label}`).toBeTruthy();
  return Number(m![1]);
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

  test('chart shows the camera, zooms, and sends the camera exploring', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);
    const chart = page.getByRole('region', { name: 'Chart' });
    await expect(chart).toBeVisible();
    await expect(chart.locator('#minimap-readout')).toContainText('Hdg');
    await expect(chart.getByText('1.0 km', { exact: true })).toBeVisible();
    await chart.getByRole('button', { name: 'Zoom chart out' }).click();
    await expect(chart.getByText('2.0 km', { exact: true })).toBeVisible();

    // Clicking open water near the rim sends the orbit camera there.
    const map = chart.locator('canvas');
    const box = (await map.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.5);
    const back = chart.getByRole('button', { name: 'Back to fleet' });
    await expect(back).toBeVisible();
    await back.click();
    await expect(back).toBeHidden();

    // Keyboard: arrows explore, Home returns.
    await map.focus();
    await page.keyboard.press('ArrowUp');
    await expect(back).toBeVisible();
    await page.keyboard.press('Home');
    await expect(back).toBeHidden();

    await chart.getByRole('button', { name: 'Hide chart' }).click();
    await expect(chart).toBeHidden();
    await page.getByRole('button', { name: 'Show chart' }).click();
    await expect(page.getByRole('region', { name: 'Chart' })).toBeVisible();
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

  test('picks a Jerlov water type without restarting the sea', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);
    await page
      .getByRole('navigation', { name: 'Scene' })
      .getByRole('button', { name: /Water, wind/ })
      .click();
    const water = page.getByLabel('Water type');
    const time = page.locator('.transport__time');
    await expect(water).toHaveValue('oceanic-ib');

    // t0 must exceed the 800 ms post-change wait: a restart at t=0 would then
    // fail t1 > t0 even at 1× realtime. SwiftShader is slower than wall clock,
    // so poll well beyond the default 5 s.
    await expect.poll(() => simulationSeconds(time), { timeout: 30_000 }).toBeGreaterThan(1);
    const t0 = await simulationSeconds(time);
    await water.selectOption('coastal-9');
    await expect(water).toHaveValue('coastal-9');
    await page.waitForTimeout(800);
    const t1 = await simulationSeconds(time);
    expect(t1).toBeGreaterThan(t0);
    await page.screenshot({ path: 'test-results/water-type-coastal-9.png' });

    await expect.poll(() => simulationSeconds(time), { timeout: 30_000 }).toBeGreaterThan(t1 + 1);
    const t2 = await simulationSeconds(time);
    await water.selectOption('oceanic-i');
    await expect(water).toHaveValue('oceanic-i');
    await page.waitForTimeout(800);
    expect(await simulationSeconds(time)).toBeGreaterThan(t2);
    await page.screenshot({ path: 'test-results/water-type-oceanic-i.png' });
    expect(errors).toEqual([]);
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

  test('enlarges the 3D view by hiding the side panels and chart dock', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);
    const canvas = page.locator('#viewport-canvas');
    const before = (await canvas.boundingBox())!;
    await page.getByRole('button', { name: 'Enlarge view' }).click();
    await expect(page.getByRole('button', { name: 'Panels' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Scene' })).toBeHidden();
    const after = (await canvas.boundingBox())!;
    expect(after.height).toBeGreaterThan(before.height + 60);
    expect(after.width).toBeGreaterThan(before.width + 60);
    await page.keyboard.press('v');
    await expect(page.getByRole('navigation', { name: 'Scene' })).toBeVisible();
    await expect(page.getByRole('separator', { name: 'Resize data dock' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('gives a laptop a tall ocean and grows it when the dock is dragged', async ({ page }) => {
    const errors = trackErrors(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    await waitForSimulation(page);
    const canvas = page.locator('#viewport-canvas');
    const before = (await canvas.boundingBox())!;
    expect(before.height).toBeGreaterThan(480);
    expect(before.width).toBeGreaterThan(700);

    const dock = page.getByRole('separator', { name: 'Resize data dock' });
    const handle = (await dock.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 90, { steps: 8 });
    await page.mouse.up();
    const afterDrag = (await canvas.boundingBox())!;
    expect(afterDrag.height).toBeGreaterThan(before.height);

    await page.getByRole('button', { name: 'Enlarge view' }).click();
    const enlarged = (await canvas.boundingBox())!;
    expect(enlarged.height).toBeGreaterThanOrEqual(afterDrag.height);
    expect(enlarged.width).toBeGreaterThan(before.width + 200);
    expect(enlarged.height).toBeGreaterThan(600);
    await page.screenshot({ path: 'test-results/laptop-enlarged.png' });
    expect(errors).toEqual([]);
  });

  test('rogue-wave preset loads without a model-validity error', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);
    await page.getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('button', { name: /Rogue wave/ }).click();
    await waitForSimulation(page);
    await expect(page.getByRole('textbox', { name: 'Experiment name' })).toHaveValue(
      'Rogue wave · container ship',
    );
    await expect(page.getByText('Model validity')).toHaveCount(0);
    await page
      .getByRole('navigation', { name: 'Scene' })
      .getByRole('button', { name: /^Rogue wave/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Wave system', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Crest height' })).toHaveValue('12.0');
    expect(errors).toEqual([]);
  });

  test('post-processing: bloom, grain and vignette persist and render cleanly', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await waitForSimulation(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Bloom').selectOption('on');
    await dialog.getByRole('switch', { name: 'Film grain' }).click();
    await dialog.getByRole('switch', { name: 'Vignette' }).click();
    await expect(dialog.getByRole('switch', { name: 'Film grain' })).toBeChecked();
    await expect(dialog.getByRole('switch', { name: 'Vignette' })).toBeChecked();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await page.keyboard.press('Escape');
    const time = page.locator('.transport__time');
    const t0 = await simulationSeconds(time);
    await expect.poll(() => simulationSeconds(time), { timeout: 30_000 }).toBeGreaterThan(t0);
    await page.screenshot({ path: 'test-results/post-stack.png' });
    expect(errors).toEqual([]);

    await page.reload();
    await waitForSimulation(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    const again = page.getByRole('dialog', { name: 'Settings' });
    await expect(again.getByLabel('Bloom')).toHaveValue('on');
    await expect(again.getByRole('switch', { name: 'Film grain' })).toBeChecked();
    await expect(again.getByRole('switch', { name: 'Vignette' })).toBeChecked();
    expect(errors).toEqual([]);
  });
});
