import { describe, expect, it } from 'vitest';
import { FFT, signedIndex } from './fft';

function naiveInverse2D(input: Float64Array, n: number): Float64Array {
  const out = new Float64Array(2 * n * n);
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let re = 0;
      let im = 0;
      for (let my = 0; my < n; my++) {
        for (let mx = 0; mx < n; mx++) {
          const a = (2 * Math.PI * (mx * px + my * py)) / n;
          const fr = input[2 * (my * n + mx)]!;
          const fi = input[2 * (my * n + mx) + 1]!;
          re += fr * Math.cos(a) - fi * Math.sin(a);
          im += fr * Math.sin(a) + fi * Math.cos(a);
        }
      }
      out[2 * (py * n + px)] = re;
      out[2 * (py * n + px) + 1] = im;
    }
  }
  return out;
}

describe('FFT', () => {
  it('rejects non power-of-two sizes', () => {
    expect(() => new FFT(12)).toThrow(RangeError);
  });

  it('matches a naive inverse DFT in 2D', () => {
    const n = 8;
    const data = new Float64Array(2 * n * n);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 1.7) + 0.3 * Math.cos(i * 0.31);
    const expected = naiveInverse2D(data, n);
    const fft = new FFT(n);
    fft.inverse2D(data);
    for (let i = 0; i < data.length; i++) expect(data[i]).toBeCloseTo(expected[i]!, 10);
  });

  it('round-trips forward/inverse with 1/N² scaling', () => {
    const n = 16;
    const fft = new FFT(n);
    const original = new Float64Array(2 * n * n).map((_, i) => Math.cos(i * 0.123));
    const data = original.slice();
    fft.forward2D(data);
    fft.inverse2D(data);
    for (let i = 0; i < data.length; i++) expect(data[i]! / (n * n)).toBeCloseTo(original[i]!, 10);
  });

  it('places a single mode at the expected wavenumber', () => {
    const n = 16;
    const fft = new FFT(n);
    const data = new Float64Array(2 * n * n);
    // mode (mx = 3, my = -2) with unit amplitude
    const mx = 3;
    const my = n - 2;
    data[2 * (my * n + mx)] = 1;
    fft.inverse2D(data);
    for (let py = 0; py < n; py++) {
      for (let px = 0; px < n; px++) {
        const a = (2 * Math.PI * (3 * px + signedIndex(my, n) * py)) / n;
        expect(data[2 * (py * n + px)]).toBeCloseTo(Math.cos(a), 10);
      }
    }
  });
});
