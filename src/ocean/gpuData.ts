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
    };
  });
  for (const r of sea.regular) variance += (r.amplitude * r.amplitude) / 2;
  return {
    cascades,
    regular: sea.regular,
    depth: env.depth,
    gravity: env.gravity,
    choppiness: env.choppiness,
    hs: 4 * Math.sqrt(variance),
  };
}
