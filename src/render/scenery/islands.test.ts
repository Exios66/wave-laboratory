import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ISLAND_CELL,
  ISLAND_CLEAR_RADIUS,
  ISLAND_FOOTPRINT,
  ISLAND_VIEW_RANGE,
  IslandLayer,
  islandInCell,
  islandsInCell,
  POOL_SIZE,
  keysInCell,
  islandsNear,
  type IslandSpec,
} from './islands';
import type { SceneryFrame } from './types';

function scan(range: number, keys = true): IslandSpec[] {
  const out: IslandSpec[] = [];
  for (let iy = -range; iy < range; iy++) {
    for (let ix = -range; ix < range; ix++) {
      if (keys) out.push(...islandsInCell(ix, iy));
      else {
        const one = islandInCell(ix, iy);
        if (one) out.push(one);
      }
    }
  }
  return out;
}

describe('island placement', () => {
  it('is deterministic and independent of where you look from', () => {
    const a = islandsNear(12_000, -7_000, 5_000);
    const b = islandsNear(12_000, -7_000, 5_000);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    const far = islandsNear(14_000, -5_000, 8_000);
    for (const spec of a) expect(far.find((s) => s.key === spec.key)).toEqual(spec);
  });

  it('gives every cell its own island, with no mirror-image repeats', () => {
    const all = scan(20);
    expect(new Set(all.map((s) => s.seed)).size).toBe(all.length);
    expect(new Set(all.map((s) => s.radius.toFixed(6))).size).toBe(all.length);
  });

  it('returns islands nearest first, each reaching into the radius', () => {
    const list = islandsNear(-3_000, 9_000, 6_000);
    let last = -1;
    for (const s of list) {
      const d = Math.hypot(s.x + 3_000, s.y - 9_000);
      expect(d).toBeGreaterThanOrEqual(last);
      expect(d - s.radius * ISLAND_FOOTPRINT).toBeLessThanOrEqual(6_000);
      last = d;
    }
  });

  it('agrees with a brute-force scan of the grid', () => {
    const [x, y, r] = [4_321, -2_345, 4_000];
    const brute = scan(12)
      .filter((s) => Math.hypot(s.x - x, s.y - y) - s.radius * ISLAND_FOOTPRINT <= r)
      .map((s) => s.key)
      .sort();
    expect(
      islandsNear(x, y, r)
        .map((s) => s.key)
        .sort(),
    ).toEqual(brute);
  });

  it('keeps the experiment area around the origin open water', () => {
    expect(islandsNear(0, 0, ISLAND_CLEAR_RADIUS)).toEqual([]);
    for (const s of scan(4)) {
      expect(Math.hypot(s.x, s.y) - s.radius * ISLAND_FOOTPRINT).toBeGreaterThanOrEqual(
        ISLAND_CLEAR_RADIUS,
      );
    }
    // But the sea is not empty: something lies within a few kilometres.
    expect(islandsNear(0, 0, ISLAND_VIEW_RANGE).length).toBeGreaterThan(0);
  });

  it('scatters roughly a third of cells with islands of sensible size', () => {
    const range = 60;
    const all = scan(range, false);
    const cells = (2 * range) ** 2;
    const share = all.length / cells;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.42);
    for (const s of all) {
      expect(s.radius).toBeGreaterThanOrEqual(20);
      expect(s.radius).toBeLessThanOrEqual(230);
      expect(s.palms).toBeGreaterThanOrEqual(1);
    }
    const large = all.filter((s) => s.radius > 150).length / all.length;
    expect(large).toBeGreaterThan(0.02);
    expect(large).toBeLessThan(0.12);
    const lighthouses = all.filter((s) => s.lighthouse).length / all.length;
    expect(lighthouses).toBeGreaterThan(0.01);
    expect(lighthouses).toBeLessThan(0.15);
    expect(all.some((s) => s.hut)).toBe(true);
    expect(all.some((s) => s.dock)).toBe(true);
  });

  it('strings chains of small keys through cells that have no island', () => {
    let chains = 0;
    for (let iy = -20; iy < 20; iy++) {
      for (let ix = -20; ix < 20; ix++) {
        const keys = keysInCell(ix, iy);
        if (keys.length === 0) continue;
        expect(islandInCell(ix, iy)).toBeNull();
        if (keys.length >= 3) chains++;
        for (const k of keys) expect(k.radius).toBeLessThan(45);
      }
    }
    expect(chains).toBeGreaterThan(40);
  });

  it('never lets two islands (lagoons included) overlap', () => {
    const all = islandsNear(30_000, 30_000, 12_000);
    for (const a of all) {
      const ix = Math.floor(a.x / ISLAND_CELL);
      const iy = Math.floor(a.y / ISLAND_CELL);
      expect(a.key.startsWith(`${ix}:${iy}`)).toBe(true);
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.radius + b.radius) * ISLAND_FOOTPRINT;
        expect(gap).toBeGreaterThan(0);
      }
    }
  });
});

function frame(camera: THREE.PerspectiveCamera, wallT = 0): SceneryFrame {
  return {
    t: wallT,
    dt: 0.016,
    wallT,
    camera,
    calm: 1,
    daylight: 0.2,
    timeOfDay: 21,
    sunDir: new THREE.Vector3(0, 1, 0),
    windSpeed: 7,
    windDirectionDeg: 45,
    hs: 1,
    vessels: [],
    vesselPositions: [],
  };
}

describe('IslandLayer', () => {
  it('builds only nearby islands and recycles a bounded pool while roaming', () => {
    const layer = new IslandLayer();
    const camera = new THREE.PerspectiveCamera();
    let maxChildren = 0;
    for (let i = 0; i < 120; i++) {
      // Walk 60 km east-north-east in 500 m steps (world x east, y north → three (x, ·, −y)).
      camera.position.set(i * 500, 120, -i * 200);
      layer.update(frame(camera, i * 0.1));
      const wx = camera.position.x;
      const wy = -camera.position.z;
      const expected = islandsNear(wx, wy, ISLAND_VIEW_RANGE).map((s) => s.key);
      expect(layer.visibleIslands.map((s) => s.key).sort()).toEqual(
        expected.slice(0, POOL_SIZE).sort(),
      );
      maxChildren = Math.max(maxChildren, layer.object.children.length);
    }
    // Pool meshes + palms + lagoons + a few lighthouse glows; never grows with distance walked.
    expect(maxChildren).toBeLessThanOrEqual(POOL_SIZE * 2 + 2);
    const visibleMeshes = layer.object.children.filter((c) => c.visible && c.name === 'island');
    expect(visibleMeshes.length).toBe(layer.visibleIslands.length);
    layer.dispose();
    expect(layer.object.children.length).toBe(0);
  });

  it('does no work while hidden', () => {
    const layer = new IslandLayer();
    layer.setEnabled(false);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(5_000, 50, 5_000);
    layer.update(frame(camera));
    expect(layer.visibleIslands).toEqual([]);
    layer.dispose();
  });
});
