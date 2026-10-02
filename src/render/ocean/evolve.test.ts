import { describe, expect, it } from 'vitest';
import { FFT } from '../../ocean/fft';
import { evolveSpectra } from './evolve';
import { ifft2d } from './ifftPasses';

describe('GPU-equivalent inverse FFT', () => {
  it('matches the CPU FFT for a random natural-order spectrum', () => {
    const n = 16;
    const data = new Float64Array(2 * n * n);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.37) * 0.25;
    const viaPasses = ifft2d(data, n);
    const viaCpu = new Float64Array(data);
    new FFT(n).inverse2D(viaCpu);
    for (let i = 0; i < viaCpu.length; i++) expect(viaPasses[i]).toBeCloseTo(viaCpu[i]!, 9);
  });
});

describe('spectral evolution', () => {
  it('turns a single h₀ bin into a travelling cosine and its Gerstner shift', () => {
    const n = 8;
    const size = 64;
    const depth = 1000;
    const lambda = 1;
    const omega = 1.3;
    const h0 = new Float32Array(4 * n * n);
    // h₀(k) = 1/2 at mx = 1, my = 0 → η = cos(kx − ωt) when h₀(−k) = 0.
    h0[4 * 1] = 0.5;
    h0[4 * 1 + 2] = omega;
    h0[4 * (n - 1) + 2] = omega;

    const t = 0.4;
    const evolved = evolveSpectra(h0, n, size, t, depth, lambda);
    const fft = new FFT(n);
    fft.inverse2D(evolved.height);
    fft.inverse2D(evolved.packedDisp);

    const k = (2 * Math.PI) / size;
    for (let px = 0; px < n; px++) {
      const x = (px * size) / n;
      const theta = k * x - omega * t;
      const eta = evolved.height[2 * px]!;
      const dx = evolved.packedDisp[2 * px]!;
      const dy = evolved.packedDisp[2 * px + 1]!;
      expect(eta).toBeCloseTo(Math.cos(theta), 6);
      expect(evolved.height[2 * px + 1]!).toBeCloseTo(0, 6);
      expect(dx).toBeCloseTo(-Math.sin(theta), 6);
      expect(dy).toBeCloseTo(0, 6);
    }
  });
});
