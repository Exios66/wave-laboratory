import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { curtainCount, curtainPlacement } from './rainCurtains';
import { RainCurtainLayer } from './rainCurtainLayer';

function meshOf(layer: RainCurtainLayer): THREE.InstancedMesh {
  const found: THREE.InstancedMesh[] = [];
  layer.object.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) found.push(o as THREE.InstancedMesh);
  });
  expect(found).toHaveLength(1);
  return found[0]!;
}

const camera = new THREE.PerspectiveCamera();
camera.position.set(300, 20, -400);

describe('RainCurtainLayer', () => {
  it('hangs curtainCount curtains in one instanced mesh', () => {
    const layer = new RainCurtainLayer();
    for (const rain of [0, 1, 6, 30, 120]) {
      layer.update({ rainMmH: rain, tier: 'full', windFromRad: 0.4, camera, light: 0.5 });
      const mesh = meshOf(layer);
      expect(mesh.count).toBe(curtainCount(rain, 'full'));
      expect(mesh.visible).toBe(mesh.count > 0);
    }
    layer.update({ rainMmH: 120, tier: 'lite', windFromRad: 0.4, camera, light: 0.5 });
    expect(meshOf(layer).count).toBe(0);
    layer.dispose();
  });

  it('stands each curtain at its placement around the camera, upright and facing it', () => {
    const layer = new RainCurtainLayer();
    layer.update({ rainMmH: 30, tier: 'full', windFromRad: 1.1, camera, light: 1 });
    const mesh = meshOf(layer);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, sc);
      const place = curtainPlacement(layer.seed, i, 1.1);
      // Compass bearing: north is −z, east is +x.
      const dx = p.x - camera.position.x;
      const dz = p.z - camera.position.z;
      expect(Math.hypot(dx, dz)).toBeCloseTo(place.distanceM, 3);
      expect(Math.atan2(dx, -dz)).toBeCloseTo(
        Math.atan2(Math.sin(place.bearing), Math.cos(place.bearing)),
        5,
      );
      expect(sc.x).toBeCloseTo(place.widthM, 3);
      // Its face (local +z) points back toward the camera, level with the sea.
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      expect(n.y).toBeCloseTo(0, 6);
      expect(n.x * -dx + n.z * -dz).toBeGreaterThan(0);
    }
    layer.dispose();
  });
});
