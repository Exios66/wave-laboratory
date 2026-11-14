import type { Page } from '@playwright/test';
import { expect, frames, test, trackErrors } from './fixtures';

async function simulationSeconds(page: Page): Promise<number> {
  const label = await page.locator('.transport__time').getAttribute('aria-label');
  const m = /Simulation time ([\d.]+) seconds/.exec(label ?? '');
  return m ? Number(m[1]) : 0;
}

// These tests look for compile errors and GPU self-check mismatches, not layout: a smaller
// canvas keeps the software renderer's per-frame cost (and the run time) down. Wide enough for
// the desktop three-column layout; toolbar buttons are found by their accessible names.
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

test('production build runs under its Content-Security-Policy', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
    // GLTFLoader revokes an embedded texture's blob URL only once it has decoded, so a revoked
    // image URL is proof the texture path ran to the end under the policy.
    const images = new Set<string>();
    const decoded = { count: 0 };
    (window as unknown as { __texturesDecoded: { count: number } }).__texturesDecoded = decoded;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = create(obj);
      if (obj instanceof Blob && obj.type.startsWith('image/')) images.add(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      if (images.delete(url)) decoded.count++;
      revoke(url);
    };
  });
  // Scenery models (meshopt WebAssembly, glTF textures) load on the full tier.
  const model = page.waitForResponse((r) => /\/models\/[\w-]+\.glb$/.test(r.url()), {
    timeout: 120_000,
  });
  await page.goto('/?gfx=full');
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    'content',
    /default-src 'self'/,
  );
  const running = page.getByRole('status').filter({ hasText: 'Simulation running' });
  await expect(running).toBeAttached({ timeout: 60_000 });
  const t0 = await simulationSeconds(page);
  await expect.poll(() => simulationSeconds(page), { timeout: 60_000 }).toBeGreaterThan(t0);
  expect((await model).status()).toBe(200);
  await page.getByRole('radio', { name: 'Underwater' }).click();
  await expect(page.getByText(/^Underwater · \d+\.\d m$/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Wave gauges' }).click();
  await expect(page.locator('figure.chart').first()).toBeVisible({ timeout: 30_000 });
  // Saving hands the browser a blob download.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Save/ }).click();
  await download;
  // Wait until a model texture has decoded, then check nothing was blocked.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __texturesDecoded: { count: number } }).__texturesDecoded.count,
        ),
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0);
  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
  );
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});

/** Mean and variance of the canvas's luminance, from a screenshot decoded in the page. */
async function canvasLuma(page: Page): Promise<{ mean: number; variance: number }> {
  const png = await page.locator('#viewport-canvas').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    let sq = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const y = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      sum += y;
      sq += y * y;
    }
    const mean = sum / n;
    return { mean, variance: sq / n - mean * mean };
  }, png.toString('base64'));
}

test.describe('temporal antialiasing', () => {
  // Smaller than the file's viewport: each pixel check reads a screenshot under SwiftShader.
  test.use({ viewport: { width: 960, height: 540 } });

  test('TAA: renders, survives camera cuts, no console errors', async ({ page }) => {
    test.setTimeout(390_000);
    const errors = trackErrors(page);
    // A sampler reading the target it renders into shows up as a WebGL warning, not an error.
    const feedback: string[] = [];
    page.on('console', (msg) => {
      if (/feedback loop/i.test(msg.text())) feedback.push(msg.text());
    });
    await page.addInitScript(() => localStorage.setItem('wave-lab:performance', 'high'));
    // The full tier at high quality: Auto turns temporal antialiasing on.
    await page.goto('/?gfx=full');
    const running = page.getByRole('status').filter({ hasText: 'Simulation running' });
    await expect(running).toBeAttached({ timeout: 60_000 });
    const readout = page.locator('.transport .field__hint[title*="GPU time"]');
    const taaOn = (on: boolean) =>
      expect
        .poll(
          async () => /Temporal antialiasing on/.test((await readout.getAttribute('title')) ?? ''),
          {
            timeout: 60_000,
          },
        )
        .toBe(on);
    const looksDrawn = async (where: string) => {
      await frames(page, 3);
      const { mean, variance } = await canvasLuma(page);
      expect(mean, `${where}: not black`).toBeGreaterThan(8);
      expect(variance, `${where}: not flat`).toBeGreaterThan(1);
    };
    const camera = (name: string) => page.getByRole('radio', { name, exact: true });

    await taaOn(true);
    await looksDrawn('orbit');
    await camera('Bridge').click();
    await taaOn(true);
    // Underwater: off (that pass owns the scene depth), and back on once surfaced.
    await camera('Underwater').click();
    await expect(page.getByText(/^Underwater · \d+\.\d m$/)).toBeVisible({ timeout: 30_000 });
    await taaOn(false);
    await looksDrawn('underwater');
    await camera('Orbit').click();
    await expect(page.getByText(/^Underwater · /)).toHaveCount(0, { timeout: 30_000 });
    await taaOn(true);
    // Plane view: off (the aircraft moves with the camera), through two ride cameras.
    await page.getByRole('button', { name: 'Plane' }).click();
    await expect(page.getByText(/^Riding with /)).toBeVisible({ timeout: 30_000 });
    await taaOn(false);
    await page
      .getByRole('radiogroup', { name: 'Plane camera' })
      .getByRole('radio', { name: 'Cockpit' })
      .click();
    await looksDrawn('plane cockpit');
    await page.getByRole('button', { name: 'Land' }).click();
    await expect(page.getByText(/^Riding with /)).toHaveCount(0);
    await taaOn(true);
    await looksDrawn('landed');
    expect(feedback).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('storm visuals', () => {
  test.use({ viewport: { width: 960, height: 540 } });

  test('a storm wets the bridge camera lens and hangs rain curtains, no console errors', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const errors = trackErrors(page);
    await page.addInitScript(() => localStorage.setItem('wave-lab:performance', 'high'));
    await page.goto('/?gfx=full');
    const running = page.getByRole('status').filter({ hasText: 'Simulation running' });
    await expect(running).toBeAttached({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Presets' }).click();
    await page.getByRole('button', { name: /North Sea winter storm/ }).click();
    await expect(running).toBeAttached({ timeout: 60_000 });
    const readout = page.locator('.transport .field__hint[title*="GPU time"]');
    const wetLens = (on: boolean) =>
      expect
        .poll(
          async () => /Raindrops on the lens/.test((await readout.getAttribute('title')) ?? ''),
          { timeout: 90_000 },
        )
        .toBe(on);
    const camera = (name: string) => page.getByRole('radio', { name, exact: true });
    await camera('Bridge').click();
    await wetLens(true);
    await frames(page, 3);
    const { mean, variance } = await canvasLuma(page);
    expect(mean, 'not black').toBeGreaterThan(8);
    expect(variance, 'not flat').toBeGreaterThan(1);
    await page.screenshot({ path: 'test-results/storm-bridge.png' });
    // Under the sea the lens is dry.
    await camera('Underwater').click();
    await expect(page.getByText(/^Underwater · \d+\.\d m$/)).toBeVisible({ timeout: 30_000 });
    await wetLens(false);
    expect(errors).toEqual([]);
  });
});
