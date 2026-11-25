import type { Page } from '@playwright/test';
import { expect, test, trackErrors } from './fixtures';

/**
 * Resource hygiene on real WebGL (SwiftShader): GPU objects (three's `renderer.info.memory`)
 * must return to their baseline after a vessel is added and removed, and after the graphics
 * quality is changed and changed back. A steady climb here is a leak that kills phones.
 * `?gfx=full` exposes `window.__waveLab` (src/main.tsx).
 */
test.use({ viewport: { width: 960, height: 540 } });

interface Counts {
  geometries: number;
  textures: number;
}

type LabHook = { __waveLab: { stats: () => (Counts & { frames: number }) | null } };

/**
 * Counts as of at least `renders` fresh renders from now. The stats only refresh inside the
 * renderer's render(), and software GL draws well under one frame a second, so waiting on
 * animation frames (which tick regardless) would just re-read a stale render.
 */
async function counts(page: Page, renders = 2): Promise<Counts> {
  const start = await page.evaluate(
    () => (window as unknown as LabHook).__waveLab.stats()?.frames ?? 0,
  );
  await page.waitForFunction(
    ([from, n]) => {
      const s = (window as unknown as LabHook).__waveLab.stats();
      return s !== null && s.frames >= (from as number) + (n as number);
    },
    [start, renders],
    { timeout: 120_000 },
  );
  return page.evaluate(() => {
    const s = (window as unknown as LabHook).__waveLab.stats();
    if (!s) throw new Error('renderer not ready');
    return { geometries: s.geometries, textures: s.textures };
  });
}

/** Counts once they stop changing (deferred disposal and lazy builds settle within a few frames). */
async function settled(page: Page): Promise<Counts> {
  let prev = await counts(page);
  for (let same = 0; same < 3;) {
    const next = await counts(page);
    same = next.geometries === prev.geometries && next.textures === prev.textures ? same + 1 : 0;
    prev = next;
  }
  return prev;
}

test('GPU object counts return to baseline after adding and removing a vessel', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await page.addInitScript(() => localStorage.setItem('wave-lab:performance', 'low'));
  await page.goto('/?gfx=full');
  await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
    timeout: 60_000,
  });
  const scene = page.getByRole('navigation', { name: 'Scene' });

  // Add and remove a vessel: its meshes, textures and wake resources must all go again. The first
  // three cycles warm up pools and caches (model library; the crew sprite mesh grows 1.5x), so they
  // only warm up; later cycles must leave the counts exactly where they were.
  const cycle = async () => {
    await scene.getByRole('button', { name: 'Add vessel' }).click();
    await page.getByRole('menuitem', { name: 'Oil tanker (VLCC)' }).click();
    await expect(scene.getByRole('button', { name: /^Oil tanker \d/ })).toBeVisible();
    await settled(page);
    await scene.getByRole('button', { name: /^Remove Oil tanker/ }).click();
    await expect(scene.getByRole('button', { name: /^Oil tanker \d/ })).toHaveCount(0);
    return settled(page);
  };
  for (let i = 0; i < 3; i++) await cycle();
  const base = await settled(page);
  expect(base.geometries).toBeGreaterThan(0);
  for (let i = 0; i < 2; i++) {
    const after = await cycle();
    expect(after).toEqual(base);
  }
  expect(errors).toEqual([]);
});

test('GPU object counts return to baseline after changing the graphics quality', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await page.addInitScript(() => localStorage.setItem('wave-lab:performance', 'low'));
  await page.goto('/?gfx=full');
  await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
    timeout: 60_000,
  });
  // Quality up and straight back down: the particle pools and the ocean mesh are rebuilt, not
  // accumulated. (Medium is never drawn here: software GL manages under one frame a second at
  // medium, so the round trip exercises the rebuild and disposal paths, not a medium render.)
  const graphics = page.getByRole('combobox', { name: /Graphics/ });
  const roundTrip = async () => {
    await graphics.selectOption('medium');
    await graphics.selectOption('low');
    return settled(page);
  };
  for (let i = 0; i < 2; i++) await roundTrip();
  const base = await settled(page);
  for (let i = 0; i < 2; i++) expect(await roundTrip()).toEqual(base);
  expect(errors).toEqual([]);
});

test('GPU object counts return to baseline after the HDR post composer is built and freed', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  // Low quality leaves every post effect off under software GL, so the composer does not exist
  // until a setting asks for it: the quality round trip above never builds it.
  await page.addInitScript(() => localStorage.setItem('wave-lab:performance', 'low'));
  await page.goto('/?gfx=full');
  await expect(page.getByRole('status').filter({ hasText: 'Simulation running' })).toBeAttached({
    timeout: 60_000,
  });
  const bloom = async (value: 'on' | 'off') => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByLabel('Bloom').selectOption(value);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
  // Turning bloom on and off again. The first rounds warm one-off caches (measured: one extra
  // fullscreen-pass geometry appears over the first two rounds and then stays), so they only warm
  // up; later rounds must leave the counts where they were.
  const round = async () => {
    await bloom('on');
    const built = await settled(page);
    await bloom('off');
    return { built, freed: await settled(page) };
  };
  for (let i = 0; i < 3; i++) await round();
  const base = await settled(page);
  for (let i = 0; i < 2; i++) {
    const { built, freed } = await round();
    // The composer really was built (its render targets are textures) and really was freed.
    expect(built.textures).toBeGreaterThan(base.textures);
    expect(freed).toEqual(base);
  }
  expect(errors).toEqual([]);
});
