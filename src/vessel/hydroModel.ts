/**
 * Fidelity-L0 radiation/diffraction and viscous coefficients for one vessel in one environment.
 *
 * Added mass (constant, "infinite-frequency" strip theory):
 *  - heave/sway: Lewis-form section coefficients integrated over ~20 strips, times a 3-D end
 *    reduction J = 1/(1 + 0.6 B/L), a fit to Lamb's transverse added-mass coefficient of prolate
 *    spheroids (0.70 at L/B = 2, 0.86 at 4, 0.96 at 10);
 *  - pitch/yaw and the heave–pitch, sway–yaw couplings from the same strips (x-moments);
 *  - surge: Söding (1982); roll: 20 % of the dry roll inertia (typical values 10–30 %,
 *    Himeno 1981), as Lewis sections give no reliable roll added inertia about G.
 * These enter the effective mass matrix (M + A) that is inverted once; they are never applied
 * as explicit force feedback (which is unstable for light bodies).
 *
 * Radiation damping: linear, distributed over the same strips (b(x) ∝ a33(x)(α + βx²)) and
 * tuned to 15 % of critical in heave and pitch — the order of magnitude strip theory gives at
 * the natural frequencies of conventional ships (Journée & Massie 2001, ch. 7). Damping and
 * the diffraction force act on the motion relative to the water at each strip (relative-motion
 * strip theory), so a vessel follows long waves exactly (RAO → 1).
 *
 * Roll damping (Ikeda-type decomposition): B44 = B_0 + B_L(U) + B_q |φ̇|, with
 *  - B_0 = 2·0.03·√((I₄₄+A₄₄) ρ g ∇ GM): wave + skin-friction + linear eddy part at zero
 *    speed, 3 % of critical, typical of Ikeda/Himeno estimates for ships without bilge keels;
 *  - B_L: Ikeda's lift component, proportional to speed (see `ikedaLiftDamping`);
 *  - B_q: quadratic (eddy-making/bilge) term sized so that its equivalent linear damping is 4 %
 *    of critical at 10° roll amplitude (B_eq = 8/(3π) ω φ_a B_q, Himeno 1981).
 */
import { SEAWATER_KINEMATIC_VISCOSITY } from '../core/constants';
import { quatIdentity } from '../core/vec';
import type { VesselDefinition } from './api';
import {
  clarkeDerivatives,
  formFactor,
  ikedaLiftDamping,
  lewisAddedMass,
  ochiThreshold,
  rudderLiftSlope,
  surgeAddedMass,
} from './coefficients';
import { quatToMat3, sectionAt, submergedProperties } from './hydrostatics';

export const STRIP_COUNT = 20;
export const HEAVE_DAMPING_RATIO = 0.15;
export const PITCH_DAMPING_RATIO = 0.15;
export const ROLL_LINEAR_DAMPING_RATIO = 0.03;
export const ROLL_QUADRATIC_DAMPING_RATIO = 0.04;
export const ROLL_QUADRATIC_REF_AMPLITUDE = (10 * Math.PI) / 180;
/** Roll added inertia as a fraction of the dry roll inertia. */
export const ROLL_ADDED_INERTIA = 0.2;
/**
 * Cross-flow drag coefficient of hull panels. Two-dimensional ship sections in cross flow have
 * C_D ≈ 0.6–1.2 depending on bilge radius and B/T (Hoerner 1965; Faltinsen 1990 §6); we use a
 * single mid-range value.
 */
export const CROSS_FLOW_CD = 0.9;

export interface HydroModel {
  rho: number;
  g: number;
  nu: number;
  mass: number;
  /** Dry inertia about the CoG (principal) [kg·m²]. */
  ixx: number;
  iyy: number;
  izz: number;
  /** 6×6 added-mass matrix (row-major, body frame: surge, sway, heave, roll, pitch, yaw). */
  addedMass: Float64Array;
  /** Inverse of the effective mass matrix M_RB + A. */
  massInverse: Float64Array;
  /** Strips: station x (body), sample depth z (body), per-strip added mass & damping. */
  stripX: Float64Array;
  stripZ: Float64Array;
  /** Local design draft of each strip [m] (for its immersion ratio). */
  stripDraft: Float64Array;
  /** Strip heave/sway added mass [kg] (already × Δx × J) and heave damping [N·s/m]. */
  stripA33: Float64Array;
  stripA22: Float64Array;
  stripB33: Float64Array;
  /** Body z of the design waterline. */
  waterlineZ: number;
  /** Hydrostatic stiffness and natural frequencies [rad/s]. */
  c33: number;
  c44: number;
  c55: number;
  omegaHeave: number;
  omegaRoll: number;
  omegaPitch: number;
  /** Achieved damping ratios (diagnostics). */
  zetaHeave: number;
  zetaPitch: number;
  rollB0: number;
  /** Ikeda lift roll damping per unit speed [N·m·s/rad per m/s]. */
  rollBLift: number;
  rollBQuad: number;
  /** Calm-water resistance parameters. */
  lwl: number;
  bwl: number;
  formFactor: number;
  blockCoefficient: number;
  clarke: { yv: number; yr: number; nv: number; nr: number };
  /** Body z where the hull's lateral manoeuvring force acts (half draft). */
  lateralZ: number;
  slamThreshold: number;
  /** Panels whose centroid is forward of this body x can slam. */
  slamRegionX: number;
  rudderLiftSlope: number;
}

