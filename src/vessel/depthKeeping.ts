/**
 * Depth keeping for a submerged, neutrally buoyant submarine: bow and stern hydroplanes.
 *
 * Plane lift (thin-wing theory, Prandtl's lifting-line slope for a low-aspect-ratio plane):
 *     L = ½ ρ A U |U| C_Lα α,   C_Lα = 2π Λ / (Λ + 2),   α = δ − w_p / U (local flow angle),
 * with induced drag C_D = C_D0 + C_L² / (π Λ e). The w_p / U term is the plane's own heave
 * damping: it opposes any vertical or pitching motion in proportion to the speed.
 *
 * Depth orders are never steps: the reference depth follows the order at a limited vertical
 * speed (slower at low speed, where only the ballast pump can move the boat) and acceleration.
 *
 * Control law: PD on the *low-pass filtered* depth (a pressure sensor and a depth-keeping
 * loop do not chase the surface swell: its orbital motion at 4–15 s would saturate the planes
 * for nothing) gives a desired heave force; PD on pitch gives a desired pitching moment. Both
 * are turned into plane lifts by solving the two-plane allocation
 *     L_b + L_s = F_z,     x_b L_b + x_s L_s = −M_y     (M_y > 0 is bow down)
 * and then into plane angles through the dynamic pressure, so authority falls with U²: the
 * angles saturate (and a slow boat simply cannot hold her depth against a net weight) exactly
 * as a real boat's planes do. The pitch moment is met first; the heave demand is scaled back
 * until neither plane saturates, and the share the planes cannot give goes to the variable-ballast
 * tank (at most 1.2 % of her displacement), which a slew-limited pump moves in minutes, not
 * seconds. The integral of the depth error is also pumped aboard as ballast (it runs only close
 * to the reference, an anti-windup window), so a net buoyancy error — such as the lift lost when
 * the sail goes under at a deeper ordered depth — is cancelled at any speed, even at rest.
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

/** Shallowest keel depth that can be ordered [m]: the hull crown stays ≥ 3 m under the swell. */
export const MIN_KEEL_DEPTH = 10;

/** Closed-loop design: heave and pitch natural frequencies [rad/s] and damping ratios. */
export const DEPTH_OMEGA = 0.06;
export const DEPTH_ZETA = 0.9;
/** Time constants of the depth filter and of the integral term [s]. */
export const DEPTH_FILTER_TAU = 12;
export const DEPTH_INTEGRAL_TAU = 200;
/**
 * Depth-order profile: the reference depth follows an order at no more than a speed-dependent
 * vertical speed (the planes cannot drive a fast dive, the ballast pump a hover only slowly)
 * with a gentle acceleration limit, so no order is ever a step to the loops.
 */
