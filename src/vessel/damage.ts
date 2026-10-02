/**
 * Structural damage ("health") of a vessel.
 *
 * Health is a fraction 0–1 (1 = intact, 0 = disabled). It is a lumped index of the hull girder,
 * machinery and steering gear rather than a finite-element model: each source below removes
 * health at a rate that is zero in ordinary service and grows with how far the load exceeds a
 * structural limit. Small craft are more fragile than large ships (their scantlings, freeboard
 * and reserve buoyancy are smaller), so every weather/seaway source is multiplied by a size
 * factor (L_ref / L)^½, and collision damage is the impact energy over the vessel's own mass.
 *
 * Sources:
 *  - Slamming: per slam, D = K_slam · f · ((a_bow − a_lim) / g)², a_bow the peak vertical bow
 *    acceleration of the slam and a_lim = 0.5 g (the bow acceleration beyond which NORDFORSK
 *    1987 advises masters to slow down; bottom-impact design loads are 1–1.5 g). A slam is one
 *    excursion of the bow acceleration above a_lim while the forefoot is slamming.
 *  - Green water: a head of water h on deck presses ρgh on hatches and fittings, which shrug
 *    off ~1 m (≈10 kPa): K_green · f · (h − 1 m) / 1 m per second.
 *  - Weather: wind above storm force (Beaufort 10, 24.5 m/s) strains rigging, windows and
 *    superstructure, K_wind · f · ((U − 24.5) / 24.5)² per second.
 *  - Heel: large roll shifts cargo and racks the structure, K_heel · f · ((φ − 25°) / 10°)² per
 *    second.
 *  - Collision: D = E / (½ m V_ref²), E the share of the dissipated impact energy (see
 *    {@link collisionDamage}).
 *  - Capsize ends with health 0.
 *
 * Effects: available propulsion (engine power or the canvas the rigging can carry) scales with
 * {@link thrustFactor}; below 25 % health the steering gear weakens ({@link steeringFactor}); at
 * 0 the vessel is disabled — engine and rudder dead, drifting.
 */

export type DamageCause = 'slamming' | 'green-water' | 'weather' | 'heel' | 'collision' | 'capsize';

/** Reference length of the size factor [m]. */
export const REFERENCE_LENGTH = 100;
/** Bow acceleration a slam must exceed before it damages the structure [g]. */
export const SLAM_LIMIT_G = 0.5;
/** Health lost per slam per (excess g)² for the reference ship. */
export const K_SLAM = 0.06;
/** Depth of water over the deck edge the deck withstands [m]. */
export const GREEN_WATER_LIMIT = 1;
/** Health lost per second per metre of green water beyond the limit (reference ship). */
export const K_GREEN = 0.003;
/** Storm force (Beaufort 10) [m/s] and the health rate per unit relative excess² [1/s]. */
export const STORM_WIND = 24.5;
export const K_WIND = 0.0006;
/** Heel at which structural/cargo stress begins [deg], scale of the excess [deg], rate [1/s]. */
export const HEEL_LIMIT_DEG = 25;
export const HEEL_SCALE_DEG = 10;
export const K_HEEL = 0.006;
/** Closing speed whose kinetic energy (on the vessel's own mass) wrecks it [m/s]. */
export const COLLISION_REFERENCE_SPEED = 5;
/** Health below which the steering gear degrades. */
export const STEERING_DAMAGE_HEALTH = 0.25;
/** Damage per step below this is not reported as a cause. */
const CAUSE_MIN = 1e-6;
/** How long the latest cause is reported after its last damage [s]. */
export const CAUSE_HOLD = 5;

const G = 9.80665;

/** Size factor (L_ref / L)^½, limited to 0.4–2.5: small craft suffer more. */
export function sizeFactor(length: number): number {
  const f = Math.sqrt(REFERENCE_LENGTH / Math.max(length, 1));
  return Math.min(2.5, Math.max(0.4, f));
}

/** Health lost by one slam with peak vertical bow acceleration `accel` [m/s²]. */
export function slamDamage(accel: number, length: number): number {
  const excess = Math.abs(accel) / G - SLAM_LIMIT_G;
  return excess > 0 ? K_SLAM * sizeFactor(length) * excess * excess : 0;
}

/** Health lost per second to wind above storm force (`wind` = 10 m speed [m/s]). */
export function windDamageRate(wind: number, length: number): number {
  const x = (wind - STORM_WIND) / STORM_WIND;
  return x > 0 ? K_WIND * sizeFactor(length) * x * x : 0;
}

