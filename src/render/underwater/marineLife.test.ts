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
import { reefsNear, seabedDepthAt, underwaterFeaturesNear } from './scenery';
import { floorDepthAt, HOME_REEF } from './seafloor';

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
    current.camera.position.set(-4, -8, 150); // World (-4, -150), on the home reef.
    // Default 4000 m sea: the floor here is the home reef, as the underwater scenery draws it.
    const reefs = reefsNear(-4, -150, { islands: false });
    const seabed = (x: number, y: number) => seabedDepthAt(x, y, 4000, reefs);
    const sites = underwaterFeaturesNear(-4, -150, MARINE_RANGE, 4000, reefs)
      .filter((f) => f.kind !== 'grass' && f.kind !== 'rock')
      .map(({ id, x, y, seed }) => ({ id, x, y, seed }));
    const schools = planMarineLife(-4, -150, 'full', sites).schools.filter(
      (school) => school.species === 'reef',
    );
    // A school around a site beyond the cells next to the camera (cells are 48 m).
    const edge = schools.find((school) => Math.hypot(school.hx + 4, school.hy + 150) > 60);
    expect(edge).toBeDefined();
    const slot = schools
      .slice(0, schools.indexOf(edge!))
      .reduce((sum, school) => sum + school.count, 0);
    const expected = makeFishPose();
    fishPose(edge!, 0, current.t, seabed, current.hs, expected);

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

  it('follows the scenery reefs in a 4000 m sea: fish over the home reef, none in blue water', () => {
    const reefCount = (layer: MarineLifeLayer) =>
      (layer.object.getObjectByName('marine-reef') as THREE.InstancedMesh).count;
    const home = new MarineLifeLayer();
    const over = frame({ waterDepth: 4000, islands: false });
    over.camera.position.set(HOME_REEF.x, -8, -HOME_REEF.y);
    home.update(over);
    expect(reefCount(home)).toBeGreaterThan(0);
    // Every fish stays above the reef floor the scenery draws.
    const mesh = home.object.getObjectByName('marine-reef') as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      const floor = floorDepthAt(m.elements[12], -m.elements[14], 4000, [HOME_REEF]);
      if (floor !== null) expect(-m.elements[13]).toBeLessThan(floor);
    }
    home.dispose();

    const blue = new MarineLifeLayer();
    const away = frame({ waterDepth: 4000, islands: false });
    away.camera.position.set(HOME_REEF.x + 5_000, -8, -HOME_REEF.y - 5_000);
    blue.update(away);
    expect(reefCount(blue)).toBe(0);
    // A shallower sea gives the same spot a floor, and the layer replans for it.
    blue.update({ ...away, waterDepth: 30 });
    expect(reefCount(blue)).toBeGreaterThan(0);
    blue.dispose();
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
