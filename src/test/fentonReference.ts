/**
 * Independent reference for steady water waves: the stream-function Fourier method of
 * Rienecker & Fenton (1981, J. Fluid Mech. 104, 119-137), solved by Newton's method with a
 * finite-difference Jacobian. It is "exact" up to the number of Fourier modes (here 16 or more),
 * so it is used to check the fifth-order Stokes, cnoidal and solitary profiles. Test-only code.
 *
 * Frame: wave frame, stream function ψ = −Ū y + Σ B_j sinh(j k y)/cosh(j k d) cos(j k x) with y
 * measured from the bed. Surface condition ψ = −Q, Bernoulli ½|q|² + g y = R. The mean Eulerian
 * current is zero (Stokes' first definition), so Ū = c.
 */

export interface FourierWave {
  /** Wavenumber [rad/m]. */
  k: number;
  /** Phase speed [m/s]. */
  c: number;
  /** Surface elevation about the mean level at phase θ = k x (crest at θ = 0) [m]. */
  eta: (theta: number) => number;
  /** Cosine coefficients a_1..a_{N-1} of η (mean zero) [m]. */
  coefficients: number[];
}

function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r]![i]!) > Math.abs(a[p]![i]!)) p = r;
    [a[i], a[p]] = [a[p]!, a[i]!];
    [b[i], b[p]] = [b[p]!, b[i]!];
    for (let r = i + 1; r < n; r++) {
      const f = a[r]![i]! / a[i]![i]!;
      if (f === 0) continue;
      for (let cc = i; cc < n; cc++) a[r]![cc]! -= f * a[i]![cc]!;
      b[r]! -= f * b[i]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let cc = i + 1; cc < n; cc++) s -= a[i]![cc]! * x[cc]!;
    x[i] = s / a[i]![i]!;
  }
  return x;
}

/** Solve for the steady wave of height H, period T on depth d, with N Fourier modes. */
export function fourierWave(
  H: number,
  T: number,
  d: number,
  g: number,
  N = 20,
  steps = 8,
): FourierWave {
  const omega = (2 * Math.PI) / T;
  // Linear start (Newton on the dispersion relation).
  let k0 = (omega * omega) / g;
  for (let i = 0; i < 60; i++)
    k0 -=
      (g * k0 * Math.tanh(k0 * d) - omega * omega) /
      (g * Math.tanh(k0 * d) + (g * k0 * d) / Math.cosh(k0 * d) ** 2);
  // Unknowns: η_0..η_N (N+1), B_1..B_N (N), k, Q, R, plus one spare slot pinned to zero so the
  // system has as many equations as unknowns (the mean-level equation is the extra one).
  const nu = 2 * N + 5;
  const z = new Array<number>(nu).fill(0);
  const iB = N + 1;
  const iK = 2 * N + 1;
  const iQ = 2 * N + 2;
  const iR = 2 * N + 3;
  z[iK] = k0;
  const c0 = omega / k0;
  z[iQ] = c0 * d;
  z[iR] = 0.5 * c0 * c0 + g * d;
  let h = 0;
  const residual = (zz: number[], hh: number): number[] => {
    const k = zz[iK]!;
    const U = omega / k;
    const Q = zz[iQ]!;
    const R = zz[iR]!;
    const r = new Array<number>(nu).fill(0);
    for (let m = 0; m <= N; m++) {
      const x = (Math.PI * m) / N / k;
      const eta = zz[m]!;
      let psi = -U * eta;
      let u = -U;
      let v = 0;
      for (let j = 1; j <= N; j++) {
        const Bj = zz[iB + j - 1]!;
        const a = j * k * eta;
        const kd = j * k * d;
        // sinh(a)/cosh(kd) and cosh(a)/cosh(kd) without overflow
        const e1 = Math.exp(a - kd);
        const e2 = Math.exp(-a - kd);
        const e3 = Math.exp(-2 * kd);
        const sh = (e1 - e2) / (1 + e3);
        const ch = (e1 + e2) / (1 + e3);
        psi += Bj * sh * Math.cos(j * k * x);
        u += j * k * Bj * ch * Math.cos(j * k * x);
        v += j * k * Bj * sh * Math.sin(j * k * x);
      }
      r[m] = psi + Q;
      r[N + 1 + m] = 0.5 * (u * u + v * v) + g * eta - R;
    }
    // r indices: 0..N kinematic, N+1..2N+1 dynamic; remaining: height, mean, pin spare.
    r[2 * N + 2] = zz[0]! - zz[N]! - hh;
    let mean = 0.5 * zz[0]! + 0.5 * zz[N]!;
    for (let m = 1; m < N; m++) mean += zz[m]!;
    r[2 * N + 3] = mean / N - d;
    r[2 * N + 4] = zz[nu - 1]!;
    return r;
  };
  // The unknown ordering above assigns Q and R to slots 2N+2, 2N+3 and k to 2N+1; the residual
  // slots are independent of that ordering, only the count (nu) matters.
  for (let s = 1; s <= steps; s++) {
    h = (H * s) / steps;
    if (s === 1) {
      for (let m = 0; m <= N; m++) z[m] = d + 0.5 * h * Math.cos((Math.PI * m) / N);
      z[iB] = (0.5 * h * omega) / (k0 * Math.tanh(k0 * d));
    }
    for (let it = 0; it < 60; it++) {
      const r = residual(z, h);
      const norm = Math.max(...r.map(Math.abs));
      if (norm < 1e-11) break;
      const J: number[][] = Array.from({ length: nu }, () => new Array<number>(nu).fill(0));
      for (let col = 0; col < nu; col++) {
        const dz = 1e-7 * Math.max(1, Math.abs(z[col]!));
        const zp = z.slice();
        zp[col]! += dz;
        const rp = residual(zp, h);
        for (let row = 0; row < nu; row++) J[row]![col] = (rp[row]! - r[row]!) / dz;
      }
      const dx = solveLinear(
        J,
        r.map((v) => -v),
      );
      for (let i = 0; i < nu; i++) z[i]! += dx[i]!;
    }
  }
  const k = z[iK]!;
  // Cosine coefficients of η from the N+1 half-wavelength samples.
  const coefficients: number[] = [];
  for (let j = 1; j < N; j++) {
    let s = 0.5 * z[0]! + 0.5 * z[N]! * (j % 2 ? -1 : 1);
    for (let m = 1; m < N; m++) s += z[m]! * Math.cos((j * Math.PI * m) / N);
    coefficients.push((2 / N) * s);
  }
  return {
    k,
    c: omega / k,
    coefficients,
    eta: (theta: number) =>
      coefficients.reduce((acc, a, i) => acc + a * Math.cos((i + 1) * theta), 0),
  };
}
