import type { Page } from '@playwright/test';
import { expect, frames, test, trackErrors } from './fixtures';

/**
 * Resource hygiene on real WebGL (SwiftShader): GPU objects (three's `renderer.info.memory`)
 * must return to their baseline after a vessel is added and removed, and after the graphics
 * quality is changed and changed back. A steady climb here is a leak that kills phones.
 * `?gfx=full` exposes `window.__waveLab` (src/main.tsx).
 */
test.use({ viewport: { width: 1300, height: 650 } });

interface Counts {
  geometries: number;
  textures: number;
}

async function counts(page: Page): Promise<Counts> {
  await frames(page, 2);
  return page.evaluate(() => {
    const s = (
      window as unknown as { __waveLab: { stats: () => Counts | null } }
    ).__waveLab.stats();
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