export const REF_SPEED_HOVER = 0.04;
export const REF_SPEED_MAX = 0.4;
export const REF_ACCEL = 0.01;
export const REF_GAIN = 0.08;
/** Time for the pump to move the ballast tank from empty-to-full capacity [s]. */
export const PUMP_TIME = 200;
/** The integral only runs near the reference and while the boat is nearly steady: depth error [m] and sink speed [m/s] windows. */
export const INTEGRAL_WINDOW = 6;
export const INTEGRAL_RATE_WINDOW = 0.08;
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
 * [m/s] with vertical plane velocity relative to the water `w` [m/s] (body frame, up positive),
 * for density `rho` [kg/m³]. The effective angle is capped at ±18°; both forces are zero when
 * |u| < 1e-6 m/s. Writes body-frame forces [N] into `out` and returns that same object; drag
 * opposes `u`, and lift reverses with `u` for a fixed effective angle.
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
  /** Commanded CoG depth [m] (the order). */
  depthCmd: number;
  /** Reference depth [m] and speed [m/s, down +]: the rate-limited profile toward the order. */
  depthRef: number;
  refRate = 0;
  /** Plane deflections [rad]; positive lifts upward. */
  bow = 0;
  stern = 0;
  /** Filtered depth [m] (NaN until the first sample). */
  filtered = Number.NaN;
  /** Variable-ballast weight force being pumped aboard [N, down +] (see the module header). */
  ballastForce = 0;
  /** Fraction of the heave demand the planes could meet at the last update (1 = all). */
  planeShare = 1;
  private integral = 0;
  private readonly kz: number;
  private readonly kd: number;
  private readonly kth: number;
  private readonly kq: number;
  private readonly maxRad: number;
  private readonly rateRad: number;
  private readonly pumpRate: number;

  /**
   * Initialize the depth order and reference with neutral planes and zero ballast force.
   * @param spec the boat's planes (body frame)
   * @param rho water density [kg/m³]
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
    this.depthRef = depth;
    this.kz = heaveMass * DEPTH_OMEGA * DEPTH_OMEGA;
    this.kd = 2 * DEPTH_ZETA * DEPTH_OMEGA * heaveMass;
    this.kth = PITCH_STIFFNESS * pitchInertia;
    this.kq = PITCH_DAMPING * pitchInertia;
    // A plane beyond its stall angle gives no more lift: do not ask for it.
    this.maxRad = Math.min(spec.maxPlaneDeg * DEG, 0.9 * PLANE_STALL);
    this.rateRad = spec.planeRateDeg * DEG;
    this.pumpRate = ballastLimit / PUMP_TIME;
  }

  /**
   * Reset the filter and reference to CoG `depth` [m, down positive], clear the integral and
   * ballast force, and center both planes. Leaves `depthCmd` and `planeShare` unchanged.
   */
  reset(depth: number): void {
    this.integral = 0;
    this.ballastForce = 0;
    this.filtered = depth;
    this.depthRef = depth;
    this.refRate = 0;
    this.bow = 0;
    this.stern = 0;
  }

  /**
   * Advance the depth reference, filter, plane deflections, ballast force, and plane share
   * toward `depthCmd` over a positive `dt` [s]. At |speed| < 0.4 m/s, the planes slew
   * toward center and ballast alone supplies the heave demand.
   */
  update(s: DepthSample, dt: number): void {
    if (!Number.isFinite(this.filtered)) {
      this.filtered = s.depth;
      this.depthRef = s.depth;
    }
    const prev = this.filtered;
    this.filtered += (s.depth - this.filtered) * (1 - Math.exp(-dt / DEPTH_FILTER_TAU));
    const rate = (this.filtered - prev) / dt; // filtered sinking speed [m/s, down +]
    const speed = s.speed;
    const sp = this.spec;
    const steer = Math.abs(speed) >= MIN_SPEED;

    // ---- reference profile toward the order
    const vMax =
      REF_SPEED_HOVER + (REF_SPEED_MAX - REF_SPEED_HOVER) * smooth((Math.abs(speed) - 0.5) / 2);
    const wanted = clamp(REF_GAIN * (this.depthCmd - this.depthRef), -vMax, vMax);
    this.refRate += clamp(wanted - this.refRate, -REF_ACCEL * dt, REF_ACCEL * dt);
    this.depthRef += this.refRate * dt;

    const err = this.depthRef - this.filtered; // > 0: too shallow, need to go down
    // Desired heave force (up +) and pitching moment (bow down +).
    // Gain schedule: at hover only the slow, lagging pump can act, so the loop is detuned
    // (half the bandwidth) there; with way on it is the full design.
    const gain = 0.25 + 0.75 * smooth((Math.abs(speed) - 0.5) / 2);
    const fz = -gain * this.kz * err + Math.sqrt(gain) * this.kd * (rate - this.refRate);
    const my = -this.kth * s.pitch - this.kq * s.pitchRate;

    // ---- plane allocation (bow plane at +xb, stern plane at xs < xb), pitch first: the heave
    // demand is scaled by `share` ∈ [0, 1] until neither plane exceeds its lift limit.
    const xb = sp.bowPlanes.x;
    const xs = sp.sternPlanes.x;
    let share = 0;
    let targetB = 0;
    let targetS = 0;
    if (steer) {
      const dyn = 0.5 * this.rho * speed * Math.abs(speed);
      const qb = dyn * sp.bowPlanes.area * planeLiftSlope(sp.bowPlanes.aspect);
      const qs = dyn * sp.sternPlanes.area * planeLiftSlope(sp.sternPlanes.aspect);
      const maxB = Math.abs(qb) * this.maxRad;
      const maxS = Math.abs(qs) * this.maxRad;
      const lbP = -my / (xb - xs); // lifts for the pitching moment alone
      const lbF = (-xs * fz) / (xb - xs); // and for the whole heave demand
      share = Math.min(room(lbP, lbF, maxB), room(-lbP, fz - lbF, maxS));
      const lb = lbP + share * lbF;
      const ls = -lbP + share * (fz - lbF);
      targetB = clamp(lb / qb, -this.maxRad, this.maxRad);
      targetS = clamp(ls / qs, -this.maxRad, this.maxRad);
    }
    this.planeShare = share;
    this.bow = rateLimit(this.bow, targetB, this.rateRad, dt);
    this.stern = rateLimit(this.stern, targetS, this.rateRad, dt);

    // ---- ballast: the integral term plus whatever heave force the planes cannot give. The
    // integral only runs near the reference (anti-windup) and the tank is slew-limited.
    const kzI = this.kz / DEPTH_INTEGRAL_TAU;
    const iMax = this.ballastLimit / kzI;
    if (Math.abs(err) < INTEGRAL_WINDOW && Math.abs(rate) < INTEGRAL_RATE_WINDOW) {
      this.integral = clamp(this.integral + err * dt, -iMax, iMax);
    }
    const target = clamp(
      kzI * this.integral - (1 - share) * fz,
      -this.ballastLimit,
      this.ballastLimit,
    );
    this.ballastForce = rateLimit(this.ballastForce, target, this.pumpRate, dt);
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

/** Smooth interpolation from 0 to 1, clamped to those values outside x ∈ [0, 1]. */
const smooth = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Available share ∈ [0, 1] of `extra` with |base + share · extra| ≤ limit. Returns 0 when
 * |base| ≥ limit, even if `extra` would reduce it; otherwise returns 1 for |extra| < 1e-12.
 */
export function room(base: number, extra: number, limit: number): number {
  if (Math.abs(base) >= limit) return 0;
  if (Math.abs(extra) < 1e-12) return 1;
  const hi = (limit - base) / extra;
  const lo = (-limit - base) / extra;
  return clamp(Math.max(hi, lo), 0, 1);
}
