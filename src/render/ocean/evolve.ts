/**
 * Spectral time evolution shared by the GPU ocean and its correctness checks.
 *
 * The formulas are the ones in docs/PHYSICS.md and `ocean/oceanField.ts`:
 *   e1 = h₀(k) e^{−iωt},  e2 = conj(h₀(−k)) e^{+iωt},  ĥ = e1 + e2
 *   D̂ = λ i k̂ coth(kh) ĥ, packed as Dx + i Dy so one inverse FFT yields both.
 * h₀ texels are RGBA float (Re h₀, Im h₀, ω, 0) in natural FFT order.
 */
import { tanhKh } from '../../ocean/dispersion';

const TAU = Math.PI * 2;

export interface EvolvedSpectra {
  /** Interleaved complex ĥ, length 2 N². */
  height: Float64Array;
  /** Interleaved complex spectrum of Dx + i Dy, length 2 N². */
  packedDisp: Float64Array;
}

export function evolveSpectra(
  h0: ArrayLike<number>,
  n: number,
  size: number,
  t: number,
  depth: number,
  lambda: number,
): EvolvedSpectra {
  const height = new Float64Array(2 * n * n);
  const packedDisp = new Float64Array(2 * n * n);
  const dk = TAU / size;
  for (let iy = 0; iy < n; iy++) {
    const my = iy < n / 2 ? iy : iy - n;
    const ky = my * dk;
    const iyNeg = iy === 0 ? 0 : n - iy;
    for (let ix = 0; ix < n; ix++) {
      const cell = iy * n + ix;
      const ar = h0[4 * cell] ?? 0;
      const ai = h0[4 * cell + 1] ?? 0;
      const omega = h0[4 * cell + 2] ?? 0;
      const ixNeg = ix === 0 ? 0 : n - ix;
      const neg = iyNeg * n + ixNeg;
      const br = h0[4 * neg] ?? 0;
      const bi = h0[4 * neg + 1] ?? 0;
      const cos = Math.cos(omega * t);
      const sin = Math.sin(omega * t);
      const e1r = ar * cos + ai * sin;
      const e1i = ai * cos - ar * sin;
      const e2r = br * cos + bi * sin;
      const e2i = br * sin - bi * cos;
      const hr = e1r + e2r;
      const hi = e1i + e2i;
      const j = 2 * cell;
      height[j] = hr;
      height[j + 1] = hi;

      const mx = ix < n / 2 ? ix : ix - n;
      const kx = mx * dk;
      const k = Math.hypot(kx, ky);
      if (k < 1e-6) continue;
      const coth = 1 / tanhKh(k, depth);
      const ux = (kx / k) * coth;
      const uy = (ky / k) * coth;
      const dxr = -lambda * ux * hi;
      const dxi = lambda * ux * hr;
      const dyr = -lambda * uy * hi;
      const dyi = lambda * uy * hr;
      packedDisp[j] = dxr - dyi;
      packedDisp[j + 1] = dxi + dyr;
    }
  }
  return { height, packedDisp };
}
