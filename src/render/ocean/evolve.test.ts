import { describe, expect, it } from 'vitest';
import { FFT } from '../../ocean/fft';
import { buildGpuOceanData } from '../../ocean/gpuData';
import { env, jonswap } from '../../test/fixtures';
import { evolveSpectra, evolveVelocitySpectra } from './evolve';
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

describe('velocity spectra (orbital velocity and attenuated elevation)', () => {
  const size = 200;

  function sea() {
    const data = buildGpuOceanData([jonswap(2, 7)], env({ depth: 40 }), 'low');
    const c = data.cascades[0]!;
    return { h0: c.h0, n: c.n, size: c.size };
  }

  function inverse(a: Float64Array, nn: number): Float64Array {
    const out = new Float64Array(a);
    new FFT(nn).inverse2D(out);
    return out;
  }

  it('is the time derivative of the displacement (unit choppiness) and of the elevation', () => {
    const { h0, n: nn, size: sz } = sea();
    const t = 3.7;
    const dt = 1e-4;
    const vel = evolveVelocitySpectra(h0, nn, sz, t, 40, 0);
    const horiz = inverse(vel.horiz, nn);
    const vert = inverse(vel.vert, nn);
    const a = evolveSpectra(h0, nn, sz, t - dt, 40, 1);
    const b = evolveSpectra(h0, nn, sz, t + dt, 40, 1);
    const dA = inverse(a.packedDisp, nn);
    const dB = inverse(b.packedDisp, nn);
    const hA = inverse(a.height, nn);
    const hB = inverse(b.height, nn);
    let scale = 0;
    for (let i = 0; i < nn * nn; i++) scale = Math.max(scale, Math.abs(vert[2 * i]!));
    expect(scale).toBeGreaterThan(0.01);
    for (let i = 0; i < nn * nn; i++) {
      expect(horiz[2 * i]!).toBeCloseTo((dB[2 * i]! - dA[2 * i]!) / (2 * dt), 3);
      expect(horiz[2 * i + 1]!).toBeCloseTo((dB[2 * i + 1]! - dA[2 * i + 1]!) / (2 * dt), 3);
      expect(vert[2 * i]!).toBeCloseTo((hB[2 * i]! - hA[2 * i]!) / (2 * dt), 3);
    }
  });

  it('carries the elevation itself at depth 0 and its attenuation below', () => {
    const { h0, n: nn, size: sz } = sea();
    const t = 1.3;
    const top = inverse(evolveVelocitySpectra(h0, nn, sz, t, 4000, 0).vert, nn);
    const height = inverse(evolveSpectra(h0, nn, sz, t, 4000, 1).height, nn);
    for (let i = 0; i < nn * nn; i++) expect(top[2 * i + 1]!).toBeCloseTo(height[2 * i]!, 9);
    const deep = inverse(evolveVelocitySpectra(h0, nn, sz, t, 4000, 8).vert, nn);
    let rmsTop = 0;
    let rmsDeep = 0;
    for (let i = 0; i < nn * nn; i++) {
      rmsTop += top[2 * i + 1]! ** 2;
      rmsDeep += deep[2 * i + 1]! ** 2;
      // The velocity half of the same transform does not depend on the depth below.
      expect(deep[2 * i]!).toBeCloseTo(top[2 * i]!, 9);
    }
    expect(rmsDeep).toBeLessThan(rmsTop);
    expect(rmsDeep).toBeGreaterThan(0);
  });

  it('turns one bin into a*omega orbits with exp(-k d) attenuation', () => {
    const nn = 8;
    const omega = 1.3;
    const h0 = new Float32Array(4 * nn * nn);
    h0[4 * 1] = 0.5;
    h0[4 * 1 + 2] = omega;
    h0[4 * (nn - 1) + 2] = omega;
    const t = 0.4;
    const d = 6;
    const spec = evolveVelocitySpectra(h0, nn, size, t, 4000, d);
    const horiz = inverse(spec.horiz, nn);
    const vert = inverse(spec.vert, nn);
    const k = (2 * Math.PI) / size;
    for (let px = 0; px < nn; px++) {
      const theta = k * ((px * size) / nn) - omega * t;
      expect(horiz[2 * px]!).toBeCloseTo(omega * Math.cos(theta), 6);
      expect(vert[2 * px]!).toBeCloseTo(omega * Math.sin(theta), 6);
      expect(vert[2 * px + 1]!).toBeCloseTo(Math.cos(theta) * Math.exp(-k * d), 6);
    }
  });
});
