/**
 * Hydrostatics of a closed triangle mesh cut by a flat water plane.
 *
 * Every quantity is a surface integral over the *submerged part of the hull only*; the
 * waterplane "lid" never has to be built. With the water plane at z = 0 and outward normals n,
 * the divergence theorem applied to fields that vanish (or are divergence-free) on z = 0 gives
 *
 *     ∇          =  ∫_S z n_z dA                 (F = (0, 0, z))
 *     ∇·x_B      =  ∫_S x z n_z dA,  ∇·y_B = ∫_S y z n_z dA,  ∇·z_B = ∫_S ½z² n_z dA
 *     A_wp       = −∫_S n_z dA                   (closed surface: ∮ n dA = 0)
 *     ∫_wp x dA  = −∫_S x n_z dA,   ∫_wp x² dA = −∫_S x² n_z dA, …  (divergence-free fields)
 *
 * All integrands are polynomials of degree ≤ 2 on each (clipped) triangle, so the 3-point
 * edge-midpoint rule is exact: results are exact for the polyhedral hull up to round-off.
 */
import { quatFromEuler, type Mat3, type Quat, type Vec3 } from '../core/vec';
import type { TriangleMesh } from './api';

/** Row-major rotation matrix of a unit quaternion (maps body → world: w = M·b). */
export function quatToMat3(q: Quat): Mat3 {
  const { w, x, y, z } = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

export interface SubmergedProperties {
  /** Displaced volume [m³]. */
  volume: number;
  /** Centre of buoyancy (fixed frame). */
  centroid: Vec3;
  /** Waterplane area [m²] and centroid (fixed frame). */
  waterplaneArea: number;
  wpCentroidX: number;
  wpCentroidY: number;
  /** Second moments of the waterplane about its own centroid [m⁴]: ∫x² dA, ∫y² dA. */
  wpIxx: number;
  wpIyy: number;
  /** Wetted (submerged) hull area [m²]. */
  wettedArea: number;
  /** Extent of the waterline (fixed frame). */
  wlMinX: number;
  wlMaxX: number;
  wlMaxY: number;
  wlMinY: number;
}

/** Integrand accumulator for one evaluation. */
class Acc {
  v = 0;
  mx = 0;
  my = 0;
  mz = 0;
  awp = 0;
  ax = 0;
  ay = 0;
  ixx = 0;
  iyy = 0;
  wet = 0;

  reset(): void {
    this.v = this.mx = this.my = this.mz = 0;
    this.awp = this.ax = this.ay = this.ixx = this.iyy = this.wet = 0;
  }

  /** Add one submerged triangle (a, b, c) using the edge-midpoint rule. */
  tri(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const sx = 0.5 * (uy * vz - uz * vy);
    const sy = 0.5 * (uz * vx - ux * vz);
    const sz = 0.5 * (ux * vy - uy * vx);
    this.wet += Math.hypot(sx, sy, sz);
    if (sz === 0) return;
    // Edge midpoints.
    const m1x = 0.5 * (ax + bx);
    const m1y = 0.5 * (ay + by);
    const m1z = 0.5 * (az + bz);
    const m2x = 0.5 * (bx + cx);
    const m2y = 0.5 * (by + cy);
    const m2z = 0.5 * (bz + cz);
    const m3x = 0.5 * (cx + ax);
    const m3y = 0.5 * (cy + ay);
    const m3z = 0.5 * (cz + az);
    const w = sz / 3;
    this.v += w * (m1z + m2z + m3z);
    this.mx += w * (m1x * m1z + m2x * m2z + m3x * m3z);
    this.my += w * (m1y * m1z + m2y * m2z + m3y * m3z);
    this.mz += 0.5 * w * (m1z * m1z + m2z * m2z + m3z * m3z);
    this.awp -= sz;
    this.ax -= w * (m1x + m2x + m3x);
    this.ay -= w * (m1y + m2y + m3y);
    this.ixx -= w * (m1x * m1x + m2x * m2x + m3x * m3x);
    this.iyy -= w * (m1y * m1y + m2y * m2y + m3y * m3y);
  }
}

const acc = new Acc();

/**
 * Submerged-volume properties of `mesh` placed by rotation `rot` (body → fixed) and
 * translation `offset`, cut by the plane z = 0 (water below).
 */
export function submergedProperties(
  mesh: TriangleMesh,
  rot: Mat3,
  offset: Vec3,
): SubmergedProperties {
  const p = mesh.positions;
  const n = p.length / 3;
  const wx = new Float64Array(n);
  const wy = new Float64Array(n);
  const wz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const bx = p[3 * i]!;
    const by = p[3 * i + 1]!;
    const bz = p[3 * i + 2]!;
    wx[i] = rot[0] * bx + rot[1] * by + rot[2] * bz + offset.x;
    wy[i] = rot[3] * bx + rot[4] * by + rot[5] * bz + offset.y;
    wz[i] = rot[6] * bx + rot[7] * by + rot[8] * bz + offset.z;
  }
  acc.reset();
  let wlMinX = Infinity;
  let wlMaxX = -Infinity;
  let wlMinY = Infinity;
  let wlMaxY = -Infinity;
  const ix = mesh.indices;
  const wl = (x: number, y: number): void => {
    if (x < wlMinX) wlMinX = x;
    if (x > wlMaxX) wlMaxX = x;
    if (y < wlMinY) wlMinY = y;
    if (y > wlMaxY) wlMaxY = y;
  };
  for (let t = 0; t < ix.length; t += 3) {
    // Rotate the vertex order so the clipping cases below see a canonical layout.
    let i0 = ix[t]!;
    let i1 = ix[t + 1]!;
    let i2 = ix[t + 2]!;
    const s0 = wz[i0]! < 0;
    const s1 = wz[i1]! < 0;
    const s2 = wz[i2]! < 0;
    const count = (s0 ? 1 : 0) + (s1 ? 1 : 0) + (s2 ? 1 : 0);
    if (count === 0) continue;
    if (count === 3) {
      acc.tri(wx[i0]!, wy[i0]!, wz[i0]!, wx[i1]!, wy[i1]!, wz[i1]!, wx[i2]!, wy[i2]!, wz[i2]!);
      continue;
    }
    // Make vertex 0 the "odd one out" (the only wet one if count = 1, the only dry one if 2).
    const odd = count === 1 ? (s0 ? 0 : s1 ? 1 : 2) : !s0 ? 0 : !s1 ? 1 : 2;
    if (odd === 1) [i0, i1, i2] = [i1, i2, i0];
    else if (odd === 2) [i0, i1, i2] = [i2, i0, i1];
    const z0 = wz[i0]!;
    const z1 = wz[i1]!;
    const z2 = wz[i2]!;
    const t1 = z0 / (z0 - z1);
    const t2 = z0 / (z0 - z2);
    const px = wx[i0]! + (wx[i1]! - wx[i0]!) * t1;
    const py = wy[i0]! + (wy[i1]! - wy[i0]!) * t1;
    const qx = wx[i0]! + (wx[i2]! - wx[i0]!) * t2;
    const qy = wy[i0]! + (wy[i2]! - wy[i0]!) * t2;
    wl(px, py);
    wl(qx, qy);
    if (count === 1) {
      acc.tri(wx[i0]!, wy[i0]!, z0, px, py, 0, qx, qy, 0);
    } else {
      acc.tri(px, py, 0, wx[i1]!, wy[i1]!, z1, wx[i2]!, wy[i2]!, z2);
      acc.tri(px, py, 0, wx[i2]!, wy[i2]!, z2, qx, qy, 0);
    }
  }
  const v = acc.v;
  const awp = acc.awp;
  const xc = awp > 0 ? acc.ax / awp : 0;
  const yc = awp > 0 ? acc.ay / awp : 0;
  return {
    volume: v,
    centroid: v > 0 ? { x: acc.mx / v, y: acc.my / v, z: acc.mz / v } : { x: 0, y: 0, z: 0 },
    waterplaneArea: awp,
    wpCentroidX: xc,
    wpCentroidY: yc,
    wpIxx: acc.ixx - awp * xc * xc,
    wpIyy: acc.iyy - awp * yc * yc,
    wettedArea: acc.wet,
    wlMinX,
    wlMaxX,
    wlMinY,
    wlMaxY,
  };
}

