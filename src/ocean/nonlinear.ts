/**
 * Nonlinear steady waves for the deterministic wave systems: fifth-order Stokes waves, cnoidal
 * waves and the solitary wave. Each is reduced to the same form the sea components use, a
 * surface profile that travels without change of shape, so the CPU field, the GPU shader and
 * vessel forces all sample one definition.
 *
 * Conventions shared by all three:
 *  - Elevation is measured from the mean water level (the depth `h` in the environment is the
 *    mean depth), so every periodic profile has zero mean.
 *  - The mean Eulerian current is zero (Stokes' first definition of wave speed). There is no
 *    return flow under the wave, so a Stokes wave carries a net forward mass transport.
 *  - Kinematics are linear per harmonic: harmonic n has wavenumber nk and frequency nω, and its
 *    horizontal-to-vertical orbital ratio is coth(nkh). This keeps the elevation exact to the
 *    stated theory while velocities and pressure are first-order accurate in each harmonic.
 */
import { micheLimit, wavenumberOf } from './dispersion';
import { ellipticE, ellipticK, jacobi } from './elliptic';

export type WaveTheory = 'airy' | 'stokes2' | 'stokes5' | 'cnoidal';

/** Depth-limited breaking criterion H/h (McCowan 1894), used for cnoidal and solitary waves. */
export const BREAKING_H_OVER_D = 0.78;

/** Fourier harmonics carried by a nonlinear wave on the CPU and the GPU. */
export const MAX_HARMONICS = 24;

// ---------------------------------------------------------------------------------------------
// Stokes fifth order
// ---------------------------------------------------------------------------------------------

export interface FentonCoefficients {
  B22: number;
  B31: number;
  B42: number;
  B44: number;
  B53: number;
  B55: number;
  C0: number;
  C2: number;
  C4: number;
}

/**
 * Coefficients of Fenton's fifth-order Stokes solution as functions of kd only, from Table 1 of
 * Fenton (1985), "A fifth-order Stokes theory for steady waves", J. Waterway, Port, Coastal and
 * Ocean Engineering 111(2), 216-234, with S = sech 2kd. The formulas are transcribed from the
 * author's published STOKES program (https://johndfenton.com/Steady-waves/Fourier.html, file
 * Stokes.zip) and checked against Table 2 of the paper in the unit tests.
 */
export function fentonCoefficients(kd: number): FentonCoefficients {
  const S = 1 / Math.cosh(2 * kd);
  const s = [1, S, S ** 2, S ** 3, S ** 4, S ** 5, S ** 6, S ** 7, S ** 8];
  const t = [1, 1 - S, (1 - S) ** 2, (1 - S) ** 3, (1 - S) ** 4, (1 - S) ** 5, (1 - S) ** 6];
  const tanh = Math.tanh(kd);
  const coth = 1 / tanh;
  const sq = Math.sqrt(tanh);
  const f32 = 3 + 2 * S;
  const f45 = 4 + S;
  return {
    B22: (coth * (1 + 2 * s[1]!)) / (2 * t[1]!),
    B31: (-3 * (1 + 3 * s[1]! + 3 * s[2]! + 2 * s[3]!)) / (8 * t[3]!),
    B42:
      (coth * (6 - 26 * s[1]! - 182 * s[2]! - 204 * s[3]! - 25 * s[4]! + 26 * s[5]!)) /
      (6 * f32 * t[4]!),
    B44:
      (coth * (24 + 92 * s[1]! + 122 * s[2]! + 66 * s[3]! + 67 * s[4]! + 34 * s[5]!)) /
      (24 * f32 * t[4]!),
    B53:
      (9 *
        (132 +
          17 * s[1]! -
          2216 * s[2]! -
          5897 * s[3]! -
          6292 * s[4]! -
          2687 * s[5]! +
          194 * s[6]! +
          467 * s[7]! +
          82 * s[8]!)) /
      (128 * f32 * f45 * t[6]!),
    B55:
      (5 *
        (300 +
          1579 * s[1]! +
          3176 * s[2]! +
          2949 * s[3]! +
          1188 * s[4]! +
          675 * s[5]! +
          1326 * s[6]! +
          827 * s[7]! +
          130 * s[8]!)) /
      (384 * f32 * f45 * t[6]!),
    C0: sq,
    C2: (sq * (2 + 7 * s[2]!)) / (4 * t[2]!),
    C4:
      (sq * (4 + 32 * s[1]! - 116 * s[2]! - 400 * s[3]! - 71 * s[4]! + 146 * s[5]!)) / (32 * t[5]!),
  };
}

export interface NonlinearInput {
  /** Wave height H, crest to trough [m]. */
  height: number;
  /** Period T [s]. */
  period: number;
  /** Mean water depth h [m]. */
  depth: number;
  gravity: number;
}

