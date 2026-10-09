/**
 * Low-aspect-ratio lifting foils: the fin keel of a yacht (and later daggerboards or dive
 * planes). A foil in oblique flow carries a lift force perpendicular to the flow and an induced
 * plus profile drag along it.
 *
 * Lift slope from lifting-line theory for a finite wing (Helmbold 1942, valid down to very small
 * aspect ratios where Prandtl's 2πΛ/(Λ + 2) overpredicts):
 *     dC_L/dα = 2π Λ / (2 + √(Λ² + 4)).
 * A keel hung from a hull sees the hull as an end plate and the free surface as a mirror, so its
 * effective aspect ratio is larger than the geometric span²/area (Larsson & Eliasson 2014,
 * §6.2: factor 1.5–2); `END_PLATE` is the factor used. Below the stall angle C_L = slope · α and
 * C_D = C_D0 + C_L²/(π Λ_e); past it the flow separates and the foil behaves as a flat plate,
 * C_L = 1.1 sin 2α, C_D = C_D0 + 1.2 sin² α, blended over 12°.
 */
import type { LateralFoil } from './api';

/** Ratio of effective to geometric aspect ratio of a hull-mounted keel. */
export const END_PLATE = 1.7;
/** Keel section stall angle [rad] (symmetric NACA 00xx sections stall at 14–18° at this Re). */
export const FOIL_STALL = (16 * Math.PI) / 180;
/** Profile drag coefficient on the planform area (includes the bulb's friction). */
export const KEEL_CD0 = 0.018;

const BLEND = (12 * Math.PI) / 180;

/** Helmbold lift-curve slope [1/rad] of a wing with aspect ratio `aspect`. */
export function helmboldSlope(aspect: number): number {
  return (2 * Math.PI * aspect) / (2 + Math.sqrt(aspect * aspect + 4));
}

export interface FoilAero {
  slope: number;
  /** Effective aspect ratio used for induced drag. */
  aspectEff: number;
}

export function foilAero(foil: LateralFoil): FoilAero {
  const aspectEff = foil.aspect * END_PLATE;
  return { slope: helmboldSlope(aspectEff), aspectEff };
}

/** Lift and drag coefficients at angle of attack `alpha` [rad] (C_L odd in α, C_D even). */
export function foilCoefficients(
  alpha: number,
  aero: FoilAero,
  cd0 = KEEL_CD0,
): { cl: number; cd: number } {
  const a = Math.abs(alpha);
  const attached = aero.slope * Math.min(a, FOIL_STALL);
  const cdAttached = cd0 + (attached * attached) / (Math.PI * aero.aspectEff);
  const t = Math.min(1, Math.max(0, (a - FOIL_STALL) / BLEND));
  const w = t * t * (3 - 2 * t);
  const clPlate = 1.1 * Math.sin(2 * Math.min(a, Math.PI / 2));
  const cdPlate = cd0 + 1.2 * Math.sin(a) ** 2;
  return {
    cl: Math.sign(alpha) * ((1 - w) * attached + w * clPlate),
    cd: (1 - w) * cdAttached + w * cdPlate,
  };
}

export interface FoilForce {
  /** Force in the body frame [N] (the foil lies in the x–z plane). */
  fx: number;
  fy: number;
}

/**
 * Force of a foil in the flow of water velocity (relative to the foil, body frame) given by the
 * foil's own velocity (u, v) through the water [m/s]. Handles astern flow by symmetry.
 */
export function foilForce(
  u: number,
  v: number,
  area: number,
  aero: FoilAero,
  rho: number,
  out: FoilForce,
  cd0 = KEEL_CD0,
): FoilForce {
  const speed = Math.hypot(u, v);
  if (speed < 1e-6) {
    out.fx = out.fy = 0;
    return out;
  }
  const dir = u >= 0 ? 1 : -1;
  const alpha = Math.atan2(v, Math.abs(u));
  const { cl, cd } = foilCoefficients(alpha, aero, cd0);
  const q = 0.5 * rho * speed * speed * area;
  // Velocity direction d = (u, v)/V. Drag opposes it; lift is perpendicular, opposing the
  // lateral component (reversed for astern flow).
  const dx = u / speed;
  const dy = v / speed;
  const lx = -dy;
  const ly = dx;
  out.fx = -q * cd * dx - dir * q * cl * lx;
  out.fy = -q * cd * dy - dir * q * cl * ly;
  return out;
}
