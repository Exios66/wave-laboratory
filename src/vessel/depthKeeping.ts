/**
 * Depth keeping for a submerged, neutrally buoyant submarine: bow and stern hydroplanes.
 *
 * Plane lift (thin-wing theory, Prandtl's lifting-line slope for a low-aspect-ratio plane):
 *     L = ½ ρ A U |U| C_Lα α,   C_Lα = 2π Λ / (Λ + 2),   α = δ − w_p / U (local flow angle),
 * with induced drag C_D = C_D0 + C_L² / (π Λ e). The w_p / U term is the plane's own heave
 * damping: it opposes any vertical or pitching motion in proportion to the speed.
 *
 * Control law: PID on the *low-pass filtered* depth (a pressure sensor and a depth-keeping
 * loop do not chase the surface swell: its orbital motion at 4–15 s would saturate the planes
 * for nothing) gives a desired heave force; PD on pitch gives a desired pitching moment. Both
 * are turned into plane lifts by solving the two-plane allocation
 *     L_b + L_s = F_z,     x_b L_b + x_s L_s = −M_y     (M_y > 0 is bow down)
 * and then into plane angles through the dynamic pressure, so authority falls with U²: the
 * angles saturate (and a slow boat simply cannot hold her depth against a net weight) exactly
 * as a real boat's planes do. Like a real boat, she also trims a variable-ballast tank: the
 * integral of the depth error is not asked of the planes but pumped aboard as ballast water
 * (at most 1.2 % of her displacement), so a net buoyancy error — such as the lift lost when the
 * sail goes under at a deeper ordered depth — is cancelled at any speed, even at rest.
 *
 * Depth is positive downward; the planes lift upward for positive angles.
 */
import { clamp } from '../core/mathUtil';
import type { DivePlane, SubmarineSpec } from './api';
import { rateLimit } from './control';

const DEG = Math.PI / 180;
/** Plane section zero-lift drag and span efficiency. */
const PLANE_CD0 = 0.012;
const PLANE_EFFICIENCY = 0.8;
/** Local flow angle at which a plane stalls [rad]; lift is held beyond it. */
const PLANE_STALL = 18 * DEG;
/** Below this speed through the water the planes have no authority and are left centred [m/s]. */
const MIN_SPEED = 0.4;

/** Closed-loop design: heave and pitch natural frequencies [rad/s] and damping ratios. */
export const DEPTH_OMEGA = 0.07;
export const DEPTH_ZETA = 0.9;
/** Time constants of the depth filter and of the integral term [s]. */
export const DEPTH_FILTER_TAU = 12;
export const DEPTH_INTEGRAL_TAU = 80;
/** Pitch loop: stiffness and rate gains as fractions of the pitch inertia (1/s², 1/s). */
export const PITCH_STIFFNESS = 0.01;
export const PITCH_DAMPING = 0.07;

/** Lift-curve slope of a plane of aspect ratio Λ [1/rad]. */
export function planeLiftSlope(aspect: number): number {
  return (2 * Math.PI * aspect) / (aspect + 2);
}

export interface PlaneForce {
  /** Body-frame forces [N]: lift (z, up) and drag (x). */
  fz: number;
  fx: number;
}

/**
 * Lift and drag of one plane at deflection `delta` [rad] in a flow of speed `u` along the hull
 * with vertical plane velocity `w` (body frame, up positive), for density `rho`.
 */
export function planeForce(
  p: DivePlane,
  delta: number,
  u: number,
  w: number,
  rho: number,
  out: PlaneForce,
): PlaneForce {
  const speed = Math.abs(u);
  if (speed < 1e-6) {
    out.fz = 0;
    out.fx = 0;
    return out;
  }
  const alpha = clamp(delta - Math.atan2(w, speed), -PLANE_STALL, PLANE_STALL);
  const cl = planeLiftSlope(p.aspect) * alpha;
  const q = 0.5 * rho * p.area * u * Math.abs(u);
  const cd = PLANE_CD0 + (cl * cl) / (Math.PI * p.aspect * PLANE_EFFICIENCY);
  out.fz = q * cl;
  out.fx = -0.5 * rho * p.area * cd * u * Math.abs(u);
  return out;
}

export interface DepthSample {
  /** CoG depth below the mean surface [m, down +], vertical speed [m/s, up +]. */
  depth: number;
  rise: number;
  /** Pitch angle [rad, bow down +] and pitch rate [rad/s]. */
  pitch: number;
  pitchRate: number;
  /** Speed through the water along the hull [m/s]. */
  speed: number;
}

