/**
 * Pure math for the GPU spray: the closed-form particle flight (mirrored in the vertex shader),
 * the ring-buffer write planner and the emitter schedulers (slamming sheets, breaking-crest
 * spray, spindrift). No three.js here, so everything is testable in plain node.
 *
 * Flight model. A droplet obeys  dv/dt = -k (v - w) + g,  with linear drag rate k toward the
 * wind w (horizontal) and gravity g = (0, -G, 0). Its terminal velocity is vt = w + g / k and
 *   v(t) = vt + (v0 - vt) e^{-kt}
 *   x(t) = x0 + vt t + (v0 - vt) (1 - e^{-kt}) / k
 * which is exactly  x0 + w t + (v0 - w)(1 - e^{-kt})/k + (g/k)(t - (1 - e^{-kt})/k).
 * The shader evaluates this per vertex from the birth state, so nothing is integrated on the CPU.
 */

export const GRAVITY = 9.81;

export interface FlightParams {
  /** Birth position (three.js coordinates, y up) [m]. */
  x0: number;
  y0: number;
  z0: number;
  /** Birth velocity [m/s]. */
  vx: number;
  vy: number;
  vz: number;
  /** Wind velocity the drag relaxes toward (horizontal) [m/s]. */
  wx: number;
  wz: number;
  /** Drag rate [1/s]. */
  drag: number;
  /** Gravity felt [m/s²] (9.81 times the style's fraction; negative rises, as hot smoke does). */
  g: number;
}

/** Position at age `t` [s]. */
export function flightPosition(p: FlightParams, t: number): [number, number, number] {
  const k = Math.max(p.drag, 1e-6);
  // (1 - e^{-kt}) / k, stable for small kt.
  const e = -Math.expm1(-k * t);
  const f = e / k;
  const vtx = p.wx;
  const vty = -p.g / k;
  const vtz = p.wz;
  return [
    p.x0 + vtx * t + (p.vx - vtx) * f,
    p.y0 + vty * t + (p.vy - vty) * f,
    p.z0 + vtz * t + (p.vz - vtz) * f,
  ];
}

/** Opacity envelope over normalised age u in [0, 1]: quick fade-in, quadratic fade-out. */
export function sprayAlpha(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  return Math.min(1, u * 8) * (1 - u) * (1 - u);
}

/** A write into a ring buffer: `count` slots from `start`. */
export interface RingRange {
  start: number;
  count: number;
}

/**
 * Split a write of `n` slots at cursor `next` of a ring of `capacity` into at most two contiguous
 * ranges (so each becomes one partial buffer upload). Writes longer than the ring keep the
 * newest `capacity` slots.
 */
export function planRingWrite(next: number, n: number, capacity: number): RingRange[] {
  if (capacity <= 0 || n <= 0) return [];
  const count = Math.min(n, capacity);
  const start = (((next + (n - count)) % capacity) + capacity) % capacity;
  const first = Math.min(count, capacity - start);
  const out: RingRange[] = [{ start, count: first }];
  if (first < count) out.push({ start: 0, count: count - first });
  return out;
}

/** Small deterministic generator (mulberry32) for the emitter proxies. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Vertical speed of a point at body offset `r` (world axes, physics z up) on a body moving with
 * linear velocity `v` and angular velocity `w`: v_z + (w x r)_z. For the bow this is how fast the
 * hull meets (or leaves) the water.
 */
export function pointVerticalSpeed(
  v: { z: number },
  w: { x: number; y: number },
  r: { x: number; y: number },
): number {
  return v.z + (w.x * r.y - w.y * r.x);
}

/**
 * Slam strength 0..1 from the bow's vertical speed [m/s]: a gentle plunge throws little, about
 * 8 m/s throws a full sheet.
 */
export function slamStrength(bowVerticalSpeed: number): number {
  return clamp01((Math.abs(bowVerticalSpeed) - 0.8) / 7);
}

/** Beaufort 8 begins at 17.2 m/s; spindrift strength 0..1 rising to a full gale-force sheet at ~32. */
export const SPINDRIFT_ONSET = 17.2;
export function spindriftStrength(wind: number): number {
  return clamp01((wind - SPINDRIFT_ONSET) / 15);
}

/** Fractional-count accumulator: turns a rate into whole emissions without losing the remainder. */
export function drawCount(rate: number, dt: number, carry: number, cap: number): [number, number] {
  const total = Math.max(0, rate) * Math.max(0, dt) + carry;
  const n = Math.min(cap, Math.floor(total));
  // Past the cap the surplus is dropped rather than queued (a stall must not cause a burst).
  return [n, n >= cap ? 0 : total - n];
}

/** A puff of spray torn off a breaking crest near the camera. */
export interface CrestBurst {
  /** Offset from the focus point (three.js x/z) [m]. */
  dx: number;
  dz: number;
  /** Height above the mean surface [m]. */
  height: number;
  /** Particles in the burst. */
  count: number;
  /** Upward launch speed [m/s]. */
  up: number;
}

/**
 * Cheap deterministic proxy for breaking crests. The render side has no CPU ocean, so instead of
 * sampling the surface for steep, foaming crests the bursts are scattered around the focus point
 * at a rate that follows the whitecap onset (about 7 m/s, Beaufort 4) and the sea state (Hs),
 * with a bias toward the camera. Heights ride on the significant wave height. The shader ocean
 * paints foam where its crests really break; this only adds airborne spray in the same
 * conditions, so nothing is ever tied to a specific crest.
 *
 * @param budget particle budget scale (1 at the high tier)
 */
export function scheduleCrestBursts(
  wind: number,
  hs: number,
  dt: number,
  carry: number,
  budget: number,
  rng: () => number,
): { bursts: CrestBurst[]; carry: number } {
  const onset = clamp01((wind - 7) / 8);
  const sea = 0.35 + 0.65 * clamp01(hs / 5);
  const rate = onset * sea * 14 * budget; // bursts per second
  const [n, rest] = drawCount(rate, dt, carry, 24);
  const bursts: CrestBurst[] = [];
  for (let i = 0; i < n; i++) {
    // sqrt-biased radius would favour the far field; squaring the draw favours the camera.
    const u = rng();
    const r = 14 + 190 * u * u;
    const a = rng() * Math.PI * 2;
    bursts.push({
      dx: r * Math.cos(a),
      dz: r * Math.sin(a),
      height: hs * (0.15 + 0.35 * rng()),
      count: 3 + Math.floor(rng() * 6),
      up: 1.2 + 2.5 * onset * rng() + 0.25 * hs,
    });
  }
  return { bursts, carry: rest };
}

/** Particles per second for the spindrift of a given wind speed, before the budget scale. */
export function spindriftRate(wind: number): number {
  const s = spindriftStrength(wind);
  return s <= 0 ? 0 : 140 + 560 * s * s;
}
