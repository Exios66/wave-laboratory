/**
 * Surf where the sea meets rock: how wide and how strong the foam band is for the sea state,
 * and how fast the swash runs. Islands feed it to their shoreline foam; rocks and buoys draw a
 * foam ring sized the same way. Pure, so it is tested in node.
 */

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Below this the band does not shrink further [m]. */
export const SURF_MIN_WIDTH_M = 0.5;
/** Above this it does not grow further [m]. */
export const SURF_MAX_WIDTH_M = 8;
/** The swash speed when the sea has no usable period [rad/s] (the old fixed value). */
export const SWASH_FALLBACK = 0.8;

/**
 * Foam band for significant wave height `hs` [m]: width [m] = 0.8·Hs within 0.5–8 m, strength
 * in [0, 1] rising from a faint lap at Hs 0.2 m to full surf at 2.5 m. `tp` [s] is accepted for
 * symmetry with `swashSpeed`; the band does not depend on it.
 */
export function surfBand(hs: number, _tp: number): { width: number; strength: number } {
  const h = Number.isFinite(hs) ? Math.max(0, hs) : 0;
  return {
    width: clamp(0.8 * h, SURF_MIN_WIDTH_M, SURF_MAX_WIDTH_M),
    strength: smoothstep(0.2, 2.5, h),
  };
}

/** Swash phase speed [rad/s]: one cycle per peak period `tp` [s], never faster than 2 s. */
export function swashSpeed(tp: number): number {
  if (!Number.isFinite(tp)) return SWASH_FALLBACK;
  return (2 * Math.PI) / Math.max(2, tp);
}
