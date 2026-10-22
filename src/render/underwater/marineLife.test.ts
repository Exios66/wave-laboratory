import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SceneryFrame } from '../scenery/types';
import { MarineLifeLayer } from './marineLife';
import { marineInstanceCap, MARINE_BUDGET } from './marineLifeModel';

function frame(over: Partial<SceneryFrame> = {}): SceneryFrame {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(40, -8, -30);
  return {
    t: 25,
    dt: 0.016,
    wallT: 25,
    camera,
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
    cameraDepth: 8,
    tier: 'full',
    ...over,
  };
}

describe('MarineLifeLayer', () => {
  it('draws nothing when surfaced or disabled', () => {
    const layer = new MarineLifeLayer();
    layer.update(frame({ underwater: false }));
    expect(layer.object.visible).toBe(false);
    expect(layer.activeDrawCalls).toBe(0);
    layer.update(frame());
    expect(layer.object.visible).toBe(true);
    layer.setEnabled(false);
    layer.update(frame());
    expect(layer.object.visible).toBe(false);
    layer.dispose();
  });

  it('respects draw-call and instance budgets per tier, with finite matrices', () => {
    for (const tier of ['full', 'mid', 'lite'] as const) {
      const layer = new MarineLifeLayer();
      layer.update(frame({ tier, t: 1e6, wallT: 1e6 }));
      expect(layer.activeDrawCalls).toBeLessThanOrEqual(MARINE_BUDGET[tier].drawCalls);
      expect(layer.activeInstances).toBeLessThanOrEqual(marineInstanceCap(tier));
      if (tier === 'lite') expect(layer.activeInstances).toBeLessThanOrEqual(8);
      for (const child of layer.object.children) {
        const mesh = child as THREE.InstancedMesh;
        for (let i = 0; i < mesh.count * 16; i++) {
          expect(Number.isFinite(mesh.instanceMatrix.array[i])).toBe(true);
        }
      }
      layer.dispose();
    }
  });
});
