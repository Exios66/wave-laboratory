/** Numerical helpers. */

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Standard Hermite smoothstep: 0 at edge0, 1 at edge1, clamped outside. */
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Lanczos approximation of ln Γ(x) for x > 0 (|ε| < 2e-10). */
export function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xx = x - 1;
  let a = c[0]!;
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Compass bearing [deg] a wind with world velocity (u, v) comes FROM. */
export function compassFrom(u: number, v: number): number {
  if (Math.hypot(u, v) < 1e-9) return 0;
  // Air moving toward bearing b comes from b + 180; bearing of a vector = atan2(east, north).
  const toward = (Math.atan2(u, v) * 180) / Math.PI;
  return (((toward + 180) % 360) + 360) % 360;
}

/** Composite Simpson integration of f over [a, b] with n (even) intervals. */
export function simpson(f: (x: number) => number, a: number, b: number, n = 512): number {
  const m = n % 2 === 0 ? n : n + 1;
  const h = (b - a) / m;
  let s = f(a) + f(b);
  for (let i = 1; i < m; i++) s += (i % 2 === 0 ? 2 : 4) * f(a + i * h);
  return (s * h) / 3;
}
