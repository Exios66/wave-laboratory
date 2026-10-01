import { describe, expect, it } from 'vitest';
import { env, jonswap, regular } from '../test/fixtures';
import { buildCascadeSpectrum, cascadeSpecs, CASCADE_SIZES } from './cascades';
import { pressureAttenuation, wavenumberOf } from './dispersion';
import { OceanField } from './oceanField';
import { resolveSea } from './systems';

describe('cascades', () => {
  it('cover disjoint, contiguous wavenumber bands', () => {
    const specs = cascadeSpecs();
    expect(specs[0]!.kLow).toBe(0);
    for (let i = 1; i < specs.length; i++) expect(specs[i]!.kLow).toBe(specs[i - 1]!.kHigh);
    expect(specs.at(-1)!.kHigh).toBe(Infinity);
    expect(specs.filter((s) => s.physics)).toHaveLength(CASCADE_SIZES.length - 1);
  });

  it('produce identical h₀ at shared wavenumbers for any grid resolution', () => {
    const e = env();
    const sea = resolveSea([jonswap(3, 9)], e);
    const spec = cascadeSpecs()[1]!;
    const a = buildCascadeSpectrum(spec, 128, sea.spectral, sea.dispersion);
    const b = buildCascadeSpectrum(spec, 256, sea.spectral, sea.dispersion);
    for (const [mx, my] of [
      [3, 5],
      [-7, 2],
      [10, -12],
    ] as const) {
      const ia = ((my + 128) % 128) * 128 + ((mx + 128) % 128);
      const ib = ((my + 256) % 256) * 256 + ((mx + 256) % 256);
      expect(a.h0[2 * ia]).toBe(b.h0[2 * ib]);
      expect(a.h0[2 * ia + 1]).toBe(b.h0[2 * ib + 1]);
    }
    expect(a.variance).toBeCloseTo(b.variance, 12);
  });

  it('represent the requested H_s across all cascades (expected variance, V2)', () => {
    const e = env();
    for (const [hs, tp] of [
      [1, 5],
      [4, 10],
      [10, 15],
    ] as const) {
      const sea = resolveSea([jonswap(hs, tp)], e);
      let v = 0;
      for (const spec of cascadeSpecs()) {
        v += buildCascadeSpectrum(spec, 256, sea.spectral, sea.dispersion).variance;
      }
      expect((4 * Math.sqrt(v)) / hs).toBeGreaterThan(0.97);
      expect((4 * Math.sqrt(v)) / hs).toBeLessThan(1.03);
    }
  });
});

