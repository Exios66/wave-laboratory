/**
 * CPU-side spectral statistics of the uploaded sea, used for shading and legends.
 *
 * For the realisation η(x, t) = Σ_k ĥ(k, t) e^{ik·x} with ĥ = h₀(k)e^{−iωt} + conj(h₀(−k))e^{iωt},
 * the space–time mean of |ĥ(k)|² is |h₀(k)|² + |h₀(−k)|², so
 *     ⟨η²⟩ = 2 Σ_k |h₀(k)|²,      ⟨|∇η|²⟩ = 2 Σ_k |k|² |h₀(k)|².
 *
 * LEAN-style filtering: when a cascade is sampled at mip level ℓ the box filter removes (roughly)
 * every wavenumber with max(|mₓ|, |m_y|) ≥ N / 2^{ℓ+1}. The slope variance carried by those
 * components is no longer visible in the normal and must be added to the specular roughness.
 * `unresolvedSlopeVariance[ℓ]` tabulates exactly that, per cascade, for ℓ = 0 … log₂N.
 */
import type { GpuOceanData } from '../../ocean/gpuData';

/** Maximum mip levels tabulated per cascade (N ≤ 512 → log₂N + 1 ≤ 10). */
export const SLOPE_TABLE_LEVELS = 10;

export interface CascadeStats {
  /** ⟨η²⟩ of this cascade [m²]. */
  etaVariance: number;
  /** Mean square slope ⟨ηₓ² + η_y²⟩ of this cascade. */
  meanSquareSlope: number;
  /** Unresolved mean square slope when sampled at mip level ℓ (index ℓ). */
  unresolvedSlopeVariance: Float32Array;
  /** Smallest wavelength present [m] (∞ if empty). */
  minWavelength: number;
}

export interface OceanStats {
  cascades: CascadeStats[];
  /** ⟨η²⟩ of all cascades plus regular waves [m²]. */
  etaVariance: number;
  /** Mean square slope of all cascades plus regular waves. */
  meanSquareSlope: number;
}

export function computeOceanStats(data: GpuOceanData): OceanStats {
  let etaVar = 0;
  let mss = 0;
  const cascades = data.cascades.map((c): CascadeStats => {
    const n = c.n;
    const dk = (2 * Math.PI) / c.size;
    const log2n = Math.round(Math.log2(n));
    // Slope variance binned by "mip level at which the component is filtered away".
    const perLevel = new Float64Array(SLOPE_TABLE_LEVELS + 1);
    let ev = 0;
    let sv = 0;
    let kMax = 0;
    for (let iy = 0; iy < n; iy++) {
      const my = iy < n / 2 ? iy : iy - n;
      for (let ix = 0; ix < n; ix++) {
        const mx = ix < n / 2 ? ix : ix - n;
        const o = 4 * (iy * n + ix);
        const a2 = c.h0[o]! * c.h0[o]! + c.h0[o + 1]! * c.h0[o + 1]!;
        if (a2 === 0) continue;
        const k2 = (mx * mx + my * my) * dk * dk;
        ev += 2 * a2;
        sv += 2 * a2 * k2;
        kMax = Math.max(kMax, Math.sqrt(k2));
        // Component survives at level ℓ while m∞ < N / 2^{ℓ+1}  ⇔  ℓ < log₂(N / m∞) − 1.
        const mInf = Math.max(Math.abs(mx), Math.abs(my));
        const firstLost = Math.max(0, Math.ceil(log2n - Math.log2(mInf) - 1 - 1e-9));
        perLevel[Math.min(firstLost, SLOPE_TABLE_LEVELS)]! += 2 * a2 * k2;
      }
    }
    const table = new Float32Array(SLOPE_TABLE_LEVELS);
    let acc = 0;
    for (let l = 0; l < SLOPE_TABLE_LEVELS; l++) {
      acc += perLevel[l]!;
      table[l] = acc;
    }
    etaVar += ev;
    mss += sv;
    return {
      etaVariance: ev,
      meanSquareSlope: sv,
      unresolvedSlopeVariance: table,
      minWavelength: kMax > 0 ? (2 * Math.PI) / kMax : Infinity,
    };
  });
  for (const r of data.regular) {
    etaVar += (r.amplitude * r.amplitude) / 2;
    mss += (r.amplitude * r.k * (r.amplitude * r.k)) / 2;
  }
  return { cascades, etaVariance: etaVar, meanSquareSlope: mss };
}

/** Round up to a "nice" legend limit (1, 2, 2.5, 5 × 10ⁿ). */
export function niceCeil(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const e = Math.floor(Math.log10(v));
  const base = 10 ** e;
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= v * (1 - 1e-9)) return m * base;
  return 10 * base;
}
