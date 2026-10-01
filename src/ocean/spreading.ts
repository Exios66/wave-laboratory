/**
 * Directional spreading functions D(θ; ω) normalised so that ∫_{−π}^{π} D dθ = 1.
 * θ is measured relative to the mean propagation direction.
 */
import { lnGamma } from '../core/mathUtil';
import type { Spreading } from '../schema/experiment';

/** Normalisation constant of cos^{2s}(θ/2): Γ(s+1) / (2√π Γ(s+½)). */
export function cos2sNorm(s: number): number {
  return Math.exp(lnGamma(s + 1) - lnGamma(s + 0.5)) / (2 * Math.sqrt(Math.PI));
}

export function cos2s(theta: number, s: number): number {
  const c = Math.abs(Math.cos(theta / 2));
  return cos2sNorm(s) * Math.pow(c, 2 * s);
}

/** Mitsuyasu et al. (1975) frequency-dependent spreading exponent. */
export function mitsuyasuS(omega: number, omegaPeak: number, sPeak: number): number {
  const r = omega / omegaPeak;
  return Math.max(0.5, r <= 1 ? sPeak * r ** 5 : sPeak * r ** -2.5);
}

/** Donelan, Hamilton & Hui (1985) with Banner (1990) high-frequency extension. */
export function donelanBannerBeta(omega: number, omegaPeak: number): number {
  const r = Math.max(omega / omegaPeak, 0.56);
  if (r < 0.95) return 2.61 * r ** 1.3;
  if (r < 1.6) return 2.28 * r ** -1.3;
  return 10 ** (-0.4 + 0.8393 * Math.exp(-0.567 * Math.log(r * r)));
}

export function donelanBanner(theta: number, beta: number): number {
  const t = ((((theta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return beta / (2 * Math.tanh(beta * Math.PI)) / Math.cosh(beta * t) ** 2;
}

/** Evaluate D(θ; ω) for a spreading configuration. */
export function spreadingDensity(
  spec: Spreading,
  theta: number,
  omega: number,
  omegaPeak: number,
): number {
  switch (spec.model) {
    case 'cos2s':
      return cos2s(theta, spec.s);
    case 'mitsuyasu':
      return cos2s(theta, mitsuyasuS(omega, omegaPeak, spec.s));
    case 'donelan-banner':
      return donelanBanner(theta, donelanBannerBeta(omega, omegaPeak));
    case 'none':
      // Long-crested: a very narrow cos-2s lobe, still integrable on the grid.
      return cos2s(theta, 400);
  }
}