export function buildHydroModel(def: VesselDefinition, rho: number, g: number): HydroModel {
  const nu = SEAWATER_KINEMATIC_VISCOSITY;
  const mesh = def.physicsHull;
  const T = def.draft;
  const zWl = T - def.kg;
  const hs = def.hydrostatics;
  const volume = hs.volume;
  const mass = def.mass;
  const props = submergedProperties(mesh, quatToMat3(quatIdentity()), { x: 0, y: 0, z: -zWl });
  const lwl = props.wlMaxX - props.wlMinX;
  const bwl = props.wlMaxY - props.wlMinY;
  const J = 1 / (1 + (0.6 * bwl) / lwl);

  const n = STRIP_COUNT;
  const dx = lwl / n;
  const stripX = new Float64Array(n);
  const stripZ = new Float64Array(n);
  const stripDraft = new Float64Array(n);
  const stripA33 = new Float64Array(n);
  const stripA22 = new Float64Array(n);
  const stripB33 = new Float64Array(n);
  let maxSectionArea = 0;
  for (let i = 0; i < n; i++) {
    const x = props.wlMinX + (i + 0.5) * dx;
    const sec = sectionAt(mesh, x, zWl);
    const lw = lewisAddedMass(sec.beam, sec.draft, sec.area, rho);
    stripX[i] = x;
    stripDraft[i] = Math.max(sec.draft, 1e-3 * T);
    // Sample relative motion at the section's mean depth A/b (Smith-effect equivalent depth).
    const dEq = sec.beam > 1e-6 ? Math.min(sec.draft, sec.area / sec.beam) : 0.5 * sec.draft;
    stripZ[i] = zWl - Math.max(dEq, 0.05 * T);
    stripA33[i] = J * lw.a33 * dx;
    stripA22[i] = J * lw.a22 * dx;
    maxSectionArea = Math.max(maxSectionArea, sec.area);
  }

  // ---- added-mass matrix (body frame, about the CoG)
  const A = new Float64Array(36);
  let a33 = 0;
  let a22 = 0;
  let a55 = 0;
  let a66 = 0;
  let a35 = 0;
  let a26 = 0;
  for (let i = 0; i < n; i++) {
    const x = stripX[i]!;
    a33 += stripA33[i]!;
    a22 += stripA22[i]!;
    a55 += stripA33[i]! * x * x;
    a66 += stripA22[i]! * x * x;
    a35 -= stripA33[i]! * x;
    a26 += stripA22[i]! * x;
  }
  const a11 = surgeAddedMass(mass, lwl, volume);
  const a44 = ROLL_ADDED_INERTIA * def.inertia.x;
  A[0] = a11;
  A[7] = a22;
  A[14] = a33;
  A[21] = a44;
  A[28] = a55;
  A[35] = a66;
  A[2 * 6 + 4] = A[4 * 6 + 2] = a35;
  A[1 * 6 + 5] = A[5 * 6 + 1] = a26;
  const M = new Float64Array(36);
  M.set(A);
  M[0]! += mass;
  M[7]! += mass;
  M[14]! += mass;
  M[21]! += def.inertia.x;
  M[28]! += def.inertia.y;
  M[35]! += def.inertia.z;
  const massInverse = invert6(M);

  // ---- hydrostatic stiffness & natural frequencies
  const c33 = rho * g * hs.waterplaneArea;
  const gm = def.gm;
  const gmL = hs.kb + hs.bmL - def.kg;
  const c44 = rho * g * volume * gm;
  const c55 = rho * g * volume * gmL;
  const i44 = def.inertia.x + a44;
  const i55 = def.inertia.y + a55;
  const omegaHeave = Math.sqrt(c33 / (mass + a33));
  const omegaRoll = Math.sqrt(Math.abs(c44) / i44);
  const omegaPitch = Math.sqrt(Math.max(c55, 0) / i55);

  // ---- heave/pitch radiation damping distributed over the strips: b_i = a_i (α + β x_i²)
  const b33Target = 2 * HEAVE_DAMPING_RATIO * Math.sqrt((mass + a33) * c33);
  const b55Target = 2 * PITCH_DAMPING_RATIO * Math.sqrt(i55 * Math.max(c55, 0));
  let s0 = 0;
  let s2 = 0;
  let s4 = 0;
  for (let i = 0; i < n; i++) {
    const x2 = stripX[i]! ** 2;
    s0 += stripA33[i]!;
    s2 += stripA33[i]! * x2;
    s4 += stripA33[i]! * x2 * x2;
  }
  const det = s0 * s4 - s2 * s2;
  let alpha = (b33Target * s4 - b55Target * s2) / det;
  let beta = (s0 * b55Target - s2 * b33Target) / det;
  if (!(alpha >= 0)) {
    alpha = 0;
    beta = b55Target / s4;
  }
  if (!(beta >= 0)) {
    beta = 0;
    alpha = b33Target / s0;
  }
  let b33 = 0;
  let b55 = 0;
  for (let i = 0; i < n; i++) {
    const x2 = stripX[i]! ** 2;
    stripB33[i] = stripA33[i]! * (alpha + beta * x2);
    b33 += stripB33[i]!;
    b55 += stripB33[i]! * x2;
  }

  // ---- roll damping
  const gmEff = Math.max(Math.abs(gm), 0.02 * def.beam);
  const critRoll = 2 * Math.sqrt(i44 * rho * g * volume * gmEff);
  const omegaRollEff = Math.sqrt((rho * g * volume * gmEff) / i44);
  const rollB0 = ROLL_LINEAR_DAMPING_RATIO * critRoll;
  const rollBQuad =
    (ROLL_QUADRATIC_DAMPING_RATIO * critRoll * 3 * Math.PI) /
    (8 * omegaRollEff * ROLL_QUADRATIC_REF_AMPLITUDE);
  const cm = maxSectionArea / (bwl * T);
  // OG: depth of G below the waterline, positive downward (Ikeda).
  const og = T - def.kg;
  const rollBLift = ikedaLiftDamping(rho, 1, lwl, bwl, T, og, cm); // per unit speed

  const cb = volume / (lwl * bwl * T);
  return {
    rho,
    g,
    nu,
    mass,
    ixx: def.inertia.x,
    iyy: def.inertia.y,
    izz: def.inertia.z,
    addedMass: A,
    massInverse,
    stripX,
    stripZ,
    stripDraft,
    stripA33,
    stripA22,
    stripB33,
    waterlineZ: zWl,
    c33,
    c44,
    c55,
    omegaHeave,
    omegaRoll,
    omegaPitch,
    zetaHeave: b33 / (2 * Math.sqrt((mass + a33) * c33)),
    zetaPitch: c55 > 0 ? b55 / (2 * Math.sqrt(i55 * c55)) : 0,
    rollB0,
    rollBLift,
    rollBQuad,
    lwl,
    bwl,
    formFactor: formFactor(cb, lwl, bwl, T),
    blockCoefficient: cb,
    clarke: clarkeDerivatives(lwl, bwl, T, cb),
    lateralZ: zWl - 0.5 * T,
    slamThreshold: ochiThreshold(g, lwl),
    slamRegionX: props.wlMinX + 0.7 * lwl,
    rudderLiftSlope: rudderLiftSlope(def.propulsion.rudderAspectRatio),
  };
}

/** Invert a 6×6 row-major matrix by Gauss–Jordan elimination with partial pivoting. */
export function invert6(m: Float64Array): Float64Array {
  const n = 6;
  const a = Float64Array.from(m);
  const inv = new Float64Array(36);
  for (let i = 0; i < n; i++) inv[i * n + i] = 1;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(a[r * n + c]!) > Math.abs(a[piv * n + c]!)) piv = r;
    }
    const pv = a[piv * n + c]!;
    if (Math.abs(pv) < 1e-300) throw new RangeError('Singular mass matrix');
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        swap(a, c * n + k, piv * n + k);
        swap(inv, c * n + k, piv * n + k);
      }
    }
    const s = 1 / pv;
    for (let k = 0; k < n; k++) {
      a[c * n + k]! *= s;
      inv[c * n + k]! *= s;
    }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r * n + c]!;
      if (f === 0) continue;
      for (let k = 0; k < n; k++) {
        a[r * n + k]! -= f * a[c * n + k]!;
        inv[r * n + k]! -= f * inv[c * n + k]!;
      }
    }
  }
  return inv;
}

function swap(a: Float64Array, i: number, j: number): void {
  const t = a[i]!;
  a[i] = a[j]!;
  a[j] = t;
}