export interface FloatingPosition {
  /** Height of the body origin (CoG) above the water plane [m]. */
  z: number;
  /** Trim angle (pitch, + bow down) [rad]. */
  trim: number;
  props: SubmergedProperties;
}

/**
 * Free-floating equilibrium at a given heel: find the CoG height z and (optionally) trim θ such
 * that ∇ = ∇₀ and the centre of buoyancy lies vertically below/above the CoG longitudinally.
 * The body origin is the CoG. Newton iteration with a finite-difference Jacobian.
 */
export function solveFloating(
  mesh: TriangleMesh,
  targetVolume: number,
  heel: number,
  opts: { freeTrim?: boolean; z0?: number; trim0?: number; length?: number } = {},
): FloatingPosition {
  const freeTrim = opts.freeTrim ?? true;
  const L = opts.length ?? 1;
  let z = opts.z0 ?? 0;
  let trim = opts.trim0 ?? 0;
  const evalAt = (zz: number, th: number): SubmergedProperties =>
    submergedProperties(mesh, quatToMat3(quatFromEuler(heel, th, 0)), { x: 0, y: 0, z: zz });
  let props = evalAt(z, trim);
  for (let it = 0; it < 60; it++) {
    const r1 = props.volume - targetVolume;
    const r2 = props.volume * props.centroid.x; // moment of buoyancy about the CoG (x-arm)
    const tol1 = 1e-11 * targetVolume;
    const tol2 = 1e-11 * targetVolume * L;
    if (Math.abs(r1) < tol1 && (!freeTrim || Math.abs(r2) < tol2)) break;
    const dz = 1e-5 * L;
    const pz = evalAt(z + dz, trim);
    const j11 = (pz.volume - props.volume) / dz;
    if (!freeTrim) {
      // dV/dz = −A_wp (raising the hull reduces the volume); keep Newton safe.
      const d = Math.abs(j11) > 1e-12 ? -r1 / j11 : -Math.sign(r1) * 0.01 * L;
      z += clampStep(d, 0.1 * L);
      props = evalAt(z, trim);
      continue;
    }
    const j21 = (pz.volume * pz.centroid.x - r2) / dz;
    const dt = 1e-5;
    const pt = evalAt(z, trim + dt);
    const j12 = (pt.volume - props.volume) / dt;
    const j22 = (pt.volume * pt.centroid.x - r2) / dt;
    const det = j11 * j22 - j12 * j21;
    let ddz: number;
    let dth: number;
    if (Math.abs(det) > 1e-300) {
      ddz = (-r1 * j22 + r2 * j12) / det;
      dth = (-r2 * j11 + r1 * j21) / det;
    } else {
      ddz = Math.abs(j11) > 1e-12 ? -r1 / j11 : 0;
      dth = 0;
    }
    z += clampStep(ddz, 0.1 * L);
    trim += clampStep(dth, 0.1);
    props = evalAt(z, trim);
  }
  return { z, trim, props };
}

