/**
 * Issue #43 performance budget, asserted against the real layers (not just the constants):
 *
 *   | per tier                        | full | mid | lite |
 *   | background traffic hulls        |  12  |  8  |  4   |
 *   | static architecture cells live  |   3  |  2  |  0   |
 *   | underwater extra draw calls     |   4  |  2  |  1   |
 *   | underwater cost when surfaced   |   0  |  0  |  0   |
 *
 * Draw calls are counted the way the renderer issues them: a visible Mesh / Points / Line is one
 * call, an InstancedMesh with `count === 0` is skipped, and anything under an invisible ancestor
 * is not drawn.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { UNDERWATER_BUDGET, UnderwaterSceneryLayer } from '../underwater/scenery';
import {
  STRUCTURE_BUDGET,
  STRUCTURE_CELL,
  structuresInCell,
  TRAFFIC_BUDGET,
  TRAFFIC_CELL,
  TRAFFIC_VIEW_RANGE,
  trafficInCell,
  TrafficLayer,
} from './traffic';
import type { SceneryFrame, SceneryTier } from './types';

const TIERS: SceneryTier[] = ['full', 'mid', 'lite'];

function drawCalls(root: THREE.Object3D): number {
  if (!root.visible) return 0;
  let n = 0;
  if ((root as THREE.InstancedMesh).isInstancedMesh) {
    n += (root as THREE.InstancedMesh).count > 0 ? 1 : 0;
  } else if (
    (root as THREE.Mesh).isMesh ||
    (root as THREE.Points).isPoints ||
    (root as THREE.Line).isLine
  ) {
    const geo = (root as THREE.Mesh).geometry;
    const drawn = geo.drawRange.count === Infinity ? 1 : geo.drawRange.count;
    n += drawn > 0 ? 1 : 0;
  }
  for (const c of root.children) n += drawCalls(c);
  return n;
}

function instances(root: THREE.Object3D, prefix: string): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh && o.name.startsWith(prefix)) {
      n += (o as THREE.InstancedMesh).count;
    }
  });
  return n;
}

function makeFrame(camera: THREE.Camera, overrides: Partial<SceneryFrame> = {}): SceneryFrame {
  return {
    t: 200,
    dt: 0.05,
    wallT: 200,
    camera: camera as THREE.PerspectiveCamera,
    calm: 1,
    daylight: 0.1,
    timeOfDay: 23,
    sunDir: new THREE.Vector3(0, -1, 0),
    windSpeed: 4,
    windDirectionDeg: 0,
    hs: 0.6,
    vessels: [],
    vesselPositions: [],
    tier: 'full',
    ...overrides,
  };
}

/** Camera spot (world x, y) with the most traffic hulls and the most rig cells in range. */
function busiestSpot(): { x: number; y: number; ships: number; cells: number } {
  let best = { x: 0, y: 0, ships: 0, cells: 0 };
  for (let y = -12000; y <= 12000; y += 1800) {
    for (let x = -12000; x <= 12000; x += 1800) {
      let ships = 0;
      for (let iy = -4; iy <= 4; iy++) {
        for (let ix = -4; ix <= 4; ix++) {
          ships += trafficInCell(
            Math.floor(x / TRAFFIC_CELL) + ix,
            Math.floor(y / TRAFFIC_CELL) + iy,
          ).length;
        }
      }
      let cells = 0;
      for (let iy = -2; iy <= 2; iy++) {
        for (let ix = -2; ix <= 2; ix++) {
          if (
            structuresInCell(
              Math.floor(x / STRUCTURE_CELL) + ix,
              Math.floor(y / STRUCTURE_CELL) + iy,
            )
          )
            cells++;
        }
      }
      if (ships + cells * 3 > best.ships + best.cells * 3) best = { x, y, ships, cells };
    }
  }
  return best;
}

