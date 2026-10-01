import { describe, expect, it } from 'vitest';
import {
  groupVelocity,
  omegaOf,
  phaseVelocity,
  pressureAttenuation,
  wavenumberOf,
  type DispersionParams,
} from './dispersion';

const g = 9.80665;
const deep: DispersionParams = { gravity: g, depth: 1e4, tensionOverDensity: 0 };

describe('dispersion relation (V1)', () => {
  it('reduces to ω² = gk in deep water', () => {
    for (const k of [0.001, 0.05, 1, 3]) expect(omegaOf(k, deep) ** 2).toBeCloseTo(g * k, 9);
  });

  it('gives c → √(gh) for long waves in shallow water', () => {
    const p: DispersionParams = { gravity: g, depth: 5, tensionOverDensity: 0 };
    expect(phaseVelocity(1e-5, p) / Math.sqrt(g * 5)).toBeCloseTo(1, 6);
  });

  it('gives c_g = c/2 in deep water and c_g → c in shallow water', () => {
    const k = 0.2;
    expect(groupVelocity(k, deep) / phaseVelocity(k, deep)).toBeCloseTo(0.5, 9);
    const shallow: DispersionParams = { gravity: g, depth: 1, tensionOverDensity: 0 };
    expect(groupVelocity(1e-4, shallow) / phaseVelocity(1e-4, shallow)).toBeCloseTo(1, 6);
  });

  it('matches a numerical derivative for the group velocity (finite depth + capillarity)', () => {
    const p: DispersionParams = { gravity: g, depth: 3, tensionOverDensity: 0.074 / 1025 };
    for (const k of [0.1, 2, 50, 400]) {
      const h = k * 1e-6;
      const numeric = (omegaOf(k + h, p) - omegaOf(k - h, p)) / (2 * h);
      expect(groupVelocity(k, p) / numeric).toBeCloseTo(1, 6);
    }
  });

  it('inverts ω(k) to machine precision', () => {
    const p: DispersionParams = { gravity: g, depth: 12, tensionOverDensity: 0.074 / 1025 };
    for (const k of [0.002, 0.3, 4, 150]) expect(wavenumberOf(omegaOf(k, p), p)).toBeCloseTo(k, 9);
  });

  it('has the minimum gravity–capillary phase speed ≈ 0.23 m/s near λ ≈ 1.7 cm', () => {
    const p: DispersionParams = { gravity: g, depth: 100, tensionOverDensity: 0.074 / 1025 };
    let best = { c: Infinity, k: 0 };
    for (let k = 50; k < 1000; k += 0.5) {
      const c = phaseVelocity(k, p);
      if (c < best.c) best = { c, k };
    }
    expect(best.c).toBeGreaterThan(0.22);
    expect(best.c).toBeLessThan(0.24);
    expect((2 * Math.PI) / best.k).toBeCloseTo(0.0171, 3);
  });

  it('pressure attenuation is 1 at the surface, e^{kz} in deep water and finite at the bed', () => {
    expect(pressureAttenuation(0.3, 0, 50)).toBeCloseTo(1, 12);
    expect(pressureAttenuation(0.3, -4, 1e4)).toBeCloseTo(Math.exp(-1.2), 12);
    expect(pressureAttenuation(0.3, -10, 10)).toBeCloseTo(1 / Math.cosh(3), 12);
  });
});
