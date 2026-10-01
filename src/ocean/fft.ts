/**
 * Complex FFT on interleaved Float64Arrays ([re0, im0, re1, im1, ...]).
 *
 * Conventions (shared with the GPU implementation in `src/render/ocean`):
 *  - Grid index n ∈ [0, N) maps to wavenumber index m = n < N/2 ? n : n - N ("natural" FFT order).
 *  - The inverse transform is UNNORMALISED with a positive exponent:
 *        f[p] = Σ_m F[m] · exp(+2πi·m·p / N)
 *    so a spectral amplitude F[m] contributes F[m]·e^{i k·x} with k = 2π m / L and x = p · L / N.
 *  - 2D arrays are row-major: index = row * N + col, with col ↔ x and row ↔ y.
 */

export class FFT {
  readonly n: number;
  readonly log2n: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  private readonly column: Float64Array;

  constructor(n: number) {
    if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) {
      throw new RangeError(`FFT size must be a power of two ≥ 2, got ${n}`);
    }
    this.n = n;
    this.log2n = Math.round(Math.log2(n));
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      const a = (2 * Math.PI * i) / n;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < this.log2n; b++) r |= ((i >> b) & 1) << (this.log2n - 1 - b);
      this.rev[i] = r;
    }
    this.column = new Float64Array(2 * n);
  }

  /**
   * In-place 1D transform of `n` complex values starting at complex index `offset` with complex
   * stride 1. `sign` = +1 gives the (unnormalised) inverse transform, −1 the forward transform.
   */
  transform1D(data: Float64Array, offset: number, sign: 1 | -1): void {
    const n = this.n;
    const rev = this.rev;
    const base = 2 * offset;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        const a = base + 2 * i;
        const b = base + 2 * j;
        const tr = data[a]!;
        const ti = data[a + 1]!;
        data[a] = data[b]!;
        data[a + 1] = data[b + 1]!;
        data[b] = tr;
        data[b + 1] = ti;
      }
    }
    const cosT = this.cos;
    const sinT = this.sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cosT[k * step]!;
          const wi = sign * sinT[k * step]!;
          const a = base + 2 * (start + k);
          const b = a + 2 * half;
          const br = data[b]!;
          const bi = data[b + 1]!;
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          const ar = data[a]!;
          const ai = data[a + 1]!;
          data[b] = ar - tr;
          data[b + 1] = ai - ti;
          data[a] = ar + tr;
          data[a + 1] = ai + ti;
        }
      }
    }
  }

  /** In-place 2D transform of an N×N complex grid (row-major, interleaved). */
  transform2D(data: Float64Array, sign: 1 | -1): void {
    const n = this.n;
    if (data.length !== 2 * n * n) {
      throw new RangeError(`Expected ${2 * n * n} values for a ${n}×${n} grid, got ${data.length}`);
    }
    for (let row = 0; row < n; row++) this.transform1D(data, row * n, sign);
    const col = this.column;
    for (let c = 0; c < n; c++) {
      for (let r = 0; r < n; r++) {
        const src = 2 * (r * n + c);
        col[2 * r] = data[src]!;
        col[2 * r + 1] = data[src + 1]!;
      }
      this.transform1D(col, 0, sign);
      for (let r = 0; r < n; r++) {
        const dst = 2 * (r * n + c);
        data[dst] = col[2 * r]!;
        data[dst + 1] = col[2 * r + 1]!;
      }
    }
  }

  inverse2D(data: Float64Array): void {
    this.transform2D(data, 1);
  }

  forward2D(data: Float64Array): void {
    this.transform2D(data, -1);
  }
}

/** Signed wavenumber index for grid index `i` in natural FFT order. */
export function signedIndex(i: number, n: number): number {
  return i < n / 2 ? i : i - n;
}
