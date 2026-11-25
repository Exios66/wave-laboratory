/**
 * Complete elliptic integrals and Jacobi elliptic functions, in plain TypeScript, for cnoidal
 * waves. The parameter is m = k² (not the modulus k). Everything uses the arithmetic–geometric
 * mean, so it converges in a handful of iterations for any 0 ≤ m < 1, including the long-wave
 * limit m → 1 where cn becomes sech.
 *
 * References: Abramowitz & Stegun, Handbook of Mathematical Functions, §16.4 (AGM and
 * descending Landen transformations) and §17.6 (complete integrals).
 */

/** Largest parameter used: 1 − 1e-15 keeps K finite and the AGM well conditioned. */
const M_MAX = 1 - 1e-15;

/** Complete elliptic integral of the first kind K(m) = ∫₀^{π/2} dθ / √(1 − m sin²θ). */
export function ellipticK(m: number): number {
  const mm = Math.min(Math.max(m, 0), M_MAX);
  let a = 1;
  let b = Math.sqrt(1 - mm);
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-16 * a; i++) {
    const an = 0.5 * (a + b);
    b = Math.sqrt(a * b);
    a = an;
  }
  return Math.PI / (2 * a);
}

/** Complete elliptic integral of the second kind E(m) = ∫₀^{π/2} √(1 − m sin²θ) dθ. */
export function ellipticE(m: number): number {
  const mm = Math.min(Math.max(m, 0), M_MAX);
  let a = 1;
  let b = Math.sqrt(1 - mm);
  let c2 = mm; // c₀² = m
  let sum = 0.5 * c2; // 2^{n−1} c_n² with n = 0
  let pow = 0.5;
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-16 * a; i++) {
    const c = 0.5 * (a - b);
    const an = 0.5 * (a + b);
    b = Math.sqrt(a * b);
    a = an;
    pow *= 2;
    c2 = c * c;
    sum += pow * c2;
  }
  return ellipticK(mm) * (1 - sum);
}

export interface JacobiValues {
  sn: number;
  cn: number;
  dn: number;
}

/**
 * Jacobi sn, cn, dn of argument u and parameter m by descending Landen / AGM (A&S 16.4). The
 * argument is first folded into [0, K] with the symmetries cn(−u) = cn(u), cn(u + 4K) = cn(u),
 * cn(2K − u) = −cn(u), so the amplitude recurrence never leaves its principal branch.
 */
export function jacobi(u: number, m: number): JacobiValues {
  const mm = Math.min(Math.max(m, 0), M_MAX);
  const K = ellipticK(mm);
  let v = Math.abs(u) % (4 * K);
  if (v > 2 * K) v = 4 * K - v;
  let flip = 1;
  if (v > K) {
    v = 2 * K - v;
    flip = -1;
  }
  const as: number[] = [1];
  const cs: number[] = [Math.sqrt(mm)];
  let a = 1;
  let b = Math.sqrt(1 - mm);
  let n = 0;
  while (n < 40 && Math.abs(cs[n]!) > 1e-17) {
    const an = 0.5 * (a + b);
    const c = 0.5 * (a - b);
    b = Math.sqrt(a * b);
    a = an;
    as.push(a);
    cs.push(c);
    n++;
  }
  let phi = 2 ** n * as[n]! * v;
  for (let i = n; i >= 1; i--) {
    phi = 0.5 * (phi + Math.asin(Math.min(1, Math.max(-1, (cs[i]! / as[i]!) * Math.sin(phi)))));
  }
  const sn = Math.sin(phi) * Math.sign(u || 1);
  const cn = Math.cos(phi) * flip;
  const dn = Math.sqrt(Math.max(0, 1 - mm * sn * sn));
  return { sn, cn, dn };
}
