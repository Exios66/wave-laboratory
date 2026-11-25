import { describe, expect, it } from 'vitest';
import { ellipticE, ellipticK, jacobi } from './elliptic';

/** Incomplete integral u = F(φ|m) by composite Simpson, independent of the AGM code. */
function incompleteF(phi: number, m: number): number {
  const n = 4000;
  const h = phi / n;
  const f = (t: number) => 1 / Math.sqrt(1 - m * Math.sin(t) ** 2);
  let s = f(0) + f(phi);
  for (let i = 1; i < n; i++) s += f(i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

describe('complete elliptic integrals', () => {
  it('match tabulated values (Abramowitz & Stegun Table 17.1, parameter m)', () => {
    expect(ellipticK(0)).toBeCloseTo(Math.PI / 2, 14);
    expect(ellipticE(0)).toBeCloseTo(Math.PI / 2, 14);
    expect(ellipticK(0.5)).toBeCloseTo(1.8540746773013719, 12);
    expect(ellipticE(0.5)).toBeCloseTo(1.3506438810476755, 12);
    expect(ellipticK(0.9)).toBeCloseTo(2.5780921133481733, 12);
    expect(ellipticE(0.9)).toBeCloseTo(1.1047747327040733, 12);
    expect(ellipticE(1)).toBeCloseTo(1, 12);
  });
  it('satisfy the Legendre relation E K′ + E′ K − K K′ = π/2', () => {
    for (const m of [0.1, 0.37, 0.8, 0.99]) {
      const lhs =
        ellipticE(m) * ellipticK(1 - m) +
        ellipticE(1 - m) * ellipticK(m) -
        ellipticK(m) * ellipticK(1 - m);
      expect(lhs).toBeCloseTo(Math.PI / 2, 11);
    }
  });
  it('K grows logarithmically toward m = 1 without overflowing', () => {
    const m = 1 - 1e-12; // 1 − m is not exactly 1e-12 in floating point, so use the real value
    expect(ellipticK(m)).toBeCloseTo(Math.log(4 / Math.sqrt(1 - m)), 6);
  });
});

describe('Jacobi elliptic functions', () => {
  it('reduce to trigonometric functions at m = 0 and hyperbolic ones at m = 1', () => {
    const a = jacobi(0.7, 0);
    expect(a.sn).toBeCloseTo(Math.sin(0.7), 13);
    expect(a.cn).toBeCloseTo(Math.cos(0.7), 13);
    expect(a.dn).toBeCloseTo(1, 13);
    const b = jacobi(0.7, 1 - 1e-13);
    expect(b.cn).toBeCloseTo(1 / Math.cosh(0.7), 8);
    expect(b.sn).toBeCloseTo(Math.tanh(0.7), 8);
  });
  it('satisfy sn² + cn² = 1, dn² + m sn² = 1 and the quarter-period values', () => {
    for (const m of [0.2, 0.6, 0.95]) {
      for (const u of [-3, 0.3, 1.1, 2.9]) {
        const j = jacobi(u, m);
        expect(j.sn ** 2 + j.cn ** 2).toBeCloseTo(1, 12);
        expect(j.dn ** 2 + m * j.sn ** 2).toBeCloseTo(1, 12);
      }
      const K = ellipticK(m);
      expect(jacobi(K, m).cn).toBeCloseTo(0, 11);
      expect(jacobi(K, m).sn).toBeCloseTo(1, 11);
      expect(jacobi(2 * K, m).cn).toBeCloseTo(-1, 11);
      expect(jacobi(4 * K + 0.4, m).cn).toBeCloseTo(jacobi(0.4, m).cn, 11);
    }
  });
  it('invert the incomplete integral: cn(F(φ|m)) = cos φ', () => {
    for (const m of [0.3, 0.7, 0.98]) {
      for (const phi of [0.2, 0.9, 1.4]) {
        const u = incompleteF(phi, m);
        expect(jacobi(u, m).cn).toBeCloseTo(Math.cos(phi), 9);
        expect(jacobi(u, m).sn).toBeCloseTo(Math.sin(phi), 9);
      }
    }
  });
});
