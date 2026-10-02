/**
 * Out-of-place inverse FFT that mirrors the GPU passes in `shaders.ts` one index at a time.
 * Sign is +1: unnormalised, positive exponent, matching `ocean/fft.ts`.
 */

function bitReverse(x: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  return r;
}

function read(data: Float64Array, ix: number, iy: number, n: number): [number, number] {
  const i = 2 * (iy * n + ix);
  return [data[i]!, data[i + 1]!];
}

function write(
  data: Float64Array,
  ix: number,
  iy: number,
  n: number,
  re: number,
  im: number,
): void {
  const i = 2 * (iy * n + ix);
  data[i] = re;
  data[i + 1] = im;
}

function cmul(ar: number, ai: number, br: number, bi: number): [number, number] {
  return [ar * br - ai * bi, ar * bi + ai * br];
}

/** Inverse 2D FFT. `input` is not modified. */
export function ifft2d(input: Float64Array, n: number): Float64Array {
  const bits = Math.round(Math.log2(n));
  let src = new Float64Array(input);
  let dst = new Float64Array(input.length);
  const swap = () => {
    const t = src;
    src = dst;
    dst = t;
  };

  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const [re, im] = read(src, bitReverse(ix, bits), iy, n);
      write(dst, ix, iy, n, re, im);
    }
  }
  swap();

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const pos = ix & (len - 1);
        const block = ix - pos;
        const k = pos < half ? pos : pos - half;
        const idxA = block + k;
        const idxB = idxA + half;
        const [ar, ai] = read(src, idxA, iy, n);
        const [br, bi] = read(src, idxB, iy, n);
        const theta = (Math.PI * 2 * k) / len;
        const [tr, ti] = cmul(Math.cos(theta), Math.sin(theta), br, bi);
        const re = pos < half ? ar + tr : ar - tr;
        const im = pos < half ? ai + ti : ai - ti;
        write(dst, ix, iy, n, re, im);
      }
    }
    swap();
  }

  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const [re, im] = read(src, ix, bitReverse(iy, bits), n);
      write(dst, ix, iy, n, re, im);
    }
  }
  swap();

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const pos = iy & (len - 1);
        const block = iy - pos;
        const k = pos < half ? pos : pos - half;
        const idxA = block + k;
        const idxB = idxA + half;
        const [ar, ai] = read(src, ix, idxA, n);
        const [br, bi] = read(src, ix, idxB, n);
        const theta = (Math.PI * 2 * k) / len;
        const [tr, ti] = cmul(Math.cos(theta), Math.sin(theta), br, bi);
        const re = pos < half ? ar + tr : ar - tr;
        const im = pos < half ? ai + ti : ai - ti;
        write(dst, ix, iy, n, re, im);
      }
    }
    swap();
  }

  return src;
}
