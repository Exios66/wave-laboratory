/**
 * Linear gravity–capillary dispersion relation for finite depth:
 *     ω² = (g k + (σ/ρ) k³) · tanh(k h)
 */

export interface DispersionParams {
  gravity: number;
  depth: number;
  /** Surface tension divided by density, σ/ρ [m³/s²]. */
  tensionOverDensity: number;
}

/** tanh(kh) that is exact and overflow-free for very large kh. */
export function tanhKh(k: number, h: number): number {
  const kh = k * h;
  return kh > 20 ? 1 : Math.tanh(kh);
}

/** Angular frequency ω(k) [rad/s]. */
export function omegaOf(k: number, p: DispersionParams): number {
  if (k <= 0) return 0;
  return Math.sqrt((p.gravity * k + p.tensionOverDensity * k * k * k) * tanhKh(k, p.depth));
}

/** dω/dk [m/s] (group velocity). */
export function groupVelocity(k: number, p: DispersionParams): number {
  if (k <= 0) return Math.sqrt(p.gravity * p.depth);
  const g = p.gravity;
  const s = p.tensionOverDensity;
  const kh = k * p.depth;
  const th = tanhKh(k, p.depth);
  const sech2 = kh > 20 ? 0 : 1 / Math.cosh(kh) ** 2;
  const a = g * k + s * k * k * k;
  const omega = Math.sqrt(a * th);
  return ((g + 3 * s * k * k) * th + a * p.depth * sech2) / (2 * omega);
}

export function phaseVelocity(k: number, p: DispersionParams): number {
  return k > 0 ? omegaOf(k, p) / k : Math.sqrt(p.gravity * p.depth);
}

/** Invert the dispersion relation: wavenumber k for angular frequency ω (Newton, robust). */
export function wavenumberOf(omega: number, p: DispersionParams): number {
  if (omega <= 0) return 0;
  // Start from the deep-water gravity solution, or the shallow-water one if larger.
  let k = Math.max((omega * omega) / p.gravity, omega / Math.sqrt(p.gravity * p.depth));
  for (let i = 0; i < 60; i++) {
    const f = omegaOf(k, p) - omega;
    const df = groupVelocity(k, p);
    const next = k - f / df;
    if (!(next > 0)) {
      k *= 0.5;
      continue;
    }
    if (Math.abs(next - k) < 1e-14 * k) return next;
    k = next;
  }
  return k;
}

/**
 * Depth attenuation of linear dynamic pressure, cosh(k(z+h)) / cosh(kh), for z ≤ 0.
 * Written in exponential form so it never overflows in deep water.
 */
export function pressureAttenuation(k: number, z: number, h: number): number {
  const zc = Math.max(z, -h);
  const num = Math.exp(k * zc) * (1 + Math.exp(-2 * k * (zc + h)));
  const den = 1 + Math.exp(-2 * k * h);
  return num / den;
}

/** Ursell number Ur = H L² / h³ (nonlinearity indicator for shallow-water waves). */
export function ursellNumber(height: number, wavelength: number, depth: number): number {
  return (height * wavelength * wavelength) / (depth * depth * depth);
}

/** Miche breaking-limit steepness H/L = 0.142 tanh(kh). */
export function micheLimit(k: number, depth: number): number {
  return 0.142 * tanhKh(k, depth);
}
