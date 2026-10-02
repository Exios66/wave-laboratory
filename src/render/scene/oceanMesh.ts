/**
 * Camera-centred radial ocean mesh.
 *
 * Rings are uniformly spaced out to the radius where the ring circumference spacing equals the
 * radial spacing, then grow geometrically (spacing ∝ radius), so every triangle subtends a
 * similar angle from a camera above the centre. The renderer scales the whole mesh with the
 * camera height every frame and the vertex shader low-passes the wave textures to each
 * vertex's spacing (attribute `aCell`, in mesh units), so the geometry never aliases.
 * Mesh units: 1 = the spacing of the innermost rings.
 */
import * as THREE from 'three';
import type { OceanQuality } from '../../schema/experiment';

/** Angular slices (vertex count per ring) per quality level. */
export const OCEAN_SLICES: Record<OceanQuality, number> = {
  low: 96,
  medium: 176,
  high: 256,
  ultra: 384,
};

/** Inner spacing as a fraction of the camera height, per quality level. */
export const OCEAN_DENSITY: Record<OceanQuality, number> = {
  low: 0.012,
  medium: 0.0075,
  high: 0.005,
  ultra: 0.0032,
};

/** Outer radius in mesh units: far enough that the smallest scale still reaches the haze. */
const MAX_RADIUS = 200_000;

export function createRadialOceanGeometry(slices: number): THREE.BufferGeometry {
  const step = (2 * Math.PI) / slices;
  const radii: number[] = [];
  const inner = Math.max(4, Math.round(1 / step));
  for (let i = 1; i <= inner; i++) radii.push(i);
  let r = inner;
  while (r < MAX_RADIUS) {
    r *= 1 + step;
    radii.push(r);
  }
  const rings = radii.length;
  const count = 1 + rings * slices;
  const pos = new Float32Array(count * 3);
  const cell = new Float32Array(count);
  cell[0] = 1;
  for (let k = 0; k < rings; k++) {
    const rk = radii[k]!;
    const radial = k === 0 ? rk : rk - radii[k - 1]!;
    const spacing = Math.max(radial, rk * step, 1);
    for (let j = 0; j < slices; j++) {
      const a = j * step;
      const v = 1 + k * slices + j;
      pos[3 * v] = rk * Math.cos(a);
      pos[3 * v + 1] = 0;
      pos[3 * v + 2] = rk * Math.sin(a);
      cell[v] = spacing;
    }
  }
  const index: number[] = [];
  // Fan around the centre, then quads between rings (counter-clockwise seen from above).
  for (let j = 0; j < slices; j++) {
    const a = 1 + j;
    const b = 1 + ((j + 1) % slices);
    index.push(0, b, a);
  }
  for (let k = 0; k + 1 < rings; k++) {
    for (let j = 0; j < slices; j++) {
      const j1 = (j + 1) % slices;
      const a = 1 + k * slices + j;
      const b = 1 + k * slices + j1;
      const c = 1 + (k + 1) * slices + j;
      const d = 1 + (k + 1) * slices + j1;
      index.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 1));
  geo.setIndex(index);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MAX_RADIUS);
  return geo;
}
