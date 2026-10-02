import { describe, expect, it } from 'vitest';
import { simpson } from '../core/mathUtil';
import { makeSpectrum, windSeaParameters, zerothMoment } from './spectra';
import { cos2s, donelanBanner, donelanBannerBeta } from './spreading';

const g = 9.80665;

describe('frequency spectra', () => {
  it('normalises JONSWAP so that 4√m₀ equals the requested H_s', () => {
    for (const [hs, tp, gamma] of [
      [2, 8, 3.3],
      [8, 13, 2],
      [0.5, 3, 7],
    ] as const) {
      const s = makeSpectrum({ shape: 'jonswap', hs, tp, gamma, gravity: g });
      expect(4 * Math.sqrt(zerothMoment(s.density, s.omegaPeak))).toBeCloseTo(hs, 6);
    }
  });

  it('peaks at T_p', () => {
    const s = makeSpectrum({ shape: 'jonswap', hs: 3, tp: 10, gamma: 3.3, gravity: g });
    let best = { w: 0, v: -1 };
    for (let w = 0.3; w < 1.5; w += 0.0005) {
      const v = s.density(w);
      if (v > best.v) best = { w, v };
    }
    expect(best.w).toBeCloseTo((2 * Math.PI) / 10, 3);
  });

  it('honours H_s after the TMA depth factor', () => {
    const s = makeSpectrum({
      shape: 'jonswap',
      hs: 2,
      tp: 10,
      gamma: 3.3,
      gravity: g,
      tmaDepth: 8,
    });
    expect(4 * Math.sqrt(zerothMoment(s.density, s.omegaPeak))).toBeCloseTo(2, 6);
  });

  it('reproduces the fully developed Pierson–Moskowitz limit H_s ≈ 0.209 U²/g', () => {
    const p = windSeaParameters(15, 5e6, g);
    expect(p.fullyDeveloped).toBe(true);
    expect(p.hs / ((0.2094 * 15 * 15) / g)).toBeCloseTo(1, 2);
  });

  it('is fetch-limited for short fetches and grows with fetch', () => {
    const a = windSeaParameters(15, 20e3, g);
    const b = windSeaParameters(15, 80e3, g);
    expect(a.fullyDeveloped).toBe(false);
    expect(b.hs).toBeGreaterThan(a.hs);
    expect(b.tp).toBeGreaterThan(a.tp);
  });
});

describe('directional spreading', () => {
  it('cos-2s integrates to 1', () => {
    for (const s of [1, 5, 20, 75]) {
      expect(simpson((t) => cos2s(t, s), -Math.PI, Math.PI, 4000)).toBeCloseTo(1, 6);
    }
  });

  it('Donelan–Banner integrates to 1', () => {
    for (const r of [0.6, 1, 1.4, 3]) {
      const beta = donelanBannerBeta(r, 1);
      expect(simpson((t) => donelanBanner(t, beta), -Math.PI, Math.PI, 4000)).toBeCloseTo(1, 6);
    }
  });
});

describe('fetch-limited wind sea', () => {
  it('never shrinks as the fetch grows (capped at the fully developed sea)', () => {
    for (const U of [5, 10, 15, 25, 40]) {
      let prev = 0;
      for (let km = 1; km <= 3000; km *= 1.05) {
        const { hs } = windSeaParameters(U, km * 1000, g);
        expect(hs).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = hs;
      }
      expect(prev).toBeCloseTo(windSeaParameters(U, 1e8, g).hs, 6);
    }
  });
});
