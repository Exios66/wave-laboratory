/**
 * Progressive flooding of a breached hull.
 *
 * Each hull is divided into 4–7 transverse watertight compartments (one per ~20 m of length).
 * A compartment is the box of equal length, equal height (keel to deck) and the breadth that
 * gives it the hull's mean section area there, so a rectangular barge is represented exactly
 * and a fine-ended hull gets the right capacity. Compartments are fully vented and have 100 %
 * permeability (cargo and machinery are not modelled).
 *
 * Flooding rate. A breach of area A (orifice discharge coefficient C_d ≈ 0.6) admits
 *     Q = C_d A √(2 g |Δh|) · sign(Δh),   Δh = max(η, z_b) − max(ζ, z_b),
 * with η the local wave elevation at the breach, ζ the inside free-surface height and z_b the
 * breach height (all world heights): water flows in while the sea stands above the inside level,
 * and out (a breach above the inside level, or a rising hull) while it stands below. The volume
 * moved in a step is limited to the volume that equalises the two levels, so the inside level
 * approaches the outside one monotonically without overshoot at any step size (Euler on a
 * square-root law would otherwise chatter around Δh = 0). Pumps (when switched on, after the
 * crew has plugged the holes) remove up to 1/240 of a compartment's capacity per second.
 *
 * Floodwater loads on the rigid body. The water in a compartment is quasi-static: its free
 * surface is always horizontal in the world (the plane n·p = c, with n the world up vector in
 * the body frame), clipped by the box walls, and holds the compartment's stored volume. The
 * force is its weight m_f g along world −z acting at the centroid of that clipped volume, so
 * the existing rigid-body dynamics produce the list and trim of off-centre and end flooding
 * and the extra sinkage. Because the centroid is that of the *tilted* water body, it moves
 * towards the low side as the ship heels: for a wall-sided partly filled compartment the
 * heeling arm is (i/V) tan φ with i = l b³ / 12, i.e. exactly the classical free-surface
 * correction GM_eff = GM − ρ i / Δ, here obtained without any ad-hoc modification of GM and
 * valid to large angles (columns of the box are integrated with 6 × 6 Gauss–Legendre nodes).
 *
 * Simplifications. Sloshing dynamics are ignored (the surface levels instantly, a long-wave
 * limit appropriate to roll periods above the sloshing period), the floodwater adds weight but
 * not inertia, and the breach is a single orifice per compartment. See docs/PHYSICS.md.
 *
 * References: Biran & López Pulido (2014), Ship Hydrostatics and Stability, ch. 8–9 (free
 * surface, flooding); IMO MSC.1/Circ.1646; Bernoulli orifice law with C_d = 0.6 (Munson et
 * al., Fundamentals of Fluid Mechanics).
 */
import type { VesselDefinition } from './api';
import { sectionAt } from './hydrostatics';
import { meshBounds } from './mesh';

/** Orifice discharge coefficient of a ragged breach. */
export const DISCHARGE_COEFFICIENT = 0.6;
/** Time to pump a compartment dry with the pumps running [s] (capacity / this = rate). */
export const PUMP_DRAIN_TIME = 240;
/** Length of hull per compartment [m]; the count is clamped to 4–7. */
export const COMPARTMENT_LENGTH = 20;
export const MIN_COMPARTMENTS = 4;
export const MAX_COMPARTMENTS = 7;
/** Breach area per unit of health lost, as a fraction of the midship rectangle B·D. */
export const COLLISION_BREACH_PER_DAMAGE = 0.1;
export const SLAM_BREACH_PER_DAMAGE = 0.04;
/** Breach area of the manual "flood compartment" order, as a fraction of B·D. */
export const MANUAL_BREACH_FRACTION = 0.02;
/** Collision damage below this opens no breach. */
export const COLLISION_BREACH_MIN = 0.02;
/** A slam must have cost this much health in total before it holes the plating. */
export const SLAM_BREACH_MIN = 0.03;
/** A hull this much submerged (of its closed volume) with water aboard has foundered. */
export const FOUNDER_FRACTION = 0.98;

const GL_NODES = [
  -0.9324695142031521, -0.6612093864662645, -0.2386191860831969, 0.2386191860831969,
  0.6612093864662645, 0.9324695142031521,
] as const;
const GL_WEIGHTS = [
  0.1713244923791704, 0.3607615730481386, 0.467913934572691, 0.467913934572691, 0.3607615730481386,
  0.1713244923791704,
] as const;

