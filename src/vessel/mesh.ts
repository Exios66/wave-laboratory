/**
 * Triangle-mesh utilities for hulls: a parametric lofting generator that is watertight by
 * construction, a topological watertightness check and divergence-theorem mass properties.
 *
 * Lofting frame ("keel frame"): x forward, y to port, z up, z = 0 on the keel baseline.
 */
import type { Vec3 } from '../core/vec';
import type { TriangleMesh } from './api';

/**
 * Parametric description of a monohull. The hull surface is generated on a (u, z) grid:
 * u ∈ [0, 1] runs from the aft end to the stem at every height, so
 *     x(u, z) = xAft(z) + u · (xFwd(z) − xAft(z)),   y = ± halfBreadth(u, z).
 *
 * Requirements (checked by the tests through watertightness and volume):
 *  - `xAft` must be affine in z (the transom is a plane), unless halfBreadth(0, z) ≡ 0;
 *  - `halfBreadth(1, z)` must be 0 (the stem lies in the centre plane), unless `xFwd` is
 *    constant (a flat bow, e.g. a box barge);
 *  - halfBreadth ≥ 0 and xFwd(z) > xAft(z).
 */
export interface HullShape {
  xAft(z: number): number;
  xFwd(z: number): number;
  /** Deck (gunwale) height above the keel at longitudinal parameter u [m]. */
  deckHeight(u: number): number;
  /** Half-breadth [m] at longitudinal parameter u and height z above the keel. */
  halfBreadth(u: number, z: number): number;
  /** The bottom has finite width at z = 0 (adds bottom vertices to every ring). */
  flatBottom: boolean;
  /** Design draft [m]: a row of vertices is placed exactly on this waterline. */
  draft: number;
}

export interface LoftOptions {
  /** Number of rings (stations) along the hull. */
  stations: number;
  /** Vertical intervals below and above the design waterline. */
  levelsBelow: number;
  levelsAbove: number;
}

export interface LoftedHull {
  mesh: TriangleMesh;
  /** Vertex indices on the deck edge (sheer line), both sides. */
  deckEdge: Uint32Array;
}

/**
 * Loft a closed hull from a {@link HullShape}. Each ring is the closed loop
 *   keel centre → (bottom edge) → port side up → deck centre → starboard side down,
 * consecutive rings are joined by quads and both end rings are closed by triangle fans from
 * their centroid. Because every ring has the same vertex count the surface is closed
 * (2-manifold) by construction; planar end rings make the fans exact for any integrand.
 * Degenerate (zero-area) triangles can occur where the hull has zero width; they are kept so
 * the topology stays closed and contribute nothing to any integral.
 */
export function loftHull(shape: HullShape, opts: LoftOptions): LoftedHull {
  const { stations, levelsBelow, levelsAbove } = opts;
  const T = shape.draft;
  const pos: number[] = [];
  const idx: number[] = [];
  const deckEdge: number[] = [];
  const rings: number[][] = [];

  const push = (x: number, y: number, z: number): number => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  const xAt = (u: number, z: number): number => {
    const a = shape.xAft(z);
    return a + u * (shape.xFwd(z) - a);
  };

  for (let i = 0; i < stations; i++) {
    const s = i / (stations - 1);
    // Blend of uniform and cosine spacing: finer rings at both ends where curvature is high.
    const u = 0.55 * s + 0.45 * 0.5 * (1 - Math.cos(Math.PI * s));
    const deck = shape.deckHeight(u);
    // Heights: cosine-clustered towards the bilge below the waterline, uniform above.
    const zs: number[] = [];
    for (let j = 1; j <= levelsBelow; j++) {
      zs.push(T * (1 - Math.cos((Math.PI / 2) * (j / levelsBelow))));
    }
    for (let j = 1; j <= levelsAbove; j++) zs.push(T + ((deck - T) * j) / levelsAbove);
    const port: number[] = [];
    const stbd: number[] = [];
    if (shape.flatBottom) {
      const hb = shape.halfBreadth(u, 0);
      const x = xAt(u, 0);
      port.push(push(x, hb, 0));
      stbd.push(push(x, -hb, 0));
    }
    for (const z of zs) {
      const hb = Math.max(0, shape.halfBreadth(u, z));
      const x = xAt(u, z);
      port.push(push(x, hb, z));
      stbd.push(push(x, -hb, z));
    }
    deckEdge.push(port[port.length - 1]!, stbd[stbd.length - 1]!);
    const keel = push(xAt(u, 0), 0, 0);
    const deckC = push(xAt(u, deck), 0, deck);
    rings.push([keel, ...port, deckC, ...stbd.reverse()]);
  }

  const R = rings[0]!.length;
  // Ring layout: [keel, port…, deck centre, starboard…]; quads k ≤ portEnd lie on the port
  // side. Starboard quads use the mirrored diagonal so the triangulated surface is exactly
  // symmetric about the centre plane (otherwise curved quads make port and starboard differ
  // slightly and the hull would float with a tiny list).
  const portEnd = (R - 2) / 2;
  for (let i = 0; i + 1 < stations; i++) {
    const a = rings[i]!;
    const b = rings[i + 1]!;
    for (let k = 0; k < R; k++) {
      const k1 = (k + 1) % R;
      if (k <= portEnd) idx.push(a[k]!, a[k1]!, b[k1]!, a[k]!, b[k1]!, b[k]!);
      else idx.push(a[k]!, a[k1]!, b[k]!, a[k1]!, b[k1]!, b[k]!);
    }
  }
  // End caps: fan from the ring centroid.
  const cap = (ring: number[], flip: boolean): void => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const v of ring) {
      cx += pos[3 * v]!;
      cy += pos[3 * v + 1]!;
      cz += pos[3 * v + 2]!;
    }
    const c = push(cx / ring.length, cy / ring.length, cz / ring.length);
    for (let k = 0; k < ring.length; k++) {
      const v0 = ring[k]!;
      const v1 = ring[(k + 1) % ring.length]!;
      if (flip) idx.push(c, v1, v0);
      else idx.push(c, v0, v1);
    }
  };
  cap(rings[0]!, true);
  cap(rings[stations - 1]!, false);

  const mesh: TriangleMesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  // Orient outward: the divergence-theorem volume must be positive.
  if (meshVolume(mesh).volume < 0) flipOrientation(mesh);
  return { mesh, deckEdge: new Uint32Array(deckEdge) };
}