/** Health lost per second at heel angle `heelDeg` (from upright) [deg]. */
export function heelDamageRate(heelDeg: number, length: number): number {
  const x = (Math.abs(heelDeg) - HEEL_LIMIT_DEG) / HEEL_SCALE_DEG;
  return x > 0 ? K_HEEL * sizeFactor(length) * x * x : 0;
}

/** Health lost per second with `depth` [m] of water over the deck edge. */
export function greenWaterDamageRate(depth: number, length: number): number {
  const x = (depth - GREEN_WATER_LIMIT) / GREEN_WATER_LIMIT;
  return x > 0 ? K_GREEN * sizeFactor(length) * x : 0;
}

/**
 * Health a vessel of `mass` [kg] loses when it absorbs `energy` [J] of impact energy: the
 * energy over the kinetic energy of its own mass at the reference closing speed. A carrier
 * ramming a lifeboat wrecks the lifeboat and barely scratches the carrier.
 */
export function collisionDamage(energy: number, mass: number): number {
  if (!(energy > 0) || !(mass > 0)) return 0;
  return energy / (0.5 * mass * COLLISION_REFERENCE_SPEED ** 2);
}

/**
 * Fraction of full propulsion a vessel at `health` can deliver: the damaged plant still gives
 * 20 % plus a share proportional to health, and nothing once disabled.
 */
export function thrustFactor(health: number): number {
  if (health <= 0) return 0;
  return Math.min(1, 0.2 + 0.8 * health);
}

/** Fraction of the steering gear's rudder rate/angle left at `health` (1 above 25 %). */
export function steeringFactor(health: number): number {
  if (health <= 0) return 0;
  if (health >= STEERING_DAMAGE_HEALTH) return 1;
  return 0.2 + 0.8 * (health / STEERING_DAMAGE_HEALTH);
}

/** Seaway/weather state of one step that drives damage. */
export interface DamageInputs {
  dt: number;
  slamming: boolean;
  /** Vertical bow acceleration [m/s²]. */
  bowAccel: number;
  /** Deepest water over the deck edge, 0 when the deck is dry [m]. */
  greenWaterDepth: number;
  /** True wind speed at the vessel [m/s]. */
  windSpeed: number;
  /** Heel from upright [deg]. */
  heelDeg: number;
  capsized: boolean;
}

/** Health bookkeeping for one vessel. */
export class DamageModel {
  health = 1;
  /** Most recent significant cause (null after {@link CAUSE_HOLD} s without damage). */
  cause: DamageCause | null = null;
  enabled: boolean;
  private causeAge = Infinity;
  /** Peak bow acceleration of the slam in progress [m/s²] (0 = none). */
  private slamPeak = 0;

  constructor(
    readonly length: number,
    enabled = true,
  ) {
    this.enabled = enabled;
  }

  get disabled(): boolean {
    return this.health <= 0;
  }

  /** Advance by one step. */
  step(i: DamageInputs): void {
    this.causeAge += i.dt;
    if (this.causeAge > CAUSE_HOLD) this.cause = null;
    if (!this.enabled) return;
    const L = this.length;
    if (i.capsized) {
      if (this.health > 0) this.damage(this.health, 'capsize');
      return;
    }
    // Slams: one slam lasts while the bow acceleration stays above the limit; health falls as
    // its peak grows, so a slam costs slamDamage(peak) in total.
    const a = Math.abs(i.bowAccel);
    if (a <= SLAM_LIMIT_G * G) {
      this.slamPeak = 0;
    } else if (i.slamming && a > this.slamPeak) {
      const d = slamDamage(a, L) - slamDamage(this.slamPeak, L);
      this.slamPeak = a;
      this.damage(d, 'slamming');
    }
    // Continuous sources: report the strongest one as the cause.
    const green = greenWaterDamageRate(i.greenWaterDepth, L);
    const wind = windDamageRate(i.windSpeed, L);
    const heel = heelDamageRate(i.heelDeg, L);
    const total = (green + wind + heel) * i.dt;
    if (total > 0) {
      const cause: DamageCause =
        green >= wind && green >= heel ? 'green-water' : wind >= heel ? 'weather' : 'heel';
      this.damage(total, cause);
    }
  }

  /** Remove `amount` of health (ignored when damage is off). */
  damage(amount: number, cause: DamageCause): void {
    if (!this.enabled || !(amount > 0) || this.health <= 0) return;
    this.health = Math.max(0, this.health - amount);
    if (amount >= CAUSE_MIN || this.health === 0) {
      this.cause = cause;
      this.causeAge = 0;
    }
  }

  repair(): void {
    this.health = 1;
    this.cause = null;
    this.causeAge = Infinity;
    this.slamPeak = 0;
  }
}