export class DepthKeeper {
  /** Commanded CoG depth [m]. */
  depthCmd: number;
  /** Plane deflections [rad]; positive lifts upward. */
  bow = 0;
  stern = 0;
  /** Filtered depth [m] (NaN until the first sample). */
  filtered = Number.NaN;
  private integral = 0;
  /** Variable-ballast weight force being pumped aboard [N, down +] (see the module header). */
  ballastForce = 0;
  private readonly kz: number;
  private readonly kd: number;
  private readonly kth: number;
  private readonly kq: number;
  private readonly maxRad: number;
  private readonly rateRad: number;

  /**
   * @param spec the boat's planes (body frame)
   * @param heaveMass mass plus heave added mass [kg]
   * @param pitchInertia pitch inertia plus added inertia [kg·m²]
   * @param depth the design (and initial commanded) CoG depth [m]
   * @param ballastLimit capacity of the variable-ballast tank as a weight force [N]
   */
  constructor(
    private readonly spec: SubmarineSpec,
    private readonly rho: number,
    heaveMass: number,
    pitchInertia: number,
    depth: number,
    private readonly ballastLimit: number,
  ) {
    this.depthCmd = depth;
    this.kz = heaveMass * DEPTH_OMEGA * DEPTH_OMEGA;
    this.kd = 2 * DEPTH_ZETA * DEPTH_OMEGA * heaveMass;
    this.kth = PITCH_STIFFNESS * pitchInertia;
    this.kq = PITCH_DAMPING * pitchInertia;
    this.maxRad = spec.maxPlaneDeg * DEG;
    this.rateRad = spec.planeRateDeg * DEG;
  }

  /** Forget the integral and the filter (a new depth order, or a restart). */
  reset(depth: number): void {
    this.integral = 0;
    this.ballastForce = 0;
    this.filtered = depth;
    this.bow = 0;
    this.stern = 0;
  }

  /** Advance the controller by `dt` seconds and move the planes toward the new orders. */
  update(s: DepthSample, dt: number): void {
    if (!Number.isFinite(this.filtered)) this.filtered = s.depth;
    const prev = this.filtered;
    this.filtered += (s.depth - this.filtered) * (1 - Math.exp(-dt / DEPTH_FILTER_TAU));
    const rate = (this.filtered - prev) / dt; // filtered sinking speed [m/s, down +]
    const err = this.depthCmd - this.filtered; // > 0: too shallow, need to go down
    const speed = s.speed;
    const sp = this.spec;
    const xb = sp.bowPlanes.x;
    const xs = sp.sternPlanes.x;
    // Desired heave force (up +) and pitching moment (bow down +).
    const kzI = this.kz / DEPTH_INTEGRAL_TAU;
    // The integral term goes to the ballast tank (anti-windup: it stops at the tank's capacity).
    const iMax = this.ballastLimit / kzI;
    this.integral = clamp(this.integral + err * dt, -iMax, iMax);
    this.ballastForce = kzI * this.integral;
    const fz = -this.kz * err + this.kd * rate;
    const my = -this.kth * s.pitch - this.kq * s.pitchRate;
    // Allocation (bow plane at +xb, stern plane at xs < xb).
    const lb = (-my - xs * fz) / (xb - xs);
    const ls = fz - lb;
    let targetB = 0;
    let targetS = 0;
    if (Math.abs(speed) >= MIN_SPEED) {
      const slopeB = planeLiftSlope(sp.bowPlanes.aspect);
      const slopeS = planeLiftSlope(sp.sternPlanes.aspect);
      const qb = 0.5 * this.rho * sp.bowPlanes.area * speed * Math.abs(speed) * slopeB;
      const qs = 0.5 * this.rho * sp.sternPlanes.area * speed * Math.abs(speed) * slopeS;
      targetB = clamp(lb / qb, -this.maxRad, this.maxRad);
      targetS = clamp(ls / qs, -this.maxRad, this.maxRad);
    }
    this.bow = rateLimit(this.bow, targetB, this.rateRad, dt);
    this.stern = rateLimit(this.stern, targetS, this.rateRad, dt);
  }

  /** Lift both planes give at speed `u` and half their range [N]: the control authority. */
  authority(u: number): number {
    const sp = this.spec;
    const a =
      sp.bowPlanes.area * planeLiftSlope(sp.bowPlanes.aspect) +
      sp.sternPlanes.area * planeLiftSlope(sp.sternPlanes.aspect);
    return 0.5 * this.rho * u * u * a * this.maxRad * 0.5;
  }
}