export function flipOrientation(mesh: TriangleMesh): void {
  const ix = mesh.indices;
  for (let t = 0; t < ix.length; t += 3) {
    const b = ix[t + 1]!;
    ix[t + 1] = ix[t + 2]!;
    ix[t + 2] = b;
  }
}

export interface WatertightReport {
  /** True when every edge is shared by exactly two triangles with opposite orientation. */
  ok: boolean;
  edges: number;
  /** Edges used by only one triangle (holes). */
  boundaryEdges: number;
  /** Edges used by more than two triangles. */
  nonManifoldEdges: number;
  /** Edges whose two triangles traverse it in the same direction (inconsistent winding). */
  misorientedEdges: number;
}

/** Topological watertightness check (index based). */
export function checkWatertight(mesh: TriangleMesh): WatertightReport {
  const ix = mesh.indices;
  const n = mesh.positions.length / 3;
  // key = min·n + max; value: count of (a→b with a<b) minus/plus directions.
  const forward = new Map<number, number>();
  const backward = new Map<number, number>();
  for (let t = 0; t < ix.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e]!;
      const b = ix[t + ((e + 1) % 3)]!;
      if (a === b) continue;
      const key = Math.min(a, b) * n + Math.max(a, b);
      const m = a < b ? forward : backward;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  const keys = new Set([...forward.keys(), ...backward.keys()]);
  let boundary = 0;
  let nonManifold = 0;
  let misoriented = 0;
  for (const k of keys) {
    const f = forward.get(k) ?? 0;
    const b = backward.get(k) ?? 0;
    if (f + b === 1) boundary++;
    else if (f + b > 2) nonManifold++;
    else if (f !== 1 || b !== 1) misoriented++;
  }
  return {
    ok: boundary === 0 && nonManifold === 0 && misoriented === 0,
    edges: keys.size,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    misorientedEdges: misoriented,
  };
}

/**
 * Volume and centroid of a closed mesh by the divergence theorem (sum of signed tetrahedra
 * spanned by the origin and each triangle). Positive for outward-oriented meshes.
 */
export function meshVolume(mesh: TriangleMesh): { volume: number; centroid: Vec3 } {
  const p = mesh.positions;
  const ix = mesh.indices;
  let v6 = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = 3 * ix[t]!;
    const b = 3 * ix[t + 1]!;
    const c = 3 * ix[t + 2]!;
    const ax = p[a]!;
    const ay = p[a + 1]!;
    const az = p[a + 2]!;
    const bx = p[b]!;
    const by = p[b + 1]!;
    const bz = p[b + 2]!;
    const qx = p[c]!;
    const qy = p[c + 1]!;
    const qz = p[c + 2]!;
    const d = ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    v6 += d;
    cx += d * (ax + bx + qx);
    cy += d * (ay + by + qy);
    cz += d * (az + bz + qz);
  }
  const volume = v6 / 6;
  const s = v6 !== 0 ? 1 / (4 * v6) : 0;
  return { volume, centroid: { x: cx * s, y: cy * s, z: cz * s } };
}

/** Total surface area of a mesh [m²]. */
export function meshArea(mesh: TriangleMesh): number {
  const p = mesh.positions;
  const ix = mesh.indices;
  let area = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = 3 * ix[t]!;
    const b = 3 * ix[t + 1]!;
    const c = 3 * ix[t + 2]!;
    const ux = p[b]! - p[a]!;
    const uy = p[b + 1]! - p[a + 1]!;
    const uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!;
    const vy = p[c + 1]! - p[a + 1]!;
    const vz = p[c + 2]! - p[a + 2]!;
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return area;
}

/** Copy of a mesh with all positions scaled by s and then translated by −origin. */
export function transformMesh(mesh: TriangleMesh, s: number, origin: Vec3): TriangleMesh {
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i]! * s - origin.x;
    out[i + 1] = src[i + 1]! * s - origin.y;
    out[i + 2] = src[i + 2]! * s - origin.z;
  }
  return { positions: out, indices: mesh.indices.slice() };
}

export function meshBounds(mesh: TriangleMesh): { min: Vec3; max: Vec3 } {
  const p = mesh.positions;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < p.length; i += 3) {
    min.x = Math.min(min.x, p[i]!);
    min.y = Math.min(min.y, p[i + 1]!);
    min.z = Math.min(min.z, p[i + 2]!);
    max.x = Math.max(max.x, p[i]!);
    max.y = Math.max(max.y, p[i + 1]!);
    max.z = Math.max(max.z, p[i + 2]!);
  }
  return { min, max };
}
