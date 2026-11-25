/**
 * Resolve experiment wave systems into the quantities the synthesis code needs:
 * a frequency spectrum S(ω), a directional spreading and a propagation angle (spectral
 * systems), or an analytic Airy component (regular waves).
 */
import { deriveSeed } from '../core/rng';
import { DEG } from '../core/units';
import type { Environment, Spreading, WaveSystem } from '../schema/experiment';
import { omegaOf, wavenumberOf, type DispersionParams } from './dispersion';
import {
  solveCnoidal,
  solveSolitary,
  solveStokes5,
  type HarmonicWaveSolution,
  type SolitarySolution,
} from './nonlinear';
import { jonswapShape, makeSpectrum, windSeaParameters, type FrequencySpectrum } from './spectra';

/** Number of linear components in a focused wave group. */
export const FOCUSED_COMPONENTS = 40;

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
  /** Add the second-order Stokes harmonic (single regular waves only, not group members). */
  stokes: boolean;
  /** Focused-group components carry the id of their group; their energy is transient. */
  group?: string;
}

export interface ResolvedFocusedGroup {
  id: string;
  crestHeight: number;
  tp: number;
  focusX: number;
  focusY: number;
  focusTime: number;
  wavelength: number;
}

/**
 * A nonlinear steady wave: Fenton fifth-order Stokes, cnoidal or solitary. The surface is
 * η = Σ a_j cos(jθ) (harmonic waves) or H sech²(κ ξ) (solitary), with θ = k (d·x) − ω t + φ.
 * Particle kinematics are linear per harmonic, with orbital ratio coth(j k h).
 */
export interface ResolvedNonlinearWave {
  id: string;
  kind: 'harmonic' | 'solitary';
  theory: 'stokes5' | 'cnoidal' | 'solitary';
  k: number;
  omega: number;
  /** Phase speed [m/s]. */
  c: number;
  dirX: number;
  dirY: number;
  phase: number;
  /** Mean water depth [m] (the kinematics need it). */
  depth: number;
  /** Elevation harmonics a_1..a_n [m] (harmonic waves; empty for solitary). */
  harmonics: number[];
  /** coth(j k h) for each harmonic. */
  coth: number[];
  solitary?: Pick<SolitarySolution, 'kappa' | 'spacing' | 'heightUsed'>;
  /** Wave height after any clamp [m]. */
  height: number;
  ursell?: number;
  m?: number;
  truncationError: number;
  /** Clamp or validity notice for the UI. */
  notice?: string;
}

export interface ResolvedSea {
  spectral: ResolvedSpectralSystem[];
  regular: ResolvedRegularWave[];
  nonlinear: ResolvedNonlinearWave[];
  focused: ResolvedFocusedGroup[];
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
  const nonlinear: ResolvedNonlinearWave[] = [];
  const focused: ResolvedFocusedGroup[] = [];
  for (const w of waves) {
    if (!w.enabled) continue;
    const followWeather = w.kind === 'wind' && w.followWeather;
    const theta0 = propagationAngleFromBearing(
      followWeather ? env.windDirectionDeg : w.directionDeg,
    );
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
        const u10 = w.followWeather ? env.windSpeed : w.windSpeed;
        const p = windSeaParameters(u10, w.fetchKm * 1000, env.gravity, tmaDepth);
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
          note:
            (p.fullyDeveloped ? 'Fully developed (Pierson–Moskowitz limit)' : 'Fetch-limited') +
            (w.followWeather ? ' · driven by the weather wind' : ''),
        });
        break;
      }
      case 'regular': {
        if (w.height <= 0) break;
        const theory = w.theory ?? 'stokes2';
        if (theory === 'stokes5' || theory === 'cnoidal') {
          const input = {
            height: w.height,
            period: w.period,
            depth: env.depth,
            gravity: env.gravity,
          };
          const sol = theory === 'stokes5' ? solveStokes5(input) : solveCnoidal(input);
          nonlinear.push(harmonicWave(w.id, theory, sol, theta0, w.phaseDeg * DEG, env.depth));
          break;
        }
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
          stokes: theory === 'stokes2',
        });
        break;
      }
      case 'solitary': {
        if (w.height <= 0) break;
        const sol = solveSolitary({
          height: w.height,
          depth: env.depth,
          gravity: env.gravity,
          spacing: w.spacing,
        });
        const k = (2 * Math.PI) / sol.spacing;
        nonlinear.push({
          id: w.id,
          kind: 'solitary',
          theory: 'solitary',
          k,
          omega: sol.c * k,
          c: sol.c,
          dirX: Math.cos(theta0),
          dirY: Math.sin(theta0),
          phase: w.phaseDeg * DEG,
          depth: env.depth,
          harmonics: [],
          coth: [],
          solitary: { kappa: sol.kappa, spacing: sol.spacing, heightUsed: sol.heightUsed },
          height: sol.heightUsed,
          truncationError: 0,
          ...(sol.notice ? { notice: sol.notice } : {}),
        });
        break;
      }
      case 'focused': {
        if (w.crestHeight <= 0) break;
        const group = focusedGroup(w, theta0, env, dispersion);
        regular.push(...group.components);
        focused.push(group.info);
        break;
      }
    }
  }
  return { spectral, regular, nonlinear, focused, dispersion };
}