/** One watertight compartment: a box in the body frame (relative to the CoG). */
export interface Compartment {
  /** 0 = foremost. */
  index: number;
  /** Forward and after limits and centre [m]. */
  xFwd: number;
  xAft: number;
  xc: number;
  /** Half breadth and floor/roof heights [m]. */
  halfBeam: number;
  zFloor: number;
  zRoof: number;
  /** Capacity [m³] and the free-surface inertia i = l b³ / 12 of a part-filled tank [m⁴]. */
  capacity: number;
  inertia: number;
}

/** Number of compartments for a hull of length `length` [m]. */
export function compartmentCount(length: number): number {
  return Math.max(
    MIN_COMPARTMENTS,
    Math.min(MAX_COMPARTMENTS, Math.round(length / COMPARTMENT_LENGTH)),
  );
}

/** Divide a vessel's hull into `count` equal-length transverse compartments (bow first). */
export function buildCompartments(
  def: VesselDefinition,
  count = compartmentCount(def.length),
): Compartment[] {
  const mesh = def.physicsHull;
  const b = meshBounds(mesh);
  const zTop = b.max.z - 1e-3;
  const dx = (b.max.x - b.min.x) / count;
  const out: Compartment[] = [];
  for (let i = 0; i < count; i++) {
    const xFwd = b.max.x - i * dx;
    const xAft = xFwd - dx;
    // Mean section area (midpoint rule over five stations) and the lowest keel in the bay.
    let area = 0;
    let zKeel = Infinity;
    const stations = 5;
    for (let k = 0; k < stations; k++) {
      const s = sectionAt(mesh, xAft + ((k + 0.5) / stations) * dx, zTop);
      area += s.area / stations;
      if (s.area > 0) zKeel = Math.min(zKeel, zTop - s.draft);
    }
    if (!Number.isFinite(zKeel)) zKeel = b.min.z;
    const height = Math.max(zTop - zKeel, 1e-3);
    const width = Math.max(area / height, 1e-3);
    out.push({
      index: i,
      xFwd,
      xAft,
      xc: 0.5 * (xFwd + xAft),
      halfBeam: 0.5 * width,
      zFloor: zKeel,
      zRoof: zTop,
      capacity: dx * width * height,
      inertia: (dx * width ** 3) / 12,
    });
  }
  return out;
}

/** Wetted volume and first moments of a compartment cut by the plane n·p = c. */
interface PlaneCut {
  volume: number;
  mx: number;
  my: number;
  mz: number;
}

const cutOut: PlaneCut = { volume: 0, mx: 0, my: 0, mz: 0 };

/**
 * Part of compartment `c` on the low side of the plane n·p = cc (n need not be exactly
 * vertical): columns along the axis most aligned with n are integrated with Gauss–Legendre
 * nodes over the other two. The result is written to (and returned as) a shared scratch object.
 */
function cutBelowPlane(c: Compartment, nx: number, ny: number, nz: number, cc: number): PlaneCut {
  // Box centre and half sizes.
  const m0 = c.xc;
  const m1 = 0;
  const m2 = 0.5 * (c.zFloor + c.zRoof);
  const h0 = 0.5 * (c.xFwd - c.xAft);
  const h1 = c.halfBeam;
  const h2 = 0.5 * (c.zRoof - c.zFloor);
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  // Integration axis k with the other two axes i, j; arrays avoided to stay allocation-free.
  const k = az >= ax && az >= ay ? 2 : ay >= ax ? 1 : 0;
  const mi = k === 0 ? m1 : m0;
  const mj = k === 2 ? m1 : m2;
  const mk = k === 0 ? m0 : k === 1 ? m1 : m2;
  const hi = k === 0 ? h1 : h0;
  const hj = k === 2 ? h1 : h2;
  const hk = k === 0 ? h0 : k === 1 ? h1 : h2;
  const ni = k === 0 ? ny : nx;
  const nj = k === 2 ? ny : nz;
  const nk = k === 0 ? nx : k === 1 ? ny : nz;
  let vol = 0;
  let mI = 0;
  let mJ = 0;
  let mK = 0;
  for (let a = 0; a < 6; a++) {
    const pi = mi + GL_NODES[a]! * hi;
    for (let b = 0; b < 6; b++) {
      const pj = mj + GL_NODES[b]! * hj;
      const s = (cc - ni * pi - nj * pj) / nk;
      let lo = mk - hk;
      let hiK = mk + hk;
      if (nk > 0) hiK = Math.min(hiK, s);
      else lo = Math.max(lo, s);
      const t = hiK - lo;
      if (!(t > 0)) continue;
      const dA = hi * hj * GL_WEIGHTS[a]! * GL_WEIGHTS[b]!;
      const dV = t * dA;
      vol += dV;
      mI += pi * dV;
      mJ += pj * dV;
      mK += 0.5 * (lo + hiK) * dV;
    }
  }
  cutOut.volume = vol;
  // Back to (x, y, z) moments.
  if (k === 0) {
    cutOut.mx = mK;
    cutOut.my = mI;
    cutOut.mz = mJ;
  } else if (k === 1) {
    cutOut.mx = mI;
    cutOut.my = mK;
    cutOut.mz = mJ;
  } else {
    cutOut.mx = mI;
    cutOut.my = mJ;
    cutOut.mz = mK;
  }
  return cutOut;
}

