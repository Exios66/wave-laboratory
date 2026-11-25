/**
 * Volumetric cloud deck: the geometry and the light model the sky shader marches through
 * (`CLOUD_GLSL` in ../ocean/shaders.ts mirrors every function here).
 *
 * The deck is a horizontal slab anchored to the world. Its coverage is the sky's existing 2D
 * noise field. Inside the slab an analytic vertical profile gives flat bases and towering tops
 * where the coverage is thickest. That is cumulus in fair weather, and a low, deep deck in storms.
 *
 * Light at a sample inside the cloud:
 *  - sunlight through the cloud toward the sun, Beer–Lambert with a "powder" term. A thin edge is
 *    half lit, the light peaks just inside where forward scattering builds up, then it decays;
 *  - a two-lobe Henyey–Greenstein phase function, strongly forward (silver linings when the sun is
 *    behind a cloud) with a weak back lobe (sunlit faces seen with the sun behind the viewer);
 *  - the sky's ambient light, darker toward the base.
 */

/** Longest path through the deck that is marched [km]; grazing rays beyond it are faded out. */
export const CLOUD_PATH_CAP_KM = 8;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Base and top of the deck [km above the sea] for a cloud cover 0–1. Fair-weather cumulus sit at
 * 1.2 km and are 0.35 km deep; a storm deck drops to 0.6 km and is 2.4 km deep.
 */
export function cloudDeck(cover: number): { baseKm: number; topKm: number } {
  const c = Math.min(1, Math.max(0, cover));
  const baseKm = 1.2 - 0.6 * smoothstep(0.1, 0.85, c);
  const thick = 0.35 + 2.05 * smoothstep(0.1, 1, c);
  return { baseKm, topKm: baseKm + thick };
}

/** Henyey–Greenstein phase function [1/sr] for the cosine of the scattering angle. */
export function hgPhase(cosTheta: number, g: number): number {
  const g2 = g * g;
  const denom = Math.pow(Math.max(1 + g2 - 2 * g * cosTheta, 1e-6), 1.5);
  return (1 - g2) / (4 * Math.PI * denom);
}

/** The clouds' phase function: 0.7 forward (g = 0.6) + 0.3 back (g = −0.25). */
export function cloudPhase(cosTheta: number): number {
  return 0.7 * hgPhase(cosTheta, 0.6) + 0.3 * hgPhase(cosTheta, -0.25);
}

/** Share of sunlight reaching a sample at optical depth τ toward the sun (Beer–Lambert + powder). */
export function powderSun(tau: number): number {
  return Math.exp(-tau) - 0.5 * Math.exp(-3 * tau);
}

/**
 * Where a ray from an eye at height `eyeKm` with vertical direction component `dirY` (unit ray)
 * runs through the slab [baseKm, topKm]: distances [t0, t1] along it [km], with the length capped
 * at `capKm`, or null when it misses.
 */
export function slabSpan(
  eyeKm: number,
  dirY: number,
  baseKm: number,
  topKm: number,
  capKm: number,
): [number, number] | null {
  const inside = eyeKm >= baseKm && eyeKm <= topKm;
  if (Math.abs(dirY) < 1e-4) return inside ? [0, capKm] : null;
  const ta = (baseKm - eyeKm) / dirY;
  const tb = (topKm - eyeKm) / dirY;
  const t0 = Math.max(0, Math.min(ta, tb));
  const t1 = Math.max(ta, tb);
  if (t1 <= 0) return null;
  return [t0, Math.min(t1, t0 + capKm)];
}