describe('OceanField', () => {
  it('is flat and hydrostatic with no waves', () => {
    const f = new OceanField([], env());
    expect(f.surface(10, -20, 3).eta).toBe(0);
    const p = f.fluid(0, 0, -5, 3);
    expect(p.pressure).toBeCloseTo(1025 * 9.80665 * 5, 6);
    expect(f.fluid(0, 0, 0.1, 3).pressure).toBe(0);
  });

  it('reproduces an analytic Airy wave (no choppiness)', () => {
    const e = env({ depth: 30, choppiness: 0 });
    const f = new OceanField([regular(2, 8, 270)], e); // from west → travels toward +x
    const omega = (2 * Math.PI) / 8;
    const k = wavenumberOf(omega, {
      gravity: e.gravity,
      depth: 30,
      tensionOverDensity: 0.074 / 1025,
    });
    for (const [x, t] of [
      [0, 0],
      [13, 2.2],
      [-40, 7.9],
    ] as const) {
      const theta = k * x - omega * t;
      expect(f.surface(x, 5, t).eta).toBeCloseTo(Math.cos(theta), 9);
      const z = -6;
      const p = f.fluid(x, 5, z, t);
      // Linear theory below the trough: p = ρg(−z + a cos θ · cosh k(z+h)/cosh kh)
      const eta = Math.cos(theta);
      const zeta = ((z - eta) * 30) / (30 + eta);
      const expected = 1025 * e.gravity * (-z + Math.cos(theta) * pressureAttenuation(k, zeta, 30));
      expect(p.pressure / expected).toBeCloseTo(1, 9);
    }
  });

  it('places choppy particles consistently (x0 + D(x0) = x)', () => {
    const e = env({ depth: 4000, choppiness: 1 });
    const f = new OceanField([regular(4, 10, 270)], e);
    // The world point that the crest particle (label 0) moves to is the crest itself.
    const t = 0;
    expect(f.surface(0, 0, t).eta).toBeCloseTo(2, 6);
    // Trochoid (Gerstner) profile: sharp crests, flat troughs, and an Eulerian mean level of
    // exactly −k a²/2 — a classic analytic check of the choppy inversion.
    let sum = 0;
    const k = ((2 * Math.PI) / 10) ** 2 / e.gravity;
    const L = (2 * Math.PI) / k;
    for (let i = 0; i < 400; i++) sum += f.surface((i / 400) * L, 0, t).eta;
    expect(sum / 400).toBeCloseTo((-k * 2 * 2) / 2, 4);
  });

  it('matches direct spectral summation (interpolation accuracy < 1.5 % of H_s)', () => {
    const e = env({ depth: 4000, choppiness: 0 });
    const f = new OceanField([jonswap(3, 9)], e);
    const t = 4.25;
    let maxErr = 0;
    for (let s = 0; s < 40; s++) {
      const x = 37.3 * s - 400;
      const y = 11.9 * s * s - 300;
      let direct = 0;
      for (const c of f.cascades) {
        const n = c.n;
        const dk = (2 * Math.PI) / c.spec.size;
        for (let iy = 0; iy < n; iy++) {
          for (let ix = 0; ix < n; ix++) {
            const cell = iy * n + ix;
            const ar = c.h0[2 * cell]!;
            const ai = c.h0[2 * cell + 1]!;
            if (ar === 0 && ai === 0) continue;
            const kx = (ix < n / 2 ? ix : ix - n) * dk;
            const ky = (iy < n / 2 ? iy : iy - n) * dk;
            const ph = kx * x + ky * y - c.omega[cell]! * t;
            direct += 2 * (ar * Math.cos(ph) - ai * Math.sin(ph));
          }
        }
      }
      maxErr = Math.max(maxErr, Math.abs(f.surface(x, y, t).eta - direct));
    }
    expect(maxErr).toBeLessThan(0.015 * 3);
  });

  it('has zero gauge pressure on the free surface', () => {
    const e = env({ depth: 50, choppiness: 1 });
    const f = new OceanField([jonswap(3, 9)], e);
    for (const [x, y] of [
      [3, 4],
      [100, -50],
    ] as const) {
      const eta = f.surface(x, y, 2).eta;
      expect(Math.abs(f.fluid(x, y, eta - 1e-9, 2).pressure)).toBeLessThan(1e-3);
    }
  });
});

describe('OceanField.column', () => {
  it('agrees with point queries', async () => {
    const { createColumnSample } = await import('./oceanField');
    const e = env({ depth: 40, choppiness: 1 });
    const f = new OceanField([jonswap(2.5, 8), regular(1, 6, 200)], e);
    const zetas = [0, -1, -3, -8, -20];
    const col = f.column(12, -7, 3.3, zetas, createColumnSample(zetas.length));
    for (let j = 0; j < zetas.length; j++) {
      // Choose z so that the stretched depth equals zetas[j].
      const z = col.eta + (zetas[j]! * (40 + col.eta)) / 40;
      const p = f.fluid(12, -7, z - 1e-12, 3.3);
      const expected = 1025 * e.gravity * (-z + col.head[j]!);
      if (zetas[j] === 0) continue;
      expect(p.pressure / expected).toBeCloseTo(1, 6);
      expect(p.u).toBeCloseTo(col.u[j]!, 9);
      expect(p.w).toBeCloseTo(col.w[j]!, 9);
    }
  });
});