/** Range of n·p over the corners of the box: the plane constant that just clears / fills it. */
function planeRange(c: Compartment, nx: number, ny: number, nz: number): [number, number] {
  const sx = Math.abs(nx) * 0.5 * (c.xFwd - c.xAft);
  const sy = Math.abs(ny) * c.halfBeam;
  const sz = Math.abs(nz) * 0.5 * (c.zRoof - c.zFloor);
  const mid = nx * c.xc + nz * 0.5 * (c.zFloor + c.zRoof);
  return [mid - sx - sy - sz, mid + sx + sy + sz];
}

/**
 * Volume [m³] below n·p = cc in the body frame; n = (nx, ny, nz) is the world up unit vector.
 * For this unit normal, `cc` is the water surface height relative to the body origin [m].
 */
export function volumeBelowPlane(
  c: Compartment,
  nx: number,
  ny: number,
  nz: number,
  cc: number,
): number {
  return cutBelowPlane(c, nx, ny, nz, cc).volume;
}

/**
 * Approximate plane constant [m] enclosing `volume` [m³] below n·p = c, with the world up unit
 * vector n = (nx, ny, nz) in the body frame. Volumes outside [0, capacity] approach the
 * compartment's lowest or highest plane constant.
 */
export function planeForVolume(
  c: Compartment,
  nx: number,
  ny: number,
  nz: number,
  volume: number,
): number {
  const [lo0, hi0] = planeRange(c, nx, ny, nz);
  let lo = lo0;
  let hi = hi0;
  for (let it = 0; it < 28; it++) {
    const mid = 0.5 * (lo + hi);
    if (cutBelowPlane(c, nx, ny, nz, mid).volume < volume) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Per-step inputs of {@link FloodingState.step}. */
export interface FloodingStepInputs {
  /** World up vector in the body frame (third row of the body→world rotation). */
  nx: number;
  ny: number;
  nz: number;
  /** World height of the body origin [m]. */
  originZ: number;
  /** Body-frame position of the breach of compartment i → outside water surface height [m]. */
  outsideLevel(i: number, bx: number, by: number, bz: number): number;
}

/** Force and moment of the floodwater about the body origin (body frame). */
export interface FloodLoads {
  fx: number;
  fy: number;
  fz: number;
  mx: number;
  my: number;
  mz: number;
}

export class FloodingState {
  readonly compartments: readonly Compartment[];
  /** Water in each compartment [m³]. */
  readonly volume: Float64Array;
  /** Breach area [m²] and body-frame position of each compartment's (lumped) breach. */
  readonly breachArea: Float64Array;
  readonly breachY: Float64Array;
  readonly breachZ: Float64Array;
  /** Pumps running (the holes are plugged first). */
  pumping = false;
  /** Water density [kg/m³] and gravity [m/s²]. */
  readonly rho: number;
  readonly g: number;
  readonly capacity: number;

  /** Start with dry, sealed compartments, water density `rho` [kg/m³], and gravity `g` [m/s²]. */
  constructor(compartments: readonly Compartment[], rho: number, g: number) {
    this.compartments = compartments;
    this.rho = rho;
    this.g = g;
    const n = compartments.length;
    this.volume = new Float64Array(n);
    this.breachArea = new Float64Array(n);
    this.breachY = new Float64Array(n);
    this.breachZ = new Float64Array(n);
    this.capacity = compartments.reduce((s, c) => s + c.capacity, 0);
  }

  /** Total floodwater volume [m³]. */
  get totalVolume(): number {
    let s = 0;
    for (const v of this.volume) s += v;
    return s;
  }

  /** Total floodwater mass [kg]. */
  get totalMass(): number {
    return this.rho * this.totalVolume;
  }

  /** Whether any compartment contains a positive water volume. */
  get hasWater(): boolean {
    for (const v of this.volume) if (v > 0) return true;
    return false;
  }

  /** Whether any compartment has an open breach of positive area. */
  get breached(): boolean {
    for (const a of this.breachArea) if (a > 0) return true;
    return false;
  }

  /** Index of the compartment whose x-range holds body-frame `x` (clamped to the ends). */
  compartmentAt(x: number): number {
    const cs = this.compartments;
    for (const c of cs) if (x >= c.xAft) return c.index;
    return cs.length - 1;
  }

  /**
   * Open (or enlarge) a breach of `area` m² in compartment `i`, at body-frame height `z` and
   * lateral position `y` (clamped to the compartment). Several breaches merge into one orifice
   * of the summed area at their area-weighted position, capped at the compartment's side area.
   * Missing compartments and areas that are not positive are ignored.
   */
  breach(i: number, area: number, y: number, z: number): void {
    const c = this.compartments[i];
    if (!c || !(area > 0)) return;
    const yc = Math.max(-c.halfBeam, Math.min(c.halfBeam, y));
    const zc = Math.max(c.zFloor, Math.min(c.zRoof, z));
    const a0 = this.breachArea[i]!;
    const total = Math.min(a0 + area, (c.xFwd - c.xAft) * (c.zRoof - c.zFloor));
    const w = total > 0 ? Math.max(0, total - a0) / total : 1;
    this.breachY[i] = a0 > 0 ? (1 - w) * this.breachY[i]! + w * yc : yc;
    this.breachZ[i] = a0 > 0 ? (1 - w) * this.breachZ[i]! + w * zc : zc;
    this.breachArea[i] = total;
  }

  /** Plug all holes. */
  seal(): void {
    this.breachArea.fill(0);
  }

  /** Empty and plug everything (new run). */
  reset(): void {
    this.volume.fill(0);
    this.seal();
    this.pumping = false;
  }

  /**
   * Set water volume [m³] for tests or scripted starts, clamped to [0, capacity].
   * Missing compartments are ignored.
   */
  fill(i: number, volume: number): void {
    const c = this.compartments[i];
    if (c) this.volume[i] = Math.max(0, Math.min(c.capacity, volume));
  }

  /**
   * Advance water volumes by a nonnegative `dt` [s] using the outside levels (see module header).
   * Pumping seals all breaches, drains the compartments, and switches off once they are dry.
   * Errors from `inp.outsideLevel` propagate; earlier compartments may already be updated.
   */
  step(dt: number, inp: FloodingStepInputs): void {
    const { nx, ny, nz, originZ } = inp;
    const cs = this.compartments;
    if (this.pumping) {
      this.seal();
      let any = false;
      for (let i = 0; i < cs.length; i++) {
        const v = this.volume[i]! - (cs[i]!.capacity / PUMP_DRAIN_TIME) * dt;
        this.volume[i] = v > 0 ? v : 0;
        if (v > 0) any = true;
      }
      if (!any) this.pumping = false;
      return;
    }
    for (let i = 0; i < cs.length; i++) {
      const area = this.breachArea[i]!;
      if (!(area > 0)) continue;
      const c = cs[i]!;
      const by = this.breachY[i]!;
      const bz = this.breachZ[i]!;
      const zb = originZ + ny * by + nz * bz + nx * c.xc;
      const eta = inp.outsideLevel(i, c.xc, by, bz);
      const v = this.volume[i]!;
      // Inside free-surface height; an empty compartment's surface rests on its lowest corner.
      const zIn =
        originZ + (v > 0 ? planeForVolume(c, nx, ny, nz, v) : planeRange(c, nx, ny, nz)[0]);
      const target = Math.max(eta, zb);
      const dh = target - Math.max(zIn, zb);
      if (dh === 0) continue;
      const q = DISCHARGE_COEFFICIENT * area * Math.sqrt(2 * this.g * Math.abs(dh));
      const vTarget = Math.min(c.capacity, volumeBelowPlane(c, nx, ny, nz, target - originZ));
      const move = Math.min(q * dt, Math.abs(vTarget - v));
      this.volume[i] = Math.max(0, Math.min(c.capacity, v + (dh > 0 ? move : -move)));
    }
  }

  /**
   * Weight of the floodwater as a force and moment about the body origin (body frame), for the
   * world up unit vector n = (nx, ny, nz) in the body frame. Overwrites and returns `out`
   * with forces [N] and moments [N·m].
   */
  loads(nx: number, ny: number, nz: number, out: FloodLoads): FloodLoads {
    out.fx = out.fy = out.fz = out.mx = out.my = out.mz = 0;
    const cs = this.compartments;
    for (let i = 0; i < cs.length; i++) {
      const v = this.volume[i]!;
      if (!(v > 0)) continue;
      const c = cs[i]!;
      const m = this.rho * v;
      let x = c.xc;
      let y = 0;
      let z = 0.5 * (c.zFloor + c.zRoof);
      if (v < c.capacity) {
        const cut = cutBelowPlane(c, nx, ny, nz, planeForVolume(c, nx, ny, nz, v));
        if (cut.volume > 0) {
          x = cut.mx / cut.volume;
          y = cut.my / cut.volume;
          z = cut.mz / cut.volume;
        }
      }
      const w = m * this.g;
      const fx = -w * nx;
      const fy = -w * ny;
      const fz = -w * nz;
      out.fx += fx;
      out.fy += fy;
      out.fz += fz;
      out.mx += y * fz - z * fy;
      out.my += z * fx - x * fz;
      out.mz += x * fy - y * fx;
    }
    return out;
  }

  /**
   * Upright floodwater centroid in body coordinates [m]; an empty bay returns its floor center.
   * @throws {TypeError} If compartment `i` does not exist.
   */
  uprightCentroid(i: number): { x: number; y: number; z: number } {
    const c = this.compartments[i]!;
    const filled = this.volume[i]! / c.capacity;
    return { x: c.xc, y: 0, z: c.zFloor + 0.5 * filled * (c.zRoof - c.zFloor) };
  }

  /** Σ ρ i over the part-filled compartments: the free-surface moment of inertia, ρ·Σ i [kg·m]. */
  freeSurfaceMoment(): number {
    let s = 0;
    for (let i = 0; i < this.compartments.length; i++) {
      const v = this.volume[i]!;
      const c = this.compartments[i]!;
      if (v > 1e-9 * c.capacity && v < (1 - 1e-9) * c.capacity) s += c.inertia;
    }
    return this.rho * s;
  }

  /** Σ m_f z_f above the keel-based height reference `zRef` (upright, body-frame z + zRef). */
  weightMoment(zRef: number): number {
    let s = 0;
    for (let i = 0; i < this.compartments.length; i++) {
      s += this.rho * this.volume[i]! * (this.uprightCentroid(i).z + zRef);
    }
    return s;
  }
}

/** Intact particulars needed for the effective metacentric height. */
export interface StabilityParticulars {
  /** Displacement mass [kg] and water density [kg/m³]. */
  mass: number;
  rho: number;
  /** Draft [m], waterplane area [m²], KB, BM, KG [m] (heights above the keel). */
  draft: number;
  waterplaneArea: number;
  kb: number;
  bm: number;
  kg: number;
}

export interface EffectiveGm {
  /** GM with the floodwater's weight and free surface [m]. */
  gm: number;
  /** Free-surface correction ρ Σ i / Δ' [m]. */
  freeSurface: number;
  /** Parallel sinkage [m]. */
  sinkage: number;
}

/**
 * Metacentric height of the flooded ship (upright, small angles, wall-sided):
 *   Δ' = Δ + m_f,   δ = m_f / (ρ A_wp)   (parallel sinkage),
 *   KB' = (∇ KB + δ A_wp (T + δ/2)) / ∇',   BM' = BM ∇ / ∇',
 *   KG' = (Δ KG + Σ m_k z_k) / Δ',          GM_eff = KB' + BM' − KG' − ρ Σ i_k / Δ'.
 * `weightMoment` is Σ m_k z_k above the keel [kg·m], `freeSurfaceMoment` is ρ Σ i_k [kg·m].
 */
export function effectiveGm(
  p: StabilityParticulars,
  floodMass: number,
  weightMoment: number,
  freeSurfaceMoment: number,
): EffectiveGm {
  const delta = p.mass + floodMass;
  const vol = p.mass / p.rho;
  const sink = floodMass / (p.rho * p.waterplaneArea);
  const vol2 = vol + floodMass / p.rho;
  const kb = (vol * p.kb + sink * p.waterplaneArea * (p.draft + 0.5 * sink)) / vol2;
  const bm = (p.bm * vol) / vol2;
  const kg = (p.mass * p.kg + weightMoment) / delta;
  const fs = freeSurfaceMoment / delta;
  return { gm: kb + bm - kg - fs, freeSurface: fs, sinkage: sink };
}
