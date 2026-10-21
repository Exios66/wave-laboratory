/**
 * Procedural geometry of the diesel-electric submarine: a closed body of revolution (pressure
 * hull) merged with a tapered sail (fin) that pierces the surface at periscope depth.
 *
 * Both parts are closed, outward-oriented triangle meshes in the keel frame (x forward, y to
 * port, z up from the keel baseline). The sail's foot is buried inside the hull, so the merged
 * mesh stays watertight part by part; the few cubic metres of overlap are counted twice by the
 * volume integrals, but mass is derived from the very same mesh (see `definition.ts`), so the
 * boat is still exactly neutrally buoyant at its design depth.
 *
 * Dimensions (scale 1): 70 m overall, 6.6 m hull diameter, keel 15 m below the surface, sail top
 * 1.5 m above it.
 */
import type { TriangleMesh } from './api';
import { flipOrientation, meshVolume } from './mesh';

export const SUB_LENGTH = 70;
export const SUB_RADIUS = 3.3;
/** Design waterline above the keel [m]: keel depth at periscope depth. */
export const SUB_DRAFT = 15;
/** Hull axis height above the keel [m]. */
export const SUB_AXIS_Z = SUB_RADIUS;
export const SUB_X_AFT = -35;
export const SUB_X_FWD = 35;
/** Sail: footprint on the hull and top above the keel. */
export const SAIL_TOP_Z = SUB_DRAFT + 1.5;
export const SAIL_X0 = 7;
export const SAIL_X1 = 18;

const BOW_START = 24;
const TAIL_START = -16;

/** Hull radius at x [m]: ellipsoidal bow, parallel middle body and a long tapered stern. */
export function hullRadius(x: number): number {
  if (x > BOW_START) {
    const s = (x - BOW_START) / (SUB_X_FWD - BOW_START);
    return SUB_RADIUS * Math.sqrt(Math.max(0, 1 - s * s));
  }
  if (x < TAIL_START) {
    const s = (TAIL_START - x) / (TAIL_START - SUB_X_AFT);
    return SUB_RADIUS * Math.pow(Math.max(0, 1 - s * s), 0.75);
  }
  return SUB_RADIUS;
}

/**
 * Closed body of revolution about the axis z = SUB_AXIS_Z with `segments` facets and
 * `stations` rings between two pole vertices. Rings cluster towards both ends.
 */
export function revolveHull(stations: number, segments: number): TriangleMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const span = SUB_X_FWD - SUB_X_AFT;
  const rings: number[][] = [];
  const aft = pos.length / 3;
  pos.push(SUB_X_AFT, 0, SUB_AXIS_Z);
  for (let i = 1; i <= stations; i++) {
    const s = i / (stations + 1);
    const u = 0.5 * (1 - Math.cos(Math.PI * s)) * 0.6 + s * 0.4;
    const x = SUB_X_AFT + u * span;
    const r = hullRadius(x);
    const ring: number[] = [];
    for (let k = 0; k < segments; k++) {
      const a = (2 * Math.PI * k) / segments;
      ring.push(pos.length / 3);
      pos.push(x, r * Math.cos(a), SUB_AXIS_Z + r * Math.sin(a));
    }
    rings.push(ring);
  }
  const fwd = pos.length / 3;
  pos.push(SUB_X_FWD, 0, SUB_AXIS_Z);
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i]!;
    const b = rings[i + 1]!;
    for (let k = 0; k < segments; k++) {
      const k1 = (k + 1) % segments;
      idx.push(a[k]!, a[k1]!, b[k1]!, a[k]!, b[k1]!, b[k]!);
    }
  }
  const first = rings[0]!;
  const last = rings[rings.length - 1]!;
  for (let k = 0; k < segments; k++) {
    const k1 = (k + 1) % segments;
    idx.push(aft, first[k1]!, first[k]!);
    idx.push(fwd, last[k]!, last[k1]!);
  }
  return orient({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
}

/** Tapered, raked sail: a closed eight-vertex prism with its foot inside the hull. */
export function sailMesh(): TriangleMesh {
  const zFoot = SUB_AXIS_Z + 1.6;
  const zTop = SAIL_TOP_Z;
  const foot = { x0: SAIL_X0, x1: SAIL_X1, t: 1.2 };
  const top = { x0: SAIL_X0 + 3.4, x1: SAIL_X1 - 3.4, t: 0.6 };
  const p: number[] = [];
  for (const [z, f] of [
    [zFoot, foot],
    [zTop, top],
  ] as const) {
    p.push(f.x0, f.t / 2, z, f.x1, f.t / 2, z, f.x1, -f.t / 2, z, f.x0, -f.t / 2, z);
  }
  // Bottom ring 0..3, top ring 4..7 (same winding in plan).
  const idx = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0,
    4, 3, 4, 7,
  ];
  return orient({ positions: new Float32Array(p), indices: new Uint32Array(idx) });
}

function orient(mesh: TriangleMesh): TriangleMesh {
  if (meshVolume(mesh).volume < 0) flipOrientation(mesh);
  return mesh;
}

/** Concatenate closed meshes (vertex indices are offset; no vertices are shared). */
export function mergeMeshes(...meshes: TriangleMesh[]): TriangleMesh {
  let nv = 0;
  let ni = 0;
  for (const m of meshes) {
    nv += m.positions.length;
    ni += m.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i]! + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

/** Hull plus sail in the keel frame; `fine` selects the display resolution. */
export function submarineMesh(fine: boolean): TriangleMesh {
  return mergeMeshes(fine ? revolveHull(110, 32) : revolveHull(38, 16), sailMesh());
}
