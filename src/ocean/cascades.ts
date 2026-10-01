/**
 * Multi-cascade spectral synthesis.
 *
 * The sea surface is the sum of several periodic FFT patches ("cascades") of decreasing size.
 * Each cascade owns a disjoint annulus of wavenumbers so no energy is counted twice:
 *     k ∈ [kLow_i, kHigh_i),   kHigh_i = kLow_{i+1} = 6 · 2π / L_{i+1}
 * With a size ratio of 4 between cascades every non-final band fits inside |m| ≤ 24 grid cells,
 * which lets the CPU physics evaluate it on a 128² grid without losing any component.
 *
 * Amplitudes (see docs/PHYSICS.md): η = 2 Re Σ_k h₀(k) e^{i(k·x − ωt)} with
 *     h₀(k) = ½ (ξ_r + i ξ_i) √(S(k) Δk²),   S(k) = S(ω) D(θ; ω) (dω/dk) / k,
 * where ξ are independent standard normals drawn from a counter-based hash of
 * (system seed, cascade, mx, my) — so every grid resolution sees *the same* sea.
 */
import { groupVelocity, omegaOf, type DispersionParams } from './dispersion';
import { signedIndex } from './fft';
import { spreadingDensity } from './spreading';
import type { ResolvedSpectralSystem } from './systems';

export const CASCADE_SIZES: readonly number[] = [1024, 256, 64, 16];
/** Cells of the next (smaller) cascade below which the current cascade hands over. */
const HANDOVER_CELLS = 6;
/** Grid size used by the CPU physics for every physics cascade. */
export const PHYSICS_GRID = 128;

export interface CascadeSpec {
  index: number;
  /** Patch size L [m]. */
  size: number;
  kLow: number;
  kHigh: number;
  /** Whether vessel physics and instruments include this cascade. */
  physics: boolean;
}

export function cascadeSpecs(sizes: readonly number[] = CASCADE_SIZES): CascadeSpec[] {
  return sizes.map((size, i) => {
    const next = sizes[i + 1];
    const prev = sizes[i - 1];
    return {
      index: i,
      size,
      kLow: prev === undefined ? 0 : (HANDOVER_CELLS * 2 * Math.PI) / size,
      kHigh: next === undefined ? Infinity : (HANDOVER_CELLS * 2 * Math.PI) / next,
      physics: next !== undefined,
    };
  });
}

/** Visual FFT resolution per quality level. */
export function visualGridSize(quality: 'low' | 'medium' | 'high' | 'ultra'): number {
  return quality === 'low' ? 64 : quality === 'medium' ? 128 : quality === 'high' ? 256 : 512;
}

export interface CascadeSpectrum {
  spec: CascadeSpec;
  n: number;
  /** Interleaved complex h₀ (2·n² values), natural FFT order, row-major (row ↔ y). */
  h0: Float64Array;
  /** ω(|k|) per cell (n² values) [rad/s]. */
  omega: Float64Array;
  /** Surface-elevation variance contained in this cascade [m²]. */
  variance: number;
  /** Energy-weighted mean wavenumber [rad/m] (0 if empty). */
  kMean: number;
}

/** splitmix32-style integer hash → uniform (0,1]. */
function hashUniform(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (b + 0x632be59b) ^ (h >>> 15), 0xc2b2ae35) >>> 0;
  h = Math.imul(h ^ (c + 0x7f4a7c15) ^ (h >>> 13), 0x27d4eb2f) >>> 0;
  h = Math.imul(h ^ (d + 0x165667b1) ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h ^= h >>> 15;
  return ((h >>> 0) + 1) / 4294967297;
}

/** Deterministic pair of standard normals for a grid cell of a system. */
export function cellGaussians(
  seed: number,
  cascade: number,
  mx: number,
  my: number,
): [number, number] {
  const u1 = hashUniform(seed, cascade, mx, my);
  const u2 = hashUniform(seed ^ 0x5bd1e995, cascade + 17, my, mx);
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

/** Directional wavenumber spectrum S(kx, ky) [m⁴] of one system. */
export function wavenumberSpectrum(
  sys: ResolvedSpectralSystem,
  kx: number,
  ky: number,
  disp: DispersionParams,
): number {
  const k = Math.hypot(kx, ky);
  if (k <= 0) return 0;
  const omega = omegaOf(k, disp);
  const s = sys.spectrum.density(omega);
  if (s <= 0) return 0;
  const theta = Math.atan2(ky, kx) - sys.theta0;
  const d = spreadingDensity(sys.spreading, theta, omega, sys.spectrum.omegaPeak);
  return (s * d * groupVelocity(k, disp)) / k;
}

const SUB = 3; // sub-samples per axis for cell-averaged spectral density

/**
 * Build h₀ and ω for one cascade at grid resolution n. Only cells whose centre lies in the
 * cascade band are filled; the Nyquist row/column is left empty so the field stays real.
 */
export function buildCascadeSpectrum(
  spec: CascadeSpec,
  n: number,
  systems: readonly ResolvedSpectralSystem[],
  disp: DispersionParams,
): CascadeSpectrum {
  const h0 = new Float64Array(2 * n * n);
  const omega = new Float64Array(n * n);
  const dk = (2 * Math.PI) / spec.size;
  const dk2 = dk * dk;
  const kNyquist = (Math.PI * n) / spec.size;
  const kHigh = Math.min(spec.kHigh, kNyquist);
  const mMax = Math.min(n / 2 - 1, Math.ceil(kHigh / dk));
  let variance = 0;
  let kWeighted = 0;
  for (let myS = -mMax; myS <= mMax; myS++) {
    for (let mxS = -mMax; mxS <= mMax; mxS++) {
      const kx = mxS * dk;
      const ky = myS * dk;
      const k = Math.hypot(kx, ky);
      if (k <= 0 || k < spec.kLow || k >= kHigh) continue;
      const ix = mxS < 0 ? mxS + n : mxS;
      const iy = myS < 0 ? myS + n : myS;
      const cell = iy * n + ix;
      omega[cell] = omegaOf(k, disp);
      let re = 0;
      let im = 0;
      for (const sys of systems) {
        let sAvg = 0;
        for (let a = 0; a < SUB; a++) {
          for (let b = 0; b < SUB; b++) {
            const sx = kx + ((a + 0.5) / SUB - 0.5) * dk;
            const sy = ky + ((b + 0.5) / SUB - 0.5) * dk;
            sAvg += wavenumberSpectrum(sys, sx, sy, disp);
          }
        }
        sAvg /= SUB * SUB;
        if (sAvg <= 0) continue;
        const amp = 0.5 * Math.sqrt(sAvg * dk2);
        const [g1, g2] = cellGaussians(sys.seed, spec.index, mxS, myS);
        re += amp * g1;
        im += amp * g2;
        // Expected contribution of this cell to Var(η): 2·E|h₀|² = S Δk².
        variance += sAvg * dk2;
        kWeighted += sAvg * dk2 * k;
      }
      h0[2 * cell] = re;
      h0[2 * cell + 1] = im;
    }
  }
  return { spec, n, h0, omega, variance, kMean: variance > 0 ? kWeighted / variance : 0 };
}

/** Expected (ensemble) significant wave height represented by a set of cascades. */
export function representedHs(cascades: readonly CascadeSpectrum[]): number {
  let v = 0;
  for (const c of cascades) v += c.variance;
  return 4 * Math.sqrt(v);
}

export { signedIndex };
