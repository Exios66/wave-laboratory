import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SceneryFrame } from '../scenery/types';
import {
  kelpSwayAngle,
  reefsNear,
  seabedDepthAt,
  SUNKEN_AVENGER_SITE,
  UNDERWATER_BUDGET,
  underwaterAtmosphere,
  underwaterFeaturesInCell,
  underwaterFeaturesNear,
  UnderwaterSceneryLayer,
} from './scenery';

function makeFrame(overrides: Partial<SceneryFrame> = {}): SceneryFrame {
  return {
    t: 25,
    dt: 0.016,
    wallT: 25,
    camera: new THREE.PerspectiveCamera(),
    calm: 1,
    daylight: 0.9,
    timeOfDay: 11,
    sunDir: new THREE.Vector3(0, 1, 0),
    windSpeed: 5,
    windDirectionDeg: 0,
    hs: 1.2,
    vessels: [],
    vesselPositions: [],
    underwater: true,
    cameraDepth: 6,
    waterDepth: 20,
    waterType: 'oceanic-i',
    tier: 'full',
    ...overrides,
  };
}

describe('underwater scenery placement & atmosphere', () => {
  it('places deterministic kelp, coral and the sunken TBM Avenger easter egg', () => {
    const a = underwaterFeaturesNear(0, 0, 300);
    const b = underwaterFeaturesNear(0, 0, 300);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    const avenger = a.find((f) => f.id === 'wreck:avenger:flight19');
    expect(avenger).toBeDefined();
    expect(avenger?.x).toBe(SUNKEN_AVENGER_SITE.x);
    expect(avenger?.y).toBe(SUNKEN_AVENGER_SITE.y);
  });

  it('guarantees authored features within a short swim anywhere in the grid', () => {
    for (const [x, y] of [
      [0, 0],
      [800, -600],
      [-1500, 1200],
    ] as const) {
      const near = underwaterFeaturesNear(x, y, 220);
      expect(near.length).toBeGreaterThan(0);
    }
    expect(seabedDepthAt(100, -50)).toBeGreaterThanOrEqual(8);
    expect(Math.abs(kelpSwayAngle(3.2, 2.0, 7))).toBeGreaterThan(0);
  });

  it('computes stronger caustics by day in clear water and stronger bioluminescence at night', () => {
    const dayClear = underwaterAtmosphere('oceanic-i', 1, 4);
    const nightTurbid = underwaterAtmosphere('coastal-9', 0, 4);
    expect(dayClear.causticStrength).toBeGreaterThan(nightTurbid.causticStrength);
    expect(nightTurbid.bioStrength).toBeGreaterThan(dayClear.bioStrength);
  });

  it('includes sunken trawlers and avengers across cells', () => {
    let wrecks = 0;
    for (let iy = -20; iy <= 20; iy++) {
      for (let ix = -20; ix <= 20; ix++) {
        for (const f of underwaterFeaturesInCell(ix, iy)) {
          if (f.kind === 'wreck-trawler' || f.kind === 'wreck-avenger') wrecks++;
        }
      }
    }
    expect(wrecks).toBeGreaterThan(2);
  });
});

describe('flora density and depth', () => {
  it('puts seagrass in every cell on a shelf (no empty cells)', () => {
    for (let iy = -8; iy <= 8; iy++) {
      for (let ix = -8; ix <= 8; ix++) {
        const kinds = new Set(underwaterFeaturesInCell(ix, iy, 20).map((f) => f.kind));
        expect(kinds.has('grass')).toBe(true);
      }
    }
  });

  it('stands every feature on the floor that follows env.depth, and none in blue water', () => {
    for (const envDepth of [8, 20, 45]) {
      for (const f of underwaterFeaturesNear(0, 0, 300, envDepth)) {
        expect(f.depth).toBeCloseTo(seabedDepthAt(f.x, f.y, envDepth), 9);
        expect(Math.abs(f.depth - envDepth)).toBeLessThanOrEqual(5.001);
      }
    }
    expect(underwaterFeaturesNear(0, 0, 400, 4000)).toEqual([]);
  });
});

describe('UnderwaterSceneryLayer', () => {
  it('costs 0 draw calls above water and respects tier draw-call caps when submerged', () => {
    const layer = new UnderwaterSceneryLayer();
    layer.update(makeFrame({ underwater: false }));
    expect(layer.activeDrawCalls).toBe(0);

    for (const waterDepth of [20, 4000]) {
      for (const tier of ['lite', 'mid', 'full'] as const) {
        layer.update(makeFrame({ underwater: true, tier, waterDepth }));
        expect(layer.activeDrawCalls).toBeGreaterThanOrEqual(1);
        expect(layer.activeDrawCalls).toBeLessThanOrEqual(UNDERWATER_BUDGET[tier]);
      }
    }
    // Back at the surface: nothing drawn again.
    layer.update(makeFrame({ underwater: false }));
    expect(layer.activeDrawCalls).toBe(0);
    layer.dispose();
  });

  it('draws the full shelf set on full, and only particulate in blue water on lite', () => {
    const layer = new UnderwaterSceneryLayer();
    layer.update(makeFrame({ tier: 'full', waterDepth: 20 }));
    expect(layer.activeDrawCalls).toBeGreaterThanOrEqual(4);
    layer.update(makeFrame({ tier: 'lite', waterDepth: 4000 }));
    expect(layer.activeDrawCalls).toBe(1);
    layer.dispose();
  });
});

describe('island reef shelves in deep water', () => {
  it('puts flora, rocks and coral on the shelf around an island and nothing in open sea', () => {
    const reefs = reefsNear(500, 800);
    expect(reefs.length).toBeGreaterThan(0);
    const here = underwaterFeaturesNear(reefs[0]!.x, reefs[0]!.y, 200, 4000, reefs);
    expect(here.length).toBeGreaterThan(5);
    expect(here.some((f) => f.kind === 'coral' || f.kind === 'rock')).toBe(true);
    for (const f of here) expect(f.depth).toBeLessThanOrEqual(60);
    // Far from every island the deep sea stays blue water.
    expect(underwaterFeaturesNear(0, 0, 130, 4000, reefsNear(0, 0))).toEqual([]);
    // Islands off: no reefs, so no features even beside an island.
    expect(underwaterFeaturesNear(reefs[0]!.x, reefs[0]!.y, 200, 4000, [])).toEqual([]);
  });

  it('draws the floor layers near a reef when islands are on, and only particulate otherwise', () => {
    const reefs = reefsNear(500, 800);
    const r = reefs[0]!;
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(r.x + r.radius * 1.8 + 40, -3, -r.y);
    const layer = new UnderwaterSceneryLayer();
    layer.update(makeFrame({ camera: cam, waterDepth: 4000, islands: true, tier: 'full' }));
    expect(layer.activeDrawCalls).toBeGreaterThanOrEqual(4);
    expect(layer.activeDrawCalls).toBeLessThanOrEqual(UNDERWATER_BUDGET.full);
    layer.update(makeFrame({ camera: cam, waterDepth: 4000, islands: false, tier: 'full' }));
    expect(layer.activeDrawCalls).toBe(1);
    layer.dispose();
  });
});
