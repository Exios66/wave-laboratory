/**
 * Fore-and-aft (Bermuda) sail forces: apparent wind, lift/drag of a mainsail and headsail, a
 * sheet that trims for drive and eases to limit heel.
 *
 * All wind quantities are in the horizontal "heading frame" (x forward along the boat's
 * heading, y to port). The apparent wind is the air velocity relative to the boat,
 *     V_a = V_true − V_boat,   β = atan2(−V_ay, −V_ax)  (angle it comes FROM; + = from port).
 *
 * Each sail is a lifting surface with boom (sheet) angle δ from the centre line, on the lee side
 * (δ > 0 = sail to starboard, wind from port). The angle of attack is α = β − δ (mirrored for
 * the other tack). Lift is perpendicular to the apparent wind and drag along it:
 *     F = ½ ρ V_a² A (C_L l + C_D d),  l = (sin β, −cos β sgn β),  d = (−cos β, −sin β sgn β).
 * Coefficients (Marchaj 1996; Larsson & Eliasson 2014, ch. 5):
 *   - attached flow  C_L = a (α + α₀) with a = Helmbold slope of the sail's aspect ratio and the
 *     zero-lift offset α₀ from camber; C_D = C_D0 + C_L²/(π Λ);
 *   - the sail luffs for α ≲ 0 (lift fills in over 0–5°) and stalls at α_s, blending over 10°
 *     into a cambered plate C_L = 1.1 sin 2α, C_D = C_D0 + 1.25 sin² α, the drag-dominated
 *     regime of a spinnaker-less run (α → 90° with the boom out gives C_D ≈ 1.3);
 *   - the headsail loses lift in the wind shadow of the main when running (b > 135°).
 * Heel φ tips the sail plan out of the wind: the exposed area falls with cos²φ.
 *
 * Auto-sheeting scans the boom angle for the largest driving force F_x, then eases both sheets
 * together (spilling wind) until the heeling moment is below what the boat can carry at the
 * heel limit. The no-go zone emerges: closer than α_s + ε the best drive is ≤ 0.
 */
import { AIR_DENSITY } from './windLoads';
import type { ForeAftRig, ForeAftSail, Vec3Like } from './sailTypes';
import { helmboldSlope } from './foils';

const DEG = Math.PI / 180;

/** Heel limit the crew trims for [deg]; beyond the corresponding heeling moment sheets are eased. */
export const HEEL_LIMIT_DEG = 25;
/** Sheet speed of the (powered) winches [rad/s]. */
export const SHEET_RATE = 25 * DEG;

export interface SailAero {
  slope: number;
  alpha0: number;
  stall: number;
  cd0: number;
  aspect: number;
}

