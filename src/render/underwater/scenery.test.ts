import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SceneryFrame } from '../scenery/types';
import {
  kelpSwayAngle,
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
    for (let iy = -6; iy <= 6; iy++) {
      for (let ix = -6; ix <= 6; ix++) {
        for (const f of underwaterFeaturesInCell(ix, iy)) {
          if (f.kind === 'wreck-trawler' || f.kind === 'wreck-avenger') wrecks++;
        }
      }
    }
    expect(wrecks).toBeGreaterThan(2);
  });
});

describe('UnderwaterSceneryLayer', () => {
  it('costs 0 draw calls above water and respects tier draw-call caps when submerged', () => {
    const layer = new UnderwaterSceneryLayer();
    layer.update(makeFrame({ underwater: false }));
    expect(layer.activeDrawCalls).toBe(0);

    for (const tier of ['lite', 'mid', 'full'] as const) {
      layer.update(makeFrame({ underwater: true, tier }));
      expect(layer.activeDrawCalls).toBeGreaterThanOrEqual(1);
      expect(layer.activeDrawCalls).toBeLessThanOrEqual(UNDERWATER_BUDGET[tier]);
    }
    layer.dispose();
  });
});
