import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SceneryFrame } from '../scenery/types';
import { MarineLifeLayer } from './marineLife';
import {
  fishPose,
  makeFishPose,
  marineInstanceCap,
  MARINE_BUDGET,
  MARINE_RANGE,
  planMarineLife,
} from './marineLifeModel';
import { seabedDepthAt, underwaterFeaturesNear } from './scenery';

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

  it('renders a reef school at an in-range site outside the adjacent cells', () => {
    const current = frame();
    current.camera.position.set(-4, -8, 320); // World (-4, -320).
    const sites = underwaterFeaturesNear(-4, -320, MARINE_RANGE).map(({ id, x, y, seed }) => ({
      id,
      x,
      y,
      seed,
    }));
    const schools = planMarineLife(-4, -320, 'full', sites).schools.filter(
      (school) => school.species === 'reef',
    );
    // The camera is in cell (-1, -2); this coral is in cell (1, -2).
    const edge = schools.find((school) => school.id === 'reef:coral:1:-2');
    expect(edge).toBeDefined();
    const slot = schools
      .slice(0, schools.indexOf(edge!))
      .reduce((sum, school) => sum + school.count, 0);
    const expected = makeFishPose();
    fishPose(edge!, 0, current.t, seabedDepthAt, current.hs, expected);

    const layer = new MarineLifeLayer();
    layer.update(current);
    const mesh = layer.object.getObjectByName('marine-reef') as THREE.InstancedMesh;
    expect(mesh.count).toBeGreaterThan(slot);
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(slot, matrix);
    expect(matrix.elements[12]).toBeCloseTo(expected.x, 3);
    expect(matrix.elements[13]).toBeCloseTo(-expected.depth, 3);
    expect(matrix.elements[14]).toBeCloseTo(-expected.y, 3);
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