function harmonicWave(
  id: string,
  theory: 'stokes5' | 'cnoidal',
  sol: HarmonicWaveSolution & { m?: number; ursell?: number },
  theta0: number,
  phase: number,
  depth: number,
): ResolvedNonlinearWave {
  return {
    id,
    kind: 'harmonic',
    theory,
    k: sol.k,
    omega: sol.omega,
    c: sol.c,
    dirX: Math.cos(theta0),
    dirY: Math.sin(theta0),
    phase,
    depth,
    harmonics: sol.harmonics,
    coth: sol.harmonics.map((_, j) => {
      const x = (j + 1) * sol.k * depth;
      return x > 20 ? 1 : 1 / Math.tanh(x);
    }),
    height: sol.heightUsed,
    truncationError: sol.truncationError,
    ...(sol.m !== undefined ? { m: sol.m } : {}),
    ...(sol.ursell !== undefined ? { ursell: sol.ursell } : {}),
    ...(sol.notice ? { notice: sol.notice } : {}),
  };
}

/**
 * NewWave focused group (Tromans, Anaturk & Hagemeijer 1991): linear components with
 * amplitudes a_n = A_c S(ω_n)Δω / Σ S(ω_m)Δω and phases chosen so every crest coincides at
 * (x_f, t_f). The underlying spectrum is JONSWAP (γ = 3.3) between 0.6 ω_p and 3 ω_p.
 * Frequencies are jittered inside their bins so the group does not refocus periodically.
 */
export function focusedGroup(
  w: {
    id: string;
    crestHeight: number;
    tp: number;
    focusX: number;
    focusY: number;
    focusTime: number;
    seed: number;
  },
  theta0: number,
  env: Pick<Environment, 'depth' | 'gravity'>,
  dispersion: DispersionParams,
): { components: ResolvedRegularWave[]; info: ResolvedFocusedGroup } {
  const wp = (2 * Math.PI) / w.tp;
  const lo = 0.6 * wp;
  const hi = 3 * wp;
  const n = FOCUSED_COMPONENTS;
  const dw = (hi - lo) / n;
  const dirX = Math.cos(theta0);
  const dirY = Math.sin(theta0);
  const comps: { omega: number; weight: number }[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const jitter = deriveSeed(w.seed, i) / 4294967296;
    const omega = lo + (i + 0.2 + 0.6 * jitter) * dw;
    const weight = jonswapShape(omega, wp, 3.3, env.gravity) * dw;
    comps.push({ omega, weight });
    total += weight;
  }
  const components: ResolvedRegularWave[] = [];
  for (let i = 0; i < n; i++) {
    const c = comps[i]!;
    const amplitude = total > 0 ? (w.crestHeight * c.weight) / total : 0;
    if (amplitude <= 1e-6) continue;
    const k = wavenumberOf(c.omega, dispersion);
    const kh = k * env.depth;
    // θ = k·x − ωt + φ = 0 at the focus.
    const phase = c.omega * w.focusTime - k * (dirX * w.focusX + dirY * w.focusY);
    components.push({
      id: `${w.id}#${i}`,
      amplitude,
      omega: c.omega,
      k,
      dirX,
      dirY,
      phase,
      cothKh: kh > 20 ? 1 : 1 / Math.tanh(kh),
      stokes: false,
      group: w.id,
    });
  }
  return {
    components,
    info: {
      id: w.id,
      crestHeight: w.crestHeight,
      tp: w.tp,
      focusX: w.focusX,
      focusY: w.focusY,
      focusTime: w.focusTime,
      wavelength: (2 * Math.PI) / wavenumberOf(wp, dispersion),
    },
  };
}

/** Wavelength [m] for a period [s] under the given dispersion (diagnostics/UI). */
export function wavelengthForPeriod(period: number, p: DispersionParams): number {
  const k = wavenumberOf((2 * Math.PI) / period, p);
  return k > 0 ? (2 * Math.PI) / k : Infinity;
}

export { omegaOf };
