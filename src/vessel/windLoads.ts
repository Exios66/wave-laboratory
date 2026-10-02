/**
 * Aerodynamic loads on a vessel: windage of the hull and superstructure, and sails.
 *
 * Windage (Isherwood/Blendermann-type drag model, Fossen 2011 §10.1):
 *     X = ½ ρ_a C_X A_F |V_a| V_ax,   Y = ½ ρ_a C_Y A_L |V_a| V_ay,
 * with V_a the air velocity relative to the ship in the body frame, so X ∝ cos γ and
 * Y ∝ sin γ of the relative wind angle γ. The lateral force acts at the centroid of the lateral
 * area, shifted 15 % of L toward the windward end (Hughes 1930), which gives the familiar
 * weather-vaning moment; the heeling moment is that force times the centroid height.
 *
 * Sails (square rig): one aerodynamic surface of area A_s set to a fraction `set`, with
 *     C_L(α) = 1.25 sin 2α · f(α),   C_D(α) = 0.08 + 1.2 sin² α,
 * a cambered-plate fit that gives C_L,max ≈ 1.25 near 45° and C_D ≈ 1.3 square to the flow
 * (Marchaj 1996 measured 1.0–1.4 for square sails). f rises smoothly from 0 at α = 8° to 1 at
 * 20°: below that a square sail luffs (its leading edge collapses) and only flaps. Lift is perpendicular and drag parallel to
 * the apparent wind. The crew braces the yards between `minBraceDeg` and square (90°) to
 * maximise drive, which reproduces a square-rigger's inability to point higher than ~60° off
 * the wind. The force falls with cos² of the heel angle (the sail plan tips out of the wind).
 * Square-riggers balance the helm by trimming the head sails against the spanker, so the
 * vessel passes the longitudinal centre of effort it wants (see `Vessel`).
 */
import type { SailPlan, WindageSpec } from './api';

export const AIR_DENSITY = 1.225;
export const WINDAGE_CX = 0.7;
export const WINDAGE_CY = 0.9;
/** Shift of the lateral centre of effort toward the windward end, as a fraction of L. */
export const WINDAGE_CE_SHIFT = 0.15;
/** Apparent wind above which the autopilot crew starts reefing [m/s] (≈ Beaufort 6). */
export const REEF_WIND = 13;

export interface AeroLoad {
  fx: number;
  fy: number;
  mx: number;
  my: number;
  mz: number;
  /** Chosen brace angle [deg] (sign: + yards braced for wind from port). */
  braceDeg: number;
}

export function emptyLoad(): AeroLoad {
  return { fx: 0, fy: 0, mx: 0, my: 0, mz: 0, braceDeg: 90 };
}

/** Windage load for body-frame relative air velocity (vax, vay), written into `out`. */
export function windageLoad(
  w: WindageSpec,
  length: number,
  vax: number,
  vay: number,
  out: AeroLoad,
): AeroLoad {
  const v = Math.hypot(vax, vay);
  if (v < 1e-6) {
    out.fx = out.fy = out.mx = out.my = out.mz = 0;
    return out;
  }
  const half = 0.5 * AIR_DENSITY;
  const fx = half * WINDAGE_CX * w.frontalArea * v * vax;
  const fy = half * WINDAGE_CY * w.lateralArea * v * vay;
  // Air flowing aft (vax < 0) means wind from ahead: the centre of effort moves forward.
  const xCe = w.lateralCentre.x - WINDAGE_CE_SHIFT * length * (vax / v);
  out.fx = fx;
  out.fy = fy;
  out.mx = -w.lateralCentre.z * fy;
  out.my = w.frontalCentreZ * fx;
  out.mz = xCe * fy;
  return out;
}

const LUFF_START = (8 * Math.PI) / 180;
const LUFF_FULL = (20 * Math.PI) / 180;

export function sailCoefficients(alpha: number): { cl: number; cd: number } {
  const s = Math.sin(alpha);
  const t = Math.min(1, Math.max(0, (Math.abs(alpha) - LUFF_START) / (LUFF_FULL - LUFF_START)));
  const fill = t * t * (3 - 2 * t);
  return { cl: 1.25 * Math.sin(2 * alpha) * fill, cd: 0.08 + 1.2 * s * s };
}

/**
 * Sail load for body-frame relative air velocity (vax, vay) with a fraction `set` of canvas
 * and heel factor cos²φ, braced for maximum drive. Written into `out`.
 */
export function sailLoad(
  plan: SailPlan,
  vax: number,
  vay: number,
  set: number,
  heelFactor: number,
  out: AeroLoad,
  /** Longitudinal centre of effort after the crew balances the helm (default: plan centre). */
  centreX = plan.centre.x,
): AeroLoad {
  const v = Math.hypot(vax, vay);
  const area = plan.area * Math.max(0, Math.min(1, set)) * Math.max(0, heelFactor);
  if (v < 1e-6 || area <= 0) {
    out.fx = out.fy = out.mx = out.my = out.mz = 0;
    out.braceDeg = 90;
    return out;
  }
  // Angle the wind comes FROM, off the bow (+ = from port); work on the port side.
  const beta = Math.atan2(-vay, -vax);
  const side = beta >= 0 ? 1 : -1;
  const b = Math.abs(beta);
  const dx = -Math.cos(b);
  const dy = -Math.sin(b);
  const lx = Math.sin(b);
  const ly = -Math.cos(b);
  const minBrace = (plan.minBraceDeg * Math.PI) / 180;
  let best = -Infinity;
  let bestX = 0;
  let bestY = 0;
  let bestPhi = Math.PI / 2;
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const phi = minBrace + ((Math.PI / 2 - minBrace) * i) / steps;
    const { cl, cd } = sailCoefficients(b - phi);
    const cx = cd * dx + cl * lx;
    if (cx > best) {
      best = cx;
      bestX = cx;
      bestY = cd * dy + cl * ly;
      bestPhi = phi;
    }
  }
  const q = 0.5 * AIR_DENSITY * v * v * area;
  const fx = q * bestX;
  const fy = q * bestY * side;
  const c = plan.centre;
  out.fx = fx;
  out.fy = fy;
  out.mx = -c.z * fy;
  out.my = c.z * fx;
  out.mz = centreX * fy - c.y * fx;
  out.braceDeg = (side * bestPhi * 180) / Math.PI;
  return out;
}

/** Canvas the autopilot crew carries for an apparent wind [m/s]: full sail up to `REEF_WIND`. */
export function reefedSet(apparentWind: number): number {
  return apparentWind <= REEF_WIND ? 1 : (REEF_WIND / apparentWind) ** 2;
}
