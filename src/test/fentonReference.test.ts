import { describe, expect, it } from 'vitest';
import { fourierWave } from './fentonReference';

describe('Fourier reference solver', () => {
  it('reproduces linear theory for a low wave', () => {
    const w = fourierWave(0.02, 8, 30, 9.81, 12, 1);
    const omega = (2 * Math.PI) / 8;
    expect(w.k * 9.81 * Math.tanh(w.k * 30)).toBeCloseTo(omega * omega, 4);
    expect(w.eta(0)).toBeCloseTo(0.01, 4);
    expect(w.eta(Math.PI)).toBeCloseTo(-0.01, 4);
  });
  it('matches the deep-water limit of Stokes: c² = g/k (1 + ε²) and a₂ = k a²/2', () => {
    const H = 3;
    const w = fourierWave(H, 9, 200, 9.81, 16, 6);
    const eps = (w.k * H) / 2;
    expect(w.c ** 2 / (9.81 / w.k)).toBeCloseTo(1 + eps * eps, 3);
    expect(w.coefficients[1]! / (w.k * (H / 2) ** 2 * 0.5)).toBeCloseTo(1, 1);
  });
});
