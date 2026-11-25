/**
 * Physics behind the scientific surface overlays (jacobian, orbital velocity, dynamic pressure,
 * energy density). The ocean shader evaluates the same formulas per vertex and pixel; this
 * module is the CPU mirror the tests check against `OceanField`, and it owns the colour-scale
 * ranges so the legend and the shader can never disagree.
 */
import { pressureAttenuation, stokesSecondAmplitude } from './dispersion';
import type { ResolvedRegularWave } from './systems';

/**
 * J = (1 + dDx/dx)(1 + dDy/dy) below this is flagged as breaking. Geometric folding is J < 0;
 * the foam model starts injecting at about 0.3, so that is the onset the overlay shows.
 */
export const BREAKING_JACOBIAN = 0.3;

/** Instantaneous potential energy density of the surface, 1/2 rho g eta^2 [J/m^2]. */
export function energyDensity(eta: number, rho: number, g: number): number {
  return 0.5 * rho * g * eta * eta;
}

export interface OverlayScale {
  /** Elevation scale a = 0.75 Hs (floored), shared with the height overlay [m]. */
  height: number;
  /** Orbital speed at the top of the ramp [m/s]. */
  velocity: number;
  /** Dynamic pressure at the top of the ramp [Pa] (surface value, rho g a). */
  pressure: number;
  /** Energy density at the top of the ramp [J/m^2], 1/2 rho g a^2. */
  energy: number;
}

/**
 * Top of every colour ramp for a sea of significant wave height `hs`. The reference wave has
 * amplitude a and the period of a developed sea (about 3.9 sqrt(Hs), at least 3 s), so the
 * speed range is a * omega.
 */
export function overlayScale(hs: number, rho: number, g: number): OverlayScale {
  const a = Math.max(0.25, hs * 0.75);
  const period = Math.max(3, 3.9 * Math.sqrt(Math.max(hs, 0)));
  return {
    height: a,
    velocity: ((2 * Math.PI) / period) * a,
    pressure: rho * g * a,
    energy: 0.5 * rho * g * a * a,
  };
}

export interface RegularOverlay {
  eta: number;
  /** Surface particle velocity [m/s] (linear theory, unit choppiness). */
  u: number;
  v: number;
  w: number;
  /** Elevation head eta * cosh(k(h - d)) / cosh(kh) at depth d below the mean surface [m]. */
  etaAtt: number;
}

/**
 * One regular or focused component at world point (x, y), mirroring the vertex shader's
 * `regularOverlay`. `depthBelow` d >= 0 is metres under the mean surface; `lambda` gates the
 * Stokes second harmonic like the displacement does.
 */
export function regularOverlay(
  r: ResolvedRegularWave,
  x: number,
  y: number,
  t: number,
  depthBelow: number,
  waterDepth: number,
  lambda: number,
): RegularOverlay {
  const theta = r.k * (r.dirX * x + r.dirY * y) - r.omega * t + r.phase;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const a2 = r.stokes && lambda > 0.001 ? stokesSecondAmplitude(r.amplitude, r.k, waterDepth) : 0;
  const z = -Math.min(Math.max(depthBelow, 0), waterDepth);
  const eta = r.amplitude * c + a2 * Math.cos(2 * theta);
  const etaAtt =
    r.amplitude * c * pressureAttenuation(r.k, z, waterDepth) +
    a2 * Math.cos(2 * theta) * pressureAttenuation(2 * r.k, z, waterDepth);
  const uh = r.amplitude * r.omega * r.cothKh * c;
  return { eta, u: uh * r.dirX, v: uh * r.dirY, w: r.amplitude * r.omega * s, etaAtt };
}

export function sumRegularOverlay(
  waves: readonly ResolvedRegularWave[],
  x: number,
  y: number,
  t: number,
  depthBelow: number,
  waterDepth: number,
  lambda: number,
): RegularOverlay {
  const out: RegularOverlay = { eta: 0, u: 0, v: 0, w: 0, etaAtt: 0 };
  for (const r of waves) {
    const p = regularOverlay(r, x, y, t, depthBelow, waterDepth, lambda);
    out.eta += p.eta;
    out.u += p.u;
    out.v += p.v;
    out.w += p.w;
    out.etaAtt += p.etaAtt;
  }
  return out;
}
