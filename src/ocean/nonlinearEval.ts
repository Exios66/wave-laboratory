/**
 * Point evaluation of the nonlinear steady waves (Stokes 5, cnoidal, solitary) for the CPU ocean
 * field. The GPU shader draws the same surface from the same resolved data, and its CPU mirror
 * (`render/ocean/nonlinearMirror.ts`) is tested against these functions.
 *
 * Every function works in the water frame at the Lagrangian label (x0, y0), exactly like the
 * linear regular waves in `OceanField`, with θ = k (d·x0) − ω t + φ.
 */
import { pressureAttenuation, verticalAttenuation } from './dispersion';
import { solitaryDisplacement, solitaryEta, wrapSpacing } from './nonlinear';
import type { ResolvedNonlinearWave } from './systems';

export interface NonlinearSurface {
  /** Elevation [m]. */
  eta: number;
  /** ∂η/∂s along the propagation direction [-]. */
  dEta: number;
  /** ∂η/∂t at the label [m/s]. */
  etaT: number;
  /** Horizontal displacement along the propagation direction for choppiness 1 [m] (before λ). */
  disp: number;
}

export function nonlinearPhase(w: ResolvedNonlinearWave, x0: number, y0: number, t: number) {
  return w.k * (w.dirX * x0 + w.dirY * y0) - w.omega * t + w.phase;
}

/** Surface state of one nonlinear wave; `disp` is the λ = 1 displacement along the direction. */
export function nonlinearSurface(
  w: ResolvedNonlinearWave,
  x0: number,
  y0: number,
  t: number,
  out: NonlinearSurface,
): NonlinearSurface {
  const theta = nonlinearPhase(w, x0, y0, t);
  if (w.kind === 'solitary') {
    const s = w.solitary!;
    const xi = theta / w.k;
    const x = wrapSpacing(xi, s.spacing);
    const q = Math.min(s.kappa * Math.abs(x), 30);
    const sech2 = 1 / Math.cosh(q) ** 2;
    out.eta = solitaryEta(xi, s);
    // dη/dξ = −2 H κ sech² tanh(κ x)
    out.dEta = -2 * s.heightUsed * s.kappa * sech2 * Math.tanh(s.kappa * x);
    out.etaT = -w.c * out.dEta;
    out.disp = solitaryDisplacement(xi, s, w.depth);
    return out;
  }
  let eta = 0;
  let dEta = 0;
  let etaT = 0;
  let disp = 0;
  const hs = w.harmonics;
  for (let j = 0; j < hs.length; j++) {
    const n = j + 1;
    const a = hs[j]!;
    const c = Math.cos(n * theta);
    const s = Math.sin(n * theta);
    eta += a * c;
    dEta -= a * n * w.k * s;
    etaT += a * n * w.omega * s;
    disp -= a * w.coth[j]! * s;
  }
  out.eta = eta;
  out.dEta = dEta;
  out.etaT = etaT;
  out.disp = disp;
  return out;
}

export interface NonlinearKinematics {
  /** Dynamic pressure head [m]. */
  head: number;
  /** Horizontal particle speed along the propagation direction [m/s]. */
  uh: number;
  /** Vertical particle speed [m/s]. */
  w: number;
}

/**
 * Pressure head and particle velocity of one nonlinear wave at stretched depth ζ ≤ 0 below the
 * surface (see OceanField.fluid). Harmonic waves use linear theory per harmonic; the solitary
 * wave is hydrostatic with u = c η / h and a vertical velocity that falls linearly to the bed.
 */
export function nonlinearKinematics(
  w: ResolvedNonlinearWave,
  x0: number,
  y0: number,
  t: number,
  zeta: number,
  out: NonlinearKinematics,
): NonlinearKinematics {
  const h = w.depth;
  const theta = nonlinearPhase(w, x0, y0, t);
  if (w.kind === 'solitary') {
    const s = nonlinearSurface(w, x0, y0, t, scratch);
    out.head = s.eta;
    out.uh = (w.c * s.eta) / h;
    out.w = (s.etaT * Math.max(h + zeta, 0)) / h;
    return out;
  }
  let head = 0;
  let uh = 0;
  let wv = 0;
  const hs = w.harmonics;
  for (let j = 0; j < hs.length; j++) {
    const n = j + 1;
    const a = hs[j]!;
    const c = Math.cos(n * theta);
    const s = Math.sin(n * theta);
    const att = pressureAttenuation(n * w.k, zeta, h);
    head += a * c * att;
    uh += a * n * w.omega * w.coth[j]! * c * att;
    wv += a * n * w.omega * s * verticalAttenuation(n * w.k, zeta, h);
  }
  out.head = head;
  out.uh = uh;
  out.w = wv;
  return out;
}

const scratch: NonlinearSurface = { eta: 0, dEta: 0, etaT: 0, disp: 0 };