function clampStep(d: number, max: number): number {
  return Math.max(-max, Math.min(max, d));
}

/**
 * Righting arm GZ(φ) [m] at constant displacement (free trim) for heel angles in degrees.
 * With the CoG at the origin, GZ = −y_B (world): positive when buoyancy acts to starboard of G
 * for a starboard-down (positive) heel, i.e. when the couple rights the vessel.
 */
export function gzCurve(
  mesh: TriangleMesh,
  targetVolume: number,
  heelsDeg: readonly number[],
  length: number,
): number[] {
  const out: number[] = [];
  let z = 0;
  let trim = 0;
  for (const h of heelsDeg) {
    const f = solveFloating(mesh, targetVolume, (h * Math.PI) / 180, {
      z0: z,
      trim0: trim,
      length,
    });
    z = f.z;
    trim = f.trim;
    out.push(-f.props.centroid.y);
  }
  return out;
}

/** Angle of vanishing stability [deg]: where GZ last crosses from positive to negative. */
export function vanishingStabilityAngle(
  heelsDeg: readonly number[],
  gz: readonly number[],
): number {
  let avs = 0;
  let positive = false;
  for (let i = 1; i < gz.length; i++) {
    const a = gz[i - 1]!;
    const b = gz[i]!;
    if (b > 0) positive = true;
    if (positive && a > 0 && b <= 0) {
      const h0 = heelsDeg[i - 1]!;
      const h1 = heelsDeg[i]!;
      avs = h0 + ((h1 - h0) * a) / (a - b);
      return avs;
    }
  }
  return positive ? heelsDeg[heelsDeg.length - 1]! : 0;
}

export interface SectionProperties {
  /** Waterline beam [m], draft below the waterline [m] and submerged area [m²]. */
  beam: number;
  draft: number;
  area: number;
}

/**
 * Transverse section x = const of an upright hull floating with its waterline at z = zWl
 * (mesh coordinates). Assumes each side of the section is single-valued in z, which holds for
 * the lofted hulls (half-breadth is a function of height).
 */
export function sectionAt(mesh: TriangleMesh, x: number, zWl: number): SectionProperties {
  const p = mesh.positions;
  const ix = mesh.indices;
  let beam = 0;
  let zMin = Infinity;
  let area = 0;
  const pt = [0, 0, 0, 0];
  for (let t = 0; t < ix.length; t += 3) {
    let k = 0;
    for (let e = 0; e < 3 && k < 4; e++) {
      const a = 3 * ix[t + e]!;
      const b = 3 * ix[t + ((e + 1) % 3)]!;
      const xa = p[a]! - x;
      const xb = p[b]! - x;
      if (xa < 0 === xb < 0) continue;
      const s = xa / (xa - xb);
      pt[k++] = p[a + 1]! + (p[b + 1]! - p[a + 1]!) * s;
      pt[k++] = p[a + 2]! + (p[b + 2]! - p[a + 2]!) * s;
    }
    if (k < 4) continue;
    let y1 = Math.abs(pt[0]!);
    let z1 = pt[1]!;
    let y2 = Math.abs(pt[2]!);
    let z2 = pt[3]!;
    if (z1 > z2) [y1, z1, y2, z2] = [y2, z2, y1, z1];
    if (z1 >= zWl) continue;
    zMin = Math.min(zMin, z1);
    if (z2 > zWl) {
      const s = (zWl - z1) / (z2 - z1);
      y2 = y1 + (y2 - y1) * s;
      z2 = zWl;
    }
    if (z2 >= zWl - 1e-6 * (1 + Math.abs(zWl))) beam = Math.max(beam, 2 * y2);
    area += 0.5 * (y1 + y2) * (z2 - z1);
  }
  return { beam, draft: Number.isFinite(zMin) ? zWl - zMin : 0, area };
}
