import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { surfBand, swashSpeed } from './surf';
import {
  SURF_RING_CAP,
  SURF_RING_RANGE,
  SurfRingLayer,
  type SurfAnchor,
  type SurfSource,
} from './surfRings';
import type { SceneryFrame } from './types';

function frame(camera: THREE.PerspectiveCamera, over: Partial<SceneryFrame> = {}): SceneryFrame {
  return {
    t: 10,
    dt: 0.016,
    wallT: 10,
    camera,
    calm: 1,
    daylight: 1,
    timeOfDay: 12,
    sunDir: new THREE.Vector3(0, 1, 0),
    windSpeed: 5,
    windDirectionDeg: 0,
    hs: 1,
    vessels: [],
    vesselPositions: [],
    ...over,
  };
}

const source = (anchors: SurfAnchor[]): SurfSource => ({
  surfAnchors: (out) => {
    out.push(...anchors);
  },
});

function mesh(layer: SurfRingLayer): THREE.InstancedMesh {
  let found: THREE.InstancedMesh | null = null;
  layer.object.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) found = o as THREE.InstancedMesh;
  });
  expect(found).not.toBeNull();
  return found!;
}

function meshes(layer: SurfRingLayer): number {
  let n = 0;
  layer.object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n++;
  });
  return n;
}

const scaleOf = (m: THREE.InstancedMesh, i: number) => {
  const mat = new THREE.Matrix4();
  m.getMatrixAt(i, mat);
  return new THREE.Vector3().setFromMatrixScale(mat).x;
};

describe('SurfRingLayer', () => {
  const cam = new THREE.PerspectiveCamera();

  it('draws the rings of every source in one instanced mesh', () => {
    const layer = new SurfRingLayer([
      source([
        { x: 10, z: 0, r: 2 },
        { x: -20, z: 5, r: 1 },
      ]),
      source([{ x: 0, z: 30, r: 1.2 }]),
    ]);
    layer.update(frame(cam));
    expect(meshes(layer)).toBe(1);
    expect(mesh(layer).count).toBe(3);
    layer.dispose();
  });

  it('draws nothing without anchors, or when switched off', () => {
    const empty = new SurfRingLayer([source([])]);
    empty.update(frame(cam));
    expect(mesh(empty).count).toBe(0);
    const off = new SurfRingLayer([source([{ x: 1, z: 1, r: 1 }])]);
    off.setEnabled(false);
    off.update(frame(cam));
    expect(off.object.visible).toBe(false);
    empty.dispose();
    off.dispose();
  });

  it(`keeps the ${SURF_RING_CAP} nearest anchors within ${SURF_RING_RANGE} m`, () => {
    const many: SurfAnchor[] = [];
    for (let i = 0; i < SURF_RING_CAP + 40; i++) many.push({ x: 5 + i * 3, z: 0, r: 1 });
    many.push({ x: SURF_RING_RANGE + 50, z: 0, r: 1 });
    const layer = new SurfRingLayer([source(many)]);
    layer.update(frame(cam));
    const m = mesh(layer);
    expect(m.count).toBe(SURF_RING_CAP);
    const mat = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let farthest = 0;
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, mat);
      farthest = Math.max(farthest, p.setFromMatrixPosition(mat).x);
    }
    expect(farthest).toBeCloseTo(5 + (SURF_RING_CAP - 1) * 3, 5);
    layer.dispose();
  });

  it('widens the ring with the sea state, by surfBand', () => {
    const layer = new SurfRingLayer([source([{ x: 10, z: 0, r: 2 }])]);
    layer.update(frame(cam, { hs: 0.5 }));
    const calm = scaleOf(mesh(layer), 0);
    layer.update(frame(cam, { hs: 4 }));
    const rough = scaleOf(mesh(layer), 0);
    // The quad reaches past the core by at least the band's width, and grows with the sea.
    expect(calm - 2).toBeGreaterThanOrEqual(surfBand(0.5, 9).width);
    expect(rough - 2).toBeGreaterThanOrEqual(surfBand(4, 9).width);
    expect(rough).toBeGreaterThan(calm);
    const u = (mesh(layer).material as THREE.ShaderMaterial).uniforms;
    expect(u.uSurfWidth!.value).toBeCloseTo(surfBand(4, 9).width, 6);
    expect(u.uSurfStrength!.value).toBeCloseTo(surfBand(4, 9).strength, 6);
    layer.dispose();
  });

  it('runs the swash at the sea’s wave period', () => {
    const layer = new SurfRingLayer([source([{ x: 10, z: 0, r: 2 }])]);
    layer.update(frame(cam, { wavePeriod: 11 }));
    const u = (mesh(layer).material as THREE.ShaderMaterial).uniforms;
    expect(u.uSwash!.value).toBeCloseTo(swashSpeed(11), 6);
    layer.update(frame(cam));
    expect(u.uSwash!.value).toBeCloseTo(swashSpeed(Number.NaN), 6);
    layer.dispose();
  });
});
