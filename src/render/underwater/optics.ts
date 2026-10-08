/**
 * Pure helpers for the underwater view (no Three.js, so they are unit tested directly).
 *
 * The renderer uses them to decide when the eye is under the sea, how the water absorbs light
 * along a ray (per-channel Beer–Lambert with the Jerlov K_d) and what colour the veiling
 * in-scatter takes at a given depth, time of day and water type. The GLSL in
 * `UnderwaterPass.ts` and the ocean shader mirrors the same formulas.
 */

/** Refractive index of sea water relative to air. */
export const WATER_INDEX = 1.333;

/** Hysteresis band either side of the surface [m]: stops flicker at the waterline. */
export const SURFACE_HYSTERESIS = 0.15;

export type Rgb = readonly [number, number, number];

/**
 * Half-angle of Snell's window [rad]: light from the whole sky above arrives inside this cone
 * about the vertical, asin(1/n) ≈ 48.6° for sea water. Outside it the surface mirrors the sea.
 */
export function snellWindowHalfAngle(n = WATER_INDEX): number {
  return Math.asin(1 / n);
}

/** Light of colour `rgb` after travelling `d` metres through water with attenuation `kd` [1/m]. */
export function attenuate(rgb: Rgb, kd: Rgb, d: number): [number, number, number] {
  const path = Math.max(0, d);
  return [
    rgb[0] * Math.exp(-kd[0] * path),
    rgb[1] * Math.exp(-kd[1] * path),
    rgb[2] * Math.exp(-kd[2] * path),
  ];
}

/** Share of the surface light still present at depth, so the deep never goes pure black. */
const DEPTH_FLOOR = 0.03;
/** The veil is lit from above, so it is brighter than the body colour seen from the air. */
const VEIL_GAIN = 3;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Colour of the water itself (the in-scatter every ray fades to). It is the Jerlov body colour,
 * lit by the sun and sky, dimmed per channel with depth (red goes first) and darker at night.
 * `sunLevel` is 0–1 daylight after cloud; `night` is 0–1.
 */
export function underwaterInscatter(
  scatter: Rgb,
  kd: Rgb,
  depth: number,
  sunLevel: number,
  night: number,
): [number, number, number] {
  const lit = clamp01(sunLevel) * (1 - 0.8 * clamp01(night));
  const d = Math.max(0, depth);
  const at = (i: 0 | 1 | 2) =>
    scatter[i] * VEIL_GAIN * lit * Math.max(DEPTH_FLOOR, Math.exp(-kd[i] * d));
  return [at(0), at(1), at(2)];
}

/**
 * Whether the eye is under the sea. `eta` is the surface height above the eye's position; the
 * state only flips once the eye is more than {@link SURFACE_HYSTERESIS} past the surface.
 */
export function nextUnderwaterState(
  camY: number,
  eta: number,
  prev: boolean,
  hysteresis = SURFACE_HYSTERESIS,
): boolean {
  return prev ? camY <= eta + hysteresis : camY < eta - hysteresis;
}

/** Highest the eye may be and still be wholly under the surface. */
export function clampBelowSurface(y: number, eta: number, margin: number): number {
  return Math.min(y, eta - margin);
}

/**
 * View-space distance from a reversed-depth buffer value (1 at the near plane, 0 at far):
 * z = n (f − d) / (d (f − n))  ⇒  d = n f / (n + z (f − n)).
 */
export function linearizeReversedDepth(z: number, near: number, far: number): number {
  return (near * far) / (near + z * (far - near));
}

/** The same for a conventional depth buffer value (0 at near, 1 at far). */
export function linearizeDepth(z: number, near: number, far: number): number {
  return (2 * near * far) / (far + near - (2 * z - 1) * (far - near));
}

/**
 * Scalar fog density [1/m] for the fallback path (no half-float target): the green-channel
 * K_d, used with the squared-exponential FogExp2 law, matches the transmission at 1/K_d.
 */
export function fallbackFogDensity(kd: Rgb): number {
  return Math.max(0.004, kd[1]);
}