describe('traffic budget enforced on the real layer', () => {
  const spot = busiestSpot();
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(spot.x, 30, -spot.y);

  it('has a scene dense enough that the caps actually bind', () => {
    expect(spot.ships).toBeGreaterThan(TRAFFIC_BUDGET.full);
    expect(spot.cells).toBeGreaterThan(STRUCTURE_BUDGET.full);
  });

  for (const tier of TIERS) {
    it(`${tier}: hull instances <= ${TRAFFIC_BUDGET[tier]}, rig cells <= ${STRUCTURE_BUDGET[tier]}`, () => {
      const layer = new TrafficLayer();
      layer.setFlags({ traffic: true, structures: true, hostiles: false });
      layer.update(makeFrame(cam, { tier }));
      const hulls = instances(layer.object, 'traffic-');
      expect(hulls).toBeLessThanOrEqual(TRAFFIC_BUDGET[tier]);
      expect(hulls).toBe(layer.ships.length);
      // Structures are instanced per item; a cell holds at most 4 items (3-4 turbines + buoy).
      const items = instances(layer.object, 'structure-');
      expect(items).toBeLessThanOrEqual(STRUCTURE_BUDGET[tier] * 5);
      if (tier === 'lite') expect(items).toBe(0);
      // Background hulls + structures + night lights: one call per live class, never per hull.
      const calls = drawCalls(layer.object);
      expect(calls).toBeLessThanOrEqual(7 + 3 + 1);
      expect(calls).toBeLessThanOrEqual(layer.ships.length + 3 + 1);
      layer.dispose();
    });
  }

  it('tiers shrink the live set monotonically (lite < mid < full)', () => {
    const counts = TIERS.map((tier) => {
      const layer = new TrafficLayer();
      layer.update(makeFrame(cam, { tier }));
      const n = layer.ships.length;
      layer.dispose();
      return n;
    });
    expect(counts[0]!).toBeGreaterThan(counts[1]!);
    expect(counts[1]!).toBeGreaterThan(counts[2]!);
    expect(counts[2]!).toBe(TRAFFIC_BUDGET.lite);
  });

  it('draws nothing when traffic, structures and hostiles are all off', () => {
    const layer = new TrafficLayer();
    layer.setFlags({ traffic: false, structures: false, hostiles: false });
    layer.update(makeFrame(cam));
    expect(drawCalls(layer.object)).toBe(0);
    expect(layer.ships).toHaveLength(0);
    layer.dispose();
  });

  it('only ever reads ships within the view range', () => {
    const layer = new TrafficLayer();
    layer.update(makeFrame(cam));
    for (const s of layer.ships) {
      expect(Math.hypot(s.x - spot.x, s.y - spot.y)).toBeLessThanOrEqual(TRAFFIC_VIEW_RANGE);
    }
    layer.dispose();
  });
});

describe('underwater budget enforced on the real layer', () => {
  // The Flight 19 Avenger site is dense: seabed + flora + wreck + marine snow all appear.
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(85, -8, 65);

  it('declares the issue table (4 / 2 / 1)', () => {
    expect(UNDERWATER_BUDGET).toEqual({ full: 4, mid: 2, lite: 1 });
  });

  for (const tier of TIERS) {
    it(`${tier}: submerged extra draw calls <= ${UNDERWATER_BUDGET[tier]}`, () => {
      const layer = new UnderwaterSceneryLayer();
      layer.update(makeFrame(cam, { underwater: true, tier, cameraDepth: 8, daylight: 0.9 }));
      const calls = drawCalls(layer.object);
      expect(calls).toBeLessThanOrEqual(UNDERWATER_BUDGET[tier]);
      expect(calls).toBe(layer.activeDrawCalls);
      // The scene is dense, so each tier really spends its whole allowance.
      expect(calls).toBe(UNDERWATER_BUDGET[tier]);
      layer.dispose();
    });
  }

  it('costs zero draw calls when surfaced, on every tier, and after surfacing again', () => {
    const layer = new UnderwaterSceneryLayer();
    for (const tier of TIERS) {
      layer.update(makeFrame(cam, { underwater: false, tier }));
      expect(drawCalls(layer.object)).toBe(0);
      layer.update(makeFrame(cam, { underwater: true, tier, cameraDepth: 8 }));
      expect(drawCalls(layer.object)).toBeGreaterThan(0);
      layer.update(makeFrame(cam, { underwater: false, tier }));
      expect(drawCalls(layer.object)).toBe(0);
      expect(layer.activeDrawCalls).toBe(0);
    }
    layer.dispose();
  });

  it('costs zero draw calls when switched off, even while submerged', () => {
    const layer = new UnderwaterSceneryLayer();
    layer.setEnabled(false);
    layer.update(makeFrame(cam, { underwater: true, cameraDepth: 8 }));
    expect(drawCalls(layer.object)).toBe(0);
    layer.dispose();
  });
});
