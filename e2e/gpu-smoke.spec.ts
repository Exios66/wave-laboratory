/**
 * Smoke tests of the full renderer (ocean, sky, fake vessel, probes, overlays, cameras, picking,
 * context loss, dispose) on desktop and on a mobile (touch) viewport. Screenshots are written to
 * test-results/ for visual inspection.
 */
import { devices, expect, test, type Page } from '@playwright/test';
import { openHarness, type HarnessGlobal } from './gpu-harness';

const SHOTS = 'test-results';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

async function step(page: Page, frames: number) {
  await page.evaluate((n) => (globalThis as unknown as HarnessGlobal).gpuHarness.step(n), frames);
}

async function expectHealthy(page: Page) {
  const glError = await page.evaluate(() =>
    (globalThis as unknown as HarnessGlobal).gpuHarness.glError(),
  );
  expect(glError, 'gl.getError()').toBe(0);
  const img = await page.evaluate(() =>
    (globalThis as unknown as HarnessGlobal).gpuHarness.canvasStats(),
  );
  // Not blank: some brightness and real image structure.
  expect(img.mean).toBeGreaterThan(10);
  expect(img.std).toBeGreaterThan(5);
}

test.describe('desktop', () => {
  test('renders ocean, sky, vessel and probes without WebGL errors', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = collectErrors(page);
    await openHarness(page);
    const { floatPath } = await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.startScene({ quality: 'high' }),
    );
    console.info(`float path: ${floatPath}`);
    await step(page, 6);
    await expectHealthy(page);
    await page.screenshot({ path: `${SHOTS}/gpu-smoke-orbit.png` });

    const stats = await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.stats(),
    );
    console.info(`stats: ${JSON.stringify(stats)}`);
    expect(stats.drawCalls).toBeGreaterThan(10);
    expect(stats.triangles).toBeGreaterThan(100_000);

    // Selection highlight + follow camera.
    await page.evaluate(() => {
      const h = (globalThis as unknown as HarnessGlobal).gpuHarness;
      h.setSelection('ship');
      h.setCamera('follow', 'ship');
    });
    await step(page, 4);
    await expectHealthy(page);
    await page.screenshot({ path: `${SHOTS}/gpu-smoke-follow.png` });

    await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.setCamera('bridge', 'ship'),
    );
    await step(page, 2);
    await expectHealthy(page);
    await page.screenshot({ path: `${SHOTS}/gpu-smoke-bridge.png` });

    // Overlays with legends.
    await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.setCamera('top', 'ship'),
    );
    for (const mode of ['height', 'steepness', 'foam'] as const) {
      const legend = await page.evaluate(
        (m) => (globalThis as unknown as HarnessGlobal).gpuHarness.setOverlay(m),
        mode,
      );
      expect(legend?.mode).toBe(mode);
      expect(legend!.max).toBeGreaterThan(legend!.min);
      expect(legend!.stops.length).toBeGreaterThanOrEqual(5);
      await step(page, 2);
      await expectHealthy(page);
      await page.screenshot({ path: `${SHOTS}/gpu-smoke-overlay-${mode}.png` });
    }
    const none = await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.setOverlay('none'),
    );
    expect(none).toBeNull();

    // Orbit again, keyboard nudges, picking.
    await page.evaluate(() => {
      const h = (globalThis as unknown as HarnessGlobal).gpuHarness;
      h.setCamera('orbit');
      for (const a of ['left', 'up', 'in', 'out', 'reset']) h.nudge(a);
    });
    await step(page, 2);
    const vp = page.viewportSize()!;
    const water = await page.evaluate(
      ([x, y]) => (globalThis as unknown as HarnessGlobal).gpuHarness.pick(x!, y!),
      [vp.width / 2, vp.height * 0.95],
    );
    expect(water?.kind).toBe('water');
    expect(Math.abs(water!.point.z)).toBeLessThan(1e-6);

    // Find the ship on screen by scanning picks; click it (tap) and drag (no pick).
    const shipAt = await page.evaluate(
      ([w, h]) => {
        const g = (globalThis as unknown as HarnessGlobal).gpuHarness;
        for (let y = 0.3; y < 0.8; y += 0.02) {
          for (let x = 0.2; x < 0.8; x += 0.02) {
            const r = g.pick(x * w!, y * h!);
            if (r?.kind === 'vessel') return [x * w!, y * h!];
          }
        }
        return null;
      },
      [vp.width, vp.height],
    );
    expect(shipAt, 'vessel visible and pickable in the default framing').not.toBeNull();
    await page.mouse.click(shipAt![0]!, shipAt![1]!);
    await page.mouse.move(shipAt![0]!, shipAt![1]!);
    await page.mouse.down();
    await page.mouse.move(shipAt![0]! + 40, shipAt![1]! + 10, { steps: 5 });
    await page.mouse.up();
    const picks = await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.picks(),
    );
    expect(picks.length, 'one tap → one pick; the drag is ignored').toBe(1);
    expect(picks[0]?.kind).toBe('vessel');
    expect(picks[0]?.id).toBe('ship');

    // Dynamic resolution below 1.
    await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.resize(1440, 900, 0.75),
    );
    await step(page, 2);
    await expectHealthy(page);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('survives WebGL context loss and frees all GPU resources on dispose', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await openHarness(page);
    await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.startScene({ quality: 'low' }),
    );
    await step(page, 2);
    await page.evaluate(() => (globalThis as unknown as HarnessGlobal).gpuHarness.loseContext());
    await expect
      .poll(() =>
        page.evaluate(() => (globalThis as unknown as HarnessGlobal).gpuHarness.contextEvents()),
      )
      .toEqual({ lost: 1, restored: 0 });
    await step(page, 2); // render() while lost must be a no-op
    await page.evaluate(() => (globalThis as unknown as HarnessGlobal).gpuHarness.restoreContext());
    await expect
      .poll(() =>
        page.evaluate(() => (globalThis as unknown as HarnessGlobal).gpuHarness.contextEvents()),
      )
      .toEqual({ lost: 1, restored: 1 });
    await step(page, 3);
    await expectHealthy(page);
    await page.screenshot({ path: `${SHOTS}/gpu-smoke-restored.png` });

    const mem = await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.disposeScene(),
    );
    console.info(`after dispose: ${JSON.stringify(mem)}`);
    expect(mem.geometries).toBe(0);
    expect(mem.textures).toBe(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('falls back to the half-float path cleanly', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await openHarness(page);
    const { floatPath } = await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.startScene({
        quality: 'medium',
        forceHalfFloat: true,
      }),
    );
    expect(floatPath).toBe('float16');
    await step(page, 3);
    await expectHealthy(page);
    await page.screenshot({ path: `${SHOTS}/gpu-smoke-halffloat.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('mobile', () => {
  // Pixel 7 viewport, DPR, touch and mobile UA (browser stays Chromium).
  const { defaultBrowserType: _ignored, ...pixel7 } = devices['Pixel 7'];
  test.use(pixel7);

  test('renders on a touch viewport and picks from taps', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await openHarness(page);
    await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.startScene({
        quality: 'medium',
        pixelRatio: 0.8,
      }),
    );
    await step(page, 4);
    await expectHealthy(page);
    await page.screenshot({ path: `${SHOTS}/gpu-smoke-mobile.png` });
    const vp = page.viewportSize()!;
    await page.touchscreen.tap(vp.width / 2, vp.height * 0.9);
    const picks = await page.evaluate(() =>
      (globalThis as unknown as HarnessGlobal).gpuHarness.picks(),
    );
    expect(picks.length).toBe(1);
    expect(picks[0]?.kind).toBe('water');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
