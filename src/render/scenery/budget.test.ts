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
import { IslandLayer } from './islands';
import { SURF_RING_CAP, SURF_RING_RANGE, SurfRingLayer, type SurfAnchor } from './surfRings';
import {
  evaluateTrafficShip,
  STRUCTURE_BUDGET,
  STRUCTURE_CELL,
  STRUCTURE_VIEW_RANGE,
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

/**
 * Camera spot (world x, y) with the most traffic hulls and buoy cells in view: uncapped counts of
 * ship poses (at the frame's time and weather) and structure cells that pass the same view-range
 * filters the layer applies, so the caps are shown to bind after filtering.
 */
function busiestSpot(): { x: number; y: number; ships: number; cells: number } {
  let best = { x: 0, y: 0, ships: 0, cells: 0 };
  const shipReach = Math.ceil(TRAFFIC_VIEW_RANGE / TRAFFIC_CELL) + 1;
  const cellReach = Math.ceil(STRUCTURE_VIEW_RANGE / STRUCTURE_CELL) + 1;
  for (let y = -12000; y <= 12000; y += 1800) {
    for (let x = -12000; x <= 12000; x += 1800) {
      let ships = 0;
      for (let iy = -shipReach; iy <= shipReach; iy++) {
        for (let ix = -shipReach; ix <= shipReach; ix++) {
          for (const spec of trafficInCell(
            Math.floor(x / TRAFFIC_CELL) + ix,
            Math.floor(y / TRAFFIC_CELL) + iy,
          )) {
            const pose = evaluateTrafficShip(spec, 200, 1, 0.6);
            if (pose && Math.hypot(pose.x - x, pose.y - y) <= TRAFFIC_VIEW_RANGE) ships++;
          }
        }
      }
      let cells = 0;
      for (let iy = -cellReach; iy <= cellReach; iy++) {
        for (let ix = -cellReach; ix <= cellReach; ix++) {
          const cell = structuresInCell(
            Math.floor(x / STRUCTURE_CELL) + ix,
            Math.floor(y / STRUCTURE_CELL) + iy,
          );
          if (cell && Math.hypot(cell.cx - x, cell.cy - y) <= STRUCTURE_VIEW_RANGE) cells++;
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
    it(`${tier}: hull instances <= ${TRAFFIC_BUDGET[tier]}, buoy cells <= ${STRUCTURE_BUDGET[tier]}`, () => {
      const layer = new TrafficLayer();
      layer.setFlags({ traffic: true, structures: true, hostiles: false });
      layer.update(makeFrame(cam, { tier }));
      const hulls = instances(layer.object, 'traffic-');
      expect(hulls).toBeLessThanOrEqual(TRAFFIC_BUDGET[tier]);
      expect(hulls).toBe(layer.ships.length);
      // One navigation buoy per structure cell.
      const items = instances(layer.object, 'structure-');
      expect(items).toBeLessThanOrEqual(STRUCTURE_BUDGET[tier]);
      if (tier === 'lite') expect(items).toBe(0);
      // Background hulls + buoys + night lights: one call per live class, never per hull.
      const calls = drawCalls(layer.object);
      expect(calls).toBeLessThanOrEqual(7 + 1 + 1);
      expect(calls).toBeLessThanOrEqual(layer.ships.length + 1 + 1);
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

  it('builds no oil-rig or wind-turbine meshes', () => {
    const layer = new TrafficLayer();
    layer.setFlags({ traffic: true, structures: true, hostiles: false });
    layer.update(makeFrame(cam));
    const names: string[] = [];
    layer.object.traverse((o) => names.push(o.name));
    expect(names).not.toContain('structure-oil-rig');
    expect(names).not.toContain('structure-wind-turbine');
    expect(names).toContain('structure-buoy');
    layer.dispose();
  });

  it('lists one surf anchor per buoy drawn, and none with structures off', () => {
    const layer = new TrafficLayer();
    layer.setFlags({ traffic: true, structures: true, hostiles: false });
    layer.update(makeFrame(cam));
    const out: SurfAnchor[] = [];
    layer.surfAnchors(out);
    expect(out.length).toBe(instances(layer.object, 'structure-'));
    expect(out.length).toBeGreaterThan(0);
    for (const a of out) expect(a.r).toBeGreaterThan(0);
    layer.setFlags({ traffic: true, structures: false, hostiles: false });
    layer.update(makeFrame(cam));
    out.length = 0;
    layer.surfAnchors(out);
    expect(out).toEqual([]);
    layer.dispose();
  });

  it('foam rings around rocks and buoys add exactly one draw call', () => {
    const traffic = new TrafficLayer();
    traffic.setFlags({ traffic: true, structures: true, hostiles: false });
    const islands = new IslandLayer();
    const rings = new SurfRingLayer([islands, traffic]);
    const f = makeFrame(cam);
    traffic.update(f);
    islands.update(f);
    const before = drawCalls(traffic.object) + drawCalls(islands.object);
    rings.update(f);
    expect(drawCalls(traffic.object) + drawCalls(islands.object)).toBe(before);
    expect(drawCalls(rings.object)).toBe(1);
    const all: SurfAnchor[] = [];
    islands.surfAnchors(all);
    traffic.surfAnchors(all);
    const inRange = all.filter(
      (a) => Math.hypot(a.x - cam.position.x, a.z - cam.position.z) <= SURF_RING_RANGE,
    ).length;
    expect(instances(rings.object, 'surf-')).toBe(Math.min(SURF_RING_CAP, inRange));
    traffic.dispose();
    islands.dispose();
    rings.dispose();
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

  it('declares the tier table (6 / 3 / 1)', () => {
    expect(UNDERWATER_BUDGET).toEqual({ full: 6, mid: 3, lite: 1 });
  });

  for (const tier of TIERS) {
    it(`${tier}: submerged extra draw calls <= ${UNDERWATER_BUDGET[tier]}`, () => {
      const layer = new UnderwaterSceneryLayer();
      layer.update(makeFrame(cam, { underwater: true, tier, cameraDepth: 8, daylight: 0.9 }));
      const calls = drawCalls(layer.object);
      expect(calls).toBeLessThanOrEqual(UNDERWATER_BUDGET[tier]);
      expect(calls).toBe(layer.activeDrawCalls);
      // The scene is dense, so each tier really spends its whole allowance. On the full tier one
      // of the six is the god-ray shafts, drawn by the absorption pass rather than this layer.
      expect(calls).toBe(UNDERWATER_BUDGET[tier] - (tier === 'full' ? 1 : 0));
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
