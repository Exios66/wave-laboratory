/**
 * Ship control: PID heading autopilot with yaw-rate damping, PI speed governor and a
 * rate-limited steering gear.
 *
 * Heading controller (Fossen 2011, "Handbook of Marine Craft Hydrodynamics", §15.2):
 *     δ_c = K_p e − K_d r + K_i ∫e dt,   e = ψ_d − ψ (wrapped), r = yaw rate,
 * positive rudder turns to port (increases ψ). The gains are scheduled with the Nomoto time
 * constant T ≈ T'·L/U (T' ≈ 1.5 for merchant ships), so the closed loop behaves similarly for
 * a lifeboat and a container ship: K_d = K_p T_d with T_d ∝ T, and the integral time is
 * 8 T_d. The integrator only runs close to the set-point (|e| < 10°) and is frozen while the
 * rudder is saturated (anti-windup).
 *
 * Speed governor: throttle = (V_d/V_max)² (resistance ∝ V² feed-forward) + PI on the speed
 * error through the water.
 */
import { clamp } from '../core/mathUtil';
import { wrapAngle } from '../core/units';

export const HEADING_KP = 1.2;
/** Heading error beyond which the proportional term saturates [rad]. */
export const HEADING_ERROR_LIMIT = (15 * Math.PI) / 180;
/** Nomoto time-constant coefficient T' (T = T' L / U). */
export const NOMOTO_T = 1.5;

export class Autopilot {
  private headingIntegral = 0;
  private speedIntegral = 0;

  reset(): void {
    this.headingIntegral = 0;
    this.speedIntegral = 0;
  }

  /**
   * Rudder command [rad] (positive = to port).
   * @param yawError desired − actual yaw [rad] (any range; wrapped here)
   * @param yawRate body yaw rate r [rad/s]
   * @param speed speed through the water [m/s]
   * @param length waterline length [m]
   */
  rudder(
    yawError: number,
    yawRate: number,
    speed: number,
    length: number,
    maxRudder: number,
    dt: number,
  ): number {
    const e = wrapAngle(yawError);
    const tNomoto = (NOMOTO_T * length) / Math.max(Math.abs(speed), 0.5);
    const td = clamp(tNomoto, 1, 60);
    const kp = HEADING_KP;
    const kd = kp * td;
    const ki = kp / (8 * td);
    // Limiting the proportional error bounds the commanded turn rate (≈ e_max / T_d) so large
    // course changes are made at a steady rate of turn instead of overshooting.
    const ep = clamp(e, -HEADING_ERROR_LIMIT, HEADING_ERROR_LIMIT);
    const raw = kp * ep - kd * yawRate + ki * this.headingIntegral;
    const cmd = clamp(raw, -maxRudder, maxRudder);
    if (Math.abs(e) < (10 * Math.PI) / 180 && cmd === raw) this.headingIntegral += e * dt;
    return cmd;
  }

  /** Throttle command −1…1 for a desired speed through the water. */
  throttle(desired: number, actual: number, maxSpeed: number, dt: number): number {
    const r = desired / maxSpeed;
    const ff = Math.sign(r) * r * r;
    const err = (desired - actual) / maxSpeed;
    const kp = 2;
    const ki = 0.05;
    const raw = ff + kp * err + ki * this.speedIntegral;
    const cmd = clamp(raw, -1, 1);
    if (cmd === raw) this.speedIntegral += err * dt;
    return cmd;
  }
}

/** Move `current` toward `target` at no more than `rate`·dt. */
export function rateLimit(current: number, target: number, rate: number, dt: number): number {
  const d = target - current;
  const max = rate * dt;
  return current + (d > max ? max : d < -max ? -max : d);
}
