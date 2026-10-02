/** How fair the weather looks: drives wildlife, birds and the pleasant-sailing mood. */

function smoothstep(a: number, b: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/**
 * Target calm from the sea state. 1 = flat calm fair weather, 0 = storm.
 * Up to about 1.8 m H_s in a fresh breeze is still fully "calm"; a moderate 2.5 m sea is
 * mostly fair, and it is gone by 4 m or a gale.
 * `storminess` (0–1), when given by a weather system, can only make things rougher.
 */
export function calmFromConditions(hs: number, windSpeed: number, storminess = 0): number {
  const severity = Math.max(hs / 4, windSpeed / 18, storminess);
  return 1 - smoothstep(0.45, 1, severity);
}

/** Ease `current` toward `target` with time constant `tau` seconds. */
export function ease(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}
