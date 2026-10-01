/**
 * Signal analysis for wave and motion records: Welch power spectral density, spectral moments
 * and zero-up-crossing wave statistics (IAHR/PIANC conventions).
 */
import { FFT } from '../ocean/fft';

export interface Psd {
  /** Frequencies [Hz]. */
  freq: Float64Array;
  /** One-sided power spectral density [unit²/Hz]. */
  density: Float64Array;
  /** Number of averaged segments (more = smoother, ~χ² with 2·segments d.o.f.). */
  segments: number;
}

function largestPow2AtMost(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * Welch's method: Hann-windowed segments with 50 % overlap, mean removed, one-sided density
 * scaled so that Σ density·Δf equals the signal variance (Parseval).
 */
export function welchPsd(signal: ArrayLike<number>, sampleRate: number, segmentLength = 256): Psd {
  const n = signal.length;
  const seg = Math.min(largestPow2AtMost(segmentLength), largestPow2AtMost(n));
  if (seg < 8) return { freq: new Float64Array(0), density: new Float64Array(0), segments: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i]!;
  mean /= n;
  const window = new Float64Array(seg);
  let wss = 0;
  for (let i = 0; i < seg; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / seg);
    wss += window[i]! * window[i]!;
  }
  const fft = new FFT(seg);
  const buf = new Float64Array(2 * seg);
  const half = seg / 2;
  const acc = new Float64Array(half + 1);
  const step = seg / 2;
  let segments = 0;
  for (let start = 0; start + seg <= n; start += step) {
    for (let i = 0; i < seg; i++) {
      buf[2 * i] = (signal[start + i]! - mean) * window[i]!;
      buf[2 * i + 1] = 0;
    }
    fft.transform1D(buf, 0, -1);
    for (let k = 0; k <= half; k++) acc[k]! += buf[2 * k]! ** 2 + buf[2 * k + 1]! ** 2;
    segments++;
  }
  const df = sampleRate / seg;
  const freq = new Float64Array(half + 1);
  const density = new Float64Array(half + 1);
  const scale = 1 / (sampleRate * wss * segments);
  for (let k = 0; k <= half; k++) {
    freq[k] = k * df;
    const oneSided = k === 0 || k === half ? 1 : 2;
    density[k] = acc[k]! * scale * oneSided;
  }
  return { freq, density, segments };
}

export interface SpectralParameters {
  /** Spectral significant wave height H_m0 = 4√m₀. */
  hm0: number;
  /** Peak period [s]. */
  tp: number;
  /** Mean period T_m01 = m₀/m₁ [s]. */
  tm01: number;
  /** Zero-crossing period estimate T_m02 = √(m₀/m₂) [s]. */
  tm02: number;
}

export function spectralParameters(psd: Psd): SpectralParameters {
  const { freq, density } = psd;
  let m0 = 0;
  let m1 = 0;
  let m2 = 0;
  let peak = 0;
  let fPeak = 0;
  for (let k = 1; k < freq.length; k++) {
    const df = freq[k]! - freq[k - 1]!;
    const f = freq[k]!;
    const s = density[k]!;
    m0 += s * df;
    m1 += s * f * df;
    m2 += s * f * f * df;
    if (s > peak) {
      peak = s;
      fPeak = f;
    }
  }
  return {
    hm0: 4 * Math.sqrt(m0),
    tp: fPeak > 0 ? 1 / fPeak : 0,
    tm01: m1 > 0 ? m0 / m1 : 0,
    tm02: m2 > 0 ? Math.sqrt(m0 / m2) : 0,
  };
}

export interface WaveStatistics {
  /** Number of individual (zero-up-crossing) waves. */
  count: number;
  /** Mean of the highest third of wave heights. */
  h13: number;
  hmax: number;
  hmean: number;
  /** Mean zero-up-crossing period [s]. */
  tz: number;
  /** Standard deviation of the record. */
  std: number;
  /** Largest crest height above the mean. */
  crestMax: number;
}

/** Zero-up-crossing analysis (crossing times linearly interpolated). */
export function zeroCrossingStatistics(
  signal: ArrayLike<number>,
  sampleRate: number,
): WaveStatistics {
  const n = signal.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i]!;
  mean = n > 0 ? mean / n : 0;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (signal[i]! - mean) ** 2;
  const std = n > 1 ? Math.sqrt(variance / (n - 1)) : 0;
  const heights: number[] = [];
  const periods: number[] = [];
  let lastCross = -1;
  let hi = -Infinity;
  let lo = Infinity;
  let crestMax = 0;
  for (let i = 1; i < n; i++) {
    const a = signal[i - 1]! - mean;
    const b = signal[i]! - mean;
    if (b > crestMax) crestMax = b;
    if (a < 0 && b >= 0) {
      const tc = (i - 1 + a / (a - b)) / sampleRate;
      if (lastCross >= 0) {
        heights.push(hi - lo);
        periods.push(tc - lastCross);
      }
      lastCross = tc;
      hi = b;
      lo = b;
    } else {
      if (b > hi) hi = b;
      if (b < lo) lo = b;
    }
  }
  const sorted = [...heights].sort((x, y) => y - x);
  const third = Math.max(1, Math.round(sorted.length / 3));
  const top = sorted.slice(0, third);
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  return {
    count: heights.length,
    h13: avg(top),
    hmax: sorted[0] ?? 0,
    hmean: avg(heights),
    tz: avg(periods),
    std,
    crestMax,
  };
}

/** Root-mean-square of a record (about its mean). */
export function rms(signal: ArrayLike<number>): number {
  const n = signal.length;
  if (n === 0) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i]!;
  mean /= n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (signal[i]! - mean) ** 2;
  return Math.sqrt(s / n);
}

/**
 * Motion sickness incidence [%] after O'Hanlon & McCauley (1974): percentage of people expected
 * to vomit within 2 h, from the RMS vertical acceleration a [m/s²] at dominant encounter
 * frequency f [Hz]. MSI = 100·Φ((log10(a/g) − μ)/0.4) with μ = −0.819 + 2.32 (log10 ω)².
 */
export function motionSicknessIncidence(
  rmsVerticalAccel: number,
  freqHz: number,
  g = 9.80665,
): number {
  if (rmsVerticalAccel <= 0 || freqHz <= 0) return 0;
  const omega = 2 * Math.PI * freqHz;
  const mu = -0.819 + 2.32 * Math.log10(omega) ** 2;
  // O'Hanlon & McCauley used the mean absolute acceleration ≈ 0.798·rms for Gaussian motion.
  const x = (Math.log10((0.798 * rmsVerticalAccel) / g) - mu) / 0.4;
  return 100 * normalCdf(x);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |ε| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
