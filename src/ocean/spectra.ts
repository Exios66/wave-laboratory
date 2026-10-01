/**
 * One-dimensional (frequency) wave spectra S(ω) [m²·s/rad] and their parameterisations.
 *
 * References: Hasselmann et al. (1973) JONSWAP; Pierson & Moskowitz (1964);
 * Bouws et al. (1985) TMA; ITTC (1978) two-parameter Bretschneider spectrum.
 */
import { simpson } from '../core/mathUtil';

export type SpectrumShape = 'jonswap' | 'pierson-moskowitz' | 'bretschneider';

export interface FrequencySpectrum {
  /** S(ω) [m² s/rad], one-sided. */
  density(omega: number): number;
  /** Peak angular frequency [rad/s]. */
  omegaPeak: number;
  /** Nominal significant wave height 4√m₀ [m] of this spectrum. */
  hs: number;
}

/** Unnormalised JONSWAP shape g² ω⁻⁵ exp(−5/4 (ωp/ω)⁴) γ^r (α = 1). */
export function jonswapShape(omega: number, omegaPeak: number, gamma: number, g: number): number {
  if (omega <= 0) return 0;
  const sigma = omega <= omegaPeak ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaPeak) ** 2) / (2 * sigma * sigma * omegaPeak * omegaPeak));
  const ratio = omegaPeak / omega;
  return (
    ((g * g) / omega ** 5) * Math.exp(-1.25 * ratio ** 4) * (gamma === 1 ? 1 : Math.pow(gamma, r))
  );
}

/**
 * Kitaigorodskii depth factor φ(ω, h) used by the TMA spectrum (Thompson & Vincent 1983
 * piece-wise approximation).
 */
export function kitaigorodskiiFactor(omega: number, depth: number, g: number): number {
  const wh = omega * Math.sqrt(depth / g);
  if (wh <= 1) return 0.5 * wh * wh;
  if (wh < 2) return 1 - 0.5 * (2 - wh) ** 2;
  return 1;
}

/** Zeroth spectral moment m₀ = ∫S dω, integrated on a range that safely brackets the peak. */
export function zerothMoment(density: (w: number) => number, omegaPeak: number): number {
  return simpson(density, 0.3 * omegaPeak, 30 * omegaPeak, 6000);
}

export interface ShapeOptions {
  shape: SpectrumShape;
  hs: number;
  tp: number;
  gamma: number;
  gravity: number;
  /** Apply TMA depth limitation with this depth (undefined = deep water). */
  tmaDepth?: number;
}

/**
 * Spectrum normalised so that 4√m₀ equals the requested H_s exactly (after any TMA factor),
 * which keeps the user's H_s control honest.
 */
export function makeSpectrum(opts: ShapeOptions): FrequencySpectrum {
  const omegaPeak = (2 * Math.PI) / opts.tp;
  const g = opts.gravity;
  const gamma = opts.shape === 'jonswap' ? opts.gamma : 1;
  const depth = opts.tmaDepth;
  const raw = (w: number): number =>
    jonswapShape(w, omegaPeak, gamma, g) *
    (depth !== undefined ? kitaigorodskiiFactor(w, depth, g) : 1);
  const m0 = zerothMoment(raw, omegaPeak);
  const alpha = m0 > 0 ? (opts.hs * opts.hs) / 16 / m0 : 0;
  return { density: (w) => alpha * raw(w), omegaPeak, hs: opts.hs };
}

export interface WindSeaParameters {
  hs: number;
  tp: number;
  gamma: number;
  /** Whether the sea is fully developed (fetch no longer limits growth). */
  fullyDeveloped: boolean;
  alpha: number;
  omegaPeak: number;
}

/**
 * JONSWAP fetch-limited growth (Hasselmann et al. 1973), capped at the Pierson–Moskowitz
 * fully developed limit:
 *   ω_p = 22 (g²/(U F))^{1/3},   α = 0.076 (U²/(F g))^{0.22},   γ = 3.3
 *   fully developed: ω_p = 0.877 g / U,  α = 0.0081,  γ = 1
 */
export function windSeaParameters(
  windSpeed: number,
  fetchMeters: number,
  gravity: number,
  tmaDepth?: number,
): WindSeaParameters {
  const U = Math.max(windSpeed, 0.5);
  const g = gravity;
  const wpFetch = 22 * Math.cbrt((g * g) / (U * fetchMeters));
  const wpFull = (0.877 * g) / U;
  const fullyDeveloped = wpFetch <= wpFull;
  const omegaPeak = fullyDeveloped ? wpFull : wpFetch;
  const alpha = fullyDeveloped ? 0.0081 : 0.076 * Math.pow((U * U) / (fetchMeters * g), 0.22);
  const gamma = fullyDeveloped ? 1 : 3.3;
  const density = (w: number): number =>
    alpha *
    jonswapShape(w, omegaPeak, gamma, g) *
    (tmaDepth !== undefined ? kitaigorodskiiFactor(w, tmaDepth, g) : 1);
  const m0 = zerothMoment(density, omegaPeak);
  return {
    hs: 4 * Math.sqrt(m0),
    tp: (2 * Math.PI) / omegaPeak,
    gamma,
    fullyDeveloped,
    alpha,
    omegaPeak,
  };
}
