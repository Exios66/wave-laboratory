/**
 * Packing of the nonlinear steady waves (Stokes 5, cnoidal, solitary) into shader uniforms, and
 * a line-for-line CPU mirror of the GLSL `nonlinearSample` in `shaders.ts`. The mirror exists so a
 * unit test can check that what the GPU draws (elevation, horizontal displacement, slopes) is
 * what the CPU physics samples; keep the two in step. No three.js here.
 *
 * Uniform layout, per wave i (MAX_NONLINEAR waves):
 *   uNlA[i] = (ω, k, φ, kind)         kind 1 = harmonic series, 2 = solitary
 *   uNlB[i] = (dirX, dirY, H, κ)      H, κ for solitary waves only
 *   uNlH[6 i + q] = a_{4q+1} … a_{4q+4}   harmonic amplitudes [m]; solitary: uNlH[6 i].x = spacing
 * plus uNlCount and uNlDepth (the mean depth, for coth(n k h) and the solitary displacement).
 * Amplitudes are float32 on the GPU: the quantisation error is ≈ 1e-7 of H.
 */
import type { ResolvedNonlinearWave } from '../../ocean/systems';

export const MAX_NONLINEAR = 4;
/** vec4s of harmonic amplitudes per wave: 24 harmonics. */
export const NL_HARMONIC_VECS = 6;
export const NL_HARMONICS = NL_HARMONIC_VECS * 4;

export interface PackedNonlinear {
  count: number;
  depth: number;
  /** 4 floats per wave. */
  a: Float32Array;
  b: Float32Array;
  /** 4·NL_HARMONIC_VECS floats per wave. */
  h: Float32Array;
}

export function packNonlinear(
  waves: readonly ResolvedNonlinearWave[],
  depth: number,
): PackedNonlinear {
  const a = new Float32Array(4 * MAX_NONLINEAR);
  const b = new Float32Array(4 * MAX_NONLINEAR);
  const h = new Float32Array(4 * NL_HARMONIC_VECS * MAX_NONLINEAR);
  const count = Math.min(waves.length, MAX_NONLINEAR);
  for (let i = 0; i < count; i++) {
    const w = waves[i]!;
    a.set([w.omega, w.k, w.phase, w.kind === 'solitary' ? 2 : 1], 4 * i);
    if (w.kind === 'solitary') {
      const s = w.solitary!;
      b.set([w.dirX, w.dirY, s.heightUsed, s.kappa], 4 * i);
      h[4 * NL_HARMONIC_VECS * i] = s.spacing;
    } else {
      b.set([w.dirX, w.dirY, 0, 0], 4 * i);
      for (let j = 0; j < Math.min(w.harmonics.length, NL_HARMONICS); j++) {
        h[4 * NL_HARMONIC_VECS * i + j] = w.harmonics[j]!;
      }
    }
  }
  return { count, depth, a, b, h };
}

export interface MirrorSample {
  /** Horizontal displacement x, y and elevation z (water frame, before the mesh offset). */
  x: number;
  y: number;
  z: number;
  /** (∂η/∂x, ∂η/∂y, ∂Dx/∂x, ∂Dy/∂y) as in the shader's regSlope. */
  slope: [number, number, number, number];
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** CPU mirror of `nonlinearSample` (GLSL). `meshH` is the local mesh spacing h [m]. */
export function mirrorNonlinearSample(
  p: PackedNonlinear,
  wx: number,
  wy: number,
  time: number,
  lambda: number,
  meshH: number,
): MirrorSample {
  const out: MirrorSample = { x: 0, y: 0, z: 0, slope: [0, 0, 0, 0] };
  for (let i = 0; i < MAX_NONLINEAR; i++) {
    if (i + 0.5 > p.count) break;
    const omega = p.a[4 * i]!;
    const k = p.a[4 * i + 1]!;
    const phase = p.a[4 * i + 2]!;
    const kind = p.a[4 * i + 3]!;
    const dx = p.b[4 * i]!;
    const dy = p.b[4 * i + 1]!;
    const theta = k * (dx * wx + dy * wy) - omega * time + phase;
    if (kind < 1.5) {
      for (let j = 0; j < NL_HARMONICS; j++) {
        const n = j + 1;
        const amp0 = p.h[4 * NL_HARMONIC_VECS * i + j]!;
        if (amp0 === 0) continue;
        const wavelength = (2 * Math.PI) / (n * k);
        const amp = amp0 * smoothstep(2 * meshH, 4 * meshH, wavelength);
        const x = n * k * p.depth;
        const coth = x > 20 ? 1 : 1 / Math.tanh(x);
        const s = Math.sin(n * theta);
        const c = Math.cos(n * theta);
        const horiz = -lambda * amp * coth * s;
        out.x += horiz * dx;
        out.y += horiz * dy;
        out.z += amp * c;
        const deta = -amp * n * k * s;
        const dd = -lambda * amp * coth * n * k * c;
        out.slope[0] += deta * dx;
        out.slope[1] += deta * dy;
        out.slope[2] += dd * dx * dx;
        out.slope[3] += dd * dy * dy;
      }
    } else {
      const height = p.b[4 * i + 2]!;
      const kappa = p.b[4 * i + 3]!;
      const spacing = p.h[4 * NL_HARMONIC_VECS * i]!;
      const amp = height * smoothstep(2 * meshH, 4 * meshH, 4 / kappa);
      const xi = theta / k;
      const x = xi - spacing * Math.floor(xi / spacing + 0.5);
      const q = Math.min(kappa * Math.abs(x), 30);
      const sech2 = 1 / Math.cosh(q) ** 2;
      const th = Math.tanh(kappa * x);
      const thHalf = Math.tanh(Math.min(0.5 * kappa * spacing, 20));
      const disp = -(amp / (p.depth * kappa)) * (th - ((2 * x) / spacing) * thHalf);
      out.x += lambda * disp * dx;
      out.y += lambda * disp * dy;
      out.z += amp * sech2;
      const deta = -2 * amp * kappa * sech2 * th;
      const dd =
        lambda * (-(amp / p.depth) * sech2 + (amp / (p.depth * kappa)) * (2 / spacing) * thHalf);
      out.slope[0] += deta * dx;
      out.slope[1] += deta * dy;
      out.slope[2] += dd * dx * dx;
      out.slope[3] += dd * dy * dy;
    }
  }
  return out;
}