/** Result for a periodic wave described by cosine harmonics of its elevation. */
export interface HarmonicWaveSolution {
  k: number;
  omega: number;
  /** Phase speed [m/s]. */
  c: number;
  /** Elevation harmonics a_1..a_n: η = Σ a_j cos(jθ), θ = k x − ω t + φ [m]. */
  harmonics: number[];
  /** Height actually used after any clamp [m]. */
  heightUsed: number;
  clamped: boolean;
  /** Explains a clamp or a validity warning for the UI. */
  notice?: string;
  /** Largest elevation error of the truncated series, relative to the height used. */
  truncationError: number;
}

interface Stokes5Point {
  k: number;
  c: number;
  harmonics: number[];
}

/** Fenton fifth-order wave of height H and period T: solve for k, then the harmonics. */
function stokes5At(height: number, omega: number, depth: number, g: number): Stokes5Point {
  const speed = (k: number) => {
    const co = fentonCoefficients(k * depth);
    const e = (k * height) / 2;
    return Math.sqrt(g / k) * (co.C0 + e * e * co.C2 + e ** 4 * co.C4);
  };
  const kLin = wavenumberOf(omega, { gravity: g, depth, tensionOverDensity: 0 });
  const f = (k: number) => speed(k) * k - omega;
  let lo = 0.2 * kLin;
  let hi = 1.2 * kLin;
  let k = kLin;
  if (f(lo) < 0 && f(hi) > 0) {
    for (let i = 0; i < 100; i++) {
      k = 0.5 * (lo + hi);
      if (f(k) > 0) hi = k;
      else lo = k;
    }
  }
  const co = fentonCoefficients(k * depth);
  const e = (k * height) / 2;
  const harmonics = [
    (e + e ** 3 * co.B31 - e ** 5 * (co.B53 + co.B55)) / k,
    (e ** 2 * co.B22 + e ** 4 * co.B42) / k,
    (-(e ** 3) * co.B31 + e ** 5 * co.B53) / k,
    (e ** 4 * co.B44) / k,
    (e ** 5 * co.B55) / k,
  ];
  return { k, c: omega / k, harmonics };
}

/**
 * Fifth-order Stokes wave (Fenton 1985) from height, period and depth. The wavenumber comes from
 * the nonlinear dispersion relation ω = k c(k, H) with c = √(g/k)(C0 + ε²C2 + ε⁴C4), ε = kH/2.
 * Heights beyond the Miche limit H/L = 0.142 tanh kd are reduced to it. When the Stokes-Ursell
 * number (kH/2)/(kd)³ exceeds 1/2 (Fenton's own criterion) the series is unreliable and the
 * notice recommends cnoidal theory.
 */