/** Aerodynamic constants of a sail of the given kind and aspect ratio. */
export function sailAero(kind: ForeAftSail['kind'], aspect: number): SailAero {
  if (!(aspect > 0)) throw new RangeError('Sail aspect ratio must be positive');
  return kind === 'main'
    ? { slope: helmboldSlope(aspect), alpha0: 3 * DEG, stall: 17 * DEG, cd0: 0.035, aspect }
    : { slope: helmboldSlope(aspect), alpha0: 2.5 * DEG, stall: 19 * DEG, cd0: 0.03, aspect };
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Lift and drag coefficients at angle of attack `alpha` [rad] (negative = luffing). */
export function foreAftCoefficients(alpha: number, aero: SailAero): { cl: number; cd: number } {
  if (alpha <= 0) return { cl: 0, cd: aero.cd0 };
  const fill = smooth(0, 5 * DEG, alpha);
  const att = aero.slope * (Math.min(alpha, aero.stall) + aero.alpha0) * fill;
  const cdAtt = aero.cd0 + (att * att) / (Math.PI * aero.aspect);
  const w = smooth(aero.stall, aero.stall + 10 * DEG, alpha);
  const a = Math.min(alpha, Math.PI);
  const clPlate = 1.1 * Math.sin(2 * a);
  const cdPlate = aero.cd0 + 1.25 * Math.sin(a) ** 2;
  return { cl: (1 - w) * att + w * clPlate, cd: (1 - w) * cdAtt + w * cdPlate };
}

export interface ApparentWind {
  /** Speed [m/s] and angle the wind comes from off the bow [rad], + = from port. */
  speed: number;
  beta: number;
  /** Air velocity relative to the boat in the heading frame [m/s]. */
  x: number;
  y: number;
}

/** Apparent wind from the true wind (air velocity, world) and the boat velocity. */
export function apparentWind(
  windU: number,
  windV: number,
  boatU: number,
  boatV: number,
  headingX: number,
  headingY: number,
  out: ApparentWind,
): ApparentWind {
  const ax = windU - boatU;
  const ay = windV - boatV;
  const n = Math.hypot(headingX, headingY) || 1;
  const c = headingX / n;
  const s = headingY / n;
  out.x = c * ax + s * ay;
  out.y = -s * ax + c * ay;
  out.speed = Math.hypot(out.x, out.y);
  out.beta = out.speed > 1e-9 ? Math.atan2(-out.y, -out.x) : 0;
  return out;
}

/** Fraction of the headsail's lift left in the lee of the main when running. */
export function jibShadow(b: number): number {
  return 1 - 0.8 * smooth(135 * DEG, 165 * DEG, b);
}

/** Force on one sail (heading frame) and its point of application (body frame). */
export interface SailItem {
  fx: number;
  fy: number;
  px: number;
  py: number;
  pz: number;
  /** Angle of attack [rad]. */
  alpha: number;
}

const newItem = (): SailItem => ({ fx: 0, fy: 0, px: 0, py: 0, pz: 0, alpha: 0 });

/** Force of one sail at signed sheet angle `delta` [rad] (written into `out`). */
export function sailForce(
  sail: ForeAftSail,
  aero: SailAero,
  wind: ApparentWind,
  delta: number,
  areaFactor: number,
  out: SailItem,
): SailItem {
  const beta = wind.beta;
  const sw = beta >= 0 ? 1 : -1;
  const b = Math.abs(beta);
  const ss = delta > 0 ? 1 : delta < 0 ? -1 : sw;
  const da = Math.abs(delta);
  const alpha = ss * (beta - delta);
  // Clew position and the centroid of the triangle tack–head–clew (the centre of effort).
  const cx = sail.tack.x - sail.foot * Math.cos(da);
  const cy = sail.tack.y - ss * sail.foot * Math.sin(da);
  out.px = (sail.tack.x + sail.head.x + cx) / 3;
  out.py = (sail.tack.y + sail.head.y + cy) / 3;
  out.pz = (sail.tack.z + sail.head.z + sail.tack.z) / 3;
  out.alpha = alpha;
  const area = sail.area * areaFactor * (sail.kind === 'jib' ? jibShadow(b) : 1);
  if (wind.speed < 1e-6 || area <= 0) {
    out.fx = out.fy = 0;
    return out;
  }
  const { cl, cd } = foreAftCoefficients(alpha, aero);
  const q = 0.5 * AIR_DENSITY * wind.speed * wind.speed * area;
  out.fx = q * (cl * Math.sin(b) - cd * Math.cos(b));
  out.fy = -sw * q * (cl * Math.cos(b) + cd * Math.sin(b));
  return out;
}

export interface ForeAftLoad {
  items: SailItem[];
  /** Drag of mast, boom and rigging (heading frame) acting at the mast. */
  rig: SailItem;
  /** Total driving force (heading frame x) and side force (y) [N]. */
  fx: number;
  fy: number;
}

export function emptyForeAftLoad(rig: ForeAftRig): ForeAftLoad {
  return { items: rig.sails.map(newItem), rig: newItem(), fx: 0, fy: 0 };
}

/** Set a sail's sheet angle `delta` (signed rad per sail) and sum the loads on the rig. */
export function foreAftLoad(
  rig: ForeAftRig,
  aeros: SailAero[],
  wind: ApparentWind,
  sheets: ArrayLike<number>,
  set: number,
  heelFactor: number,
  out: ForeAftLoad,
): ForeAftLoad {
  const areaFactor = Math.max(0, Math.min(1, set)) * Math.max(0, heelFactor);
  let fx = 0;
  let fy = 0;
  for (let i = 0; i < rig.sails.length; i++) {
    const it = sailForce(rig.sails[i]!, aeros[i]!, wind, sheets[i]!, areaFactor, out.items[i]!);
    fx += it.fx;
    fy += it.fy;
  }
  // Mast, boom and rigging: pure drag along the apparent wind.
  const r = out.rig;
  const q = 0.5 * AIR_DENSITY * wind.speed * rig.rigDragArea * (0.4 + 0.6 * Math.max(0, set));
  r.fx = wind.speed > 1e-6 ? q * wind.x : 0;
  r.fy = wind.speed > 1e-6 ? q * wind.y : 0;
  r.px = rig.mast.x;
  r.py = 0;
  r.pz = 0.5 * (rig.mast.zFoot + rig.mast.zTop);
  fx += r.fx;
  fy += r.fy;
  out.fx = fx;
  out.fy = fy;
  return out;
}

/** Scratch space for the sheet trim search. */
const scratch = newItem();

/**
 * Sheet-angle magnitudes [rad] of the main (index 0) and headsail that give the most drive in
 * `wind`, then eased together until the heeling moment about the lateral-resistance height
 * `zRef` is no more than `mAllow` [N·m]. `sheetMin`/`sheetMax` bound the boom/sheet angle.
 */
export function autoTrim(
  rig: ForeAftRig,
  aeros: SailAero[],
  wind: ApparentWind,
  set: number,
  heelFactor: number,
  zRef: number,
  mAllow: number,
  out: Float64Array,
): Float64Array {
  const n = rig.sails.length;
  const areaFactor = Math.max(0, Math.min(1, set)) * Math.max(0, heelFactor);
  const sw = wind.beta >= 0 ? 1 : -1;
  const SHEET_MIN = 3 * DEG;
  const SHEET_MAX = 100 * DEG;
  const STEP = 2 * DEG;
  const best = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let bestDrive = -Infinity;
    for (let d = SHEET_MIN; d <= SHEET_MAX + 1e-9; d += STEP) {
      sailForce(rig.sails[i]!, aeros[i]!, wind, sw * d, areaFactor, scratch);
      if (scratch.fx > bestDrive) {
        bestDrive = scratch.fx;
        best[i] = d;
      }
    }
  }
  // Ease both sheets together until the heeling moment is acceptable.
  let eased = 0;
  for (let off = 0; off <= 80 * DEG + 1e-9; off += STEP) {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.min(SHEET_MAX, best[i]! + off);
      sailForce(rig.sails[i]!, aeros[i]!, wind, sw * d, areaFactor, scratch);
      m += Math.abs(scratch.fy) * (scratch.pz - zRef);
    }
    eased = off;
    if (m <= mAllow) break;
  }
  for (let i = 0; i < n; i++) out[i] = sw * Math.min(SHEET_MAX, best[i]! + eased);
  return out;
}

export type { Vec3Like };
