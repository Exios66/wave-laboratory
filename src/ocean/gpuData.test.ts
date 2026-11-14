import { describe, expect, it } from 'vitest';
import { evolveSpectra } from '../render/ocean/evolve';
import { env, jonswap } from '../test/fixtures';
import { FFT } from './fft';
import { buildGpuOceanData, meanSquareSlope } from './gpuData';

/** Spatial variance of |∇η| of the sea a packed h₀ draws at time t, by inverse FFT. */
function slopeVarianceAt(h0: Float32Array, n: number, size: number, t: number): number {
  const { height } = evolveSpectra(h0, n, size, t, 1000, 1);
  const sx = new Float64Array(2 * n * n);
  const sy = new Float64Array(2 * n * n);
  const dk = (2 * Math.PI) / size;
  for (let iy = 0; iy < n; iy++) {
    const ky = (iy < n / 2 ? iy : iy - n) * dk;
    for (let ix = 0; ix < n; ix++) {
      const kx = (ix < n / 2 ? ix : ix - n) * dk;
      const c = 2 * (iy * n + ix);
      const re = height[c]!;
      const im = height[c + 1]!;
      // ∂/∂x ↔ i kx.
      sx[c] = -kx * im;
      sx[c + 1] = kx * re;
      sy[c] = -ky * im;
      sy[c + 1] = ky * re;
    }
  }
  const fft = new FFT(n);
  fft.inverse2D(sx);
  fft.inverse2D(sy);
  let sum = 0;
  for (let i = 0; i < n * n; i++) sum += sx[2 * i]! ** 2 + sy[2 * i]! ** 2;
  return sum / (n * n);
}

describe('mean-square slope', () => {
  it('is k²a²/2 for a single cosine', () => {
    const n = 8;
    const size = 64;
    const h0 = new Float32Array(4 * n * n);
    // h₀ = a/2 at (mx, my) = (2, 1) alone gives η = a cos(k·x − ωt).
    const a = 0.8;
    const cell = 1 * n + 2;
    h0[4 * cell] = a / 2;
    h0[4 * cell + 2] = 1;
    h0[4 * ((n - 1) * n + (n - 2)) + 2] = 1;
    const k2 = ((2 * Math.PI) / size) ** 2 * (2 * 2 + 1 * 1);
    expect(meanSquareSlope(h0, n, size)).toBeCloseTo((k2 * a * a) / 2, 8);
    expect(slopeVarianceAt(h0, n, size, 0.7)).toBeCloseTo((k2 * a * a) / 2, 8);
  });

  it('matches the slopes each cascade actually draws', () => {
    const data = buildGpuOceanData([jonswap(3, 8)], env(), 'low');
    for (const c of data.cascades) {
      expect(c.slopeVariance).toBeGreaterThan(0);
      let measured = 0;
      const times = [0, 3.1, 7.7];
      for (const t of times) measured += slopeVarianceAt(c.h0, c.n, c.size, t) / times.length;
      // The k / −k cross terms only average out over many components; a few per cent remain.
      expect(measured / c.slopeVariance).toBeGreaterThan(0.9);
      expect(measured / c.slopeVariance).toBeLessThan(1.1);
    }
    // Shorter waves are steeper: the finer cascades carry most of the slope variance.
    const mss = data.cascades.map((c) => c.slopeVariance);
    expect(mss[1]! + mss[2]! + mss[3]!).toBeGreaterThan(mss[0]!);
  });

  it('stays in the range Cox and Munk measured for a fresh breeze', () => {
    // Cox & Munk (1954), clean surface: mss ≈ 0.003 + 5.12e-3 U [-]. The spectrum stops at the
    // finest cascade's Nyquist wavenumber, so the resolved part sits below the full value.
    const data = buildGpuOceanData([jonswap(2, 7)], env(), 'high');
    const total = data.cascades.reduce((s, c) => s + c.slopeVariance, 0);
    expect(total).toBeGreaterThan(0.002);
    expect(total).toBeLessThan(0.003 + 5.12e-3 * 12);
  });
});

describe('mean wave period', () => {
  it('is the spectral mean period Tm01, a little under the peak period', () => {
    for (const tp of [6, 9, 12]) {
      const data = buildGpuOceanData([jonswap(2.5, tp)], env(), 'low');
      expect(data.meanPeriod).toBeGreaterThan(0.7 * tp);
      expect(data.meanPeriod).toBeLessThan(1.0 * tp);
    }
  });

  it('is zero for a flat sea', () => {
    expect(buildGpuOceanData([], env(), 'low').meanPeriod).toBe(0);
  });
});
