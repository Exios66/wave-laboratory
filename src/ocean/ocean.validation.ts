/**
 * Statistical validation of the synthesised sea (docs/PLAN.md §8, V2–V3). These run longer
 * records than unit tests and are executed with `pnpm validate`.
 */
import { describe, expect, it } from 'vitest';
import { spectralParameters, welchPsd, zeroCrossingStatistics } from '../instruments/analysis';
import { env, jonswap } from '../test/fixtures';
import { OceanField } from './oceanField';

const FS = 4; // Hz
const DURATION = 1536; // s

function record(f: OceanField, x: number, y: number): Float64Array {
  const n = DURATION * FS;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f.surface(x, y, i / FS).eta;
  return out;
}

describe('V2 — spectrum reproduction at a virtual wave gauge', () => {
  for (const [hs, tp] of [
    [2, 8],
    [6, 12],
  ] as const) {
    it(`JONSWAP Hs=${hs} m, Tp=${tp} s`, () => {
      const f = new OceanField([jonswap(hs, tp)], env({ choppiness: 0 }), {
        physicsGrid: 64,
        snapshotInterval: 1 / FS,
      });
      const eta = record(f, 17, -23);
      const sp = spectralParameters(welchPsd(eta, FS, 1024));
      // Sampling variability of Hm0 from a ~25 min record is a few percent.
      expect(sp.hm0 / hs).toBeGreaterThan(0.9);
      expect(sp.hm0 / hs).toBeLessThan(1.1);
      expect(Math.abs(sp.tp - tp) / tp).toBeLessThan(0.12);
    });
  }
});

describe('V3 — wave statistics', () => {
  it('linear sea: Gaussian elevations and H1/3 ≈ Hm0', () => {
    const hs = 3;
    const f = new OceanField([jonswap(hs, 9)], env({ choppiness: 0 }), {
      physicsGrid: 64,
      snapshotInterval: 1 / FS,
    });
    const eta = record(f, -40, 75);
    const zc = zeroCrossingStatistics(eta, FS);
    const hm0 = 4 * zc.std;
    expect(zc.h13 / hm0).toBeGreaterThan(0.85);
    expect(zc.h13 / hm0).toBeLessThan(1.05);
    let m3 = 0;
    let m4 = 0;
    for (const v of eta) {
      m3 += (v / zc.std) ** 3;
      m4 += (v / zc.std) ** 4;
    }
    // A 25-min record holds ~N = 750 independent samples (≈ 2 s decorrelation), so the sampling
    // standard errors are √(6/N) ≈ 0.09 for skewness and √(24/N) ≈ 0.18 for kurtosis.
    // Tolerances are three standard errors.
    expect(Math.abs(m3 / eta.length)).toBeLessThan(0.27);
    expect(Math.abs(m4 / eta.length - 3)).toBeLessThan(0.54);
  });

  it('choppy (Lagrangian) sea: positive skewness — sharper crests than troughs', () => {
    const f = new OceanField([jonswap(6, 9)], env({ choppiness: 1 }), {
      physicsGrid: 64,
      snapshotInterval: 1,
    });
    f.prepare(0);
    const samples: number[] = [];
    for (let i = 0; i < 120; i++)
      for (let j = 0; j < 120; j++) samples.push(f.surface(i * 4.1, j * 3.7, 0).eta);
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const sd = Math.sqrt(samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length);
    const skew = samples.reduce((s, v) => s + ((v - mean) / sd) ** 3, 0) / samples.length;
    expect(skew).toBeGreaterThan(0.05);
    expect(mean).toBeLessThan(0); // Eulerian mean level drops (cf. −k a²/2 for a trochoid)
  });
});
