/**
 * Rubber duck stand-in for a ship's hull (an easter egg). Only the picture changes: the physics
 * still floats the real hull, so a "duck" the size of a container ship rolls like a container ship.
 *
 * Built in the vessel group's Three.js frame: +x forward, +y up, waterline at `waterlineY`.
 */
import * as THREE from 'three';

export function buildDuck(
  length: number,
  waterlineY: number,
  id: string,
): { group: THREE.Group; materials: THREE.MeshStandardMaterial[] } {
  const L = length;
  const yellow = new THREE.MeshPhysicalMaterial({
    color: 0xfff04a,
    roughness: 0.35,
    metalness: 0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.15,
  });
  const orange = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.4 });
  const black = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.2 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const group = new THREE.Group();
  group.name = 'duck';
  group.visible = false;

  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, waterlineY + y, z);
    mesh.userData.pickKind = 'vessel';
    mesh.userData.pickId = id;
    group.add(mesh);
    return mesh;
  };

  const body = part(new THREE.SphereGeometry(1, 32, 20), yellow, -0.04 * L, 0.02 * L);
  body.scale.set(0.5 * L, 0.2 * L, 0.33 * L);
  // ConeGeometry points along +y; tip it back and up into a perky tail.
  const tail = part(new THREE.ConeGeometry(0.08 * L, 0.16 * L, 20), yellow, -0.48 * L, 0.13 * L);
  tail.rotation.z = Math.PI / 2 - 0.7;
  part(new THREE.SphereGeometry(0.18 * L, 28, 20), yellow, 0.27 * L, 0.32 * L);
  const beak = part(new THREE.SphereGeometry(1, 20, 12), orange, 0.45 * L, 0.29 * L);
  beak.scale.set(0.1 * L, 0.035 * L, 0.09 * L);
  for (const side of [-1, 1]) {
    part(new THREE.SphereGeometry(0.038 * L, 16, 12), white, 0.38 * L, 0.38 * L, side * 0.1 * L);
    part(new THREE.SphereGeometry(0.022 * L, 12, 10), black, 0.405 * L, 0.39 * L, side * 0.11 * L);
  }
  return { group, materials: [yellow, orange, black, white] };
}
