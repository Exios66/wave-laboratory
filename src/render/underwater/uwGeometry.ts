/**
 * Geometry builders for the underwater scenery: the world-snapped seabed grid, the kelp / seagrass
 * blade bundle, the coral / rock head and the wreck silhouette. Vertex colours carry the shading
 * gradients; hue comes from per-instance colours.
 */
import * as THREE from 'three';

/** Height of one kelp blade bundle in its own units [m]; the sway shader bends by `y / UW_BLADE_H`. */
export const UW_BLADE_H = 6.5;

/** Seabed grid: `SEABED_CELLS`² cells of `SEABED_STEP` metres, centred on the (snapped) camera. */
export const SEABED_CELLS = 80;
export const SEABED_STEP = 5;

export function buildSeabedGeometry(): THREE.BufferGeometry {
  const n = SEABED_CELLS;
  const verts = (n + 1) * (n + 1);
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const half = (n * SEABED_STEP) / 2;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = (j * (n + 1) + i) * 3;
      pos[k] = i * SEABED_STEP - half;
      pos[k + 1] = -20;
      pos[k + 2] = j * SEABED_STEP - half;
      col[k] = 0.6;
      col[k + 1] = 0.55;
      col[k + 2] = 0.42;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      // Alternate the diagonal so the relief does not show a directional grain.
      if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Three crossed tapering ribbons with a slight curl: one kelp frond bundle. Scaled short and wide it
 * reads as a seagrass tuft. Colour darkens toward the base so instance hue gets depth.
 */
export function buildPlantGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const segs = 6;
  const ribbons = 3;
  for (let r = 0; r < ribbons; r++) {
    const a = (r / ribbons) * Math.PI;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const w0 = 0.3 * (1 - t0 * 0.7);
      const w1 = 0.3 * (1 - t1 * 0.7);
      // Curl: the ribbon leans over progressively, with a per-ribbon phase.
      const lean = 0.35 + r * 0.12;
      const o0 = lean * t0 * t0 * 1.6;
      const o1 = lean * t1 * t1 * 1.6;
      const y0 = t0 * UW_BLADE_H;
      const y1 = t1 * UW_BLADE_H;
      // Offset each ribbon off the root a little so the bundle spreads.
      const bx = (r - 1) * 0.18;
      const verts = [
        [-w0, y0, o0],
        [w0, y0, o0],
        [w1, y1, o1],
        [-w0, y0, o0],
        [w1, y1, o1],
        [-w1, y1, o1],
      ] as const;
      for (const [x, y, z] of verts) {
        pos.push(x * ca + z * sa + bx, y, -x * sa + z * ca);
      }
      const g0 = 0.45 + 0.55 * t0;
      const g1 = 0.45 + 0.55 * t1;
      col.push(g0, g0, g0, g0, g0, g0, g1, g1, g1, g0, g0, g0, g1, g1, g1, g1, g1, g1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * A lumpy hard head: a displaced icosphere standing on the floor. Per-instance scale turns it into
 * a flat boulder or a tall coral column; per-instance colour into rock grey or reef hues.
 */
export function buildHardGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 2).toNonIndexed();
  const pos = ico.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const lump = 0.78 + 0.42 * hash3(Math.round(v.x * 3), Math.round(v.y * 3), Math.round(v.z * 3));
    const ridge = 1 + 0.18 * Math.sin(v.x * 7 + v.z * 5) * Math.sin(v.y * 6);
    v.multiplyScalar(lump * ridge);
    // Flatten the underside into the floor; the dome rises.
    v.y = Math.max(v.y, -0.25) + 0.25;
    pos.setXYZ(i, v.x, v.y, v.z);
    const shade = 0.55 + 0.45 * Math.min(1, v.y / 1.1);
    col[i * 3] = shade;
    col[i * 3 + 1] = shade;
    col[i * 3 + 2] = shade;
  }
  ico.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ico.deleteAttribute('uv');
  ico.computeVertexNormals();
  return ico;
}

export function buildWreckGeometry(): THREE.BufferGeometry {
  // Sunken TBM Avenger / wreck silhouette: fuselage, wings, tail fin and broken ribs.
  const parts: [number, number, number, number, number, number, number][] = [
    [0, 0.8, 0, 11.5, 1.4, 1.6, 0x3b4d54], // fuselage
    [0.8, 0.6, 0, 2.7, 0.35, 16.5, 0x33444c], // Avenger wingspan 16.5 m
    [-5.4, 1.8, 0, 1.8, 2.2, 0.3, 0x475569], // tail fin
    [1.1, 1.5, 0, 3.8, 0.8, 1.1, 0x52646e], // greenhouse canopy frame
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  for (const [cx, cy, cz, sx, sy, sz, hex] of parts) {
    c.setHex(hex);
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const v = [
      [cx - hx, cy - hy, cz - hz],
      [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy + hy, cz - hz],
      [cx - hx, cy + hy, cz - hz],
      [cx - hx, cy - hy, cz + hz],
      [cx + hx, cy - hy, cz + hz],
      [cx + hx, cy + hy, cz + hz],
      [cx - hx, cy + hy, cz + hz],
    ] as const;
    for (const f of [
      [0, 1, 2, 0, 2, 3],
      [5, 4, 7, 5, 7, 6],
      [4, 0, 3, 4, 3, 7],
      [1, 5, 6, 1, 6, 2],
      [3, 2, 6, 3, 6, 7],
    ] as const) {
      for (const i of f) {
        pos.push(v[i]![0], v[i]![1], v[i]![2]);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}