export function solveStokes5(input: NonlinearInput): HarmonicWaveSolution {
  const { depth, gravity: g } = input;
  const omega = (2 * Math.PI) / input.period;
  let height = Math.max(input.height, 0);
  let sol = stokes5At(height, omega, depth, g);
  const over = (hh: number, p: Stokes5Point) => hh - micheLimit(p.k, depth) * ((2 * Math.PI) / p.k);
  let clamped = false;
  let notice: string | undefined;
  if (over(height, sol) > 0) {
    clamped = true;
    let lo = 0;
    let hi = height;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (over(mid, stokes5At(mid, omega, depth, g)) > 0) hi = mid;
      else lo = mid;
    }
    const requested = height;
    height = lo;
    sol = stokes5At(height, omega, depth, g);
    notice =
      `Height reduced from ${requested.toFixed(2)} m to ${height.toFixed(2)} m: the Miche ` +
      `breaking limit H/L = 0.142 tanh kd = ${micheLimit(sol.k, depth).toFixed(3)} was exceeded.`;
  }
  const kd = sol.k * depth;
  const stokesUrsell = (0.5 * sol.k * height) / kd ** 3;
  if (stokesUrsell > 0.5) {
    notice =
      (notice ? notice + ' ' : '') +
      `Stokes-Ursell number ${stokesUrsell.toFixed(2)} > 1/2: fifth-order Stokes theory is ` +
      'unreliable for waves this long and high in this depth; use cnoidal theory.';
  }
  return {
    k: sol.k,
    omega,
    c: sol.c,
    harmonics: sol.harmonics,
    heightUsed: height,
    clamped,
    ...(notice ? { notice } : {}),
    truncationError: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Cnoidal waves (first-order KdV)
// ---------------------------------------------------------------------------------------------

export interface CnoidalSolution extends HarmonicWaveSolution {
  /** Elliptic parameter m = k² of the Jacobi functions (m → 1 is the solitary wave). */
  m: number;
  /** Ursell number H L² / h³ of the wave. */
  ursell: number;
}

/** Wave speed and length of a KdV cnoidal wave for elliptic parameter m (Wiegel 1960). */
function cnoidalGeometry(m: number, height: number, depth: number, g: number) {
  const K = ellipticK(m);
  const E = ellipticE(m);
  const L = 4 * K * Math.sqrt((m * depth ** 3) / (3 * height));
  const c = Math.sqrt(g * depth) * (1 + (height / (m * depth)) * (1 - m / 2 - (3 * E) / (2 * K)));
  return { K, E, L, c };
}

/** Elevation of the cnoidal wave at phase θ = 2π ξ/L, crest at θ = 0, zero mean level. */
function cnoidalEta(theta: number, m: number, height: number, K: number, E: number): number {
  const cn = jacobi((K * theta) / Math.PI, m).cn;
  return (height / m) * (1 - m - E / K) + height * cn * cn;
}

/** Cosine series of a function even about θ = 0 and 2π-periodic, harmonics 1..n (mean dropped). */
function cosineSeries(f: (theta: number) => number, n: number, samples = 1024): number[] {
  const v = new Float64Array(samples);
  for (let i = 0; i < samples; i++) v[i] = f((2 * Math.PI * i) / samples);
  const out: number[] = [];
  for (let j = 1; j <= n; j++) {
    let a = 0;
    for (let i = 0; i < samples; i++) a += v[i]! * Math.cos((j * 2 * Math.PI * i) / samples);
    out.push((2 * a) / samples);
  }
  return out;
}

/**
 * Cnoidal wave from the first-order KdV theory (Korteweg & de Vries 1895; Wiegel 1960):
 *   η = η_t + H cn²(2K ξ/L | m),  L = 4K √(m h³ / 3H),
 *   c = √(g h) [1 + (H / m h)(1 − m/2 − 3E/2K)],  η_t = (H/m)(1 − m − E/K),
 * with the origin of η at the mean level (zero-mean form), so the water depth h is the mean
 * depth. m is solved from H, T and h so that L / c = T. The periodic profile is carried as a
 * 24-term cosine series; `truncationError` is the largest elevation error of that series
 * relative to H. It grows as m → 1 and is returned so the UI can say so.
 * Valid for Ursell numbers ≳ 20 (long waves); below that the notice recommends Stokes theory.
 */
export function solveCnoidal(input: NonlinearInput): CnoidalSolution {
  const { depth, gravity: g } = input;
  const limit = BREAKING_H_OVER_D * depth;
  let height = Math.max(input.height, 1e-6);
  let clamped = false;
  let notice: string | undefined;
  if (height > limit) {
    notice =
      `Height reduced from ${height.toFixed(2)} m to ${limit.toFixed(2)} m: waves higher than ` +
      '0.78 times the depth break.';
    height = limit;
    clamped = true;
  }
  const T = input.period;
  // Smallest m for which KdV gives a sensible speed (c > ½ √gh); below it the wave is not long
  // enough for shallow-water theory.
  const mMax = 1 - 1e-10;
  let mMin = 1e-6;
  {
    let lo = 1e-6;
    let hi = mMax;
    if (cnoidalGeometry(lo, height, depth, g).c >= 0.5 * Math.sqrt(g * depth)) hi = lo;
    for (let i = 0; i < 80 && hi > lo; i++) {
      const mid = Math.sqrt(lo * hi);
      if (cnoidalGeometry(mid, height, depth, g).c >= 0.5 * Math.sqrt(g * depth)) hi = mid;
      else lo = mid;
    }
    mMin = hi;
  }
  const period = (m: number) => {
    const gm = cnoidalGeometry(m, height, depth, g);
    return gm.L / gm.c;
  };
  let m: number;
  if (period(mMin) >= T) {
    m = mMin;
  } else if (period(mMax) <= T) {
    m = mMax;
  } else {
    let lo = mMin;
    let hi = mMax;
    for (let i = 0; i < 200; i++) {
      // Bisection in log(1 − m), because T grows like log(1/(1 − m)) near m = 1.
      const mid = 1 - Math.sqrt((1 - lo) * (1 - hi));
      if (period(mid) > T) hi = mid;
      else lo = mid;
    }
    m = 0.5 * (lo + hi);
  }
  const { K, E, L, c } = cnoidalGeometry(m, height, depth, g);
  const k = (2 * Math.PI) / L;
  const ursell = (height * L * L) / depth ** 3;
  if (ursell < 20 || period(mMin) >= T) {
    notice =
      (notice ? notice + ' ' : '') +
      `Ursell number ${ursell.toFixed(0)} is below about 20: this wave is not long enough for ` +
      'cnoidal (shallow-water) theory; Stokes fifth order is the better model.';
  }
  const f = (th: number) => cnoidalEta(th, m, height, K, E);
  const harmonics = cosineSeries(f, MAX_HARMONICS);
  let worst = 0;
  for (let i = 0; i <= 720; i++) {
    const th = (Math.PI * i) / 720;
    const approx = harmonics.reduce((a, h, j) => a + h * Math.cos((j + 1) * th), 0);
    worst = Math.max(worst, Math.abs(approx - f(th)));
  }
  const truncationError = worst / height;
  if (truncationError > 0.02) {
    notice =
      (notice ? notice + ' ' : '') +
      `The 24-term series for this very peaked wave is off by ${(100 * truncationError).toFixed(1)} % of H.`;
  }
  // The wave speed must reproduce the requested period when m was not clamped; when it was, the
  // period of the wave actually drawn differs and is reported through omega.
  return {
    k,
    omega: k * c,
    c,
    harmonics,
    heightUsed: height,
    clamped,
    ...(notice ? { notice } : {}),
    truncationError,
    m,
    ursell,
  };
}
