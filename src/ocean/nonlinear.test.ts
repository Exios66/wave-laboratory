import { describe, expect, it } from 'vitest';
import { fourierWave } from '../test/fentonReference';
import { fentonCoefficients, solveStokes5 } from './nonlinear';

describe('Stokes fifth-order coefficients (Fenton 1985)', () => {
  it('reproduce Table 2, column 4, for d/λ = 0.12 (kd = 0.753982)', () => {
    // Fenton (1985), J. Waterway, Port, Coastal & Ocean Eng. 111(2), 216-234, Table 2: the worked
    // example of Skjelbreia & Hendrickson, kd = 2π × 0.12.
    const c = fentonCoefficients(2 * Math.PI * 0.12);
    expect(c.B22).toBeCloseTo(2.502414, 5);
    expect(c.B31).toBeCloseTo(-5.731666, 5);
    expect(c.B42).toBeCloseTo(-32.407508, 4);
    expect(c.B44).toBeCloseTo(14.033758, 5);
    expect(c.B53).toBeCloseTo(-103.445042, 3);
    expect(c.B55).toBeCloseTo(37.200027, 4);
    expect(c.C0).toBeCloseTo(0.798448, 6);
    expect(c.C2).toBeCloseTo(1.940215, 5);
    expect(c.C4).toBeCloseTo(-12.970403, 4);
  });
  it('approach the deep-water limits of Table 2', () => {
    const c = fentonCoefficients(14);
    expect(c.B22).toBeCloseTo(0.5, 6);
    expect(c.B31).toBeCloseTo(-3 / 8, 6);
    expect(c.B42).toBeCloseTo(1 / 3, 6);
    expect(c.B44).toBeCloseTo(1 / 3, 6);
    expect(c.B53).toBeCloseTo(99 / 128, 6);
    expect(c.B55).toBeCloseTo(125 / 384, 6);
    expect(c.C2).toBeCloseTo(0.5, 6);
    expect(c.C4).toBeCloseTo(1 / 8, 6);
  });
});

describe('solveStokes5', () => {
  const g = 9.81;
  it('is the linear wave for a very low wave', () => {
    const s = solveStokes5({ height: 0.01, period: 8, depth: 50, gravity: g });
    const omega = (2 * Math.PI) / 8;
    expect(g * s.k * Math.tanh(s.k * 50)).toBeCloseTo(omega * omega, 6);
    expect(s.harmonics[0]).toBeCloseTo(0.005, 6);
  });
  it('has crest-to-trough height exactly H and zero mean elevation', () => {
    const s = solveStokes5({ height: 4, period: 9, depth: 40, gravity: g });
    const eta = (th: number) => s.harmonics.reduce((a, h, i) => a + h * Math.cos((i + 1) * th), 0);
    expect(eta(0) - eta(Math.PI)).toBeCloseTo(4, 10);
    let mean = 0;
    for (let i = 0; i < 360; i++) mean += eta((2 * Math.PI * i) / 360) / 360;
    expect(mean).toBeCloseTo(0, 10);
    expect(eta(0)).toBeGreaterThan(-eta(Math.PI)); // sharper crests, flatter troughs
  });
  it('solves k from H, T and h so that c k = ω with Fenton speed coefficients', () => {
    const s = solveStokes5({ height: 5, period: 10, depth: 30, gravity: g });
    expect(s.c * s.k).toBeCloseTo((2 * Math.PI) / 10, 9);
    // Nonlinear waves of the same period are longer than linear ones in the same depth.
    const lin = solveStokes5({ height: 0.01, period: 10, depth: 30, gravity: g });
    expect(s.k).toBeLessThan(lin.k);
  });

  // V4: profile against the independent Rienecker–Fenton Fourier solution (24 modes), within
  // 1 % of H. Cases are well inside Stokes' range of validity (Stokes–Ursell number < 0.5).
  const cases = [
    { name: 'deep water, H/L ≈ 0.035', height: 3.5, period: 8, depth: 300 },
    { name: 'deep water, H/L ≈ 0.09', height: 9, period: 8, depth: 300 },
    { name: 'intermediate, kd ≈ 1.4', height: 2.5, period: 9, depth: 22 },
    { name: 'intermediate, kd ≈ 0.9', height: 1.1, period: 12, depth: 15 },
    { name: 'near-Fenton example, d/λ ≈ 0.12', height: 1.4, period: 10.4, depth: 14 },
  ];
  for (const cs of cases) {
    it(`matches the numerical stream-function solution: ${cs.name}`, () => {
      const s = solveStokes5({ ...cs, gravity: g });
      expect(s.clamped).toBe(false);
      const ref = fourierWave(cs.height, cs.period, cs.depth, g, 24, 8);
      expect(s.k).toBeCloseTo(ref.k, 3);
      expect(Math.abs(s.k - ref.k) / ref.k).toBeLessThan(5e-3);
      let worst = 0;
      for (let i = 0; i <= 180; i++) {
        const th = (Math.PI * i) / 180;
        const e5 = s.harmonics.reduce((a, h, j) => a + h * Math.cos((j + 1) * th), 0);
        worst = Math.max(worst, Math.abs(e5 - ref.eta(th)));
      }
      expect(worst / cs.height).toBeLessThan(0.01);
    });
  }

  it('clamps beyond the Miche limit and says so', () => {
    const s = solveStokes5({ height: 20, period: 8, depth: 300, gravity: g });
    expect(s.clamped).toBe(true);
    expect(s.heightUsed).toBeLessThan(20);
    const L = (2 * Math.PI) / s.k;
    expect(s.heightUsed / L).toBeCloseTo(0.142 * Math.tanh(s.k * 300), 3);
    expect(s.notice).toMatch(/Miche/);
  });
  it('flags shallow, long waves where Stokes theory is unreliable', () => {
    const s = solveStokes5({ height: 0.8, period: 14, depth: 4, gravity: g });
    expect(s.notice).toMatch(/cnoidal/i);
  });
});
