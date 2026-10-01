/**
 * Resolve experiment wave systems into the quantities the synthesis code needs:
 * a frequency spectrum S(ω), a directional spreading and a propagation angle (spectral
 * systems), or an analytic Airy component (regular waves).
 */
import { DEG } from '../core/units';
import type { Environment, Spreading, WaveSystem } from '../schema/experiment';
import { omegaOf, wavenumberOf, type DispersionParams } from './dispersion';
import { makeSpectrum, windSeaParameters, type FrequencySpectrum } from './spectra';

/** Water deeper than this is treated as infinitely deep for TMA purposes. */
export const DEEP_WATER_DEPTH = 1000;

export interface ResolvedSpectralSystem {
  id: string;
  /** Mathematical propagation angle in the world frame (0 = toward +x/east, CCW positive). */
  theta0: number;
  spectrum: FrequencySpectrum;
  spreading: Spreading;
  seed: number;
  /** Diagnostics for the UI. */
  hs: number;
  tp: number;
  note?: string;
}

export interface ResolvedRegularWave {
  id: string;
  /** Amplitude a = H/2 [m]. */
  amplitude: number;
  omega: number;
  k: number;
  /** Unit propagation direction. */
  dirX: number;
  dirY: number;
  phase: number;
  /** coth(kh): ratio of horizontal to vertical orbital amplitude at the surface. */
  cothKh: number;
}

export interface ResolvedSea {
  spectral: ResolvedSpectralSystem[];
  regular: ResolvedRegularWave[];
  dispersion: DispersionParams;
}

/** Convert a compass "coming from" bearing [deg] to a mathematical propagation angle [rad]. */
export function propagationAngleFromBearing(fromDeg: number): number {
  return (-90 - fromDeg) * DEG;
}

/** Convert a compass heading the bow points TOWARD [deg] to a mathematical yaw [rad]. */
export function yawFromHeading(headingDeg: number): number {
  return (90 - headingDeg) * DEG;
}

export function headingFromYaw(yaw: number): number {
  const h = 90 - yaw / DEG;
  return ((h % 360) + 360) % 360;
}

export function dispersionFor(env: Environment): DispersionParams {
  return {
    gravity: env.gravity,
    depth: env.depth,
    tensionOverDensity: env.surfaceTension / env.waterDensity,
  };
}

export function resolveSea(waves: readonly WaveSystem[], env: Environment): ResolvedSea {
  const dispersion = dispersionFor(env);
  const tmaDepth = env.depth < DEEP_WATER_DEPTH ? env.depth : undefined;
  const spectral: ResolvedSpectralSystem[] = [];
  const regular: ResolvedRegularWave[] = [];
  for (const w of waves) {
    if (!w.enabled) continue;
    const theta0 = propagationAngleFromBearing(w.directionDeg);
    switch (w.kind) {
      case 'spectrum': {
        if (w.hs <= 0) break;
        const spectrum = makeSpectrum({
          shape: w.spectrum,
          hs: w.hs,
          tp: w.tp,
          gamma: w.gamma,
          gravity: env.gravity,
          ...(w.depthLimited && tmaDepth !== undefined ? { tmaDepth } : {}),
        });
        spectral.push({
          id: w.id,
          theta0,
          spectrum,
          spreading: w.spreading,
          seed: w.seed,
          hs: w.hs,
          tp: w.tp,
        });
        break;
      }
      case 'wind': {
        const p = windSeaParameters(w.windSpeed, w.fetchKm * 1000, env.gravity, tmaDepth);
        if (p.hs <= 0) break;
        const spectrum = makeSpectrum({
          shape: 'jonswap',
          hs: p.hs,
          tp: p.tp,
          gamma: p.gamma,
          gravity: env.gravity,
          ...(tmaDepth !== undefined ? { tmaDepth } : {}),
        });
        spectral.push({
          id: w.id,
          theta0,
          spectrum,
          spreading: w.spreading,
          seed: w.seed,
          hs: p.hs,
          tp: p.tp,
          note: p.fullyDeveloped ? 'Fully developed (Pierson–Moskowitz limit)' : 'Fetch-limited',
        });
        break;
      }
      case 'regular': {
        if (w.height <= 0) break;
        const omega = (2 * Math.PI) / w.period;
        const k = wavenumberOf(omega, dispersion);
        const kh = k * env.depth;
        regular.push({
          id: w.id,
          amplitude: w.height / 2,
          omega,
          k,
          dirX: Math.cos(theta0),
          dirY: Math.sin(theta0),
          phase: w.phaseDeg * DEG,
          cothKh: kh > 20 ? 1 : 1 / Math.tanh(kh),
        });
        break;
      }
    }
  }
  return { spectral, regular, dispersion };
}

/** Wavelength [m] for a period [s] under the given dispersion (diagnostics/UI). */
export function wavelengthForPeriod(period: number, p: DispersionParams): number {
  const k = wavenumberOf((2 * Math.PI) / period, p);
  return k > 0 ? (2 * Math.PI) / k : Infinity;
}

export { omegaOf };
