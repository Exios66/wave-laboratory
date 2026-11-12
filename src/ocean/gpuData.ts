/**
 * Packing of the spectral sea for the GPU renderer. The renderer receives exactly the h₀ and ω
 * that the CPU physics uses (same cells, same values), so what you see is what the ships feel.
 */
import type { Environment, OceanQuality, WaveSystem } from '../schema/experiment';
import { buildCascadeSpectrum, cascadeSpecs, visualGridSize } from './cascades';
import { resolveSea, type ResolvedRegularWave } from './systems';

export interface GpuCascade {
  index: number;
  /** Patch size L [m]. */
  size: number;
  /** Grid resolution N (power of two). */
  n: number;
  /**
   * RGBA float data, N×N texels, row-major with row ↔ y and col ↔ x, natural FFT order:
   *   R = Re h₀(k), G = Im h₀(k), B = ω(|k|) [rad/s], A = 0.
   * Texel (ix, iy) holds wavenumber k = (2π/L)·(m(ix), m(iy)) with m(i) = i < N/2 ? i : i − N.
   */
  h0: Float32Array;
  /** Whether the CPU physics includes this cascade (the last one is visual-only ripples). */
  physics: boolean;
  /** Surface-elevation variance in this cascade [m²]. */
  variance: number;
  /**
   * Mean-square slope of this cascade, E[(∂η/∂x)² + (∂η/∂y)²] [-]: the time (and space) average
   * of the slopes the drawn h₀ produces, 2 Σ |k|² |h₀(k)|². The renderer turns the part of it a
   * pixel cannot resolve into surface roughness (sun glitter, blurred reflections).
   */
  slopeVariance: number;
}

export interface GpuOceanData {
  cascades: GpuCascade[];
  regular: ResolvedRegularWave[];
  depth: number;
  gravity: number;
  choppiness: number;
  /** Expected significant wave height of everything represented [m]. */
  hs: number;
}

/**
 * Mean-square slope of a packed h₀ field (RGBA texels as in GpuCascade.h0). With
 * η = Σ_k ĥ(k, t) e^{ik·x} and ĥ = h₀(k) e^{−iωt} + conj(h₀(−k)) e^{iωt}, Parseval gives
 * ⟨|∇η|²⟩ = Σ_k |k|² ⟨|ĥ(k, t)|²⟩ = 2 Σ_k |k|² |h₀(k)|² once the cross terms between k and −k
 * (which oscillate at 2ω) are averaged out.
 */
export function meanSquareSlope(h0: ArrayLike<number>, n: number, size: number): number {
  const dk = (2 * Math.PI) / size;
  let sum = 0;
  for (let iy = 0; iy < n; iy++) {
    const my = iy < n / 2 ? iy : iy - n;
    for (let ix = 0; ix < n; ix++) {
      const mx = ix < n / 2 ? ix : ix - n;
      const cell = iy * n + ix;
      const re = h0[4 * cell] ?? 0;
      const im = h0[4 * cell + 1] ?? 0;
      if (re === 0 && im === 0) continue;
      sum += (mx * mx + my * my) * (re * re + im * im);
    }
  }
  return 2 * dk * dk * sum;
}

export function buildGpuOceanData(
  waves: readonly WaveSystem[],
  env: Environment,
  quality: OceanQuality,
): GpuOceanData {
  const sea = resolveSea(waves, env);
  const n = visualGridSize(quality);
  let variance = 0;
  const cascades = cascadeSpecs().map((spec) => {
    const c = buildCascadeSpectrum(spec, n, sea.spectral, sea.dispersion);
    variance += c.variance;
    const h0 = new Float32Array(4 * n * n);
    for (let i = 0; i < n * n; i++) {
      h0[4 * i] = c.h0[2 * i]!;
      h0[4 * i + 1] = c.h0[2 * i + 1]!;
      h0[4 * i + 2] = c.omega[i]!;
    }
    return {
      index: spec.index,
      size: spec.size,
      n,
      h0,
      physics: spec.physics,
      variance: c.variance,
      slopeVariance: meanSquareSlope(h0, n, spec.size),
    };
  });
  for (const r of sea.regular) if (!r.group) variance += (r.amplitude * r.amplitude) / 2;
  return {
    cascades,
    regular: sea.regular,
    depth: env.depth,
    gravity: env.gravity,
    choppiness: env.choppiness,
    hs: 4 * Math.sqrt(variance),
  };
}
